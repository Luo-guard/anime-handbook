"""离线下载的业务编排：搜索 → 提交 → 同步进度 → 删除。

这一层只做「把几个零件接起来」，不解析 HTML、不碰 UI。所有对外方法都返回
可以直接塞进 JSON 的结构，错误统一抛 ``OfflineError``，由 HTTP 层翻译成
中文提示。
"""
from __future__ import annotations

import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from . import media as media_tools
from . import mikan, offline_config
from .offline import OfflineStore
from .qbittorrent import QBError, Client, normalise_base


class OfflineError(RuntimeError):
    """离线功能里的可读错误；消息直接给用户看。"""


# qB 的状态名不少，这里只关心它对「进度」的意义。
_DONE_STATES = {
    "uploading",
    "stalledUP",
    "queuedUP",
    "pausedUP",
    "forcedUP",
    "checkingUP",
}
_ERROR_STATES = {"error", "missingFiles"}
_BUSY_STATES = {"moving", "checkingResumeData"}


def map_qb_state(state: str, progress: float) -> str:
    """把 qB 状态和进度折成手账自己的六种状态。"""
    name = str(state or "").strip()
    ratio = float(progress or 0)
    if name in _ERROR_STATES:
        return "failed"
    if ratio >= 0.999:
        # 到 100% 之后 qB 还会校验/做种，手账这边就算「下完了」，等归档。
        return "processing"
    if name in _BUSY_STATES:
        return "processing"
    if name in _DONE_STATES:
        return "downloading"
    return "downloading"


def _seconds_stale(iso_text: str) -> float:
    try:
        from datetime import datetime

        return max(0.0, time.time() - datetime.fromisoformat(str(iso_text)).timestamp())
    except (TypeError, ValueError):
        return 0.0


# 归档（remux）放在后台线程做：一季 12 集串行封装要几十秒，不能卡住 GET。
_ARCHIVING: set[int] = set()
_ARCHIVE_LOCK = threading.Lock()


