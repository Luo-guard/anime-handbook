"""离线下载的本地记录。

两层结构：
``local_media`` 是「一个 BT 任务」，合集种子一个任务能产出十几集；
``local_files`` 是「一集一个成品文件」，网页播放和续播进度都记在这一层。

这样设计是为了让「下了个 S1-S4 全套」和「下了单集」走同一套代码：前者入库后
在 local_files 里留下十几行，后者只留一行，界面看到的都是「哪几集能播」。
"""
from __future__ import annotations

from typing import Any

from .common import now_iso

STATUSES = ("queued", "downloading", "processing", "ready", "failed", "missing")
ACTIVE_STATUSES = ("queued", "downloading", "processing")

# 允许外部改写的列，白名单式收口，避免拼接列名时被注入。
_JOB_FIELDS = {
    "episode_key",
    "status",
    "torrent_hash",
    "torrent_name",
    "source_title",
    "group_name",
    "resolution",
    "codec",
    "progress",
    "save_path",
    "error",
    "archive_retries",
}
_FILE_FIELDS = {
    "media_id",
    "file_path",
    "file_size",
    "duration_ms",
    "resume_ms",
    "subtitle_path",
}


def _row(row: Any) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def _check_status(status: str) -> str:
    value = str(status or "").strip()
    if value not in STATUSES:
        raise ValueError(f"未知的下载状态：{status}")
    return value


