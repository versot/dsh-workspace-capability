/**
 * Workspace-scoped skill catalog.
 *
 * Replaces `@deepseek-ai/dsh-skill-filesystem` inside an agent preset and
 * filters the discovered catalog with a file that lives in the workspace:
 * `<workspace>/.dsh/skill-scope.yml`.
 *
 * Without that file the behavior matches the stock filesystem provider:
 * project roots, user roots and the bundled root are all scanned.
 *
 * This module holds no Cordis plugin: `provider.js` is the preset half and
 * `index.js` is the Host half, and both read the catalog from here.
 *
 * @module dsh-workspace-skill-scope/catalog
 */
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { MCP_SERVER_NAME_PATTERN } from "./mcp-scope.js";

const PROVIDER_NAME = "workspace-scope";
const PROJECT_DSH_RANK = 100;
const PROJECT_AGENTS_RANK = 200;
const USER_DSH_RANK = 400;
const USER_AGENTS_RANK = 500;
const BUNDLED_RANK = 600;
const CONFIG_SEGMENTS = [".dsh", "skill-scope.yml"];
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const POLL_INTERVAL_MS = 1500;
const MAX_KNOWN_WORKSPACES = 32;

/** Default policy: identical to the stock filesystem provider. */
const DEFAULT_CONFIG = Object.freeze({
  projectSkills: true,
  userSkills: true,
  bundled: true,
  allow: Object.freeze([]),
  deny: Object.freeze([]),
  include: Object.freeze([]),
  mcpServers: undefined,
});

/** Skill provider that maps workspace-configured local skill roots into `ctx.skills`. */
export class WorkspaceScopeProvider {
  /** @param {object} ctx - plugin context. @param {object} control - registration lifecycle control. */
  constructor(ctx, control) {
    this.ctx = ctx;
    this.name = PROVIDER_NAME;
    this.control = control;
    /** workspace root -> catalog signature, used to invalidate the registry cache. */
    this.known = new Map();
    this.ticking = false;
    this.disposed = false;
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
    control.signal.addEventListener("abort", () => {
      this.dispose();
    }, { once: true });
  }

