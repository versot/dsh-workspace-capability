# dsh-workspace-capability

English | [中文](README.zh.md)

[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

<img src="icon.png" width="72" height="72" alt="">

Per-workspace Skill and whole-MCP-server visibility for [DeepSeek Harness](https://www.deepseek.com/harness/).

Each workspace owns one `.dsh/capability-scope.yml`. Every session that runs in that
workspace sees only the capabilities the file allows — regardless of which preset the
session uses (Standard / PTC / Minimal / Create), and including sessions that
already existed before the plugin was installed.

## Install

```bash
dsh plugin --profile <profile> add github:versot/dsh-workspace-capability
```

Then make sure the package is listed in that profile's `dsh.profile.bundles`
(the plugin manager does this for you) and restart DSH.

From a local tarball instead:

```bash
dsh plugin --profile <profile> add ./dsh-workspace-capability-<version>.tgz
```

Requires DSH `>= 0.2.2-rc.3` (`engines.dsh`); older runtimes refuse to install it.

## Configure

`<workspace>/.dsh/capability-scope.yml` — a missing file means "behave exactly like the
stock Standard preset", i.e. every skill is available:

```yaml
projectSkills: true    # <workspace>/.dsh/skills and <workspace>/.agents/skills
userSkills: false      # ~/.dsh/skills and ~/.agents/skills
bundled: true          # skills shipped with DSH
allow: []              # non-empty = allowlist: only these <skill-name> values
deny: []               # hide these <skill-name> values
include: []            # keep these <skill-name> values even when the group is off
mcpServers: [<server-name>]  # whole-server allowlist; omit = every MCP server
```

Visibility precedence: `deny` → `include` → `allow` (when non-empty) → the group
switch. So "user-level off, but keep one skill anyway" is
`userSkills: false` plus `include: [<skill-name>]`.

`mcpServers` controls complete server namespaces: `<server-name>` means every
`mcp__<server-name>__*` tool, never individual tools. Omit it to allow all current
and future servers; use `[]` to expose no MCP tools. Skill-only and MCP-only files
leave the other capability unrestricted.

Edits apply without a restart: the provider polls the file every 1.5s and a panel
save invalidates immediately. MCP changes apply on the next model request, not an
already-running turn.

## Capability allowlists for child agents

The plugin adds a `subagent_with_skills` tool. When a parent agent uses it to
create a **spawned child agent**, the optional `skills` parameter is an allowlist.
The child's effective catalog is:

```text
skills visible under the parent agent's current workspace policy ∩ explicit skills allowlist
```

Validation uses the directories currently visible to the parent agent, not every
skill installed on the machine. The request is rejected if the list contains an
unknown name or a name hidden from the parent by the workspace policy; names are
never silently ignored.

- omit `skills`: inherit every skill currently visible to the parent;
- `skills: []`: create a child with zero skills;
- pass a non-empty array: expose only the intersection above;
- optional `mcpServers` follows the same omit/inherit, `[]`/none, or server-name-list semantics; its effective scope is workspace-visible ∩ parent-visible ∩ selected;
- the policy is persisted in `.dsh/agent-scopes.json`; version-1 Skill-only records remain compatible and inherit parent-visible MCP servers.

This is a **capability-visibility restriction** for spawned child agents, not a
security sandbox or permission boundary. It depends on the workspace-owned
`.dsh/agent-scopes.json`; an actor that can modify or delete that file can
break the restriction. Fork may also retain already-loaded Skill content from
conversation history and is not an isolation mechanism.

## Capability presets

Each `<workspace>/.dsh/agents/<name>.md` file defines a capability preset and
recommended scenarios for the parent agent:

```markdown
---
description: Suitable for GitHub Issue investigation and PR change analysis.
skills: [<skill-name>]
mcpServers: [<server-name>]
---
```

Replace the placeholders with names visible to the parent.

- `description` is required. It helps the **parent** choose a preset; it is not
  automatically sent to the child as a task or system prompt.
- `skills` and `mcpServers` supply defaults: omit to inherit parent visibility,
  use `[]` for none, or list names to select them. Explicit tool arguments override
  these defaults; selections cannot exceed workspace/parent visibility.
- No body is required. Any Markdown body is ignored, including in older files.
- The plugin does not inject system prompts. The parent writes the complete task
  in `prompt`; DSH retains its normal child composition and system prompt.

`list_subagent_roles` lists presets, their recommended scenarios and parse
problems. Pass the chosen name as `role` to `subagent_with_skills` alongside the
actual task. The directory and tool/parameter names remain unchanged for
compatibility; “role” now means a capability preset, not a persona.
These presets do not restrict native tools such as Bash and are not a sandbox.

## Panel

Use the same Session menu entry **Workspace capability scope…**. The panel has
Workspace scope and Capability presets tabs. The latter provides a preset list
and editor with create, edit, delete, name and recommended-scenario fields.
Display names (`displayName`) support Chinese and renaming (1–100 trimmed characters,
no control characters). New presets receive an automatic stable identifier; renaming
never changes that identifier or file. Legacy files without `displayName` display
their existing file stem, without migration. Catalog entries expose `id`, legacy
`name` (both are the callable file-stem identifier), and `displayName`; pass `id`
as the `role` argument, not the display name. Disabled save actions show a reason.
Skill and MCP each offer Inherit parent / None / Custom modes; unavailable saved
selections remain visible with warnings. Internal identifiers cannot be changed after saving; display names can.
No role body or system-prompt editor is provided. Unsaved preset changes and
preset deletion require confirmation. Preset saves are independent of workspace
policy saves and keep the editor open. The panel uses DSH theme tokens and
switches to a single-column layout on narrow screens.

Session row **「⋯」→ 工作区能力范围…** opens a checklist: Skill groups/items
and one checkbox per complete MCP server, backed by the YAML above. Policies are written to a same-directory temporary file and then replaced with `rename`; replacement semantics have currently been verified only on macOS. Saving also refreshes the mounted providers and closes the panel. Configured servers that are currently disconnected remain listed as offline, so unrelated saves do not discard them. The API and panel report `skillFilterInstalled` and `mcpFilterInstalled` separately; `filterInstalled` remains a compatibility alias for the Skill filter.

## How it works

Two rows, one bundle:

- **Host row** (`index.js`) serves `GET /dsh-workspace-capability/catalog` and
  `POST /dsh-workspace-capability/policy` for the panel. It also installs
  `filter.js`.
- **`filter.js`** wraps the shared `skills` service (`list` / `snapshot` / `get`)
  so the policy applies to every preset and to sessions created earlier. This is
  the only mechanism that can reach an already-created session: a session binds
  its preset at creation and never re-evaluates it.
- `provider.js` and `catalog.js` hold the scanner and a real skill provider; the
  provider is not mounted by default (no preset is declared).
- `agent-scopes.js` owns the durable child allowlists and the
  `subagent_with_skills` tool; `roles.js` reads the workspace role directory and
  registers `list_subagent_roles`.

## Permissions and external services

This plugin needs filesystem and same-origin network access, which puts it in the
marketplace's elevated-capability tier (`user-reviewed`):

| Capability | Used for | Bound |
| --- | --- | --- |
| Read files | scanning `<workspace>/.dsh/skills`, `<workspace>/.agents/skills`, `~/.dsh/skills`, `~/.agents/skills`, the bundled directory, and `<workspace>/.dsh/agents/*.md` | reads `SKILL.md` frontmatter and role files only |
| Write files | `<workspace>/.dsh/capability-scope.yml` and `.dsh/agent-scopes.json` | same-directory temporary file followed by `rename`; invalid requests do not write; replacement semantics are currently verified only on macOS |
| Network | one same-origin prefix `/dsh-workspace-capability` on DSH's own `webServer`; the browser half fetches it | no outbound requests, no telemetry |
| Session data | session id → workspace path via `workspaceRegistry` (fallback `sessions.get(id).header.cwd`) | read-only, never stored or sent; no credentials, cookies or tokens |
| Subprocess / shell | none | — |
| Lifecycle scripts | none | install runs no code |

The only runtime dependency is `yaml@^2.9.0`, pinned in `pnpm-lock.yaml`
(currently `yaml@2.9.1` with an integrity hash).

Failure bounds: workspace discovery fails open; an allowlist store that is found but corrupt or unreadable fails closed (zero Skills). A failed child-policy write keeps the previous file and does not start the child. DSH older than
`0.2.2-rc.3` refuses to load the bundle. `.dsh/agent-scopes.json` is part of the visibility state and must move with the workspace; if it is deleted, the plugin cannot distinguish “never restricted” from “record lost”, so affected Agents return to the normal workspace catalog after a restart. Install / start / uninstall evidence from a
disposable profile is in [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Caveats

- The cross-preset filters wrap internal services, not documented extension
  points. A DSH upgrade can break them; when it does, the panel separately shows
  `skillFilterInstalled: false` or `mcpFilterInstalled: false` instead of silently pretending to filter.
- Workspace scan failures fail open; corrupt or unreadable per-Agent allowlist storage fails closed.
- Workspace policy only controls scan-root Skills. An explicit child-Agent allowlist filters the final complete catalog too, including Desktop/runtime Skills.
- The project root is the nearest ancestor with `.git`, `.dsh/capability-scope.yml`,
  `.dsh/skills` or `.agents/skills`; a workspace nested inside another workspace
  inherits the outer policy unless it creates its own marker.
- The panel needs the 0.2.x UI slots `sidebar.workspaces.session.menu.item` and
  `shell.overlay`; on older builds filtering still works but the menu entry is absent.

## Development

```bash
npm test    # manifest / patch / client id / market index / import graph
npm pack    # dsh-workspace-capability-<version>.tgz
```

`market/index.json` is a format-1 plugin-market index that lists this package;
host it over https and add the URL under Settings → Plugin Market → Indexes.
`scripts/check.mjs` only checks the package offline — real behaviour needs a DSH
boot (a throwaway profile with `@deepseek-ai/dsh-base`, `dsh-web-app` and this
bundle is enough).

## License

MIT
