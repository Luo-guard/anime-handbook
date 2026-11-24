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
from handbook import offline_service as offline_service_module
from handbook.offline import OfflineStore
from handbook.offline_service import OfflineError, OfflineService

SEGMENTS = [b"segment-one-bytes", b"segment-two-bytes!", b"segment-three!!"]
KEY_BYTES = b"0123456789abcdef"


def _wait_archives(timeout: float = 20.0) -> None:
    """等后台归档线程收尾：它还在 remux 时删临时目录会让 sqlite 报只读。"""
    deadline = time.time() + timeout
    while time.time() < deadline and offline_service_module._ARCHIVING:
        time.sleep(0.1)


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
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
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
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # 整个类共用一个根目录，每个用例用子目录：临时目录在用例中途被删掉，
        # 后台线程就会写进一个不存在的库（sqlite 报 readonly）。
        cls.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        cls.class_root = Path(cls.tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()
        super().tearDownClass()

    def setUp(self):
        self.root = self.class_root / self._testMethodName
        self.root.mkdir(parents=True, exist_ok=True)
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
        # 先让批次线程收手并 join，再清注册表、等归档线程；否则线程会写进已删除的临时库。
        self.service.stop_web_batches()
        web_download.reset()
        _wait_archives()
        self.env.stop()
        web_download.clear_folder(self.root)

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
        # 等下载线程自己跑完（不碰数据库），再同步归档：避免测试线程和下载线程
        # 同时读写同一个库，sqlite 在这种并发下偶发 readonly。
        deadline = time.time() + 30
        while time.time() < deadline:
            task = web_download.get(self.service._web_owner(), media_id)
            if task is None:
                break
            if task.snapshot().get("status") in ("done", "failed"):
                break
            time.sleep(0.05)
        self.service._archive(media_id)
        job = self.store.job(media_id) or {}
        folder = self.service._web_folder(media_id)
        listing = sorted(item.name for item in folder.iterdir()) if folder.exists() else "目录不存在"
        self.assertEqual(job.get("status"), "ready", f"{job.get('error')} | {folder} | {listing}")
        files = self.store.files_for_anime(77)
        self.assertEqual([item["episode_key"] for item in files], ["0:5"])
        self.assertTrue(Path(files[0]["file_path"]).is_file())
        # 归档完临时目录要清掉，别留第二份。
        self.assertFalse(self.service._web_folder(media_id).exists())


class _FakeTask:
    """只回「已完成」的下载任务替身：串行顺序和状态流转不依赖真实网络与文件。"""

    total_bytes = 0
    error = ""

    def __init__(self, media_id: int) -> None:
        self.media_id = media_id

    def snapshot(self) -> dict:
        return {"status": "done", "paused": False, "progress": 100.0, "speed": 0.0, "bytes": 0}

    def pause(self) -> None: ...
    def resume(self) -> None: ...
    def cancel(self) -> None: ...


class BatchDownloadTest(ServerMixin, unittest.TestCase):
    """选集下载：入队、串行解析、跳过已有、单集失败不拖累整批。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        cls.class_root = Path(cls.tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()
        super().tearDownClass()

    def setUp(self):
        self.root = self.class_root / self._testMethodName
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = database.HandbookDB(self.root / "handbook.db", asset_root=self.root)
        self.store = OfflineStore(self.db)
        offline_config.save(self.root, {"media_root": str(self.root / "media"), "seed_after_done": True})
        self.service = OfflineService(self.db)
        self.env = patch.dict("os.environ", {"ANIME_HANDBOOK_SANDBOX": "1"})
        self.env.start()
        FixtureHandler.video = b"y" * 2048

    def tearDown(self):
        # 先让批次线程收手并 join，再清注册表、等归档线程；否则线程会写进已删除的临时库。
        self.service.stop_web_batches()
        web_download.reset()
        _wait_archives()
        self.env.stop()
        web_download.clear_folder(self.root)

    def _queue(self, anime_id: int, pairs: list[tuple[str, str]]) -> list[dict]:
        """直接建排队中的任务，但不启动线程：下面用同步方式跑 worker，避免和
        测试自己的临时库赛跑（后台线程在临时目录被删时会写失败）。"""
        queue = []
        for key, episode_id in pairs:
            job, _fresh = self.service._web_job_for(anime_id, key, "测试番", "", status="queued")
            queue.append({"media_id": int(job["id"]), "episode_id": episode_id, "key": key})
        return queue

    def _run_worker(self, queue: list[dict], resolve) -> None:
        """同步跑 worker，但把「下载」换成即时完成的替身：这一层要验的是排队、
        解析顺序和失败隔离，真实下载由 WebDownloaderTest 覆盖。"""
        tasks: dict[int, _FakeTask] = {}

        def fake_start(owner, media_id, url, kind, headers, folder):
            tasks[int(media_id)] = _FakeTask(int(media_id))
            return tasks[int(media_id)]

        with patch.object(web_download, "start", fake_start), \
             patch.object(web_download, "get", lambda owner, media_id: tasks.get(int(media_id))), \
             patch.object(OfflineService, "_schedule_archive", lambda self, media_id: None):
            self.service._run_web_batch_inner(queue, resolve, self.service._batch_epoch)

    def test_api_queues_all_selected_episodes(self):
        data = self.service.download_web_batch(
            anime_id=88,
            items=[
                {"episode_key": "0:1", "episode_id": "ep-1"},
                {"episode_key": "0:2", "episode_id": "ep-2"},
            ],
            resolve=lambda episode_id: (f"{self.base}/video.mp4", "file", {}),
            title="测试番",
        )
        self.assertEqual(data["queued"], 2)
        self.assertEqual(data["skipped"], 0)
        self.assertEqual([job["status"] for job in data["jobs"]], ["queued", "queued"])
        # 线程已经起来在跑了，这里立刻叫停，免得它跑进下一个用例的临时目录。
        self.service.stop_web_batches()
        web_download.reset()

    def test_worker_resolves_and_downloads_one_episode_at_a_time(self):
        calls: list[str] = []

        def resolve(episode_id: str):
            calls.append(episode_id)
            return (f"{self.base}/video.mp4", "file", {})

        queue = self._queue(88, [("0:1", "ep-1"), ("0:2", "ep-2")])
        self._run_worker(queue, resolve)
        # 串行：第二集的解析只能发生在第一集下完之后。
        self.assertEqual(calls, ["ep-1", "ep-2"])
        for item in queue:
            job = self.store.job(item["media_id"]) or {}
            status = job.get("status")
            # 夹具是假字节，归档可能封装失败；下载本身必须成功（进了 processing 之后）。
            self.assertIn(status, ("processing", "ready", "failed"), job.get("error"))
            if status == "failed":
                self.assertIn("归档失败", str(job.get("error")))

    def test_batch_skips_episodes_already_in_the_queue(self):
        self.service.download_web(
            anime_id=90, url=f"{self.base}/video.mp4", kind="file",
            episode_key="0:1", title="测试番",
        )
        data = self.service.download_web_batch(
            anime_id=90,
            items=[
                {"episode_key": "0:1", "episode_id": "ep-1"},
                {"episode_key": "0:2", "episode_id": "ep-2"},
            ],
            resolve=lambda episode_id: (f"{self.base}/video.mp4", "file", {}),
            title="测试番",
        )
        self.assertEqual(data["queued"], 1)
        self.assertEqual(data["skipped"], 1)
        self.assertEqual(data["jobs"][0]["episode_key"], "0:2")
        self.service.stop_web_batches()
        web_download.reset()

    def test_one_failed_resolve_does_not_stop_the_rest(self):
        def resolve(episode_id: str):
            if episode_id == "bad":
                raise OfflineError("这条线路没有这一集")
            return (f"{self.base}/video.mp4", "file", {})

        queue = self._queue(91, [("0:1", "bad"), ("0:2", "good")])
        self._run_worker(queue, resolve)
        bad = self.store.job(queue[0]["media_id"]) or {}
        self.assertEqual(bad.get("status"), "failed")
        self.assertIn("解析这一集失败", str(bad.get("error")))
        good = self.store.job(queue[1]["media_id"]) or {}
        self.assertIn(good.get("status"), ("processing", "ready", "failed"), good.get("error"))
        if good.get("status") == "failed":
            self.assertIn("归档失败", str(good.get("error")))

    def test_failed_episode_keeps_its_slot_and_can_retry_in_place(self):
        """失败的一集留在任务里，并记住「怎么再找到这一集」，重试不用回播放器。"""
        ref = {"rule": "demo", "catalogue": "1", "source": "1", "episode": "ep-8"}
        job, _fresh = self.service._web_job_for(95, "0:8", "测试番", "", status="failed", ref=ref)
        self.store.set_status(int(job["id"]), "failed", error="解析这一集失败：未找到可用视频")

        state = self.service.state(95)
        self.assertEqual(len(state["jobs"]), 1, "失败集不能被从任务列表里丢掉")
        self.assertEqual(state["jobs"][0]["episode_key"], "0:8")
        self.assertTrue(state["jobs"][0]["retryable"], "留了片源信息就应该能就地重试")

        calls: list[str] = []

        def resolve(episode_id: str):
            calls.append(episode_id)
            return (f"{self.base}/video.mp4", "file", {})

        with patch.object(web_download, "start", lambda *args, **kwargs: None):
            self.service.retry_web(int(job["id"]), resolve)
        self.assertEqual(calls, ["ep-8"])
        again = self.store.job(int(job["id"])) or {}
        self.assertEqual(again.get("status"), "downloading")
        self.assertEqual(again.get("error"), "", "重试要把上一次的错误清掉")

    def test_retry_without_source_ref_is_refused_with_a_usable_message(self):
        job, _fresh = self.service._web_job_for(96, "0:1", "测试番", "", status="failed")
        self.store.set_status(int(job["id"]), "failed", error="下载已中断")
        self.assertFalse(self.service.state(96)["jobs"][0]["retryable"])
        with self.assertRaises(OfflineError) as caught:
            self.service.retry_web(int(job["id"]), lambda _id: ("", "", {}))
        self.assertIn("片源信息", str(caught.exception))

    def test_empty_selection_is_refused(self):
        with self.assertRaises(OfflineError):
            self.service.download_web_batch(anime_id=1, items=[], resolve=lambda _id: ("", "", {}))


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
