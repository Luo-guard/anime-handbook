function renderSettingsPanels() {
  $("#kazumiWritebackInput").checked=state.settings.kazumi_writeback!==false;
  $("#kazumiConflictInput").value=state.settings.kazumi_conflict||"handbook";
  renderKeyboardSettings();
  $("#showZeroStatisticsInput").checked = enabledSetting("statistics_show_zero_periods");
  renderBgmSourceControls();
  $("#hideCustomizedInput").checked = hideCustomizedFromBuiltin();
  $("#showMoveButtonWithoutCollectionsInput").checked =
    state.settings.show_custom_move_button_without_collections !== false;
  $("#showSidebarToggleInput").checked = showSidebarToggle();
  $("#showShutdownButtonInput").checked = enabledSetting("show_shutdown_button");
  $("#newRecordDefaultsToOtherInput").checked = newRecordDefaultsToOther();
  $("#topSyncActionInput").value = topSyncAction();
  $("#launchAtLoginInput").checked = launchAtLogin();
  const boundPath = state.settings.bound_kazumi_path || "";
  const localPath = state.sync.kazumi_path || "";
  const samePath = boundPath && localPath && boundPath.toLowerCase() === localPath.toLowerCase();
  $("#launchAtLoginHint").textContent = samePath
    ? "已绑定本机 Kazumi 数据库；开启后将在 Windows 登录时静默启动手账。"
    : boundPath
      ? "当前账号绑定的 Kazumi 路径与本机不同，因此不会修改这台电脑的开机自启。"
      : "首次开启时会绑定当前本机 Kazumi 路径；之后仅路径相同的账号能控制本机自启。";
  $("#showEpisodeReviewRecordInput").checked = showEpisodeReviewRecord();
  $("#showOpedRecordInput").checked = showOpedRecord();
  $("#showEpisodeRatingRecordInput").checked = showEpisodeRatingRecord();
  $("#showCharacterTabInput").checked = state.settings.show_character_tab !== false;
  $("#showBgmRatingInput").checked = showBgmRating();
  $("#showCollectionBgmRatingInput").checked = showCollectionBgmRating();
  $("#collectionRatingSourceInput").value = state.settings.collection_rating_source || "bgm";
  $("#showCollectionRatingControlInput").checked = state.settings.show_collection_rating_control !== false;
  $("#showCollectionProgressControlInput").checked = state.settings.show_collection_progress_control !== false;
  $("#showCreateCollectionControlInput").checked = state.settings.show_create_collection_control !== false;
  $("#showAgeRelatedButtonInput").checked = showAgeRelatedButton();
  $("#showBilibiliSearchButtonInput").checked = showBilibiliSearchButton();
  $("#mergeBilibiliLinksInput").checked = state.settings.merge_bilibili_links === true;
  $("#showSavedVideoListInput").checked = enabledSetting("show_saved_video_list");
  $("#showEpisodeTitlesOnHoverInput").checked = showEpisodeTitlesOnHover();
  $("#showRankingHoverTitlesInput").checked = showRankingHoverTitles();
  $("#rankingHoverDelayInput").value = rankingHoverDelay();
  $("#rankingHoverDelayValue").textContent = `${rankingHoverDelay()} 秒`;
  const activeTheme = state.settings.theme_color || "forest";
  $$(".theme-option").forEach((button) => {
    const active = button.dataset.themeValue === activeTheme;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
  $("#customThemeColorInput").value = state.settings.custom_theme_color || "#2e6d4e";
  $("#customThemeColorPreview").value = state.settings.custom_theme_color || "#2e6d4e";
  $("#customBackgroundOpacityInput").value = state.settings.custom_background_overlay_opacity ?? 82;
  $("#customBackgroundOpacityValue").textContent = `${$("#customBackgroundOpacityInput").value}%`;
  renderThemeProfiles();
  renderScheduleSettings();
  renderSharingSettings();
  renderWebdavSettings();
  $("#defaultViewInput").value = ["timeline", "statistics", "ranking", "schedule"].includes(
    state.settings.default_view,
  )
    ? state.settings.default_view
    : "collection";
  $("#showAllCollectionTabInput").checked = state.settings.show_all_collection_tab !== false;
  const collectionHomeOptions = [
    ...builtinCollectionOrder().map((id) => {
      const category = CATEGORIES.find((item) => item.id === id);
      return `<option value="builtin:${id}">${escapeHtml(category.name)}</option>`;
    }),
    ...state.custom_collections.map((collection) =>
      `<option value="custom:${collection.id}">${escapeHtml(collection.name)}</option>`,
    ),
    ...(state.settings.show_all_collection_tab !== false ? ["<option value=\"all\">全部收藏夹</option>"] : []),
  ];
  $("#collectionHomeInput").innerHTML = collectionHomeOptions.join("");
  const savedHome = String(state.settings.collection_home || "builtin:1");
  $("#collectionHomeInput").value = collectionHomeOptions.some((item) => item.includes(`value=\"${savedHome}\"`))
    ? savedHome
    : "builtin:1";
  const builtinOrder = builtinCollectionOrder();
  $("#builtinCollectionOrderList").innerHTML = builtinOrder.map((id, index) => {
    const category = CATEGORIES.find((item) => item.id === id);
    return `<div class="sidebar-setting-item">
      <span>${escapeHtml(category.name)}</span>
      <span class="sidebar-order-actions">
        <button type="button" class="text-button builtin-order-button" data-direction="up" data-category="${id}" ${index === 0 ? "disabled" : ""}>上移</button>
        <button type="button" class="text-button builtin-order-button" data-direction="down" data-category="${id}" ${index === builtinOrder.length - 1 ? "disabled" : ""}>下移</button>
      </span>
    </div>`;
  }).join("");
  $("#sidebarNameInputs").innerHTML = Object.keys(SIDEBAR_ITEMS).filter(id => id !== "settings").map(id => `<label class="page-name-row"><span>${SIDEBAR_ITEMS[id]}</span><input type="text" data-page-name="${id}" maxlength="20" value="${escapeHtml(state.settings.sidebar_labels?.[id] || "")}" placeholder="${SIDEBAR_ITEMS[id]}" aria-label="${SIDEBAR_ITEMS[id]}名称" /></label>`).join("");
  const visibility = sidebarVisibility();
  $("#sidebarSettingsList").innerHTML = sidebarOrder().map((id, index) => `
    <div class="sidebar-setting-item">
      <label class="mini-check">
        <input type="checkbox" class="sidebar-visibility-check" data-sidebar-id="${id}" ${visibility[id] !== false || id === "settings" ? "checked" : ""} ${id === "settings" ? "disabled" : ""} />
        <span>${escapeHtml(pageLabel(id))}</span>
      </label>
      <span class="sidebar-order-actions">
        <button type="button" class="text-button sidebar-order-button" data-direction="up" data-sidebar-id="${id}" ${index === 0 ? "disabled" : ""}>上移</button>
        <button type="button" class="text-button sidebar-order-button" data-direction="down" data-sidebar-id="${id}" ${index === sidebarOrder().length - 1 ? "disabled" : ""}>下移</button>
      </span>
    </div>
  `).join("");
  $$(".sidebar-visibility-check").forEach(input => input.addEventListener("change", () => syncSettingsNavigation(true)));
  const builtinCategoryVisibility = builtinVisibility();
  $("#builtinVisibilityList").innerHTML = CATEGORIES.map((category) => `
    <label class="mini-check">
      <input
        type="checkbox"
        class="builtin-visibility-check"
        data-category="${category.id}"
        ${builtinCategoryVisibility[String(category.id)] !== false ? "checked" : ""}
      />
      <span>${category.name}</span>
    </label>
  `).join("");
  $("#settingsCustomCollections").innerHTML = state.custom_collections.length
    ? state.custom_collections.map((collection) => `
        <div class="custom-setting-item">
          <span>${escapeHtml(collection.name)} <small>${collection.count || 0} 部</small></span>
          <button type="button" class="text-button danger delete-custom-collection" data-id="${collection.id}">删除</button>
        </div>
      `).join("")
    : `<p class="muted-line">还没有自定义收藏夹。</p>`;
  $$(".delete-custom-collection").forEach((button) => {
    button.addEventListener("click", () => deleteCustomCollection(Number(button.dataset.id)));
  });
  $$(".sidebar-order-button").forEach((button) => {
    button.addEventListener("click", () => {
      const order = sidebarOrder();
      const index = order.indexOf(button.dataset.sidebarId);
      const target = button.dataset.direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= order.length) return;
      [order[index], order[target]] = [order[target], order[index]];
      state.settings.sidebar_order = order;
      // Move existing rows so names and other unsaved controls keep their values.
      const list = $("#sidebarSettingsList");
      order.forEach(id => list.append($(`.sidebar-visibility-check[data-sidebar-id="${id}"]`).closest(".sidebar-setting-item")));
      $$(".sidebar-order-button").forEach(control => {
        const position = order.indexOf(control.dataset.sidebarId);
        control.disabled = control.dataset.direction === "up" ? position === 0 : position === order.length - 1;
      });
      syncSettingsNavigation(true);
    });
  });
  $$(".builtin-order-button").forEach((button) => {
    button.addEventListener("click", () => {
      const order = builtinCollectionOrder();
      const index = order.indexOf(Number(button.dataset.category));
      const target = button.dataset.direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= order.length) return;
      [order[index], order[target]] = [order[target], order[index]];
      state.settings.builtin_collection_order = order;
      renderSettingsPanels();
    });
  });
}

