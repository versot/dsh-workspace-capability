[English](README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-workspace-skill-scope)](https://www.npmjs.com/package/dsh-workspace-skill-scope)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

# dsh-workspace-skill-scope

按工作区决定「这个工作区的会话能看到哪些 skill」的 DeepSeek Harness 插件。

每个工作区一份 `.dsh/skill-scope.yml`；会话行菜单里有勾选面板；对所有 preset 生效
（标准 / PTC / 极简 / 创造），也包括插件安装之前创建的老会话。

## 组成

| 文件 | 作用 |
| --- | --- |
| `catalog.js` | 扫描与策略的全部逻辑：`findWorkspaceRoot` / `readWorkspaceConfig` / `rootsFor` / `discoverRoot` / `collectWorkspaceCatalog`，外加 `WorkspaceScopeProvider` 类。不含 Cordis 插件 |
| `filter.js` | **主机制**：包一层共享的 `skills` 服务（`list`/`snapshot`/`get`），让工作区策略对**所有 preset**生效，包括标准/PTC/极简/创造和 preset 出现之前建的老会话。失败时 fail-open，状态会通过 `filterInstalled` 报告给面板 |
| `provider.js` | preset 半侧（`./provider`）：把 `WorkspaceScopeProvider` 注册进 `ctx.skills`。**目前没有被任何行引用**——preset 声明已删除，保留它只是为了将来想恢复「一个模式自带 provider」时不用重写 |
| `index.js` | Host 半侧（包根）：注册 `/dsh-workspace-skill-scope` 路由、安装 `filter.js`，并在每次返回里带 `filterInstalled`。**必须是裸包名那一行**——`client-modules` 只认裸包名的 active row 来发现 `./client` |
| `client.js` | 浏览器半侧：会话行「⋯」菜单加一项「工作区 Skill…」，打开只读面板（`Modal` + `shell.overlay`） |
| `cordis.patch.yml` | bundle 层：只插入一行 Host 行 `workspace-skill-scope-host`。**不声明 preset，也不改默认 preset**（默认仍是 `standard`） |
| `node_modules/yaml` | 运行期依赖。插件是按真实路径（本目录）加载的，DSH 的 profile 解析上下文帮不到它，所以 `yaml` 必须在插件自己的 `node_modules` 里能找到 |
| `locale/*.json` | 插件管理页的展示文案 |
| `icon.svg` | 插件图标 |

## 面板（可编辑）

- 入口：侧栏任意会话行的「⋯」→ **工作区 Skill…**
- 读取：`GET /dsh-workspace-skill-scope/catalog?session=<id>`；会话 → 工作区走 `ctx.get('workspaceRegistry').list()`（含未打开的会话），退回 `ctx.sessions.get(id).header.cwd`
- 写入：`POST /dsh-workspace-skill-scope/policy`，body `{ workspace|session, config }`。服务端用 `normalizeConfig` 校验（非法名字直接 400），原子写 `<工作区>/.dsh/skill-scope.yml`（临时文件 + rename），然后 `invalidateWorkspaceProviders()` 立刻刷新已挂载的 provider，再返回最新 catalog
- 语义：组开关 = `projectSkills` / `userSkills` / `bundled`；单项勾选在 `allow` 为空时写 `deny`，`allow` 非空时改白名单；全部勾上 = 与 standard 完全一致
- 生效范围：**所有 preset**（标准/PTC/极简/创造、以及老会话）——由 `filter.js` 在共享 `skills` 服务层过滤，所以换模式不会丢掉 skill 选择
- 自检：面板收到 `filterInstalled: false` 时会红字提示“共享过滤没装上”，此时策略完全不生效

测试路由不需要开 UI：起一个临时 profile（bundles 只放 base + web-app + 本包），然后

```bash
curl 'http://127.0.0.1:<port>/dsh-workspace-skill-scope/catalog?workspace=<编码后的工作区路径>'
curl -X POST 'http://127.0.0.1:<port>/dsh-workspace-skill-scope/policy' \
  -H 'content-type: application/json' \
  --data '{"workspace":"<路径>","config":{"projectSkills":true,"userSkills":false,"bundled":true,"allow":[],"deny":["beta"]}}'
```

## 安装 / 更新

profile：`~/.dsh/profiles/desktop`

1. `package.json` 的 `dependencies` 里有：
   `"@local/dsh-workspace-skill-scope": "link:/Users/versot/KSR秘密小道具/.dsh/plugin/dsh-workspace-skill-scope"`
   （等价命令：`dsh plugin --profile desktop add "link:<这个目录>"`）
2. `package.json` 的 `dsh.profile.bundles` 末尾有 `"@local/dsh-workspace-skill-scope"`。
3. 重启 DeepSeek Harness，新会话的 preset 列表里出现「工作区 Skill 作用域」。

## 验证（不依赖 GUI）

在本目录执行 `node probe.mjs <工作区目录>`：它像 Loader 一样加载 `index.js`、伪装 `skills` 服务，打印该工作区实际会得到的 catalog。

内置（bundled）skill 在 Desktop 的 `app.asar` 里，普通 node 读不到；要连内置一起看，先解出目录再指过去：

```bash
DSH_BUNDLED_SKILL_DIR=/tmp/dsh-bundled-skills/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills \
  node probe.mjs "/Users/versot/KSR秘密小道具"
```

更接近真实的一条：用 app 自带运行时 headless 起一个临时 profile（`scope-test`，bundles 只放 base + web-app + 本包），在 `apply()` 里打一行 stderr 探针，再 grep 日志——能证明 preset 真的挂载、provider 真的被创建。

## 策略文件

`<工作区>/.dsh/skill-scope.yml`，缺省（文件不存在）时行为与 `standard` 一致：

```yaml
projectSkills: true    # <工作区>/.dsh/skills、<工作区>/.agents/skills
userSkills: false      # ~/.dsh/skills、~/.agents/skills
bundled: true          # DSH 自带 skill
allow: []              # 非空 = 只放行这些名字（白名单）
deny: []               # 排除这些名字
include: []            # 即使整组关闭也保留的名字（面板里单点一个 skill 写这里）
```

可见性判定顺序：`deny` → `include` → `allow`（非空时）→ 所属组的开关。
所以「用户级整组关掉，但保留 prompt-optimizer」= `userSkills: false` + `include: [prompt-optimizer]`；
所有 root 始终会被扫描，组开关只影响可见性，不影响能不能被单独放行。

改文件不用重启：provider 每 1.5s 轮询签名，变化时 invalidate，模型侧下一次请求就能看到新目录；
面板保存还会直接 invalidate 一次，所以是立刻生效。

## 权限与外部服务（DSH STORE / Permissions）

这个插件需要文件与网络能力，属于商城口径里的高权限插件（`user-reviewed`）。具体边界：

| 能力 | 用在哪 | 边界 |
| --- | --- | --- |
| 读取文件 | 扫 `<工作区>/.dsh/skills`、`<工作区>/.agents/skills`、`~/.dsh/skills`、`~/.agents/skills`、内置 skill 目录 | 只读 `SKILL.md` 及其 frontmatter；不跟随出目录的符号链接目标 |
| 写入文件 | 只写 `<工作区>/.dsh/skill-scope.yml` | 临时文件 + `rename` 原子替换；内容先过 schema 校验，非法直接 400、不落盘 |
| 网络 | Host 在 DSH 自带 `webServer` 上注册一个同源前缀 `/dsh-workspace-skill-scope`；浏览器半侧 `fetch` 该前缀 | **不访问任何外部服务**，无遥测，无外发上报 |
| 会话信息 | 用 session id 换工作区路径（`workspaceRegistry`，退回 `sessions.get(id).header.cwd`） | 只读，不落盘、不外传；不读取凭据、cookie、token |
| 子进程 / Shell | 无 | 不执行任何外部命令 |
| 生命周期脚本 | 无 `preinstall/install/postinstall/prepare` | 安装期不跑代码 |

唯一的运行依赖是 `yaml@^2.9.0`（锁定在 `pnpm-lock.yaml`，当前解析 `yaml@2.9.1`，带 integrity）。

失败边界：过滤层任何异常都 fail-open（返回未过滤目录，不会让会话变零 skill）；写文件失败返回 400/500 且保留原文件；
DSH 低于 `0.2.1-rc.5` 拒绝加载。一次性 Profile 的安装 / 启动 / 卸载证据见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

## 已知边界

- **跨 preset 的过滤是包在共享 `skills` 服务上的**（`filter.js` 改写 `list`/`snapshot`/`get`），属于非官方扩展点。
  DSH 大版本升级后可能失效；失效时面板会红字提示 `filterInstalled: false`，不会静默假装在过滤。
- 只过滤本插件扫描根里的名字；Host 级 skill（Desktop 注入的 office 系列、workspace-dependencies 等）不受
  `skill-scope.yml` 控制，面板里也不显示。
- 过滤失败一律 fail-open：目录原样返回，不会把会话搞成零 skill。
- 项目根 = 最近的含 `.git`、`.dsh/skill-scope.yml`、`.dsh/skills` 或 `.agents/skills` 的祖先目录；
  都没有时就是会话 cwd。把新工作区建在已有工作区里面会继承它的策略。
- 面板入口依赖 0.2.x 的 UI slot（`sidebar.workspaces.session.menu.item`、`shell.overlay`）；
  更老的版本上过滤仍然生效，只是没有菜单项。

## 卸载

删掉 `dsh.profile.bundles` 里的那一项和 `dependencies` 里的那一项，重启 app。
工作区里的 `.dsh/skill-scope.yml` 可以留着，没有插件时它不起作用。

## 发布 / 分发

包名 `dsh-workspace-skill-scope`，`engines.dsh >=0.2.1-rc.5`。

```bash
npm pack                     # 产物：dsh-workspace-skill-scope-1.0.0.tgz
npm publish --access public  # 需要 npm 账号；发布前把 repository 字段补上
```

或者只发 GitHub 仓库，安装写法是 `github:<owner>/<repo>#<40位commit>`。

**应用内插件市场** 读的是索引 JSON（format 1），不是中央服务器：
`market/index.json` 是已经用 DSH 自带 `dsh-plugin-market-index` 校验过的模板，托管到任意 https 地址后，
用户把它加到「设置 → 插件市场 → 索引」即可看到并安装；条目里的 `publishTimestamp` 要改成真实的发布时间。

**DSH Hub（dshhub.org）** 是从公开仓库生成的社区目录，收录入口是它的
[submit-plugin issue 模板](https://github.com/coderPerseus/dsh-hub/issues/new?template=submit-plugin.yml)。
