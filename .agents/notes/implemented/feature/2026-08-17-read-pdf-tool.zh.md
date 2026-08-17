# Agent Note: 基于打包南鲸转换器的面向模型 read_pdf 工具

Status: implemented

[English](2026-08-17-read-pdf-tool.md) | 中文

## 问题

`read` 仅接受 UTF-8 文本，`read_image` 仅处理光栅图，`web_fetch` 也没有 PDF 分支——被要求摘要或引用 PDF 的 agent 要么失败，要么临时拼 shell OCR。独立的南鲸 PDF 识别工具已能做面向版面的 OCR 并产出 Markdown，但它落在 harness 插件图之外，没有工具 schema、系统提示指导、会话 cwd 路径规则，也没有可选的 skill 注册。

## 决定

在 `tool-fs-search` 旁交付 `@deepseek-ai/dsh-tool-pdf`，作为经 subprocess 支持的消费方：

- **`read_pdf` 在存在 `tools`、`systemPrompt`、`subprocess` 时无条件注册。** 调用经 `ctx.subprocess` 以固定 argv 向量 spawn 打包的 `engine/pdf_wiki_parser.py`（无 shell）。默认缓存目录为 `<cwd>/.dsh/pdf/<hash>/`，按路径 + mtime + size 键控。转换器写入 `document.md` 与可编辑的 `document.docx`（南鲸 `docx_exporter.py` 消费 `semantic_blocks`）；宿主 Python 须提供 python-docx。
- **引擎留在包内**（`engine/`、`assets/`）；宿主 Python、Poppler、python-docx 与 OCR 后端仍是部署要求。配置可覆盖 `python` 与 `engineRoot`。
- **捆绑的 `read-pdf` skill 可选**：通过 `ctx.get('skills')` 注册，资源布局对齐 `skill-badge`，因此没有 skill seam 的部署仍能使用工具。
- **base profile 挂载 `tool-pdf`**，紧邻 `tool-fs-search`。Web 组合包会禁用该宿主平面副本，改由 standard／code／cordis agent preset 拥有该工具，与 `tool-fs`／`tool-fs-search` 一致。headless 保留宿主平面注册。工具目录经 `LocalSubprocessRuntime` 收割 schema。
- **PDF 工作在 `tools/pre-execute` 被路由到 `read_pdf`**：对 `.pdf` 路径的 `read`/`read_image`，以及 `bash`/`pwsh` 转换（含带空格的 Mac 应用路径的 WPS、`open -a`、对 PDF/Office 文件使用 `open`、osascript tell WPS/Word/Preview、pandoc/pdftotext/soffice）。检视类命令（`which`/`ls`/`file`）仍会执行。提示词、schema 与 skill 文本要求一旦知道 PDF 路径就调用 `read_pdf`，并交出 `document.docx` 而不是再写第二套转换器。Word 是 A4 中文标准样式的可编辑 OCR，不是扫描件的逐页摹本：标准封面在第 1 页有足够汉字时用 OCR 正文，目次保留原文编号、缩进与点线页码，PDF 原始页码标记只留在 Markdown。全局 `tool:bash` 提示词保持不变，以免 ACP `text-turn` 快照抖动。
- **无图题整页图**仅在可印刷区域墨水占满大部分页面时保留（架构图）。空白页、装订阴影噪声与居中标志/印记页省略；带图题插图仍走 `ink_bbox_for_figure`。

## 考虑过的替代方案

- **扩展 `read` / `ctx.fs` 以支持 PDF** — 拒绝：PDF 转换是由进程支持的 OCR 工作流，不是文件系统原语；放在 `ctx.fs` 会迫使每个后端都长出 OCR。
- **仅用 shell 一次性命令或仅用 Skill** — 拒绝：Skill 不能替代带类型的工具 schema，也无法保证模型可见指导；shell OCR 绕过预算、路径校验与错误码。
- **默认用逐页影像做“保真” Word** — 拒绝：会把每一 PDF 页都嵌成图片，重现多余整页图。视觉版式请保留 PDF；可编辑 Word 消费 `semantic_blocks`。
- **只产 Markdown、不写 Word 产物** — 拒绝：转 Word 请求随后会写出一次性 Markdown→Word 脚本，按每个 PDF 页码标记分页并粘贴整页扫描图。打包导出器才是 Word 路径。
- **默认走远程 OCR API** — 延后：本地引擎匹配用户既有离线工具；日后可用提供方 seam 包装其他后端而不改工具名。

## 后果

- 挂载该插件的组合里，组装后的提示词和工具目录会增加一个 schema 与一段指导。ACP 示例不挂载它，因此 `text-turn` 保持不变。产品 CLI／headless 保留宿主平面注册；Web 由 standard／code／cordis preset 重新挂载。模型若仍对 PDF 使用 `read`、WPS 或 pandoc，会得到指向 `read_pdf` 的拒绝结果。
- keyless OCR 端到端快照延后，直到有与宿主无关的夹具策略；包测试用假 subprocess 钉住 argv、缓存路径、截断、`docxPath` 与 `PdfError` 代码。`engine/test_full_page_artwork.py` 与 `engine/test_cover_and_toc.py` 钉住转换器启发，不进入 Vitest 覆盖率门禁。
- 转换器质量（目次配对、封面重建、插图裁剪、整页图判定）仍由 `engine/` 拥有；Cordis 适配层只拥有注册、预算与路径呈现。缺少 python-docx 时在转换器启动时失败。
