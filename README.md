# DshPlugins

DeepSeek Harness（DSH）插件集合，按 **DSH Desktop 0.2.0-rc.2** 适配。

| 插件 | 作用 |
|---|---|
| [dsh-plugin-init](./dsh-plugin-init) | 注册 `/init` 斜杠命令：把 agent 指向当前仓库，让它创建或刷新 `CLAUDE.md`。移植自 Claude Code 的内置命令。 |
| [dsh-plugin-workspace-purge](./dsh-plugin-workspace-purge) | 删除工作区时，把它名下的已存储会话一并删除，而不是让它们留在「未分组」里。 |
| [dsh-net-proxy](./dsh-net-proxy) | 把 agent 的网络请求（`web_search` / `web_fetch` / 外部 API）导入配置好的 HTTP / HTTPS-CONNECT / SOCKS5 代理，带内存流量日志与设置页。从 [mafeis/dsh-net-proxy](https://github.com/mafeis/dsh-net-proxy) vendored 而来。 |

每个插件目录下都有自己的文档：

- `README.md` —— 安装、配置与设计说明。
- `CLAUDE.md` —— 维护该插件时必须遵守的契约与代码约定（`dsh-net-proxy` 目前只有 `README.md`）。DSH 把 `AGENTS.md` 与 `CLAUDE.md` 当同级候选，同一目录只留一份：并存且内容不同会被双双注入。

三个插件都是单包、零构建：`lib/` 就是发布的源码。`dsh-plugin-*` 两个用 Node 内置 runner 逐文件列出测试（`npm test`）；`dsh-net-proxy` 的 `npm test` 就是裸 `node --test`，另有 `npm run lint`。

跨插件的共同事实（依赖放置、profile 激活链路、0.2.0-rc.2 的 peer 兼容性闸门、改完必须重启、本机实测状态）写在仓库根的 [`CLAUDE.md`](./CLAUDE.md)。
