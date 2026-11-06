"""蜜柑搜索模块：标题拆字段、RSS 解析、镜像回落。

全部用构造的报文，不访问真实站点，因此可以离线跑。
"""
import unittest
import urllib.error

from handbook import mikan


def feed(items: str) -> bytes:
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<rss version="2.0" xmlns:torrent="https://mikanime.tv/0.1/">'
        f"<channel><title>Mikan Project</title>{items}</channel></rss>"
    ).encode("utf-8")


def item(title: str, size: int = 1073741824, hash_: str = "abc123", when: str = "2026-08-06T03:33:55") -> str:
    return (
        "<item>"
        f'<guid isPermaLink="false">{title}</guid>'
        f"<link>https://mikanime.tv/Home/Episode/{hash_}</link>"
        f"<title>{title}</title>"
        f"<torrent:contentLength>{size}</torrent:contentLength>"
        f"<torrent:pubDate>{when}</torrent:pubDate>"
        f'<enclosure type="application/x-bittorrent" length="{size}" '
        f'url="https://mikanime.tv/Download/20260806/{hash_}.torrent" />'
        "</item>"
    )


class FakeResponse:
    def __init__(self, payload: bytes):
        self._payload = payload

    def read(self, size: int = -1) -> bytes:
        return self._payload if size is None or size < 0 else self._payload[:size]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Opener:
    """按调用顺序返回预设结果；元素是 bytes 就成功，是异常就抛出。"""

    def __init__(self, *results):
        self.results = list(results)
        self.urls = []

    def __call__(self, request, timeout=None):
        self.urls.append(request.full_url)
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return FakeResponse(result)


class TitleParsingTest(unittest.TestCase):
    def test_bilibili_movie_2160p_hevc(self):
        parsed = mikan.parse_title(
            "[沸班亚马制作组] 剧场版 鬼灭之刃 无限城篇 第一章 猗窝座再袭 V2 "
            "[BILIBILI WebRip 2160p HEVC FLAC][简繁内封字幕]"
        )
        self.assertEqual(parsed["group"], "沸班亚马制作组")
        self.assertEqual(parsed["resolution"], "2160p")
        self.assertEqual(parsed["codec"], "HEVC")
        self.assertEqual(parsed["bit_depth"], "")
        self.assertEqual(parsed["subtitles"], "简繁内封")
        self.assertFalse(parsed["batch"])

    def test_vcb_multi_resolution_prefers_hev_and_marks_fin(self):
        parsed = mikan.parse_title(
            "[VCB-Studio] 全金属狂潮 / Full Metal Panic! 10-bit 720p/1080p AVC/HEVC BDRip [S1-S4 Reseed Fin]"
        )
        self.assertEqual(parsed["group"], "VCB-Studio")
        # 双分辨率取第一个；AVC 与 HEVC 同时出现时按 HEVC 归类。
        self.assertEqual(parsed["resolution"], "720p")
        self.assertEqual(parsed["codec"], "HEVC")
        self.assertEqual(parsed["bit_depth"], "10bit")
        self.assertTrue(parsed["batch"])

    def test_collection_marker(self):
        parsed = mikan.parse_title(
            "[动漫国字幕组&LoliHouse] Spy x Family / 间谍过家家 [38-50 合集][WebRip 1080p HEVC-10bit AAC]"
        )
        self.assertEqual(parsed["resolution"], "1080p")
        self.assertEqual(parsed["bit_depth"], "10bit")
        self.assertEqual(parsed["subtitles"], "")
        self.assertTrue(parsed["batch"])

    def test_x265_written_in_numerals(self):
        parsed = mikan.parse_title(
            "[7³ACG] 葬送的芙莉莲/Sousou no Frieren S01 | 01-28+SPx11 [简繁字幕] BDrip 1080p x265 OPUS 2.0"
        )
        self.assertEqual(parsed["codec"], "HEVC")
        self.assertEqual(parsed["resolution"], "1080p")
        self.assertEqual(parsed["bit_depth"], "")
        # 「简繁字幕」没说内封内嵌，就不猜。
        self.assertEqual(parsed["subtitles"], "")

    def test_hardsubbed_and_no_group(self):
        parsed = mikan.parse_title("[MingY] 画完这个就去死 / Kore Kaite Shine [1080p][简日内嵌]")
        self.assertEqual(parsed["subtitles"], "简体内嵌")
        self.assertEqual(parsed["codec"], "")

        plain = mikan.parse_title("灌篮高手大电影.2022.MULTi.2160p.10bit.4KLight.DV")
        self.assertEqual(plain["group"], "")
        self.assertEqual(plain["resolution"], "2160p")
        self.assertEqual(plain["bit_depth"], "10bit")

    def test_subtitle_normalisation(self):
        self.assertEqual(mikan._subtitles("简繁日内封"), "简繁内封")
        self.assertEqual(mikan._subtitles("繁日内封"), "繁体内封")
        self.assertEqual(mikan._subtitles("内封字幕"), "内封")
        self.assertEqual(mikan._subtitles("外挂繁中字幕"), "繁体外挂")
        self.assertEqual(mikan._subtitles("无标记"), "")


