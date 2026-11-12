/**
 * Host-level catalog filter, for Sessions that were created before the
 * `workspace-scope` preset existed.
 *
 * A Session binds its preset at creation: an old Session keeps the
 * `standard` preset (and that preset's `skill-filesystem` provider) for its
 * whole life, so nothing inside a preset can reach it. The shared `skills`
 * service can, so this module wraps its read paths and drops the names the
 * workspace policy hides.
 *
 * Only names this package manages are touched: a skill that no scan root
 * produced (office skills, runtime-registered skills) is always kept. Any
 * failure fails open — an unfiltered catalog is better than a broken one.
 *
 * @module dsh-workspace-skill-scope/filter
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
 * @returns {Function} disposer restoring the original methods.
 */
export function installSkillFilter(ctx, skills) {
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

  try {
    skills.list = async function list(options = {}) {
      const result = await originalList.call(this, options);
      const managed = await managedFor(options.cwd);
      return managed === undefined ? result : result.filter((skill) => keep(managed, skill.name));
    };
    if (typeof originalSnapshot === "function") {
      skills.snapshot = async function snapshot(options = {}) {
        const result = await originalSnapshot.call(this, options);
        if (result === undefined) return result;
        const managed = await managedFor(options.cwd);
        if (managed === undefined) return result;
        return { ...result, skills: result.skills.filter((skill) => keep(managed, skill.name)) };
      };
    }
    if (typeof originalGet === "function") {
      skills.get = async function get(name, options = {}) {
        const managed = await managedFor(options.cwd);
        if (managed !== undefined && !keep(managed, name)) return undefined;
        return originalGet.call(this, name, options);
      };
    }
  } catch (error) {
    ctx?.logger?.warn?.(`workspace-skill-scope: cannot filter the shared skill service: ${messageOf(error)}`);
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
