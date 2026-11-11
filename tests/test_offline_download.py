"""bencode 解析与「提交后认回任务」的竞态处理。"""
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from handbook import database, mikan, offline_config
from handbook.offline_service import OfflineError, OfflineService
from handbook.qbittorrent import QBError
from handbook.torrent_meta import TorrentMetaError, torrent_infohash, torrent_name

# 最小合法 torrent：顶层 announce + info(name,length)
MINIMAL_TORRENT = b"d8:announce6:abcdef4:infod4:name4:test6:lengthi1eee"
INFO_BYTES = b"d4:name4:test6:lengthi1ee"


class TorrentMetaTest(unittest.TestCase):
    def test_infohash_is_sha1_of_raw_info_dict(self):
        expected = hashlib.sha1(INFO_BYTES).hexdigest()
        self.assertEqual(torrent_infohash(MINIMAL_TORRENT), expected)
        self.assertEqual(len(expected), 40)

    def test_name_is_read_from_info(self):
        self.assertEqual(torrent_name(MINIMAL_TORRENT), "test")

    def test_info_at_the_end_of_the_dictionary(self):
        payload = b"d8:announce6:abcdef4:infod4:name4:demoee"
        self.assertEqual(torrent_infohash(payload), hashlib.sha1(b"d4:name4:demoe").hexdigest())

    def test_nested_lists_and_integers_do_not_confuse_the_scanner(self):
        # files 是列表，里面套字典，字典里又套列表；用来验证扫描器能正确跨层。
        payload = b"d8:announce6:abcdef5:filesld6:lengthi99e4:pathl5:a.mp4eee4:infod4:name4:testee"
        self.assertEqual(torrent_infohash(payload), hashlib.sha1(b"d4:name4:teste").hexdigest())
        self.assertEqual(torrent_name(payload), "test")

    def test_malformed_payloads_are_rejected(self):
        for payload in (b"", b"not-a-torrent", b"d4:name4:teste"):
            with self.assertRaises(TorrentMetaError):
                torrent_infohash(payload)

    def test_name_failure_returns_empty_string(self):
        self.assertEqual(torrent_name(b"garbage"), "")


class FakeClient:
    """前几次查询故意返回空，模拟 qB 刚 add 完还没注册完。"""

    def __init__(self, missing_times: int = 2, preexisting: bool = False, reject_add: bool = False):
        self.missing_times = missing_times
        self.preexisting = preexisting
        self.reject_add = reject_add
        self.calls = 0
        self.added: dict = {}
        self.hash = "a" * 40

    def add_torrent(self, payload, filename, **kwargs):
        if self.reject_add:
            from handbook.qbittorrent import QBError
            raise QBError("qBittorrent 拒绝了这个种子：Fails.")
        self.added = {"payload": payload, "filename": filename, **kwargs}

    def torrent(self, _hash):
        if self.preexisting:
            return {"hash": self.hash, "name": "已存在任务", "state": "missingFiles"}
        if not self.added:
            # 提交之前当然查不到
            return None
        self.calls += 1
        if self.calls <= self.missing_times:
            return None
        return {"hash": self.hash, "name": "测试任务", "state": "downloading"}

    def torrents(self, **_kwargs):
        return []


