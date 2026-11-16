# 发布 / 分发

包名 `dsh-workspace-skill-scope`，`engines.dsh >=0.2.1-rc.5`、`engines.node >=22.12.0`。

## npm

```bash
npm login
npm test
npm publish --access public
```

或交给 CI：在仓库 Settings → Secrets 加 `NPM_TOKEN`（Automation token），然后
`git tag v1.0.0 && git push origin v1.0.0`（`.github/workflows/publish.yml` 会跑测试并发布）。
两条路只选一条，否则第二次会因版本已存在失败。

## GitHub（免 npm）

```bash
dsh plugin --profile <profile> add github:versot/dsh-workspace-skill-scope
dsh plugin --profile <profile> add github:versot/dsh-workspace-skill-scope#<40位commit>
```

索引里的 git 条目必须固定到 40 位 commit（不能写分支名）。代价是每次发版都要更新 commit 与 version。

## 应用内插件市场

市场读的是索引 JSON（format 1），不是中央服务器。`market/index.json` 已用 DSH 自带的
`dsh-plugin-market-index` 校验过；托管到任意 https 地址后，用户把它加到「设置 → 插件市场 → 索引」。

- 条目里的 `publishTimestamp` 要改成真实发布时间；
- 默认 `source` 是 npm；改用 git 时写 `{"type":"git","url":"…","commit":"<sha>"}`；
- 目前可直接用 raw 地址：
  `https://raw.githubusercontent.com/versot/dsh-workspace-skill-scope/main/market/index.json`

## DSH Hub（dshhub.org）

社区目录由公开仓库生成，收录入口是
[submit-plugin issue 模板](https://github.com/coderPerseus/dsh-hub/issues/new?template=submit-plugin.yml)，
填仓库、安装命令、已验证的 DSH 版本、分类。

## 发版检查清单

- [ ] `pnpm-lock.yaml` 与依赖一致（`pnpm install --lockfile-only`）
- [ ] `npm test` 通过
- [ ] `docs/VERIFICATION.md` 的固定 Commit 指向本版
- [ ] 版本号在三处一致：`package.json`、`market/index.json`、git tag
