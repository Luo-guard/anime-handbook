"""单集格子手势绑定表的校验（与全局键盘快捷键完全分开）。

设计上刻意让两张表互不查重：全局的 ``Ctrl+P`` 和格子上的 ``Ctrl+左键``
作用域不同，混在一张表里会互相误报冲突。

左键单击固定为「切换已看」，不进绑定表 —— 它是最高频操作，一旦被改绑，
用户又没给「已看」留别的触发方式，等于把这个功能弄丢了。
"""
from __future__ import annotations

import copy

# 允许被绑定的动作。open_menu 是「打开六格扇区」，其余是扇区或手势直接触发。
ACTIONS = {
    "open_menu", "play", "download", "cancel_download", "delete",
    "score", "review", "op", "ed",
    "open_detail", "reveal_in_folder", "redownload",
}
BASE_GESTURES = {
    "DoubleClick", "RightClick", "LongClick", "LongRightClick", "MiddleClick",
}
MODIFIER_PREFIXES = (
    "", "Ctrl+", "Alt+", "Shift+", "Ctrl+Shift+", "Ctrl+Alt+",
    "Alt+Shift+", "Ctrl+Alt+Shift+",
)
GESTURES = {prefix + base for prefix in MODIFIER_PREFIXES for base in BASE_GESTURES}
# 裸左键单击归「切换已看」，不允许绑定；带修饰键的左键单击可以。
for _prefix in MODIFIER_PREFIXES[1:]:
    GESTURES.add(_prefix + "Click")

MAX_GESTURES_PER_ACTION = 4
SLOT_KEYS = ("top", "bottom", "top_right", "bottom_right", "top_left", "bottom_left")

DEFAULT_SLOTS = {
    "top": "play",
    "bottom": "download",
    "top_right": "score",
    "bottom_right": "review",
    "top_left": "ed",
    "bottom_left": "op",
}
DEFAULT_BINDINGS = {
    "RightClick": "open_menu",
    "LongClick": "open_menu",
    "Ctrl+Click": "open_detail",
    "Alt+Click": "reveal_in_folder",
}


def defaults() -> dict:
    """返回一份全新的默认配置，避免调用方拿到共享引用。"""
    return {
        "enabled": True,
        "keep_menu_on_release": True,
        "slots": dict(DEFAULT_SLOTS),
        "bindings": dict(DEFAULT_BINDINGS),
    }


def normalize(value) -> dict:
    """校验并补齐单集手势设置；非法输入一律抛 ValueError 交给接口转成 400。"""
    if not isinstance(value, dict):
        raise ValueError("单集手势设置格式错误")
    result = defaults()
    enabled = value.get("enabled", True)
    keep = value.get("keep_menu_on_release", True)
    if not isinstance(enabled, bool) or not isinstance(keep, bool):
        raise ValueError("单集手势开关无效")
    result["enabled"] = enabled
    result["keep_menu_on_release"] = keep

    slots = value.get("slots", DEFAULT_SLOTS)
    if not isinstance(slots, dict) or set(slots) - set(SLOT_KEYS):
        raise ValueError("扇区方位无效")
    cleaned_slots = {}
    for key in SLOT_KEYS:
        item = slots.get(key, DEFAULT_SLOTS[key])
        if item is None or item == "":
            cleaned_slots[key] = ""  # 用户主动去掉这一格
        elif isinstance(item, str) and item in ACTIONS and item != "open_menu":
            cleaned_slots[key] = item
        else:
            raise ValueError("扇区动作无效")
    result["slots"] = cleaned_slots

    bindings = value.get("bindings", DEFAULT_BINDINGS)
    if not isinstance(bindings, dict):
        raise ValueError("手势绑定格式错误")
    cleaned: dict[str, str] = {}
    counts: dict[str, int] = {}
    for gesture, action in bindings.items():
        if not isinstance(gesture, str) or not isinstance(action, str):
            raise ValueError("手势绑定格式错误")
        if action == "":
            continue  # 空值表示该手势解绑
        if gesture == "Click":
            raise ValueError("左键单击固定用于记录已看，不能改绑")
        if gesture not in GESTURES:
            raise ValueError(f"手势无效：{gesture}")
        if action not in ACTIONS:
            raise ValueError(f"单集动作无效：{action}")
        cleaned[gesture] = action
        counts[action] = counts.get(action, 0) + 1
        if counts[action] > MAX_GESTURES_PER_ACTION:
            raise ValueError(f"同一个动作最多绑定 {MAX_GESTURES_PER_ACTION} 个手势")
    result["bindings"] = cleaned
    return copy.deepcopy(result)


def double_click_bound(value: dict) -> bool:
    """是否绑定了双击 —— 前端据此决定是否给单击加 250ms 判定延迟。"""
    return any(gesture.endswith("DoubleClick") for gesture in (value or {}).get("bindings", {}))


def action_for_gesture(value: dict, gesture: str) -> str:
    return (value or {}).get("bindings", {}).get(gesture, "")

# settings_service 里用的是带前缀的名字，避免和 shortcuts.normalize_shortcuts 混淆。
normalize_episode_gestures = normalize
