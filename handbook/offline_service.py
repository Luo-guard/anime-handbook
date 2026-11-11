"""离线下载的业务编排：搜索 → 提交 → 同步进度 → 删除。

这一层只做「把几个零件接起来」，不解析 HTML、不碰 UI。所有对外方法都返回
可以直接塞进 JSON 的结构，错误统一抛 ``OfflineError``，由 HTTP 层翻译成
中文提示。
"""
from __future__ import annotations

import os
import json
import shutil
import threading
import time
import uuid
from pathlib import Path
import re
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
# qB 4 叫 pausedDL，qB 5 改名成 stoppedDL（做种那边同理 pausedUP/stoppedUP）。
_PAUSED_STATES = {"pausedDL", "stoppedDL", "pausedUP", "stoppedUP"}


def is_paused_state(state: str) -> bool:
    """这个 qB 状态是不是「用户按了暂停」。

    以前暂停这件事是写进 ``error`` 字段传出去的（前端看 ``live.state`` 兜底），
    结果 ``error`` 语义被混用、下一次同步又被清空。现在单独判一次，走
    ``live.paused`` 明确传出去。
    """
    return str(state or "").strip() in _PAUSED_STATES


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


def _is_within(path: Path, root: Path) -> bool:
    """路径是否在 root 之下；Windows 下按不区分大小写比较。"""
    child = os.path.normcase(os.path.normpath(str(path)))
    parent = os.path.normcase(os.path.normpath(str(root)))
    return child == parent or child.startswith(parent + os.sep)


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


def _release_episode(item: dict[str, Any]) -> int:
    """条目对应第几集；标题里认不出来就是 0。

    判新不能只看发布时间：蜜柑有的镜像不给 pubDate（历史 bug 就是因此永远判不出
    新集），但标题里的集数一直都有，所以以「集数是否超过已有最大集」为主判据。
    """
    try:
        return int(media_tools.episode_number(str(item.get("title") or "")))
    except (TypeError, ValueError):
        return 0


