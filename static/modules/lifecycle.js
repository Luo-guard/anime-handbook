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

async function refreshStatus(options = {}) {
  const silent = Boolean(options.silent);
  const payload = await api("/api/status");
  const wasRunning = state.sync.running;
  const collectionChanged = JSON.stringify(state.animes) !== JSON.stringify(payload.animes)
    || JSON.stringify(state.custom_collections) !== JSON.stringify(payload.custom_collections || state.custom_collections);
  state.animes = payload.animes;
  state.custom_collections = payload.custom_collections || state.custom_collections;
  state.stats = payload.stats;
  state.sync = payload.sync;
  renderStats();
  renderSync();
  if (collectionChanged) {
    renderTabs();
    renderCollection();
    renderSeasonFilter();
    populateAnimeSelect();
  }
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

async function bootstrap() {
  try {
    const payload = await api("/api/bootstrap");
    Object.assign(state, payload);
    initializeSchedule();
    applyTheme();
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
    state.animes = payload.animes || state.animes;
    if (selectAfterCreate) {
      state.collectionKind = "custom";
      state.customCollectionId = Number(payload.collection.id);
    }
    renderStats();
    renderTabs();
    renderCollection();
    renderSettingsPanels();
    toast("自定义收藏夹已创建");
    return payload;
  } catch (error) {
    toast(error.message, "error");
    return null;
  }
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
    state.animes = payload.animes || state.animes;
    ensureVisibleCollection();
    renderStats();
    renderTabs();
    renderCollection();
    renderSettingsPanels();
    if (state.progressAnime) {
      const latest = state.animes.find((item) => item.id === state.progressAnime.id);
      if (latest) state.progressAnime = latest;
    }
    toast("自定义收藏夹已删除");
  } catch (error) {
    toast(error.message, "error");
  }
}

