# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库定位

DeepSeek Harness（DSH）插件集合，按 **DSH Desktop 0.2.0-rc.2** 适配（不保留对 0.1.x 的兼容）。

| 目录 | 作用 | 指令文件 |
|---|---|---|
| `dsh-plugin-init/` | 注册 `/init` 斜杠命令，steer agent 创建/刷新 `CLAUDE.md`（提示词逐字移植自 Claude Code） | `CLAUDE.md` |
| `dsh-plugin-workspace-purge/` | 删除工作区时连带删除它名下的已存储会话，而非留在「未分组」 | `CLAUDE.md` |
| `dsh-net-proxy/` | 把 agent 的网络请求（`web_search` / `web_fetch` / 外部 API）导入本地 HTTP/CONNECT/SOCKS5 代理，带流量日志与设置页。从上游 `mafeis/dsh-net-proxy` vendored | `CLAUDE.md` |

三个插件都是独立单包：`lib/` 就是**发布的源码**，零构建、零转译、零打包，也没有 CI。`cordis.patch.yml` 是 bundle 补丁，`README.md` 写安装/配置/设计，维护契约写在各自的 `CLAUDE.md`。前两个形态一致（`lib/index.js` + `test/`）；`dsh-net-proxy` 是**双面包**，形态不同（`tests/` 而非 `test/`，带 `package-lock.json`、`eslint.config.js`，`npm test` = 裸 `node --test`）。

**动手改某个插件之前，先读它自己那份指令文件（或 README）。** 本文件只写跨插件的共同事实。

## 插件形态与架构

**单面插件**（`dsh-plugin-init`、`dsh-plugin-workspace-purge`）：只导出 Cordis 插件接口面 `name` / `inject` / `Config` / `apply`，逻辑全跑在宿主进程里。`inject` 列的服务齐了 Cordis 才调 `apply`；`Config` 是 schemastery schema，部署方从补丁条目的 `config:` 传值，**默认值写在 schema 上而不是 `apply` 里**。`apply` 里的注册与订阅一律包进 `ctx.effect(generator, "<标签>")`，被 yield 的销毁器就是注销路径。

**双面插件**（`dsh-net-proxy`，本仓库唯一一个）：除宿主半边 `lib/index.js` 外还有一个**浏览器半边** `lib/client.js`，两半通过同源 HTTP 路由通信。它比单面插件多出三处 DSH 约定，错一处浏览器半边就不会加载：`package.json` 的 `dsh.client` 声明 + `exports` 的 `"./client"` 导出、`lib/client.js` 的 `window.__ModuleLoader__.load({ id, factory })` 手写 UMD 形态、以及 `dsh.client.inject` 里的模块名必须由前端**共享模块表**应答（**不能凭空 inject**）。

要新增一个双面插件、或改 `dsh-net-proxy` 的浏览器半边，先读 `dsh-net-proxy/CLAUDE.md`——那里写了共享模块表的当前内容、浏览器半边可用的 `ctx.slots` / `ctx.locale` 服务，以及宿主侧用 `webServer` 服务开同源路由的标准写法。真实范例在官方 UI 包：`app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-*/lib/client.js`。

## 命令

每个插件在自己的目录里独立测试（`dsh-net-proxy` 另有 lint）：

```sh
cd dsh-plugin-init && npm test              # 3 个套件、17 个用例
cd dsh-plugin-workspace-purge && npm test   # 3 个套件、25 个用例
cd dsh-net-proxy && npm test                # npm test = node --test，122 个用例
cd dsh-net-proxy && npm run lint            # eslint flat config

# 单文件 / 单个用例
node --test test/purge.test.js
node --test tests/routes.test.mjs
node --test --test-name-pattern="steers one user message" test/command.test.js
```

**前两个插件不要裸跑 `node --test`**：它会一并收进 `test/*.manual.mjs`，而 `live-host.manual.mjs` 缺参数时以 2 退出，整轮因此变红。`npm test` 的脚本里逐字列出三个 `.test.js` 正是为此。`dsh-net-proxy` 的 `tests/` 只有 `.test.mjs` 和 `fixtures/`，裸跑安全。

