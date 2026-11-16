/**
 * Optional provider export for consumers that explicitly mount a
 * workspace-scoped Skill provider on `ctx.skills`.
 *
 * The shipped bundle does not declare a separate preset: its Host row installs
 * the shared filter for every preset and existing Session. This export remains
 * available for compatibility with explicit provider compositions.
 *
 * @module dsh-workspace-skill-scope/provider
 */
import { WorkspaceScopeProvider, trackWorkspaceProvider } from "./catalog.js";

export const name = "workspace-skill-scope";
export const inject = ["skills"];

/**
 * Register the workspace-scoped provider on `ctx.skills`.
 * @param {object} ctx - plugin context carrying the `skills` service.
 */
export function apply(ctx) {
  let provider;
  let untrack;
  ctx.skills.registerProvider((control) => {
    provider = new WorkspaceScopeProvider(ctx, control);
    untrack = trackWorkspaceProvider(provider);
    return provider;
  });
  ctx.effect(() => () => {
    untrack?.();
    provider?.dispose();
  }, "workspace-skill-scope watcher");
}
