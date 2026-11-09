"""离线下载的「这台机器」配置。

单独放一个 ``offline.json``，不进 settings 主表，原因是这类设置全部跟本机
绑定：媒体库路径、qB 端口、字体目录。放进主设置会被同步到别的设备，那边
既没有那个盘符也没有那个下载器，反而制造故障。
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

CONFIG_FILE = "offline.json"
DEFAULT_QB_HOST = "127.0.0.1"
DEFAULT_QB_PORT = 8080
DEFAULT_CATEGORY = "AnimeHandbook"
MAX_TEXT = 400

DEFAULTS: dict[str, Any] = {
    "media_root": "",          # 空表示用 default_media_root()
    "download_root": "",       # 空表示 <media_root>/_incoming
    "screenshot_root": "",     # 空表示 <media_root>/截图
    "screenshot_name_format": "",  # 空表示 DEFAULT_SCREENSHOT_NAME
    "qb_host": DEFAULT_QB_HOST,
    "qb_port": DEFAULT_QB_PORT,
    "qb_category": DEFAULT_CATEGORY,
    "seed_after_done": True,
    "auto_follow": False,
    "font_dir": "",
    "mikan_host": "",          # 空表示按 MIRRORS 顺序自动选
    "last_group": {},          # anime_id(字符串) -> 字幕组名
    "warn_size_gb": 10,
    "low_space_gb": 20,
}

_BOOLS = ("seed_after_done", "auto_follow")
_INTS = {"qb_port": (1, 65535), "warn_size_gb": (1, 500), "low_space_gb": (1, 5000)}
_TEXTS = ("media_root", "download_root", "screenshot_root", "screenshot_name_format", "font_dir", "mikan_host", "qb_host", "qb_category")

# 截图文件名模板：{episode} 集数、{time} 时间码、{date} 日期、{anime} 番名。
DEFAULT_SCREENSHOT_NAME = "{episode}_{time}"


def project_root() -> Path:
    """项目根目录（handbook/ 的上一级）。"""
    return Path(__file__).resolve().parents[1]


def default_media_root() -> str:
    """默认放在项目目录下的 media/。

    跟项目同盘：备份、整体搬移时媒体跟着走，不用再记第二个路径。
    视频不会被推到 GitHub——auto_sync 只收显式 --paths 里的代码/文档，
    且 mp4/mkv/png 这类二进制类型直接拒绝。
    """
    return str(project_root() / "media").replace("\\", "/")


def config_path(asset_root: Path) -> Path:
    return Path(asset_root) / CONFIG_FILE


# 整个进程共用一把锁：search 记主机、download 记字幕组、设置页保存都是
# 「读-改-写」同一个 offline.json，并发时后写的会把先写的覆盖掉。用 RLock 是
# 因为 patch / save_settings 会在持锁状态下调用 load / save。
_LOCK = threading.RLock()


def _clean_text(value: Any) -> str:
    text = str(value or "").strip()
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT]
    return text.replace("\\", "/").rstrip("/") if text else ""


def normalize(document: Any) -> dict[str, Any]:
    """把任意输入收敛成合法配置；不认识的多余键直接丢弃。"""
    source = document if isinstance(document, dict) else {}
    result: dict[str, Any] = {}
    for key in _TEXTS:
        result[key] = _clean_text(source.get(key, DEFAULTS[key]))
    for key in _BOOLS:
        result[key] = bool(source.get(key, DEFAULTS[key]))
    for key, (low, high) in _INTS.items():
        raw = source.get(key, DEFAULTS[key])
        try:
            number = int(raw)
        except (TypeError, ValueError):
            number = int(DEFAULTS[key])
        result[key] = max(low, min(high, number))
    if not result["qb_host"]:
        result["qb_host"] = DEFAULT_QB_HOST
    if not result["qb_category"]:
        result["qb_category"] = DEFAULT_CATEGORY
    # 字幕组偏好只保留「数字 id → 短字符串」的配对，防止脏数据堆积。
    last_group: dict[str, str] = {}
    raw_groups = source.get("last_group")
    if isinstance(raw_groups, dict):
        for anime_id, group in list(raw_groups.items())[:500]:
            key = str(anime_id).strip()
            name = str(group or "").strip()[:80]
            if key.isdigit() and name:
                last_group[key] = name
    result["last_group"] = last_group
    return result


def load(asset_root: Path) -> dict[str, Any]:
    path = config_path(asset_root)
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return normalize({})
    return normalize(document)


def save(asset_root: Path, document: Any) -> dict[str, Any]:
    config = normalize(document)
    path = config_path(asset_root)
    with _LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(path)
    return config


def patch(asset_root: Path, **fields: Any) -> dict[str, Any]:
    """在锁里「读-改-写」一次，只动传进来的键。

    记住镜像主机、记住字幕组这类副作用以前都是「整份读出、改一个键、整份写回」，
    和设置页保存撞在一起就会互相覆盖。要整份覆盖（设置页）用
    :func:`save_settings`，只改一个键用这里。
    """
    with _LOCK:
        config = load(asset_root)
        config.update(fields)
        return save(asset_root, config)


def save_settings(asset_root: Path, document: Any) -> dict[str, Any]:
    """设置页保存：只覆盖它真的提交了的键。

    设置表单里没有 ``mikan_host``（自动探测出来的镜像）和 ``last_group``
    （搜索时记下的字幕组偏好），整份覆盖会把这两个静默清掉。
    """
    submitted = document if isinstance(document, dict) else {}
    with _LOCK:
        config = load(asset_root)
        for key in submitted:
            if key in DEFAULTS:
                config[key] = submitted[key]
        return save(asset_root, config)


def resolved(config: dict[str, Any]) -> dict[str, str]:
    """算出真正使用的几个目录，不改动原始配置。"""
    media = _clean_text(config.get("media_root")) or _clean_text(default_media_root())
    download = _clean_text(config.get("download_root")) or f"{media}/_incoming"
    shots = _clean_text(config.get("screenshot_root")) or f"{media}/截图"
    return {"media_root": media, "download_root": download, "screenshot_root": shots}


_PROBE_LOCK = threading.Lock()
# 探测结果缓存：路径 -> (时间戳, 是否可写)。探测本身要创建+删除临时文件，
# 跑批/轮询场景下高频调用会积累大量删除动作；可写状态分钟级缓存既消除
# 无谓的文件操作，也把删除频率压到护栏阈值以下。失败只缓存 5 秒，便于恢复。
_PROBE_CACHE: dict[str, tuple[float, bool]] = {}
_PROBE_TTL_OK = 30.0
_PROBE_TTL_FAIL = 5.0


def _probe_writable(target: Path) -> None:
    """mkstemp 写一个探测文件并删掉；写成功即证明目录可写。

    并发安全：mkstemp 每次唯一名，写与删都是自己的文件；进程内用锁串行化，
    避免一个线程 unlink 时另一个线程刚好命中同一短暂窗口（N14 的原始竞态）。
    删除失败（外部占用/护栏拦截）只说明清理没做成，不代表目录不可写，
    静默忽略即可——探测文件留在盘上也只是一个 0 字节隐藏文件。
    """
    fd, tmp_name = tempfile.mkstemp(prefix=".handbook-write-test-", dir=str(target))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(b"ok")
    finally:
        try:
            Path(tmp_name).unlink(missing_ok=True)
        except OSError:
            pass


def ensure_dirs(config: dict[str, Any]) -> dict[str, Any]:
    """建目录并顺手检查可写；返回给界面看的落地状态。"""
    paths = resolved(config)
    result: dict[str, Any] = {**paths, "ok": True, "error": "", "free_gb": 0.0}
    now = time.monotonic()
    for key in ("media_root", "download_root"):
        target = Path(paths[key])
        try:
            target.mkdir(parents=True, exist_ok=True)
            cached = _PROBE_CACHE.get(str(target))
            if cached and now - cached[0] < (_PROBE_TTL_OK if cached[1] else _PROBE_TTL_FAIL):
                if not cached[1]:
                    result["ok"] = False
                    result["error"] = f"{target} 不可写（缓存）"
                    return result
                continue
            with _PROBE_LOCK:
                _probe_writable(target)
            _PROBE_CACHE[str(target)] = (now, True)
        except OSError as error:
            _PROBE_CACHE[str(target)] = (now, False)
            result["ok"] = False
            result["error"] = f"{target} 不可写：{error}"
            return result
    try:
        # shutil.disk_usage 在 Windows 上也能用，os.statvfs 不行。
        usage = shutil.disk_usage(paths["media_root"])
        result["free_gb"] = round(usage.free / (1 << 30), 1)
        result["total_gb"] = round(usage.total / (1 << 30), 1)
    except OSError:
        pass
    return result
def remember_group(asset_root: Path, anime_id: Any, group: str) -> dict[str, Any]:
    """记住某部番上次选的字幕组，下次搜索把它排前面。"""
    key = str(int(anime_id)) if str(anime_id).isdigit() else ""
    name = str(group or "").strip()[:80]
    if not (key and name):
        return load(asset_root)
    # 读和写必须在同一把锁里，否则两次搜索并发时后一次会用旧的 last_group 覆盖前一次。
    with _LOCK:
        config = load(asset_root)
        config["last_group"][key] = name
        return save(asset_root, config)