function renderSharingSettings() {
  const sharing = state.sharing || {};
  const profiles = Array.isArray(state.profiles) ? state.profiles : [];
  const active = state.active_profile?.id || profiles.find((item) => item.active)?.id || "";
  const folder = $("#sharingFolderInput");
  if (folder) folder.value = sharing.shared_folder || "";
  const autoPublish = $("#autoPublishSharingInput");
  if (autoPublish) autoPublish.checked = sharing.auto_publish !== false;
  const status = $("#sharingStatus");
  if (status) status.textContent = sharing.configured
    ? `共享目录：${sharing.shared_folder}。其他账号默认按需加载；常驻账号每 30 分钟刷新一次。`
    : "未设置共享目录。使用“设置共享同步.cmd”安装 Syncthing 后，在这里选择它的共享文件夹。";
  const select = $("#handbookProfileInput");
  if (select) {
    select.innerHTML = profiles.map((profile) => `<option value="${escapeHtml(profile.id)}" ${profile.id === active ? "selected" : ""}>${escapeHtml(profile.name)}${profile.active ? "（当前）" : ""}</option>`).join("");
  }
  const list = $("#sharedProfileList");
  if (!list) return;
  const available = Array.isArray(state.sharing_available_profiles) ? state.sharing_available_profiles : [];
  list.innerHTML = available.length
    ? available.map((profile) => {
      const legacy = Number(profile.format || 1) < 2;
      const name = escapeHtml(profile.name || profile.profile_id);
      const publishedAt = escapeHtml(profile.published_at || "未知时间");
      if (legacy) {
        return `<div class="custom-collection-setting"><span>${name}<small>发布于 ${publishedAt} · 旧快照，需发布者重启更新后的手账并重新发布</small></span></div>`;
      }
      return `<div class="custom-collection-setting"><span>${name}<small>发布于 ${publishedAt}</small></span><button type="button" class="text-button load-shared-profile" data-profile-id="${escapeHtml(profile.profile_id)}">立即加载</button><label><input type="checkbox" class="resident-shared-profile" data-profile-id="${escapeHtml(profile.profile_id)}" ${(sharing.resident_profiles || []).includes(profile.profile_id) ? "checked" : ""} /> 常驻</label></div>`;
    }).join("")
    : "<p class=\"empty-settings\">共享目录中暂未发现其他账号的已发布快照。</p>";
}

