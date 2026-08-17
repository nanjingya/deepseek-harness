#!/usr/bin/env python3
"""南鲸 PDF local scanned-PDF pipeline for LLM knowledge bases.

The first backend uses Poppler + Tesseract.  Results are stored in a neutral
JSON representation so a stronger OCR/layout backend can be added later.

Project author: nanjingya.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict, replace
from datetime import datetime
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image, ImageOps


FIGURE_CAPTION_RE = re.compile(r"^图\s*[A-ZＡ-Ｚ]?\.?\s*\d+(?:\.\d+)?\s*")
TABLE_CAPTION_RE = re.compile(r"^表\s*[A-ZＡ-Ｚ]?\.?\s*\d+(?:\.\d+)?\s+\S")
FIGURE_REFERENCE_RE = re.compile(r"(?:见|如)\s*图\s*[A-ZＡ-Ｚ]?\.?\s*\d+(?:\.\d+)?(?:\s*所示)?[。.]?$")
LIST_RE = re.compile(r"^(?:[a-zA-Z][)）]|[（(][a-zA-Z0-9]+[)）]|\d+[)）]|[—–-]{1,2})\s*")
STANDARD_HEADER_RE = re.compile(r"^(?:GM|GB)\s*/\s*[TZ]\s*\d+(?:\.\d+)?\s*[—–-]\s*\d{4}$", re.I)
STANDARD_RUNNING_HEADER_RE = re.compile(
    r"^(?:GM|GB)\s*/?\s*[TZ]\s*\d+(?:\.\d+)?\s*(?:[—–-]\s*)?\d{4}$", re.I
)
MARKDOWN_SCHEMA_VERSION = "1.4"
MARKDOWN_PROFILE = "llm-wiki-gfm"
GENERATOR_NAME = "南鲸 PDF"
GENERATOR_AUTHOR = "nanjingya"
PROJECT_ROOT = Path(__file__).resolve().parent
TOOL_ENV = {
    "pdfinfo": "PDF_WIKI_PDFINFO",
    "pdftoppm": "PDF_WIKI_PDFTOPPM",
    "pdftotext": "PDF_WIKI_PDFTOTEXT",
    "tesseract": "PDF_WIKI_TESSERACT",
}


@dataclass
class Line:
    text: str
    bbox: list[int]
    confidence: float
    page: int
    kind: str = "text"


@dataclass
class Figure:
    page: int
    bbox: list[int]
    caption: str
    asset: str
    figure_ocr: list[str]


@dataclass
class Table:
    page: int
    bbox: list[int]
    caption: str
    asset: str
    table_ocr: list[str]


@dataclass
class SemanticBlock:
    """Backend-neutral page content consumed by both Markdown and DOCX."""

    kind: str
    page: int
    bbox: list[int]
    text: str = ""
    level: int | None = None
    marker: str | None = None
    asset: str | None = None
    caption: str | None = None
    search_text: str | None = None


def windows_tool_candidates(name: str) -> list[Path]:
    """Return common WinGet, Scoop, local and conventional install paths."""
    executable = f"{name}.exe"
    candidates = [
        PROJECT_ROOT / "tools" / "poppler" / "Library" / "bin" / executable,
        PROJECT_ROOT / "tools" / "poppler" / "bin" / executable,
    ]
    local_app_data = os.environ.get("LOCALAPPDATA")
    program_files = [os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")]
    user_profile = os.environ.get("USERPROFILE")

    if name == "tesseract":
        for base in [*program_files, local_app_data]:
            if base:
                candidates.append(Path(base) / "Tesseract-OCR" / executable)
                candidates.append(Path(base) / "Programs" / "Tesseract-OCR" / executable)
    else:
        for base in [*program_files, local_app_data]:
            if base:
                candidates.extend([
                    Path(base) / "poppler" / "Library" / "bin" / executable,
                    Path(base) / "Programs" / "poppler" / "Library" / "bin" / executable,
                ])
        if user_profile:
            candidates.append(
                Path(user_profile) / "scoop" / "apps" / "poppler" / "current" / "Library" / "bin" / executable
            )
        if local_app_data:
            winget = Path(local_app_data) / "Microsoft" / "WinGet" / "Packages"
            if winget.is_dir():
                candidates.extend(winget.glob(
                    f"oschwartz10612.Poppler_*/**/Library/bin/{executable}"
                ))
    return candidates


def resolve_tool(name: str) -> Path | None:
    """Resolve an external executable across macOS, Linux and Windows."""
    env_name = TOOL_ENV.get(name)
    if env_name and os.environ.get(env_name):
        configured = Path(os.path.expandvars(os.environ[env_name])).expanduser()
        if configured.is_file():
            return configured.resolve()
    discovered = shutil.which(name)
    if discovered:
        return Path(discovered).resolve()
    if sys.platform == "win32":
        return next((path.resolve() for path in windows_tool_candidates(name) if path.is_file()), None)
    return None


def resolve_tessdata_dir() -> Path | None:
    configured = os.environ.get("PDF_WIKI_TESSDATA")
    if configured:
        path = Path(os.path.expandvars(configured)).expanduser()
        if path.is_dir():
            return path.resolve()
    bundled = PROJECT_ROOT / "tools" / "tessdata"
    return bundled.resolve() if bundled.is_dir() else None


def paddleocr_available() -> bool:
    return importlib.util.find_spec("paddle") is not None and importlib.util.find_spec("paddleocr") is not None


def select_auto_engine() -> str:
    vision_source = PROJECT_ROOT / "tools" / "vision_ocr.swift"
    if sys.platform == "darwin" and shutil.which("swiftc") and vision_source.exists():
        return "vision"
    if paddleocr_available():
        return "paddleocr"
    return "tesseract"


def command_with_resolved_tool(cmd: list[str]) -> list[str]:
    resolved = resolve_tool(cmd[0]) if cmd and cmd[0] in TOOL_ENV else None
    return [str(resolved) if resolved else cmd[0], *cmd[1:]]


def run(cmd: list[str], *, capture: bool = False) -> str:
    result = subprocess.run(
        command_with_resolved_tool(cmd), check=True, text=True, capture_output=capture,
        encoding="utf-8", errors="replace",
    )
    return result.stdout if capture else ""


def tesseract_languages() -> set[str]:
    executable = resolve_tool("tesseract")
    if not executable:
        return set()
    cmd = [str(executable), "--list-langs"]
    tessdata = resolve_tessdata_dir()
    if tessdata:
        cmd.extend(["--tessdata-dir", str(tessdata)])
    result = subprocess.run(cmd, text=True, capture_output=True, encoding="utf-8", errors="replace")
    if result.returncode:
        return set()
    return {line.strip() for line in result.stdout.splitlines() if re.fullmatch(r"[A-Za-z0-9_]+", line.strip())}


def require_tools(engine: str, lang: str = "chi_sim+eng") -> None:
    required = ["pdfinfo", "pdftoppm", "pdftotext"]
    if engine == "tesseract":
        required.append("tesseract")
    missing = [name for name in required if not resolve_tool(name)]
    if missing:
        hint = (
            "请双击“安装Windows依赖.bat”，或通过 PDF_WIKI_* 环境变量指定程序路径。"
            if sys.platform == "win32"
            else "请安装 Poppler/Tesseract，并确认命令已加入 PATH。"
        )
        raise SystemExit("缺少必需工具：" + ", ".join(missing) + "。" + hint)
    if engine == "paddleocr" and not paddleocr_available():
        raise SystemExit(
            "PaddleOCR 尚未安装。Windows 请重新运行“安装Windows依赖.bat”，"
            "或改用 --engine tesseract。"
        )
    if engine == "tesseract":
        requested = {item for item in lang.split("+") if item}
        missing_languages = sorted(requested - tesseract_languages())
        if missing_languages:
            hint = (
                "Windows 请重新运行“安装Windows依赖.bat”。"
                if sys.platform == "win32"
                else "请安装对应的 Tesseract traineddata，或设置 PDF_WIKI_TESSDATA。"
            )
            raise SystemExit(
                "Tesseract 缺少语言数据：" + ", ".join(missing_languages)
                + "。" + hint
            )


def require_python_docx() -> None:
    """Fail at converter start when python-docx is not installed."""
    if importlib.util.find_spec("docx") is None:
        raise SystemExit(
            "python-docx is required to write document.docx. "
            "Install the packages listed in engine/requirements.txt."
        )


def pdf_info(pdf: Path) -> dict:
    raw = run(["pdfinfo", str(pdf)], capture=True)
    info: dict[str, str] = {}
    for line in raw.splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            info[key.strip()] = value.strip()
    text = run(["pdftotext", "-f", "1", "-l", "3", str(pdf), "-"], capture=True).strip()
    pages = int(info.get("Pages", "0"))
    return {
        "pages": pages,
        "encrypted": info.get("Encrypted", "unknown"),
        "page_size": info.get("Page size", "unknown"),
        "page_rotation": info.get("Page rot", "unknown"),
        "has_text_layer": bool(text),
        "document_type": "native_or_mixed" if text else "scanned",
    }


def render_pages(pdf: Path, pages_dir: Path, dpi: int) -> list[Path]:
    pages_dir.mkdir(parents=True, exist_ok=True)
    prefix = pages_dir / "page"
    run(["pdftoppm", "-r", str(dpi), "-jpeg", "-jpegopt", "quality=92", str(pdf), str(prefix)])
    pages = sorted(pages_dir.glob("page-*.jpg"), key=lambda p: int(p.stem.split("-")[-1]))
    if not pages:
        raise RuntimeError("PDF rendered no pages")
    return pages


def parse_tsv(tsv_path: Path, page_number: int) -> list[Line]:
    grouped: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
    with tsv_path.open(encoding="utf-8", errors="replace") as fh:
        # Tesseract writes literal quote characters in the text field; they are
        # OCR content, not CSV quoting delimiters.
        for row in csv.DictReader(fh, delimiter="\t", quoting=csv.QUOTE_NONE):
            text = (row.get("text") or "").strip()
            try:
                conf = float(row.get("conf", -1))
            except ValueError:
                conf = -1
            if text and conf >= 0:
                grouped[(row["block_num"], row["par_num"], row["line_num"])].append(row)

    lines: list[Line] = []
    for words in grouped.values():
        words.sort(key=lambda w: int(w["left"]))
        text = ""
        for word in (w["text"].strip() for w in words):
            if text and text[-1].isascii() and word[0].isascii() and text[-1].isalnum() and word[0].isalnum():
                text += " "
            text += word
        left = min(int(w["left"]) for w in words)
        top = min(int(w["top"]) for w in words)
        right = max(int(w["left"]) + int(w["width"]) for w in words)
        bottom = max(int(w["top"]) + int(w["height"]) for w in words)
        confs = [float(w["conf"]) for w in words]
        lines.append(Line(normalize_text(text), [left, top, right, bottom], sum(confs) / len(confs), page_number))
    return sorted(lines, key=lambda x: (x.bbox[1], x.bbox[0]))


def parse_vision_json(path: Path, page_number: int) -> list[Line]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    lines = [
        Line(normalize_text(item["text"]), item["bbox"], float(item["confidence"]) * 100, page_number)
        for item in raw if item.get("text", "").strip()
    ]
    lines.sort(key=lambda x: (x.bbox[1], x.bbox[0]))
    merged: list[Line] = []
    for line in lines:
        if merged:
            prev = merged[-1]
            prev_h = prev.bbox[3] - prev.bbox[1]
            line_h = line.bbox[3] - line.bbox[1]
            center_delta = abs((prev.bbox[1] + prev.bbox[3]) - (line.bbox[1] + line.bbox[3])) / 2
            gap = line.bbox[0] - prev.bbox[2]
            if center_delta <= max(14, min(prev_h, line_h) * 0.75) and -10 <= gap <= 180:
                prev.text = normalize_text(prev.text + " " + line.text)
                prev.bbox = [min(prev.bbox[0], line.bbox[0]), min(prev.bbox[1], line.bbox[1]),
                             max(prev.bbox[2], line.bbox[2]), max(prev.bbox[3], line.bbox[3])]
                prev.confidence = (prev.confidence + line.confidence) / 2
                continue
        merged.append(line)
    return merged


def is_cover_noise(text: str) -> bool:
    """Drop scanned logo letters and authenticity-stamp OCR from a standards cover."""
    compact = re.sub(r"\s+", "", text)
    return bool(re.fullmatch(r"GM", compact, re.I) or "刮涂层" in compact or "查真伪" in compact)


def normalize_text(text: str) -> str:
    text = text.replace("|", "I")
    text = text.replace("a.gorithm", "algorithm")
    text = re.sub(r"\bcryptograph\b", "cryptography", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"GM\s*/\s*T", "GM/T", text, flags=re.I)
    text = re.sub(r"^GBT(?=\s*\d)", "GB/T", text)
    text = re.sub(r"^(\d+(?:\.\d+)+)['’”]+$", r"\1", text)
    text = re.sub(r"^1(?=一个有序的序列)", "", text)
    text = text.replace("系統", "系统").replace("人侵", "入侵").replace("录人", "录入").replace("导人", "导入")
    if text.replace(" ", "") == "言引":
        text = "引言"
    text = re.sub(r"^一(?=(?:在线|离线|随机数|应用类|通信类|证书载体|对称|非对称|密码|接口|协议|密钥|物理))", "—", text)
    text = re.sub(r"\s+([，。；：、）])", r"\1", text)
    text = re.sub(r"([（])\s+", r"\1", text)
    return text


def normalize_markdown_text(text: str) -> str:
    """Polish OCR spacing without changing the recognized wording."""
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\b((?:GB|GM)/[TZ])(?=\d)", r"\1 ", text, flags=re.I)
    text = re.sub(
        r"\b((?:GB|GM)(?:/[TZ])?\s*\d+(?:\.\d+)*(?:[—–-]\d{4})?)(?=[\u4e00-\u9fff])",
        r"\1 ",
        text,
        flags=re.I,
    )
    text = re.sub(r"第\s*(\d+)\s*部分", r"第\1部分", text)
    text = re.sub(r"(?<=\d)(?=(?:实施|发布))", " ", text)
    text = re.sub(r"(实施|发布)(?=\d)", r"\1 ", text)
    text = re.sub(r"\b((?:GM|GB)/[TZ]\s*\d+(?:\.\d+)*)\s*-\s*(\d{4})\b", r"\1—\2", text, flags=re.I)
    text = re.sub(r"(备案号[：:])\s*(\d+)\s+[—–-]?\s*(\d{4})", r"\1\2—\3", text)
    text = re.sub(r"(?<=[\u4e00-\u9fff])(?=[A-Za-z])", " ", text)
    text = re.sub(
        r"([A-Za-z][A-Za-z0-9]*(?:/[A-Za-z0-9]+)?)(?=[\u4e00-\u9fff])",
        r"\1 ",
        text,
    )
    text = re.sub(r"\s+([，。；：、！？）】》])", r"\1", text)
    text = re.sub(r"([（【《])\s+", r"\1", text)
    return text


def prepare_ocr_image(source: Path, target: Path) -> None:
    """Suppress colored stamps/watermarks while preserving dark printed text."""
    image = Image.open(source).convert("RGB")
    rgb = np.asarray(image).copy()
    chroma = rgb.max(axis=2).astype(np.int16) - rgb.min(axis=2).astype(np.int16)
    colored = (chroma > 35) & (rgb.max(axis=2) > 80)
    rgb[colored] = 255
    clean = ImageOps.autocontrast(Image.fromarray(rgb).convert("L"), cutoff=0.3)
    clean.save(target, quality=95)


def ocr_one(image: Path, ocr_dir: Path, lang: str) -> tuple[int, list[Line]]:
    page_number = int(image.stem.split("-")[-1])
    base = ocr_dir / image.stem
    prepared = ocr_dir / f"{image.stem}-clean.jpg"
    prepare_ocr_image(image, prepared)
    cmd = ["tesseract"]
    tessdata = resolve_tessdata_dir()
    if tessdata:
        cmd.extend(["--tessdata-dir", str(tessdata)])
    cmd.extend([str(prepared), str(base), "-l", lang, "--psm", "3", "tsv"])
    run(cmd)
    return page_number, parse_tsv(base.with_suffix(".tsv"), page_number)


def ocr_one_vision(image: Path, ocr_dir: Path, executable: Path) -> tuple[int, list[Line]]:
    page_number = int(image.stem.split("-")[-1])
    output = ocr_dir / f"{image.stem}-vision.json"
    run([str(executable), str(image), str(output)])
    return page_number, parse_vision_json(output, page_number)


def create_paddle_ocr():
    """Lazily load the optional local PaddleOCR 3.x engine."""
    from paddleocr import PaddleOCR

    options = dict(
        lang="ch",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )
    try:
        return PaddleOCR(engine="paddle", **options)
    except TypeError as exc:
        # PaddleOCR 3.x releases before unified engine selection did not expose
        # the `engine` keyword. Their local PaddlePaddle backend is still valid.
        if "engine" not in str(exc):
            raise
        return PaddleOCR(**options)


def paddle_result_payload(result) -> dict:
    if isinstance(result, dict):
        return result.get("res", result)
    raw = getattr(result, "json", None)
    if callable(raw):
        raw = raw()
    if isinstance(raw, str):
        raw = json.loads(raw)
    if isinstance(raw, dict):
        return raw.get("res", raw)
    to_dict = getattr(result, "to_dict", None)
    if callable(to_dict):
        raw = to_dict()
        if isinstance(raw, dict):
            return raw.get("res", raw)
    raise TypeError("无法读取 PaddleOCR 返回结果")


def plain_sequence(value) -> list:
    if value is None:
        return []
    if hasattr(value, "tolist"):
        value = value.tolist()
    return list(value)


def paddle_box(value) -> list[int]:
    points = plain_sequence(value)
    if len(points) == 4 and all(isinstance(item, (int, float)) for item in points):
        left, top, right, bottom = points
    else:
        coordinates = [plain_sequence(point) for point in points]
        xs = [point[0] for point in coordinates if len(point) >= 2]
        ys = [point[1] for point in coordinates if len(point) >= 2]
        if not xs or not ys:
            raise ValueError("PaddleOCR 文本框坐标无效")
        left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
    return [int(round(left)), int(round(top)), int(round(right)), int(round(bottom))]


def parse_paddle_results(results, page_number: int) -> list[Line]:
    lines: list[Line] = []
    for result in results:
        payload = paddle_result_payload(result)
        texts = plain_sequence(payload.get("rec_texts"))
        scores = plain_sequence(payload.get("rec_scores"))
        boxes = plain_sequence(payload.get("rec_boxes")) or plain_sequence(payload.get("rec_polys"))
        for text, score, box in zip(texts, scores, boxes):
            normalized = normalize_text(str(text))
            if normalized:
                lines.append(Line(normalized, paddle_box(box), float(score) * 100, page_number))
    return sorted(lines, key=lambda line: (line.bbox[1], line.bbox[0]))


def ocr_one_paddle(image: Path, ocr_dir: Path, ocr) -> tuple[int, list[Line]]:
    page_number = int(image.stem.split("-")[-1])
    prepared = ocr_dir / f"{image.stem}-paddle-clean.jpg"
    prepare_ocr_image(image, prepared)
    lines = parse_paddle_results(ocr.predict(str(prepared)), page_number)
    output = ocr_dir / f"{image.stem}-paddle.json"
    output.write_text(json.dumps([asdict(line) for line in lines], ensure_ascii=False, indent=2), encoding="utf-8")
    return page_number, lines


def repeated_margin_text(page_lines: dict[int, list[Line]], image_height: int) -> set[str]:
    counts: Counter[str] = Counter()
    for lines in page_lines.values():
        seen: set[str] = set()
        for line in lines:
            y = (line.bbox[1] + line.bbox[3]) / 2
            if y < image_height * 0.12 or y > image_height * 0.9:
                key = re.sub(r"\d+", "#", line.text)
                if len(key) >= 4:
                    seen.add(key)
        counts.update(seen)
    threshold = max(3, len(page_lines) // 4)
    return {text for text, count in counts.items() if count >= threshold}


def is_full_page_artwork(image: Image.Image) -> bool:
    """True when an uncaptioned page is a diagram occupying most of the printable area.

    Blank versos, binding-shadow noise, and centered logo or stamp pages return False.
    Captioned figures use ink_bbox_for_figure instead of this path.
    """
    gray = np.asarray(ImageOps.grayscale(image))
    height, width = gray.shape
    side = max(12, int(width * 0.06))
    printable = (gray < 210)[:, side:width - side]
    if float(printable.mean()) < 0.04:
        return False
    content_rows = np.where(printable.mean(axis=1) > 0.05)[0]
    content_cols = np.where(printable.mean(axis=0) > 0.05)[0]
    if content_rows.size == 0 or content_cols.size == 0:
        return False
    span_h = (int(content_rows[-1]) - int(content_rows[0]) + 1) / height
    span_w = (int(content_cols[-1]) - int(content_cols[0]) + 1) / printable.shape[1]
    return span_h >= 0.55 and span_w >= 0.55


def ink_bbox_for_figure(image: Image.Image, caption: Line, lines: list[Line], min_top: int = 0) -> list[int] | None:
    """Estimate the diagram immediately above a figure caption.

    It uses whitespace projection, which works well on scanned standards where
    figures are separated from body text. It intentionally errs on preserving a
    larger crop; OCR lines inside the crop are excluded from body text.
    """
    gray = np.asarray(ImageOps.grayscale(image))
    h, w = gray.shape
    cap_top = caption.bbox[1]
    if cap_top < h * 0.30:
        return None
    # Scanned pages commonly have dark binding shadows and speckles along both
    # vertical edges.  Including those pixels makes every row look non-empty,
    # which in turn expands a figure crop upward into ordinary OCR paragraphs.
    # Whitespace and content projections therefore operate only inside the
    # printable page area.
    side_margin = max(12, int(w * 0.06))
    ink = gray < 210
    printable_ink = ink[:, side_margin:w - side_margin]
    row_density = printable_ink.mean(axis=1)
    search_start = max(int(h * 0.06), 0)
    search_end = max(search_start, cap_top - 8)
    # Find the last wide whitespace band before the connected figure content.
    blank = row_density[search_start:search_end] < 0.002
    bands: list[tuple[int, int]] = []
    start = None
    for idx, is_blank in enumerate(blank, search_start):
        if is_blank and start is None:
            start = idx
        elif not is_blank and start is not None:
            if idx - start >= max(12, h // 120):
                bands.append((start, idx))
            start = None
    if start is not None:
        bands.append((start, search_end))
    candidates = [b for b in bands if b[1] < cap_top - h * 0.08]
    candidates = [b for b in candidates if b[1] >= min_top]
    top = candidates[-1][1] if candidates else cap_top
    # A diagram should occupy a substantial vertical interval. OCR boxes inside
    # a diagram provide a reliable fallback when connector lines defeat the
    # whitespace projection.
    if cap_top - top < h * 0.18:
        internal_lines = [x for x in lines if max(h * 0.10, min_top) < x.bbox[1] < cap_top and not STANDARD_HEADER_RE.match(x.text)]
        if not internal_lines:
            return None
        top = max(int(h * 0.08), min_top, min(x.bbox[1] for x in internal_lines) - int(h * 0.02))
    # Standards usually introduce a diagram with “见图 A.1” or “如图 2
    # 所示”.  This is a strong semantic boundary: the introducing sentence is
    # editable body text and must never be baked into the following image.
    references = [
        line for line in lines
        if min_top <= line.bbox[1] < cap_top and FIGURE_REFERENCE_RE.search(line.text.replace(" ", ""))
    ]
    if references:
        top = max(top, max(line.bbox[3] for line in references) + 8)
    region = printable_ink[top:cap_top, :]
    col_density = region.mean(axis=0)
    xs = np.where(col_density > 0.002)[0]
    if xs.size == 0:
        return None
    left = max(side_margin, side_margin + int(xs[0]) - 15)
    right = min(w - side_margin, side_margin + int(xs[-1]) + 16)
    return [left, max(0, top - 8), right, min(h, cap_top - 4)]


def _group_nearby(values: Iterable[int], max_gap: int = 3) -> list[list[int]]:
    groups: list[list[int]] = []
    for value in values:
        if not groups or value - groups[-1][-1] > max_gap:
            groups.append([value])
        else:
            groups[-1].append(value)
    return groups


def ink_bbox_for_table(image: Image.Image, caption: Line, end_y: int) -> list[int] | None:
    """Find a ruled table below its caption using long horizontal borders.

    This intentionally activates only for clearly ruled tables. Borderless
    column layouts remain OCR text instead of being incorrectly cropped.
    """
    gray = np.asarray(ImageOps.grayscale(image))
    h, w = gray.shape
    side = max(12, int(w * 0.06))
    start = min(h - 1, caption.bbox[3] + 4)
    stop = min(h, max(start + 1, end_y))
    if stop - start < h * 0.04:
        return None

    ink = gray < 175
    printable = ink[start:stop, side:w - side]
    # A ruled border spans at least 42% of the printable width. Requiring high
    # row density prevents ordinary underlined headings from becoming tables.
    strong = np.where(printable.mean(axis=1) > 0.42)[0] + start
    bands = _group_nearby((int(y) for y in strong), 3)
    if len(bands) < 2:
        return None
    centers = [int(round(sum(group) / len(group))) for group in bands]
    first = next((index for index, y in enumerate(centers) if y - caption.bbox[3] <= h * 0.12), None)
    if first is None:
        return None
    borders = centers[first:]
    if len(borders) < 2 or borders[-1] - borders[0] < h * 0.04:
        return None

    # Use all border pixels to recover the left/right table edges. This is more
    # stable than OCR coordinates for merged cells and long descriptions.
    xs: list[int] = []
    for y in borders:
        row = np.where(ink[max(0, y - 1):min(h, y + 2), :].any(axis=0))[0]
        xs.extend(int(x) for x in row if side <= x <= w - side)
    if not xs:
        return None
    left, right = min(xs), max(xs)
    if right - left < w * 0.42:
        return None
    return [max(side, left - 3), max(0, borders[0] - 3), min(w - side, right + 4), min(h, borders[-1] + 4)]


def within(line: Line, box: list[int], padding: int = 8) -> bool:
    cx = (line.bbox[0] + line.bbox[2]) / 2
    cy = (line.bbox[1] + line.bbox[3]) / 2
    return box[0] - padding <= cx <= box[2] + padding and box[1] - padding <= cy <= box[3] + padding


def classify_heading(text: str) -> int | None:
    if re.match(r"^(?:19|20)\d{2}[\s、，]", text):
        return None
    text = re.sub(r"^(\d+(?:\.\d+){0,5})[，、'\"”]+", r"\1 ", text)
    compact = text.replace(" ", "")
    if compact in {"前言", "引言", "目录", "参考文献"}:
        return 1
    match = re.match(r"^(?:(\d+(?:\.\d+)+)(?:\s+|(?=[\u4e00-\u9fffA-Z]))|(\d+)\s+)", text)
    if match:
        number = match.group(1) or match.group(2)
        return min(6, number.count(".") + 2)
    appendix = re.match(r"^[A-Z]\.(\d+(?:\.\d+)*)\s+\S", text, re.I)
    if appendix:
        return min(6, appendix.group(1).count(".") + 3)
    if compact.startswith("附录"):
        return 1
    return None


def format_heading(text: str) -> str:
    compact = text.replace(" ", "")
    special = {"前言": "前言", "引言": "引言", "目录": "目录", "参考文献": "参考文献"}
    if compact in special:
        return special[compact]
    text = re.sub(r"^(\d+(?:\.\d+){0,5})[，、'\"”]+", r"\1 ", text)
    text = re.sub(r"^(\d+(?:\.\d+){0,5})\s*", r"\1 ", text)
    text = re.sub(r"^(\d+(?:\.\d+){0,5})\s*[；;：:，、]\s*", r"\1 ", text)
    return normalize_markdown_text(text)


def process_layout(
    page_images: list[Path], page_lines: dict[int, list[Line]], output_dir: Path
) -> tuple[dict[int, list[Line]], list[Figure], list[Table], set[str]]:
    first_image = Image.open(page_images[0])
    repeated = repeated_margin_text(page_lines, first_image.height)
    first_image.close()
    figures: list[Figure] = []
    tables: list[Table] = []
    assets = output_dir / "assets"
    if assets.exists():
        shutil.rmtree(assets)
    assets.mkdir(parents=True, exist_ok=True)

    # Detect table-of-contents range. It is redundant for retrieval and tends to
    # create false headings because of page numbers and leader dots.
    toc_start = next((p for p, xs in page_lines.items() if any(x.text == "目" for x in xs) and any(x.text == "次" for x in xs)), None)
    preface_page = next((p for p, xs in page_lines.items() if p > (toc_start or 0) and any(x.text.replace(" ", "") == "前言" for x in xs)), None)
    toc_pages = set(range(toc_start, preface_page)) if toc_start and preface_page else set()

    for image_path in page_images:
        page = int(image_path.stem.split("-")[-1])
        image = Image.open(image_path)
        lines = page_lines[page]
        # Join isolated section numbers with the nearest short title. Vision can
        # return same-row boxes in slightly different vertical order, so spatial
        # distance is more reliable than list adjacency.
        used_title_ids: set[int] = set()
        for line in lines:
            if not re.fullmatch(r"\d+(?:\.\d+){0,5}", line.text):
                continue
            # Standards often place the last definition close to the footer.
            # Only exclude the true bottom margin; 0.86 dropped valid section
            # numbers such as 3.3 and 3.15 from heading reconstruction.
            if (line.bbox[1] + line.bbox[3]) / 2 > image.height * 0.96:
                continue
            candidates = []
            for title in lines:
                if title is line or id(title) in used_title_ids or re.fullmatch(r"\d+(?:\.\d+){0,5}", title.text):
                    continue
                if len(title.text) > 45 or re.search(r"[。；]$", title.text):
                    continue
                vertical_gap = min(abs(title.bbox[1] - line.bbox[3]), abs(line.bbox[1] - title.bbox[3]))
                center_delta = abs((title.bbox[1] + title.bbox[3]) - (line.bbox[1] + line.bbox[3])) / 2
                title_center = (title.bbox[1] + title.bbox[3]) / 2
                number_center = (line.bbox[1] + line.bbox[3]) / 2
                # Prefer the short label to the right/below the isolated
                # section number. A preceding body line can be slightly closer
                # but must never be mistaken for the heading text.
                if (
                    vertical_gap <= 75
                    and center_delta <= 100
                    and title_center >= number_center - 10
                    and title.bbox[0] >= line.bbox[2] - 20
                ):
                    candidates.append((center_delta + max(0, title.bbox[0] - line.bbox[2]) * 0.1, title))
            if candidates:
                title = min(candidates, key=lambda x: x[0])[1]
                line.text = f"{line.text} {title.text}"
                line.bbox = [min(line.bbox[0], title.bbox[0]), min(line.bbox[1], title.bbox[1]),
                             max(line.bbox[2], title.bbox[2]), max(line.bbox[3], title.bbox[3])]
                title.kind = "heading_continuation"
                used_title_ids.add(id(title))

        # Some figure captions wrap after the figure number (notably 图 A.4).
        for idx, line in enumerate(lines):
            if FIGURE_CAPTION_RE.match(line.text) and len(line.text.replace(" ", "")) <= 7:
                choices = [x for x in lines if x is not line and len(x.text) <= 60 and
                           abs((x.bbox[1] + x.bbox[3]) - (line.bbox[1] + line.bbox[3])) / 2 < 100]
                if choices:
                    nxt = min(choices, key=lambda x: abs((x.bbox[1] + x.bbox[3]) - (line.bbox[1] + line.bbox[3])))
                    line.text = f"{line.text} {nxt.text}"
                    line.bbox = [min(line.bbox[0], nxt.bbox[0]), line.bbox[1], max(line.bbox[2], nxt.bbox[2]), nxt.bbox[3]]
                    nxt.kind = "figure_caption_continuation"

        captions = [line for line in lines if FIGURE_CAPTION_RE.match(line.text)]
        previous_caption_bottom = 0
        for index, caption in enumerate(captions, 1):
            caption.text = caption.text.rstrip("•·. ")
            box = ink_bbox_for_figure(image, caption, lines, previous_caption_bottom)
            if not box:
                continue
            internal = [line.text for line in lines if within(line, box)]
            asset_name = f"page-{page:03d}-figure-{index:02d}.png"
            image.crop(tuple(box)).save(assets / asset_name, optimize=True)
            figures.append(Figure(page, box, caption.text, f"assets/{asset_name}", internal))
            previous_caption_bottom = caption.bbox[3] + 8

        table_captions = [line for line in lines if TABLE_CAPTION_RE.match(line.text)]
        for index, caption in enumerate(table_captions, 1):
            later_boundaries = [
                candidate.bbox[1]
                for candidate in lines
                if candidate.bbox[1] > caption.bbox[3]
                and (
                    TABLE_CAPTION_RE.match(candidate.text)
                    or (
                        classify_heading(candidate.text)
                        and candidate.bbox[0] < image.width * 0.38
                        and not re.match(r"^(?:19|20)\d{2}", candidate.text)
                    )
                )
            ]
            end_y = min(later_boundaries) - 8 if later_boundaries else image.height - int(image.height * 0.05)
            box = ink_bbox_for_table(image, caption, end_y)
            if not box:
                continue
            internal = [line.text for line in lines if within(line, box)]
            asset_name = f"page-{page:03d}-table-{index:02d}.png"
            image.crop(tuple(box)).save(assets / asset_name, optimize=True)
            tables.append(Table(page, box, caption.text.rstrip("•·. "), f"assets/{asset_name}", internal))

        # Preserve uncaptioned full-page diagrams; skip blank, stamp, and logo pages.
        meaningful_lines = [x for x in lines if len(re.sub(r"\W", "", x.text)) >= 2]
        if len(meaningful_lines) <= 1 and not captions and is_full_page_artwork(image):
            asset_name = f"page-{page:03d}-full-page-image.png"
            image.save(assets / asset_name, optimize=True)
            figures.append(Figure(page, [0, 0, image.width, image.height], f"第{page}页整页图片", f"assets/{asset_name}", []))

        figure_boxes = [f.bbox for f in figures if f.page == page]
        table_boxes = [table.bbox for table in tables if table.page == page]
        cleaned: list[Line] = []
        for line in lines:
            normalized_margin = re.sub(r"\d+", "#", line.text)
            center_y = (line.bbox[1] + line.bbox[3]) / 2
            if line.kind in {"heading_continuation", "figure_caption_continuation"}:
                pass
            elif page == 1 and is_cover_noise(line.text):
                line.kind = "header_footer"
            elif normalized_margin in repeated:
                if page == 1 and STANDARD_RUNNING_HEADER_RE.match(line.text):
                    pass
                else:
                    line.kind = "header_footer"
            elif STANDARD_RUNNING_HEADER_RE.match(line.text) and center_y < image.height * 0.15:
                line.kind = "header_footer"
            elif (
                re.fullmatch(r"[IVXⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ皿\d]+", line.text)
                and center_y > image.height * 0.88
                and not (page in toc_pages and line.bbox[0] > image.width * 0.70)
            ):
                line.kind = "page_number"
            elif page in toc_pages:
                line.kind = "toc"
            elif FIGURE_CAPTION_RE.match(line.text):
                line.kind = "figure_caption"
            elif TABLE_CAPTION_RE.match(line.text):
                line.kind = "table_caption"
            elif any(within(line, box) for box in figure_boxes):
                line.kind = "figure_text"
            elif any(within(line, box) for box in table_boxes):
                line.kind = "table_text"
            elif LIST_RE.match(line.text):
                line.kind = "list"
            elif classify_heading(line.text):
                line.kind = "heading"
            cleaned.append(line)
        page_lines[page] = cleaned
        image.close()
    return page_lines, figures, tables, repeated


def join_paragraph(lines: Iterable[Line]) -> str:
    result = ""
    for line in lines:
        text = line.text.strip()
        if not text:
            continue
        if result and result[-1].isascii() and text[0].isascii() and result[-1].isalnum() and text[0].isalnum():
            result += " "
        result += text
    return result


def union_bbox(lines: Iterable[Line]) -> list[int]:
    boxes = [line.bbox for line in lines]
    if not boxes:
        return [0, 0, 0, 0]
    return [min(x[0] for x in boxes), min(x[1] for x in boxes), max(x[2] for x in boxes), max(x[3] for x in boxes)]


def expand_embedded_headings(lines: list[Line]) -> list[Line]:
    """Split an OCR line such as `...。3.3 术语` without dropping either part."""
    expanded: list[Line] = []
    pattern = re.compile(r"^(.+?[。；])\s*((?:\d+(?:\.\d+)+)\s*[一-鿿A-Z].+)$")
    for line in lines:
        if line.kind != "text":
            expanded.append(line)
            continue
        match = pattern.match(line.text)
        if not match or not classify_heading(match.group(2)):
            expanded.append(line)
            continue
        expanded.append(replace(line, text=match.group(1), kind="text"))
        expanded.append(replace(line, text=match.group(2), kind="heading"))
    return expanded


def merge_split_display_headings(lines: list[Line]) -> list[Line]:
    """Merge large two-character headings returned as reversed OCR boxes."""
    merged: list[Line] = []
    index = 0
    replacements = {"言引": "引言", "次目": "目录"}
    while index < len(lines):
        if index + 1 < len(lines):
            first, second = lines[index], lines[index + 1]
            combined = (first.text + second.text).replace(" ", "")
            center_delta = abs((first.bbox[1] + first.bbox[3]) - (second.bbox[1] + second.bbox[3])) / 2
            if first.kind == second.kind == "text" and combined in replacements and center_delta <= 24:
                merged.append(Line(
                    replacements[combined],
                    [min(first.bbox[0], second.bbox[0]), min(first.bbox[1], second.bbox[1]),
                     max(first.bbox[2], second.bbox[2]), max(first.bbox[3], second.bbox[3])],
                    (first.confidence + second.confidence) / 2, first.page, "heading",
                ))
                index += 2
                continue
        merged.append(lines[index])
        index += 1
    return merged


def list_parts(text: str) -> tuple[str, str] | None:
    match = LIST_RE.match(text)
    if match:
        marker = match.group(0).strip()
        return marker, text[match.end():].strip()
    # OCR commonly reads an em dash as the Chinese numeral “一” before “第 N 部分”.
    if re.match(r"^一第\s*\d+部分", text):
        return "-", text[1:].strip()
    noisy_step = re.match(r"^[A-Za-z]{2,3}[)）]\s*(步骤\s*\d+.+)$", text)
    if noisy_step:
        return "-", noisy_step.group(1).strip()
    return None


def infer_document_title(pdf: Path, first_page: list[Line]) -> str:
    if not first_page:
        return normalize_markdown_text(pdf.stem)
    max_y = max(line.bbox[3] for line in first_page)
    # A cropped PDF or a one-page conversion may start directly with numbered
    # body sections. In that case, large table/body text is not a cover title;
    # the source filename is the safer document identity.
    if any(classify_heading(line.text) for line in first_page):
        return normalize_markdown_text(pdf.stem)
    central = [
        line for line in first_page
        if max_y * 0.25 <= (line.bbox[1] + line.bbox[3]) / 2 <= max_y * 0.68
        and re.search(r"[一-鿿]", line.text)
        and not re.search(r"(?:中华人民共和国|国家市场|管理委员会|发布|实施)", line.text)
    ]
    if not central:
        return normalize_markdown_text(pdf.stem)
    tallest = max(line.bbox[3] - line.bbox[1] for line in central)
    title_lines = [line for line in central if line.bbox[3] - line.bbox[1] >= tallest * 0.62 and len(line.text) <= 70]
    title_lines.sort(key=lambda line: (line.bbox[1], line.bbox[0]))
    # A line break on a standards cover is normally typographic, not a word
    # boundary. Joining without an invented space avoids titles such as
    # “证书认证 系统密码”, while the typography normalizer still separates SM2.
    title_parts: list[str] = []
    for line in title_lines:
        if title_parts and re.match(r"^第\s*\d+\s*部分", line.text):
            title_parts.append(" ")
        title_parts.append(line.text)
    title = normalize_markdown_text("".join(title_parts))
    return title if 4 <= len(title) <= 100 else normalize_markdown_text(pdf.stem)


ROMAN_OCR_FIX = {"川": "III", "皿": "III", "Ⅲ": "III", "Ⅱ": "II", "Ⅰ": "I"}


def toc_page_number(text: str) -> str:
    compact = ROMAN_OCR_FIX.get(text.strip().replace(" ", ""), text.strip().replace(" ", ""))
    return re.sub(r"[^0-9IVXⅠ-Ⅹ]", "", compact, flags=re.I)


def leading_toc_number(text: str) -> str | None:
    match = re.match(r"^(\d+(?:\.\d+)*)(?:\s+|(?=[一-鿿A-Za-z]))", text)
    if match:
        return match.group(1)
    match = re.match(r"^([A-Z]\.\d+(?:\.\d+)*)(?:\s+|(?=[一-鿿A-Za-z]))", text)
    return match.group(1) if match else None


def toc_indent_level(label: str) -> int:
    compact = label.replace(" ", "")
    if re.match(r"^(?:前言|引言|参考文献|附录)", compact):
        return 1
    number = leading_toc_number(label)
    if not number:
        return 1
    return min(4, number.count(".") + 1)


def implied_toc_number(prev: str | None, nxt: str | None) -> str | None:
    if nxt:
        parent = re.match(r"^(\d+)\.\d+", nxt)
        if parent and (not prev or prev.split(".")[0] != parent.group(1)):
            return parent.group(1)
    if prev and nxt and re.fullmatch(r"\d+", prev) and re.fullmatch(r"\d+", nxt):
        if int(nxt) == int(prev) + 2:
            return str(int(prev) + 1)
    return None


def normalize_toc_label(text: str) -> str:
    text = re.sub(r"[⋯…•·.\s：:]+$", "", text).strip()
    text = re.sub(r"^(\d+(?:\.\d+)*)(?=[一-鿿A-Za-z])", r"\1 ", text)
    text = re.sub(r"^([A-Z]\.\d+(?:\.\d+)*)(?=[一-鿿A-Za-z])", r"\1 ", text)
    text = text.replace("缩咯语", "缩略语")
    return normalize_markdown_text(text)


def roman_page_number(text: str) -> bool:
    return bool(re.fullmatch(r"[IVXⅠ-Ⅹ]+", text, flags=re.I))


def fill_toc_page_numbers(entries: list[tuple[str, str, list[int]]]) -> list[tuple[str, str, list[int]]]:
    pages = [page for _, page, _ in entries]
    for index, page in enumerate(pages):
        if page:
            continue
        nxt = next((item for item in pages[index + 1:] if item), "")
        prev = next((item for item in reversed(pages[:index]) if item), "")
        if nxt and (not prev or prev == nxt or (roman_page_number(prev) and not roman_page_number(nxt))):
            pages[index] = nxt
        elif prev and (not nxt or prev == nxt):
            pages[index] = prev
    return [(label, page, bbox) for (label, _, bbox), page in zip(entries, pages)]


def fill_missing_toc_section_numbers(labels: list[str]) -> list[str]:
    numbers = [leading_toc_number(label) for label in labels]
    filled: list[str] = []
    for index, label in enumerate(labels):
        if numbers[index] or re.match(r"^(?:前言|引言|参考文献|附录)", label.replace(" ", "")):
            filled.append(label)
            continue
        prev = next((item for item in reversed(numbers[:index]) if item), None)
        nxt = next((item for item in numbers[index + 1:] if item), None)
        implied = implied_toc_number(prev, nxt)
        filled.append(f"{implied} {label}" if implied else label)
        if implied:
            numbers[index] = implied
    return filled


def build_toc_blocks(lines: list[Line], page: int) -> list[SemanticBlock]:
    """Pair TOC labels with right-aligned page numbers and restore hierarchy."""
    toc = [line for line in lines if line.kind == "toc"]
    if not toc:
        return []
    page_width = max(line.bbox[2] for line in lines)
    labels = [line for line in toc if line.bbox[0] < page_width * 0.72]
    numbers = [line for line in toc if line.bbox[0] > page_width * 0.70]
    usable: list[Line] = []
    for label in labels:
        text = normalize_toc_label(label.text)
        compact = text.replace(" ", "")
        if compact in {"目", "次", "目次"} or len(re.sub(r"\W", "", text)) < 2:
            continue
        usable.append(replace(label, text=text))
    candidates: list[tuple[float, int, int]] = []
    for label_index, label in enumerate(usable):
        center = (label.bbox[1] + label.bbox[3]) / 2
        tolerance = max(40, (label.bbox[3] - label.bbox[1]) * 1.4)
        for number_index, number in enumerate(numbers):
            distance = abs((number.bbox[1] + number.bbox[3]) / 2 - center)
            if distance <= tolerance:
                candidates.append((distance, label_index, number_index))
    candidates.sort()
    assigned: dict[int, int] = {}
    used_numbers: set[int] = set()
    for _, label_index, number_index in candidates:
        if label_index in assigned or number_index in used_numbers:
            continue
        assigned[label_index] = number_index
        used_numbers.add(number_index)
    paired: list[tuple[str, str, list[int]]] = []
    for label_index, label in enumerate(usable):
        page_number = ""
        if label_index in assigned:
            page_number = toc_page_number(numbers[assigned[label_index]].text)
        paired.append((label.text, page_number, label.bbox))
    paired = fill_toc_page_numbers(paired)
    labels_only = fill_missing_toc_section_numbers([label for label, _, _ in paired])
    return [
        SemanticBlock(
            "toc_entry", page, bbox, text=f"{label} …… {page_number}" if page_number else label,
            level=toc_indent_level(label),
        )
        for label, (_, page_number, bbox) in zip(labels_only, paired)
    ]


def build_semantic_blocks(
    lines: list[Line], figures: list[Figure], tables: list[Table], page: int
) -> list[SemanticBlock]:
    """Reconstruct page semantics from OCR coordinates and layout labels."""
    ordered = merge_split_display_headings(
        expand_embedded_headings(sorted(lines, key=lambda line: (line.bbox[1], line.bbox[0])))
    )
    eligible = [line for line in ordered if line.kind in {"text", "list"}]
    heights = sorted(max(1, line.bbox[3] - line.bbox[1]) for line in eligible)
    median_height = heights[len(heights) // 2] if heights else 32
    lefts = sorted(line.bbox[0] for line in eligible)
    body_left = lefts[max(0, int(len(lefts) * 0.18) - 1)] if lefts else 0
    figure_by_caption = {figure.caption: figure for figure in figures if figure.page == page}
    table_by_caption = {table.caption: table for table in tables if table.page == page}
    toc_blocks = build_toc_blocks(ordered, page)
    toc_emitted = False

    blocks: list[SemanticBlock] = []
    paragraph: list[Line] = []
    active_list: list[Line] = []
    active_marker: str | None = None

    def flush_paragraph() -> None:
        if not paragraph:
            return
        text = join_paragraph(paragraph)
        kind = "note" if re.match(r"^注\s*[：:]", text) else "paragraph"
        blocks.append(SemanticBlock(kind, page, union_bbox(paragraph), text=text))
        paragraph.clear()

    def flush_list() -> None:
        nonlocal active_marker
        if not active_list:
            return
        text = join_paragraph(active_list)
        parts = list_parts(text)
        if parts:
            marker, text = parts
        else:
            marker = active_marker or "-"
        if text:
            blocks.append(SemanticBlock("list_item", page, union_bbox(active_list), text=text, marker=marker))
        active_list.clear()
        active_marker = None

    def starts_inferred_list(line: Line, previous_text: str) -> bool:
        if re.match(r"^一第\s*\d+部分", line.text):
            return True
        label = re.match(r"^[一-鿿A-Za-z0-9/().（）]{2,24}[：:]", line.text)
        lost_dash = re.match(r"^一(?=(?:证书|工具|系统|密钥|接口|协议|步骤))", line.text)
        return bool(label and (
            previous_text.endswith(("如下：", "包括："))
            or bool(active_list)
            or bool(blocks and blocks[-1].kind == "list_item")
        ) or lost_dash and bool(active_list or (blocks and blocks[-1].kind == "list_item")))

    def paragraph_break(previous: Line, current: Line) -> bool:
        gap = current.bbox[1] - previous.bbox[3]
        indented = current.bbox[0] >= body_left + max(24, int(median_height * 0.72))
        sentence_end = bool(re.search(r"[。！？；]$", previous.text))
        same_band = abs((current.bbox[1] + current.bbox[3]) - (previous.bbox[1] + previous.bbox[3])) / 2 <= median_height
        x_gap = max(current.bbox[0] - previous.bbox[2], previous.bbox[0] - current.bbox[2])
        cover_dates = (
            previous.page == 1
            and current.page == 1
            and same_band
            and x_gap > max(120, int((previous.bbox[2] - previous.bbox[0]) * 0.8))
        )
        cover_meta = previous.page == 1 and bool(
            re.match(r"^(?:ICS\b|[A-Z]\s*\d+$|备案号)", previous.text)
        )
        return (
            gap > max(12, int(median_height * 0.45))
            or (sentence_end and indented)
            or cover_dates
            or cover_meta
        )

    ignored = {
        "header_footer", "page_number", "figure_text", "table_text",
        "heading_continuation", "figure_caption_continuation",
    }
    for line in ordered:
        if line.kind in ignored:
            continue
        if line.kind == "toc":
            flush_list(); flush_paragraph()
            if not toc_emitted:
                blocks.extend(toc_blocks)
                toc_emitted = True
            continue
        if line.kind == "heading":
            flush_list(); flush_paragraph()
            blocks.append(SemanticBlock(
                "heading", page, line.bbox, text=format_heading(line.text), level=classify_heading(line.text) or 2
            ))
            continue
        if line.kind == "figure_caption" and line.text in figure_by_caption:
            flush_list(); flush_paragraph()
            figure = figure_by_caption[line.text]
            blocks.append(SemanticBlock(
                "figure", page, figure.bbox, asset=figure.asset, caption=figure.caption,
                search_text=" ".join(figure.figure_ocr),
            ))
            continue
        if line.kind == "table_caption" and line.text.rstrip("•·. ") in table_by_caption:
            flush_list(); flush_paragraph()
            table = table_by_caption[line.text.rstrip("•·. ")]
            blocks.append(SemanticBlock(
                "table", page, table.bbox, asset=table.asset, caption=table.caption,
                search_text="\n".join(table.table_ocr),
            ))
            continue

        explicit = list_parts(line.text)
        previous_text = join_paragraph(active_list) if active_list else (join_paragraph(paragraph) if paragraph else "")
        inferred = not explicit and starts_inferred_list(line, previous_text)
        if explicit or inferred:
            flush_paragraph(); flush_list()
            active_marker = explicit[0] if explicit else "-"
            if inferred:
                line = replace(line, text=re.sub(
                    r"^一(?=(?:[一-鿿]{2,20}[：:]|证书|工具|系统|密钥|接口|协议|步骤))", "", line.text
                ))
            active_list.append(line)
            continue
        if active_list:
            previous = active_list[-1]
            if re.search(r"[。！？；]$", previous.text):
                flush_list()
            else:
                gap = line.bbox[1] - previous.bbox[3]
                if gap <= max(18, int(median_height * 0.72)):
                    active_list.append(line)
                    continue
                flush_list()
        if paragraph and paragraph_break(paragraph[-1], line):
            flush_paragraph()
        paragraph.append(line)

    flush_list(); flush_paragraph()
    for figure in figures:
        if figure.page == page and figure.caption.startswith("第") and figure.caption.endswith("整页图片"):
            blocks.append(SemanticBlock(
                "full_page_image", page, figure.bbox, asset=figure.asset, caption=figure.caption
            ))
    return blocks


def reconcile_page_boundaries(pages: dict[int, list[SemanticBlock]]) -> None:
    """Repair paragraphs and list items split only because a PDF page ended."""
    previous_blocks: list[SemanticBlock] | None = None
    for page in sorted(pages):
        current = pages[page]
        if not previous_blocks or not current:
            previous_blocks = current
            continue
        tail = previous_blocks[-1]
        list_context = tail.kind == "list_item"
        if list_context and not re.search(r"[。！？；]$", tail.text) and current[0].kind == "paragraph":
            first = current.pop(0)
            if tail.text and tail.text[-1].isascii() and first.text[:1].isascii():
                tail.text += " "
            tail.text += first.text
        if list_context:
            for block in current:
                if block.kind != "paragraph":
                    break
                if not re.match(r"^[一-鿿A-Za-z0-9/().（）]{2,24}[：:]", block.text):
                    if not re.match(r"^一(?=(?:证书|工具|系统|密钥|接口|协议|步骤))", block.text):
                        break
                block.kind = "list_item"
                block.marker = "-"
                block.text = re.sub(r"^一(?=(?:证书|工具|系统|密钥|接口|协议|步骤))", "", block.text)
        previous_blocks = current or previous_blocks


def markdown_heading_level(level: int | None) -> int:
    """Reserve H1 for the document title and cap overly deep PDF numbering."""
    return max(2, min(4, level or 2))


def markdown_caption(caption: str) -> str:
    match = re.match(r"^(图|表)\s*([A-ZＡ-Ｚ]?\.?\s*\d+(?:\.\d+)?)\s*(.*)$", caption)
    if not match:
        return normalize_markdown_text(caption)
    number = re.sub(r"\s+", "", match.group(2))
    title = normalize_markdown_text(match.group(3))
    return f"{match.group(1)} {number}" + (f"：{title}" if title else "")


def looks_like_code(text: str) -> bool:
    compact = text.strip()
    if re.fullmatch(r"[{}\[\]｛｝［］，,、\s]+", compact):
        return True
    return bool(
        re.search(r"[\"“”][A-Za-z][A-Za-z0-9_.]*[\"“”']?\s*[：:]", compact)
        or re.search(r"(?:sessionId|toolId|timestamp|toolInputParam|toolOutputParam)", compact)
    )


def format_code_lines(texts: list[str]) -> str:
    """Make OCR JSON samples readable without pretending they are valid JSON."""
    lines: list[str] = []
    for text in texts:
        normalized = text.strip()
        normalized = normalized.replace("｛", "{").replace("｝", "}").replace("［", "[").replace("］", "]")
        normalized = normalized.replace("“", '"').replace("”", '"')
        normalized = re.sub(r'(["\'])\s*：\s*', r'\1: ', normalized)
        normalized = re.sub(r'，\s*(?=")', ',\n', normalized)
        if normalized:
            lines.append(normalized)
    return "```json\n" + "\n".join(lines) + "\n```"


def split_references(text: str) -> list[str]:
    parts = re.split(r"(?=(?:［|\[)\s*\d+\s*(?:］|\]))", text)
    return [part.strip() for part in parts if part.strip()]


def is_cover_page(blocks: list[SemanticBlock], title: str) -> bool:
    if any(block.kind == "full_page_image" for block in blocks):
        return True
    if any(block.kind == "heading" for block in blocks):
        return False
    text = "".join(block.text for block in blocks if block.text)
    compact_title = re.sub(r"\s+", "", title)
    return len(blocks) >= 4 and compact_title and compact_title in re.sub(r"\s+", "", text)


def render_cover_markdown(blocks: list[SemanticBlock], page: int, title: str) -> str:
    content: list[str] = []
    compact_title = re.sub(r"\s+", "", title)
    for block in blocks:
        if block.kind not in {"paragraph", "note"} or not block.text:
            continue
        compact = re.sub(r"\s+", "", block.text)
        if compact_title and len(compact) >= 4 and (compact in compact_title or compact_title in compact):
            continue
        if is_cover_noise(block.text):
            continue
        content.append(normalize_markdown_text(block.text))
    groups = [f"> **PDF 原始页码：** {page}"]
    if content:
        groups.append("## 文档信息\n\n" + "\n".join(f"- {line}" for line in content))
    return "\n\n".join(groups)


def render_page_markdown(
    blocks: list[SemanticBlock], page: int, state: dict[str, bool], *, title: str = "", cover: bool = False
) -> str:
    if cover:
        return render_cover_markdown(blocks, page, title)
    if not blocks:
        return ""

    groups = [f"> **PDF 原始页码：** {page}"]
    index = 0
    while index < len(blocks):
        block = blocks[index]
        if block.kind == "heading":
            level = markdown_heading_level(block.level)
            groups.append("#" * level + " " + format_heading(block.text))
            state["references"] = block.text.replace(" ", "").startswith("参考文献")
        elif block.kind == "paragraph":
            if title and re.sub(r"\s+", "", block.text) == re.sub(r"\s+", "", title):
                pass
            elif state.get("references"):
                reference_lines: list[str] = []
                while index < len(blocks) and blocks[index].kind in {"paragraph", "list_item"}:
                    reference_block = blocks[index]
                    references = split_references(reference_block.text)
                    for reference in references:
                        if reference_lines and re.match(r"^(?:[—-]|Part\s+)", reference, re.I):
                            reference_lines[-1] += " " + normalize_markdown_text(reference.lstrip("—- "))
                        else:
                            reference_lines.append(f"- {normalize_markdown_text(reference)}")
                    index += 1
                index -= 1
                groups.append("\n".join(reference_lines))
            elif looks_like_code(block.text):
                code_lines = [block.text]
                while index + 1 < len(blocks) and blocks[index + 1].kind == "paragraph" and looks_like_code(blocks[index + 1].text):
                    index += 1
                    code_lines.append(blocks[index].text)
                groups.append(format_code_lines(code_lines))
            else:
                groups.append(normalize_markdown_text(block.text))
        elif block.kind == "note":
            note = normalize_markdown_text(re.sub(r"^注\s*[：:]\s*", "", block.text))
            groups.append(f"> **注：** {note}")
        elif block.kind == "list_item":
            list_lines: list[str] = []
            while index < len(blocks) and blocks[index].kind in {"list_item", "note"}:
                item = blocks[index]
                if item.kind == "note":
                    note = normalize_markdown_text(re.sub(r"^注\s*[：:]\s*", "", item.text))
                    list_lines.append(f"  > **注：** {note}")
                else:
                    numbered = re.match(r"^(\d+)[)）]", item.marker or "")
                    prefix = f"{numbered.group(1)}." if numbered else "-"
                    list_lines.append(f"{prefix} {normalize_markdown_text(item.text)}")
                index += 1
            index -= 1
            groups.append("\n".join(list_lines))
        elif block.kind == "toc_entry":
            toc_lines: list[str] = []
            if not state.get("toc_started"):
                toc_lines.extend(["## 目次", ""])
                state["toc_started"] = True
            while index < len(blocks) and blocks[index].kind == "toc_entry":
                entry = blocks[index]
                indent = "  " * max(0, (entry.level or 1) - 1)
                toc_lines.append(f"{indent}- {normalize_markdown_text(entry.text)}")
                index += 1
            index -= 1
            groups.append("\n".join(toc_lines))
        elif block.kind in {"figure", "table", "full_page_image"} and block.asset:
            caption = markdown_caption(block.caption or f"第{page}页图片")
            alt = caption.replace("[", "［").replace("]", "］")
            media = [f"![{alt}]({block.asset})"]
            if block.kind != "full_page_image":
                media.append(f"*{caption}*")
            if block.kind == "table" and block.search_text:
                media.append(
                    "**表格文本：**\n\n"
                    f"```text\n{block.search_text}\n```"
                )
            groups.append("\n\n".join(media))
        index += 1
    return "\n\n".join(group for group in groups if group.strip())


def page_markdown(blocks: list[SemanticBlock], page: int) -> str:
    """Compatibility wrapper used by unit tests and external callers."""
    return render_page_markdown(blocks, page, {"toc_started": False, "references": False}) + "\n"


def document_markdown(title: str, semantic_pages: dict[int, list[SemanticBlock]]) -> str:
    state = {"toc_started": False, "references": False}
    pages: list[str] = []
    for page, blocks in semantic_pages.items():
        rendered = render_page_markdown(
            blocks, page, state, title=title,
            cover=page == 1 and is_cover_page(blocks, title),
        )
        if rendered:
            pages.append(rendered)
    return "\n\n".join(pages).strip() + "\n"


def markdown_frontmatter(title: str, source: str, document_id: str) -> str:
    """Keep reader-facing metadata small; diagnostics belong in JSON reports."""
    values = {
        "title": normalize_markdown_text(title),
        "source": source,
        "document_id": document_id,
    }
    lines = ["---"]
    lines.extend(f"{key}: {json.dumps(value, ensure_ascii=False)}" for key, value in values.items())
    lines.append("---")
    return "\n".join(lines) + "\n\n"


def frontmatter_keys(content: str) -> set[str]:
    match = re.match(r"\A---\n(.*?)\n---(?:\n|\Z)", content, re.S)
    if not match:
        return set()
    return {
        key.group(1)
        for line in match.group(1).splitlines()
        if (key := re.match(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*:", line))
    }


def validate_llm_wiki_markdown(content: str, root: Path) -> dict:
    """Validate the HTML-free GFM subset emitted for LLM Wiki ingestion."""
    errors: list[str] = []
    warnings: list[str] = []
    metadata_keys = frontmatter_keys(content)
    if not metadata_keys:
        errors.append("YAML front matter is missing or unbalanced")
    elif "title" not in metadata_keys:
        errors.append("front matter title is missing")
    processing_keys = {
        "page_count", "source_type", "ocr_engine", "markdown_schema",
        "markdown_profile", "language", "assets_path", "processed_at",
    }
    leaked = sorted(metadata_keys & processing_keys)
    if leaked:
        errors.append("processing metadata must be stored in JSON reports: " + ", ".join(leaked))
    headings = re.findall(r"^(#{1,6})\s+\S", content, re.M)
    if headings.count("#") != 1:
        errors.append("document must contain exactly one H1 title")
    if headings and max(map(len, headings)) > 4:
        errors.append("heading depth exceeds H4")
    if content.count("```") % 2:
        errors.append("fenced code block is unbalanced")
    if re.search(r"</?(?:a|details|summary|div|span|p)\b|<!--", content, re.I):
        errors.append("raw HTML is not allowed in llm-wiki-gfm")
    if not re.search(r"^> \*\*PDF 原始页码：\*\* \d+$", content, re.M):
        errors.append("source page markers are missing")
    image_paths = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", content)
    for asset in image_paths:
        if re.match(r"(?:[a-z]+:|/)", asset, re.I):
            errors.append(f"image path must be relative: {asset}")
        elif not (root / asset).exists():
            errors.append(f"image asset is missing: {asset}")
    if re.search(r"[ \t]+$", content, re.M):
        warnings.append("trailing whitespace found")
    if "\n\n\n" in content:
        warnings.append("more than one blank line found")
    return {
        "profile": MARKDOWN_PROFILE,
        "schema_version": MARKDOWN_SCHEMA_VERSION,
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "heading_count": len(headings),
        "max_heading_level": max(map(len, headings)) if headings else 0,
        "image_count": len(image_paths),
        "source_page_markers": len(re.findall(r"^> \*\*PDF 原始页码：\*\* \d+$", content, re.M)),
        "frontmatter_keys": sorted(metadata_keys),
    }


def write_outputs(
    pdf: Path,
    info: dict,
    page_lines: dict[int, list[Line]],
    figures: list[Figure],
    tables: list[Table],
    repeated: set[str],
    output_dir: Path,
    dpi: int,
    engine: str,
) -> None:
    title = infer_document_title(pdf, page_lines.get(1, []))
    digest = hashlib.sha256(pdf.read_bytes()).hexdigest()
    processed_at = datetime.now().astimezone().isoformat(timespec="seconds")
    source_type = "mixed_pdf" if info["has_text_layer"] else "scanned_pdf"
    semantic_pages = {
        page: build_semantic_blocks(lines, figures, tables, page)
        for page, lines in sorted(page_lines.items())
    }
    reconcile_page_boundaries(semantic_pages)
    markdown_content = (
        markdown_frontmatter(title, pdf.name, digest[:16])
        + f"# {title}\n\n"
        + document_markdown(title, semantic_pages)
    )
    (output_dir / "document.md").write_text(markdown_content, encoding="utf-8")

    payload = {
        "schema_version": "1.1",
        "source": {"path": str(pdf), "sha256": digest, **info},
        "processing": {
            "generator": {"name": GENERATOR_NAME, "author": GENERATOR_AUTHOR},
            "processed_at": processed_at,
            "renderer": "poppler",
            "dpi": dpi,
            "ocr": engine,
            "languages": (
                ["zh-Hans", "en-US"] if engine == "vision"
                else ["zh", "en"] if engine == "paddleocr"
                else ["chi_sim", "eng"]
            ),
            "markdown_schema": MARKDOWN_SCHEMA_VERSION,
            "markdown_profile": MARKDOWN_PROFILE,
        },
        "repeated_margin_patterns": sorted(repeated),
        "figures": [asdict(f) for f in figures],
        "tables": [asdict(table) for table in tables],
        "pages": [
            {
                "page": page,
                "blocks": [asdict(line) for line in lines],
                "semantic_blocks": [asdict(block) for block in semantic_pages[page]],
            }
            for page, lines in sorted(page_lines.items())
        ],
    }
    (output_dir / "document.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    body_lines = [line for lines in page_lines.values() for line in lines if line.kind not in {"header_footer", "page_number", "figure_text", "table_text"}]
    low = [line for line in body_lines if line.confidence < 65]
    report = {
        "processing": {
            "generator": {"name": GENERATOR_NAME, "author": GENERATOR_AUTHOR},
            "processed_at": processed_at,
            "source_type": source_type,
            "ocr_engine": engine,
            "markdown_schema": MARKDOWN_SCHEMA_VERSION,
            "markdown_profile": MARKDOWN_PROFILE,
            "language": "zh-CN",
            "assets_path": "assets/",
        },
        "pages": info["pages"],
        "recognized_lines": len(body_lines),
        "average_confidence": round(sum(x.confidence for x in body_lines) / max(1, len(body_lines)), 2),
        "low_confidence_lines": len(low),
        "figures": len(figures),
        "tables": len(tables),
        "markdown_validation": validate_llm_wiki_markdown(markdown_content, output_dir),
        "low_confidence_samples": [asdict(x) for x in low[:100]],
    }
    (output_dir / "quality-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    from docx_exporter import export as export_docx
    export_docx(output_dir, output_dir / "document.docx", "editable")


def recognize_pages(
    pages: list[Path],
    ocr_dir: Path,
    engine: str,
    requested_engine: str,
    workers: int,
    lang: str,
    vision_executable: Path,
) -> tuple[dict[int, list[Line]], str]:
    """Run one OCR engine for the whole document, with clean auto fallback."""
    page_lines: dict[int, list[Line]] = {}
    if engine == "paddleocr":
        try:
            paddle_ocr = create_paddle_ocr()
            for image in pages:
                page, lines = ocr_one_paddle(image, ocr_dir, paddle_ocr)
                page_lines[page] = lines
                print(f"OCR page {page}/{len(pages)}: {len(lines)} lines", file=sys.stderr)
        except Exception as exc:
            if requested_engine != "auto":
                raise
            print(f"PaddleOCR 不可用，自动回退 Tesseract：{exc}", file=sys.stderr)
            engine = "tesseract"
            require_tools(engine, lang)
            page_lines.clear()

    if engine in {"vision", "tesseract"}:
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            if engine == "vision":
                jobs = [pool.submit(ocr_one_vision, page, ocr_dir, vision_executable) for page in pages]
            else:
                jobs = [pool.submit(ocr_one, page, ocr_dir, lang) for page in pages]
            for job in as_completed(jobs):
                page, lines = job.result()
                page_lines[page] = lines
                print(f"OCR page {page}/{len(pages)}: {len(lines)} lines", file=sys.stderr)
    return page_lines, engine


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a PDF to LLM-ready Markdown")
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dpi", type=int, default=200)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--lang", default="chi_sim+eng")
    parser.add_argument("--engine", choices=["auto", "vision", "paddleocr", "tesseract"], default="auto")
    args = parser.parse_args()
    engine = args.engine
    vision_source = PROJECT_ROOT / "tools" / "vision_ocr.swift"
    vision_executable = PROJECT_ROOT / "build" / "vision_ocr"
    if engine == "auto":
        engine = select_auto_engine()
    if engine == "vision" and sys.platform != "darwin":
        raise SystemExit("Vision OCR 仅支持 macOS；Windows/Linux 请使用 --engine tesseract 或 auto。")
    require_tools(engine, args.lang)
    require_python_docx()
    pdf = args.pdf.expanduser().resolve()
    if not pdf.is_file():
        raise SystemExit(f"PDF not found: {pdf}")
    output = args.output.resolve()
    work = output / "debug"
    pages_dir, ocr_dir = work / "pages", work / "ocr"
    ocr_dir.mkdir(parents=True, exist_ok=True)

    info = pdf_info(pdf)
    pages = render_pages(pdf, pages_dir, args.dpi)
    if engine == "vision" and not vision_executable.exists():
        vision_executable.parent.mkdir(parents=True, exist_ok=True)
        run(["swiftc", str(vision_source), "-o", str(vision_executable)])
    page_lines, engine = recognize_pages(
        pages, ocr_dir, engine, args.engine, args.workers, args.lang, vision_executable
    )

    page_lines, figures, tables, repeated = process_layout(pages, page_lines, output)
    write_outputs(pdf, info, page_lines, figures, tables, repeated, output, args.dpi, engine)
    print(output / "document.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
