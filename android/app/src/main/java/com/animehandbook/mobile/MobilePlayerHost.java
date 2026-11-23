package com.animehandbook.mobile;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.provider.DocumentsContract;
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
import android.webkit.WebViewClient;
import android.webkit.CookieManager;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.ArrayList;
import java.util.Locale;

final class MobilePlayerHost extends WebChromeClient {
  static final String HOST = "appassets.androidplatform.net";
  private static final int OPEN_FILE = 41, SAVE_IMAGE = 42;
  private final Activity activity;
  private final WebView web;
  private final ExecutorService requests = Executors.newFixedThreadPool(2);
  private ValueCallback<Uri[]> chooser;
  private byte[] pendingImage;
  private WebView renderView;
  private int renderId;
  private final SharedPreferences mediaPrefs;
  private final LocalMediaServer mediaServer;
  private final MediaDownloader downloader;
  private final ExecutorService mediaTasks = Executors.newSingleThreadExecutor();
  private static final int PICK_MEDIA_ROOT = 43;

  MobilePlayerHost(Activity activity, WebView web) {
    this.activity = activity;
    this.web = web;
    mediaPrefs = activity.getSharedPreferences("offline-media", Activity.MODE_PRIVATE);
    mediaServer = new LocalMediaServer(activity);
    mediaServer.start();
    downloader = new MediaDownloader(activity, mediaServer,
      state -> script("window.HandbookPlayer?.downloadState(" + JSONObject.quote(state.toString()) + ")"));
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
          + "img-src https: blob: data:; connect-src 'self' https:; media-src 'self' https: blob: http://127.0.0.1:* http://localhost:*; "
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
    } else if (request == PICK_MEDIA_ROOT) {
      if (code != Activity.RESULT_OK || data == null || data.getData() == null) {
        script("window.HandbookPlayer?.mediaRootPicked(" + JSONObject.quote("") + ")");
        return;
      }
      Uri tree = data.getData();
      try {
        activity.getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
      } catch (Exception denied) { /* 少数实现不给持久权限，本次会话内仍可扫描 */ }
      mediaPrefs.edit().putString("root", tree.toString()).apply();
      mediaServer.clear();
      script("window.HandbookPlayer?.mediaRootPicked(" + JSONObject.quote(tree.getPath() == null ? "目录已选择" : tree.getPath()) + ")");
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

  // 规则仓库要抓站点页面，WebView 里的 fetch 会被 CORS 挡掉，只能走原生。
  // 限制：只允许 https、不跟随跳转、拒绝本机/内网地址、4MB 上限、只接受 Referer/UA 两个头。
  private String httpText(String rawUrl, String headersRaw) throws Exception {
    URI uri = https(rawUrl);
    String host = uri.getHost().toLowerCase(java.util.Locale.ROOT);
    if (host.equals("localhost") || host.endsWith(".local") || host.endsWith(".localhost")
        || host.contains(":") || host.matches("\\d+(\\.\\d+){3}"))
      throw new IllegalArgumentException("规则不允许访问本机或 IP 地址");
    HttpURLConnection connection = (HttpURLConnection) uri.toURL().openConnection();
    try {
      connection.setInstanceFollowRedirects(false);
      connection.setConnectTimeout(8000);
      connection.setReadTimeout(12000);
      connection.setRequestProperty("User-Agent",
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36");
      connection.setRequestProperty("Accept", "text/html,application/json;q=0.9,*/*;q=0.5");
      connection.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9");
      JSONObject headers = new JSONObject(headersRaw == null || headersRaw.isEmpty() ? "{}" : headersRaw);
      String referer = headers.optString("Referer", "");
      String agent = headers.optString("User-Agent", "");
      if (!referer.isEmpty()) {
        URI check = https(referer);
        connection.setRequestProperty("Referer", check.toString());
      }
      if (!agent.isEmpty()) connection.setRequestProperty("User-Agent", agent);
      int code = connection.getResponseCode();
      if (code >= 300 && code < 400)
        throw new IllegalStateException("站点要求跳转（HTTP " + code + "），请用浏览器打开");
      if (code != 200) throw new IllegalStateException("站点返回 HTTP " + code);
      String charset = "UTF-8";
      String type = connection.getContentType();
      if (type != null) {
        java.util.regex.Matcher found = java.util.regex.Pattern.compile("(?i)charset=([\\w-]+)").matcher(type);
        if (found.find()) charset = found.group(1);
      }
      byte[] body;
      try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
        byte[] buffer = new byte[16384];
        for (int length; (length = in.read(buffer)) != -1; ) {
          if (out.size() + length > 4 * 1024 * 1024) throw new IllegalStateException("页面超过 4MB，已停止读取");
          out.write(buffer, 0, length);
        }
        body = out.toByteArray();
      }
      if ("UTF-8".equalsIgnoreCase(charset)) {
        String head = new String(body, 0, Math.min(body.length, 2048), StandardCharsets.ISO_8859_1);
        java.util.regex.Matcher meta = java.util.regex.Pattern
          .compile("(?i)<meta[^>]+charset=[\"']?([\\w-]+)").matcher(head);
        if (meta.find()) charset = meta.group(1);
      }
      String name = charset;
      try { return new String(body, java.nio.charset.Charset.forName(name)); }
      catch (Exception wrong) { return new String(body, StandardCharsets.UTF_8); }
    } finally { connection.disconnect(); }
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

  // 用隐藏 WebView 跑完页面脚本，再把渲染后的 DOM 交回前端解析。
  // 这是 Kazumi 规则里 useWebview 那类站点的兜底路径：同一个 WebView 里 cookie 会保留，
  // 所以“搜索 → 分集 → 播放页”能走同一条会话。
  private void renderPage(int id, String url, String headers) {
    activity.runOnUiThread(() -> {
      cancelRender("新的页面请求已开始");
      final String target;
      try { target = https(url).toString(); }
      catch (Exception invalid) { deliver(id, null, invalid.getMessage()); return; }
      final WebView view = new WebView(activity);
      renderView = view;
      renderId = id;
      final boolean[] done = {false};
      android.webkit.WebSettings settings = view.getSettings();
      settings.setJavaScriptEnabled(true);
      settings.setDomStorageEnabled(true);
      settings.setAllowFileAccess(false);
      settings.setAllowContentAccess(false);
      settings.setJavaScriptCanOpenWindowsAutomatically(false);
      settings.setBlockNetworkImage(true);
      settings.setLoadsImagesAutomatically(false);
      settings.setMediaPlaybackRequiresUserGesture(true);
      settings.setUserAgentString(settings.getUserAgentString().replace("; wv", ""));
      CookieManager.getInstance().setAcceptCookie(true);
      CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
      view.setVisibility(View.INVISIBLE);
      view.setLayoutParams(new android.widget.FrameLayout.LayoutParams(2, 2));
      view.setWebViewClient(new WebViewClient() {
        @Override public void onPageFinished(WebView current, String finished) {
          if (done[0] || finished == null || finished.startsWith("about:")) return;
          // 单页应用在 onPageFinished 之后才填内容，等一拍再取 DOM。
          current.postDelayed(() -> {
            if (done[0] || renderView != current) return;
            current.evaluateJavascript(
              "(function(){try{return document.documentElement?document.documentElement.outerHTML:''}catch(e){return ''}})()",
              value -> {
                if (done[0]) return;
                String html = "";
                try { Object parsed = new JSONTokener(value == null ? "null" : value).nextValue(); html = parsed instanceof String ? (String) parsed : ""; }
                catch (Exception ignored) { html = ""; }
                if (html.trim().isEmpty()) return;   // 可能还在渲染，等下一次 onPageFinished
                done[0] = true;
                if (html.length() > 6 * 1024 * 1024) html = html.substring(0, 6 * 1024 * 1024);
                finishRender(id, current, html, null);
              });
          }, 1100);
        }
        @Override public boolean shouldOverrideUrlLoading(WebView current, WebResourceRequest request) {
          String next = request.getUrl().toString();
          return !(next.startsWith("http://") || next.startsWith("https://"));
        }
      });
      try {
        ((android.view.ViewGroup) activity.findViewById(android.R.id.content)).addView(view);
      } catch (Exception ignored) { /* 加不进视图树也能加载，只是不可见 */ }
      view.postDelayed(() -> {
        if (!done[0] && renderView == view) { done[0] = true; finishRender(id, view, null, "页面渲染超时，站点可能太慢或需要验证"); }
      }, 20000);
      Map<String, String> extra = new HashMap<>();
      try {
        JSONObject raw = new JSONObject(headers == null || headers.isEmpty() ? "{}" : headers);
        for (Iterator<String> keys = raw.keys(); keys.hasNext(); ) {
          String key = keys.next();
          if ("Referer".equalsIgnoreCase(key) || "User-Agent".equalsIgnoreCase(key)) extra.put(key, raw.getString(key));
        }
      } catch (Exception ignored) { /* 头不是必需 */ }
      try { view.loadUrl(target, extra); }
      catch (Exception error) { done[0] = true; finishRender(id, view, null, "无法加载这个页面"); }
    });
  }

  private void cancelRender(String reason) {
    if (renderView == null) return;
    WebView old = renderView;
    int id = renderId;
    renderView = null;
    detach(old);
    deliver(id, null, reason);
  }

  private void finishRender(int id, WebView view, String html, String error) {
    if (renderView == view) { renderView = null; renderId = 0; }
    detach(view);
    deliver(id, html, error);
  }

  private void detach(WebView view) {
    try {
      if (view.getParent() instanceof android.view.ViewGroup) ((android.view.ViewGroup) view.getParent()).removeView(view);
      view.stopLoading();
      view.loadUrl("about:blank");
      view.destroy();
    } catch (Exception ignored) { /* 已经销毁 */ }
  }

  private void deliver(int id, String html, String error) {
    if (error != null) script("window.HandbookRules?.fetchResult(" + id + ",null," + JSONObject.quote(error) + ")");
    else script("window.HandbookRules?.fetchResult(" + id + "," + JSONObject.quote(html) + ",null)");
  }

  // ---------- 离线媒体库：手账整理目录的授权 / 扫描 ----------
  // 目录结构来自电脑端下载流程的自动归档：media/番名 [bgm-12345]/番名 - 01.mp4。
  // 扫描只认这个目录（用户通过 SAF 授权），番外散文件和认不出集数的视频会计入 ignored。

  @JavascriptInterface public void pickMediaRoot() {
    activity.runOnUiThread(() -> {
      try {
        activity.startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), PICK_MEDIA_ROOT);
      } catch (Exception unavailable) {
        script("window.HandbookPlayer?.mediaRootPicked(" + JSONObject.quote("无法打开目录选择器") + ")");
      }
    });
  }

