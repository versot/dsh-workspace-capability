/**
 * Host-level catalog filter for every preset and existing Session.
 *
 * A Session binds its preset at creation, so a workspace-specific preset could
 * not reach Sessions created under another composition. The shared `skills`
 * service can, so this module wraps its read paths and drops the names the
 * workspace policy hides.
 *
 * Workspace policy touches only names managed by its scan roots. An explicit
 * Agent allowlist is then applied to the complete resulting catalog, including
 * runtime Skills. Workspace discovery failures fail open; persisted Agent
 * policy failures fail closed in AgentSkillScopes.
 *
 * @module dsh-workspace-capability/filter
 */
import { collectWorkspaceCatalog } from "./catalog.js";

const installed = new WeakSet();
let activeCount = 0;

/** Whether the shared-service filter is currently installed. */
export function isSkillFilterActive() {
  return activeCount > 0;
}

/**
 * Wrap `skills.list` / `skills.snapshot` / `skills.get` with the workspace policy.
 * @param {object} ctx - host context (used for logger warnings).
 * @param {object} skills - the `skills` service instance.
 * @param {object} [agentScopes] - durable Agent-specific allowlist resolver.
 * @returns {Function} disposer restoring the original methods.
 */
export function installSkillFilter(ctx, skills, agentScopes) {
  if (skills === undefined || skills === null) return () => {};
  if (installed.has(skills)) return () => {};
  const originalList = skills.list;
  const originalSnapshot = skills.snapshot;
  const originalGet = skills.get;
  if (typeof originalList !== "function") return () => {};

  /** @param {string|undefined} cwd - viewing workspace. @returns {Promise<Map<string, boolean>|undefined>} managed names. */
  async function managedFor(cwd) {
    if (typeof cwd !== "string" || cwd.length === 0) return undefined;
    try {
      const catalog = await collectWorkspaceCatalog(cwd, ctx);
      const managed = new Map();
      for (const group of catalog.groups) {
        for (const skill of group.skills) {
          // Same name from several roots: keep it if any root shows it, because
          // the winning candidate may come from that root.
          managed.set(skill.name, (managed.get(skill.name) ?? false) || skill.visible === true);
        }
      }
      return managed;
    } catch {
      return undefined;
    }
  }

  function keep(managed, name) {
    const visible = managed.get(name);
    return visible === undefined ? true : visible;
  }

  async function agentAllowlist(options) {
    if (agentScopes === undefined || options?.scope === undefined) return undefined;
    return (await agentScopes.get(options.scope, options.cwd))?.skills;
  }

  function filterResult(result, managed, allowlist) {
    const allowed = allowlist === undefined ? undefined : new Set(allowlist);
    return result.filter((skill) => (managed === undefined || keep(managed, skill.name))
      && (allowed === undefined || allowed.has(skill.name)));
  }

  try {
    if (typeof originalSnapshot === "function") {
      // DSH's list() delegates to this.snapshot(options), so wrapping snapshot
      // filters both paths once. Wrapping list as well would repeat workspace
      // discovery and Agent policy lookup for every list call.
      skills.snapshot = async function snapshot(options = {}) {
        const result = await originalSnapshot.call(this, options);
        if (result === undefined) return result;
        const [managed, allowlist] = await Promise.all([managedFor(options.cwd), agentAllowlist(options)]);
        return { ...result, skills: filterResult(result.skills, managed, allowlist) };
      };
    } else {
      // Compatibility fallback for a skills service without snapshot().
      skills.list = async function list(options = {}) {
        const result = await originalList.call(this, options);
        const [managed, allowlist] = await Promise.all([managedFor(options.cwd), agentAllowlist(options)]);
        return filterResult(result, managed, allowlist);
      };
    }
    if (typeof originalGet === "function") {
      skills.get = async function get(name, options = {}) {
        const [managed, allowlist] = await Promise.all([managedFor(options.cwd), agentAllowlist(options)]);
        if (managed !== undefined && !keep(managed, name)) return undefined;
        if (allowlist !== undefined && !allowlist.includes(name)) return undefined;
        return originalGet.call(this, name, options);
      };
    }
  } catch (error) {
    ctx?.logger?.warn?.(`workspace-capability: cannot filter the shared skill service: ${messageOf(error)}`);
    return () => {};
  }

  try {
    skills.list.__workspaceScopeFilter = true;
  } catch {
    /* a proxy that rejects property writes still routes the call below */
  }
  installed.add(skills);
  activeCount += 1;
  return () => {
    skills.list = originalList;
    if (typeof originalSnapshot === "function") skills.snapshot = originalSnapshot;
    if (typeof originalGet === "function") skills.get = originalGet;
    installed.delete(skills);
    activeCount = Math.max(0, activeCount - 1);
  };
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
