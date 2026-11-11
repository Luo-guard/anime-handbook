# 网页 ASS 字幕资源

从 GitHub 新下载代码、换电脑或准备部署包后，在项目根目录执行一次：

```shell
node tools/prepare_subtitles.cjs
```

构建机需要 Node.js 18+（含 npm）、能访问 npm 官方仓库。脚本使用本目录的 `package-lock.json` 执行 `npm ci --ignore-scripts`，校验下载包完整性，再生成播放器实际引用的全部资源。JASSUB 2.5.35、esbuild 0.25.12、Noto Sans SC 5.2.8 及其间接依赖均由锁文件固定，不使用浮动 latest。

输出位于 `static/vendor/jassub/`：主线程 bundle、Worker bundle、普通及现代两套 WASM/加载器、默认字体、中文字体、第三方声明和 SHA256 清单。Worker 的依赖也一起打包，不依赖浏览器解析 npm 包名。先在临时目录构建并验证，成功后才替换原目录；下载或构建失败不会提前删除原有资源。

验证已生成的资源（无需联网，也不需要保留 node_modules）：

```shell
node tools/prepare_subtitles.cjs --check
```

仅更新到当前版本、资源检查通过时，不必重新构建。播放时不访问 CDN，不需要 Node/npm 常驻。下载字幕和媒体本身仍沿用应用已有请求。

## 部署和离线转移

从 GitHub 克隆后先执行上述准备命令，再启动 Python 服务。仓库保存构建脚本及锁文件，WASM/字体不受代码同步工具分发；不能只复制 Python 和 JS 就认为字幕资源齐全。

无网络的目标电脑不需要安装 Node：在联网构建机准备资源，再复制整个 `static/vendor/jassub/`，或运行 `python tools/package_online.py` 生成包含这些文件的部署 ZIP。打包工具会验证清单，缺失或损坏时拒绝生成新包，保留已有包。部署 ZIP 中不包含 npm/node_modules；普通本地启动仍允许不安装字幕资源，只是没有页面内 ASS 效果。

## 验证及升级

```shell
node tools/prepare_subtitles.cjs --output /path/to/empty-test-assets
node tests/verify_subtitle_assets.cjs /path/to/empty-test-assets
```

浏览器验证需要 Playwright，可通过 `PLAYWRIGHT_MODULE` 指向现有安装。测试仅开启临时 HTTP 服务和无头 Chromium，不连接正在运行的手账、不读写用户数据，验证两套 WASM 都能渲染中文 ASS。

升级依赖时显式修改 package.json 并重新生成锁文件，再运行构建和渲染测试；不要直接升级生产机的包版本。依赖源码、许可声明随 npm 包保留，构建产物带 `LICENSES.txt`；JASSUB 包含 libass 等组件，不应把这些第三方产物宣称为项目自有 MIT 代码。对外再分发时须保留相应上游许可及源码获取说明。
