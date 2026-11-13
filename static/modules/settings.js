function applyKazumiReadOnlyControls() {
  const readOnly = $("#kazumiReadOnlyInput").checked;
  $("#kazumiWritebackInput").disabled = readOnly;
  $("#kazumiConflictInput").disabled = readOnly;
  $("#kazumiWritebackInput").closest(".setting-row")?.classList.toggle("is-disabled", readOnly);
  $("#kazumiConflictInput").closest(".setting-row")?.classList.toggle("is-disabled", readOnly);
}
// 详情页 / 周表链接的两套读写函数都在下面「兼容旧调用名」那一段里定义，
// 走的是 linkRowsFromDom / readLinkList / commitLinkList —— 这里以前还有一份
// 同名实现（不带 id、过滤规则也不同），靠后面的定义覆盖它，属于埋在头上的雷。
const LINK_EDITORS = {
  detail: { list: "#detailLinkList", setting: "detail_links", source: () => detailLinks() },
  schedule: { list: "#scheduleDetailLinkList", setting: "schedule_detail_links", source: () => scheduleDetailLinks() },
};

function linkRowsFromDom(kind) {
  const config = LINK_EDITORS[kind];
  return [...document.querySelectorAll(`${config.list} .detail-link-row`)].map((row) => ({
    id: row.dataset.detailLinkId || "",
    kind: row.dataset.detailLinkKind || "custom",
    name: String(row.querySelector("[data-detail-link-name]")?.value || "").trim(),
    url: String(row.querySelector("[data-detail-link-url]")?.value || "").trim(),
    enabled: Boolean(row.querySelector("[data-detail-link-enabled]").checked),
  }));
}
function readLinkList(kind) {
  return linkRowsFromDom(kind).filter((link) => ["saved_video", "rules_menu"].includes(link.kind) || (link.name && link.url));
}
function commitLinkList(kind, links) {
  state.settings[LINK_EDITORS[kind].setting] = links;
  renderLinkList(kind);
}
// 编辑中的列表要保留还没填完的空行，所以不走 source() 的过滤。
function editableLinks(kind) {
  const config = LINK_EDITORS[kind];
  const saved = state.settings[config.setting];
  if (!Array.isArray(saved)) return config.source();
  const rows = saved.map((item) => ({
    id: String(item?.id || "") || detailLinkId(),
    kind: ["bgm", "bilibili", "saved_video", "rules_menu"].includes(item?.kind) ? item.kind : "custom",
    name: String(item?.name ?? ""),
    url: String(item?.url ?? ""),
    enabled: item?.enabled !== false,
  }));
  return kind === "detail" ? withBuiltinDetailLinks(rows) : rows;
}
function renderLinkList(kind) {
  const config = LINK_EDITORS[kind];
  const list = $(config.list);
  if (!list) return;
  list.replaceChildren();
  const links = editableLinks(kind);
  links.forEach((link, index) => {
    const row = document.createElement("div");
    row.className = "detail-link-row";
    row.dataset.detailLinkKind = link.kind || "custom";
    row.dataset.detailLinkId = link.id;
    const name = document.createElement("input");
    name.type = "text";
    name.value = String(link.name || "");
    name.placeholder = "名称，例如 次元城";
    name.dataset.detailLinkName = "";
    let url;
    if (link.kind === "saved_video") {
      // 地址来自收藏里的默认视频，这里只读，避免误以为能手填。
      url = document.createElement("span");
      url.className = "detail-link-auto";
      url.textContent = "自动使用默认已存视频";
    } else if (link.kind === "rules_menu") {
      // 总链接点开才是站点列表，本身没有网址。
      url = document.createElement("span");
      url.className = "detail-link-auto";
      url.textContent = "点击详情页按钮展开站点列表";
    } else {
      url = document.createElement("input");
      url.type = "text";
      url.value = String(link.url || "");
      url.placeholder = "https://example.com/search?q={title}";
      url.dataset.detailLinkUrl = "";
    }
    const order = document.createElement("div");
    order.className = "detail-link-order";
    [["↑", -1, "上移"], ["↓", 1, "下移"]].forEach(([glyph, delta, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "detail-link-order-button";
      button.textContent = glyph;
      button.setAttribute("aria-label", `${label}${String(link.name || "链接").trim()}`);
      button.disabled = index + delta < 0 || index + delta >= links.length;
      button.addEventListener("click", () => {
        const next = linkRowsFromDom(kind);
        const target = index + delta;
        [next[index], next[target]] = [next[target], next[index]];
        commitLinkList(kind, next);
      });
      order.append(button);
    });
    const toggle = document.createElement("label");
    toggle.className = "switch-row compact";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = link.enabled !== false;
    check.dataset.detailLinkEnabled = "";
    check.setAttribute("aria-label", `显示${String(link.name || "这个").trim() || "链接"}`);
    const visual = document.createElement("span");
    visual.className = "switch";
    toggle.append(check, visual);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary-button compact-button";
    if (link.kind === "saved_video" || link.kind === "rules_menu") {
      const label = link.kind === "saved_video" ? "已存视频" : "更多站点";
      remove.textContent = "固定";
      remove.disabled = true;
      remove.title = `${label}入口固定存在，可用左侧开关隐藏`;
      remove.setAttribute("aria-label", `${label}入口固定，不能删除`);
    } else {
      remove.textContent = "删除";
      remove.setAttribute("aria-label", `删除链接 ${String(link.name || "").trim()}`);
      remove.addEventListener("click", () => commitLinkList(kind, linkRowsFromDom(kind).filter((_, item) => item !== index)));
    }
    row.append(name, url, order, toggle, remove);
    list.append(row);
  });
}

// 新增的自定义链接在另一边补一条（默认关闭）；已同步过的 id 不再重复补，删除和开关也不会回灌。
function syncLinkAdditions(detailList, scheduleList, syncedIds) {
  const detail = [...detailList];
  const schedule = [...scheduleList];
  const synced = new Set(Array.isArray(syncedIds) ? syncedIds : []);
  const propagate = (source, target) => {
    const targetIds = new Set(target.map((link) => link.id).filter(Boolean));
    source.forEach((link) => {
      if (link.kind !== "custom" || !link.id || synced.has(link.id) || !link.name || !link.url) return;
      synced.add(link.id);
      if (!targetIds.has(link.id)) target.push({ ...link, enabled: false });
    });
  };
  propagate(detail, schedule);
  propagate(schedule, detail);
  return { detail, schedule, synced: [...synced] };
}

function addLinkRow(kind) {
  commitLinkList(kind, [...linkRowsFromDom(kind), { id: detailLinkId(), kind: "custom", name: "", url: "", enabled: true }]);
  $(`${LINK_EDITORS[kind].list} .detail-link-row:last-child [data-detail-link-name]`)?.focus();
}
function resetLinkList(kind) {
  commitLinkList(kind, DETAIL_LINK_PRESETS.map((preset) => ({ ...preset, id: detailLinkId() })));
}

$("#addDetailLink")?.addEventListener("click", () => addLinkRow("detail"));
$("#resetDetailLinks")?.addEventListener("click", () => resetLinkList("detail"));
$("#addScheduleDetailLink")?.addEventListener("click", () => addLinkRow("schedule"));
$("#resetScheduleDetailLinks")?.addEventListener("click", () => resetLinkList("schedule"));

// 兼容旧调用名。
function detailLinksFromDom() { return linkRowsFromDom("detail"); }
function readDetailLinks() { return readLinkList("detail"); }
function readScheduleDetailLinks() { return readLinkList("schedule"); }
function commitDetailLinks(links) { commitLinkList("detail", links); }
function renderDetailLinkSettings() { renderLinkList("detail"); updateRuleCatalogStatus(); }
function renderScheduleDetailLinkSettings() { renderLinkList("schedule"); }

// 自定义收藏夹管理：改名、删除、以及映射到哪个 Kazumi 收藏夹。
function renderCustomCollectionSettings() {
  const host = $("#settingsCustomCollections");
  if (!host) return;
  if (!state.custom_collections.length) {
    host.innerHTML = `<p class="muted-line">还没有自定义收藏夹。</p>`;
    return;
  }
  host.innerHTML = state.custom_collections.map((collection) => {
    const mapped = Number(collection.kazumi_category) || 0;
    return `
      <div class="custom-setting-item" data-collection-id="${collection.id}">
        <span class="custom-setting-name">${escapeHtml(collection.name)} <small>${collection.count || 0} 部</small></span>
        <label class="custom-setting-map">
          <span>Kazumi 收藏夹</span>
          <select class="custom-map-select" data-id="${collection.id}" aria-label="${escapeHtml(collection.name)}映射到哪个 Kazumi 收藏夹">
            <option value=""${mapped ? "" : " selected"}>不映射</option>
            ${CATEGORIES.map((category) => `<option value="${category.id}"${mapped === category.id ? " selected" : ""}>${category.name}</option>`).join("")}
          </select>
        </label>
        <span class="custom-setting-actions">
          <button type="button" class="text-button rename-custom-collection" data-id="${collection.id}">重命名</button>
          <button type="button" class="text-button danger delete-custom-collection" data-id="${collection.id}">删除</button>
        </span>
      </div>
    `;
  }).join("");
  $$(".delete-custom-collection").forEach((button) => {
    button.addEventListener("click", () => deleteCustomCollection(Number(button.dataset.id)));
  });
  $$(".rename-custom-collection").forEach((button) => {
    button.addEventListener("click", () => renameCustomCollection(Number(button.dataset.id)));
  });
  $$(".custom-map-select").forEach((select) => {
    select.addEventListener("change", () => {
      updateCustomCollectionSettings(Number(select.dataset.id), {
        kazumi_category: select.value ? Number(select.value) : null,
      });
    });
  });
}

function renderSettingsPanels() {
  $("#kazumiReadOnlyInput").checked=state.settings.kazumi_read_only===true;
  $("#kazumiWritebackInput").checked=state.settings.kazumi_writeback!==false;
  $("#webdavKazumiSyncInput").checked=state.settings.webdav_kazumi_sync!==false;
  $("#kazumiConflictInput").value=state.settings.kazumi_conflict||"handbook";
  applyKazumiReadOnlyControls();
  renderKeyboardSettings();
  if (typeof renderEpisodeGestureSettings === "function") renderEpisodeGestureSettings();
  renderDetailLinkSettings();
  renderScheduleDetailLinkSettings();
  $("#showZeroStatisticsInput").checked = enabledSetting("statistics_show_zero_periods");
  renderBgmSourceControls();
  $("#hideCustomizedInput").checked = hideCustomizedFromBuiltin();
  $("#showMoveButtonWithoutCollectionsInput").checked =
    state.settings.show_custom_move_button_without_collections !== false;
  $("#showSidebarToggleInput").checked = showSidebarToggle();
  $("#showShutdownButtonInput").checked = enabledSetting("show_shutdown_button");
  $("#newRecordDefaultsToOtherInput").checked = newRecordDefaultsToOther();
  renderTimelineDefaultThemes();
  $("#topSyncActionInput").value = topSyncAction();
  $("#launchAtLoginInput").checked = launchAtLogin();
  const boundPath = state.settings.bound_kazumi_path || "";
  const localPath = state.sync.kazumi_path || "";
  const samePath = boundPath && localPath && boundPath.toLowerCase() === localPath.toLowerCase();
  const hint = $("#launchAtLoginHint");
  hint.textContent = samePath
    ? "已绑定本机 Kazumi 数据库"
    : boundPath
      ? "已绑定其他路径，本机不会自启"
      : "尚未绑定本机路径";
  hint.classList.toggle("is-ok", Boolean(samePath));
  hint.classList.toggle("is-warn", Boolean(boundPath && !samePath));
  $("#showEpisodeReviewRecordInput").checked = showEpisodeReviewRecord();
  $("#showOpedRecordInput").checked = showOpedRecord();
  $("#showEpisodeRatingRecordInput").checked = showEpisodeRatingRecord();
  $("#showCharacterTabInput").checked = state.settings.show_character_tab !== false;
  $("#showBgmRatingInput").checked = showBgmRating();
  $("#bgmRatingLinkInput").checked = state.settings.bgm_rating_link !== false;
  $("#showCollectionBgmRatingInput").checked = showCollectionBgmRating();
  $("#collectionRatingSourceInput").value = state.settings.collection_rating_source || "bgm";
  $("#collectionAiringSourceInput").value = state.settings.collection_airing_source || "bgm";
  const detailAirtimeSource = $("#detailAirtimeSourceInput");
  detailAirtimeSource.value = state.settings.detail_airtime_source || "yuc";
  detailAirtimeSource.closest(".setting-row").classList.toggle("hidden", Boolean(window.handbookOnline));
  const hideMissingAsSchedule = $("#hideMissingAsScheduleInput");
  hideMissingAsSchedule.checked = state.settings.hide_missing_as_schedule !== false;
  hideMissingAsSchedule.closest(".setting-row").classList.toggle("hidden", Boolean(window.handbookOnline));
  $("#showCollectionRatingControlInput").checked = state.settings.show_collection_rating_control !== false;
  $("#showCollectionProgressControlInput").checked = state.settings.show_collection_progress_control !== false;
  $("#showCreateCollectionControlInput").checked = state.settings.show_create_collection_control !== false;
  $("#showCollectionAddButtonInput").checked = enabledSetting("show_collection_add_button");
  $("#collectionAddIconOnlyInput").checked = state.settings.collection_add_button_icon_only === true;
  $("#showJumpHistoryButtonInput").checked = enabledSetting("show_jump_history_button");
  // 跳转记录默认就是图标样式，和截图里的一致。
  $("#jumpHistoryIconOnlyInput").checked = booleanSetting("jump_history_button_icon_only", true);
  $("#showAgeRelatedButtonInput").checked = showAgeRelatedButton();
  $("#showSearchBgmLinkInput").checked = enabledSetting("show_search_bgm_link");
  $("#videoDefaultPinnedInput").checked = state.settings.video_default_pinned !== false;
  $("#mergeBilibiliLinksInput").checked = state.settings.merge_bilibili_links === true;
  $("#showSavedVideoListInput").checked = enabledSetting("show_saved_video_list");
  $("#showEpisodeTitlesOnHoverInput").checked = showEpisodeTitlesOnHover();
  $("#showRankingHoverTitlesInput").checked = showRankingHoverTitles();
  $("#rankingHoverDelayInput").value = rankingHoverDelay();
  $("#rankingHoverDelayValue").textContent = `${rankingHoverDelay()} 秒`;
  renderThemeControls();
  renderScheduleSettings();
  renderSharingSettings();
  renderWebdavSettings();
  $("#defaultViewInput").value = ["library", "timeline", "statistics", "ranking", "schedule"].includes(
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
  // 媒体库有自己的三态开关（始终显示 / 有内容时 / 隐藏），这里的勾选框跟它是同一个设置：
  // 勾上=显示，取消=隐藏；auto 也算勾上。以前这颗勾选框是 disabled，用户想在这儿隐藏根本点不动。
  const libraryShown = librarySidebarMode() !== "hide";
  $("#sidebarSettingsList").innerHTML = sidebarOrder().map((id, index) => `
    <div class="sidebar-setting-item">
      <label class="mini-check">
        <input type="checkbox" class="sidebar-visibility-check" data-sidebar-id="${id}" ${(id === "library" ? libraryShown : visibility[id] !== false || id === "settings") ? "checked" : ""} ${id === "settings" ? "disabled" : ""} ${id === "settings" ? 'title="设置页永远显示"' : id === "library" ? 'title="与「设置 → 媒体库」的显示开关同步：勾上=显示，取消=隐藏"' : ""} />
        <span>${escapeHtml(pageLabel(id))}</span>
      </label>
      <span class="sidebar-order-actions">
        <button type="button" class="text-button sidebar-order-button" data-direction="up" data-sidebar-id="${id}" ${index === 0 ? "disabled" : ""}>上移</button>
        <button type="button" class="text-button sidebar-order-button" data-direction="down" data-sidebar-id="${id}" ${index === sidebarOrder().length - 1 ? "disabled" : ""}>下移</button>
      </span>
    </div>
  `).join("");
  $$(".sidebar-visibility-check").forEach(input => input.addEventListener("change", () => {
    // 媒体库不仅要在这里显示，还要落到 library_sidebar 上（复用三态开关那条保存通路）。
    if (input.dataset.sidebarId === "library") setLibrarySidebarMode(input.checked ? "show" : "hide");
    syncSettingsNavigation(true);
    if (typeof applySidebarOrder === "function") applySidebarOrder();
  }));
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
  renderCustomCollectionSettings();
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
      // 设置里的顺序和主侧边栏必须是同一份：这里立刻重排，别等按「保存」。
      syncSettingsNavigation(true);
      if (typeof applySidebarOrder === "function") applySidebarOrder();
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
      // 移动现有行而不是重渲染面板，否则其它未保存的改动会被清掉。
      const list = $("#builtinCollectionOrderList");
      order.forEach((id) => list.append(
        $(`.builtin-order-button[data-category="${id}"]`).closest(".sidebar-setting-item"),
      ));
      $$(".builtin-order-button").forEach((control) => {
        const position = order.indexOf(Number(control.dataset.category));
        control.disabled = control.dataset.direction === "up"
          ? position === 0
          : position === order.length - 1;
      });
    });
  });
  if (typeof setupSettingHelp === "function") setupSettingHelp();
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
  if (status) {
    status.textContent = sharing.configured ? `共享目录：${sharing.shared_folder}` : "未设置共享目录";
    status.classList.toggle("is-ok", Boolean(sharing.configured));
  }
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
  status.classList.toggle("is-ok", Boolean(webdav.configured && !webdav.last_error));
  status.classList.toggle("is-error", Boolean(webdav.configured && webdav.last_error));
  if (!webdav.configured) {
    status.textContent = "尚未连接坚果云";
  } else if (webdav.last_error) {
    status.textContent = `上次同步未完成：${webdav.last_error}`;
  } else if (webdav.last_synced_at) {
    status.textContent = `已连接坚果云 · 上次同步 ${webdav.last_synced_at}`;
  } else {
    status.textContent = "配置已保存，尚未同步";
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
  state.settings = ThemeSettingsSession.incoming(payload.settings);
  renderBgmSourceControls();
  return payload;
}

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

