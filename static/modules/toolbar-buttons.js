// 收藏夹工具栏的两个按钮（搜索添加番剧 / 历史记录）：
// 显不显示、只显示图标还是图标＋文字，全部由设置决定。
// 单独成文件，方便测试直接加载，也避免这些纯展示逻辑埋在收藏编辑代码里。
const COLLECTION_TOOLBAR_BUTTONS = [
  ["#collectionSearchButton", "show_collection_add_button", "collection_add_button_icon_only", false, "搜索添加番剧"],
  ["#jumpHistoryButton", "show_jump_history_button", "jump_history_button_icon_only", true, "历史记录"],
];

function applyCollectionToolbarButtons() {
  const supported = typeof collectionEditingSupported === "function" ? collectionEditingSupported() : true;
  COLLECTION_TOOLBAR_BUTTONS.forEach(([selector, visibleKey, iconKey, iconFallback, label]) => {
    const button = $(selector);
    if (!button) return;
    button.classList.toggle("hidden", !supported || !enabledSetting(visibleKey));
    button.classList.toggle("icon-only", booleanSetting(iconKey, iconFallback));
    // 只剩图标时靠 title / aria-label 说明用途。
    button.title = label;
    button.setAttribute("aria-label", label);
  });
}
