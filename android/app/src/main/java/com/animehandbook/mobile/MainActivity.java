package com.animehandbook.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends Activity {
  private WebView web;
  private File stateFile;
  private android.content.SharedPreferences prefs;
  private static final long AUTO_SYNC_INTERVAL_MS = 30L * 60L * 1000L;
  private final Handler autoSyncHandler = new Handler(Looper.getMainLooper());
  private final AtomicBoolean syncRunning = new AtomicBoolean(false);
  private final Runnable autoSyncTask = new Runnable() {
    @Override public void run() {
      if (!prefs.getBoolean("auto_sync", true)) return;
      triggerSync(false);
      autoSyncHandler.postDelayed(this, AUTO_SYNC_INTERVAL_MS);
    }
  };

  @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
  @Override public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    prefs = getSharedPreferences("webdav", MODE_PRIVATE);
    stateFile = new File(getFilesDir(), "account-state.json");
    web = new WebView(this);
    web.getSettings().setJavaScriptEnabled(true);
    web.getSettings().setDomStorageEnabled(true);
    CoverLoader covers = new CoverLoader(new File(getCacheDir(), "covers"));
    web.setWebViewClient(new WebViewClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (!"covers.animehandbook.local".equals(request.getUrl().getHost())) return null;
        try {
          byte[] image = covers.load(request.getUrl().getQueryParameter("url"));
          String mime = java.net.URLConnection.guessContentTypeFromStream(new ByteArrayInputStream(image));
          return new WebResourceResponse(mime == null ? "image/webp" : mime, null, new ByteArrayInputStream(image));
        } catch (Exception error) {
          String placeholder = "<svg xmlns='http://www.w3.org/2000/svg' width='240' height='320'><rect width='240' height='320' fill='#ddd5ec'/><text x='120' y='160' text-anchor='middle' fill='#7052a4' font-size='16'>封面暂未加载</text></svg>";
          return new WebResourceResponse("image/svg+xml", "UTF-8", new ByteArrayInputStream(placeholder.getBytes(StandardCharsets.UTF_8)));
        }
      }
    });
    web.setWebChromeClient(new WebChromeClient());
    web.addJavascriptInterface(new Bridge(), "AndroidHandbook");
    setContentView(web);
    web.loadUrl("file:///android_asset/index.html");
    restartAutoSync();
  }

  @Override protected void onDestroy() {
    autoSyncHandler.removeCallbacks(autoSyncTask);
    super.onDestroy();
  }

  private void restartAutoSync() {
    autoSyncHandler.removeCallbacks(autoSyncTask);
    if (prefs.getBoolean("auto_sync", true)) autoSyncHandler.postDelayed(autoSyncTask, AUTO_SYNC_INTERVAL_MS);
  }

  private void triggerSync(boolean notify) {
    if (!syncRunning.compareAndSet(false, true)) return;
    new Thread(() -> {
      try {
        JSONObject result = MainActivity.this.sync("");
        String script = "window.HandbookMobile.completeSync(" + JSONObject.quote(result.toString()) + "," + (!notify ? "true" : "false") + ")";
        web.post(() -> web.evaluateJavascript(script, null));
      } catch(Exception error) {
        String value = "{\"error\":" + JSONObject.quote(error.getMessage() == null ? "同步失败" : error.getMessage()) + "}";
        String script = "window.HandbookMobile.completeSync(" + JSONObject.quote(value) + "," + (!notify ? "true" : "false") + ")";
        web.post(() -> web.evaluateJavascript(script, null));
      } finally {
        syncRunning.set(false);
      }
    }).start();
  }

  private String readState() {
    if (!stateFile.isFile()) return "{\"format\":1,\"exported_at\":\"\",\"tables\":{\"anime\":[],\"events\":[],\"settings\":[],\"custom_collections\":[],\"custom_collection_items\":[],\"ranking_boards\":[],\"ranking_templates\":[],\"ranking_tiers\":[],\"ranking_items\":[]}}";
    try (InputStream in = new FileInputStream(stateFile)) { return new String(in.readAllBytes(), StandardCharsets.UTF_8); }
    catch (IOException error) { return "{}"; }
  }
  private void writeState(String value) throws IOException {
    File temp = new File(getFilesDir(), "account-state.tmp");
    try (OutputStream out = new FileOutputStream(temp)) { out.write(value.getBytes(StandardCharsets.UTF_8)); }
    if (!temp.renameTo(stateFile)) throw new IOException("无法保存本地手账数据");
  }
  private static String rawDigest(String value) throws Exception {
    byte[] hash = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
    StringBuilder text = new StringBuilder(); for (byte item : hash) text.append(String.format("%02x", item)); return text.toString();
  }
  private static String digest(String value) throws Exception {
    // exported_at is only a bookkeeping timestamp.  Do not make an unchanged
    // account look edited merely because a device prepared a sync snapshot.
    JSONObject state = new JSONObject(value); state.remove("exported_at");
    return rawDigest(state.toString());
  }
  private String endpoint(String part) {
    String base = prefs.getString("url", "https://dav.jianguoyun.com/dav/").replaceAll("/+$", "");
    return base + "/AnimeHandbook-v1/" + prefs.getString("account", "") + "/" + part;
  }
  private HttpURLConnection connection(String method, String part) throws Exception {
    // Some Android VPN/proxy apps publish a localhost system proxy.  WebDAV
    // requests can then be sent to a stale 127.0.0.1 port instead of Nutstore.
    // Nutstore is directly reachable, so sync deliberately bypasses that proxy.
    HttpURLConnection c = (HttpURLConnection)new URL(endpoint(part)).openConnection(Proxy.NO_PROXY);
    c.setRequestMethod(method); c.setConnectTimeout(20000); c.setReadTimeout(30000);
    String token = prefs.getString("username", "") + ":" + prefs.getString("password", "");
    c.setRequestProperty("Authorization", "Basic " + Base64.getEncoder().encodeToString(token.getBytes(StandardCharsets.UTF_8)));
    c.setRequestProperty("User-Agent", "AnimeHandbook Android/1.0");
    return c;
  }
  private void ensureFolders() throws Exception {
    String base = prefs.getString("url", "https://dav.jianguoyun.com/dav/").replaceAll("/+$", "");
    for (String path : new String[]{"AnimeHandbook-v1", "AnimeHandbook-v1/" + prefs.getString("account", "")}) {
      HttpURLConnection c = (HttpURLConnection)new URL(base + "/" + path).openConnection(Proxy.NO_PROXY); c.setRequestMethod("MKCOL");
      String token = prefs.getString("username", "") + ":" + prefs.getString("password", "");
      c.setRequestProperty("Authorization", "Basic " + Base64.getEncoder().encodeToString(token.getBytes(StandardCharsets.UTF_8)));
      int code = c.getResponseCode(); if (code != 201 && code != 405) throw new IOException("坚果云无法创建同步目录（HTTP " + code + "）");
    }
  }
  private String getRemote() throws Exception {
    HttpURLConnection c = connection("GET", "account.json"); int code = c.getResponseCode();
    if (code == 404) return null;
    if (code != 200) throw new IOException("读取坚果云失败（HTTP " + code + "）");
    try (InputStream in = c.getInputStream()) { return new String(in.readAllBytes(), StandardCharsets.UTF_8); }
  }
  private static class RemoteProbe {
    final int code; final String etag;
    RemoteProbe(int code, String etag) { this.code = code; this.etag = etag == null ? "" : etag; }
  }
  private RemoteProbe probeRemote() throws Exception {
    HttpURLConnection c = connection("HEAD", "account.json"); int code = c.getResponseCode();
    return new RemoteProbe(code, c.getHeaderField("ETag"));
  }
  private void putRemote(String state) throws Exception {
    JSONObject document = new JSONObject(); document.put("format", 1); document.put("updated_at", java.time.OffsetDateTime.now().toString()); document.put("state", new JSONObject(state));
    HttpURLConnection c = connection("PUT", "account.json"); c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
    try (OutputStream out = c.getOutputStream()) { out.write(document.toString().getBytes(StandardCharsets.UTF_8)); }
    int code = c.getResponseCode(); if (code != 200 && code != 201 && code != 204) throw new IOException("上传坚果云失败（HTTP " + code + "）");
  }
  private JSONObject sync(String resolution) throws Exception {
    if (prefs.getString("username", "").isEmpty() || prefs.getString("password", "").isEmpty() || prefs.getString("account", "").length() < 8) throw new IOException("请先填写坚果云账号、应用密码和云端账号标识");
    // HttpURLConnection on Android only permits a fixed list of HTTP verbs,
    // so it cannot issue WebDAV MKCOL.  The computer client creates the
    // account folder on its first sync; the phone then only GETs/PUTs the
    // shared account file inside it.
    String local = readState(), known = prefs.getString("last_hash", ""), previousEtag = prefs.getString("last_etag", "");
    String localHash = digest(local), localLegacyHash = rawDigest(local);
    RemoteProbe probe = probeRemote();
    if (probe.code != 200 && probe.code != 404 && probe.code != 405) throw new IOException("读取坚果云失败（HTTP " + probe.code + "）");
    JSONObject result = new JSONObject();
    if (probe.code == 404) { putRemote(local); RemoteProbe uploaded = probeRemote(); prefs.edit().putString("last_hash", localHash).putString("last_etag", uploaded.etag).apply(); result.put("action", "uploaded"); result.put("message", "已首次上传手机端账号数据"); return result; }
    if (probe.code == 200 && !previousEtag.isEmpty() && previousEtag.equals(probe.etag) && !known.isEmpty()) {
      if (localHash.equals(known)) { prefs.edit().putString("last_etag", probe.etag).apply(); result.put("action", "unchanged"); result.put("message", "两边数据已经是最新"); return result; }
      putRemote(local); RemoteProbe uploaded = probeRemote(); prefs.edit().putString("last_hash", localHash).putString("last_etag", uploaded.etag).apply(); result.put("action", "uploaded"); result.put("message", "已上传手机端最新数据"); return result;
    }
    String remoteDocument = getRemote();
    if (remoteDocument == null) { putRemote(local); RemoteProbe uploaded = probeRemote(); prefs.edit().putString("last_hash", localHash).putString("last_etag", uploaded.etag).apply(); result.put("action", "uploaded"); result.put("message", "已首次上传手机端账号数据"); return result; }
    JSONObject remoteState = new JSONObject(remoteDocument).getJSONObject("state"); String remote = remoteState.toString();
    String remoteHash = digest(remote), remoteLegacyHash = rawDigest(remote);
    // Migrate the hash stored by earlier builds, which included exported_at.
    if (known.equals(remoteLegacyHash)) known = remoteHash; else if (known.equals(localLegacyHash)) known = localHash;
    if (known.isEmpty() || "remote".equals(resolution)) { writeState(remote); prefs.edit().putString("last_hash", remoteHash).putString("last_etag", probe.etag).apply(); result.put("action", "downloaded"); result.put("state", remoteState); result.put("message", "已从坚果云下载账号数据"); return result; }
    if (!localHash.equals(known) && !remoteHash.equals(known) && !"local".equals(resolution)) {
      JSONObject merged = RecordStateMerger.merge(new JSONObject(local), remoteState); String mergedText = merged.toString(); putRemote(mergedText); RemoteProbe uploaded = probeRemote(); String mergedHash = digest(mergedText);
      writeState(mergedText); prefs.edit().putString("last_hash", mergedHash).putString("last_etag", uploaded.etag).apply(); result.put("action", "merged"); result.put("state", merged); result.put("message", "已自动合并新增记录；同一番剧同一集保留较早观看时间"); return result;
    }
    if (!localHash.equals(known) || "local".equals(resolution)) { putRemote(local); RemoteProbe uploaded = probeRemote(); prefs.edit().putString("last_hash", localHash).putString("last_etag", uploaded.etag).apply(); result.put("action", "uploaded"); result.put("message", "已上传手机端最新数据"); return result; }
    if (!remoteHash.equals(known)) { writeState(remote); prefs.edit().putString("last_hash", remoteHash).putString("last_etag", probe.etag).apply(); result.put("action", "downloaded"); result.put("state", remoteState); result.put("message", "已下载坚果云最新数据"); return result; }
    prefs.edit().putString("last_hash", known).putString("last_etag", probe.etag).apply(); result.put("action", "unchanged"); result.put("message", "两边数据已经是最新"); return result;
  }
  class Bridge {
    @JavascriptInterface public String config() { try { JSONObject data = new JSONObject(); data.put("url", prefs.getString("url", "https://dav.jianguoyun.com/dav/")); data.put("username", prefs.getString("username", "")); data.put("account", prefs.getString("account", "")); data.put("passwordSet", !prefs.getString("password", "").isEmpty()); data.put("autoSync", prefs.getBoolean("auto_sync", true)); return data.toString(); } catch(Exception e) { return "{}"; } }
    @JavascriptInterface public String state() { return readState(); }
    @JavascriptInterface public void saveState(String value) { try { new JSONObject(value); writeState(value); } catch(Exception ignored) {} }
    @JavascriptInterface public void saveConfig(String raw) { try { JSONObject item = new JSONObject(raw); android.content.SharedPreferences.Editor edit = prefs.edit().putString("url", item.optString("url")).putString("username", item.optString("username")).putString("account", item.optString("account")).putBoolean("auto_sync", item.optBoolean("auto_sync", true)); if (!item.optString("password").isEmpty()) edit.putString("password", item.optString("password")); edit.apply(); restartAutoSync(); } catch(Exception ignored) {} }
    @JavascriptInterface public void sync(String resolution) { if (resolution == null || resolution.isEmpty()) { triggerSync(true); return; } new Thread(() -> { try { JSONObject result = MainActivity.this.sync(resolution); web.post(() -> web.evaluateJavascript("window.HandbookMobile.completeSync(" + JSONObject.quote(result.toString()) + ",false)", null)); } catch(Exception error) { String value = "{\"error\":" + JSONObject.quote(error.getMessage() == null ? "同步失败" : error.getMessage()) + "}"; web.post(() -> web.evaluateJavascript("window.HandbookMobile.completeSync(" + JSONObject.quote(value) + ",false)", null)); } }).start(); }
  }
}
