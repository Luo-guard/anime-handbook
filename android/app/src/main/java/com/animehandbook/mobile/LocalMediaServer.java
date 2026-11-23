package com.animehandbook.mobile;

import android.content.ContentResolver;
import android.content.Context;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 回环媒体服务：把离线媒体（SAF 授权的 content:// 文件、App 自己下载到媒体目录的文件、
 * 以及下载得到的 HLS 分片目录）以 http://127.0.0.1:<port>/m/<token>[/<文件>] 交给播放器。
 *
 * - 只绑定 127.0.0.1，外部设备连不上；
 * - token 只在扫描/下载时登记，不能枚举目录之外的内容；
 * - 支持 Range/206，拖动进度条才能工作；
 * - HLS 用 /m/<token>/playlist.m3u8 及其相对分片名访问。
 */
final class LocalMediaServer implements Runnable {
  private final ContentResolver resolver;
  private final Map<String, Entry> entries = new ConcurrentHashMap<>();
  private ServerSocket socket;
  private Thread thread;
  private int port;

  LocalMediaServer(Context context) { this.resolver = context.getContentResolver(); }

  static final class Entry {
    final Uri uri;
    final File file;
    final File dir;
    final String mime;
    Entry(Uri uri, File file, File dir, String mime) {
      this.uri = uri; this.file = file; this.dir = dir; this.mime = mime;
    }
  }

  synchronized void start() {
    if (thread != null) return;
    for (int candidate = 43131; candidate < 43141 && socket == null; candidate++) {
      try {
        socket = new ServerSocket(candidate, 16, InetAddress.getByName("127.0.0.1"));
        port = candidate;
      } catch (Exception busy) { /* 端口被占就换下一个 */ }
    }
    if (socket == null) return;
    thread = new Thread(this, "local-media");
    thread.setDaemon(true);
    thread.start();
  }

  int port() { return port; }

  /** 登记 SAF 文件，返回播放 token；文件打不开（已被移动/删除）时返回 null。 */
  String register(Uri uri, String mime) {
    try (ParcelFileDescriptor probe = resolver.openFileDescriptor(uri, "r")) {
      if (probe == null) return null;
    } catch (Exception unreadable) {
      return null;
    }
    return put(new Entry(uri, null, null, mime));
  }

  /** 登记 App 自己下载的普通文件。 */
  String registerFile(File file, String mime) {
    if (file == null || !file.isFile() || file.length() <= 0) return null;
    return put(new Entry(null, file, null, mime));
  }

  /** 登记下载好的 HLS 分片目录（内含 playlist.m3u8 与分片）。 */
  String registerDir(File dir) {
    if (dir == null || !dir.isDirectory()) return null;
    File playlist = new File(dir, "playlist.m3u8");
    if (!playlist.isFile() || playlist.length() <= 0) return null;
    return put(new Entry(null, null, dir, "application/vnd.apple.mpegurl"));
  }

  private String put(Entry entry) {
    String token = Integer.toHexString(System.identityHashCode(entry))
      + "-" + Long.toHexString(System.nanoTime() & 0xFFFFFF) + "-" + entries.size();
    entries.put(token, entry);
    return token;
  }

  void clear() { entries.clear(); }

  @Override public void run() {
    while (true) {
      try (Socket client = socket.accept()) {
        serve(client);
      } catch (Exception loop) {
        if (socket == null || socket.isClosed()) return;
      }
    }
  }

