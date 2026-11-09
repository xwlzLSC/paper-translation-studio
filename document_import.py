"""Turn local documents into the PDF used by the reader and translation engine."""

from html import escape
from io import BytesIO
import re
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile


IMAGE_FORMATS = {
    "png": "PNG", "jpg": "JPEG", "jpeg": "JPEG", "webp": "WEBP",
    "tif": "TIFF", "tiff": "TIFF",
}
FORMATS = {"pdf", "docx", "txt", "md", "markdown", *IMAGE_FORMATS}
MAX_TEXT_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 80_000_000
PAGE_CSS = """
body { font-size: 11pt; line-height: 1.5; color: #1f2937; }
h1, h2, h3, h4, h5, h6 { color: #19243b; line-height: 1.2; }
p { margin: 0 0 9pt; }
table { width: 100%; margin: 0 0 12pt; border-collapse: collapse; font-size: 10pt; }
td, th { border: 1pt solid #ccd3df; padding: 5pt 6pt; }
th { background: #edf0f6; text-align: left; }
blockquote { margin-left: 14pt; color: #394861; }
pre { white-space: pre-wrap; font-size: 9pt; }
"""


class ImportError(ValueError):
    """An import failure that can be shown to the user."""


def _read_text(path):
    if path.stat().st_size > MAX_TEXT_BYTES:
        raise ImportError("文本过大，请拆分后再导入。")
    data = path.read_bytes()
    encodings = ("utf-16",) if data.startswith((b"\xff\xfe", b"\xfe\xff")) else ("utf-8-sig", "gb18030")
    for encoding in encodings:
        try:
            text = data.decode(encoding)
        except UnicodeDecodeError:
            continue
        if text.strip() and not re.search(r"[\x00-\x08\x0b\x0e-\x1f\x7f]", text):
            return text
    raise ImportError("没有可读的文本。请保存为 UTF-8、UTF-16（带 BOM）或 GB18030 后重试。")


def _docx_html(path):
    try:
        with ZipFile(path) as archive:
            entry = archive.getinfo("word/document.xml")
            if entry.file_size > MAX_TEXT_BYTES:
                raise ImportError("Word 正文过大，请拆分后再导入。")
            raw = archive.read(entry)
            if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", raw.replace(b"\x00", b""), flags=re.I):
                raise ImportError("无法导入包含自定义 XML 实体的 Word 文档。")
            root = ElementTree.fromstring(raw)
    except (BadZipFile, KeyError, ElementTree.ParseError, RuntimeError, NotImplementedError, OSError):
        raise ImportError("无法读取 Word 文件。请选择未加密且完整的 .docx 文件。") from None

    ns = root.tag.rpartition("}")[0] + "}"
    if ns not in {"{http://schemas.openxmlformats.org/wordprocessingml/2006/main}",
                  "{http://purl.oclc.org/ooxml/wordprocessingml/main}"}:
        raise ImportError("文件不包含可识别的 Word 正文。")
    body = root.find(ns + "body")
    if body is None:
        raise ImportError("文件不包含可识别的 Word 正文。")

    def paragraph(node):
        # Keep visible run text in document order, including links and tabs.
        parts = []
        for item in node.iter():
            if item.tag == ns + "t" and item.text:
                parts.append(escape(item.text))
            elif item.tag == ns + "tab":
                parts.append(" ")
            elif item.tag in (ns + "br", ns + "cr"):
                parts.append("<br>")
        if not "".join(parts).replace("<br>", "").strip():
            return ""
        style = node.find(f"{ns}pPr/{ns}pStyle")
        name = style.get(ns + "val", "") if style is not None else ""
        heading = re.fullmatch(r"heading\s*([1-6])", name, re.I)
        tag = f"h{heading[1]}" if heading else ("h1" if name.lower() == "title" else "p")
        return f"<{tag}>{''.join(parts)}</{tag}>"

    def blocks(container, depth=0):
        if depth > 20:
            raise ImportError("Word 的表格或内容控件嵌套太深，请精简文档后重试。")
        for node in container:
            if node.tag == ns + "p":
                if content := paragraph(node):
                    yield content
            elif node.tag == ns + "tbl":
                rows = []
                for row in node.findall(ns + "tr"):
                    cells = ["".join(blocks(cell, depth + 1)) for cell in row.findall(ns + "tc")]
                    if cells and any(cells):
                        tag = "th" if row.find(f"{ns}trPr/{ns}tblHeader") is not None else "td"
                        rows.append("<tr>" + "".join(f"<{tag}>{cell}</{tag}>" for cell in cells) + "</tr>")
                if rows:
                    yield "<table>" + "".join(rows) + "</table>"
            elif node.tag == ns + "sdt":
                content = node.find(ns + "sdtContent")
                if content is not None:
                    yield from blocks(content, depth + 1)

    content = "\n".join(blocks(body))
    if not content:
        raise ImportError("Word 文档中没有可导入的正文。只有图片或公式时，请先导出为 PDF 再导入。")
    return content


