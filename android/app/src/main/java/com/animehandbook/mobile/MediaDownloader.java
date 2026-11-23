package com.animehandbook.mobile;

import android.content.Context;
import android.os.Build;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 手账下载：把当前播放的片源存成本地文件，落到 App 自己的媒体目录，
 * 目录结构与电脑端归档一致（「番名 [bgm-编号]/番名 - 01.mp4」），
 * 这样「本机视频」扫描后可以直接离线播放。
 *
 * - 直链 mp4/m4v/webm：单文件下载，先写 .part 再改名；
 * - HLS（m3u8）：下载全部分片与 init/key，重写播放列表后整目录保存，
 *   播放走回环媒体的 /m/<token>/playlist.m3u8。
 */
final class MediaDownloader {
  interface Listener { void onState(JSONObject state); }

  private static final Pattern EPISODE_NUMBER = Pattern.compile("(\\d{1,4})");

  private final Context context;
  private final LocalMediaServer server;
  private final Listener listener;
  private final ExecutorService queue = Executors.newSingleThreadExecutor();
  private final Map<String, Boolean> cancelled = new ConcurrentHashMap<>();
  private final Map<String, Boolean> running = new ConcurrentHashMap<>();

  MediaDownloader(Context context, LocalMediaServer server, Listener listener) {
    this.context = context;
    this.server = server;
    this.listener = listener;
  }

  File root() {
    File external = context.getExternalFilesDir("media");
    File base = external != null ? external : new File(context.getFilesDir(), "media");
    if (!base.isDirectory() && !base.mkdirs()) return base;
    return base;
  }

  void start(String id, String url, String referer, String animeTitle, int animeId,
             String episodeLabel, String episodeKey) {
    if (id == null || id.isEmpty() || url == null || url.isEmpty()) return;
    if (running.putIfAbsent(id, Boolean.TRUE) != null) return;   // 同一集不重复下载
    cancelled.remove(id);
    queue.execute(() -> {
      try {
        download(id, url, referer, animeTitle, animeId, episodeLabel, episodeKey);
      } catch (Exception error) {
        if (isCancelled(id)) emit(id, animeTitle, episodeLabel, "cancelled", 0, "已取消下载");
        else emit(id, animeTitle, episodeLabel, "error", 0, friendly(error));
      } finally {
        running.remove(id);
        cancelled.remove(id);
      }
    });
  }

  void cancel(String id) {
    if (id == null) return;
    cancelled.put(id, Boolean.TRUE);
  }

  private boolean isCancelled(String id) { return cancelled.containsKey(id); }

  private void download(String id, String url, String referer, String animeTitle, int animeId,
                        String episodeLabel, String episodeKey) throws Exception {
    emit(id, animeTitle, episodeLabel, "start", 0, "准备下载…");
    String cleaned = safeName(animeTitle, "未命名");
    String dirName = animeId > 0 ? cleaned + " [bgm-" + animeId + "]" : cleaned;
    File dir = new File(root(), dirName);
    if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("无法创建下载目录");

    String baseName = cleaned + " - " + episodeNumber(episodeLabel, episodeKey);
    boolean hls = url.toLowerCase(Locale.ROOT).contains(".m3u8");

    if (!hls) {
      File target = new File(dir, baseName + extension(url));
      downloadFile(id, animeTitle, episodeLabel, new URI(url), referer, target, -1, 0);
      if (isCancelled(id)) { deleteQuietly(target); return; }
      String token = server.registerFile(target, guessMime(target.getName()));
      emitDone(id, animeTitle, episodeLabel, target, token);
      return;
    }

    // HLS：整目录保存，播放列表重写成分片文件名
    File hlsDir = new File(dir, baseName + ".hls");
    if (hlsDir.isDirectory()) deleteTree(hlsDir);
    if (!hlsDir.mkdirs()) throw new IOException("无法创建分集目录");
    String playlist = fetchText(new URI(url), referer);
    if (playlist.contains("#EXT-X-STREAM-INF")) {
      URI variant = firstVariant(playlist, new URI(url));
      if (variant == null) throw new IOException("播放列表里没有可用的清晰度");
      playlist = fetchText(variant, referer);
      url = variant.toString();
    }
    String rewritten = downloadPlaylist(id, animeTitle, episodeLabel, playlist, new URI(url), referer, hlsDir);
    if (isCancelled(id)) { deleteTree(hlsDir); return; }
    File playlistFile = new File(hlsDir, "playlist.m3u8");
    writeText(playlistFile, rewritten);
    String token = server.registerDir(hlsDir);
    if (token == null) throw new IOException("下载结果不完整，请重试");
    emitDone(id, animeTitle, episodeLabel, hlsDir, token);
  }

