"""Reuse the PDF2zh 1.9.11 portable layout engine without modifying its install."""

from __future__ import annotations

from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
import hashlib
import json
import math
import os
from pathlib import Path
from queue import Empty, Queue
import re
import shutil
import subprocess
import sys
import tempfile
from threading import RLock, Thread
from time import monotonic
from types import SimpleNamespace
from zipfile import ZipFile


HERE = Path(__file__).resolve().parent
DEFAULT_HOME = HERE.parent
MARKER = "@@paper-translation-studio@@"
PLACEHOLDER = re.compile(r"\{\s*v([\d\s]+)\}", re.IGNORECASE)
FORMULA_ONLY = re.compile(r"\{v\d+\}")
LAYOUT_ASSET = "models/doclayout_yolo_docstructbench_imgsz1024.onnx"
FONT_ASSETS = {
    "zh": "SourceHanSerifCN-Regular.ttf",
    "zh-cn": "SourceHanSerifCN-Regular.ttf",
    "zh-hans": "SourceHanSerifCN-Regular.ttf",
    "zh-tw": "SourceHanSerifTW-Regular.ttf",
    "zh-hant": "SourceHanSerifTW-Regular.ttf",
    "ja": "SourceHanSerifJP-Regular.ttf",
    "ko": "SourceHanSerifKR-Regular.ttf",
}
MAX_CACHE_ENTRIES = 15000


class EngineError(RuntimeError):
    pass


class EngineCancelled(EngineError):
    pass


def discover_pdf2zh(home=None) -> Path:
    """Return the portable build folder containing runtime and site-packages."""
    home = Path(home or os.environ.get("PDF2ZH_HOME") or DEFAULT_HOME).expanduser()
    for build in (home / "pdf2zh" / "build", home / "build", home):
        if (
            (build / "runtime" / "python.exe").is_file()
            and (build / "site-packages" / "pdf2zh" / "converter.py").is_file()
        ):
            return build.resolve()
    raise EngineError("找不到 PDF2zh 便携版。请将 PDF2ZH_HOME 指向解压后的目录。")


def _batches(values, limit=20, characters=10000):
    batch = []
    length = 0
    for value in values:
        if batch and (len(batch) >= limit or length + len(value) > characters):
            yield batch
            batch = []
            length = 0
        batch.append(value)
        length += len(value)
    if batch:
        yield batch


def _validate_text(original, translated):
    if not isinstance(translated, str) or not translated.strip():
        raise EngineError("翻译服务返回了空段落，请重试或更换模型。")
    normalize = lambda match: "{v" + re.sub(r"\s+", "", match.group(1)) + "}"
    translated = PLACEHOLDER.sub(normalize, translated)
    if Counter(PLACEHOLDER.findall(original)) != Counter(PLACEHOLDER.findall(translated)):
        raise EngineError("模型改变了公式占位符，已停止排版。请重试或更换模型。")
    return re.sub(r"[\r\n\t]+", " ", translated).strip()


def _worker_events(proc, queue):
    try:
        for line in proc.stdout:
            if line.startswith(MARKER):
                queue.put(json.loads(line[len(MARKER):]))
    finally:
        queue.put(None)


