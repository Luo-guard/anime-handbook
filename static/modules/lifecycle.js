async function startSync(options = {}) {
  const silent = Boolean(options.silent);
  try {
    const result = await api("/api/sync", {
      method: "POST",
      body: JSON.stringify({ refresh_all: false }),
    });
    if (!silent) toast(result.message);
    state.sync.running = true;
    state.sync.message = "正在自动同步 Kazumi 收藏…";
    renderSync();
    startStatusPolling({ silent });
  } catch (error) {
    if (state.sync.running) {
      startStatusPolling({ silent });
      return;
    }
    if (!silent) {
      toast(error.message, "error");
    } else {
      state.sync.last_error = error.message;
      state.sync.message = error.message;
      renderSync();
    }
  }
}

// 服务端在返回 index.html 时已经按周计划/随机选好主题并写进首屏样式；这里沿用
// 同一套字段，避免启动后 applyTheme() 又按数据库里的方案把界面跳回去。
function adoptInitialWeeklyTheme() {
  const initial = window.handbookInitialAppearance;
  if (!initial?.weekly_theme_profile) return;
  if (state.settings?.theme_weekly_plan_enabled !== true) return;
  const profiles = Array.isArray(state.settings.theme_profiles) ? state.settings.theme_profiles : [];
  const chosen = profiles.find((item) => String(item?.id) === String(initial.weekly_theme_profile));
  if (!chosen) return;
  state.settings = {
    ...state.settings,
    ...(initial.settings || {}),
    active_theme_profile: String(chosen.id),
  };
  state.weeklyThemeProfile = String(chosen.id);
  state.weeklyPlanDay = null;
}

function adoptInitialRandomTheme() {
  const initial = window.handbookInitialAppearance;
  if (!initial?.random_theme_profile) return;
  if (state.settings?.theme_weekly_plan_enabled === true) return;
  if (state.settings?.theme_random_on_open !== true) return;
  const profiles = Array.isArray(state.settings.theme_profiles) ? state.settings.theme_profiles : [];
  const chosen = profiles.find((item) => String(item?.id) === String(initial.random_theme_profile));
  if (!chosen) return;
  state.settings = {
    ...state.settings,
    ...(initial.settings || {}),
    active_theme_profile: String(chosen.id),
  };
  // 让设置面板知道“现在显示的是随机抽到的那套”，而不是数据库里记录的方案。
  state.randomThemeProfile = String(chosen.id);
}

async function refreshStatus(options = {}) {
  const silent = Boolean(options.silent);
  const payload = await api("/api/status");
  const wasRunning = state.sync.running;
  state.sync = payload.sync;
  state.stats = payload.stats;
  // /api/status 不再携带全部收藏：数据版本变了才调一次全量接口。
  const revision = Number(payload.revision || 0);
  const collectionChanged = revision !== state.dataRevision;
  if (collectionChanged) {
    const fresh = await api("/api/collection-state");
    commitAnimes(fresh.animes, { render: false });
    state.custom_collections = fresh.custom_collections || state.custom_collections;
    // 拉取成功才记账，失败时下一次轮询会再试一次。
    state.dataRevision = revision;
    renderTabs();
    renderCollection();
    renderSeasonFilter();
    populateAnimeSelect();
  } else {
    state.dataRevision = revision;
  }
  renderStats();
  renderSync();
  if (wasRunning && !state.sync.running && !silent) {
    toast(state.sync.message, state.sync.last_error ? "error" : "normal");
  }
  return state.sync.running;
}

function startStatusPolling(options = {}) {
  const silent = Boolean(options.silent);
  clearInterval(state.statusTimer);
  let polling = false;
  state.statusTimer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const running = await refreshStatus({ silent });
      if (!running) {
        clearInterval(state.statusTimer);
        state.statusTimer = null;
      }
    } catch {
      // A transient polling failure should not interrupt the rest of the UI.
    } finally {
      polling = false;
    }
  }, 900);
}

let airingRefreshPending = false;
let airingRefreshTimer = null;

