"""Install KazumiRules and resolve episodes from the selected local rule."""
from __future__ import annotations

import io
import json
import re
import tempfile
import threading
import time
import zipfile
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
        public_url(rule["baseURL"])
    except (KeyError, TypeError, RequestProblem):
        return False
    if rule.get("searchMode") == "api":
        search_ok = isinstance(rule.get("searchApiConfig"), dict)
    else:
        search_ok = all(rule.get(field) for field in ("searchURL", "searchList", "searchName", "searchResult"))
    if rule.get("chapterMode") == "api":
        chapter_ok = (rule.get("chapterApiConfig") or {}).get("format") in {"nested", "delimited"}
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
                    not _RULE_ID.fullmatch(rule_id) or entry.file_size > _MAX_RULE):
                continue
            try:
                rule = json.loads(archive.read(entry))
            except (UnicodeError, ValueError):
                continue
            if supported(rule):
                rules[rule_id] = rule
    return rules


def remote_rules():
    global _REMOTE, _REMOTE_EXPIRES
    with _CATALOGUE_LOCK:
        if _REMOTE and time.monotonic() < _REMOTE_EXPIRES:
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
        raise RequestProblem("请先下载这个播放规则", 404)
    return rule


def rule_list(remote=False):
    installed = {}
    for path in rule_folder().glob("*.json"):
        try:
            installed[path.stem] = installed_rule(path.stem)
        except RequestProblem:
            continue
    rules = {**installed, **remote_rules()} if remote else installed
    return {"items": [
        {"id": rule_id, "name": "稀饭动漫 Next" if rule_id == "xfdmnext" else str(rule.get("name") or rule_id),
         "host": urlsplit(rule["baseURL"]).hostname, "version": str(rule.get("version", "")),
         "installed": rule_id in installed,
         "update": rule_id in installed and installed[rule_id].get("version") != rule.get("version")}
        for rule_id, rule in sorted(rules.items())
    ]}


def change_rule(rule_id, action):
    path = rule_path(rule_id)
    if action == "install":
        rule = remote_rules().get(rule_id)
        if not rule:
            raise RequestProblem("该规则已不在兼容规则目录中", 404)
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
    elif action == "remove":
        path.unlink(missing_ok=True)
    else:
        raise RequestProblem("规则操作无效")
    with _LOCK:
        for key in [key for key in _CATALOGUES if key[0] == rule_id]:
            del _CATALOGUES[key]
    return rule_list()


def _read(url, headers, *, method="GET", body=None):
    try:
        with request_public(url, method=method, headers=headers, body=body) as (response, final_url):
            if response.status != 200:
                raise RequestProblem(f"片源站点返回 HTTP {response.status}", 502)
            raw = response.read(_MAX_RESPONSE + 1)
            if len(raw) > _MAX_RESPONSE:
                raise RequestProblem("片源站点返回的资料过大", 502)
            return raw, final_url
    except (OSError, HTTPException):
        raise RequestProblem("片源站点连接失败，请重试或切换规则", 502) from None


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
        raise RequestProblem("此规则的接口请求格式暂未支持", 502)
    try:
        return json.loads(_read(url, headers, method=method, body=body)[0])
    except (UnicodeError, json.JSONDecodeError):
        raise RequestProblem("站点没有返回可读取的 JSON 数据", 502) from None


def _json_nodes(document, path):
    if not path or path == "$":
        return [document]
    if not re.fullmatch(r"\$(?:\.[\w-]+|\[\*\])+", path):
        raise RequestProblem("此规则的 JSONPath 格式暂未支持", 502)
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


def _page(rule, url):
    try:
        from lxml import etree, html
    except ImportError:
        raise RequestProblem("缺少 XPath 解析组件 lxml，请安装桌面播放依赖", 503) from None
    raw, final_url = _read(url, _headers(rule))
    try:
        try:
            raw = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            pass  # Let the HTML parser honor the page's declared charset.
        return html.fromstring(raw, parser=html.HTMLParser(no_network=True)), final_url
    except (ValueError, etree.ParserError):
        raise RequestProblem("站点没有返回可读取的页面", 502) from None


