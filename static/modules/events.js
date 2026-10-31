$$(".nav-item[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.view === "collection") {
      applyCollectionHome();
      renderTabs();
      renderCollection();
    }
    switchView(button.dataset.view);
  });
});

$$('[data-stat-period]').forEach((button) => {
  button.addEventListener("click", () => {
    state.statisticsPeriod = button.dataset.statPeriod;
    $$('[data-stat-period]').forEach((item) => item.classList.toggle("active", item === button));
    renderStatistics();
  });
});

$("#statisticsTypeSelect")?.addEventListener("change", (event) => {
  state.statisticsType = event.target.value;
  renderStatistics();
});

$("#searchInput").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderCollection();
});

$("#collectionFloatingButton").addEventListener("click", () => {
  const panel = $("#collectionFloatingPanel");
  panel.showModal();
  $("#collectionFloatingButton").setAttribute("aria-expanded", "true");
});

$("#closeCollectionFloatingPanel").addEventListener("click", () => {
  $("#collectionFloatingPanel").close();
});

$("#collectionFloatingPanel").addEventListener("close", () => {
  $("#collectionFloatingButton").setAttribute("aria-expanded", "false");
});

let timelineSearchTimer = null;
$("#timelineSearchInput").addEventListener("input", (event) => {
  state.timelineSearch = event.target.value;
  clearTimeout(timelineSearchTimer);
  timelineSearchTimer = setTimeout(renderTimeline, 180);
});
setupDismissibleMenu("#timelineThemeFilterButton", "#timelineThemeFilterMenu");

$("#syncButton").addEventListener("click", syncPrimaryAction);
$("#emptySyncButton").addEventListener("click", startSync);
$("#createCollectionButton").addEventListener("click", createCustomCollection);
$("#createRankingButton").addEventListener("click", createRankingBoard);

$("#collectionRatingToggle").addEventListener("change", async (event) => {
  try {
    const visibility = {
      ...(state.settings.category_rating_visibility || {}),
      [activeVisibilityKey()]: event.target.checked,
    };
    const payload = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ category_rating_visibility: visibility }),
    });
    state.settings = payload.settings;
    renderCollection();
  } catch (error) {
    toast(error.message, "error");
  }
});

$("#progressBarToggle").addEventListener("change", async (event) => {
  try {
    const visibility = {
      ...(state.settings.category_progress_visibility || {}),
      [activeVisibilityKey()]: event.target.checked,
    };
    const payload = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ category_progress_visibility: visibility }),
    });
    state.settings = payload.settings;
    state.stats = payload.stats || state.stats;
    state.animes = payload.animes || state.animes;
    state.custom_collections = payload.custom_collections || state.custom_collections;
    renderCollection();
  } catch (error) {
    toast(error.message, "error");
  }
});

$$("[data-sort-mode]").forEach((row) => row.addEventListener("click", async (event) => {
  try {
    const mode = row.dataset.sortMode;
    const direction = event.target.dataset.sortDirection || collectionSortDirection();
    const modes = { ...(state.settings.collection_sort_modes || {}), [activeVisibilityKey()]: mode };
    const directions = { ...(state.settings.collection_sort_directions || {}) };
    directions[activeVisibilityKey()] = direction;
    const payload = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ collection_sort_modes: modes, collection_sort_directions: directions }),
    });
    state.settings = payload.settings;
    renderCollection();
  } catch (error) {
    toast(error.message, "error");
  }
}));

$("#sidebarToggle").addEventListener("click", () => setSidebarCollapsed(true));
$("#sidebarReopenButton").addEventListener("click", () => setSidebarCollapsed(false));

