"""Validation for account-specific keyboard bindings (defaults live in keyboard.js)."""
import re

APP_ACTIONS = {"collection", "library", "schedule", "timeline", "statistics", "ranking", "settings", "previous", "next", "sidebar", "shutdown", "search", "new_record", "new_ranking", "refresh_schedule", "filter"}
# 播放器快捷键（与键盘模块里的 scope=player 一一对应；和全局动作各自一套命名空间，
# 所以 Space / 1 / 2 / 3 这类同键不算冲突）。
PLAYER_ACTIONS = {
    "player_play_pause", "player_rewind", "player_forward", "player_volume_up", "player_volume_down",
    "player_mute", "player_fullscreen", "player_danmaku", "player_screenshot", "player_prev",
    "player_next", "player_skip", "player_speed_down", "player_speed_up",
    "player_speed_1", "player_speed_2", "player_speed_3",
}
ACTIONS = APP_ACTIONS | PLAYER_ACTIONS
MAX_KEYS_PER_ACTION = 8


def _valid_key(key: str) -> bool:
    parts = key.split("+")
    modifiers = parts[:-1]
    base = parts[-1]
    valid_base = (
        (len(base) == 1 and base.isascii() and base.isprintable() and base not in {" ", "+"})
        or base in {"MouseBack", "MouseForward", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Escape", "Space", "Backspace", "Delete"}
        or re.fullmatch(r"F(?:[1-9]|1[0-2])", base)
    )
    return bool(valid_base) and modifiers == [m for m in ["Ctrl", "Alt", "Shift", "Meta"] if m in modifiers]


def normalize_shortcuts(value):
    if not isinstance(value, dict) or not isinstance(value.get("enabled", True), bool):
        raise ValueError("快捷键设置格式错误")
    bindings = value.get("bindings", {})
    if not isinstance(bindings, dict) or set(bindings) - ACTIONS:
        raise ValueError("快捷键操作无效")
    result = {}
    used = {}
    for action, item in bindings.items():
        if not isinstance(item, dict) or not isinstance(item.get("enabled"), bool):
            raise ValueError("快捷键格式错误")
        raw = item.get("keys")
        if raw is None:
            # 兼容旧版本只保存单个 key 的结构。
            legacy = item.get("key", "")
            if not isinstance(legacy, str):
                raise ValueError("快捷键格式错误")
            raw = [legacy] if legacy else []
        if not isinstance(raw, list) or any(not isinstance(key, str) for key in raw):
            raise ValueError("快捷键格式错误")
        keys = []
        for key in raw:
            if key and key not in keys:
                keys.append(key)
        if len(keys) > MAX_KEYS_PER_ACTION:
            raise ValueError(f"每个操作最多绑定 {MAX_KEYS_PER_ACTION} 个按键")
        for key in keys:
            if not _valid_key(key):
                raise ValueError("快捷键按键无效")
        if item["enabled"]:
            # 全局和播放器分开查重：同一个键可以既是导航键又是播放器键。
            bucket = used.setdefault("player" if action in PLAYER_ACTIONS else "app", set())
            for key in keys:
                if key in bucket:
                    raise ValueError("启用的快捷键不能重复")
                bucket.add(key)
        result[action] = {"enabled": item["enabled"], "keys": keys}
    return {"enabled": value.get("enabled", True), "bindings": result}
