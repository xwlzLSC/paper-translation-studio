package com.paperstudio.translator;

import android.app.ActivityManager;
import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.function.IntConsumer;
import java.util.function.IntPredicate;

final class PrecisionModel {
    static final String NAME = "Hy-MT2-1.8B-Q4_K_M.gguf";
    private static final String ASSET = "models/" + NAME;
    private static final long BYTES = 1133080448L;
    private static final String SHA256 = "dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699";

    private final Context context;
    private final File file;
    private final boolean bundled;
    private final Object state = new Object();
    private long engine;
    private String running;
    private volatile boolean cancelled;
    private boolean closed;
    private boolean importing;

    PrecisionModel(Context context) {
        this.context = context;
        file = new File(context.getFilesDir(), ASSET);
        bundled = hasBundledModel();
    }

    private static final class Library {
        static final boolean AVAILABLE = load();

        private static boolean load() {
            if (!android.os.Process.is64Bit()) return false;
            try { System.loadLibrary("paper_precision"); return true; }
            catch (LinkageError error) { return false; }
        }
    }

    JSONObject status() throws Exception {
        boolean imported = imported();
        return new JSONObject().put("supported", Library.AVAILABLE).put("installed", bundled || imported)
                .put("bundled", bundled).put("imported", imported)
                .put("name", NAME).put("bytes", BYTES);
    }

    private boolean imported() { return file.isFile() && file.length() == BYTES; }
    private boolean installed() { return bundled || imported(); }

    private boolean hasBundledModel() {
        try (AssetFileDescriptor model = context.getAssets().openFd(ASSET)) {
            return model.getDeclaredLength() == BYTES;
        } catch (IOException missing) {
            return false;
        }
    }

    private long loadEngine(int threads, Progress progress) throws IOException {
        IntPredicate loading = new IntPredicate() {
            private int last = 0;

            @Override public boolean test(int percent) {
                if (cancelled) return false;
                if (percent - last >= 5 || (percent == 100 && last < 100)) {
                    last = percent;
                    progress.update("model", percent);
                }
                return true;
            }
        };
        if (!bundled) return openEngine(file.getAbsolutePath().getBytes(StandardCharsets.UTF_8), threads, loading);
        try (AssetFileDescriptor model = context.getAssets().openFd(ASSET)) {
            return openBundledEngine(model.getParcelFileDescriptor().getFd(), model.getStartOffset(), threads, loading);
        }
    }

