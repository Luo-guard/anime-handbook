"""Install KazumiRules and resolve episodes from the selected local rule."""
from __future__ import annotations

import io
import json
import ssl
import re
import tempfile
import threading
import time
import zipfile
from uuid import uuid4
from http.client import HTTPException
from pathlib import Path
from urllib.parse import quote, urlencode, urljoin, urlsplit

from . import link_rules, playback_stream, xifan_preview
from .common import DATA_ROOT
from .http_support import RequestProblem
from .playback_network import public_url, request_public

PREFIX = playback_stream.PLAYBACK_PREFIX
_LOCK = threading.Lock()
_CATALOGUE_LOCK = threading.Lock()
_REMOTE = {}
_REMOTE_EXPIRES = 0
_CATALOGUES = {}
_RULE_ID = re.compile(r"[a-z0-9_-]{1,48}")
_MAX_RULE = 128 * 1024
_MAX_RESPONSE = 4 * 1024 * 1024
_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


def rule_folder():
    return DATA_ROOT / "playback-rules"


def supported(rule):
    if not isinstance(rule, dict) or rule.get("type", "anime") != "anime":
        return False
    if rule.get("deprecated") or rule.get("useNativePlayer") is False or rule.get("usePost"):
        return False
    try:
        if not isinstance(rule.get("baseURL"), str):
            return False
        public_url(rule["baseURL"])
    except (KeyError, TypeError, RequestProblem):
        return False
    if rule.get("searchMode") == "api":
        search_ok = isinstance(rule.get("searchApiConfig"), dict)
    else:
        search_ok = all(rule.get(field) for field in ("searchURL", "searchList", "searchName", "searchResult"))
    if rule.get("chapterMode") == "api":
        config = rule.get("chapterApiConfig")
        chapter_ok = isinstance(config, dict) and config.get("format") in ("nested", "delimited")
    else:
        chapter_ok = all(rule.get(field) for field in ("chapterRoads", "chapterResult"))
    return search_ok and chapter_ok


def extract_archive(raw):
    rules = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for entry in archive.infolist():
            path = Path(entry.filename)
            rule_id = path.stem.lower()
            if (entry.filename.count("/") != 1 or path.suffix != ".json" or
                    not _RULE_ID.fullmatch(rule_id) or rule_id.startswith("custom-") or entry.file_size > _MAX_RULE):
                continue
            try:
                rule = json.loads(archive.read(entry))
            except (UnicodeError, ValueError):
                continue
            if supported(rule):
                rules[rule_id] = {key: value for key, value in rule.items() if not key.startswith("_handbook_")}
    return rules


def remote_rules(*, refresh=False):
    global _REMOTE, _REMOTE_EXPIRES
    with _CATALOGUE_LOCK:
        if not refresh and _REMOTE and time.monotonic() < _REMOTE_EXPIRES:
            return _REMOTE
        try:
            rules = extract_archive(link_rules.fetch_archive(timeout=12))
        except (link_rules.RuleFetchError, zipfile.BadZipFile, RuntimeError):
            raise RequestProblem("暂时连不上 KazumiRules，请稍后重试", 502) from None
        if not rules:
            raise RequestProblem("KazumiRules 暂无兼容规则", 502)
        _REMOTE, _REMOTE_EXPIRES = rules, time.monotonic() + 600
        return rules


def rule_path(rule_id):
    if not isinstance(rule_id, str) or not _RULE_ID.fullmatch(rule_id):
        raise RequestProblem("规则编号无效")
    return rule_folder() / f"{rule_id}.json"


def installed_rule(rule_id):
    try:
        rule = json.loads(rule_path(rule_id).read_bytes())
    except (OSError, UnicodeError, ValueError):
        rule = None
    if not supported(rule):
        raise RequestProblem("请先下载这个播放规则", 404, "rule_missing")
    return rule


def _newer_rule(local, remote):
    versions = []
    for rule in (local, remote):
        version = str(rule.get("version") or "").strip()
        if not re.fullmatch(r"[vV]?[0-9]{1,9}(?:\.[0-9]{1,9}){0,7}", version):
            return False
        parts = [int(part) for part in version.lstrip("vV").split(".")]
        versions.append(tuple(parts + [0] * (8 - len(parts))))
    return versions[1] > versions[0]


def _display_name(rule_id, rule):
    return rule.get("_handbook_name") or str(rule.get("name") or rule_id)


def _preferred_rule():
    try:
        value = json.loads((rule_folder() / ".preferences").read_bytes())
        return value if isinstance(value, str) else ""
    except (OSError, ValueError):
        return ""


