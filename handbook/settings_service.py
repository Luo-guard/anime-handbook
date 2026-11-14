"""Settings schema/normalization and the single settings-update operation."""
from __future__ import annotations
from typing import Any
import re
import copy
from contextlib import ExitStack
import os
from .common import (CATEGORY_NAMES, normalize_schedule_grouping, normalize_detail_links, normalize_custom_search_links, normalize_link_sync, normalize_bgm_sources, windows_autostart_change)
from .shortcuts import normalize_shortcuts
from .episode_gestures import normalize_episode_gestures
from .metadata import SyncService

_SCHEDULE_SOURCES = ("yuc", "kazumi", "as")


def _normalize_schedule_preferences(value: Any) -> dict[str, Any]:
    """三套周表各自的排序/筛选；结构非法直接报错，错误会透给界面。"""
    if not isinstance(value, dict):
        raise ValueError("周表偏好无效")
    result: dict[str, Any] = {}
    for source in _SCHEDULE_SOURCES:
        raw = value.get(source)
        if raw is None:
            continue
        if not isinstance(raw, dict):
            raise ValueError("周表偏好无效")
        entry: dict[str, Any] = {}
        for key, item in raw.items():
            if key == "schedule_sort":
                if item not in ("time", "score", "popularity"):
                    raise ValueError("周表排列方式无效")
                entry[key] = item
            elif key == "schedule_grouping":
                entry[key] = normalize_schedule_grouping(item)
            elif key == "schedule_statuses":
                if not isinstance(item, list) or any(not isinstance(n, int) or not 1 <= n <= 5 for n in item):
                    raise ValueError("周表收藏状态筛选无效")
                entry[key] = list(dict.fromkeys(item))
            elif key == "schedule_origins":
                if not isinstance(item, list) or any(n not in {"jp", "cn", "us", "kr", "other", "unknown"} for n in item):
                    raise ValueError("周表地区筛选无效")
                entry[key] = list(dict.fromkeys(item))
            elif key == "schedule_uncollected":
                entry[key] = bool(item)
        result[source] = entry
    return result


def _normalize_schedule_hidden(value: Any) -> dict[str, list[int]]:
    """隐藏的番剧按周表来源分开存：在哪一套里隐藏，就只影响那一套。

    旧版本存的是扁平列表（三套通吃），这里兼容：读到列表就展开成三份，
    前端下一次保存会把嵌套结构固化下来。
    """
    def clean(items: Any) -> list[int]:
        if not isinstance(items, list):
            raise ValueError("隐藏番剧列表无效")
        cleaned: list[int] = []
        for item in items:
            number = int(item)
            if number > 0 and number not in cleaned:
                cleaned.append(number)
        return cleaned[:500]

    if isinstance(value, dict):
        return {source: clean(value.get(source, [])) for source in _SCHEDULE_SOURCES}
    if isinstance(value, list):
        shared = clean(value)
        return {source: list(shared) for source in _SCHEDULE_SOURCES}
    raise ValueError("隐藏番剧列表无效")


def _normalize_schedule_hidden_titles(value: Any) -> dict[str, list[str]]:
    """按标题隐藏的番剧，按周表来源分开存。

    有些条目（尤其 AnimeSchedule 的国漫）压根没有关联到 Bangumi，拿不到数字 ID，
    只靠 ``schedule_hidden`` 的 ID 列表就藏不掉。这里单独存一份标题，
    匹配时和 ID 列表取并集；标题按原样保存（去首尾空格、去重、截断），
    比较时再统一小写。
    """
    def clean(items: Any) -> list[str]:
        if not isinstance(items, list):
            raise ValueError("隐藏番剧标题列表无效")
        cleaned: list[str] = []
        seen: set[str] = set()
        for item in items:
            title = str(item or "").strip()
            if not title:
                continue
            folded = title.casefold()
            if folded in seen:
                continue
            seen.add(folded)
            cleaned.append(title[:120])
        return cleaned[:500]

    if isinstance(value, dict):
        return {source: clean(value.get(source, [])) for source in _SCHEDULE_SOURCES}
    if isinstance(value, list):
        shared = clean(value)
        return {source: list(shared) for source in _SCHEDULE_SOURCES}
    raise ValueError("隐藏番剧标题列表无效")