两个手工脚本**从插件目录直接跑即可**（`@deepseek-ai/*` 已从 npm 装到各自的 `node_modules`）：

```sh
node test/lifecycle.manual.mjs                                   # 真实 Cordis 生命周期
node test/live-host.manual.mjs http://127.0.0.1:<port> <token>   # 真实运行中的宿主
```

`dsh` 在 agent shell 里解析到 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。它是 pnpm 的转发器：`dsh plugin --profile <p> <pnpm-args...>`。

## 插件如何被激活（改完必须重启）

一条链路，任何一环断了插件都不会生效：

1. `package.json` 的 `dsh.bundle.patch` 指向 `./cordis.patch.yml`
2. `cordis.patch.yml` 用 `insert:` 插入条目 id（`init` / `workspace-purge` / `net-proxy`），且 `lib/index.js` 导出的 `name` 必须与之一致
3. profile 的 `dsh.profile.bundles` 里列出该包名——`dsh plugin --profile <p> add <本目录>` 会依据已安装状态自动对账这个列表

**陷阱：绝不要把同一个 insert 条目再加进 profile 自己的 `$DSH_HOME/profiles/<p>/cordis.patch.yml`。** 两层是叠加而非覆盖，加载器会合成出含重复 id 的列表，并以 `duplicate loader entry id "<id>" in the composed profile` 让**整个 profile 启动失败**。`patchReload: "live"` 只监听用户补丁文件、不监听 bundle 列表，「加在那里省一次重启」很诱人——不要这么做。两个插件的 `test/bundle.test.js` 守卫这一点（profile 名单写死在测试里，`$DSH_HOME/profiles` 不存在时跳过）。

**没有任何东西会热重载插件代码。** `dsh-base` 的 `hmr` 行（`@deepseek-ai/cordis-plugin-hmr`）带 `disabled: true`。改 `lib/` 或 `cordis.patch.yml` 都只在 harness 重启后生效。

### 0.2.0-rc.2 的兼容性闸门

`dsh-app-boot` 的 `evaluatePluginCompatibility()` 会在加载 profile 时逐个检查 bundle 的 `peerDependencies`，**只检查名字是 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的那些**，判定是 `semver.satisfies(运行时版本, 范围, { includePrerelease: true })`。不兼容的 bundle 被**跳过**而不是让 profile 失败，stderr 打一行 `dsh: skipping profile bundle "<name>": ...`。

- **`^0.1.5-rc.2` 不等于「0.1.5 及以上」**：node-semver 把它展开成 `>=0.1.5-rc.2 <0.2.0-0`，而 `0.2.0-rc.2 < 0.2.0-0` 为假（预发布标识 `0 < rc`）。`dsh-plugin-init` 曾因此在 0.2.0-rc.2 上被整包跳过。`^0.2.0-rc.2` 才对。
- 只声明 `cordis`/`schemastery` 的插件**不受闸门保护**（`dsh-plugin-workspace-purge` 就是），任何 DSH 版本都会照常加载。要挡住得声明一个 `@deepseek-ai/dsh-*` peer——尚未做，见其 `CLAUDE.md`。

临时放行靠 profile 里的 `<profile>/compatibility.json`（`{"<包名>@<精确版本>": ["<精确DSH版本>"]}`），写入方式是 `dsh plugin allow-version` 或插件管理器。**精确版本，不接受范围。**

## 依赖与测试基础设施