const THEME_PALETTES = [
  { id: "forest", name: "森野绿", color: "#2e6d4e" },
  { id: "ocean", name: "海蓝", color: "#2784aa" },
  { id: "violet", name: "暮紫", color: "#7c60ae" },
  { id: "amber", name: "暖琥珀", color: "#aa7833" },
  { id: "rose", name: "蔷薇粉", color: "#b85670" },
  { id: "indigo", name: "靛蓝", color: "#5269b6" },
  { id: "teal", name: "青碧", color: "#23807a" },
  { id: "slate", name: "雾灰蓝", color: "#58677a" },
];

function themeProfiles() {
  return Array.isArray(state.settings.theme_profiles) && state.settings.theme_profiles.length
    ? state.settings.theme_profiles
    : [{ id: "default", name: "默认主题", theme_color: "forest", custom_theme_color: "#2e6d4e", custom_background_enabled: false, custom_background_version: 0, custom_background_overlay_opacity: 82 }];
}

function activeThemeId() {
  return state.settings.active_theme_profile || themeProfiles()[0].id;
}

function themePaletteEntry(id) {
  return THEME_PALETTES.find((entry) => entry.id === id) || null;
}

function themeAccentColor(profile) {
  if (profile?.theme_color === "custom") return String(profile.custom_theme_color || "#2e6d4e").toUpperCase();
  return themePaletteEntry(profile?.theme_color)?.color || "#2e6d4e";
}