$("#episodeCountInput").addEventListener("change", renderEpisodeGrid);
$("#progressModal .modal-close").addEventListener("click", (event) => {
  event.preventDefault();
  $("#progressModal").close();
});
$$("[data-detail-tab]").forEach((button) => button.addEventListener("click", () => {
  const tab = button.dataset.detailTab;
  switchDetailTab(tab);
  if (tab === "characters") loadCharacters();
}));
$("#refreshCharacters").addEventListener("click", () => loadCharacters(true));
$("#openAnimeComment").addEventListener("click", () => {
  $("#animeCommentForm").classList.remove("hidden");
  $("#animeCommentContent").focus();
});
$("#openAnimeRating").addEventListener("click", async () => {
  if (!state.progressAnime) return;
  const value = prompt("写下你的个人评分（可自由输入，例如：五星上、夯、S）", state.progressAnime.personal_rating_text || state.progressAnime.personal_score || "");
  if (value === null) return;
  const score = value.trim();
  try {
    const result = await api(`/api/animes/${state.progressAnime.id}/rating`, { method: "POST", body: JSON.stringify({ rating: score }) });
    state.progressAnime.personal_rating_text = score;
    const anime = state.animes.find((item) => item.id === state.progressAnime.id);
    if (anime) anime.personal_rating_text = score;
    $("#personalRating").textContent = score ? `我的评分 ${score}` : "";
    $("#personalRating").classList.toggle("hidden", !score);
    renderCollection();
    toast(score ? "评分已写入时间线" : (result.deleted ? "评分与对应记录已删除" : "评分已清除"));
  } catch (error) { toast(error.message, "error"); }
});
$("#openAgeRelated").addEventListener("click", async () => {
  if (!state.progressAnime) return;
  const button = $("#openAgeRelated");
  button.disabled = true;
  button.textContent = "正在查找…";
  try {
    const result = await api(`/api/animes/${state.progressAnime.id}/age-related`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    renderAgeRelated(result.related || {});
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "查找相关番剧";
  }
});
$("#cancelAnimeComment").addEventListener("click", () => {
  $("#animeCommentForm").classList.add("hidden");
  $("#animeCommentContent").value = "";
});
$("#saveAnimeComment").addEventListener("click", async () => {
  if (!state.progressAnime) return;
  try {
    const content = $("#animeCommentContent").value;
    await api(`/api/animes/${state.progressAnime.id}/comments`, {
      method: "POST",
      body: JSON.stringify({
        content,
        raw_directives: recordTextFormat({
          themes: [eventTheme({ theme: "anime_comment" }).name],
          anime: state.progressAnime.display_name,
          content,
        }),
      }),
    });
    $("#animeCommentContent").value = "";
    $("#animeCommentForm").classList.add("hidden");
    renderAnimeComments(state.progressAnime.id);
    toast("番剧评论已写入时间线");
  } catch (error) {
    toast(error.message, "error");
  }
});
$("#cancelProgress").addEventListener("click", () => $("#progressModal").close());
$("#saveProgress").addEventListener("click", saveProgress);

$("#writeNoteButton").addEventListener("click", () => {
  $("#noteComposer").classList.remove("hidden");
  $("#noteContent").focus();
});

$("#closeComposer").addEventListener("click", () => {
  $("#noteComposer").classList.add("hidden");
});

async function createRecordTheme() {
  const name = prompt("主题名称");
  if (!name?.trim()) return;
  const color = prompt("主题颜色（HEX，例如 #7B61A8）", "#7B61A8");
  if (!/^#[0-9a-f]{6}$/i.test(color || "")) { toast("请输入 6 位 HEX 颜色", "error"); return; }
  const id = `custom_${Date.now()}`;
  const themes = [...allRecordThemes(), { id, name: name.trim(), color: color.toUpperCase(), builtin: false }];
  try {
    const payload = await api("/api/settings", { method: "PATCH", body: JSON.stringify({ record_themes: themes }) });
    state.settings = payload.settings;
    populateAnimeSelect();
    state.noteThemes = new Set([id]);
    updateNoteThemeLabel();
  } catch (error) { toast(error.message, "error"); }
}

setupDismissibleMenu("#noteThemeButton", "#noteThemeMenu");
setupAssociatedAnimeMenu();

async function insertRecordImages(input, textarea) {
  const files = [...(input.files || [])];
  if (!files.length) return;
  if (files.length > 9) {
    toast("一次最多插入 9 张图片", "error");
    input.value = "";
    return;
  }
  const oversized = files.find((file) => file.size > 8 * 1024 * 1024);
  if (oversized) {
    toast(`图片「${oversized.name}」不能超过 8 MB`, "error");
    input.value = "";
    return;
  }
  try {
    const inserts = [];
    for (const [index, file] of files.entries()) {
      toast(files.length > 1 ? `正在上传图片 ${index + 1}/${files.length}` : "正在上传图片");
      const result = window.handbookOnline
        ? await window.handbookOnline.uploadImage("/api/record-images", file)
        : await (async () => {
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error("读取图片失败"));
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(file);
          });
          return api("/api/record-images", {
            method: "POST",
            body: JSON.stringify({ data }),
          });
        })();
      inserts.push(`![${file.name}](${result.url})`);
    }
    const insert = inserts.join("\n");
    textarea.setRangeText(insert, textarea.selectionStart, textarea.selectionEnd, "end");
    textarea.focus();
    toast(files.length > 1 ? `${files.length} 张图片已插入记录` : "图片已插入记录");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    input.value = "";
  }
}

