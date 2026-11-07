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
| 「更多站点」格式与其他链接一致 | **已修** | 已是真 `<a href="#rules-menu=…">`（`video-links.js:112`）：左键 `preventDefault` 仍弹应用内站点菜单，中键新标签、右键复制地址交给浏览器原生处理；在新标签里打开时 `rules-menu.js:168-176` 读哈希自动弹出同一个菜单（与「保存视频」的 `#save-video=` 同一套机制）。字号/颜色/加粗本就与旁边三条一致（`.detail-link-menu`，`styles.css:3750`） |
| 链接后的箭头可去掉 | **已修（#8446 收口）** | 上一轮先把渲染处硬拼的 `↗` 全删了；这一轮按「默认在名字里、能自己删掉」的口径把箭头写回**默认名称**：预设变成 `Bangumi #{id} ↗` / `B站搜索 ↗`，「更多站点」默认名仍带 `▾`。名称就是设置里那个输入框，删掉箭头即生效。顺带清掉历史数据里两条预设的 `id: "undefined"`（会让「新增同步」把它们当成同一条）。 |
| 链接超一行时日期单独占一行 | **已修** | `.progress-meta` 由 flex 改回块级行内流（`styles.css:1603-1611`），注释写明原因 |

**影响面**：箭头一条只影响观感；`<button>` → `<a>` 一条已收口，键鼠行为与其它三条链接一致（见 CHANGELOG「详情页链接的箭头硬拼与『更多站点』按钮行为」）。

### B2 · `#8631` 日期与链接挤太紧 + 详情信息重排（17:08）

- **已修 · 确定**。`.meta-separator { margin: 0 9px }`（`styles.css:3827`）；评分/个人评分/收藏状态合并进 `.progress-info-row`（`styles.css:3829`，`index.html:368`）。
- 注意：`#progressAirDate` 不要再加右外边距，否则是双倍间距（历史坑，已写在注释里）。

### B3 · `#8668 / #8715` 离线面板说明句 + 不好看（17:12 / 17:22）

- **已修 · 确定**。`index.html:297-317` 里已无「在蜜柑里搜关键词…」这句；面板结构与层级按截图重做过（`styles.css:3836-3878`）。
- 同类 · ✅ 已修：`#8668` 的诉求本质是「说明文字占地方」；当时另有一处「订阅按钮的 toast 在承诺实际不会发生的事」，已随 N13 修掉（文案按自动追番开关分两档）。

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

- **已修 · 确定**。`presentation.js:37-40` 恢复绿点药丸、只显示「已播 N」，总集数与来源放进 `title`。**下集时间脚注（`episodeNextAiringNote`）后来被整条去掉**（版本号 `20261107-no-next-airing`）：同一条信息改由详情页头部那行「首播日期 · 每周X更新」承担，页面上不再有第二个下集时间。
- **口径已定 · 保持现状（2026-11-07 你确认）**：`aired >= total` 时整个药丸 `return ""`（`presentation.js:35`），**完结番不显示任何进度标记，也不加「已播完」**。旧版是否也隐藏无法从代码判断（证据不足），但集数格子本来就是齐的，多一个「已播完」只是噪音；代码里已留注释说明这是刻意口径，`tests/verify_airing_progress.cjs:26` 有断言兜住。

### B9 · `#9161` 矮窗口下界面显示不全（18:48）

- **已修 · 确定**。`.offline-modal .modal-frame > :not(.offline-panel) { flex-shrink: 0 }` 等 5 条（`styles.css:3901-3905`），列表/设置区 `flex:1 1 auto; min-height:0`。
- **同类 · ✅ 已修（N9）**：`.rules-dialog` / `.rules-menu-dialog` 也是「flex 纵向 + max-height」，当时确实同样溢出（30 行数据）：`520px` 高溢出 12px、`480px` 高溢出 46px，超出部分落到白色底框之外（靠 dialog 自身滚动才看得到，文字没被裁）。已按同一思路修掉：`.rules-list { min-height: min(200px, 30vh) }` + 非列表子元素 `flex-shrink: 0` + `@media (max-height: 620px)` 隐藏说明句并把列表下限放到 40px + 白框 `overflow-y: auto` 兜底（`styles.css:4222-4231`）。复测 900/640/520/480/420/380 六档零溢出（`tests/verify_rules_modal_height.cjs`）。

### B10 · `#9449` 换番后找资源仍用上一部番（19:29）

- **已修 · 确定**。`openOffline()` 用 `offlineView.animeId / animeName` 判断 `switched`，换番时重置 query/items/group/local 并自动搜新番名（`offline.js:34-64`）；`verify_offline_switch.cjs` 覆盖。
- **同类 · ✅ 已修（与 N12 同一处）**：同一部番之外，`refreshOfflineLocal()`、`runOfflineSearch()` 当时都没有「请求版本号」，慢响应会覆盖新番的数据。现各带 token + animeId 双重校验（`offline.js:99/107/118`、`229/233/238`）；更严重的「播放」手势（N1）同轮改成按当前番自取一份，不吃共享缓存，见修复记录（三）。

