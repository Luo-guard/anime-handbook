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
from .torrent_meta import TorrentMetaError, torrent_infohash, torrent_name
from .offline import OfflineStore
from .common import now_iso
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
CHECK_INTERVAL_SECONDS = 6 * 3600

# 归档失败的自动重试上限：文件晚就绪、qB 慢半拍这类临时问题几次内就能恢复；
# 真正坏掉的（文件缺失、名字认不出）重试再多次也没用，到顶后停下来等手动重试。
MAX_ARCHIVE_RETRIES = 5

# 后台心跳的间隔：下载进度 5 秒刷新一次足够顺滑，qB 的压力也可忽略。
WORKER_INTERVAL_SECONDS = 5.0

_ARCHIVING: set[int] = set()
_ARCHIVE_LOCK = threading.Lock()
_AUTO_CHECK_LOCK = threading.Lock()
_AUTO_CHECK_RUNNING = False


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
        # infohash 是种子自身的身份，先算出来；提交后用它认回任务最可靠。
        # 之前只按标签查，qB 刚 add 完还没注册完就会查不到，误报「没接住」。
        try:
            infohash = torrent_infohash(payload)
        except TorrentMetaError:
            infohash = ""
        display_name = torrent_name(payload) or str(title or "")
        tag = "hb" + uuid.uuid4().hex[:10]
        client = self.client(config)

        # 同一个种子已经在 qB 里时不要重复提交：qB 会直接回 "Fails."，
        # 之前把它当成失败，用户就会反复点、反复报错。
        existing = client.torrent(infohash) if infohash else None
        if existing:
            return self._register_job(
                anime_id=anime_id,
                task=existing,
                title=title,
                display_name=display_name,
                episode_key=episode_key,
                group_name=group_name,
                resolution=resolution,
                codec=codec,
                download_root=paths["download_root"],
                reused=True,
            )
        try:
            client.add_torrent(
                payload,
                f"{tag}.torrent",
                save_path=paths["download_root"],
                category=str(config.get("qb_category") or ""),
                tags=("handbook", tag),
                paused=False,
            )
        except QBError as error:
            # "Fails." 最常见的原因就是重复种子；再按 infohash 找一次，
            # 找得到就当复用，找不到才把原始错误交给用户。
            if infohash:
                existing = client.torrent(infohash)
                if existing:
                    return self._register_job(
                        anime_id=anime_id,
                        task=existing,
                        title=title,
                        display_name=display_name,
                        episode_key=episode_key,
                        group_name=group_name,
                        resolution=resolution,
                        codec=codec,
                        download_root=paths["download_root"],
                        reused=True,
                    )
            raise OfflineError(
                f"{error}（常见原因：下载器里已有一条相同任务，或保存目录不可写）"
            ) from error
        # qB 的 add 返回「Ok.」时任务可能还没进列表，短轮询等它出现。
        task: dict[str, Any] | None = None
        for _ in range(12):
            if infohash:
                task = client.torrent(infohash)
            if task:
                break
            found = client.torrents(tag=tag)
            if found:
                task = found[0]
                break
            time.sleep(0.2)
        if not task:
            raise OfflineError(
                "种子已经提交给 qBittorrent，但没能确认任务编号。"
                "请到 qB 里看一下是不是被合并进已有任务了，或稍后点一下刷新。"
            )
        return self._register_job(
            anime_id=anime_id,
            task=task,
            title=title,
            display_name=display_name,
            episode_key=episode_key,
            group_name=group_name,
            resolution=resolution,
            codec=codec,
            download_root=paths["download_root"],
            reused=False,
        )

    def _register_job(
        self,
        *,
        anime_id: int,
        task: dict[str, Any],
        title: str,
        display_name: str,
        episode_key: str,
        group_name: str,
        resolution: str,
        codec: str,
        download_root: str,
        reused: bool,
    ) -> dict[str, Any]:
        job = self.store.create_job(
            anime_id=int(anime_id),
            torrent_hash=str(task.get("hash") or ""),
            torrent_name=str(task.get("name") or display_name),
            source_title=str(title or ""),
            episode_key=str(episode_key or ""),
            group_name=str(group_name or ""),
            resolution=str(resolution or ""),
            codec=str(codec or ""),
            save_path=str(download_root),
        )
        if group_name:
            offline_config.remember_group(self.asset_root, anime_id, group_name)
        return {
            "ok": True,
            "job": job,
            "download_root": download_root,
            "reused": reused,
            "task_state": str(task.get("state") or ""),
        }

    # ---- 进度同步 -----------------------------------------------------

    def _sync(self, jobs: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
        """刷新任务状态，并顺手把「速度、剩余时间、qB 原始状态」带回去给界面。"""
        active = [job for job in jobs if job.get("status") in ("queued", "downloading", "processing")]
        live: dict[int, dict[str, Any]] = {}
        # 归档失败以前会让任务永远停在 failed，刷新也不再处理。给一个限频的自动重试，
        # 文件晚一点就绪、或 qB 当时还没写好 content_path 都能自己恢复；
        # 重试到上限就停，免得一个真坏掉的任务每 30 秒空转一次，按钮始终可用。
        for job in jobs:
            if (
                job.get("status") == "failed"
                and str(job.get("error") or "").startswith("归档失败")
                and _seconds_stale(job.get("updated_at") or "") > 30
            ):
                attempts = int(job.get("archive_retries") or 0)
                if attempts >= MAX_ARCHIVE_RETRIES:
                    continue
                self.store.set_status(
                    job["id"], "processing", error="", archive_retries=attempts + 1
                )
                self._schedule_archive(int(job["id"]))
        if not active:
            return live
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
            live[int(job["id"])] = {
                "dlspeed": int(task.get("dlspeed") or 0),
                "upspeed": int(task.get("upspeed") or 0),
                "eta": int(task.get("eta") or 0),
                "state": str(task.get("state") or ""),
                "seeds": int(task.get("num_seeds") or 0),
                "size": int(task.get("size") or 0),
            }
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
        return live

    def sync_all(self) -> None:
        """推进当前库里所有需要动的任务，不依赖前端正好停在哪一页。

        以前进度和归档只在有人打开/切换页签触发 ``state()`` 时才前进：
        页面不开着，下载下完了也没人去归档，失败的也不重试。
        后台心跳周期性调用这里， ``_sync`` 会顺带处理归档重试的调度。
        """
        self._sync(self.store.jobs_for_sync())

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
            self._mark_archive_failed(media_id, error)
        except Exception as error:  # noqa: BLE001 - 后台线程必须兜住一切，否则任务永远卡在 processing
            self._mark_archive_failed(media_id, error)
        finally:
            with _ARCHIVE_LOCK:
                _ARCHIVING.discard(media_id)

    def _mark_archive_failed(self, media_id: int, error: Exception) -> None:
        """记失败并把已自动重试的次数写进错误信息，界面上能看到还剩几次机会。"""
        job = self.store.job(media_id)
        attempts = int((job or {}).get("archive_retries") or 0)
        suffix = f"（自动重试 {attempts}/{MAX_ARCHIVE_RETRIES}）" if attempts else ""
        self.store.set_status(media_id, "failed", error=f"归档失败：{error}{suffix}")

    def _archive(self, media_id: int) -> None:
        job = self.store.job(media_id)
        if not job:
            return
        anime_id = int(job["anime_id"])
        done_rows = [
            row
            for row in self.store.files_for_anime(anime_id)
            if int(row.get("media_id") or 0) == media_id
        ]
        done_keys = {str(row["episode_key"]) for row in done_rows}
        # 只有已经整体标记为 ready 的任务才直接跳过，避免每次刷新都重新封装；
        # 部分入库的失败任务要继续跑，已入库的集数在下面的循环里按 key 跳过。
        if done_keys and job.get("status") == "ready":
            self.store.set_status(media_id, "ready", progress=100, error="")
            return
        config = self.config()
        paths = offline_config.ensure_dirs(config)
        if not paths["ok"]:
            raise OfflineError(str(paths.get("error") or "媒体库目录不可写"))
        torrent_hash = str(job.get("torrent_hash") or "")
        client = self.client(config)
        files: list[Any] = []
        # qB 报 100% 到文件真正落盘/重命名之间有一小段窗口，content_path 可能还没指向成品。
        # 后台线程里短轮询等它就绪，并确认大小稳定，避免读到半成品或误判成永久失败。
        for _attempt in range(10):
            try:
                task = client.torrent(torrent_hash) if torrent_hash else None
            except QBError:
                task = None
            exact = Path(str((task or {}).get("content_path") or ""))
            if exact.is_file():
                candidates = [exact] if exact.suffix.lower() in media_tools.VIDEO_SUFFIXES else []
            elif exact.is_dir():
                candidates = media_tools.video_files(exact)
            else:
                # 只能退回下载目录时，只取最近修改的一个，别把别的任务的文件一起归档。
                folder = str(
                    (task or {}).get("save_path")
                    or job.get("save_path")
                    or paths["download_root"]
                )
                found = media_tools.video_files(folder)
                candidates = sorted(
                    found, key=lambda item: item.stat().st_mtime, reverse=True
                )[:1] if found else []
            if candidates:
                before = [item.stat().st_size for item in candidates]
                time.sleep(1)
                after = [item.stat().st_size for item in candidates if item.exists()]
                if before == after and any(before):
                    files = candidates
                    break
            time.sleep(1)
        if not files:
            raise OfflineError("下载目录里没有找到视频文件，可能还没写完或已被移走")
        anime = self.db.get_anime(anime_id) or {}
        folder = media_tools.safe_name(
            anime.get("display_name") or anime.get("name_cn") or anime.get("name") or job.get("torrent_name")
        )
        target_dir = Path(paths["media_root"]) / folder
        target_dir.mkdir(parents=True, exist_ok=True)
        fallback_key = str(job.get("episode_key") or "")
        if not fallback_key:
            from_title = media_tools.episode_number(
                str(job.get("source_title") or job.get("torrent_name") or "")
            )
            if from_title > 0:
                fallback_key = media_tools.episode_key(from_title)
        made = 0
        already = 0
        fonts_done = False
        for source in files:
            number = media_tools.episode_number(source.name)
            # 单文件任务认不出集数时退回用户指定的集数；多文件任务必须能认出，
            # 否则硬塞给某一集只会把别的集覆盖掉。
            key = media_tools.episode_key(number) if number > 0 else (fallback_key if len(files) == 1 else "")
            if not key:
                continue
            if key in done_keys:
                # 重试时跳过已入库的集，不重复封装，也不把重试跑成全量返工。
                already += 1
                continue
            label = media_tools.episode_filename(number) if number > 0 else media_tools.safe_name(source.stem)
            try:
                info = media_tools.probe(source)
                result = media_tools.remux(source, target_dir / f"{label}.mp4", codec=info["codec"])
                subtitle = media_tools.extract_subtitle(source, target_dir / f"{label}.ass")
            except media_tools.MediaError:
                # 单个文件坏掉不该让整季任务失败，剩下的继续处理。
                continue
            # 同一个字幕组的合集里每集附件都一样，抽一次就够，别重复读十几遍原片。
            if not fonts_done:
                media_tools.extract_font_attachments(source, target_dir / "_fonts")
                fonts_done = True
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
        ingested = made + already
        if not ingested:
            raise OfflineError("这些文件名里认不出集数，请在下载器里改名后重试")
        if ingested < len(files):
            # 部分入库不能算完成：差着的集数用户看不到，还以为整季都在媒体库里。
            # 抛错走统一的失败记录（计入自动重试次数），已入库的集保持原样，
            # 重试时上面按 key 跳过，不会重复封装。
            raise OfflineError(
                f"只入库 {ingested}/{len(files)} 集，其余文件认不出集数或封装失败；"
                "会自动重试几次，也可以稍后手动重试"
            )
        self.store.set_status(media_id, "ready", progress=100, error="", archive_retries=0)
        if not config.get("seed_after_done"):
            # 不保留做种时，归档完就清掉原始文件，免得同一集占两份空间。
            try:
                client.delete([torrent_hash], delete_files=True)
            except QBError:
                pass

    def state(self, anime_id: int, *, refresh: bool = True) -> dict[str, Any]:
        jobs = self.store.jobs_for_anime(int(anime_id))
        live: dict[int, dict[str, Any]] = {}
        if refresh:
            live = self._sync(jobs)
            jobs = self.store.jobs_for_anime(int(anime_id))
        for job in jobs:
            job["live"] = live.get(int(job["id"]), {})
        self.maybe_auto_check()
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

    def maybe_auto_check(self) -> None:
        """在后台跑一次订阅检查；不阻塞当前请求。

        自动追番关着的时候什么都不做；同一条订阅 6 小时内只查一次，所以即使
        前端每隔几秒轮询一次状态，也不会真的反复联网。
        """
        if not self.config().get("auto_follow"):
            return
        global _AUTO_CHECK_RUNNING
        with _AUTO_CHECK_LOCK:
            if _AUTO_CHECK_RUNNING:
                return
            _AUTO_CHECK_RUNNING = True

        def worker() -> None:
            global _AUTO_CHECK_RUNNING
            try:
                self.check_subscriptions()
            except Exception:  # noqa: BLE001 - 后台线程不能把异常抛给无人接收的地方
                pass
            finally:
                with _AUTO_CHECK_LOCK:
                    _AUTO_CHECK_RUNNING = False

        threading.Thread(target=worker, name="handbook-offline-check", daemon=True).start()

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

    def retry_archive(self, media_id: int) -> dict[str, Any]:
        """手动重试一次归档，让已经卡在 failed 的任务立刻重新整理。

        手动介入说明用户动过什么（比如改了文件名），自动重试的计数清零，
        之后失败还能再享受一整轮自动重试。
        """
        job = self.store.job(int(media_id))
        if not job:
            raise OfflineError("下载记录不存在")
        self.store.set_status(int(media_id), "processing", error="", archive_retries=0)
        self._schedule_archive(int(media_id))
        return {"ok": True, "media_id": int(media_id)}

    def task_action(self, media_id: int, action: str) -> dict[str, Any]:
        """暂停或继续一个下载任务。"""
        job = self.store.job(int(media_id))
        if not job:
            raise OfflineError("下载记录不存在")
        torrent_hash = str(job.get("torrent_hash") or "")
        if not torrent_hash:
            raise OfflineError("这个任务没有对应的种子，无法操作")
        client = self.client()
        if action == "pause":
            client.pause([torrent_hash])
            self.store.set_status(int(media_id), "downloading", error="已暂停")
        elif action == "resume":
            client.resume([torrent_hash])
            self.store.set_status(int(media_id), "downloading", error="")
        else:
            raise ValueError("任务操作无效")
        return {"ok": True, "action": action}

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


    # ---- 自动追番 -----------------------------------------------------

    def subscribe(self, *, anime_id: int, keyword: str, group_name: str = "", enabled: bool = True) -> dict[str, Any]:
        sub = self.store.add_subscription(
            anime_id=int(anime_id), keyword=keyword, group_name=group_name, enabled=enabled
        )
        return {"ok": True, "subscription": sub}

    def unsubscribe(self, sub_id: int) -> dict[str, Any]:
        if not self.store.delete_subscription(int(sub_id)):
            raise OfflineError("订阅不存在")
        return {"ok": True}

    def subscriptions(self, anime_id: int | None = None) -> dict[str, Any]:
        return {"ok": True, "items": self.store.subscriptions(anime_id)}

    def check_subscriptions(self, *, force: bool = False) -> dict[str, Any]:
        """按订阅搜一遍，有更新的集就下最新一条。

        几条刻意的保守规则：
        1. 自动模式没开就不跑，只有手动「立即检查」能强制跑；
        2. 每条订阅最多 6 小时查一次，避免反复请求蜜柑；
        3. 第一次检查只记基准、不下载——否则刚订阅就会把旧集全灌进来；
        4. 一次只下最新一条，就算积压了十集也不会一口气塞满硬盘；
        5. 同一条种子下过就不再下（按 torrent id 比对）。
        """
        config = self.config()
        if not force and not config.get("auto_follow"):
            return {"ok": True, "skipped": True, "reason": "自动追番未开启", "checked": 0, "downloaded": 0, "items": []}
        subscriptions = self.store.subscriptions()
        results: list[dict[str, Any]] = []
        downloaded = 0
        for sub in subscriptions:
            if not int(sub.get("enabled") or 0):
                continue
            last = str(sub.get("last_checked") or "")
            if not force and last and _seconds_stale(last) < CHECK_INTERVAL_SECONDS:
                continue
            entry = {"id": sub["id"], "keyword": sub["keyword"], "group": sub.get("group_name") or "", "status": "", "title": ""}
            try:
                found = mikan.search(
                    str(sub["keyword"]),
                    prefer=str(config.get("mikan_host") or ""),
                    limit=100,
                )
            except mikan.MikanError as error:
                entry["status"] = "error"
                entry["title"] = str(error)
                results.append(entry)
                continue
            predicate_group = str(sub.get("group_name") or "")
            candidates = [
                item
                for item in found["items"]
                if item.get("torrent_url")
                and (not predicate_group or item.get("group") == predicate_group)
                and str(item.get("id") or "") != str(sub.get("last_torrent") or "")
            ]
            candidates.sort(key=lambda item: str(item.get("published_at") or ""))
            if not last:
                # 首次检查：把当前最新一条记成基准，不下载。
                newest = candidates[-1] if candidates else None
                self.store.touch_subscription(
                    sub["id"],
                    last_checked=str((newest or {}).get("published_at") or now_iso()),
                    last_torrent=str((newest or {}).get("id") or ""),
                )
                entry["status"] = "baseline"
                entry["title"] = (newest or {}).get("title") or "还没有可记录的条目"
                results.append(entry)
                continue
            fresh = [item for item in candidates if str(item.get("published_at") or "") > last]
            if not fresh:
                self.store.touch_subscription(sub["id"], last_checked=now_iso(), last_torrent=str(sub.get("last_torrent") or ""))
                entry["status"] = "nothing"
                results.append(entry)
                continue
            target = fresh[-1]
            try:
                self.download(
                    anime_id=int(sub.get("anime_id") or 0),
                    torrent_url=str(target["torrent_url"]),
                    title=str(target.get("title") or ""),
                    episode_key="",
                    group_name=str(target.get("group") or predicate_group),
                    resolution=str(target.get("resolution") or ""),
                    codec=str(target.get("codec") or ""),
                )
                self.store.touch_subscription(
                    sub["id"],
                    last_checked=str(target.get("published_at") or now_iso()),
                    last_torrent=str(target.get("id") or ""),
                )
                entry["status"] = "downloaded"
                entry["title"] = str(target.get("title") or "")
                downloaded += 1
            except OfflineError as error:
                entry["status"] = "error"
                entry["title"] = str(error)
                # 失败也推进检查时间，否则前端轮询会反复重试同一条种子。
                self.store.touch_subscription(sub["id"], last_checked=now_iso())
            results.append(entry)
        return {
            "ok": True,
            "skipped": False,
            "checked": len(results),
            "downloaded": downloaded,
            "items": results,
        }

    # ---- 迁移媒体库 ---------------------------------------------------

    def migrate_media_root(self, target_root: str, *, delete_source: bool = False) -> dict[str, Any]:
        """把已入库的文件搬到新目录。

        刻意做成「先复制、校验大小、再切换指向」，全部成功才改配置；只要有一条
        失败就原地不动，避免数据库指向一堆没搬过去的路径。默认不删源文件——
        真要删是另一个明确的开关，不藏在默认行为里。
        """
        target_text = str(target_root or "").strip().replace("\\", "/").rstrip("/")
        if not target_text:
            raise OfflineError("请填写目标目录")
        config = self.config()
        current_text = offline_config.resolved(config)["media_root"].replace("\\", "/").rstrip("/")
        if target_text == current_text:
            raise OfflineError("目标目录和当前目录是同一个")
        current_path = Path(current_text)
        target_path = Path(target_text)
        try:
            target_path.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise OfflineError(f"无法创建目标目录：{error}") from error
        copied = 0
        failed: list[dict[str, str]] = []
        for row in self.store.all_files():
            source = Path(str(row.get("file_path") or ""))
            if not source.is_file():
                failed.append({"file": str(source), "reason": "源文件不存在"})
                continue
            try:
                relative = source.relative_to(current_path)
            except ValueError:
                # 文件本来就不在媒体库里（手动挪过），平铺到目标根目录。
                relative = Path(source.name)
            destination = target_path / relative
            try:
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
                if destination.stat().st_size != source.stat().st_size:
                    raise OfflineError("复制后大小不一致")
            except (OSError, OfflineError) as error:
                failed.append({"file": str(source), "reason": str(error)})
                continue
            subtitle_path = ""
            subtitle = Path(str(row.get("subtitle_path") or ""))
            if subtitle.is_file():
                try:
                    subtitle_relative = subtitle.relative_to(current_path)
                except ValueError:
                    subtitle_relative = Path(subtitle.name)
                subtitle_target = target_path / subtitle_relative
                try:
                    subtitle_target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(subtitle, subtitle_target)
                    subtitle_path = str(subtitle_target)
                except OSError:
                    subtitle_path = str(subtitle)
            self.store.replace_file(
                anime_id=int(row["anime_id"]),
                episode_key=str(row["episode_key"]),
                file_path=str(destination),
                file_size=int(row.get("file_size") or 0),
                duration_ms=int(row.get("duration_ms") or 0),
                media_id=int(row.get("media_id") or 0),
                subtitle_path=subtitle_path or str(row.get("subtitle_path") or ""),
            )
            copied += 1
            if delete_source:
                try:
                    source.unlink()
                except OSError:
                    pass
        switched = not failed
        if switched:
            config["media_root"] = target_text
            offline_config.save(self.asset_root, config)
        return {
            "ok": True,
            "copied": copied,
            "failed": failed,
            "target": target_text,
            "switched": switched,
            "deleted_source": delete_source,
        }

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


# ---- 后台心跳 ---------------------------------------------------------

_WORKER_LOCK = threading.Lock()
_WORKER_STOP: threading.Event | None = None


def start_background_worker(
    database_provider: Any,
    stop: threading.Event | None = None,
    *,
    interval: float = WORKER_INTERVAL_SECONDS,
) -> threading.Event:
    """启动全局下载心跳：不打开页面也持续推进下载进度、归档与自动重试。

    ``database_provider`` 在每次心跳时现取当前库——切换本地账号后，
    心跳自动跟着新账号走，不用重启。重复调用只启动一次；返回停止信号，
    进程退出时 set 它即可让线程收尾。
    """
    global _WORKER_STOP
    with _WORKER_LOCK:
        if _WORKER_STOP is not None:
            return _WORKER_STOP
        stop_event = stop or threading.Event()
        _WORKER_STOP = stop_event

    def loop() -> None:
        while not stop_event.wait(interval):
            try:
                OfflineService(database_provider()).sync_all()
            except Exception:  # noqa: BLE001 - 心跳线程不允许带异常退出
                pass

    threading.Thread(target=loop, name="handbook-offline-worker", daemon=True).start()
    return stop_event
