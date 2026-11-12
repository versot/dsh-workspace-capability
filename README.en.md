# dsh-workspace-skill-scope

Per-workspace skill visibility for [DeepSeek Harness](https://www.deepseek.com/harness/).

Each workspace owns one `.dsh/skill-scope.yml`. Every session that runs in that
workspace sees only the skills the file allows — regardless of which preset the
session uses (Standard / PTC / Minimal / Create), and including sessions that
already existed before the plugin was installed.

[中文](README.md)

## Install

```bash
dsh plugin --profile <profile> add dsh-workspace-skill-scope
```

Then make sure the package is listed in that profile's `dsh.profile.bundles`
(the plugin manager does this for you) and restart DSH.

From a tarball instead of npm:

```bash
dsh plugin --profile <profile> add ./dsh-workspace-skill-scope-1.0.0.tgz
```

Requires DSH `>= 0.2.1-rc.5` (`engines.dsh`); older runtimes refuse to install it.

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
```

Visibility precedence: `deny` → `include` → `allow` (when non-empty) → the group
switch. So "user-level off, but keep `prompt-optimizer`" is
`userSkills: false` plus `include: [prompt-optimizer]`.

Edits apply without a restart: the provider polls the file every 1.5s and a panel
save invalidates immediately, so the next model request sees the new catalog.

## Panel

Session row **「⋯」→ 工作区 Skill…** opens a checklist: one checkbox per group and
per skill, backed by the YAML above. Saving rewrites the file atomically, refreshes
the mounted providers, and closes the panel.

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

## Caveats

- The cross-preset filter wraps an internal service, not a documented extension
  point. A DSH upgrade can break it; when it does, the panel shows
  `filterInstalled: false` instead of silently pretending to filter.
- It fails open: if anything throws, the unfiltered catalog is returned.
- Skills that no scan root produced (the office family injected by Desktop,
  runtime-registered skills) are never filtered.
- The project root is the nearest ancestor with `.git`, `.dsh/skill-scope.yml`,
  `.dsh/skills` or `.agents/skills`; a workspace nested inside another workspace
  inherits the outer policy unless it creates its own marker.
- The panel needs the 0.2.x UI slots `sidebar.workspaces.session.menu.item` and
  `shell.overlay`; on older builds filtering still works but the menu entry is absent.

## Development

```bash
npm test    # manifest / patch / client id / market index / import graph
npm pack    # dsh-workspace-skill-scope-1.0.0.tgz
```

`market/index.json` is a format-1 plugin-market index that lists this package;
host it over https and add the URL under Settings → Plugin Market → Indexes.
`scripts/check.mjs` only checks the package offline — real behaviour needs a DSH
boot (a throwaway profile with `@deepseek-ai/dsh-base`, `dsh-web-app` and this
bundle is enough).

## License

MIT