### B11 · `#9480` 下载完显示未归档、刷新也没用（19:36）

- **已修 · 确定**（你的真实任务 id=1 当时已手工修好）：归档短轮询 10 次、等文件大小稳定（`offline_service.py:362-394`）；方括号纯数字/第N话/EPN 识别（`media.py:289-302`）；`_sync` 对「归档失败」加 30 秒限频重试（`offline_service.py:271-279`）；`POST /api/offline/retry` + 面板「重试归档」按钮（`offline.js:474-488`）。
- **残留 3 点**（都在同一根因上，见 N2/N3/N4）· ✅ 全部收尾：
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

**N2 · 离线面板没有轮询，下载进度/归档不会自己走（`offline.js` 全模块）· 确定 · ✅ 已修复**
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

**N5 · 「本地文件」里的「字幕」标签永远不显示（`offline.js:236`）· 确定 · ✅ 已修复**
- `file.has_subtitle` 这个字段后端从来不返回（`local_files` 表没有这一列，`database.py:226-238`；`state` 直接透传行数据）。
- 影响：纯观感，但说明「这一集有没有字幕」在列表里看不出来。
- 修法：随 N11 的读时核对一起解决 —— `_annotate_files()` 每行补 `has_subtitle = subtitle_path 存在且 is_file()`（不写库）。现在真有字幕才显示「字幕」标签。

### B 档

**N6 · 字幕抽取不看编码，SRT/PGS 会被存成 `.ass`（`media.py:183-197`）· 较可信**
- `-map 0:s:0 -c copy` 到目标 `第 05 集.ass`：如果第一条字幕轨是 SRT 或 PGS（图形字幕），文件内容不是 ASS，libass/jassub 解析失败 → 页面内字幕起不来，而 `subtitle_path` 非空，播放器仍显示「字幕 · 开」并报「页面内字幕没起来」。
- 已有一条保底：`probe()` 里其实拿到了 `subtitle_codec`（`media.py:114`），只是没用于判断。
- 不确定点：蜜柑上主流是内封 ASS，命中率不高；但 BDRip 的 PGS 并不少见。

**N7 · 归档回退时会抓「下载目录里最新的一个视频」（`offline_service._resolve_files`）· 较可信 · ✅ 已修复**
- 触发：qB 还没给出 `content_path`（刚 100%、或种子结构异常），且下载目录里同时有别的任务在写。
- 风险：取 mtime 最新的那个文件，可能是**另一个番**的成品 → 被 remux 进当前番的目录并按当前番的集数命名。属于「写错位置」的数据错误。
- 修法：`content_path` 不可用时只按种子名（qB 的 `name`，退回任务记录里的 `torrent_name`）在同一目录下找同名文件/文件夹；找不到就报「没有找到这个任务的视频文件」等用户处理。代价是 qB 把种子内顶层名改得面目全非时要人工重试，但不再有写错番的可能。

**N8 · 迁移媒体库失败时，数据库已改指向新目录（`offline_service.migrate_media_root`）· 确定 · ✅ 已修复**
- 循环里逐个 `replace_file` 把 DB 指到新路径，但 `switched = not failed` 才写配置。一旦有文件失败：盘上多一份副本、DB 指向新副本、配置仍指旧目录 → 新旧两个媒体库并存，`_trash` 与后续下载仍走旧目录。
- 另外：`_fonts` 目录**不参与迁移**（只复制了视频与字幕），迁移后片源字体丢失，字幕回退到 Noto Sans SC（观感变化，OP/ED 特效字幕最明显）。
- 前端提示「有 N 集失败，目录没有切换」（`offline.js`）与事实不符 —— 部分文件其实已经切过去了。
- 修法：改成两阶段。先复制视频、字幕、`_fonts` 并逐个校验大小（只记录、不碰 DB），全部成功后才一次性写 `local_files` 与配置；任一失败则 `_rollback` 删掉这次新建的副本（目标目录原有文件不动）、清掉这次建的空目录，DB 与配置原样返回 `rolled_back: true`。`delete_source` 挪到最后一步，失败时不会删除任何源文件。返回结构新增 `attempted / rolled_back / warnings / fonts`，前端文案改成「迁移没有执行：<原因>。新目录里的副本已清掉，媒体库仍是原目录」。

