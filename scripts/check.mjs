/**
 * Offline smoke test for CI and for "did I break the manifest" checks.
 *
 * Runs without a DSH runtime: it imports every module, parses the bundle patch,
 * and cross-checks the pieces that must agree (package name <-> patch row <->
 * client module id <-> market index entry). It cannot test the Host behaviour —
 * that needs a real DSH boot.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const failures = [];
function check(condition, message) {
  if (condition) return;
  failures.push(message);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

check(pkg.name === "dsh-workspace-capability", `package name is "${pkg.name}"`);
check(/^\d+\.\d+\.\d+/.test(pkg.version), `version "${pkg.version}" is not semver`);
check(typeof pkg.engines?.dsh === "string", "engines.dsh is missing");
check(pkg.dsh?.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch must point at cordis.patch.yml");
check(typeof pkg.dsh?.client?.platform === "string", "dsh.client.platform is missing");
check(typeof pkg.exports?.["./client"] === "string", "exports[./client] is missing");

for (const file of ["index.js", "provider.js", "catalog.js", "client.js", "filter.js", "agent-scopes.js", "mcp-scope.js", "cordis.patch.yml"]) {
  check(existsSync(file), `${file} is missing`);
  check(Array.isArray(pkg.files) && pkg.files.includes(file), `${file} is not in package.json "files"`);
}

// The bundle patch must insert exactly one host row named after the package.
const patchRows = parse(readFileSync("cordis.patch.yml", "utf8"), {
  customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => value }],
});
const inserted = patchRows.flatMap((row) => row.insert ?? []);
check(inserted.length === 1, `patch inserts ${inserted.length} rows, expected 1`);
check(inserted[0]?.name === pkg.name, `patch row name is "${inserted[0]?.name}", expected "${pkg.name}"`);

// The browser half registers itself under the package id.
const clientSource = readFileSync("client.js", "utf8");
check(clientSource.includes(`id: '${pkg.name}'`), "client.js __ModuleLoader__ id does not match the package name");

// The market index must describe this package. It may intentionally lag behind
// package.json while the next version is still unreleased.
const index = JSON.parse(readFileSync("market/index.json", "utf8"));
check(index.format === 1, "market index format must be 1");
const entry = index.plugins?.find((plugin) => plugin.name === pkg.name);
check(entry !== undefined, "market index has no entry for this package");
check(Array.isArray(entry?.versions) && entry.versions.length > 0, "market index has no released versions");
for (const version of entry?.versions ?? []) {
  check(Number.isSafeInteger(version.publishTimestamp) && version.publishTimestamp > 0,
    `market version ${version.version} has an invalid publishTimestamp`);
  check(version.source?.type === "npm" || version.source?.type === "git",
    `market version ${version.version} has an invalid source`);
  if (version.source?.type === "git") {
    check(/^https:\/\//.test(version.source.url ?? ""), `market version ${version.version} has no HTTPS git URL`);
    check(/^[0-9a-f]{40}$/.test(version.source.commit ?? ""), `market version ${version.version} has no fixed 40-character commit`);
  }
}

// Importing the modules is the cheapest way to catch a broken import graph.
for (const module of ["../index.js", "../provider.js", "../catalog.js", "../filter.js", "../agent-scopes.js", "../mcp-scope.js"]) {
  try {
    await import(module);
  } catch (error) {
    failures.push(`${module} failed to import: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✓ ${pkg.name}@${pkg.version}: manifest, patch, client id, market index and imports all agree`);