  @JavascriptInterface public void scanMedia() {
    mediaTasks.execute(this::runScan);
  }

  @JavascriptInterface public int mediaPort() {
    return mediaServer.port();
  }

  private void runScan() {
    JSONObject result = new JSONObject();
    try {
      String raw = mediaPrefs.getString("root", "");
      if (raw.isEmpty()) { result.put("error", "notSet"); deliverScan(result); return; }
      Uri tree = Uri.parse(raw);
      JSONObject payload = new JSONObject();
      payload.put("name", rootName(raw));
      JSONArray folders = new JSONArray();
      int[] ignored = {0};
      try {
        for (JSONObject doc : childDocs(tree, DocumentsContract.getTreeDocumentId(tree))) {
          if (!DocumentIsDirectory(doc)) { ignored[0] += 1; continue; }
          JSONObject folder = scanFolder(tree, doc, ignored);
          if (folder != null && folder.getJSONArray("files").length() > 0) folders.put(folder);
        }
      } catch (Exception permissionLost) {
        result.put("error", "noAccess");
        deliverScan(result);
        return;
      }
      scanDownloaded(folders, ignored);
      result.put("folders", folders);
      result.put("ignored", ignored[0]);
    } catch (Exception failure) {
      try {
        result.put("error", "scanFailed");
        result.put("message", failure.getMessage() == null ? "扫描失败" : failure.getMessage());
      } catch (Exception ignored) { }
    }
    deliverScan(result);
  }

