package com.paperstudio.translator;

import android.net.Uri;

import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.common.model.RemoteModelManager;
import com.google.mlkit.nl.translate.TranslateLanguage;
import com.google.mlkit.nl.translate.TranslateRemoteModel;
import com.google.mlkit.nl.translate.Translation;
import com.google.mlkit.nl.translate.Translator;
import com.google.mlkit.nl.translate.TranslatorOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

final class TranslationServices {
    private TranslationServices() {}

    static boolean offlineModelReady() throws Exception {
        TranslateRemoteModel model = new TranslateRemoteModel.Builder(TranslateLanguage.CHINESE).build();
        return Tasks.await(RemoteModelManager.getInstance().isModelDownloaded(model), 5, TimeUnit.SECONDS);
    }

    private static Translator offlineTranslator() {
        return Translation.getClient(new TranslatorOptions.Builder()
                .setSourceLanguage(TranslateLanguage.ENGLISH).setTargetLanguage(TranslateLanguage.CHINESE).build());
    }

    private static void ensureOfflineModel(Translator translator) throws Exception {
        try {
            Tasks.await(translator.downloadModelIfNeeded(new DownloadConditions.Builder().build()), 150, TimeUnit.SECONDS);
        } catch (Exception error) {
            throw new IOException("离线英译中语言包未能下载。请联网后在翻译设置中重试。", error);
        }
    }

    static void prepareOfflineModel() throws Exception {
        try (Translator translator = offlineTranslator()) {
            ensureOfflineModel(translator);
        }
    }

    static JSONArray translateOffline(JSONArray texts) throws Exception {
        if (texts.length() > 24) throw new IOException("翻译批次过大。");
        try (Translator translator = offlineTranslator()) {
            ensureOfflineModel(translator);
            JSONArray output = new JSONArray();
            for (int i = 0; i < texts.length(); i++) {
                String text = texts.getString(i);
                if (text.length() > 3500) throw new IOException("段落过长，请缩小翻译范围。");
                output.put(Tasks.await(translator.translate(text), 45, TimeUnit.SECONDS));
            }
            return output;
        }
    }

    private static URI validatedUri(String text) throws Exception {
        URI uri = new URI(text.trim());
        if (!("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme())) ||
                uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null) {
            throw new IOException("请填写有效的 HTTP 或 HTTPS 地址。");
        }
        return uri;
    }

    static Uri desktopUri(String text) throws Exception {
        return Uri.parse(validatedUri(text).toASCIIString());
    }

    private static boolean localAddress(String host) {
        if ("localhost".equalsIgnoreCase(host) || "[::1]".equals(host)) return true;
        if (!host.matches("\\d{1,3}(\\.\\d{1,3}){3}")) return false;
        String[] octets = host.split("\\.");
        for (String octet : octets) if (Integer.parseInt(octet) > 255) return false;
        int first = Integer.parseInt(octets[0]);
        int second = Integer.parseInt(octets[1]);
        return first == 127 || first == 10 || (first == 192 && second == 168)
                || (first == 172 && second >= 16 && second <= 31);
    }

    static JSONObject callApi(String action, JSONObject options) throws Exception {
        URI base = validatedUri(options.optString("base_url"));
        if (base.getRawQuery() != null) throw new IOException("请填写 API 基础地址，去掉查询参数。");
        if ("http".equalsIgnoreCase(base.getScheme()) && !localAddress(base.getHost())) {
            throw new IOException("公网 API 请使用 HTTPS。HTTP 仅用于本机或局域网地址。");
        }
        String path = "models".equals(action) ? "/models" : "/chat/completions";
        URL url = new URL(base.toASCIIString().replaceAll("/+$", "") + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(75000);
            connection.setRequestProperty("Accept", "application/json");
            String apiKey = options.optString("api_key").trim();
            if (!apiKey.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + apiKey);
            if ("chat".equals(action)) {
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] bytes = options.getJSONObject("request").toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) {
                String hint = code == 401 || code == 403 ? "请检查 API Key 和模型权限。"
                        : code == 404 ? "请检查 API 基础地址或模型 ID。"
                        : code == 429 ? "请求受限，请稍后重试或降低并发。"
                        : code >= 300 && code < 400 ? "请使用接口的最终地址。" : "请检查服务状态。";
                throw new IOException("API 返回 HTTP " + code + "。" + hint);
            }
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                Documents.copy(input, bytes, 4L * 1024 * 1024);
                return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
            }
        } finally {
            connection.disconnect();
        }
    }
}
