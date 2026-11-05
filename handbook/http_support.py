"""Common HTTP framing, request validation and conditional asset responses."""
import gzip
import hashlib
import json
import math

from .common import MAX_JSON_BODY_BYTES


class RequestProblem(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def request_integer(value, label):
    if type(value) is not int and not (isinstance(value, str) and value.strip().lstrip("-").isdigit()):
        raise ValueError(f"{label}需为整数")
    try:
        number = int(value)
        if not -(2**63) <= number < 2**63:
            raise ValueError()
        return number
    except (ValueError, OverflowError):
        raise ValueError(f"{label}无效") from None


def validate_command_body(path, body):
    """Reject malformed command fields before any database/file mutation."""
    integers = {"anime_id": "番剧 ID", "template_id": "模板 ID", "episode_count": "集数"}
    for field, label in integers.items():
        if field in body:
            optional = field == "template_id" or (field == "anime_id" and path not in {"/api/video-links", "/api/collection-status"})
            if optional and body[field] in (None, ""):
                continue
            request_integer(body[field], label)
    arrays = {"themes", "episode_keys", "anime_ids", "tiers"}
    if path.endswith("/progress"):
        arrays.add("episodes")
    for field in arrays:
        if field in body and body[field] is not None and not isinstance(body[field], list):
            raise ValueError(f"{field}需为列表")
        if field in body and isinstance(body[field], list):
            for item in body[field]:
                if field == "anime_ids":
                    request_integer(item, "番剧 ID")
                elif field in {"episode_keys", "episodes"} and (type(item) not in {str, int, float} or (type(item) is float and not math.isfinite(item))):
                    raise ValueError("集数列表内容无效")
                elif field == "themes" and not isinstance(item, str):
                    raise ValueError("主题列表内容需为文字")
                if field in {"episode_keys", "episodes"} and isinstance(item, str):
                    try:
                        numeric = float(item)
                    except ValueError:
                        continue  # Named keys such as bgm:123 and main:1 are valid.
                    if not math.isfinite(numeric):
                        raise ValueError("集数列表内容无效")
    if "rating" in body and body["rating"] not in (None, ""):
        try:
            value = float(body["rating"])
        except (TypeError, ValueError, OverflowError):
            raise ValueError("评分需为有效数字") from None
        if not math.isfinite(value):
            raise ValueError("评分需为有限数字")
    if path == "/api/video-links":
        if not isinstance(body.get("action", "save"), str):
            raise ValueError("视频操作需为文字")
        if body.get("action") in {"delete", "default", "unset_default"}:
            request_integer(body.get("id"), "视频 ID")
    if path.endswith("/move") and path.startswith("/api/rankings/"):
        placements = body.get("placements")
        if not isinstance(placements, dict):
            raise ValueError("排名位置需为对象")
        for tier, ids in placements.items():
            if tier != "unranked":
                request_integer(tier, "排名等级 ID")
            if not isinstance(ids, list):
                raise ValueError("排名位置需为列表")
            for item in ids:
                request_integer(item, "番剧 ID")


def _reject_json_constant(value):
    raise ValueError("JSON 不允许 NaN 或 Infinity")


def read_object(handler):
    if handler.headers.get("Transfer-Encoding"):
        raise ValueError("不支持分块请求")
    raw_size = handler.headers.get("Content-Length", "0")
    if not str(raw_size).isdigit():
        raise ValueError("Content-Length 无效")
    size = int(raw_size)
    if size > MAX_JSON_BODY_BYTES:
        raise RequestProblem("请求内容过大", 413)
    if size == 0: return {}
    if handler.headers.get_content_type() != "application/json":
        raise RequestProblem("请求必须使用 application/json", 415)
    try:
        raw = handler.rfile.read(size)
    except TimeoutError as error:
        handler.close_connection = True
        raise RequestProblem("读取请求超时", 408) from error
    if len(raw) != size: raise ValueError("请求内容不完整")
    try:
        value = json.loads(raw.decode("utf-8"), parse_constant=_reject_json_constant)
    except (ValueError, UnicodeError) as error:
        raise ValueError("JSON 格式错误") from error
    if not isinstance(value, dict): raise ValueError("请求内容需为 JSON 对象")
    return value


def send_asset(handler, body, mime, *, cache="private, no-cache", compress=False, etag=None):
    accepts = {}
    for part in handler.headers.get("Accept-Encoding", "").split(","):
        coding, *params = part.strip().lower().split(";")
        quality = 1.0
        for param in params:
            if param.strip().startswith("q="):
                try: quality = float(param.strip()[2:])
                except ValueError: quality = 0
        accepts[coding] = quality
    zipped = compress and len(body) >= 512 and accepts.get("gzip", accepts.get("*", 0)) > 0
    if zipped: body = gzip.compress(body, mtime=0)
    etag = etag or ('"' + hashlib.sha256(body).hexdigest() + '"')
    tags = [value.strip().removeprefix("W/") for value in handler.headers.get("If-None-Match", "").split(",")]
    unchanged = cache != "private, no-store" and (etag.removeprefix("W/") in tags or "*" in tags)
    handler.send_response(304 if unchanged else 200)
    handler.send_header("Content-Type", mime)
    handler.send_header("Cache-Control", cache)
    handler.send_header("ETag", etag)
    if compress: handler.send_header("Vary", "Accept-Encoding")
    if zipped: handler.send_header("Content-Encoding", "gzip")
    if not unchanged: handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    if not unchanged and handler.command != "HEAD": handler.wfile.write(body)
