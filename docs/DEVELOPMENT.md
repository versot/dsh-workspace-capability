# 开发说明 / Development

## 文件组成

| 文件 | 作用 |
| --- | --- |
| `catalog.js` | 扫描与策略的全部逻辑：`findWorkspaceRoot` / `readWorkspaceConfig` / `rootsFor` / `discoverRoot` / `collectWorkspaceCatalog`，外加 `WorkspaceScopeProvider` 类。不含 Cordis 插件 |
| `filter.js` | 包一层共享 `skills` 服务（`list`/`snapshot`/`get`），让 Skill 策略对所有 preset 生效；状态通过 `skillFilterInstalled` 报告给面板，`filterInstalled` 仅作旧客户端兼容别名 |
| `mcp-scope.js` | 按 `mcp__<server>__<tool>` 整台过滤共享工具服务的读路径与 resolved tool set；安装过程事务式回滚，状态通过 `mcpFilterInstalled` 单独报告 |
| `agent-scopes.js` | 持久化子 Agent 的 Skill/MCP 范围并注册 `subagent_with_skills`；省略 MCP 参数时快照父 Agent 当前可见 Server，保证后代范围不扩大 |
| `provider.js` | preset 半侧（`./provider`）：注册 `WorkspaceScopeProvider`。**当前没有行引用它**——preset 声明已删除，保留是为了将来想恢复「某个模式自带 provider」时不用重写 |
| `index.js` | Host 半侧（包根）：注册 `/dsh-workspace-skill-scope` 路由、安装 `filter.js`。必须挂在**裸包名**那一行——`client-modules` 只扫裸包名的 active row 来发现 `./client` |
| `client.js` | 浏览器半侧：会话行「⋯」菜单项 + 面板（`shell.overlay` 自绘浮层，不用 `Modal` 的固定窄宽） |
| `cordis.patch.yml` | bundle 层：只插入一行 Host 行 `workspace-skill-scope-host`；不声明 preset，也不改默认 preset |
| `market/index.json` | 应用内插件市场的索引条目（format 1） |
| `docs/index.html`, `docs/icon.png` | GitHub Pages 落地页与其图标 |

## 两个实现要点

1. **webServer 懒注册**：`index.js` 不再 `export const inject = ["webServer"]`，而是在 `apply()` 里
   `ctx.inject(["webServer"], …)` 再注册路由。否则在没有 web 服务的组合（headless/最小 profile）
   里整行会永久 `pending (waiting for service: webServer)`。
2. **裸包名那一行**：`client-modules` 的 `exactPackageSpecifier` 只接受 `pkg` 形式，`pkg/subpath`
   会被跳过，浏览器半侧就不会被加载。所以包根必须是 RPC 行，provider 才放在 `./provider` 子路径。

## `subagent_with_skills` 的作用域语义

`subagent_with_skills` 只用于 spawn 子 Agent。父 Agent 可传可选的 `skills` 白名单；有效集合按下式确定：

```text
父 Agent 当前工作区策略下的可见目录所产生的 skill ∩ 显式 skills 名单
```

这里的验证基准必须是父 Agent**当前可见目录**。不能先对机器上的全量 skill 校验，再在子 Agent 侧过滤，
否则工作区策略隐藏的名称会泄漏或被错误接受。显式名单中出现未知名称，或出现父 Agent 当前不可见的隐藏名称，
都必须拒绝整个请求；不能只丢弃无效项。

输入约定：

| `skills` 值 | 语义 |
| --- | --- |
| 省略 | 继承父 Agent 当前可见的全部 skill |
| `[]` | 子 Agent 零 skill |
| 非空数组 | 仅使用父 Agent 当前可见集合与该数组的交集 |

解析后的子 Agent 策略持久化在工作区 `.dsh/agent-skill-scopes.json`。这是目录可见性限制，不是安全沙箱：
能修改工作区状态的主体可以破坏它，存储被删除后重启也会退回普通工作区目录。`fork` 还可能从历史继承已加载的
skill 内容，因此调用方不能把任何一条路径当作权限边界。

## 本地联调

profile 里用 `link:` 指向本目录，改完重启 DSH 即生效：

```bash
dsh plugin --profile <profile> add "link:$PWD"
```

## 离线自检

```bash
npm test        # manifest / patch / client id / market index / import 图
node probe.mjs <工作区目录>
```

`probe.mjs` 像 Loader 一样加载 `provider.js`、伪装 `skills` 服务，打印该工作区实际会得到的 catalog。
内置 skill 在 Desktop 的 `app.asar` 里，普通 node 读不到，要连内置一起看就先解出目录：

```bash
DSH_BUNDLED_SKILL_DIR=/tmp/dsh-bundled-skills/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills \
  node probe.mjs "/path/to/workspace"
```

## 不启动 UI 验证路由

起一个临时 profile（bundles 只放 base + web-app + 本包），然后：

```bash
curl 'http://127.0.0.1:<port>/dsh-workspace-skill-scope/catalog?workspace=<编码后的工作区路径>'
curl -X POST 'http://127.0.0.1:<port>/dsh-workspace-skill-scope/policy' \
  -H 'content-type: application/json' \
  --data '{"workspace":"<路径>","config":{"projectSkills":true,"userSkills":false,"bundled":true,"allow":[],"deny":["beta"]}}'
```