$("#noteImageInput").addEventListener("change", async (event) => {
  await insertRecordImages(event.target, $("#noteContent"));
});

$("#noteComposer").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/notes", {
      method: "POST",
      body: JSON.stringify({
        content: $("#noteContent").value,
        anime_id: newRecordDefaultsToOther() ? null : $("#noteAnime").value || null,
        theme: [...state.noteThemes][0] || "other",
        themes: [...state.noteThemes],
        raw_directives: recordTextFormat({
          themes: recordThemes().filter((theme) => state.noteThemes.has(theme.id)).map((theme) => theme.name),
          anime: newRecordDefaultsToOther() ? "" : state.animes.find((anime) => String(anime.id) === $("#noteAnime").value)?.display_name || "",
          content: $("#noteContent").value,
        }),
      }),
    });
    $("#noteContent").value = "";
    $("#noteAnime").value = "";
    updateAssociatedAnimeLabel();
    $("#noteComposer").classList.add("hidden");
    toast("感想已写入时间线");
    await renderTimeline();
  } catch (error) {
    toast(error.message, "error");
  }
});

$("#settingsButton").addEventListener("click", () => {
  $("#dayStartInput").value = state.settings.day_start_hour;
  $("#showEpisodeBalanceInput").checked = state.settings.show_episode_balance !== false;
  $("#episodeBalanceInitialInput").value = Number(state.settings.episode_balance_initial ?? 237);
  $("#episodeBalanceDailyTargetInput").value = Number(state.settings.episode_balance_daily_target ?? 8);
  $("#statisticsDefaultThemeInput").innerHTML = [
    '<option value="all">全部记录</option>',
    ...allRecordThemes().map((theme) => `<option value="${escapeHtml(theme.id)}">${escapeHtml(theme.name)}</option>`),
  ].join("");
  $("#statisticsDefaultThemeInput").value = statisticsDefaultTheme();
  setupSettingsTabs();
  renderSettingsPanels();
  refreshSharingSettings().catch(() => {});
  refreshWebdavSettings().catch(() => {});
  $("#settingsModal").showModal();
});

async function refreshSharingSettings() {
  const payload = await api("/api/sharing");
  state.sharing = payload.sharing || {};
  state.sharing_available_profiles = payload.available_profiles || [];
  renderSharingSettings();
}

async function refreshWebdavSettings() {
  const payload = await api("/api/webdav");
  state.webdav = payload.webdav || {};
  renderWebdavSettings();
}

async function saveWebdavSettings() {
  const payload = await api("/api/webdav/configure", {
    method: "POST",
    body: JSON.stringify({
      url: $("#webdavUrlInput").value.trim(),
      username: $("#webdavUsernameInput").value.trim(),
      password: $("#webdavPasswordInput").value,
      account_id: $("#webdavAccountIdInput").value.trim(),
      auto_sync: $("#autoWebdavSyncInput").checked,
    }),
  });
  state.webdav = payload.webdav || {};
  $("#webdavPasswordInput").value = "";
  renderWebdavSettings();
  return payload;
}

$("#saveWebdavButton").addEventListener("click", async () => {
  try { await saveWebdavSettings(); toast("坚果云配置已保存"); } catch (error) { toast(error.message, "error"); }
});

$("#testWebdavButton").addEventListener("click", async () => {
  try {
    await saveWebdavSettings();
    const payload = await api("/api/webdav/test", { method: "POST", body: JSON.stringify({}) });
    toast(payload.message || "坚果云连接成功");
  } catch (error) { toast(error.message, "error"); }
});

