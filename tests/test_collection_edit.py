import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from handbook.database import HandbookDB
from handbook.collection import save_collection

class CollectionTests(unittest.TestCase):
    def test_add_edit_outbox_survives_import(self):
        with tempfile.TemporaryDirectory() as folder, patch("pathlib.Path.is_file", return_value=True):
            db=HandbookDB(Path(folder)/"test.db")
            subject={"id":123,"type":2,"name":"Test","name_cn":"测试"}
            save_collection(db,subject,2)
            save_collection(db,subject,1)
            db.import_kazumi([])
            self.assertEqual(db.get_anime(123)["collection_type"],1)
            self.assertEqual(len(db.list_anime()),1)
            with db.connect() as conn:
                rows=conn.execute("SELECT * FROM kazumi_outbox").fetchall()
            self.assertEqual(len(rows),1)
            self.assertIsNone(rows[0]["baseline"])
            self.assertEqual(rows[0]["status"],1)
            with self.assertRaises(ValueError):save_collection(db,subject,9)
            with self.assertRaises(ValueError):save_collection(db,{"id":2,"type":1},2)

    def test_worker_waits_and_preserves_failed_jobs(self):
        from handbook.kazumi_writeback import flush
        from unittest.mock import patch
        import subprocess
        with tempfile.TemporaryDirectory() as folder, patch("pathlib.Path.is_file", return_value=True):
            db=HandbookDB(Path(folder)/"test.db")
            save_collection(db,{"id":123,"type":2,"name":"Test"},2)
            source=Path(folder)/"collectibles.hive"
            with patch("handbook.kazumi_writeback.subprocess.run",return_value=subprocess.CompletedProcess([],0,b'"kazumi.exe"',b'')) as run:
                flush(db,source)
                self.assertEqual(run.call_count,1)
            with patch("handbook.kazumi_writeback.subprocess.run",side_effect=[subprocess.CompletedProcess([],0,b'',b''),subprocess.CompletedProcess([],2,b'',b'lock busy')]):
                with self.assertRaises(RuntimeError):flush(db,source)
            with db.connect() as conn:
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM kazumi_outbox").fetchone()[0],1)
            with patch("handbook.kazumi_writeback.subprocess.run",side_effect=[subprocess.CompletedProcess([],0,b'',b''),subprocess.CompletedProcess([],0,b'{"items":[{"id":123,"status":1}]}',b'')]):
                flush(db,source)
            self.assertEqual(db.get_anime(123)["collection_type"],1)
            with db.connect() as conn:self.assertEqual(conn.execute("SELECT COUNT(*) FROM kazumi_outbox").fetchone()[0],0)

    def test_http_add_search_and_outbox(self):
        from handbook.http import RequestHandler
        from handbook.metadata import SyncService
        from http.server import ThreadingHTTPServer
        from types import SimpleNamespace
        import threading, urllib.request
        with tempfile.TemporaryDirectory() as folder:
            database=HandbookDB(Path(folder)/"test.db")
            subject={"id":123,"type":2,"name":"Test","eps":12,"rating":{"score":7,"total":10}}
            class Handler(RequestHandler):
                services=SimpleNamespace(database=database,sync=SyncService(database))
                def require_write_access(self):pass
                def log_message(self,*args):pass
            server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            base=f"http://127.0.0.1:{server.server_port}"
            try:
                with patch.object(Handler.services.sync,"fetch_bgm",return_value=subject):
                    request=urllib.request.Request(base+"/api/collection-status",data=json.dumps({"anime_id":123,"status":2}).encode(),headers={"Content-Type":"application/json"})
                    response=json.load(urllib.request.urlopen(request))
                    self.assertEqual(response["anime"]["collection_type"],2)
                    self.assertEqual(response["anime"]["episode_count"],12)
                self.assertEqual(len(json.load(urllib.request.urlopen(base+"/api/collection-outbox"))["items"]),1)
                with patch("schedule.ScheduleService.fetch",return_value=json.dumps({"data":[subject]}).encode()):
                    self.assertEqual(json.load(urllib.request.urlopen(base+"/api/collection-search?q=test"))["items"][0]["id"],123)
            finally:
                server.shutdown();server.server_close();thread.join()
