# DshPlugins

DeepSeek Harness（DSH）插件集合。

| 插件 | 作用 |
|---|---|
| [dsh-plugin-init](./dsh-plugin-init) | 注册 `/init` 斜杠命令：把 agent 指向当前仓库，让它创建或刷新 `AGENTS.md`。移植自 opencode 的内置命令。 |
| [dsh-plugin-workspace-purge](./dsh-plugin-workspace-purge) | 删除工作区时，把它名下的已存储会话一并删除，而不是让它们留在「未分组」里。 |

每个插件目录下都有自己的两个文档：

- `README.md` —— 安装、配置与设计说明。
- `AGENTS.md` —— 维护该插件时必须遵守的契约与代码约定。

两个插件都是单包、零构建：`lib/` 就是发布的源码，测试用 Node 内置 runner（`npm test`）。
