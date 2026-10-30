package com.animehandbook.mobile;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Device-only cover cache; image bytes never enter the shared account JSON. */
final class CoverLoader {
  static final long CACHE_LIMIT = 100L * 1024 * 1024;
  private final File directory;
  CoverLoader(File directory) { this.directory = directory; directory.mkdirs(); }

  static String normalize(String source) throws Exception {
    URL url = new URL(source);
    if (!(url.getProtocol().equals("https") || url.getProtocol().equals("http")) ||
        !(url.getHost().equals("lain.bgm.tv") || url.getHost().equals("api.bgm.tv")) ||
        url.getUserInfo() != null || url.getPort() != -1) throw new IOException("Unsupported cover source");
    return "https://" + url.getHost() + url.getFile();
  }

  static String mirror(String source) throws Exception {
    return "https://wsrv.nl/?url=" + URLEncoder.encode(normalize(source), "UTF-8");
  }

  byte[] load(String source) throws Exception {
    String normalized = normalize(source);
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(normalized.getBytes(StandardCharsets.UTF_8));
    StringBuilder key = new StringBuilder(); for (byte b : digest) key.append(String.format("%02x", b));
    File cached = new File(directory, key + ".img");
    synchronized (this) {
      if (cached.isFile()) {
        cached.setLastModified(System.currentTimeMillis());
        try (InputStream in = new FileInputStream(cached)) { return in.readAllBytes(); }
      }
    }
    byte[] data = null;
    // Like Kazumi's Bangumi mirror mode, this avoids inaccessible Bangumi image hosts.
    // Try the original HTTPS source if the mirror is unavailable.
    for (String address : new String[]{mirror(normalized), normalized}) {
      try { data = download(address); break; } catch (IOException ignored) { }
    }
    if (data == null) throw new IOException("Cover unavailable");
    synchronized (this) {
      File temp = File.createTempFile("cover-", ".tmp", directory);
      try {
        try (OutputStream out = new FileOutputStream(temp)) { out.write(data); }
        if (!temp.renameTo(cached)) temp.delete();
      } finally { temp.delete(); }
      trim();
    }
    return data;
  }

  private static byte[] download(String address) throws IOException {
    HttpURLConnection connection = (HttpURLConnection)new URL(address).openConnection(Proxy.NO_PROXY);
    connection.setConnectTimeout(8000); connection.setReadTimeout(10000);
    connection.setRequestProperty("User-Agent", "AnimeHandbook Android/1.0");
    try {
      if (connection.getResponseCode() != 200) throw new IOException("Image HTTP error");
      String type = connection.getContentType();
      if (type == null || !type.toLowerCase(Locale.ROOT).startsWith("image/")) throw new IOException("Not an image");
      try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
        byte[] buffer = new byte[8192]; int count;
        while ((count = in.read(buffer)) != -1) {
          if (out.size() + count > 8 * 1024 * 1024) throw new IOException("Cover too large");
          out.write(buffer, 0, count);
        }
        if (out.size() == 0) throw new IOException("Empty cover");
        return out.toByteArray();
      }
    } finally { connection.disconnect(); }
  }

  private void trim() {
    File[] files = directory.listFiles((dir, name) -> name.endsWith(".img"));
    if (files == null) return;
    Arrays.sort(files, Comparator.comparingLong(File::lastModified));
    long size = 0; for (File file : files) size += file.length();
    for (File file : files) { if (size <= CACHE_LIMIT) break; long length = file.length(); if (file.delete()) size -= length; }
  }
}
