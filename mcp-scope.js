/** Helpers for workspace and Agent MCP server visibility. */

export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Parse a DSH MCP public tool name without treating ordinary tools as MCP.
 * @param {unknown} name - registered public tool name.
 * @returns {{serverName: string, toolName: string}|undefined} namespace identity.
 */
export function parseMcpToolName(name) {
  if (typeof name !== "string" || !name.startsWith("mcp__")) return undefined;
  const separator = name.indexOf("__", 5);
  if (separator < 0) return undefined;
  const serverName = name.slice(5, separator);
  const toolName = name.slice(separator + 2);
  if (!MCP_SERVER_NAME_PATTERN.test(serverName) || toolName.length === 0) return undefined;
  return { serverName, toolName };
}

/** Missing allowlist means backward-compatible all-visible behavior. */
export function mcpServerVisible(config, serverName) {
  return config?.mcpServers === undefined || config.mcpServers.includes(serverName);
}

const installedTools = new WeakSet();
let activeCount = 0;

/** Whether at least one shared tool service has a complete MCP filter installed. */
export function isMcpToolFilterActive() {
  return activeCount > 0;
}

/**
 * Filter the shared DSH tool registry at discovery and execution lookup paths.
 * Policy resolvers deliberately sit outside this wrapper: Host integration can
 * keep a synchronous last-known workspace snapshot while `resolve()` refreshes
 * it asynchronously at the start of every model step.
 */
export function installMcpToolFilter(ctx, tools, agentScopes, policies) {
  if (tools === undefined || tools === null || installedTools.has(tools)) return () => {};
  const originals = Object.fromEntries(
    ["get", "executable", "definitions", "schemas", "resolve"]
      .filter((name) => typeof tools[name] === "function")
      .map((name) => [name, tools[name]]),
  );
  if (typeof originals.definitions !== "function" || typeof originals.resolve !== "function") return () => {};

  function scopePolicy(scope) {
    const workspace = policies?.policyForSync?.(scope);
    const child = agentScopes?.getSync?.(scope);
    return { workspace, child };
  }

  function visible(name, policy) {
    const parsed = parseMcpToolName(name);
    if (parsed === undefined) return true;
    return mcpServerVisible(policy.workspace, parsed.serverName)
      && mcpServerVisible(policy.child, parsed.serverName);
  }

  function filterMap(map, policy) {
    return new Map([...map].filter(([name]) => visible(name, policy)));
  }

  try {
    if (originals.get) tools.get = function get(name, scope, toolSet) {
      if (!visible(name, scopePolicy(scope))) return undefined;
      return originals.get.call(this, name, scope, toolSet);
    };
    if (originals.executable) tools.executable = function executable(name, scope, toolSet) {
      if (!visible(name, scopePolicy(scope))) return undefined;
      return originals.executable.call(this, name, scope, toolSet);
    };
    tools.definitions = function definitions(scope, toolSet) {
      return originals.definitions.call(this, scope, toolSet).filter((item) => visible(item.name, scopePolicy(scope)));
    };
    if (originals.schemas) tools.schemas = function schemas(scope, toolSet) {
      return originals.schemas.call(this, scope, toolSet).filter((item) => visible(item.name, scopePolicy(scope)));
    };
    tools.resolve = async function resolve(context) {
      const workspace = await policies?.policyFor?.(context.agent, context.signal)
        ?? policies?.policyForSync?.(context.agent);
      const restoredChild = await agentScopes?.get?.(context.agent);
      const child = restoredChild ?? agentScopes?.getSync?.(context.agent);
      const policy = { workspace, child };
      const resolved = await originals.resolve.call(this, context);
      return Object.freeze({
        dispose: () => resolved.dispose(),
        view: (scope) => filterMap(resolved.view(scope), policy),
      });
    };
  } catch (error) {
    const rollbackFailures = [];
    for (const [name, original] of Object.entries(originals)) {
      try {
        tools[name] = original;
      } catch (rollbackError) {
        rollbackFailures.push(`${name}: ${messageOf(rollbackError)}`);
      }
    }
    const suffix = rollbackFailures.length === 0 ? "" : `; rollback failed for ${rollbackFailures.join(", ")}`;
    ctx?.logger?.warn?.(`workspace-skill-scope: cannot filter shared MCP tools: ${messageOf(error)}${suffix}`);
    return () => {};
  }

  installedTools.add(tools);
  activeCount += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const [name, original] of Object.entries(originals)) tools[name] = original;
    installedTools.delete(tools);
    activeCount = Math.max(0, activeCount - 1);
  };
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
