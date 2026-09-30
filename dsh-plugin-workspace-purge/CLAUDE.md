# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

单包 DSH（DeepSeek Harness）插件 **dsh-plugin-workspace-purge**：工作区被删除时，删除它名下的已存储会话，而不是让它们落进「未分组」。`lib/` 就是发布的源码——没有构建、转译或打包步骤。git 仓库根在上一级 `DshPlugins/`（`.git` 在那里），所以在本目录里 `git status` 会一并看到 `dsh-plugin-init/` 与 `dsh-net-proxy/` 的改动；跨插件的共同约定写在仓库根 `CLAUDE.md`。

## 这份插件会删真实数据

- **当前这台机器上它并没有在跑**：`desktop` profile 的 `dsh.profile.bundles` 里没有本插件（DSH 升级到 0.2.0-rc.2 时安装被清空了）。要让它生效得重新 `dsh plugin --profile desktop add <本目录>` 并重启 DSH；装好后 `profiles/desktop/node_modules/dsh-plugin-workspace-purge` 指向本工作树，运行中的 harness 执行的就是你正在编辑的 `lib/index.js`。
- `lib/index.js` 里的一处错误，代价是这台机器上真实的会话日志：没有回收站、没有撤销，`fs.rm` 之后不可恢复。
- 改任何护栏（`sessionDirOf` 的路径形状、`sharedDirectories` 的共享目录判定、活跃会话判断、`removeSessionDir` 的删前复核）都必须同时补一个在临时目录上证明新行为的测试。
- 没有任何东西热重载插件代码：`dsh-base` 的 `hmr` 行（`@deepseek-ai/cordis-plugin-hmr`）带 `disabled: true`，而 `patchReload: "live"` 只监听 profile 的用户补丁文件。改 `lib/` 或 `cordis.patch.yml` 都只在 harness 重启后生效。

## 命令

```sh
npm test                                                                     # 3 个测试文件、25 个用例
node --test test/purge.test.js                                               # 单文件（13 个用例）
node --test --test-name-pattern="a live session is kept" test/purge.test.js  # 单用例
node test/lifecycle.manual.mjs                                               # 手工：真 Cordis 生命周期
```

- 没有 lint / format / typecheck 配置，也没有 CI。测试用 Node 内置 runner。
- 裸跑 `node --test` 会额外收进 `test/lifecycle.manual.mjs`（runner 收 `test/` 下的所有文件）。它在这份 checkout 里能通过（26/26），但它是手工脚本，日常用 `npm test`——`package.json` 的脚本里逐字列了那三个 `.test.js`。
- 手工脚本从本目录直接跑即可：`import("dsh-plugin-workspace-purge")` 走 `exports` 的包自引用。它必须打印四行 `true`（删除被记账的会话、保留活跃会话、保留别的工作区的会话、dispose 之后观察者消失）。
- `node_modules/@deepseek-ai/{cordis,schemastery}` 是从 npm 装来的真实 0.2.0-rc.2 包（`npm install --no-save --no-package-lock --ignore-scripts`），本插件刻意不保留 lockfile。0.1.5 时代它们是指向 `$DSH_HOME/profiles/node_modules/` 的 junction，那条链路在 DSH 升级后已全部悬空——别再往 `$DSH_HOME` 里造 junction（根 `CLAUDE.md` 有完整说明）。

## 架构：一次工作区删除的完整路径

```
客户端 Delete / 其他插件 / 宿主脚本
  → ctx.workspaceRegistry.delete(id) → deleteKnown(id)
       先 entities.delete(id)，再写表，表写入才发出事件   ← 事件到达时 get(key) 已是 undefined
  → domain/changed { domain:"workspace", table:"workspaces", key, operation:"deleted" }   ← 不带 value
  → WorkspacePurge.observe：取镜像账本 → 压入 #chain（绝不 await）
  → purge(sessionIds)
       sessionPersistence.listArtifacts()    → Map<sessionId, logPath>
       planPurge(ids, artifactPaths, isLive) → { purge, live, absent, refused }   ← 纯函数，不碰文件系统
       removeSessionDir(dir, logName)        → "removed" | "absent" | "unidentified"
       emit("api-session/removed", id)       → dsh-api-remotes 白名单转发 → 客户端不刷新就删掉那一行
       #log(report, total)                   → 恰好一行汇总
```

`lib/index.js` 的接缝：`name` / `inject` / `Config` / `apply` 是 Cordis 接口面；`sessionDirOf` 与 `planPurge` 是**导出给测试的纯函数接缝**（决策与文件操作分离，`test/index.test.js` 直接测它们，不需要 stub）；`removeSessionDir` 与 `#artifactPaths` 是私有实现；`WorkspacePurge` 持镜像账本 `#accounts` 与串行链 `#chain`，`settled()` 只为测试存在。`apply` 只做两件事：`seed(ctx.workspaceRegistry.list())` 抓下已有账本，再在 `ctx.effect` 里订阅 `domain/changed`——被 yield 的 `ctx.on` 销毁器就是唯一的注销路径。

## 契约（这些「简化」都已被证伪）

