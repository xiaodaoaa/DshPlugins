# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库定位

DeepSeek Harness（DSH）插件集合。两个插件各自是**独立单包**，没有根 `package.json`、没有 workspace、没有 lockfile、没有 CI。

| 目录 | 作用 |
|---|---|
| `dsh-plugin-init/` | 注册 `/init` 斜杠命令，steer agent 创建/刷新 `CLAUDE.md`（提示词逐字移植自 Claude Code） |
| `dsh-plugin-workspace-purge/` | 删除工作区时连带删除它名下的已存储会话，而非留在「未分组」 |

每个插件目录结构一致：`lib/index.js` 就是**发布的源码**（零构建、零转译、零打包），`cordis.patch.yml` 是 bundle 补丁，`test/` 放测试，`README.md` 写安装/配置/设计，维护契约写在插件自己的指令文件里（两个插件都是 `CLAUDE.md`——**同一目录只留一份**，`AGENTS.md` 与它并存会被双双注入）。

**动手改某个插件之前，先读它自己那份指令文件。** 那里写明了该插件依赖的宿主 API 形状、必须保留的护栏、以及哪些看似可以「简化」的写法其实是必需的。本文件只写跨插件的共同事实。

## 命令

每个插件在自己的目录里独立测试：

```sh
cd dsh-plugin-init && npm test              # 3 个套件、17 个用例
cd dsh-plugin-workspace-purge && npm test   # 3 个套件、25 个用例

# 单文件
node --test test/command.test.js

# 单个用例（--test-name-pattern 按正则匹配测试名，子串写法同样可用）
node --test --test-name-pattern="steers one user message" test/command.test.js
```

**不要裸跑 `node --test`。** 它会一并收集 `test/*.manual.mjs`，而那些脚本有意排除在 `npm test` 之外（`live-host.manual.mjs` 缺参数时以 2 退出，会让整轮变红）。`npm test` 的脚本里逐个列出了三个 `.test.js`，正是为此。

手工脚本，需要 harness 包可解析，因此要从 profile 目录运行：

```sh
cd "$DSH_HOME/profiles/web"
node "D:\Workspace\OpenSouces\DshPlugins\<插件>\test\lifecycle.manual.mjs"   # 真实 Cordis 生命周期
node "...\dsh-plugin-init\test\live-host.manual.mjs" http://127.0.0.1:<port> <token>  # 真实运行中的宿主
```

仓库里没有 lint、format、typecheck 配置，也没有 CI。`dsh` 在 agent shell 里可解析到宿主注入的 shim（`%APPDATA%\DSH Desktop\host-commands\web\generations\<hash>\bin\dsh.cmd`），别假设它不在 PATH 上。

## 插件如何被激活（改完必须重启）

一条链路，任何一环断了插件都不会生效：

1. `package.json` 的 `dsh.bundle.patch` 指向 `./cordis.patch.yml`
2. `cordis.patch.yml` 用 `insert:` 插入一个条目 id（`init` / `workspace-purge`），且 `lib/index.js` 导出的 `name` 必须与之一致
3. profile 的 `dsh.profile.bundles` 里列出该包名，`dsh plugin --profile <p> add <本目录>` 会依据已安装状态自动对账这个列表

**陷阱：绝不要把同一个 insert 条目再加进 profile 自己的 `$DSH_HOME/profiles/<p>/cordis.patch.yml`。** 两层是叠加而非覆盖关系，加载器会合成出含重复 id 的列表，并以 `duplicate loader entry id "<id>" in the composed profile` 让**整个 profile 启动失败**。`patchReload: "live"` 只监听用户补丁文件、不监听 bundle 列表，所以「加在那里省一次重启」很诱人——不要这么做。两个插件的 `test/bundle.test.js` 都守卫这一点（扫描的 profile 名单写死在测试里，`$DSH_HOME/profiles` 不存在时跳过）。

**没有任何东西会热重载插件代码。** `dsh-base` 的 `hmr` 行（`@deepseek-ai/cordis-plugin-hmr`）带 `disabled: true`。改 `lib/` 或 `cordis.patch.yml` 都只在 harness 重启后生效。

## 依赖与测试基础设施

