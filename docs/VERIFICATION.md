# 一次性 Profile 验收记录 / Disposable-profile evidence

这份记录对应 DSH STORE 整改要求里的「一次性 Profile 的安装、启动与卸载证据」。
所有命令都在 `DSH_HOME=$(mktemp -d)` 下执行，真实 `~/.dsh` 全程未被读写。

## 环境

| 项 | 值 |
| --- | --- |
| 宿主 | DeepSeek Harness Desktop `0.2.2-rc.3` |
| Node.js | 24.21.0（`runtime/primary-runtime`） |
| pnpm | 11.28.5（安装器内置） |
| 平台 | macOS（arm64） |
| 安装源 | `github:versot/dsh-workspace-skill-scope` 默认分支 |

## 1. 安装

```bash
export DSH_HOME="$(mktemp -d)"
dsh plugin --profile web add github:versot/dsh-workspace-skill-scope
```

观察到的 `profiles/web/package.json`：

```json
{
  "dependencies": { "dsh-workspace-skill-scope": "github:versot/dsh-workspace-skill-scope" },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-workspace-skill-scope"
  ] } }
}
```

依赖（`yaml@2.9.1`）由 pnpm 一并安装；没有 `preinstall/install/postinstall/prepare` 生命周期脚本。

`dsh --profile web --dump-config` 中的入口行：

```yaml
- id: workspace-skill-scope-host
  name: dsh-workspace-skill-scope
```

## 2. 启动

```bash
dsh --profile web --no-open --host 127.0.0.1 --port 0
# dsh web: http://127.0.0.1:53573/?token=…
```

首屏请求（同源，无需额外凭据）：

```bash
curl 'http://127.0.0.1:53573/dsh-workspace-skill-scope/catalog?workspace=<url-encoded-workspace>'
```

```json
{
  "filterInstalled": true,
  "skillFilterInstalled": true,
  "mcpFilterInstalled": true,
  "mcpServers": [
    { "name": "time", "toolCount": 3, "connected": true, "visible": true }
  ],
  "visible": ["rendezvous-shot-maker", "script-writing-studio",
              "agent-experience", "cordis-composition-reference",
              "cordis-plugin-development", "editing-cordis-compositions"]
}
```

HTTP 200；`skillFilterInstalled: true` 说明共享 `skills` 过滤层已装上，`mcpFilterInstalled: true` 说明共享 MCP 工具过滤已完整装上。`filterInstalled` 只保留为 Skill Filter 的旧客户端兼容字段。策略中已有但暂时离线的 Server 仍应出现在 `mcpServers`，且为 `toolCount: 0, connected: false`。

## 3. 卸载

```bash
dsh plugin --profile web remove dsh-workspace-skill-scope
```

`profiles/web/package.json` 回到：

```json
{ "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } } }
```

依赖与 bundle 行同时移除，`node_modules` 中被回收；临时 `DSH_HOME` 随后整目录删除。

## 4. `subagent_with_skills` 待执行验收矩阵

新增工具对 spawn 子 Agent 施加 Skill 可见性限制，但不是安全沙箱或权限边界。验收时先记录父 Agent 在当前
工作区策略下的可见目录与 skill 集合，再逐项检查；所有显式名单的合法性都必须相对于这份
**父 Agent 当前可见目录**判断。

| 用例 | 输入 | 预期 |
| --- | --- | --- |
| 继承 | 省略 `skills` | 子 Agent 继承父 Agent 当前可见的全部 skill |
| 零技能 | `skills: []` | 子 Agent 的 skill catalog 为空 |
| 白名单交集 | `skills: [<父 Agent 可见名称>]` | 子 Agent 仅看到“工作区可见集合 ∩ 显式名单” |
| 未知名称 | 名单含不存在的名称 | 整个 spawn 请求被拒绝，不静默忽略 |
| 隐藏名称 | 名单含已被工作区策略隐藏、父 Agent 当前不可见的名称 | 整个 spawn 请求被拒绝；验证不能绕过父 Agent 当前可见目录 |
| 持久化 | 完成一次带作用域的 spawn | 工作区 `.dsh/agent-skill-scopes.json` 记录解析后的策略 |
| 重启恢复 | 带作用域 spawn 后重启 DSH | 记录存在时，子 Agent 仍使用原目录限制 |
| 存储丢失或损坏 | 删除或破坏 JSON 后重启 | 记录丢失时退回普通工作区目录；已找到但损坏时零 skill，并明确这不是安全边界 |
| 后代不扩大 | 受限子 Agent 再调用 `subagent_with_skills` | 后代不能选择父级当前不可见的名称 |
| 不同 cwd | 子 Agent 指定相对或绝对 `cwd` | 工作区解析与策略存储位置符合预期 |
| 普通 spawn / fork 边界 | 使用 `subagent` 或 `subagent_fork` | 不宣称具有与本工具相同的可见性限制；fork 可能继承历史中的 Skill 内容 |

验证白名单交集时，应同时确认未列出的可见 skill 没有进入子 Agent，列出但隐藏的名称触发拒绝，以及持久化
文件与实际生效范围一致。以上各项在记录真实观察结果前都属于待执行项目，而不是通过证据。

## 覆盖范围与未覆盖项

已覆盖：

- 固定分支源码 → 安装 → 依赖安装 → Host 行挂载 → HTTP 路由响应 → 卸载 → 目录清理。

未覆盖（不应被读成 `passed`）：

- 其他 DSH 版本（当前子 Agent 白名单接口仅验证 `0.2.2-rc.3`，`dsh.compatibility.dshReleases` 只声明该版本）。
- Windows / Linux。
- Desktop 面板里的图标、菜单项与保存交互（需真人点击）。
- 第 4 节的子 Agent 可见性、重启恢复、存储丢失/损坏、后代、不同 cwd 与普通 spawn/fork 矩阵。
- 真实用户 Profile 的升级路径。
