# 后台模块结构

- `common.py`：路径配置、数据规范化、章节工具、外观初始化及系统辅助函数。
- `database.py`：HandbookDB，SQLite 数据访问与业务数据操作。
- `metadata.py`：SyncService，Kazumi/Bangumi 资料请求及同步。
- `related.py`：相关番剧查询及缓存。
- `profiles.py`：本机账号配置。
- `sharing.py`：本机共享快照及设备授权。
- `webdav.py`：WebDAV 同步与合并。
- `http.py`：共享业务 HTTP 处理器；线上由 server/http.py 继承。
- `desktop.py`：仅桌面启动时初始化本机服务，处理账号切换及进程启动。

app.py 只负责桌面命令启动，不再提供类或函数转发。内部调用应直接导入拥有该实现的模块。HTTP 路由为现有客户端契约，本次没有删除或改名。

线上直接依赖业务模块，导入 server.runtime 或 server.http 不初始化 desktop，也不再需要 ANIME_HANDBOOK_RUNTIME 环境变量。

依赖方向：基础工具 → 数据与业务服务 → HTTP 适配器。桌面状态仅在本机请求或共享任务执行时访问；线上请求使用账号级 services。不要在通用模块顶部导入 desktop。

- `video_links.py`：按账号数据库与番剧隔离的 B 站视频链接，校验 BV 地址、分 P、默认链接及重复保存；共享 HTTP 路由复用，扩展源码见 `browser-extension/`。