**N9 · 矮窗口下「更多站点 / 链接规则」弹窗内容溢出底框（`styles.css:3434 / 3752`）· 确定（实测）· ✅ 已修复**
- 见 B9 尾部数据；属于 B9 的同类，只是没裁字。
- 根因：列表写死 `min-height: 200px`，而框是 `max-height: 86vh + flex 纵向`，窗高一压就顶出去（400px 高溢 24px、380px 高溢 110px）。
- 修法：三层。① 列表下限改成 `min(200px, 30vh)`，窗矮了自己让位；② `.rules-dialog / .rules-menu-dialog .modal-frame > :not(.rules-list) { flex-shrink: 0 }`，标题/工具栏/状态行/底部按钮不再被压扁裁字；③ `@media (max-height: 620px)` 里先藏掉说明句、列表下限放到 40px（约一行），真到极限再让白框自己滚（`overflow-y: auto`），内容永远不落到框外。
- 复测（1280 宽 × 900/640/520/480/420/380 高）：两个弹窗 `scrollHeight - clientHeight` 全为 0；标题 `scrollHeight == clientHeight`（没被压扁）；400px 高时底部「取消 / 添加选中的 N 个」完整可见。

**N10 · 「更多站点」首次打开强制联网，有缓存也打不开（`rules-menu.js:148-153`）· 确定 · ✅ 已修复**
- `linkRulesState.items` 每次刷新页面都是空的，`openRulesMenu` 看到空就 `loadLinkRules(true)` → **force 刷新**，不走本地 `link-rules.json`。断网/连不上 GitHub 时列表为空并显示错误，尽管本机有 74 条缓存。
- 影响：每次刷新页面后的第一次点「更多站点」都要等一次 2 秒联网；离线不可用。
- 修法：改成 `loadLinkRules(false)`（先 `GET /api/link-rules` 读本地 JSON，只有本地确实没有缓存时才 POST 刷新），并在等待期间显示「正在获取规则…」。实测：刷新页面后首次点开 74 个站点 121 ms 出列表，请求只有一条 `GET /api/link-rules`。

**N11 · 文件被外部删除后界面仍显示「可以播放」（`offline.py:16 / offline_service.py:458`）· 确定 · ✅ 已修复**
- `STATUSES` 里定义了 `missing`，但全仓没有任何地方写入它，也没人校验 `file_path` 是否存在。
- 点播放才会 404「本地文件不在了」（`http_read.py:21-23`）。缺一层「刷新时核对文件是否还在」。
- 修法：`state()` 新增 `_annotate_files()`，每行带上 `exists` 与 `has_subtitle`；`ready_episodes` 只收 `exists` 的，另下发 `missing_keys / missing_count`。**刻意不落库**：外接盘临时没插、文件被挪走都会自己恢复，写成 `missing` 反而要人工修。前端把「文件不在了」单独列一段（角标只数能播的）、不给播放按钮、删除确认文案改成「只清记录」；详情页手势与 `playLocalFile` 都当「没下载」处理。顺带修好：`has_subtitle` 后端其实一直没下发，列表里的「字幕」标签从来没显示过。

**N12 · 搜索/状态请求没有版本号，慢响应会覆盖新番（`offline.js:99 / 229`）· 确定 · ✅ 已修复**
- 对比 `renderVideoLinks()` 里有 `videoLinksLoadVersion` 的写法（`video-links.js:213/256/268`），离线这边当时没做。快速换番（或快速改关键词连按搜索）时旧响应后到 → 列表与「当前番」不匹配。
- 修法（B11 收尾时顺手完成）：`offlineView.searchToken` / `localToken` 在请求前各自自增并捕获，响应回来先比对 `token !== 当前值 || animeId !== offlineView.animeId`，不匹配直接 return —— 成功分支和 catch 分支都做了这层校验，不会拿旧番的文件/搜索结果去画新番。字幕另有独立的 `subtitleToken`（换集或关播放器即失效）。

**N13 · 「订阅」toast 承诺了不会发生的事（`offline.js:575` + `offline_config.py:28`）· 确定 · ✅ 已修复**
- 自动追番总开关默认关；订阅后 toast 说「已订阅…的新集」，但不去设置里打开「自动追新番」就永远不会下。与 B3 同类（说明文案与实际行为不符）。建议文案改成「已订阅；到设置里打开『自动追新番』后才会自动下载」。
- 修法：订阅 / 订阅列表接口都带回 `auto_follow`；关着时 toast 说「已订阅…；到设置里打开『自动追新番』后才会自动下载」，订阅列表顶部再加一句「『自动追新番』关着：这些订阅只在点『立即检查全部订阅』时才会查一次」，按钮 title 也改成同一口径。开着时仍然是原来的「已订阅…的新集」。

**N14 · 目录可写性探测有并发竞态（`offline_config.py:130-140`）· 较可信**
- 固定文件名 `.handbook-write-test`：两个请求同时 `ensure_dirs`（例如设置页与 `summary` 同时到达），一个刚 unlink、另一个 mkdir/write 会抛 `FileNotFoundError` → 误报「目录不可写」。

