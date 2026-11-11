"""Regressions for the public URL and media relay boundaries."""
import time
import unittest
from unittest.mock import patch
from urllib.request import Request

from handbook import xifan_preview as preview


class XifanPreviewTest(unittest.TestCase):
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