- `@deepseek-ai/*` 一律留在 `peerDependencies`——**绝不要移到 `dependencies`**。
- **运行时由 DSH 的解析拦截提供，插件自己不需要带。** 0.2.0-rc.2 的 `dsh-app-boot` 会装一层运行时模块解析拦截（`installRuntimeInterception` + `ResolutionRouter`，由 `PluginPackages` 这个 Service 在构造时安装）：它把安装树的整个依赖闭包与 profile 的包表合成一张表，并把 **`<profile>/node_modules` 下指向 `profiles/` 之外的 Junction 目标**登记为 *linked root*（`linkedProfileRoots`）。来自 linked root 的 `import` 命中 `routeLinked`：只要**插件自己的 `package.json` 把那个包声明为 peer**，裸标识符就被路由到安装树的那一份。所以 `dsh-net-proxy` 本地没装 `@deepseek-ai/schemastery` 也能加载。**别为了「运行时能 import」在插件里塞一份 `@deepseek-ai/*`。**
- **但测试跑在 DSH 之外，没有那层拦截**，本地仍需真包（`node --test` 与 `lifecycle.manual.mjs` 都靠它）。`@deepseek-ai/*` 已发布到 registry，当前 `0.2.0-rc.2`；各插件 `.gitignore` 忽略 `node_modules/`。
  - `dsh-plugin-init` / `dsh-plugin-workspace-purge`：`npm install --no-save --no-package-lock --ignore-scripts`（两者刻意不保留 lockfile）。
  - `dsh-net-proxy`：`npm install --legacy-peer-deps`。它的 `eslint ^9.39.5` 与 `@eslint/js ^10.0.1` 互相冲突（后者要求 peer eslint ^10），是上游遗留，`eslint.config.js` 注释里就写了这一点。该开关同时关掉 peer 自动安装，所以它 `node_modules/@deepseek-ai` 下只有 devDependency 级的 `dsh-http-proxy`——正常，它的 `tests/` 都不 import `lib/index.js`。
- **要在不启动宿主的前提下验证「插件能不能加载」**，别用裸 `node` 去 `import()` 插件入口——那会绕过上述拦截，报出假的 `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`。正确做法：用 Electron 以 `ELECTRON_RUN_AS_NODE=1` 跑脚本，依次调用 DSH 自己的 `loadProfile(binName, <profile>, <installAnchor>, <home>)` → `createRuntimeResolution({installAnchor, profile, home})` → `new PluginPackages(ctx, {resolution})`，**然后**才 import 插件入口。走完这三步，`resolution.entries`、`linkedRoots`、跳过的 bundle 与真实启动一致。
- **历史坑（别再踩）**：0.1.5 时代 `node_modules/@deepseek-ai/*` 是指向 `$DSH_HOME/profiles/node_modules/@deepseek-ai/` 的 junction，后者又指向安装目录 `D:\Program Files\DSH Desktop\...`。升级到 0.2.0-rc.2 后安装位置换成 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，那 243 个 junction **全部悬空**，插件连 `import` 都过不去。0.2.0-rc.2 另有 `removeLinkProjections()` 专门清理 0.1.5 link 后端投影进 profile 的包。**不要再往 `$DSH_HOME` 里造 junction。**
- 本机 `$DSH_HOME` 解析为 `C:\Users\fengchao12\.dsh`（agent shell 里已设置；未设置时代码回退 `%USERPROFILE%\.dsh`，同值）。
- 测试统一 `node:test` + `node:assert/strict`。两个 `dsh-plugin-*` 用**镜像 Cordis `effect()` 生成器契约的 stub 上下文**驱动真实的 `apply` 与处理器；`dsh-net-proxy` 用真实 `node:http`/`node:net` 起本地回环服务。扩展这些 stub/夹具，不要引入测试框架。

## 代码约定（两个 `dsh-plugin-*` 一致）

- 纯 ESM JavaScript，Node >= 22：`node:` 前缀导入、双引号、2 空格缩进、带 `u` 标志的正则。
- 每个导出和非平凡函数都写 JSDoc，用 `@param - ` 风格。
- `apply` 里的注册与订阅一律包在 `ctx.effect(generator, "<插件名>: <做什么>")` 中；被 yield 的销毁器就是注销路径，`test/*.test.js` 断言该标签字符串与销毁器数量。改标签要同步改测试。
- 每次清理/关键路径写恰好一行汇总日志（含早退路径），测试断言这些句子。改代码就一起改测试。

以上四条只约束两个 `dsh-plugin-*`。`dsh-net-proxy` 是 vendored 副本，风格自成一套，**不要为了统一去重排它**（会让上游 diff 无法比对）；它自己的约定见其 `CLAUDE.md`。

## 本机安装状态（2026-09-30 实测）

