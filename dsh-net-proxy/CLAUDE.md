# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

单包 DSH（DeepSeek Harness）插件 **dsh-net-proxy**：把 agent 自己发起的网络请求导入配置好的 HTTP / CONNECT / SOCKS5 代理，带内存流量日志与设置页。`lib/` 就是发布的源码——没有构建、转译或打包步骤。git 仓库根在上一级 `DshPlugins/`（`.git` 在那里），跨插件的共同事实（`@deepseek-ai/*` 留在 `peerDependencies`、0.2.0-rc.2 的 peer 兼容性闸门、profile 激活链路、运行时模块解析拦截、改完必须重启）写在仓库根 `CLAUDE.md`；本文件只写这个插件自己的东西。

这个目录是从上游 [`mafeis/dsh-net-proxy`](https://github.com/mafeis/dsh-net-proxy) **vendored** 进来的副本（当前 `0.7.20`），不是本仓库原创。`plugins-entry.json` 是上游插件市场的登记项。

## 它是双面包，两半各自独立

| 半边 | 入口 | 干什么 |
|---|---|---|
| 宿主（Node） | `lib/index.js` | 读 `$DSH_HOME/net-proxy.json`；包装 `globalThis.fetch`；把生效策略同步安装进 harness 的代理层；起本地中继与流量日志；注册同源设置路由 |
| 浏览器 | `lib/client.js` | 设置页（代理设置 / 请求日志 / 流量图表），经同源路由读写同一份配置 |

两半通过 `/_dsh/net-proxy`（设置与探测）与 `/_dsh/net-proxy/log`（请求日志）通信，**没有别的通道**。让浏览器半边能被加载，三处约定缺一不可：

1. `package.json` 的 `dsh.client` 声明 `{ inject: [...模块名], platform: "web" }`（另有可选字段 `external` / `immediately`），且 `exports` 必须导出 `"./client"`——`dsh-client-modules` 扫描时对「声明了 `dsh.client` 却没有 `./client` 导出」的包直接抛错。
2. `lib/client.js` 是**手写 UMD**，不是构建产物：`window.__ModuleLoader__.load({ id: "dsh-net-proxy", factory: (require) => { ... } })`，模块体里用 `require("react")` / `require("react/jsx-runtime")` / `require("@deepseek-ai/dsh-client-ui-primitives")` 取依赖。改它就是在改发布产物，别指望有编译步骤。
3. `dsh.client.inject` 的三个模块名必须由前端**共享模块表**应答。当前表里是 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。**表里没有的名字需要别处有应答者，不能凭空 inject。**

浏览器半边能用的 ctx 服务与宿主半边不同：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", ... }))` 挂设置页，`ctx.locale.register(ns, { zh, en })` + `ctx.locale.bind(ns)` 做 i18n（`register` 那句包在 `ctx.effect` 里，标签见 `lib/client.js`）。宿主半边要开同源接口用 `webServer` 服务：`ctx.inject(["webServer"], (webCtx) => webCtx.effect(() => { const d = webCtx.webServer.register({ kind: "exact", path: "/_dsh/net-proxy", handler: ... }); return () => d(); }, "net-proxy: web settings route"))`。

## 宿主半边：两条代理通道 + 一条中继

`web_fetch` **不走** `globalThis.fetch`，所以只有一条通道是不够的：

- **fetch 包装层**：`globalThis.fetch = wrapper`，覆盖 agent 自己发的请求（`lib/proxy-fetch.js` 的手写 HTTP/SOCKS5 转发，零第三方依赖）。
- **harness 代理层**（`lib/harness-proxy.js`）：把策略装进 `@deepseek-ai/dsh-http-proxy`，覆盖 `web_fetch`。
- **本地中继**（`lib/relay.js`）：harness 层的策略 env 指向中继端口，真实代理由 `getProxy()` **每连接实时读取**。这样 `web_fetch` 流量也过插件之手（可记日志/统计），顺带解除 harness 层只接受 `http://` 代理 URL 的限制——`socks5` 配置经中继也能全覆盖。

`apply` 覆盖的配置等价于「用户配置 ⊕ 跟随模式下的系统代理状态」（`lib/system-proxy.js#applyFollowSystem`，纯函数）。包装器闭包**惰性**调用 `effectiveCfg()`，所以跟随系统的变化在下次请求时自动生效，不需要重装包装层。

配置热更监听的是**父目录**而不是文件本身：`writeConfig` 用 `tmp + rename` 原子替换，文件 inode 会换，`fs.watch(file)` 在 rename 后失效。另配三个 `.unref()` 的定时器（文件不存在时 1s 兜底 poll 且命中自清、跟随系统 3s、中继存活看护 5s），全部登记进 `watchers`。

## 契约（改之前先读这一节）

- **`apply` 返回 disposer，不用 `ctx.effect` 包全局逻辑。** 卸载路径是 `return () => {...}` 里那句：关 watchers → 还原 `globalThis.fetch` → `relay.stop()` → `harness.dispose()`。只有 `webServer` 路由那段用了 `ctx.inject` + `ctx.effect`，因为它要等 `webServer` 就绪。别照搬仓库另两个插件的 `ctx.effect(generator, label)` 形态来「统一」这里。
- **harness 层必须写进 harness 自己加载的那一个模块实例。** `dsh-http-proxy` 的 active/installed 是模块级状态，写进另一个实例等于没写。解析顺序三档：① `process.resourcesPath` 下 `app.asar/dsh/node_modules/…`（**0.2.0-rc.2 的布局带中间那层 `dsh/`**；`app.asar/node_modules/` 只放 Electron 主程序自己的依赖，里面没有这个包）→ ② 从 `process.argv[1]` 解析 → ③ bare specifier。三档全失败时优雅降级为 `unavailable`：只有 `web_fetch` 不跟随，fetch 包装层不受影响。
- **「先还原旧策略，再装新策略」的顺序不可反。** disposer 会把状态回滚到「自己安装前」的快照，反过来会把旧策略当成新基线。
- **中继端口终身制。** 总开关关闭（`sync(null)`）**不停中继**，只有插件卸载才真停。原因是第三方单例代理组件（如 dshmarket 的 `EnvHttpProxyAgent`）构造时读一次 env 并 keep-alive 池化连接，中继换端口后它们仍连旧死端口、0s 失败且永不自愈。`relayWatch` 每 5s 核对「曾装过中继而现在没在监听」并强制重同步，就是为了兜住这种情况。
- **SOCKS5 不走直装路径**（`dsh-http-proxy` 的 `isSupportedProxyUrl` 只认 `http:`/`https:`），一律经中继；中继启动失败会回退直装，此时 SOCKS5 变 `unsupported-socks` 且只保留 fetch 包装层。
- **还原 `globalThis.fetch` 只在它仍是自己装的那个包装器时进行。** 链上叠了后装包装器就沿链摘不掉自身——此时只报错留痕，**不要**强行拆别人的包装器。
- **设置路由的 Host / Origin 校验不可省。** Host 必须命中白名单（`localHostAllowlist()`：回环 + 主机名 + 所有网卡地址，为的是允许从局域网访问 GUI），否则 403 `forbidden host`；带 `Origin` 时其 `host:port` 必须与 Host 一致，否则 403 `cross-origin request`。这是防 DNS rebinding 与跨源写，无 Host 头视为非浏览器直连才放行。
- **探测只在目标与当前配置的代理同源（host + port + protocol）时才回填已保存凭据**；探测任意第三方主机一律不带凭据，避免把存储的代理密码发给攻击者控制的服务器。
- 幂等：harness 层用 `relay|直装 + 目标 URL + noProxy` 做键，未变不重装卸载；`logEnabled === false` 时给协议栈传 `begin` 恒返回 `null` 的包装，不再记新条目。

## 命令

```sh
npm install --legacy-peer-deps     # 首次准备依赖；必须带这个开关
npm test                           # = node --test，122 个用例
npm run lint                       # eslint flat config
node --test tests/routes.test.mjs
node --test --test-name-pattern="<子串>" tests/harness-proxy.test.mjs
```

- `tests/` 下只有 `.test.mjs` 和 `fixtures/`，所以**裸跑 `node --test` 是安全的**（本仓库另两个插件则不行，它们的 `test/` 里有会以非零退出的人工脚本）。
- `--legacy-peer-deps` 不能省：`eslint ^9.39.5` 与 `@eslint/js ^10.0.1` 互相冲突（后者要求 peer eslint ^10），`eslint.config.js` 的注释里就写了这一点。该开关**同时关掉 peer 自动安装**，所以 `node_modules/@deepseek-ai/` 下只有 devDependency 级的 `dsh-http-proxy`——这是正常的，运行时缺的那些由 DSH 的解析拦截从安装树补上（见根 `CLAUDE.md`）。

## 测试怎么搭的

122 个用例，只有两个文件依赖外部包：

- `tests/harness-proxy-integration.test.mjs` —— 打**真实** `@deepseek-ai/dsh-http-proxy`，验证「装策略 → 真实 `proxyRouteFor` 立刻可见 → dispose 回直连 → 环境变量还原」整条链路。这是判断 harness 层有没有真的写进同一实例的**唯一自动化手段**。整组按能力门控 skip（`URL.parse` 要 Node ≥ 22.6；undici 8 要 `markAsUncloneable`，Node ≥ 22.19），不满足时跳过而不是失败。
- `tests/jsonview-e2e.test.mjs` —— 用 `react` + `react-dom/server` 渲染设置页片段。

其余用例都用**真实 `node:http`/`node:net` 起本地回环服务**，不 mock socket。代理栈的 bug 基本都藏在真实 socket 行为里（背压、半关、CONNECT 协商、分块解码），**不要为了跑得快把它们换成 mock**。

## 改哪里

- `lib/index.js` 宿主半边入口；`lib/client.js` 手写 UMD 浏览器半边（`eslint.config.js` 对它单独按 `commonjs` + 浏览器全局处理）；`lib/proxy/` 手写代理栈（`parse` / `conn` / `http11` / `http2` / `body` / `request` / `no-proxy` / `errors`）；`lib/routes.js` 同源路由与它的安全校验；`lib/harness-proxy.js` 是 harness 层的**唯一**耦合点；`lib/traffic-log.js` 内存环形缓冲；`lib/relay.js` 本地中继；`lib/system-proxy.js` 读系统代理（Windows 注册表 / macOS `scutil` / Linux env）。
- `README.md` 承载安装方式、配置字段表与必须保持准确的已知限制；**改行为就同步改它**。
- **`Config` 的默认值与 `lib/config.js#defaults()` 必须逐字一致**（两处各写了一份）。改一处就改另一处。
- `package-lock.json` 里 `@deepseek-ai/dsh-http-proxy` 的版本要跟 `peerDependencies` / `devDependencies` 的范围对得上；本仓库已升到 `0.2.0-rc.2`，且保留上游用的 `registry.npmmirror.com` URL 风格。
- **不要为了让这个目录跟仓库另两个插件「风格统一」而重排代码。** 它是 vendored 副本，`lib/` 下本来就是中文注释；重排会让上游 diff 无法比对。

## 备注

- `engines.node` 是 `>= 22`。
- **本插件受兼容性闸门保护，靠的是那两个 `@deepseek-ai/dsh-*` peer**（`dsh-client-ui-primitives`、`dsh-http-proxy`）。后者虽在 `peerDependenciesMeta` 里标了 `optional`，闸门仍会校验它——`evaluatePluginCompatibility()` 不读该字段。版本不匹配时整个 bundle 会被跳过，所以**别删这两个 peer**。
- `.gitignore` 只有 `node_modules/`、`npm-debug.log*`、`*.log`。
