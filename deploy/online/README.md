# 动漫手账线上版

这是同一个项目的独立运行入口，复用 `app.py` 的业务逻辑与 `static/` 页面。
本机仍使用原启动脚本、43127 端口及原 `data/`；线上使用 `python -m server`、43128 端口和独立数据目录。
**不要把本机 data、shared、浏览器资料、坚果云凭据上传到服务器。**

## 已实现

- 管理员创建私人账号，或通过单次邀请码自行注册；密码 scrypt 哈希；会话保存在 SQLite，7 天有效，可退出及管理员重置密码撤销。
- 登录 cookie 默认 Secure、HttpOnly、SameSite=Strict；写入校验 Origin、CSRF token 和版本号。
- 每个账号独立数据库、背景和记录配图；番剧封面与周表缓存共用。请求携带的账号参数不能切换身份。
- 原收藏、记录、统计、排行、周表和显示设置共用现有接口；线上可按 Bangumi ID 添加/改变收藏状态。
- 浏览器刷新、回到前台及每 5 秒检查更新；无手动同步按钮。编辑弹窗和未保存排行期间延后自动更新。
- 观看新增以增量命令自动合并，同集保留更早的观看时间。旧版本的删除或其他编辑返回 409，保留输入，要求刷新后重新提交，不静默覆盖。在线模式先联网保存，不支持离线写入。
- 上传图片原文件保存，不缩图、不重编码，包含原有元信息。JPG/PNG/WebP 单张最多 8 MiB；服务器只识别文件头，不加载像素缓冲区。以 64 KiB 分块写入临时文件、成功后原子替换；全站一次只接收一张图片，其他请求有界等待，繁忙超时提示重试。私有图片也以 64 KiB 分块读取发送。用户图片必须备份。
- 不启用本机 Kazumi、坚果云、共享目录、Windows 自启或用户自定义网络源接口。

## 本机测试（不影响现有本机服务）

需要 Python 3.12+、Pillow。安装包必须使用已有或新建的 conda 环境，勿在系统 Python/base 安装。
在项目根目录、激活环境后运行：

```powershell
python -m server.manage --data-dir .online-data create-user example_user
python -m server --development --data-dir .online-data
```

打开 `http://127.0.0.1:43128`。欢迎页提供登录、邀请码注册、游客体验三个入口。密码通过隐藏输入提示输入，不写进命令历史。
开发模式只用于本机 HTTP 测试，正式部署不使用 `--development`。

## 迁移现有记录（选择服务器后执行）

```powershell
python -m server.manage --data-dir .online-data import-local example_user --source "D:\动漫\动漫手账\data\handbook.db"
```

只读取来源库，不启动本机同步，不修改来源。只允许导入空账号，保留记录、设置、排行和收藏，复制同级记录图片与背景。
如果使用多个本机账号，请选择相应账号的实际数据库文件，并用 `--assets-dir "D:\动漫\动漫手账\data"` 指定原本机 data 根目录。只复制当前手账记录引用的配图及对应账号的背景，不复制其他账号的图片；导入结果会列出缺失配图。
不要直接导入本机账号目录或凭据文件。
导入前停止线上服务，导入后重启；界面以新账号登录核对。云服务器迁移时使用导出的线上目录副本，而不是本机浏览器目录。

## 部署步骤（供选定服务器后使用）

在项目根目录运行 `python tools/package_online.py`，生成 `releases/online/anime-handbook-online-日期.zip`。该包仅含代码、页面、部署模板和 SHA256 清单，不含本机数据、凭据、APK 或测试账号。

1. 只上传 `app.py`、`schedule.py`、`static/`、`server/`、`deploy/online/`。
2. 用独立低权限系统用户 `animehandbook` 运行，代码放 `/opt/animehandbook`，数据放 `/var/lib/animehandbook`。
3. 建立服务器虚拟环境，安装 `deploy/online/requirements.txt`。本机若安装仍遵守 conda 约定。
4. `/etc/animehandbook.env` 写入 `HANDBOOK_ORIGIN=https://实际域名`，使用提供的 systemd 配置，后端仅监听回环地址。
5. 通过 `server.manage` 创建账号；不要使用测试密码。域名、证书和 Nginx 使用同一外部地址，Origin 包含非标准端口时也要一致。
6. 配置 HTTPS 反向代理，导入示例 `nginx.conf`。示例中的证书路径需要替换，不能直接原样启动。
7. 以两个账号、同账号两台设备验证数据隔离、自动更新、版本冲突和私有图片访问后再正式使用。

服务必须运行单个后端进程，线程由内置服务管理。不要启动多个进程共同操作同一线上目录；当前账号版本锁在单进程内协调。

## 备份与恢复

