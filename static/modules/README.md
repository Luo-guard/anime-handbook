# 前端模块结构

index.html 明确声明 defer 脚本顺序，最后由 app.js 调用 bootstrap。app.js 已删除原先的大段实现，不提供兼容转发。

- core：共享状态、DOM、格式化与提示工具。
- network：统一 API 请求入口。
- collection / collection-cards：收藏筛选、排序、卡片及拖动。
- presentation：显示偏好、章节显示辅助与页面名称/导航。
- composer：记录编辑器与主题选择菜单。
- details：番剧详情、人物请求、剧集操作。
- records：记录解析、时间线及页面切换。
- ranking / statistics：排名与统计页面。
- lifecycle：启动、状态轮询与收藏管理。
- settings：设置渲染、主题方案和分类导航。
- events：页面事件绑定及设置提交。

本次保留原有浏览器全局函数和共享 state 的调用方式，避免改变其他页面脚本及线上适配器的运行契约；没有引入新的打包器或浏览器版本要求。这里是按职责拆文件，并非所有模块已改造成完全隔离的 ES modules。后续可按模块逐步显式注入依赖，不应重新复制实现或增加旧入口转发。

tests/frontend_source.cjs 按真实 HTML 的脚本顺序读取源代码，现有回归测试不再假设实现位于 app.js 单一文件。

- `keyboard.js`：数字 1～6 页面快捷导航，复用侧边栏点击入口；输入焦点、编辑器、输入法组合输入及弹窗期间禁用。

快捷键配置由 `keyboard.js` 集中维护动作、默认键位与行为；`handbook/shortcuts.py` 校验持久化配置，旧账号沿用默认值。设置修改只在保存后应用。
