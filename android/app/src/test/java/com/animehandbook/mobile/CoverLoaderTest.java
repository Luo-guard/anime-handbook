package com.animehandbook.mobile;

import org.junit.Test;
import static org.junit.Assert.*;
import java.net.URLDecoder;
import java.io.File;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

public class CoverLoaderTest {
  @Test public void cachedCoverWorksWithoutNetworkAndReusesHttpKey() throws Exception {
    File directory = Files.createTempDirectory("cover-test").toFile();
    String source = "https://lain.bgm.tv/pic/cover/l/test.jpg";
    byte[] hash = MessageDigest.getInstance("SHA-256").digest(source.getBytes(StandardCharsets.UTF_8));
    StringBuilder key = new StringBuilder(); for (byte b : hash) key.append(String.format("%02x", b));
    File cached = new File(directory, key + ".img");
    byte[] image = new byte[]{(byte)255, (byte)216, (byte)255};
    try {
      Files.write(cached.toPath(), image);
      assertArrayEquals(image, new CoverLoader(directory).load(source.replace("https:", "http:")));
    } finally { cached.delete(); directory.delete(); }
  }
  @Test public void upgradesLegacyHttpAndPreservesImageQuery() throws Exception {
    assertEquals("https://api.bgm.tv/v0/subjects/27364/image?type=large", CoverLoader.normalize("http://api.bgm.tv/v0/subjects/27364/image?type=large"));
  }
  @Test public void mirrorRetainsFullSourceUrl() throws Exception {
    String source = "https://api.bgm.tv/v0/subjects/27364/image?type=large";
    assertEquals(source, URLDecoder.decode(CoverLoader.mirror(source).split("url=", 2)[1], "UTF-8"));
  }
  @Test public void rejectsNonCoverSources() throws Exception {
    for (String source : new String[]{"file:///etc/passwd", "https://localhost/private", "https://api.bgm.tv:1234/image", "https://user@lain.bgm.tv/a", "https://lain.bgm.tv.evil/a"}) {
      try { CoverLoader.normalize(source); fail(source); } catch (Exception expected) { }
    }
  }
}
