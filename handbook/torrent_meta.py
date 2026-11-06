"""从 .torrent 文件里读出 infohash 与名称。

不引第三方 BT 库。bencode 的 ``info`` 字典原始字节的 SHA1 就是 infohash，
这是 BT 协议的规定，所以自己扫一遍字典就能拿到那段字节。

有了 infohash，提交种子后就能用 ``/torrents/info?hashes=<hash>`` 精确认回
任务，不必依赖「按标签查」这种可能滞后或受格式影响的方式。
"""
from __future__ import annotations

import hashlib


class TorrentMetaError(ValueError):
    """种子文件不是合法 bencode。"""


def _skip_value(data: bytes, pos: int) -> int:
    """跳过 pos 处的一个完整 bencode 值，返回它后面那个位置。"""
    if pos >= len(data):
        raise TorrentMetaError("种子数据被截断")
    first = data[pos : pos + 1]
    if first == b"i":
        end = data.find(b"e", pos + 1)
        if end < 0:
            raise TorrentMetaError("整数没有结束符")
        return end + 1
    if first in (b"l", b"d"):
        is_dict = first == b"d"
        pos += 1
        while True:
            if pos >= len(data):
                raise TorrentMetaError("容器没有结束符")
            if data[pos : pos + 1] == b"e":
                return pos + 1
            if is_dict:
                pos = _skip_value(data, pos)  # 键
            pos = _skip_value(data, pos)  # 值（列表则是元素）
    if first.isdigit():
        colon = data.find(b":", pos)
        if colon < 0:
            raise TorrentMetaError("字符串缺少长度分隔符")
        length = int(data[pos:colon])
        end = colon + 1 + length
        if end > len(data):
            raise TorrentMetaError("字符串长度超出数据范围")
        return end
    raise TorrentMetaError(f"无法识别的 bencode 值：{first!r}")


def _items(data: bytes):
    """产出字典里每一项的 ``(键, 值起始, 值结束)``；值结束位置不含。"""
    if not data.startswith(b"d"):
        raise TorrentMetaError("不是 bencode 字典")
    pos = 1
    while pos < len(data) and data[pos : pos + 1] != b"e":
        colon = data.find(b":", pos)
        if colon < 0:
            raise TorrentMetaError("字典键格式错误")
        key_length = int(data[pos:colon])
        key = data[colon + 1 : colon + 1 + key_length]
        value_start = colon + 1 + key_length
        value_end = _skip_value(data, value_start)
        yield key, value_start, value_end
        pos = value_end


def _decode_string(raw: bytes) -> str:
    colon = raw.find(b":")
    if colon < 0:
        return ""
    return raw[colon + 1 :].decode("utf-8", "replace")


def torrent_infohash(payload: bytes) -> str:
    """返回小写十六进制的 40 位 infohash。"""
    data = bytes(payload or b"")
    for key, start, end in _items(data):
        if key == b"info":
            return hashlib.sha1(data[start:end]).hexdigest()
    raise TorrentMetaError("种子里没有 info 字典")


def torrent_name(payload: bytes) -> str:
    """读 info.name；解析不出来返回空串，调用方拿它当兜底即可。"""
    data = bytes(payload or b"")
    try:
        for key, start, end in _items(data):
            if key != b"info":
                continue
            info = data[start:end]
            for inner_key, inner_start, inner_end in _items(info):
                if inner_key == b"name":
                    return _decode_string(info[inner_start:inner_end])
    except (TorrentMetaError, ValueError, IndexError):
        return ""
    return ""
