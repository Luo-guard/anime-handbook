"""G2/G4: deterministic load, concurrency, wire faults and restore isolation.

No external network, real profile or real cloud is used.
"""
import gzip
import http.client as httpclient
from http.server import ThreadingHTTPServer
import json
import socket
import sqlite3
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from handbook import database, desktop, http, metadata
from handbook.concurrency import ReadWriteGate
from handbook.settings_service import normalize_settings
from handbook.observability import record_failure


class Profiles:
    def __init__(self, paths): self.paths, self.active = paths, "a"
    def profile(self, profile_id=None): return {"id": profile_id or self.active, "name": profile_id or self.active, "shared": False}
    def list_profiles(self): return [self.profile(key) for key in self.paths]
    def database_path(self, profile_id=None): return self.paths[profile_id or self.active]
    def activate(self, profile_id): self.active=profile_id; return self.profile()


class WireTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = database.HandbookDB(self.root / "a.db", asset_root=self.root)
        self.profiles = Profiles({"a": self.db.path, "b": self.root / "b.db"})
        self.patches = [patch.object(desktop, "DATABASE", self.db), patch.object(desktop, "PROFILES", self.profiles),
                        patch.object(desktop, "SYNC", metadata.SyncService(self.db)), patch.object(desktop, "require_active_profile_write_access")]
        for item in self.patches: item.start()
        class Handler(http.RequestHandler):
            def setup(self): super().setup(); self.request.settimeout(.3)
        class Server(ThreadingHTTPServer):
            request_queue_size = 64
        self.server = Server(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval":.02}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(3)
        for item in reversed(self.patches): item.stop()
        self.temp.cleanup()

    def call(self, method, path, body=None, headers=None):
        conn = httpclient.HTTPConnection("127.0.0.1", self.server.server_port, timeout=8)
        conn.request(method, path, body, {"Content-Type":"application/json", **(headers or {})})
        response=conn.getresponse(); payload=response.read(); result=(response.status,payload,dict(response.getheaders()))
        conn.close(); return result

    def test_staged_background_does_not_change_settings_or_existing_image(self):
        import base64
        import io
        from PIL import Image
        output = io.BytesIO()
        Image.new("RGB", (2, 2), "blue").save(output, "PNG")
        before = self.db.get_settings()
        root = self.root / "background"
        root.mkdir()
        existing = root / "saved-image.png"
        existing.write_bytes(b"existing")
        with patch.object(http, "BACKGROUND_ROOT", root):
            body = json.dumps({"data": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode(), "profile_id": "theme_staged", "defer_settings": True})
            status, raw, _ = self.call("POST", "/api/background", body)
            self.assertEqual(status, 200, raw)
            self.assertGreater(json.loads(raw)["version"], 0)
        self.assertEqual(self.db.get_settings(), before)
        self.assertEqual(existing.read_bytes(), b"existing")
        self.assertEqual(len(list(root.glob("*"))), 2)

    def test_object_content_type_length_and_encoding_validation(self):
        for body in [b"[]",b"null",b"true",b"1",b'"text"',b"{",b"\xff"]:
            self.assertEqual(self.call("POST","/api/notes",body)[0],400,body)
        self.assertEqual(self.call("POST","/api/notes",b"{}",{"Content-Type":"text/plain"})[0],415)
        self.assertEqual(self.call("POST","/api/notes",b"{}",{"Content-Length":"-1"})[0],400)
        self.assertEqual(self.call("POST","/api/notes",b"",{"Content-Length":"999999999"})[0],413)
        with self.db.connect() as db: self.assertEqual(db.execute("SELECT COUNT(*) FROM events").fetchone()[0],0)

    def test_slow_and_truncated_request_bodies_recover(self):
        for slow in [True,False]:
            connection=socket.create_connection(("127.0.0.1",self.server.server_port),timeout=3)
            connection.sendall(b'POST /api/notes HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"content":')
            if not slow: connection.shutdown(socket.SHUT_WR)
            response=connection.recv(4096); connection.close()
            self.assertIn(b"408" if slow else b"400",response)
        self.assertEqual(self.call("POST","/api/notes",b'{"content":"after fault"}')[0],201)

    def test_static_compression_etags_and_cover_short_circuit(self):
        status,plain,plain_headers=self.call("GET","/styles.css")
        self.assertEqual(status,200)
        status,compressed,zipped_headers=self.call("GET","/styles.css",headers={"Accept-Encoding":"gzip"})
        self.assertEqual(gzip.decompress(compressed),plain)
        self.assertNotEqual(plain_headers["ETag"],zipped_headers["ETag"])
        self.assertLess(len(compressed),len(plain))
        self.assertEqual(self.call("GET","/styles.css",headers={"Accept-Encoding":"gzip","If-None-Match":zipped_headers["ETag"]})[:2],(304,b""))
        self.assertNotIn("Content-Encoding",self.call("GET","/styles.css",headers={"Accept-Encoding":"gzip;q=0"})[2])
        with self.db.connect() as db:
            db.execute("INSERT INTO anime(id,collection_type,name,image_url,created_at,updated_at) VALUES(1,1,'cover','https://example.invalid/image','2026-01-01','2026-01-01')")
        (self.root / "covers" / "1.img").write_bytes(b"cached cover")
        with patch.object(self.db,"get_anime",side_effect=AssertionError("heavy read")):
            status,body,headers=self.call("GET","/api/covers/1")
        self.assertEqual((status,body),(200,b"cached cover"))
        with patch.object(desktop.SYNC,"cover",side_effect=AssertionError("304 read image body")):
            self.assertEqual(self.call("GET","/api/covers/1",headers={"If-None-Match":headers["ETag"]})[:2],(304,b""))

    def test_concurrent_writers_and_readers_have_no_missing_or_duplicate_notes(self):
        def task(index):
            if index % 3:
                status,body,_=self.call("POST","/api/notes",json.dumps({"content":f"note-{index}"}).encode())
                self.assertEqual(status,201,body)
            else: self.assertEqual(self.call("GET","/api/status")[0],200)
        with ThreadPoolExecutor(max_workers=12) as pool: list(pool.map(task,range(120)))
        with self.db.connect() as db:
            rows=db.execute("SELECT content,record_uid FROM events").fetchall()
        self.assertEqual(len(rows),80)
        self.assertEqual(len({row[0] for row in rows}),80)
        self.assertEqual(len({row[1] for row in rows}),80)

    def test_switch_waits_for_old_request_and_failed_switch_is_atomic(self):
        entered, release, switched=threading.Event(),threading.Event(),threading.Event()
        original=self.db.add_note
        def held(*args,**kwargs): entered.set(); release.wait(3); return original(*args,**kwargs)
        with patch.object(self.db,"add_note",side_effect=held), ThreadPoolExecutor(max_workers=2) as pool:
            old=pool.submit(self.call,"POST","/api/notes",b'{"content":"account a"}')
            self.assertTrue(entered.wait(2))
            def switch():
                result=self.call("POST","/api/profiles/activate",b'{"profile_id":"b"}')
                switched.set(); return result
            switch_task=pool.submit(switch)
            self.assertFalse(switched.wait(.08))
            release.set()
            self.assertEqual(old.result()[0],201)
            self.assertEqual(switch_task.result()[0],200)
        self.assertEqual(self.call("POST","/api/notes",b'{"content":"account b"}')[0],201)
        with self.db.connect() as db: self.assertEqual([row[0] for row in db.execute("SELECT content FROM events")],["account a"])
        with desktop.DATABASE.connect() as db: self.assertEqual([row[0] for row in db.execute("SELECT content FROM events")],["account b"])
        previous=desktop.DATABASE
        self.profiles.paths["broken"]=self.root / "broken.db"; self.profiles.paths["broken"].write_bytes(b"not sqlite")
        self.assertEqual(self.call("POST","/api/profiles/activate",b'{"profile_id":"broken"}')[0],500)
        self.assertIs(desktop.DATABASE,previous)
        self.assertEqual(self.profiles.active,"b")

    def test_timeout_returns_bounded_gateway_error_without_corrupting_data(self):
        with patch.object(self.db,"stats",side_effect=TimeoutError("upstream detail")):
            self.assertEqual(self.call("GET","/api/status")[0],504)
        self.assertEqual(self.call("GET","/api/status")[0],200)

    def test_disconnected_response_does_not_block_later_requests_or_log_secrets(self):
        with patch.object(self.db,"stats",side_effect=RuntimeError("private-secret-marker")):
            with self.assertLogs("anime_handbook",level="ERROR") as output:
                status,body,_=self.call("GET","/api/status")
            self.assertEqual(status,500)
            self.assertNotIn(b"private-secret-marker",body)
            self.assertNotIn("private-secret-marker"," ".join(output.output))
        connection=socket.create_connection(("127.0.0.1",self.server.server_port))
        connection.sendall(b"GET /styles.css HTTP/1.0\r\n\r\n"); connection.close()
        self.assertEqual(self.call("GET","/api/health")[0],200)


class DataLoadTest(unittest.TestCase):
    def test_large_collection_timeline_and_cover_query(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); db=database.HandbookDB(root / "large.db",asset_root=root)
            with db.connect() as connection:
                connection.executemany("INSERT INTO anime(id,name,collection_type,created_at,updated_at) VALUES(?,?,1,?,?)",[(i,f"anime {i}","2026-01-01","2026-01-01") for i in range(1,10001)])
                connection.executemany("INSERT INTO events(event_type,anime_id,content,created_at,theme,themes) VALUES('note',?,?,?,'other','[\"other\"]')",[(i%10000+1,f"event {i}",f"2026-{i%12+1:02}-{i%28+1:02}T12:00:00+08:00") for i in range(50000)])
            started=time.perf_counter(); stats=db.stats(); page=db.timeline_page(limit=30)
            self.assertEqual(stats["anime_total"],10000)
            self.assertTrue(page["has_more"])
            self.assertLess(time.perf_counter()-started,12,"10k anime/50k events regression")
            with patch.object(db,"_anime_from_row",side_effect=AssertionError("full metadata decoded")):
                self.assertEqual(db.cover_info(1)["id"],1)

    def test_restore_waits_for_all_instances_and_never_replaces_the_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); live=database.HandbookDB(root / "live.db",asset_root=root)
            peer=database.HandbookDB(live.path,asset_root=root)
            source=database.HandbookDB(root / "source.db",asset_root=root)
            live.add_note("old"); source.add_note("new")
            old_inode=live.path.stat().st_ino; old_revision=peer.revision
            entered,release,restored=threading.Event(),threading.Event(),threading.Event()
            def reader():
                with peer.connect() as connection:
                    connection.execute("SELECT content FROM events").fetchall()
                    entered.set(); release.wait(3)
            def restore(): live.import_snapshot(source.path); restored.set()
            with ThreadPoolExecutor(max_workers=2) as pool:
                reading=pool.submit(reader); self.assertTrue(entered.wait(2))
                restoring=pool.submit(restore); self.assertFalse(restored.wait(.08))
                release.set(); reading.result(); restoring.result(timeout=5)
            self.assertEqual(live.path.stat().st_ino,old_inode)
            self.assertGreater(peer.revision,old_revision)
            with peer.connect() as connection:self.assertEqual(connection.execute("SELECT content FROM events").fetchone()[0],"new")
            bad=root / "bad.db"; bad.write_bytes(b"broken snapshot")
            with self.assertRaises((ValueError,sqlite3.DatabaseError)):live.import_snapshot(bad)
            with peer.connect() as connection:self.assertEqual(connection.execute("SELECT content FROM events").fetchone()[0],"new")
            self.assertTrue(list((root / "backups").glob("*-before-snapshot-*.db")))

    def test_upstream_timeout_retry_is_bounded_and_can_recover(self):
        from unittest.mock import MagicMock
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); db=database.HandbookDB(root / "retry.db",asset_root=root)
            sync=metadata.SyncService(db)
            reply=MagicMock(); reply.__enter__.return_value.read.return_value=b'{"ok":true}'
            with patch.object(metadata.urllib.request,"urlopen",side_effect=[TimeoutError(),TimeoutError(),reply]) as request, patch.object(metadata.time,"sleep"), patch.object(sync,"_wait_for_episode_request_slot"):
                self.assertTrue(sync._fetch_bgm_json("https://example.invalid/test",timeout=.1,attempts=3)["ok"])
                self.assertEqual(request.call_count,3)
            with patch.object(metadata.urllib.request,"urlopen",side_effect=TimeoutError()) as request, patch.object(metadata.time,"sleep"), patch.object(sync,"_wait_for_episode_request_slot"):
                with self.assertRaises(TimeoutError):sync._fetch_bgm_json("https://example.invalid/test",timeout=.1,attempts=2)
                self.assertEqual(request.call_count,2)

    def test_settings_validation_is_pure_and_does_not_modify_input(self):
        settings={"sidebar_visibility":{"collection":False},"schedule_card_fields":{"tags":False}}
        body={"sidebar_visibility":{"schedule":False},"schedule_card_fields":{"votes":False}}
        before=json.dumps(settings,sort_keys=True)
        normalized,_,_=normalize_settings(body,settings)
        self.assertEqual(json.dumps(settings,sort_keys=True),before)
        self.assertFalse(normalized["schedule_card_fields"]["tags"])
        with self.assertRaises(ValueError):normalize_settings({"schedule_grouping":{"mode":"bad"}},settings)


if __name__ == "__main__":unittest.main()
