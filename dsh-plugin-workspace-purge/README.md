# dsh-plugin-workspace-purge

一个 DeepSeek Harness 插件：**删除工作区时，把它名下的会话一并删除**，而不是让它们全部留在「未分组」里。

```
删除工作区  →  工作区注册记录被移除
            →  它名下的会话日志从磁盘上被删除
            →  已连接的客户端立刻移除对应的行
```

## 为什么这件事需要一个插件

出厂 harness 里三个各自独立的设计，叠加起来就是「删除工作区绝不碰它的会话」：

- `@deepseek-ai/dsh-workspace` 明确规定移除工作区**绝不删除数据**——文件夹、文件、每个会话日志都保留，会话只是不再被任何工作区记账。
- 分组是推导出来的，不是存下来的：侧边栏通过「哪条工作区记录认领了这个会话」来分组，所有无人认领的会话落进兜底桶，渲染为**未分组**（`@deepseek-ai/dsh-client-ui-workspace` 的 `groupByWorkspace`）。
- `@deepseek-ai/dsh-session-persistence` **根本没有删除或保留接口**：「剪枝已存储会话属于带外后端维护。」

本插件就是那种带外维护，只绑定一个触发点：在工作区域上观察到的删除。

## 它做什么

1. 激活时从 `ctx.workspaceRegistry.list()` 镜像每个工作区的会话账本，并在 `workspaces` 表每次 `domain/changed` `put` 时刷新这份镜像。
2. 收到 `{ domain: "workspace", table: "workspaces", operation: "deleted" }` 时取出镜像的账本——事件本身只带工作区 id——并排队执行清理。
3. 对账本里的每个会话，从 `ctx.sessionPersistence.listArtifacts()` 解析出日志的确切路径，然后删除该会话目录。
4. 对每个确实被删除的会话发出 `api-session/removed`；`@deepseek-ai/dsh-api-remotes` 会把它转发给客户端，因此侧边栏那一行无需刷新页面就会消失。
5. 每次清理写一行汇总，逐一列出每种结果的数量：已删除、因活跃而保留、无已存储日志、已放过、已拒绝、失败。

它绝不碰工作区文件夹、工作区里的文件，也不碰被删工作区没有记账的任何会话。

## 安装

```sh
dsh plugin --profile web add D:\Workspace\OpenSouces\DshPlugins\dsh-plugin-workspace-purge
```

`dsh plugin` 会在 profile 目录里转发给 pnpm，然后依据已安装状态对账 `dsh.profile.bundles`，因此声明了 `dsh.bundle` 的包会自动加入层栈。等价的手工形式，在 profile 目录（`$DSH_HOME/profiles/<profile>`）里执行：

```sh
pnpm add file:D:/Workspace/OpenSouces/DshPlugins/dsh-plugin-workspace-purge
```

……然后把 `"dsh-plugin-workspace-purge"` 加进该 profile `package.json` 的 `dsh.profile.bundles`。重启 harness，此后删除工作区就会删除它的会话。

### 不要同时从 profile 自己的补丁层插入它

`dsh.profile.bundles` 在启动时合成，而 bundle 自带的 `cordis.patch.yml` 会插入 `id: workspace-purge`。再把同一个 insert 加进 profile 的 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，会让加载器合成出一个含该 id 两次的列表，并以如下错误让整个 profile 启动失败：

```
duplicate loader entry id "workspace-purge" in the composed profile
```

`patchReload: "live"` 只监听那个用户补丁文件、不监听 bundle 列表，所以把条目加在那里以省掉重启很诱人。不要这么做：两层是叠加关系，不是覆盖关系。请重启。

`test/bundle.test.js` 守卫这一点——它读取 bundle 补丁和每个已安装 profile 的用户补丁层，当同一个条目 id 同时出现在两处时失败。

## 配置

两个开关默认都开启，因此装好即用，无需配置。

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: workspace-purge
  config:
    enabled: true
    notifyClient: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 删除被删工作区的已存储会话。`false` 保留全部日志，并在日志里报告保留了多少个。 |
| `notifyClient` | `true` | 每个被清理的会话发一次 `api-session/removed`，让已连接的客户端立刻移除对应的行。`false` 删同样的文件，但让客户端在下次刷新列表时才察觉。 |

依赖 `ctx.workspaceRegistry`、`ctx.sessions`、`ctx.sessionPersistence`——插件在 `inject` 里声明了这三者，缺少任何一个都不会激活。