- **账本只能靠镜像。** `seed` 加上 `observe` 的 `put` 分支是它唯一可知的原因；不要改成删除时现查 `ctx.workspaceRegistry.get(key)`（原因见上面的时序）。镜像取自 `Workspace.sessionIds`，它是注册表自己的 live-cwd 过滤视图，与注册表每次写入前的过滤一致。
- **`planPurge` 拒绝被两个以上会话日志指名的目录。** 一个会话独占一个目录，所以这样的目录是它们上面的项目目录，递归删除会毁掉同级会话。这条护栏从后端自己的清单推导，不依赖路径约定，因此能挺过后端布局变更。
- **活跃会话绝不删除。** `ctx.sessions.get(id) !== undefined` 意味着持久化后端持有该日志句柄，下一次 append 会把文件重建出来；没有公开办法关闭活跃会话，所以只报告。
- **路径向后端要。** `listArtifacts()` 不在 `SessionPersistence` 的服务定义里（`@deepseek-ai/dsh-session-persistence` 整包都没有它），它是 JSONL 后端类上的方法，返回 `{ header, path }`。用 `typeof … === "function"` 探测，缺失实现会让清理大声失败；不要自己推导 `root/<projectKey>/<encoded-id>/session.vN.jsonl`。
- **`api-session/removed` 只在确实删掉某个会话目录（或发现它本就不存在）时才发。** 它在 `@deepseek-ai/dsh-api-remotes` 的宿主事件转发白名单里，客户端半边用 `ctx.remote.$on` 订阅。
- **清理绝不阻塞工作区写入。** `domain/changed` 的监听器只是通知，发出方还会吞掉它们的异常；清理跑在 `#chain` 串行链上并通过 logger 汇报，别把 `observe` 改成 await。
- **`inject` 三个服务全是必需。** 只有 `workspaceRegistry`、`sessionPersistence`、`sessions` 都存在 Cordis 才运行 `apply`，`WorkspaceFeed` 依赖同一保证来同步调用 `ctx.workspaceRegistry.list()`。
- 改这几处必须同步改测试：`apply` 的 effect 标签 `"dsh-plugin-workspace-purge: purge the Sessions of a deleted Workspace"` 与「恰好一个销毁器」、每次清理恰好一行汇总（含早退路径）、`Config` 两个开关默认 `true`。

## 激活

- `package.json` 的 `dsh.bundle.patch` → `./cordis.patch.yml`，后者只插入一个条目 `id: workspace-purge`，且 `lib/index.js` 导出的 `name` 必须与之一致。`test/bundle.test.js` 守卫这三者的对应关系。
- 安装：`dsh plugin --profile desktop add D:\Workspace\OpenSouces\DshPlugins\dsh-plugin-workspace-purge`（0.2.0-rc.2 起在用的 profile 是 `desktop`，不再是 `web`；装完必须重启 DSH）。
- **绝不要把同一个 insert 条目再加进 profile 自己的 `$DSH_HOME/profiles/<p>/cordis.patch.yml`。** 两层是叠加而非覆盖，加载器会合成出含重复 id 的列表，并以 `duplicate loader entry id "workspace-purge" in the composed profile` 让整个 profile 启动失败。`patchReload: "live"` 只监听用户补丁文件、不监听 bundle 列表，「加在那里省一次重启」很诱人——不要这么做。`test/bundle.test.js` 对已安装 profile 守卫这一点（profile 名单写死在测试里，`$DSH_HOME/profiles` 不存在时跳过）。

## 代码约定

- 纯 ESM JavaScript（Node >= 22）：`node:` 前缀导入、双引号、2 空格缩进、带 `u` 标志的正则；每个导出和非平凡函数都写 JSDoc，用 `@param - ` 风格。
- 源码里的 JSDoc、注释、错误信息一律英文，logger 输出一律以 `workspace-purge: ` 起头；`README.md` 与本文件用中文。
- `@deepseek-ai/*` 只留在 `peerDependencies`（`cordis`、`schemastery`），别移到 `dependencies`；`dsh-workspace`、`dsh-session`、`dsh-session-persistence` 通过 `ctx` 消费，因此有意不 import。
- **已知缺口：本插件不受 0.2.0-rc.2 的 peer 兼容性闸门保护。** 闸门只检查名字形如 `@deepseek-ai/dsh-*` 的 peer，而本插件一个都没声明，所以任何 DSH 版本都会照常加载它——包括 `domain/changed` 载荷或 `listArtifacts()` 形状变了的版本。它删的是不可恢复的真实数据，`sharedDirectories` 那道护栏只防「目录被多个会话指名」，防不住契约漂移。真想挡住，得声明一个真实的 DSH peer（如 `@deepseek-ai/dsh-workspace`）——那是对外可见的安装/加载行为变更，**尚未做**，要做得单独评估。
- 测试用 `node:test` + `node:assert/strict`，文件操作类断言跑在 `mkdtempSync` 出来的临时目录上。`test/index.test.js` 与 `test/purge.test.js` 里的 stub 上下文镜像 Cordis 的 `effect()` 生成器契约——扩展这些 stub，不要引入测试框架。

## 备注

- 出厂 Web 客户端的删除确认框仍承诺「文件夹与会话记录会保留」，装了本插件后那句话是假的。修正它需要一个客户端半边（`dsh.client` 加 locale 覆盖），**在有人提出需求之前不做**。
- 清理会把会话 id 留在注册表的 `archivedSessionIds` 里；它是惰性的，而从插件里写另一个包的领域状态更糟。
- `README.md` 承载安装/配置接口、本插件依赖的宿主 API 映射，以及必须保持准确的已知限制（不可恢复、活跃会话存活、派生索引滞后、只验证过 JSONL 后端）；「已知限制」一节末尾指向本文件。
- 远端已配置：`origin` = `https://github.com/xiaodaoaa/DshPlugins.git`，`main` 跟踪 `origin/main`。`.gitattributes` 强制 `* text=auto eol=lf`，而本机 `core.autocrlf=true`，别提交 CRLF。
