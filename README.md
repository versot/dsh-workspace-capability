# dsh-workspace-skill-scope

[English](README.en.md) | 中文

[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

<img src="icon.png" width="72" height="72" alt="">

按工作区控制会话能看到哪些 Skill 和整台 MCP Server：每个工作区一份 `.dsh/skill-scope.yml`，会话行菜单里勾选。
**对所有 preset 生效**（标准 / PTC / 极简 / 创造），也包括插件安装之前就存在的老会话。

## 安装

```bash
dsh plugin --profile <profile> add github:versot/dsh-workspace-skill-scope
```

装完重启 DSH，会话行「⋯」里会出现「工作区 Skill 与 MCP…」。也可以装本地包：
`dsh plugin --profile <profile> add ./dsh-workspace-skill-scope-<version>.tgz`。

需要 DSH `>= 0.2.2-rc.3`（`engines.dsh`，更低版本拒绝加载）与 Node `>= 22.12.0`。

## 配置

`<工作区>/.dsh/skill-scope.yml`，文件不存在时行为与标准模式完全一致（全部可用）：

```yaml
projectSkills: true    # <工作区>/.dsh/skills、<工作区>/.agents/skills
userSkills: false      # ~/.dsh/skills、~/.agents/skills
bundled: true          # DSH 自带 skill
allow: []              # 非空 = 只放行这些名字（白名单）
deny: []               # 排除这些名字
include: []            # 即使所属组关闭也保留的名字
mcpServers: [comfyui]  # 可选；只放行整台 comfyui Server；省略 = 全部 MCP Server
```

可见性顺序：`deny` → `include` → `allow`（非空时）→ 组开关。所以「用户级整组关掉、只留
`prompt-optimizer`」就是 `userSkills: false` + `include: [prompt-optimizer]`。

`mcpServers` 按 Server 名控制整个命名空间；`comfyui` 对应全部 `mcp__comfyui__*` 工具，不支持单个 MCP 工具开关。省略此字段时所有当前及以后新连接的 MCP Server 都默认可用；写 `[]` 时隐藏全部 MCP 工具。Skill-only 或 MCP-only 配置互不影响另一类能力。

改文件不用重启：provider 每 1.5s 轮询签名，面板保存还会立刻失效一次。MCP 策略从下一次模型请求开始应用，不追溯正在执行的回合。

## 子 Agent 的 skill 白名单

插件新增 `subagent_with_skills` 工具。父 Agent 用它创建 **spawn 子 Agent** 时，可以通过
`skills` 参数传入允许子 Agent 使用的 skill 名称白名单。子 Agent 最终可见的 skill 是：

```text
父 Agent 当前工作区策略下的可见 skill ∩ skills 显式白名单
```

白名单的校验也以**父 Agent 当前可见目录**为准，而不是以机器上的全部 skill 为准。因此，名单中只要含有
未知名称，或含有被工作区策略隐藏、父 Agent 当前不可见的名称，请求就会被拒绝，不会静默忽略。

- 省略 `skills`：继承父 Agent 当前可见的全部 skill；
- `skills: []`：创建零 skill 的子 Agent；
- 传入非空数组：仅暴露交集中的 skill；
- `mcpServers` 同样可省略（继承）、传 `[]`（无 MCP）或传 Server 名数组；有效范围是 `工作区可见 ∩ 父 Agent 可见 ∩ 显式选择`；
- 策略持久化到工作区的 `.dsh/agent-skill-scopes.json`，旧版 Skill-only 记录兼容并默认继承全部父级可见 MCP Server。

这是对 spawn 子 Agent 的 **Skill 可见性限制**，不是安全沙箱或权限边界。它依赖工作区内的
`.dsh/agent-skill-scopes.json`；能修改或删除该文件的主体也能破坏限制。`fork` 还可能从历史中继承已经加载的
skill 内容，因此也不能用作隔离手段。

## 面板

会话行 **「⋯」→ 工作区 Skill 与 MCP…**：Skill 组/单项和每台 MCP Server 各有勾选框，背后就是上面那份 YAML。保存时先写入同目录临时文件，再通过 `rename` 替换目标文件、刷新已挂载的 provider，然后自动关闭面板；替换语义当前仅在 macOS 验证，其他平台尚未验证。

- 组关掉后仍可单独勾选某个 skill（写进 `include`）；
- 全部勾上 = 与标准模式完全一致；
- 面板分别报告 `skillFilterInstalled` 与 `mcpFilterInstalled`；任一共享过滤没装完整时都会显示对应红色警告；旧客户端仍可读取兼容字段 `filterInstalled`（仅代表 Skill Filter）；
- 策略中已经选中但当前未连接的 MCP Server 会以“当前未连接”保留显示，保存其他设置不会静默删除它。

## 权限与外部服务

这个插件需要文件与网络能力，属于商城口径里的高权限插件（`user-reviewed`）。

| 能力 | 用在哪 | 边界 |
| --- | --- | --- |
| 读取文件 | 扫四个 skill 根与内置目录 | 只读 `SKILL.md` 及其 frontmatter |
| 写入文件 | `<工作区>/.dsh/skill-scope.yml` 与 `.dsh/agent-skill-scopes.json` | 同目录临时文件后通过 `rename` 替换；非法输入不写入；替换语义当前仅在 macOS 验证 |
| 网络 | DSH 自带 `webServer` 上的同源前缀 `/dsh-workspace-skill-scope` | 不访问任何外部服务，无遥测 |
| 会话信息 | session id → 工作区路径（`workspaceRegistry`，退回 `sessions`） | 只读，不落盘、不外传，不读凭据 |
| 子进程 / Shell | 无 | — |
| 生命周期脚本 | 无 | 安装期不执行代码 |

唯一运行依赖 `yaml@^2.9.0`，锁定在 `pnpm-lock.yaml`（当前 `yaml@2.9.1`，带 integrity）。

失败边界：工作区目录扫描异常 fail-open；已找到但损坏或不可读的白名单存储会 fail-closed（零 skill）；
写文件失败保留原文件且不启动子 Agent；DSH 低于 `0.2.2-rc.3` 拒绝加载。`.dsh/agent-skill-scopes.json` 是可见性限制状态的一部分，迁移工作区时必须一并保留；若它被删除，插件无法区分“从未限制”和“记录丢失”，重启后相关 Agent 会退回普通工作区目录。

## 已知边界

- 跨 preset 的过滤是包在共享 `skills` 服务上的（`filter.js` 改写 `list`/`snapshot`/`get`），属于非官方扩展点；
  DSH 大版本升级后可能失效，失效时面板会分别报告 `skillFilterInstalled: false` 或 `mcpFilterInstalled: false`，不会静默假装在过滤。
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