class FormatSizeTest(unittest.TestCase):
    def test_readable_units(self):
        self.assertEqual(mikan.format_size(0), "")
        self.assertEqual(mikan.format_size(None), "")
        self.assertEqual(mikan.format_size(512), "512 B")
        self.assertEqual(mikan.format_size(1536), "1.5 KB")
        self.assertEqual(mikan.format_size(1073741824), "1.0 GB")
        self.assertEqual(mikan.format_size(85255102464), "79.4 GB")


class ParseFeedTest(unittest.TestCase):
    def test_fields(self):
        payload = feed(item("[字幕组] 测试番 第01话 [1080p][简日内封]", size=1536, hash_="deadbeef"))
        items = mikan.parse_feed(payload)
        self.assertEqual(len(items), 1)
        entry = items[0]
        self.assertEqual(entry["id"], "deadbeef")
        self.assertEqual(entry["size"], 1536)
        self.assertEqual(entry["size_text"], "1.5 KB")
        self.assertEqual(entry["published_at"], "2026-08-06T03:33:55")
        self.assertEqual(entry["torrent_url"], "https://mikanime.tv/Download/20260806/deadbeef.torrent")
        self.assertEqual(entry["page_url"], "https://mikanime.tv/Home/Episode/deadbeef")
        self.assertEqual(entry["group"], "字幕组")
        self.assertEqual(entry["resolution"], "1080p")
        self.assertEqual(entry["subtitles"], "简日内封".replace("简日", "简体"))

    def test_broken_entry_is_skipped_not_fatal(self):
        payload = feed(item("[A] 有标题 [1080p]") + "<item><title></title></item>" + item("[B] 也正常 [720p]"))
        items = mikan.parse_feed(payload)
        self.assertEqual([entry["group"] for entry in items], ["A", "B"])

    def test_invalid_xml_raises(self):
        with self.assertRaises(mikan.MikanError):
            mikan.parse_feed(b"<html>not rss</html>")

    def test_missing_channel_raises(self):
        with self.assertRaises(mikan.MikanError):
            mikan.parse_feed(b'<?xml version="1.0"?><rss></rss>')


class SearchTest(unittest.TestCase):
    def test_uses_first_reachable_mirror_and_reports_it(self):
        opener = Opener(
            urllib.error.URLError("timeout"),
            feed(item("[A] 番 [1080p]", hash_="h1")),
        )
        result = mikan.search("鬼灭之刃", opener=opener)
        self.assertEqual(result["base"], "https://mikanani.kas.pub")
        self.assertEqual(len(result["items"]), 1)
        self.assertIn("mikanani.kas.pub", opener.urls[1])
        self.assertIn("%E9%AC%BC", opener.urls[0])

    def test_prefer_is_tried_before_default_order(self):
        opener = Opener(feed(item("[A] 番 [1080p]")))
        result = mikan.search("番", prefer="https://mikanime.tv", opener=opener)
        self.assertEqual(result["base"], "https://mikanime.tv")
        self.assertEqual(len(opener.urls), 1)

    def test_prefer_that_fails_falls_back(self):
        opener = Opener(urllib.error.URLError("boom"), feed(item("[A] 番 [1080p]")))
        result = mikan.search("番", prefer="https://dead.invalid", opener=opener)
        self.assertEqual(result["base"], "https://mikanime.tv")

    def test_all_mirrors_failing_raises_with_reason(self):
        opener = Opener(*[urllib.error.URLError("blocked")] * len(mikan.MIRRORS))
        with self.assertRaises(mikan.MikanError) as caught:
            mikan.search("番", opener=opener)
        self.assertIn("不可用", str(caught.exception))

    def test_blank_keyword_rejected_without_network(self):
        opener = Opener()
        with self.assertRaises(mikan.MikanError):
            mikan.search("   ", opener=opener)
        self.assertEqual(opener.urls, [])

    def test_limit_truncates(self):
        payload = feed("".join(item(f"[A] 第{i:02d}话 [1080p]", hash_=f"h{i}") for i in range(6)))
        opener = Opener(payload)
        result = mikan.search("番", limit=2, opener=opener)
        self.assertEqual(len(result["items"]), 2)


class FetchTorrentTest(unittest.TestCase):
    def test_accepts_bencoded_payload(self):
        payload = b"d8:announce14:http://tracker4:infod4:name1:aee"
        opener = Opener(payload)
        self.assertEqual(mikan.fetch_torrent("https://mikanime.tv/x.torrent", opener=opener), payload)

    def test_rejects_html_error_page(self):
        opener = Opener(b"<!DOCTYPE html><html>403</html>")
        with self.assertRaises(mikan.MikanError):
            mikan.fetch_torrent("https://mikanime.tv/x.torrent", opener=opener)

    def test_rejects_bad_scheme(self):
        with self.assertRaises(mikan.MikanError):
            mikan.fetch_torrent("file:///etc/passwd")

    def test_network_failure_wrapped(self):
        opener = Opener(urllib.error.URLError("down"))
        with self.assertRaises(mikan.MikanError) as caught:
            mikan.fetch_torrent("https://mikanime.tv/x.torrent", opener=opener)
        self.assertIn("种子下载失败", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
