# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这个包是什么

单包 DeepSeek Harness（DSH）插件，注册面向人的 `/init` 斜杠命令：把 agent steer 到当前仓库去创建或刷新 `CLAUDE.md`。提示词正文逐字移植自 Claude Code 的内置 `/init`，正文文件就是 `lib/template/initialize.txt`。

`lib/` 就是发布的源码——零构建、零转译、零打包。

跨插件的共同事实（`@deepseek-ai/*` 必须留在 `peerDependencies`、stub 测试上下文、profile 激活链路、改完必须重启、没有 lint/CI）写在仓库根的 `CLAUDE.md`；本文件只写这个插件自己的东西。

## 命令

```sh
npm test                        # = node --test test/bundle.test.js test/index.test.js test/command.test.js，17 个用例
node --test test/command.test.js
node --test --test-name-pattern="steers one user message" test/command.test.js

# 安装到某个 profile（dsh 是 pnpm 的转发器，会顺带对账 dsh.profile.bundles）
dsh plugin --profile <profile> add D:\Workspace\OpenSouces\DshPlugins\dsh-plugin-init
```

**不要裸跑 `node --test`**：它会把 `test/*.manual.mjs` 一起收进来，而 `live-host.manual.mjs` 缺参数时以 2 退出，整轮因此变红。

两个手工脚本有意排除在 `npm test` 之外，从任意目录都能跑：

```sh
node test/lifecycle.manual.mjs                                   # 真实 Cordis 生命周期
node test/live-host.manual.mjs http://127.0.0.1:<port> <token>   # 真实运行中的宿主
```

- `lifecycle.manual.mjs` 用真实 `Context.plugin()` 挂载（`import("dsh-plugin-init")` 走包自引用，所以加载的始终是这份 checkout），成功时打印 `registered after plugin(): init` 与 `registered after dispose: 0`——它证明的是激活、`ctx.effect` 生命周期与销毁，而不只是「模块能 import」。
- `live-host.manual.mjs` 走浏览器用的同一套 `/api` RPC，向运行中宿主自己的 `pluginInventory` 服务提问，回答的是「`/init` 到底有没有真的生效」。token 是宿主启动时打印的 `?token=`；应当报出一个 `moduleName: "dsh-plugin-init"` 且 `fiberPhase: "active"` 的条目。

## 架构：一次 `/init` 的完整链路

要读 `lib/index.js` + `lib/template/initialize.txt` + `test/command.test.js` 才拼得出来：

1. `ctx.commands.register()` 把命令发布给所有已合成的人类命令适配器，所以 `/init` 出现在 Web 输入框的斜杠列表里。
2. 处理器渲染打包模板：`${path}` → 会话 cwd，`$ARGUMENTS` → 用户原样输入。
3. 渲染结果经 `createUserMessage` 包成用户消息，交给 `agent.steer(...)`。
4. 命令以一行面向人的结果结束；模型侧的工作就是一次普通的 agent 轮次——读仓库、写 `CLAUDE.md`。

下面这些取舍是刻意的，别当成冗余「简化」掉：

- **命令本身不产生模型消息。** `@deepseek-ai/dsh-commands` 的命令是面向人的，所以模型侧工作只能由处理器自己发起。
- **用 `steer`，不用 `followup`/`inject`。** `@deepseek-ai/dsh-agent-loop` 的 `ReactLoop` 里：`steer → send(msg, "next-step", true)`、`followup → send(msg, "next-turn", true)`、`inject → send(msg, "next-step", false)`。`steer` 让忙碌会话在下一个步骤边界认领、让空闲会话立刻开一轮；`followup` 要等这一轮结束；`inject` 不唤醒。
- **模板在 `apply` 期间读一次。** 模板缺失、为空、或 `init.template` 不是非空字符串，都在插件激活时抛出，而不是等到第一次 `/init`。
- **相对 `init.template` 按 `process.cwd()`（宿主进程目录）解析**——既不是会话 cwd，也不是 profile 目录，所以写绝对路径最稳。会话 cwd 只影响 `${path}`：取 `agent.session.header.cwd`，缺失时回退 `process.cwd()`。
- **模板没提 `$ARGUMENTS` 时，用户输入被追加到末尾**，而不是丢掉——`/init focus on CI` 不能丢 focus。`$ARGUMENTS` 是全局替换，模板可以提多次。
- **不写「已初始化」时间戳。** `command/run`、`command/done` 由注册表追加进会话日志，那才是持久记录；重跑 `/init` 按设计无害，提示词要求对已有 `CLAUDE.md` 只建议改进、不直接重写。

