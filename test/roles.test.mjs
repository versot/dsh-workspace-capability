import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRoles, parseRole, readRole } from "../roles.js";

const REVIEWER = `---
description: Review a change and report risks.
skills:
  - karpathy-guidelines
mcpServers:
  - github
---
You review code. Report findings, never edit files.
`;

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "dsh-roles-"));
  await mkdir(join(root, ".dsh", "agents"), { recursive: true });
  return root;
}

test("a capability preset carries only its description and allowlists", () => {
  assert.deepEqual(parseRole("reviewer", REVIEWER), {
    name: "reviewer", id: "reviewer", displayName: "reviewer",
    description: "Review a change and report risks.",
    skills: ["karpathy-guidelines"],
    mcpServers: ["github"],
  });
});

test("omitted allowlists stay omitted so the role inherits the parent", () => {
  const role = parseRole("ad-hoc", "---\ndescription: Anything.\n---\nDo the task.\n");
  assert.equal(role.skills, undefined);
  assert.equal(role.mcpServers, undefined);
});

test("an empty allowlist is preserved as a deliberate lockout", () => {
  const role = parseRole("blind", "---\ndescription: No tools at all.\nskills: []\nmcpServers: []\n---\nReason only.\n");
  assert.deepEqual(role.skills, []);
  assert.deepEqual(role.mcpServers, []);
});

test("a preset without a description or frontmatter is rejected", () => {
  assert.throws(() => parseRole("x", "---\nskills: [a]\n---\nbody\n"), /description/);
  assert.deepEqual(parseRole("x", "---\ndescription: d\n---"), { name: "x", id: "x", displayName: "x", description: "d" });
  assert.throws(() => parseRole("x", "no frontmatter\n"), /frontmatter/);
});

test("invalid names in a role allowlist are rejected", () => {
  assert.throws(() => parseRole("x", "---\ndescription: d\nskills: [Bad Name]\n---\nb\n"), /invalid Skill name/);
  assert.throws(() => parseRole("x", "---\ndescription: d\nmcpServers: [has space]\n---\nb\n"), /invalid MCP server name/);
  assert.throws(() => parseRole("x", "---\ndescription: d\nskills: nope\n---\nb\n"), /must be an array/);
});

test('Chinese display names are editable independently of stable identifiers', () => {
  const role = parseRole('review', '---\ndisplayName: 代码审查\ndescription: 检查变更\n---\n');
  assert.equal(role.name, 'review');
  assert.equal(role.displayName, '代码审查');
  assert.equal(parseRole('legacy', REVIEWER).displayName, 'legacy');
  assert.throws(() => parseRole('review', '---\ndisplayName: ""\ndescription: d\n---\n'), /displayName/);
});

test("a role name must be usable as a file stem", () => {
  assert.throws(() => parseRole("Not A Name", REVIEWER), /invalid role name/);
});

test("readRole reports an unknown role instead of failing silently", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(readRole(root, "missing"), /unknown role "missing"/);
});

test("the catalog keeps working roles and reports broken files", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".dsh", "agents", "reviewer.md"), REVIEWER);
  await writeFile(join(root, ".dsh", "agents", "broken.md"), "---\nskills: []\n---\nno description\n");
  await writeFile(join(root, ".dsh", "agents", "notes.txt"), "ignored");
  const { roles, problems } = await listRoles(root);
  assert.deepEqual(roles.map((role) => role.name), ["reviewer"]);
  assert.deepEqual(problems.map((problem) => problem.file), ["broken.md"]);
});

test("a workspace without a role directory has an empty catalog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-roles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await listRoles(root), { roles: [], problems: [] });
});

test("preset prose is ignored rather than returned as instructions", () => {
  const metadata = "---\ndescription: Recommend for review.\nskills: []\n---\n";
  assert.deepEqual(parseRole("review", metadata + "Never inject this {{text}}."), parseRole("review", metadata));
});