**N15 · 集数识别的两个隐患（`media.episode_identity` + `offline_service._archive`）· 待确认 · ✅ 已修复（第 ② 项无真实种子样本，按命名约定实现）**
- ① 文件名里没有其它数字时，`10-bit` / `8bit` 这类标签会被 `_TRAILING_NUMBER_RE` 当成第 10 集（剧场版/合集种子风险）；且 `number > 0` 时**优先于**用户指定的 `episode_key`。
- ② 所有归档一律写成 `0:N`（`media.episode_key`），特别篇/OVA 的下载会被记成本篇第 N 集 —— 详情页「特别篇 02」格子上看不到已下载，本篇 02 反而多出一个文件。
- 修法：① 新增 `_NOISE_TOKEN_RE`，先把 `10bit / 8bit / 1080p / x264 / h.265 / 23.976fps / 128kbps / 2ch` 整段抹掉再找集数，兜底候选同样过滤分辨率与年份；单文件任务里用户明确指定的 `episode_key` 提升为最高优先级。② 新增 `episode_identity(name) -> (类型, 集数)`，SP/OVA/OAD/番外/特别篇/特典 记为类型 1，入库 `1:N`、文件名「特别篇 02」；`SPY×FAMILY` 里的 SP 与 `[01-12+SPx1]` 这类合集标记不会误判；`episode_key/episode_filename` 增加类型参数（默认 0，旧调用不变），本地文件列表标签按类型显示。
- 遗留：已经按本篇归档的历史特别篇不会自动改 key（无法可靠区分），需要删掉那一集重新归档。

### C 档

**N16 · 本地文件列表按字符串排序，10 排在 2 前面（`offline.py:239`）· 确定 · ✅ 已修复**
- `ORDER BY episode_key` → `0:1, 0:10, 0:11, 0:2 …`。超过 9 集就会看到顺序乱。前端没有再排序。
- 修法：新增 `media.key_sort_value()`（先类型、再集数数值，`bgm:123` 这类非数字标识排到数字之后），`files_for_anime()` 与 `all_files()` 取回后在 Python 里排序；`ready_episodes / missing_keys` 也按同一把尺子排。

**N17 · 暂停状态借 `error` 字段传达（`offline_service.py:551-556`）· 确定（影响小）· ✅ 已修复**
- `task_action` 把「已暂停」写进 `error`，下一次 `_sync` 会把它清空（`:321`）。目前前端靠 `live.state` 的 `paused` 前缀判断（`offline.js:252`），所以显示是对的；但 DB 里的 `error` 语义已经混了。
- 修法：新增 `is_paused_state()` 与 `live.paused` 布尔值，暂停不再写 `error`（`task_action` 也不再用「已暂停」污染它）；前端优先读 `live.paused`，缺失时回落到状态字符串。顺带修好 qB 5：它把 `pausedDL` 改名成 `stoppedDL`，旧代码只看 `paused` 前缀，在 qB 5 上暂停按钮永远显示「暂停」而不是「继续」。

**N18 · `episode_gestures.normalize` 不合并默认绑定（`episode_gestures.py:86-107`）· 确定（当前前端不受影响）· ✅ 已修复**
- 传部分 `bindings` 时，未传的默认绑定全部丢失。当前前端每次提交全量 11 个下拉框，所以碰不到；外部 PATCH / 旧客户端会踩。
- 修法：`bindings` 先 `{**DEFAULT_BINDINGS, **传入}` 再校验（和 `slots` 一个口径：缺键=默认，显式 `""`=解绑）。前端 `readEpisodeGestureSettings()` 相应改成**空值也发**（以前跳过空值，用户清空下拉框后保存时默认绑定会悄悄长回来）。

**N19 · `settings.js` 有 6 个重复定义的函数（`8-23` 与 `171-177`）· 确定（当前行为正确）· ✅ 已修复**
- `detailLinksFromDom / readDetailLinks / commitDetailLinks` 各定义两次，靠后定义覆盖前定义。前者返回的对象**没有 id**，一旦有人删掉后面的「兼容旧调用名」段，id 就会丢、排序与固定都会串。属埋雷。
- 修法：删掉前面那份旧实现（保留文件顶部一句注释指路），现在每个名字只定义一次，走 `linkRowsFromDom / readLinkList / commitLinkList`。`detailLinks()` / `scheduleDetailLinks()` 的预设兜底也补上了 id（以前周表存下去会得到字符串 `"undefined"`，`normalizeDetailLink` 现在把 `"undefined"` 当成没 id 重新生成）。

