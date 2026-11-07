# 离线功能之后：Bug 全面核对清单（2026-11-07）

**性质**：只排查、不改代码。等你确认后再决定修哪些。

## 0. 范围与基准

- **起点**：2026-11-06 12:39 提出离线需求（`#7707`），16:01 开工（`#8184`），16:20 推送 M1–M3（`50abd9f7`）。你在此后反馈的第一条 bug 是 16:29 的 `#8446`。
- **纳入核对**：`#8446` 起至 `#9708` 的 13 条 bug 反馈，外加 1 条在离线阶段被发现的既有缺陷（`#7719/#7880` 的 sqlite 并发只读）。
- **当前代码**：工作副本 `D:/动漫/动漫手账`（HEAD 为 `c98e9175` 之后的未提交状态，本轮未改任何文件）。
- **测试基线（本轮实测）**：后端 `478` 项，第一次跑 `477 过 / 1 失败`，第二次跑没有失败行（该缺陷概率性未复现）。单独跑 `tests/test_hardening.py` 可稳定复现 `25 项 1 失败`，报错就是你已知的那条：`500 {"ok":false,"message":"后台暂时无法处理请求…"}`（并发写时 `attempt to write a readonly database`）。前端 52 个 verify 脚本本轮未全量重跑。
- **本轮新增的实测**：用 playwright 在 900/700/600/520/480px 视口量了「更多站点 / 链接规则」弹窗的 flex 溢出（见 N9）。

---

## 1. 已知 bug 逐条核对

确认程度：**确定** = 代码与现象一一对应，可直接复现；**较可信** = 代码路径明确，但受环境/数据影响；**待确认** = 代码上看不出，需要你复现一次。

### B1 · `#8446` 详情页链接：默认全开 / 格式不一 / 箭头 / 日期换行（16:29）

| 子项 | 结论 | 依据 |
|---|---|---|
| 规则仓库导入的链接「默认都不开」 | **已修** | `static/modules/settings.js:1234` 导入时 `enabled: false`；默认只有 bgm、bilibili、更多站点三条开着，`saved_video` 默认关（`video-links.js:36-43`） |
| 「更多站点」格式与其他链接一致 | **部分满足** | 视觉字号/颜色/加粗一致（`.detail-link-menu`，`styles.css:3750`），但它是 `<button>` 而不是 `<a>`：**不能中键新标签打开、不能右键复制链接地址**，和旁边三条链接行为不同 |
| 链接后的箭头可去掉 | **未满足** | 普通链接仍然在代码里硬拼 `↗`（`video-links.js:72 / 121 / 147`），并且这个字符**不在**可编辑的名称里 —— 在设置里改名也去不掉；只有「更多站点」把箭头（▾）并进了名称（`video-links.js:21/107`）。你当时的要求是「默认在名字里，能自己删掉」 |
| 链接超一行时日期单独占一行 | **已修** | `.progress-meta` 由 flex 改回块级行内流（`styles.css:1603-1611`），注释写明原因 |

**影响面**：箭头一条只影响观感；`<button>` 一条影响操作习惯（中键/右键）。

### B2 · `#8631` 日期与链接挤太紧 + 详情信息重排（17:08）

- **已修 · 确定**。`.meta-separator { margin: 0 9px }`（`styles.css:3827`）；评分/个人评分/收藏状态合并进 `.progress-info-row`（`styles.css:3829`，`index.html:368`）。
- 注意：`#progressAirDate` 不要再加右外边距，否则是双倍间距（历史坑，已写在注释里）。

### B3 · `#8668 / #8715` 离线面板说明句 + 不好看（17:12 / 17:22）

- **已修 · 确定**。`index.html:297-317` 里已无「在蜜柑里搜关键词…」这句；面板结构与层级按截图重做过（`styles.css:3836-3878`）。
- 同类残留：`#8668` 的诉求本质是「说明文字占地方」，目前**订阅按钮的 toast 仍在承诺实际不会发生的事**（见 N13）。

### B4 · `#8706` 站点选择弹窗的说明句（17:16）

- **已修 · 确定**。`rules-menu.js` 只在状态行写「共 N 个站点…」，不再是操作说明；空状态行不占位（`.rules-status:empty { display: none }`，`styles.css:3871`）。

### B5 · `#8709` 红框内容整体下移（17:17）

- **已修 · 确定**。`.progress-info-row { margin-top: 17px }`（`styles.css:3829`），`.progress-meta { padding-bottom: 3px }`、`.progress-hero { padding-bottom: 15px }`（`3873-3874`）。

