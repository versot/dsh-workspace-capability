/**
 * Host half: the panel's JSON API.
 *
 * This row exists for two reasons. It serves the data the browser panel renders
 * and accepts its saves, and it is the package's root Host entry — DSH discovers
 * a package's browser half by scanning active Loader rows whose manifest
 * declares `dsh.client`, and that scan only understands a bare package
 * specifier, so the root entry has to be the one that carries it. The skill
 * provider itself lives in `provider.js` and is mounted by the preset, not here.
 *
 * Routes (prefix `/dsh-workspace-skill-scope`):
 *   GET  /catalog?session=<sessionId>   workspace of that session
 *   GET  /catalog?workspace=<absPath>   explicit workspace (used by tests)
 *   POST /policy                        { workspace|session, config } → rewritten catalog
 *
 * @module dsh-workspace-skill-scope
 */
import { statSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import {
  collectWorkspaceCatalog,
  findWorkspaceRoot,
  invalidateWorkspaceProviders,
  normalizeConfig,
} from "./catalog.js";
import { installSkillFilter, isSkillFilterActive } from "./filter.js";

export const name = "workspace-skill-scope-host";
export const inject = ["webServer"];

const PREFIX = "/dsh-workspace-skill-scope";
const BODY_LIMIT_BYTES = 256 * 1024;
const POLICY_HEADER = [
  "# 由「工作区 Skill」面板写入；也可以直接手改。",
  "# projectSkills / userSkills / bundled 是整组开关；include 里的名字即使整组关掉也保留；deny 精确排除。",
  "",
].join("\n");

/**
 * Register the panel's HTTP surface, torn down with the plugin.
 * @param {object} ctx - host context carrying `webServer`.
 */
export function apply(ctx) {
  // Old Sessions keep the preset they were created with, so the only way to make
  // the workspace policy reach them is the shared `skills` service, not the
  // preset. Fail-open: an empty catalog is worse than an unfiltered one.
  ctx.inject(["skills"], (skillsCtx) => {
    const restore = installSkillFilter(skillsCtx, skillsCtx.skills);
    skillsCtx.effect(() => () => restore(), "workspace-skill-scope: shared catalog filter");
  });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: PREFIX,
        handler: (req, res) => {
          handle(ctx, req, res).catch((error) => {
            ctx.logger?.warn?.(`workspace-skill-scope: ${messageOf(error)}`);
            if (!res.destroyed && !res.writableEnded) {
              sendJson(res, 500, { error: { code: "internal-error", message: "workspace-skill-scope: internal error" } });
            }
          });
        },
      }),
    `workspace-skill-scope: ${PREFIX} route`,
  );
}

async function handle(ctx, req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const rest = url.pathname.slice(PREFIX.length).replace(/^\/+/, "");

  if (rest === "catalog" && (req.method === "GET" || req.method === "HEAD")) {
    const workspace = resolveWorkspace(ctx, url.searchParams.get("session"), url.searchParams.get("workspace"));
    if (workspace === undefined) return sendNoWorkspace(res);
    sendJson(res, 200, withFilterState(await collectWorkspaceCatalog(workspace, ctx)));
    return;
  }

  if (rest === "policy" && req.method === "POST") {
    await savePolicy(ctx, req, res);
    return;
  }

  if (rest === "catalog" || rest === "policy") {
    sendJson(res, 405, {
      error: { code: "method-not-allowed", message: `only ${rest === "policy" ? "POST" : "GET"} is supported` },
    });
    return;
  }
  sendJson(res, 404, { error: { code: "route/unknown", message: `unknown route "${rest}"` } });
}

/**
 * Validate one submitted policy, write it atomically, refresh live providers.
 * @param {object} ctx - host context.
 * @param {import("node:http").IncomingMessage} req - request carrying `{ workspace|session, config }`.
 * @param {import("node:http").ServerResponse} res - response to answer.
 */
async function savePolicy(ctx, req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: { code: "body/invalid", message: messageOf(error) } });
    return;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: { code: "body/invalid", message: "body must be a JSON object" } });
    return;
  }
  const workspace = resolveWorkspace(ctx, body.session, body.workspace);
  if (workspace === undefined) return sendNoWorkspace(res);
  if (typeof body.config !== "object" || body.config === null || Array.isArray(body.config)) {
    sendJson(res, 400, { error: { code: "config/invalid", message: "config must be a JSON object" } });
    return;
  }

  const root = await findWorkspaceRoot(workspace);
  const file = join(root, ".dsh", "skill-scope.yml");
  let config;
  try {
    config = normalizeConfig(body.config, file, ctx);
  } catch (error) {
    sendJson(res, 400, { error: { code: "config/invalid", message: messageOf(error) } });
    return;
  }

  const text =
    POLICY_HEADER +
    stringify(
      {
        projectSkills: config.projectSkills,
        userSkills: config.userSkills,
        bundled: config.bundled,
        allow: [...config.allow],
        deny: [...config.deny],
        include: [...config.include],
      },
      { lineWidth: 0 },
    );

  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    sendJson(res, 500, { error: { code: "policy/write-failed", message: messageOf(error) } });
    return;
  }

  // A save must be visible on the next model request, not on the poller's tick.
  invalidateWorkspaceProviders();
  sendJson(res, 200, withFilterState(await collectWorkspaceCatalog(workspace, ctx)));
}

/** Attach whether the every-session filter is live, so the panel can warn when it is not. */
function withFilterState(catalog) {
  return { ...catalog, filterInstalled: isSkillFilterActive() };
}

function sendNoWorkspace(res) {
  sendJson(res, 404, {
    error: { code: "workspace/unknown", message: "no workspace could be resolved for this request" },
  });
}

/**
 * Find the directory a session belongs to.
 *
 * The workspace registry knows every workspace and the sessions attached to it,
 * including sessions that are not live in this Host; a live session header is the
 * fallback for a row the registry has not seen.
 * @param {object} ctx - host context.
 * @param {string|null} sessionId - session whose workspace is wanted.
 * @param {string|null} explicit - absolute workspace path supplied by a test.
 * @returns {string|undefined} absolute directory.
 */
function resolveWorkspace(ctx, sessionId, explicit) {
  if (typeof explicit === "string" && explicit.length > 0) {
    const directory = resolve(explicit);
    try {
      return statSync(directory).isDirectory() ? directory : undefined;
    } catch {
      return undefined;
    }
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  const registry = ctx.get("workspaceRegistry");
  if (registry !== undefined) {
    for (const workspace of registry.list()) {
      if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
        return workspace.path;
      }
    }
  }
  const cwd = ctx.get("sessions")?.get(sessionId)?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

/**
 * Collect a request body with a hard cap.
 * @param {import("node:http").IncomingMessage} req - request.
 * @returns {Promise<string>} UTF-8 body.
 */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
