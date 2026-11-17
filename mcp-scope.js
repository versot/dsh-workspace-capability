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