正式上线后安排每日备份。停止服务后完整备份 `/var/lib/animehandbook`，包含账号库、每人手账库及用户图片；封面与周表 `cache/` 可不备份。
备份包含私人资料、密码哈希与会话信息，限制文件权限，保留异机副本。恢复时停止服务，恢复完整目录及权限，再启动并验证。
清理封面缓存只删 `cache/covers`，不能删除 `users/*/record-images` 或背景。当前未自动执行定时备份/缓存容量清理。

## 网站与后续 APK 的接口约定

后续 APK 与网站使用相同 HTTPS 域名和账号；APK 的 cookie 容器需与请求共用。
`POST /api/auth/login`（username/password） → cookie；`GET /api/auth/me` → csrf。
`GET /api/bootstrap` → 完整账号数据、revision；`GET /api/changes` → revision。
所有写入使用 `X-CSRF-Token`、`Origin`（配置的站点地址）及 `If-Match`（读取的 revision）；成功响应头返回新 `X-Handbook-Revision`。
409 表示旧版本，不能用旧表单自动重试；重新读取数据并提示用户处理当前输入。401 表示需要重新登录。
修改进度使用 `/api/animes/{id}/progress`，提供 `base_episode_keys`（打开时的原始选择）、`episode_keys`（新选择）及 `watched_at`（含时区的 ISO 时间）。新增部分可以在旧版本下自动合并，保留并发新增集数；同集保留最早真实时间，跨时区按时刻比较。取消观看等删除操作仍需当前版本，防止旧设备撤销另一端记录。
自动合并的响应带 `refresh_required=true`，客户端在结束编辑后重新拉取完整数据，以更新同时变动的设置等信息。请求重试不会重复产生同集观看记录。
APK 登录及发布、持久化离线待上传队列留到安卓版阶段。不要把坚果云快照直接覆盖线上数据库。

## 原图上传接口与低内存部署

`POST /api/record-images` 或 `POST /api/background?profile_id=主题ID` 的请求体直接发送原始文件字节，Content-Type 使用 image/jpeg、image/png、image/webp（未知 MIME 可用 application/octet-stream）。仍需登录 Cookie、Origin、X-CSRF-Token 和 If-Match。文件长度需明确且不超过 8 MiB，不再接受旧的 JSON/base64 上传；旧页面需刷新。图片接口仅校验头部格式，不承诺完整解码可用性；坏图片仍可能由客户端显示失败。

网页上传时直接发送 File，不使用 canvas、缩图或 base64；原文件与下载内容保持一致。服务器不去除 EXIF/拍摄位置等元信息，原图质量与元信息均保留。当前不生成缩略图，缩略图若以后启用必须独立排队且保留原图。

Nginx 保持 proxy_request_buffering on、client_body_buffer_size 64k，将等待的上传体落盘，临时目录需要足够磁盘空间。全局上传等待最多20秒；HTTP请求线程总数仍限制16。此处队列是请求等待，不是持久化任务，断网或服务重启需重新上传，不自动重试以避免版本冲突。

这些措施降低图片上传峰值，但512MiB服务器是否足够仍需在实际Linux主机上连同系统、Nginx、登录和周表更新一起验证；本地Windows进程测量不能替代整机内存上限测试。


## 邀请朋友注册与游客体验

管理员在服务器代码目录、所用虚拟环境中生成邀请码（无需邮箱服务）：

```shell
python -m server.manage --data-dir /var/lib/animehandbook create-invite --days 7
```

每条邀请码只能注册一个账号，默认 7 天有效。为每位朋友单独生成一条，私下发送；邀请码只在生成时显示，数据库只保存哈希。撤销尚未使用的邀请码：

```shell
python -m server.manage --data-dir /var/lib/animehandbook revoke-invite 邀请码
```

注册填写用户名、密码、确认密码、邀请码。用户名为 3～40 位字母/数字/下划线/短横线；密码至少 12 位。注册完成自动登录，账号数据为空且独立。邀请码的消费和账号创建为原子事务，同时注册不会复用同一个码。暂不收集邮箱；忘记密码使用管理员 reset-password 命令处理。

游客无需输入密码，进入独立保留身份 __demo__；会话 1 小时有效。服务器统一拒绝所有业务写入（允许退出游客会话），界面隐藏编辑入口、禁止排行拖动及进度修改。搜索、筛选和排序可以临时操作，其中显示偏好仅在当前标签页生效，不发送服务器。演示库不会读取本机 data 或私人线上账号。

演示番剧和封面来自 Bangumi 公开资料的内置快照，来源为 https://api.bgm.tv/v0/subjects/{id}，采集日期 2026-10-21；评分为采集时快照，不保证实时。观看记录、感想和排名为虚构示例。周表仍读取公共周表来源并使用原缓存机制，显示当前真实放送资料；来源不可用且没有缓存时保留正常的暂不可用提示，不伪造当季时间。

游客数据在服务启动时准备，不在每次访问时复制。部署包包含这些公开演示素材，不包含真实用户的数据。新增 role 字段会自动迁移原线上账号库，已有账号保持普通成员权限。邀请注册和游客入口与登录入口均受请求来源及频率限制保护。