async function refreshAiringProgress() {
  if (airingRefreshPending || document.hidden) return;
  airingRefreshPending = true;
  const collection = state.animes;
  try {
    const ids = (typeof scheduleState !== "undefined" ? scheduleState.data?.items || [] : [])
      .map((item) => item.id || item.local_id).filter(Boolean);
    const params = new URLSearchParams();
    if (state.settings.schedule_airing_source === "as") {
      if (ids.length) params.set("ids", ids.join(","));
      if (typeof scheduleSource === "function" && scheduleSource() === "as" && scheduleState.week) {
        params.set("calendar_source", "as"); params.set("week", scheduleState.week);
      }
    }
    const query = params.toString() ? `?${params}` : "";
    const payload = await api(`/api/airing${query}`);
    // A profile change or collection refresh invalidates this request's owner.
    if (state.animes !== collection) return;
    const fresh = new Map((payload.animes || []).map((anime) => [anime.id, anime.airing]));
    const freshAS = new Map((payload.animes || []).map((anime) => [anime.id, anime.as_airing]));
    let changed = false;
    for (const anime of collection) {
      if (!fresh.has(anime.id)) continue;
      const airing = fresh.get(anime.id) || undefined;
      if (JSON.stringify(anime.airing) !== JSON.stringify(airing)) {
        anime.airing = airing;
        changed = true;
      }
      const asAiring = freshAS.get(anime.id) || undefined;
      if (JSON.stringify(anime.as_airing) !== JSON.stringify(asAiring)) {
        anime.as_airing = asAiring;
        changed = true;
      }
    }
    if (payload.schedule_airing && typeof scheduleState !== "undefined") {
      for (const item of scheduleState.data?.items || []) {
        const asAiring = payload.calendar_airing?.[item.key] || payload.schedule_airing[String(item.id || item.local_id)];
        if (asAiring === undefined) continue;
        if (JSON.stringify(item.as_airing) !== JSON.stringify(asAiring)) {
          item.as_airing = asAiring;
          changed = true;
        }
      }
    }
    if (!changed) return;
    if (state.activeView === "schedule") renderSchedule();
    if (state.progressAnime && $("#progressModal")?.open) {
      const anime = collection.find((item) => item.id === state.progressAnime.id);
      if (anime) {
        state.progressAnime.airing = anime.airing;
        state.progressAnime.as_airing = anime.as_airing;
        refreshEpisodeAiringStatus();
      }
    }
  } catch {
    // Cached progress stays available during a transient/offline request.
  } finally {
    airingRefreshPending = false;
  }
}

function startAiringWatcher() {
  clearInterval(airingRefreshTimer);
  airingRefreshTimer = setInterval(refreshAiringProgress, 60000);
  if (!startAiringWatcher.listening) {
    document.addEventListener("visibilitychange", refreshAiringProgress);
    window.addEventListener("focus", refreshAiringProgress);
    startAiringWatcher.listening = true;
  }
}

async function bootstrap() {
  try {
    const payload = await api("/api/bootstrap");
    Object.assign(state, payload);
    commitAnimes(state.animes, { render: false });
    state.dataRevision = Number(payload.revision || 0);
    adoptInitialWeeklyTheme();
    adoptInitialRandomTheme();
    initializeSchedule();
    startAiringWatcher();
    applyTheme();
    if (typeof applyWeeklyThemeForToday === "function") applyWeeklyThemeForToday();
    if (typeof startThemePlanWatcher === "function") startThemePlanWatcher();
    applySidebarLayout();
    let initialView = ["timeline", "statistics", "ranking", "schedule"].includes(state.settings.default_view)
      ? state.settings.default_view
      : "collection";
    if (sidebarVisibility()[initialView] === false) initialView = state.activeView;
    if (initialView === "collection") applyCollectionHome();
    switchView(initialView);
    applyNoteComposerMode();
    $("#dayStartLabel").textContent = state.settings.day_start_hour;
    $("#dayStartInput").value = state.settings.day_start_hour;
    renderStats();
    renderSync();
    renderTabs();
    renderCollection();
    applyCollectionEditingAvailability();
    renderSeasonFilter();
    populateAnimeSelect();
    openVideoCaptureFromLocation();
    if (window.handbookOnline) {
      window.handbookOnline.start();
    } else if (state.sync.running) {
      startStatusPolling({ silent: true });
    } else {
      startSync({ silent: true });
    }
  } catch (error) {
    toast(`初始化失败：${error.message}`, "error");
  }
}