class DownloadLookupTest(unittest.TestCase):
    def test_delete_keeps_local_task_when_qb_is_offline(self):
        job = self.service.store.create_job(anime_id=1, torrent_hash="abc", torrent_name="test")
        for operation in ("torrent", "delete"):
            with self.subTest(operation=operation), patch.object(self.service, "client") as client:
                qb = client.return_value
                qb.torrent.return_value = {"hash": "abc"}
                getattr(qb, operation).side_effect = QBError("connection refused")
                with self.assertRaisesRegex(OfflineError, "保留手账记录"):
                    self.service.delete_job(job["id"], delete_files=True)
                self.assertIsNotNone(self.service.store.job(job["id"]))

    def test_delete_clears_only_confirmed_removed_tasks(self):
        for already_absent in (True, False):
            with self.subTest(already_absent=already_absent):
                job = self.service.store.create_job(anime_id=1, torrent_hash="abc", torrent_name="test")
                with patch.object(self.service, "client") as client:
                    qb = client.return_value
                    qb.torrent.side_effect = [None] if already_absent else [{"hash": "abc"}, None]
                    self.assertTrue(self.service.delete_job(job["id"])["ok"])
                    if already_absent:
                        qb.delete.assert_not_called()
                    else:
                        qb.delete.assert_called_once_with(["abc"], delete_files=False)
                self.assertIsNone(self.service.store.job(job["id"]))

    def test_delete_keeps_local_task_if_qb_does_not_remove_it(self):
        job = self.service.store.create_job(anime_id=1, torrent_hash="abc", torrent_name="test")
        with patch.object(self.service, "client") as client:
            client.return_value.torrent.return_value = {"hash": "abc"}
            with self.assertRaisesRegex(OfflineError, "任务仍在下载器"):
                self.service.delete_job(job["id"])
        self.assertIsNotNone(self.service.store.job(job["id"]))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.db = database.HandbookDB(self.root / "handbook.db", asset_root=self.root)
        offline_config.save(
            self.root,
            {
                "media_root": str(self.root / "media"),
                "download_root": str(self.root / "incoming"),
            },
        )
        self.service = OfflineService(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def run_download(self, client):
        patches = [
            patch.object(mikan, "fetch_torrent", return_value=MINIMAL_TORRENT),
            patch.object(OfflineService, "client", new=lambda _self, config=None: client),
        ]
        for item in patches:
            item.start()
        try:
            return self.service.download(
                anime_id=3,
                torrent_url="https://mikanime.tv/Download/x.torrent",
                title="[字幕组] 测试番 - 01",
                episode_key="0:1",
                group_name="字幕组",
            )
        finally:
            for item in patches:
                item.stop()

    def test_retries_instead_of_false_negative(self):
        client = FakeClient(missing_times=2)
        result = self.run_download(client)
        self.assertTrue(result["ok"])
        self.assertEqual(result["job"]["torrent_hash"], "a" * 40)
        self.assertGreaterEqual(client.calls, 3, "应该轮询到任务出现为止")
        self.assertIn("payload", client.added)

    def test_immediate_lookup_still_works(self):
        client = FakeClient(missing_times=0)
        result = self.run_download(client)
        self.assertTrue(result["ok"])
        self.assertEqual(client.calls, 1)

    def test_tags_are_still_sent_as_fallback(self):
        client = FakeClient(missing_times=0)
        self.run_download(client)
        tags = client.added.get("tags") or ()
        self.assertIn("handbook", tags)
        self.assertTrue(any(str(tag).startswith("hb") for tag in tags))

    def test_no_paused_flag_when_not_paused(self):
        # qB 把出现即视为真值，所以不暂停时根本不该传 paused / stopped。
        client = FakeClient(missing_times=0)
        self.run_download(client)
        self.assertIn("payload", client.added)
        self.assertIs(client.added["paused"], False)
        # 真正发给 qB 的表单里不该出现这些字段，见 test_qbittorrent 的对应断言。

    def test_existing_torrent_is_reused_without_resubmitting(self):
        client = FakeClient(preexisting=True)
        result = self.run_download(client)
        self.assertTrue(result["ok"])
        self.assertTrue(result["reused"])
        self.assertEqual(result["task_state"], "missingFiles")
        self.assertEqual(client.added, {}, "已经存在时不该再提交一次")

    def test_rejected_add_falls_back_to_existing_lookup(self):
        # qB 对重复种子回 "Fails."；先抛错、随后按 infohash 能查到就当复用。
        class RejectThenFind(FakeClient):
            def __init__(self):
                super().__init__(reject_add=True)
                self.after_reject = 0

            def torrent(self, _hash):
                if self.reject_add and self.after_reject == 0:
                    self.after_reject += 1
                    return None
                return {"hash": self.hash, "name": "已存在任务", "state": "stalledDL"}

        result = self.run_download(RejectThenFind())
        self.assertTrue(result["reused"])


if __name__ == "__main__":
    unittest.main()
