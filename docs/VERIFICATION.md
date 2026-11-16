# 一次性 Profile 验收记录 / Disposable-profile evidence

这份记录对应 DSH STORE 整改要求里的「一次性 Profile 的安装、启动与卸载证据」。
所有命令都在 `DSH_HOME=$(mktemp -d)` 下执行，真实 `~/.dsh` 全程未被读写。

## 环境

| 项 | 值 |
| --- | --- |
| 宿主 | DeepSeek Harness Desktop `0.2.1-rc.5` |
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
  "visible": ["rendezvous-shot-maker", "script-writing-studio",
              "agent-experience", "cordis-composition-reference",
              "cordis-plugin-development", "editing-cordis-compositions"]
}
```

HTTP 200；`filterInstalled: true` 说明共享 `skills` 服务的过滤层已装上。

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

## 覆盖范围与未覆盖项

已覆盖：

- 固定分支源码 → 安装 → 依赖安装 → Host 行挂载 → HTTP 路由响应 → 卸载 → 目录清理。

未覆盖（不应被读成 `passed`）：

- 其他 DSH 版本（仅验证 `0.2.1-rc.5`；`0.2.2-alpha.*` 未测试，`dsh.compatibility.dshReleases` 里不声明）。
- Windows / Linux。
- Desktop 面板里的图标、菜单项与保存交互（需真人点击）。
- 真实用户 Profile 的升级路径。
