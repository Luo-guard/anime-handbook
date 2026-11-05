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
import java.util.Base64;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends Activity {
  private WebView web;
  private File stateFile;
  private final Object stateLock = new Object();
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
    if(android.os.Build.VERSION.SDK_INT>=33)getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::navigateBack);
  }
  private void navigateBack(){web.evaluateJavascript("window.HandbookMobile ? window.HandbookMobile.handleBack() : false", result->{if(!"true".equals(result))moveTaskToBack(true);});}
  @Override public void onBackPressed(){navigateBack();}
  @Override protected void onPause(){web.evaluateJavascript("window.HandbookMobile && window.HandbookMobile.persistUi()",null);super.onPause();}


  @Override protected void onDestroy() {
    autoSyncHandler.removeCallbacks(autoSyncTask);
    super.onDestroy();
  }

  private void restartAutoSync() {
    autoSyncHandler.removeCallbacks(autoSyncTask);
    if (prefs.getBoolean("auto_sync", true)) autoSyncHandler.postDelayed(autoSyncTask, AUTO_SYNC_INTERVAL_MS);
  }

  private void triggerSync(boolean notify) { triggerSync(notify, ""); }
  private void triggerSync(boolean notify, String resolution) {
    if (!syncRunning.compareAndSet(false, true)) return;
    new Thread(() -> {
      try {
        JSONObject result = MainActivity.this.sync(resolution);
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

  private String readState() { synchronized (stateLock) { return readStateLocked(); } }
  private String readStateLocked() {
    if (!stateFile.isFile() && !new File(stateFile.getPath()+".bak").isFile()) return "{\"format\":1,\"exported_at\":\"\",\"tables\":{\"anime\":[],\"events\":[],\"settings\":[],\"custom_collections\":[],\"custom_collection_items\":[],\"ranking_boards\":[],\"ranking_templates\":[],\"ranking_tiers\":[],\"ranking_items\":[]}}";
    try (InputStream in = new android.util.AtomicFile(stateFile).openRead()) { return new String(in.readAllBytes(), StandardCharsets.UTF_8); }
    catch (IOException error) { return "{}"; }
  }
  private void writeState(String value) throws IOException { synchronized (stateLock) { writeStateLocked(value); } }
  private void writeStateLocked(String value) throws IOException {
    android.util.AtomicFile file=new android.util.AtomicFile(stateFile);FileOutputStream out=null;
    try{out=file.startWrite();out.write(value.getBytes(StandardCharsets.UTF_8));file.finishWrite(out);}catch(IOException error){if(out!=null)file.failWrite(out);throw error;}
  }
  // A network response may only replace the snapshot it started from.
  private boolean acceptRemote(String base, String incoming) throws Exception {
    synchronized (stateLock) {
      if (!digest(readStateLocked()).equals(digest(base))) return false;
      writeStateLocked(incoming);
      return true;
    }
  }
  private static String digest(String value) throws Exception { return AccountSync.digest(value); }
  private void rememberSync(String value, String etag) throws Exception {
    synchronized(stateLock){
      android.util.AtomicFile file=new android.util.AtomicFile(new File(getFilesDir(),"account-base.json"));
      FileOutputStream out=null;try{out=file.startWrite();out.write(value.getBytes(StandardCharsets.UTF_8));file.finishWrite(out);}catch(Exception e){if(out!=null)file.failWrite(out);throw e;}
      if(!prefs.edit().putString("last_hash",digest(value)).putString("last_etag",etag).commit())throw new IOException("无法保存同步状态");
    }
  }
  private String baseline(){synchronized(stateLock){try(InputStream in=new FileInputStream(new File(getFilesDir(),"account-base.json"))){return new String(in.readAllBytes(),StandardCharsets.UTF_8);}catch(IOException e){return null;}}}
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
  private AccountSync.Snapshot probeRemote() throws Exception {
    HttpURLConnection c=connection("HEAD","account.json");try{return new AccountSync.Snapshot(c.getResponseCode(),null,c.getHeaderField("ETag"));}finally{c.disconnect();}
  }
  private AccountSync.Snapshot getRemote() throws Exception {
    HttpURLConnection c=connection("GET","account.json");try{int code=c.getResponseCode();String value=null;if(code==200)try(InputStream in=c.getInputStream()){value=new String(in.readAllBytes(),StandardCharsets.UTF_8);}return new AccountSync.Snapshot(code,value,c.getHeaderField("ETag"));}finally{c.disconnect();}
  }
  private AccountSync.Snapshot putRemote(String state, String etag, boolean missing) throws Exception {
    AccountSync.requireVersion(etag,missing);
    JSONObject document=new JSONObject().put("format",1).put("updated_at",java.time.OffsetDateTime.now().toString()).put("state",new JSONObject(state));
    HttpURLConnection c=connection("PUT","account.json");
    try{
      c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json; charset=utf-8");c.setRequestProperty(missing?"If-None-Match":"If-Match",missing?"*":etag);
      try(OutputStream out=c.getOutputStream()){out.write(document.toString().getBytes(StandardCharsets.UTF_8));}
      int code=c.getResponseCode();if(code==412)throw new IOException("云端刚有新修改，本次未覆盖，请稍后重新同步");if(code!=200&&code!=201&&code!=204)throw new IOException("上传云端失败（HTTP "+code+"）");
      return new AccountSync.Snapshot(code,null,c.getHeaderField("ETag"));
    }finally{c.disconnect();}
  }
  private JSONObject sync(String resolution) throws Exception {
    if(prefs.getString("username","").isEmpty()||prefs.getString("password","").isEmpty()||prefs.getString("account","").length()<8)throw new IOException("请先填写坚果云账号、应用密码和云端账号标识");
    return AccountSync.run(new AccountSync.Store(){
      public String read(){return readState();}
      public String baseline(){return MainActivity.this.baseline();}
      public boolean accept(String base,String incoming)throws Exception{return acceptRemote(base,incoming);}
      public void checkpoint(String state,String etag)throws Exception{rememberSync(state,etag);}
    },new AccountSync.Remote(){
      public AccountSync.Snapshot probe()throws Exception{return probeRemote();}
      public AccountSync.Snapshot get()throws Exception{return getRemote();}
      public AccountSync.Snapshot put(String state,String etag,boolean missing)throws Exception{return putRemote(state,etag,missing);}
    },prefs.getString("last_hash",""),prefs.getString("last_etag",""),resolution);
  }
  class Bridge {
    @JavascriptInterface public String config() { try { JSONObject data = new JSONObject(); data.put("url", prefs.getString("url", "https://dav.jianguoyun.com/dav/")); data.put("username", prefs.getString("username", "")); data.put("account", prefs.getString("account", "")); data.put("passwordSet", !prefs.getString("password", "").isEmpty()); data.put("autoSync", prefs.getBoolean("auto_sync", true)); return data.toString(); } catch(Exception e) { return "{}"; } }
    @JavascriptInterface public String state() { return readState(); }
    @JavascriptInterface public boolean saveState(String value, String expected) {
      synchronized(stateLock){try{new JSONObject(value).getJSONObject("tables");if(expected==null||!digest(expected).equals(digest(readStateLocked())))return false;writeStateLocked(value);return true;}catch(Exception error){return false;}}
    }
    @JavascriptInterface public boolean saveConfig(String raw) {
      if(!syncRunning.compareAndSet(false,true))return false;
      try{
        JSONObject item=new JSONObject(raw);boolean changed=!item.optString("url").equals(prefs.getString("url",""))||!item.optString("account").equals(prefs.getString("account",""))||!item.optString("username").equals(prefs.getString("username",""));
        android.content.SharedPreferences.Editor edit=prefs.edit().putString("url",item.optString("url")).putString("username",item.optString("username")).putString("account",item.optString("account")).putBoolean("auto_sync",item.optBoolean("auto_sync",true));
        if(!item.optString("password").isEmpty())edit.putString("password",item.optString("password"));if(changed)edit.remove("last_hash").remove("last_etag");
        if(!edit.commit())return false;if(changed)new File(getFilesDir(),"account-base.json").delete();autoSyncHandler.post(()->restartAutoSync());return true;
      }catch(Exception e){return false;}finally{syncRunning.set(false);}
    }
    @JavascriptInterface public String uiState(){return getSharedPreferences("device-ui",MODE_PRIVATE).getString("state","{}");}
    @JavascriptInterface public void saveUiState(String value){try{new JSONObject(value);getSharedPreferences("device-ui",MODE_PRIVATE).edit().putString("state",value).commit();}catch(Exception ignored){}}

    @JavascriptInterface public void sync(String resolution) { triggerSync(true, resolution == null ? "" : resolution); }
  }
}