class OfflineService:
    def __init__(self, db: Any) -> None:
        self.db = db
        self.asset_root = Path(db.asset_root)
        self.store = OfflineStore(db)

    # ---- 基础设施 -----------------------------------------------------

    def config(self) -> dict[str, Any]:
        return offline_config.load(self.asset_root)

    def client(self, config: dict[str, Any] | None = None) -> Client:
        current = config or self.config()
        return Client(normalise_base(str(current.get("qb_host") or ""), current.get("qb_port")))

    def paths(self) -> dict[str, Any]:
        config = self.config()
        return offline_config.ensure_dirs(config)

    # ---- 搜索 ---------------------------------------------------------

    def search(self, keyword: str, limit: int = 40, anime_id: int = 0) -> dict[str, Any]:
        config = self.config()
        try:
            result = mikan.search(
                keyword,
                prefer=str(config.get("mikan_host") or ""),
                limit=limit,
            )
        except mikan.MikanError as error:
            raise OfflineError(str(error)) from error
        if result["base"] != config.get("mikan_host"):
            # 记住这次能用的主机，下次省掉一次必然失败的尝试。
            config["mikan_host"] = result["base"]
            offline_config.save(self.asset_root, config)
        items = list(result["items"])
        preferred = str((config.get("last_group") or {}).get(str(anime_id)) or "")
        if preferred:
            # 上次给这部番选过的字幕组排前面，其余保持蜜柑原有顺序。
            items.sort(key=lambda item: 0 if item.get("group") == preferred else 1)
        return {
            "ok": True,
            "host": result["base"],
            "items": items,
            "truncated": result["truncated"],
            "preferred_group": preferred,
        }

    # ---- 提交下载 -----------------------------------------------------

    def download(
        self,
        *,
        anime_id: int,
        torrent_url: str,
        title: str,
        episode_key: str = "",
        group_name: str = "",
        resolution: str = "",
        codec: str = "",
    ) -> dict[str, Any]:
        config = self.config()
        paths = offline_config.ensure_dirs(config)
        if not paths["ok"]:
            raise OfflineError(str(paths.get("error") or "媒体库目录不可用"))
        try:
            payload = mikan.fetch_torrent(torrent_url)
        except mikan.MikanError as error:
            raise OfflineError(str(error)) from error
        # 每次任务打一个独有标签，提交后靠它把任务从 qB 里认回来，避免按名字猜。
        tag = "hb" + uuid.uuid4().hex[:10]
        client = self.client(config)
        try:
            client.add_torrent(
                payload,
                f"{tag}.torrent",
                save_path=paths["download_root"],
                category=str(config.get("qb_category") or ""),
                tags=("handbook", tag),
                paused=False,
            )
            found = client.torrents(tag=tag)
        except QBError as error:
            raise OfflineError(str(error)) from error
        if not found:
            raise OfflineError("qBittorrent 没有接住这个种子，请检查它是否在运行")
        task = found[0]
        job = self.store.create_job(
            anime_id=int(anime_id),
            torrent_hash=str(task.get("hash") or ""),
            torrent_name=str(task.get("name") or title),
            source_title=str(title or ""),
            episode_key=str(episode_key or ""),
            group_name=str(group_name or ""),
            resolution=str(resolution or ""),
            codec=str(codec or ""),
            save_path=str(paths["download_root"]),
        )
        if group_name:
            offline_config.remember_group(self.asset_root, anime_id, group_name)
        return {"ok": True, "job": job, "download_root": paths["download_root"]}

    # ---- 进度同步 -----------------------------------------------------

    def _sync(self, jobs: list[dict[str, Any]]) -> None:
        active = [job for job in jobs if job.get("status") in ("queued", "downloading", "processing")]
        if not active:
            return
        client = self.client()
        for job in active:
            torrent_hash = str(job.get("torrent_hash") or "")
            if not torrent_hash:
                continue
            try:
                task = client.torrent(torrent_hash)
            except QBError:
                # 下载器暂时不可用时不改状态，避免把「qB 关着」误判成「任务失败」。
                continue
            if task is None:
                self.store.set_status(
                    job["id"], "failed", error="qBittorrent 里找不到这个任务，可能被手动删除了"
                )
                continue
            progress = float(task.get("progress") or 0) * 100
            status = map_qb_state(str(task.get("state") or ""), task.get("progress") or 0)
            if status == "failed":
                message = "文件缺失，可能被移动或删除" if task.get("state") == "missingFiles" else "下载出错"
                self.store.set_status(job["id"], "failed", error=message, progress=progress)
                continue
            # 30 分钟没有任何进度就提示可能没人做种。
            if (
                status == "downloading"
                and progress <= 0.1
                and _seconds_stale(job.get("created_at") or "") > 1800
            ):
                self.store.set_status(
                    job["id"], "downloading", progress=progress, error="长时间没有速度，可能没人在做种"
                )
                continue
            self.store.set_status(job["id"], status, progress=progress, error="")
            if status == "processing":
                self._schedule_archive(int(job["id"]))

    # ---- 归档（remux + 抽字幕）-----------------------------------------

    def _schedule_archive(self, media_id: int) -> None:
        with _ARCHIVE_LOCK:
            if media_id in _ARCHIVING:
                return
            _ARCHIVING.add(media_id)
        threading.Thread(target=self._archive_job, args=(media_id,), daemon=True).start()

    def _archive_job(self, media_id: int) -> None:
        try:
            self._archive(media_id)
        except (OfflineError, media_tools.MediaError, QBError) as error:
            self.store.set_status(media_id, "failed", error=f"归档失败：{error}")
        except Exception as error:  # noqa: BLE001 - 后台线程必须兜住一切，否则任务永远卡在 processing
            self.store.set_status(media_id, "failed", error=f"归档失败：{error}")
        finally:
            with _ARCHIVE_LOCK:
                _ARCHIVING.discard(media_id)

    def _archive(self, media_id: int) -> None:
        job = self.store.job(media_id)
        if not job:
            return
        anime_id = int(job["anime_id"])
        # 已经录过成品就不要再跑一遍，避免每次刷新都重新封装。
        if any(int(row.get("media_id") or 0) == media_id for row in self.store.files_for_anime(anime_id)):
            self.store.set_status(media_id, "ready", progress=100, error="")
            return
        config = self.config()
        paths = offline_config.ensure_dirs(config)
        if not paths["ok"]:
            raise OfflineError(str(paths.get("error") or "媒体库目录不可写"))
        torrent_hash = str(job.get("torrent_hash") or "")
        task = self.client(config).torrent(torrent_hash) if torrent_hash else None
        content = str(
            (task or {}).get("content_path")
            or (task or {}).get("save_path")
            or job.get("save_path")
            or paths["download_root"]
        )
        files = media_tools.video_files(content)
        if not files:
            raise OfflineError("下载目录里没有找到视频文件，可能还没写完或已被移走")
        anime = self.db.get_anime(anime_id) or {}
        folder = media_tools.safe_name(
            anime.get("display_name") or anime.get("name_cn") or anime.get("name") or job.get("torrent_name")
        )
        target_dir = Path(paths["media_root"]) / folder
        target_dir.mkdir(parents=True, exist_ok=True)
        fallback_key = str(job.get("episode_key") or "")
        made = 0
        for source in files:
            number = media_tools.episode_number(source.name)
            # 单文件任务认不出集数时退回用户指定的集数；多文件任务必须能认出，
            # 否则硬塞给某一集只会把别的集覆盖掉。
            key = media_tools.episode_key(number) if number > 0 else (fallback_key if len(files) == 1 else "")
            if not key:
                continue
            label = media_tools.episode_filename(number) if number > 0 else media_tools.safe_name(source.stem)
            try:
                info = media_tools.probe(source)
                result = media_tools.remux(source, target_dir / f"{label}.mp4", codec=info["codec"])
                subtitle = media_tools.extract_subtitle(source, target_dir / f"{label}.ass")
            except media_tools.MediaError:
                # 单个文件坏掉不该让整季任务失败，剩下的继续处理。
                continue
            self.store.replace_file(
                anime_id=anime_id,
                episode_key=key,
                file_path=result["path"],
                file_size=result["size"],
                duration_ms=info["duration_ms"],
                media_id=media_id,
                subtitle_path=subtitle,
            )
            made += 1
        if not made:
            raise OfflineError("这些文件名里认不出集数，请在下载器里改名后重试")
        self.store.set_status(media_id, "ready", progress=100, error="")
        if not config.get("seed_after_done"):
            # 不保留做种时，归档完就清掉原始文件，免得同一集占两份空间。
            try:
                self.client(config).delete([torrent_hash], delete_files=True)
            except QBError:
                pass

    def state(self, anime_id: int, *, refresh: bool = True) -> dict[str, Any]:
        jobs = self.store.jobs_for_anime(int(anime_id))
        if refresh:
            self._sync(jobs)
            jobs = self.store.jobs_for_anime(int(anime_id))
        files = self.store.files_for_anime(int(anime_id))
        ready = {str(item.get("episode_key")) for item in files}
        return {
            "ok": True,
            "jobs": jobs,
            "files": files,
            "ready_episodes": sorted(ready),
            "counts": self.store.summary(),
            "paths": offline_config.resolved(self.config()),
        }

    # ---- 删除 ---------------------------------------------------------

    def _trash_path(self, media_root: str, source: Path) -> Path:
        """不直接删除，挪进媒体库里的回收站，留一条后悔路。"""
        target_dir = Path(media_root) / "_trash" / time.strftime("%Y%m%d-%H%M%S")
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / source.name
        counter = 1
        while target.exists():
            target = target_dir / f"{source.stem}-{counter}{source.suffix}"
            counter += 1
        return target

    def delete_episode_file(self, anime_id: int, episode_key: str) -> dict[str, Any]:
        row = self.store.file_for(int(anime_id), str(episode_key or ""))
        if not row:
            raise OfflineError("这一集没有本地文件")
        source = Path(str(row.get("file_path") or ""))
        moved = ""
        if source.is_file():
            config = self.config()
            media_root = offline_config.resolved(config)["media_root"]
            target = self._trash_path(media_root, source)
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(source), str(target))
                moved = str(target)
            except OSError as error:
                raise OfflineError(f"文件没能移入回收站：{error}") from error
        subtitle = Path(str(row.get("subtitle_path") or ""))
        if subtitle.is_file():
            try:
                subtitle.unlink()
            except OSError:
                pass
        self.store.delete_file(int(anime_id), str(episode_key))
        return {"ok": True, "moved_to": moved}

    def delete_job(self, media_id: int, *, delete_files: bool = False, keep_files: bool = True) -> dict[str, Any]:
        """从下载器移除任务。

        ``delete_files`` 为真时连下载下来的文件一起删；否则任务消失、文件留在盘上
        （qB 的「删除任务但保留文件」就是这个语义）。
        """
        job = self.store.job(int(media_id))
        if not job:
            raise OfflineError("下载记录不存在")
        torrent_hash = str(job.get("torrent_hash") or "")
        if torrent_hash:
            try:
                self.client().delete([torrent_hash], delete_files=delete_files)
            except QBError as error:
                # 任务已经不在 qB 里也照样清本地记录，否则会留一条删不掉的僵尸。
                if "找不到" not in str(error):
                    pass
        self.store.delete_job(int(media_id))
        return {"ok": True, "kept_files": not delete_files and keep_files}

    # ---- 汇总 ---------------------------------------------------------

    def summary(self) -> dict[str, Any]:
        config = self.config()
        paths = offline_config.resolved(config)
        writable = offline_config.ensure_dirs(config)
        alive = False
        version = ""
        try:
            client = self.client(config)
            version = client.version()
            alive = True
        except QBError:
            alive = False
        return {
            "ok": True,
            "counts": self.store.summary(),
            "paths": paths,
            "writable": writable.get("ok", False),
            "write_error": writable.get("error", ""),
            "qb_online": alive,
            "qb_version": version,
            "config": {key: config[key] for key in ("qb_host", "qb_port", "qb_category", "seed_after_done", "auto_follow")},
        }
