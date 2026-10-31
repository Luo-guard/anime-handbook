"""Account-local collection edits and durable Kazumi outbox."""
import json
from .common import now_iso


def save_collection(database, subject, status):
    if type(status) is not int or status not in range(1, 6):
        raise ValueError("收藏状态无效")
    if subject.get("type") != 2 or not subject.get("id"):
        raise ValueError("只能收藏 Bangumi 动画条目")
    stamp = now_iso()
    with database._write_lock, database.connect() as db:
        old = db.execute("SELECT collection_type FROM anime WHERE id=?", (subject["id"],)).fetchone()
        db.execute("""INSERT INTO anime(id,name,name_cn,summary,air_date,image_url,collection_type,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET collection_type=excluded.collection_type,active=1,updated_at=excluded.updated_at""",
            (subject["id"], subject.get("name", ""), subject.get("name_cn", ""), subject.get("summary", ""), subject.get("date", ""),
             (subject.get("images") or {}).get("large", ""), status, stamp, stamp))
        db.execute("""INSERT INTO kazumi_outbox(anime_id,status,baseline,subject,revision) VALUES(?,?,?,?,?)
            ON CONFLICT(anime_id) DO UPDATE SET status=excluded.status,subject=excluded.subject,revision=excluded.revision,error=''""",
            (subject["id"], status, old["collection_type"] if old else None, json.dumps(subject, ensure_ascii=False), stamp))
    return database.get_anime(subject["id"])