function themeAccountId() {
  return state.active_profile?.id || "local";
}

function themeBackgroundUrl(profile) {
  if (!profile || profile.custom_background_enabled !== true) return "";
  return `/api/background?profile=${encodeURIComponent(profile.id)}&account=${encodeURIComponent(themeAccountId())}&v=${Number(profile.custom_background_version) || 0}`;
}

function themeWeeklyPlan() {
  const plan = state.settings?.theme_weekly_plan;
  return plan && typeof plan === "object" && !Array.isArray(plan) ? plan : {};
}

function themePlanTodayDay() {
  // JS 周日是 0，这里换成 ISO 星期（周一 1…周日 7），与服务端一致。
  return String(new Date().getDay() || 7);
}

function renderThemeWeeklyPlan() {
  const box = $("#themeWeeklyPlan");
  if (!box) return;
  const enabled = state.settings.theme_weekly_plan_enabled === true;
  const toggle = $("#themeWeeklyPlanEnabledInput");
  if (toggle) toggle.checked = enabled;
  const profiles = themeProfiles();
  const plan = themeWeeklyPlan();
  const today = themePlanTodayDay();
  box.classList.toggle("is-disabled", !enabled);
  box.innerHTML = WEEKDAY_LABELS.map((label, index) => {
    const day = String(index + 1);
    const selected = String(plan[day] || "");
    const options = [
      `<option value=""${selected ? "" : " selected"}>不指定（保持当前）</option>`,
      ...profiles.map((profile) => {
        const id = String(profile.id || "");
        return `<option value="${escapeHtml(id)}"${id === selected ? " selected" : ""}>${escapeHtml(profile.name || "未命名主题")}</option>`;
      }),
    ].join("");
    return `<label class="theme-plan-day${day === today ? " is-today" : ""}"><span>${label}${day === today ? "<i>今天</i>" : ""}</span><select data-theme-plan-day="${day}" ${enabled ? "" : "disabled"} aria-label="${label}使用的主题">${options}</select></label>`;
  }).join("");
  const random = $("#themeRandomOnOpenInput");
  if (random) {
    random.disabled = enabled;
    random.closest(".setting-row")?.classList.toggle("is-plan-overridden", enabled);
  }
}

function themeProfileSummary(profile) {
  const palette = themePaletteEntry(profile.theme_color);
  const color = profile.theme_color === "custom"
    ? `自定义 ${String(profile.custom_theme_color || "").toUpperCase()}`
    : palette?.name || "森野绿";
  return profile.custom_background_enabled === true ? `${color} · 背景图` : color;
}

// 顶层外观字段只从方案快照取，避免预览时把编辑中的值写进另一套方案。
function profileAppearance(profile) {
  return {
    theme_color: profile?.theme_color || "forest",
    custom_theme_color: String(profile?.custom_theme_color || "#2E6D4E").toUpperCase(),
    custom_background_enabled: profile?.custom_background_enabled === true,
    custom_background_version: Number(profile?.custom_background_version) || 0,
    custom_background_overlay_opacity: Number(profile?.custom_background_overlay_opacity ?? 82),
  };
}

function themeCardMarkup(profile, active, single) {
  const accent = themeAccentColor(profile);
  const background = ThemeSettingsSession.background(profile);
  const deleteTitle = single ? "至少要保留一套主题方案" : `删除「${profile.name || "未命名主题"}」`;
  return `<article class="theme-card${active ? " is-active" : ""}" data-theme-card="${escapeHtml(profile.id)}" role="listitem">
    <button type="button" class="theme-card-main" data-theme-pick="${escapeHtml(profile.id)}" aria-pressed="${active}">
      <span class="theme-thumb" style="--accent:${escapeHtml(accent)}">
        ${background ? `<img src="${escapeHtml(background)}" alt="" loading="lazy" onerror="this.remove()" />` : ""}
        <span class="theme-thumb-side" aria-hidden="true"></span>
        <span class="theme-thumb-lines" aria-hidden="true"><i></i><i></i><i></i></span>
        ${active ? '<span class="theme-card-badge">已选择</span>' : ""}
      </span>
      <span class="theme-card-meta"><strong>${escapeHtml(profile.name || "未命名主题")}</strong><small>${escapeHtml(themeProfileSummary(profile))}</small></span>
    </button>
    <span class="theme-card-actions">
      <button type="button" class="text-button" data-theme-edit="${escapeHtml(profile.id)}">编辑</button>
      <button type="button" class="text-button danger" data-theme-delete="${escapeHtml(profile.id)}" ${single ? "disabled" : ""} title="${escapeHtml(deleteTitle)}">删除</button>
    </span>
  </article>`;
}

