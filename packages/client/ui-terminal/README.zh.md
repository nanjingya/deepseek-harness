# @deepseek-ai/dsh-client-ui-terminal

[English](README.md) | 中文

Web 可视 PTY 标签：在 `conversation.session.header.utilities` 提供面板，经 `host.*SessionTerminal` RPC 对 `ctx.terminals` 上 agent 拥有的 PTY 做列表、打开、读取、发送与关闭。打开面板时若还没有会话，会在会话工作目录拉起一个 shell。当前命令在 `dsh> ` 提示符行上输入（scrollback 读取 + 按行发送 `submit: true`）；无 xterm 画布或第二套 `node-pty`。

## 模型体验

无。Web 预设不增加 `terminal_*` 工具；仅供人类 UI。

#### KV Cache 影响

无。

## 已知限制与后续工作

- **需要 live agent** — 冷会话显示空态；宿主不会仅为标签页 resume。
- **仅面向行** — 无 resize、按键序列或完整 TUI 体验。