### B6 · `#8712` 点下载报错、qB 没反应（17:17）

- **已修 · 确定**。三层根因都在代码里：`handbook/torrent_meta.py` 自算 infohash；`offline_service.py:154-169` 提交前按 hash 查重并复用；`:200-216` 提交后 12×0.2s 轮询（hash 优先、tag 兜底）；`qbittorrent.py:181-185` 不暂停时**根本不发** `paused/stopped/skip_checking`。
- 残留（轻微）：轮询 12 次共约 2.4 秒仍找不到任务时，报「种子已经提交给 qBittorrent，但没能确认任务编号」；此时任务其实可能已加入，用户在 qB 里会看到重复项（`offline_service.py:212-216`）。概率低。

### B7 · `#8821` 评分信息沉到封面底边（17:59）

- **已修 · 确定**。`.progress-hero-info { align-self: stretch; display:flex; flex-direction:column }` + `.progress-info-row { margin-top: auto }`（`styles.css:3882-3883`），靠 grid 行高把右列拉到与封面同高。
- 待确认：极窄视口（hero 变单列）时右列高度由内容决定，`margin-top:auto` 自然失效、不会出现大空隙 —— 但从没在 ≤430px 下截图验证过（B7 只量过宽屏与 470px）。

### B8 · `#9089` 播出进度恢复药丸 + 下集时间位置（18:37）

- **已修 · 确定**。`presentation.js:35-38` 恢复绿点药丸、只显示「已播 N」，总集数与来源放进 `title`；下集时间改成网格下方脚注 `episodeNextAiringNote`（`presentation.js:42-48`，`details.js:524`）。
- 行为提示（不是 bug，待你确认）：`aired >= total` 时整个药丸 `return ""`（`presentation.js:33`）—— 完结番看不到任何进度标记。旧版是否也隐藏无法从当前代码判断，属**证据不足**。

### B9 · `#9161` 矮窗口下界面显示不全（18:48）

- **已修 · 确定**。`.offline-modal .modal-frame > :not(.offline-panel) { flex-shrink: 0 }` 等 5 条（`styles.css:3901-3905`），列表/设置区 `flex:1 1 auto; min-height:0`。
- **同类未修**：`.rules-dialog` / `.rules-menu-dialog` 也是「flex 纵向 + max-height」，但没做同样处理。本轮实测（30 行数据）：
  - `520px` 高：linkRulesModal 内容 `459px` > 框 `447px`（溢出 12px）
  - `480px` 高：溢出 `46px`，超出部分落到白色底框之外（靠 dialog 自身滚动才看得到，文字没被裁）
  - 结论：同类问题存在，但严重度低于 B9（不裁字，只是底框高度不够）。

### B10 · `#9449` 换番后找资源仍用上一部番（19:29）

- **已修 · 确定**。`openOffline()` 用 `offlineView.animeId / animeName` 判断 `switched`，换番时重置 query/items/group/local 并自动搜新番名（`offline.js:34-64`）；`verify_offline_switch.cjs` 覆盖。
- **同类残留（严重）**：同一部番之外，`refreshOfflineLocal()`、`runOfflineSearch()` 都没有「请求版本号」，慢响应会覆盖新番的数据（`offline.js:88-99 / 208-217`）。更严重的是「播放」手势（见 N1）。

### B11 · `#9480` 下载完显示未归档、刷新也没用（19:36）

- **已修 · 确定**（你的真实任务 id=1 当时已手工修好）：归档短轮询 10 次、等文件大小稳定（`offline_service.py:362-394`）；方括号纯数字/第N话/EPN 识别（`media.py:289-302`）；`_sync` 对「归档失败」加 30 秒限频重试（`offline_service.py:271-279`）；`POST /api/offline/retry` + 面板「重试归档」按钮（`offline.js:474-488`）。
- **残留 3 点**（都在同一根因上，见 N2/N3/N4）：
  1. 没有任何后台 worker，归档只在 `GET /api/offline/state` 被调用时推进；而面板**没有轮询**。→ 关掉面板后，下完的任务会停在最后一次同步时的状态，不会自己进入归档；要等你下次打开/切页签才继续。
  2. 30 秒重试**没有次数上限**：永久性失败（认不出集数、磁盘满、源文件损坏）会每 30 秒重跑一次 ffmpeg，只要面板开着就无限重试。
  3. 多文件任务「部分入库」后会被误判为完成（见 N4），重试按钮也救不回来。

