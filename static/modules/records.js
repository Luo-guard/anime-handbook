const RECORD_THEME_ORDER = ["watch", "anime_comment", "anime_rating", "character_record", "episode_review", "episode_rating", "oped"];
function allRecordThemes() {
  const themes = Array.isArray(state.settings?.record_themes) ? state.settings.record_themes : [];
  const position = id => id === "other" ? RECORD_THEME_ORDER.length + 1 : RECORD_THEME_ORDER.includes(id) ? RECORD_THEME_ORDER.indexOf(id) : RECORD_THEME_ORDER.length;
  // Sort a copy for display; preserve saved themes and custom-theme relative order.
  return [...themes].sort((a, b) => position(a.id) - position(b.id));
}

function recordThemes() {
  return allRecordThemes();
}

function recordTextFormat({ theme = "", themes = [], anime = "", episodes = "", content = "" }) {
  const themeNames = [...new Set([...(Array.isArray(themes) ? themes : []), ...(theme ? [theme] : [])].map(String).map((item) => item.trim()).filter(Boolean))];
  return `${themeNames.map((item) => `#主题 ${item}\n`).join("")}${anime ? `#动漫 ${anime}\n` : ""}${episodes ? `#集数 ${episodes}\n` : ""}${content || ""}`.trim();
}

function eventTheme(event) {
  const id = event.theme || (event.event_type === "watch" ? "watch" : event.event_type === "anime_comment" ? "anime_comment" : "other");
  return allRecordThemes().find((item) => item.id === id) || { id, name: id === "watch" ? "观看记录" : id === "anime_comment" ? "番剧评论" : id === "anime_rating" ? "番剧评分" : "其他记录", color: "#7c8790" };
}

// A record is format-agnostic.  Directives are only optional metadata; all
// remaining lines belong to the user and are never parsed by theme-specific code.
function parseRecordDirectives(value) {
  const lines = String(value || "").replace(/\r/g, "").split("\n");
  const themeNames = [];
  let animeName = "";
  let episodeText = "";
  const body = [];
  let hasAnimeDirective = false;
  let hasEpisodeDirective = false;
  for (const line of lines) {
    if (line.startsWith("#主题")) {
      const name = line.slice(3).trim();
      if (name) themeNames.push(name);
      continue;
    }
    if (line.startsWith("#动漫")) {
      hasAnimeDirective = true;
      animeName = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("#集数")) {
      hasEpisodeDirective = true;
      episodeText = line.slice(3).trim();
      continue;
    }
    body.push(line);
  }
  return {
    raw: String(value || ""), themeNames, animeName, episodeText,
    content: body.join("\n").trim(), hasAnimeDirective, hasEpisodeDirective,
  };
}

function resolveRecordThemes(themeNames) {
  return [...new Map(
    themeNames
      .map((themeName) => allRecordThemes().find((item) => item.name === themeName || item.id === themeName))
      .filter(Boolean)
      .map((theme) => [theme.id, theme]),
  ).values()];
}

function storedEventThemes(event) {
  const ids = Array.isArray(event.themes) && event.themes.length
    ? event.themes
    : [event.theme || (event.event_type === "watch" ? "watch" : event.event_type === "anime_comment" ? "anime_comment" : "other")];
  return [...new Map(ids.map((id) => [id, eventTheme({ theme: id, event_type: event.event_type })])).values()];
}

function eventRecordParts(event) {
  const raw = String(event.raw_directives || "").trim();
  if (!raw) {
    const episodes = Array.isArray(event.episodes) ? event.episodes : [];
    return {
      themes: storedEventThemes(event),
      title: event.display_name || "",
      episodeText: episodes.map((episode) => episode.display_label || episode.label || episode.key).join("、"),
      content: String(event.content || "").trim(),
    };
  }
  const parts = parseRecordDirectives(event.raw_directives);
  return {
    // Unknown theme names are hidden only in the display.  Their original
    // directive remains in raw_directives and comes back in the editor.
    themes: resolveRecordThemes(parts.themeNames),
    // A typed anime name appears as an association only after it was resolved
    // to an actual local anime entry when saved.
    title: event.anime_id && parts.hasAnimeDirective ? (event.display_name || parts.animeName) : "",
    episodeText: parts.hasEpisodeDirective ? parts.episodeText : "",
    content: parts.content,
  };
}

function parseRecordText(value) {
  const parts = parseRecordDirectives(value);
  const themes = resolveRecordThemes(parts.themeNames).map((theme) => theme.id);
  const anime = state.animes.find((item) => item.display_name === parts.animeName || item.name_cn === parts.animeName || item.name === parts.animeName);
  return {
    theme: themes[0] || "",
    themes,
    anime_id: anime?.id || null,
    // Keep this free text as metadata.  The backend must not map it back to
    // known episode keys, or custom text such as "EP4" would disappear.
    episodes: parts.episodeText,
    content: parts.content,
    raw_directives: parts.raw,
  };
}

