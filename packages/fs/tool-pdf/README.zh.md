# @deepseek-ai/dsh-tool-pdf

[English](README.md) | 中文

面向模型的 **`read_pdf`**：通过打包的南鲸 OCR/版面引擎，将 PDF（原生文本或扫描件）转为面向 LLM 的 Markdown 与可编辑 Word。经 `ctx.subprocess` spawn Python（绝不走 `ctx.shell`）；在挂载 `ctx.skills` 时可选注册捆绑的 **`read-pdf`** skill。

```ts ignore-check
await ctx.plugin(LocalSubprocessRuntime) // @deepseek-ai/dsh-subprocess-local
await ctx.plugin(ToolPdf)                // @deepseek-ai/dsh-tool-pdf
// Optional: skill discovery / load_skill
await ctx.plugin(SkillRegistry)          // @deepseek-ai/dsh-skill
```

base profile 将该插件挂在 `tool-fs-search` 旁。Web 组合包会禁用该宿主平面副本，改由 standard／code／cordis agent preset 拥有该工具。宿主仍需 Python 3（Pillow、numpy、python-docx）、Poppler（`pdftoppm`/`pdfinfo`）以及 OCR 后端（macOS 优先 Vision；其他平台优先 PaddleOCR 或 Tesseract）。注册无条件；缺少宿主工具时在调用时失败。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `python` | `$PDF_WIKI_PYTHON` / `$DSH_PDF_PYTHON` / `python3` | 转换器的解释器 argv[0]。 |
| `engineRoot` | 打包的 `engine/` | 含 `pdf_wiki_parser.py` 与 `docx_exporter.py` 的目录。 |
| `dpi` | `200` | 调用省略 `dpi` 时的默认页渲染 DPI。 |
| `workers` | `4` | 调用省略 `workers` 时的默认 OCR 工作进程数。 |
| `defaultEngine` | `auto` | 默认 OCR 引擎（`auto` / `vision` / `paddleocr` / `tesseract`）。 |
| `maxOutputChars` | `120000` | 内联返回的最大 Markdown 字符数；完整文本仍在 `markdownPath`。 |
| `timeoutMs` | `600000` | 协作式工具调用预算（长扫描 PDF）。 |
| `graceMs` | `5000` | 协作预算之后的终止升级宽限。 |
| `stderrMaxBytes` | `65536` | 失败信息中保留的转换器 stderr。 |

## 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `read_pdf` | `file_path`、`output_dir?`、`dpi?`、`engine?`、`workers?` | spawn 打包转换器；返回可能被截断的内联 Markdown，以及 `.dsh/pdf/<hash>/`（或 `output_dir`）下持久的 `document.md` 与 `document.docx`。后续切片优先对 `markdownPath` 使用普通 `read`。 |

挂载期间，`tools/pre-execute` 会拒绝对 `.pdf` 路径的 `read`/`read_image`，以及 `bash`/`pwsh` 转换（WPS、pandoc、pdftotext、办公 GUI）。检视类命令（`which`、`ls`、`file`）仍会执行。用户要 Word 时交出 `document.docx`；不要再写第二套转换器。

## 错误

失败携带包自有的 `PdfError` 代码：`PDF_NOT_FOUND`、`PDF_INVALID_PATH`、`PDF_ENGINE_FAILED`、`PDF_ABORTED`、`PDF_OUTPUT_MISSING`。

## 模型体验

### 系统提示

#### 模型看到什么

该插件注册作用域内的每次请求都包含下面独立注册的 `read_pdf` 指导。Agent 作用域的工具限制可以隐藏 schema，但不会移除对应的提示词段落。

##### read_pdf 指导

```markdown
When a PDF path is known, call read_pdf immediately — not read, bash, WPS, Word, Preview, open, pandoc, or pdftotext. It returns Markdown plus document.md and an editable document.docx under .dsh/pdf/. Word is OCR text in A4 Chinese-standard styles, not a page-faithful copy of the scan; do not write a second converter. Pass the exact path from glob or ls without truncating long names. Prefer read on that Markdown for follow-up slices; do not claim PDF contents without calling read_pdf first.
```

#### Token 影响

插件已注册期间，每请求固定指导成本。

#### KV Cache 影响

插件作用域与指导文本不变时前缀稳定。

### 工具 schema

#### 模型看到什么

生成的 [`read_pdf` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-pdf) 描述本地 OCR/版面转换与宿主要求。

#### Token 影响

工具可见时每请求固定 schema 成本。

#### KV Cache 影响

工具可见性与定义不变时前缀稳定。

### 结果

#### 模型看到什么

含 `<path>`、`<docx>`、`<source>`、`<engine>`、可选 `<pages>` / `<truncated>` 与 `<output_dir>` 的页眉，随后是 Markdown 正文。

#### Token 影响

受 `maxOutputChars` 约束；完整 Markdown 留在磁盘供后续 `read`。

#### KV Cache 影响

新可见的工具结果为追加式。

### 工具错误

#### 模型看到什么

规范化的 `Error: <message>`，并对调用方附带结构化 `PdfError` 代码。

#### Token 影响

仅失败调用增加这些保留 token。

#### KV Cache 影响

追加式。

## 已知限制与延后工作

- **需要宿主 OCR、Poppler 与 python-docx** — 打包引擎不是自包含二进制；宿主须安装 macOS Vision / PaddleOCR / Tesseract、Poppler 以及 python-docx。
- **转换可能长达数分钟** — 长扫描标准默认 `timeoutMs` 为 10 分钟；不暴露后台任务。
- **Word 是可编辑 OCR，不是原件摹本** — A4 中文标准样式、原生文本与带图题的插图裁剪；分页与字号不匹配扫描件。标准封面在第 1 页有足够汉字时用 OCR 正文，否则保留该页光栅。目次保留原文编号、缩进与点线页码。PDF 原始页码标记只留在 Markdown。视觉版式请保留 PDF。空白页与标志印记不输出为整页图。
- **尚无 keyless OCR 快照** — 包测试用假 subprocess 覆盖 argv、缓存与错误码；组装后的 OCR 笔录等待与宿主无关的夹具策略。
- **引擎质量启发仍属上游** — 目次配对、封面重建、插图裁剪与无图题整页图判定继承自 vendored 南鲸转换器；应在 `engine/` 修复，而不是在 Cordis 适配层。