async function syncWebdav(options = {}) {
  if (state.webdavSyncRunning) return;
  state.webdavSyncRunning = true;
  renderSyncButton();
  $("#syncWebdavButton").disabled = true;
  try {
    // The header uses saved credentials; only the settings button saves its form.
    if (options.saveConfig) await saveWebdavSettings();
    let payload = await api("/api/webdav/sync", { method: "POST", body: JSON.stringify({}) });
    if (payload.conflict) {
      const useLocal = confirm("本机和坚果云都在上次同步后有修改。\n\n确定：以本机这次提交为准，覆盖云端。\n取消：以坚果云版本为准，覆盖本机。");
      payload = await api("/api/webdav/sync", { method: "POST", body: JSON.stringify({ resolution: useLocal ? "local" : "remote" }) });
    }
    Object.assign(state, {
      webdav: payload.webdav || state.webdav,
      settings: payload.settings || state.settings,
      animes: payload.animes || state.animes,
      custom_collections: payload.custom_collections || state.custom_collections,
      ranking_boards: payload.ranking_boards || state.ranking_boards,
      ranking_templates: payload.ranking_templates || state.ranking_templates,
      stats: payload.stats || state.stats,
    });
    applyTheme(); renderStats(); renderTabs(); renderCollection(); renderSettingsPanels(); renderWebdavSettings();
    switchView(state.activeView);
    toast(payload.message || "坚果云同步完成");
  } catch (error) { toast(error.message, "error"); }
  finally {
    state.webdavSyncRunning = false;
    renderSyncButton();
    $("#syncWebdavButton").disabled = false;
  }
}

$("#syncWebdavButton").addEventListener("click", () => syncWebdav({ saveConfig: true }));

$("#copyWebdavAccountIdButton").addEventListener("click", async () => {
  const value = $("#webdavAccountIdInput").value.trim();
  if (!value) { toast("请先保存或填写云端账号标识", "error"); return; }
  try {
    await navigator.clipboard.writeText(value);
    toast("云端账号标识已复制，可粘贴到另一台设备");
  } catch (_) {
    $("#webdavAccountIdInput").select();
    toast("已选中云端账号标识，请按 Ctrl+C 复制");
  }
});

$("#configureSharingButton").addEventListener("click", async () => {
  try {
    const payload = await api("/api/sharing/configure", {
      method: "POST",
      body: JSON.stringify({ shared_folder: $("#sharingFolderInput").value.trim() }),
    });
    state.sharing = payload.sharing || {};
    await refreshSharingSettings();
    toast("共享目录已保存");
  } catch (error) { toast(error.message, "error"); }
});

$("#publishSharingButton").addEventListener("click", async () => {
  try {
    const payload = await api("/api/sharing/publish", { method: "POST", body: JSON.stringify({}) });
    await refreshSharingSettings();
    toast(`已发布当前账号快照：${payload.snapshot?.published_at || "完成"}`);
  } catch (error) { toast(error.message, "error"); }
});

$("#autoPublishSharingInput").addEventListener("change", async (event) => {
  try {
    const payload = await api("/api/sharing/auto-publish", {
      method: "POST",
      body: JSON.stringify({ enabled: event.target.checked }),
    });
    state.sharing = payload.sharing || state.sharing;
    toast(event.target.checked ? "已开启每 30 分钟自动发布" : "已关闭自动发布");
  } catch (error) {
    event.target.checked = !event.target.checked;
    toast(error.message, "error");
  }
});

$("#createHandbookProfileButton").addEventListener("click", async () => {
  const name = prompt("新手账账号名称");
  if (!name?.trim()) return;
  const detectedKazumiPath = state.sync?.kazumi_path || "";
  const kazumiPath = prompt(
    "绑定本机 Kazumi 收藏数据库文件（collectibles.hive）的完整路径。已自动填入检测到的路径，可修改。",
    detectedKazumiPath,
  ) ?? "";
  try {
    const payload = await api("/api/profiles", { method: "POST", body: JSON.stringify({ name: name.trim(), kazumi_path: kazumiPath.trim() }) });
    state.profiles = payload.profiles || state.profiles;
    renderSharingSettings();
    toast("新账号已创建；打开后即可独立使用");
  } catch (error) { toast(error.message, "error"); }
});

