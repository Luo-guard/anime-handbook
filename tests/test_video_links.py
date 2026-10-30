import tempfile
import unittest
from pathlib import Path
from handbook.database import HandbookDB
from handbook.video_links import VideoLinks, canonical_video_url

class VideoLinksTest(unittest.TestCase):
    def test_url_validation_and_page(self):
        self.assertEqual(canonical_video_url("https://www.bilibili.com/video/BV1NJHG6eE9z/?p=2&vd_source=tracking"), "https://www.bilibili.com/video/BV1NJHG6eE9z/?p=2")
        for url in ["javascript:alert(1)", "https://evil.test/video/BV1NJHG6eE9z/", "https://www.bilibili.com.evil.test/video/BV1NJHG6eE9z/", "https://www.bilibili.com/video/BV1NJHG6eE9z/?p=bad", "https://user@www.bilibili.com/video/BV1NJHG6eE9z/", "https://www.bilibili.com:443/video/BV1NJHG6eE9z/"]:
            with self.assertRaises(ValueError): canonical_video_url(url)

    def test_account_isolation_dedup_defaults_and_persistence(self):
        with tempfile.TemporaryDirectory() as temp:
            db=HandbookDB(Path(temp)/"one.db")
            with db.connect() as conn:
                conn.execute("INSERT INTO anime(id,name,collection_type,created_at,updated_at) VALUES(1,'first',1,'2026-10-29','2026-10-29'),(2,'second',1,'2026-10-29','2026-10-29')")
            store=VideoLinks(db)
            body={"scope":store.scope,"anime_id":1,"url":"https://www.bilibili.com/video/BV1NJHG6eE9z/","title":"<title>","note":"简体"}
            first=store.update(body)[0]
            self.assertEqual(first["is_default"],0)
            self.assertEqual(len(store.update({**body,"url":body["url"]+"?spm_id=abc"})),1)
            rows=store.update({**body,"url":body["url"]+"?p=2","make_default":True})
            self.assertEqual(len(rows),2)
            self.assertTrue(rows[0]["url"].endswith("?p=2"))
            cleared=store.update({"scope":store.scope,"anime_id":1,"id":rows[0]["id"],"action":"unset_default"})
            self.assertTrue(all(row["is_default"]==0 for row in cleared))
            self.assertTrue(all(row["is_default"]==0 for row in store.update({**body,"make_default":False})))
            self.assertEqual(store.list(2),[])
            with self.assertRaises(ValueError): store.update({**body,"scope":"wrong"})
            with self.assertRaises(ValueError): store.update({**body,"anime_id":999})
            with self.assertRaises(ValueError): store.update({"scope":store.scope,"anime_id":2,"id":first["id"],"action":"delete"})
            store.update({"scope":store.scope,"anime_id":1,"id":first["id"],"action":"default"})
            rows=store.update({"scope":store.scope,"anime_id":1,"id":first["id"],"action":"delete"})
            self.assertEqual(rows[0]["is_default"],0)
            self.assertEqual(len(VideoLinks(HandbookDB(db.path)).list(1)),1)
            self.assertEqual(VideoLinks(HandbookDB(Path(temp)/"two.db")).list(1),[])

    def test_http_routes_round_trip_and_scope_check(self):
        import json
        import threading
        import urllib.request
        import urllib.error
        from unittest.mock import patch
        from http.server import ThreadingHTTPServer
        from handbook import desktop, http
        with tempfile.TemporaryDirectory() as temp:
            db=HandbookDB(Path(temp)/"http.db")
            with db.connect() as conn:
                conn.execute("INSERT INTO anime(id,name,collection_type,created_at,updated_at) VALUES(1,'test',1,'2026-10-29','2026-10-29')")
            server=ThreadingHTTPServer(("127.0.0.1",0),http.RequestHandler)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            url=f"http://127.0.0.1:{server.server_port}/api/video-links"
            try:
                with patch.object(desktop,"DATABASE",db),patch.object(desktop,"require_active_profile_write_access"):
                    settings_url=url.replace("/video-links","/settings")
                    preference=urllib.request.Request(settings_url,data=json.dumps({"show_saved_video_list":False,"merge_bilibili_links":True,"keyboard_shortcuts":{"enabled":False,"bindings":{"collection":{"enabled":True,"key":"Alt+k"}}}}).encode(),method="PATCH",headers={"Content-Type":"application/json"})
                    self.assertFalse(json.load(urllib.request.urlopen(preference))["settings"]["show_saved_video_list"])
                    self.assertFalse(HandbookDB(db.path).get_settings()["show_saved_video_list"])
                    self.assertTrue(HandbookDB(db.path).get_settings()["merge_bilibili_links"])
                    self.assertFalse(HandbookDB(db.path).get_settings()["keyboard_shortcuts"]["enabled"])
                    catalog=json.load(urllib.request.urlopen(url))
                    self.assertEqual(catalog["animes"][0]["id"],1)
                    self.assertEqual(catalog["features"]["optional_video_default"],1)
                    body={"scope":catalog["scope"],"anime_id":1,"url":"https://www.bilibili.com/video/BV1NJHG6eE9z/?p=3","title":"test"}
                    request=urllib.request.Request(url,data=json.dumps(body).encode(),headers={"Content-Type":"application/json"})
                    self.assertEqual(len(json.load(urllib.request.urlopen(request))["items"]),1)
                    self.assertEqual(len(json.load(urllib.request.urlopen(url+"?anime_id=1"))["items"]),1)
                    saved=json.load(urllib.request.urlopen(url+"?anime_id=1"))["items"][0]
                    for action in ["default","unset_default"]:
                        command={"scope":catalog["scope"],"anime_id":1,"id":saved["id"],"action":action}
                        request=urllib.request.Request(url,data=json.dumps(command).encode(),headers={"Content-Type":"application/json"})
                        result=json.load(urllib.request.urlopen(request))
                        self.assertEqual(result["items"][0]["is_default"],int(action=="default"))
                    body["scope"]="wrong"
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(urllib.request.Request(url,data=json.dumps(body).encode(),headers={"Content-Type":"application/json"}))
                    self.assertEqual(error.exception.code,400)
            finally:
                server.shutdown();server.server_close();thread.join()
