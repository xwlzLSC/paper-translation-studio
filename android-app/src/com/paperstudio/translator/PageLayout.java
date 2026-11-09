package com.paperstudio.translator;

import android.graphics.RectF;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/** Groups positioned PDF words and OCR lines into source regions in reading order. */
final class PageLayout {
    private static final Pattern FOLIO = Pattern.compile(
            "(?i)(?:^\\s*\\d{1,6}\\s*$|IEEE\\s+JOURNAL|\\bVOL\\.\\s*\\d|\\bet\\s+al\\.:|authorized licensed use|downloaded on|rights reserved|©)");
    private static final Pattern CAPTION = Pattern.compile("(?i)^(?:fig(?:ure)?\\.?\\s*\\d|table\\s+[ivxlcdm\\d]+\\b)");
    private static final Pattern HEADING = Pattern.compile("(?i)^(?:[ivxlcdm]+\\.|[a-h]\\.)\\s+\\p{L}");
    private static final Pattern BYLINE = Pattern.compile("^,?\\s*(?:and\\s+)?\\p{Lu}[\\p{L}.'’-]+\\s+\\p{Lu}[\\p{L}.'’-]+\\s*(?:,|$)");
    private static final Pattern WRAPPED_SUFFIX = Pattern.compile("(?i)^(?:[a-z]{0,6}(?:tion|tions|tor|tors|ment|ments|ence|ance|ivity|ative|parator|parators))\\b");
    private static final Pattern KEEP_HYPHEN = Pattern.compile(
            "(?i).*(?:\\b(?:analog|charge|clock|closed|common|cross|current|differential|double|dual|full|gain|high|input|large|low|mixed|noise|non|open|output|phase|power|pre|rail|self|short|signal|single|small|source|time|two|voltage|wide))-$");
    private static final Pattern LATIN_WORD = Pattern.compile("[A-Za-z]{3,}");

    static final class Face {
        final String family;
        final int style;
        final boolean math;

        Face(String family, int style, boolean math) {
            this.family = family;
            this.style = style;
            this.math = math;
        }
    }

    static final class Glyph {
        final int start;
        final int end;
        final RectF box;
        final float baseline;
        final float size;
        final Face face;

        Glyph(int start, int end, RectF box, float baseline, float size, Face face) {
            this.start = start;
            this.end = end;
            this.box = box;
            this.baseline = baseline;
            this.size = size;
            this.face = face;
        }

        Glyph at(int offset) {
            return new Glyph(start + offset, end + offset, box, baseline, size, face);
        }
    }

    static final class Line {
        final String text;
        final RectF box;
        final float font;
        final List<Glyph> glyphs;

        Line(String text, RectF box, float font) {
            this(text.trim(), box, font, java.util.Collections.emptyList());
        }

        Line(String text, RectF box, float font, List<Glyph> glyphs) {
            this.text = text;
            this.box = box;
            this.font = font;
            this.glyphs = glyphs;
        }
    }

    private static final class Region {
        final List<Line> lines = new ArrayList<>();
        final RectF box;
        final int lane;
        final String kind;
        final float font;

        Region(Line line, int lane, String kind) {
            this.lane = lane;
            this.kind = kind;
            this.font = line.font;
            box = new RectF(line.box);
            lines.add(line);
        }

        void add(Line line) {
            box.union(line.box);
            lines.add(line);
        }
    }

    private final float width;
    private final float height;

    PageLayout(float width, float height) {
        this.width = width;
        this.height = height;
    }