- `@deepseek-ai/*` 一律留在 `peerDependencies`——harness 在进程内提供这些模块。**绝不要移到 `dependencies`。**
- 测试靠 `node_modules/@deepseek-ai/` 里的 **junction** 解析 `@deepseek-ai/*` → `$DSH_HOME/profiles/node_modules/@deepseek-ai/`。没有 lockfile 或安装步骤会重建它们；请保留在原地，不要清理。`node_modules/` 被各插件的 `.gitignore` 忽略。
- 本机 `$DSH_HOME` 解析为 `C:\Users\fengchao12\.dsh`（agent shell 里该变量已设置；未设置时代码回退到 `%USERPROFILE%\.dsh`，两者同值），只有 `web` 一个 profile。
- 测试统一用 `node:test` + `node:assert/strict`，通过**镜像 Cordis `effect()` 生成器契约的 stub 上下文**驱动真实的 `apply` 与处理器。扩展这些 stub，不要引入测试框架。

## 代码约定（两个插件一致）

- 纯 ESM JavaScript，Node >= 22：`node:` 前缀导入、双引号、2 空格缩进、带 `u` 标志的正则。
- 每个导出和非平凡函数都写 JSDoc，用 `@param - ` 风格。
- `apply` 里的注册与订阅一律包在 `ctx.effect(generator, "<插件名>: <做什么>")` 中；被 yield 的销毁器就是注销路径，`test/*.test.js` 断言该标签字符串与销毁器数量。改标签要同步改测试。
- 每次清理/关键路径写恰好一行汇总日志（含早退路径），测试断言这些句子。改代码就一起改测试。

## 本机安装状态（2026-09-24 实测）

`web` profile 的 `dsh.profile.bundles` 已列出两个插件，`dependencies` 是 `link:D:/Workspace/OpenSouces/DshPlugins/<插件>`，`node_modules/<包名>` 是**指向工作树的 junction**（`fsutil reparsepoint query` 报 `0xa0000003`）。所以运行中的 harness 加载的**就是**这份工作树，改 `lib/` 后重启即可生效。

（2026-09-24 复核：`profiles/web/node_modules/dsh-plugin-init` 确为指向本工作树的 junction，`profiles/web/node_modules` 下已找不到早先那份 `.ignored_dsh-plugin-init` 遗留副本。要确认加载的是哪一份，看 junction 目标或比对 `lib/index.js` 的哈希即可。）

## 指令文件的双候选（改 `/init` 或写文档时注意）

`@deepseek-ai/dsh-agent-instructions` 默认 `instructionFileCandidates` 是 `["AGENTS.md", "CLAUDE.md"]`（叠加层为 `AGENTS.local.md` / `CLAUDE.local.md`），`projectRootMarkers` 是 `[".git"]`。含义：

- 同一目录下 `AGENTS.md` 与 `CLAUDE.md` **内容不同时会被双双注入**，token 翻倍；内容相同时只渲染一次。
- 用户全局层只有 `$DSH_HOME/AGENTS.md` 一个文件名，没有全局 `CLAUDE.md`。
- 本仓库的维护契约：`dsh-plugin-init/CLAUDE.md`、`dsh-plugin-workspace-purge/CLAUDE.md`——两份原先都叫 `AGENTS.md`，已于 2026-09-24 合并改名。同一目录永远只留一份：再补另一种文件名时必须先合并，不要并列。

## 其他

- `.gitattributes` 强制 `* text=auto eol=lf`。本机 `core.autocrlf=true`，所以别提交 CRLF。
- 插件产生的中间文件放 `.tmp/`，不要提交（本仓库顶层尚无 `.gitignore`，`.tmp/` 目前只会靠 `.gitattributes` 之外的习惯约束——如需长期生效可考虑补一条忽略规则）。
- `dsh-plugin-workspace-purge` **会删真实数据**：`lib/index.js` 里的一个错误，代价是这台机器上真实的会话日志。改它的护栏时必须同时补一个在临时目录上证明新行为的测试。
- 出厂 Web 客户端的删除确认框仍承诺会话日志会保留，装了 purge 插件后那句话是假的。修正它需要客户端半边（`dsh.client` + locale 覆盖），**在有人提出需求之前不做**。
