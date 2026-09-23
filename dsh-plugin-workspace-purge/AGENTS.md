# AGENTS.md — dsh-plugin-workspace-purge

一个单包 DeepSeek Harness（DSH）插件：工作区被删除时，删除它名下的已存储会话。`lib/` 就是发布的源码：没有构建、转译或打包步骤。

## 这份 checkout 就是正在运行的插件

- 当某个 profile 以 `"dsh-plugin-workspace-purge": "link:D:/Workspace/OpenSouces/DshPlugins/dsh-plugin-workspace-purge"` 安装它时，正在运行的 harness 就在从你编辑的工作树里执行清理。
- 没有任何东西会重载它：`dsh-base` 带的是 `hmr` 行（`@deepseek-ai/cordis-plugin-hmr`）且 `disabled: true`，而 `patchReload: live` 只监听 profile 的补丁文件。插件代码与 `cordis.patch.yml` 的改动只有在 harness 重启后才生效。
- **这个插件会删数据。** `lib/index.js` 里的一个错误，代价是它所在机器上真实的会话日志。改动护栏时，必须同时补一个在临时目录上证明新行为的测试。

## 命令

- `npm test` 用 Node 内置 runner 跑三个测试套件。仓库里没有 lint、format 或 typecheck 配置。
- 单文件：`node --test test/purge.test.js`。单个用例：
  `node --test --test-name-pattern="a live session is kept" test/purge.test.js`。
- 不要裸跑 `node --test`：它还会收集 `test/lifecycle.manual.mjs`，而那个脚本需要 `@deepseek-ai/cordis` 可解析，不属于本包的依赖集合。
- 测试套件通过 `node_modules/@deepseek-ai/` 里的 junction 解析 `@deepseek-ai/*` → `$DSH_HOME/profiles/node_modules/@deepseek-ai/`。没有 lockfile 或安装步骤会重建它们；请保留在原地。`npm test` 只需要 `schemastery`；手工脚本需要 `cordis`。
- `node test/lifecycle.manual.mjs` 从仓库根目录运行（它的 `import("dsh-plugin-workspace-purge")` 通过 `exports` 的包自引用解析），用来证明真实 Cordis 的激活、inject 解析、订阅与销毁。它必须打印四行 `true`。

## 约定契约

- `cordis.patch.yml` 必须只插入一个条目 `id: workspace-purge`，且 `lib/index.js` 里的 `name` 必须与该 id 一致。把 `dsh-plugin-workspace-purge` 列进 `dsh.profile.bundles` 的 profile，不得在自己的 `cordis.patch.yml` 里重复该 id：加载器会把两层合成为一个列表，重复 id 会让整个 profile 启动失败。`test/bundle.test.js` 针对已安装 profile 守卫这一点，并在 `$DSH_HOME/profiles` 不存在时跳过。
- **会话账本必须靠镜像，绝不能在删除时现查。** `domain/changed` 的删除事件只带 `{ domain, table, key, operation: "deleted" }`，而 `WorkspaceRegistry.deleteKnown` 在发出事件的那次表写入**之前**就已把实体从缓存里移除。`WorkspacePurge.seed` 加上 `observe` 的 `put` 分支，是账本唯一可知的原因；不要把它们「简化」成一次 `ctx.workspaceRegistry.get(key)` 调用。
- **`planPurge` 拒绝被两个以上会话日志指名的目录。** 一个会话独占一个目录，所以这样的目录是它们上面的项目目录，递归删除它会毁掉同级的其他会话。这是能在后端布局变更后依然生效的护栏；保留它，也保留它的测试。
- **活跃会话绝不删除。** `ctx.sessions.get(id) !== undefined` 意味着持久化后端持有该日志句柄，且下一次 append 会把文件重建出来。没有公开办法关闭活跃会话，所以只报告，不强删。
- `ctx.sessionPersistence.listArtifacts()` **不在** `SessionPersistence` 服务定义里——它是 JSONL 后端类上的方法。用 `typeof … === "function"` 探测它，缺失实现会让清理大声失败。不要改成自己推导 `root/<projectKey>/<encoded-id>/session.vN.jsonl`；那套约定是 `@deepseek-ai/dsh-session-persistence-jsonl` 的私有实现。
- `api-session/removed` 在 `@deepseek-ai/dsh-api-remotes` 的宿主事件转发白名单里，`dsh-api-session-controller` 也是从插件上下文里以同样方式发出的。只有当本插件确实删掉了某个会话目录（或发现它本就不存在）时才发出该事件。
- `apply` 在 `ctx.effect(generator, "dsh-plugin-workspace-purge: purge the Sessions of a deleted Workspace")` 里完成播种与订阅；被 yield 的 `ctx.on` 销毁器就是取消订阅的路径。`test/index.test.js` 断言该标签和恰好一个销毁器。
- `inject` 把 `workspaceRegistry`、`sessionPersistence`、`sessions` 都列为必需。只有它们都存在时 Cordis 才会运行 `apply`——`WorkspaceFeed` 依赖同一保证来同步调用 `ctx.workspaceRegistry.list()`。
- 每次清理都写恰好一行汇总，早退路径也包括在内。`test/purge.test.js` 断言这些句子；改代码就一起改测试。

## 代码约定

- 纯 ESM JavaScript（Node >= 22）：`node:` 前缀导入、双引号、2 空格缩进、带 `u` 标志的正则。
- 每个导出和非平凡函数都要写 JSDoc，用 `@param - ` 风格。
- `@deepseek-ai/*` 一律留在 `peerDependencies`——harness 在进程内提供这些模块。绝不要把它们移到 `dependencies`。`dsh-workspace`、`dsh-session`、`dsh-session-persistence` 是通过 `ctx` 消费的，因此有意不做 import。
- 测试使用 `node:test` + `node:assert/strict`。`test/index.test.js` 与 `test/purge.test.js` 里的 stub 上下文镜像了 Cordis 的 `effect()` 生成器契约；扩展它们，不要引入测试框架。

## 备注

- 出厂 Web 客户端的删除确认框仍然承诺会话日志会被保留，因此在装了本插件的环境里那句话是明知故犯的错误。修正它需要一个客户端半边（`dsh.client`、构建出的客户端产物，以及 locale 覆盖）；在有人提出需求之前不做。
- 清理会把会话 id 留在注册表的 `archivedSessionIds` 里。它是惰性的，而从插件里写另一个包的领域状态会更糟。
- Git 仓库未配置远端：提交只留在本地，直到加上远端。
- `README.md` 承载安装/配置接口、本插件所依赖的宿主 API 映射，以及必须保持准确的已知限制。