// 只刷新主题区；切换方案或保存后用它，避免重渲染整个面板把其他页签未保存的改动清掉。
function renderThemeControls() {
  renderThemeProfiles();
  const random = $("#themeRandomOnOpenInput");
  if (random) random.checked = state.settings.theme_random_on_open === true;
  renderThemeWeeklyPlan();
  if (themeEditorState.open) renderThemeEditorFields();
}

function renderThemeProfiles() {
  const grid = $("#themeProfileGrid");
  if (!grid) return;
  const profiles = themeProfiles();
  const active = activeThemeId();
  grid.innerHTML = profiles.map((profile) => themeCardMarkup(profile, profile.id === active, profiles.length <= 1)).join("")
    + `<button type="button" class="theme-card theme-card-new" id="newThemeCard">
        <span class="theme-card-plus" aria-hidden="true">＋</span>
        <strong>新建主题</strong>
        <small>配色、背景各存一套</small>
      </button>`;
}

// 背景的选择状态直接显示在行内，避免用户对着“未选择文件”猜有没有设过。
function renderBackgroundStatus() {
  const name = $("#customBackgroundName");
  if (!name) return;
  const draft = themeEditorState.draft;
  const pending = themeEditorState.pendingFile;
  const enabled = Boolean(draft?.custom_background_enabled);
  name.textContent = pending ? `待上传：${pending.name}` : enabled ? "已设置" : "未设置";
  name.classList.toggle("is-set", enabled);
  const clear = $("#clearCustomBackgroundButton");
  if (clear) clear.disabled = !enabled;
}

const themeEditorState = {
  open: false,
  mode: "new",
  id: "",
  draft: null,
  snapshot: null,
  pendingFile: null,
  localBackgroundUrl: null,
  copyBackgroundFrom: "",
  saving: false,
};

function themeEditorBackgroundUrl(draft) {
  if (!draft?.custom_background_enabled) return "";
  return themeEditorState.localBackgroundUrl
    || ThemeSettingsSession.background({ ...draft, id: draft.backgroundProfileId || draft.id });
}

// 编辑面板里的背景预览：遮罩强度和选图都在这里先看到效果。
function renderThemeEditorPreview() {
  const preview = $("#themeEditorBackgroundPreview");
  const draft = themeEditorState.draft;
  if (!preview || !draft) return;
  const url = themeEditorBackgroundUrl(draft);
  const overlay = Math.min(1, Math.max(0, Number(draft.custom_background_overlay_opacity ?? 82) / 100));
  preview.style.setProperty("--preview-accent", themeAccentColor(draft));
  preview.style.setProperty("--preview-overlay", String(overlay));
  preview.style.setProperty("--preview-image", url ? `url('${url}')` : "none");
  preview.dataset.label = url ? "背景预览" : "纯色背景";
  preview.classList.toggle("has-image", Boolean(url));
}

function renderThemeEditorFields() {
  const draft = themeEditorState.draft;
  if (!draft) return;
  const title = $("#themeEditorTitle");
  const subtitle = $("#themeEditorSubtitle");
  if (title) title.textContent = themeEditorState.mode === "edit" ? `编辑主题「${draft.name || "未命名"}」` : "新建主题";
  if (subtitle) subtitle.textContent = themeEditorState.mode === "edit"
    ? "调整后先预览，保存设置后才保留。"
    : "创建后先预览，保存设置后才保留。";
  // 名称只在打开面板时回填；这里回写会在用户点颜色、选图片时把刚输入的名字清掉。
  $$(".theme-option").forEach((button) => {
    const active = button.dataset.themeValue === draft.theme_color;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
  const customInput = $("#customThemeColorInput");
  const customPreview = $("#customThemeColorPreview");
  // 预设主题时显示该预设的实际色值，避免“选了青碧、输入框却还写着上一套的自定义色”。
  const shownColor = draft.theme_color === "custom" ? draft.custom_theme_color : themeAccentColor(draft);
  // 正在输入 HEX 时不要回写，否则调滑块、点预设会把没提交的颜色清掉。
  if (customInput && document.activeElement !== customInput) customInput.value = String(shownColor || "#2E6D4E").toUpperCase();
  if (customPreview) customPreview.value = String(shownColor || "#2e6d4e").toLowerCase();
  const usingCustom = draft.theme_color === "custom";
  $("#customThemeInUse")?.classList.toggle("hidden", !usingCustom);
  $("#customThemeColorInput")?.closest(".theme-editor-custom")?.classList.toggle("is-active", usingCustom);
  const opacity = Number(draft.custom_background_overlay_opacity ?? 82);
  const opacityInput = $("#customBackgroundOpacityInput");
  const opacityValue = $("#customBackgroundOpacityValue");
  if (opacityInput) opacityInput.value = opacity;
  if (opacityValue) opacityValue.textContent = `${opacity}%`;
  renderThemeEditorPreview();
  renderBackgroundStatus();
}

function applyThemeDraft() {
  const draft = themeEditorState.draft;
  if (!draft) return;
  Object.assign(state.settings, {
    ...profileAppearance(draft),
    // 新建时背景图仍属于来源方案，预览要指回它，否则会 404。
    active_theme_profile: draft.backgroundProfileId || draft.id,
  });
  const previewUrl=themeEditorBackgroundUrl(draft);
  window.handbookThemePreview = previewUrl ? { backgroundUrl: previewUrl } : null;
  applyTheme();
}

function themeAppearanceSnapshot() {
  return {
    active_theme_profile: state.settings.active_theme_profile,
    ...profileAppearance({
      theme_color: state.settings.theme_color,
      custom_theme_color: state.settings.custom_theme_color,
      custom_background_enabled: state.settings.custom_background_enabled,
      custom_background_version: state.settings.custom_background_version,
      custom_background_overlay_opacity: state.settings.custom_background_overlay_opacity,
    }),
  };
}

function openThemeEditor(profileId = null) {
  const profiles = themeProfiles();
  const source = profileId
    ? profiles.find((profile) => profile.id === profileId)
    : profiles.find((profile) => profile.id === activeThemeId()) || profiles[0];
  if (!source) return;
  const creating = !profileId;
  themeEditorState.snapshot = themeAppearanceSnapshot();
  themeEditorState.mode = creating ? "new" : "edit";
  themeEditorState.id = creating ? `theme_${Date.now()}` : source.id;
  themeEditorState.draft = {
    id: themeEditorState.id,
    name: creating ? "" : source.name,
    ...profileAppearance(source),
    // 预览背景仍指回来源方案（新建时还没有自己的背景文件）。
    backgroundProfileId: source.id,
  };
  themeEditorState.pendingFile = null;
  themeEditorState.localBackgroundUrl = null;
  themeEditorState.copyBackgroundFrom = creating && source.custom_background_enabled === true ? source.id : "";
  themeEditorState.saving = false;
  themeEditorState.reading=false;$("#themeEditorSave").disabled=false;
  themeEditorState.open = true;
  const status = $("#themeEditorStatus");
  if (status) status.textContent = "";
  const nameInput = $("#themeEditorName");
  if (nameInput) nameInput.value = themeEditorState.draft.name || "";
  const scroller = $("#themeEditorModal")?.querySelector(".theme-editor-scroll");
  if (scroller) scroller.scrollTop = 0;
  renderThemeEditorFields();
  $("#themeEditorModal").showModal();
  applyThemeDraft();
  nameInput?.focus();
  if (!creating) nameInput?.select();
}

function setThemeEditorStatus(text) {
  const status = $("#themeEditorStatus");
  if (status) status.textContent = text || "";
}

function closeThemeEditor(cancel = true) {
  if (!themeEditorState.open) return;
  if (cancel && themeEditorState.snapshot) Object.assign(state.settings, themeEditorState.snapshot);
  themeEditorState.open = false;
  themeEditorState.draft = null;
  themeEditorState.pendingFile = null;
  themeEditorState.localBackgroundUrl = null;
  themeEditorState.copyBackgroundFrom = "";
  window.handbookThemePreview = null;
  $("#themeEditorModal")?.close();
  if (ThemeSettingsSession.active) ThemeSettingsSession.apply();
  if (cancel) {
    applyTheme();
    renderThemeControls();
  }
}

function themeFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

async function uploadThemeBackground(file, profileId, staged = false) {
  if (window.handbookOnline) return window.handbookOnline.uploadImage("/api/background", file, profileId, staged);
  const data = await themeFileToDataUrl(file);
  return api("/api/background", {
    method: "POST",
    body: JSON.stringify({ data, profile_id: profileId, account_id: themeAccountId(), defer_settings: staged }),
  });
}

// 新建主题继承当前背景时，背景文件仍在来源方案名下；保存时复制一份到新 id，
// 否则新方案会指向一个不存在的文件。
async function copyThemeBackground(profileId) {
  const source = themeProfiles().find((profile) => profile.id === profileId);
  const url = themeBackgroundUrl(source);
  if (!url) return null;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const blob = await response.blob();
    return new File([blob], "background.jpg", { type: blob.type || "image/jpeg" });
  } catch (_) {
    return null;
  }
}

async function persistThemeProfiles(profiles, activeId) {
  state.settings.theme_profiles=profiles;state.settings.active_theme_profile=activeId;
  ThemeSettingsSession.select(activeId);renderThemeProfiles();
}
async function persistThemePlan(plan, enabled) {
  state.settings.theme_weekly_plan=plan;state.settings.theme_weekly_plan_enabled=enabled;
  ThemeSettingsSession.update();renderThemeControls();
}

async function saveThemeWeeklyPlan(notify = false) {
  const plan = {};
  $$("[data-theme-plan-day]").forEach((select) => { plan[select.dataset.themePlanDay] = select.value; });
  const enabled = $("#themeWeeklyPlanEnabledInput").checked;
  try {
    await persistThemePlan(plan, enabled);
    if (enabled) applyWeeklyThemeForToday(true);
    else {
      ThemeSettingsSession.restoreSelection();
      renderThemeControls();
    }
    ThemeSettingsSession.apply();

  } catch (error) {
    renderThemeControls();
    toast(error.message, "error");
  }
}

// 关闭周计划或某天改成“不指定”时，回到当前 active 方案；关闭时 PATCH 已把 active 恢复成数据库里的值。
function applySavedThemeProfile() {
  const profile = themeProfiles().find((item) => String(item.id) === activeThemeId());
  if (!profile) return;
  Object.assign(state.settings, profileAppearance(profile));
  applyTheme();
}

// 只改内存里的当前外观，不写数据库：周计划是“当天显示什么”，不是把方案改成当前。
function applyWeeklyThemeForToday(force = false) {
  if (ThemeSettingsSession.active && !force) return;
  if (state.settings?.theme_weekly_plan_enabled !== true) return;
  const day = themePlanTodayDay();
  if (!force && state.weeklyPlanDay === day) return;
  state.weeklyPlanDay = day;
  const id = String(themeWeeklyPlan()[day] || "");
  if (!id) {
    applySavedThemeProfile();
    renderThemeControls();
    return;
  }
  const profile = themeProfiles().find((item) => String(item.id) === id);
  if (!profile) return;
  if (activeThemeId() === id) return;
  Object.assign(state.settings, profileAppearance(profile), { active_theme_profile: id });
  window.handbookThemePreview = null;
  applyTheme();
  renderThemeControls();
}

let themePlanTimer = null;
let themePlanWatcherBound = false;
function startThemePlanWatcher() {
  clearInterval(themePlanTimer);
  themePlanTimer = setInterval(() => applyWeeklyThemeForToday(), 60_000);
  if (themePlanWatcherBound) return;
  themePlanWatcherBound = true;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) applyWeeklyThemeForToday();
  });
}