function renderWebdavSettings() {
  const webdav = state.webdav || {};
  const url = $("#webdavUrlInput");
  const username = $("#webdavUsernameInput");
  const account = $("#webdavAccountIdInput");
  const auto = $("#autoWebdavSyncInput");
  if (url) url.value = webdav.url || "https://dav.jianguoyun.com/dav/";
  if (username) username.value = webdav.username || "";
  if (account) account.value = webdav.account_id || state.active_profile?.sharing_id || "";
  if (auto) auto.checked = webdav.auto_sync !== false;
  const status = $("#webdavStatus");
  if (!status) return;
  if (!webdav.configured) {
    status.textContent = "尚未连接坚果云。填写 WebDAV 地址、账号和应用密码后保存；密码只保存在当前设备。";
  } else if (webdav.last_error) {
    status.textContent = `上次同步未完成：${webdav.last_error}`;
  } else if (webdav.last_synced_at) {
    status.textContent = `已连接坚果云；上次同步：${webdav.last_synced_at}。封面、角色资料等缓存不会上传。`;
  } else {
    status.textContent = "已保存坚果云配置，尚未同步。";
  }
}

function bgmSources() {
  const saved = Array.isArray(state.settings.bgm_sources) ? state.settings.bgm_sources : [];
  return saved.length ? saved : [{
    id: "official", name: "Bangumi 官方", site_base: "https://bgm.tv", api_base: "https://api.bgm.tv",
  }];
}