**N20 · 离线配置并发保存会丢更新（`offline_config.py:109-116`）· 较可信 · ✅ 已修复**
- `search()` 记 `mikan_host`、`download()` 记 `last_group`、设置页保存，都是「读-改-写」整个 JSON。两个请求同时到，后写的覆盖前写的。影响小（丢一次字幕组偏好/主机记忆）。
- 修法：`offline_config` 加模块级 `RLock`，`save()` 落盘在锁内；新增 `patch(**fields)`（读-改-写整段持锁，只动传入的键）与 `save_settings()`（只覆盖设置表单真的提交了的键）。`search()` 记主机、`migrate_media_root()` 改目录改走 `patch()`，设置页改走 `save_settings()`。
- 附带修掉一个一直在丢数据的路径：设置页提交的 JSON 里没有 `mikan_host` / `last_group`，以前整份覆盖会把它们清空 —— 现在保存一次设置，实测 `mikan_host=https://mikanime.tv`、`last_group={'554779': '云光字幕组'}` 都还在。

---

## 3. 未复现 / 证据不足

1. ~~**B8 完结后药丸消失**~~ —— 口径已定，见 B8：完结番不显示进度药丸，**不标「已播完」**（2026-11-07 确认保持现状）。
2. ~~**#8446「更多站点格式与其他一样」**：`<button>` 与 `<a>` 的键鼠行为差异没人验证过~~ —— 已换成真 `<a href="#rules-menu=…">`（`video-links.js:112`），中键/右键都是浏览器原生行为，不需要再手工验证。
3. **N15 特别篇/OVA 归档**：已按命名约定实现（SP/OVA/OAD/番外/特典 → `1:N`），但仍没有真实种子样本端到端跑过；手上如果有这类种子，值得补一次实测。
4. **N4 部分入库**：需要一次「归档中杀进程」实证，本轮只做了代码路径确认。
5. **B7 极窄视口**：只量过 1080/600/520/470px，`≤430px` 单列布局下评分行与封面的相对位置没量。
6. **并发只读缺陷**：本轮两次跑，一次 1 失败、一次全过，频率与 11-06 记录一致，未做进一步定位（已定位过，未修）。

---

## 4. 如果之后要修，我建议的顺序

1. **N1**（播错番）+ **N3**（删了不能再下）+ **N4**（部分入库永久缺失）—— 三个都会造成「看到的和实际不一致」，且都在归档/播放链路上。
2. **N2**（面板轮询）—— 一并把 B11 的三个残留收掉：轮询 3 秒、重试加次数上限、归档失败给可操作提示。
3. ~~**N7 / N8 / N15**（写错位置、迁移半途、集数识别）~~ —— ✅ 已完成。
4. ~~**N10 / N11 / N13 / N16**（缓存、缺文件、文案、排序）~~ —— ✅ 已完成。
5. ~~**B1 的箭头**（把 `↗` 并进可编辑名称）、**N9**（rules 弹窗 flex-shrink）、**N5 / N17 / N18 / N19 / N20**（清理项）~~ —— ✅ 已完成。
6. **K1**（sqlite 只读）—— 独立的加固项，建议单独一轮，用「常驻写连接 + 一次重试」的组合。

---

## 5. 本轮做过的验证

- 代码通读：`offline_service.py` / `offline.py` / `offline_config.py` / `media.py` / `mikan.py` / `qbittorrent.py` / `torrent_meta.py` / `link_rules.py` / `episode_gestures.py` / `http_read.py` / `http_post.py` / `settings_service.py` / `common.py` / `database.py`（离线相关段），前端 `offline.js` / `details.js` / `video-links.js` / `rules-menu.js` / `settings.js` / `episode-gesture.js` / `collection.js` / `presentation.js` / `styles.css`（离线与详情段）。
- 全仓 grep：`state.animes =`（确认唯一写入口）、`OfflineService(`（确认只有 HTTP 调用、无后台 worker）、`has_subtitle`、`low_space_gb / warn_size_gb`（声明了但没有任何读取点 —— 容量提醒目前只在设置页显示「剩余 N GB」）、`missing`（定义未使用）。
- 实测：后端全量 2 次（478 项，1 次 1 失败）；playwright 5 个视口 × 2 个弹窗的 flex 溢出测量。
- 未做：前端 52 个 verify 脚本全量重跑；真实服务下的端到端点击（会动真实库，本轮不动）。



---

## 修复记录（六）：B1 箭头 / N9 弹窗高度 / N5·N17·N18·N19·N20 清理（2026-11-07 深夜）

