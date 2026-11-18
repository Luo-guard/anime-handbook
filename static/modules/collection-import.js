// 批量导入：给没有 Kazumi 收藏的人用。上传或粘贴一份番剧名单，
// 逐条调用 Bangumi 搜索，确认收藏状态后自动跳到下一条。
const IMPORT_HEADER_WORDS = new Set(["name", "title", "name_cn", "番剧", "番名", "番剧名", "名称", "标题", "动画", "动画名", "动画名称", "作品", "作品名", "anime", "subject"]);
const IMPORT_JSON_KEYS = ["name", "title", "name_cn", "番剧", "名称", "标题", "番名", "anime", "subject"];
const IMPORT_LIMIT = 2000;
let importState = null;
let importToken = 0;
let importFilter = "all";
const importOrigins = new WeakMap();
const importStorageKey = () => `handbook:collection-import:${state.active_profile?.id || "default"}`;

function importLoadBatch(key) {
  if (importState?.key === key) return importState;
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (!Array.isArray(saved?.names) || !saved.names.length || saved.names.length > IMPORT_LIMIT
        || saved.names.some(name => typeof name !== "string" || !name.trim())) return null;
    const valid = values => (Array.isArray(values) ? values : [])
      .filter(index => Number.isInteger(index) && index >= 0 && index < saved.names.length);
    const added = new Set(valid(saved.added));
    const skipped = new Set(valid(saved.skipped).filter(index => !added.has(index)));
    const index = valid([saved.index])[0] ?? 0;
    return {key, names:saved.names, index, added, skipped, cache:new Map()};
  } catch { return null; }
}

function importSaveBatch(batch = importState) {
  const {key, names, index, added, skipped} = batch;
  try { localStorage.setItem(key, JSON.stringify({names, index, added:[...added], skipped:[...skipped]})); }
  catch { /* Keep the current batch usable when browser storage is unavailable. */ }
}

function importVisibleIndices(filter = importFilter) {
  return (importState?.names || []).map((_, index) => index).filter(index =>
    filter === "all" || (filter === "skipped" ? importState.skipped.has(index)
      : !importState.added.has(index) && !importState.skipped.has(index)));
}

