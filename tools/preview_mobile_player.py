"""在本机起一个手机播放器预览：用真实工程资源 + 假的原生桥，浏览器里直接点。

用法：python tools/preview_mobile_player.py [--port 8765] [--no-open]
构建目录在 preview/_build（每次重建），只用于预览，不要提交。
"""
from __future__ import annotations

import argparse
import functools
import http.server
import shutil
import socketserver
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "android" / "app" / "src" / "main" / "assets"
OUT = ROOT / "preview"
BUILD = OUT / "_build"

MOCK = """
<script>
(() => {
  // 预览用的假原生桥：和 APK 里的接口一一对应，只是不碰真实存储/系统。
  window.__previewAllowHttp = true;   // 预览用 localhost 的示例视频，真机只认 HTTPS
  const demo = { id: 9001, name_cn: "葬送的芙莉莲", collection_type: 1,
    episodes: JSON.stringify(Array.from({ length: 12 }, (_, i) => ({
      key: String(i + 1).padStart(2, "0"), display_label: String(i + 1),
      name_cn: i === 0 ? "冒险的结束" : "",
    }))) };
  const extras = [
    { id: 9002, name_cn: "迷宫饭", collection_type: 1, episode_count: 24, watched_episodes: '["01","02","03","04","05"]' },
    { id: 9003, name_cn: "孤独摇滚！", collection_type: 1, episode_count: 12, watched_episodes: '["01","02","03","04","05","06","07","08"]' },
    { id: 9004, name_cn: "药屋少女的呢喃", collection_type: 1, episode_count: 24, watched_episodes: '["01","02"]' },
    { id: 9005, name_cn: "蓝色管弦乐", collection_type: 2, episode_count: 24, watched_episodes: '[]' },
    { id: 9006, name_cn: "地。-关于地球的运动-", collection_type: 2, episode_count: 25, watched_episodes: '[]' },
    { id: 9007, name_cn: "胆大党", collection_type: 4, episode_count: 12, watched_episodes: '["01","02","03","04","05","06","07","08","09","10","11","12"]' },
  ].map(item => ({ active: 1, ...item }));
  const events = [
    { id: 1, event_type: "watch", anime_id: 9001, episodes: '["01"]', content: "", created_at: "2026-11-22T12:40:00+08:00" },
    { id: 2, event_type: "note", anime_id: 9001, episodes: "[]", content: "第一集的分镜很稳，音乐也好听，先记一笔。", created_at: "2026-11-21T23:10:00+08:00" },
    { id: 3, event_type: "watch", anime_id: 9003, episodes: '["07","08"]', content: "", created_at: "2026-11-20T21:05:00+08:00" },
  ];
  let snapshot = JSON.stringify({ tables: { anime: [demo, ...extras], events, settings: [] } });
  window.AndroidHandbook = {
    state: () => snapshot,
    saveState: value => { snapshot = value; return true; },
    uiState: () => "{}", saveUiState: () => {}, config: () => "{}",
    version: () => "1.0.28-preview",
  };

  // ---- 预览里的假站点：搜到的条目、分集、播放页都指向本机 sample.mp4 ----
  const MEDIA = location.origin + "/_build/sample.mp4";
  const rule = dynamic => ({
    name: dynamic ? "演示站（动态）" : "演示站（静态）",
    version: "1.0", type: "anime", baseURL: "https://demo.preview/",
    searchURL: "https://demo.preview/search?kw=@keyword",
    searchList: "//div[@class='item']", searchName: ".//a", searchResult: ".//a",
    chapterRoads: "//ul[@class='eps']", chapterResult: ".//a", useWebview: dynamic,
  });
  window.__previewRules = [rule(false), rule(true)];
  const PAGES = {
    search: `<div class="item"><a href="/anime/1">葬送的芙莉莲</a></div><div class="item"><a href="/anime/2">葬送的芙莉莲 第二季</a></div>`,
    anime: `<ul class='eps'><li><a href='/play/1'>第 1 集</a></li><li><a href='/play/2'>第 2 集</a></li><li><a href='/play/3'>第 3 集</a></li></ul>`,
    // 地址放在播放器容器的属性里，和很多真实站点一致
    play: `<div id="player" data-src="${MEDIA}"></div>`,
  };
  const respond = url => {
    if (url.includes("api.github.com")) return JSON.stringify([
      { name: "demo.json", download_url: "https://demo.preview/static.json", size: 640 },
      { name: "demo-dynamic.json", download_url: "https://demo.preview/dynamic.json", size: 660 },
    ]);
    if (url.endsWith("/static.json")) return JSON.stringify(window.__previewRules[0]);
    if (url.endsWith("/dynamic.json")) return JSON.stringify(window.__previewRules[1]);
    if (url.includes("demo.preview/search")) return PAGES.search;
    if (url.includes("demo.preview/anime/")) return PAGES.anime;
    if (url.includes("demo.preview/play/")) return PAGES.play;
    return null;
  };
  // 预置一份仓库缓存，打开「规则仓库」就能直接装
  try {
    localStorage.setItem("mobile-player:rule-repo", JSON.stringify({
      at: Date.now(),
      items: [
        { name: "demo", url: "https://demo.preview/static.json", size: 640 },
        { name: "demo-dynamic", url: "https://demo.preview/dynamic.json", size: 660 },
      ],
    }));
  } catch (error) { /* 无痕模式 */ }

  window.__previewNotices = [];
  window.AndroidPlayer = {
    bars() {},
    volume() {},
    pip() { window.HandbookPlayer?.pictureInPicture(true); },
    saveImage(name) { window.__previewNotices.push("截图已生成：" + name); alert("预览里不落盘，截图已生成：\\n" + name); },
    external(url) { window.open(url, "_blank"); },
    requestDanmaku(id, raw) {
      const path = JSON.parse(raw).path;
      const body = path.startsWith("/api/v2/search/")
        ? { animes: [{ animeTitle: "葬送的芙莉莲", episodes: [{ episodeId: 101, episodeTitle: "01 冒险的结束" }] }] }
        : { comments: Array.from({ length: 40 }, (_, i) => ({ p: "1,1,16777215", m: "预览弹幕 " + (i + 1) })) };
      setTimeout(() => window.HandbookPlayer?.danmakuResult(id, JSON.stringify(body), null), 150);
    },
    downloadStart(payload) {
      const data = JSON.parse(payload);
      const report = (status, percent, message) => window.HandbookPlayer?.downloadState(
        JSON.stringify({id:data.id, status, percent, message:message||"", episode:data.episode, title:data.title}));
      report("start", 0);
      let percent = 0;
      const timer = setInterval(() => {
        percent = Math.min(100, percent + 20);
        if (percent < 100) { report("downloading", percent); return; }
        clearInterval(timer);
        window.__previewDownloads = (window.__previewDownloads || 0) + 1;
        report("done", 100);
      }, 350);
    },
    downloadCancel(id) { window.HandbookPlayer?.downloadState(JSON.stringify({id, status:"cancelled", percent:0, message:""})); },
    scanMedia() {
      const origin = location.origin + "/_build/sample.mp4";
      const ep = (n) => ({ name: `葬送的芙莉莲 - 0${n}.mp4`, episode: n, size: 104857600 * n, url: `${origin}?ep=${n}` });
      const data = {
        name: "AnimeHandbook",
        folders: [
          { name: "葬送的芙莉莲 [bgm-9001]", animeId: 9001, clean: "葬送的芙莉莲", files: [ep(1), ep(2), ep(3)] },
          { name: "孤独摇滚！ [bgm-9003]", animeId: 9003, clean: "孤独摇滚！", files: [ep(1), ep(2)] },
          { name: "药屋少女的呢喃 [bgm-9004]", animeId: 9004, clean: "药屋少女的呢喃", files: [ep(1)] },
        ],
        ignored: 2,
      };
      setTimeout(() => window.HandbookPlayer?.scanResult(JSON.stringify(data)), 250);
    },
    pickMediaRoot() {
      toast("预览里没有原生目录选择，扫描数据是演示用的");
      window.HandbookPlayer?.mediaRootPicked("AnimeHandbook");
    },
    fetchText(id, url) {
      const text = respond(url);
      setTimeout(() => window.HandbookRules?.fetchResult(id, text, text ? null : "预览只支持内置的演示站点"), 80);
    },
    renderText(id, url) {
      const text = respond(url);
      setTimeout(() => window.HandbookRules?.fetchResult(id, text, text ? null : "预览只支持内置的演示站点"), 700);
    },
  };
})();
</script>
"""

