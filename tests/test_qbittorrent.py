"""qBittorrent 客户端：请求构造、错误翻译、接口改名回落。

全部用假 opener，不连真实客户端。
"""
import io
import os
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from handbook.qbittorrent import Client, QBError, build_multipart, normalise_base


class FakeResponse:
    def __init__(self, body: bytes = b"", status: int = 200):
        self.body = body
        self.status = status

    def read(self, size: int = -1) -> bytes:
        return self.body if size is None or size < 0 else self.body[:size]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(code: int, body: bytes) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("http://127.0.0.1:8080/api/v2", code, "err", {}, io.BytesIO(body))


class Recorder:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


@unittest.skipUnless(os.name == "nt", "Windows qBittorrent startup")
class StartupTest(unittest.TestCase):
    def test_starts_once_on_connection_refused_and_waits_for_web_ui(self):
        refused = urllib.error.URLError(ConnectionRefusedError())
        opener = Recorder(refused, refused, FakeResponse(b"v5.1.0"))
        client = Client(opener=opener)
        with patch("handbook.qbittorrent._windows_executable", return_value=Path("C:/qBittorrent/qbittorrent.exe")), \
                patch("handbook.qbittorrent.subprocess.Popen") as launch, \
                patch("handbook.qbittorrent.time.sleep"):
            client.ensure_running()
        launch.assert_called_once()
        self.assertEqual(len(opener.requests), 3)

    def test_leaves_running_and_remote_clients_alone(self):
        local = Recorder(FakeResponse(b"v5.1.0"))
        remote = Recorder()
        with patch("handbook.qbittorrent.subprocess.Popen") as launch:
            Client(opener=local).ensure_running()
            Client("http://192.0.2.1:8080", opener=remote).ensure_running()
        launch.assert_not_called()
        self.assertEqual(len(local.requests), 1)
        self.assertEqual(remote.requests, [])

    def test_web_ui_auth_error_does_not_launch(self):
        opener = Recorder(http_error(403, b"Forbidden"))
        with patch("handbook.qbittorrent.subprocess.Popen") as launch:
            with self.assertRaisesRegex(QBError, "身份验证"):
                Client(opener=opener).ensure_running()
        launch.assert_not_called()


class MultipartTest(unittest.TestCase):
    def test_fields_and_file_are_both_encoded(self):
        body = build_multipart(
            {"savepath": "D:/a b", "paused": "false"},
            {"torrents": ("x.torrent", b"d4:infodee")},
            "BOUND",
        )
        self.assertIn(b'--BOUND\r\nContent-Disposition: form-data; name="savepath"\r\n\r\nD:/a b\r\n', body)
        self.assertIn(b'name="torrents"; filename="x.torrent"', body)
        self.assertIn(b"Content-Type: application/x-bittorrent", body)
        self.assertIn(b"d4:infodee", body)
        self.assertTrue(body.endswith(b"--BOUND--\r\n"))


