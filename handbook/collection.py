"""Account-local collection edits and durable Kazumi outbox."""
import json
from .common import now_iso


def _text(value):
    """Bangumi 会用 null 表示尚未定档的字段，数据库列是 NOT NULL，统一转成空串。"""
    return "" if value is None else str(value)


def save_collection(database, subject, status):
    if type(status) is not int or status not in range(1, 6):
        raise ValueError("收藏状态无效")
    if subject.get("type") != 2 or not subject.get("id"):
        raise ValueError("只能收藏 Bangumi 动画条目")
    stamp = now_iso()
    image = (subject.get("images") or {}).get("large") or ""
    with database._write_lock, database.connect() as db:
        old = db.execute("SELECT collection_type FROM anime WHERE id=?", (subject["id"],)).fetchone()
        db.execute(
            """INSERT INTO anime(id,name,name_cn,summary,air_date,image_url,collection_type,collection_added_at,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
                collection_type=excluded.collection_type,
                -- 收藏夹没变就不该刷新「加入时间」，否则每次改状态都会把
                -- 老条目顶到该收藏夹最前面。
                collection_added_at=CASE
                    WHEN anime.collection_type=excluded.collection_type
                        THEN COALESCE(NULLIF(anime.collection_added_at,''),excluded.collection_added_at)
                    ELSE excluded.collection_added_at END,
                active=1,updated_at=excluded.updated_at""",
            (subject["id"], _text(subject.get("name")), _text(subject.get("name_cn")), _text(subject.get("summary")),
             _text(subject.get("date")), _text(image), status, stamp, stamp, stamp))
        db.execute("""INSERT INTO kazumi_outbox(anime_id,status,baseline,subject,revision) VALUES(?,?,?,?,?)
            ON CONFLICT(anime_id) DO UPDATE SET status=excluded.status,subject=excluded.subject,revision=excluded.revision,error=''""",
            (subject["id"], status, old["collection_type"] if old else None, json.dumps(subject, ensure_ascii=False), stamp))
    return database.get_anime(subject["id"])