def _layout_pdf(fitz, content, output, max_pages):
    if not content.strip():
        raise ImportError("文档没有可导入的正文。")
    story = fitz.Story(html=content, user_css=PAGE_CSS)
    page = fitz.paper_rect("a4")
    body = page + (48, 49, -48, -49)
    writer = fitz.DocumentWriter(str(output))
    try:
        for _ in range(max_pages):
            more, filled = story.place(body)
            if more and fitz.Rect(filled).is_empty:
                raise ImportError("有内容无法放入页面，请缩小表格或改为导入 PDF。")
            device = writer.begin_page(page)
            story.draw(device)
            writer.end_page()
            if not more:
                return
        raise ImportError(f"转换后超过 {max_pages} 页，请拆分文档后再导入。")
    finally:
        writer.close()


def _image_pdf(fitz, source, kind, output, max_pages):
    from PIL import Image, ImageOps, ImageSequence

    try:
        with Image.open(source, formats=[IMAGE_FORMATS[kind]]) as picture, fitz.open() as doc:
            if getattr(picture, "n_frames", 1) > max_pages:
                raise ImportError(f"图片超过 {max_pages} 帧，请拆分后再导入。")
            pixels = 0
            for frame in ImageSequence.Iterator(picture):
                pixels += frame.width * frame.height
                if pixels > MAX_IMAGE_PIXELS:
                    raise ImportError("图片分辨率或总像素过高，请缩小或拆分后再导入。")
                oriented = ImageOps.exif_transpose(frame)
                with oriented.convert("RGBA") as rgba, Image.new("RGB", rgba.size, "white") as rgb:
                    rgb.paste(rgba, mask=rgba.getchannel("A"))
                    size = rgb.size
                    data = BytesIO()
                    if kind in {"jpg", "jpeg"}:
                        rgb.save(data, format="JPEG", quality=95, subsampling=0)
                    else:
                        rgb.save(data, format="PNG")
                scale = min(1, 842 / max(size))
                page = doc.new_page(width=max(1, size[0] * scale), height=max(1, size[1] * scale))
                page.insert_image(page.rect, stream=data.getvalue())
            doc.save(output, deflate=True)
    except (OSError, Image.DecompressionBombError, SyntaxError):
        raise ImportError("无法读取图片，请检查格式与文件完整性。") from None


def convert(fitz, source, kind, output, max_pages):
    if kind in IMAGE_FORMATS:
        _image_pdf(fitz, source, kind, output, max_pages)
        return
    if kind == "docx":
        content = _docx_html(source)
    else:
        text = _read_text(source)
        if kind == "txt":
            content = "\n".join(f"<p>{escape(block).replace(chr(10), '<br>')}</p>"
                                for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n").replace("\r", "\n"))
                                if block.strip())
        else:
            try:
                from markdown_it import MarkdownIt
                parser = MarkdownIt("commonmark", {"html": False}).enable("table")
                # Keep image descriptions, without resolving file or network URLs.
                parser.renderer.rules["image"] = lambda tokens, i, *_: escape(tokens[i].content)
                content = parser.render(text)
            except (ImportError, ModuleNotFoundError):
                # Lightweight pure-Python fallback when markdown_it is not in the host environment
                lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
                html_parts = []
                p_buf = []
                def flush_p():
                    if p_buf:
                        html_parts.append(f"<p>{'<br>'.join(escape(x) for x in p_buf)}</p>")
                        p_buf.clear()
                for line in lines:
                    s = line.strip()
                    if not s:
                        flush_p()
                    elif s.startswith("### "):
                        flush_p()
                        html_parts.append(f"<h3>{escape(s[4:])}</h3>")
                    elif s.startswith("## "):
                        flush_p()
                        html_parts.append(f"<h2>{escape(s[3:])}</h2>")
                    elif s.startswith("# "):
                        flush_p()
                        html_parts.append(f"<h1>{escape(s[2:])}</h1>")
                    else:
                        p_buf.append(line)
                flush_p()
                content = "\n".join(html_parts)
    _layout_pdf(fitz, content, output, max_pages)