  /** 扫描 App 自己的下载目录（与 SAF 目录同构：番名 [bgm-编号]/番名 - 01.mp4）。 */
  private void scanDownloaded(JSONArray folders, int[] ignored) throws Exception {
    File root = downloader.root();
    File[] dirs = root == null ? null : root.listFiles();
    if (dirs == null) return;
    java.util.Map<String, JSONObject> existing = new java.util.HashMap<>();
    for (int i = 0; i < folders.length(); i++) {
      JSONObject folder = folders.optJSONObject(i);
      if (folder != null) existing.put(folder.optString("name"), folder);
    }
    for (File dir : dirs) {
      if (dir == null || !dir.isDirectory() || dir.getName().startsWith(".")) continue;
      JSONArray files = new JSONArray();
      File[] children = dir.listFiles();
      if (children == null) continue;
      for (File child : children) {
        if (child.isDirectory()) {
          // 下载得到的 HLS：目录里是 playlist.m3u8 + 分片
          if (!child.getName().toLowerCase(java.util.Locale.ROOT).endsWith(".hls")) continue;
          try {
            String token = mediaServer.registerDir(child);
            if (token == null) { ignored[0] += 1; continue; }
            files.put(downloadEntry(child.getName().replaceFirst("\\.hls$", ""), token, true));
          } catch (Exception unreadable) { ignored[0] += 1; }
          continue;
        }
        String mime = downloadedMime(child.getName());
        if (mime == null) continue;
        try {
          String token = mediaServer.registerFile(child, mime);
          if (token == null) { ignored[0] += 1; continue; }
          files.put(downloadEntry(child.getName(), token, false));
        } catch (Exception unreadable) { ignored[0] += 1; }
      }
      if (files.length() == 0) continue;
      JSONObject folder = existing.get(dir.getName());
      if (folder == null) {
        folder = new JSONObject();
        folder.put("name", dir.getName());
        java.util.regex.Matcher bgm = java.util.regex.Pattern
          .compile("(?i)\\[\\s*(?:bgm|bangumi)\\s*[-:#]?\\s*(\\d{3,9})\\s*\\]").matcher(dir.getName());
        folder.put("animeId", bgm.find() ? Long.parseLong(bgm.group(1)) : 0);
        folder.put("clean", dir.getName().replaceAll("(?i)\\s*\\[[^\\]]*\\]", "").trim());
        folder.put("files", new JSONArray());
        folders.put(folder);
        existing.put(dir.getName(), folder);
      }
      JSONArray target = folder.optJSONArray("files");
      if (target == null) { target = new JSONArray(); folder.put("files", target); }
      for (int i = 0; i < files.length(); i++) target.put(files.opt(i));
    }
  }

