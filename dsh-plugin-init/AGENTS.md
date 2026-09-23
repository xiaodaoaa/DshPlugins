# AGENTS.md — dsh-plugin-init

一个单包 DeepSeek Harness（DSH）插件，注册面向人的 `/init` 命令。`lib/` 就是发布的源码：没有构建、转译或打包步骤。

## 这份 checkout 与正在运行的插件

- `$DSH_HOME/profiles/web` 的 `dsh.profile.bundles` 里列了本包，但依赖声明是
  `"dsh-plugin-init": "link:D:/Workspace/OpenSouces/dsh-plugin-init"`——那个路径已经不存在
  （仓库搬到了 `DshPlugins/` 下）。`profiles/web/node_modules/dsh-plugin-init` 是**普通目录副本**，
  不是 junction（`fsutil reparsepoint query <该目录>` 报 not a reparse point）。
- 因此运行中的 harness 加载的是那份副本，**不是你正在编辑的工作树**。它的 `lib/` 目前与工作树一致，
  但 `AGENTS.md`/`README.md` 停在旧版本——这足以证明两者不是同一份文件。要让改动生效，得按
  README 记录的 `dsh plugin --profile web add <本目录>` 重装该 profile 的依赖，再重启 harness。
- 没有任何东西会重载它：`dsh-base` 的 `hmr` 行（`@deepseek-ai/cordis-plugin-hmr`）带 `disabled: true`，
  而 `patchReload: live` 只监听 profile 的补丁文件。插件代码与 `cordis.patch.yml` 的改动只在重启后生效。
- 改 `lib/template/initialize.txt` 就是改 `/init` 要 steer 的那段提示词本身。

## 命令

- `npm test` 用 Node 内置 runner 跑三个测试套件（17 个用例）。仓库里没有 lint、format、typecheck 或 CI 配置。
- 单文件：`node --test test/command.test.js`。单个用例：
  `node --test --test-name-pattern="steers one user message" test/command.test.js`。
- 不要裸跑 `node --test`：它还会收集 `test/*.manual.mjs`，而 `live-host.manual.mjs` 缺参数时以 2 退出，
  整轮因此变红。
- 测试套件通过 `node_modules/@deepseek-ai/` 里的 junction 解析 `@deepseek-ai/*`
  → `$DSH_HOME/profiles/node_modules/@deepseek-ai/`。没有 lockfile 或安装步骤会重建它们；请保留在原地。
- 手工脚本，有意排除在 `npm test` 之外：`node test/lifecycle.manual.mjs` 从仓库根目录运行
  （它的 `import("dsh-plugin-init")` 通过 `exports` 的包自引用解析），用真实 Cordis 证明激活与销毁，
  成功时打印 `registered after plugin(): init` 与 `registered after dispose: 0`。
  `test/live-host.manual.mjs <origin> <token>` 向运行中宿主的 `pluginInventory` RPC 询问本 bundle 的
  fiber 是否 `active`。

## 约定契约

- `cordis.patch.yml` 必须只插入一个条目 `id: init`。把 `dsh-plugin-init` 列进 `dsh.profile.bundles`
  的 profile，不得在自己的 `cordis.patch.yml` 里重复该 id：加载器会把两层合成为一个列表，
  重复 id 会让整个 profile 启动失败。`test/bundle.test.js` 针对已安装 profile 守卫这一点
  （扫描的 profile 名单写死在测试里），并在 `$DSH_HOME/profiles` 不存在时跳过。
- `@deepseek-ai/dsh-commands` 的命令是面向人的，不产生模型消息，因此模型侧工作靠 `agent.steer(...)` 承载。
  `@deepseek-ai/dsh-agent-loop` 的 `ReactLoop` 里三者是
  `steer → send(msg, "next-step", true)`、`followup → send(msg, "next-turn", true)`、
  `inject → next-step` 且不唤醒：区别在消息于下一步还是下一轮被认领，两者都会唤醒空闲 agent。
- 注册放在 `ctx.effect(generator, "dsh-plugin-init: register /init")` 里；被 yield 的销毁器就是注销路径。
  `test/command.test.js` 断言该标签与恰好一个销毁器。
- 模板在 `apply` 期间读取，因此错误的 `init.template` 路径会在插件激活时抛出，而不是在第一次 `/init` 时。
  相对路径按宿主进程目录（`process.cwd()`）解析；会话的 `cwd` 只影响 `${path}`
  （取 `agent.session.header.cwd`，缺失时回退 `process.cwd()`）。
- 处理器结果是 `{ kind: "success" | "error", text }`：注册表要求错误时 text 非空、`input.hint` 非空字符串、
  名称匹配 `/^[a-z][a-z0-9_-]*$/u`。
- `test/command.test.js` 断言打包模板里的确切句子
  （`Create or update \`AGENTS.md\` for this repository.`、
  `If \`AGENTS.md\` already exists at <cwd>`）。改模板就一起改这些断言。

## 代码约定

- 纯 ESM JavaScript（Node >= 22）：`node:` 前缀导入、双引号、2 空格缩进、带 `u` 标志的正则。
- 每个导出和非平凡函数都要写 JSDoc，用 `@param - ` 风格。
- `@deepseek-ai/*` 一律留在 `peerDependencies`——harness 在进程内提供这些模块。绝不要把它们移到 `dependencies`。
- 测试使用 `node:test` + `node:assert/strict`，并通过镜像 `effect()` 生成器契约的 stub Cordis 上下文
  驱动真实的 `apply` 与处理器；扩展它们，不要引入测试框架。

## 备注

- Git 根在上一级：`D:\Workspace\OpenSouces\DshPlugins`（远端 `origin` 指向
  `github.com/xiaodaoaa/DshPlugins`），本目录只是它里面的一个插件。`main` 还没有任何提交，
  整棵树都是未跟踪状态，所以在插件目录里 `git status` 只会看到一个 `dsh-plugin-init/` 条目，
  一次提交会同时覆盖两个插件。
- `package.json#files` 列出了 `LICENSE`，但工作树里没有该文件。
- `README.md` 承载安装/配置接口，以及解释代码为何长成这样的 opencode→DSH `/init` 映射表。
  改行为时同步改它：`agent.steer`/`followup`/`inject` 的差别、`template` 相对路径按 `process.cwd()`
  解析、`dsh plugin` 的路径锚定与 bundles 对账，都是它已经写明、且容易写错的地方。