    List<Line> splitRow(List<Line> words) {
        words.sort(Comparator.comparingDouble(word -> word.box.left));
        List<Line> result = new ArrayList<>();
        StringBuilder text = new StringBuilder();
        RectF box = new RectF();
        List<Float> fonts = new ArrayList<>();
        List<Glyph> glyphs = new ArrayList<>();
        for (Line word : words) {
            if (word.text.isEmpty()) continue;
            float gap = word.box.left - box.right;
            boolean spansCenter = box.right <= width * .506f && word.box.left >= width * .494f;
            float threshold = spansCenter ? Math.max(width * .008f, word.font * .95f)
                    : Math.max(width * .042f, word.font * 2.15f);
            if (text.length() > 0 && gap > threshold) {
                result.add(new Line(text.toString(), box, typicalFont(fonts), glyphs));
                text.setLength(0);
                box = new RectF();
                fonts.clear();
                glyphs = new ArrayList<>();
            }
            if (text.length() == 0) box.set(word.box);
            else {
                text.append(' ');
                box.union(word.box);
            }
            for (Glyph glyph : word.glyphs) glyphs.add(glyph.at(text.length()));
            text.append(word.text);
            fonts.add(word.font);
        }
        if (text.length() > 0) result.add(new Line(text.toString(), box, typicalFont(fonts), glyphs));
        return result;
    }

    private static float typicalFont(List<Float> fonts) {
        fonts.sort(Float::compare);
        return fonts.get(fonts.size() / 2);
    }

    private float findGutter(List<Line> lines) {
        float best = 0;
        float score = 0;
        for (int step = 43; step <= 57; step++) {
            float center = width * step / 100;
            int left = 0, right = 0, cross = 0;
            for (Line line : lines) {
                if (line.text.length() < 24 || line.box.width() < width * .15f ||
                        line.box.top < height * .11f || line.box.bottom > height * .96f) continue;
                if (line.box.right <= center + width * .005f) left++;
                else if (line.box.left >= center - width * .005f) right++;
                else cross++;
            }
            float candidate = Math.min(left, right) - cross * 0.95f - Math.abs(step - 50) * .09f;
            if (left >= 5 && right >= 4 && cross <= (left + right) / 4 && candidate > score) {
                score = candidate;
                best = center;
            }
        }
        return best;
    }

    private String lineKind(Line line, float bodyFont) {
        String text = line.text;
        boolean edge = line.box.top < height * .063f || line.box.bottom > height * .948f;
        boolean lowerMargin = line.box.top > height * .89f;
        if ((edge && (FOLIO.matcher(text).find() || line.font < bodyFont * .78f)) ||
                (lowerMargin && FOLIO.matcher(text).find())) return "furniture";
        if (CAPTION.matcher(text).find()) return text.toLowerCase(Locale.ROOT).startsWith("table") ? "table" : "caption";
        if (text.length() < 110 && (HEADING.matcher(text).find() ||
                (line.font >= bodyFont * 1.22f && line.box.width() >= width * .26f))) return "heading";
        if (text.length() < 110 && text.matches(".*[=∑∫√≤≥≃≅±].*")) {
            java.util.regex.Matcher words = LATIN_WORD.matcher(text);
            int count = 0;
            while (words.find()) count++;
            if (count <= 3) return "formula";
        }
        return "";
    }

    private boolean follows(Region region, Line line, String kind, float bodyFont) {
        if (region == null || "furniture".equals(kind) || "formula".equals(kind) || "table".equals(kind)) return false;
        if (!kind.equals(region.kind) && !("caption".equals(region.kind) && kind.isEmpty())) return false;
        Line previous = region.lines.get(region.lines.size() - 1);
        float font = Math.max(previous.font, line.font);
        float delta = line.box.top - previous.box.top;
        boolean dropCap = region.lines.size() == 1 && previous.box.height() > font * 2.2f &&
                line.box.top < previous.box.bottom && Math.abs(line.box.right - previous.box.right) < font * 1.4f;
        if (delta < font * .57f || (!dropCap && delta > font * 1.73f) ||
                Math.abs(previous.font - line.font) > font * .30f) return false;
        boolean heading = "heading".equals(kind);
        float indent = line.box.left - region.box.left;
        if (heading) return Math.abs(line.box.centerX() - region.box.centerX()) <= width * .065f;
        if (indent < -font * 1.7f || indent > font * (dropCap ? 4.5f : 2.3f)) return false;
        return !(indent > bodyFont * .85f && previous.text.matches(".*[.!?。！？]$"));
    }