## 契约（改之前先读这一节）

- `cordis.patch.yml` 必须只插入一个条目 `id: init`，且 `lib/index.js` 导出的 `name = "init"` 必须与之一致；`inject` 只声明 `["commands"]`。
- **`peerDependencies` 的两个 `@deepseek-ai/dsh-*` 范围是对外行为，不只是元数据。** 0.2.0-rc.2 的 profile 加载器会用 `evaluatePluginCompatibility()` 校验它们（只认 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`），不匹配就把整个 bundle 跳过——`/init` 静默不注册，只在 stderr 留一句 `dsh: skipping profile bundle "dsh-plugin-init": ...`。保持 `^0.2.0-rc.2`；**别再写 `^0.1.x`**，`^0.1.5-rc.2` 展开为 `>=0.1.5-rc.2 <0.2.0-0`，不接受 `0.2.0-rc.2`。DSH 升到新的 0.2.x 时这两个范围要跟着走。
- **绝不要把同一个 insert 再加进 profile 自己的补丁层**：两层是叠加而非覆盖，重复 id 会让整个 profile 启动失败（根 `CLAUDE.md` 有完整说明）。`test/bundle.test.js` 就是这里的守卫。
- 注册包在 `ctx.effect(generator, "dsh-plugin-init: register /init")` 里，被 yield 的销毁器就是注销路径。`test/command.test.js` 断言这个标签字符串与恰好一个销毁器——改标签要同步改测试。
- 处理器返回 `{ kind: "success" | "error", text }`。注册表的硬性要求：`kind: "error"` 时 `text` 非空、`input.hint` 非空字符串、`name` 匹配 `/^[a-z][a-z0-9_-]*$/u`。
- **`test/command.test.js` 断言打包模板里的确切句子**（`create a CLAUDE.md file`、``If there's already a `CLAUDE.md` at <cwd>``、``If an `AGENTS.md` already exists at <cwd>``）。改 `lib/template/initialize.txt` 就一起改这些断言。

## 测试怎么搭的

三个 `.test.js`，都用 `node:test` + `node:assert/strict`：

- `index.test.js` —— 模块形态（`name`/`inject`/`apply`/`Config`）、`renderPrompt` 的替换与追加规则、打包模板仍带两个占位符且不含 `$1` 式编号占位符。
- `command.test.js` —— 用**镜像 Cordis `effect()` 生成器契约的 stub 上下文**（跑 executor、收集被 yield 的销毁器）驱动真实的 `apply` 与真实处理器；只有 cordis 运行时和 agent 是替身。
- `bundle.test.js` —— 一个刻意很窄的 YAML 读取器（只认 `- insert:` 之后缩进的 `id:` 行，不引 YAML 解析器）检查 bundle 补丁，并守卫上面那条重复 id 陷阱。

## 改哪里

- `lib/template/initialize.txt` **就是** `/init` 要 steer 的那段提示词本身，改它等于改命令行为。
- `README.md` 承载安装/配置接口和一张 Claude Code→DSH `/init` 映射表（`${path}`/`$ARGUMENTS` 是本插件加的，`AGENTS.md` 合并要求也是本插件加的，保守语气与强制前缀原样保留）。**改行为就同步改它。**
- 运行中的 harness 加载的是 profile 里 `node_modules/dsh-plugin-init` 指向的那一份。**当前这台机器上本插件并未安装**（0.2.0-rc.2 的 `desktop` profile 的 `dsh.profile.bundles` 里没有它），要生效得 `dsh plugin --profile desktop add <本目录>` 再重启 DSH；若某次重装把它变回普通目录副本，比对两处 `lib/index.js` 的哈希或 mtime 即可确认加载的是哪一份。

## 备注

- Git 根在上一级 `D:\Workspace\OpenSouces\DshPlugins`（`origin` = `github.com/xiaodaoaa/DshPlugins`）。本目录只是其中一个插件，所以在插件目录里 `git status` 只会看到一个 `dsh-plugin-init/` 条目，一次提交会同时覆盖三个插件。
- `package.json#files` 列了 `LICENSE`，但工作树里没有该文件。
- 本目录原先的 `AGENTS.md` 已合并进本文件：DSH 把同目录的 `AGENTS.md` 与 `CLAUDE.md` 当同级候选，两份并存且内容不同时会被双双注入。打包模板里那条合并要求说的就是这件事。