### B12 · `#9564` 设置界面底部多一条横向滚动条（19:52）

- **已修 · 确定**。四处修法齐全：`.switch-row{position:relative}` + 隐藏 checkbox 固定 1×1（`styles.css:1017-1042`）、`.detail-link-row input:not([type="checkbox"])`（`3429`）、`.modal-frame{max-width:100%}`（`2166`）、`dialog.modal{overflow-x:hidden}`（`3933`）。
- 同类排查：slim 弹窗（rules-menu、rules-dialog、收藏搜索、导入）都套了 `.modal-frame`，`max-width:100%` 兜住横向溢出；本轮 5 个视口测得的都是纵向溢出（B9 同类），无横向滚动。

### B13 · `#9708` 收藏夹新增条目刷新前后顺序不一致（20:14）

- **已修 · 确定**。`commitAnimes()`（`collection.js:337-345`）成为唯一写入口：全仓 `state.animes =` 只剩这一处（grep 验证）；渲染端 `filteredAnimes()` 用同一个 `collectionComparator()`（`:115`），不存在两套顺序。
- 同类排查：`collectionComparator()` 的 name 兜底已改成 `display_name || name_cn || name` + `String()`（`:215-216`），少了「新条目缺字段导致 sort 抛错」的路径。

### K1 · 既有缺陷：sqlite 并发写「只读数据库」（`#7719/#7880`，发现于离线阶段）

- **未修 · 确定**。根因（你自己复现过）：最后一个连接关闭时 SQLite checkpoint 并删除 `-wal`，Windows 上并发重建出现短暂只读。
- 应用侧症状：多线程同时写（自动同步 / Kazumi 写回 / 手动操作撞一起）时偶发一次「后台暂时无法处理请求」，那一次写入丢失。
- 与离线的交集：归档线程、`_sync`、`check_subscriptions` 都可能和手动操作并发写 `local_media` / `local_files`，**新增了两条并发写路径**，撞上的概率比之前略高。本轮测试仍是 478 项里偶发 1 失败。

---

## 2. 新发现的疑似同类问题

按「影响」排序：**A 档 = 数据错/内容错**，**B 档 = 功能不生效**，**C 档 = 观感/体验**。

### A 档

**N1 · 单集「播放」手势会播上一部番的文件（`details.js:584-590`）· 确定 · ✅ 已修复**
- 触发：详情页 → 右键/长按格子 → 播放。只要**本次页面会话里没有为当前这部番打开过离线面板**。
- 原因 1：`refreshOfflineLocal()` 是 async，这里没 await，紧接着同步读 `offlineView.local.files`；
- 原因 2：`refreshOfflineLocal()` 在 `offlineView.animeId === 0` 时直接 return（`offline.js:209`），所以首次点必然读到空数组 → 误报「这一集还没下载」；
- 原因 3：若上一次打开的是**另一部番**，`offlineView.animeId` 仍是那部番，`files.find(episode_key === "0:5")` 会命中**上一部番的第 5 集**（`files` 里没有 anime 过滤）→ 直接播放错误内容。
- 与 `#9449` 同源：都是「视图缓存的番身份没有随当前详情同步」。

**N2 · 离线面板没有轮询，下载进度/归档不会自己走（`offline.js` 全模块）· 确定**
- 触发：点完下载后停在面板上不动。
- 现象：进度条、速度、剩余时间都是点下载那一刻的快照（`refreshOfflineLocal` 只在打开面板、切页签、点按钮、播放结束、重试后调用）。归档也只在 `state()` 里被安排（`offline_service.py:449-467`）。
- 影响：`#9480` 的「下载完但显示未归档」在**不开面板**的情况下仍然成立 —— 文件下完了也不会自动 remux。
- 不确定点：是否刻意做成省资源（不轮询）需要你定；如果要做，建议 2–3 秒一次、只在面板打开时跑。

**N3 · 删掉某一集后再点下载，不会重新归档（`offline_service.py:230-263` + `offline.py:80-92`）· 确定 · ✅ 已修复**
- 触发：本地文件页 → 删除某一集（移到 `_trash`）→ 回找资源页点同一条种子下载。
- 原因：`delete_episode_file` 只删 `local_files` 行，`local_media` 任务仍是 `ready`；`download()` 会真的把种子重新交给 qB 并下载，但 `create_job` 按 hash 合并到那条 `ready` 任务且**不改 status**；`_sync` 只处理 `queued/downloading/processing` → 永远不归档。
- 症状：qB 里在下载、磁盘上有文件，手账里那一集仍然是「没有本地文件」，任务列表里也看不到（ready 任务不显示）。