  private JSONObject downloadEntry(String fileName, String token, boolean hls) throws Exception {
    String base = hls ? fileName : fileName.replaceFirst("(?i)\\.[a-z0-9]{2,5}$", "");
    java.util.regex.Matcher episode = java.util.regex.Pattern
      .compile("(?i)(?:S\\d{1,2}E|第)?\\s*0*(\\d{1,4})\\s*(?:话|話)?\\s*$").matcher(base);
    JSONObject file = new JSONObject();
    file.put("name", fileName);
    file.put("episode", episode.find() ? Integer.parseInt(episode.group(1)) : 0);
    file.put("token", token);
    file.put("url", "http://127.0.0.1:" + mediaServer.port() + "/m/" + token + (hls ? "/playlist.m3u8" : ""));
    file.put("downloaded", true);
    return file;
  }

  private static String downloadedMime(String name) {
    String lower = name.toLowerCase(java.util.Locale.ROOT);
    if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
    if (lower.endsWith(".webm")) return "video/webm";
    if (lower.endsWith(".mkv")) return "video/x-matroska";
    return null;
  }

  private JSONObject scanFolder(Uri tree, JSONObject dir, int[] ignored) throws Exception {
    String name = dir.getString("name");
    if (name == null || name.startsWith(".")) { ignored[0] += 1; return null; }
    JSONArray files = new JSONArray();
    for (JSONObject doc : childDocs(tree, dir.getString("id"))) {
      if (DocumentIsDirectory(doc)) {
        // 一级子目录（特典/合集分卷等）也认一遍，文件仍归属外层番剧
        for (JSONObject inner : childDocs(tree, doc.getString("id"))) {
          collectFile(tree, inner, name, files);
        }
        continue;
      }
      collectFile(tree, doc, name, files);
    }
    if (files.length() == 0) { ignored[0] += 1; return null; }
    java.util.regex.Matcher bgm = java.util.regex.Pattern
      .compile("(?i)\\[\\s*(?:bgm|bangumi)\\s*[-:#]?\\s*(\\d{3,9})\\s*\\]").matcher(name);
    JSONObject folder = new JSONObject();
    folder.put("name", name);
    folder.put("animeId", bgm.find() ? Long.parseLong(bgm.group(1)) : 0);
    folder.put("clean", name.replaceAll("(?i)\\s*\\[[^\\]]*\\]", "").trim());
    folder.put("files", files);
    return folder;
  }

