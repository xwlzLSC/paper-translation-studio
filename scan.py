"""Local OCR and readable, searchable output for image-only pages."""
from collections import defaultdict
import re


def available(build):
    package = build / "site-packages" / "rapidocr_onnxruntime"
    return (package / "__init__.py").is_file() and len(list((package / "models").glob("*.onnx"))) >= 3


class Scanner:
    def __init__(self):
        from rapidocr_onnxruntime import RapidOCR

        self.ocr = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)

    def paragraphs(self, page):
        lines, width, _ = self.read(page)
        return _paragraphs(lines, width)

    def read(self, page):
        import fitz
        import numpy as np

        scale = min(3.0, 2300 / max(page.rect.width, page.rect.height))
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
        rgb = np.frombuffer(pix.samples_mv, dtype=np.uint8).reshape(pix.height, pix.width, 3)
        result, _ = self.ocr(np.ascontiguousarray(rgb[:, :, ::-1]))
        lines = []
        for box, text, _ in result or ():
            xs, ys = zip(*box)
            text = text.strip()
            if text:
                lines.append((min(xs), min(ys), max(xs), max(ys), text))
        return lines, pix.width, pix.height


def reading_sequences(lines, width):
    # Keep the left column ahead of the right when the center gutter is
    # visible. Spanning headings and captions divide the page into bands.
    mid, slack = width / 2, width * 0.025
    left = [line for line in lines if line[2] <= mid + slack]
    right = [line for line in lines if line[0] >= mid - slack]
    two_columns = len(left) >= 3 and len(right) >= 3 and (
        max(min(line[1] for line in left), min(line[1] for line in right))
        < min(max(line[3] for line in left), max(line[3] for line in right))
    )
    sequences = []
    if two_columns:
        bands = defaultdict(list)
        spanning = sorted(set(lines) - set(left) - set(right), key=lambda line: line[1])
        boundaries = [line[1] for line in spanning]
        for col, column in enumerate((left, right)):
            for line in column:
                bands[sum(line[1] > boundary for boundary in boundaries), col].append(line)
        for band in range(len(spanning) + 1):
            sequences.extend((bands[band, 0], bands[band, 1]))
            if band < len(spanning):
                sequences.append([spanning[band]])
    else:
        sequences = [lines]
    return [sorted(sequence, key=lambda item: (item[1], item[0])) for sequence in sequences]


def _paragraphs(lines, width):
    paragraphs = []
    for sequence in reading_sequences(lines, width):
        previous = None
        for line in sequence:
            x0, y0, x1, y1, text = line
            if previous:
                px0, py0, px1, py1, _ = previous
                height = max(y1 - y0, py1 - py0)
                if (
                    abs(x0 - px0) < width * 0.045 and px1 > x0
                    and -height * 0.25 <= y0 - py1 <= height * 0.85
                    and len(paragraphs[-1]) + len(text) < 1800
                ):
                    paragraphs[-1] += " " + text
                    previous = line
                    continue
            paragraphs.append(text)
            previous = line
    return paragraphs


_CJK = r"\u2e80-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef"
_WORDS = re.compile(rf"[{_CJK}]|[^\s{_CJK}]+| +")


def wrap(text, font, size, max_width):
    """Wrap Latin words and CJK glyphs at the actual printed width."""
    line, used = "", 0.0
    for token in _WORDS.findall(" ".join(text.split())):
        advance = font.text_length(token, fontsize=size)
        chunks = (token,) if advance <= max_width else tuple(token)
        for chunk in chunks:
            advance = font.text_length(chunk, fontsize=size)
            if used + advance > max_width and line.strip():
                yield line.rstrip()
                line, used = "", 0.0
            if chunk != " " or line:
                line += chunk
                used += advance
    if line.strip():
        yield line.rstrip()


def reflow(page_rect, number, translations, font, *, original=None, retained=()):
    """Return a one-page PDF with one readable counterpart per scanned page."""
    import fitz

    width = max(360, min(900, page_rect.width))
    margin = 42
    size = 11.5
    leading = 18
    y = 86
    rows = []
    for text in translations:
        for line in wrap(text, font, size, width - margin * 2):
            rows.append((y, line))
            y += leading
        y += 9
    crops = []
    for rect in retained:
        crop_width = min(width - margin * 2, rect.width)
        crop_height = crop_width * rect.height / rect.width
        crops.append((rect, fitz.Rect(margin, y, margin + crop_width, y + crop_height)))
        y += crop_height + 12

    doc = fitz.open()
    page = doc.new_page(width=width, height=max(page_rect.height, y + margin))
    page.insert_text((margin, 40), f"OCR TRANSLATION   /   SOURCE PAGE {number}",
                     fontsize=10, fontname="hebo", color=(0.07, 0.38, 0.31))
    page.draw_line((margin, 54), (width - margin, 54), width=0.7, color=(0.65, 0.75, 0.70))
    writer = fitz.TextWriter(page.rect)
    for baseline, line in rows:
        writer.append((margin, baseline), line, font=font, fontsize=size)
    writer.write_text(page, color=(0.10, 0.15, 0.14))
    for clip, target in crops:
        pix = original.get_pixmap(matrix=fitz.Matrix(2, 2), clip=clip, alpha=False)
        page.insert_image(target, pixmap=pix)
    doc.subset_fonts()
    return doc
