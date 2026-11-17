/** Durable per-child Skill allowlists and the model-facing spawn adapter. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { findWorkspaceRoot } from "./catalog.js";
import { MCP_SERVER_NAME_PATTERN, parseMcpToolName } from "./mcp-scope.js";

const STORE_SEGMENTS = [".dsh", "agent-scopes.json"];
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class AgentSkillScopes {
  constructor(ctx) {
    this.ctx = ctx;
    this.memory = new Map();
    this.roots = new Map();
    this.writes = new Map();
  }

  has(agentId) {
    return this.memory.has(agentId);
  }

  getSync(agent) {
    return typeof agent?.id === "string" ? this.memory.get(agent.id) : undefined;
  }

  async get(agent, cwd) {
    const id = agent?.id;
    if (typeof id !== "string") return undefined;
    if (this.memory.has(id)) return this.memory.get(id);
    const originalCwd = agent?.session?.header?.cwd;
    const inheritedFrom = agent?.session?.header?.parentSession;
    const parent = typeof inheritedFrom === "string" ? this.ctx.sessions?.get?.(inheritedFrom) : undefined;
    const parentCwd = parent?.header?.cwd;
    for (const candidate of [originalCwd, cwd, parentCwd, this.roots.get(inheritedFrom)]) {
      if (typeof candidate !== "string" || candidate.length === 0) continue;
      try {
        const root = await findWorkspaceRoot(candidate);
        const document = await readStore(root);
        const policyId = Object.hasOwn(document.agents, id)
          ? id
          : typeof inheritedFrom === "string" && Object.hasOwn(document.agents, inheritedFrom)
            ? inheritedFrom
            : undefined;
        if (policyId !== undefined) {
          const policy = validateStored(document.agents[policyId]);
          let policyRoot = root;
          if (policyId !== id) {
            policyRoot = await findWorkspaceRoot(originalCwd ?? cwd ?? root);
            await this.update(policyRoot, (latest) => {
              latest.version = 2;
              latest.agents[id] = storedPolicy(policy, {
                parentSessionId: inheritedFrom,
                inherited: true,
              });
            });
          }
          this.memory.set(id, policy);
          this.roots.set(id, policyRoot);
          return policy;
        }
      } catch (error) {
        this.ctx.logger?.warn?.(`workspace-capability: cannot restore Agent Skill policy for ${id}: ${messageOf(error)}`);
        return Object.freeze({ skills: Object.freeze([]), mcpServers: Object.freeze([]) });
      }
    }
    return undefined;
  }

  async put(cwd, childId, policy, metadata = {}) {
    const normalized = validatePolicy(policy);
    const root = await findWorkspaceRoot(cwd);
    await this.update(root, (document) => {
      document.version = 2;
      document.agents[childId] = storedPolicy(normalized, metadata);
    });
    this.memory.set(childId, normalized);
    this.roots.set(childId, root);
  }

  async remove(cwd, childId) {
    this.memory.delete(childId);
    this.roots.delete(childId);
    const root = await findWorkspaceRoot(cwd);
    await this.update(root, (document) => {
      delete document.agents[childId];
    });
  }

  async update(root, mutate) {
    const previous = this.writes.get(root) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const document = await readStore(root);
      mutate(document);
      await writeStore(root, document);
    });
    this.writes.set(root, next);
    try {
      await next;
    } finally {
      if (this.writes.get(root) === next) this.writes.delete(root);
    }
  }
}

export function installSkilledSubagentTool(ctx, scopes) {
  const definition = {
    name: "subagent_with_skills",
    description: "Start an independent spawn subagent with a Skill visibility allowlist. Omit skills to inherit the parent's current catalog; pass [] for no Skills. This workspace-backed restriction is not a security sandbox, and fork may retain Skill content from conversation history.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["description", "prompt"],
      properties: {
        cwd: { type: "string", description: "Initial child working directory; omitted inherits the parent directory." },
        description: { type: "string", description: "A short 3-5 word task description." },
        name: { type: "string", description: "Optional unique short child name." },
        prompt: { type: "string", description: "The complete self-contained task for the child." },
        skills: {
          type: "array",
          items: { type: "string" },
          description: "Exact Skill names the child may use. Omit to inherit; [] allows no Skills.",
        },
        mcpServers: {
          type: "array",
          items: { type: "string" },
          description: "Exact whole MCP server names the child may use. Omit to inherit; [] allows no MCP tools.",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "name"],
        properties: {
          kind: { type: "string", const: "activation" },
          name: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: `started skilled subagent ${value.name}` }],
      presentationMeta: (_args, value) => ({ kind: value.kind, name: value.name }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error("subagent_with_skills requires a calling Agent");
      const parentCwd = await ctx.workingDirectory.ensure(parent, exec.signal);
      const cwd = args.cwd === undefined ? parentCwd : resolve(parentCwd, args.cwd);
      const visible = await ctx.skills.list({ cwd: parentCwd, scope: parent, signal: exec.signal });
      const visibleNames = new Set(visible.map((skill) => skill.name));
      const selected = args.skills === undefined
        ? Object.freeze([...visibleNames])
        : validateRequested(args.skills);
      const unavailable = selected.filter((name) => !visibleNames.has(name));
      if (unavailable.length > 0) {
        throw new Error(`Skills are unknown or hidden by the workspace/parent policy: ${unavailable.join(", ")}`);
      }
      const visibleMcpServers = new Set(ctx.tools.definitions(parent).flatMap((tool) => {
        const parsed = parseMcpToolName(tool.name);
        return parsed === undefined ? [] : [parsed.serverName];
      }));
      const selectedMcpServers = args.mcpServers === undefined
        ? Object.freeze([...visibleMcpServers])
        : validateMcpServers(args.mcpServers);
      const unavailableMcp = selectedMcpServers.filter((server) => !visibleMcpServers.has(server));
      if (unavailableMcp.length > 0) {
        throw new Error(`MCP servers are unknown or hidden by the workspace/parent policy: ${unavailableMcp.join(", ")}`);
      }

      const childId = randomUUID();
      await scopes.put(cwd, childId, { skills: selected, mcpServers: selectedMcpServers }, { parentSessionId: parent.id });
      try {
        exec.signal.throwIfAborted();
        const maxDepth = ctx.subagents.resolveMaxDepth();
        const started = await ctx.subagents.startActivation({
          provider: "spawn",
          childId,
          label: args.description,
          ...args.name === undefined ? {} : { name: args.name },
          ...args.cwd === undefined ? {} : { cwd },
          prompt: [{ type: "text", text: args.prompt }],
          parent,
          signal: exec.signal,
          delivery: "parent",
          ...maxDepth === undefined ? {} : { maxDepth },
        });
        return { kind: "activation", name: started.name };
      } catch (error) {
        await scopes.remove(cwd, childId).catch(() => {});
        throw error;
      }
    },
  };
  return ctx.tools.register(definition);
}

function validateRequested(value) {
  if (!Array.isArray(value)) throw new Error("skills must be an array");
  const result = [];
  const seen = new Set();
  for (const name of value) {
    if (typeof name !== "string" || !SKILL_NAME.test(name)) throw new Error(`invalid Skill name: ${String(name)}`);
    if (!seen.has(name)) result.push(name);
    seen.add(name);
  }
  return Object.freeze(result);
}

function validateMcpServers(value) {
  if (!Array.isArray(value)) throw new Error("mcpServers must be an array");
  const result = [];
  const seen = new Set();
  for (const name of value) {
    if (typeof name !== "string" || !MCP_SERVER_NAME_PATTERN.test(name)) throw new Error(`invalid MCP server name: ${String(name)}`);
    if (!seen.has(name)) result.push(name);
    seen.add(name);
  }
  return Object.freeze(result);
}

function validatePolicy(policy) {
  if (typeof policy !== "object" || policy === null) throw new Error("invalid Agent policy");
  return Object.freeze({
    skills: validateRequested(policy.skills),
    mcpServers: policy.mcpServers === undefined ? undefined : validateMcpServers(policy.mcpServers),
  });
}

function validateStored(record) {
  if (record?.version !== 1 && record?.version !== 2) throw new Error("unsupported Agent policy record");
  if (!Array.isArray(record.skills)) throw new Error("invalid Agent Skill policy record");
  return validatePolicy({
    skills: record.skills,
    mcpServers: record.version === 1 ? undefined : record.mcpServers,
  });
}

function storedPolicy(policy, metadata = {}) {
  return {
    version: 2,
    skills: [...policy.skills],
    ...policy.mcpServers === undefined ? {} : { mcpServers: [...policy.mcpServers] },
    createdAt: new Date().toISOString(),
    ...typeof metadata.parentSessionId === "string" ? { parentSessionId: metadata.parentSessionId } : {},
    ...metadata.inherited === true ? { inherited: true } : {},
  };
}

async function readStore(root) {
  const file = join(root, ...STORE_SEGMENTS);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (![1, 2].includes(parsed?.version) || typeof parsed.agents !== "object" || parsed.agents === null || Array.isArray(parsed.agents)) {
      throw new Error(`invalid Agent Skill policy store: ${file}`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 2, agents: {} };
    throw error;
  }
}

async function writeStore(root, document) {
  const file = join(root, ...STORE_SEGMENTS);
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