**N4 · 多文件任务「部分入库」会被判成已完成，剩余集数永久丢失（`offline_service.py:351-354`）· 较可信 · ✅ 已修复**
- 触发：一季 12 集的合集，归档中途进程被杀/崩溃（`replace_file` 已写了几集，status 还是 `processing`）。
- 原因：`_archive` 开头的「已经录过成品就不要再跑」用的是 `any(media_id == 这条任务)`，只要**有一集**存在就整任务 `ready` 返回。
- 后果：剩下 11 集永远不会再归档；手动「重试归档」走同一段代码，同样直接返回。属静默数据缺失。
- 不确定点：需要一次「归档中杀进程」才能实证，但代码路径是确定的。

**N5 · 「本地文件」里的「字幕」标签永远不显示（`offline.js:236`）· 确定**
- `file.has_subtitle` 这个字段后端从来不返回（`local_files` 表没有这一列，`database.py:226-238`；`state` 直接透传行数据）。
- 影响：纯观感，但说明「这一集有没有字幕」在列表里看不出来。

### B 档

**N6 · 字幕抽取不看编码，SRT/PGS 会被存成 `.ass`（`media.py:183-197`）· 较可信**
- `-map 0:s:0 -c copy` 到目标 `第 05 集.ass`：如果第一条字幕轨是 SRT 或 PGS（图形字幕），文件内容不是 ASS，libass/jassub 解析失败 → 页面内字幕起不来，而 `subtitle_path` 非空，播放器仍显示「字幕 · 开」并报「页面内字幕没起来」。
- 已有一条保底：`probe()` 里其实拿到了 `subtitle_codec`（`media.py:114`），只是没用于判断。
- 不确定点：蜜柑上主流是内封 ASS，命中率不高；但 BDRip 的 PGS 并不少见。

**N7 · 归档回退时会抓「下载目录里最新的一个视频」（`offline_service.py:374-384`）· 较可信**
- 触发：qB 还没给出 `content_path`（刚 100%、或种子结构异常），且下载目录里同时有别的任务在写。
- 风险：取 mtime 最新的那个文件，可能是**另一个番**的成品 → 被 remux 进当前番的目录并按当前番的集数命名。属于「写错位置」的数据错误。
- 不确定点：`content_path` 正常时不会走到这里；同时下两部番时才可能命中。

**N8 · 迁移媒体库失败时，数据库已改指向新目录（`offline_service.py:716-767`）· 确定**
- 循环里逐个 `replace_file` 把 DB 指到新路径，但 `switched = not failed` 才写配置。一旦有文件失败：盘上多一份副本、DB 指向新副本、配置仍指旧目录 → 新旧两个媒体库并存，`_trash` 与后续下载仍走旧目录。
- 另外：`_fonts` 目录**不参与迁移**（只复制了视频与字幕），迁移后片源字体丢失，字幕回退到 Noto Sans SC（观感变化，OP/ED 特效字幕最明显）。
- 前端提示「有 N 集失败，目录没有切换」（`offline.js:673`）与事实不符 —— 部分文件其实已经切过去了。

**N9 · 矮窗口下「更多站点 / 链接规则」弹窗内容溢出底框（`styles.css:3434 / 3752`）· 确定（实测）**
- 见 B9 尾部数据；属于 B9 的同类，只是没裁字。

**N10 · 「更多站点」首次打开强制联网，有缓存也打不开（`rules-menu.js:148-153`）· 确定**
- `linkRulesState.items` 每次刷新页面都是空的，`openRulesMenu` 看到空就 `loadLinkRules(true)` → **force 刷新**，不走本地 `link-rules.json`。断网/连不上 GitHub 时列表为空并显示错误，尽管本机有 74 条缓存。
- 影响：每次刷新页面后的第一次点「更多站点」都要等一次 2 秒联网；离线不可用。

**N11 · 文件被外部删除后界面仍显示「可以播放」（`offline.py:16 / offline_service.py:458`）· 确定**
- `STATUSES` 里定义了 `missing`，但全仓没有任何地方写入它，也没人校验 `file_path` 是否存在。
- 点播放才会 404「本地文件不在了」（`http_read.py:21-23`）。缺一层「刷新时核对文件是否还在」。