$("#renameHandbookProfileButton").addEventListener("click", async () => {
  const profileId = $("#handbookProfileInput").value;
  const profile = (state.profiles || []).find((item) => item.id === profileId);
  if (!profileId || !profile) return;
  const name = prompt("账号新名称", profile.name || "");
  if (name === null || !name.trim()) return;
  try {
    const payload = await api(`/api/profiles/${encodeURIComponent(profileId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim() }),
    });
    state.profiles = payload.profiles || state.profiles;
    if (state.active_profile?.id === profileId) state.active_profile = payload.profile || state.active_profile;
    renderSharingSettings();
    toast("账号名称已修改");
  } catch (error) { toast(error.message, "error"); }
});

$("#deleteHandbookProfileButton").addEventListener("click", async () => {
  const profileId = $("#handbookProfileInput").value;
  const profile = (state.profiles || []).find((item) => item.id === profileId);
  if (!profileId || !profile) return;
  if (profileId === state.active_profile?.id) {
    toast("请先打开其他账号，再删除当前账号", "error");
    return;
  }
  const approved = confirm(
    `确定从本机账号列表删除“${profile.name}”？\n\n这会删除本机镜像数据，但不会删除 Syncthing 共享文件夹中的发布快照。`,
  );
  if (!approved) return;
  try {
    const payload = await api(`/api/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
    state.profiles = payload.profiles || state.profiles;
    state.sharing = payload.sharing || state.sharing;
    renderSharingSettings();
    toast("账号已从本机列表删除");
  } catch (error) { toast(error.message, "error"); }
});

$("#activateHandbookProfileButton").addEventListener("click", async () => {
  const profileId = $("#handbookProfileInput").value;
  try {
    const payload = await api("/api/profiles/activate", { method: "POST", body: JSON.stringify({ profile_id: profileId }) });
    Object.assign(state, payload);
    applyTheme();
    renderStats(); renderTabs(); renderCollection(); renderSettingsPanels();
    toast("已切换手账账号");
  } catch (error) { toast(error.message, "error"); }
});

$("#loadSharedProfilesButton").addEventListener("click", async () => {
  try { await refreshSharingSettings(); toast("已检查共享账号"); } catch (error) { toast(error.message, "error"); }
});

$("#sharedProfileList").addEventListener("click", async (event) => {
  const button = event.target.closest(".load-shared-profile");
  if (!button) return;
  try {
    const payload = await api("/api/sharing/load", { method: "POST", body: JSON.stringify({ profile_id: button.dataset.profileId }) });
    state.profiles = payload.profiles || state.profiles;
    await refreshSharingSettings();
    toast("共享账号已加载；可在上方账号列表中打开");
  } catch (error) { toast(error.message, "error"); }
});

$("#sharedProfileList").addEventListener("change", async (event) => {
  if (!event.target.matches(".resident-shared-profile")) return;
  const selected = $$(".resident-shared-profile").filter((input) => input.checked).map((input) => input.dataset.profileId);
  try {
    const payload = await api("/api/sharing/resident-profiles", { method: "POST", body: JSON.stringify({ profile_ids: selected }) });
    state.sharing = payload.sharing || state.sharing;
    toast("常驻加载设置已保存");
  } catch (error) { toast(error.message, "error"); }
});

$("#bgmSourceInput").addEventListener("change", (event) => {
  const source = bgmSources().find((item) => item.id === event.target.value);
  if (!source) return;
  event.target.dataset.newSource = "";
  $("#bgmSourceNameInput").value = source.name || "";
  $("#bgmSourceSiteInput").value = source.site_base || "";
  $("#bgmSourceApiInput").value = source.api_base || "";
});

$("#newBgmSourceButton").addEventListener("click", () => {
  $("#bgmSourceInput").dataset.newSource = "true";
  $("#bgmSourceNameInput").value = "";
  $("#bgmSourceSiteInput").value = "https://bgm.tv";
  $("#bgmSourceApiInput").value = "https://api.bgm.tv";
  $("#bgmSourceNameInput").focus();
});

$("#saveBgmSourceButton").addEventListener("click", async () => {
  try {
    const select = $("#bgmSourceInput");
    const isNew = select.dataset.newSource === "true";
    const sourceId = isNew ? `source_${Date.now()}` : select.value;
    const source = readBgmSourceForm(sourceId);
    const sources = bgmSources();
    const nextSources = isNew
      ? [...sources, source]
      : sources.map((item) => item.id === sourceId ? source : item);
    await saveBgmSources(nextSources, isNew ? sourceId : currentBgmSource().id);
    delete select.dataset.newSource;
    toast(isNew ? "Bangumi 站点已新增并切换" : "Bangumi 站点已更新");
  } catch (error) { toast(error.message, "error"); }
});

$("#activateBgmSourceButton").addEventListener("click", async () => {
  try {
    await saveBgmSources(bgmSources(), $("#bgmSourceInput").value);
    toast("已切换 Bangumi 站点；之后的同步会使用新 API");
  } catch (error) { toast(error.message, "error"); }
});

$("#deleteBgmSourceButton").addEventListener("click", async () => {
  const id = $("#bgmSourceInput").value;
  const sources = bgmSources();
  if (sources.length <= 1) { toast("请至少保留一个 Bangumi 站点", "error"); return; }
  const source = sources.find((item) => item.id === id);
  if (!source || !confirm(`删除站点“${source.name}”？`)) return;
  try {
    const nextSources = sources.filter((item) => item.id !== id);
    const activeId = currentBgmSource().id === id ? nextSources[0].id : currentBgmSource().id;
    await saveBgmSources(nextSources, activeId);
    toast("Bangumi 站点已删除");
  } catch (error) { toast(error.message, "error"); }
});

function selectTheme(theme) {
  state.settings.theme_color = theme;
  applyTheme();
  $$(".theme-option").forEach((button) => {
    const active = button.dataset.themeValue === theme;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
}

$$(".theme-option").forEach((button) => {
  button.addEventListener("click", () => selectTheme(button.dataset.themeValue));
});

$("#themeProfileInput").addEventListener("change", (event) => activateThemeProfile(event.target.value));
$("#newThemeProfileButton").addEventListener("click", async () => {
  const name = prompt("新主题名称");
  if (!name?.trim()) return;
  const id = `theme_${Date.now()}`;
  const profiles = [...themeProfiles(), currentThemeSnapshot(id, name.trim())];
  await persistThemeProfiles(profiles, id);
  state.settings.active_theme_profile = id;
});
$("#renameThemeProfileButton").addEventListener("click", async () => {
  const id = $("#themeProfileInput").value;
  const current = themeProfiles().find((item) => item.id === id);
  if (!current) return;
  const name = prompt("修改主题名称", current.name);
  if (!name?.trim() || name.trim() === current.name) return;
  const profiles = themeProfiles().map((item) => item.id === id ? { ...item, name: name.trim() } : item);
  await persistThemeProfiles(profiles, id);
  toast("主题名称已修改");
});
$("#saveThemeProfileButton").addEventListener("click", async () => {
  const id = $("#themeProfileInput").value;
  const old = themeProfiles().find((item) => item.id === id);
  const profiles = themeProfiles().map((item) => item.id === id ? currentThemeSnapshot(id, old?.name || "主题") : item);
  await persistThemeProfiles(profiles, id);
  toast("当前主题方案已保存");
});
$("#deleteThemeProfileButton").addEventListener("click", async () => {
  const id = $("#themeProfileInput").value;
  if (themeProfiles().length <= 1 || !confirm("删除这个主题方案？")) return;
  const profiles = themeProfiles().filter((item) => item.id !== id);
  await persistThemeProfiles(profiles, profiles[0].id);
  await activateThemeProfile(profiles[0].id);
});

$("#customThemeColorPreview").addEventListener("input", (event) => {
  $("#customThemeColorInput").value = event.target.value.toUpperCase();
});

$("#useCustomThemeButton").addEventListener("click", () => {
  const value = $("#customThemeColorInput").value.trim();
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    toast("请输入 6 位 HEX 色值，例如 #2E6D4E", "error");
    return;
  }
  state.settings.custom_theme_color = value.toUpperCase();
  $("#customThemeColorPreview").value = value;
  selectTheme("custom");
});

$("#customBackgroundInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { toast("背景图片不能超过 8 MB", "error"); return; }
  if (window.handbookOnline) {
    try {
      toast("正在上传原图，繁忙时会自动排队");
      const payload = await window.handbookOnline.uploadImage("/api/background", file, state.settings.active_theme_profile || "default");
      state.settings = payload.settings;
      applyTheme();
      await saveActiveThemeProfileSilently();
      toast("原图背景已保存到线上账号");
    } catch (error) { toast(error.message, "error"); }
    finally { event.target.value = ""; }
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const payload = await api("/api/background", { method: "POST", body: JSON.stringify({ data: reader.result, profile_id: state.settings.active_theme_profile || "default", account_id: state.active_profile?.id || "local" }) });
      state.settings = payload.settings;
      applyTheme();
      await saveActiveThemeProfileSilently();
      toast("自定义背景已保存到本地");
    } catch (error) { toast(error.message, "error"); }
  };
  reader.readAsDataURL(file);
});