- **B1**：箭头回到「默认名称」里 —— `DETAIL_LINK_PRESETS` 改成 `Bangumi #{id} ↗` / `B站搜索 ↗`（更多站点默认名带 `▾`），删除箭头就是在设置里删字符。顺带修掉 `id: "undefined"`：`normalizeDetailLink` 把字符串 `undefined` 当作没 id 重新生成，`detailLinks()` / `scheduleDetailLinks()` 的预设兜底也补了 id。已用 API 把现有两套列表里的预设名补上箭头、清掉坏 id。
- **N9**：`.rules-list { min-height: min(200px, 30vh) }` + 两个规则弹窗的非列表子元素 `flex-shrink: 0` + `@media (max-height: 620px)` 隐藏说明句、列表下限 40px + 白框 `overflow-y: auto` 兜底。复测 900/640/520/480/420/380 六档全部无溢出、标题不被压扁。
- **N5**：随 N11 的 `_annotate_files()` 一起解决，`has_subtitle` 现在真的会下发。
- **N17**：新增 `is_paused_state()`（`pausedDL / stoppedDL / pausedUP / stoppedUP`）与 `live.paused`；`task_action` 不再把「已暂停」写进 `error`，返回 `paused`；前端优先读 `live.paused`。
- **N18**：`bindings` 先合并默认再校验（缺键=默认、`""`=解绑）；前端空值也发。
- **N19**：删掉 `settings.js` 顶部那份重复实现，每个链接读写函数只剩一处定义。
- **N20**：`offline_config` 加 `RLock`，新增 `patch()` / `save_settings()`；`search()`、`migrate_media_root()`、设置页保存分别改走它们；设置页保存不再清空 `mikan_host` / `last_group`。
- **测试**：
  - `tests/test_offline_config.py` +3：`patch` 只动指定键、两线程并发不互相覆盖、设置保存保留学习到的状态。
  - `tests/test_episode_gestures.py` +2：部分绑定保留默认、`""` 才是解绑。
  - `tests/test_offline_retry.py` +5（`PauseStateTests`）：qB 4/5 暂停状态识别、暂停不写 error、继续清 error、`_sync` 下发 `live.paused`。
  - `tests/verify_rules_modal_height.cjs`（新增）：六档窗高下两个弹窗都不溢出、标题不裁、列表保底一行、高窗口仍有 200px+。
  - `tests/verify_offline_paused.cjs`（新增）：`live.paused` 优先、`stoppedDL` 认出暂停、无 `paused` 字段时回落状态字符串、暂停不再出现在 error 里。
  - `tests/verify_detail_links.cjs`、`tests/verify_gesture_settings.cjs` 补断言（箭头在名字里可删、解绑要显式发空串、每行带 id）。
  - 后端 509 项通过（不含已知并发写失败的 `test_hardening`）；前端 60 个 verify 脚本全过；真实服务下确认详情页显示 `Bangumi ↗ / bilibili ↗`，设置保存一次后 `mikan_host` / `last_group` 仍在。

---

## 修复记录（五）：N10 缓存优先 / N11 缺文件 / N13 订阅文案 / N16 排序（2026-11-07 夜间）

- **N10**：`openRulesMenu` 的 `loadLinkRules(true)` → `loadLinkRules(false)`；只有本地 `link-rules.json` 确实为空时 `loadLinkRules` 内部才 POST 刷新。等待期间菜单显示「正在获取规则…」，拿到后重绘。实测本机 74 条规则：刷新页面后首次点开 121 ms 出列表，网络侧只有 `GET /api/link-rules`。
- **N11**：`OfflineService._annotate_files()` 给每一行补 `exists` / `has_subtitle`（一次 `is_file()`，不写库）；`state()` 的 `ready_episodes` 只含 `exists` 的行，另下发 `missing_keys`、`missing_count`。前端本地文件页把缺失的单独列成「文件不在了 · N 集」，不给播放按钮、只留「删除记录」，并提示「插回去/放回原位会自动恢复」；`localFileForEpisode()` 与 `playLocalFile()` 都把缺失当「没下载」；删除确认与 toast 按有没有文件分两套文案（原来对缺失文件也说「会移到 _trash」）。顺带修好一直没生效的「字幕」标签（后端此前没下发 `has_subtitle`）。
- **N13**：`subscribe()` / `subscriptions()` 返回 `auto_follow`；总开关关着时 toast 说「已订阅…；到设置里打开『自动追新番』后才会自动下载」，订阅列表顶部补一句「『自动追新番』关着：只在点『立即检查全部订阅』时才会查一次」，搜索结果的「订阅」按钮 title 同步改口径。
- **N16**：新增 `media.key_sort_value()`；`files_for_anime()` / `all_files()` 改在 Python 侧按「类型 → 集数数值」排序（`0:1, 0:2, 0:10, 0:11, 1:3`，`bgm:123` 排最后）。
- **测试**：
  - `tests/test_offline_state.py`（新增 5 项）：在盘的能播、被删的不算能播、字幕单独判定、拔盘后记录保留且插回自动恢复、缺失列表按集数排。
  - `tests/test_offline_store.py` +1：`files_for_anime` 按数值排序。
  - `tests/test_offline_subs.py` +1：订阅/订阅列表回传 `auto_follow` 真假。
  - `tests/test_media.py` +1：`key_sort_value` 数值序、非数字标识排尾且稳定。
  - `tests/verify_offline_missing_files.cjs`（新增）：缺失分组与角标、缺失行无播放按钮、播放守卫、`localFileForEpisode` 跳过缺失、删除文案分两套、订阅 toast 两档、订阅列表提示开关状态。
  - `tests/verify_rules_menu_cache.cjs`（新增）：首次打开传 `force=false` 并立即出列表、有缓存时一次请求都不发。
  - 后端全量 499 项通过（不含已知并发写失败的 `test_hardening`）；前端 58 个 verify 脚本全过；真实服务下点开「更多站点」与离线面板各验一次，无 JS 报错。

