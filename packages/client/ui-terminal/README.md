# @deepseek-ai/dsh-client-ui-terminal

English | [中文](README.zh.md)

Web visual PTY tab: one `conversation.session.header.utilities` panel lists, opens, reads, sends, and closes agent-owned PTY sessions through `host.*SessionTerminal` RPCs over `ctx.terminals`. Opening the panel spawns a session-cwd shell when none exists. The live draft is typed on the `dsh> ` prompt line (scrollback read + line send with `submit: true`); no xterm canvas or second `node-pty` stack.

## Model Experience

None. Web preset does not add `terminal_*` tools; human UI only.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Live agent required** — cold sessions show an empty-state message; the host never resumes just for the tab.
- **Line-oriented only** — no resize, key sequences, or full-screen TUI fidelity.
