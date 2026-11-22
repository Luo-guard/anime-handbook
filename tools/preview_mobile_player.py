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
  const demo = { id: 9001, name_cn: "葬送的芙莉莲", collection_type: 1,
    episodes: JSON.stringify(Array.from({ length: 12 }, (_, i) => ({
      key: String(i + 1).padStart(2, "0"), display_label: String(i + 1),
      name_cn: i === 0 ? "冒险的结束" : "",
    }))) };
  let snapshot = JSON.stringify({ tables: { anime: [demo], events: [], settings: [] } });
  window.AndroidHandbook = {
    state: () => snapshot,
    saveState: value => { snapshot = value; return true; },
    uiState: () => "{}", saveUiState: () => {}, config: () => "{}",
  };
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
    fetchText(id) { setTimeout(() => window.HandbookRules?.fetchResult(id, null, "预览模式不联网，规则仓库只在真机上生效"), 60); },
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
  // 顶栏的返回键在预览里会关掉播放器，这里补一个复位入口。
  const reset = document.createElement("button");
  reset.textContent = "↻ 重新打开播放器";
  Object.assign(reset.style, {
    position: "fixed", right: "12px", bottom: "calc(env(safe-area-inset-bottom) + 96px)",
    zIndex: 999, padding: "8px 14px", borderRadius: "999px", border: "0",
    background: "#c4b1f0", color: "#1d1630", font: "600 12px/1 system-ui", display: "none",
  });
  reset.onclick = () => window.HandbookPlayer.show(demo, "01");
  document.body.append(reset);
  new MutationObserver(() => {
    reset.style.display = document.getElementById("mobilePlayer").hidden ? "block" : "none";
  }).observe(document.getElementById("mobilePlayer"), { attributes: true, attributeFilter: ["hidden"] });
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
    html = html.replace("</body>", BOOT + "</body>", 1)
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