def _normalize_settings(body, settings):
    if not isinstance(body, dict): raise ValueError("设置内容需为 JSON 对象")
    settings = copy.deepcopy(settings)
    body = copy.deepcopy(body)
    allowed = {
        "keyboard_shortcuts",
        "episode_gestures",
        "day_start_hour",
        "show_episode_balance",
        "episode_balance_initial",
        "episode_balance_daily_target",
        "statistics_default_theme",
        "timeline_default_themes",
        "statistics_show_zero_periods",
        "show_watch_events",
        "show_note_events",
        "show_comment_events",
        "record_themes",
        "show_bgm_rating",
        "bgm_rating_link",
        "show_bgm_rating_in_collection",
        "show_collection_rating_control",
        "collection_rating_source",
        "collection_airing_source",
        "detail_airtime_source",
        "detail_layout",
        "detail_modern_original_title",
        "detail_modern_compact_credits",
        "hide_missing_as_schedule",
        "schedule_airing_source",
        "show_collection_progress_control",
        "show_create_collection_control",
        "show_collection_add_button",
        "collection_add_button_icon_only",
        "show_jump_history_button",
        "jump_history_button_icon_only",
        "show_age_related_button",
        "detail_links",
        "schedule_detail_links",
        "detail_link_sync",
        "custom_search_links",
        "show_bilibili_search_button",
        "show_search_bgm_link",
        "show_saved_video_list",
        "video_default_pinned",
        "merge_bilibili_links",
        "show_episode_titles_on_hover",
        "show_episode_review_record",
        "show_oped_record",
        "show_episode_rating_record",
        "show_character_tab",
        "bgm_sources",
        "active_bgm_source",
        "launch_at_login",
        "show_ranking_hover_titles",
        "ranking_hover_delay_seconds",
        "show_all_collection_tab",
        "builtin_collection_order",
        "collection_home",
        "collection_sort_modes",
        "collection_sort_directions",
        "new_record_defaults_to_other",
        "top_sync_action",
        "theme_color",
        "custom_theme_color",
        "custom_background_enabled",
        "custom_background_overlay_opacity",
        "active_theme_profile",
        "theme_random_on_open",
        "theme_weekly_plan_enabled",
        "theme_weekly_plan",
        "theme_profiles",
        "category_episode_visibility",
        "category_rating_visibility",
        "category_progress_visibility",
        "builtin_category_visibility",
        "hide_custom_collection_items_from_builtin",
        "show_custom_move_button_without_collections",
        "show_progress_bar",
        "show_sidebar_toggle",
        "show_shutdown_button",
        "default_view",
        "sidebar_visibility",
        "sidebar_order",
        "sidebar_labels",
        "kazumi_read_only",
        "webdav_kazumi_sync",
        "kazumi_writeback",
        "kazumi_conflict",
        "schedule_source",
        "show_schedule_source_switch",
        "schedule_sort",
        "schedule_grouping",
        "schedule_statuses",
        "schedule_origins",
        "schedule_uncollected",
        "schedule_preferences",
        "schedule_hidden",
        "schedule_hidden_titles",
        "schedule_card_fields",
        "auto_open_offline_enabled",
        "auto_open_offline_collections",
        "library_sidebar",
    }
    balance_initial = (
        int(body["episode_balance_initial"])
        if "episode_balance_initial" in body
        else None
    )
    balance_daily_target = (
        min(100, max(0, int(body["episode_balance_daily_target"])))
        if "episode_balance_daily_target" in body
        else None
    )
    pending_settings: dict[str, Any] = {}
    for key, value in body.items():
        if key in allowed:
            boolean_key = key.startswith(("show_", "hide_")) or key.endswith("_enabled") or key in {
                "schedule_uncollected", "theme_random_on_open", "theme_weekly_plan_enabled", "new_record_defaults_to_other",
                "kazumi_read_only", "webdav_kazumi_sync", "kazumi_writeback", "merge_bilibili_links", "video_default_pinned",
                "collection_add_button_icon_only", "jump_history_button_icon_only", "statistics_show_zero_periods", "launch_at_login",
            }
            if boolean_key and type(value) is not bool:
                raise ValueError("设置开关必须为布尔值")
            if key in {
                "episode_balance_initial",
                "episode_balance_daily_target",
            }:
                continue
            if key in {"collection_airing_source", "schedule_airing_source"}:
                if not isinstance(value, str) or value not in {"bgm", "as"}:
                    raise ValueError("已播集数来源无效")
            elif key == "detail_layout":
                if not isinstance(value, str) or value not in {"classic", "modern"}:
                    raise ValueError("番剧详情布局无效")
            elif key in {"detail_modern_original_title", "detail_modern_compact_credits"}:
                if type(value) is not bool:
                    raise ValueError("番剧详情显示选项无效")
            elif key == "detail_airtime_source":
                if not isinstance(value, str) or value not in {"yuc", "as"}:
                    raise ValueError("详情更新时间来源无效")
            elif key == "schedule_grouping":
                value = normalize_schedule_grouping(value)
            elif key == "kazumi_read_only":
                if type(value) is not bool:
                    raise ValueError("只读开关无效")
            elif key == "webdav_kazumi_sync":
                if type(value) is not bool:
                    raise ValueError("Kazumi 云端推送开关无效")
            elif key == "kazumi_writeback":
                if type(value) is not bool:
                    raise ValueError("写回开关无效")
            elif key == "kazumi_conflict":
                if value not in {"handbook", "kazumi"}:
                    raise ValueError("冲突优先级无效")
            elif key == "schedule_source":
                if not isinstance(value, str) or value not in {"yuc", "kazumi", "as"}:
                    raise ValueError("周表来源无效")
            elif key == "show_schedule_source_switch":
                value = bool(value)
            elif key == "schedule_sort":
                if value not in {"time", "score", "popularity"}:
                    raise ValueError("周表排序无效")
            elif key == "schedule_card_fields":
                fields = {"tags", "votes", "release", "score", "collection", "airtime", "progress"}
                if not isinstance(value, dict) or any(item not in fields or type(flag) is not bool for item, flag in value.items()):
                    raise ValueError("周表卡片显示设置无效")
                value = {**settings.get(key, {}), **value}
            elif key == "schedule_statuses":
                if not isinstance(value, list) or any(type(item) is not int or item not in {1, 2, 3, 4, 5} for item in value):
                    raise ValueError("周表收藏状态无效")
                value = list(dict.fromkeys(value))
            elif key == "schedule_origins":
                # unknown 是「Bangumi 没标国家」的那一档，和空 origin 一一对应。
                if not isinstance(value, list) or any(item not in {"jp", "cn", "us", "kr", "other", "unknown"} for item in value):
                    raise ValueError("周表地区筛选无效")
                value = list(dict.fromkeys(value))
            elif key == "schedule_uncollected":
                value = bool(value)
            elif key == "schedule_preferences":
                value = _normalize_schedule_preferences(value)
            elif key == "schedule_hidden":
                value = _normalize_schedule_hidden(value)
            elif key == "schedule_hidden_titles":
                value = _normalize_schedule_hidden_titles(value)
            elif key == "day_start_hour":
                value = min(23, max(0, int(value)))
            elif key == "show_episode_balance":
                value = bool(value)
            elif key == "episode_balance_initial":
                value = int(value)
            elif key == "episode_balance_daily_target":
                value = min(100, max(0, int(value)))
            elif key == "keyboard_shortcuts":
                value = normalize_shortcuts(value)
            elif key == "episode_gestures":
                value = normalize_episode_gestures(value)
            elif key == "statistics_default_theme":
                value = str(value or "watch").strip() or "watch"
            elif key == "timeline_default_themes":
                if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
                    raise ValueError("默认展示记录无效")
                value = list(dict.fromkeys(item.strip()[:40] for item in value if item.strip()))[:40]
            elif key in {
                "category_episode_visibility",
                "category_rating_visibility",
                "category_progress_visibility",
                "builtin_category_visibility",
            }:
                current = settings.get(key, {})
                if not isinstance(current, dict):
                    current = {}
                if not isinstance(value, dict):
                    raise ValueError("收藏夹可见设置格式错误")
                current.update(
                    {
                        str(item_key): bool(item_value)
                        for item_key, item_value in value.items()
                    }
                )
                value = current
            elif key == "hide_custom_collection_items_from_builtin":
                value = bool(value)
            elif key == "show_custom_move_button_without_collections":
                value = bool(value)
            elif key == "library_sidebar":
                value = str(value or "show")
                if value not in ("show", "hide", "auto"):
                    raise ValueError("动漫库侧边栏取值无效")
            elif key == "auto_open_offline_collections":
                if not isinstance(value, list):
                    raise ValueError("触发的收藏夹需为列表")
                cleaned: list[str] = []
                for item in value:
                    text = str(item).strip()
                    if text and text not in cleaned:
                        cleaned.append(text)
                value = cleaned[:20]
            elif key == "show_progress_bar":
                value = bool(value)
            elif key in {"show_sidebar_toggle", "show_shutdown_button", "statistics_show_zero_periods"}:
                value = bool(value)
            elif key == "new_record_defaults_to_other":
                value = bool(value)
            elif key == "show_bgm_rating":
                value = bool(value)
            elif key == "bgm_rating_link":
                value = bool(value)
            elif key == "show_bgm_rating_in_collection":
                value = bool(value)
            elif key == "show_age_related_button":
                value = bool(value)
            elif key == "custom_search_links":
                value = normalize_custom_search_links(value)
            elif key == "detail_links":
                value = normalize_detail_links(value)
            elif key == "schedule_detail_links":
                value = normalize_detail_links(value)
            elif key == "detail_link_sync":
                value = normalize_link_sync(value)
            elif key in {"show_collection_add_button", "collection_add_button_icon_only", "show_jump_history_button", "jump_history_button_icon_only"}:
                value = bool(value)
            elif key in {"show_bilibili_search_button", "show_search_bgm_link", "show_saved_video_list", "merge_bilibili_links", "video_default_pinned"}:
                value = bool(value)
            elif key in {"show_episode_titles_on_hover", "hide_missing_as_schedule"}:
                value = bool(value)
            elif key == "bgm_sources":
                value = normalize_bgm_sources(value)
            elif key == "active_bgm_source":
                value = str(value or "").strip()
            elif key in {
                "show_episode_review_record",
                "show_oped_record",
                "show_episode_rating_record",
                "show_character_tab",
                "launch_at_login",
            }:
                value = bool(value)
            elif key == "show_ranking_hover_titles":
                value = bool(value)
            elif key == "ranking_hover_delay_seconds":
                value = min(10, max(0, int(value)))
            elif key == "show_all_collection_tab":
                value = bool(value)
            elif key == "builtin_collection_order":
                if not isinstance(value, list):
                    raise ValueError("收藏夹顺序格式错误")
                ordered = [int(item) for item in value if int(item) in CATEGORY_NAMES]
                value = ordered + [item for item in CATEGORY_NAMES if item not in ordered]
            elif key == "collection_home":
                value = str(value)
                if value != "all" and not re.fullmatch(
                    r"(?:builtin|custom):\d+", value
                ):
                    raise ValueError("收藏夹主页无效")
            elif key == "collection_sort_modes":
                if not isinstance(value, dict):
                    raise ValueError("收藏排序格式错误")
                valid_modes = {
                    "name", "rank", "popularity", "airdate",
                    "latest", "kazumi", "custom",
                }
                value = {
                    str(k): str(v)
                    for k, v in value.items()
                    if str(v) in valid_modes
                }
            elif key == "collection_sort_directions":
                if not isinstance(value, dict):
                    raise ValueError("收藏排序方向格式错误")
                value = {
                    str(k): str(v)
                    for k, v in value.items()
                    if str(v) in {"asc", "desc"}
                }
            elif key == "theme_color":
                if value not in {
                    "forest", "ocean", "violet", "amber", "rose",
                    "indigo", "teal", "slate", "custom",
                }:
                    raise ValueError("主题颜色无效")
            elif key == "custom_theme_color":
                value = str(value).strip()
                if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
                    raise ValueError("自定义颜色应为 6 位 HEX 色值，例如 #2E6D4E")
            elif key == "custom_background_enabled":
                value = bool(value)
            elif key == "custom_background_overlay_opacity":
                value = min(100, max(0, int(value)))
            elif key == "top_sync_action":
                if value not in {"webdav", "kazumi"}:
                    raise ValueError("同步按钮功能无效")
            elif key == "default_view":
                if value not in {"collection", "library", "schedule", "timeline", "statistics", "ranking"}:
                    raise ValueError("默认主页无效")
            elif key == "record_themes":
                if not isinstance(value, list):
                    raise ValueError("记录主题格式错误")
                value = [
                    {"id": str(item.get("id") or ""), "name": str(item.get("name") or ""), "color": str(item.get("color") or "#7c8790"), "builtin": bool(item.get("builtin", False))}
                    for item in value
                    if isinstance(item, dict) and str(item.get("id") or "") and str(item.get("name") or "")
                ]
            elif key == "theme_profiles":
                if not isinstance(value, list):
                    raise ValueError("主题方案格式错误")
                value = [item for item in value if isinstance(item, dict) and item.get("id") and item.get("name")]
            elif key == "active_theme_profile":
                value = str(value or "default")
            elif key == "theme_random_on_open":
                value = bool(value)
            elif key == "theme_weekly_plan_enabled":
                value = bool(value)
            elif key == "theme_weekly_plan":
                if not isinstance(value, dict):
                    raise ValueError("周计划格式错误")
                plan = {}
                for day in range(1, 8):
                    item = value.get(str(day), "")
                    if item in (None, ""):
                        plan[str(day)] = ""
                    elif isinstance(item, str):
                        plan[str(day)] = item.strip()[:64]
                    else:
                        raise ValueError("周计划格式错误")
                value = plan
            elif key == "collection_rating_source":
                if value not in {"bgm", "personal"}:
                    raise ValueError("评分来源无效")
            elif key == "sidebar_visibility":
                if not isinstance(value, dict):
                    raise ValueError("侧边栏显示设置格式错误")
                current = settings.get(key, {})
                if not isinstance(current, dict):
                    current = {}
                current.update(
                    {
                        item: bool(value.get(item, True))
                        for item in {"collection", "schedule", "timeline", "statistics", "ranking", "settings"}
                        if item in value
                    }
                )
                current["settings"] = True
                value = current
            elif key == "sidebar_labels":
                if not isinstance(value, dict):
                    raise ValueError("页面名称设置格式错误")
                labels = {}
                for page in ("collection", "library", "schedule", "timeline", "statistics", "ranking"):
                    name = value.get(page, "")
                    if not isinstance(name, str) or len(name.strip()) > 20 or any(ord(c) < 32 for c in name):
                        raise ValueError("页面名称需为不超过 20 个字符的文字")
                    if name.strip():
                        labels[page] = name.strip()
                value = labels
            elif key == "sidebar_order":
                if not isinstance(value, list):
                    raise ValueError("侧边栏顺序格式错误")
                # 「媒体库」也要能排序：它由独立的三态开关控制显隐，但顺序跟其它页面一样存这里。
                # 早先白名单里没有 library，前端怎么拖都会被这段过滤回原位 —— 用户看到的
                # 「上移下移不生效」就是这个原因。
                allowed_items = {"collection", "library", "schedule", "timeline", "statistics", "ranking", "settings"}
                ordered = [item for item in value if item in allowed_items]
                value = ordered + [
                    item for item in ["collection", "library", "schedule", "timeline", "statistics", "ranking", "settings"]
                    if item not in ordered
                ]
            pending_settings[key] = value
    return pending_settings, balance_initial, balance_daily_target

