# 本 Fork 改动说明

[English](FORK.md) | 中文

本仓库 [`nanjingya/deepseek-herness`](https://github.com/nanjingya/deepseek-herness) 基于官方 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 迭代，在 Web 端与文件能力上增加了以下功能。设计思路借鉴社区 Better Sidebar 的部分交互，**未** vendoring 该插件源码。

## 1. Web 工作区文件树

**包**：`@deepseek-ai/dsh-client-ui-workspace-files`

- 在会话页眉工具区（`conversation.session.header.utilities`，顺序 5）增加「文件」按钮，展示当前会话工作目录下的目录树。
- 点击文件通过 `host.openPath` 用系统默认应用打开；不在浏览器内 HTTP 提供文件内容。
- 新增 Host RPC：`host.listSessionDirectory`、`host.searchSessionFiles`，在会话 `header.cwd` 下经 `ctx.fs` 列名，并跳过 `node_modules`、`.git`、`.dsh` 等目录。

## 2. 输入框 `@` 文件引用

**包**：同上（`ui-workspace-files`）

- 在输入框 `@` 菜单中新增 `file` 来源（顺序 1），可按文件名搜索工作区文件。
- 选中后在光标处插入相对路径纯文本（例如 `src/foo.ts `），与现有 `@` 子 agent 来源并存。
- 未扩展 `workspace.*` 或浏览用的 `host.listDirectory`，避免语义混用。

## 3. 会话终端面板（PTY 可视化）

**包**：`@deepseek-ai/dsh-client-ui-terminal`

- 在会话页眉工具区（顺序 10）增加「终端」按钮，以弹层展示当前**活跃** agent 的 PTY 会话。
- 新增 Host RPC：`host.listSessionTerminals`、`host.openSessionTerminal`、`host.readSessionTerminal`、`host.sendSessionTerminal`、`host.closeSessionTerminal`。
- 仅代理 `ctx.terminals` 的 live agent（`agents.get`，不用 resume 代理）；行发送使用 `submit: true`；打开面板时若无终端则自动 spawn shell。
- UI 为行导向：`<pre>` 滚动区 + 内联 `dsh> ` 提示符输入，**未**引入 xterm 或第二套 `node-pty`，也未向模型暴露 `terminal_*` 工具。

Web 组合包（`packages/bundle/web-app`）额外挂载 `@deepseek-ai/dsh-terminal` 与 `@deepseek-ai/dsh-terminal-bash` 于宿主平面。

## 4. 只读 PDF 工具（`read_pdf`）

**包**：`@deepseek-ai/dsh-tool-pdf`

- 新增 `read_pdf` 工具，经 `ctx.subprocess` 调用打包的南鲸 PDF 转换器（`engine/pdf_wiki_parser.py`），产出 Markdown 与可编辑 Word（`document.docx`）。
- 对 `.pdf` 的 `read`/`read_image` 以及常见 shell 转换命令（pdftotext、pandoc、WPS 等）在 `tools/pre-execute` 路由到 `read_pdf`，避免模型绕过专用工具。
- 可选捆绑 `read-pdf` skill；base profile 与 standard/code/cordis agent preset 已接入。

## 5. 其他修复

- 局域网 HTTP 下 `crypto.randomUUID` 不可用时，RPC 与附件 ID 改用 `crypto.getRandomValues` 生成。
- `sendSessionTerminal` 等待 `terminals.startSend(...).done` 完成后再返回，避免发送后立即读屏仍只有提示符。

## 运行

与官方一致，从源码：

```sh
git clone git@github.com:nanjingya/deepseek-herness.git
cd deepseek-herness
pnpm install
pnpm run build
pnpm dsh web
```

局域网访问示例：

```sh
pnpm dsh web --host 0.0.0.0
```

修改 client 或 Host RPC 后，需在对应包内执行 `pnpm exec tsdown`（或 `pnpm run bundle`），重启 Web 服务并硬刷新浏览器。

## 详细设计记录

- [Web 工作区文件树与会话终端](.agents/notes/implemented/feature/2026-08-17-web-workspace-files-and-pty-tab.md)
- [read_pdf 工具](.agents/notes/implemented/feature/2026-08-17-read-pdf-tool.zh.md)

## 与官方仓库的关系

- **上游**：https://github.com/deepseek-ai/deepseek-harness
- **本 Fork**：https://github.com/nanjingya/deepseek-herness
- 本 Fork 命名中的 `herness` 为仓库名拼写，与官方 `harness` 不同；推送目标以本仓库为准。
