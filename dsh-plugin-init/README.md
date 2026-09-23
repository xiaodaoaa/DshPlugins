# dsh-plugin-init

一个 DeepSeek Harness 插件，提供 `/init` 斜杠命令：把 agent 指向当前仓库，让它创建或刷新 `AGENTS.md`。

移植自 [opencode](https://github.com/sst/opencode) 内置的 `/init` 命令。

```
/init
/init focus on the CI setup and the release process
```

## 它做什么

1. `/init` 会出现在 Web 输入框的斜杠命令列表里，因为命令注册表通过与 `/compact`、`/plan` 相同的发现接口发布它。
2. 处理器渲染打包好的提示词，并做两处替换：
   - `${path}` → 会话创建时记录的 cwd（`agent.session.header.cwd`，缺失时回退到宿主进程目录）
   - `$ARGUMENTS` → 用户在 `/init` 之后输入的全部内容
3. 渲染后的提示词通过 `agent.steer(...)` 投递：agent 空闲时它开启一轮，忙碌时它落在下一个步骤边界上。
4. 命令以一行面向人的简短结果结束；模型侧的工作就是一次普通的 agent 轮次——读仓库、写 `AGENTS.md`。

## 安装

```sh
dsh plugin --profile <profile> add D:\Workspace\OpenSouces\DshPlugins\dsh-plugin-init
```

`dsh plugin --profile <name> <args...>` 是 pnpm 的薄转发器：先初始化缺失的 profile，在 profile 目录里执行 `pnpm <args...>`，再依据已安装状态对账 `dsh.profile.bundles`（解析到声明了 `dsh.bundle` 的依赖自动加入层栈，已移除或不再声明 `dsh.bundle` 的自动退出），所以不必手工改 bundles 列表。相对路径可以放心用——`.`、`../plugin` 及其 `file:`/`link:` 形式会被锚定到你调用 `dsh` 时的目录，不会在 profile 里自链接。

等价的手工形式是在 profile 目录（`$DSH_HOME/profiles/<profile>`）里 `pnpm add <本目录的绝对路径>`，然后自己把 `"dsh-plugin-init"` 加进该 profile `package.json` 的 `dsh.profile.bundles`。重启 harness，`/init` 即可用。

### 仓库搬家后要重装

profile 记的是安装当时的路径（这台机器上是 `link:D:/Workspace/OpenSouces/dsh-plugin-init`）。仓库搬进 `DshPlugins/` 之后那个路径已经不存在，而 `profiles/<profile>/node_modules/dsh-plugin-init` 里留着一份**普通目录副本**——不是 junction，`fsutil reparsepoint query <该目录>` 会报 not a reparse point——运行中的 harness 加载的正是这份副本。所以改了 `lib/` 之后 `/init` 行为没变时，先用当前路径重装再重启；想确认装的是不是当前工作树，比对两处 `lib/index.js` 的哈希即可。

### 不要同时从 profile 自己的补丁层插入它

`dsh.profile.bundles` 在启动时合成，而 bundle 自带的 `cordis.patch.yml` 会插入 `id: init`。再把同一个 insert 加进 profile 的 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，会让加载器合成出一个含该 id 两次的列表，并以如下错误让整个 profile 启动失败：

```
duplicate loader entry id "init" in the composed profile
```

`patchReload: "live"` 只监听那个用户补丁文件、不监听 bundle 列表，所以把条目加在那里以省掉重启很诱人。不要这么做：两层是叠加关系，不是覆盖关系。请重启。

`test/bundle.test.js` 守卫这一点——它读取 bundle 补丁和每个已安装 profile 的用户补丁层，当同一个条目 id 同时出现在两处时失败。

## 配置

可选。省略即使用打包好的提示词。

```yaml
init:
  template: D:\path\to\my-initialize.txt
```

| 字段 | 含义 |
|---|---|
| `template` | 替换打包版 `lib/template/initialize.txt` 的提示词文件路径。相对路径按宿主进程的工作目录（`process.cwd()`）解析——既不是会话的 cwd，也不是 profile 目录，所以写绝对路径最稳。它必须非空；如果模板从未提到 `$ARGUMENTS`，用户输入会被追加到末尾。 |

## 与 opencode `/init` 的对应关系

| opencode | 这里 |
|---|---|
| `packages/opencode/src/command/index.ts` 里的 `commands[Default.INIT]` | `ctx.commands.register({ name: "init", … })` |
| `get template() { PROMPT_INITIALIZE.replace("${path}", ctx.worktree) }` | 调用时的 `renderPrompt(template, worktree, args)` |
| `SessionPrompt.command` 里的 `$ARGUMENTS` 替换 | `renderPrompt` 的 `replaceAll`，外加「未提及时追加」 |
| `POST /session/:id/init` 与 TUI 的 `session.command` | 唯一的 `commands.register` 处理器；所有适配器共用它 |
| `SessionPrompt.command` → `prompt(...)`（模型轮次） | `agent.steer(createUserMessage(...))` |
| `Command.Event.Executed` → `Project.setInitialized` | 没有项目时间戳；注册表已经把持久化的 `command/run` / `command/done` 事件追加进会话日志 |
| `subtask: false`（在当前会话中运行） | 相同：提示词被 steer 进当前 agent |

## 设计说明

- **没有客户端代码。** 命令平面在宿主侧；发现、输入提示与结果渲染都来自已合成的适配器。
- **用 `steer`，不用 `followup`。** `@deepseek-ai/dsh-agent-loop` 的 `ReactLoop` 里三者是 `steer → send(msg, "next-step", true)`、`followup → send(msg, "next-turn", true)`、`inject → next-step` 且不唤醒。差别在消息于**下一步**还是**下一轮**被认领：忙碌的会话里 `steer` 落在当前轮的下一个步骤边界上，`followup` 要等这一轮结束；两者都会唤醒空闲 agent。命令处理器需要立刻产生模型工作，所以用 `steer`。
- **模板在插件加载时读一次。** 缺失或空模板会让激活大声失败，而不是让第一次调用失败。
- **没有「已初始化」状态。** opencode 在观察到 `init` 的 `command.executed` 事件时写入 `project.time.initialized`。DSH 没有等价的项目记录，而重跑 `/init` 按设计是无害的：提示词要求 agent 就地改进已有的 `AGENTS.md`。

## 开发

```sh
npm test        # 三个套件、17 个用例，等价于下一行
node --test test/bundle.test.js test/index.test.js test/command.test.js
```

单文件用 `node --test test/command.test.js`，单个用例再加 `--test-name-pattern="steers one user message"`。不要裸跑 `node --test`：它还会收集 `test/*.manual.mjs`，而 `live-host.manual.mjs` 缺参数时以 2 退出，整轮因此变红。

这些套件覆盖 `renderPrompt`、模块的插件形态、通过 stub Cordis 上下文与替身 agent 驱动的真实处理器，以及 bundle 补丁（包括针对已安装 profile 的重复条目 id 守卫）。

还有两个手工脚本更进一步，它们有意不属于 `node --test`：`lifecycle.manual.mjs` 需要 harness 包可解析（本仓库 `node_modules/@deepseek-ai/` 里指向 `$DSH_HOME/profiles/node_modules/@deepseek-ai/` 的 junction 就是为此存在的），`live-host.manual.mjs` 需要一个运行中的宿主和它的 `?token=`，缺参数时会以 2 退出：

```sh
# 真实 Cordis 生命周期：通过 Context.plugin() 挂载插件，因此它证明了激活、
# ctx.effect 生命周期与销毁。裸说明符按导入文件的位置解析，所以 import("dsh-plugin-init")
# 走包自引用，始终加载这个 checkout——从哪个目录运行都一样。
node "D:\Workspace\OpenSouces\DshPlugins\dsh-plugin-init\test\lifecycle.manual.mjs"

# 真实运行中的宿主：通过浏览器所用的同一个 /api RPC，向运行中宿主自己的
# pluginInventory Remote 服务询问本 bundle 的 fiber 是否活跃。
# 传入宿主启动时打印的 ?token= 值。
node "D:\Workspace\OpenSouces\DshPlugins\dsh-plugin-init\test\live-host.manual.mjs" http://127.0.0.1:<port> <token>
```

第二个脚本回答的是「`/init` 到底有没有真的生效？」——它应当报告一个 `moduleName: "dsh-plugin-init"` 且 `fiberPhase: "active"` 的条目。
