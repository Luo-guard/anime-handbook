"""Common HTTP framing, request validation and conditional asset responses."""
import gzip
import hashlib
import json

from .common import MAX_JSON_BODY_BYTES


class RequestProblem(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


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
        value = json.loads(raw.decode("utf-8"))
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
