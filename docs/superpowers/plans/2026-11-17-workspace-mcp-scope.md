# Workspace MCP Server Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `dsh-workspace-skill-scope` so each workspace can allow or hide complete MCP server namespaces alongside Skills, including child-Agent narrowing.

**Architecture:** Keep `.dsh/skill-scope.yml` backward compatible by adding an optional `mcpServers` allowlist: omission means all servers, while an array means exactly those namespaces. Install one Host-level wrapper over the shared `tools` service so every preset and existing Session is filtered at model-step resolution and direct registry lookups; identify MCP tools only by the public `mcp__<serverName>__<tool>` namespace. Extend the existing durable child-Agent scope record and `subagent_with_skills` tool with an optional `mcpServers` field, always validating selections against the parent-visible workspace-filtered catalog.

**Tech Stack:** Node.js ESM, DSH `0.2.2-rc.3` Cordis Host services, React module-loader client, YAML 2.x, Node built-in test runner.

## Global Constraints

- DSH compatibility floor remains `>=0.2.2-rc.3`.
- MCP selection granularity is a complete MCP server namespace, never an individual MCP tool.
- Missing `mcpServers` preserves version 1.0 behavior: every MCP server remains visible.
- Workspace and parent policies may only narrow child-Agent visibility; hidden servers cannot be requested explicitly.
- Policy changes apply to all presets and existing Sessions on their next model request; an in-flight turn is not rewritten.
- Standard Skill APIs and standard tool registry paths must fail closed for explicitly hidden capabilities; direct filesystem or external bypasses remain outside the plugin boundary.

---

### Task 1: Policy Model and MCP Namespace Helpers

**Files:**
- Modify: `catalog.js`
- Create: `mcp-scope.js`
- Test: `test/mcp-scope.test.mjs`

**Interfaces:**
- Produces: `parseMcpToolName(name): { serverName, toolName } | undefined`, `mcpServerVisible(config, serverName): boolean`, and normalized `config.mcpServers: readonly string[] | undefined`.

- [ ] Write tests proving missing `mcpServers` allows all servers, `[]` allows none, selected names allow complete namespaces, malformed names/config values reject, and non-MCP tools are unaffected.
- [ ] Run `node --test test/mcp-scope.test.mjs` and confirm failures are caused by missing exports.
- [ ] Implement the smallest parser and config normalization that passes those tests.
- [ ] Run the focused test and commit.

### Task 2: Shared Tool Registry Enforcement

**Files:**
- Modify: `mcp-scope.js`
- Modify: `index.js`
- Test: `test/tool-filter.test.mjs`

**Interfaces:**
- Consumes: normalized workspace config and MCP namespace parser from Task 1.
- Produces: `installMcpToolFilter(ctx, tools, agentScopes): () => void`, wrapping `resolve`, `get`, `executable`, `definitions`, and `schemas` without changing non-MCP tools.

- [ ] Write a fake DSH tools service and failing tests for catalog discovery, resolved step tool sets, direct `get`, direct `executable`, definitions, schemas, dynamic post-install MCP registrations, all-visible default, workspace allowlist, and child-Agent intersection.
- [ ] Run the focused test and confirm the unfiltered MCP names are visible.
- [ ] Implement filtering using the Agent Session cwd, synchronous cached workspace policy snapshots refreshed by file metadata, and the existing Agent scope resolver where async resolution is available.
- [ ] Run focused and full tests, then commit.

### Task 3: Durable Child-Agent MCP Narrowing

**Files:**
- Modify: `agent-scopes.js`
- Test: `test/agent-scopes.test.mjs`

**Interfaces:**
- Changes `AgentSkillScopes.get()` to return `{ skills, mcpServers }` for persisted records while accepting legacy version-1 records as `{ skills, mcpServers: undefined }`.
- Extends `subagent_with_skills` input with `mcpServers?: string[]`; omission inherits parent-visible servers and `[]` hides all MCP servers.

- [ ] Write failing tests for legacy record migration, inheritance, explicit empty lists, rejection of hidden parent servers, atomic persistence, and cleanup after failed spawn.
- [ ] Run the focused test and verify the old Skill-only record shape causes the expected failures.
- [ ] Implement version-2 records and parent-visible server discovery from filtered tool definitions.
- [ ] Run focused and full tests, then commit.

### Task 4: Host Catalog API and Browser Panel

**Files:**
- Modify: `index.js`
- Modify: `client.js`
- Modify: `locale/zh.json`
- Modify: `locale/en.json`
- Test: `test/policy-roundtrip.test.mjs`

**Interfaces:**
- `GET /catalog` adds `mcpServers: [{ name, toolCount, visible }]`.
- `POST /policy` accepts and persists `config.mcpServers` as omitted/all or an explicit server-name array.

- [ ] Write failing serialization/round-trip tests for omitted, empty, and selected MCP allowlists.
- [ ] Implement server enumeration from current tool definitions and include it in catalog responses.
- [ ] Add an MCP Server section to the existing panel, with whole-server checkboxes only; saving uses the same close-on-success flow.
- [ ] Update copy to say “Skill 与 MCP”, explain whole-server semantics, old Sessions, and default-all compatibility.
- [ ] Run focused and full tests, then commit.

### Task 5: Documentation, Package Metadata, and Release Verification

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/VERIFICATION.md`
- Modify: `docs/DEVELOPMENT.md`
- Modify: `package.json`
- Modify: `cordis.patch.yml`
- Modify: `scripts/check.mjs`

**Interfaces:**
- Package description and docs advertise workspace Skill + whole-MCP-server scoping without claiming filesystem sandboxing.

- [ ] Update documentation with the exact YAML schema, compatibility defaults, child-Agent intersection, and manual verification for hidden discovery plus known-name invocation.
- [ ] Extend the offline checker to run Node tests and verify the new module is exported and packed.
- [ ] Run `npm test`, `npm pack --dry-run`, and inspect the tarball file list.
- [ ] Review the complete diff for unrelated changes and commit.

### Task 6: DSH Runtime Verification and Integration

**Files:**
- No new production files; use the working tree package and current DSH profile only after local tests pass.

**Interfaces:**
- Verifies behavior in the installed DSH `0.2.2-rc.3` runtime.

- [ ] Install/enable the tested branch package in the current profile using the supported plugin manager path.
- [ ] Verify the panel lists MCP servers as one checkbox each and closes after save.
- [ ] Verify a hidden server disappears from model-visible schemas and a call by known `mcp__...` name is rejected, then verify restoring it works on the next turn/session read.
- [ ] Request code review, resolve only verified findings, rerun all tests, merge the isolated branch into `main`, and push only after confirming the user-authorized publication scope.