class AddTorrentTest(unittest.TestCase):
    def test_posts_multipart_with_metadata(self):
        opener = Recorder(FakeResponse(b"Ok."))
        client = Client(opener=opener)
        client.add_torrent(
            b"d4:infodee",
            "abc.torrent",
            save_path="D:\\media",
            category="AnimeHandbook",
            tags=("handbook", "job-1"),
            paused=True,
        )
        request = opener.requests[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertTrue(request.full_url.endswith("/api/v2/torrents/add"))
        self.assertIn("multipart/form-data; boundary=", request.get_header("Content-type"))
        body = request.data
        self.assertIn(b"d4:infodee", body)
        self.assertIn(b"filename=\"abc.torrent\"", body)
        self.assertIn(b"handbook,job-1", body)
        self.assertIn(b"paused", body)

    def test_rejection_raises(self):
        opener = Recorder(FakeResponse(b"Fails."))
        with self.assertRaises(QBError) as caught:
            Client(opener=opener).add_torrent(b"d4:infodee")
        self.assertIn("拒绝", str(caught.exception))

    def test_no_paused_or_skip_checking_fields_when_running(self):
        # qB 把布尔参数「出现」当成真值，所以正常运行时不该发这些字段，
        # 也不该开 skip_checking（新下载需要正常校验，否则容易 missingFiles）。
        opener = Recorder(FakeResponse(b"Ok."))
        Client(opener=opener).add_torrent(b"d4:infodee")
        body = opener.requests[0].data
        self.assertNotIn(b'name="paused"', body)
        self.assertNotIn(b'name="stopped"', body)
        self.assertNotIn(b'name="skip_checking"', body)

    def test_empty_payload_rejected_before_network(self):
        opener = Recorder()
        with self.assertRaises(QBError):
            Client(opener=opener).add_torrent(b"")
        self.assertEqual(opener.requests, [])


class QueryTest(unittest.TestCase):
    def test_torrents_filter_by_tag(self):
        opener = Recorder(FakeResponse(b'[{"hash":"abc"}]'))
        items = Client(opener=opener).torrents(tag="job-1")
        self.assertEqual(items[0]["hash"], "abc")
        self.assertIn("tag=job-1", opener.requests[0].full_url)

    def test_torrent_by_hash_returns_first_or_none(self):
        opener = Recorder(FakeResponse(b'[{"hash":"abc","progress":1}]'), FakeResponse(b"[]"))
        client = Client(opener=opener)
        self.assertEqual(client.torrent("abc")["progress"], 1)
        self.assertIsNone(client.torrent("none"))

    def test_malformed_torrent_response_is_not_reported_as_absent(self):
        opener = Recorder(FakeResponse(b'{"error":"unavailable"}'))
        with self.assertRaisesRegex(QBError, "任务列表无效"):
            Client(opener=opener).torrent("abc")

    def test_delete_can_keep_files(self):
        opener = Recorder(FakeResponse(b""), FakeResponse(b""))
        client = Client(opener=opener)
        client.delete(["a", "b"], delete_files=False)
        client.delete(["a"], delete_files=True)
        self.assertEqual(opener.requests[0].data, b"hashes=a%7Cb&deleteFiles=false")
        self.assertEqual(opener.requests[1].data, b"hashes=a&deleteFiles=true")


class ErrorTranslationTest(unittest.TestCase):
    def test_version_reads_plain_text(self):
        opener = Recorder(FakeResponse(b"v5.1.0\n"))
        self.assertEqual(Client(opener=opener).version(), "v5.1.0")

    def test_auth_failure_explains_the_fix(self):
        opener = Recorder(http_error(403, b"Forbidden"))
        with self.assertRaises(QBError) as caught:
            Client(opener=opener).version()
        self.assertIn("跳过身份验证", str(caught.exception))

    def test_connection_failure_is_wrapped(self):
        opener = Recorder(urllib.error.URLError("refused"), urllib.error.URLError("refused"))
        client = Client(opener=opener)
        self.assertFalse(client.alive())
        with self.assertRaises(QBError) as caught:
            client.version()
        self.assertIn("连不上", str(caught.exception))

    def test_pause_falls_back_when_endpoint_renamed(self):
        opener = Recorder(http_error(404, b"Not Found"), FakeResponse(b""))
        Client(opener=opener).pause(["abc"])
        self.assertTrue(opener.requests[0].full_url.endswith("/torrents/stop"))
        self.assertTrue(opener.requests[1].full_url.endswith("/torrents/pause"))

    def test_pause_does_not_retry_on_real_failure(self):
        opener = Recorder(http_error(500, b"boom"))
        with self.assertRaises(QBError):
            Client(opener=opener).pause(["abc"])
        self.assertEqual(len(opener.requests), 1)


class BaseUrlTest(unittest.TestCase):
    def test_defaults(self):
        self.assertEqual(normalise_base("", ""), "http://127.0.0.1:8080")

    def test_host_and_port(self):
        self.assertEqual(normalise_base("127.0.0.1", 8080), "http://127.0.0.1:8080")

    def test_full_url_wins(self):
        self.assertEqual(normalise_base("http://192.168.1.5:9090/", ""), "http://192.168.1.5:9090")

    def test_bad_port_falls_back(self):
        self.assertIn(":8080", normalise_base("127.0.0.1", "abc"))


if __name__ == "__main__":
    unittest.main()