async function saveThemeEditor() {
  const draft = themeEditorState.draft;
  if (!draft || themeEditorState.saving || themeEditorState.reading) return;
  const nameInput = $("#themeEditorName");
  const name = String(nameInput?.value || "").trim();
  if (!name) {
    toast("给这套主题起个名字", "error");
    nameInput?.focus();
    return;
  }
  if (themeProfiles().some((profile) => profile.id !== draft.id && String(profile.name || "").trim() === name)) {
    toast("已有同名主题，换一个名字", "error");
    nameInput?.focus();
    return;
  }
  draft.name = name;
  themeEditorState.saving = true;
  const saveButton = $("#themeEditorSave");
  if (saveButton) saveButton.disabled = true;
  setThemeEditorStatus("正在保存…");
  try {
    ThemeSettingsSession.stage(draft.id,themeEditorState.pendingFile,themeEditorState.localBackgroundUrl,themeEditorState.copyBackgroundFrom,draft.custom_background_enabled);
    Object.assign(state.settings, { ...profileAppearance(draft), active_theme_profile: draft.id });
    const snapshot = {
      id: draft.id,
      name: draft.name,
      theme_color: draft.theme_color,
      custom_theme_color: draft.custom_theme_color,
      custom_background_enabled: draft.custom_background_enabled === true,
      custom_background_version: draft.custom_background_version || 0,
      custom_background_overlay_opacity: Number(draft.custom_background_overlay_opacity ?? 82),
    };
    const profiles = themeEditorState.mode === "edit"
      ? themeProfiles().map((profile) => profile.id === draft.id ? snapshot : profile)
      : [...themeProfiles(), snapshot];
    await persistThemeProfiles(profiles, draft.id);
    applyTheme();
    setThemeEditorStatus("");
    closeThemeEditor(false);
    renderThemeControls();
    toast(`正在预览「${name}」，保存设置后保留`);
  } catch (error) {
    setThemeEditorStatus(error.message || "保存失败");
    toast(error.message, "error");
  } finally {
    themeEditorState.saving = false;
    if (saveButton) saveButton.disabled = false;
  }
}

async function activateThemeProfile(id) {
  const profile = themeProfiles().find((item) => item.id === id);
  if (!profile) return;
  Object.assign(state.settings, profileAppearance(profile), { active_theme_profile: id });
  ThemeSettingsSession.select(id);
  renderThemeControls();
}

async function deleteThemeProfile(id) {
  const profiles = themeProfiles();
  if (profiles.length <= 1) {
    toast("至少要保留一套主题方案", "error");
    return;
  }
  const target = profiles.find((profile) => profile.id === id);
  const fallback = profiles.find((profile) => profile.id !== id);
  if (!target || !fallback) return;
  if (!confirm(`删除主题方案「${target.name || "未命名"}」？\n保存设置后删除，取消设置可恢复。`)) return;
  const remaining = profiles.filter((profile) => profile.id !== id);
  // 周计划里指向被删方案的格子要一起清空，否则会留下一个永远取不到的主题 id。
  const plan = { ...themeWeeklyPlan() };
  let planChanged = false;
  for (let day = 1; day <= 7; day += 1) {
    if (plan[String(day)] === id) {
      plan[String(day)] = "";
      planChanged = true;
    }
  }
  if (planChanged) state.settings.theme_weekly_plan = plan;
  // 先把界面切到保底方案，再一次性写入，避免删除后有一帧仍显示被删方案。
  Object.assign(state.settings, profileAppearance(fallback), { active_theme_profile: fallback.id });
  await persistThemeProfiles(remaining, fallback.id);
  if(planChanged)await persistThemePlan(plan,state.settings.theme_weekly_plan_enabled===true);
  applyTheme();
  renderThemeControls();
  toast(`已删除「${target.name || "方案"}」，当前使用「${fallback.name || "另一套"}」`);
}

function librarySidebarMode() {
  return state.settings?.library_sidebar || "show";
}