- **运行中的 DSH 是 Desktop `0.2.0-rc.2`**（nightly），装在 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，宿主代码打包在 `resources\app.asar`（`app.asar\dsh\node_modules\@deepseek-ai\*`）。**`app.asar` 是文件不是目录**，普通工具看不到里面；要读源码得解 asar，或让 Electron 以 `ELECTRON_RUN_AS_NODE=1` 跑脚本按 `file:///.../app.asar/...` 动态 import。
- **唯一在用的 profile 是 `desktop`，而它就是 `web`**：`dir /AL .dsh\profiles` 显示 `<SYMLINKD> desktop [C:\Users\fengchao12\.dsh\profiles\web]`（两边 File ID 相同，写一边另一边立刻可见）。两个名字指同一份文件。
- **`dsh` CLI 拒绝启动 `desktop` profile**：报 `error: profile "desktop" is managed exclusively by the Electron application`。要 dry-run 合成结果就用别名 `dsh --profile web --dump-config`（读同一批文件）；但 `dsh plugin --profile desktop add <dir>` 是允许的。
- **三个插件已装入该 profile**。`dsh.profile.bundles` = `[dsh-base, dsh-web-app, dsh-plugin-init, dsh-plugin-workspace-purge, dsh-net-proxy]`，`dependencies` 三条都是 `link:D:/Workspace/OpenSouces/DshPlugins/<插件>`，`profiles/web/node_modules/<包名>` 是指向工作树的 **Junction**。验证：`dsh --profile web --dump-config` 合成 298 条条目、零跳过，含 `id: init` / `id: workspace-purge` / `id: net-proxy`。
- 重装 / 换机时用活动 profile 的名字 `desktop`，装完**必须重启 DSH**；想确认某次装的是不是当前工作树，比对 `lib/index.js` 哈希或看 Junction 目标。卸载：`dsh plugin --profile desktop remove <包名>`。
- 只想临时验证「某几个 bundle 能不能合成」又不想动活动 profile：在 `$DSH_HOME/profiles/` 下建探针 profile，其 `node_modules/<包名>` 用 Junction 指向工作树，再 `dsh --profile <探针> --dump-config`——它会走真实加载器与兼容性闸门，并把跳过的 bundle 打到 stderr。
- `$DSH_HOME/profiles/node_modules/@deepseek-ai/` 下那 243 个悬空 Junction 是升级残留，当前无害但会误导排查；真正的宿主包在 `app.asar` 里。

## 指令文件的双候选（改 `/init` 或写文档时注意）

`@deepseek-ai/dsh-agent-instructions` 默认 `instructionFileCandidates` 是 `["AGENTS.md", "CLAUDE.md"]`（叠加层 `AGENTS.local.md` / `CLAUDE.local.md`），`projectRootMarkers` 是 `[".git"]`。含义：

- 同一目录下 `AGENTS.md` 与 `CLAUDE.md` **内容不同时会被双双注入**，token 翻倍；内容相同时只渲染一次。本仓库根目录与三个插件目录**各只有一份 `CLAUDE.md`，都没有 `AGENTS.md`**。
- 用户全局层只有 `$DSH_HOME/AGENTS.md` 一个文件名，没有全局 `CLAUDE.md`。
- 同一目录永远只留一份：再补另一种文件名时必须先合并，不要并列。仓库根与两个 `dsh-plugin-*` 的契约原先都叫 `AGENTS.md`，已于 2026-09-24 合并改名。

## 其他

- `.gitattributes` 强制 `* text=auto eol=lf`。本机 `core.autocrlf=true`，别提交 CRLF。
- 插件产生的中间文件放 `.tmp/`，不要提交（顶层尚无 `.gitignore`，`.tmp/` 目前只靠习惯约束，如需长期生效可补一条忽略规则）。`.tmp/harness-0.2.0-rc.2/` 是解 asar 出来的宿主源码快照，排查用，可随时删。
- `dsh-plugin-workspace-purge` **会删真实数据**：`lib/index.js` 里的一个错误，代价是这台机器上真实的会话日志。改它的护栏时必须同时补一个在临时目录上证明新行为的测试。
- 出厂 Web 客户端的删除确认框仍承诺会话日志会保留，装了 purge 插件后那句话是假的。修正它需要客户端半边（`dsh.client` + locale 覆盖），**在有人提出需求之前不做**。
