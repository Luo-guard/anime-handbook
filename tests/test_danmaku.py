"""弹幕解析与在线源安全校验。"""
from __future__ import annotations

import base64
import hashlib
import tempfile
import unittest
from pathlib import Path

from handbook import danmaku


BILI_XML = """<?xml version="1.0" encoding="UTF-8"?>
<i><chatserver>chat.bilibili.com</chatserver>
<d p="12.5,1,25,16777215,1234567890,0,abc,42">第一条弹幕</d>
<d p="1.25,5,30,16711680,1234567890,0,abc,43">顶部 &amp; 固定</d>
<d p="99,4,25,255,1234567890,0,abc,44">底部</d>
<d p="bad,1,25,16777215">时间坏掉</d>
</i>"""


class ParseTest(unittest.TestCase):
    def test_bili_xml(self):
        items = danmaku.parse_bili_xml(BILI_XML)
        self.assertEqual(len(items), 3, "坏掉的时间要丢掉")
        self.assertEqual(items[0]["text"], "顶部 & 固定")
        self.assertEqual(items[0]["mode"], 5)
        self.assertEqual(items[0]["color"], "#ff0000")
        self.assertEqual(items[0]["size"], 30)
        self.assertEqual(items[1]["time"], 12.5)
        self.assertEqual(items[1]["color"], "#ffffff")
        self.assertEqual(items[2]["mode"], 4)
        self.assertEqual(items[2]["color"], "#0000ff")

    def test_dandan_json(self):
        payload = {"comments": [
            {"cid": 1, "p": "3.5,1,16777215,uid", "m": "滚动"},
            {"cid": 2, "p": "0.5,4,255,uid", "m": "底部"},
            {"cid": 3, "p": "oops,1,255,uid", "m": "坏时间"},
        ]}
        items = danmaku.parse_dandan_json(payload)
        self.assertEqual([item["time"] for item in items], [0.5, 3.5])
        self.assertEqual(items[0]["mode"], 4)
        self.assertEqual(items[0]["color"], "#0000ff")
        self.assertEqual(items[1]["text"], "滚动")

    def test_normalized_array_round_trip(self):
        payload = [{"time": 2, "mode": 1, "color": "#abcdef", "size": 25, "text": "自导出"}]
        items = danmaku.parse_dandan_json(payload)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["color"], "#abcdef")
        self.assertEqual(items[0]["text"], "自导出")

    def test_parse_text_guesses_format(self):
        self.assertEqual(len(danmaku.parse_text(BILI_XML)), 3)
        self.assertEqual(len(danmaku.parse_text('{"comments":[]}')), 0)
        self.assertEqual(danmaku.parse_text("这不是弹幕"), [])


class LocalFileTest(unittest.TestCase):
    def test_same_name_and_single_xml(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            video = root / "第 05 集.mp4"
            video.write_bytes(b"fake")
            self.assertEqual(danmaku.load_local(video), [], "没有弹幕文件时返回空")
            (root / "第 05 集.xml").write_text(BILI_XML, encoding="utf-8")
            self.assertEqual(len(danmaku.load_local(video)), 3)

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            video = root / "ep.mp4"
            video.write_bytes(b"fake")
            (root / "弹幕.xml").write_text(BILI_XML, encoding="utf-8")
            self.assertEqual(len(danmaku.load_local(video)), 3, "目录里唯一的 xml 也认")

    def test_ambiguous_xml_is_not_guessed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            video = root / "ep.mp4"
            video.write_bytes(b"fake")
            (root / "a.xml").write_text(BILI_XML, encoding="utf-8")
            (root / "b.xml").write_text(BILI_XML, encoding="utf-8")
            self.assertEqual(danmaku.load_local(video), [], "猜不出来就别乱加载")

    def test_missing_video(self):
        self.assertEqual(danmaku.load_local("Z:/nope/missing.mp4"), [])


class UpstreamSafetyTest(unittest.TestCase):
    def test_allowed_bases(self):
        self.assertEqual(danmaku.safe_base("https://api.dandanplay.net/"),
                         "https://api.dandanplay.net")
        self.assertEqual(danmaku.safe_base("http://127.0.0.1:9321/87654321"),
                         "http://127.0.0.1:9321/87654321")
        self.assertEqual(danmaku.safe_base("http://192.168.1.7:9321"),
                         "http://192.168.1.7:9321")

    def test_rejects_public_hosts_and_bad_schemes(self):
        for bad in ("https://example.com", "ftp://127.0.0.1", "not-a-url", ""):
            with self.assertRaises(ValueError):
                danmaku.safe_base(bad)

    def test_allows_known_public_danmaku_sources(self):
        for host in ("https://api.danmu.icu", "https://fc.lyz05.cn", "https://danmu.56uxi.com"):
            self.assertEqual(danmaku.safe_base(host), host)
        with self.assertRaises(ValueError):
            danmaku.safe_base("https://random-public-host.example.net")

    def test_signature_matches_documented_formula(self):
        url = "https://api.dandanplay.net/api/v2/comment/123?format=json"
        headers = danmaku.signed_headers("my-app", "my-secret", url)
        self.assertEqual(headers["X-AppId"], "my-app")
        raw = f"my-app{headers['X-Timestamp']}/api/v2/comment/123my-secret".encode()
        expected = base64.b64encode(hashlib.sha256(raw).digest()).decode()
        self.assertEqual(headers["X-Signature"], expected)
        self.assertEqual(danmaku.signed_headers("", "secret", url), {})
        self.assertEqual(danmaku.signed_headers("app", "", url), {})

    def test_rejects_bad_api_path(self):
        with self.assertRaises(ValueError):
            danmaku.fetch_upstream("https://api.dandanplay.net", "/../secret")


if __name__ == "__main__":
    unittest.main()