function eventThemes(event) {
  return eventRecordParts(event).themes;
}

function renderRecordContent(event, parts = eventRecordParts(event)) {
  const pills = parts.episodeText
    ? `<div class="episode-pills"><span class="episode-pill">${escapeHtml(parts.episodeText)}</span></div>`
    : "";
  return `${pills}${parts.content ? `<p>${renderRecordText(parts.content)}</p>` : ""}`;
}

function renderRecordText(value) {
  const imagePattern = /!\[([^\]]*)\]\(((?:\/api\/(?:record-images\/[A-Za-z0-9_-]+\.(?:png|jpg|webp)|character-covers\/\d+\/\d+)|https?:\/\/[^\s)]+))\)/g;
  const matches = [...String(value || "").matchAll(imagePattern)];
  let cursor = 0;
  let output = "";
  for (let index = 0; index < matches.length; index += 1) {
    const first = matches[index];
    let lastIndex = index;
    while (
      lastIndex + 1 < matches.length
      && String(value || "").slice(Number(matches[lastIndex].index) + matches[lastIndex][0].length, Number(matches[lastIndex + 1].index)).trim() === ""
    ) {
      lastIndex += 1;
    }
    const images = matches.slice(index, lastIndex + 1);
    output += escapeHtml(String(value || "").slice(cursor, Number(first.index))).replaceAll("\n", "<br>");
    output += `<div class="record-image-grid count-${Math.min(images.length, 9)}">${images.map((match) => `<img decoding="async" class="record-image" src="${escapeHtml(match[2])}" alt="${escapeHtml(match[1] || "记录图片")}" loading="lazy" />`).join("")}</div>`;
    const last = images.at(-1);
    cursor = Number(last.index) + last[0].length;
    index = lastIndex;
  }
  return `${output}${escapeHtml(String(value || "").slice(cursor)).replaceAll("\n", "<br>")}`;
}

function timelineEvent(event) {
  const parts = eventRecordParts(event);
  const themes = parts.themes;
  const title = parts.title;
  const editableContent = parts.content;
  const content = renderRecordContent(event, parts);
  return `
    <article class="timeline-event record-event" style="--record-theme:${escapeHtml(themes[0]?.color || "#7c8790")}">
      <time class="event-time">${formatTime(event.created_at)}</time>
      <div class="event-content">
        <div class="event-heading"><span class="record-theme-chips">${themes.map((theme) => `<span class="record-theme-chip" style="--record-theme:${escapeHtml(theme.color)}">${escapeHtml(theme.name)}</span>`).join("")}</span>${title ? `<strong>${escapeHtml(title)}</strong>` : ""}</div>
        ${content}
      </div>
      <div class="event-actions">
        <button class="edit-event" data-event-id="${event.id}" data-event-theme="${escapeHtml(themes[0]?.id || "other")}" data-event-themes="${escapeHtml(themes.map((theme) => theme.id).join(","))}" data-event-anime="${event.anime_id || ""}" data-event-title="${escapeHtml(title)}" data-event-episodes="${escapeHtml(parts.episodeText)}" data-event-content="${escapeHtml(editableContent)}" data-event-raw="${escapeHtml(event.raw_directives || "")}" title="修改记录">编辑</button>
        <button class="delete-event" data-event-id="${event.id}" title="删除记录" aria-label="删除记录">×</button>
      </div>
    </article>
  `;
}

let timelineRequest = 0;
let timelineAbort = null;
let timelineOffset = 0;
let timelineLoading = false;
let timelineHasMore = false;
let timelineObserver = null;