async function createCustomCollection(options = {}) {
  const selectAfterCreate = options.selectAfterCreate !== false;
  const name = prompt("请输入自定义收藏夹名称");
  if (name === null) return null;
  const trimmed = name.trim();
  if (!trimmed) {
    toast("收藏夹名称不能为空", "error");
    return null;
  }
  try {
    const payload = await api("/api/custom-collections", {
      method: "POST",
      body: JSON.stringify({ name: trimmed }),
    });
    state.custom_collections = payload.custom_collections || state.custom_collections;
    state.stats = payload.stats || state.stats;
    commitAnimes(payload.animes || state.animes, { render: false });
    if (selectAfterCreate) {
      state.collectionKind = "custom";
      state.customCollectionId = Number(payload.collection.id);
    }
    renderStats();
    renderTabs();
    renderCollection();
    // 只刷新收藏夹列表：整页重渲染会把设置里其他未保存的改动清掉。
    if (typeof renderCustomCollectionSettings === "function") renderCustomCollectionSettings();
    toast("自定义收藏夹已创建");
    return payload;
  } catch (error) {
    toast(error.message, "error");
    return null;
  }
}

function customCollectionCategoryName(category) {
  const match = (typeof CATEGORIES !== "undefined" ? CATEGORIES : []).find(
    (item) => Number(item.id) === Number(category),
  );
  return match ? match.name : "Kazumi 收藏夹";
}

// 改名与“映射到哪个 Kazumi 收藏夹”共用同一个 PATCH：只传要改的字段。
async function updateCustomCollectionSettings(collectionId, changes) {
  try {
    const payload = await api(`/api/custom-collections/${collectionId}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
    state.custom_collections = payload.custom_collections || state.custom_collections;
    if (typeof renderCustomCollectionSettings === "function") renderCustomCollectionSettings();
    renderTabs();
    renderCollection();
    if ("kazumi_category" in changes) {
      toast(
        changes.kazumi_category
          ? `已映射到 Kazumi「${customCollectionCategoryName(changes.kazumi_category)}」，之后加入这个收藏夹会同步改 Kazumi 分类`
          : "已取消映射，之后加入不会改动 Kazumi 分类",
      );
    } else {
      toast("收藏夹已重命名");
    }
    return payload;
  } catch (error) {
    toast(error.message, "error");
    // 失败时把下拉恢复成服务端的真实值。
    if (typeof renderCustomCollectionSettings === "function") renderCustomCollectionSettings();
    return null;
  }
}

async function renameCustomCollection(collectionId) {
  const current = state.custom_collections.find(
    (item) => Number(item.id) === Number(collectionId),
  );
  if (!current) return;
  const name = prompt("新的收藏夹名称", current.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    toast("收藏夹名称不能为空", "error");
    return;
  }
  if (trimmed === current.name) return;
  await updateCustomCollectionSettings(collectionId, { name: trimmed });
}

async function deleteCustomCollection(collectionId) {
  const collection = state.custom_collections.find(
    (item) => Number(item.id) === Number(collectionId),
  );
  if (!collection) return;
  if (state.custom_collections.length === 1 && visibleBuiltinCategories().length === 0) {
    toast("请先在设置里显示至少一个 Kazumi 收藏夹，再删除最后一个自定义收藏夹", "error");
    return;
  }
  if (!confirm(`删除自定义收藏夹“${collection.name}”？这不会删除番剧和观看进度。`)) {
    return;
  }
  try {
    const payload = await api(`/api/custom-collections/${collectionId}`, {
      method: "DELETE",
    });
    state.custom_collections = payload.custom_collections || [];
    state.stats = payload.stats || state.stats;
    commitAnimes(payload.animes || state.animes, { render: false });
    ensureVisibleCollection();
    renderStats();
    renderTabs();
    renderCollection();
    if (typeof renderCustomCollectionSettings === "function") renderCustomCollectionSettings();
    if (state.progressAnime) {
      const latest = state.animes.find((item) => item.id === state.progressAnime.id);
      if (latest) state.progressAnime = latest;
    }
    toast("自定义收藏夹已删除");
  } catch (error) {
    toast(error.message, "error");
  }
}

