"""Public Bangumi snapshots plus fictional viewing records, isolated from real users."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path

ASSETS = Path(__file__).parent / "demo_assets"


def prepare_demo(runtime, user):
    if user.get("role") != "guest":
        raise ValueError("演示内容只能写入游客账号")
    service = runtime.services(user)
    db = service.database
    catalog = json.loads((ASSETS / "catalog.json").read_text("utf-8"))
    if not catalog:
        raise ValueError("缺少演示番剧资料")
    # The regular image pipeline can read these cached public cover snapshots.
    for row in catalog:
        url = row["image_url"]
        target = runtime.covers / hashlib.sha256(url.encode()).hexdigest()
        if not target.exists():
            target.write_bytes(b"image/jpeg\n" + (ASSETS / f"{row['id']}.jpg").read_bytes())
    with db.connect() as connection:
        ready = connection.execute("SELECT value FROM settings WHERE key='online_demo_version'").fetchone()
    if ready and json.loads(ready[0]) == 1:
        return
    # Only this reserved demo identity is reset if an earlier seed was interrupted.
    with db.connect() as connection:
        for table in ("ranking_items", "ranking_tiers", "ranking_boards", "events"):
            connection.execute(f"DELETE FROM {table}")
    db.import_kazumi([{"id": row["id"], "name": row["name"], "name_cn": row["name_cn"] or row["name"],
                      "type": [1, 1, 2, 4, 3, 5][i], "air_date": row["date"],
                      "image_url": row["image_url"],
                      "summary": row["summary"]} for i, row in enumerate(catalog)])
    now = datetime.now(timezone(timedelta(hours=8)))
    for i, row in enumerate(catalog):
        rating = row.get("rating") or {}
        count = max(1, int(row.get("eps") or 12))
        db.update_bgm_metadata(row["id"], episode_count=count, rating_score=rating.get("score"),
                               rating_total=rating.get("total"), rating_rank=rating.get("rank"), rating_synced=True)
        if i in (0, 1, 3, 4):
            anime = db.get_anime(row["id"])
            for index, ep in enumerate(anime["episodes"][:min(6, count)]):
                service.record_progress(row["id"], {"base_episode_keys": [], "episode_keys": [ep["key"]],
                    "watched_at": (now - timedelta(days=8-index, hours=i)).isoformat()})
    db.add_note("【演示记录】喜欢这一段对日常细节的刻画，想把这份感受留在手账里。", catalog[0]["id"])
    db.add_note("【演示记录】周末留一点时间追番。这里的观看进度、感想和排名均为虚构示例，不是任何用户的私人数据。")
    board = db.create_ranking_board("我的心头好 · 演示排名")
    ids = [row["id"] for row in catalog]
    db.import_ranking_items(board["id"], ids)
    for i, sid in enumerate(ids):
        db.move_ranking_item(board["id"], sid, board["tiers"][min(i // 2, 4)]["id"], [sid])
    db.set_setting("online_demo_version", 1)
    service.changed()
