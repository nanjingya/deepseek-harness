---
title: Web workspace file tree and PTY tab
date: 2026-08-17
---

# Web workspace file tree and PTY tab

The web GUI gains three human-only surfaces distilled from community Better Sidebar ideas without vendoring that plugin: a session project file tree, an `@` file reference source, and a line-oriented PTY utility tab. Each crosses the existing host RPC seam; none HTTP-serves workspace bytes, steals the details panel, or adds model tools.

## File tree and `@` references

`host.listSessionDirectory` and `host.searchSessionFiles` list names under a session's `header.cwd` through optional `ctx.fs`, with containment via `fs.contains` and skips for `node_modules`, `.git`, and `.dsh`. Clicking a file calls `host.openPath` with a host-computed absolute path. The `@` source named `file` (order 1) inserts `{ text: '<relativePath> ' }` as plain text, matching the plain-text-reference decision in the 2026-07-25 input-machine note. Rejected: in-app HTTP preview (2026-07-31 web-workspace-file-links note), overloading `workspace.*` or browse `host.listDirectory`, and vendoring Better Sidebar.

Packages: `@deepseek-ai/dsh-client-ui-workspace-files`; RPCs live in `@deepseek-ai/dsh-host-apiproxy`.

## Visual PTY tab

`host.listSessionTerminals`, `openSessionTerminal`, `readSessionTerminal`, `sendSessionTerminal`, and `closeSessionTerminal` proxy `ctx.terminals` for the session's **live** agent only (`agents.get`, never `agentFor`/resume). Spawn uses backend type `shell` (terminal-bash default) and session cwd. MVP UI: header utility popover, `<pre>` scrollback, line send with `submit: true`. Web bundle mounts `@deepseek-ai/dsh-terminal` and `@deepseek-ai/dsh-terminal-bash` on the host plane. Rejected: xterm/node-pty duplicate, `terminal_*` in the web tool catalog, and model-visible terminal tools for this slice.

Package: `@deepseek-ai/dsh-client-ui-terminal`.

## Placement

Both utilities register on `conversation.session.header.utilities` (files order 5, terminal order 10). Jobs and subagent catalog remain on `header.actions`.
