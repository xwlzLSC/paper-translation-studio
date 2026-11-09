"""Local-only PDF translation workbench."""

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import html
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from threading import Event, RLock, Thread, Timer
from urllib.parse import parse_qs, quote, unquote, urlsplit
from uuid import uuid4
import webbrowser

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))  # The portable interpreter uses a restricted ._pth.
import audit
import content_filter
import engine
import document_import
import document_search
import example
import providers
import scan

MAX_UPLOAD = 60 * 1024 * 1024
MAX_PAGES = 600
SOURCE_FILE = "source-upload"
ACTIVE = {"queued", "running"}
FILES = {
    "original": "original.pdf",
    "translated": "translated.pdf",
    "bilingual": "bilingual.pdf",
    "markdown": "parallel.md",
    "markdown_mono": "translated.md",
    "html": "bilingual.html",
    "word": "bilingual.doc",
}
TARGET_NAMES = {
    "zh": "简体中文", "zh-tw": "繁體中文", "en": "English",
    "ja": "日本語", "ko": "한국어", "fr": "Français", "de": "Deutsch", "es": "Español",
}
PDF_LOCK = RLock()
FORMULA_LABEL = "〔公式见 PDF〕"


class RequestError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def has_job_result(job):
    return job.get("has_result", job["state"] == "completed")


def pdf_module():
    try:
        import fitz
    except ModuleNotFoundError:
        sys.path.insert(0, str(engine.discover_pdf2zh() / "site-packages"))
        import fitz
    return fitz


def inspect_pdf_meta(path):
    fitz = pdf_module()
    try:
        with PDF_LOCK, fitz.open(path) as doc:
            if not doc.is_pdf or doc.needs_pass or not 1 <= len(doc) <= MAX_PAGES:
                raise RequestError(f"请选择未加密的 PDF，页数须在 1–{MAX_PAGES} 页之间。")
            dimensions = [[round(p.rect.width, 2), round(p.rect.height, 2)] for p in doc]
            if not all(math.isfinite(value) and 1 <= value <= 12_000 for size in dimensions for value in size):
                raise RequestError("PDF 中有无效或超大页面，请先缩放或重新导出文档。")
            raw_toc = doc.get_toc(simple=True) or []
            toc = []
            for item in raw_toc[:300]:
                if len(item) >= 3:
                    level, title, page_num = int(item[0]), str(item[1]).strip(), int(item[2])
                    if title and 1 <= page_num <= len(doc):
                        toc.append({"level": max(1, min(4, level)), "title": title[:160], "page": page_num})
            return dimensions, toc
    except (fitz.FileDataError, fitz.EmptyFileError):
        raise RequestError("无法打开这个 PDF，请检查文件是否完整。") from None


def inspect_pdf(path):
    dimensions, _ = inspect_pdf_meta(path)
    return dimensions


def export_spread(original, translated, output, cancelled):
    fitz = pdf_module()
    with PDF_LOCK, fitz.open(original) as left, fitz.open(translated) as right, fitz.open() as result:
        if len(left) != len(right):
            raise RequestError("译文页数与原文不一致，未生成对照文件。")
        for i, (a, b) in enumerate(zip(left, right)):
            if cancelled():
                return
            gap = 12
            page = result.new_page(width=a.rect.width + gap + b.rect.width, height=max(a.rect.height, b.rect.height))
            if a.get_contents():
                page.show_pdf_page(fitz.Rect(0, 0, a.rect.width, a.rect.height), left, i)
            if b.get_contents():
                x = a.rect.width + gap
                page.show_pdf_page(fitz.Rect(x, 0, x + b.rect.width, b.rect.height), right, i)
        result.save(output, garbage=3, deflate=True)


def replace_pdf_pages(base, replacement, output, pages):
    """Keep the existing document and replace only the specified 1-based pages."""
    fitz = pdf_module()
    with PDF_LOCK, fitz.open(base) as doc, fitz.open(replacement) as new:
        if len(doc) != len(new):
            raise RequestError("合并失败：重试结果的页数与原文不一致。")
        toc = doc.get_toc()
        for page in sorted(pages):
            index = page - 1
            doc.delete_page(index)
            doc.insert_pdf(new, from_page=index, to_page=index, start_at=index)
        if toc:
            doc.set_toc(toc)
        doc.save(output, garbage=3, deflate=True)


def normalized_ignore_content(value):
    if (not isinstance(value, list) or len(value) > len(content_filter.TYPES)
            or any(not isinstance(kind, str) or kind not in content_filter.TYPES for kind in value)):
        raise RequestError("忽略翻译设置格式不正确。")
    return sorted(set(value))


def validate_options(options):
    for field in ("provider", "source_language", "target_language", "model", "api_key", "base_url", "pages", "glossary"):
        value = options.get(field, "")
        if not isinstance(value, str) or len(value) > 4096:
            raise RequestError("翻译设置格式不正确。")
    allowed = providers.CLI_PROVIDERS.keys() | providers.API_PRESETS.keys() | {providers.OFFLINE_PROVIDER}
    if options.get("provider", "codex") not in allowed:
        raise RequestError("请选择一个可用的翻译服务。")
    if type(options.get("ocr", True)) is not bool:
        raise RequestError("OCR 设置格式不正确。")
    normalized_ignore_content(options.get("ignore_content", []))
    if "auto_glossary" in options and type(options["auto_glossary"]) is not bool:
        raise RequestError("自动术语提取设置格式不正确。")
    if "concurrency" in options and options["concurrency"] is not None:
        try:
            c = int(options["concurrency"])
            if not 1 <= c <= 8:
                raise ValueError
        except (ValueError, TypeError):
            raise RequestError("并发线程数须在 1–8 之间。") from None


def paragraph_text(text, mode):
    return engine.PLACEHOLDER.sub(FORMULA_LABEL, text) if mode == "layout" else text


def text_revision(job):
    return job.get("text_revision") or job.get("result_id") or "legacy"


def restored_translation(original, translation, raw_translation, cached):
    """Recover the identifiers hidden by the reader's generic formula labels."""
    formulas = engine.FORMULA_ONLY.findall(original)
    if not formulas:
        return translation
    if translation.count(FORMULA_LABEL) != len(formulas):
        return None
    if raw_translation is not None:
        order = engine.FORMULA_ONLY.findall(raw_translation)
    elif len(formulas) == 1:
        order = formulas
    else:
        matches = {
            candidate for candidate in cached.get(translation, ())
            if Counter(engine.FORMULA_ONLY.findall(candidate)) == Counter(formulas)
        }
        return next(iter(matches)) if len(matches) == 1 else None
    if Counter(order) != Counter(formulas):
        return None
    tokens = iter(order)
    return re.sub(re.escape(FORMULA_LABEL), lambda _: next(tokens), translation)


def verify_paragraph_pdf(path, page, translation, mode):
    with PDF_LOCK, pdf_module().open(path) as doc:
        rendered = document_search.normalize(doc[page - 1].get_text()).replace(" ", "")
    pieces = engine.FORMULA_ONLY.split(translation) if mode == "layout" else [translation]
    if any(document_search.normalize(piece).replace(" ", "") not in rendered for piece in pieces):
        raise engine.EngineError("本页的排版未能完整容纳这段译文，请调整文字后再写回。")


def _clean_md(value: str) -> str:
    text = str(value).replace("\r\n", "\n").strip()
    return re.sub(r"^(\s*)#", r"\1\\#", text, flags=re.MULTILINE)