  private void serve(Socket client) {
    ParcelFileDescriptor pfd = null;
    try {
      client.setSoTimeout(10000);
      java.io.BufferedReader reader = new java.io.BufferedReader(
        new java.io.InputStreamReader(client.getInputStream(), StandardCharsets.US_ASCII));
      String requestLine = reader.readLine();
      if (requestLine == null || !(requestLine.startsWith("GET ") || requestLine.startsWith("HEAD "))) return;
      boolean headOnly = requestLine.startsWith("HEAD");
      String path = requestLine.split(" ")[1];
      Map<String, String> headers = new HashMap<>();
      while ((requestLine = reader.readLine()) != null && !requestLine.isEmpty()) {
        int c = requestLine.indexOf(':');
        if (c > 0) headers.put(requestLine.substring(0, c).trim().toLowerCase(), requestLine.substring(c + 1).trim());
      }

      if (!path.startsWith("/m/")) { respond(client, 404, "Not Found"); return; }
      String rest = path.substring(3);
      int query = rest.indexOf('?');
      if (query >= 0) rest = rest.substring(0, query);
      String token = rest, name = "";
      int slash = rest.indexOf('/');
      if (slash >= 0) { token = rest.substring(0, slash); name = rest.substring(slash + 1); }

      Entry entry = entries.get(token);
      if (entry == null) { respond(client, 404, "Not Found"); return; }

      OutputStream out = client.getOutputStream();
      String mime = entry.mime;

      if (entry.dir != null) {
        // HLS：token 后面跟文件名，必须在目录内
        if (name.isEmpty()) name = "playlist.m3u8";
        if (name.contains("..") || name.startsWith("/")) { respond(client, 404, "Not Found"); return; }
        File target = new File(entry.dir, name);
        if (!target.isFile()) { respond(client, 404, "Not Found"); return; }
        mime = guessMime(name);
        streamFile(client, out, target, mime, headers, headOnly);
        return;
      }

      long size;
      InputStream input;
      RandomAccessFile raf = null;
      if (entry.file != null) {
        size = entry.file.length();
        raf = new RandomAccessFile(entry.file, "r");
        input = new FileInputStream(raf.getFD());
      } else {
        pfd = resolver.openFileDescriptor(entry.uri, "r");
        if (pfd == null) { respond(client, 404, "Not Found"); return; }
        size = pfd.getStatSize();
        input = new FileInputStream(pfd.getFileDescriptor());
      }
      long[] range = parseRange(headers.get("range"), size);
      if (range == null) { respond(client, 416, "Range Not Satisfiable"); if (input != null) input.close(); return; }
      writeHeaders(out, range, size, mime);
      if (headOnly) { input.close(); return; }
      java.nio.channels.FileChannel channel = ((FileInputStream) input).getChannel();
      channel.position(range[0]);
      byte[] buffer = new byte[64 * 1024];
      long remaining = range[1] - range[0] + 1;
      while (remaining > 0) {
        int n = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
        if (n < 0) break;
        out.write(buffer, 0, n);
        remaining -= n;
      }
      out.flush();
      input.close();
      if (raf != null) try { raf.close(); } catch (Exception ignored) { }
    } catch (Exception broken) {
      try { client.close(); } catch (Exception ignored) { }
    } finally {
      if (pfd != null) try { pfd.close(); } catch (Exception ignored) { }
    }
  }

  private void streamFile(Socket client, OutputStream out, File target, String mime,
                          Map<String, String> headers, boolean headOnly) throws Exception {
    long size = target.length();
    long[] range = parseRange(headers.get("range"), size);
    if (range == null) { respond(client, 416, "Range Not Satisfiable"); return; }
    writeHeaders(out, range, size, mime);
    if (headOnly) return;
    try (RandomAccessFile raf = new RandomAccessFile(target, "r")) {
      raf.seek(range[0]);
      byte[] buffer = new byte[64 * 1024];
      long remaining = range[1] - range[0] + 1;
      while (remaining > 0) {
        int n = raf.read(buffer, 0, (int) Math.min(buffer.length, remaining));
        if (n < 0) break;
        out.write(buffer, 0, n);
        remaining -= n;
      }
      out.flush();
    }
  }

  private static long[] parseRange(String header, long size) {
    if (header == null || !header.startsWith("bytes=")) return new long[] {0, size - 1};
    String[] parts = header.substring(6).split("-");
    long start, end;
    try { start = Long.parseLong(parts[0].trim()); } catch (Exception bad) { return new long[] {0, size - 1}; }
    try { end = parts.length > 1 && !parts[1].isEmpty() ? Long.parseLong(parts[1].trim()) : size - 1; }
    catch (Exception bad) { end = size - 1; }
    if (end >= size) end = size - 1;
    if (start < 0 || start > end || size <= 0) return null;
    return new long[] {start, end};
  }

  private static void writeHeaders(OutputStream out, long[] range, long size, String mime) throws Exception {
    boolean partial = range[0] > 0 || range[1] < size - 1;
    StringBuilder head = new StringBuilder();
    head.append(partial ? "HTTP/1.1 206 Partial Content" : "HTTP/1.1 200 OK").append("\r\n");
    head.append("Content-Type: ").append(mime == null ? "application/octet-stream" : mime).append("\r\n");
    head.append("Content-Length: ").append(range[1] - range[0] + 1).append("\r\n");
    head.append("Accept-Ranges: bytes\r\n");
    head.append("Access-Control-Allow-Origin: *\r\n");
    head.append("Cache-Control: no-store\r\n");
    if (partial) head.append("Content-Range: bytes ").append(range[0]).append('-').append(range[1]).append('/').append(size).append("\r\n");
    head.append("Connection: close\r\n\r\n");
    out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
    out.flush();
  }

  private static String guessMime(String name) {
    String lower = name.toLowerCase(java.util.Locale.ROOT);
    if (lower.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
    if (lower.endsWith(".m4s") || lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
    if (lower.endsWith(".webm")) return "video/webm";
    if (lower.endsWith(".mkv")) return "video/x-matroska";
    if (lower.endsWith(".ts")) return "video/mp2t";
    if (lower.endsWith(".key")) return "application/octet-stream";
    return "application/octet-stream";
  }

  private void respond(Socket client, int code, String text) {
    try {
      OutputStream out = client.getOutputStream();
      String head = "HTTP/1.1 " + code + " " + text + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
      out.write(head.getBytes(StandardCharsets.US_ASCII));
      out.flush();
    } catch (Exception ignored) { }
  }
}