---

## 修复记录（四）：N7 写错位置 / N8 迁移半途 / N15 集数识别（2026-11-07 晚）

- **N7**：新增 `OfflineService._resolve_files()`。`content_path` 不可用（qB 刚 100%、种子结构异常、刚重启）时，只按种子名去下载目录里找同名文件/文件夹（qB 的 `name`，退回 `job.torrent_name`），不再「取 mtime 最新的一个」。找不到就报「下载目录里没有找到这个任务的视频文件」，交给自动重试（30 秒后、最多 5 次）或手动重试。取舍：极少数种子内顶层名被改过的任务要人工处理，但不会再把别的番的成品写进当前番的目录。
- **N8**：`migrate_media_root()` 改成两阶段。
  - 阶段一：逐条复制视频、字幕、各番目录下的 `_fonts`，逐条校验大小；只记录 `plan` 与 `failed`，**不碰数据库**。
  - 有失败：`_rollback()` 删掉这次新建的副本（复制前就存在的文件不动）、清掉这次建的空目录，返回 `copied=0 / attempted=N / rolled_back=true`，DB 与配置保持原样；`delete_source` 一个源文件都不删。
  - 全成功：一次性写 `local_files` → 保存配置 → 最后才删源。不会再有「DB 指新目录、配置指旧目录」的半途状态。
  - 字体：以前完全不迁，迁移后特效字幕回退 Noto Sans SC；现在一起搬，搬不动只记 `warnings`、不阻塞整批。
  - 前端 `migrateMediaRoot()` 文案改成「迁移没有执行：<原因>。新目录里的副本已清掉，媒体库仍是原目录」，成功时带上字体数量与 warning 数。
- **N15**：
  - ① `media._NOISE_TOKEN_RE` 先抹掉 `10bit / 8-bit / 1080p / 720i / 23.976fps / 128kbps / 128k / x264 / h.264 / h265 / 48khz / 2ch`，再走原有 patterns 与兜底；兜底候选同时过滤分辨率集合与 1900–2100 年份（以前只有方括号分支过滤）。`某番 剧场版 10-bit.mkv` 从「第 10 集」变成「认不出」。
  - ① 单文件任务里 `job.episode_key`（用户明确指定）升为最高优先级，文件名推断退居其次；多文件任务仍然只认文件名（一个 key 会把整季写到同一集）。
  - ② 新增 `media.episode_identity(name) -> (type, number)`：SP/OVA/OAD/番外/特别篇/特典 记为类型 1；`SPY×FAMILY` 的 SP（后接字母）、`[01-12+SPx1]` 这类合集标记不误判。`episode_key / episode_filename` 增加类型参数（默认 0，旧调用行为不变），特别篇入库 `1:N`、文件名「特别篇 02」。`video_files()` 排序也改成「本篇在前、特别篇在后」。
  - 前端 `episodeLabelOf()` 按类型显示 `特别篇 02 / OP 01 / ED 01 / 预告 01`，`bgm:123` 这类非「类型:集数」的 key 原样显示。
- **测试**：
  - `tests/test_media.py` +6：10bit 不当集数、编码数字（x264/h.265/128kbps/23.976fps）不当集数、SP/OVA/方括号 SP/特别篇/番外识别、合集标记不误判、SPY×FAMILY 不误判、`episode_key/filename/label_for_key` 带类型。
  - `tests/test_offline_archive.py` +4：content_path 缺失时不抓别的番（并确认媒体库里没有产出）、按种子名目录仍能归档、SP01 入库为 `1:1` 且文件名「特别篇 01」、`episode_key` 优先于 10-bit 噪声（均用真实 ffmpeg 跑）。
  - `tests/test_offline_migrate.py` +3：中途失败回滚（DB 全指向原目录、新目录副本已清）、失败时 `delete_source` 不删源、`_fonts` 迁移。
  - `tests/verify_offline_episode_labels.cjs`（新增）：标签映射 6 种、本地列表「第 02 集 / 特别篇 02」、迁移失败与成功两套文案。
  - 后端全量 491 项通过（不含已知并发写失败的 `test_hardening`）；离线相关前端 verify 5 个全过。

