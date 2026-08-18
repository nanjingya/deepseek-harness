# Fork changelog

English | [中文](FORK.zh.md)

This repository [`nanjingya/deepseek-harness`](https://github.com/nanjingya/deepseek-harness) extends the official [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) with Web UI and filesystem capabilities below. Interaction ideas are distilled from community Better Sidebar feedback; **Better Sidebar is not vendored**.

## 1. Web workspace file tree

**Package**: `@deepseek-ai/dsh-client-ui-workspace-files`

- Header utility (order 5) listing the session workdir tree.
- File click opens via `host.openPath` (OS default app); no in-browser HTTP file serving.
- Host RPCs: `host.listSessionDirectory`, `host.searchSessionFiles`.

## 2. `@` file references in the composer

**Package**: same as above

- `@` source `file` (order 1) searches workspace files and inserts a relative path as plain text.
- Does not overload `workspace.*` or browse `host.listDirectory`.

## 3. Session terminal panel (visual PTY)

**Package**: `@deepseek-ai/dsh-client-ui-terminal`

- Header utility (order 10) showing the live agent's PTY in a popover.
- Host RPCs: `host.listSessionTerminals`, `openSessionTerminal`, `readSessionTerminal`, `sendSessionTerminal`, `closeSessionTerminal`.
- Line-oriented UI with inline `dsh> ` prompt; no xterm or model-facing `terminal_*` tools.

The web bundle also mounts `@deepseek-ai/dsh-terminal` and `@deepseek-ai/dsh-terminal-bash` on the host plane.

## 4. Read-only PDF tool (`read_pdf`)

**Package**: `@deepseek-ai/dsh-tool-pdf`

- Spawns the packaged Nanjing PDF converter via `ctx.subprocess`; returns Markdown and editable Word.
- Routes PDF bypass attempts from `read`/`read_image` and common shell converters to `read_pdf`.

## 5. Other fixes

- RPC and attachment IDs use `crypto.getRandomValues` when `crypto.randomUUID` is unavailable over insecure HTTP LAN.
- `sendSessionTerminal` awaits `terminals.startSend(...).done` before returning.

## Run from this fork

```sh
git clone git@github.com:nanjingya/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

After client or Host RPC changes, rebuild the affected package with `pnpm exec tsdown`, restart the Web server, and hard-refresh the browser.

## Design notes

- [Web workspace file tree and PTY tab](.agents/notes/implemented/feature/2026-08-17-web-workspace-files-and-pty-tab.md)
- [read_pdf tool](.agents/notes/implemented/feature/2026-08-17-read-pdf-tool.md)

## Upstream

- **Upstream**: https://github.com/deepseek-ai/deepseek-harness
- **This fork**: https://github.com/nanjingya/deepseek-harness
