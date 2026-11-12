/**
 * Preset half: register the workspace-scoped provider on `ctx.skills`.
 *
 * This is the row a `workspace-scope` preset mounts in place of
 * `@deepseek-ai/dsh-skill-filesystem`. It carries only the provider, so a Host
 * row of this package (index.js) can serve the panel without inventing a second
 * provider for sessions that never selected the preset.
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
