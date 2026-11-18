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
  await writeFile(join(root, ".dsh", "agent-scopes.json"), JSON.stringify({
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
  const stored = JSON.parse(await readFile(join(root, ".dsh", "agent-scopes.json"), "utf8"));
  assert.equal(stored.version, 2);
  assert.equal(stored.agents.some.version, 2);
});

test("invalid stored MCP policy fails closed", async (t) => {
  const root = await workspace(); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".dsh", "agent-scopes.json"), JSON.stringify({
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
  const stored = JSON.parse(await readFile(join(root, ".dsh", "agent-scopes.json"), "utf8"));
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
  const stored = JSON.parse(await readFile(join(root, ".dsh", "agent-scopes.json"), "utf8"));
  const child = Object.values(stored.agents)[0];
  assert.deepEqual(child.mcpServers, ["github"]);
});

async function rollout(ctxFactory) {
  const root = await workspace();
  await mkdir(join(root, ".dsh", "agents"), { recursive: true });
  await writeFile(join(root, ".dsh", "agents", "reviewer.md"), [
    "---",
    "description: Review a change.",
    "skills: [karpathy-guidelines]",
    "mcpServers: [github]",
    "---",
    "",
  ].join("\n"));
  const parent = agent("parent", root);
  let definition;
  const ctx = ctxFactory(root, (value) => { definition = value; });
  const scopes = new AgentSkillScopes(context());
  const activations = [];
  const start = ctx.subagents.startActivation;
  ctx.subagents.startActivation = (request) => { activations.push(request); return start(request); };
  installSkilledSubagentTool(ctx, scopes);
  return { root, parent, scopes, activations, run: (args) => definition.execute(args, { agent: parent, signal: new AbortController().signal }) };
}

function roleContext(root, capture) {
  return {
    workingDirectory: { ensure: async () => root },
    skills: { list: async () => [{ name: "karpathy-guidelines" }, { name: "prompt-optimizer" }] },
    tools: {
      definitions: () => [{ name: "bash" }, { name: "mcp__github__issue" }, { name: "mcp__comfyui__run" }],
      register(value) { capture(value); return () => {}; },
    },
    subagents: {
      resolveMaxDepth: () => 2,
      startActivation: async ({ childId }) => ({ name: `child-${childId}` }),
    },
  };
}

test("a preset supplies capability defaults but passes only the parent task to the child", async (t) => {
  const scope = await rollout(roleContext);
  t.after(() => rm(scope.root, { recursive: true, force: true }));
  await scope.run({ description: "review", prompt: "review the diff", role: "reviewer" });
  const stored = JSON.parse(await readFile(join(scope.root, ".dsh", "agent-scopes.json"), "utf8"));
  const child = Object.values(stored.agents)[0];
  assert.deepEqual(child.skills, ["karpathy-guidelines"]);
  assert.deepEqual(child.mcpServers, ["github"]);
  assert.equal(scope.activations.length, 1);
  assert.deepEqual(scope.activations[0].prompt, [{ type: "text", text: "review the diff" }]);
  assert.equal(scope.activations[0].persona, undefined);
  assert.equal(scope.activations[0].systemPrompt, undefined);
});

test("explicit arguments override a role default", async (t) => {
  const scope = await rollout(roleContext);
  t.after(() => rm(scope.root, { recursive: true, force: true }));
  await scope.run({ description: "review", prompt: "review the diff", role: "reviewer", skills: [], mcpServers: [] });
  const stored = JSON.parse(await readFile(join(scope.root, ".dsh", "agent-scopes.json"), "utf8"));
  const child = Object.values(stored.agents)[0];
  assert.deepEqual(child.skills, []);
  assert.deepEqual(child.mcpServers, []);
});

test("a role cannot widen past the parent's visible Skill or MCP set", async (t) => {
  const scope = await rollout(roleContext);
  t.after(() => rm(scope.root, { recursive: true, force: true }));
  await writeFile(join(scope.root, ".dsh", "agents", "greedy.md"), [
    "---",
    "description: Wants everything.",
    "skills: [not-visible]",
    "---",
    "Do it.",
    "",
  ].join("\n"));
  await assert.rejects(scope.run({ description: "greedy", prompt: "go", role: "greedy" }), /unknown or hidden/);
  assert.equal(scope.activations.length, 0);
  // Validation runs before anything is persisted, so no child policy exists at all.
  await assert.rejects(readFile(join(scope.root, ".dsh", "agent-scopes.json"), "utf8"), { code: "ENOENT" });
});

test("an unknown role fails before any child is created", async (t) => {
  const scope = await rollout(roleContext);
  t.after(() => rm(scope.root, { recursive: true, force: true }));
  await assert.rejects(scope.run({ description: "x", prompt: "go", role: "nope" }), /unknown role "nope"/);
  assert.equal(scope.activations.length, 0);
});