    private static boolean nearby(Glyph left, Glyph right, float size) {
        return right.box.left >= left.box.left - size * .18f && right.box.left - left.box.right <= size * .24f;
    }

    private static boolean script(Glyph base, Glyph candidate, String text) {
        float rise = Math.abs(base.baseline - candidate.baseline);
        int codePoint = text.codePointAt(candidate.start);
        if (codePoint >= 0x2070 && codePoint <= 0x209F || "¹²³".indexOf(codePoint) >= 0) return true;
        return candidate.size >= base.size * .50f && candidate.size <= base.size * .83f
                && rise >= base.size * .13f && rise <= base.size * .72f
                && (Character.isLetterOrDigit(codePoint) || "+-−±,()".indexOf(codePoint) >= 0);
    }

    private void collectNotation(Line line, int offset, JSONArray notation) throws JSONException {
        List<Glyph> glyphs = line.glyphs;
        int previousEnd = 0;
        for (int i = 1; i < glyphs.size(); i++) {
            Glyph base = glyphs.get(i - 1);
            Glyph mark = glyphs.get(i);
            int baseChar = line.text.codePointAt(base.start);
            if (!(Character.isLetterOrDigit(baseChar) || ")]%".indexOf(baseChar) >= 0)
                    || !nearby(base, mark, base.size) || !script(base, mark, line.text)) continue;
            int first = i - 1;
            while (first > 0) {
                Glyph previous = glyphs.get(first - 1);
                if (!nearby(previous, glyphs.get(first), base.size) || Math.abs(previous.baseline - base.baseline) > base.size * .18f) break;
                int previousChar = line.text.codePointAt(previous.start);
                if (previous.face.math || Character.isDigit(previousChar) && Character.isDigit(baseChar)) first--;
                else {
                    if (first == i - 1 && !base.face.math && (base.face.style & 2) == 0
                            && Character.isLowerCase(baseChar) && Character.isLowerCase(previousChar)) first = i;
                    break;
                }
            }
            int last = i;
            while (last + 1 < glyphs.size() && nearby(glyphs.get(last), glyphs.get(last + 1), base.size * .70f)
                    && Math.abs(mark.baseline - glyphs.get(last + 1).baseline) <= base.size * .18f
                    && script(base, glyphs.get(last + 1), line.text)) last++;
            int start = glyphs.get(first).start;
            int end = glyphs.get(last).end;
            i = last;
            if (start < previousEnd || end - mark.start > 20 || line.text.substring(mark.start, end).contains(" ")) continue;
            previousEnd = end;
            RectF box = new RectF(glyphs.get(first).box);
            for (int j = first + 1; j <= last; j++) box.union(glyphs.get(j).box);
            box.inset(-.18f, -.30f);
            notation.put(new JSONArray().put(offset + start).put(offset + end)
                    .put(normalized(box)).put((base.baseline - box.top) / box.height()).put(base.size / width));
        }
    }

    private static JSONArray typeface(List<Line> lines) throws JSONException {
        Map<Face, Float> widths = new LinkedHashMap<>();
        for (Line line : lines) for (Glyph glyph : line.glyphs) {
            if (!glyph.face.math) widths.merge(glyph.face, glyph.box.width(), Float::sum);
        }
        Face face = null;
        float width = 0;
        for (Map.Entry<Face, Float> entry : widths.entrySet()) {
            if (entry.getValue() > width) {
                width = entry.getValue();
                face = entry.getKey();
            }
        }
        return face == null ? null : new JSONArray().put(face.family).put(face.style);
    }