  private void collectFile(Uri tree, JSONObject doc, String folder, JSONArray files) throws Exception {
    String name = doc.optString("name", "");
    if (name == null || name.startsWith(".")) return;
    String lower = name.toLowerCase(Locale.ROOT);
    String mime;
    if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) mime = "video/mp4";
    else if (lower.endsWith(".webm")) mime = "video/webm";
    else if (lower.endsWith(".mkv")) mime = "video/x-matroska";
    else return;   // 只认视频扩展名，字幕/说明/图片一律过滤
    Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, doc.getString("id"));
    String token = mediaServer.register(uri, mime);
    if (token == null) return;   // 文件已被移动或删除，按缺失过滤
    java.util.regex.Matcher episode = java.util.regex.Pattern
      .compile("(?i)(?:S\\d{1,2}E|第)?\\s*0*(\\d{1,4})\\s*(?:话|話)?\\s*(?:\\.[a-z0-9]{2,4})?\\s*$").matcher(name);
    JSONObject file = new JSONObject();
    file.put("name", name);
    file.put("episode", episode.find() ? Integer.parseInt(episode.group(1)) : 0);
    file.put("size", doc.optLong("size", 0));
    file.put("token", token);
    file.put("url", "http://127.0.0.1:" + mediaServer.port() + "/m/" + token);
    files.put(file);
  }

  private ArrayList<JSONObject> childDocs(Uri tree, String parentId) throws Exception {
    Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
    ArrayList<JSONObject> out = new ArrayList<>();
    try (Cursor cursor = activity.getContentResolver().query(children, new String[] {
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_SIZE,
    }, null, null, null)) {
      if (cursor == null) throw new Exception("目录不可读");
      while (cursor.moveToNext()) {
        JSONObject doc = new JSONObject();
        doc.put("id", cursor.getString(0));
        doc.put("name", cursor.getString(1));
        doc.put("mime", cursor.getString(2));
        doc.put("size", cursor.getLong(3));
        out.add(doc);
      }
    }
    return out;
  }

  private static boolean DocumentIsDirectory(JSONObject doc) {
    return "vnd.android.document/directory".equals(doc.optString("mime", ""));
  }

  private static String rootName(String raw) {
    String path = Uri.parse(raw).getPath();
    if (path == null) return "手账视频目录";
    int split = path.lastIndexOf(':');
    return split >= 0 ? path.substring(split + 1) : path;
  }

  private void deliverScan(JSONObject result) {
    script("window.HandbookPlayer?.scanResult(" + JSONObject.quote(result.toString()) + ")");
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

    @JavascriptInterface public void fetchText(int id, String url, String headers) {
      requests.execute(() -> {
        try {
          String text = httpText(url, headers);
          script("window.HandbookRules?.fetchResult(" + id + "," + JSONObject.quote(text) + ",null)");
        } catch (Exception error) {
          script("window.HandbookRules?.fetchResult(" + id + ",null,"
            + JSONObject.quote(error.getMessage() == null ? "请求失败" : error.getMessage()) + ")");
        }
      });
    }

    @JavascriptInterface public void pickMediaRoot() { MobilePlayerHost.this.pickMediaRoot(); }
    @JavascriptInterface public void scanMedia() { MobilePlayerHost.this.scanMedia(); }
    @JavascriptInterface public int mediaPort() { return MobilePlayerHost.this.mediaPort(); }

    @JavascriptInterface public void downloadStart(String payload) {
      try {
        JSONObject data = new JSONObject(payload == null ? "{}" : payload);
        downloader.start(
          data.optString("id"), data.optString("url"), data.optString("referer"),
          data.optString("title"), data.optInt("animeId", 0),
          data.optString("episode"), data.optString("key"));
      } catch (Exception ignored) { /* 参数不合法就当没点 */ }
    }

    @JavascriptInterface public void downloadCancel(String id) { downloader.cancel(id); }

    @JavascriptInterface public void renderText(int id, String url, String headers) {
      renderPage(id, url, headers);
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