def _release_order(item: dict[str, Any]) -> tuple[int, str]:
    """「更新」程度：先比集数，集数相同再比发布时间。"""
    return (_release_episode(item), str(item.get("published_at") or ""))


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
            # 记住这次能用的主机，下次省掉一次必然失败的尝试。只写这一个键：
            # 整份写回会把同时发生的字幕组记忆或设置页保存覆盖掉。
            config["mikan_host"] = result["base"]
            offline_config.patch(self.asset_root, mikan_host=result["base"])
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
                "paused": is_paused_state(task.get("state") or ""),
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
        """记失败，并把「还剩几次自动重试 / 已经停止」写进错误信息。

        提示必须能指导下一步：还在重试窗口里就说明会自动再试；到了上限就
        明确说自动重试已停、要用户处理什么之后点「重试归档」。
        """
        job = self.store.job(media_id)
        attempts = int((job or {}).get("archive_retries") or 0)
        if attempts >= MAX_ARCHIVE_RETRIES:
            suffix = (
                f"（已自动重试 {MAX_ARCHIVE_RETRIES} 次仍未成功，自动重试已停止："
                "按上面的提示处理后点「重试归档」）"
            )
        elif attempts:
            suffix = f"（已自动重试 {attempts}/{MAX_ARCHIVE_RETRIES}，稍后还会自动再试）"
        else:
            suffix = "（点「重试归档」可以立即再试一次）"
        self.store.set_status(media_id, "failed", error=f"归档失败：{error}{suffix}")

    def _resolve_files(
        self, task: dict[str, Any] | None, job: dict[str, Any], download_root: str
    ) -> list[Path]:
        """定位这个任务落地的视频文件。

        ``content_path`` 没就绪时，**只**按种子名去下载目录里找同名文件/文件夹。
        旧逻辑是「取下载目录里 mtime 最新的那个视频」，同时下两部番时会抓到
        另一部番的成品，然后被 remux 进当前番的目录、按当前番的集数命名 ——
        宁可报错让人处理，也不能把内容写到错误的位置。
        """
        exact = Path(str((task or {}).get("content_path") or ""))
        if exact.is_file():
            return [exact] if exact.suffix.lower() in media_tools.VIDEO_SUFFIXES else []
        if exact.is_dir():
            return media_tools.video_files(exact)
        folder = Path(
            str((task or {}).get("save_path") or job.get("save_path") or download_root)
        )
        name = str((task or {}).get("name") or job.get("torrent_name") or "").strip()
        if not name:
            return []
        target = folder / name
        if target.is_file():
            return [target] if target.suffix.lower() in media_tools.VIDEO_SUFFIXES else []
        if target.is_dir():
            return media_tools.video_files(target)
        return []

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
            candidates = self._resolve_files(task, job, paths["download_root"])
            if candidates:
                before = [item.stat().st_size for item in candidates]
                time.sleep(1)
                after = [item.stat().st_size for item in candidates if item.exists()]
                if before == after and any(before):
                    files = candidates
                    break
            time.sleep(1)
        if not files:
            raise OfflineError(
                "下载目录里没有找到这个任务的视频文件：确认 qBittorrent 里这个任务已完成、"
                "文件还在下载目录（被移走或改名过就放回原处），再点「重试归档」"
            )
        anime = self.db.get_anime(anime_id) or {}
        folder = media_tools.safe_name(
            anime.get("display_name") or anime.get("name_cn") or anime.get("name") or job.get("torrent_name")
        )
        target_dir = Path(paths["media_root"]) / folder
        target_dir.mkdir(parents=True, exist_ok=True)
        # 用户明确指定的集数是权威信息，只对单文件任务生效（多文件任务一个 key
        # 会把整季都写到同一集上）。
        explicit_key = str(job.get("episode_key") or "").strip()
        title_key = ""
        if not explicit_key:
            from_title = media_tools.episode_number(
                str(job.get("source_title") or job.get("torrent_name") or "")
            )
            if from_title > 0:
                title_key = media_tools.episode_key(from_title)
        made = 0
        already = 0
        broken = 0
        fonts_done = False
        for source in files:
            kind, number = media_tools.episode_identity(source.name)
            if explicit_key and len(files) == 1:
                # 文件名里的数字可能是「10-bit」这类噪声；用户点的是哪一集就存哪一集。
                key = explicit_key
                label = media_tools.label_for_key(key) or media_tools.safe_name(source.stem)
            elif number > 0:
                # 特别篇写 1:N，和收藏里「特别篇 02」那一格对得上，不再占本篇的位置。
                key = media_tools.episode_key(number, kind)
                label = media_tools.episode_filename(number, kind)
            elif len(files) == 1 and title_key:
                key = title_key
                label = media_tools.label_for_key(key) or media_tools.safe_name(source.stem)
            else:
                # 多文件任务认不出集数就跳过，硬塞给某一集只会把别的集覆盖掉。
                key = ""
                label = ""
            if not key:
                continue
            if key in done_keys:
                # 重试时跳过已入库的集，不重复封装，也不把重试跑成全量返工。
                already += 1
                continue
            try:
                info = media_tools.probe(source)
                result = media_tools.remux(source, target_dir / f"{label}.mp4", codec=info["codec"])
                subtitle = media_tools.extract_subtitle(source, target_dir / f"{label}.ass")
            except media_tools.MediaError:
                # 单个文件坏掉不该让整季任务失败，剩下的继续处理；但数量要记下来，
                # 全是封装失败时不能报成「认不出集数」，那会把人引到错误的方向。
                broken += 1
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
            if broken:
                raise OfflineError(
                    f"{broken} 个文件封装失败，可能已损坏或编码不受支持："
                    "换一条种子，或确认磁盘还有空间"
                )
            raise OfflineError(
                "这些文件名里认不出集数：在下载器里把文件名改成「番名 - 01」这类带集数的格式，"
                "再点「重试归档」"
            )
        if ingested < len(files):
            # 部分入库不能算完成：差着的集数用户看不到，还以为整季都在媒体库里。
            # 抛错走统一的失败记录（计入自动重试次数），已入库的集保持原样，
            # 重试时上面按 key 跳过，不会重复封装。
            reason = f"，其中 {broken} 个封装失败" if broken else ""
            raise OfflineError(
                f"只入库 {ingested}/{len(files)} 集{reason}：认不出集数的文件在下载器里改名成"
                "「番名 - 01」这类格式，然后点「重试归档」，已入库的集会跳过"
            )
        self.store.set_status(media_id, "ready", progress=100, error="", archive_retries=0)
        if not config.get("seed_after_done"):
            # 不保留做种时，归档完就清掉原始文件，免得同一集占两份空间。
            try:
                client.delete([torrent_hash], delete_files=True)
            except QBError:
                pass

    @staticmethod
    def _annotate_files(files: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """给每一集标上「现在还能不能播」。

        只做读取层的判断，不改数据库：外接盘临时没插、文件被搬到别处，插回来
        或搬回去就该自动恢复，直接在库里写成 missing 反而要人工修。代价是
        每次 state 请求都 stat 一遍这个番的文件（一般几十行，可以忽略）。
        """
        for row in files:
            video = str(row.get("file_path") or "")
            row["exists"] = bool(video) and Path(video).is_file()
            subtitle = str(row.get("subtitle_path") or "")
            row["has_subtitle"] = bool(subtitle) and Path(subtitle).is_file()
        return files

    def library(self) -> dict[str, Any]:
        """「我的库」聚合：按番分组已入库文件，纯读，供媒体库视图一次拉全。"""
        files = self.store.all_files()
        root = offline_config.resolved(self.config())["media_root"]
        disk: dict[str, Any] = {"media_root": root}
        try:
            usage = shutil.disk_usage(root)
            disk["free_gb"] = round(usage.free / (1 << 30), 1)
            disk["total_gb"] = round(usage.total / (1 << 30), 1)
        except OSError:
            pass

        grouped: dict[int, list[dict[str, Any]]] = {}
        for row in files:
            grouped.setdefault(int(row.get("anime_id") or 0), []).append(row)

        items: list[dict[str, Any]] = []
        with self.store.db.connect() as db:
            for anime_id, rows in grouped.items():
                anime = db.execute(
                    "SELECT name, name_cn, image_url, collection_type, episode_count, watched_episodes, episodes"
                    " FROM anime WHERE id = ?",
                    (anime_id,),
                ).fetchone()
                info = dict(anime) if anime else {}
                ordered = sorted(rows, key=lambda row: media_tools.key_sort_value(row.get("episode_key")))
                playable = [row for row in ordered if Path(str(row.get("file_path") or "")).is_file()]
                if not playable:
                    continue  # 文件全不在了的番不进媒体库，去「本地文件」看记录更合适

                # 已看集合：watched_episodes 里混着旧格式（bgm:123），用该番的
                # episodes 资料把这类 key 换算成统一的「类型:集数」再比。
                try:
                    raw_watched = {str(key) for key in json.loads(info.get("watched_episodes") or "[]")}
                except ValueError:
                    raw_watched = set()
                key_map: dict[str, str] = {}
                try:
                    for episode in json.loads(info.get("episodes") or "[]"):
                        if isinstance(episode, dict) and episode.get("key"):
                            key_map[str(episode["key"])] = f"{int(episode.get('type') or 0)}:{int(episode.get('sort') or 0)}"
                except ValueError:
                    pass
                watched = {key_map.get(key, key) for key in raw_watched}

                def is_watched(row: dict[str, Any]) -> bool:
                    return str(row.get("episode_key")) in watched

                # 继续观看：优先「看了一半」里进度最深的；全没看过就从第一集开始
                started = [row for row in playable if 0 < int(row.get("resume_ms") or 0) < int(row.get("duration_ms") or 1)]
                continue_row = (
                    max(started, key=lambda row: int(row.get("resume_ms") or 0))
                    if started
                    else next((row for row in playable if not is_watched(row)), playable[0])
                )
                size_bytes = sum(int(row.get("file_size") or 0) for row in playable)
                items.append({
                    "anime_id": anime_id,
                    "name": (info.get("name_cn") or info.get("name") or f"番剧 {anime_id}").strip(),
                    "cover": f"/api/covers/{anime_id}",
                    "collection_type": int(info.get("collection_type") or 0),
                    "episode_count": int(info.get("episode_count") or 0),
                    # 「已收 N 集」只数磁盘上真能播的文件，和详情页口径一致；
                    # 早期这里数的是数据库记录，手动删过文件后卡片会比详情多一集。
                    "file_count": len(playable),
                    "missing_count": len(ordered) - len(playable),
                    "watched_count": sum(1 for row in playable if is_watched(row)),
                    "size_bytes": size_bytes,
                    "continue_file_id": int(continue_row["id"]),
                    "continue_episode_key": str(continue_row.get("episode_key") or ""),
                    "continue_resume_ms": int(continue_row.get("resume_ms") or 0),
                    "last_updated": max(str(row.get("updated_at") or "") for row in rows),
                })
        items.sort(key=lambda item: item["last_updated"], reverse=True)
        return {"ok": True, "items": items, "disk": disk}

    def state(self, anime_id: int, *, refresh: bool = True) -> dict[str, Any]:
        jobs = self.store.jobs_for_anime(int(anime_id))
        live: dict[int, dict[str, Any]] = {}
        if refresh:
            live = self._sync(jobs)
            jobs = self.store.jobs_for_anime(int(anime_id))
        for job in jobs:
            job["live"] = live.get(int(job["id"]), {})
        self.maybe_auto_check()
        files = self._annotate_files(self.store.files_for_anime(int(anime_id)))
        # 文件不在了不算「可以播放」：详情页的手势、面板的播放按钮都据此判断，
        # 否则点下去只会拿到 404「本地文件不在了」。
        # 把下载任务的原始种子标题带给前端：播放器标题下能显示「原视频原名」，
        # local_files 本身不存这个字段（归档后的文件名已经格式化过）。
        # 早期任务没写 episode_key，就按番内 job 的种子标题里的 [05] 集数对回去。
        jobs_by_key: dict[str, str] = {}
        groups_by_key: dict[str, str] = {}
        fallback: list[tuple[int, str, str]] = []
        for job in jobs:
            title = str(job.get("source_title") or job.get("torrent_name") or "").strip()
            group = str(job.get("group_name") or "").strip()
            if not title and not group:
                continue
            key = str(job.get("episode_key") or "")
            if key:
                if title:
                    jobs_by_key[key] = title
                if group:
                    groups_by_key[key] = group
            else:
                numbers = [int(n) for n in re.findall(r"\[(\d{1,3})\]", title)]
                if numbers:
                    fallback.append((numbers[-1], title, group))
        for item in files:
            key = str(item.get("episode_key") or "")
            title = jobs_by_key.get(key, "")
            group = groups_by_key.get(key, "")
            if not title and fallback:
                match = re.search(r"(\d+)$", key.rsplit(":", 1)[-1])
                if match:
                    number = int(match.group(1))
                    hit = next((entry for entry in fallback if entry[0] == number), None)
                    if hit:
                        title, group = hit[1], hit[2]
            item["source_title"] = title
            item["group_name"] = group
        ready = {str(item.get("episode_key")) for item in files if item.get("exists")}
        missing = [item for item in files if not item.get("exists")]
        return {
            "ok": True,
            "jobs": jobs,
            "files": files,
            "ready_episodes": sorted(ready, key=media_tools.key_sort_value),
            "missing_keys": sorted((str(item.get("episode_key")) for item in missing), key=media_tools.key_sort_value),
            "missing_count": len(missing),
            "counts": self.store.summary(),
            "paths": offline_config.resolved(self.config()),
            # 前端据此判断「还在自动重试窗口里」和「已经停了」，决定轮询节奏与按钮文案。
            "archive_retry_limit": MAX_ARCHIVE_RETRIES,
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

    def delete_episode_file(self, anime_id: int, episode_key: str) -> dict[str, Any]:
        """直接删掉硬盘上的文件并清记录（不进回收站，删了就没了）。"""
        row = self.store.file_for(int(anime_id), str(episode_key or ""))
        if not row:
            raise OfflineError("这一集没有本地文件")
        source = Path(str(row.get("file_path") or ""))
        removed = ""
        if source.is_file():
            try:
                source.unlink()
                removed = str(source)
            except OSError as error:
                raise OfflineError(f"文件删除失败：{error}") from error
        subtitle = Path(str(row.get("subtitle_path") or ""))
        if subtitle.is_file():
            try:
                subtitle.unlink()
            except OSError:
                pass
        self.store.delete_file(int(anime_id), str(episode_key))
        return {"ok": True, "deleted": removed}

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
        # 「已暂停」不进 error 字段：error 只放真正的错误，态由 live.paused 表达，
        # 否则下一次 _sync 就把它清掉，DB 里留下一个语义半真半假的字符串。
        if action == "pause":
            client.pause([torrent_hash])
            self.store.set_status(int(media_id), "downloading")
            paused = True
        elif action == "resume":
            client.resume([torrent_hash])
            self.store.set_status(int(media_id), "downloading", error="")
            paused = False
        else:
            raise ValueError("任务操作无效")
        return {"ok": True, "action": action, "paused": paused}

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
            client = self.client()
            try:
                if client.torrent(torrent_hash) is not None:
                    client.delete([torrent_hash], delete_files=delete_files)
                    if client.torrent(torrent_hash) is not None:
                        raise QBError("任务仍在下载器中，请稍后重试")
            except QBError as error:
                raise OfflineError(f"未能确认下载器已删除任务，已保留手账记录：{error}") from error
        self.store.delete_job(int(media_id))
        return {"ok": True, "kept_files": not delete_files and keep_files}


    # ---- 自动追番 -----------------------------------------------------

    def subscribe(self, *, anime_id: int, keyword: str, group_name: str = "", enabled: bool = True) -> dict[str, Any]:
        sub = self.store.add_subscription(
            anime_id=int(anime_id), keyword=keyword, group_name=group_name, enabled=enabled
        )
        # 带回总开关：自动追番默认关，订阅了也永远不会自动下载，
        # 前端要据此说清楚「还要去设置里打开」，而不是含糊地报「已订阅」。
        return {"ok": True, "subscription": sub, "auto_follow": bool(self.config().get("auto_follow"))}

    def unsubscribe(self, sub_id: int) -> dict[str, Any]:
        if not self.store.delete_subscription(int(sub_id)):
            raise OfflineError("订阅不存在")
        return {"ok": True}

    def subscriptions(self, anime_id: int | None = None) -> dict[str, Any]:
        items = self.store.subscriptions(anime_id)
        # 订阅管理页要显示番名：一次把涉及到的番全查出来。
        ids = {int(item.get("anime_id") or 0) for item in items if item.get("anime_id")}
        names: dict[int, str] = {}
        if ids:
            with self.store.db.connect() as db:
                marks = ",".join("?" for _ in ids)
                rows = db.execute(
                    f"SELECT id, name, name_cn FROM anime WHERE id IN ({marks})",
                    tuple(ids),
                ).fetchall()
                for row in rows:
                    names[int(row["id"])] = str(row["name_cn"] or row["name"] or f"番剧 {row['id']}")
        for item in items:
            item["anime_name"] = names.get(int(item.get("anime_id") or 0), "")
        return {
            "ok": True,
            "items": items,
            "auto_follow": bool(self.config().get("auto_follow")),
        }

    def _known_episode_number(self, sub: dict[str, Any], items: list[dict[str, Any]]) -> int:
        """这部番已经见过的最大集数：本地文件 / 下载任务 / 上次处理的那条种子。"""
        numbers: list[int] = []
        anime_id = int(sub.get("anime_id") or 0)
        try:
            for row in self.store.files_for_anime(anime_id):
                match = re.search(r":(\d+)$", str(row.get("episode_key") or ""))
                if match:
                    numbers.append(int(match.group(1)))
            for row in self.store.jobs_for_anime(anime_id):
                title = str(row.get("source_title") or row.get("torrent_name") or "")
                numbers.append(_release_episode({"title": title}))
        except Exception:  # noqa: BLE001 - 读库出错不该让整轮检查挂掉
            pass
        last_torrent = str(sub.get("last_torrent") or "")
        if last_torrent:
            known = next((item for item in items if str(item.get("id") or "") == last_torrent), None)
            if known:
                numbers.append(_release_episode(known))
        return max(numbers or [0])

    def _fresh_releases(
        self,
        sub: dict[str, Any],
        all_items: list[dict[str, Any]],
        candidates: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """在这一批候选里挑出「还没下过的新集」。

        主判据是**集数**：超过已有最大集才算新。发布时间不能当主判据——蜜柑有的
        镜像干脆不给 pubDate（历史上订阅永远判不出新集就是这个原因）。集数认不出来
        时才退回发布时间，且水位线取「上次处理的那条种子」的发布时间，而不是上次
        检查时间：用检查时间会把检查之前刚发布的集永久吞掉。
        """
        known = self._known_episode_number(sub, all_items)
        last_torrent = next(
            (item for item in all_items if str(item.get("id") or "") == str(sub.get("last_torrent") or "")),
            None,
        )
        watermark = str((last_torrent or {}).get("published_at") or "")
        fresh: list[dict[str, Any]] = []
        for item in candidates:
            number = _release_episode(item)
            if number and known:
                if number > known:
                    fresh.append(item)
                continue
            if number:
                # 一份都还没下过：任何一集都算新，后面只挑最高的一集下。
                fresh.append(item)
                continue
            published = str(item.get("published_at") or "")
            if published and (not watermark or published > watermark):
                fresh.append(item)
        fresh.sort(key=_release_order)
        return fresh

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
            candidates.sort(key=_release_order)
            if not last:
                # 首次检查：把当前最新一条记成基准，不下载。
                newest = candidates[-1] if candidates else None
                self.store.touch_subscription(
                    sub["id"],
                    last_checked=now_iso(),
                    last_torrent=str((newest or {}).get("id") or ""),
                )
                entry["status"] = "baseline"
                entry["title"] = (newest or {}).get("title") or "还没有可记录的条目"
                results.append(entry)
                continue
            fresh = self._fresh_releases(sub, found["items"], candidates)
            if not fresh:
                # 没新集：只推进检查时刻，水位线（last_torrent）原样保留。
                self.store.touch_subscription(sub["id"], last_checked=now_iso())
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
                    last_checked=now_iso(),
                    last_torrent=str(target.get("id") or ""),
                )
                entry["status"] = "downloaded"
                entry["title"] = str(target.get("title") or "")
                downloaded += 1
            except Exception as error:  # noqa: BLE001
                # 单条订阅失败（qB 没开、网络断）只算这一条出错，不能让整轮检查 500：
                # 之前只捕 OfflineError，QBError 会一路冒到 HTTP 层，用户在订阅页
                # 点「立即检查」只会看到「后台暂时无法处理请求」。
                entry["status"] = "error"
                entry["title"] = str(error) or error.__class__.__name__
                # 失败也推进检查时间，否则前端轮询会反复重试同一条种子；
                # last_torrent 不动，下一轮仍会把这一集当成新集重试。
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

    @staticmethod
    def _copy_file(source: Path, destination: Path) -> bool:
        """Return whether a new file was created. Reuse identical copies."""
        destination.parent.mkdir(parents=True, exist_ok=True)
        created = False
        try:
            with source.open("rb") as incoming:
                try:
                    outgoing = destination.open("xb")
                except FileExistsError:
                    if destination.is_symlink() or not destination.is_file() or source.samefile(destination):
                        raise FileExistsError(f"目标路径已占用：{destination}") from None
                    with destination.open("rb") as existing:
                        while True:
                            block = incoming.read(1024 * 1024)
                            if block != existing.read(1024 * 1024):
                                raise FileExistsError(f"目标已有内容不同的同名文件：{destination}") from None
                            if not block:
                                return False
                created = True
                with outgoing:
                    shutil.copyfileobj(incoming, outgoing)
            shutil.copystat(source, destination)
            if destination.stat().st_size != source.stat().st_size:
                raise OSError("复制后大小不一致")
        except OSError:
            if created:
                destination.unlink(missing_ok=True)
            raise
        return True

    @staticmethod
    def _rollback(paths: list[Path]) -> None:
        for path in reversed(paths):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass

    def _migrate_fonts(
        self,
        current_path: Path,
        target_path: Path,
        created: list[Path],
        warnings: list[dict[str, str]],
    ) -> int:
        """把各番目录下的 ``_fonts`` 一起搬过去。

        字体只影响字幕观感，所以复制失败只记 warning、不阻塞整批迁移；
        但不迁的话迁移后特效字幕会回退到默认字体。
        """
        count = 0
        try:
            roots = [
                path
                for path in current_path.rglob("_fonts")
                if path.is_dir() and not _is_within(path, target_path)
            ]
        except OSError:
            return 0
        for fonts_dir in roots:
            try:
                relative = fonts_dir.relative_to(current_path)
            except ValueError:
                relative = Path(fonts_dir.name)
            try:
                items = [item for item in fonts_dir.iterdir() if item.is_file()]
            except OSError:
                continue
            for item in items:
                destination = target_path / relative / item.name
                try:
                    fresh = self._copy_file(item, destination)
                except OSError as error:
                    warnings.append(
                        {"file": str(item), "reason": f"字体没复制过去：{error}"}
                    )
                    continue
                count += 1
                if fresh:
                    created.append(destination)
        return count

    def migrate_media_root(self, target_root: str, *, delete_source: bool = False) -> dict[str, Any]:
        """把已入库的文件搬到新目录。

        分两个阶段：先把视频、字幕、字体全部复制并校验，**全部成功**才一次性
        改数据库与配置。任何一条失败就回滚（删掉这次复制到新目录的副本），
        数据库与配置保持原样。旧逻辑是边复制边改数据库，中途失败会留下
        「数据库指向新副本、配置仍指旧目录」两个媒体库并存的状态。

        默认不删源文件——真要删是另一个明确的开关，且放在最后一步。
        """
        target_text = str(target_root or "").strip()
        if not target_text:
            raise OfflineError("请填写目标目录")
        config = self.config()
        current_text = offline_config.resolved(config)["media_root"].replace("\\", "/").rstrip("/")
        current_path = Path(current_text)
        try:
            target_path = Path(target_text).resolve()
            if target_path == current_path.resolve():
                raise OfflineError("目标目录和当前目录是同一个")
            target_text = target_path.as_posix()
            if target_text.endswith("/"):
                raise OfflineError("请选择盘符下的一个目录作为媒体库")
            if len(target_text) > offline_config.MAX_TEXT:
                raise OfflineError("目标目录路径过长")
            target_path.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise OfflineError(f"无法创建目标目录：{error}") from error

        failed: list[dict[str, str]] = []
        warnings: list[dict[str, str]] = []
        # 只记「复制成功、准备改指向」的条目；真正写数据库留到全部成功之后。
        plan: list[tuple[dict[str, Any], str, str]] = []
        created: list[Path] = []
        original_files = self.store.all_files()
        for row in original_files:
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
                fresh = self._copy_file(source, destination)
            except OSError as error:
                failed.append({"file": str(source), "reason": str(error)})
                continue
            if fresh:
                created.append(destination)
            subtitle_path = str(row.get("subtitle_path") or "")
            subtitle = Path(subtitle_path)
            if subtitle_path and subtitle.is_file():
                try:
                    subtitle_relative = subtitle.relative_to(current_path)
                except ValueError:
                    subtitle_relative = Path(subtitle.name)
                subtitle_target = target_path / subtitle_relative
                try:
                    subtitle_fresh = self._copy_file(subtitle, subtitle_target)
                except OSError as error:
                    # 只搬视频不搬字幕，删源之后字幕就成了孤儿；整条算失败更安全。
                    failed.append({"file": str(subtitle), "reason": f"字幕没复制过去：{error}"})
                    continue
                if subtitle_fresh:
                    created.append(subtitle_target)
                subtitle_path = str(subtitle_target)
            plan.append((row, str(destination), subtitle_path))

        if failed:
            self._rollback(created)
            return {
                "ok": True,
                "copied": 0,
                "attempted": len(plan),
                "failed": failed,
                "warnings": warnings,
                "target": target_text,
                "switched": False,
                "rolled_back": True,
                "deleted_source": False,
                "fonts": 0,
            }

        # 视频/字幕都齐了再搬字体；字体失败只记 warning，不影响整批成功。
        fonts_copied = self._migrate_fonts(current_path, target_path, created, warnings)
        # Ignore playback progress changes, which replace_file preserves.
        def file_locations(rows):
            return [(row["id"], row["file_path"], row["subtitle_path"], row["media_id"]) for row in rows]

        try:
            with offline_config.media_root_switch(self.asset_root, current_text, target_text), self.db.transaction():
                if file_locations(self.store.all_files()) != file_locations(original_files):
                    raise OfflineError("复制期间媒体库文件有变动，请重试迁移")
                for row, destination, subtitle_path in plan:
                    self.store.replace_file(
                        anime_id=int(row["anime_id"]),
                        episode_key=str(row["episode_key"]),
                        file_path=destination,
                        file_size=int(row.get("file_size") or 0),
                        duration_ms=int(row.get("duration_ms") or 0),
                        media_id=int(row.get("media_id") or 0),
                        subtitle_path=subtitle_path,
                    )
        except Exception as error:
            self._rollback(created)
            raise OfflineError(f"迁移切换失败：{error}") from error
        if delete_source:
            # 删源放在最后：前面任何一步失败都不该让原文件消失。
            for row, _, _ in plan:
                for key in ("file_path", "subtitle_path"):
                    path = Path(str(row.get(key) or ""))
                    if path.is_file() and _is_within(path, current_path):
                        try:
                            path.unlink()
                        except OSError:
                            pass
        return {
            "ok": True,
            "copied": len(plan),
            "attempted": len(plan),
            "failed": failed,
            "warnings": warnings,
            "target": target_text,
            "switched": True,
            "rolled_back": False,
            "deleted_source": delete_source,
            "fonts": fonts_copied,
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