  /** 下载媒体播放列表里的分片与 init/key，返回重写后的播放列表文本。 */
  private String downloadPlaylist(String id, String title, String label, String playlist,
                                  URI base, String referer, File dir) throws Exception {
    List<String> segments = new ArrayList<>();
    for (String line : playlist.split("\\r?\\n")) {
      String trimmed = line.trim();
      if (trimmed.isEmpty() || trimmed.startsWith("#EXT-X-ENDLIST")) { segments.add(line); continue; }
      if (trimmed.startsWith("#EXT-X-MAP:")) {
        segments.add(rewriteAttribute(id, title, label, trimmed, base, referer, dir, "init", ".mp4"));
        continue;
      }
      if (trimmed.startsWith("#EXT-X-KEY:")) {
        if (trimmed.toUpperCase(Locale.ROOT).contains("METHOD=NONE")) { segments.add(line); continue; }
        segments.add(rewriteAttribute(id, title, label, trimmed, base, referer, dir, "key", ".key"));
        continue;
      }
      if (trimmed.startsWith("#")) { segments.add(line); continue; }
      String name = String.format(Locale.ROOT, "seg_%04d%s", segments.size(), extension(trimmed));
      segments.add(name);
      downloadFile(id, title, label, base.resolve(trimmed), referer, new File(dir, name), -1, 0);
      if (isCancelled(id)) return "";
    }
    return String.join("\n", segments) + "\n";
  }

  private String rewriteAttribute(String id, String title, String label, String line, URI base,
                                  String referer, File dir, String prefix, String fallbackExt) throws Exception {
    Matcher uri = Pattern.compile("URI=\"([^\"]+)\"").matcher(line);
    if (!uri.find()) return line;
    String raw = uri.group(1);
    String name = prefix + extension(raw.isEmpty() ? fallbackExt : raw);
    downloadFile(id, title, label, base.resolve(raw), referer, new File(dir, name), -1, 0);
    return line.replace("URI=\"" + raw + "\"", "URI=\"" + name + "\"");
  }

