# dsh-workspace-skill-scope

[English](README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-workspace-skill-scope)](https://www.npmjs.com/package/dsh-workspace-skill-scope)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

<img src="icon.png" width="72" height="72" alt="">

按工作区控制会话能看到哪些 skill：每个工作区一份 `.dsh/skill-scope.yml`，会话行菜单里勾选。
**对所有 preset 生效**（标准 / PTC / 极简 / 创造），也包括插件安装之前就存在的老会话。

## 安装

```bash
dsh plugin --profile <profile> add github:versot/dsh-workspace-skill-scope
```

装完重启 DSH，会话行「⋯」里会出现「工作区 Skill…」。也可以装本地包：
`dsh plugin --profile <profile> add ./dsh-workspace-skill-scope-1.0.0.tgz`。

需要 DSH `>= 0.2.1-rc.5`（`engines.dsh`，更低版本拒绝加载）与 Node `>= 22.12.0`。

## 配置

`<工作区>/.dsh/skill-scope.yml`，文件不存在时行为与标准模式完全一致（全部可用）：

```yaml
projectSkills: true    # <工作区>/.dsh/skills、<工作区>/.agents/skills
userSkills: false      # ~/.dsh/skills、~/.agents/skills
bundled: true          # DSH 自带 skill
allow: []              # 非空 = 只放行这些名字（白名单）
deny: []               # 排除这些名字
include: []            # 即使所属组关闭也保留的名字
```

可见性顺序：`deny` → `include` → `allow`（非空时）→ 组开关。所以「用户级整组关掉、只留
`prompt-optimizer`」就是 `userSkills: false` + `include: [prompt-optimizer]`。

改文件不用重启：provider 每 1.5s 轮询签名，面板保存还会立刻失效一次。

## 面板

会话行 **「⋯」→ 工作区 Skill…**：组与单项各一个勾选框，背后就是上面那份 YAML。保存会原子重写文件、
刷新已挂载的 provider，然后自动关闭面板。

- 组关掉后仍可单独勾选某个 skill（写进 `include`）；
- 全部勾上 = 与标准模式完全一致；
- 若共享过滤没装上，面板顶部会红字提示 `filterInstalled: false`。

## 权限与外部服务

这个插件需要文件与网络能力，属于商城口径里的高权限插件（`user-reviewed`）。

| 能力 | 用在哪 | 边界 |
| --- | --- | --- |
| 读取文件 | 扫四个 skill 根与内置目录 | 只读 `SKILL.md` 及其 frontmatter |
| 写入文件 | 只写 `<工作区>/.dsh/skill-scope.yml` | 先校验再原子替换；非法输入返回 400，原文件不动 |
| 网络 | DSH 自带 `webServer` 上的同源前缀 `/dsh-workspace-skill-scope` | 不访问任何外部服务，无遥测 |
| 会话信息 | session id → 工作区路径（`workspaceRegistry`，退回 `sessions`） | 只读，不落盘、不外传，不读凭据 |
| 子进程 / Shell | 无 | — |
| 生命周期脚本 | 无 | 安装期不执行代码 |

唯一运行依赖 `yaml@^2.9.0`，锁定在 `pnpm-lock.yaml`（当前 `yaml@2.9.1`，带 integrity）。

失败边界：过滤层任何异常都 fail-open（返回未过滤目录，不会让会话变零 skill）；写文件失败返回
400/500 并保留原文件；DSH 低于 `0.2.1-rc.5` 拒绝加载。

## 已知边界

- 跨 preset 的过滤是包在共享 `skills` 服务上的（`filter.js` 改写 `list`/`snapshot`/`get`），属于非官方扩展点；
  DSH 大版本升级后可能失效，失效时面板会报 `filterInstalled: false`，不会静默假装在过滤。
- 只过滤插件扫描根里的名字；Host 级 skill（Desktop 注入的 office 系列等）不受控制，面板里也不显示。
- 项目根 = 最近的含 `.git`、`.dsh/skill-scope.yml`、`.dsh/skills` 或 `.agents/skills` 的祖先目录；
  把新工作区建在已有工作区里面会继承它的策略。
- 面板入口依赖 0.2.x 的 UI slot（`sidebar.workspaces.session.menu.item`、`shell.overlay`）；
  更老的版本上过滤仍生效，只是没有菜单项。

## 卸载

```bash
dsh plugin --profile <profile> remove dsh-workspace-skill-scope
```

工作区里的 `.dsh/skill-scope.yml` 可以留着，没有插件时它不起作用。

## 开发与维护

实现说明、本地联调、离线自检见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)；
一次性 Profile 的安装 / 启动 / 卸载证据见 [docs/VERIFICATION.md](docs/VERIFICATION.md)；
发布与分发流程见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。
