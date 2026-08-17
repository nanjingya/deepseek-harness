# @deepseek-ai/dsh-client-ui-workspace-files

English | [中文](README.zh.md)

Web session workspace files: one `conversation.session.header.utilities` popover lists the session project tree through `host.listSessionDirectory`, opens files with `host.openPath`, and registers an `@` input source named `file` that searches via `host.searchSessionFiles` and lands plain relative paths in the composer. Listing never HTTP-serves file bytes; containment is enforced host-side with `ctx.fs.contains`.

## Model Experience

None. The `@` pick inserts plain text; no new model tools or session events.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **No in-app preview** — opening a file uses the OS default application only.
- **Search is bounded** — depth and file-count caps apply; very large trees may truncate `@` candidates.
