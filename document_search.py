"""Local full-text search and glyph coordinates for rendered PDFs."""
from collections import OrderedDict
import re
import unicodedata


MAX_QUERY = 160
MAX_HITS = 200
MAX_BOXES = 250
MAX_CACHE_TEXT = 8_000_000
_CJK = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\U00020000-\U000323af]")
_INVISIBLE = {"\u00ad", "\u200b", "\u2060", "\ufeff"}


def normalize(value, offsets=None):
    """Normalize PDF glyph variants and whitespace, optionally retaining source offsets."""
    result = []
    gap = None
    for index, glyph in enumerate(value):
        if glyph in _INVISIBLE:
            continue
        for char in unicodedata.normalize("NFKC", glyph):
            if char.isspace():
                gap = index
                continue
            # PDF layout can insert gaps or line breaks within a CJK word.
            if gap is not None and result and not (_CJK.fullmatch(result[-1]) and _CJK.fullmatch(char)):
                result.append(" ")
                if offsets is not None:
                    offsets.append(gap)
            result.append(char)
            if offsets is not None:
                offsets.append(index)
            gap = None
    return "".join(result)


def _page_blocks(fitz, page, geometry=False):
    for block in page.get_text("rawdict", flags=fitz.TEXTFLAGS_SEARCH)["blocks"]:
        if block["type"] != 0:
            continue
        raw = []
        locations = [] if geometry else None
        offsets = [] if geometry else None
        for line_number, line in enumerate(block["lines"]):
            for span in line["spans"]:
                for glyph in span["chars"]:
                    char = glyph["c"]
                    raw.append(char)
                    if geometry:
                        locations.extend([(line_number, glyph["bbox"])] * len(char))
            raw.append("\n")
            if geometry:
                locations.append(None)
        text = normalize("".join(raw), offsets)
        if text:
            yield text, locations, offsets


def snippet(text, match):
    left = max(0, match.start() - 42)
    right = min(len(text), match.end() + 66)
    return {
        "before": ("…" if left else "") + text[left:match.start()].replace("\n", " "),
        "match": text[match.start():match.end()],
        "after": text[match.end():right].replace("\n", " ") + ("…" if right < len(text) else ""),
    }


class SearchIndex:
    def __init__(self):
        self._cache = OrderedDict()
        self._cached_chars = 0

    def pdf_text(self, fitz, lock, path):
        """Read each PDF only once until its on-disk content changes."""
        with lock:
            try:
                stat = path.stat()
            except FileNotFoundError:
                return ()
            stamp = (stat.st_mtime_ns, stat.st_size, stat.st_ino)
            existing = self._cache.pop(path, None)
            if existing is not None:
                if existing[0] == stamp:
                    self._cache[path] = existing
                    return existing[1]
                self._cached_chars -= existing[2]
            with fitz.open(path) as pdf:
                pages = tuple("\n".join(text for text, _, _ in _page_blocks(fitz, page)) for page in pdf)
            size = sum(map(len, pages))
            if size <= MAX_CACHE_TEXT:
                while self._cache and (len(self._cache) >= 8 or self._cached_chars + size > MAX_CACHE_TEXT):
                    _, (_, _, evicted_size) = self._cache.popitem(last=False)
                    self._cached_chars -= evicted_size
                self._cache[path] = (stamp, pages, size)
                self._cached_chars += size
            return pages


def search_text(query, sides, texts, pages, translated_pages):
    """Enumerate matches in PDF text in the same order as their highlight boxes."""
    pattern = re.compile(re.escape(query), re.IGNORECASE)
    results = []
    searchable = False
    total = 0

    for page in range(1, pages + 1):
        for side in sides:
            if side == "translated" and page not in translated_pages:
                continue
            page_text = texts[side][page - 1] if page <= len(texts[side]) else ""
            searchable |= bool(page_text)
            for index, match in enumerate(pattern.finditer(page_text)):
                total += 1
                if len(results) < MAX_HITS:
                    results.append({
                        "page": page, "kind": side, "source": "pdf", "match_index": index,
                        "snippet": snippet(page_text, match),
                    })
    return {"hits": results, "total": total, "searchable": searchable}


def match_boxes(fitz, lock, path, page_number, query):
    """Map normalized matches to their glyph boxes on the visible PDF page."""
    pattern = re.compile(re.escape(query), re.IGNORECASE)
    with lock, fitz.open(path) as pdf:
        if page_number > len(pdf):
            return {"boxes": [], "match_ids": [], "aspect": 1}
        page = pdf[page_number - 1]
        page_rect = page.rect
        rotation = page.rotation_matrix
        boxes = []
        match_ids = []
        match_id = 0
        for text, locations, offsets in _page_blocks(fitz, page, geometry=True):
            for match in pattern.finditer(text):
                if len(boxes) >= MAX_BOXES:
                    break
                by_line = {}
                for index in range(match.start(), match.end()):
                    if text[index] == " ":
                        continue
                    line, bounds = locations[offsets[index]]
                    rect = fitz.Rect(bounds)
                    by_line[line] = by_line[line] | rect if line in by_line else rect
                for bounds in by_line.values():
                    rect = (bounds * rotation) & page_rect
                    if rect.is_empty:
                        continue
                    boxes.append([
                        (rect.x0 - page_rect.x0) / page_rect.width,
                        (rect.y0 - page_rect.y0) / page_rect.height,
                        rect.width / page_rect.width,
                        rect.height / page_rect.height,
                    ])
                    match_ids.append(match_id)
                    if len(boxes) >= MAX_BOXES:
                        break
                match_id += 1
            if len(boxes) >= MAX_BOXES:
                break
        return {"boxes": boxes, "match_ids": match_ids, "aspect": page_rect.width / page_rect.height}