def rule_list(remote=False, *, refresh=False):
    installed = {}
    for path in rule_folder().glob("*.json"):
        try:
            installed[path.stem] = installed_rule(path.stem)
        except RequestProblem:
            continue
    available = (remote_rules(refresh=True) if refresh else remote_rules()) if remote else {}
    rules = {**available, **installed}
    preferred = _preferred_rule()
    return {"default_rule": preferred if preferred == "manual" or preferred in installed else "", "items": [
        {"id": rule_id, "name": _display_name(rule_id, rule), "custom": rule_id.startswith("custom-") and rule_id in installed,
         "host": urlsplit(rule["baseURL"]).hostname, "version": str(rule.get("version", "")),
         "available_version": str(available.get(rule_id, {}).get("version", "")),
         "installed": rule_id in installed,
         "update": rule_id in installed and not rule_id.startswith("custom-") and rule_id in available and _newer_rule(rule, available[rule_id])}
        for rule_id, rule in sorted(rules.items(), key=lambda pair: (pair[0] not in installed, pair[0]))
    ]}


def change_rule(rule_id, action, *, name=None, config=None):
    if action == "default":
        with _LOCK:
            if rule_id not in ("", "manual"):
                installed_rule(rule_id)
            _write_rule(rule_folder() / ".preferences", rule_id)
        return rule_list()
    if action == "create":
        rule_id = f"custom-{uuid4().hex}"
    path = rule_path(rule_id)
    if action == "rename" and not isinstance(name, str):
        raise RequestProblem("请输入显示名称")
    if action in ("rename", "create") and name is not None and (not isinstance(name, str) or len(name.strip()) > 80):
        raise RequestProblem("规则名称最多 80 个字符")
    rule = None
    if action in ("install", "update"):
        if rule_id.startswith("custom-"):
            raise RequestProblem("自定义规则由你手动编辑")
        rule = remote_rules().get(rule_id)
        if not rule:
            raise RequestProblem("该规则已不在兼容规则目录中", 404)
    elif action in ("create", "edit"):
        if not rule_id.startswith("custom-"):
            raise RequestProblem("只能编辑自定义规则")
        if not isinstance(config, str) or len(config.encode("utf-8", errors="replace")) > _MAX_RULE:
            raise RequestProblem("规则 JSON 不能超过 128 KB")
        try:
            rule = json.loads(config)
        except (ValueError, RecursionError):
            raise RequestProblem("请输入有效的规则 JSON") from None
        if not supported(rule) or any(
            key in rule and not isinstance(rule[key], str)
            for key in ("name", "version", "searchURL", "searchList", "searchName",
                        "searchResult", "chapterRoads", "chapterResult", "userAgent", "referer")
        ):
            raise RequestProblem("规则缺少有效网址、搜索或选集配置，或使用了当前播放器不支持的模式")
        rule = {key: value for key, value in rule.items() if not key.startswith("_handbook_")}
        if action == "create" and name and name.strip():
            rule["_handbook_name"] = name.strip()
    elif action not in ("remove", "rename"):
        raise RequestProblem("规则操作无效")
    with _LOCK:
        if action == "remove":
            path.unlink(missing_ok=True)
            if _preferred_rule() == rule_id:
                _write_rule(rule_folder() / ".preferences", "")
        elif action == "rename":
            local = installed_rule(rule_id)
            local.pop("_handbook_name", None)
            if name.strip():
                local["_handbook_name"] = name.strip()
            _write_rule(path, local)
        elif action in ("create", "edit"):
            if action == "edit":
                local = installed_rule(rule_id)
                if alias := local.get("_handbook_name"):
                    rule["_handbook_name"] = alias
            _write_rule(path, rule)
        else:
            try:
                local = installed_rule(rule_id)
            except RequestProblem as error:
                if action == "update" or error.status != 404:
                    raise
                local = None
            if local is not None and not _newer_rule(local, rule):
                if action == "update":
                    raise RequestProblem("当前规则已是最新版本")
                return rule_list()
            if local:
                # 规则更新只覆盖站点自带的内容，本地补的扩展（别名、站点接口细节）要留住，
                # 否则更新一次规则，这些站点就退化回「按位置编号 + 浏览器嗅探」。
                extras = {key: value for key, value in local.items() if key.startswith("_handbook_")}
                if extras:
                    rule = {**rule, **extras}
            _write_rule(path, rule)
        for key in [key for key in _CATALOGUES if key[0] == rule_id]:
            del _CATALOGUES[key]
    return rule_list()


