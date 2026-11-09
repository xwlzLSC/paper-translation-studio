package com.paperstudio.translator;

import android.graphics.Bitmap;

/** Improves contrast for recognition without moving pixels or changing the displayed page. */
final class ScanEnhancer {
    private static final int TILE = 128;
    private static final int SAMPLE = 4;

    private ScanEnhancer() {}

    static Bitmap enhance(Bitmap source) {
        int width = source.getWidth(), height = source.getHeight();
        int columns = (width + TILE - 1) / TILE, rows = (height + TILE - 1) / TILE;
        int[][] tiles = new int[rows * columns][256];
        int[] histogram = new int[256];
        int[] pixels = new int[width];
        for (int y = 0; y < height; y += SAMPLE) {
            source.getPixels(pixels, 0, width, 0, y, width, 1);
            int row = (y / TILE) * columns;
            for (int x = 0; x < width; x += SAMPLE) {
                int value = luminance(pixels[x]);
                histogram[value]++;
                tiles[row + x / TILE][value]++;
            }
        }
        int white = percentile(histogram, .95f);
        int black = percentile(histogram, .008f);
        float gain = Math.max(1f, Math.min(2.65f, 247f / Math.max(1, white - black)));
        int[] lights = new int[tiles.length];
        for (int i = 0; i < tiles.length; i++) {
            int level = percentile(tiles[i], .85f);
            lights[i] = Math.max(white - 52, Math.min(white + 25, level));
        }

        Bitmap result = source.isMutable() ? source : source.copy(Bitmap.Config.ARGB_8888, true);
        if (result == null) return source;
        for (int y = 0; y < height; y++) {
            source.getPixels(pixels, 0, width, 0, y, width, 1);
            float tileY = Math.max(0, Math.min(rows - 1, (float) y / TILE - .5f));
            int y1 = (int) tileY, y2 = Math.min(y1 + 1, rows - 1);
            for (int x = 0; x < width; x++) {
                float tileX = Math.max(0, Math.min(columns - 1, (float) x / TILE - .5f));
                int x1 = (int) tileX, x2 = Math.min(x1 + 1, columns - 1);
                float top = blend(lights[y1 * columns + x1], lights[y1 * columns + x2], tileX - x1);
                float bottom = blend(lights[y2 * columns + x1], lights[y2 * columns + x2], tileX - x1);
                float background = blend(top, bottom, tileY - y1);
                int gray = Math.max(0, Math.min(255, Math.round(251 + (luminance(pixels[x]) - background) * gain)));
                pixels[x] = 0xff000000 | gray * 0x010101;
            }
            result.setPixels(pixels, 0, width, 0, y, width, 1);
        }
        return result;
    }

    private static float blend(float a, float b, float fraction) {
        return a + (b - a) * fraction;
    }

    private static int percentile(int[] histogram, float fraction) {
        int count = 0;
        for (int value : histogram) count += value;
        int remaining = Math.max(1, (int) Math.ceil(count * fraction));
        for (int value = 0; value < histogram.length; value++) {
            remaining -= histogram[value];
            if (remaining <= 0) return value;
        }
        return 255;
    }

    private static int luminance(int pixel) {
        int gray = (77 * (pixel >> 16 & 255) + 150 * (pixel >> 8 & 255) + 29 * (pixel & 255)) >> 8;
        int alpha = pixel >>> 24;
        return 255 - (255 - gray) * alpha / 255;
    }
}