    void install(Uri uri) throws Exception {
        if (!Library.AVAILABLE) throw new IOException("本机精译需要 64 位安卓设备。");
        if (!"content".equals(uri.getScheme())) throw new IOException("请使用系统文件选择器导入模型。");
        synchronized (state) {
            if (closed || importing || running != null) throw new IOException("请等当前本机精译操作结束。");
            if (installed()) return;
            importing = true;
        }
        File temporary = null;
        try {
            try (Cursor cursor = context.getContentResolver().query(uri,
                    new String[]{OpenableColumns.SIZE}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0) && cursor.getLong(0) != BYTES) {
                    throw new IOException("请选择完整的 " + NAME + " 官方文件。");
                }
            }
            File directory = file.getParentFile();
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建模型目录。");
            if (directory.getUsableSpace() < BYTES + 16 * 1024 * 1024L) {
                throw new IOException("导入模型需要约 1.14 GB 额外可用空间。");
            }
            temporary = File.createTempFile("precision-", ".tmp", directory);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long total = 0;
            try (InputStream in = context.getContentResolver().openInputStream(uri);
                 FileOutputStream out = new FileOutputStream(temporary)) {
                if (in == null) throw new IOException("无法读取所选模型文件。");
                byte[] buffer = new byte[1024 * 1024];
                for (int count; (count = in.read(buffer)) != -1;) {
                    if (Thread.currentThread().isInterrupted()) throw new IOException("模型导入已取消。");
                    total += count;
                    if (total > BYTES) throw new IOException("模型文件大小不符合要求。");
                    digest.update(buffer, 0, count);
                    out.write(buffer, 0, count);
                }
                out.getFD().sync();
            }
            StringBuilder hash = new StringBuilder();
            for (byte value : digest.digest()) hash.append(String.format(Locale.ROOT, "%02x", value & 0xff));
            if (total != BYTES || !SHA256.contentEquals(hash)) {
                throw new IOException("模型 SHA-256 校验失败。请选择官方下载的 Q4_K_M 文件。");
            }
            synchronized (state) {
                if (closed || !temporary.renameTo(file)) throw new IOException("无法保存本机精译模型。");
            }
        } finally {
            if (temporary != null) temporary.delete();
            synchronized (state) { importing = false; }
        }
    }

    void remove() throws IOException {
        synchronized (state) {
            if (running != null || importing) throw new IOException("请等当前本机精译操作结束。");
            releaseEngine();
            if (file.exists() && !file.delete()) throw new IOException("模型文件删除失败。");
        }
    }

    interface Progress {
        void update(String stage, int value);
    }

    JSONArray translate(String job, JSONArray prompts, Progress progress) throws Exception {
        if (!Library.AVAILABLE || !installed()) throw new IOException("请先在翻译设置中导入本机精译模型。");
        if (prompts.length() < 1 || prompts.length() > 4) throw new IOException("本机精译批次无效。");
        synchronized (state) {
            if (closed || running != null || importing) throw new IOException("另一个本机精译请求正在处理。");
            if (!installed()) throw new IOException("请先导入本机精译模型。");
            running = job;
            cancelled = false;
        }
        try {
            if (engine == 0) {
                progress.update("model", 0);
                ActivityManager manager = context.getSystemService(ActivityManager.class);
                if (manager != null) {
                    ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
                    manager.getMemoryInfo(memory);
                    if (memory.lowMemory || memory.availMem < (768L << 20)) {
                        throw new IOException("设备当前可用内存不足。释放内存后重试，或切换本机离线模式。");
                    }
                }
                int threads = Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() - 1));
                long loaded = loadEngine(threads, progress);
                synchronized (state) { engine = loaded; }
            }
            synchronized (state) {
                if (closed || cancelled) throw new IOException("本机精译已取消。");
                setCancelled(engine, false);
            }
            JSONArray output = new JSONArray();
            IntConsumer tokens = count -> progress.update("tokens", count);
            for (int i = 0; i < prompts.length(); i++) {
                String prompt = prompts.getString(i);
                if (prompt.length() > 5200) throw new IOException("段落和背景信息超出本机精译长度。");
                progress.update("prompt", 0);
                byte[] result = generateText(engine, prompt.getBytes(StandardCharsets.UTF_8), tokens);
                String translation = new String(result, StandardCharsets.UTF_8).trim();
                int thought = translation.indexOf("</think>");
                if (thought >= 0) translation = translation.substring(thought + 8).trim();
                if (translation.startsWith("<think>") || translation.isEmpty() || translation.indexOf('\ufffd') >= 0) {
                    throw new IOException("本机精译未返回可用译文。请重试本页。");
                }
                output.put(translation);
            }
            return output;
        } finally {
            synchronized (state) {
                running = null;
                if (closed) releaseEngine();
            }
        }
    }

    void cancel(String job) {
        synchronized (state) {
            if (!job.equals(running)) return;
            cancelled = true;
            if (engine != 0) setCancelled(engine, true);
        }
    }

    void trim() {
        synchronized (state) { if (running == null) releaseEngine(); }
    }

    void close() {
        synchronized (state) {
            closed = true;
            cancelled = true;
            if (running == null) releaseEngine();
            else if (engine != 0) setCancelled(engine, true);
        }
    }

    private void releaseEngine() {
        if (engine != 0) { closeEngine(engine); engine = 0; }
    }

    private static native long openEngine(byte[] path, int threads, IntPredicate progress) throws IOException;
    private static native long openBundledEngine(int descriptor, long offset, int threads, IntPredicate progress) throws IOException;
    private static native byte[] generateText(long engine, byte[] prompt, IntConsumer progress) throws IOException;
    private static native void setCancelled(long engine, boolean cancelled);
    private static native void closeEngine(long engine);
}
