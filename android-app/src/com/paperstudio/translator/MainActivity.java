package com.paperstudio.translator;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity {
    private static final String HOST = "appassets.paperstudio.local";
    private static final String HOME_URL = "https://" + HOST + "/index.html?android=2.2";
    private static final int OPEN_FILES = 1001;
    private static final int SAVE_FILE = 1002;
    private static final int OPEN_MODEL = 1003;
    private static final Pattern STATIC_FILE = Pattern.compile("/static/([a-zA-Z0-9_.-]+)");
    private static final Pattern PAGE_IMAGE = Pattern.compile("/native/pages/([a-f0-9]{32})/(\\d{1,3})\\.png");
    private final ExecutorService workers = Executors.newFixedThreadPool(3);
    private final ExecutorService apiWorkers = Executors.newFixedThreadPool(8);
    private WebView webView;
    private Documents documents;
    private PrecisionModel precision;
    private String modelRequest;
    private String pickerRequest;
    private Export pendingExport;
    private boolean workerClientInstalled;

    private static final class Export {
        final String request;
        final File file;
        final boolean temporary;

        Export(String request, File file, boolean temporary) {
            this.request = request;
            this.file = file;
            this.temporary = temporary;
        }

        void cleanUp() {
            if (temporary) file.delete();
        }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        PDFBoxResourceLoader.init(getApplicationContext());
        documents = new Documents(getApplicationContext());
        precision = new PrecisionModel(getApplicationContext());
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        try {
            webView = new WebView(this);
        } catch (RuntimeException error) {
            showWebViewError("请安装或更新 Android System WebView 后重新打开论文译读。");
            return;
        }
        FrameLayout layout = new FrameLayout(this);
        layout.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(layout);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            layout.setBackgroundColor(Color.rgb(249, 250, 255));
            layout.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                int bottom = Math.max(bars.bottom, insets.getInsets(WindowInsets.Type.ime()).bottom);
                view.setPadding(bars.left, bars.top, bars.right, bottom);
                return insets;
            });
            WindowInsetsController bars = getWindow().getInsetsController();
            if (bars != null) {
                int appearance = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS |
                        WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                bars.setSystemBarsAppearance(appearance, appearance);
            }
        }

        WebSettings settings = webView.getSettings();
        Matcher chromium = Pattern.compile("Chrome/(\\d+)").matcher(String.valueOf(settings.getUserAgentString()));
        if (chromium.find() && Integer.parseInt(chromium.group(1)) < 90) {
            showWebViewError("请更新 Android System WebView 后重新打开论文译读。");
            return;
        }
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        webView.setWebChromeClient(new WebChromeClient());
        webView.addJavascriptInterface(new NativeBridge(), "AndroidPdfBridge");
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return isAppOrigin(request.getUrl()) && "GET".equals(request.getMethod())
                        ? loadResource(request.getUrl()) : unavailable(403, "Forbidden");
            }
        });
        workerClientInstalled = true;
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isAppOrigin(request.getUrl());
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!isAppOrigin(request.getUrl()) || !"GET".equals(request.getMethod())) {
                    return unavailable(403, "Forbidden");
                }
                return loadResource(request.getUrl());
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                webView = null;
                showWebViewError("阅读器已停止。点击此处重新打开，已保存的文献仍在文献库。");
                view.destroy();
                return true;
            }
        });
        webView.loadUrl(HOME_URL);
    }

    private void showWebViewError(String message) {
        TextView error = new TextView(this);
        error.setPadding(36, 64, 36, 36);
        error.setTextSize(18);
        error.setText(message);
        error.setOnClickListener(view -> recreate());
        setContentView(error);
    }

    private static boolean isAppOrigin(Uri uri) {
        return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost()) &&
                (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private WebResourceResponse loadResource(Uri uri) {
        String path = uri.getPath() == null ? "" : uri.getPath();
        try {
            Matcher page = PAGE_IMAGE.matcher(path);
            if (page.matches()) {
                String requested = uri.getQueryParameter("width");
                int width = requested == null ? 960 : Integer.parseInt(requested);
                return new WebResourceResponse("image/png", null,
                        documents.pageImage(page.group(1), Integer.parseInt(page.group(2)), width));
            }
            Matcher asset = STATIC_FILE.matcher(path);
            String name = "/".equals(path) || "/index.html".equals(path) ? "index.html"
                    : asset.matches() ? asset.group(1) : "";
            if (name.isEmpty() || ".".equals(name) || "..".equals(name)) return unavailable(404, "Not Found");
            String mime = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css"
                    : name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".png") ? "image/png"
                    : name.endsWith(".otf") ? "font/otf" : "text/html";
            HashMap<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            if ("index.html".equals(name)) {
                headers.put("Content-Security-Policy",
                        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
                        "img-src 'self' blob: data:; connect-src 'self' blob:; object-src 'none'; frame-src 'none'");
            }
            return new WebResourceResponse(mime, name.endsWith(".png") || name.endsWith(".otf") ? null : "UTF-8",
                    200, "OK", headers, getAssets().open("www/" + name));
        } catch (Exception error) {
            return unavailable(404, "Not Found");
        }
    }

    private static WebResourceResponse unavailable(int code, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", code, reason, null,
                new ByteArrayInputStream(new byte[0]));
    }

    public final class NativeBridge {
        @JavascriptInterface
        public void request(String id, String action, String json) {
            if (id == null || !id.matches("\\d{1,12}")) return;
            if (json == null || json.length() > 8_000_000) {
                reply(id, false, "操作数据过大，请拆分文档后重试。");
                return;
            }
            if ("pick".equals(action)) {
                runOnUiThread(() -> pickDocuments(id));
                return;
            }
            if ("precisionImport".equals(action)) {
                runOnUiThread(() -> pickModel(id));
                return;
            }
            if ("precisionCancel".equals(action)) {
                try {
                    precision.cancel(new JSONObject(json).getString("id"));
                    reply(id, true, JSONObject.NULL);
                } catch (Exception error) { reply(id, false, errorMessage(error)); }
                return;
            }
            ExecutorService executor = "chat".equals(action) || "models".equals(action) ? apiWorkers : workers;
            executor.execute(() -> {
                try {
                    JSONObject options = new JSONObject(json);
                    Object data;
                    switch (action) {
                        case "ocr":
                            data = documents.recognize(options.getString("id"), options.getInt("page"),
                                    options.optString("language", "en"));
                            break;
                        case "inspect":
                            data = documents.inspectLegacyPdf(options.getString("id"));
                            break;
                        case "delete":
                            documents.delete(options.getString("id"));
                            data = JSONObject.NULL;
                            break;
                        case "models":
                        case "chat":
                            data = TranslationServices.callApi(action, options);
                            break;
                        case "offline":
                            data = TranslationServices.translateOffline(options.getJSONArray("texts"));
                            break;
                        case "precision":
                            data = precision.translate(options.optString("id", "sample"), options.getJSONArray("prompts"),
                                    (stage, value) -> reportPrecisionProgress(id, stage, value));
                            break;
                        case "precisionStatus":
                            data = precision.status();
                            break;
                        case "precisionRemove":
                            precision.remove();
                            data = precision.status();
                            break;
                        case "offlineStatus":
                            data = TranslationServices.offlineModelReady();
                            break;
                        case "prepareOffline":
                            TranslationServices.prepareOfflineModel();
                            data = JSONObject.NULL;
                            break;
                        case "export":
                            prepareExport(id, options);
                            return;
                        case "desktop":
                            Uri uri = TranslationServices.desktopUri(options.getString("url"));
                            runOnUiThread(() -> {
                                try {
                                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                                    reply(id, true, JSONObject.NULL);
                                } catch (ActivityNotFoundException e) {
                                    reply(id, false, "设备上没有可打开网页的浏览器。");
                                }
                            });
                            return;
                        case "deepseekOrShare":
                            final String promptText = options.optString("text", "");
                            runOnUiThread(() -> {
                                try {
                                    Intent intent = new Intent(Intent.ACTION_SEND);
                                    intent.setType("text/plain");
                                    intent.putExtra(Intent.EXTRA_TEXT, promptText);
                                    intent.setPackage("com.deepseek.chat");
                                    try {
                                        startActivity(intent);
                                        reply(id, true, "deepseek_app");
                                    } catch (ActivityNotFoundException appNotFound) {
                                        Intent chooser = Intent.createChooser(new Intent(Intent.ACTION_SEND)
                                                .setType("text/plain")
                                                .putExtra(Intent.EXTRA_TEXT, promptText), "向 DeepSeek 或其他应用提问");
                                        startActivity(chooser);
                                        reply(id, true, "system_share");
                                    }
                                } catch (Exception e) {
                                    reply(id, false, "无法调用系统分享或 DeepSeek。");
                                }
                            });
                            return;
                        default:
                            throw new IllegalArgumentException("未知的设备操作。");
                    }
                    reply(id, true, data);
                } catch (Exception error) {
                    reply(id, false, errorMessage(error));
                }
            });
        }

        @JavascriptInterface
        public void openDeepSeekOrShare(String text) {
            if (text == null) return;
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Intent.ACTION_SEND);
                    intent.setType("text/plain");
                    intent.putExtra(Intent.EXTRA_TEXT, text);
                    intent.setPackage("com.deepseek.chat");
                    try {
                        startActivity(intent);
                    } catch (ActivityNotFoundException appNotFound) {
                        Intent chooser = Intent.createChooser(new Intent(Intent.ACTION_SEND)
                                .setType("text/plain")
                                .putExtra(Intent.EXTRA_TEXT, text), "向 DeepSeek 或其他应用提问");
                        startActivity(chooser);
                    }
                } catch (Exception ignored) {}
            });
        }
    }

    private void reply(String id, boolean ok, Object data) {
        runOnUiThread(() -> {
            if (webView == null || isFinishing() || isDestroyed()) return;
            try {
                String result = new JSONObject().put("ok", ok).put("data", data).toString();
                webView.evaluateJavascript("window.PaperStudioMobile.complete(" +
                        JSONObject.quote(id) + "," + JSONObject.quote(result) + ")", null);
            } catch (Exception ignored) {
                // A destroyed or replaced page no longer owns this request.
            }
        });
    }

    private void reportPrecisionProgress(String id, String stage, int value) {
        runOnUiThread(() -> {
            if (webView == null || isFinishing() || isDestroyed()) return;
            webView.evaluateJavascript("window.PaperStudioMobile?.progress(" +
                    JSONObject.quote(id) + "," + JSONObject.quote(stage) + "," + value + ")", null);
        });
    }

    private static String errorMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? "设备操作失败，请重试。" : message;
    }

    private void pickDocuments(String id) {
        if (pickerRequest != null) {
            reply(id, false, "请先关闭正在打开的文件选择器。");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("*/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try {
            pickerRequest = id;
            startActivityForResult(intent, OPEN_FILES);
        } catch (ActivityNotFoundException error) {
            pickerRequest = null;
            reply(id, false, "设备上没有系统文件选择器。");
        }
    }

    private void pickModel(String id) {
        if (modelRequest != null) {
            reply(id, false, "请先关闭正在打开的模型选择器。");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("*/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            modelRequest = id;
            startActivityForResult(intent, OPEN_MODEL);
        } catch (ActivityNotFoundException error) {
            modelRequest = null;
            reply(id, false, "设备上没有系统文件选择器。");
        }
    }

    private void prepareExport(String id, JSONObject options) throws Exception {
        String kind = options.getString("kind");
        boolean temporary = !"source".equals(kind);
        File file = temporary ? documents.createExport(options) : documents.source(options.getString("id"));
        Export export = new Export(id, file, temporary);
        runOnUiThread(() -> {
            if (isDestroyed() || isFinishing() || pendingExport != null) {
                export.cleanUp();
                reply(id, false, "已有文件正在保存。");
                return;
            }
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(options.optString("mime", "application/octet-stream"));
            intent.putExtra(Intent.EXTRA_TITLE, options.optString("name", "PaperStudio.pdf"));
            try {
                pendingExport = export;
                startActivityForResult(intent, SAVE_FILE);
            } catch (ActivityNotFoundException error) {
                pendingExport = null;
                export.cleanUp();
                reply(id, false, "设备上没有系统文件保存器。");
            }
        });
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == OPEN_FILES && pickerRequest != null) {
            String id = pickerRequest;
            pickerRequest = null;
            ArrayList<Uri> files = new ArrayList<>();
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                        files.add(data.getClipData().getItemAt(i).getUri());
                    }
                } else if (data.getData() != null) {
                    files.add(data.getData());
                }
            }
            workers.execute(() -> {
                JSONArray imported = new JSONArray();
                for (Uri uri : files) imported.put(documents.importFile(uri));
                reply(id, true, imported);
            });
        } else if (request == OPEN_MODEL && modelRequest != null) {
            String id = modelRequest;
            modelRequest = null;
            Uri model = result == RESULT_OK && data != null ? data.getData() : null;
            if (model == null) { reply(id, true, false); return; }
            workers.execute(() -> {
                try {
                    precision.install(model);
                    reply(id, true, true);
                } catch (Exception error) { reply(id, false, errorMessage(error)); }
            });
        } else if (request == SAVE_FILE && pendingExport != null) {
            Export export = pendingExport;
            pendingExport = null;
            Uri target = result == RESULT_OK && data != null ? data.getData() : null;
            workers.execute(() -> {
                try {
                    if (target != null) {
                        try (InputStream in = new java.io.FileInputStream(export.file);
                             OutputStream out = getContentResolver().openOutputStream(target, "wt")) {
                            if (out == null) throw new java.io.IOException("无法打开所选位置。");
                            Documents.copy(in, out, Long.MAX_VALUE);
                        }
                    }
                    reply(export.request, true, target != null);
                } catch (Exception error) {
                    reply(export.request, false, errorMessage(error));
                } finally {
                    export.cleanUp();
                }
            });
        }
    }

    @Override
    public void onBackPressed() {
        if (webView == null) finish();
        else webView.evaluateJavascript("window.PaperStudioMobile && window.PaperStudioMobile.back()", handled -> {
            if (!"true".equals(handled)) finish();
        });
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (level >= TRIM_MEMORY_RUNNING_LOW && precision != null) precision.trim();
    }

    @Override
    protected void onDestroy() {
        if (pendingExport != null) pendingExport.cleanUp();
        if (precision != null) precision.close();
        apiWorkers.shutdownNow();
        workers.shutdownNow();
        if (workerClientInstalled) ServiceWorkerController.getInstance().setServiceWorkerClient(null);
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidPdfBridge");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