class _PersistentCache:
    """Thread-safe translation cache with optional disk persistence."""

    def __init__(self, path: Path | None, namespace: str):
        self.path = Path(path) if path else None
        self.namespace = namespace
        self.lock = RLock()
        self.memory: dict[str, str] = {}
        self.disk: dict[str, str] = {}
        if self.path and self.path.is_file():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self.disk = {str(k): str(v) for k, v in loaded.items() if isinstance(k, str) and isinstance(v, str)}
            except (OSError, ValueError):
                self.disk = {}

    def _key(self, text: str) -> str:
        return hashlib.sha256(f"{self.namespace}\0{text}".encode("utf-8")).hexdigest()[:24]

    def get(self, text: str) -> str | None:
        with self.lock:
            if text in self.memory:
                return self.memory[text]
            candidate = self.disk.get(self._key(text))
            if candidate is not None:
                try:
                    valid = _validate_text(text, candidate)
                    self.memory[text] = valid
                    return valid
                except EngineError:
                    return None
            return None

    def put_many(self, pairs) -> None:
        with self.lock:
            changed = False
            for original, translated in pairs:
                self.memory[original] = translated
                key = self._key(original)
                if self.disk.get(key) != translated:
                    self.disk[key] = translated
                    changed = True
            if changed and self.path:
                if len(self.disk) > MAX_CACHE_ENTRIES:
                    keys = list(self.disk.keys())[-MAX_CACHE_ENTRIES:]
                    self.disk = {k: self.disk[k] for k in keys}
                try:
                    self.path.parent.mkdir(parents=True, exist_ok=True)
                    tmp = self.path.with_suffix(".tmp")
                    tmp.write_text(json.dumps(self.disk, ensure_ascii=False), encoding="utf-8")
                    tmp.replace(self.path)
                except OSError:
                    pass