def normalize_settings(body, settings):
    try:
        return _normalize_settings(body, settings)
    except (TypeError, OverflowError) as error:
        raise ValueError("设置内容格式不正确") from error


def _save_settings_values(self, body, effects):
    pending_settings, balance_initial, balance_daily_target = normalize_settings(body, self.database.get_settings())
    # 收集完一次写入：逐键提交时 61 个键要开 61 次连接、61 个事务。
    self.database.set_settings(pending_settings)
    self.database.update_episode_balance_settings(
        initial=balance_initial,
        daily_target=balance_daily_target,
    )
    if "bgm_sources" in body or "active_bgm_source" in body:
        settings = self.database.get_settings()
        sources = normalize_bgm_sources(settings.get("bgm_sources"))
        active_id = str(settings.get("active_bgm_source") or "")
        active = next((item for item in sources if item["id"] == active_id), sources[0])
        self.database.set_setting("active_bgm_source", active["id"])
        self.database.set_setting("bgm_api_base", active["api_base"])
        self.database.set_setting("bgm_site_base", active["site_base"])
    if "launch_at_login" in body:
        settings = self.database.get_settings()
        local_kazumi = SyncService.find_kazumi_database()
        bound_kazumi = str(settings.get("bound_kazumi_path") or "")
        # A profile receives its binding only once. In a future shared
        # setup, another profile with a different binding can update its
        # own preference without removing this machine's launcher.
        if not bound_kazumi and local_kazumi:
            bound_kazumi = str(local_kazumi)
            self.database.set_setting("bound_kazumi_path", bound_kazumi)
        matches_local = bool(
            local_kazumi
            and bound_kazumi
            and os.path.normcase(os.path.abspath(str(local_kazumi)))
            == os.path.normcase(os.path.abspath(bound_kazumi))
        )
        if matches_local:
            active = effects.enter_context(windows_autostart_change(
                bool(settings.get("launch_at_login"))
            ))
            self.database.set_setting("autostart_active", active)
        else:
            # Never alter the computer's launcher for a profile bound to
            # another Kazumi database.
            self.database.set_setting("autostart_active", False)
    return {
        "ok": True,
        "settings": self.database.get_settings(),
        "stats": self.database.stats(),
        "animes": self.database.list_anime(),
        "custom_collections": self.database.list_custom_collections(),
    }


def save_settings(self, body):
    # External launcher changes remain reversible until the DB commit succeeds.
    # Build the reply inside the transaction too: a failed stats/list query must
    # not turn a rejected save into partially persisted settings.
    with ExitStack() as effects:
        with self.database.transaction():
            response = _save_settings_values(self, body, effects)
    self.send_json(response)
