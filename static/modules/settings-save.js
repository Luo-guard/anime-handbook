// Settings save controller. Dependencies are loaded before this module in index.html.
const HandbookSettings = (() => {
  let saving = false;
  async function save() {
    const button = $("#saveSettings");
    if (saving) return;
    saving = true;
    button.disabled = true;
    ThemeSettingsSession.lock(true);
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
      const detailLinkPayload = readDetailLinks();
      const scheduleLinkPayload = readScheduleDetailLinks();
      const detailLinksChanged = JSON.stringify(detailLinkPayload) !== JSON.stringify(detailLinks());
      // 两边各自新增的自定义链接会互相同步一条（另一边默认关闭）；开关和删除互不影响。
      const linkSync = syncLinkAdditions(detailLinkPayload, scheduleLinkPayload, state.settings.detail_link_sync);
      const detailLinkPayloadFinal = linkSync.detail;
      const scheduleLinkPayloadFinal = linkSync.schedule;
      const keyboardSettings = readKeyboardSettings();
      const keyboardChanged = JSON.stringify(keyboardSettings) !== JSON.stringify(keyboardPreferences());
      if(keyboardChanged && !(await api("/api/health")).features?.keyboard_shortcuts) throw new Error("当前后台尚不支持保存快捷键，请重启手账后台并刷新页面。");
      const scheduleSorting = readScheduleSorting("#scheduleSortingSettings");
      const progressSources = {
        collection_airing_source: $("#collectionAiringSourceInput").value,
        schedule_airing_source: $("#scheduleAiringSourceInput").value,
      };
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
          // 外观草稿与其他设置由同一次保存提交。
          ...await ThemeSettingsSession.payload(),
          default_view: $("#defaultViewInput").value,
          ...scheduleSorting,
          kazumi_writeback: $("#kazumiWritebackInput").checked,
          webdav_kazumi_sync: $("#webdavKazumiSyncInput").checked,
          kazumi_read_only: $("#kazumiReadOnlyInput").checked,
          kazumi_conflict: $("#kazumiConflictInput").value,
          schedule_source: $("#scheduleSourceInput").value,
          ...progressSources,
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
          show_collection_add_button: $("#showCollectionAddButtonInput").checked,
          collection_add_button_icon_only: $("#collectionAddIconOnlyInput").checked,
          show_jump_history_button: $("#showJumpHistoryButtonInput").checked,
          jump_history_button_icon_only: $("#jumpHistoryIconOnlyInput").checked,
          show_age_related_button: $("#showAgeRelatedButtonInput").checked,
          detail_links: detailLinkPayloadFinal,
          schedule_detail_links: scheduleLinkPayloadFinal,
          detail_link_sync: linkSync.synced,
          show_search_bgm_link: $("#showSearchBgmLinkInput").checked,
          merge_bilibili_links: $("#mergeBilibiliLinksInput").checked,
          show_saved_video_list: $("#showSavedVideoListInput").checked,
          video_default_pinned: $("#videoDefaultPinnedInput").checked,
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
      if ($("#kazumiReadOnlyInput").checked && payload.settings.kazumi_read_only !== true) throw new Error("当前后台还不支持只读开关，请重启手账后台并刷新后再试。");
      if (!$("#showSearchBgmLinkInput").checked && payload.settings.show_search_bgm_link !== false) throw new Error("当前后台还不支持搜索页 Bangumi 入口开关，请重启手账后台并刷新后再试。");
      if (detailLinksChanged && !Array.isArray(payload.settings.detail_links)) throw new Error("当前后台还不支持详情页链接，请重启手账后台并刷新后再试。");
      if (!$("#showJumpHistoryButtonInput").checked && payload.settings.show_jump_history_button !== false) throw new Error("当前后台还不支持工具栏按钮设置，请重启手账后台并刷新后再试。");
      if (payload.settings.schedule_source !== $("#scheduleSourceInput").value || payload.settings.show_schedule_source_switch !== $("#scheduleSourceSwitchInput").checked) throw new Error("后台未保存周表来源设置，请重启后台并刷新后重试。");
      if(keyboardChanged && JSON.stringify(keyboardPreferences(payload.settings.keyboard_shortcuts))!==JSON.stringify(keyboardSettings)) throw new Error("快捷键未成功保存，请重启后台并刷新后再试。");
      if (Object.entries(progressSources).some(([key, value]) => (payload.settings[key] || "bgm") !== value)) throw new Error("后台未保存已播集数来源，请重启后台并刷新后重试。");
      ThemeSettingsSession.finish(true);
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
      applyCollectionEditingAvailability();
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
      await refreshAiringProgress();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      saving = false;
      button.disabled = false;
      ThemeSettingsSession.lock(false);
    }
  }
  return {save};
})();
