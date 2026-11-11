"""Regressions for the public URL and media relay boundaries."""
import time
import unittest
from unittest.mock import patch
from urllib.request import Request

from handbook import xifan_preview as preview


class XifanPreviewTest(unittest.TestCase):
    def test_search_uses_the_kazumi_rule_only_for_the_known_endpoint(self):
        url = f"{preview.API}/rest/v1/rpc/search_animes"
        key = "sb_publishable_" + "example" * 2
        search_request = {"url": url, "method": "POST", "headers": {"apikey": key}}
        rule = {"searchApiConfig": {"request": search_request}}
        rows = [{"id": 42, "title": "Example", "title_original": "Original", "extra": "ignored"}]
        with patch.object(preview, "_rule", return_value=rule), patch.object(preview, "_json_request", return_value=rows) as request:
            self.assertEqual(preview.search(" Original "), {
                "items": [{"id": 42, "title": "Example", "original": "Original"}],
            })
            request.assert_called_once_with(url, {"search_term": "Original", "page_number": 1, "items_per_page": 24}, key)
            request.reset_mock()
            search_request["url"] = "https://elsewhere.test/search"
            with self.assertRaises(preview.PreviewError):
                preview.search("Original")
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
                    preview.catalogue(url)
            request.assert_not_called()

    def test_media_redirect_cannot_leave_the_known_cdn(self):
        redirect = preview._Redirect(preview.MEDIA_HOSTS)
        source = Request("https://apn.moedot.net/sample.mp4", headers={"Range": "bytes=20-40"})
        allowed = redirect.redirect_request(
            source, None, 302, "", {}, "https://bjdownload.pan.wo.cn:30443/openapi/download",
        )
        self.assertEqual(allowed.get_header("Range"), "bytes=20-40")
        for url in ("http://127.0.0.1/", "https://bjdownload.pan.wo.cn:1234/", "https://elsewhere.test/"):
            with self.subTest(url=url), self.assertRaises(preview.PreviewError):
                redirect.redirect_request(source, None, 302, "", {}, url)

    def test_invalid_or_expired_tickets_never_fetch_media(self):
        with patch.object(preview, "_TICKETS", {"expired": ("https://apn.moedot.net/sample.mp4", time.time() - 1)}):
            with patch.object(preview, "build_opener") as opener:
                for token in ("missing", "expired"):
                    with self.subTest(token=token), self.assertRaises(preview.PreviewError) as error:
                        preview._stream(None, token)
                    self.assertEqual(error.exception.status, 410)
                opener.assert_not_called()
