"""Find source regions to preserve in native and scanned PDF pages."""

import re
import unicodedata


TYPES = frozenset({"tables", "code", "images", "references"})
LAYOUT_TYPES = {
    "tables": {"table", "table_caption", "table_footnote"},
    "images": {"figure", "figure_caption"},
}
_HEADING_NUMBER = re.compile(r"^(?:(?:\d+(?:\.\d+)*|[ivxlcdm]+)[.)、:\s]+|第[一二三四五六七八九十\d]+[章节]\s*)", re.I)
_REFERENCES = re.compile(
    r"(?:references(?: and notes)?|bibliography|works cited|literature cited|"
    r"参考\s*文献|參考\s*文獻|引用文献|参考資料|참고\s*문헌|literatur(?:verzeichnis)?|"
    r"références(?: bibliographiques)?|bibliographie|referencias(?: bibliográficas)?|bibliografía)",
    re.I,
)
_AFTER_REFERENCES = re.compile(
    r"(?:appendix(?:\s+[a-z0-9]+)?|appendices|supplementary (?:material|information)|"
    r"acknowledg(?:e)?ments?|author (?:biographies|contributions)|biographies|"
    r"附录(?:\s*[a-z0-9]+)?|附錄|致谢|致謝|作者简介|作者簡介)(?:\s*[:.：]\s*.+)?",
    re.I,
)
_FENCE = re.compile(r"^\s*(?:\x60{3,}|~{3,})")
_CODE = re.compile(
    r"^\s*(?:>>> |#\s*include\s*[<\"]|//\s|/\*|\*/|(?:async\s+)?def\s+\w+\s*\(|"
    r"function\s+\w+\s*\(|(?:const|let|var)\s+[\w$]+\s*=|from\s+[\w.]+\s+import\s+\w|"
    r"import\s+[\w.]+(?:\s+as\s+\w+)?[;\s]*$|"
    r"(?:if|for|while|elif|except|with)\s+.+(?:\{|:)\s*$|"
    r"(?:else|try|finally)\s*[:{]\s*$|[{}\[\]]\s*[;,]?\s*$|"
    r"(?:return|break|continue)(?:\s+[^;]+)?;\s*$|[\w.]+\s*=\s*[^=;]+;\s*$)"
)
_MONO = re.compile(r"mono|courier|consolas|typewriter|sourcecode", re.I)
_CAPTIONS = {
    "tables": re.compile(r"^(?:table\s+|表\s*)(?:\d+|[ivxlcdm]+)\s*[.．:：]", re.I),
    "images": re.compile(r"^(?:fig(?:ure)?\.?\s+|图\s*|圖\s*)(?:\d+|[ivxlcdm]+)\s*[.．:：]", re.I),
}


class TextFilter:
    def __init__(self, kinds):
        self.kinds = kinds
        self.in_references = False
        self.in_code = False

    def excludes(self, text):
        text = unicodedata.normalize("NFKC", text).strip()
        if "references" in self.kinds:
            heading = _HEADING_NUMBER.sub("", text).rstrip(".:：。 ").strip()
            if _REFERENCES.fullmatch(heading):
                self.in_references = True
            elif self.in_references and _AFTER_REFERENCES.fullmatch(heading):
                self.in_references = False
            if self.in_references:
                return True
        if "code" in self.kinds:
            if _FENCE.match(text):
                self.in_code = not self.in_code
                return True
            if self.in_code or _CODE.match(text):
                return True
        return any(kind in self.kinds and pattern.match(text) for kind, pattern in _CAPTIONS.items())

    def native_regions(self, page):
        import fitz

        regions = []
        flags = fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES
        for block in page.get_text("dict", flags=flags)["blocks"]:
            for line in block.get("lines", ()):
                spans = line["spans"]
                if self.excludes("".join(span["text"] for span in spans)):
                    regions.append(fitz.Rect(line["bbox"]) * page.rotation_matrix)
                elif "code" in self.kinds:
                    regions.extend(
                        fitz.Rect(span["bbox"]) * page.rotation_matrix
                        for span in spans
                        if span["text"].strip()
                        and (span["flags"] & fitz.TEXT_FONT_MONOSPACED or _MONO.search(span["font"]))
                    )
        return regions

    def scanned_regions(self, page, sequences, width, height):
        import fitz

        scale = fitz.Matrix(page.rect.width / width, page.rect.height / height)
        return [
            fitz.Rect(line[:4]) * scale
            for sequence in sequences for line in sequence
            if self.excludes(line[4])
        ]


def layout_regions(page, layout, width, height, kinds, *, native):
    import fitz

    scale = fitz.Matrix(page.rect.width / width, page.rect.height / height)
    region_types = set().union(*(LAYOUT_TYPES.get(kind, ()) for kind in kinds))
    regions = []
    has_table = False
    for box in layout.boxes:
        name = layout.names[int(box.cls)]
        if name in region_types:
            rect = fitz.Rect(*map(float, box.xyxy.squeeze())) * scale
            if name != "figure" or rect.get_area() < page.rect.get_area() * 0.9:
                regions.append(rect)
            has_table |= name == "table"
    if native and "images" in kinds:
        for image in page.get_image_info():
            rect = fitz.Rect(image["bbox"]) * page.rotation_matrix
            if rect.get_area() < page.rect.get_area() * 0.9:
                regions.append(rect)
    if native and "tables" in kinds and not has_table:
        # The layout model can miss small ruled tables in converted documents.
        try:
            for table in page.find_tables().tables:
                if sum(sum(bool(cell and cell.strip()) for cell in row) >= 2 for row in table.extract()) >= 2:
                    regions.append(fitz.Rect(table.bbox) * page.rotation_matrix)
        except (RuntimeError, ValueError):
            pass
    return regions


def clipped_regions(regions, page_rect):
    """Drop nested regions so reflow doesn't repeat captions or diagram labels."""
    clipped = sorted((rect & page_rect for rect in regions), key=lambda rect: -rect.get_area())
    retained = []
    for rect in clipped:
        if not rect.is_empty and not any(other.contains(rect) for other in retained):
            retained.append(rect)
    return sorted(retained, key=lambda rect: (rect.y0, rect.x0))


def scanned_body(page, lines, width, height, regions):
    import fitz

    scale = fitz.Matrix(page.rect.width / width, page.rect.height / height)
    kept = []
    for line in lines:
        rect = fitz.Rect(line[:4]) * scale
        if not any((rect & region).get_area() >= rect.get_area() * 0.5 for region in regions):
            kept.append(line)
    return kept