**N12 · 搜索/状态请求没有版本号，慢响应会覆盖新番（`offline.js:88-99 / 208-217`）· 较可信**
- 对比 `renderVideoLinks()` 里有 `videoLinksLoadVersion` 的写法（`video-links.js:240-252`），离线这边没做。快速换番（或快速改关键词连按搜索）时旧响应后到 → 列表与「当前番」不匹配。

**N13 · 「订阅」toast 承诺了不会发生的事（`offline.js:575` + `offline_config.py:28`）· 确定**
- 自动追番总开关默认关；订阅后 toast 说「已订阅…的新集」，但不去设置里打开「自动追新番」就永远不会下。与 B3 同类（说明文案与实际行为不符）。建议文案改成「已订阅；到设置里打开『自动追新番』后才会自动下载」。

**N14 · 目录可写性探测有并发竞态（`offline_config.py:130-140`）· 较可信**
- 固定文件名 `.handbook-write-test`：两个请求同时 `ensure_dirs`（例如设置页与 `summary` 同时到达），一个刚 unlink、另一个 mkdir/write 会抛 `FileNotFoundError` → 误报「目录不可写」。

**N15 · 集数识别的两个隐患（`media.py:285-317` + `offline_service.py:411-414`）· 待确认**
- ① 文件名里没有其它数字时，`10-bit` / `8bit` 这类标签会被 `_TRAILING_NUMBER_RE` 当成第 10 集（剧场版/合集种子风险）；且 `number > 0` 时**优先于**用户指定的 `episode_key`。
- ② 所有归档一律写成 `0:N`（`media.py:320-322`），特别篇/OVA 的下载会被记成本篇第 N 集 —— 详情页「特别篇 02」格子上看不到已下载，本篇 02 反而多出一个文件。
- 不确定点：需要你手上真实的 SP/OVA 种子名才能定论；本轮没有足够样本。

### C 档

**N16 · 本地文件列表按字符串排序，10 排在 2 前面（`offline.py:239`）· 确定**
- `ORDER BY episode_key` → `0:1, 0:10, 0:11, 0:2 …`。超过 9 集就会看到顺序乱。前端没有再排序。

**N17 · 暂停状态借 `error` 字段传达（`offline_service.py:551-556`）· 确定（影响小）**
- `task_action` 把「已暂停」写进 `error`，下一次 `_sync` 会把它清空（`:321`）。目前前端靠 `live.state` 的 `paused` 前缀判断（`offline.js:252`），所以显示是对的；但 DB 里的 `error` 语义已经混了。

**N18 · `episode_gestures.normalize` 不合并默认绑定（`episode_gestures.py:86-107`）· 确定（当前前端不受影响）**
- 传部分 `bindings` 时，未传的默认绑定全部丢失。当前前端每次提交全量 11 个下拉框，所以碰不到；外部 PATCH / 旧客户端会踩。

**N19 · `settings.js` 有 6 个重复定义的函数（`8-23` 与 `171-177`）· 确定（当前行为正确）**
- `detailLinksFromDom / readDetailLinks / commitDetailLinks` 各定义两次，靠后定义覆盖前定义。前者返回的对象**没有 id**，一旦有人删掉后面的「兼容旧调用名」段，id 就会丢、排序与固定都会串。属埋雷。

**N20 · 离线配置并发保存会丢更新（`offline_config.py:109-116`）· 较可信**
- `search()` 记 `mikan_host`、`download()` 记 `last_group`、设置页保存，都是「读-改-写」整个 JSON。两个请求同时到，后写的覆盖前写的。影响小（丢一次字幕组偏好/主机记忆）。

---

## 3. 未复现 / 证据不足

1. **B8 完结后药丸消失**：`aired >= total` 直接不渲染，无法判断这是「恢复旧版」的一部分还是新引入的行为，需要你确认想要哪种。
2. **#8446「更多站点格式与其他一样」**：视觉上一致，但 `<button>` 与 `<a>` 的键鼠行为差异没人验证过；需要你在浏览器里试一次中键点击。
3. **N15 特别篇/OVA 归档**：没有真实种子样本，纯代码推断。
4. **N4 部分入库**：需要一次「归档中杀进程」实证，本轮只做了代码路径确认。
5. **B7 极窄视口**：只量过 1080/600/520/470px，`≤430px` 单列布局下评分行与封面的相对位置没量。
6. **并发只读缺陷**：本轮两次跑，一次 1 失败、一次全过，频率与 11-06 记录一致，未做进一步定位（已定位过，未修）。

---

## 4. 如果之后要修，我建议的顺序

