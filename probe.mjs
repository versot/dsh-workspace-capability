/**
 * Standalone probe for dsh-workspace-capability.
 *
 * Loads this package the way the Loader does and fakes the `skills` service, then
 * prints the catalog one workspace would receive. Use it to check
 * `<workspace>/.dsh/capability-scope.yml` without restarting the app or opening a session.
 *
 * Usage: node probe.mjs [workspace-dir]
 *
 * Bundled skills live inside the Desktop app's app.asar, which plain Node cannot
 * read. Point DSH_BUNDLED_SKILL_DIR at an extracted copy to include them:
 *   DSH_BUNDLED_SKILL_DIR=/tmp/dsh-bundled-skills/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills node probe.mjs
 * Without it the probe reports project and user roots only.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "provider.js");
const workspace = process.argv[2] ?? process.cwd();

const warnings = [];
let registered;
const ctx = {
  logger: { warn: (message) => warnings.push(message) },
  skills: { registerProvider: (factory) => { registered = factory; } },
  effect: () => {},
};

const mod = await import(pathToFileURL(PLUGIN).href);
mod.apply(ctx);
if (typeof registered !== "function") throw new Error("apply() did not register a provider");

const control = { signal: new AbortController().signal, invalidate: () => {} };
const provider = registered(control);

const listed = await provider.list({ cwd: workspace });
const candidates = Array.isArray(listed) ? listed : listed.candidates;
const bySource = {};
for (const candidate of candidates) (bySource[candidate.source] ??= []).push(candidate.name);

console.log("workspace:", workspace);
console.log("bundled root:", process.env.DSH_BUNDLED_SKILL_DIR ?? "(not set)");
console.log("total:", candidates.length);
for (const [source, names] of Object.entries(bySource)) {
  console.log(`  ${source} (${names.length}): ${names.sort().join(", ")}`);
}
console.log("warnings:", warnings.length === 0 ? "(none)" : warnings);

const sample = candidates.find((candidate) => candidate.source === "project-agents");
if (sample !== undefined) {
  const skill = await provider.get(sample, {});
  console.log(
    "get() sample:",
    sample.name,
    "->",
    skill === undefined
      ? "undefined"
      : `${skill.name}, ${skill.content.length} chars, invocation ${JSON.stringify(skill.invocation)}`,
  );
}

provider.dispose();

if (process.env.DSH_BUNDLED_SKILL_DIR !== undefined && !existsSync(process.env.DSH_BUNDLED_SKILL_DIR)) {
  console.log("note: DSH_BUNDLED_SKILL_DIR does not exist; bundled skills were skipped");
}
