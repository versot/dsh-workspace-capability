/**
 * Predefined subagent capability presets: one Markdown file per preset under
 * `<workspace>/.dsh/agents/`.
 *
 * A preset supplies Skill and whole-MCP-server defaults. Its description helps
 * the parent choose a suitable preset; no prose is sent to the child. Presets
 * never modify system prompts or grant capabilities hidden from the parent.
 *
 * @module dsh-workspace-capability/roles
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { findWorkspaceRoot } from "./catalog.js";
import { MCP_SERVER_NAME_PATTERN } from "./mcp-scope.js";

const ROLE_DIR_SEGMENTS = [".dsh", "agents"];
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A role file's stem becomes its callable name. */
export const ROLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Absolute directory that holds this workspace's role files. */
export function rolesDirectory(root) {
  return join(root, ...ROLE_DIR_SEGMENTS);
}

/**
 * Read and validate one role file.
 * @param {string} root - workspace root.
 * @param {string} name - role name (the file stem).
 * @returns {Promise<{name: string, description: string, skills?: string[], mcpServers?: string[]}>} frozen role.
 */
export async function readRole(root, name) {
  if (typeof name !== "string" || !ROLE_NAME.test(name)) throw new Error(`invalid role name: ${String(name)}`);
  const label = `.dsh/agents/${name}.md`;
  let raw;
  try {
    raw = await readFile(join(rolesDirectory(root), `${name}.md`), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`unknown role "${name}": this workspace has no ${label}`);
    throw new Error(`cannot read role "${name}" (${label}): ${messageOf(error)}`);
  }
  return parseRole(name, raw, label);
}

/**
 * Parse a role document. Kept pure so the format can be tested without a disk.
 * @param {string} name - role name.
 * @param {string} raw - file contents.
 * @param {string} source - label used in error messages.
 * @returns {object} frozen role.
 */
export function parseRole(name, raw, source = `.dsh/agents/${name}.md`) {
  if (typeof name !== "string" || !ROLE_NAME.test(name)) throw new Error(`invalid role name: ${String(name)}`);
  if (typeof raw !== "string") throw new Error(`${source}: role file is not text`);
  const match = FRONTMATTER.exec(raw);
  if (match === null) throw new Error(`${source}: a role file must start with a \`---\` YAML frontmatter block`);

  let meta;
  try {
    meta = parse(match[1]);
  } catch (error) {
    throw new Error(`${source}: invalid YAML frontmatter: ${messageOf(error)}`);
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new Error(`${source}: frontmatter must be a mapping`);
  }
  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  if (description.length === 0) throw new Error(`${source}: "description" is required and must be a non-empty string`);

  const displayName = meta.displayName === undefined ? name : meta.displayName;
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(displayName)) {
    throw new Error(`${source}: "displayName" must be a non-empty string of at most 100 characters without control characters`);
  }
  return Object.freeze({
    name,
    id: name,
    displayName: displayName.trim(),
    description,
    ...meta.skills === undefined ? {} : { skills: validateNames(meta.skills, SKILL_NAME, source, "skills", "Skill") },
    ...meta.mcpServers === undefined
      ? {}
      : { mcpServers: validateNames(meta.mcpServers, MCP_SERVER_NAME_PATTERN, source, "mcpServers", "MCP server") },
  });
}

/**
 * List every valid role in a workspace plus the files that could not be used.
 *
 * One broken file must not hide the rest, and it must not be silently dropped
 * either: the caller reports `problems` so a typo stays visible.
 * @param {string} root - workspace root.
 * @returns {Promise<{roles: object[], problems: {file: string, message: string}[]}>} catalog.
 */
export async function listRoles(root) {
  let entries;
  try {
    entries = await readdir(rolesDirectory(root), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { roles: [], problems: [] };
    throw new Error(`cannot list roles: ${messageOf(error)}`);
  }
  const roles = [];
  const problems = [];
  for (const entry of entries.filter((item) => item.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -".md".length);
    if (!ROLE_NAME.test(name)) {
      problems.push({ file: entry.name, message: "the file name is not a usable role name" });
      continue;
    }
    try {
      roles.push(await readRole(root, name));
    } catch (error) {
      problems.push({ file: entry.name, message: messageOf(error) });
    }
  }
  return { roles, problems };
}

/**
 * Register the role catalog as a model-facing tool.
 *
 * A delegating Agent cannot call a role it cannot name, and the role list lives
 * in a workspace file rather than in the prompt, so it needs a tool.
 * @param {object} ctx - host context carrying `tools` and `workingDirectory`.
 * @returns {() => void} disposer.
 */
export function installRoleCatalogTool(ctx) {
  const definition = {
    name: "list_subagent_roles",
    description: "List capability presets and recommended scenarios under .dsh/agents/. Use description to choose a preset, then pass its name as role to subagent_with_skills with a self-contained task prompt. Presets supply only Skill/MCP defaults; descriptions and file bodies are not injected into the child.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["roles"],
        properties: {
          roles: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "description"],
              properties: {
                name: { type: "string", description: "Stable identifier used as the role argument; unchanged by display renames." },
                id: { type: "string" },
                displayName: { type: "string" },
                description: { type: "string" },
                skills: { type: "array", items: { type: "string" } },
                mcpServers: { type: "array", items: { type: "string" } },
              },
            },
          },
          problems: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["file", "message"],
              properties: { file: { type: "string" }, message: { type: "string" } },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.roles.length === 0 ? "no subagent roles are defined in this workspace" : value.roles
          .map((role) => `${role.displayName} (role=${role.id}): ${role.description}`)
          .join("\n"),
      }],
      presentationMeta: (_args, value) => ({ roles: value.roles.map((role) => role.name) }),
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      if (!exec.agent) throw new Error("list_subagent_roles requires a calling Agent");
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const root = await findWorkspaceRoot(cwd);
      const { roles, problems } = await listRoles(root);
      return {
        roles: roles.map((role) => ({
          name: role.name,
          id: role.id,
          displayName: role.displayName,
          description: role.description,
          ...role.skills === undefined ? {} : { skills: [...role.skills] },
          ...role.mcpServers === undefined ? {} : { mcpServers: [...role.mcpServers] },
        })),
        ...problems.length === 0 ? {} : { problems },
      };
    },
  };
  return ctx.tools.register(definition);
}

function validateNames(value, pattern, source, field, label) {
  if (!Array.isArray(value)) throw new Error(`${source}: "${field}" must be an array`);
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !pattern.test(item)) throw new Error(`${source}: invalid ${label} name: ${String(item)}`);
    if (!seen.has(item)) result.push(item);
    seen.add(item);
  }
  return Object.freeze(result);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