$("#clearCustomBackgroundButton").addEventListener("click", async () => {
  try {
    const payload = await api("/api/settings", { method: "PATCH", body: JSON.stringify({ custom_background_enabled: false }) });
    state.settings = payload.settings;
    applyTheme();
    $("#customBackgroundInput").value = "";
    await saveActiveThemeProfileSilently();
    toast("当前主题已关闭自定义背景");
  } catch (error) { toast(error.message, "error"); }
});

$("#customBackgroundOpacityInput").addEventListener("input", (event) => {
  state.settings.custom_background_overlay_opacity = Number(event.target.value);
  $("#customBackgroundOpacityValue").textContent = `${event.target.value}%`;
  applyTheme();
});

$("#rankingHoverDelayInput").addEventListener("input", (event) => {
  state.settings.ranking_hover_delay_seconds = Number(event.target.value);
  $("#rankingHoverDelayValue").textContent = `${event.target.value} 秒`;
  if (state.activeView === "ranking") renderRanking();
});

$("#saveSettings").addEventListener("click", async () => {
  try {
    const builtinVisibilityPayload = {};
    $$(".builtin-visibility-check").forEach((input) => {
      builtinVisibilityPayload[String(input.dataset.category)] = input.checked;
    });
    if (
      !Object.values(builtinVisibilityPayload).some(Boolean) &&
      !state.custom_collections.length
    ) {
      toast("至少保留一个收藏夹显示", "error");
      return;
    }
    const keyboardSettings = readKeyboardSettings();
    const keyboardChanged = JSON.stringify(keyboardSettings) !== JSON.stringify(keyboardPreferences());
    if(keyboardChanged && !(await api("/api/health")).features?.keyboard_shortcuts) throw new Error("当前后台尚不支持保存快捷键，请重启手账后台并刷新页面。");
    const scheduleSorting = readScheduleSorting("#scheduleSortingSettings");
    await requireScheduleSortingSupport();
    const payload = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        keyboard_shortcuts: keyboardSettings,
        day_start_hour: Number($("#dayStartInput").value),
        show_episode_balance: $("#showEpisodeBalanceInput").checked,
        episode_balance_initial: Number($("#episodeBalanceInitialInput").value),
        episode_balance_daily_target: Number($("#episodeBalanceDailyTargetInput").value),
        statistics_default_theme: $("#statisticsDefaultThemeInput").value,
        statistics_show_zero_periods: $("#showZeroStatisticsInput").checked,
        theme_color: state.settings.theme_color || "forest",
        custom_theme_color: $("#customThemeColorInput").value.trim() || "#2E6D4E",
        custom_background_overlay_opacity: Number($("#customBackgroundOpacityInput").value),
        default_view: $("#defaultViewInput").value,
        ...scheduleSorting,
        kazumi_writeback: $("#kazumiWritebackInput").checked,
        kazumi_conflict: $("#kazumiConflictInput").value,
        schedule_source: $("#scheduleSourceInput").value,
        show_schedule_source_switch: $("#scheduleSourceSwitchInput").checked,
        schedule_statuses: $$("#scheduleStatusInputs input:checked").map((input) => Number(input.value)),
        schedule_uncollected: $("#scheduleUncollectedInput").checked,
        schedule_card_fields: Object.fromEntries($$("#scheduleCardFieldInputs input").map((input) => [input.dataset.scheduleField, input.checked])),
        top_sync_action: $("#topSyncActionInput").value,
        collection_home: $("#collectionHomeInput").value,
        show_all_collection_tab: $("#showAllCollectionTabInput").checked,
        builtin_collection_order: builtinCollectionOrder(),
        sidebar_visibility: Object.fromEntries($$(".sidebar-visibility-check").map((input) => [input.dataset.sidebarId, input.checked])),
        sidebar_order: sidebarOrder(),
        sidebar_labels: Object.fromEntries($$("[data-page-name]").map(input => [input.dataset.pageName, input.value.trim()])),
        show_sidebar_toggle: $("#showSidebarToggleInput").checked,
        show_shutdown_button: $("#showShutdownButtonInput").checked,
        new_record_defaults_to_other: $("#newRecordDefaultsToOtherInput").checked,
        launch_at_login: $("#launchAtLoginInput").checked,
        show_episode_review_record: $("#showEpisodeReviewRecordInput").checked,
        show_oped_record: $("#showOpedRecordInput").checked,
        show_episode_rating_record: $("#showEpisodeRatingRecordInput").checked,
        show_character_tab: $("#showCharacterTabInput").checked,
        show_bgm_rating: $("#showBgmRatingInput").checked,
        show_bgm_rating_in_collection: $("#showCollectionBgmRatingInput").checked,
        collection_rating_source: $("#collectionRatingSourceInput").value,
        show_collection_rating_control: $("#showCollectionRatingControlInput").checked,
        show_collection_progress_control: $("#showCollectionProgressControlInput").checked,
        show_create_collection_control: $("#showCreateCollectionControlInput").checked,
        show_age_related_button: $("#showAgeRelatedButtonInput").checked,
        show_bilibili_search_button: $("#showBilibiliSearchButtonInput").checked,
        merge_bilibili_links: $("#mergeBilibiliLinksInput").checked,
        show_saved_video_list: $("#showSavedVideoListInput").checked,
        show_episode_titles_on_hover:
          $("#showEpisodeTitlesOnHoverInput").checked,
        show_ranking_hover_titles: $("#showRankingHoverTitlesInput").checked,
        ranking_hover_delay_seconds: Number($("#rankingHoverDelayInput").value),
        hide_custom_collection_items_from_builtin: $("#hideCustomizedInput").checked,
        show_custom_move_button_without_collections:
          $("#showMoveButtonWithoutCollectionsInput").checked,
        builtin_category_visibility: builtinVisibilityPayload,
      }),
    });
    verifyScheduleSortingSaved(payload.settings, scheduleSorting);
    if (payload.settings.schedule_source !== $("#scheduleSourceInput").value || payload.settings.show_schedule_source_switch !== $("#scheduleSourceSwitchInput").checked) throw new Error("后台未保存周表来源设置，请重启后台并刷新后重试。");
    if(keyboardChanged && JSON.stringify(keyboardPreferences(payload.settings.keyboard_shortcuts))!==JSON.stringify(keyboardSettings)) throw new Error("快捷键未成功保存，请重启后台并刷新后再试。");
    state.settings = payload.settings;
    state.stats = payload.stats || state.stats;
    state.animes = payload.animes || state.animes;
    state.custom_collections = payload.custom_collections || state.custom_collections;
    renderSyncButton();
    const visibleThemeIds = new Set(recordThemes().map((theme) => theme.id));
    state.noteThemes = new Set([...state.noteThemes].filter((id) => visibleThemeIds.has(id)));
    if (!state.noteThemes.size) state.noteThemes.add("other");
    state.timelineThemes = new Set([...state.timelineThemes].filter((id) => visibleThemeIds.has(id)));
    applyTheme();
    applyCharacterTabVisibility();
    $("#dayStartLabel").textContent = state.settings.day_start_hour;
    $("#settingsModal").close();
    ensureVisibleCollection();
    applySidebarLayout();
    applyNoteComposerMode();
    switchView(state.activeView);
    renderStats();
    renderTabs();
    renderCollection();
    toast("设置已保存");
    if (state.activeView === "timeline") await renderTimeline();
    if (state.activeView === "schedule") renderSchedule();
  } catch (error) {
    toast(error.message, "error");
  }
});

