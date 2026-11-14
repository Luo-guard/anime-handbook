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
    "reveal_in_folder", "redownload",
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
HIDEABLE_ACTIONS = {"play", "online_play", "download", "cancel_download", "delete",
                    "reveal_in_folder", "redownload"}
PLAYBACK_SOURCES = {"auto", "local", "online"}

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
    "Alt+Click": "reveal_in_folder",
}


def defaults() -> dict:
    """返回一份全新的默认配置，避免调用方拿到共享引用。"""
    return {
        "enabled": True,
        "keep_menu_on_release": True,
        "slots": dict(DEFAULT_SLOTS),
        "bindings": dict(DEFAULT_BINDINGS),
        "hidden_actions": [],
        "playback_source": "auto",
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
    hidden = value.get("hidden_actions", [])
    if not isinstance(hidden, list) or any(
        not isinstance(action, str) or action not in HIDEABLE_ACTIONS | {"open_detail"} for action in hidden
    ):
        raise ValueError("扇区入口设置无效")
    source = value.get("playback_source")
    if "playback_source" not in value:
        if "online_play" in hidden and "play" not in hidden:
            source = "local"
        elif "play" in hidden and "online_play" not in hidden:
            source = "online"
            hidden = [action for action in hidden if action != "play"]
        else:
            source = "auto"
    if not isinstance(source, str) or source not in PLAYBACK_SOURCES:
        raise ValueError("播放来源设置无效")
    result["playback_source"] = source
    result["hidden_actions"] = sorted(set(hidden) - {"online_play", "open_detail"})

    slots = value.get("slots", DEFAULT_SLOTS)
    if not isinstance(slots, dict) or set(slots) - set(SLOT_KEYS):
        raise ValueError("扇区方位无效")
    cleaned_slots = {}
    for key in SLOT_KEYS:
        item = slots.get(key, DEFAULT_SLOTS[key])
        if item in (None, "", "open_detail"):
            cleaned_slots[key] = ""  # 用户主动去掉这一格
        elif isinstance(item, str) and item in ACTIONS and item != "open_menu":
            cleaned_slots[key] = item
        else:
            raise ValueError("扇区动作无效")
    result["slots"] = cleaned_slots

    bindings = value.get("bindings", DEFAULT_BINDINGS)
    if not isinstance(bindings, dict):
        raise ValueError("手势绑定格式错误")
    # 只传了一部分绑定（外部 PATCH、旧客户端）时，没提到的键保留默认 —— 和上面
    # slots 的处理一致；真要解绑某个手势就显式传 ""。以前这里直接整表替换，
    # 传一个 {"Ctrl+Click": "play"} 会把右键/长按等默认绑定一起抹掉。
    bindings = {**DEFAULT_BINDINGS, **bindings}
    cleaned: dict[str, str] = {}
    counts: dict[str, int] = {}
    for gesture, action in bindings.items():
        if not isinstance(gesture, str) or not isinstance(action, str):
            raise ValueError("手势绑定格式错误")
        if action == "":
            if gesture in DEFAULT_BINDINGS:
                cleaned[gesture] = ""
            continue
        if gesture == "Click":
            raise ValueError("左键单击固定用于记录已看，不能改绑")
        if gesture not in GESTURES:
            raise ValueError(f"手势无效：{gesture}")
        if action == "open_detail":
            if gesture in DEFAULT_BINDINGS:
                cleaned[gesture] = ""
            continue
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
    return any(gesture.endswith("DoubleClick") and action
               for gesture, action in (value or {}).get("bindings", {}).items())


def action_for_gesture(value: dict, gesture: str) -> str:
    return (value or {}).get("bindings", {}).get(gesture, "")

# settings_service 里用的是带前缀的名字，避免和 shortcuts.normalize_shortcuts 混淆。
normalize_episode_gestures = normalize
