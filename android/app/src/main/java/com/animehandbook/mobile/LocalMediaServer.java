package com.animehandbook.mobile;

import android.content.ContentResolver;
import android.content.Context;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.FileInputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 回环媒体服务：把扫描到的手账离线视频（SAF content:// URI）以
 * http://127.0.0.1:<port>/m/<token> 的形式交给播放器，带 Range 支持，
 * 拖动进度条才能工作。只绑定 127.0.0.1，外部设备连不上；
 * token 只在扫描时登记，无法枚举出目录之外的内容。
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
    final String mime;
    Entry(Uri uri, String mime) { this.uri = uri; this.mime = mime; }
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

  /** 登记一个文件，返回播放 token；文件打不开（已被移动/删除）时返回 null。 */
  String register(Uri uri, String mime) {
    try (ParcelFileDescriptor probe = resolver.openFileDescriptor(uri, "r")) {
      if (probe == null) return null;
    } catch (Exception unreadable) {
      return null;
    }
    String token = Integer.toHexString(uri.hashCode()) + "-" + Long.toHexString(System.nanoTime() & 0xFFFF) + "-" + entries.size();
    entries.put(token, new Entry(uri, mime));
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
    try {
      client.setSoTimeout(10000);
      java.io.BufferedReader reader = new java.io.BufferedReader(
        new java.io.InputStreamReader(client.getInputStream(), StandardCharsets.US_ASCII));
      String line = reader.readLine();
      if (line == null || !(line.startsWith("GET ") || line.startsWith("HEAD "))) return;
      boolean headOnly = line.startsWith("HEAD");
      String path = line.split(" ")[1];
      Map<String, String> headers = new HashMap<>();
      while ((line = reader.readLine()) != null && !line.isEmpty()) {
        int c = line.indexOf(':');
        if (c > 0) headers.put(line.substring(0, c).trim().toLowerCase(), line.substring(c + 1).trim());
      }
      String token = path.startsWith("/m/") ? path.substring(3) : "";
      int query = token.indexOf('?');
      if (query >= 0) token = token.substring(0, query);
      Entry entry = entries.get(token);
      OutputStream out = client.getOutputStream();
      if (entry == null) { respond(out, 404, "Not Found", null, null, false); return; }

      ParcelFileDescriptor pfd = null;
      try {
        pfd = resolver.openFileDescriptor(entry.uri, "r");
        if (pfd == null) { respond(out, 404, "Not Found", null, null, false); return; }
        long size = pfd.getStatSize();
        long start = 0, end = size - 1;
        boolean partial = false;
        String range = headers.get("range");
        if (range != null && range.startsWith("bytes=")) {
          String[] parts = range.substring(6).split("-");
          try { start = Long.parseLong(parts[0].trim()); } catch (Exception ignored) { }
          if (parts.length > 1 && !parts[1].isEmpty()) {
            try { end = Long.parseLong(parts[1].trim()); } catch (Exception ignored) { }
          }
          if (end >= size) end = size - 1;
          if (start < 0 || start > end || start >= size) { respond(out, 416, "Range Not Satisfiable", null, null, false); return; }
          partial = true;
        }
        StringBuilder head = new StringBuilder();
        head.append(partial ? "HTTP/1.1 206 Partial Content" : "HTTP/1.1 200 OK").append("\r\n");
        head.append("Content-Type: ").append(entry.mime).append("\r\n");
        head.append("Content-Length: ").append(end - start + 1).append("\r\n");
        head.append("Accept-Ranges: bytes\r\n");
        head.append("Access-Control-Allow-Origin: *\r\n");
        if (partial) head.append("Content-Range: bytes ").append(start).append('-').append(end).append('/').append(size).append("\r\n");
        head.append("Connection: close\r\n\r\n");
        out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
        out.flush();
        if (headOnly) return;
        FileInputStream in = new FileInputStream(pfd.getFileDescriptor());
        in.getChannel().position(start);
        byte[] buffer = new byte[64 * 1024];
        long remaining = end - start + 1;
        while (remaining > 0) {
          int n = in.read(buffer, 0, (int) Math.min(buffer.length, remaining));
          if (n < 0) break;
          out.write(buffer, 0, n);
          remaining -= n;
        }
        out.flush();
        in.close();
      } finally {
        if (pfd != null) try { pfd.close(); } catch (Exception ignored) { }
      }
    } catch (Exception broken) {
      try { client.close(); } catch (Exception ignored) { }
    }
  }

  private void respond(OutputStream out, int code, String text, String mime, Long length, boolean head) throws Exception {
    StringBuilder head2 = new StringBuilder();
    head2.append("HTTP/1.1 ").append(code).append(' ').append(text).append("\r\n");
    if (mime != null) head2.append("Content-Type: ").append(mime).append("\r\n");
    if (length != null) head2.append("Content-Length: ").append(length).append("\r\n");
    head2.append("Connection: close\r\n\r\n");
    out.write(head2.toString().getBytes(StandardCharsets.US_ASCII));
    out.flush();
  }
}
