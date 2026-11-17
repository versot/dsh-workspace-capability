# dsh-workspace-skill-scope

Per-workspace Skill and whole-MCP-server visibility for [DeepSeek Harness](https://www.deepseek.com/harness/).

Each workspace owns one `.dsh/skill-scope.yml`. Every session that runs in that
workspace sees only the skills the file allows — regardless of which preset the
session uses (Standard / PTC / Minimal / Create), and including sessions that
already existed before the plugin was installed.

[中文](README.md)

## Install

```bash
dsh plugin --profile <profile> add github:versot/dsh-workspace-skill-scope
```

Then make sure the package is listed in that profile's `dsh.profile.bundles`
(the plugin manager does this for you) and restart DSH.

From a local tarball instead:

```bash
dsh plugin --profile <profile> add ./dsh-workspace-skill-scope-<version>.tgz
```

Requires DSH `>= 0.2.2-rc.3` (`engines.dsh`); older runtimes refuse to install it.

## Configure

`<workspace>/.dsh/skill-scope.yml` — a missing file means "behave exactly like the
stock Standard preset", i.e. every skill is available:

```yaml
projectSkills: true    # <workspace>/.dsh/skills and <workspace>/.agents/skills
userSkills: false      # ~/.dsh/skills and ~/.agents/skills
bundled: true          # skills shipped with DSH
allow: []              # non-empty = whitelist: only these names
deny: []               # hide these names
include: []            # keep these names even when their group is switched off
mcpServers: [comfyui]  # optional whole-server allowlist; omit = all MCP servers
```

Visibility precedence: `deny` → `include` → `allow` (when non-empty) → the group
switch. So "user-level off, but keep `prompt-optimizer`" is
`userSkills: false` plus `include: [prompt-optimizer]`.

`mcpServers` controls complete server namespaces: `comfyui` means every
`mcp__comfyui__*` tool, never individual tools. Omit it to allow all current and
future servers; use `[]` to expose no MCP tools. Skill-only and MCP-only files
leave the other capability unrestricted.

Edits apply without a restart: the provider polls the file every 1.5s and a panel
save invalidates immediately. MCP changes apply on the next model request, not an
already-running turn.

## Skill allowlists for child agents

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
- the policy is persisted in `.dsh/agent-skill-scopes.json`; version-1 Skill-only records remain compatible and inherit parent-visible MCP servers.

This is a **Skill-visibility restriction** for spawned child agents, not a
security sandbox or permission boundary. It depends on the workspace-owned
`.dsh/agent-skill-scopes.json`; an actor that can modify or delete that file can
break the restriction. Fork may also retain already-loaded Skill content from
conversation history and is not an isolation mechanism.

## Panel

Session row **「⋯」→ 工作区 Skill 与 MCP…** opens a checklist: Skill groups/items
and one checkbox per complete MCP server, backed by the YAML above. Saving rewrites the file atomically, refreshes
the mounted providers, and closes the panel. Configured servers that are currently disconnected remain listed as offline, so unrelated saves do not discard them. The API and panel report `skillFilterInstalled` and `mcpFilterInstalled` separately; `filterInstalled` remains a compatibility alias for the Skill filter.

## How it works

Two rows, one bundle:

- **Host row** (`index.js`) serves `GET /dsh-workspace-skill-scope/catalog` and
  `POST /dsh-workspace-skill-scope/policy` for the panel. It also installs
  `filter.js`.
- **`filter.js`** wraps the shared `skills` service (`list` / `snapshot` / `get`)
  so the policy applies to every preset and to sessions created earlier. This is
  the only mechanism that can reach an already-created session: a session binds
  its preset at creation and never re-evaluates it.
- `provider.js` and `catalog.js` hold the scanner and a real skill provider; the
  provider is not mounted by default (no preset is declared).

## Permissions and external services

This plugin needs filesystem and same-origin network access, which puts it in the
marketplace's elevated-capability tier (`user-reviewed`):

| Capability | Used for | Bound |
| --- | --- | --- |
| Read files | scanning `<workspace>/.dsh/skills`, `<workspace>/.agents/skills`, `~/.dsh/skills`, `~/.agents/skills`, the bundled directory | reads `SKILL.md` frontmatter only |
| Write files | `<workspace>/.dsh/skill-scope.yml` and `.dsh/agent-skill-scopes.json` | workspace and child-Agent policies use atomic tmp + rename; invalid requests do not write |
| Network | one same-origin prefix `/dsh-workspace-skill-scope` on DSH's own `webServer`; the browser half fetches it | no outbound requests, no telemetry |
| Session data | session id → workspace path via `workspaceRegistry` (fallback `sessions.get(id).header.cwd`) | read-only, never stored or sent; no credentials, cookies or tokens |
| Subprocess / shell | none | — |
| Lifecycle scripts | none | install runs no code |

The only runtime dependency is `yaml@^2.9.0`, pinned in `pnpm-lock.yaml`
(currently `yaml@2.9.1` with an integrity hash).

Failure bounds: workspace discovery fails open; an allowlist store that is found but corrupt or unreadable fails closed (zero Skills). A failed child-policy write keeps the previous file and does not start the child. DSH older than
`0.2.2-rc.3` refuses to load the bundle. `.dsh/agent-skill-scopes.json` is part of the visibility state and must move with the workspace; if it is deleted, the plugin cannot distinguish “never restricted” from “record lost”, so affected Agents return to the normal workspace catalog after a restart. Install / start / uninstall evidence from a
disposable profile is in [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Caveats

- The cross-preset filters wrap internal services, not documented extension
  points. A DSH upgrade can break them; when it does, the panel separately shows
  `skillFilterInstalled: false` or `mcpFilterInstalled: false` instead of silently pretending to filter.
- Workspace scan failures fail open; corrupt or unreadable per-Agent allowlist storage fails closed.
- Workspace policy only controls scan-root Skills. An explicit child-Agent allowlist filters the final complete catalog too, including Desktop/runtime Skills.
- The project root is the nearest ancestor with `.git`, `.dsh/skill-scope.yml`,
  `.dsh/skills` or `.agents/skills`; a workspace nested inside another workspace
  inherits the outer policy unless it creates its own marker.
- The panel needs the 0.2.x UI slots `sidebar.workspaces.session.menu.item` and
  `shell.overlay`; on older builds filtering still works but the menu entry is absent.

## Development

```bash
npm test    # manifest / patch / client id / market index / import graph
npm pack    # dsh-workspace-skill-scope-<version>.tgz
```

`market/index.json` is a format-1 plugin-market index that lists this package;
host it over https and add the URL under Settings → Plugin Market → Indexes.
`scripts/check.mjs` only checks the package offline — real behaviour needs a DSH
boot (a throwaway profile with `@deepseek-ai/dsh-base`, `dsh-web-app` and this
bundle is enough).

## License

MIT