  /**
   * Discover the catalog visible to one workspace.
   * @param {{cwd?: string, signal?: AbortSignal}} options - lookup options.
   * @returns {Promise<Array<object>>} provider candidates carrying root ranks.
   */
  async list(options = {}) {
    if (this.disposed) return [];
    const cwd = options.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) return [];
    const root = await findWorkspaceRoot(cwd);
    const { config } = await readWorkspaceConfig(root, this.ctx);
    const roots = rootsFor(root);
    const candidates = [];
    for (const entry of roots) {
      try {
        candidates.push(...await discoverRoot(entry, PROVIDER_NAME, this.ctx, config));
      } catch (error) {
        if (options.signal?.aborted === true) throw error;
        warn(this.ctx, `skill-scope: root ${entry.path} skipped: ${messageOf(error)}`);
      }
    }
    rememberWorkspace(this.known, root, await signatureFor(root, config, roots));
    return candidates;
  }

  /**
   * Load one skill body from the candidate's file locator.
   * @param {object} candidate - a candidate returned by this provider.
   * @param {{signal?: AbortSignal}} options - lookup options.
   * @returns {Promise<object|undefined>} the full skill, or undefined if it vanished.
   */
  async get(candidate, options = {}) {
    const locator = candidate.locator;
    const parsed = await readSkillFile(locator.path, this.ctx, options.signal);
    if (parsed === undefined) return undefined;
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      invocation: parsed.invocation,
      source: candidate.source,
      provider: PROVIDER_NAME,
      resourceBase: { kind: "directory", path: locator.directory },
      path: parsed.path,
      ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
      content: parsed.content,
    };
  }

  /** Invalidate the registry when a watched workspace's catalog signature changes. */
  async tick() {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      for (const [root, previous] of [...this.known]) {
        const { config } = await readWorkspaceConfig(root, this.ctx);
        const roots = rootsFor(root);
        const next = await signatureFor(root, config, roots).catch(() => previous);
        if (next !== previous) {
          this.known.set(root, next);
          this.control.invalidate();
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Stop the poller; safe to call more than once. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
  }
}

/**
 * Resolve the workspace root for one session directory: the nearest ancestor
 * that is a git work tree or that carries a skill-scope file.
 * @param {string} cwd - session working directory.
 * @returns {Promise<string>} absolute workspace root.
 */
export async function findWorkspaceRoot(cwd) {
  const start = resolve(cwd);
  const home = homedir();
  let current = start;
  while (true) {
    if (await isWorkspaceMarker(current)) return current;
    const parent = dirname(current);
    if (parent === current || parent === home) return start;
    current = parent;
  }
}

async function isWorkspaceMarker(directory) {
  if (await pathExists(join(directory, ".git"))) return true;
  if (await pathExists(join(directory, ...CONFIG_SEGMENTS))) return true;
  if (await pathExists(join(directory, ".dsh", "skills"))) return true;
  return await pathExists(join(directory, ".agents", "skills"));
}

/**
 * Read `<workspace>/.dsh/skill-scope.yml`.
 * @param {string} root - workspace root.
 * @param {object} ctx - plugin context for warnings.
 * @returns {Promise<{config: object, signature: string}>} normalized policy.
 */
export async function readWorkspaceConfig(root, ctx) {
  const path = join(root, ...CONFIG_SEGMENTS);
  let raw;
  let stamp;
  try {
    const info = await stat(path);
    raw = await readFile(path, "utf8");
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch (error) {
    if (isAbsentPathError(error)) return { config: DEFAULT_CONFIG, signature: "absent" };
    warn(ctx, `skill-scope: ${path} ignored: ${messageOf(error)}`);
    return { config: DEFAULT_CONFIG, signature: "unreadable" };
  }
  let parsed;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    warn(ctx, `skill-scope: ${path} ignored: invalid YAML: ${messageOf(error)}`);
    return { config: DEFAULT_CONFIG, signature: `invalid:${stamp}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn(ctx, `skill-scope: ${path} ignored: the file must be a YAML mapping`);
    return { config: DEFAULT_CONFIG, signature: `invalid:${stamp}` };
  }
  try {
    return { config: normalizeConfig(parsed, path, ctx), signature: stamp };
  } catch (error) {
    warn(ctx, `skill-scope: ${path} ignored: ${messageOf(error)}`);
    return { config: DEFAULT_CONFIG, signature: `invalid:${stamp}` };
  }
}

/**
 * Validate and normalize one parsed scope file.
 * @param {object} input - parsed YAML mapping.
 * @param {string} path - source path for diagnostics.
 * @param {object} ctx - plugin context for warnings.
 * @returns {object} normalized policy.
 */
export function normalizeConfig(input, path, ctx) {
  const known = new Set(["projectSkills", "userSkills", "bundled", "allow", "deny", "include", "mcpServers", "comment"]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) warn(ctx, `skill-scope: ${path} has unknown field "${key}"`);
  }
  const config = {
    projectSkills: readBoolean(input, "projectSkills", true, path),
    userSkills: readBoolean(input, "userSkills", true, path),
    bundled: readBoolean(input, "bundled", true, path),
    allow: readNameList(input, "allow", path),
    deny: readNameList(input, "deny", path),
    include: readNameList(input, "include", path),
    mcpServers: readMcpServerList(input, path),
  };
  return config;
}

function readBoolean(input, key, fallback, path) {
  if (!Object.hasOwn(input, key)) return fallback;
  const value = input[key];
  if (typeof value === "boolean") return value;
  throw new TypeError(`"${key}" must be true or false`);
}

function readNameList(input, key, path) {
  if (!Object.hasOwn(input, key) || input[key] === null) return [];
  const value = input[key];
  if (!Array.isArray(value)) throw new TypeError(`"${key}" must be a list of skill names`);
  const names = [];
  for (const item of value) {
    if (typeof item !== "string" || !SKILL_NAME.test(item)) {
      throw new TypeError(`"${key}" contains an invalid skill name: ${JSON.stringify(item)}`);
    }
    names.push(item);
  }
  return names;
}

function readMcpServerList(input) {
  if (!Object.hasOwn(input, "mcpServers")) return undefined;
  const value = input.mcpServers;
  if (!Array.isArray(value)) throw new TypeError('"mcpServers" must be a list of MCP server names');
  const names = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !MCP_SERVER_NAME_PATTERN.test(item)) {
      throw new TypeError(`"mcpServers" contains an invalid MCP server name: ${JSON.stringify(item)}`);
    }
    if (!seen.has(item)) names.push(item);
    seen.add(item);
  }
  return names;
}

/**
 * Build the scan roots for one workspace and its policy.
 * @param {string} root - workspace root.
 * @param {object} config - normalized policy.
 * @returns {Array<object>} ordered roots.
 */
export function rootsFor(root) {
  // Every root is scanned, whatever the group switches say: a switch only
  // changes visibility, so an explicitly included skill can come back from a
  // group that is switched off.
  const roots = [
    { path: join(root, ".dsh", "skills"), source: "project-dsh", rank: PROJECT_DSH_RANK },
    { path: join(root, ".agents", "skills"), source: "project-agents", rank: PROJECT_AGENTS_RANK },
    {
      path: join(envHome("DSH_HOME", ".dsh"), "skills"),
      source: "user-dsh",
      rank: USER_DSH_RANK,
      skipSystem: true,
    },
    {
      path: join(envHome("DSH_AGENTS_HOME", ".agents"), "skills"),
      source: "user-agents",
      rank: USER_AGENTS_RANK,
    },
  ];
  const bundled = bundledSkillDir();
  if (bundled !== undefined) roots.push({ path: bundled, source: "bundled", rank: BUNDLED_RANK, trusted: true });
  return roots;
}

let cachedBundledDir;
/** Resolve the shipped bundled-skill root, with a packaged-app fallback when the env override is absent. */
function bundledSkillDir() {
  if (cachedBundledDir !== undefined) return cachedBundledDir;
  const fromEnv = process.env.DSH_BUNDLED_SKILL_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    cachedBundledDir = resolve(expandHome(fromEnv));
    return cachedBundledDir;
  }
  const resources = typeof process.resourcesPath === "string" ? process.resourcesPath : undefined;
  if (resources !== undefined) {
    for (const candidate of [
      join(resources, "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-agent-preset", "skills"),
      join(resources, "dsh", "node_modules", "@deepseek-ai", "dsh-agent-preset", "skills"),
    ]) {
      if (existsSync(candidate)) {
        cachedBundledDir = candidate;
        return cachedBundledDir;
      }
    }
  }
  return undefined;
}

function envHome(variable, directory) {
  const override = process.env[variable];
  if (typeof override === "string" && override.trim().length > 0) return resolve(expandHome(override));
  return join(homedir(), directory);
}

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Discover every skill under one root.
 * @param {object} root - scan root with source and rank.
 * @param {string} providerName - provider name stamped on candidates.
 * @param {object} ctx - plugin context for warnings.
 * @param {object} config - normalized policy.
 * @param {{includeHidden?: boolean}} [options] - `includeHidden` keeps policy-denied skills and marks them.
 * @returns {Promise<Array<object>>} candidates accepted by the policy.
 */
export async function discoverRoot(root, providerName, ctx, config, options = {}) {
  let entries;
  try {
    entries = await readdir(root.path, { withFileTypes: true });
  } catch (error) {
    if (isAbsentPathError(error)) return [];
    throw error;
  }
  const includeHidden = options.includeHidden === true;
  const candidates = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (root.skipSystem === true && entry.name === ".system") continue;
    const entryPath = join(root.path, entry.name);
    const kind = await entryKind(entryPath, entry, ctx);
    let skillPath;
    let directory;
    if (kind === "directory") {
      skillPath = join(entryPath, "SKILL.md");
      directory = entryPath;
    } else if (kind === "file" && entry.name.endsWith(".md")) {
      skillPath = entryPath;
      directory = root.path;
    } else {
      continue;
    }
    let parsed;
    try {
      parsed = await readSkillFile(skillPath, ctx, undefined, root.trusted === true);
    } catch (error) {
      warn(ctx, `skill-scope: ${skillPath} skipped: ${messageOf(error)}`);
      continue;
    }
    if (parsed === undefined) continue;
    const visible = isVisible(config, root.source, parsed.name);
    if (!visible && !includeHidden) continue;
    candidates.push({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      invocation: parsed.invocation,
      provider: providerName,
      source: root.source,
      rank: root.rank,
      locator: { path: skillPath, directory },
      resourceBase: { kind: "directory", path: directory },
      path: parsed.path,
      ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
      ...(includeHidden ? { visible } : {}),
    });
  }
  return candidates;
}

/**
 * Collect the full picture of one workspace for a UI: every root, every skill,
 * and whether the current policy hides it.
 * @param {string} workspace - directory a session runs in.
 * @param {object} ctx - plugin context (only `logger.warn` is used).
 * @returns {Promise<object>} workspace root, policy file, normalized policy, and per-root groups.
 */
export async function collectWorkspaceCatalog(workspace, ctx) {
  const root = await findWorkspaceRoot(workspace);
  const { config } = await readWorkspaceConfig(root, ctx);
  const file = join(root, ...CONFIG_SEGMENTS);
  // Scan every root, including the ones a group switch turns off: the panel has to
  // show what a workspace would get, not only what it currently gets.
  const scanRoots = rootsFor(root);
  const groups = [];
  for (const scanRoot of scanRoots) {
    let candidates = [];
    try {
      candidates = await discoverRoot(scanRoot, PROVIDER_NAME, ctx, config, { includeHidden: true });
    } catch (error) {
      warn(ctx, `skill-scope: root ${scanRoot.path} skipped: ${messageOf(error)}`);
    }
    const groupEnabled = switchFor(scanRoot.source, config);
    groups.push({
      key: scanRoot.source,
      path: scanRoot.path,
      enabled: groupEnabled,
      skills: candidates.map((candidate) => ({
        name: candidate.name,
        description: candidate.description,
        path: candidate.locator.path,
        visible: candidate.visible === true,
      })),
    });
  }
  return {
    workspace: root,
    file,
    fileExists: existsSync(file),
    config: {
      projectSkills: config.projectSkills,
      userSkills: config.userSkills,
      bundled: config.bundled,
      allow: [...config.allow],
      deny: [...config.deny],
      include: [...config.include],
    },
    groups,
  };
}

/** Which group switch owns one scan root. */
function switchFor(source, config) {
  switch (source) {
    case "project-dsh":
    case "project-agents":
      return config.projectSkills;
    case "user-dsh":
    case "user-agents":
      return config.userSkills;
    case "bundled":
      return config.bundled;
    default:
      return true;
  }
}



/** Providers currently mounted by a preset, so a panel save can refresh them at once. */
const liveProviders = new Set();

/**
 * Track one mounted provider for out-of-band invalidation.
 * @param {{control?: {invalidate?: Function}}} provider - provider instance.
 * @returns {Function} disposer removing the provider from the registry.
 */
export function trackWorkspaceProvider(provider) {
  liveProviders.add(provider);
  return () => {
    liveProviders.delete(provider);
  };
}

/**
 * Tell every mounted provider that the policy file changed.
 *
 * The poller would notice within its interval; a panel save should not make the
 * user wait for it, so the save path calls this directly.
 */
export function invalidateWorkspaceProviders() {
  for (const provider of [...liveProviders]) {
    try {
      provider.control?.invalidate?.();
    } catch {
      /* the provider is being torn down; nothing to refresh */
    }
  }
}

/**
 * Whether one skill is visible under a policy.
 *
 * Precedence: `deny` wins, then an explicit `include` entry (which is how a
 * single skill stays usable while its group switch is off), then the `allow`
 * whitelist, then the group switch itself.
 * @param {object} config - normalized policy.
 * @param {string} source - scan root the skill came from.
 * @param {string} skillName - skill name.
 * @returns {boolean} true when the catalog should carry it.
 */
export function isVisible(config, source, skillName) {
  if (config.deny.includes(skillName)) return false;
  if (config.include.includes(skillName)) return true;
  if (config.allow.length > 0) return config.allow.includes(skillName);
  return switchFor(source, config);
}

async function entryKind(entryPath, entry, ctx) {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return undefined;
  try {
    const info = await stat(entryPath);
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return undefined;
  } catch (error) {
    warn(ctx, `skill-scope: ${entryPath} skipped: ${messageOf(error)}`);
    return undefined;
  }
}

async function readSkillFile(path, ctx, signal, trusted = false) {
  signal?.throwIfAborted?.();
  let resolved;
  let raw;
  try {
    resolved = await realpath(path);
    raw = await readFile(resolved, "utf8");
  } catch (error) {
    signal?.throwIfAborted?.();
    if (isAbsentPathError(error)) return undefined;
    throw error;
  }
  const frontmatter = parseFrontmatter(raw);
  if (frontmatter === undefined) {
    warn(ctx, `skill-scope: ${resolved} ignored: missing YAML frontmatter`);
    return undefined;
  }
  const skillName = stringField(frontmatter.data, "name");
  const description = stringField(frontmatter.data, "description");
  if (skillName === undefined || description === undefined) {
    warn(ctx, `skill-scope: ${resolved} ignored: frontmatter requires name and description`);
    return undefined;
  }
  if (!SKILL_NAME.test(skillName)) {
    warn(ctx, `skill-scope: ${resolved} ignored: invalid skill name "${skillName}"`);
    return undefined;
  }
  let invocation;
  try {
    invocation = parseInvocationPolicy(frontmatter.data);
  } catch (error) {
    warn(ctx, `skill-scope: ${resolved} ignored: invalid invocation frontmatter: ${messageOf(error)}`);
    return undefined;
  }
  return {
    name: skillName,
    description,
    ...optionalString(frontmatter.data, "whenToUse"),
    invocation,
    ...optionalMetadata(frontmatter.data),
    path: resolved,
    content: frontmatter.body.trim(),
  };
}

function parseFrontmatter(raw) {
  const firstLineEnd = raw.indexOf("\n");
  if (firstLineEnd < 0) return undefined;
  if (raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") return undefined;
  const start = firstLineEnd + 1;
  const closing = findClosingFrontmatter(raw, start);
  if (closing === undefined) return undefined;
  const parsed = parseYaml(raw.slice(start, closing.start));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return { data: parsed, body: raw.slice(closing.bodyStart) };
}

function findClosingFrontmatter(raw, start) {
  let lineStart = start;
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf("\n", lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 };
    }
    if (nextNewline < 0) return undefined;
    lineStart = nextNewline + 1;
  }
  return undefined;
}

function parseInvocationPolicy(data) {
  for (const legacy of ["disableModelInvocation", "modelInvocable", "userInvocable"]) {
    if (Object.hasOwn(data, legacy)) throw new Error(`frontmatter field "${legacy}" is unsupported`);
  }
  const disableModelInvocation = frontmatterBoolean(data, "disable-model-invocation");
  const userInvocable = frontmatterBoolean(data, "user-invocable");
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  };
}

function frontmatterBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return undefined;
  const value = data[key];
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value === "string") {
    switch (value.toLowerCase()) {
      case "true":
      case "yes":
      case "on": return true;
      case "false":
      case "no":
      case "off": return false;
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`);
}

function stringField(data, key) {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalString(data, key) {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? { [key]: value } : {};
}

function optionalMetadata(data) {
  const value = data.metadata;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { metadata: value } : {};
}

async function signatureFor(root, config, roots) {
  const { signature } = await readWorkspaceConfig(root, { logger: undefined });
  const parts = [signature];
  for (const scanRoot of roots) {
    let entries;
    try {
      entries = await readdir(scanRoot.path, { withFileTypes: true });
    } catch {
      parts.push(`${scanRoot.path}:absent`);
      continue;
    }
    const stamps = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const info = await statOrUndefined(join(scanRoot.path, entry.name, "SKILL.md"))
        ?? await statOrUndefined(join(scanRoot.path, entry.name));
      stamps.push(`${entry.name}:${info === undefined ? "-" : `${info.mtimeMs}:${info.size}`}`);
    }
    parts.push(`${scanRoot.path}[${stamps.join(",")}]`);
  }
  return parts.join("|");
}

function rememberWorkspace(known, root, signature) {
  known.delete(root);
  known.set(root, signature);
  while (known.size > MAX_KNOWN_WORKSPACES) {
    const oldest = known.keys().next();
    if (oldest.done === true) break;
    known.delete(oldest.value);
  }
}

async function statOrUndefined(path) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isAbsentPathError(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function warn(ctx, message) {
  ctx?.logger?.warn?.(message);
}