1. **N1**（播错番）+ **N3**（删了不能再下）+ **N4**（部分入库永久缺失）—— 三个都会造成「看到的和实际不一致」，且都在归档/播放链路上。
2. **N2**（面板轮询）—— 一并把 B11 的三个残留收掉：轮询 3 秒、重试加次数上限、归档失败给可操作提示。
3. **N7 / N8 / N15**（写错位置、迁移半途、集数识别）—— 数据正确性，改动集中在 `offline_service._archive` 与 `migrate_media_root`。
4. **N10 / N11 / N13 / N16**（缓存、缺文件、文案、排序）—— 小改动、用户可感知。
5. **B1 的箭头**（把 `↗` 并进可编辑名称）、**N9**（rules 弹窗 flex-shrink）、**N5 / N17 / N18 / N19 / N20**（清理项）。
6. **K1**（sqlite 只读）—— 独立的加固项，建议单独一轮，用「常驻写连接 + 一次重试」的组合。

---

## 5. 本轮做过的验证

- 代码通读：`offline_service.py` / `offline.py` / `offline_config.py` / `media.py` / `mikan.py` / `qbittorrent.py` / `torrent_meta.py` / `link_rules.py` / `episode_gestures.py` / `http_read.py` / `http_post.py` / `settings_service.py` / `common.py` / `database.py`（离线相关段），前端 `offline.js` / `details.js` / `video-links.js` / `rules-menu.js` / `settings.js` / `episode-gesture.js` / `collection.js` / `presentation.js` / `styles.css`（离线与详情段）。
- 全仓 grep：`state.animes =`（确认唯一写入口）、`OfflineService(`（确认只有 HTTP 调用、无后台 worker）、`has_subtitle`、`low_space_gb / warn_size_gb`（声明了但没有任何读取点 —— 容量提醒目前只在设置页显示「剩余 N GB」）、`missing`（定义未使用）。
- 实测：后端全量 2 次（478 项，1 次 1 失败）；playwright 5 个视口 × 2 个弹窗的 flex 溢出测量。
- 未做：前端 52 个 verify 脚本全量重跑；真实服务下的端到端点击（会动真实库，本轮不动）。


---

## 修复记录（二）：N1 / N3 / N4（2026-11-07 傍晚）

- **N1（播错番）**：新增 `localFileForEpisode(key)`（offline.js）——按 `state.progressAnime` 同步 `offlineView.animeId/animeName` 身份（不一致就清缓存）、`await refreshOfflineLocal()` 按当前番拉取后再找文件；`details.js` 的 play 分支改为 `await` 它。番没有 id 时不发请求、安静提示。四个场景的回归测试 `tests/verify_episode_play.cjs`：缓存挂着上一部番的同集号文件→不播错只提示；当前番有文件→播放正确 id；会话首次触发（animeId=0）→按新番拉取成功；无 id→不发请求。
- **N3（删了不能再下）**：`OfflineStore.create_job` 合并同 hash 任务时，若已有任务状态是 `ready`（如某集被删）或 `failed`，重置为 `queued` 并清错误——重新点同一条种子即表达「再要一次」，下载完成后归档按已入库的集跳过、只补缺的。测试：删集 → 重登记 → 状态回 queued → 归档补齐 0:2。
- **N4（部分入库永久缺失）**：主体随 #9480 修复（早退条件从「有一集入库」收紧为「status=ready 且全部入库」；`ingested < len(files)` 抛错计入重试；重试按 key 跳过已入库集）。本次补上崩溃残留的实证测试：status 卡在 processing + 已入库 1 集 → 归档继续补第 2 集并标 ready，不再被 `any()` 误判成完成。

---

## 修复记录（2026-11-07 下午）

- **B11 残留 1（无后台 worker）**：`offline_service.start_background_worker()` 已在 `desktop.main` 启动，每 5 秒 `sync_all()` 推进所有活动任务与待重试归档；下载面板开着时前端另加 3 秒轮询把结果画出来（审计建议的「轮询 3 秒」一并落实，N2 关闭）。
- **B11 残留 2（30 秒重试无上限）**：新增 `local_media.archive_retries`（自动迁移），自动重试上限 `MAX_ARCHIVE_RETRIES = 5`，到顶停手等手动按钮；错误信息带「自动重试 x/5」；手动重试清零。
- **N4（部分入库判成完成）**：`_archive` 按已入库集数比对文件总数，未齐报「只入库 x/y 集」并计入重试；重试时已入库的集按 episode_key 跳过不重复封装；用户改名后手动重试可补完。
