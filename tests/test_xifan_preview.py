"""Regressions for the public URL and media relay boundaries."""
import io
import json
import socket
import tempfile
import unittest
import zipfile
from contextlib import contextmanager
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from handbook import xifan_preview as preview
from handbook import playback_rules as rules
from handbook import playback_stream as streams
from handbook.playback_network import connect_public, public_url
from handbook.http_support import RequestProblem


class XifanPreviewTest(unittest.TestCase):
    def test_search_uses_the_kazumi_rule_only_for_the_known_endpoint(self):
        url = f"{preview.API}/rest/v1/rpc/search_animes"
        key = "sb_publishable_" + "example" * 2
        search_request = {"url": url, "method": "POST", "headers": {"apikey": key}}
        rule = {"searchApiConfig": {"request": search_request}}
        rows = [{"id": 42, "title": "Example", "title_original": "Original", "extra": "ignored"}]
        with patch.object(preview, "_json_request", return_value=rows) as request:
            self.assertEqual(preview.search(" Original ", rule), {
                "items": [{"id": 42, "title": "Example", "original": "Original"}],
            })
            request.assert_called_once_with(url, {"search_term": "Original", "page_number": 1, "items_per_page": 24}, key)
            request.reset_mock()
            search_request["url"] = "https://elsewhere.test/search"
            with self.assertRaises(preview.PreviewError):
                preview.search("Original", rule)
            request.assert_not_called()

    def test_only_next_title_or_episode_links_are_resolved(self):
        with patch.object(preview, "_json_request") as request:
            for url in (
                "http://next.xifanacg.com/anime/3",
                "https://next.xifanacg.com:8000/anime/3",
                "https://next.xifanacg.com@127.0.0.1/anime/3",
                "https://next.xifanacg.com/search",
            ):
                with self.subTest(url=url), self.assertRaises(preview.PreviewError):
                    preview.catalogue(url, {})
            request.assert_not_called()

    def test_nonstandard_public_media_ports_and_private_dns(self):
        self.assertEqual(public_url("https://example.com:8088/video.mp4")[1], 8088)
        addresses = [
            (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", 443)),
        ]
        with patch("socket.getaddrinfo", return_value=addresses), patch("socket.socket") as transport:
            with self.assertRaises(RequestProblem):
                connect_public("example.com", 443)
            transport.assert_not_called()

    def test_stream_ticket_and_hls_variants_keys_and_segments(self):
        with patch.object(streams, "_PLAYBACKS", {}), patch.object(streams, "request_public") as fetch:
            with self.assertRaises(RequestProblem) as missing:
                streams.stream(None, "missing", "main")
            self.assertEqual(missing.exception.status, 410)
            fetch.assert_not_called()
            issued = streams.issue("https://example.com:8088/hls/main.m3u8", "hls")
            token = issued["url"].split("/")[-2]
            playback = streams._PLAYBACKS[token]
            playlist = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000\nvariant\n#EXT-X-KEY:METHOD=AES-128,URI="key"\nseg.ts\n'
            output = streams.rewrite_playlist(playlist, playback.url, token, playback).decode()
            self.assertIn('#EXT-X-KEY:METHOD=AES-128,URI="/api/playback/stream/', output)
            self.assertEqual(set(playback.resources.values()), {
                (playback.url, "hls"), ("https://example.com:8088/hls/variant", "hls"),
                ("https://example.com:8088/hls/key", "segment"), ("https://example.com:8088/hls/seg.ts", "segment"),
            })
            self.assertNotIn("example.com", output)

    def test_media_probe_rejects_upstream_error_and_empty_hls(self):
        url = "https://example.com/video"
        headers = Message()

        @contextmanager
        def upstream(status, body):
            yield SimpleNamespace(status=status, headers=headers, read=io.BytesIO(body).read), url

        cases = [
            (500, b"error", "file", "HTTP 500"),
            (200, b"#EXTM3U\r\n", "hls", "空的播放列表"),
        ]
        for status, body, kind, message in cases:
            with self.subTest(kind=kind), patch.object(streams, "request_public", return_value=upstream(status, body)):
                with self.assertRaisesRegex(RequestProblem, message):
                    streams.probe_media(url, kind, {})
        with patch.object(streams, "request_public", return_value=upstream(200, b"#EXTM3U\n#EXTINF:6,\nsegment.ts\n")):
            streams.probe_media(url, "hls", {})

    def test_download_gates_use_and_xpath_selects_each_line_independently(self):
        rule = {
            "name": "Example", "baseURL": "https://example.com/", "searchURL": "https://example.com/?q=@keyword",
            "searchList": "//article", "searchName": "//a", "searchResult": "//a",
            "chapterRoads": "//ul", "chapterResult": "//a",
        }
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as zip_file:
            zip_file.writestr("KazumiRules-main/example.json", json.dumps(rule))
            zip_file.writestr("KazumiRules-main/disabled.json", json.dumps({**rule, "deprecated": True}))
        remote = rules.extract_archive(archive.getvalue())
        self.assertEqual(list(remote), ["example"])
        with tempfile.TemporaryDirectory() as folder, patch.object(rules, "DATA_ROOT", Path(folder)), \
                patch.object(rules, "remote_rules", return_value=remote), patch.object(rules, "_CATALOGUES", {}):
            self.assertFalse(rules.rule_list(remote=True)["items"][0]["installed"])
            handler = SimpleNamespace(client_address=("127.0.0.1", 1234), headers={"Host": "localhost"})
            with patch.object(rules, "search") as search:
                with self.assertRaises(RequestProblem) as missing:
                    rules.serve(handler, rules.PREFIX + "search", {"rule": ["example"], "title": ["Example"]})
                self.assertEqual(missing.exception.status, 404)
                search.assert_not_called()
            rules.change_rule("example", "install")
            self.assertEqual(rules.installed_rule("example"), rule)
            html = b'<ul><li><a href="/one">06</a></li></ul><ul><li><a href="/two">07</a></li></ul>'
            with patch.object(rules, "_read", return_value=(html, "https://example.com/show")):
                data = rules.catalogue("example", rule, "https://example.com/show")
            self.assertEqual([[(ep["number"], ep["url"]) for ep in line["episodes"]] for line in data["sources"]],
                             [[("6", "https://example.com/one")], [("7", "https://example.com/two")]])
            rules.change_rule("example", "remove")
            self.assertEqual(rules.rule_list()["items"], [])

    def test_xifan_failed_direct_stream_falls_back_to_playback_page(self):
        page = "https://next.xifanacg.com/anime/1/play/2"
        direct = "https://example.com/direct.mp4"
        media = "https://example.com/browser.mp4"
        catalogue = {"sources": [{"id": 4, "episodes": [{"id": 2, "url": page}]}]}
        rule = {}
        with patch.object(rules, "catalogue", return_value=catalogue), \
                patch.object(preview, "resolve", return_value=(direct, None)), \
                patch.object(streams, "probe_media", side_effect=[RequestProblem("HTTP 500", 502), None]), \
                patch.object(streams, "resolve_in_browser", return_value=(media, "file", {})) as browser, \
                patch.object(streams, "issue", return_value={"format": "file"}) as issue:
            self.assertEqual(rules.play("xfdmnext", rule, "1", "4", "2"), {"format": "file"})
            browser.assert_called_once_with(page, rule)
            issue.assert_called_once_with(media, "file", {})

    def test_custom_rule_and_default_survive_renaming_and_editing(self):
        config = {
            "name": "Example", "version": "1", "baseURL": "https://example.com",
            "searchURL": "/?q=@keyword", "searchList": "//article", "searchName": "//a",
            "searchResult": "//a", "chapterRoads": "//ul", "chapterResult": "//a",
        }
        with tempfile.TemporaryDirectory() as folder, patch.object(rules, "DATA_ROOT", Path(folder)), \
                patch.object(rules, "remote_rules") as remote:
            with self.assertRaises(RequestProblem):
                rules.change_rule(None, "create", config="{}")
            row = rules.change_rule(None, "create", name="自定义名称", config=json.dumps(config))["items"][0]
            rule_id = row["id"]
            self.assertTrue(row["custom"])
            self.assertEqual(row["name"], "自定义名称")
            self.assertEqual(rules.change_rule(rule_id, "default")["default_rule"], rule_id)
            rules.change_rule(rule_id, "rename", name="我的片源")
            result = rules.change_rule(rule_id, "edit", config=json.dumps({**config, "version": "2"}))
            self.assertEqual(result["default_rule"], rule_id)
            self.assertEqual((result["items"][0]["name"], result["items"][0]["version"]), ("我的片源", "2"))
            self.assertEqual(rules.change_rule(rule_id, "remove")["default_rule"], "")
            self.assertEqual(rules.change_rule("manual", "default")["default_rule"], "manual")
            remote.assert_not_called()

    def test_rule_update_checks_fresh_catalogue_and_cannot_downgrade(self):
        local = {
            "name": "Example", "version": "1.9", "baseURL": "https://example.com/",
            "searchURL": "https://example.com/?q=@keyword", "searchList": "//article",
            "searchName": "//a", "searchResult": "//a", "chapterRoads": "//ul", "chapterResult": "//a",
        }
        newer = {**local, "version": "1.10"}
        with tempfile.TemporaryDirectory() as folder, patch.object(rules, "DATA_ROOT", Path(folder)), \
                patch.object(rules, "remote_rules", return_value={"example": local}) as remote, \
                patch.object(rules, "_CATALOGUES", {}):
            rules.change_rule("example", "install")
            rules.change_rule("example", "rename", name="我的规则")
            remote.return_value = {"example": newer}
            row = rules.rule_list(remote=True, refresh=True)["items"][0]
            remote.assert_called_with(refresh=True)
            self.assertEqual((row["version"], row["available_version"], row["update"]), ("1.9", "1.10", True))
            rules.change_rule("example", "update")
            remote.return_value = {"example": local}
            self.assertFalse(rules.rule_list(remote=True)["items"][0]["update"])
            with self.assertRaises(RequestProblem):
                rules.change_rule("example", "update")
            self.assertEqual(rules.installed_rule("example"), {**newer, "_handbook_name": "我的规则"})
