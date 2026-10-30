import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from datetime import datetime
from schedule import ScheduleService, BEIJING


class SourceTests(unittest.TestCase):
    def test_independent_cache_and_explicit_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            service = ScheduleService(Path(directory))
            kazumi = service.for_source("kazumi")
            self.assertIs(service.for_source("yuc"), service)
            self.assertIs(kazumi, service.for_source("kazumi"))
            with self.assertRaises(ValueError):
                service.for_source("invalid")
            now = datetime.now(BEIJING)
            season = f"{now.year}{((now.month - 1) // 3) * 3 + 1:02d}"
            document = [{"weekday": {"id": 1}, "items": [{"id": 123, "name": "Test", "rating": {"score": 7, "total": 10}}]}]
            with patch.object(kazumi, "fetch", return_value=json.dumps(document).encode()):
                kazumi._refresh(season)
            row = kazumi.load(season)["items"][0]
            self.assertEqual(row["key"], "bgm-123")
            self.assertEqual(row["time"], "")
            self.assertEqual(row["weekday"], 1)
            self.assertIsNone(service.load(season))
            with patch.object(kazumi, "fetch", side_effect=OSError("offline")):
                kazumi._refresh(season)
            self.assertEqual(kazumi.load(season)["items"][0]["id"], 123)
            self.assertIn(season, kazumi.errors)
