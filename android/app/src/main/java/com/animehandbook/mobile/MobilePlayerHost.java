package com.animehandbook.mobile;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.util.Rational;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class MobilePlayerHost extends WebChromeClient {
  static final String HOST = "appassets.androidplatform.net";
  private static final int OPEN_FILE = 41, SAVE_IMAGE = 42;
  private final Activity activity;
  private final WebView web;
  private final ExecutorService requests = Executors.newFixedThreadPool(2);
  private ValueCallback<Uri[]> chooser;
  private byte[] pendingImage;

  MobilePlayerHost(Activity activity, WebView web) {
    this.activity = activity;
    this.web = web;
  }

  WebResourceResponse asset(WebResourceRequest request) {
    String path = request.getUrl().getPath();
    try {
      if (path == null || !path.matches("/[A-Za-z0-9_./-]+") || path.contains(".."))
        throw new FileNotFoundException();
      String mime = path.endsWith(".html") ? "text/html" :
        path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/plain";
      return new WebResourceResponse(mime, "UTF-8", 200, "OK", Collections.singletonMap(
        "Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
          + "img-src https: blob: data:; connect-src 'self' https:; media-src 'self' https: blob:; "
          + "worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"),
        activity.getAssets().open(path.substring(1)));
    } catch (Exception missing) {
      return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Collections.emptyMap(), null);
    }
  }

  @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
    if (chooser != null) chooser.onReceiveValue(null);
    chooser = callback;
    try {
      activity.startActivityForResult(params.createIntent(), OPEN_FILE);
    } catch (Exception unavailable) {
      chooser.onReceiveValue(null);
      chooser = null;
    }
    return true;
  }

  void result(int request, int code, Intent data) {
    if (request == OPEN_FILE && chooser != null) {
      ValueCallback<Uri[]> callback = chooser;
      chooser = null;
      Uri[] selected = FileChooserParams.parseResult(code, data);
      if (code == Activity.RESULT_OK && data != null && data.getClipData() != null) {
        android.content.ClipData clip = data.getClipData();
        selected = new Uri[clip.getItemCount()];
        for (int i = 0; i < selected.length; i++) selected[i] = clip.getItemAt(i).getUri();
      }
      if (selected != null) for (Uri uri : selected) {
        if (uri == null || !"content".equals(uri.getScheme())) { selected = null; break; }
      }
      callback.onReceiveValue(selected);
    } else if (request == SAVE_IMAGE) {
      byte[] contents = pendingImage;
      pendingImage = null;
      if (code != Activity.RESULT_OK || data == null || data.getData() == null || contents == null) {
        playerNotice("截图保存已取消");
        return;
      }
      Uri target = data.getData();
      requests.execute(() -> {
        try (OutputStream out = activity.getContentResolver().openOutputStream(target, "w")) {
          if (out == null) throw new FileNotFoundException();
          out.write(contents);
          playerNotice("截图已保存");
        } catch (Exception error) { playerNotice("截图保存失败"); }
      });
    }
  }

  private void playerNotice(String message) {
    script("window.HandbookPlayer?.notice(" + JSONObject.quote(message) + ")");
  }

  private void script(String code) {
    web.post(() -> { if (!activity.isDestroyed()) web.evaluateJavascript(code, null); });
  }

  private static URI https(String value) throws Exception {
    URI uri = new URI(value);
    if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null)
      throw new IllegalArgumentException("请输入 HTTPS 地址");
    return uri;
  }

  private String danmaku(String raw) throws Exception {
    JSONObject query = new JSONObject(raw);
    URI base = https(query.getString("base"));
    String path = query.getString("path");
    if (!path.matches("/api/v2/(search/episodes|bangumi/(bgmtv/)?\\d+|comment/[^/?#]+)(\\?[^#]*)?")
        || base.getRawQuery() != null || base.getRawFragment() != null || path.contains(".."))
      throw new IllegalArgumentException("弹幕接口地址无效");
    URI url = https(base.toString().replaceAll("/+$", "") + path);
    HttpURLConnection connection = (HttpURLConnection) url.toURL().openConnection();
    try {
      connection.setInstanceFollowRedirects(false);
      connection.setConnectTimeout(3900);
      connection.setReadTimeout(5500);
      connection.setRequestProperty("User-Agent", "AnimeHandbook Android");
      connection.setRequestProperty("Accept", "application/json, text/xml");
      String appId = query.optString("app_id");
      String secret = query.optString("app_secret");
      if (!appId.isEmpty() && !secret.isEmpty()) {
        if (!"api.dandanplay.net".equalsIgnoreCase(url.getHost()) || (url.getPort() != -1 && url.getPort() != 443))
          throw new IllegalArgumentException("官方弹幕凭据仅用于 api.dandanplay.net");
        String timestamp = Long.toString(System.currentTimeMillis() / 1000);
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(
          (appId + timestamp + url.getRawPath() + secret).getBytes(StandardCharsets.UTF_8));
        connection.setRequestProperty("X-AppId", appId);
        connection.setRequestProperty("X-Timestamp", timestamp);
        connection.setRequestProperty("X-Signature", Base64.getEncoder().encodeToString(hash));
      }
      if (connection.getResponseCode() != 200) throw new IllegalStateException("弹幕源返回 HTTP " + connection.getResponseCode());
      try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
        byte[] buffer = new byte[16384];
        for (int length; (length = in.read(buffer)) != -1; ) {
          if (out.size() + length > 8 * 1024 * 1024) throw new IllegalStateException("弹幕响应过大");
          out.write(buffer, 0, length);
        }
        return out.toString("UTF-8");
      }
    } finally { connection.disconnect(); }
  }

  Object bridge() { return new PlayerBridge(); }

  final class PlayerBridge {
    @JavascriptInterface public void requestDanmaku(int id, String raw) {
      requests.execute(() -> {
        try {
          String text = danmaku(raw);
          script("window.HandbookPlayer?.danmakuResult(" + id + "," + JSONObject.quote(text) + ",null)");
        } catch (Exception error) {
          script("window.HandbookPlayer?.danmakuResult(" + id + ",null,"
            + JSONObject.quote(error.getMessage() == null ? "弹幕源请求失败" : error.getMessage()) + ")");
        }
      });
    }

    @JavascriptInterface public void external(String url) {
      activity.runOnUiThread(() -> {
        try { activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(https(url).toString()))); }
        catch (Exception unavailable) { playerNotice("无法打开网页"); }
      });
    }

    @JavascriptInterface public void bars(boolean hide) {
      activity.runOnUiThread(() -> {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
          android.view.WindowInsetsController controller = activity.getWindow().getInsetsController();
          if (controller != null) {
            int bars = android.view.WindowInsets.Type.systemBars();
            controller.setSystemBarsBehavior(android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            if (hide) controller.hide(bars);
            else controller.show(bars);
          }
        } else {
          activity.getWindow().getDecorView().setSystemUiVisibility(hide ?
            View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY : 0);
        }
      });
    }

    @JavascriptInterface public void volume(float fraction) {
      if (!Float.isFinite(fraction)) return;
      activity.runOnUiThread(() -> {
        android.media.AudioManager audio = activity.getSystemService(android.media.AudioManager.class);
        if (audio == null) return;
        int stream = android.media.AudioManager.STREAM_MUSIC;
        int level = Math.round(Math.max(0, Math.min(1, fraction)) * audio.getStreamMaxVolume(stream));
        try { audio.setStreamVolume(stream, level, 0); } catch (SecurityException ignored) {}
      });
    }

    @JavascriptInterface public void pip(int width, int height) {
      activity.runOnUiThread(() -> {
        boolean opened = false;
        if (activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
          try {
            float ratio = (float) width / Math.max(1, height);
            Rational aspect = ratio >= 0.43f && ratio <= 2.39f ? new Rational(width, height) : new Rational(16, 9);
            opened = activity.enterPictureInPictureMode(new PictureInPictureParams.Builder().setAspectRatio(aspect).build());
          } catch (Exception unavailable) { /* Some devices disable picture-in-picture. */ }
        }
        if (!opened) playerNotice("当前设备未开启画中画");
      });
    }

    @JavascriptInterface public void saveImage(String name, String data) {
      if (data.length() > 22_000_000) { playerNotice("截图太大，无法保存"); return; }
      final byte[] bytes;
      try { bytes = Base64.getDecoder().decode(data); }
      catch (IllegalArgumentException error) { playerNotice("截图格式无效"); return; }
      activity.runOnUiThread(() -> {
        if (pendingImage != null) { playerNotice("请先完成上一次截图保存"); return; }
        pendingImage = bytes;
        try {
          activity.startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("image/png")
            .addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, name), SAVE_IMAGE);
        } catch (Exception unavailable) { pendingImage = null; playerNotice("无法打开截图保存窗口"); }
      });
    }
  }

  void close() {
    if (chooser != null) chooser.onReceiveValue(null);
    chooser = null;
    requests.shutdownNow();
  }
}
