package com.chenziang.todolist;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 应用外壳：一个 WebView 装本地网页，外加三样网页做不到的事
 * —— 系统通知、文件导出、检查更新。
 */
public class MainActivity extends Activity {

    private static final String DOMAIN = "appassets.androidplatform.net";
    private static final String BASE_URL = "https://" + DOMAIN + "/index.html";
    private static final int REQ_NOTIF = 101;
    private static final String REPO = "chenziangloves/todolist-android";

    private WebView web;

    /** 检查更新的异步结果：requestId -> JSON */
    private final Map<String, String> updateResults = new ConcurrentHashMap<>();
    private final AtomicLong updateSeq = new AtomicLong();

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Reminders.ensureChannel(this);
        buildWebView();
        setContentView(web);

        // 开机后闹钟可能没重建（或系统把后台清了），这里补一次
        Reminders.scheduleAll(this);
        // 提醒时刻已过但没弹出来的，打开 App 时补发（12 小时内的）
        Reminders.catchUp(this, 12L * 3600L * 1000L);
    }

    private void buildWebView() {
        web = new WebView(this);
        web.setBackgroundColor(0xFF0F1115);
        web.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(DOMAIN)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u != null && DOMAIN.equals(u.getHost())) return false;
                if (u != null) openExternal(u.toString());
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "TodoNative");
        web.loadUrl(BASE_URL);
    }

    /* ---------------- 返回键 ---------------- */

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            // 先问网页：有没有开着的弹层要关
            web.evaluateJavascript(
                    "(function(){try{return window.__back?window.__back():false}catch(e){return false}})()",
                    value -> {
                        if (!"true".equals(value)) {
                            // 没有弹层就退到后台，而不是杀进程，数据都在本地不担心丢
                            moveTaskToBack(true);
                        }
                    });
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] grants) {
        super.onRequestPermissionsResult(code, perms, grants);
        if (code == REQ_NOTIF) {
            boolean ok = grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED;
            toastUi(ok ? "通知已开启" : "没开通知的话，只能打开 App 才看得到提醒");
            Reminders.scheduleAll(this);
        }
    }

    /* ---------------- 原生桥 ---------------- */

    private class Bridge {

        @JavascriptInterface
        public String appVersion() {
            try {
                PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                return pi.versionName == null ? "" : pi.versionName;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String notifState() {
            if (Build.VERSION.SDK_INT >= 33) {
                boolean granted = checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                        == PackageManager.PERMISSION_GRANTED;
                if (granted) return "granted";
                boolean asked = shouldShowRequestPermissionRationale("android.permission.POST_NOTIFICATIONS");
                return asked ? "denied" : "prompt";
            }
            return Reminders.canNotify(MainActivity.this) ? "granted" : "denied";
        }

        @JavascriptInterface
        public void requestNotif() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33) {
                    requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIF);
                } else {
                    openNotifSettings();
                }
            });
        }

        @JavascriptInterface
        public String exactAlarmState() {
            return Reminders.canExact(MainActivity.this) ? "granted" : "denied";
        }

        @JavascriptInterface
        public void requestExactAlarm() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 31 && !Reminders.canExact(MainActivity.this)) {
                    try {
                        Intent i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                        i.setData(Uri.parse("package:" + getPackageName()));
                        startActivity(i);
                    } catch (Exception e) {
                        toastUi("这台手机没有这个设置项，提醒可能会晚几分钟");
                    }
                }
            });
        }

        @JavascriptInterface
        public void syncAlarms(String json) {
            Reminders.sync(MainActivity.this, json);
        }

        @JavascriptInterface
        public String saveText(String name, String text) {
            return writeDownload(name, text);
        }

        @JavascriptInterface
        public void vibrate(int ms) {
            try {
                Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
                if (v != null && v.hasVibrator()) v.vibrate(Math.max(5, Math.min(ms, 60)));
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public void openUrl(String url) {
            runOnUiThread(() -> openExternal(url));
        }

        @JavascriptInterface
        public String checkUpdate() {
            final String rid = "u" + updateSeq.incrementAndGet();
            new Thread(() -> updateResults.put(rid, fetchLatest())).start();
            // 只留最近 8 次，避免无限堆积
            if (updateResults.size() > 8) {
                String first = updateResults.keySet().iterator().next();
                updateResults.remove(first);
            }
            return rid;
        }

        @JavascriptInterface
        public String pollUpdate(String rid) {
            return rid == null ? null : updateResults.get(rid);
        }
    }

    /* ---------------- 文件导出 ---------------- */

    private String writeDownload(String name, String text) {
        String safe = (name == null || name.trim().isEmpty()) ? "todolist-backup.json" : name.trim();
        byte[] bytes = text == null ? new byte[0] : text.getBytes(StandardCharsets.UTF_8);
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) return "";
                try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                    if (os == null) return "";
                    os.write(bytes);
                }
                return "下载/" + safe;
            }
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (!dir.exists() && !dir.mkdirs()) return "";
            File f = new File(dir, safe);
            try (FileOutputStream fos = new FileOutputStream(f)) {
                fos.write(bytes);
            }
            return f.getAbsolutePath();
        } catch (Exception e) {
            return "";
        }
    }

    /* ---------------- 检查更新 ---------------- */

    private String fetchLatest() {
        HttpURLConnection conn = null;
        try {
            URL url = new URL("https://api.github.com/repos/" + REPO + "/releases/latest");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(7000);
            conn.setReadTimeout(7000);
            conn.setRequestProperty("Accept", "application/vnd.github+json");
            conn.setRequestProperty("User-Agent", "TodoList-Android/" + appVersionSafe());

            int code = conn.getResponseCode();
            if (code != 200) {
                return err("服务器返回 " + code);
            }
            StringBuilder sb = new StringBuilder();
            try (InputStream in = conn.getInputStream()) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0) sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
            }

            JSONObject o = new JSONObject(sb.toString());
            String tag = o.optString("tag_name", "");
            String latest = (tag.startsWith("v") || tag.startsWith("V")) ? tag.substring(1) : tag;
            String current = appVersionSafe();

            String apkUrl = "";
            JSONArray assets = o.optJSONArray("assets");
            if (assets != null) {
                for (int i = 0; i < assets.length(); i++) {
                    JSONObject a = assets.optJSONObject(i);
                    if (a == null) continue;
                    String nm = a.optString("name", "");
                    if (nm.endsWith(".apk")) {
                        apkUrl = a.optString("browser_download_url", "");
                        break;
                    }
                }
            }

            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("version", latest);
            out.put("current", current);
            out.put("hasUpdate", compareVersion(latest, current) > 0);
            out.put("url", apkUrl);
            return out.toString();
        } catch (java.net.UnknownHostException e) {
            return err("连不上网络，请检查是否断网或被限制");
        } catch (java.net.SocketTimeoutException e) {
            return err("连接超时，可能是网络不稳定，稍后再试");
        } catch (Exception e) {
            return err("检查失败：" + e.getClass().getSimpleName());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private String err(String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("error", msg);
            return o.toString();
        } catch (Exception e) {
            return "{\"ok\":false}";
        }
    }

    private String appVersionSafe() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.versionName == null ? "0" : pi.versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    /** 逐段比较 1.10.2 与 1.9.9；纯数字段比大小，非数字段按字典序 */
    private static int compareVersion(String a, String b) {
        if (a == null) return -1;
        if (b == null) return 1;
        String[] x = a.split("[.\\-+]");
        String[] y = b.split("[.\\-+]");
        int n = Math.max(x.length, y.length);
        for (int i = 0; i < n; i++) {
            String p = i < x.length ? x[i] : "0";
            String q = i < y.length ? y[i] : "0";
            int c;
            try {
                c = Integer.compare(Integer.parseInt(p), Integer.parseInt(q));
            } catch (NumberFormatException e) {
                c = p.compareTo(q);
            }
            if (c != 0) return c;
        }
        return 0;
    }

    /* ---------------- 小工具 ---------------- */

    private void openNotifSettings() {
        try {
            Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            i.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            startActivity(i);
        } catch (Exception e) {
            toastUi("请到系统设置里允许本应用发送通知");
        }
    }

    private void openExternal(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            toastUi("打不开这个链接");
        }
    }

    private void toastUi(final String msg) {
        runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
    }
}
