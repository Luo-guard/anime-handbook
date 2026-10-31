"""Local-only outbox worker. Never force locks or terminate Kazumi."""
import json
import subprocess
import threading
from .common import APP_ROOT


def flush(database, source):
    writer = APP_ROOT / "tools" / "kazumi_writer.exe"
    if not writer.is_file():
        raise RuntimeError("Kazumi 写回工具未构建")
    if database.get_settings().get("kazumi_read_only"):
        return
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if hasattr(subprocess, "CREATE_NO_WINDOW") else {}
    processes = subprocess.run(["tasklist", "/FI", "IMAGENAME eq kazumi.exe", "/FO", "CSV", "/NH"], capture_output=True, timeout=10, **options)
    if processes.returncode or b'kazumi.exe' in processes.stdout.lower():
        return
    with database._write_lock, database.connect() as db:
        jobs = [dict(row) for row in db.execute("SELECT * FROM kazumi_outbox")]
        if not jobs:
            return
        result = subprocess.run([str(writer), str(source)], input=json.dumps({"jobs": jobs, "policy": database.get_settings().get("kazumi_conflict", "handbook")}).encode(), capture_output=True, timeout=45, **options)
        if result.returncode:
            raise RuntimeError("Kazumi 文件占用或写回失败，任务已保留：" + result.stderr.decode("utf-8", errors="replace")[-240:])
        for row in json.loads(result.stdout)["items"]:
            if row["status"] is None:
                db.execute("UPDATE anime SET active=0 WHERE id=?", (row["id"],))
            else:
                db.execute("UPDATE anime SET collection_type=? WHERE id=?", (row["status"], row["id"]))
            db.execute("DELETE FROM kazumi_outbox WHERE anime_id=?", (row["id"],))


def start_worker(stop):
    def run():
        from . import desktop
        while not stop.wait(5):
            database = desktop.DATABASE
            settings = database.get_settings()
            if settings.get("kazumi_read_only") or not settings.get("kazumi_writeback", True) or desktop.active_profile_write_issue(bind_unbound=False):
                continue
            if desktop.SYNC.status.get("running"):
                continue
            try:
                with desktop.SYNC._lock:
                    if database is not desktop.DATABASE:
                        continue
                    flush(database, desktop.SyncService.find_kazumi_database())
            except Exception as error:
                with database.connect() as db:
                    db.execute("UPDATE kazumi_outbox SET error=?", (str(error),))
    thread=threading.Thread(target=run, daemon=True)
    thread.start()
    return thread