function currentBgmSource() {
  const sources = bgmSources();
  return sources.find((item) => item.id === state.settings.active_bgm_source) || sources[0];
}

function renderBgmSourceControls() {
  const sources = bgmSources();
  const current = currentBgmSource();
  const select = $("#bgmSourceInput");
  select.innerHTML = sources.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("");
  select.value = current.id;
  $("#bgmSourceNameInput").value = current.name || "";
  $("#bgmSourceSiteInput").value = current.site_base || "";
  $("#bgmSourceApiInput").value = current.api_base || "";
  $("#deleteBgmSourceButton").disabled = sources.length <= 1;
}

function readBgmSourceForm(sourceId = "") {
  const name = $("#bgmSourceNameInput").value.trim();
  const site_base = $("#bgmSourceSiteInput").value.trim().replace(/\/+$/, "");
  const api_base = $("#bgmSourceApiInput").value.trim().replace(/\/+$/, "");
  if (!name || !site_base || !api_base) throw new Error("请填写站点名称、站点地址和 API 地址");
  if (!/^https?:\/\/[^/]+/i.test(site_base) || !/^https?:\/\/[^/]+/i.test(api_base)) {
    throw new Error("站点地址和 API 地址必须是完整的 http(s) 地址");
  }
  return { id: sourceId, name, site_base, api_base };
}

async function saveBgmSources(sources, activeId) {
  const payload = await api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ bgm_sources: sources, active_bgm_source: activeId }),
  });
  state.settings = payload.settings;
  renderBgmSourceControls();
  return payload;
}

function themeProfiles() {
  return Array.isArray(state.settings.theme_profiles) && state.settings.theme_profiles.length
    ? state.settings.theme_profiles
    : [{ id: "default", name: "默认主题", theme_color: "forest", custom_theme_color: "#2e6d4e", custom_background_enabled: false, custom_background_version: 0, custom_background_overlay_opacity: 82 }];
}

function currentThemeSnapshot(id, name) {
  return { id, name, theme_color: state.settings.theme_color || "forest", custom_theme_color: $("#customThemeColorInput").value.trim() || "#2E6D4E", custom_background_enabled: state.settings.custom_background_enabled === true, custom_background_version: state.settings.custom_background_version || 0, custom_background_overlay_opacity: Number($("#customBackgroundOpacityInput").value) };
}

function renderThemeProfiles() {
  const select = $("#themeProfileInput");
  select.innerHTML = themeProfiles().map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join("");
  select.value = state.settings.active_theme_profile || themeProfiles()[0].id;
  $("#deleteThemeProfileButton").disabled = themeProfiles().length <= 1;
}

async function persistThemeProfiles(profiles, activeId) {
  const payload = await api("/api/settings", { method: "PATCH", body: JSON.stringify({ theme_profiles: profiles, active_theme_profile: activeId }) });
  state.settings = payload.settings;
  renderThemeProfiles();
}