// 改媒体库显隐：走三态开关那条通路（立即保存 + 应用 + toast），两条入口共享同一份配置。
function setLibrarySidebarMode(mode) {
  const select = $("#librarySidebarMode");
  if (select) {
    select.value = mode;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  state.settings.library_sidebar = mode;
  api("/api/settings", { method: "PATCH", body: JSON.stringify({ library_sidebar: mode }) })
    .then(() => applyLibrarySidebarVisibility?.())
    .catch((error) => toast(`没存上：${error.message || error}`, "error"));
}

// 三态开关改过之后，把「侧边栏显示与顺序」里的勾选框同步过来。
function syncLibraryVisibilityCheckbox() {
  const box = $('.sidebar-visibility-check[data-sidebar-id="library"]');
  if (box) box.checked = librarySidebarMode() !== "hide";
}

let settingsGroupsInitialized = false;
const SETTINGS_PAGE_IDS = {collection: "collection", schedule: "schedule", record: "timeline", statistics: "statistics", ranking: "ranking"};
function syncSettingsNavigation(preview = false) {
  if (!settingsGroupsInitialized) return;
  const visibility = sidebarVisibility();
  if (preview) $$(".sidebar-visibility-check").forEach(input => { visibility[input.dataset.sidebarId] = input.checked; });
  const tabs = new Map($$("[data-settings-tab]").map(button => [button.dataset.settingsTab, button]));
  const nav = $("#settingsSideNav"), list = $(".settings-list");
  // 设置分类跟随主导航的顺序：主界面在最前，接着按侧边栏里页面的实际顺序排
  // （收藏夹后面挂番剧详情，媒体库对应「媒体库」这一节），最后是工具类分类。
  // 之前媒体库（offline）没进这个序列，永远不会被 append，就一直留在最前面。
  const SETTINGS_TABS_BY_PAGE = {
    collection: ["collection", "detail"],
    library: ["offline"],
    schedule: ["schedule"],
    timeline: ["record"],
    statistics: ["statistics"],
    ranking: ["ranking"],
  };
  const orderedTabs = ["main", ...sidebarOrder().flatMap((id) => SETTINGS_TABS_BY_PAGE[id] || []), "keyboard", "data", "sharing"];
  orderedTabs.forEach(tab => {
    const button = tabs.get(tab);
    if (!button) return;
    // 媒体库（offline）的显隐是这一节自己的三态开关管的，不能跟着侧边栏一起藏，
    // 否则用户把侧边栏关掉就再也进不来打开了。
    button.classList.toggle("hidden", Boolean(SETTINGS_PAGE_IDS[tab] && visibility[SETTINGS_PAGE_IDS[tab]] === false));
    nav.append(button);
    const group = $(`.settings-group[data-settings-group="${tab}"]`);
    if (group) list.append(group);
  });
  if ([...tabs.values()].some(button => button.classList.contains("active") && button.classList.contains("hidden"))) switchSettingsTab("main");
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
    $("#goToEpisodeMouseGestures").addEventListener("click", () => {
      resetSettingsSearch();
      switchSettingsTab("detail");
      const heading = $("#episodeMouseGestureHeading");
      heading.scrollIntoView({ block: "center" });
      heading.focus({ preventScroll: true });
    });
    settingsGroupsInitialized = true;
  }
  syncSettingsNavigation();
  switchSettingsTab("main");
}


// 看番记录默认筛选：设置页只改草稿，点「保存设置」才写入；空集合表示显示全部。
function timelineDefaultThemes() {
  const saved = state.settings?.timeline_default_themes;
  return Array.isArray(saved) ? saved.map(String) : [];
}

function renderTimelineDefaultThemes() {
  const grid = $("#timelineDefaultThemesMenu");
  if (!grid) return;
  const selected = new Set(timelineDefaultThemes());
  grid.innerHTML =
    recordThemes()
      .map((theme) => `<label><input type="checkbox" value="${escapeHtml(theme.id)}"${selected.has(theme.id) ? " checked" : ""} /><span class="theme-dot" style="--theme-dot:${escapeHtml(theme.color)}"></span>${escapeHtml(theme.name)}</label>`)
      .join("") +
    `<button type="button" class="text-button timeline-default-all" id="timelineDefaultThemesAll">清空选择（显示全部）</button>`;
}

// —— 从 Kazumi 规则仓库挑选跳转链接 ——
// 只取规则里的站点名与搜索地址；规则本身（解析、播放、弹幕）不使用。
const LINK_RULES_FALLBACK_LIMIT = 12;
const linkRulesState = { items: [], selected: new Set(), loading: false, error: "", fetchedAt: 0, limit: LINK_RULES_FALLBACK_LIMIT };

function linkRulesUsedCount() {
  return editableLinks("detail").length;
}

function linkRulesRemaining() {
  const limit = linkRulesState.limit || LINK_RULES_FALLBACK_LIMIT;
  return Math.max(0, limit - linkRulesUsedCount());
}

function linkRuleExistingUrls() {
  return new Set(editableLinks("detail").map((link) => String(link.url || "").trim()).filter(Boolean));
}

function updateLinkRulesStatus() {
  const status = $("#linkRulesStatus");
  const add = $("#linkRulesAdd");
  const selected = linkRulesState.selected.size;
  const remaining = linkRulesRemaining();
  if (status) {
    if (linkRulesState.loading) status.textContent = "正在获取规则…";
    else if (linkRulesState.error) status.textContent = linkRulesState.error;
    else if (!linkRulesState.items.length) status.textContent = "还没有规则缓存，点「刷新规则」获取。";
    else status.textContent = `共 ${linkRulesState.items.length} 个站点可用 · 链接总数上限 ${linkRulesState.limit || LINK_RULES_FALLBACK_LIMIT} 条，还能加 ${remaining} 条`;
    status.classList.toggle("is-error", Boolean(linkRulesState.error));
  }
  if (add) {
    add.textContent = `添加选中的 ${selected} 个`;
    add.disabled = !selected || remaining <= 0;
  }
}