def _xpath(node, expression, relative=False):
    from lxml import etree

    if relative and expression.startswith("//"):
        expression = "." + expression
    try:
        value = node.xpath(expression)
    except etree.XPathError:
        raise RequestProblem("规则的 XPath 无效，请更新规则", 502) from None
    return value if isinstance(value, list) else [value]


def _node_text(node):
    return _text(node.text_content() if hasattr(node, "text_content") else node)


def _link(base, node):
    href = node.get("href") if hasattr(node, "get") else node
    if not isinstance(href, str) or not href.strip() or href.strip().startswith("#"):
        return ""
    url = urljoin(base, href.strip())
    try:
        public_url(url)
    except RequestProblem:
        return ""
    return url


def search(rule_id, rule, title):
    if not title.strip() or len(title) > 200:
        raise RequestProblem("请输入有效的番剧名称")
    if rule_id == "xfdmnext":
        return xifan_preview.search(title, rule)
    values = {"@keyword": title}
    items = []
    if rule.get("searchMode") == "api":
        config = rule["searchApiConfig"]
        result = _api(rule, config, values)
        for row in _json_nodes(result, config["listPath"])[:40]:
            name = _text(_value(row, config["namePath"]))
            source = _text(_value(row, config["sourcePath"]), 2000)
            template = config.get("sourceTemplate")
            if template and source:
                source = _template(template, {"@source": source}, encode=True)
            if name and source:
                items.append({"id": source, "title": name})
    else:
        url = _template(rule["searchURL"], values, encode=True).replace("{keyword}", quote(title, safe=""))
        page, base = _page(rule, url)
        for row in _xpath(page, rule["searchList"])[:40]:
            name = _node_text(next(iter(_xpath(row, rule["searchName"], relative=True)), ""))
            source = _link(base, next(iter(_xpath(row, rule["searchResult"], relative=True)), ""))
            if name and source:
                items.append({"id": source, "title": name})
    return {"items": list({item["id"]: item for item in items}.values())}


def _episode_number(label, index):
    match = re.fullmatch(r"\s*(?:第\s*|EP?\.?\s*)?0*(\d+(?:\.\d+)?)(?:\s*[集話话])?(?:\s*[:：·].*)?\s*", label, re.I)
    if match:
        return match[1]
    return "" if re.search(r"\b(?:SP|OVA|PV|OP|ED)\d*\b|预告|番外|特典|总集篇", label, re.I) else str(index)


def _episodes(pairs):
    episodes = []
    seen_urls = set()
    seen_ids = set()
    index = 0
    for label, url in pairs:
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        number = _episode_number(label, index + 1)
        index += bool(number)
        episode_id = f"episode-{number}" if number else f"special-{label}"
        if episode_id in seen_ids:
            episode_id += f"-{len(episodes) + 1}"
        seen_ids.add(episode_id)
        episodes.append({"id": episode_id, "url": url, "number": number, "title": label})
    return episodes


def _api_roads(rule, provider):
    config = rule["chapterApiConfig"]
    data = _api(rule, config, {"@source": provider})
    if config["format"] == "delimited":
        names = _text(_value(data, config["roadNamesPath"]), 4000).split(config["roadSeparator"])
        roads = _text(_value(data, config["roadEpisodesPath"]), _MAX_RESPONSE).split(config["roadSeparator"])
        for index, road in enumerate(roads[:30]):
            pairs = []
            for item in road.split(config["episodeSeparator"])[:2000]:
                name, separator, url = item.partition(config["fieldSeparator"])
                if separator:
                    pairs.append((_text(name), _link(rule["baseURL"], url)))
            yield names[index] if index < len(names) else "", pairs
        return
    for road in _json_nodes(data, config["roadsPath"])[:30]:
        name = _text(_value(road, config.get("roadNamePath")), 80) if config.get("roadNamePath") else ""
        pairs = []
        for episode in _json_nodes(road, config["episodesPath"])[:2000]:
            label = _text(_value(episode, config["episodeNamePath"]))
            target = _text(_value(episode, config["episodeUrlPath"]), 2000)
            if not target:
                continue
            page = config.get("episodePage") or {}
            if page.get("url"):
                values = {"@source": provider, "@episodeUrl": target}
                target = _with_query(_template(page["url"], values, encode=True), page.get("query"), values)
            pairs.append((label, _link(rule["baseURL"], target)))
        yield name, pairs


