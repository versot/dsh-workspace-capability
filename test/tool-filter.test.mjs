import test from "node:test";
import assert from "node:assert/strict";
import { installMcpToolFilter } from "../mcp-scope.js";

function definition(name) { return { name }; }
function service(initial = []) {
  const entries = new Map(initial.map((name) => [name, definition(name)]));
  return {
    entries,
    get(name, scope, set) { return set ? set.view(scope).get(name) : entries.get(name); },
    executable(name, scope, set) { return this.get(name, scope, set); },
    definitions(scope, set) { return [...(set ? set.view(scope) : entries).values()]; },
    schemas(scope, set) { return this.definitions(scope, set).map(({ name }) => ({ name })); },
    async resolve({ agent }) {
      return { dispose() {}, view(scope) { return scope === agent ? new Map(entries) : new Map(); } };
    },
    async execute(input) { return this.executable(input.name, input.agent, input.toolSet)?.name; },
  };
}

function install(tools, policy, childPolicy) {
  return installMcpToolFilter({}, tools, childPolicy && { getSync: () => childPolicy }, {
    policyForSync: () => policy,
    policyFor: async () => policy,
  });
}

const names = ["bash", "mcp__github__issue", "mcp__github__repo", "mcp__comfyui__image"];

test("missing workspace MCP policy leaves every native and MCP tool visible", () => {
  const tools = service(names);
  install(tools, {});
  assert.deepEqual(tools.definitions().map((item) => item.name), names);
});

test("workspace policy hides complete MCP servers across registry read paths", () => {
  const tools = service(names);
  install(tools, { mcpServers: ["github"] });
  assert.deepEqual(tools.definitions().map((item) => item.name), names.slice(0, 3));
  assert.deepEqual(tools.schemas().map((item) => item.name), names.slice(0, 3));
  assert.equal(tools.get("mcp__comfyui__image"), undefined);
  assert.equal(tools.executable("mcp__comfyui__image"), undefined);
  assert.equal(tools.get("mcp__github__issue")?.name, "mcp__github__issue");
  assert.equal(tools.get("bash")?.name, "bash");
});

test("resolved step sets remain filtered and block known-name execution", async () => {
  const agent = { id: "parent" };
  const tools = service(names);
  install(tools, { mcpServers: ["github"] });
  const set = await tools.resolve({ agent, signal: new AbortController().signal });
  assert.deepEqual([...set.view(agent).keys()], names.slice(0, 3));
  assert.equal(tools.executable("mcp__comfyui__image", agent, set), undefined);
  assert.equal(await tools.execute({ name: "mcp__comfyui__image", agent, toolSet: set }), undefined);
});

test("Agent MCP selections intersect with the workspace-visible servers", () => {
  const tools = service(names);
  install(tools, { mcpServers: ["github", "comfyui"] }, { mcpServers: ["comfyui"] });
  const agent = { id: "child" };
  assert.deepEqual(tools.definitions(agent).map((item) => item.name), ["bash", "mcp__comfyui__image"]);
});

test("omitted child MCP scope inherits while an empty list permits no MCP tools", () => {
  const inherited = service(names);
  install(inherited, { mcpServers: ["github"] }, { skills: [] });
  assert.deepEqual(inherited.definitions({ id: "child" }).map((item) => item.name), names.slice(0, 3));
  const empty = service(names);
  install(empty, { mcpServers: ["github"] }, { mcpServers: [] });
  assert.deepEqual(empty.definitions({ id: "child" }).map((item) => item.name), ["bash"]);
});

test("tools registered after filter installation are filtered dynamically", () => {
  const tools = service(["bash"]);
  install(tools, { mcpServers: ["github"] });
  tools.entries.set("mcp__comfyui__late", definition("mcp__comfyui__late"));
  tools.entries.set("mcp__github__late", definition("mcp__github__late"));
  assert.deepEqual(tools.definitions().map((item) => item.name), ["bash", "mcp__github__late"]);
});

test("disposer restores the original tool service methods", () => {
  const tools = service(names);
  const restore = install(tools, { mcpServers: [] });
  assert.deepEqual(tools.definitions().map((item) => item.name), ["bash"]);
  restore();
  assert.deepEqual(tools.definitions().map((item) => item.name), names);
});