BOOT = """
<script>
(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  await wait(250);
  const list = typeof animes === "function" ? animes() : (state?.tables?.anime || []);
  const demo = list.find(item => Number(item.id) === 9001) || list[0];
  if (!demo) return;
  const video = document.getElementById("offlineVideo");
  video.muted = true;
  window.HandbookPlayer.show(demo, "01");
  await wait(200);
  try {
    const blob = await fetch("sample.mp4").then(response => response.blob());
    const files = ["01", "02", "03"].map(name => new File([blob], name + ".mp4", { type: "video/mp4" }));
    const transfer = new DataTransfer();
    files.forEach(file => transfer.items.add(file));
    const input = document.getElementById("mpFiles");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (error) {
    console.warn("示例视频没有加载：", error);
  }
  // 关掉播放器后，用收藏页的「本机视频」或番剧详情重新打开，和真机路径一致。
})();
</script>
"""


def make_sample(target: Path) -> None:
    """用 ffmpeg 生成一段带标题和时间码的渐变视频；没有 ffmpeg 就跳过（预览仍可手动选片）。"""
    target.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg", "-hide_banner", "-v", "error",
        "-f", "lavfi", "-i", "gradients=s=720x404:c0=#241b3d:c1=#6f5aa8:c2=#1b2a4a:n=3:speed=0.02",
        "-t", "24",
        "-vf", "drawtext=fontfile='C\\:/Windows/Fonts/msyh.ttc':text='动漫手账 · 手机播放器预览':"
               "fontcolor=white@0.92:fontsize=30:x=(w-tw)/2:y=(h-th)/2-18",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", str(target),
    ]
    try:
        import subprocess
        subprocess.run(command, check=True)
    except Exception as error:  # noqa: BLE001 - 预览没有示例视频也能用
        print("示例视频生成失败（不影响预览）：", error)


