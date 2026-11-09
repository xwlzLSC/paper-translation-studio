package com.paperstudio.translator;

import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.pdf.PdfDocument;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Xml;

import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import com.tom_roush.pdfbox.io.MemoryUsageSetting;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.pdmodel.PDPage;
import com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException;
import com.tom_roush.pdfbox.text.PDFTextStripper;
import com.tom_roush.pdfbox.pdmodel.font.PDFont;
import com.tom_roush.pdfbox.pdmodel.font.PDFontDescriptor;
import com.tom_roush.pdfbox.text.TextPosition;

import org.json.JSONArray;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

final class Documents {
    private static final List<String> FORMATS =
            Arrays.asList("pdf", "docx", "txt", "md", "markdown", "png", "jpg", "jpeg", "webp");
    private static final List<String> IMAGES = Arrays.asList("png", "jpg", "jpeg", "webp");
    private static final long MAX_FILE = 100L * 1024 * 1024;
    private static final int MAX_PAGES = 500;
    private static final int MAX_TEXT = 1_200_000;
    private final Context context;
    private final File sources;

    Documents(Context context) {
        this.context = context;
        this.sources = new File(context.getFilesDir(), "sources");
    }

    static void copy(InputStream in, OutputStream out, long limit) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        long total = 0;
        for (int n; (n = in.read(buffer)) != -1;) {
            total += n;
            if (total > limit) throw new IOException("文件或响应超过大小限制。");
            out.write(buffer, 0, n);
        }
    }

    private static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    JSONObject importFile(Uri uri) {
        String id = UUID.randomUUID().toString().replace("-", "");
        String name = "文献";
        File folder = new File(sources, id);
        File file = null;
        try {
            if (!"content".equals(uri.getScheme())) throw new IOException("请从系统文件选择器导入文献。");
            try (Cursor cursor = context.getContentResolver().query(uri,
                    new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    if (!cursor.isNull(0)) name = cursor.getString(0).replaceAll("[\\p{Cntrl}/\\\\]", "_");
                    if (!cursor.isNull(1) && cursor.getLong(1) > MAX_FILE) {
                        throw new IOException("单个文件最大 100 MB。");
                    }
                }
            }
            String ext = extension(name);
            if (!FORMATS.contains(ext)) throw new IOException("请选择 PDF、DOCX、TXT、Markdown、PNG、JPEG 或 WebP。");
            if (!folder.mkdirs()) throw new IOException("无法创建本地文献目录。");
            file = new File(folder, "source." + ext);
            try (InputStream in = context.getContentResolver().openInputStream(uri);
                 OutputStream out = new FileOutputStream(file)) {
                if (in == null) throw new IOException("无法读取文件。");
                copy(in, out, MAX_FILE);
            }
            return inspect(file).put("id", id).put("name", name).put("format", ext);
        } catch (Exception error) {
            if (file != null) file.delete();
            folder.delete();
            JSONObject result = new JSONObject();
            try {
                result.put("name", name).put("error", error.getMessage() == null ? "文件读取失败。" : error.getMessage());
            } catch (Exception ignored) {}
            return result;
        }
    }

    File source(String id) throws IOException {
        if (!id.matches("[a-f0-9]{32}")) throw new IOException("无效的文献编号。");
        File folder = new File(sources, id);
        for (String ext : FORMATS) {
            File file = new File(folder, "source." + ext);
            if (file.isFile()) return file;
        }
        File legacy = new File(context.getFilesDir(), "pdfs/" + id + ".pdf");
        if (legacy.isFile()) return legacy;
        throw new IOException("原文件不可用，请重新导入。");
    }

    void delete(String id) throws IOException {
        File file;
        try { file = source(id); }
        catch (IOException missing) { return; }
        if (!file.delete()) throw new IOException("原文件删除失败。");
        if (file.getParentFile().getParentFile().equals(sources)) file.getParentFile().delete();
    }

    JSONObject inspectLegacyPdf(String id) throws Exception {
        return inspect(source(id));
    }

    private MemoryUsageSetting scratch() {
        return MemoryUsageSetting.setupMixed(12L * 1024 * 1024).setTempDir(context.getCacheDir());
    }

    private JSONObject inspect(File file) throws Exception {
        String ext = extension(file.getName());
        if ("pdf".equals(ext)) {
            try (PDDocument pdf = PDDocument.load(file, scratch())) {
                int count = pdf.getNumberOfPages();
                if (count == 0 || count > MAX_PAGES) throw new IOException("PDF 需包含 1 至 500 页。");
                try (PdfRenderer renderer = openPdf(file)) {
                    if (renderer.getPageCount() != count) throw new IOException("PDF 页数异常，请重新保存后导入。");
                }
                PageText extractor = new PageText(count);
                extractor.getText(pdf);
                return new JSONObject().put("pages", extractor.pages);
            } catch (InvalidPasswordException | SecurityException error) {
                throw new IOException("PDF 需要密码，请先解锁后再导入。", error);
            }
        }
        if (IMAGES.contains(ext)) {
            BitmapFactory.Options info = imageInfo(file);
            JSONArray pages = new JSONArray().put(new JSONObject().put("mode", "image")
                    .put("width", info.outWidth).put("height", info.outHeight).put("blocks", new JSONArray()));
            return new JSONObject().put("pages", pages);
        }
        JSONArray blocks = "docx".equals(ext) ? readWord(file) : readText(file);
        if (blocks.length() == 0) throw new IOException("文档中没有可读取的正文。");
        return new JSONObject().put("blocks", blocks);
    }

    private static JSONObject block(String text, String kind, RectF rect) throws Exception {
        JSONObject entry = new JSONObject().put("text", text).put("kind", kind);
        if (rect != null && !rect.isEmpty()) entry.put("box", new JSONArray()
                .put(rect.left).put(rect.top).put(rect.width()).put(rect.height()));
        return entry;
    }

    private static final class PageText extends PDFTextStripper {
        final JSONArray pages = new JSONArray();
        private final List<PageLayout.Line> row = new ArrayList<>();
        private final List<PageLayout.Line> lines = new ArrayList<>();
        private final Map<PDFont, PageLayout.Face> faces = new IdentityHashMap<>();
        private static final Pattern MATH_FACE = Pattern.compile("(?i)cm(?:mi|sy|ex)|mt(?:mi|sy|ex)|math|symbol|stix");
        private int pageIndex;
        private float width;
        private float height;
        private int charCount;
        private PageLayout layout;

        PageText(int count) throws Exception {
            setSortByPosition(true);
            setShouldSeparateByBeads(false);
            for (int i = 0; i < count; i++) pages.put(new JSONObject().put("mode", "layout").put("blocks", new JSONArray()));
        }

        @Override
        protected void startPage(PDPage page) throws IOException {
            pageIndex = getCurrentPageNo() - 1;
            boolean rotated = Math.floorMod(page.getRotation(), 180) != 0;
            width = Math.max(1, rotated ? page.getCropBox().getHeight() : page.getCropBox().getWidth());
            height = Math.max(1, rotated ? page.getCropBox().getWidth() : page.getCropBox().getHeight());
            layout = new PageLayout(width, height);
            try { pages.getJSONObject(pageIndex).put("width", width).put("height", height); }
            catch (Exception error) { throw new IOException("无法读取 PDF 页面尺寸。", error); }
        }

        private static PageLayout.Face face(PDFont font) {
            PDFontDescriptor descriptor = font.getFontDescriptor();
            String name = String.valueOf(font.getName()).toLowerCase(Locale.ROOT);
            boolean mono = name.matches(".*(?:mono|courier|cmtt).*") || descriptor != null && descriptor.isFixedPitch();
            boolean serif = !name.contains("sans") && (name.matches(".*(?:times|nimbusrom|serif|palatino|cambria|garamond|cmr).*")
                    || descriptor != null && descriptor.isSerif());
            boolean bold = name.matches(".*(?:bold|demi|medi|black|heavy).*") || descriptor != null && descriptor.isForceBold();
            boolean italic = name.matches(".*(?:ital|oblique|slant|cmmi|mtmi).*") || descriptor != null && descriptor.isItalic();
            return new PageLayout.Face(mono ? "monospace" : serif ? "serif" : "sans-serif",
                    (bold ? 1 : 0) | (italic ? 2 : 0), MATH_FACE.matcher(name).find());
        }

        @Override
        protected void writeString(String word, List<TextPosition> positions) throws IOException {
            String text = word.trim();
            if (text.isEmpty()) return;
            RectF box = new RectF();
            float font = 0;
            int offset = 0;
            List<PageLayout.Glyph> glyphs = new ArrayList<>();
            for (TextPosition position : positions) {
                float x = position.getX();
                float y = position.getY();
                float size = Math.max(position.getHeight(), position.getFontSizeInPt() * .85f);
                RectF glyph = new RectF(Math.max(0, x), Math.max(0, y - size), Math.min(width, x + position.getWidth()),
                        Math.min(height, y + size * .19f));
                if (glyph.isEmpty()) continue;
                box.union(glyph);
                font = Math.max(font, size);
                String letter = position.getUnicode();
                if (letter == null || letter.trim().isEmpty()) continue;
                int start = text.indexOf(letter, offset);
                if (start < 0) {
                    letter = Normalizer.normalize(letter, Normalizer.Form.NFKC);
                    start = text.indexOf(letter, offset);
                }
                if (start < 0 || start > offset && !text.substring(offset, start).trim().isEmpty()) continue;
                offset = start + letter.length();
                PDFont sourceFont = position.getFont();
                if (sourceFont != null) glyphs.add(new PageLayout.Glyph(start, offset, glyph, y, size,
                        faces.computeIfAbsent(sourceFont, PageText::face)));
            }
            if (!box.isEmpty()) {
                charCount += text.length() + 1;
                if (charCount > MAX_TEXT) throw new IOException("PDF 正文过长，请拆分文档后导入。");
                row.add(new PageLayout.Line(text, box, font, glyphs));
            }
        }

        @Override protected void writeWordSeparator() {}
        @Override protected void writeLineSeparator() { flushRow(); }
        @Override protected void writeParagraphSeparator() { flushRow(); }

        @Override
        protected void endPage(PDPage page) throws IOException {
            flushRow();
            try { pages.getJSONObject(pageIndex).put("blocks", layout.organize(lines)); }
            catch (Exception error) { throw new IOException("无法读取 PDF 正文。", error); }
            lines.clear();
        }

        private void flushRow() {
            if (row.isEmpty()) return;
            lines.addAll(layout.splitRow(row));
            row.clear();
        }
    }

    private static JSONArray readText(File file) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (InputStream in = new FileInputStream(file)) { copy(in, bytes, 6L * 1024 * 1024); }
        byte[] data = bytes.toByteArray();
        Charset encoding = data.length >= 2 && ((data[0] == (byte) 0xFF && data[1] == (byte) 0xFE) ||
                (data[0] == (byte) 0xFE && data[1] == (byte) 0xFF)) ? StandardCharsets.UTF_16 : StandardCharsets.UTF_8;
        String text = new String(data, encoding).replaceFirst("^\\uFEFF", "").replace("\r\n", "\n");
        if (text.length() > MAX_TEXT) throw new IOException("正文过长，请拆分文档后导入。");
        JSONArray result = new JSONArray();
        StringBuilder para = new StringBuilder();
        boolean code = false;
        boolean references = false;
        for (String line : text.split("\n", -1)) {
            String trimmed = line.trim();
            String kind = code ? "code" : references ? "references" : "";
            boolean fence = trimmed.startsWith("\u0060\u0060\u0060") || trimmed.startsWith("~~~");
            boolean table = trimmed.startsWith("|") && trimmed.endsWith("|");
            boolean referenceTitle = trimmed.matches("(?i)^#*\\s*(references|bibliography|参考文献)\\s*[:：]?$");
            if (trimmed.isEmpty() || fence || table || referenceTitle || trimmed.startsWith("#")) {
                if (para.length() > 0) result.put(block(para.toString().trim(), kind, null));
                para.setLength(0);
                if (!trimmed.isEmpty()) {
                    result.put(block(trimmed, fence ? "code" : table && !code ? "table" : referenceTitle ? "references" : kind, null));
                }
                if (fence) code = !code;
                if (referenceTitle) references = true;
            } else if (code) {
                result.put(block(line, kind, null));
            } else {
                if (para.length() > 0) para.append(' ');
                para.append(trimmed);
            }
        }
        if (para.length() > 0) result.put(block(para.toString().trim(), references ? "references" : "", null));
        return result;
    }

    private static JSONArray readWord(File file) throws Exception {
        JSONArray result = new JSONArray();
        try (ZipFile zip = new ZipFile(file)) {
            ZipEntry entry = zip.getEntry("word/document.xml");
            if (entry == null || entry.getSize() > 12L * 1024 * 1024) {
                throw new IOException("DOCX 缺少正文或正文过大。");
            }
            try (InputStream raw = zip.getInputStream(entry)) {
                ByteArrayOutputStream xml = new ByteArrayOutputStream();
                copy(raw, xml, 12L * 1024 * 1024);
                XmlPullParser parser = Xml.newPullParser();
                parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true);
                parser.setInput(new ByteArrayInputStream(xml.toByteArray()), null);
                StringBuilder paragraph = new StringBuilder();
                int tableDepth = 0;
                int characters = 0;
                int paragraphDepth = -1;
                String wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
                for (int token; (token = parser.next()) != XmlPullParser.END_DOCUMENT;) {
                    if (!wordNamespace.equals(parser.getNamespace())) continue;
                    String tag = parser.getName();
                    if (token == XmlPullParser.START_TAG) {
                        if ("tbl".equals(tag)) tableDepth++;
                        if ("p".equals(tag) && paragraphDepth == -1) paragraphDepth = parser.getDepth();
                        if (paragraphDepth != -1 && "t".equals(tag)) paragraph.append(parser.nextText());
                        if (paragraphDepth != -1 && ("tab".equals(tag) || "br".equals(tag))) paragraph.append(' ');
                    } else if (token == XmlPullParser.END_TAG) {
                        if ("tbl".equals(tag)) tableDepth--;
                        if ("p".equals(tag) && paragraphDepth == parser.getDepth()) {
                            String text = paragraph.toString().trim();
                            characters += text.length();
                            if (characters > MAX_TEXT) throw new IOException("DOCX 正文过长，请拆分后导入。");
                            if (!text.isEmpty()) result.put(block(text, tableDepth > 0 ? "table" : "", null));
                            paragraph.setLength(0);
                            paragraphDepth = -1;
                        }
                    }
                }
            }
        }
        return result;
    }

    private static PdfRenderer openPdf(File file) throws IOException {
        ParcelFileDescriptor handle = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
        try { return new PdfRenderer(handle); }
        catch (IOException | RuntimeException error) { handle.close(); throw error; }
    }

    private static BitmapFactory.Options imageInfo(File file) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getPath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw new IOException("无法读取图片。");
        return bounds;
    }

    private static Bitmap render(File file, int number, int maxWidth, int maxHeight) throws IOException {
        if (!"pdf".equals(extension(file.getName()))) {
            if (number != 1 || !IMAGES.contains(extension(file.getName()))) throw new IOException("原文页面不可用。");
            BitmapFactory.Options info = imageInfo(file);
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = 1;
            while (info.outWidth / options.inSampleSize > 2 * maxWidth ||
                    info.outHeight / options.inSampleSize > 2 * maxHeight) options.inSampleSize *= 2;
            Bitmap image = BitmapFactory.decodeFile(file.getPath(), options);
            if (image == null) throw new IOException("无法读取图片。");
            float scale = Math.min(1, Math.min((float) maxWidth / image.getWidth(), (float) maxHeight / image.getHeight()));
            if (scale == 1) return image;
            Bitmap resized = Bitmap.createScaledBitmap(image, Math.max(1, Math.round(image.getWidth() * scale)),
                    Math.max(1, Math.round(image.getHeight() * scale)), true);
            if (resized != image) image.recycle();
            return resized;
        }
        try (PdfRenderer pdf = openPdf(file)) {
            if (number < 1 || number > pdf.getPageCount()) throw new IOException("页码超出文献范围。");
            try (PdfRenderer.Page page = pdf.openPage(number - 1)) {
                double scale = Math.min((double) maxWidth / page.getWidth(), (double) maxHeight / page.getHeight());
                Bitmap bitmap = Bitmap.createBitmap(Math.max(1, (int) Math.round(page.getWidth() * scale)),
                        Math.max(1, (int) Math.round(page.getHeight() * scale)), Bitmap.Config.ARGB_8888);
                bitmap.eraseColor(Color.WHITE);
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                return bitmap;
            }
        }
    }

    InputStream pageImage(String id, int number, int width) throws IOException {
        Bitmap image = render(source(id), number, Math.max(160, Math.min(width, 1800)), 2400);
        try {
            ByteArrayOutputStream png = new ByteArrayOutputStream();
            image.compress(Bitmap.CompressFormat.PNG, 100, png);
            return new ByteArrayInputStream(png.toByteArray());
        } finally { image.recycle(); }
    }

    synchronized JSONObject recognize(String id, int page, String language) throws Exception {
        File file = source(id);
        Bitmap bitmap = render(file, page, 2480, 3508);
        boolean latin = Arrays.asList("en", "de", "fr", "es").contains(language);
        try (TextRecognizer ocr = latin ? TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
                : TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build())) {
            Bitmap enhanced = ScanEnhancer.enhance(bitmap);
            if (enhanced != bitmap) {
                bitmap.recycle();
                bitmap = enhanced;
            }
            Text found = Tasks.await(ocr.process(InputImage.fromBitmap(bitmap, 0)), 95, TimeUnit.SECONDS);
            if (found.getText().trim().isEmpty()) {
                bitmap.recycle();
                bitmap = render(file, page, 2480, 3508);
                found = Tasks.await(ocr.process(InputImage.fromBitmap(bitmap, 0)), 95, TimeUnit.SECONDS);
            }
            int width = bitmap.getWidth(), height = bitmap.getHeight();
            PageLayout layout = new PageLayout(width, height);
            List<PageLayout.Line> lines = new ArrayList<>();
            for (Text.TextBlock item : found.getTextBlocks()) {
                for (Text.Line line : item.getLines()) {
                    Rect rect = line.getBoundingBox();
                    if (rect != null && !rect.isEmpty() && !line.getText().trim().isEmpty()) {
                        List<PageLayout.Line> words = new ArrayList<>();
                        for (Text.Element element : line.getElements()) {
                            Rect area = element.getBoundingBox();
                            if (area != null && !area.isEmpty()) {
                                words.add(new PageLayout.Line(element.getText(), new RectF(area), rect.height()));
                            }
                        }
                        if (latin && words.size() > 1) lines.addAll(layout.splitRow(words));
                        else lines.add(new PageLayout.Line(line.getText(), new RectF(rect), rect.height()));
                    }
                }
            }
            return new JSONObject().put("mode", "ocr").put("width", width).put("height", height)
                    .put("blocks", layout.organize(lines));
        } finally {
            bitmap.recycle();
        }
    }

    File createExport(JSONObject options) throws Exception {
        File output = File.createTempFile("paper-export-", ".tmp", context.getCacheDir());
        try (FileOutputStream stream = new FileOutputStream(output)) {
            if ("text".equals(options.getString("kind"))) {
                stream.write(options.getString("text").getBytes(StandardCharsets.UTF_8));
            } else {
                writePdf(options, stream);
            }
            return output;
        } catch (Exception error) {
            output.delete();
            throw error;
        }
    }

    private void writePdf(JSONObject options, OutputStream output) throws Exception {
        JSONArray pages = options.getJSONArray("pages");
        if (pages.length() == 0 || pages.length() > MAX_PAGES) throw new IOException("导出页数无效。");
        String kind = options.getString("kind");
        boolean dual = "bilingual".equals(kind);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        Typeface serif = Typeface.createFromAsset(context.getAssets(), "www/SourceHanSerifCN-Regular.otf");
        PdfDocument pdf = new PdfDocument();
        try {
            for (int i = 0; i < pages.length(); i++) {
                JSONObject model = pages.getJSONObject(i);
                JSONObject left = model.optJSONObject("left");
                JSONObject right = model.optJSONObject("right");
                boolean nativeLeft = model.optBoolean("native");
                boolean nativeRight = right != null && right.optDouble("sourceHeight", 0) > 0;
                Bitmap original = nativeLeft || nativeRight ? render(source(options.getString("id")), i + 1, 1150, 1800) : null;
                int leftHeight = nativeLeft ? Math.min(6000, Math.round(540f * original.getHeight() / original.getWidth()))
                        : left == null ? 0 : left.getInt("height");
                int rightHeight = right == null ? 0 : right.getInt("height");
                int height = Math.max(leftHeight, rightHeight);
                if (height < 1 || height > 14_400) throw new IOException("导出页面尺寸超出范围。");
                PdfDocument.Page page = pdf.startPage(new PdfDocument.PageInfo.Builder(dual ? 1096 : 540, height, i + 1).create());
                Canvas canvas = page.getCanvas();
                canvas.drawColor(Color.WHITE);
                if (nativeLeft) {
                    drawImage(canvas, original, 0, leftHeight, paint);
                    if (dual && model.optBoolean("copyRight")) drawImage(canvas, original, 556, leftHeight, paint);
                } else if (left != null) drawTextPage(canvas, left, 0, paint, original, serif);
                int rightOffset = dual ? 556 : 0;
                if (nativeRight) drawImage(canvas, original, rightOffset, (float) right.getDouble("sourceHeight"), paint);
                if (right != null) drawTextPage(canvas, right, rightOffset, paint, original, serif);
                pdf.finishPage(page);
            }
            pdf.writeTo(output);
        } finally { pdf.close(); }
    }

    private static void drawImage(Canvas canvas, Bitmap bitmap, int offset, float height, Paint paint) {
        canvas.drawBitmap(bitmap, null, new RectF(offset, 0, offset + 540, height), paint);
    }

    private static void drawTextPage(Canvas canvas, JSONObject model, int offset, Paint paint,
                                     Bitmap original, Typeface serif) throws Exception {
        JSONArray masks = model.optJSONArray("masks");
        if (masks != null) {
            paint.setColor(Color.WHITE);
            for (int i = 0; i < masks.length(); i++) {
                JSONArray mask = masks.getJSONArray(i);
                float x = (float) mask.getDouble(0) + offset;
                float y = (float) mask.getDouble(1);
                canvas.drawRect(x, y, x + (float) mask.getDouble(2), y + (float) mask.getDouble(3), paint);
            }
        }
        JSONArray crops = model.optJSONArray("crops");
        if (original != null && crops != null) {
            for (int i = 0; i < crops.length(); i++) {
                JSONArray crop = crops.getJSONArray(i);
                JSONArray box = crop.getJSONArray(0);
                int left = Math.max(0, (int) Math.floor(box.getDouble(0) * original.getWidth()));
                int top = Math.max(0, (int) Math.floor(box.getDouble(1) * original.getHeight()));
                int right = Math.min(original.getWidth(), (int) Math.ceil((box.getDouble(0) + box.getDouble(2)) * original.getWidth()));
                int bottom = Math.min(original.getHeight(), (int) Math.ceil((box.getDouble(1) + box.getDouble(3)) * original.getHeight()));
                if (left >= right || top >= bottom) continue;
                float x = offset + (float) crop.getDouble(1);
                float y = (float) crop.getDouble(2);
                canvas.drawBitmap(original, new Rect(left, top, right, bottom),
                        new RectF(x, y, x + (float) crop.getDouble(3), y + (float) crop.getDouble(4)), paint);
            }
        }
        JSONArray lines = model.getJSONArray("lines");
        paint.setColor(Color.rgb(34, 42, 59));
        for (int i = 0; i < lines.length(); i++) {
            JSONArray line = lines.getJSONArray(i);
            paint.setTextSize((float) line.getDouble(3));
            JSONArray face = line.optJSONArray(7);
            int style = face == null ? (line.getBoolean(4) ? Typeface.BOLD : Typeface.NORMAL) : face.optInt(1) & 3;
            String family = face == null ? "sans-serif" : face.optString(0);
            paint.setTypeface("paper-serif".equals(family) ? Typeface.create(serif, style) : Typeface.create(family, style));
            canvas.drawText(line.getString(0), offset + (float) line.getDouble(1), (float) line.getDouble(2), paint);
        }
    }
}
