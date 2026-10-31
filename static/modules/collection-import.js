// 批量导入：给没有 Kazumi 收藏的人用。上传或粘贴一份番剧名单，
// 逐条调用 Bangumi 搜索，确认收藏状态后自动跳到下一条。
const IMPORT_HEADER_WORDS = new Set(["name", "title", "name_cn", "番剧", "番名", "名称", "标题", "动画", "动画名", "作品", "作品名", "anime", "subject"]);
const IMPORT_JSON_KEYS = ["name", "title", "name_cn", "番剧", "名称", "标题", "番名", "anime", "subject"];
const IMPORT_LIMIT = 2000;
const importState = { names: [], index: 0, added: new Set(), skipped: new Set(), cache: new Map(), token: 0 };

function importCleanName(value) {
  return String(value ?? "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function importFromJson(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : [data];
  return list
    .map((item) => {
      if (typeof item === "string") return importCleanName(item);
      if (!item || typeof item !== "object") return "";
      const key = IMPORT_JSON_KEYS.find((name) => typeof item[name] === "string" && item[name].trim());
      return key ? importCleanName(item[key]) : "";
    })
    .filter(Boolean);
}
function importFromLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(/\t|,|;|，/)[0])
    .map(importCleanName)
    .filter((name) => name && !IMPORT_HEADER_WORDS.has(name.toLowerCase()));
}
function parseImportText(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!raw) return [];
  let names = [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      names = importFromJson(raw);
    } catch {
      names = [];
    }
    if (!names.length) names = importFromLines(raw);
  } else {
    names = importFromLines(raw);
  }
  return [...new Set(names)].slice(0, IMPORT_LIMIT);
}
function importSetStatus(message, isError = false) {
  const node = $("#importStatus");
  node.textContent = message;
  node.classList.toggle("is-error", isError);
}
function importProgress() {
  const name = importState.names[importState.index] || "";
  $("#importCount").textContent = name ? `${importState.index + 1} / ${importState.names.length}` : `0 / ${importState.names.length}`;
  $("#importProgress").textContent = `已添加 ${importState.added.size} 条 · 已跳过 ${importState.skipped.size} 条 · 共 ${importState.names.length} 条`;
  $("#importPrev").disabled = importState.index <= 0;
  $("#importNext").disabled = importState.index >= importState.names.length - 1;
  const done = importState.added.size + importState.skipped.size;
  if (done >= importState.names.length && importState.names.length) $("#importProgress").textContent = `全部处理完成：已添加 ${importState.added.size} 条 · 已跳过 ${importState.skipped.size} 条`;
}
function importRenderResults(rows) {
  const box = $("#importResults");
  box.removeAttribute("aria-busy");
  if (!rows || !rows.length) {
    box.innerHTML = `<div class="collect-search-empty">${COLLECT_SEARCH_ICON}<strong>没有找到这个名称</strong><p>可以改一下名称，或补上季度／原名再搜一次。</p></div>`;
    return;
  }
  box.innerHTML = `<div class="collect-card-grid">${rows.map(collectionSearchCard).join("")}</div>`;
}
function importSearchedLabel(name, strict) {
  const node = $("#importSearched");
  if (!node) return;
  node.textContent = name ? `「${name}」${strict ? "的完整标题匹配" : "的分词结果（没有完整同名条目）"}` : "";
}
async function importSearchByName(name, token) {
  // 先用引号做完整标题匹配（Bangumi 的短语搜索），没有结果再退回分词匹配。
  const quoted = `"${name.replace(/"/g, "")}"`;
  let rows = [];
  try {
    const strict = await api(`/api/collection-search?q=${encodeURIComponent(quoted)}&sort=match`);
    if (token !== importState.token) return null;
    rows = strict.items || [];
  } catch (error) {
    if (token !== importState.token) return null;
    throw error;
  }
  if (rows.length) {
    importSearchedLabel(name, true);
    return rows;
  }
  const loose = await api(`/api/collection-search?q=${encodeURIComponent(name)}&sort=match`);
  if (token !== importState.token) return null;
  importSearchedLabel(name, false);
  return loose.items || [];
}
async function importSearchCurrent() {
  const token = ++importState.token;
  const name = importCleanName($("#importName").value) || importState.names[importState.index] || "";
  if (!name) return;
  importState.names[importState.index] = name;
  const cached = importState.cache.get(name);
  if (cached) {
    importRenderResults(cached);
    importProgress();
    return;
  }
  const box = $("#importResults");
  box.innerHTML = collectionSearchSkeleton();
  box.setAttribute("aria-busy", "true");
  try {
    const rows = await importSearchByName(name, token);
    if (rows === null) return;
    importState.cache.set(name, rows);
    importRenderResults(rows);
  } catch (error) {
    if (token !== importState.token) return;
    box.removeAttribute("aria-busy");
    box.innerHTML = `<div class="collect-search-empty">${COLLECT_SEARCH_ICON}<strong>搜索没有完成</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
  importProgress();
}
function importGoTo(index) {
  if (!importState.names.length) return;
  importState.index = Math.min(importState.names.length - 1, Math.max(0, index));
  $("#importName").value = importState.names[importState.index];
  importProgress();
  importSearchCurrent();
}
function importStart(names) {
  importState.names = names;
  importState.index = 0;
  importState.added = new Set();
  importState.skipped = new Set();
  importState.cache = new Map();
  importState.token = 0;
  $("#importSetup").classList.add("hidden");
  $("#importWork").classList.remove("hidden");
  $("#importName").value = names[0];
  importProgress();
  importSearchCurrent();
}
function importMarkDone(kind) {
  const name = importState.names[importState.index];
  if (!name) return;
  importState.skipped.delete(name);
  importState.added.delete(name);
  (kind === "added" ? importState.added : importState.skipped).add(name);
  importProgress();
  if (importState.index < importState.names.length - 1) importGoTo(importState.index + 1);
}
async function importReadFile(file) {
  if (!file) return;
  const name = String(file.name || "").toLowerCase();
  if (!/\.(csv|tsv|txt|json)$/.test(name)) {
    importSetStatus("只支持 CSV / TSV / TXT / JSON；Excel 表格请另存为 CSV，或直接把整列复制到下面的输入框。", true);
    return;
  }
  importSetStatus(`已读取 ${file.name}`);
  const text = await file.text();
  $("#importPaste").value = text;
}
if ($("#collectionImportButton")) {
  const modal = $("#collectionImportModal");
  const closeModal = () => {
    modal.close();
    importState.token++;
  };
  $("#collectionImportButton").onclick = () => {
    $("#importSetup").classList.remove("hidden");
    $("#importWork").classList.add("hidden");
    $("#importPaste").value = "";
    $("#importFile").value = "";
    importSetStatus("");
    modal.showModal();
  };
  $("#collectionImportClose").onclick = closeModal;
  modal.addEventListener("close", () => {
    importState.token++;
  });
  $("#importFile").addEventListener("change", (event) => importReadFile(event.target.files?.[0]));
  const drop = $("#importDrop");
  ["dragenter", "dragover"].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add("is-over");
  }));
  ["dragleave", "drop"].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.remove("is-over");
  }));
  drop.addEventListener("drop", (event) => importReadFile(event.dataTransfer?.files?.[0]));
  $("#importParse").onclick = () => {
    const names = parseImportText($("#importPaste").value);
    if (!names.length) {
      importSetStatus("没有读到番剧名称：请确认每行一个名称，或文件里有 name / title 字段。", true);
      return;
    }
    importSetStatus(`识别到 ${names.length} 条${names.length >= IMPORT_LIMIT ? `（单次最多 ${IMPORT_LIMIT} 条，其余已忽略）` : ""}`);
    importStart(names);
  };
  $("#importSearchForm").onsubmit = (event) => {
    event.preventDefault();
    importState.cache.delete(importCleanName($("#importName").value));
    importSearchCurrent();
  };
  $("#importPrev").onclick = () => importGoTo(importState.index - 1);
  $("#importNext").onclick = () => importGoTo(importState.index + 1);
  $("#importSkip").onclick = () => importMarkDone("skipped");
  $("#importRestart").onclick = () => {
    $("#importWork").classList.add("hidden");
    $("#importSetup").classList.remove("hidden");
  };
  document.addEventListener("collection-status-changed", (event) => {
    if (!modal.open || $("#importWork").classList.contains("hidden")) return;
    const rows = importState.cache.get(importState.names[importState.index]) || [];
    const hit = rows.some((row) => Number(row.id) === Number(event.detail?.animeId));
    if (!hit) return;
    importMarkDone("added");
  });
}