    private String join(List<Line> lines, JSONArray notation) throws JSONException {
        StringBuilder text = new StringBuilder();
        boolean joinsSoftHyphen = false;
        for (Line line : lines) {
            if (text.length() > 0 && !joinsSoftHyphen) {
                char last = text.charAt(text.length() - 1);
                if (last == '-' && Character.isLowerCase(line.text.charAt(0))) {
                    if (WRAPPED_SUFFIX.matcher(line.text).find() && !KEEP_HYPHEN.matcher(text).matches()) {
                        text.setLength(text.length() - 1);
                    }
                } else if (!(Character.UnicodeScript.of(last) == Character.UnicodeScript.HAN &&
                        Character.UnicodeScript.of(line.text.charAt(0)) == Character.UnicodeScript.HAN)) {
                    text.append(' ');
                }
            }
            joinsSoftHyphen = line.text.endsWith("\u00ad");
            if (line.text.indexOf('\u00ad') < 0) collectNotation(line, text.length(), notation);
            text.append(line.text.replace("\u00ad", ""));
        }
        return text.toString();
    }

    private JSONArray normalized(RectF rect) throws JSONException {
        float x = Math.max(0, rect.left / width);
        float y = Math.max(0, rect.top / height);
        return new JSONArray().put(x).put(y).put(Math.max(0, Math.min(1, rect.right / width) - x))
                .put(Math.max(0, Math.min(1, rect.bottom / height) - y));
    }

    JSONArray organize(List<Line> lines) throws JSONException {
        lines.removeIf(line -> line.text.isEmpty() || line.box.isEmpty());
        lines.sort(Comparator.comparingDouble((Line line) -> line.box.top).thenComparingDouble(line -> line.box.left));
        List<Float> fonts = new ArrayList<>();
        for (Line line : lines) if (line.text.length() >= 30 && line.box.top > height * .08f && line.box.bottom < height * .94f) fonts.add(line.font);
        fonts.sort(Float::compare);
        float bodyFont = fonts.isEmpty() ? width * .018f : fonts.get(fonts.size() / 2);
        float gutter = findGutter(lines);
        float bylineEnd = 0;
        Region[] last = new Region[3];
        List<Region> regions = new ArrayList<>();
        for (Line line : lines) {
            int lane = gutter == 0 ? 0 : line.box.right <= gutter + width * .007f ? 1 :
                    line.box.left >= gutter - width * .007f ? 2 : 0;
            String kind = lineKind(line, bodyFont);
            if ("heading".equals(kind) && line.box.top < height * .16f &&
                    line.box.width() > width * .48f && line.font > bodyFont * 1.28f) {
                bylineEnd = line.box.bottom + height * .047f;
            } else if (kind.isEmpty() && line.box.top < bylineEnd && line.text.length() <= 120 &&
                    BYLINE.matcher(line.text).find()) {
                kind = "byline";
            }
            Region current = last[lane];
            if (follows(current, line, kind, bodyFont)) current.add(line);
            else {
                current = new Region(line, lane, kind);
                regions.add(current);
                last[lane] = current;
            }
        }

        // Full-width titles and headings divide a page into reading bands.
        List<Region> ordered = new ArrayList<>();
        List<Region> left = new ArrayList<>(), right = new ArrayList<>();
        for (Region region : regions) {
            if (region.lane == 0) {
                ordered.addAll(left);
                ordered.addAll(right);
                left.clear();
                right.clear();
                ordered.add(region);
            } else (region.lane == 1 ? left : right).add(region);
        }
        ordered.addAll(left);
        ordered.addAll(right);

        JSONArray blocks = new JSONArray();
        for (Region region : ordered) {
            JSONArray notation = new JSONArray();
            String text = join(region.lines, notation);
            String kind = region.kind;
            if (kind.isEmpty() && fonts.size() >= 8 && region.lines.size() == 1 &&
                    region.box.width() < width * .135f && text.length() < 24 &&
                    !text.matches(".*[.!?。！？]$")) kind = "artwork";
            JSONArray masks = new JSONArray();
            for (Line line : region.lines) masks.put(normalized(line.box));
            JSONObject block = new JSONObject().put("text", text).put("kind", kind).put("box", normalized(region.box))
                    .put("masks", masks).put("font", region.font / width);
            JSONArray typeface = typeface(region.lines);
            if (typeface != null) block.put("typeface", typeface);
            if (notation.length() > 0) block.put("notation", notation);
            blocks.put(block);
        }
        return blocks;
    }
}