async function renderTimeline(append = false) {
  if (append && (timelineLoading || !timelineHasMore || state.activeView !== "timeline")) return;
  if (!append) {
    timelineAbort?.abort();
    timelineObserver?.disconnect();
    timelineOffset = 0;
    timelineHasMore = false;
    $("#timeline").innerHTML = "";
    $("#timelineEmpty").classList.add("hidden");
  }
  const request = ++timelineRequest;
  timelineAbort = new AbortController();
  timelineLoading = true;
  try {
    const query = new URLSearchParams({limit: "30", offset: String(timelineOffset), q: state.timelineSearch});
    for (const theme of state.timelineThemes) query.append("theme", theme);
    const result = await api(`/api/timeline?${query}`, {signal: timelineAbort.signal});
    if (request !== timelineRequest) return;
    if (Array.isArray(result.available_themes)) {
      const hadSelection = state.timelineThemes.size > 0;
      timelineAvailableThemes = new Set(result.available_themes);
      renderTimelineThemeFilter();
      // Deleting the final record of a selected theme restores the full list.
      if (hadSelection && !state.timelineThemes.size) return renderTimeline();
    }
    const days = result.days;
    timelineOffset = result.next_offset;
    timelineHasMore = result.has_more;
    $("#timelineMore")?.remove();
    const html = days
      .map((day) => {
        const date = formatDate(day.date);
        const summaries = [];
        if (day.episode_total) summaries.push(`看了 ${day.episode_total} 集`);
        if (day.anime_total) summaries.push(`涉及 ${day.anime_total} 部番`);
        if (!summaries.length) summaries.push("写下了一些想法");
        return `
          <section class="timeline-day">
            <div class="day-label">
              <strong>${date.main}</strong>
              <span>${date.sub}</span>
            </div>
            <div class="day-content">
              <div class="day-summary">${summaries.join(" · ")}</div>
              <div class="day-events">${day.events.map(timelineEvent).join("")}</div>
            </div>
          </section>
        `;
      })
      .join("");
    $("#timeline").insertAdjacentHTML("beforeend", html);
    const empty = timelineOffset === 0;
    $("#timeline").classList.toggle("hidden", empty);
    $("#timelineEmpty").classList.toggle("hidden", !empty);
    if (timelineHasMore) {
      $("#timeline").insertAdjacentHTML("beforeend", '<button id="timelineMore" class="secondary-button">加载更多记录</button>');
      $("#timelineMore").onclick = () => renderTimeline(true);
      if ("IntersectionObserver" in window) {
        timelineObserver?.disconnect();
        timelineObserver = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) renderTimeline(true);
        }, {rootMargin: "250px"});
        timelineObserver.observe($("#timelineMore"));
      }
    }
    $$(".delete-event:not([data-bound])", $("#timeline")).forEach((button) => {
      button.dataset.bound = "true";
      button.addEventListener("click", async () => {
        if (!confirm("删除这条时间线记录？观看进度不会因此回退。")) return;
        try {
          await api(`/api/events/${button.dataset.eventId}`, { method: "DELETE" });
          await renderTimeline();
          await refreshStatus();
        } catch (error) {
          toast(error.message, "error");
        }
      });
    });
    $$(".edit-event:not([data-bound])", $("#timeline")).forEach((button) => {
      button.dataset.bound = "true";
      button.addEventListener("click", () => {
        const card = button.closest(".timeline-event");
        if (card.querySelector(".inline-event-editor")) return;
        const themeNames = (button.dataset.eventThemes || button.dataset.eventTheme || "other")
          .split(",")
          .map((id) => eventTheme({ theme: id }).name);
        const content = button.dataset.eventRaw || recordTextFormat({ themes: themeNames, anime: button.dataset.eventTitle || "", episodes: button.dataset.eventEpisodes || "", content: button.dataset.eventContent || "" });
        const editor = document.createElement("form");
        editor.className = "inline-event-editor";
        editor.innerHTML = `<textarea rows="3" required></textarea><div><label class="secondary-button compact-button note-image-button">批量插入图片<input type="file" accept="image/png,image/jpeg,image/webp" multiple data-edit-image-input /></label><button type="button" class="text-button" data-cancel-edit>取消</button><button type="submit" class="primary-button compact-button">保存修改</button></div>`;
        $("textarea", editor).value = content;
        $(".event-content", card).append(editor);
        button.classList.add("hidden");
        $("[data-cancel-edit]", editor).addEventListener("click", () => { editor.remove(); button.classList.remove("hidden"); });
        $("[data-edit-image-input]", editor).addEventListener("change", (event) => {
          insertRecordImages(event.target, $("textarea", editor));
        });
        editor.addEventListener("submit", async (event) => {
          event.preventDefault();
          try {
            await api(`/api/events/${button.dataset.eventId}`, {
              method: "PATCH",
              body: JSON.stringify(parseRecordText($("textarea", editor).value)),
            });
            await renderTimeline();
          } catch (error) { toast(error.message, "error"); }
        });
      });
    });
  } catch (error) {
    if (request === timelineRequest && error.name !== "AbortError") toast(error.message, "error");
  } finally {
    if (request === timelineRequest) timelineLoading = false;
  }
}

function switchView(view) {
  if (view !== "schedule") stopSchedulePolling();
  if (view !== "timeline") {
    timelineAbort?.abort();
    timelineObserver?.disconnect();
    timelineRequest += 1;
    timelineLoading = false;
    $("#timeline").innerHTML = "";
  }
  state.activeView = view;
  $$(".view").forEach((item) => item.classList.remove("active"));
  $$(".nav-item[data-view]").forEach((item) => item.classList.remove("active"));
  $(`#${view}View`).classList.add("active");
  $(`.nav-item[data-view="${view}"]`).classList.add("active");
  $$("[data-floating-view]").forEach(control => control.classList.toggle("hidden", control.dataset.floatingView !== view));
  if (view !== "collection" && $("#collectionFloatingPanel").open) {
    $("#collectionFloatingPanel").close();
  }
  if (view === "timeline") renderTimeline();
  if (view === "statistics") {
    state.statisticsType = statisticsDefaultTheme();
    renderStatistics();
  }
  if (view === "ranking") renderRanking();
  if (view === "schedule") loadSchedule();
}

