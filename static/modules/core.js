const CATEGORIES = [
  { id: 1, name: "在看" },
  { id: 2, name: "想看" },
  { id: 3, name: "搁置" },
  { id: 4, name: "看过" },
  { id: 5, name: "抛弃" },
];

const state = {
  animes: [],
  custom_collections: [],
  ranking_boards: [],
  ranking_templates: [],
  rankingBoard: null,
  rankingDirtyBoards: new Set(),
  settings: {},
  stats: {},
  sync: {},
  webdavSyncRunning: false,
  collectionKind: "builtin",
  category: 1,
  customCollectionId: null,
  search: "",
  seasonFilters: new Set(),
  seasonFilterOpen: false,
  progressAnime: null,
  moveAnime: null,
  pendingEpisodes: new Set(),
  episodeRecordAnnotations: {},
  activeView: "collection",
  statisticsPeriod: "day",
  statisticsType: "all",
  timelineSearch: "",
  timelineThemes: new Set(),
  noteThemes: new Set(["other"]),
  statusTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Remove the retired long-press instruction from tabs that were left open by
// an older cached script before the newest menu is created.
$$('.episode-quick-tip').forEach((element) => element.remove());

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

let toastLayerObserver=null;
function raiseToastLayer() {
  const region=$("#toastRegion");
  if(!region.children.length)return;
  if(typeof region.showPopover === "function") {
    // Native modal dialogs live in the top layer. Reinsert after the most recent
    // dialog so notifications remain clear instead of sitting behind its backdrop.
    if(region.matches(":popover-open"))region.hidePopover();
    region.showPopover();
  } else {
    const dialogs=[...document.querySelectorAll("dialog[open]")];
    (dialogs[dialogs.length-1]||document.body).append(region);
  }
}
function toast(message, type = "normal") {
  const region=$("#toastRegion");
  if(!toastLayerObserver) {
    toastLayerObserver=new MutationObserver(records=>{
      if(records.some(record=>record.target.tagName==="DIALOG"))raiseToastLayer();
    });
    toastLayerObserver.observe(document.body,{subtree:true,attributes:true,attributeFilter:["open"]});
  }
  const item = document.createElement("div");
  item.className = `toast ${type === "error" ? "error" : ""}`;
  item.textContent = message;
  region.append(item);
  raiseToastLayer();
  setTimeout(() => {
    item.remove();
    if(!region.children.length && typeof region.hidePopover === "function" && region.matches(":popover-open"))region.hidePopover();
  }, 4200);
}

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {hour: "2-digit", minute: "2-digit", hour12: false});
function formatTime(iso) { return timeFormatter.format(new Date(iso)); }

function formatDate(dateValue) {
  const date = new Date(`${dateValue}T12:00:00`);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, today)) return { main: "今天", sub: dateValue };
  if (sameDay(date, yesterday)) return { main: "昨天", sub: dateValue };
  return {
    main: `${date.getMonth() + 1}月${date.getDate()}日`,
    sub: `${date.getFullYear()}年`,
  };
}