  private void downloadFile(String id, String title, String label, URI source, String referer,
                            File target, long expected, long alreadyBytes) throws Exception {
    if (isCancelled(id)) return;
    File part = new File(target.getParentFile(), target.getName() + ".part");
    HttpURLConnection connection = open(source, referer);
    long total = connection.getContentLengthLong();
    try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(part)) {
      byte[] buffer = new byte[128 * 1024];
      long written = 0;
      long lastEmit = 0;
      int read;
      while ((read = input.read(buffer)) >= 0) {
        if (isCancelled(id)) { output.close(); deleteQuietly(part); return; }
        output.write(buffer, 0, read);
        written += read;
        long now = System.currentTimeMillis();
        if (now - lastEmit > 400 && total > 0) {
          lastEmit = now;
          emit(id, title, label, "downloading", (int) Math.min(99L, written * 100 / total), "正在下载 " + percentText(written, total));
        }
      }
    } finally {
      connection.disconnect();
    }
    if (isCancelled(id)) { deleteQuietly(part); return; }
    if (part.length() <= 0) { deleteQuietly(part); throw new IOException("下载到的文件是空的"); }
    if (target.exists()) deleteQuietly(target);
    if (!part.renameTo(target)) { copyFile(part, target); deleteQuietly(part); }
  }

  private HttpURLConnection open(URI uri, String referer) throws Exception {
    URL url = uri.toURL();
    if (!"https".equalsIgnoreCase(url.getProtocol())) throw new IOException("只支持 HTTPS 片源");
    HttpURLConnection connection = (HttpURLConnection) url.openConnection();
    connection.setInstanceFollowRedirects(true);
    connection.setConnectTimeout(15000);
    connection.setReadTimeout(30000);
    connection.setRequestProperty("User-Agent",
      "Mozilla/5.0 (Linux; Android " + Build.VERSION.RELEASE + ") AnimeHandbook/" + appVersion());
    if (referer != null && !referer.isEmpty()) connection.setRequestProperty("Referer", referer);
    int code = connection.getResponseCode();
    if (code < 200 || code >= 300) throw new IOException("片源返回 " + code + "，可能已过期");
    return connection;
  }

  private String fetchText(URI uri, String referer) throws Exception {
    HttpURLConnection connection = open(uri, referer);
    StringBuilder text = new StringBuilder();
    try (BufferedReader reader = new BufferedReader(
      new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
      String line;
      while ((line = reader.readLine()) != null) text.append(line).append('\n');
    } finally {
      connection.disconnect();
    }
    if (text.length() == 0) throw new IOException("播放列表是空的");
    return text.toString();
  }

  private URI firstVariant(String playlist, URI base) {
    String[] lines = playlist.split("\\r?\\n");
    for (int i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
      for (int j = i + 1; j < lines.length; j++) {
        String candidate = lines[j].trim();
        if (candidate.isEmpty() || candidate.startsWith("#")) continue;
        return base.resolve(candidate);
      }
    }
    return null;
  }

  private String appVersion() {
    try { return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName; }
    catch (Exception missing) { return "1.0"; }
  }

  private void emitDone(String id, String title, String label, File target, String token) throws Exception {
    JSONObject state = base(id, title, label, "done", 100, "已下载");
    state.put("path", target.getName());
    if (token != null) {
      boolean dir = target.isDirectory();
      state.put("url", "http://127.0.0.1:" + server.port() + "/m/" + token + (dir ? "/playlist.m3u8" : ""));
    }
    listener.onState(state);
  }

  private void emit(String id, String title, String label, String status, int percent, String message) {
    try { listener.onState(base(id, title, label, status, percent, message)); }
    catch (Exception ignored) { }
  }

  private JSONObject base(String id, String title, String label, String status, int percent, String message) throws Exception {
    JSONObject state = new JSONObject();
    state.put("id", id);
    state.put("title", title == null ? "" : title);
    state.put("episode", label == null ? "" : label);
    state.put("status", status);
    state.put("percent", percent);
    state.put("message", message == null ? "" : message);
    return state;
  }

  private static String percentText(long written, long total) {
    return String.format(Locale.ROOT, "%d%%", Math.min(100, written * 100 / Math.max(1, total)));
  }

  private static String friendly(Exception error) {
    String message = error.getMessage();
    if (message == null || message.isEmpty()) return "下载失败，检查网络后再试";
    return message.length() > 80 ? message.substring(0, 80) : message;
  }

  private static String safeName(String value, String fallback) {
    String text = value == null ? "" : value.trim();
    text = text.replaceAll("[\\\\/:*?\"<>|]", "_").replaceAll("\\s+", " ").trim();
    if (text.isEmpty()) text = fallback;
    return text.length() > 60 ? text.substring(0, 60).trim() : text;
  }

  private static String episodeNumber(String label, String key) {
    String source = (label != null && !label.isEmpty()) ? label : (key == null ? "01" : key);
    Matcher matcher = EPISODE_NUMBER.matcher(source);
    if (matcher.find()) {
      int value = Integer.parseInt(matcher.group(1));
      return String.format(Locale.ROOT, "%02d", value);
    }
    return safeName(source, "01").replaceAll("\\s+", "");
  }

  private static String extension(String urlOrName) {
    String path = urlOrName;
    int cut = path.indexOf('?');
    if (cut > 0) path = path.substring(0, cut);
    int dot = path.lastIndexOf('.');
    if (dot < 0 || dot < path.length() - 6) return ".mp4";
    String ext = path.substring(dot).toLowerCase(Locale.ROOT);
    return ext.matches("\\.[a-z0-9]{2,5}") ? ext : ".mp4";
  }

  private static String guessMime(String name) {
    String lower = name.toLowerCase(Locale.ROOT);
    if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
    if (lower.endsWith(".webm")) return "video/webm";
    if (lower.endsWith(".mkv")) return "video/x-matroska";
    return "video/mp4";
  }

  private static void copyFile(File from, File to) throws IOException {
    try (InputStream input = new java.io.FileInputStream(from);
         FileOutputStream output = new FileOutputStream(to)) {
      byte[] buffer = new byte[128 * 1024];
      int read;
      while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
    }
  }

  private static void writeText(File target, String text) throws IOException {
    try (FileOutputStream output = new FileOutputStream(target)) {
      output.write(text.getBytes(StandardCharsets.UTF_8));
    }
  }

  private static void deleteQuietly(File target) {
    try { if (target != null && target.exists()) target.delete(); } catch (Exception ignored) { }
  }

  private static void deleteTree(File dir) {
    if (dir == null) return;
    File[] children = dir.listFiles();
    if (children != null) for (File child : children) {
      if (child.isDirectory()) deleteTree(child);
      else deleteQuietly(child);
    }
    deleteQuietly(dir);
  }
}