def _html_roads(rule, provider):
    url, _ = public_url(provider)
    hosts = {urlsplit(rule["baseURL"]).hostname, urlsplit(rule.get("searchURL", "")).hostname}
    if url.hostname not in hosts:
        raise RequestProblem("番剧链接与所选规则站点不一致")
    page, base = _page(rule, provider)
    for road in _xpath(page, rule["chapterRoads"])[:30]:
        yield "", [(_node_text(row), _link(base, row))
                   for row in _xpath(road, rule["chapterResult"], relative=True)[:2000]]


def catalogue(rule_id, rule, provider):
    if not provider or len(provider) > 2000:
        raise RequestProblem("片源编号无效")
    key = (rule_id, provider)
    with _LOCK:
        cached, expiry = _CATALOGUES.get(key, (None, 0))
    if cached and time.monotonic() < expiry:
        return cached
    if rule_id == "xfdmnext":
        data = xifan_preview.catalogue(f"{xifan_preview.SITE}/anime/{xifan_preview._id(provider)}", rule)
        for source in data["sources"]:
            for episode in source["episodes"]:
                episode["url"] = f"{xifan_preview.SITE}/anime/{data['id']}/play/{episode['id']}"
    else:
        roads = _api_roads(rule, provider) if rule.get("chapterMode") == "api" else _html_roads(rule, provider)
        sources = []
        for index, (name, pairs) in enumerate(roads, 1):
            episodes = _episodes(pairs)
            if episodes:
                sources.append({"id": index, "name": name or f"线路 {index}", "episodes": episodes})
        data = {"id": provider, "sources": sources}
    if not data["sources"]:
        raise RequestProblem("这个站点没有返回可用的选集，请切换规则", 502)
    data["rule"] = rule_id
    data["ruleName"] = "稀饭动漫 Next" if rule_id == "xfdmnext" else str(rule.get("name") or rule_id)
    with _LOCK:
        if len(_CATALOGUES) >= 48:
            del _CATALOGUES[next(iter(_CATALOGUES))]
        _CATALOGUES[key] = data, time.monotonic() + 300
    return data


def play(rule_id, rule, provider, source_id, episode_id):
    data = catalogue(rule_id, rule, provider)
    source = next((item for item in data["sources"] if str(item["id"]) == source_id), None)
    episode = next((item for item in (source or {}).get("episodes", []) if str(item["id"]) == episode_id), None)
    if not episode:
        raise RequestProblem("这条线路没有这一集", 404)
    url = episode["url"]
    headers = _headers(rule)
    if rule_id == "xfdmnext":
        try:
            media, expires = xifan_preview.resolve(provider, episode_id, source_id, rule)
            headers["Referer"] = xifan_preview.SITE + "/"
            kind = playback_stream.media_format(media) or "file"
            playback_stream.probe_media(media, kind, headers)
            return playback_stream.issue(media, kind, headers, expires=expires)
        except xifan_preview.PreviewError:
            pass
    if kind := playback_stream.media_format(url):
        return playback_stream.issue(url, kind, headers)
    return playback_stream.issue(*playback_stream.resolve_in_browser(url, rule))


def serve(handler, path, query):
    xifan_preview.require_local(handler)
    route = path.removeprefix(PREFIX)

    def arg(key):
        return query.get(key, [""])[0]

    if route == "rules":
        return handler.send_json(rule_list(remote=arg("remote") == "1"))
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
        raise RequestProblem("站点返回的数据与当前规则不符，请更新或切换规则", 502) from None
    handler.send_json(result)
