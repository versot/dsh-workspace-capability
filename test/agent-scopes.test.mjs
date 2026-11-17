import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSkillScopes, installSkilledSubagentTool } from "../agent-scopes.js";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "dsh-scope-"));
  await mkdir(join(root, ".dsh"));
  return root;
}
function context() { return { sessions: { get() {} }, logger: { warn() {} } }; }
function agent(id, cwd) { return { id, session: { header: { cwd } } }; }

test("version 1 records restore Skills and inherit all MCP servers", async (t) => {
  const root = await workspace(); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".dsh", "agent-skill-scopes.json"), JSON.stringify({
    version: 1, agents: { child: { version: 1, skills: ["alpha"] } },
  }));
  const scopes = new AgentSkillScopes(context());
  const value = await scopes.get(agent("child", root), root);
  assert.deepEqual(value, { skills: ["alpha"], mcpServers: undefined });
  assert.deepEqual(scopes.getSync({ id: "child" }), value);
});

test("version 2 records preserve explicit empty and selected MCP scopes", async (t) => {
  const root = await workspace(); t.after(() => rm(root, { recursive: true, force: true }));
  const scopes = new AgentSkillScopes(context());
  await scopes.put(root, "none", { skills: [], mcpServers: [] });
  await scopes.put(root, "some", { skills: ["alpha"], mcpServers: ["comfyui"] });
  assert.deepEqual(await scopes.get(agent("none", root), root), { skills: [], mcpServers: [] });
  assert.deepEqual(await scopes.get(agent("some", root), root), { skills: ["alpha"], mcpServers: ["comfyui"] });
  const stored = JSON.parse(await readFile(join(root, ".dsh", "agent-skill-scopes.json"), "utf8"));
  assert.equal(stored.version, 2);
  assert.equal(stored.agents.some.version, 2);
});

test("invalid stored MCP policy fails closed", async (t) => {
  const root = await workspace(); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".dsh", "agent-skill-scopes.json"), JSON.stringify({
    version: 2, agents: { child: { version: 2, skills: ["alpha"], mcpServers: ["bad name"] } },
  }));
  const scopes = new AgentSkillScopes(context());
  assert.deepEqual(await scopes.get(agent("child", root), root), { skills: [], mcpServers: [] });
});

test("remove clears memory and durable child policy", async (t) => {
  const root = await workspace(); t.after(() => rm(root, { recursive: true, force: true }));
  const scopes = new AgentSkillScopes(context());
  await scopes.put(root, "child", { skills: ["alpha"], mcpServers: ["github"] });
  await scopes.remove(root, "child");
  assert.equal(scopes.getSync({ id: "child" }), undefined);
  const stored = JSON.parse(await readFile(join(root, ".dsh", "agent-skill-scopes.json"), "utf8"));
  assert.equal(stored.agents.child, undefined);
});

test("omitted MCP selection snapshots the parent-visible servers", async (t) => {
  const root = await workspace(); t.after(() => rm(root, { recursive: true, force: true }));
  const parent = agent("parent", root);
  let definition;
  const ctx = {
    workingDirectory: { ensure: async () => root },
    skills: { list: async () => [] },
    tools: {
      definitions: () => [
        { name: "bash" },
        { name: "mcp__github__issue" },
        { name: "mcp__github__repo" },
      ],
      register(value) { definition = value; return () => {}; },
    },
    subagents: {
      resolveMaxDepth: () => 2,
      startActivation: async ({ childId }) => ({ name: `child-${childId}` }),
    },
  };
  const scopes = new AgentSkillScopes(context());
  installSkilledSubagentTool(ctx, scopes);
  await definition.execute(
    { description: "inherit MCP scope", prompt: "check" },
    { agent: parent, signal: new AbortController().signal },
  );
  const stored = JSON.parse(await readFile(join(root, ".dsh", "agent-skill-scopes.json"), "utf8"));
  const child = Object.values(stored.agents)[0];
  assert.deepEqual(child.mcpServers, ["github"]);
});