def write_text_outputs(name, segments, json_path, markdown_path, folder=None):
    title = Path(name).stem
    sorted_pages = sorted(segments.items(), key=lambda item: int(item[0]))
    if json_path:
        json_path.write_text(json.dumps(segments, ensure_ascii=False), encoding="utf-8")
    if markdown_path:
        with markdown_path.open("w", encoding="utf-8") as output:
            output.write(f"# {_clean_md(title)}\n\n")
            output.write("> 由「论文译读」生成 · 图表与复杂公式请参见双语 PDF。\n\n")
            for page, entry in sorted_pages:
                if not entry.get("pairs"):
                    continue
                label = "（OCR）" if entry.get("mode") == "ocr" else ""
                output.write(f"## 第 {page} 页{label}\n\n")
                for original, translation in entry["pairs"]:
                    output.write(f"**原文**\n\n{_clean_md(original)}\n\n**译文**\n\n{_clean_md(translation)}\n\n---\n\n")

    if folder is not None:
        folder = Path(folder)
        mono_md = folder / FILES["markdown_mono"]
        html_path = folder / FILES["html"]
        word_path = folder / FILES["word"]

        with mono_md.open("w", encoding="utf-8") as out:
            out.write(f"# {_clean_md(title)}（译文）\n\n")
            for page, entry in sorted_pages:
                if not entry.get("pairs"):
                    continue
                label = "（OCR）" if entry.get("mode") == "ocr" else ""
                out.write(f"## 第 {page} 页{label}\n\n")
                for _, translation in entry["pairs"]:
                    out.write(f"{_clean_md(translation)}\n\n")

        rows_html = []
        for page, entry in sorted_pages:
            if not entry.get("pairs"):
                continue
            label = " · OCR 识别" if entry.get("mode") == "ocr" else ""
            rows_html.append(f'<div class="page-sep">第 {html.escape(str(page))} 页{label}</div>')
            for idx, (orig, trans) in enumerate(entry["pairs"], 1):
                rows_html.append(
                    f'<div class="pair"><div class="col orig"><span class="idx">P{html.escape(str(page))}.{idx}</span>'
                    f'<p>{html.escape(orig)}</p></div>'
                    f'<div class="col trans"><span class="idx">译文</span><p>{html.escape(trans)}</p></div></div>'
                )
        html_doc = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)} - 双语对照</title>
