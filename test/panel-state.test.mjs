import test from "node:test";
import assert from "node:assert/strict";
import { withFilterState } from "../index.js";

function catalog(mcpServers) {
  return {
    workspace: "/workspace",
    config: { mcpServers },
    groups: [],
  };
}

test("catalog preserves configured MCP servers that are currently offline", () => {
  const ctx = {
    tools: {
      definitions: () => [
        { name: "mcp__time__now" },
        { name: "mcp__time__convert" },
      ],
    },
  };
  const result = withFilterState(catalog(["time", "github"]), ctx);
  assert.deepEqual(result.mcpServers, [
    { name: "github", toolCount: 0, connected: false, visible: true },
    { name: "time", toolCount: 2, connected: true, visible: true },
  ]);
  assert.equal(typeof result.skillFilterInstalled, "boolean");
  assert.equal(typeof result.mcpFilterInstalled, "boolean");
});