def translate_pdf(
    source: Path,
    output: Path,
    provider,
    *,
    source_language="en",
    target_language="zh",
    pdf2zh_home=None,
    pages=None,
    ocr=True,
    concurrency=4,
    auto_glossary=False,
    cache_path: Path | None = None,
    progress=None,
    cancelled=None,
    on_segments=None,
    on_page_error=None,
    on_preserved=None,
    replay_page=None,
    ignore_content=(),
    image_document=False,
) -> Path:
    """Translate selected 1-based pages; retain the complete PDF and all page sizes."""
    source = Path(source).resolve()
    output = Path(output).resolve()
    if not source.is_file():
        raise EngineError("找不到要翻译的 PDF。")
    if source == output:
        raise EngineError("译文路径必须与原文不同。")
    build = discover_pdf2zh(pdf2zh_home)
    output.parent.mkdir(parents=True, exist_ok=True)
    progress = progress or (lambda *_: None)
    cancelled = cancelled or (lambda: False)
    on_segments = on_segments or (lambda *_: None)
    on_preserved = on_preserved or (lambda _: None)
    translate = getattr(provider, "translate", None) or getattr(provider, "translate_batch", None)
    if not callable(translate) and replay_page is None:
        raise EngineError("翻译服务无法处理段落。")

    workers = max(1, min(8, int(concurrency or 1)))
    glossary = getattr(provider, "glossary", None) or {}
    glossary_sig = json.dumps(sorted(glossary.items()), ensure_ascii=False) if isinstance(glossary, dict) else ""
    namespace = f"{source_language}:{target_language}:{glossary_sig}"
    provider_namespace = getattr(provider, "cache_namespace", None)
    if provider_namespace:
        namespace = f"{provider_namespace}:{namespace}"
    cache = _PersistentCache(cache_path, namespace)

    def check_cancelled():
        if cancelled():
            raise EngineCancelled("已取消翻译。")

    def cache_suffix() -> str:
        get_usage = getattr(provider, "get_usage_summary", None)
        if callable(get_usage):
            stats = get_usage()
            if stats.get("prompt_tokens", 0) > 0:
                return f" · 缓存命中 {stats['cache_hit_rate']}%"
        return ""

    check_cancelled()
    progress(0.02, "准备本地排版引擎")
    from providers import OutputError, ProviderError

    def translate_batch(batch, retry=True):
        check_cancelled()
        try:
            result = translate(batch, target_language)
            if not isinstance(result, (list, tuple)) or len(result) != len(batch):
                raise OutputError("模型返回的段落数不匹配，请重试或更换模型。")
            return [_validate_text(text, new) for text, new in zip(batch, result)]
        except OutputError:
            if not retry or len(batch) == 1:
                raise
            middle = len(batch) // 2
            return translate_batch(batch[:middle], False) + translate_batch(batch[middle:], False)

    def translate_page(texts, pool, current, total, page, warmed_up):
        missing = list(dict.fromkeys(text for text in texts if cache.get(text) is None))
        if not missing:
            return warmed_up
        chunk_limit = max(3, min(14, math.ceil(len(missing) / workers))) if workers > 1 else 20
        chunk_chars = 4500 if workers > 1 else 10000
        batches = list(_batches(missing, limit=chunk_limit, characters=chunk_chars))
        base_frac = 0.10 + 0.82 * max(0, current - 1) / max(1, total)
        if not warmed_up and len(batches) > 1 and workers > 1:
            progress(base_frac, f"预热前缀缓存 · 第 {page} 页（{current}/{total}）")
            first = batches.pop(0)
            translated = translate_batch(first)
            check_cancelled()
            cache.put_many(zip(first, translated))
        progress(base_frac, f"翻译第 {page} 页（{current}/{total}）{cache_suffix()}")
        if len(batches) == 1 or workers == 1:
            for batch in batches:
                translated = translate_batch(batch)
                check_cancelled()
                cache.put_many(zip(batch, translated))
        else:
            futures = {pool.submit(translate_batch, batch): batch for batch in batches}
            errors = []
            for future in as_completed(futures):
                check_cancelled()
                try:
                    translated = future.result()
                except (ProviderError, EngineError) as exc:
                    errors.append(exc)
                else:
                    cache.put_many(zip(futures[future], translated))
            if errors:
                raise errors[0]
        return True

    with tempfile.TemporaryDirectory(prefix=".pdf2zh-", dir=output.parent) as stage:
        result = Path(stage) / "translated.pdf"
        env = {
            key: value for key, value in os.environ.items()
            if not key.upper().endswith(("_API_KEY", "_ACCESS_TOKEN", "_AUTH_TOKEN"))
        }
        proc = subprocess.Popen(
            [str(build / "runtime" / "python.exe"), str(Path(__file__).resolve()),
             "--_worker", str(build)],
            cwd=stage,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None if os.environ.get("PAPER_STUDIO_DEBUG_ENGINE") == "1" else subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        events = Queue()
        reader = Thread(target=_worker_events, args=(proc, events), daemon=True)
        reader.start()

        def send(value):
            try:
                proc.stdin.write(json.dumps(value) + "\n")
                proc.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                raise EngineError("排版引擎中途退出，请检查便携版安装和 PDF。") from exc

        last_activity = monotonic()
        current = total = page = 0
        mode = "layout"
        warmed_up = False
        failed = set()

        def fail_page(number, message):
            if on_page_error is None:
                raise EngineError(message)
            failed.add(number)
            on_page_error(number, message)

        try:
            send({
                "source": str(source), "output": str(result), "pages": pages,
                "source_language": source_language, "target_language": target_language, "ocr": ocr,
                "allow_partial": on_page_error is not None,
                "ignore_content": sorted(ignore_content), "image_document": image_document,
            })
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="batch-tx") as pool:
                while True:
                    check_cancelled()
                    try:
                        event = events.get(timeout=0.2)
                    except Empty:
                        if monotonic() - last_activity > 600:
                            raise EngineError("本地排版引擎长时间无响应，请用少量页面重试。")
                        continue
                    last_activity = monotonic()
                    if event is None:
                        raise EngineError("排版引擎未能完成。请检查 PDF2zh 便携版是否完整。")
                    kind = event["type"]
                    if kind == "error":
                        raise EngineError(event["message"])
                    if kind == "context":
                        prep = getattr(provider, "prepare_context", None)
                        if callable(prep):
                            if auto_glossary:
                                progress(0.06, "正在提取论文核心专业术语与固定前缀缓存…")
                            try:
                                prep(event.get("text", ""), target_language, auto_glossary=auto_glossary)
                            except ProviderError:
                                # Optional glossary generation should not discard the page results.
                                if on_page_error is None:
                                    raise
                        last_activity = monotonic()
                    elif kind == "page":
                        current, total = event["current"], event["total"]
                        page, mode = event["page"], event["mode"]
                        action = "识别扫描页" if mode == "ocr" else "识别文字和版面"
                        progress(0.10 + 0.82 * (current - 1) / max(1, total),
                                 f"{action} · 第 {page} 页（{current}/{total}）{cache_suffix()}")
                    elif kind == "translate":
                        texts = event["texts"]
                        if replay_page is not None:
                            replayed = replay_page(page, mode, texts)
                            if len(replayed) != len(texts):
                                raise EngineError("已保存的段落与原文数量不一致。")
                            translated = [_validate_text(text, value) for text, value in zip(texts, replayed)]
                        elif page not in failed:
                            try:
                                warmed_up = translate_page(texts, pool, current, total, page, warmed_up)
                            except EngineCancelled:
                                raise
                            except (ProviderError, EngineError) as exc:
                                check_cancelled()
                                fail_page(page, str(exc))
                        if page in failed:
                            send({"skip": True})
                        else:
                            if replay_page is None:
                                translated = [cache.get(text) or text for text in texts]
                            on_segments(page, mode, list(zip(texts, translated)))
                            send({"translations": translated})
                        last_activity = monotonic()
                    elif kind == "page_error":
                        fail_page(event["page"], event["message"])
                    elif kind == "preserved":
                        on_preserved(event["page"])
                    elif kind == "reference_scan":
                        progress(0.06, f"识别参考文献范围 · 第 {event['page']} 页")
                    elif kind == "finalizing":
                        progress(0.94, f"生成并检查译文 PDF{cache_suffix()}")
                    elif kind == "done":
                        check_cancelled()
                        if proc.wait(timeout=30) != 0 or not result.is_file():
                            raise EngineError("未能生成译文 PDF。")
                        os.replace(result, output)
                        progress(1.0, f"翻译完成{cache_suffix()}")
                        return output
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
            proc.stdin.close()
            reader.join()
            proc.stdout.close()