function importBatchSummary() {
  const {names, added, skipped} = importState;
  return `已添加 ${added.size} 条 · 已跳过 ${skipped.size} 条 · 未处理 ${names.length - added.size - skipped.size} 条 · 共 ${names.length} 条`;
}
// Excel 读出来的一行就是一整条番名，不能再按逗号切（「就算是哥哥，有爱就没问题了，对吧」）。
let importRowsAreVerbatim = false;

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
function importFromRows(text) {
  return text
    .split(/\r?\n/)
    .map(importCleanName)
    .filter((name) => name && !IMPORT_HEADER_WORDS.has(name.toLowerCase()));
}
function importFromLines(text) {
  const names = [];
  // Scan every field to find the next record, including newlines inside quoted fields.
  const field = / *(?:"((?:[^"]|"")*)" *(?=[\t,;，\r\n]|$)|([^\t,;，\r\n]*))/y;
  let firstColumn = true;
  while (field.lastIndex < text.length) {
    const [, quoted, unquoted] = field.exec(text);
    if (firstColumn) {
      const name = importCleanName(quoted === undefined ? unquoted : quoted.replace(/""/g, '"'));
      if (name && !IMPORT_HEADER_WORDS.has(name.toLowerCase())) names.push(name);
    }
    const delimiter = text[field.lastIndex];
    firstColumn = delimiter === "\r" || delimiter === "\n";
    field.lastIndex += delimiter === "\r" && text[field.lastIndex + 1] === "\n" ? 2 : 1;
  }
  return names;
}
function parseImportText(text, { verbatim = false } = {}) {
  const raw = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!raw) return [];
  let names = [];
  if (verbatim) {
    names = importFromRows(raw);
  } else if (raw.startsWith("[") || raw.startsWith("{")) {
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
  const indices = importVisibleIndices();
  const position = indices.indexOf(importState.index);
  $("#importCount").textContent = `${position + 1} / ${indices.length}`;
  $("#importProgress").textContent = importBatchSummary();
  $("#importPrev").disabled = position <= 0;
  $("#importNext").disabled = position < 0 || position >= indices.length - 1;
  $("#importSkip").disabled = position < 0 || importState.added.has(importState.index) || importState.skipped.has(importState.index);
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
  box.querySelectorAll(".collect-control").forEach(control => {
    importOrigins.set(control, {batch:importState, index:importState.index});
  });
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
    if (token !== importToken) return null;
    rows = strict.items || [];
  } catch (error) {
    if (token !== importToken) return null;
    throw error;
  }
  if (rows.length) {
    return {rows, strict:true};
  }
  const loose = await api(`/api/collection-search?q=${encodeURIComponent(name)}&sort=match`);
  if (token !== importToken) return null;
  return {rows:loose.items || [], strict:false};
}
async function importSearchCurrent() {
  const token = ++importToken;
  const name = importCleanName($("#importName").value) || importState.names[importState.index] || "";
  if (!name) return;
  importState.names[importState.index] = name;
  importSaveBatch();
  const cached = importState.cache.get(name);
  if (cached) {
    importSearchedLabel(name, cached.strict);
    importRenderResults(cached.rows);
    importProgress();
    return;
  }
  const box = $("#importResults");
  box.innerHTML = collectionSearchSkeleton();
  $("#importSearched").textContent = "";
  box.setAttribute("aria-busy", "true");
  try {
    const result = await importSearchByName(name, token);
    if (token !== importToken || !result) return;
    importState.cache.set(name, result);
    importSearchedLabel(name, result.strict);
    importRenderResults(result.rows);
  } catch (error) {
    if (token !== importToken) return;
    box.removeAttribute("aria-busy");
    box.innerHTML = `<div class="collect-search-empty">${COLLECT_SEARCH_ICON}<strong>搜索没有完成</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
  importProgress();
}
function importGoTo(index) {
  const empty = index == null;
  $("#importSearchForm").classList.toggle("hidden", empty);
  if (!empty) importState.index = index;
  importProgress();
  if (empty) {
    ++importToken;
    $("#importSearched").textContent = importFilter === "skipped" ? "没有跳过的条目。" : "没有未处理的条目。";
    $("#importResults").replaceChildren();
    $("#importResults").removeAttribute("aria-busy");
    return;
  }
  $("#importName").value = importState.names[index];
  importSearchCurrent();
}
function importShowWork(filter) {
  importFilter = filter;
  if (filter === "skipped") {
    for (const index of importState.skipped) importState.cache.delete(importState.names[index]);
  }
  $("#importFilter").value = filter;
  $("#importSetup").classList.add("hidden");
  $("#importWork").classList.remove("hidden");
  const indices = importVisibleIndices();
  importGoTo(indices.includes(importState.index) ? importState.index : indices[0]);
}
function importMarkDone(kind, index = importState.index) {
  if (kind === "skipped" && importState.added.has(index)) return;
  importState.skipped.delete(index);
  importState[kind].add(index);
  importSaveBatch();
  if (!$("#collectionImportModal").open || $("#importWork").classList.contains("hidden")) return;
  if (index === importState.index) {
    const indices = importVisibleIndices();
    const next = indices.find(value => value > index && (importFilter !== "all"
      || (!importState.added.has(value) && !importState.skipped.has(value))));
    if (next !== undefined || importFilter !== "all") {
      importGoTo(next ?? indices[0]);
      return;
    }
  }
  importProgress();
}
// —— Excel(.xlsx) 读取 ——
// xlsx 就是一个 zip 包，里面是 xml。这里用浏览器自带的解压能力读，
// 不引入第三方库、不联网，也不占安装包体积。
const XLSX_LIMIT_BYTES = 12 * 1024 * 1024;
let xlsxDecoder = null;

function xlsxText() {
  if (!xlsxDecoder) xlsxDecoder = new TextDecoder("utf-8");
  return xlsxDecoder;
}

// 从文件尾部往前找 zip 的目录结束标记（EOCD）。
function xlsxEocd(view) {
  const floor = Math.max(0, view.byteLength - 66000);
  for (let offset = view.byteLength - 22; offset >= floor; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

async function xlsxInflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 只解出真正需要的两个 xml，不整包展开，几千行的表格也很快。
async function xlsxReadEntries(buffer, wanted) {
  const view = new DataView(buffer);
  const eocd = xlsxEocd(view);
  if (eocd < 0) throw new Error("这个文件不是有效的 Excel");
  const total = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);
  const decoder = xlsxText();
  const files = {};
  for (let index = 0; index < total; index += 1) {
    if (pointer + 46 > view.byteLength || view.getUint32(pointer, true) !== 0x02014b50) break;
    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, pointer + 46, nameLength));
    pointer += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;
    if (view.getUint32(localOffset, true) !== 0x04034b50) continue;
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const raw = new Uint8Array(buffer, start, compressedSize);
    if (method === 0) files[name] = raw;
    else if (method === 8) files[name] = await xlsxInflate(raw);
    else throw new Error("这个 Excel 用了不支持的压缩方式");
  }
  return files;
}

function xlsxParseStrings(xml) {
  if (!xml) return [];
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  // 单元格里的富文本会被拆成多个 <t>，拼回整段。
  return [...doc.getElementsByTagName("si")].map((node) =>
    [...node.getElementsByTagName("t")].map((text) => text.textContent || "").join("")
  );
}

function xlsxCellText(cell, shared) {
  const type = String(cell.getAttribute("t") || "");
  if (type === "inlineStr") {
    return [...cell.getElementsByTagName("t")].map((node) => node.textContent || "").join("");
  }
  const value = cell.getElementsByTagName("v")[0];
  const raw = value ? value.textContent || "" : "";
  if (type === "s") return shared[Number(raw)] ?? "";
  return raw;
}

function xlsxParseNames(xml, shared) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return [...doc.getElementsByTagName("row")].map((row) => {
    const columns = new Map();
    [...row.getElementsByTagName("c")].forEach((cell, index) => {
      const ref = String(cell.getAttribute("r") || "");
      // 有 r="B3" 就按列字母归位，没有就按出现顺序退化成 A、B、C…
      const column = (ref.match(/^[A-Z]+/) || [""])[0] || String.fromCharCode(65 + index);
      columns.set(column, xlsxCellText(cell, shared));
    });
    // 名单基本都在第一列；第一列空时，退回这一行第一个非空单元格。
    const first = columns.get("A");
    if (first && String(first).trim()) return first;
    return [...columns.values()].find((value) => String(value).trim()) || "";
  });
}

async function importReadXlsx(file) {
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > XLSX_LIMIT_BYTES) {
    throw new Error("Excel 超过 12 MB，请先删掉无关的工作表");
  }
  const files = await xlsxReadEntries(
    buffer,
    (name) => name === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(name)
  );
  const sheet = Object.keys(files).find((name) => name.startsWith("xl/worksheets/"));
  if (!sheet) throw new Error("Excel 里没有找到工作表");
  const decoder = xlsxText();
  const shared = xlsxParseStrings(files["xl/sharedStrings.xml"] ? decoder.decode(files["xl/sharedStrings.xml"]) : "");
  return xlsxParseNames(decoder.decode(files[sheet]), shared).map(importCleanName).filter(Boolean);
}

async function importReadFile(file) {
  if (!file) return;
  const name = String(file.name || "").toLowerCase();
  if (/\.xlsx$/.test(name)) {
    if (typeof DecompressionStream !== "function") {
      importSetStatus("当前浏览器版本过低，读不了 Excel；请另存为 CSV，或直接把整列复制到下面的输入框。", true);
      return;
    }
    importSetStatus(`正在读取 ${file.name}…`);
    try {
      const names = await importReadXlsx(file);
      if (!names.length) {
        importSetStatus("这份 Excel 的第一列没读到内容；请把番剧名放在第一列，或另存为 CSV。", true);
        return;
      }
      $("#importPaste").value = names.join("\n");
      importRowsAreVerbatim = true;
      importSetStatus(`已从 ${file.name} 读取 ${names.length} 条${names.length >= IMPORT_LIMIT ? `（单次最多 ${IMPORT_LIMIT} 条，其余已忽略）` : ""}`);
    } catch (error) {
      importSetStatus(`${error.message}；也可以另存为 CSV，或直接把整列复制到下面的输入框。`, true);
    }
    return;
  }
  if (/\.xls$/.test(name)) {
    importSetStatus("旧版 .xls 格式读不了，请在 Excel 里另存为 .xlsx 或 CSV。", true);
    return;
  }
  if (!/\.(csv|tsv|txt|json)$/.test(name)) {
    importSetStatus("只支持 Excel（.xlsx）/ CSV / TSV / TXT / JSON；也可以直接把整列复制到下面的输入框。", true);
    return;
  }
  importSetStatus(`已读取 ${file.name}`);
  const text = await file.text();
  importRowsAreVerbatim = false;
  $("#importPaste").value = text;
}
if ($("#collectionImportButton")) {
  const modal = $("#collectionImportModal");
  const showSetup = () => {
    ++importToken;
    $("#importSetup").classList.remove("hidden");
    $("#importWork").classList.add("hidden");
    $("#importSaved").classList.toggle("hidden", !importState);
    $("#importSavedSummary").textContent = importState ? importBatchSummary() : "";
    $("#importRetrySkipped").disabled = !importState?.skipped.size;
    $("#importParse").textContent = importState ? "开始新批次" : "读取清单";
  };
  $("#collectionImportButton").onclick = () => {
    $("#collectionSearchModal").close();
    importState = importLoadBatch(importStorageKey());
    showSetup();
    $("#importPaste").value = "";
    $("#importFile").value = "";
    importRowsAreVerbatim = false;
    importSetStatus("");
    modal.showModal();
  };
  $("#collectionImportClose").onclick = () => { ++importToken; modal.close(); };
  modal.addEventListener("close", () => {
    if (!modal.open) ++importToken;
  });
  $("#importResume").onclick = () => importShowWork("pending");
  $("#importRetrySkipped").onclick = () => importShowWork("skipped");
  $("#importFile").addEventListener("change", (event) => importReadFile(event.target.files?.[0]));
  // 用户动过文本框就回到通用解析，避免 Excel 的“整行一条”规则套到手动编辑的内容上。
  $("#importPaste").addEventListener("input", () => { importRowsAreVerbatim = false; });
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
    const names = parseImportText($("#importPaste").value, { verbatim: importRowsAreVerbatim });
    if (!names.length) {
      importSetStatus("没有读到番剧名称：请确认每行一个名称，或文件里有 name / title 字段。", true);
      return;
    }
    importSetStatus(`识别到 ${names.length} 条${names.length >= IMPORT_LIMIT ? `（单次最多 ${IMPORT_LIMIT} 条，其余已忽略）` : ""}`);
    importState = { key:importStorageKey(), names, index:0, added:new Set(), skipped:new Set(), cache:new Map() };
    importSaveBatch();
    importShowWork("all");
  };
  $("#importSearchForm").onsubmit = (event) => {
    event.preventDefault();
    importState.cache.delete(importCleanName($("#importName").value));
    importSearchCurrent();
  };
  const step = direction => {
    const indices = importVisibleIndices();
    const next = indices[indices.indexOf(importState.index) + direction];
    if (next !== undefined) importGoTo(next);
  };
  $("#importPrev").onclick = () => step(-1);
  $("#importNext").onclick = () => step(1);
  $("#importFilter").onchange = event => importShowWork(event.target.value);
  $("#importSkip").onclick = () => importMarkDone("skipped");
  $("#importRestart").onclick = showSetup;
  document.addEventListener("collection-status-changed", (event) => {
    const origin = importOrigins.get(event.detail?.source);
    if (origin?.batch === importState && importState?.key === importStorageKey()) importMarkDone("added", origin.index);
  });
}