---

## 修复记录（三）：N2 面板轮询 + B11 三个残留（2026-11-07 傍晚）

- **轮询节奏（N2 / B11 残留 1）**：`setOfflinePolling` 改成 `setTimeout` 自调度，间隔由 `offlinePollDelay()` 决定——有任务在下载/整理、或归档失败但自动重试还没到上限 → 3 秒；全都静止（没任务、只剩已放弃的失败）→ 15 秒，避免面板开着时每 3 秒打一次 qB。面板关闭即停、`document.hidden` 时不请求；`visibilitychange` 切回前台立刻补一次。
- **请求版本号（B10 残留 / 与轮询同源）**：`refreshOfflineLocal` 与 `runOfflineSearch` 各带 token + animeId 双重校验，换番后旧响应直接丢弃，不会把上一部番的文件/搜索结果画到新番上。播放手势 `localFileForEpisode` 改为自己按当前番直取一份（不吃共享缓存、不受「过期响应丢弃」影响）。
- **重试上限（B11 残留 2）**：`MAX_ARCHIVE_RETRIES = 5` 已有；`state()` 新增下发 `archive_retry_limit`，前端据此判断「还会自己再试」还是「已经停了」。
- **可操作提示（B11 残留 3）**：失败文案分三档——`已自动重试 x/5，稍后还会自动再试` / `已自动重试 5 次仍未成功，自动重试已停止：按上面的提示处理后点「重试归档」` / 首次失败 `点「重试归档」可以立即再试一次`；失败卡片下方新增一行提示（含「已入库的集会跳过，只补缺的」）。归档错误本身也改成带下一步动作：找不到视频→确认 qB 任务完成且文件在原处；认不出集数→改名成「番名 - 01」再重试；全是封装失败→换一条种子/查磁盘空间（此前一律报成「认不出集数」，方向是错的）。
- 测试：`tests/verify_offline_polling.cjs`（节奏决策 4 档、真实计时 3 秒内至少刷一次、关面板/切后台完全停、切回立刻补、旧番响应被丢弃）；`tests/verify_offline_retry.cjs` 补两档提示断言；后端新增「上限文案」「封装失败文案」「下发重试上限」3 项。

---

## 修复记录（二）：N1 / N3 / N4（2026-11-07 傍晚）

- **N1（播错番）**：新增 `localFileForEpisode(key)`（offline.js）——按 `state.progressAnime` 同步 `offlineView.animeId/animeName` 身份（不一致就清缓存）、自己按当前番直取一份 `/api/offline/state` 再找文件（不吃共享缓存）；`details.js` 的 play 分支改为 `await` 它。番没有 id 时不发请求、安静提示。四个场景的回归测试 `tests/verify_episode_play.cjs`：缓存挂着上一部番的同集号文件→不播错只提示；当前番有文件→播放正确 id；会话首次触发（animeId=0）→按新番拉取成功；无 id→不发请求。
- **N3（删了不能再下）**：`OfflineStore.create_job` 合并同 hash 任务时，若已有任务状态是 `ready`（如某集被删）或 `failed`，重置为 `queued` 并清错误——重新点同一条种子即表达「再要一次」，下载完成后归档按已入库的集跳过、只补缺的。测试：删集 → 重登记 → 状态回 queued → 归档补齐 0:2。
- **N4（部分入库永久缺失）**：主体随 #9480 修复（早退条件从「有一集入库」收紧为「status=ready 且全部入库」；`ingested < len(files)` 抛错计入重试；重试按 key 跳过已入库集）。本次补上崩溃残留的实证测试：status 卡在 processing + 已入库 1 集 → 归档继续补第 2 集并标 ready，不再被 `any()` 误判成完成。


---

## 修复记录（2026-11-07 下午）

- **B11 残留 1（无后台 worker）**：`offline_service.start_background_worker()` 已在 `desktop.main` 启动，每 5 秒 `sync_all()` 推进所有活动任务与待重试归档；下载面板开着时前端另加 3 秒轮询把结果画出来（审计建议的「轮询 3 秒」一并落实，N2 关闭）。
- **B11 残留 2（30 秒重试无上限）**：新增 `local_media.archive_retries`（自动迁移），自动重试上限 `MAX_ARCHIVE_RETRIES = 5`，到顶停手等手动按钮；错误信息带「自动重试 x/5」；手动重试清零。
- **N4（部分入库判成完成）**：`_archive` 按已入库集数比对文件总数，未齐报「只入库 x/y 集」并计入重试；重试时已入库的集按 episode_key 跳过不重复封装；用户改名后手动重试可补完。