## 为什么这样写

- **观察领域，不包装 `delete`。** 订阅 `domain/changed` 覆盖所有删除路径（Web 客户端的 Delete 操作、其他插件、宿主脚本），并且完全不改动 `ctx.workspaceRegistry.delete`。`@deepseek-ai/dsh-api-workspace-controller` 里的 `WorkspaceFeed` 就是用同样的方式跟踪同一个领域。
- **必须镜像账本，因为事件给不出账本。** 删除事件的形状是 `{ domain, table, key, operation: "deleted" }`，没有 value，而且事件发出时注册表已经从缓存里移除了那条记录。所以会话账本只能在它还存在的时侯先抓下来。
- **路径向后端要。** `listArtifacts()` 返回 `{ header, path }`，胜过在这里自己推导 `root/<projectKey>/<encoded-id>/session.vN.jsonl`——那套布局是 JSONL 后端的私有约定，一旦移动就会静默失效。
- **绝不删除持有其他会话日志的目录。** 一个会话独占一个目录，所以被两个会话的日志同时指名的目录是它们上面的项目目录。`planPurge` 会拒绝这类目录，这正是防止未来后端布局变更把一次删除变成整个项目数据丢失的关键。
- **绝不删除活跃会话。** 持久化后端持有它的日志句柄，`ctx.sessions` 继续从内存提供它，下一次 append 还会把文件重建出来。`ctx.sessions` 没有公开的 close，所以这些会话只被报告，不被强删。
- **清理绝不阻塞工作区写入。** `domain/changed` 的监听器只是通知，发出方还会吞掉它们的异常；清理跑在自己的串行 promise 链上，通过 logger 汇报。

## 已知限制

- **这是不可恢复的。** 没有会话删除 API、没有回收站、没有撤销：日志用 `fs.rm` 删除。卸载插件能恢复旧行为，但恢复不了已删除的日志。
- **删除确认框仍在说谎。** 出厂 Web 客户端问的是「将把"{name}"从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在"未分组"下。」（英文 locale 为 "This removes "{name}" from the workspace list. The folder and session logs will be kept. Its sessions will appear under Ungrouped."）装上本插件后，第二句就是假的。修正它需要一个客户端半边（`dsh.client` 加 locale 覆盖），本版本有意不做；见 `CLAUDE.md`。
- **活跃会话会在工作区删除后存活。** 工作区被删时正处于打开或运行状态的会话会保留日志，并留在未分组。汇总行会说明保留了几个；关掉它们再删一次（第二次删除已无可清理，所以这些会话只能手工归档或删除）。
- **派生索引会滞后，但不会坏。** SQLite FTS 索引（`@deepseek-ai/dsh-session-query-sqlite`）会在下次搜索时对账已删除的来源，投影缓存以会话 id 为键。两者都不需要人工修复。
- **归档记账保持原样。** 被清理的会话 id 可能仍留在注册表的 `archivedSessionIds` 里。它是惰性的——归档要求会话存在——而从插件里写另一个包的领域状态比这点残留更糟。
- **只验证了 JSONL 后端。** 插件需要 `listArtifacts()`，而它不在 `SessionPersistence` 的服务定义里。不提供该方法的后端会让清理大声失败，而不是静默什么都不做。

## 开发

```sh
node --test test/bundle.test.js test/index.test.js test/purge.test.js
```

`test/index.test.js` 覆盖模块形态、配置 schema、路径护栏、纯函数清理规划器，以及一个通过真实 `apply`、以 stub Cordis 上下文驱动的端到端删除。`test/purge.test.js` 让观察者跑在真实的临时目录上，因此文件操作是真的。`test/bundle.test.js` 守卫 bundle 补丁，包括针对已安装 profile 的重复条目 id 检查。

还有一个手工脚本更进一步，它有意不属于 `npm test`，因为它需要 harness 包可解析：

```sh
# 真实 Cordis 生命周期：通过 Context.plugin() 挂载插件，inject 列表背后是真实的
# Service 实例，发出真实的 domain/changed，并证明 fiber.dispose() 之后观察者确实没了。
cd "$DSH_HOME/profiles/web"
node "D:\Workspace\OpenSouces\DshPlugins\dsh-plugin-workspace-purge\test\lifecycle.manual.mjs"
```

预期输出：

```
accounted session deleted: true
live session kept: true
other workspace's session kept: true
observer gone after dispose: true
```