class _PageRead(Exception):
    pass


@lru_cache(maxsize=48)
def read_page_paragraphs(source, page, source_language, target_language, ignore_content=()):
    """Recover the original paragraph order and formula identifiers for older results."""
    def capture(_page, mode, texts):
        raise _PageRead(mode, tuple(texts))

    with tempfile.TemporaryDirectory(prefix="paper-page-") as stage:
        try:
            translate_pdf(
                source, Path(stage) / "page.pdf", None, pages=str(page), concurrency=1,
                source_language=source_language, target_language=target_language,
                replay_page=capture, ignore_content=ignore_content,
            )
        except _PageRead as captured:
            return captured.args
    raise EngineError("该页没有可回写的原文段落。")


def _pages(value, count):
    """Convert public 1-based ranges (e.g. 1-3,5) to 0-based indices."""
    if value is None or value == "":
        return None
    if isinstance(value, str):
        chunks = re.split(r"[,，]", value.strip())
    elif isinstance(value, (tuple, list)):
        chunks = value
    else:
        raise EngineError("页码格式不正确，请输入如 1-3,5。")
    result = set()
    for chunk in chunks:
        match = re.fullmatch(r"([0-9]{1,8})(?:\s*[-–]\s*([0-9]{1,8}))?", str(chunk).strip())
        if not match:
            raise EngineError("页码格式不正确，请输入如 1-3,5。")
        first = int(match.group(1))
        last = int(match.group(2) or first)
        if not 1 <= first <= last <= count:
            raise EngineError(f"页码超出范围，本论文共 {count} 页。")
        result.update(range(first - 1, last))
    if not result:
        raise EngineError("至少选择一页进行翻译。")
    return sorted(result)