async function saveActiveThemeProfileSilently() {
  const id = state.settings.active_theme_profile || themeProfiles()[0].id;
  const old = themeProfiles().find((item) => item.id === id);
  const profiles = themeProfiles().map((item) => item.id === id ? currentThemeSnapshot(id, old?.name || "主题") : item);
  await persistThemeProfiles(profiles, id);
}

async function activateThemeProfile(id) {
  const profile = themeProfiles().find((item) => item.id === id);
  if (!profile) return;
  Object.assign(state.settings, { active_theme_profile: id, theme_color: profile.theme_color || "forest", custom_theme_color: profile.custom_theme_color || "#2e6d4e", custom_background_enabled: profile.custom_background_enabled === true, custom_background_version: profile.custom_background_version || 0, custom_background_overlay_opacity: Number(profile.custom_background_overlay_opacity ?? 82) });
  const payload = await api("/api/settings", { method: "PATCH", body: JSON.stringify({ active_theme_profile: id, theme_color: state.settings.theme_color, custom_theme_color: state.settings.custom_theme_color, custom_background_enabled: state.settings.custom_background_enabled, custom_background_version: state.settings.custom_background_version, custom_background_overlay_opacity: state.settings.custom_background_overlay_opacity }) });
  state.settings = payload.settings;
  applyTheme();
  renderSettingsPanels();
}

let settingsGroupsInitialized = false;
const SETTINGS_PAGE_IDS = {collection: "collection", schedule: "schedule", record: "timeline", statistics: "statistics", ranking: "ranking"};
function syncSettingsNavigation(preview = false) {
  if (!settingsGroupsInitialized) return;
  const visibility = sidebarVisibility();
  if (preview) $$(".sidebar-visibility-check").forEach(input => { visibility[input.dataset.sidebarId] = input.checked; });
  const tabs = new Map($$("[data-settings-tab]").map(button => [button.dataset.settingsTab, button]));
  const pageTabs = sidebarOrder().map(id => Object.keys(SETTINGS_PAGE_IDS).find(tab => SETTINGS_PAGE_IDS[tab] === id)).filter(Boolean);
  const nav = $("#settingsSideNav"), list = $(".settings-list");
  ["theme", ...pageTabs, "keyboard", "data", "sharing"].forEach(tab => {
    const button = tabs.get(tab);
    if (!button) return;
    button.classList.toggle("hidden", Boolean(SETTINGS_PAGE_IDS[tab] && visibility[SETTINGS_PAGE_IDS[tab]] === false));
    nav.append(button);
    const group = $(`.settings-group[data-settings-group="${tab}"]`);
    if (group) list.append(group);
  });
  if ([...tabs.values()].some(button => button.classList.contains("active") && button.classList.contains("hidden"))) switchSettingsTab("theme");
}
function switchSettingsTab(tab) {
  $$(".settings-group").forEach((group) => group.classList.toggle("hidden", group.dataset.settingsGroup !== tab));
  $$("[data-settings-tab]").forEach((button) => button.classList.toggle("active", button.dataset.settingsTab === tab));
  $("#settingsModal").scrollTop = 0;
}

function setupSettingsTabs() {
  if (!settingsGroupsInitialized) {
    const list = $(".settings-list");
    const groups = new Map($$("[data-settings-tab]").map((button) => {
      const panel = document.createElement("section");
      panel.className = "settings-group";
      panel.dataset.settingsGroup = button.dataset.settingsTab;
      return [button.dataset.settingsTab, panel];
    }));
    let current = null;
    [...list.children].forEach((child) => {
      if (child.dataset.settingsSection) current = groups.get(child.dataset.settingsSection);
      if (current) current.append(child);
    });
    list.replaceChildren(...groups.values());
    $$("[data-settings-tab]").forEach((button) => button.addEventListener("click", () => switchSettingsTab(button.dataset.settingsTab)));
    settingsGroupsInitialized = true;
  }
  syncSettingsNavigation();
  switchSettingsTab("theme");
}

