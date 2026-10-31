# 本机收藏编辑与 Kazumi 写回

收藏夹工具栏“搜索添加番剧”搜索 Bangumi 动画；周表条目已关联 Bangumi ID 时可直接加入收藏；番剧详情提供五种收藏状态。

设置 → 账号与同步提供自动写回开关、冲突优先级和待同步任务。仅收藏新增和状态参与写回，不写观看进度或手账独有记录。后台运行期间每 5 秒检查任务；Kazumi 进程运行或 Hive 锁冲突时保留任务。默认手账优先，可改为 Kazumi 优先。新任务立即保存在账号数据库，连续修改合并为最后状态；读入 Kazumi 收藏不会覆盖待写回任务。

写入工具在 Hive 正常锁保护下操作，写前将收藏文件备份为 collectibles.hive.handbook-时间戳.bak，失败不确认任务；写后重新打开验证。备份包含个人收藏，不应上传仓库。窗口关闭不会停止后台；关闭后台后下次启动继续任务。

构建 Windows 写回工具：在 tools/kazumi_reader 目录执行 `dart pub get`，再执行 `dart compile exe bin/kazumi_writer.dart -o ../kazumi_writer.exe`。构建产物不提交仓库。使用现有 Hive adapter 格式，遇到未知类型或不支持的字段布局停止写回并保留任务，需检查 Kazumi 升级兼容性。

测试仅操作临时数据库和收藏副本，不修改真实用户收藏。网页版收藏可独立维护；本机文件写回工作器仅在 Windows 本机版运行。