function updateRuleCatalogStatus() {
  const status = $("#ruleCatalogStatus");
  if (!status) return;
  const count = linkRulesState.items.length;
  const stamp = Number(linkRulesState.fetchedAt) || 0;
  if (!count) {
    status.textContent = "规则站点尚未获取，点「检查规则更新」拉取一次";
    status.classList.remove("is-ok");
    return;
  }
  const when = stamp
    ? new Date(stamp * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
  status.textContent = `已保存 ${count} 个规则站点${when ? ` · 上次更新 ${when}` : ""}；平时只用本地这份，不会自动联网`;
  status.classList.add("is-ok");
}

async function refreshLinkCatalog() {
  const button = $("#refreshRuleCatalog");
  const label = button ? button.textContent : "";
  const firstTime = !Number(linkRulesState.fetchedAt);
  if (button) { button.disabled = true; button.textContent = "检查中…"; }
  try {
    const payload = await api("/api/link-rules/refresh", { method: "POST", body: "{}" });
    linkRulesState.items = Array.isArray(payload.items) ? payload.items : [];
    linkRulesState.fetchedAt = Number(payload.fetched_at) || 0;
    linkRulesState.limit = Number(payload.limit) || LINK_RULES_FALLBACK_LIMIT;
    linkRulesState.error = "";
    const total = linkRulesState.items.length;
    if (firstTime) {
      toast(`已获取 ${total} 个规则站点，保存在本机`);
    } else {
      const added = Number(payload.added) || 0;
      const removed = Number(payload.removed) || 0;
      toast(added || removed
        ? `规则已更新：新增 ${added} 个${removed ? `，移除 ${removed} 个` : ""}，现有 ${total} 个`
        : `规则已是最新，现有 ${total} 个站点`);
    }
    updateRuleCatalogStatus();
    renderLinkRules();
  } catch (error) {
    linkRulesState.error = error.message;
    toast(error.message, "error");
    updateRuleCatalogStatus();
  } finally {
    if (button) { button.disabled = false; button.textContent = label || "检查规则更新"; }
  }
}

function renderLinkRules() {
  const list = $("#linkRulesList");
  if (!list) return;
  updateRuleCatalogStatus();
  updateLinkRulesStatus();
  if (linkRulesState.loading) {
    list.innerHTML = `<p class="rules-empty">正在从规则仓库读取站点列表…</p>`;
    return;
  }
  if (!linkRulesState.items.length) {
    list.innerHTML = `<p class="rules-empty">${escapeHtml(linkRulesState.error || "还没有规则。点「刷新规则」联网获取一次，之后会保存在本机。")}</p>`;
    return;
  }
  const keyword = String($("#linkRulesSearch")?.value || "").trim().toLowerCase();
  const existing = linkRuleExistingUrls();
  const remaining = linkRulesRemaining();
  const matched = linkRulesState.items.filter((item) => !keyword
    || String(item.name || "").toLowerCase().includes(keyword)
    || String(item.host || "").toLowerCase().includes(keyword));
  if (!matched.length) {
    list.innerHTML = `<p class="rules-empty">没有匹配「${escapeHtml(keyword)}」的站点。</p>`;
    return;
  }
  // 已经加过的排到后面，打开面板先看到可用的。
  const ordered = [...matched].sort((left, right) => Number(existing.has(left.template)) - Number(existing.has(right.template)));
  const scroll = list.scrollTop;
  list.replaceChildren();
  ordered.forEach((item) => {
    const added = existing.has(item.template);
    const checked = !added && linkRulesState.selected.has(item.id);
    const row = document.createElement("label");
    row.className = `rules-row${added ? " is-added" : ""}`;
    row.title = added ? "已经在列表里" : item.template;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = item.id;
    input.checked = checked;
    input.disabled = added || (!checked && linkRulesState.selected.size >= remaining);
    const name = document.createElement("span");
    name.className = "rules-name";
    name.textContent = item.name;
    const host = document.createElement("span");
    host.className = "rules-host";
    host.textContent = added ? "已添加" : item.host;
    row.append(input, name, host);
    list.append(row);
  });
  list.scrollTop = scroll;
}

async function loadLinkRules(force = false) {
  if (linkRulesState.loading) return;
  linkRulesState.loading = true;
  linkRulesState.error = "";
  renderLinkRules();
  try {
    let payload = null;
    if (!force) {
      const cached = await api("/api/link-rules");
      if (Array.isArray(cached.items) && cached.items.length) payload = cached;
    }
    // 没有缓存时顺手拉一次：用户已经主动打开这个面板，不算后台自动请求。
    if (!payload) payload = await api("/api/link-rules/refresh", { method: "POST", body: "{}" });
    linkRulesState.items = Array.isArray(payload.items) ? payload.items : [];
    linkRulesState.fetchedAt = Number(payload.fetched_at) || 0;
    linkRulesState.limit = Number(payload.limit) || LINK_RULES_FALLBACK_LIMIT;
    const known = new Set(linkRulesState.items.map((item) => item.id));
    linkRulesState.selected = new Set([...linkRulesState.selected].filter((id) => known.has(id)));
  } catch (error) {
    linkRulesState.error = error.message;
  } finally {
    linkRulesState.loading = false;
    renderLinkRules();
  }
}

function openLinkRules() {
  if (!$("#linkRulesModal")) return;
  linkRulesState.selected = new Set();
  linkRulesState.error = "";
  const search = $("#linkRulesSearch");
  if (search) search.value = "";
  $("#linkRulesModal").showModal();
  renderLinkRules();
  loadLinkRules(false);
}

function addSelectedLinkRules() {
  const chosen = linkRulesState.items.filter((item) => linkRulesState.selected.has(item.id));
  if (!chosen.length) return;
  const remaining = linkRulesRemaining();
  if (remaining <= 0) {
    toast(`详情页链接最多 ${linkRulesState.limit} 条，请先删掉一些再加`, "error");
    return;
  }
  const existing = linkRuleExistingUrls();
  const rows = editableLinks("detail");
  let added = 0;
  chosen.forEach((item) => {
    if (added >= remaining || existing.has(item.template)) return;
    rows.push({ id: detailLinkId(), kind: "custom", name: item.name, url: item.template, enabled: false });
    existing.add(item.template);
    added += 1;
  });
  if (!added) {
    toast("选中的站点都已经在列表里了", "error");
    return;
  }
  commitLinkList("detail", rows);
  linkRulesState.selected = new Set();
  $("#linkRulesModal").close();
  toast(`已添加 ${added} 个搜索链接，点右下角「保存设置」生效`);
}

// ===== 设置搜索（VS Code 式）：输入即在页内过滤——隐藏分类导航，命中的
// 设置行连着小节标题搬进结果区按分类平铺，命中文字加粗高亮；↑/↓（或
// Enter / Shift+Enter）逐个跳转；清空后原样放回。
const settingsSearchState = {
  moved: [], panel: null,
  marks: [],       // 本次搜索创建的 <mark>，还原时拆开
  hitInputs: [],   // 值里含关键词的输入框，加了提示底色
  matches: [],     // 结果区里的 .setting-row，按 DOM 顺序即跳转顺序
  current: -1,     // 当前跳到第几个匹配
};

function settingsSearchTokens(query) {
  return String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
}

function ensureSearchPanel() {
  if (settingsSearchState.panel?.isConnected) return settingsSearchState.panel;
  const list = $(".settings-list");
  if (!list) return null;
  const panel = document.createElement("section");
  panel.className = "settings-search-results";
  panel.id = "settingsSearchResults";
  panel.hidden = true;
  list.append(panel);
  settingsSearchState.panel = panel;
  return panel;
}

function restoreSearchRows() {
  // 逆序放回：每个节点的锚点（原 nextSibling）要么没动过，要么比自己晚搬、
  // 已经先放回去了，insertBefore 才不会踩空。
  for (const record of [...settingsSearchState.moved].reverse()) {
    record.parent.insertBefore(record.node, record.next);
  }
  settingsSearchState.moved = [];
}

function escapeSearchToken(token) {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 高亮不用 CSS Highlight API（用户浏览器上实测不出效果），直接把命中文本
// 包进 <mark>：加粗 + 主题色底，全浏览器可见。mark 只包纯文本节点，不碰
// 元素结构和各设置项自己的事件绑定；还原时按记录逐个拆开即可。
function clearSearchHighlight() {
  for (const mark of settingsSearchState.marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    mark.replaceWith(...mark.childNodes);
    parent.normalize();
  }
  settingsSearchState.marks = [];
  for (const input of settingsSearchState.hitInputs) {
    input.classList.remove("settings-hit-input");
  }
  settingsSearchState.hitInputs = [];
  for (const row of settingsSearchState.matches) {
    row.classList.remove("settings-search-current");
  }
  settingsSearchState.matches = [];
  settingsSearchState.current = -1;
}

function applySearchHighlight(root, tokens) {
  clearSearchHighlight();
  if (!tokens.length) return;
  const pattern = new RegExp(tokens.map(escapeSearchToken).join("|"), "gi");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("input,select,textarea,script,style")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  // 先收集命中节点再切分：切分会改树结构，边走边切会打乱 TreeWalker。
  const targets = [];
  for (let node = walker.nextNode(); node && targets.length < 600; node = walker.nextNode()) {
    pattern.lastIndex = 0;
    if (pattern.test(node.nodeValue)) targets.push(node);
  }
  for (const node of targets) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (match.index > last) frag.append(text.slice(last, match.index));
      const mark = document.createElement("mark");
      mark.className = "settings-hit-mark";
      mark.textContent = match[0];
      frag.append(mark);
      settingsSearchState.marks.push(mark);
      last = match.index + match[0].length;
      if (settingsSearchState.marks.length >= 600) break;
    }
    if (last < text.length) frag.append(text.slice(last));
    if (frag.childNodes.length) node.replaceWith(frag);
  }
  // 输入框的值不是文本节点，包不了 mark：给值里含关键词的输入框加提示底色。
  for (const input of $$("input,textarea", root)) {
    const value = String(input.value || "").toLowerCase();
    if (value && tokens.some((token) => value.includes(token))) {
      input.classList.add("settings-hit-input");
      settingsSearchState.hitInputs.push(input);
    }
  }
}

function gotoSearchMatch(step) {
  const matches = settingsSearchState.matches;
  if (!matches.length) return;
  const next = (settingsSearchState.current + step + matches.length) % matches.length;
  matches[settingsSearchState.current]?.classList.remove("settings-search-current");
  settingsSearchState.current = next;
  const row = matches[next];
  row.classList.add("settings-search-current");
  row.scrollIntoView({ block: "center" });
  const count = $("#settingsSearchCount");
  if (count) count.textContent = `${next + 1} / ${matches.length}`;
}

// 搜索后落在第一个匹配上（VS Code 行为）：高亮 + 计数，不滚动免得打字时乱跳。
function focusFirstSearchMatch() {
  const matches = settingsSearchState.matches;
  const count = $("#settingsSearchCount");
  if (!matches.length) {
    if (count) { count.textContent = ""; count.classList.add("hidden"); }
    return;
  }
  matches[0].classList.add("settings-search-current");
  settingsSearchState.current = 0;
  if (count) {
    count.textContent = `1 / ${matches.length}`;
    count.classList.remove("hidden");
  }
}