<style>
body{{margin:0;background:#f4f6f3;color:#182e2c;font:15px/1.75 system-ui,-apple-system,"Microsoft YaHei UI",sans-serif}}
header{{background:#126958;color:#fff;padding:22px 32px}}header h1{{margin:0;font-size:20px}}header p{{margin:6px 0 0;opacity:.85;font-size:13px}}
main{{max-width:1360px;margin:20px auto 48px;padding:0 20px}}
.page-sep{{font-weight:700;color:#126958;margin:24px 0 10px;padding-bottom:6px;border-bottom:2px solid #d5e0d7;font-size:14px}}
.pair{{display:grid;grid-template-columns:1fr 1fr;background:#fff;border:1px solid #d9e1d9;border-radius:10px;margin-bottom:10px;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,.03)}}
.col{{padding:14px 18px}}.col.trans{{background:#fbfdf9;border-left:1px solid #d9e1d9}}
.idx{{display:inline-block;font-size:11px;color:#526360;font-weight:600;margin-bottom:4px}}
p{{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}}
@media(max-width:760px){{.pair{{grid-template-columns:1fr}}.col.trans{{border-left:0;border-top:1px solid #d9e1d9}}}}
</style></head><body>
<header><h1>{html.escape(title)}</h1><p>论文译读 · 左右双语逐段对照导出</p></header>
<main>{"".join(rows_html)}</main></body></html>"""
        html_path.write_text(html_doc, encoding="utf-8")

        word_rows = []
        for page, entry in sorted_pages:
            if not entry.get("pairs"):
                continue
            label = "（OCR）" if entry.get("mode") == "ocr" else ""
            word_rows.append(
                f'<tr><td colspan="2" style="background:#e7f2ec;font-weight:bold;padding:8pt;color:#126958">'
                f'第 {html.escape(str(page))} 页{label}</td></tr>'
            )
            for orig, trans in entry["pairs"]:
                word_rows.append(
                    f'<tr><td style="width:50%;vertical-align:top;padding:8pt;border:1px solid #cbd8cf">{html.escape(orig)}</td>'
                    f'<td style="width:50%;vertical-align:top;padding:8pt;border:1px solid #cbd8cf;background:#fbfdf9">{html.escape(trans)}</td></tr>'
                )
        word_doc = f"""<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>{html.escape(title)}</title></head>
<body style="font-family:'Microsoft YaHei',SimSun,sans-serif;font-size:11pt;line-height:1.6">
<h1 style="color:#126958">{html.escape(title)}（双语对照）</h1>
<table style="width:100%;border-collapse:collapse;border:1px solid #cbd8cf">{"".join(word_rows)}</table>
</body></html>"""
        word_path.write_text(word_doc, encoding="utf-8")


def write_example(path, translated=False):
    with PDF_LOCK:
        example.write(pdf_module(), path, translated=translated)


class Workbench:
    def __init__(self, data, default_provider="magpie"):
        self.data = data.resolve()
        self.default_provider = default_provider
        self.data.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        self.jobs = {}
        self.cancelled = {}
        self.rewriting = set()
        self.settings_file = self.data / "settings.json"
        self.search_index = document_search.SearchIndex()
        self.cache_file = self.data / "translation_cache.json"
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="translation")
        for manifest in self.data.glob("*/job.json"):
            try:
                job = json.loads(manifest.read_text(encoding="utf-8"))
                if job["id"] != manifest.parent.name or not re.fullmatch(r"[a-f0-9]{32}", job["id"]):
                    continue
                if "has_result" not in job:
                    job["has_result"] = (self.result_dir(job) / FILES["translated"]).is_file()
                self.jobs[job["id"]] = job
                if job["state"] in ACTIVE:
                    self.update(job, state="completed" if job["has_result"] else "failed",
                                message="上次任务因服务关闭而中断。", error="上次任务因服务关闭而中断。")
                if job["state"] in {"completed", "failed"} and "failed_pages" not in job:
                    self.update(job, failed_pages=self.find_failed_pages(job))
            except (ValueError, OSError, KeyError, TypeError):
                continue

    def dir(self, job):
        return self.data / job["id"]

    def result_dir(self, job):
        version = job.get("result_id")
        folder = self.dir(job)
        return folder / f"result-{version}" if isinstance(version, str) and re.fullmatch(r"[a-f0-9]{32}", version) else folder

    def read_segments(self, job):
        with self.lock:
            path = self.result_dir(job) / "segments.json"
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return {}

    def _get_paragraph(self, job, page, segment, revision=None):
        current = self.jobs.get(job["id"])
        if current is None:
            raise RequestError("找不到这个任务。", 404)
        if revision is not None and revision != text_revision(current):
            raise RequestError("译文已更新，请重新打开这个段落。", 409)
        segments = self.read_segments(current)
        entry = segments.get(str(page))
        if (not has_job_result(current) or not entry or page in (current.get("failed_pages") or ())
                or not 0 <= segment < len(entry["pairs"])):
            raise RequestError("该页没有这个双语段落。", 404)
        return current, segments, entry

    def _require_editable(self, job):
        if job["state"] in ACTIVE or job["id"] in self.rewriting:
            raise RequestError("请等当前翻译或回写结束后再编辑译文。", 409)

    def _review_languages(self, job):
        if job.get("provider") == "demo":
            return "en", "zh"
        saved = job.get("retry_settings") or {}
        source = saved.get("source_language") or job.get("source_language") or self.get_settings()["source_language"]
        label = job.get("target_language")
        target = saved.get("target_language") or next(
            (code for code, name in TARGET_NAMES.items() if label in (code, name)), "zh"
        )
        return source, target

    def _review_sources(self, job, page, entry):
        raw_pairs = entry.get("raw_pairs")
        if raw_pairs is not None:
            sources = [left for left, _ in raw_pairs]
        elif entry["mode"] == "ocr" or job.get("provider") == "demo":
            sources = [left for left, _ in entry["pairs"]]
        else:
            source, target = self._review_languages(job)
            ignored = tuple((job.get("retry_settings") or {}).get("ignore_content", ()))
            mode, sources = engine.read_page_paragraphs(self.dir(job) / FILES["original"], page, source, target, ignored)
            if mode != entry["mode"]:
                raise engine.EngineError("当前识别方式与保存的译文不一致。")
        if [paragraph_text(text, entry["mode"]) for text in sources] != [left for left, _ in entry["pairs"]]:
            raise engine.EngineError("保存的段落与原文版面未能对齐。")
        return sources

    def _review_targets(self, entry, sources):
        raw_pairs = entry.get("raw_pairs")
        if raw_pairs is not None:
            return [right for _, right in raw_pairs]
        shown = [right for _, right in entry.get("pdf_pairs", entry["pairs"])]
        if entry["mode"] != "layout":
            return shown
        cached = defaultdict(list)
        if any(len(engine.FORMULA_ONLY.findall(text)) > 1 for text in sources):
            try:
                values = json.loads(self.cache_file.read_text(encoding="utf-8"))
                if isinstance(values, dict):
                    for value in values.values():
                        if isinstance(value, str):
                            cached[paragraph_text(value, "layout")].append(value)
            except (OSError, ValueError):
                pass
        return [
            restored_translation(source, translation, None, cached)
            for source, translation in zip(sources, shown)
        ]

    def paragraph_review(self, job, page, segment):
        with self.lock:
            current, _, entry = self._get_paragraph(job, page, segment)
            self._require_editable(current)
            snapshot = current.copy()
        original, translation = entry["pairs"][segment]
        result = {"source": original, "current": translation, "draft": translation,
                  "revision": text_revision(snapshot), "pdf_error": ""}
        try:
            sources = self._review_sources(snapshot, page, entry)
            targets = self._review_targets(entry, sources)
            source = sources[segment]
            draft = translation
            if entry["mode"] == "layout":
                draft = restored_translation(source, translation, targets[segment], {}) or translation
            result.update(source=source, draft=draft)
            result["has_formulas"] = entry["mode"] == "layout" and bool(engine.FORMULA_ONLY.search(source))
            missing = next((i for i, value in enumerate(targets) if i != segment and value is None), None)
            if missing is not None:
                result["pdf_error"] = f"本页第 {missing + 1} 段缺少可核对的公式编号。"
        except (engine.EngineError, OSError) as exc:
            result["pdf_error"] = str(exc) if isinstance(exc, engine.EngineError) else "无法读取该页的原文。"
            result["source_unavailable"] = True
        return result

    def retranslate_paragraph(self, job, page, segment, body):
        with self.lock:
            current, _, entry = self._get_paragraph(job, page, segment, body.get("revision") or "")
            self._require_editable(current)
            snapshot = current.copy()
        source_language, target_language = self._review_languages(snapshot)
        original = self._review_sources(snapshot, page, entry)[segment]
        options = self.resolve_options({
            **body, "source_language": source_language, "target_language": target_language,
        })
        validate_options(options)
        provider = providers.make_provider(options)
        translated = provider.translate([original], target_language)
        if not isinstance(translated, (list, tuple)) or len(translated) != 1:
            raise providers.OutputError("重译返回的段落数量不匹配。")
        return {"draft": engine._validate_text(original, translated[0])}

    def save_paragraph(self, job, page, segment, body):
        translation = body.get("translation")
        write_pdf = body.get("write_pdf", True)
        if (not isinstance(translation, str) or not translation.strip() or len(translation) > 12000
                or type(write_pdf) is not bool):
            raise RequestError("请输入 1 至 12000 个字符的译文。")
        with self.lock:
            current, segments, entry = self._get_paragraph(job, page, segment, body.get("revision") or "")
            self._require_editable(current)
            if not write_pdf:
                drafts = [right for _, right in entry["pairs"]]
                drafts[segment] = paragraph_text(translation, entry["mode"])
                self.update_page_segments(current, page, drafts)
                return current.copy()
            snapshot = current.copy()
            self.rewriting.add(current["id"])
        try:
            return self._write_paragraph_pdf(current, snapshot, segments, entry, page, segment, translation)
        finally:
            with self.lock:
                self.rewriting.discard(current["id"])

    def _write_paragraph_pdf(self, job, snapshot, segments, entry, page, segment, translation):
        folder = self.dir(snapshot).resolve()
        if folder.parent != self.data:
            raise RequestError("任务目录不正确。")
        original = folder / FILES["original"]
        sources = self._review_sources(snapshot, page, entry)
        targets = self._review_targets(entry, sources)
        targets[segment] = engine._validate_text(sources[segment], translation)
        if None in targets:
            raise engine.EngineError(f"本页第 {targets.index(None) + 1} 段缺少可核对的公式编号。")
        targets = [engine._validate_text(left, right) for left, right in zip(sources, targets)]
        version = uuid4().hex
        result = folder / f"result-{version}"
        result.mkdir()
        pending = result / "pending.pdf"
        translated = result / FILES["translated"]
        published = False
        try:
            if snapshot.get("provider") == "demo":
                with PDF_LOCK:
                    example.write(pdf_module(), pending, translated=True, replaced_page=page, replacements=targets)
            else:
                def replay(number, mode, texts):
                    if number != page or mode != entry["mode"] or list(texts) != list(sources):
                        raise engine.EngineError("原文段落已变化，请重新打开本页。")
                    return targets

                source_language, target_language = self._review_languages(snapshot)
                ignored = (snapshot.get("retry_settings") or {}).get("ignore_content", ())
                engine.translate_pdf(
                    original, pending, None, pages=str(page), concurrency=1,
                    source_language=source_language, target_language=target_language, replay_page=replay,
                    ignore_content=ignored,
                )
            verify_paragraph_pdf(pending, page, targets[segment], entry["mode"])
            replace_pdf_pages(self.result_dir(snapshot) / FILES["translated"], pending, translated, [page])
            pending.unlink()
            export_spread(original, translated, result / FILES["bilingual"], lambda: False)
            entry["pairs"][segment][1] = paragraph_text(targets[segment], entry["mode"])
            entry["raw_pairs"] = list(zip(sources, targets))
            entry.pop("pdf_pairs", None)
            write_text_outputs(snapshot["name"], segments, result / "segments.json", result / FILES["markdown"], result)
            with self.lock:
                self.update(job, result_id=version, text_revision=version, message=f"第 {page} 页译文已写回 PDF")
                published = True
                return job.copy()
        finally:
            if not published and result.resolve().parent == folder:
                shutil.rmtree(result, ignore_errors=True)

    def read_notes(self, job):
        with self.lock:
            try:
                return json.loads((self.dir(job) / "notes.json").read_text(encoding="utf-8"))
            except FileNotFoundError:
                return []

    def change_note(self, job, note_id=None, body=None):
        with self.lock:
            if self.jobs.get(job["id"]) is not job:
                raise RequestError("找不到这个任务。", 404)
            notes = self.read_notes(job)
            note = next((item for item in notes if item["id"] == note_id), None)
            if note_id and note is None:
                raise RequestError("找不到这条笔记。", 404)
            if body is None:
                notes.remove(note)
            else:
                comment = body.get("comment", "")
                if not isinstance(comment, str) or len(comment) > 4000:
                    raise RequestError("笔记正文最多 4000 字。")
                if note is None:
                    page, segment = body.get("page"), body.get("segment")
                    if type(page) is not int or type(segment) is not int:
                        raise RequestError("笔记的段落位置无效。")
                    _, _, entry = self._get_paragraph(job, page, segment, body.get("revision") or "")
                    original, translation = entry["pairs"][segment]
                    note = {"id": uuid4().hex, "page": page, "segment": segment,
                            "original": original, "translation": translation, "created_at": timestamp()}
                    notes.insert(0, note)
                note["comment"] = comment.strip()
            path = self.dir(job) / "notes.json"
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(notes, ensure_ascii=False), encoding="utf-8")
            temporary.replace(path)
            return note

    def get_settings(self) -> dict:
        defaults = {
            "active_provider": self.default_provider,
            "source_language": "en",
            "target_language": "zh",
            "concurrency": 4,
            "ocr": True,
            "ignore_content": [],
            "auto_glossary": False,
            "glossary": "",
            "profiles": {},
        }
        with self.lock:
            if self.settings_file.is_file():
                try:
                    loaded = json.loads(self.settings_file.read_text(encoding="utf-8"))
                    if isinstance(loaded, dict):
                        defaults.update({k: v for k, v in loaded.items() if k in defaults})
                except (OSError, ValueError):
                    pass
        return defaults

    def save_settings(self, incoming: dict) -> dict:
        with self.lock:
            current = self.get_settings()
            for key in ("active_provider", "source_language", "target_language", "glossary"):
                if isinstance(incoming.get(key), str) and len(incoming[key]) <= 4096:
                    current[key] = incoming[key].strip() if key != "glossary" else incoming[key]
            if isinstance(incoming.get("ocr"), bool):
                current["ocr"] = incoming["ocr"]
            if "ignore_content" in incoming:
                current["ignore_content"] = normalized_ignore_content(incoming["ignore_content"])
            if isinstance(incoming.get("auto_glossary"), bool):
                current["auto_glossary"] = incoming["auto_glossary"]
            if "concurrency" in incoming:
                try:
                    current["concurrency"] = max(1, min(8, int(incoming["concurrency"])))
                except (ValueError, TypeError):
                    pass
            profiles = dict(current.get("profiles") or {})
            if isinstance(incoming.get("profiles"), dict):
                for p_name, p_val in incoming["profiles"].items():
                    if isinstance(p_name, str) and isinstance(p_val, dict):
                        entry = dict(profiles.get(p_name) or {})
                        for field in ("base_url", "api_key", "model"):
                            if isinstance(p_val.get(field), str) and len(p_val[field]) <= 1024:
                                entry[field] = p_val[field].strip()
                        profiles[p_name] = entry
            provider = incoming.get("provider")
            if isinstance(provider, str) and provider:
                current["active_provider"] = provider
                entry = dict(profiles.get(provider) or {})
                for field in ("base_url", "api_key", "model"):
                    if isinstance(incoming.get(field), str) and len(incoming[field]) <= 1024:
                        if field != "api_key" or incoming[field].strip():
                            entry[field] = incoming[field].strip()
                profiles[provider] = entry
            current["profiles"] = profiles
            try:
                tmp = self.settings_file.with_suffix(".tmp")
                tmp.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
                tmp.replace(self.settings_file)
            except OSError:
                pass
            return current

    def resolve_options(self, options: dict) -> dict:
        merged = dict(options)
        saved = self.get_settings()
        provider = merged.get("provider") or saved.get("active_provider") or "codex"
        merged["provider"] = provider
        merged.setdefault("ignore_content", saved["ignore_content"])
        profile = (saved.get("profiles") or {}).get(provider) or {}
        for field in ("base_url", "api_key", "model"):
            if field not in merged and profile.get(field):
                merged[field] = profile[field]
        return merged

    def update(self, job, *, persist=True, **changes):
        with self.lock:
            changes["updated_at"] = timestamp()
            if persist:
                folder = self.dir(job)
                tmp = folder / "job.tmp"
                tmp.write_text(json.dumps({**job, **changes}, ensure_ascii=False), encoding="utf-8")
                tmp.replace(folder / "job.json")
            job.update(changes)

    def get(self, job_id):
        with self.lock:
            if job_id not in self.jobs:
                raise RequestError("找不到这个任务。", 404)
            job = self.jobs[job_id]
            if "toc" not in job:
                try:
                    _, toc = inspect_pdf_meta(self.dir(job) / "original.pdf")
                    self.update(job, toc=toc)
                except Exception:
                    job["toc"] = []
            return job

    def add(self, name, write_original, write_translation=None, segments=None, source_format="pdf"):
        job_id = uuid4().hex
        folder = self.data / job_id
        folder.mkdir()
        try:
            original = folder / "original.pdf"
            if source_format == "pdf":
                write_original(original)
            else:
                source = folder / SOURCE_FILE
                write_original(source)
                with PDF_LOCK:
                    document_import.convert(pdf_module(), source, source_format, original, MAX_PAGES)
            dimensions, toc = inspect_pdf_meta(original)
            if write_translation:
                translated = folder / "translated.pdf"
                write_translation(translated)
                export_spread(original, translated, folder / "bilingual.pdf", lambda: False)
                write_text_outputs(name, segments, folder / "segments.json", folder / FILES["markdown"], folder)
            job = dict(
                id=job_id, name=name, source_format=source_format, pages=len(dimensions), dimensions=dimensions, toc=toc,
                state="completed" if write_translation else "uploaded",
                progress=1 if write_translation else 0,
                message="样例已就绪" if write_translation else "原文已就绪", error="",
                provider="demo" if write_translation else "",
                created_at=timestamp(), page_range="", demo=bool(write_translation),
                has_text=bool(segments), has_result=bool(write_translation), ocr_pages=[], failed_pages=[],
            )
            with self.lock:
                self.update(job)
                self.jobs[job_id] = job
            return job.copy()
        except BaseException:
            shutil.rmtree(folder, ignore_errors=True)
            raise

    def start(self, job, raw_options):
        options = self.resolve_options(raw_options)
        validate_options(options)
        pages = re.sub(r"\s+", "", options.get("pages", "").strip().replace("，", ",").replace("—", "-").replace("–", "-"))
        selected = engine._pages(pages, job["pages"])
        selected = list(range(1, job["pages"] + 1)) if selected is None else [index + 1 for index in selected]
        return self.queue_translation(job, options, selected, pages)

    def queue_translation(self, job, options, selected, page_range, *, retry=False):
        with self.lock:
            if self.jobs.get(job["id"]) is not job:
                raise RequestError("找不到这个任务。", 404)
            if job["state"] in ACTIVE or job["id"] in self.rewriting:
                raise RequestError("这个任务已在队列中。", 409)
            provider = options["provider"]
            target = options.get("target_language", "zh")
            source = options.get("source_language") or "en"
            if target not in TARGET_NAMES:
                raise RequestError("目标语言不受支持。")
            if not re.fullmatch(r"[a-zA-Z-]{2,12}", source):
                raise RequestError("源语言格式不正确。")
            if source.lower() == target:
                raise RequestError("请选择不同的原文与译文语言。")
            default_workers = 1 if provider in providers.CLI_PROVIDERS else 4
            offline = provider == providers.OFFLINE_PROVIDER
            concurrency = 1 if offline else max(1, min(8, int(options.get("concurrency") or default_workers)))
            auto_glossary = not offline and bool(options.get("auto_glossary", False))
            stop = Event()
            client = providers.make_provider(options, cancelled=stop.is_set)
            settings = {"source_language": source, "target_language": target, "ocr": options.get("ocr", True),
                        "glossary": options.get("glossary", ""),
                        "ignore_content": normalized_ignore_content(options.get("ignore_content", []))}
            if not retry:
                self.save_settings(options)
            had_result = bool(has_job_result(job))
            changes = {"has_result": had_result}
            if not had_result:
                changes.update(page_range=page_range, failed_pages=selected, retry_settings=settings, provider=provider)
            self.update(job, state="queued", progress=0, message="等待重试失败页" if retry else "等待翻译",
                        error="", usage={}, **changes)
            self.cancelled[job["id"]] = stop
            self.worker.submit(self.run, job, client, provider, settings, selected, page_range,
                               concurrency, auto_glossary, stop, retry=retry)
            return job.copy()

    def run(self, job, provider, provider_name, settings, selected, page_range,
            concurrency, auto_glossary, stop, *, retry=False):
        def get_usage():
            fn = getattr(provider, "get_usage_summary", None)
            return fn() if callable(fn) else {}

        def safe_error(message):
            key = getattr(provider, "key", None)
            return (message.replace(key, "[已隐藏]") if key else message)[:300]

        def progress(fraction, message):
            self.update(job, persist=False, progress=max(0, min(0.94, float(fraction) * 0.94)), message=str(message), usage=get_usage())

        new_segments = {}
        preserved = set()
        failures = {}

        def collect(page, mode, pairs):
            entry = new_segments.setdefault(str(page), {"mode": mode, "pairs": []})
            entry["pairs"].extend((paragraph_text(left, mode), paragraph_text(right, mode)) for left, right in pairs)
            entry.setdefault("raw_pairs", []).extend(pairs)

        def page_failed(page, message):
            failures[page] = safe_error(message)

        previous = job.copy()
        had_result = previous["has_result"]
        version = uuid4().hex
        folder = self.dir(job).resolve()
        result = folder / f"result-{version}"
        original = folder / FILES["original"]
        pending = result / "pending.pdf"
        translated = result / FILES["translated"]
        published = False
        try:
            if stop.is_set():
                return
            if folder.parent != self.data:
                raise RequestError("任务目录不正确。")
            result.mkdir()
            self.update(job, state="running", message="正在重试失败页…" if retry else "正在读取版面与正文…")
            pages = ",".join(map(str, selected)) if retry else (page_range or None)
            engine.translate_pdf(
                original, pending, provider,
                source_language=settings["source_language"], target_language=settings["target_language"], pages=pages,
                ocr=settings["ocr"], concurrency=concurrency, auto_glossary=auto_glossary, cache_path=self.cache_file,
                progress=progress, cancelled=stop.is_set, on_segments=collect, on_page_error=page_failed,
                ignore_content=settings["ignore_content"], on_preserved=preserved.add,
                image_document=previous.get("source_format") in document_import.IMAGE_FORMATS,
            )
            if stop.is_set():
                return
            for page in failures:
                new_segments.pop(str(page), None)
            if not new_segments and not preserved:
                raise engine.EngineError(next(iter(failures.values()), "所选页面没有可翻译的正文。"))
            if retry and had_result:
                segments = self.read_segments(previous)
                segments.update(new_segments)
                successful_pages = {int(page) for page in new_segments} | preserved
                replace_pdf_pages(self.result_dir(previous) / FILES["translated"], pending, translated, successful_pages)
                preserved.update(previous.get("preserved_pages") or ())
            else:
                segments = new_segments
                if failures:
                    replace_pdf_pages(pending, original, translated, failures)
                else:
                    pending.replace(translated)
            pending.unlink(missing_ok=True)
            progress(1, "正在生成对照 PDF 与导出文档…")
            export_spread(original, translated, result / FILES["bilingual"], stop.is_set)
            if stop.is_set():
                return
            write_text_outputs(job["name"], segments, result / "segments.json", result / FILES["markdown"], result)
            with self.lock:
                if not stop.is_set():
                    message = f"部分完成，{len(failures)} 页可重试" if failures else ("重试完成" if retry else "翻译完成")
                    if preserved:
                        message += f" · {len(preserved)} 页保留原文"
                    self.update(
                        job, state="completed", progress=1, message=message, error="",
                        has_result=True, has_text=bool(segments), result_id=version, text_revision=version,
                        provider=provider_name, page_range=page_range, retry_settings=settings,
                        target_language=TARGET_NAMES[settings["target_language"]],
                        failed_pages=sorted(failures), page_errors={str(page): msg for page, msg in failures.items()},
                        preserved_pages=sorted(preserved),
                        usage=get_usage(),
                        ocr_pages=sorted(int(page) for page, entry in segments.items() if entry["mode"] == "ocr"),
                    )
                    published = True
        except Exception as exc:
            if not stop.is_set():
                message = str(exc) if isinstance(exc, (RequestError, engine.EngineError, providers.ProviderError)) else f"处理 PDF 时发生错误（{type(exc).__name__}）。"
                changes = {}
                if not had_result or retry:
                    changes.update(failed_pages=selected, page_errors={str(page): failures.get(page, safe_error(message)) for page in selected})
                self.update(job, state="completed" if had_result else "failed",
                            message="重试未完成" if retry else "翻译未完成", error=safe_error(message), **changes)
        finally:
            with self.lock:
                if not published and result.is_dir() and result.resolve().parent == folder:
                    shutil.rmtree(result, ignore_errors=True)
                if stop.is_set() and job["state"] in ACTIVE:
                    self.update(job, state="completed" if had_result else "cancelled", message="已取消", error="")
                if self.cancelled.get(job["id"]) is stop:
                    self.cancelled.pop(job["id"], None)

    def update_page_segments(self, job, page_num: int, pairs: list):
        with self.lock:
            if self.jobs.get(job["id"]) is not job:
                raise RequestError("找不到这个任务。", 404)
            self._require_editable(job)
            if not has_job_result(job) or not job.get("has_text"):
                raise RequestError("当前任务尚无译文段落可编辑。", 400)
            folder = self.result_dir(job)
            seg_path = folder / "segments.json"
            if not seg_path.is_file():
                raise RequestError("找不到段落文件。", 404)
            segments = json.loads(seg_path.read_text(encoding="utf-8"))
            key = str(page_num)
            entry = segments.get(key)
            if not entry or not isinstance(entry.get("pairs"), list):
                raise RequestError("该页没有可编辑的段落。", 404)
            if not isinstance(pairs, list) or len(pairs) != len(entry["pairs"]):
                raise RequestError("段落数量不匹配。")
            cleaned = []
            for (old_orig, _), item in zip(entry["pairs"], pairs):
                if isinstance(item, (list, tuple)) and len(item) == 2:
                    new_trans = str(item[1]).strip()
                elif isinstance(item, str):
                    new_trans = item.strip()
                else:
                    raise RequestError("段落内容格式不正确。")
                if not new_trans:
                    raise RequestError("译文段落不能为空。")
                cleaned.append([old_orig, new_trans])
            if "raw_pairs" not in entry:
                entry.setdefault("pdf_pairs", entry["pairs"])
            entry["pairs"] = cleaned
            segments[key] = entry
            write_text_outputs(job["name"], segments, seg_path, folder / FILES["markdown"], folder)
            self.update(job, text_revision=uuid4().hex)
            return entry

    def cancel(self, job):
        with self.lock:
            if job["state"] in ACTIVE:
                self.cancelled[job["id"]].set()
                self.update(job, persist=False, message="正在取消…")
            return job.copy()

    def find_failed_pages(self, job) -> list[int]:
        recorded = job.get("failed_pages")
        total = job["pages"]
        if isinstance(recorded, list):
            return sorted({page for page in recorded if type(page) is int and 1 <= page <= total})
        state = job["state"]
        if state not in {"failed", "completed"}:
            return []

        try:
            selected = engine._pages(job.get("page_range"), total)
        except engine.EngineError:
            selected = None
        target = list(range(1, total + 1)) if selected is None else [i + 1 for i in selected]
        if not has_job_result(job):
            return target if state == "failed" else []
        # Old jobs did not record failures. Only infer them where a saved result
        # also has paragraph data to distinguish the translated pages.
        try:
            segments = self.read_segments(job)
        except (OSError, ValueError):
            return []
        if not segments:
            return []
        failed = []
        for page in target:
            pairs = segments.get(str(page), {}).get("pairs") or []
            if not pairs:
                if state == "failed":
                    failed.append(page)
            elif any(len(pair) < 2 or not isinstance(pair[1], str) or not pair[1].strip()
                     or pair[1].startswith("[翻译失败]") for pair in pairs):
                failed.append(page)
        return failed

    def retry_failed(self, job, raw_options=None):
        with self.lock:
            if self.jobs.get(job["id"]) is not job:
                raise RequestError("找不到这个任务。", 404)
            if job["state"] in ACTIVE:
                raise RequestError("这个任务已在进行中。", 409)
            failed_pages = self.find_failed_pages(job)
            if not failed_pages:
                raise RequestError("当前没有记录到失败页。")

            saved = self.get_settings()
            settings = job.get("retry_settings") or {}
            previous_target = next((code for code, label in TARGET_NAMES.items() if label == job.get("target_language")), None)
            options = {
                "provider": job.get("provider") or saved["active_provider"],
                "source_language": settings.get("source_language") or saved["source_language"],
                "target_language": settings.get("target_language") or previous_target or saved["target_language"],
                "glossary": settings.get("glossary", saved["glossary"]),
                "ocr": settings.get("ocr", saved["ocr"]),
                "ignore_content": settings.get("ignore_content", []),
                "concurrency": saved["concurrency"],
            }
            for field in ("provider", "base_url", "api_key", "model", "ocr", "concurrency"):
                if field in (raw_options or {}):
                    options[field] = raw_options[field]
            options = self.resolve_options(options)
            validate_options(options)
            return self.queue_translation(job, options, failed_pages, job.get("page_range", ""), retry=True)

    def delete(self, job):
        with self.lock:
            if job["state"] in ACTIVE or job["id"] in self.cancelled or job["id"] in self.rewriting:
                raise RequestError("请等待任务停止后再删除。", 409)
            folder = self.dir(job).resolve()
            if folder.parent != self.data or not re.fullmatch(r"[a-f0-9]{32}", folder.name):
                raise RequestError("任务目录不正确。")
            shutil.rmtree(folder)
            del self.jobs[job["id"]]

    def demo(self):
        with self.lock:
            existing = next((job for job in self.jobs.values() if job.get("demo") and job.get("has_text")
                             and job["state"] == "completed"), None)
            if existing:
                if "toc" not in existing:
                    self.get(existing["id"])
                return existing.copy()
            return self.add(example.NAME, write_example,
                            lambda p: write_example(p, translated=True), example.SEGMENTS)

    def status(self):
        try:
            build = engine.discover_pdf2zh()
            has_ocr = scan.available(build)
            engine_status = {"ok": True, "message": "PDF2zh 版面引擎已就绪"}
        except engine.EngineError as exc:
            has_ocr = False
            engine_status = {"ok": False, "message": str(exc)}
        provider_status = {
            key: providers.check_provider({"provider": key})
            for key in ("magpie", "codex", "antigravity", providers.OFFLINE_PROVIDER)
        }
        return {
            "engine": engine_status,
            "providers": provider_status,
            "presets": providers.API_PRESETS,
            "ocr": has_ocr,
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "PaperStudio/2.0"

    @property
    def app(self):
        return self.server.app

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def _cors_headers(self):
        if getattr(self.server, "allow_lan", False):
            origin = self.headers.get("Origin") or "*"
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Local-Request, X-Filename")

    def dispatch(self, method):
        try:
            allow_lan = getattr(self.server, "allow_lan", False)
            allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            host = self.headers.get("Host", "")
            if not allow_lan and host not in allowed:
                raise RequestError("此工具仅接受本机访问。", 403)
            if method != "GET":
                if self.headers.get("X-Local-Request") != "1":
                    raise RequestError("请从本地工作台操作。", 403)
                if not allow_lan and self.headers.get("Origin", f"http://{host}") != f"http://{host}":
                    raise RequestError("请从本地工作台操作。", 403)
            url = urlsplit(self.path)
            path = url.path
            static_routes = {
                "/", "/index.html", "/sw.js", "/manifest.webmanifest",
                "/static/style.css", "/static/app.js", "/static/layout.css", "/static/layout.js",
                "/static/mobile-bridge.js", "/static/manifest.webmanifest", "/static/icon.svg", "/static/sw.js",
            }
            if method == "GET" and path in static_routes:
                name = "index.html" if path == "/" else path.rsplit("/", 1)[-1]
                content_type = {
                    ".html": "text/html",
                    ".css": "text/css",
                    ".js": "text/javascript",
                    ".webmanifest": "application/manifest+json",
                    ".svg": "image/svg+xml",
                }[Path(name).suffix]
                self.send_bytes((ROOT / "static" / name).read_bytes(), content_type + "; charset=utf-8")
            elif method == "GET" and path == "/api/status":
                self.send_json(self.app.status())
            elif method == "GET" and path == "/api/settings":
                self.send_json(self.app.get_settings())
            elif method == "POST" and path == "/api/settings":
                self.send_json(self.app.save_settings(self.options()))
            elif method == "POST" and path == "/api/models":
                options = self.app.resolve_options(self.options())
                self.send_json(providers.fetch_models(options))
            elif method == "POST" and path == "/api/explain":
                self.send_json(providers.explain_selection(self.app.resolve_options(self.options())))
            elif method == "GET" and path == "/api/jobs":
                with self.app.lock:
                    jobs = sorted((j.copy() for j in self.app.jobs.values()), key=lambda j: j["created_at"], reverse=True)
                self.send_json({"jobs": jobs})
            elif method == "POST" and path == "/api/upload":
                self.upload()
            elif method == "POST" and path == "/api/demo":
                self.send_json({"job": self.app.demo()}, 201)
            elif method == "POST" and path == "/api/check":
                options = self.app.resolve_options(self.options())
                validate_options(options)
                self.app.save_settings(options)
                result = providers.check_provider(options, sample=True)
                if not result["ok"]:
                    raise RequestError(result["message"])
                self.send_json(result)
            else:
                match = re.fullmatch(r"/api/jobs/([a-f0-9]{32})(/.*)?", path)
                if not match:
                    raise RequestError("找不到这个地址。", 404)
                job = self.app.get(match[1])
                if method == "GET":
                    with self.app.lock:
                        job = job.copy()
                action = match[2] or ""
                if method == "POST" and action == "/translate":
                    self.send_json({"job": self.app.start(job, self.options())}, 202)
                elif method == "POST" and action == "/cancel":
                    self.send_json({"job": self.app.cancel(job)})
                elif method == "POST" and action == "/retry-failed":
                    self.send_json({"job": self.app.retry_failed(job, self.options_optional())}, 202)
                elif method == "DELETE" and action == "":
                    self.app.delete(job)
                    self.send_json({})
                elif method == "GET" and action.startswith("/page/"):
                    self.page(job, action, parse_qs(url.query))
                elif method == "GET" and action == "/segments":
                    self.all_segments(job)
                elif method == "GET" and action == "/audit":
                    self.audit_job(job)
                elif action.startswith("/paragraph/") and method in {"GET", "POST", "PUT"}:
                    self.paragraph(job, action, method)
                elif action == "/notes" and method == "GET":
                    self.send_json({"notes": self.app.read_notes(job)})
                elif action == "/notes" and method == "POST":
                    self.send_json({"note": self.app.change_note(job, body=self.options())}, 201)
                elif action == "/notes.md" and method == "GET":
                    self.download_notes(job)
                elif action.startswith("/notes/") and method in {"PUT", "DELETE"}:
                    note = re.fullmatch(r"/notes/([a-f0-9]{32})", action)
                    if not note:
                        raise RequestError("找不到这条笔记。", 404)
                    updated = self.app.change_note(job, note[1], self.options() if method == "PUT" else None)
                    self.send_json({"note": updated} if method == "PUT" else {})
                elif method == "GET" and (action == "/search" or action == "/search/boxes"):
                    self.search_document(job, action, parse_qs(url.query))
                elif method == "GET" and action.startswith("/text/"):
                    self.text_page(job, action)
                elif method in {"PUT", "POST"} and action.startswith("/text/"):
                    self.save_text_page(job, action)
                elif method == "GET" and action.startswith("/download/"):
                    self.download(job, action.rsplit("/", 1)[-1])
                else:
                    raise RequestError("找不到这个操作。", 404)
        except RequestError as exc:
            self.send_json({"error": str(exc)}, exc.status)
        except document_import.ImportError as exc:
            self.send_json({"error": str(exc)}, 400)
        except (providers.ProviderError, engine.EngineError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except (UnicodeError, json.JSONDecodeError):
            self.send_json({"error": "请求格式不正确。"}, 400)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return
        except Exception as exc:
            self.send_json({"error": f"本地服务无法完成请求（{type(exc).__name__}）。"}, 500)

    def options(self):
        options = json.loads(self.rfile.read(self.length(64 * 1024)).decode("utf-8"))
        if not isinstance(options, dict):
            raise RequestError("翻译设置格式不正确。")
        return options

    def options_optional(self):
        try:
            content_length = int(self.headers.get("Content-Length") or 0)
            if not content_length:
                return {}
            data = self.rfile.read(min(content_length, 64 * 1024)).decode("utf-8")
            payload = json.loads(data)
            return payload if isinstance(payload, dict) else {}
        except Exception:
            return {}

    def length(self, maximum):
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            raise RequestError("请求缺少有效的文件大小。") from None
        if length < 1:
            raise RequestError("未收到文件或请求内容。")
        if length > maximum:
            raise RequestError("文件或设置超过大小限制（单份文件最多 60 MB）。", 413)
        return length

    def upload(self):
        size = self.length(MAX_UPLOAD)
        name = unquote(self.headers.get("X-Filename", "document.pdf")).replace("\\", "/").rsplit("/", 1)[-1]
        name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip() or "document.pdf"
        suffix = Path(name).suffix
        kind = suffix[1:].lower()
        if kind not in document_import.FORMATS:
            raise RequestError("请选择 PDF、Word（.docx）、Markdown、TXT 或 PNG、JPG、WebP、TIFF 图片。", 415)
        if len(name) > 200:
            name = name[:200 - len(suffix)] + suffix

        def save(path):
            remaining = size
            with path.open("wb") as dest:
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise RequestError("上传未完成，请重试。")
                    dest.write(chunk)
                    remaining -= len(chunk)

        self.send_json({"job": self.app.add(name, save, source_format=kind)}, 201)

    def file(self, job, kind):
        if kind == "source":
            path = self.app.dir(job) / (FILES["original"] if job.get("source_format", "pdf") == "pdf" else SOURCE_FILE)
            if not path.is_file():
                raise RequestError("原文件已不存在。", 404)
            return path
        if kind not in FILES or (kind != "original" and not has_job_result(job)):
            raise RequestError("文件尚未就绪。", 404)
        folder = self.app.dir(job) if kind == "original" else self.app.result_dir(job)
        file = folder / FILES[kind]
        if not file.is_file() and kind in {"markdown_mono", "html", "word"} and (folder / "segments.json").is_file():
            with self.app.lock:
                segments = self.app.read_segments(job)
                write_text_outputs(job["name"], segments, None, None, folder)
        if not file.is_file():
            raise RequestError("文件已不存在。", 404)
        return file

    def page(self, job, action, query):
        match = re.fullmatch(r"/page/(original|translated)/(\d{1,4})\.png", action)
        if not match or not 1 <= int(match[2]) <= job["pages"]:
            raise RequestError("页码不存在。", 404)
        path = self.file(job, match[1])
        try:
            width = min(2000, max(240, int(query.get("width", ["1000"])[0])))
        except ValueError:
            raise RequestError("预览宽度无效。") from None
        fitz = pdf_module()
        with PDF_LOCK, fitz.open(path) as doc:
            page = doc[int(match[2]) - 1]
            scale = min(width / page.rect.width, 2800 / page.rect.height)
            image = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).tobytes("png")
        self.send_bytes(image, "image/png", cache="private, max-age=3600" if match[1] == "original" else "no-store")

    def search_document(self, job, action, query):
        term = document_search.normalize(query.get("q", [""])[0])
        if not term or len(term) > document_search.MAX_QUERY:
            raise RequestError(f"请输入 1–{document_search.MAX_QUERY} 个字符。")
        side = query.get("side", ["both"])[0]
        if side not in {"both", "original", "translated"}:
            raise RequestError("搜索范围无效。")
        has_result = has_job_result(job)
        paths = {
            "original": self.app.dir(job) / FILES["original"],
            "translated": self.app.result_dir(job) / FILES["translated"],
        }
        pages = job["pages"]
        translated_pages = set()
        if has_result:
            selected = None
            try:
                selected = engine._pages(job.get("page_range") or None, pages)
            except engine.EngineError:
                pass
            translated_pages = set(range(1, pages + 1)) if selected is None else {index + 1 for index in selected}
            translated_pages.difference_update(job.get("failed_pages") or ())
        if action == "/search/boxes":
            try:
                page = int(query.get("page", ["0"])[0])
            except ValueError:
                raise RequestError("页码无效。") from None
            if (not 1 <= page <= pages or side == "both"
                    or (side == "translated" and page not in translated_pages)):
                raise RequestError("找不到搜索页。", 404)
            path = paths[side]
            if not path.is_file():
                raise RequestError("找不到搜索页。", 404)
            self.send_json(document_search.match_boxes(pdf_module(), PDF_LOCK, path, page, term))
            return
        sides = ("original", "translated") if side == "both" else (side,)
        fitz = pdf_module()
        texts = {
            kind: (self.app.search_index.pdf_text(fitz, PDF_LOCK, paths[kind])
                   if kind == "original" or translated_pages else ())
            for kind in sides
        }
        self.send_json(document_search.search_text(term, sides, texts, pages, translated_pages))

    def all_segments(self, job):
        if not has_job_result(job) or not job.get("has_text"):
            raise RequestError("还没有可对照的段落。", 404)
        pages = self.app.read_segments(job)
        for entry in pages.values():
            entry.pop("raw_pairs", None)
            entry.pop("pdf_pairs", None)
        audit_report = audit.audit_document_segments(pages)
        for page_num, issue_list in audit_report.get("details", {}).items():
            if page_num in pages and "pairs" in pages[page_num]:
                for item in issue_list:
                    idx = item["segment_index"]
                    if 0 <= idx < len(pages[page_num]["pairs"]):
                        pair = pages[page_num]["pairs"][idx]
                        if isinstance(pair, list):
                            if len(pair) == 2:
                                pair.append(item["issues"])
                            else:
                                pair[2] = item["issues"]
        self.send_json({"pages": pages, "audit": audit_report})

    def audit_job(self, job):
        if not has_job_result(job) or not job.get("has_text"):
            raise RequestError("还没有可校对的译文段落。", 404)
        self.send_json(audit.audit_document_segments(self.app.read_segments(job)))

    def text_page(self, job, action):
        match = re.fullmatch(r"/text/(\d{1,4})", action)
        if not match or not 1 <= int(match[1]) <= job["pages"]:
            raise RequestError("页码不存在。", 404)
        if not has_job_result(job) or not job.get("has_text"):
            raise RequestError("还没有可对照的段落。", 404)
        pages = self.app.read_segments(job)
        entry = pages.get(str(int(match[1])), {"mode": "", "pairs": []})
        self.send_json({"mode": entry["mode"], "pairs": entry["pairs"]})

    def save_text_page(self, job, action):
        match = re.fullmatch(r"/text/(\d{1,4})", action)
        if not match or not 1 <= int(match[1]) <= job["pages"]:
            raise RequestError("页码不存在。", 404)
        body = self.options()
        with self.app.lock:
            updated = self.app.update_page_segments(job, int(match[1]), body.get("pairs"))
            result = {"mode": updated["mode"], "pairs": updated["pairs"], "text_revision": job["text_revision"]}
        self.send_json(result)

    def paragraph(self, job, action, method):
        match = re.fullmatch(r"/paragraph/(\d{1,4})/(\d{1,5})", action)
        if not match or not 1 <= int(match[1]) <= job["pages"]:
            raise RequestError("找不到这个段落。", 404)
        page, segment = map(int, match.groups())
        if method == "GET":
            self.send_json(self.app.paragraph_review(job, page, segment))
        elif method == "POST":
            self.send_json(self.app.retranslate_paragraph(job, page, segment, self.options()))
        else:
            self.send_json({"job": self.app.save_paragraph(job, page, segment, self.options())})

    def download_notes(self, job):
        def quoted(text):
            literal = re.sub(r"([\\`*_{}\[\]<>!])", r"\\\1", text)
            return "\n".join("> " + line for line in literal.splitlines())

        title = Path(job["name"]).stem
        lines = ["# 双语笔记", "", quoted(title), ""]
        for note in self.app.read_notes(job):
            lines.extend([
                f"## 第 {note['page']} 页 · 第 {note['segment'] + 1} 段", "",
                "**原文**", "", quoted(note["original"]), "",
                "**译文**", "", quoted(note["translation"]), "",
            ])
            if note["comment"]:
                lines.extend(["**笔记**", "", quoted(note["comment"]), ""])
        data = ("\n".join(lines) + "\n").encode("utf-8")
        filename = quote(f"{title}_双语笔记.md", safe="")
        self.headers_for(200, "text/markdown; charset=utf-8", len(data))
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{filename}")
        self.end_headers()
        self.wfile.write(data)

    def download(self, job, kind):
        path = self.file(job, kind)
        if kind == "source":
            self.download_file(path, job["name"], "application/octet-stream")
            return
        suffix = {
            "original": "_原文",
            "translated": "_译文",
            "bilingual": "_左右对照",
            "markdown": "_双语对照",
            "markdown_mono": "_纯译文",
            "html": "_双语网页",
            "word": "_双语Word",
        }[kind]
        filename = f"{Path(job['name']).stem}{suffix}{path.suffix}"
        mime = {
            "markdown": "text/markdown; charset=utf-8",
            "markdown_mono": "text/markdown; charset=utf-8",
            "html": "text/html; charset=utf-8",
            "word": "application/msword; charset=utf-8",
        }.get(kind, "application/pdf")
        self.download_file(path, filename, mime)

    def download_file(self, path, filename, mime):
        filename = quote(filename, safe="")
        with path.open("rb") as stream:
            self.headers_for(200, mime, path.stat().st_size)
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{filename}")
            self.end_headers()
            shutil.copyfileobj(stream, self.wfile)

    def headers_for(self, status, mime, length, cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "no-referrer")
        self._cors_headers()
        self.send_header("Content-Security-Policy", "default-src 'self'; connect-src 'self' http: https:; img-src 'self' data: blob: http: https:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'")

    def send_bytes(self, body, mime, status=200, cache="no-store"):
        self.headers_for(status, mime, len(body), cache)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, data, status=HTTPStatus.OK):
        self.send_bytes(json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)


def launch_desktop_window(url: str) -> bool:
    """Try launching in native-like standalone desktop window mode via Edge/Chrome --app."""
    if os.name == "nt":
        candidates = [
            shutil.which("msedge.exe"),
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            shutil.which("chrome.exe"),
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        ]
        for exe in candidates:
            if exe and Path(exe).is_file():
                try:
                    subprocess.Popen(
                        [str(exe), f"--app={url}", "--window-size=1480,920"],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    )
                    return True
                except OSError:
                    continue
    return webbrowser.open(url)


def main():
    parser = argparse.ArgumentParser(description="论文译读 · 本地 PDF 翻译工作台")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--lan", action="store_true", help="开启局域网共享模式，允许平板/手机 APK 或浏览器远程连接")
    parser.add_argument("--open", action="store_true", help="启动后在默认浏览器打开")
    parser.add_argument("--app", action="store_true", help="以独立桌面应用窗口模式启动")
    parser.add_argument("--desktop-host", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    bind_host = "0.0.0.0" if args.lan else "127.0.0.1"
    try:
        listener = ThreadingHTTPServer((bind_host, args.port), Handler)
    except OSError:
        if not args.desktop_host or not args.port:
            raise
        listener = ThreadingHTTPServer((bind_host, 0), Handler)
    with listener as server:
        server.allow_lan = bool(args.lan)
        default_provider = providers.OFFLINE_PROVIDER if args.desktop_host else "magpie"
        server.app = Workbench(args.data_dir, default_provider=default_provider)
        url = f"http://127.0.0.1:{server.server_port}"
        if args.desktop_host:
            def stop_with_host():
                sys.stdin.readline()
                server.shutdown()

            print(f"PAPER_STUDIO_URL={url}", flush=True)
            Thread(target=stop_with_host, daemon=True).start()
        else:
            print(f"论文译读已启动：{url}", flush=True)
            if args.lan:
                import socket
                try:
                    with socket.socket(socket.AF_INET, socket.SocketKind.SOCK_DGRAM) as s:
                        s.connect(("8.8.8.8", 80))
                        lan_ip = s.getsockname()[0]
                    print(f"平板/手机局域网连接地址：http://{lan_ip}:{server.server_port}", flush=True)
                except OSError:
                    pass
            print("关闭此窗口将停止服务。", flush=True)
        if args.app and not args.desktop_host:
            timer = Timer(0.3, launch_desktop_window, args=(url,))
            timer.daemon = True
            timer.start()
        elif args.open and not args.desktop_host:
            timer = Timer(0.3, webbrowser.open, args=(url,))
            timer.daemon = True
            timer.start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            with server.app.lock:
                for stop in server.app.cancelled.values():
                    stop.set()
            server.app.worker.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