class OfflineStore:
    def __init__(self, db: Any) -> None:
        self.db = db

    # ---- 任务层 -------------------------------------------------------

    def create_job(
        self,
        *,
        anime_id: int,
        torrent_hash: str = "",
        torrent_name: str = "",
        source_title: str = "",
        episode_key: str = "",
        group_name: str = "",
        resolution: str = "",
        codec: str = "",
        save_path: str = "",
        status: str = "queued",
    ) -> dict[str, Any]:
        """登记一个下载任务。

        同一个 infohash 只允许一条记录：用户重复点下载时更新已有的那条，
        而不是在任务列表里叠出两个一模一样的任务。
        """
        _check_status(status)
        existing = self.job_by_hash(torrent_hash) if torrent_hash else None
        if existing:
            merged = self.update_job(
                existing["id"],
                torrent_name=torrent_name or existing["torrent_name"],
                source_title=source_title or existing["source_title"],
                group_name=group_name or existing["group_name"],
                resolution=resolution or existing["resolution"],
                codec=codec or existing["codec"],
                save_path=save_path or existing["save_path"],
                episode_key=episode_key or existing["episode_key"],
            )
            return merged or existing
        stamp = now_iso()
        with self.db.connect() as db:
            cursor = db.execute(
                "INSERT INTO local_media (anime_id, episode_key, status, torrent_hash, torrent_name,"
                " source_title, group_name, resolution, codec, progress, save_path, error,"
                " created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,0,?,'',?,?)",
                (
                    int(anime_id),
                    str(episode_key or ""),
                    status,
                    str(torrent_hash or ""),
                    str(torrent_name or ""),
                    str(source_title or ""),
                    str(group_name or ""),
                    str(resolution or ""),
                    str(codec or ""),
                    str(save_path or ""),
                    stamp,
                    stamp,
                ),
            )
            media_id = int(cursor.lastrowid)
        return self.job(media_id) or {}

    def update_job(self, media_id: int, **fields: Any) -> dict[str, Any] | None:
        payload = {key: value for key, value in fields.items() if key in _JOB_FIELDS}
        if "status" in payload:
            _check_status(payload["status"])
        if not payload:
            return self.job(media_id)
        payload["updated_at"] = now_iso()
        assignments = ", ".join(f"{key} = ?" for key in payload)
        with self.db.connect() as db:
            db.execute(
                f"UPDATE local_media SET {assignments} WHERE id = ?",
                (*payload.values(), int(media_id)),
            )
        return self.job(media_id)

    def set_status(
        self,
        media_id: int,
        status: str,
        *,
        error: str | None = None,
        progress: float | None = None,
        archive_retries: int | None = None,
    ) -> dict[str, Any] | None:
        fields: dict[str, Any] = {"status": _check_status(status)}
        if error is not None:
            fields["error"] = str(error)
        if progress is not None:
            fields["progress"] = max(0.0, min(100.0, float(progress)))
        if archive_retries is not None:
            fields["archive_retries"] = max(0, int(archive_retries))
        return self.update_job(media_id, **fields)

    def job(self, media_id: int) -> dict[str, Any] | None:
        with self.db.connect() as db:
            return _row(db.execute("SELECT * FROM local_media WHERE id = ?", (int(media_id),)).fetchone())

    def job_by_hash(self, torrent_hash: str) -> dict[str, Any] | None:
        value = str(torrent_hash or "").strip().lower()
        if not value:
            return None
        with self.db.connect() as db:
            return _row(
                db.execute(
                    "SELECT * FROM local_media WHERE lower(torrent_hash) = ? LIMIT 1", (value,)
                ).fetchone()
            )

    def jobs_for_anime(self, anime_id: int) -> list[dict[str, Any]]:
        with self.db.connect() as db:
            rows = db.execute(
                "SELECT * FROM local_media WHERE anime_id = ? ORDER BY id DESC", (int(anime_id),)
            ).fetchall()
        return [dict(row) for row in rows]

    def active_jobs(self) -> list[dict[str, Any]]:
        marks = ",".join("?" for _ in ACTIVE_STATUSES)
        with self.db.connect() as db:
            rows = db.execute(
                f"SELECT * FROM local_media WHERE status IN ({marks}) ORDER BY id", (*ACTIVE_STATUSES,)
            ).fetchall()
        return [dict(row) for row in rows]

    def jobs_for_sync(self) -> list[dict[str, Any]]:
        """后台心跳要推进的全部任务：活动中的 + 还在自动重试窗口里的归档失败。"""
        marks = ",".join("?" for _ in ACTIVE_STATUSES)
        with self.db.connect() as db:
            rows = db.execute(
                f"SELECT * FROM local_media WHERE status IN ({marks})"
                " OR (status = 'failed' AND error LIKE '归档失败%') ORDER BY id",
                (*ACTIVE_STATUSES,),
            ).fetchall()
        return [dict(row) for row in rows]

    def delete_job(self, media_id: int) -> bool:
        with self.db.connect() as db:
            cursor = db.execute("DELETE FROM local_media WHERE id = ?", (int(media_id),))
        return cursor.rowcount > 0

    # ---- 文件层 -------------------------------------------------------

    def replace_file(
        self,
        *,
        anime_id: int,
        episode_key: str,
        file_path: str,
        file_size: int = 0,
        duration_ms: int = 0,
        media_id: int = 0,
        subtitle_path: str = "",
    ) -> dict[str, Any]:
        """写入或替换一集的成品文件；换源时替换而不是叠加。"""
        key = str(episode_key or "").strip()
        if not key:
            raise ValueError("缺少集数标识")
        stamp = now_iso()
        with self.db.connect() as db:
            db.execute(
                "INSERT INTO local_files (media_id, anime_id, episode_key, file_path, file_size,"
                " duration_ms, resume_ms, subtitle_path, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,0,?,?,?)"
                " ON CONFLICT(anime_id, episode_key) DO UPDATE SET"
                " media_id = excluded.media_id, file_path = excluded.file_path,"
                " file_size = excluded.file_size, duration_ms = excluded.duration_ms,"
                " subtitle_path = excluded.subtitle_path, updated_at = excluded.updated_at",
                (
                    int(media_id),
                    int(anime_id),
                    key,
                    str(file_path or ""),
                    int(file_size or 0),
                    int(duration_ms or 0),
                    str(subtitle_path or ""),
                    stamp,
                    stamp,
                ),
            )
        return self.file_for(anime_id, key) or {}

    def file_for(self, anime_id: int, episode_key: str) -> dict[str, Any] | None:
        with self.db.connect() as db:
            return _row(
                db.execute(
                    "SELECT * FROM local_files WHERE anime_id = ? AND episode_key = ?",
                    (int(anime_id), str(episode_key or "")),
                ).fetchone()
            )

    def file(self, file_id: int) -> dict[str, Any] | None:
        with self.db.connect() as db:
            return _row(db.execute("SELECT * FROM local_files WHERE id = ?", (int(file_id),)).fetchone())

    def files_for_anime(self, anime_id: int) -> list[dict[str, Any]]:
        with self.db.connect() as db:
            rows = db.execute(
                "SELECT * FROM local_files WHERE anime_id = ? ORDER BY episode_key", (int(anime_id),)
            ).fetchall()
        return [dict(row) for row in rows]

    def all_files(self) -> list[dict[str, Any]]:
        with self.db.connect() as db:
            rows = db.execute("SELECT * FROM local_files ORDER BY anime_id, episode_key").fetchall()
        return [dict(row) for row in rows]

    def set_resume(self, anime_id: int, episode_key: str, resume_ms: int) -> None:
        with self.db.connect() as db:
            db.execute(
                "UPDATE local_files SET resume_ms = ?, updated_at = ?"
                " WHERE anime_id = ? AND episode_key = ?",
                (max(0, int(resume_ms)), now_iso(), int(anime_id), str(episode_key or "")),
            )

    def delete_file(self, anime_id: int, episode_key: str) -> bool:
        with self.db.connect() as db:
            cursor = db.execute(
                "DELETE FROM local_files WHERE anime_id = ? AND episode_key = ?",
                (int(anime_id), str(episode_key or "")),
            )
        return cursor.rowcount > 0


    # ---- 订阅 ---------------------------------------------------------

    def add_subscription(
        self,
        *,
        anime_id: int,
        keyword: str,
        group_name: str = "",
        enabled: bool = True,
    ) -> dict[str, Any]:
        key = " ".join(str(keyword or "").split())
        if not key:
            raise ValueError("订阅关键词不能为空")
        stamp = now_iso()
        with self.db.connect() as db:
            db.execute(
                "INSERT INTO local_subscriptions (anime_id, keyword, group_name, enabled,"
                " last_checked, last_torrent, created_at, updated_at)"
                " VALUES (?,?,?,?,'','',?,?)"
                " ON CONFLICT(anime_id, keyword, group_name) DO UPDATE SET"
                " enabled = excluded.enabled, updated_at = excluded.updated_at",
                (int(anime_id), key, str(group_name or ""), 1 if enabled else 0, stamp, stamp),
            )
        with self.db.connect() as db:
            row = db.execute(
                "SELECT * FROM local_subscriptions WHERE anime_id = ? AND keyword = ? AND group_name = ?",
                (int(anime_id), key, str(group_name or "")),
            ).fetchone()
        return dict(row) if row else {}

    def subscriptions(self, anime_id: int | None = None) -> list[dict[str, Any]]:
        with self.db.connect() as db:
            if anime_id is None:
                rows = db.execute("SELECT * FROM local_subscriptions ORDER BY id DESC").fetchall()
            else:
                rows = db.execute(
                    "SELECT * FROM local_subscriptions WHERE anime_id = ? ORDER BY id DESC",
                    (int(anime_id),),
                ).fetchall()
        return [dict(row) for row in rows]

    def set_subscription_enabled(self, sub_id: int, enabled: bool) -> dict[str, Any] | None:
        with self.db.connect() as db:
            db.execute(
                "UPDATE local_subscriptions SET enabled = ?, updated_at = ? WHERE id = ?",
                (1 if enabled else 0, now_iso(), int(sub_id)),
            )
        with self.db.connect() as db:
            row = db.execute("SELECT * FROM local_subscriptions WHERE id = ?", (int(sub_id),)).fetchone()
        return dict(row) if row else None

    def touch_subscription(self, sub_id: int, *, last_checked: str, last_torrent: str = "") -> None:
        with self.db.connect() as db:
            db.execute(
                "UPDATE local_subscriptions SET last_checked = ?, last_torrent = ?, updated_at = ?"
                " WHERE id = ?",
                (str(last_checked), str(last_torrent), now_iso(), int(sub_id)),
            )

    def delete_subscription(self, sub_id: int) -> bool:
        with self.db.connect() as db:
            cursor = db.execute("DELETE FROM local_subscriptions WHERE id = ?", (int(sub_id),))
        return cursor.rowcount > 0

    # ---- 汇总 ---------------------------------------------------------

    def summary(self) -> dict[str, Any]:
        with self.db.connect() as db:
            rows = db.execute("SELECT status, COUNT(*) AS total FROM local_media GROUP BY status").fetchall()
            files = db.execute("SELECT COUNT(*) FROM local_files").fetchone()[0]
        counts = {status: 0 for status in STATUSES}
        for row in rows:
            status = str(row["status"])
            if status in counts:
                counts[status] = int(row["total"])
        counts["files"] = int(files or 0)
        return counts
