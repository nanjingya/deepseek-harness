# @deepseek-ai/dsh-client-ui-workspace-files

[English](README.md) | 中文

Web 会话工作区文件：在 `conversation.session.header.utilities` 提供一个弹出层，通过 `host.listSessionDirectory` 列出会话项目树，通过 `host.openPath` 用系统默认应用打开文件，并注册名为 `file` 的 `@` 输入源，经 `host.searchSessionFiles` 搜索后在编辑器中插入相对路径纯文本。列表 RPC 不提供文件字节 HTTP 服务；宿主侧用 `ctx.fs.contains` 做路径 containment。

## 模型体验

无。`@` 选中插入纯文本；不新增模型工具或会话事件。

#### KV Cache 影响

无。

## 已知限制与后续工作

- **无应用内预览** — 打开文件仅走操作系统默认应用。
- **搜索有界** — 深度与文件数量有上限；超大目录可能截断 `@` 候选。