function resetSettingsSearch() {
  const input = $("#settingsSearch");
  if (input) input.value = "";
  runSettingsSearch("");
}

function runSettingsSearch(query) {
  const modal = $("#settingsModal");
  const panel = ensureSearchPanel();
  const count = $("#settingsSearchCount");
  const clearButton = $("#settingsSearchClear");
  if (!modal || !panel) return;
  restoreSearchRows();
  clearSearchHighlight();
  const tokens = settingsSearchTokens(query);
  clearButton?.classList.toggle("hidden", !tokens.length);
  if (!tokens.length) {
    modal.classList.remove("settings-searching");
    panel.hidden = true;
    panel.replaceChildren();
    if (count) { count.textContent = ""; count.classList.add("hidden"); }
    $("#settingsSearchPrev")?.classList.add("hidden");
    $("#settingsSearchNext")?.classList.add("hidden");
    return;
  }

  // 按侧栏顺序扫每个分类；行按「所属小节标题 + 行文本」匹配，多关键词全含。
  const sections = [];
  for (const head of $$("[data-settings-tab]")) {
    const tab = head.dataset.settingsTab;
    const group = $(`.settings-group[data-settings-group="${tab}"]`);
    if (!group) continue;
    let currentSub = null;
    const matched = [];
    // 媒体库那一节是表单流（.offline-settings 里放 .offline-field / .offline-switch），
    // 不是 .setting-row；只认 .setting-row 会让它整节搜不到。这里按同样的顺序往下走一层。
    const ROW_CLASSES = ["setting-row", "offline-field", "offline-field-row", "offline-switch"];
    const walk = (parent) => {
      for (const node of parent.children) {
        const cls = node.classList;
        if (!cls) continue;
        if (cls.contains("settings-subsection-title")) { currentSub = node; continue; }
        if (cls.contains("offline-settings")) { walk(node); continue; }
        if (!ROW_CLASSES.some((name) => cls.contains(name))) continue;
        const haystack = `${currentSub?.textContent || ""} ${node.textContent}`.toLowerCase();
        if (tokens.every((token) => haystack.includes(token))) matched.push({ node, sub: currentSub });
      }
    };
    walk(group);
    if (!matched.length) continue;
    const section = document.createElement("div");
    section.className = "settings-search-section";
    const title = document.createElement("p");
    title.className = "settings-search-section-title";
    title.textContent = `${head.textContent.trim()} · ${matched.length} 项`;
    section.append(title);
    const movedSubs = new Set();
    for (const item of matched) {
      if (item.sub && !movedSubs.has(item.sub)) {
        settingsSearchState.moved.push({ parent: item.sub.parentElement, node: item.sub, next: item.sub.nextSibling });
        section.append(item.sub);
        movedSubs.add(item.sub);
      }
      settingsSearchState.moved.push({ parent: item.node.parentElement, node: item.node, next: item.node.nextSibling });
      section.append(item.node);
    }
    sections.push(section);
  }

  const emptyMessage = document.createElement("p");
  emptyMessage.className = "settings-search-empty";
  emptyMessage.textContent = `没有匹配「${String(query).trim()}」的设置项，换个词试试`;
  panel.replaceChildren(...(sections.length ? sections : [emptyMessage]));
  panel.hidden = false;
  modal.classList.add("settings-searching");
  applySearchHighlight(panel, tokens);
  // .offline-field-row 里还套着两个 .offline-field，只留外层，遍历时不会一步跳两次。
  settingsSearchState.matches = $$(".setting-row, .offline-field, .offline-field-row, .offline-switch", panel)
    .filter((node) => !(node.classList.contains("offline-field") && node.parentElement?.classList.contains("offline-field-row")));
  $("#settingsSearchPrev")?.classList.toggle("hidden", !settingsSearchState.matches.length);
  $("#settingsSearchNext")?.classList.toggle("hidden", !settingsSearchState.matches.length);
  focusFirstSearchMatch();
}

function initSettingsSearch() {
  const input = $("#settingsSearch");
  if (!input) return;
  if (!initSettingsSearch.bound) {
    initSettingsSearch.bound = true;
    input.addEventListener("input", (event) => runSettingsSearch(event.target.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.stopPropagation(); resetSettingsSearch(); return; }
      // VS Code 式遍历：Enter 下一个，Shift+Enter 上一个；上下方向键同义。
      if (event.key === "Enter" || event.key === "ArrowDown") {
        event.preventDefault();
        gotoSearchMatch(event.shiftKey ? -1 : 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        gotoSearchMatch(-1);
      }
    });
    $("#settingsSearchPrev")?.addEventListener("click", () => gotoSearchMatch(-1));
    $("#settingsSearchNext")?.addEventListener("click", () => gotoSearchMatch(1));
    $("#settingsSearchClear")?.addEventListener("click", resetSettingsSearch);
    // 搜索状态下直接关弹窗也没事：close 时把搬走的行放回原位。
    $("#settingsModal")?.addEventListener("close", () => {
      restoreSearchRows();
      clearSearchHighlight();
      settingsSearchState.panel?.replaceChildren();
      if (settingsSearchState.panel) settingsSearchState.panel.hidden = true;
      $("#settingsModal").classList.remove("settings-searching");
      $("#settingsSearchClear")?.classList.add("hidden");
      $("#settingsSearchPrev")?.classList.add("hidden");
      $("#settingsSearchNext")?.classList.add("hidden");
      const count = $("#settingsSearchCount");
      if (count) { count.textContent = ""; count.classList.add("hidden"); }
      if (input) input.value = "";
    });
  }
}

// ===== 主设置里的「自动追新番」开关（与离线面板是同一个配置）=====
async function initAutoFollowSetting() {
  const input = $("#autoFollowSetting");
  if (!input) return;
  try {
    const data = await api("/api/offline/settings");
    input.checked = (data.config || {}).auto_follow === true;
  } catch (error) { /* 读不到就保持当前状态，保存时后端会校验 */ }
  if (!initAutoFollowSetting.bound) {
    initAutoFollowSetting.bound = true;
    input.addEventListener("change", async () => {
      const checked = input.checked;
      try {
        await api("/api/offline/settings", {
          method: "POST",
          body: JSON.stringify({ auto_follow: checked }),
        });
        const panel = $("#offlineAutoFollow");
        if (panel) panel.checked = checked;
        toast(checked ? "已开启自动追新番" : "已关闭自动追新番");
      } catch (error) {
        input.checked = !checked;
        toast(`自动追新番没存上：${error.message || error}`, "error");
      }
    });
  }
}

// ===== 加入收藏自动打开找资源：开关 + 触发的收藏夹复选 =====
function renderAutoOpenOfflineCollections() {
  const box = $("#autoOpenOfflineCollections");
  if (!box) return;
  const selected = new Set((state.settings.auto_open_offline_collections || []).map(String));
  const options = [...CATEGORIES, ...(state.custom_collections || [])];
  box.innerHTML = options.map((item) => `
    <label class="auto-open-offline-item">
      <input type="checkbox" value="${Number(item.id)}" ${selected.has(String(item.id)) ? "checked" : ""} />
      <span>${escapeHtml(item.name || `收藏夹 ${item.id}`)}</span>
    </label>`).join("") || '<p class="settings-search-empty">还没有可用收藏夹</p>';
}

function initAutoOpenOfflineSetting() {
  const input = $("#autoOpenOfflineInput");
  if (!input) return;
  input.checked = state.settings.auto_open_offline_enabled === true;
  renderAutoOpenOfflineCollections();
  const row = $("#autoOpenOfflineCollectionsRow");
  if (row) row.classList.toggle("hidden", !input.checked);
  if (!initAutoOpenOfflineSetting.bound) {
    initAutoOpenOfflineSetting.bound = true;
    input.addEventListener("change", () => {
      const current = $("#autoOpenOfflineCollectionsRow");
      if (current) current.classList.toggle("hidden", !input.checked);
    });
  }
}
