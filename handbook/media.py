"""ffmpeg/ffprobe 封装与集数识别。

这里的核心主张是「只换壳、不转码」：实测一集 24 分钟的视频 remux 只要几百
毫秒，画质一个比特都不动。真正需要重新编码的情况（AV1、源文件损坏）极少，
所以 remux 失败时只报错、不自动降级去转码——转码是不可逆的画质损失，必须
由用户明确选择。
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

VIDEO_SUFFIXES = {".mkv", ".mp4", ".m4v", ".avi", ".ts", ".flv", ".webm", ".mov"}
SUBTITLE_SUFFIXES = {".ass", ".ssa", ".srt"}
# 字幕组常把 ASS 用到的字体作为 MKV 附件一起发布；抽出来给 libass 用，
# 比任何回退字体都准（OP/ED 特效字幕尤其依赖原字体）。
FONT_SUFFIXES = {".ttf", ".otf", ".ttc", ".otc", ".woff", ".woff2"}
FONT_MIME = {
    ".ttf": "font/ttf", ".otf": "font/otf", ".ttc": "font/collection",
    ".otc": "font/collection", ".woff": "font/woff", ".woff2": "font/woff2",
}
FONT_TIMEOUT = 120

# 方括号里几乎都是画质/字幕组/语言标记，先整体去掉再找集数，能避开
# “[1080p]”“[10bit]”“[01-12+SPx1]” 这类噪声。
_BRACKET_RE = re.compile(r"[\[【（(][^\]】）)]*[\]】）)]")
_PATTERNS = (
    re.compile(r"第\s*(\d{1,4})\s*[话話集]"),
    re.compile(r"[Ss](\d{1,2})[Ee](\d{1,4})"),
    re.compile(r"[Ee][Pp]?\.?\s*(\d{1,4})"),
    re.compile(r"\s[-－—]\s*(\d{1,4})(?:\s|$)"),
    re.compile(r"^(\d{1,4})$"),
)
_TRAILING_NUMBER_RE = re.compile(r"(\d{1,4})(?![\dpP])")

PROBE_TIMEOUT = 40
REMUX_TIMEOUT = 900
SUBTITLE_TIMEOUT = 120


class MediaError(RuntimeError):
    """ffmpeg 不可用或处理失败；消息直接给用户看。"""


def tool_path(name: str, configured: str = "") -> str:
    """优先用用户填的路径，其次在 PATH 里找。找不到返回空串。"""
    candidate = str(configured or "").strip()
    if candidate:
        path = Path(candidate)
        if path.is_file():
            return str(path)
        # 允许只填目录，自动补上可执行文件名。
        if path.is_dir():
            for suffix in (".exe", ""):
                guess = path / f"{name}{suffix}"
                if guess.is_file():
                    return str(guess)
    return shutil.which(name) or ""


def probe(path: Path | str, *, ffprobe: str = "", timeout: float = PROBE_TIMEOUT) -> dict[str, Any]:
    binary = ffprobe or tool_path("ffprobe")
    if not binary:
        raise MediaError("找不到 ffprobe，请确认 ffmpeg 已安装并在 PATH 中")
    target = Path(path)
    if not target.is_file():
        raise MediaError(f"文件不存在：{target}")
    command = [
        binary,
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        str(target),
    ]
    try:
        completed = subprocess.run(
            command, capture_output=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise MediaError(f"ffprobe 运行失败：{error}") from error
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip()[:200]
        raise MediaError(f"无法识别这个视频文件：{detail or 'ffprobe 返回错误'}")
    try:
        document = json.loads(completed.stdout.decode("utf-8", "replace"))
    except ValueError as error:
        raise MediaError("ffprobe 输出无法解析") from error
    streams = document.get("streams") or []
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    if video is None:
        raise MediaError("这个文件里没有视频轨")
    subtitle_streams = [item for item in streams if item.get("codec_type") == "subtitle"]
    try:
        duration_ms = int(float((document.get("format") or {}).get("duration") or 0) * 1000)
    except (TypeError, ValueError):
        duration_ms = 0
    return {
        "codec": str(video.get("codec_name") or ""),
        "profile": str(video.get("profile") or ""),
        "pix_fmt": str(video.get("pix_fmt") or ""),
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "duration_ms": duration_ms,
        "has_subtitle": bool(subtitle_streams),
        "subtitle_codec": str(subtitle_streams[0].get("codec_name") or "") if subtitle_streams else "",
    }


def remux(
    source: Path | str,
    destination: Path | str,
    *,
    codec: str = "",
    ffmpeg: str = "",
    timeout: float = REMUX_TIMEOUT,
) -> dict[str, Any]:
    """换壳成 mp4。``-c copy`` 保证零损失，HEVC 额外打 hvc1 标记。

    ``hvc1`` 这个标记不是可有可无的：Edge 对 ``hev1`` 的接受度不稳定，同一份
    码流换个 fourcc 就可能从「能播」变成「黑屏」。
    """
    binary = ffmpeg or tool_path("ffmpeg")
    if not binary:
        raise MediaError("找不到 ffmpeg，请确认已安装并在 PATH 中")
    src = Path(source)
    dst = Path(destination)
    if not src.is_file():
        raise MediaError(f"源文件不存在：{src}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    temporary = dst.with_name(dst.stem + ".remuxing" + dst.suffix)
    command = [
        binary,
        "-y",
        "-loglevel", "error",
        "-i", str(src),
        "-map", "0:v:0",
        "-map", "0:a?",
        "-c", "copy",
        "-sn",
        "-movflags", "+faststart",
        "-f", "mp4",
    ]
    if codec.lower() in ("hevc", "h265"):
        command += ["-tag:v", "hvc1"]
    command.append(str(temporary))
    try:
        completed = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise MediaError(f"ffmpeg 运行失败：{error}") from error
    if completed.returncode != 0 or not temporary.is_file():
        detail = completed.stderr.decode("utf-8", "replace").strip()[:300]
        temporary.unlink(missing_ok=True)
        raise MediaError(f"封装失败：{detail or 'ffmpeg 返回错误'}")
    temporary.replace(dst)
    return {"path": str(dst), "size": dst.stat().st_size}


def extract_subtitle(
    source: Path | str,
    destination: Path | str,
    *,
    ffmpeg: str = "",
    timeout: float = SUBTITLE_TIMEOUT,
) -> str:
    """抽第一条字幕轨。没有字幕轨或抽取失败都返回空串，不影响视频入库。"""
    binary = ffmpeg or tool_path("ffmpeg")
    if not binary:
        return ""
    src = Path(source)
    dst = Path(destination)
    if not src.is_file():
        return ""
    dst.parent.mkdir(parents=True, exist_ok=True)
    command = [
        binary, "-y", "-loglevel", "error",
        "-i", str(src),
        "-map", "0:s:0",
        "-c", "copy",
        str(dst),
    ]
    try:
        completed = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    if completed.returncode != 0 or not dst.is_file() or dst.stat().st_size == 0:
        dst.unlink(missing_ok=True)
        return ""
    return str(dst)


def font_attachments(
    path: Path | str,
    *,
    ffprobe: str = "",
    timeout: float = PROBE_TIMEOUT,
) -> list[dict[str, Any]]:
    """列出 MKV 里的字体附件。

    ``t_index`` 是 ffmpeg ``-dump_attachment:t:N`` 要用的**附件流序号**，
    不是 ffprobe 的全局 stream index；两者在有视频/音频/字幕轨时并不相等。
    """
    binary = ffprobe or tool_path("ffprobe")
    target = Path(path)
    if not binary or not target.is_file():
        return []
    command = [binary, "-v", "error", "-print_format", "json", "-show_streams", str(target)]
    try:
        completed = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return []
    if completed.returncode != 0:
        return []
    try:
        document = json.loads(completed.stdout.decode("utf-8", "replace"))
    except ValueError:
        return []
    found: list[dict[str, Any]] = []
    t_index = 0
    for item in document.get("streams") or []:
        if item.get("codec_type") != "attachment":
            continue
        # ffprobe 有时回绝对路径（取决于压制时 -attach 的参数），统一取 basename。
        filename = Path(str((item.get("tags") or {}).get("filename") or "")).name
        if Path(filename).suffix.lower() in FONT_SUFFIXES:
            found.append({"t_index": t_index, "filename": filename})
        t_index += 1
    return found


def extract_font_attachments(
    source: Path | str,
    target_dir: Path | str,
    *,
    ffprobe: str = "",
    ffmpeg: str = "",
    timeout: float = FONT_TIMEOUT,
) -> list[str]:
    """把字体附件抽到 ``target_dir``，返回抽出的路径列表。

    抽不到或抽失败都返回空列表：字体只是字幕观感，绝不能让归档失败。
    """
    attachments = font_attachments(source, ffprobe=ffprobe)
    binary = ffmpeg or tool_path("ffmpeg")
    if not attachments or not binary:
        return []
    src = Path(source)
    root = Path(target_dir)
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError:
        return []
    made: list[str] = []
    for item in attachments:
        # 只取 basename，避免附件名里的 ../ 写到媒体库外面。
        name = Path(str(item["filename"])).name
        if Path(name).suffix.lower() not in FONT_SUFFIXES:
            continue
        destination = root / name
        command = [
            binary, "-y", "-v", "error",
            f"-dump_attachment:t:{int(item['t_index'])}", str(destination),
            "-i", str(src),
            "-f", "null", "-",
        ]
        try:
            completed = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
        except (OSError, subprocess.SubprocessError):
            continue
        if completed.returncode != 0 or not destination.is_file() or destination.stat().st_size == 0:
            destination.unlink(missing_ok=True)
            continue
        made.append(str(destination))
    return made


def episode_number(name: str) -> int:
    """从文件名认集数；认不出返回 0，由调用方决定跳过还是让用户手填。"""
    text = str(name or "")
    stem = Path(text).stem if Path(text).suffix.lower() in VIDEO_SUFFIXES | SUBTITLE_SUFFIXES else text
    cleaned = _BRACKET_RE.sub(" ", stem).strip()
    for pattern in _PATTERNS:
        matched = pattern.search(cleaned)
        if not matched:
            continue
        if pattern.groups == 2:  # SxxExx 取集数那一组
            return int(matched.group(2))
        return int(matched.group(1))
    # 兜底：取最后一个不像分辨率的数字。
    candidates = [
        int(value)
        for value in _TRAILING_NUMBER_RE.findall(cleaned)
        if 0 < int(value) <= 1000
    ]
    return candidates[-1] if candidates else 0


def episode_key(number: int) -> str:
    """与收藏里保持一致：本篇第 N 集的 key 是 ``0:N``。"""
    return f"0:{int(number)}"


def episode_filename(number: int) -> str:
    return f"第 {int(number):02d} 集"


def safe_name(text: str, *, fallback: str = "未命名番剧", limit: int = 80) -> str:
    """清掉 Windows 文件名禁用字符，避免建目录时炸掉。"""
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", str(text or ""))
    value = re.sub(r"\s+", " ", value).strip(" .")
    if not value:
        value = fallback
    return value[:limit]


def video_files(root: Path | str, *, min_bytes: int = 0) -> list[Path]:
    """列出目录里的视频，按集数排序。

    只按文件名挡 ``sample``、按大小挡 1 KB 以下的空壳，不做「小于 5 MB 就当
    残片」这种猜测——预告片和 OP 也可能只有几十 MB，误杀比漏放更麻烦。
    """
    base = Path(root)
    if base.is_file():
        return [base] if base.suffix.lower() in VIDEO_SUFFIXES else []
    if not base.is_dir():
        return []
    found: list[tuple[int, str, Path]] = []
    for path in base.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in VIDEO_SUFFIXES:
            continue
        name = path.name.lower()
        if "sample" in name:
            continue
        try:
            if path.stat().st_size < max(min_bytes, 1024):
                continue
        except OSError:
            continue
        found.append((episode_number(path.name), str(path).lower(), path))
    found.sort(key=lambda item: (item[0] or 10**6, item[1]))
    return [item[2] for item in found]