def _asset(archive: Path, member: str) -> Path:
    stat = archive.stat()
    fingerprint = hashlib.sha256(
        f"{archive}:{stat.st_size}:{stat.st_mtime_ns}".encode()
    ).hexdigest()[:16]
    cache_dir = Path(os.environ.get("PAPER_STUDIO_LAYOUT_CACHE") or (HERE / ".layout-assets"))
    cache_root = cache_dir / fingerprint
    path = cache_root / member
    with ZipFile(archive) as bundle:
        info = bundle.getinfo(member)
        if not (0 < info.file_size < 128 * 1024 * 1024):
            raise EngineError("离线排版资源不完整，请重新解压 PDF2zh。")
        if path.is_file() and path.stat().st_size == info.file_size:
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
            tmp = Path(file.name)
            try:
                with bundle.open(info) as source:
                    shutil.copyfileobj(source, file)
                file.close()
                try:
                    os.replace(tmp, path)
                except PermissionError:
                    if not path.is_file() or path.stat().st_size != info.file_size:
                        raise
            finally:
                file.close()
                tmp.unlink(missing_ok=True)
    return path


def _emit(kind, **data):
    print(MARKER + json.dumps({"type": kind, **data}), flush=True)


def _worker(build: Path):
    request = json.loads(sys.stdin.readline())
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(build / "site-packages"))
    sys.path.insert(0, str(HERE))
    from pymupdf import Document, Font
    import content_filter
    import scan

    source = Path(request["source"])
    output = Path(request["output"])
    lang_out = request["target_language"]
    lang_in = request["source_language"]
    allow_partial = request.get("allow_partial", False)
    ignored = frozenset(request.get("ignore_content", ()))
    unreadable = {}

    def page_error(index, message):
        if not allow_partial:
            raise EngineError(message)
        unreadable[index] = message
        _emit("page_error", page=index + 1, message=message)

    try:
        doc = Document(str(source))
    except (RuntimeError, ValueError) as exc:
        raise EngineError("无法读取 PDF，请检查文件是否损坏。") from exc
    with doc:
        if not doc.is_pdf or doc.page_count == 0 or doc.needs_pass:
            raise EngineError("请选择未加密且包含页面的 PDF。")
        indices = _pages(request["pages"], doc.page_count)
        selected = indices if indices is not None else list(range(doc.page_count))
        if "images" in ignored and request.get("image_document"):
            for index in selected:
                _emit("preserved", page=index + 1)
            shutil.copyfile(source, output)
            _emit("done")
            return
        dims = [tuple(page.rect) for page in doc]
        native = []
        scans = []
        context_snippets = []
        for index in selected:
            page = doc[index]
            if page.rect.width * page.rect.height > 12_000_000:
                page_error(index, "页面尺寸过大，请缩小 PDF 后重试。")
                continue
            page_text = page.get_text().strip()
            if page_text:
                native.append(index)
                if not ignored and len(context_snippets) < 2:
                    context_snippets.append(re.sub(r"\s+", " ", page_text)[:1200])
            elif page.get_images() or page.get_contents():
                if request.get("ocr"):
                    scans.append(index)
                elif allow_partial:
                    page_error(index, "没有可提取的文字，请启用扫描页 OCR。")
    needs_reference_scan = "references" in ignored and request.get("ocr")
    can_scan = bool(scans or needs_reference_scan) and scan.available(build)
    if scans and not can_scan:
        for index in scans:
            page_error(index, "找不到便携包内的 OCR 模型，请恢复完整便携包。")
        scans = []
    if not (native or scans):
        if unreadable:
            shutil.copyfile(source, output)
            _emit("done")
            return
        raise EngineError("所选页面没有可提取的文字。扫描件请启用 OCR 或检查页码。")

    if context_snippets:
        _emit("context", text="\n\n".join(context_snippets))

    scanner = None

    def read_scan(page):
        nonlocal scanner
        if scanner is None:
            scanner = scan.Scanner()
        return scanner.read(page)

    def scan_error(index):
        page_error(index, "扫描页识别失败，请检查清晰度后重试。")

    text_filter = content_filter.TextFilter(ignored)
    text_regions = {}
    reference_scans = {}
    if ignored:
        native_set, scan_set = set(native), set(scans)
        inspect = range(max(selected) + 1) if "references" in ignored else native
        with Document(str(source)) as original:
            for index in inspect:
                if index in unreadable:
                    continue
                page = original[index]
                has_text = index in native_set or page.get_text().strip()
                if has_text:
                    regions = text_filter.native_regions(page)
                    if index in native_set:
                        text_regions[index] = regions
                elif (needs_reference_scan and can_scan and page.rect.get_area() <= 12_000_000
                      and page.get_contents()):
                    _emit("reference_scan", page=index + 1)
                    try:
                        lines, width, height = read_scan(page)
                    except Exception:
                        if index in scan_set:
                            scan_error(index)
                        continue
                    regions = text_filter.scanned_regions(page, scan.reading_sequences(lines, width), width, height)
                    if index in scan_set:
                        reference_scans[index] = (lines, width, height, regions)
        scans = [index for index in scans if index not in unreadable]

    archive = next(iter(sorted(build.glob("offline_assets_*.zip"))), None)
    if archive is None:
        raise EngineError("缺少离线排版资源，请使用 with-assets 便携版。")
    font = FONT_ASSETS.get(lang_out.lower(), "GoNotoKurrent-Regular.ttf")
    scan_layout = bool(scans and ignored.intersection(content_filter.LAYOUT_TYPES))
    try:
        layout_path = _asset(archive, LAYOUT_ASSET) if native or scan_layout else None
        font_path = _asset(archive, f"fonts/{font}")
    except (KeyError, OSError) as exc:
        raise EngineError("无法读取离线排版模型或字体，请检查 PDF2zh 资源。") from exc
    if layout_path:
        import numpy as np
        from pdf2zh.doclayout import OnnxModel
        model = OnnxModel(str(layout_path))
    requested = set()
    preserved = set()
    protected_native = set()
    context_sent = not ignored
    total = len(native) + len(scans)

    def preserve(index):
        preserved.add(index)
        _emit("preserved", page=index + 1)

    def request_translation(index, texts):
        nonlocal context_sent
        if not context_sent:
            # Form the glossary/context excerpt from the same filtered text as the translation batches.
            _emit("context", text=" ".join(texts)[:2400])
            context_sent = True
        requested.add(index)
        _emit("translate", texts=texts)
        line = sys.stdin.readline()
        if not line:
            raise EngineError("翻译请求已终止。")
        reply = json.loads(line)
        if reply.get("skip"):
            return None
        translated = reply["translations"]
        if len(texts) != len(translated):
            raise EngineError("翻译结果和原文段落数量不匹配。")
        return translated

    class BridgeTranslator:
        name = "studio-bridge"

        def __init__(self, _lang_in, target, _model, **_kwargs):
            self.lang_out = target

    class BatchExecutor:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def map(self, _worker, blocks):
            positions = [i for i, block in enumerate(blocks)
                         if block.strip() and not FORMULA_ONLY.fullmatch(block)]
            if not positions:
                return iter(blocks)
            translated = request_translation(native_index, [blocks[i] for i in positions])
            if translated is None:
                return iter(blocks)
            blocks = list(blocks)
            for i, text in zip(positions, translated):
                blocks[i] = text
            return iter(blocks)

    if native:
        from pdf2zh import converter, high_level

        if getattr(converter.GoogleTranslator, "name", None) != "google":
            raise EngineError("这版 PDF2zh 的接口不兼容，请使用 v1.9.11 便携包。")
        high_level.download_remote_fonts = lambda _: str(font_path)
        converter.GoogleTranslator = BridgeTranslator
        converter.concurrent = SimpleNamespace(futures=SimpleNamespace(ThreadPoolExecutor=BatchExecutor))

        native_index = None

        def progress(bar):
            nonlocal native_index
            native_index = native[bar.n - 1]
            _emit("page", current=bar.n, total=total, page=native_index + 1, mode="layout")

        class FilteredLayout:
            def predict(self, image, imgsz):
                layouts = model.predict(image, imgsz=imgsz)
                layout = layouts[0]
                page = original[native_index]
                height, width = image.shape[:2]
                regions = text_regions.get(native_index, []) + content_filter.layout_regions(
                    page, layout, width, height, ignored, native=True,
                )
                if regions:
                    protected_native.add(native_index)
                    abandon = next(index for index, name in layout.names.items() if name == "abandon")
                    sx, sy = width / page.rect.width, height / page.rect.height
                    for rect in regions:
                        box = np.array((rect.x0 * sx, rect.y0 * sy, rect.x1 * sx, rect.y1 * sy))
                        layout.boxes.append(SimpleNamespace(xyxy=box, cls=abandon))
                return layouts

        with Document(str(source)) as original:
            mono, dual = high_level.translate_stream(
                source.read_bytes(), pages=native, lang_in=lang_in, lang_out=lang_out,
                service=BridgeTranslator.name, thread=1, model=FilteredLayout() if ignored else model,
                callback=progress, ignore_cache=True,
            )
        del dual
        translated = Document(stream=mono)
    else:
        translated = Document(str(source))

    with translated:
        if [tuple(page.rect) for page in translated] != dims:
            raise EngineError("译文的页数或页面尺寸与原文不一致。")
        native_preserved = protected_native - requested
        if scans or native_preserved:
            font = Font(fontfile=str(font_path))
            toc = translated.get_toc()
            with Document(str(source)) as original:
                for index in sorted(native_preserved):
                    translated.delete_page(index)
                    translated.insert_pdf(original, from_page=index, to_page=index, start_at=index)
                    preserve(index)
                for current, index in enumerate(scans, len(native) + 1):
                    _emit("page", current=current, total=total, page=index + 1, mode="ocr")
                    page = original[index]
                    try:
                        if index in reference_scans:
                            lines, width, height, retained = reference_scans[index]
                        else:
                            lines, width, height = read_scan(page)
                            retained = text_filter.scanned_regions(
                                page, scan.reading_sequences(lines, width), width, height,
                            ) if ignored else []
                    except Exception:
                        scan_error(index)
                        continue
                    if scan_layout:
                        try:
                            pix = page.get_pixmap(alpha=False)
                            rgb = np.frombuffer(pix.samples_mv, np.uint8).reshape(pix.height, pix.width, 3)
                            layout = model.predict(rgb[:, :, ::-1], imgsz=max(32, pix.height // 32 * 32))[0]
                            retained.extend(content_filter.layout_regions(
                                page, layout, pix.width, pix.height, ignored, native=False,
                            ))
                        except (RuntimeError, ValueError):
                            page_error(index, "扫描页版面识别失败，请重试该页。")
                            continue
                    retained = content_filter.clipped_regions(retained, page.rect)
                    kept = content_filter.scanned_body(page, lines, width, height, retained) if retained else lines
                    blocks = scan._paragraphs(kept, width)
                    if not blocks:
                        if retained or ("images" in ignored and page.get_images() and not lines):
                            preserve(index)
                        elif allow_partial:
                            page_error(index, "扫描页没有识别到文字，请检查清晰度。")
                        continue
                    text = request_translation(index, blocks)
                    if text is None:
                        continue
                    try:
                        replacement = scan.reflow(page.rect, index + 1, text, font, original=page, retained=retained)
                    except Exception:
                        if not allow_partial:
                            raise
                        page_error(index, "扫描页译文排版失败。")
                        continue
                    with replacement:
                        translated.delete_page(index)
                        translated.insert_pdf(replacement, start_at=index)
            if toc:
                translated.set_toc(toc)
        if not requested and not preserved and not unreadable:
            raise EngineError("未找到可翻译的正文。扫描件请检查清晰度与页码范围。")
        _emit("finalizing")
        if scans or native_preserved or not native:
            translated.save(output, garbage=3, deflate=True)
        else:
            output.write_bytes(mono)
    _emit("done")


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--_worker":
    try:
        _worker(Path(sys.argv[2]))
    except EngineError as exc:
        _emit("error", message=str(exc))
        sys.exit(1)
    except Exception:
        if os.environ.get("PAPER_STUDIO_DEBUG_ENGINE") == "1":
            import traceback
            traceback.print_exc()
        _emit("error", message="PDF2zh 无法完成这份文档的排版，请检查便携包或先试译少量页面。")
        sys.exit(1)
