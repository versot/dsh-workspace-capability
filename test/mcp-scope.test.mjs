import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../catalog.js";
import { mcpServerVisible, parseMcpToolName } from "../mcp-scope.js";

const quiet = { logger: { warn() {} } };

function config(input) {
  return normalizeConfig(input, "/workspace/.dsh/skill-scope.yml", quiet);
}

test("missing mcpServers preserves default visibility for every server", () => {
  const policy = config({});
  assert.equal(policy.mcpServers, undefined);
  assert.equal(mcpServerVisible(policy, "github"), true);
  assert.equal(mcpServerVisible(policy, "Comfy_UI-2"), true);
});

test("an empty mcpServers list hides every server", () => {
  const policy = config({ mcpServers: [] });
  assert.deepEqual(policy.mcpServers, []);
  assert.equal(mcpServerVisible(policy, "github"), false);
});

test("mcpServers selects complete server namespaces and removes duplicates", () => {
  const policy = config({ mcpServers: ["github", "comfy-ui", "github"] });
  assert.deepEqual(policy.mcpServers, ["github", "comfy-ui"]);
  assert.equal(mcpServerVisible(policy, "github"), true);
  assert.equal(mcpServerVisible(policy, "comfy-ui"), true);
  assert.equal(mcpServerVisible(policy, "other"), false);
});

test("invalid MCP server policy values are rejected", () => {
  for (const value of [null, "github", {}, [""], ["has space"], ["x".repeat(33)], [1]]) {
    assert.throws(() => config({ mcpServers: value }), /mcpServers|MCP server/i);
  }
});

test("MCP public tool names expose their server namespace", () => {
  assert.deepEqual(parseMcpToolName("mcp__github__create_issue"), {
    serverName: "github",
    toolName: "create_issue",
  });
  assert.deepEqual(parseMcpToolName("mcp__Comfy_UI-2__generate-image"), {
    serverName: "Comfy_UI-2",
    toolName: "generate-image",
  });
});

test("non-MCP or malformed names are not classified as MCP tools", () => {
  for (const name of [
    "bash",
    "mcp__github",
    "mcp____tool",
    "mcp__github__",
    "mcp__has space__tool",
    `mcp__${"x".repeat(33)}__tool`,
  ]) {
    assert.equal(parseMcpToolName(name), undefined, name);
  }
});
