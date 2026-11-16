# 开发说明 / Development

## 文件组成

| 文件 | 作用 |
| --- | --- |
| `catalog.js` | 扫描与策略的全部逻辑：`findWorkspaceRoot` / `readWorkspaceConfig` / `rootsFor` / `discoverRoot` / `collectWorkspaceCatalog`，外加 `WorkspaceScopeProvider` 类。不含 Cordis 插件 |
| `filter.js` | **主机制**：包一层共享 `skills` 服务（`list`/`snapshot`/`get`），让策略对所有 preset 生效，含插件安装前建的老会话；失败 fail-open，状态通过 `filterInstalled` 报告给面板 |
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