def _write_rule(path, rule):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
            temporary = Path(file.name)
            file.write(json.dumps(rule, ensure_ascii=False).encode("utf-8"))
        temporary.replace(path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def _read(url, headers, *, method="GET", body=None):
    # 偶发的连接被重置很常见（尤其连着搜几个词时），重试一次就过去了；
    # 真连不上再报错，别让用户看到一次抖动就得自己再点一遍。
    for attempt in range(2):
        try:
            with request_public(url, method=method, headers=headers, body=body) as (response, final_url):
                if response.status != 200:
                    # 403/503 有时是 Cloudflare 的验证页：先看一眼正文，别把它当「站点坏了」。
                    if _is_challenge(response.read(65536)):
                        raise _challenge_problem()
                    # 404 是「站点上没有这一页」，5xx/403 更像站点本身出问题，分开给前端。
                    code = "not_found" if response.status == 404 else "site_unreachable"
                    raise RequestProblem(f"片源站点返回 HTTP {response.status}", 502, code)
                raw = response.read(_MAX_RESPONSE + 1)
                if len(raw) > _MAX_RESPONSE:
                    raise RequestProblem("片源站点返回的资料过大", 502)
                return raw, final_url
        except ssl.SSLCertVerificationError:
            # 站点少发中间证书：Python 校验证书链失败，而浏览器/curl 会自动补链。
            # 这不是网络问题，别让用户去查自己的网。
            raise RequestProblem(
                "站点少发了中间证书，证书链不完整",
                502, "site_certificate",
            ) from None
        except (OSError, HTTPException):
            if attempt == 0:
                time.sleep(0.25)
                continue
            raise RequestProblem("片源站点连接失败，请重试或切换规则", 502, "site_unreachable") from None


_PLACEHOLDER = re.compile(r"@(keyword|source|episodeUrl)\b")


def _template(value, values, *, encode=False):
    if not isinstance(value, str):
        return value
    if not encode and value in values:
        return values[value]
    def substitute(match):
        replacement = str(values[match[0]])
        return quote(replacement, safe="") if encode else replacement

    return _PLACEHOLDER.sub(substitute, value)


def _with_query(url, query, values):
    if not query:
        return url
    pairs = {key: _template(value, values) for key, value in query.items()}
    return url + ("&" if "?" in url else "?") + urlencode({
        key: str(value).lower() if isinstance(value, bool) else value for key, value in pairs.items()
    })


def _headers(rule):
    headers = {"User-Agent": rule.get("userAgent") or _AGENT, "Accept-Encoding": "identity"}
    if rule.get("referer"):
        headers["Referer"] = rule["referer"]
    return headers


def _api(rule, config, values):
    request = config["request"]
    headers = {**_headers(rule), **(request.get("headers") or {})}
    url = _with_query(_template(request["url"], values, encode=True), request.get("query"), values)
    method = request.get("method", "GET").upper()
    body = None
    if method == "POST" and request.get("bodyType", "json") == "json":
        headers["Content-Type"] = "application/json"
        body = json.dumps({key: _template(value, values) for key, value in request.get("body", {}).items()}).encode()
    elif method != "GET":
        raise RequestProblem("此规则的接口请求格式暂未支持", 502, "site_changed")
    raw = _read(url, headers, method=method, body=body)[0]
    if _is_challenge(raw):
        raise _challenge_problem()
    try:
        return json.loads(raw)
    except (UnicodeError, json.JSONDecodeError):
        raise RequestProblem("站点没有返回可读取的 JSON 数据", 502, "site_changed") from None


def _json_nodes(document, path):
    if not path or path == "$":
        return [document]
    if not re.fullmatch(r"\$(?:\.[\w-]+|\[\*\])+", path):
        raise RequestProblem("此规则的 JSONPath 格式暂未支持", 502, "site_changed")
    nodes = [document]
    for name in re.findall(r"\.([\w-]+)|\[\*\]", path):
        if name:
            nodes = [node[name] for node in nodes if isinstance(node, dict) and name in node]
        else:
            nodes = [item for node in nodes if isinstance(node, list) for item in node]
    return nodes


def _value(document, path):
    return next(iter(_json_nodes(document, path)), "")


def _text(value, limit=180):
    return str(value or "").strip()[:limit] if isinstance(value, (str, int, float)) else ""


# 站点挡爬虫时返回的不是内容页，而是「验证一下再继续」。这种页面的链接结构一定
# 对不上，报「没有可用的选集」会把人带去改规则；直接说「要人机验证」才是对的。
_CHALLENGE_MESSAGE = "站点要求人机验证：先在浏览器里打开这个站点，通过验证后回来重试"
# 强信号：只会出现在拦截页上。
_CHALLENGE_MARKERS = (
    "cf-browser-verification", "cf_chl_opt", "ddos-guard", "sgcaptcha", "captcha-image",
    "verify you are human", "checking your browser",
    "请完成安全验证", "人机验证", "滑动验证", "拖动滑块",
)
# 弱信号：正常页面也可能带（Cloudflare 会给普通页面注入 challenge-platform 脚本），
# 只有「页面很小、一看就不是内容页」时才算拦截页，避免把整站误判成要人机验证。
_CHALLENGE_WEAK_MARKERS = (
    "challenge-platform", "/cdn-cgi/challenge", "g-recaptcha", "h-captcha",
    "recaptcha/api", "geetest",
)
_CHALLENGE_TITLE = re.compile(r"<title[^>]*>([^<]{0,160})</title>", re.I)
_CHALLENGE_TITLE_WORDS = (
    "just a moment", "attention required", "checking your browser", "cloudflare", "ddos-guard",
    "安全验证", "人机验证", "验证码", "访问验证", "请稍候",
)


def _is_challenge(raw: bytes) -> bool:
    """看返回的到底是内容页，还是「请先通过人机验证」这种拦截页。"""
    text = raw[:262144].decode("utf-8", "ignore").lower()
    if not text:
        return False
    title = _CHALLENGE_TITLE.search(text)
    if title and any(word in title.group(1) for word in _CHALLENGE_TITLE_WORDS):
        return True
    if any(marker in text for marker in _CHALLENGE_MARKERS):
        return True
    # 弱信号 + 小页面 + 几乎没有链接：三条同时成立才当拦截页。
    # 正常内容页通常有大量 href，哪怕只有十几 KB。
    return (len(text) < 20000 and text.count("href=") < 5
            and any(marker in text for marker in _CHALLENGE_WEAK_MARKERS))


def _challenge_problem():
    return RequestProblem(_CHALLENGE_MESSAGE, 502, "captcha")


def _page(rule, url):
    try:
        from lxml import etree, html
    except ImportError:
        raise RequestProblem("缺少 XPath 解析组件 lxml，请安装桌面播放依赖", 503) from None
    raw, final_url = _read(url, _headers(rule))
    if _is_challenge(raw):
        raise _challenge_problem()
    try:
        try:
            raw = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            pass  # Let the HTML parser honor the page's declared charset.
        return html.fromstring(raw, parser=html.HTMLParser(no_network=True)), final_url
    except (ValueError, etree.ParserError):
        raise RequestProblem("站点没有返回可读取的页面", 502, "site_changed") from None


def _xpath(node, expression, relative=False):
    from lxml import etree

    if relative and expression.startswith("//"):
        expression = "." + expression
    try:
        value = node.xpath(expression)
    except etree.XPathError:
        raise RequestProblem("规则的 XPath 无效，请更新规则", 502, "site_changed") from None
    return value if isinstance(value, list) else [value]


def _node_text(node):
    return _text(node.text_content() if hasattr(node, "text_content") else node)


_SCRIPT_SCHEMES = ("javascript:", "vbscript:", "data:", "magnet:", "ed2k:", "thunder:")


def _link_info(base, node):
    """把节点上的 href 变成可用网址；不行就说清「为什么不行」。

    以前这里只返回空字符串，调用方于是把整条结果/整集丢掉——集数少了、后面
    没写集号的集还会整体前移一位（点第 5 集播到第 6 集）。现在把原因带出去，
    界面可以留着这一条并标成「打不开」。
    """
    href = node.get("href") if hasattr(node, "get") else node
    if not isinstance(href, str) or not href.strip():
        return "", "站点没有给出链接"
    value = href.strip()
    if value.startswith("#"):
        return "", "链接只是页内锚点"
    if value.lower().startswith(_SCRIPT_SCHEMES):
        return "", "链接是脚本或下载协议，不是网页地址"
    url = urljoin(base, value)
    try:
        public_url(url)
    except RequestProblem:
        return "", "链接指向本机/内网或格式不合法"
    return url, ""


def _link(base, node):
    return _link_info(base, node)[0]


def search(rule_id, rule, title):
    """按番名搜索。

    链接解析不出来的条目不再直接丢掉：留着并标 ``playable: False``，界面上显示成
    「打不开」，同时把 ``skipped``（标题 + 原因）带回去，用户能展开看是哪几条、为什么。
    一条都打不开时才按「规则过期」报错——那种情况更新规则才有意义。
    """
    if not title.strip() or len(title) > 200:
        raise RequestProblem("请输入有效的番剧名称")
    values = {"@keyword": title}
    items = []
    rows = 0
    if rule.get("searchMode") == "api":
        config = rule["searchApiConfig"]
        result = _api(rule, config, values)
        for row in _json_nodes(result, config["listPath"])[:40]:
            rows += 1
            name = _text(_value(row, config["namePath"]))
            source = _text(_value(row, config["sourcePath"]), 2000)
            template = config.get("sourceTemplate")
            if template and source:
                source = _template(template, {"@source": source}, encode=True)
            if not name:
                continue
            # 接口式搜索的 source 通常是番剧编号（不是网址），能拿它读选集就算可用。
            item = {"id": source, "title": name, "playable": bool(source)}
            if not source:
                item["reason"] = "站点没有给出番剧编号"
            if config.get("originalPath"):
                original = _text(_value(row, config["originalPath"]), 180)
                if original:
                    item["original"] = original
            items.append(item)
    else:
        url = _template(rule["searchURL"], values, encode=True).replace("{keyword}", quote(title, safe=""))
        page, base = _page(rule, url)
        _remember_host(rule_id, base)
        for row in _xpath(page, rule["searchList"])[:40]:
            rows += 1
            name = _node_text(next(iter(_xpath(row, rule["searchName"], relative=True)), ""))
            target, reason = _link_info(base, next(iter(_xpath(row, rule["searchResult"], relative=True)), ""))
            if not name:
                continue
            item = {"id": target, "title": name, "playable": bool(target)}
            if not target:
                item["reason"] = reason
            items.append(item)
    unique = []
    seen = set()
    for item in items:
        key = item["id"] if item["playable"] else f"bad:{item['title']}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    playable = [item for item in unique if item["playable"]]
    if unique and not playable:
        # 列表节点对上了，却一条可用链接都没有：多半是站点把 href 换成了脚本跳转。
        raise RequestProblem(
            f"站点返回了 {len(unique)} 条结果，但一条链接都解析不出来（可能改成了脚本跳转）",
            502, "site_changed",
        )
    data = {"items": unique}
    broken = [{"title": item["title"], "reason": item.get("reason", "")} for item in unique if not item["playable"]]
    if broken:
        data["skipped"] = broken
    return data


def _episode_number(label, index):
    match = re.fullmatch(r"\s*(?:第\s*|EP?\.?\s*)?0*(\d+(?:\.\d+)?)(?:\s*[集話话])?(?:\s*[:：·].*)?\s*", label, re.I)
    if match:
        return match[1]
    return "" if re.search(r"\b(?:SP|OVA|PV|OP|ED)\d*\b|预告|番外|特典|总集篇", label, re.I) else str(index)


def _episodes(pairs):
    """把「标签 + 地址」整理成选集。

    规则可以在分集配置里给出真实的集号与集 ID（站点自己有编号字段时用），
    这时直接采用；没给才按标题里的数字/顺序推算。

    链接不可用的条目**不删除**：留着占住集号，并标 ``playable: False``。删掉会让
    后面没写集号的集整体前移一位（点第 5 集播到第 6 集）；留着至少集数还是齐的，
    界面也能显示「这一集打不开」。
    """
    episodes = []
    seen_urls = set()
    seen_ids = set()
    index = 0
    for entry in pairs:
        label, url = entry[0], entry[1]
        number_hint = str(entry[2] or "").strip() if len(entry) > 2 else ""
        id_hint = str(entry[3] or "").strip() if len(entry) > 3 else ""
        reason = str(entry[4] or "").strip() if len(entry) > 4 else ""
        if not label and not url:
            continue
        if url and url in seen_urls:
            continue   # 同一集在列表里重复出现，不重复计
        if url:
            seen_urls.add(url)
        number = number_hint or _episode_number(label, index + 1)
        index += bool(number)
        if id_hint.isdigit():
            episode_id = int(id_hint)   # 站点给的是数字编号：保持数字，别和历史记录里的类型对不上
        else:
            episode_id = id_hint or (f"episode-{number}" if number else f"special-{label}")
        if episode_id in seen_ids:
            episode_id += f"-{len(episodes) + 1}"
        seen_ids.add(episode_id)
        episode = {"id": episode_id, "url": url, "number": number, "title": label,
                   "playable": bool(url)}
        if not url:
            episode["reason"] = reason or "站点没有给出这一集的地址"
        episodes.append(episode)
    return episodes


def _api_roads(rule, provider, meta=None):
    config = {**rule["chapterApiConfig"], **(rule.get("_handbook_chapter") or {})}
    data = _api(rule, config, {"@source": provider})
    # 站点的详情接口顺带给了番名：记到 meta 里，选集面板和播放记录就有名字可用。
    if isinstance(meta, dict) and config.get("titlePath"):
        title = _text(_value(data, config["titlePath"]), 180)
        if title:
            meta["title"] = title
    if config["format"] == "delimited":
        names = _text(_value(data, config["roadNamesPath"]), 4000).split(config["roadSeparator"])
        roads = _text(_value(data, config["roadEpisodesPath"]), _MAX_RESPONSE).split(config["roadSeparator"])
        for index, road in enumerate(roads[:30]):
            pairs = []
            for item in road.split(config["episodeSeparator"])[:2000]:
                name, separator, url = item.partition(config["fieldSeparator"])
                if separator:
                    target, reason = _link_info(rule["baseURL"], url)
                    pairs.append((_text(name), target, "", "", reason))
            yield names[index] if index < len(names) else "", pairs, ""
        return
    for road in _json_nodes(data, config["roadsPath"])[:30]:
        name = _text(_value(road, config.get("roadNamePath")), 80) if config.get("roadNamePath") else ""
        road_id = _text(_value(road, config.get("roadIdPath")), 20) if config.get("roadIdPath") else ""
        pairs = []
        for episode in _json_nodes(road, config["episodesPath"])[:2000]:
            label = _text(_value(episode, config["episodeNamePath"]))
            target = _text(_value(episode, config["episodeUrlPath"]), 2000)
            number = _text(_value(episode, config.get("episodeNumberPath")), 12).removesuffix(".0") if config.get("episodeNumberPath") else ""
            episode_id = _text(_value(episode, config.get("episodeIdPath")), 40) if config.get("episodeIdPath") else ""
            page = config.get("episodePage") or {}
            if page.get("url") and target:
                values = {"@source": provider, "@episodeUrl": target}
                target = _with_query(_template(page["url"], values, encode=True), page.get("query"), values)
            url, reason = _link_info(rule["baseURL"], target) if target else ("", "站点没有给出这一集的地址")
            pairs.append((label, url, number, episode_id, reason))
        yield name, pairs, road_id


# 站点换域名时（例如 baseURL 里写的是 www.baimaodm.com，实际 301 到 www.bmddm.com），
# 搜索结果的绝对链接落在新域名上，只比对规则里写死的域名就会误报「链接与站点不一致」。
# 这里记住每个规则实际跳转到的域名，再用来校验——仍然只放行这条规则自己的站点。
_RULE_HOSTS: dict[str, set[str]] = {}
_HOST_PROBE: dict[str, tuple[set[str], float]] = {}
_HOST_PROBE_TTL = 600.0
_HOST_PROBE_LOCK = threading.Lock()


def _configured_hosts(rule):
    hosts = set()
    for key in ("baseURL", "searchURL"):
        try:
            host = urlsplit(str(rule.get(key) or "")).hostname
        except ValueError:
            host = None
        if host:
            hosts.add(host)
    return hosts


def _remember_host(rule_id, url):
    try:
        host = urlsplit(str(url or "")).hostname
    except ValueError:
        host = None
    if not rule_id or not host:
        return
    with _LOCK:
        _RULE_HOSTS.setdefault(rule_id, set()).add(host)


def _rule_hosts(rule_id, rule):
    with _LOCK:
        return _configured_hosts(rule) | _RULE_HOSTS.get(rule_id, set())


def _discover_hosts(rule_id, rule):
    """探一次规则首页，把跳转后的域名记下来（换域名/换 www 前缀都能自愈）。"""
    if not rule_id:
        return set()
    now = time.monotonic()
    with _HOST_PROBE_LOCK:
        cached, expiry = _HOST_PROBE.get(rule_id, (set(), 0.0))
    if expiry > now:
        return cached
    found: set[str] = set()
    try:
        _raw, final_url = _read(str(rule.get("baseURL") or ""), _headers(rule))
        host = urlsplit(final_url).hostname
        if host:
            found.add(host)
    except (RequestProblem, OSError, ValueError):
        found = set()
    with _HOST_PROBE_LOCK:
        _HOST_PROBE[rule_id] = (found, now + _HOST_PROBE_TTL)
    for host in found:
        _remember_host(rule_id, f"https://{host}/")
    return found


def _html_roads(rule, provider, rule_id=""):
    url, _ = public_url(provider)
    hosts = _rule_hosts(rule_id, rule)
    if url.hostname not in hosts:
        # 可能是站点换了域名：探一次首页，确认它现在落在哪一个域名上。
        hosts |= _discover_hosts(rule_id, rule)
    if url.hostname not in hosts:
        raise RequestProblem(
            f"番剧链接与所选规则站点不一致（链接在 {url.hostname}，规则站点是 "
            f"{'、'.join(sorted(hosts)) or '未知'}）",
            400, "site_mismatch",
        )
    _remember_host(rule_id, provider)
    page, base = _page(rule, provider)
    _remember_host(rule_id, base)
    for road in _xpath(page, rule["chapterRoads"])[:30]:
        pairs = []
        for row in _xpath(road, rule["chapterResult"], relative=True)[:2000]:
            target, reason = _link_info(base, row)
            pairs.append((_node_text(row), target, "", "", reason))
        yield "", pairs


def catalogue(rule_id, rule, provider):
    if not provider or len(provider) > 2000:
        raise RequestProblem("片源编号无效")
    key = (rule_id, provider, json.dumps(rule, sort_keys=True, ensure_ascii=True))
    with _LOCK:
        cached, expiry = _CATALOGUES.get(key, (None, 0))
    if cached and time.monotonic() < expiry:
        return cached
    meta: dict[str, Any] = {}
    roads = _api_roads(rule, provider, meta) if rule.get("chapterMode") == "api" else _html_roads(rule, provider, rule_id)
    sources = []
    for index, road in enumerate(roads, 1):
        name, pairs = road[0], road[1]
        road_id = str(road[2]).strip() if len(road) > 2 and str(road[2]).strip() else ""
        episodes = _episodes(pairs)
        if episodes:
            sources.append({"id": int(road_id) if road_id.isdigit() else index,
                            "name": name or f"线路 {index}", "episodes": episodes})
    unplayable = sum(1 for line in sources for episode in line["episodes"] if not episode.get("playable"))
    data = {"id": provider, "sources": sources}
    if unplayable:
        # 条目还在，但打不开：界面要把这件事说清楚（不再是无声少一集）。
        data["unplayable"] = unplayable
    if meta.get("title"):
        data["title"] = meta["title"]
    playable_lines = [line for line in sources if any(ep.get("playable") for ep in line["episodes"])]
    if not playable_lines:
        raise RequestProblem(
            "页面打开了，但这个站点没有解析出任何可播放的选集——多半是站点改版，规则需要更新",
            502, "site_changed",
        )
    data["rule"] = rule_id
    data["ruleName"] = _display_name(rule_id, rule)
    with _LOCK:
        if len(_CATALOGUES) >= 48:
            del _CATALOGUES[next(iter(_CATALOGUES))]
        _CATALOGUES[key] = data, time.monotonic() + 300
    return data


def _typed_value(value, values):
    """整格就是一个占位符时保留类型：站点接口要的是数字，传字符串会被判 400。"""
    if isinstance(value, str) and value in values:
        text = str(values[value])
        return int(text) if re.fullmatch(r"[1-9][0-9]{0,9}", text) else text
    return _template(value, values)


def _issue_play(rule, config, provider, source_id, episode_id):
    """规则自带「签发播放地址」的接口时走这里。

    有些站点不把视频地址放在播放页里，而是让你调一个接口换一个带时效的地址。
    这属于站点能力，所以写在规则里（``_handbook_play`` / ``playApiConfig``），
    和规则站点走同一条路，不再按规则 ID 特判。
    """
    request = config.get("request") or {}
    if not request.get("url"):
        raise RequestProblem("这条规则没有配置播放地址接口", 502, "rule_stale")
    values = {"@source": str(source_id), "@episode": str(episode_id), "@anime": str(provider)}
    url = _template(str(request["url"]), values, encode=True)
    headers = {**_headers(rule), **(request.get("headers") or {})}
    # 这类接口通常按网页端的跨域请求校验来源，缺 Origin 会被判成非法调用。
    parts = urlsplit(str(rule.get("baseURL") or ""))
    if parts.scheme and parts.netloc:
        headers.setdefault("Origin", f"{parts.scheme}://{parts.netloc}")
    headers.setdefault("Accept", "application/json")
    body = None
    method = str(request.get("method") or "GET").upper()
    if method == "POST":
        payload = {key: _typed_value(value, values) for key, value in (request.get("body") or {}).items()}
        body = json.dumps(payload).encode()
        headers.setdefault("Content-Type", "application/json")
    try:
        raw = _read(url, headers, method=method, body=body)[0]
        data = json.loads(raw)
    except (UnicodeError, json.JSONDecodeError):
        raise RequestProblem("站点的播放接口没有返回可读的数据", 502, "no_media") from None
    if config.get("okPath") and not _value(data, config["okPath"]):
        raise RequestProblem("站点没有提供这一集的播放地址，请打开原网页", 400, "no_media")
    if config.get("animePath"):
        expected = _value(data, config["animePath"])
        if expected not in (None, "") and str(expected) != str(provider):
            raise RequestProblem("站点返回的是另一部番的播放地址", 502, "no_media")
    media = _text(_value(data, config.get("urlPath") or "url"), 4000)
    if not media:
        raise RequestProblem("当前线路无法在手账内播放，请打开原网页", 400, "no_media")
    expires = _value(data, config["expiresPath"]) if config.get("expiresPath") else None
    return media, expires if type(expires) in (int, float) else None


def play(rule_id, rule, provider, source_id, episode_id):
    data = catalogue(rule_id, rule, provider)
    source = next((item for item in data["sources"] if str(item["id"]) == source_id), None)
    episode = next((item for item in (source or {}).get("episodes", []) if str(item["id"]) == episode_id), None)
    if not episode:
        raise RequestProblem("这条线路没有这一集（可能下架了，也可能这条线路集数不同）", 404, "episode_missing")
    if not episode.get("playable", True):
        raise RequestProblem(
            f"这一集在站点上打不开：{episode.get('reason') or '链接无法识别（可能是脚本跳转）'}",
            400, "episode_unplayable",
        )
    url = episode["url"]
    headers = _headers(rule)
    play_cfg = rule.get("_handbook_play") or rule.get("playApiConfig")
    if play_cfg:
        try:
            media, expires = _issue_play(rule, play_cfg, provider, source_id, episode_id)
        except RequestProblem as direct_error:
            # 接口不给地址时再退回「打开播放页嗅探」，两条路拿到的可能是不同的源。
            try:
                media, kind, browser_headers = playback_stream.resolve_in_browser(url, rule)
                playback_stream.probe_media(media, kind, browser_headers)
                return playback_stream.issue(media, kind, browser_headers)
            except RequestProblem:
                raise direct_error from None
        # Referer 只发给「和规则同一个站点」的地址：很多 CDN 对带 Referer 的直链直接回
        # 400（稀饭的 apn CDN 就是），带上反而会把能播的地址判成不能播，白白退到浏览器嗅探。
        site = urlsplit(str(rule.get("baseURL") or "")).hostname
        media_host = urlsplit(media).hostname
        if site and media_host == site:
            headers["Referer"] = str(rule.get("baseURL") or "").rstrip("/") + "/"
        else:
            headers.pop("Referer", None)
        kind = playback_stream.media_format(media) or "file"
        playback_stream.probe_media(media, kind, headers)
        return playback_stream.issue(media, kind, headers, expires=expires)
    if kind := playback_stream.media_format(url):
        return playback_stream.issue(url, kind, headers)
    return playback_stream.issue(*playback_stream.resolve_in_browser(url, rule))


def serve(handler, path, query):
    xifan_preview.require_local(handler)
    route = path.removeprefix(PREFIX)

    def arg(key):
        return query.get(key, [""])[0]

    if route == "rules":
        return handler.send_json(rule_list(remote=arg("remote") == "1", refresh=arg("refresh") == "1"))
    if route == "custom-rule":
        rule_id = arg("id")
        if not rule_id.startswith("custom-"):
            raise RequestProblem("只能编辑自定义规则")
        rule = installed_rule(rule_id)
        return handler.send_json({"config": {key: value for key, value in rule.items() if not key.startswith("_handbook_")}})
    if match := re.fullmatch(r"stream/([\w-]{32})/(main|[a-f0-9]{32})", route, re.ASCII):
        return playback_stream.stream(handler, *match.groups())
    if route not in {"search", "catalogue", "play"}:
        raise RequestProblem("播放地址无效", 404)
    rule_id = arg("rule")
    rule = installed_rule(rule_id)
    try:
        if route == "search":
            result = search(rule_id, rule, arg("title"))
        elif route == "catalogue":
            result = catalogue(rule_id, rule, arg("anime"))
        else:
            result = play(rule_id, rule, arg("anime"), arg("source"), arg("episode"))
    except (KeyError, TypeError):
        raise RequestProblem("站点返回的数据与当前规则不符，请更新或切换规则", 502, "site_changed") from None
    handler.send_json(result)
