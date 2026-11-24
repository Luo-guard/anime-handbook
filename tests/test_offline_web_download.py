"""网站资源下载：m3u8 / 直链抓取，以及和媒体库归档的衔接。

下载器不依赖外网：这里起一个本地 HTTP 站点当片源，沙箱模式放开回环地址。
"""
import http.server
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from handbook import database, offline_config, web_download
from handbook.offline import OfflineStore
from handbook.offline_service import OfflineError, OfflineService

SEGMENTS = [b"segment-one-bytes", b"segment-two-bytes!", b"segment-three!!"]
KEY_BYTES = b"0123456789abcdef"


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    playlist = ""
    master = ""
    encrypted = ""
    video = b""
    ranges = []

    def log_message(self, *_args):
        pass

    def do_GET(self):  # noqa: N802 - http.server 的约定
        path = self.path.split("?")[0]
        if path == "/master.m3u8":
            return self._text(self.master)
        if path == "/media.m3u8":
            return self._text(self.playlist)
        if path == "/secret.m3u8":
            return self._text(self.encrypted)
        if path == "/live.m3u8":
            return self._text("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/seg0.ts\n")
        if path == "/key.key":
            return self._bytes(KEY_BYTES)
        if path.startswith("/seg") and path.endswith(".ts"):
            index = int(path[4:-3])
            return self._bytes(SEGMENTS[index])
        if path == "/video.mp4":
            data = self.video
            header = self.headers.get("Range")
            self.ranges.append(header or "")
            if header:
                start = int(header.split("=")[1].split("-")[0])
                return self._bytes(data[start:], status=206, extra={"Content-Range": f"bytes {start}-{len(data) - 1}/{len(data)}"})
            return self._bytes(data)
        self.send_error(404)

    def _bytes(self, data: bytes, status: int = 200, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def _text(self, text: str):
        data = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.apple.mpegurl")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class ServerMixin:
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()


class WebDownloaderTest(ServerMixin, unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dest = Path(self.tmp.name) / "web"
        FixtureHandler.master = (
            "#EXTM3U\n"
            '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n'
            '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1920x1080\nmedia.m3u8\n'
        )
        FixtureHandler.playlist = (
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n"
            "#EXTINF:4.0,\nseg0.ts\n#EXTINF:4.0,\nseg1.ts\n#EXTINF:4.0,\nseg2.ts\n#EXT-X-ENDLIST\n"
        )
        FixtureHandler.encrypted = (
            "#EXTM3U\n#EXT-X-TARGETDURATION:4\n"
            '#EXT-X-KEY:METHOD=AES-128,URI="/key.key"\n'
            "#EXTINF:4.0,\nseg0.ts\n#EXT-X-ENDLIST\n"
        )
        FixtureHandler.video = b"x" * 4096
        FixtureHandler.ranges = []
        self.env = patch.dict("os.environ", {"ANIME_HANDBOOK_SANDBOX": "1"})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def _run(self, url: str, kind: str = "hls") -> web_download.WebTask:
        task = web_download.WebTask(7, url, kind, {}, self.dest)
        task._run()  # 同步跑，测试里不需要线程
        return task

    def test_master_playlist_picks_highest_bandwidth(self):
        task = self._run(f"{self.base}/master.m3u8")
        self.assertEqual(task.status, "done", task.error)
        self.assertEqual(len(list(self.dest.glob("seg_*.ts"))), 3)
        playlist = (self.dest / web_download.PLAYLIST_NAME).read_text(encoding="utf-8")
        self.assertIn("seg_00000.ts", playlist)
        self.assertIn("#EXT-X-ENDLIST", playlist)
        self.assertTrue(playlist.startswith("#EXTM3U"))

    def test_aes_key_is_saved_next_to_the_local_playlist(self):
        task = self._run(f"{self.base}/secret.m3u8")
        self.assertEqual(task.status, "done", task.error)
        self.assertEqual((self.dest / "key_0.key").read_bytes(), KEY_BYTES)
        playlist = (self.dest / web_download.PLAYLIST_NAME).read_text(encoding="utf-8")
        self.assertIn('URI="key_0.key"', playlist)
        self.assertNotIn("/key.key", playlist)

    def test_live_playlist_is_rejected(self):
        task = self._run(f"{self.base}/live.m3u8")
        self.assertEqual(task.status, "failed")
        self.assertIn("直播", task.error)

    def test_direct_file_download(self):
        task = self._run(f"{self.base}/video.mp4", kind="file")
        self.assertEqual(task.status, "done", task.error)
        self.assertEqual((self.dest / web_download.DIRECT_NAME).stat().st_size, 4096)

    def test_direct_file_resumes_from_part_file(self):
        self.dest.mkdir(parents=True, exist_ok=True)
        (self.dest / (web_download.DIRECT_NAME + ".part")).write_bytes(FixtureHandler.video[:1024])
        task = self._run(f"{self.base}/video.mp4", kind="file")
        self.assertEqual(task.status, "done", task.error)
        self.assertEqual((self.dest / web_download.DIRECT_NAME).read_bytes(), FixtureHandler.video)
        self.assertIn("bytes=1024-", FixtureHandler.ranges)


class ServiceIntegrationTest(ServerMixin, unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.db = database.HandbookDB(self.root / "handbook.db", asset_root=self.root)
        self.store = OfflineStore(self.db)
        offline_config.save(self.root, {"media_root": str(self.root / "media"), "seed_after_done": True})
        self.service = OfflineService(self.db)
        self.env = patch.dict("os.environ", {"ANIME_HANDBOOK_SANDBOX": "1"})
        self.env.start()
        FixtureHandler.video = b""
        FixtureHandler.playlist = (
            "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg0.ts\n#EXT-X-ENDLIST\n"
        )

    def tearDown(self):
        self.env.stop()
        web_download.clear_folder(self.root)
        self.tmp.cleanup()

    def _wait(self, media_id: int, wanted: str, timeout: float = 20.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            job = self.store.job(media_id) or {}
            if job.get("status") == wanted:
                return job
            time.sleep(0.1)
        self.fail(f"任务没有变成 {wanted}：{self.store.job(media_id)}")

    def test_download_creates_web_job_and_reuses_the_same_episode(self):
        first = self.service.download_web(
            anime_id=42, url=f"{self.base}/media.m3u8", kind="hls",
            episode_key="0:3", title="测试番 · 第 03 集",
        )
        self.assertFalse(first["reused"])
        self.assertEqual(first["job"]["source_kind"], "web")
        second = self.service.download_web(
            anime_id=42, url=f"{self.base}/media.m3u8", kind="hls",
            episode_key="0:3", title="测试番 · 第 03 集",
        )
        # 同一集再点一次不能叠出第二条任务。
        self.assertTrue(second["reused"])
        self.assertEqual(first["job"]["id"], second["job"]["id"])

    def test_missing_episode_key_is_refused(self):
        with self.assertRaises(OfflineError):
            self.service.download_web(anime_id=1, url=f"{self.base}/media.m3u8", episode_key="")

    def test_delete_job_cleans_the_temporary_folder(self):
        data = self.service.download_web(
            anime_id=42, url=f"{self.base}/media.m3u8", kind="hls",
            episode_key="0:4", title="测试番 · 第 04 集",
        )
        media_id = int(data["job"]["id"])
        folder = self.service._web_folder(media_id)
        deadline = time.time() + 20
        while time.time() < deadline and not (folder / web_download.PLAYLIST_NAME).is_file():
            time.sleep(0.1)
        self.service.delete_job(media_id)
        self.assertFalse(folder.exists())
        self.assertIsNone(self.store.job(media_id))

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "需要本机 ffmpeg")
    def test_direct_download_is_archived_into_the_library(self):
        sample = self.root / "sample.mp4"
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                "-t", "1", "-c:v", "libx264", "-preset", "ultrafast",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(sample),
            ],
            capture_output=True, timeout=180, check=True,
        )
        FixtureHandler.video = sample.read_bytes()
        data = self.service.download_web(
            anime_id=77, url=f"{self.base}/video.mp4", kind="file",
            episode_key="0:5", title="测试番 · 第 05 集",
        )
        media_id = int(data["job"]["id"])
        self._wait(media_id, "downloading")
        # 下载线程结束后由心跳推进到归档。
        deadline = time.time() + 30
        while time.time() < deadline:
            self.service._sync(self.store.jobs_for_sync())
            job = self.store.job(media_id) or {}
            if job.get("status") in ("ready", "failed"):
                break
            time.sleep(0.2)
        job = self.store.job(media_id) or {}
        self.assertEqual(job.get("status"), "ready", job.get("error"))
        files = self.store.files_for_anime(77)
        self.assertEqual([item["episode_key"] for item in files], ["0:5"])
        self.assertTrue(Path(files[0]["file_path"]).is_file())
        # 归档完临时目录要清掉，别留第二份。
        self.assertFalse(self.service._web_folder(media_id).exists())


class PlaybackTokenTest(unittest.TestCase):
    """下载复用播放令牌：拿到的必须是正在播的那一份地址与请求头。"""

    def test_lookup_returns_the_issued_resource(self):
        from handbook import playback_stream

        issued = playback_stream.issue("https://example.com/a.m3u8", "hls", {"Referer": "https://example.com/"})
        token = issued["url"].split("/stream/")[1].split("/")[0]
        playback = playback_stream.lookup(token)
        self.assertIsNotNone(playback)
        url, kind = playback_stream.main_resource(playback)
        self.assertEqual((url, kind), ("https://example.com/a.m3u8", "hls"))
        self.assertEqual(playback.headers.get("Referer"), "https://example.com/")

    def test_unknown_token_is_none(self):
        from handbook import playback_stream

        self.assertIsNone(playback_stream.lookup("nope"))


if __name__ == "__main__":
    unittest.main()