def build() -> None:
    if BUILD.exists():
        shutil.rmtree(BUILD)
    shutil.copytree(ASSETS, BUILD)
    modules = BUILD / "modules"
    modules.mkdir(exist_ok=True)
    for name in ("danmaku.js", "player-upscale.js", "anime4k-shaders.js"):
        source = ROOT / "static" / "modules" / name
        if source.exists():
            shutil.copy(source, modules / name)
    vendor = ROOT / "static" / "vendor" / "hls"
    if vendor.exists():
        shutil.copytree(vendor, BUILD / "vendor" / "hls")
    sample = OUT / "sample.mp4"
    if not sample.exists():
        make_sample(sample)
    if sample.exists():
        shutil.copy(sample, BUILD / "sample.mp4")

    html = (BUILD / "index.html").read_text(encoding="utf-8")
    html = html.replace('<script src="app.js"></script>', MOCK + '<script src="app.js"></script>', 1)
    cut = html.rindex("</body>")   # 只替换真正的文档结尾，避免命中内联字符串
    html = html[:cut] + BOOT + html[cut:]
    (BUILD / "index.html").write_text(html, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()

    build()
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(OUT))
    handler.log_message = lambda *a, **k: None  # type: ignore[attr-defined]
    with socketserver.ThreadingTCPServer(("127.0.0.1", args.port), handler) as server:
        url = f"http://localhost:{args.port}/_build/index.html"
        print(f"预览地址：{url}")
        if not args.no_open:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        server.serve_forever()


if __name__ == "__main__":
    main()
