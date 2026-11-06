// 批量导入：给没有 Kazumi 收藏的人用。上传或粘贴一份番剧名单，
// 逐条调用 Bangumi 搜索，确认收藏状态后自动跳到下一条。
const IMPORT_HEADER_WORDS = new Set(["name", "title", "name_cn", "番剧", "番名", "番剧名", "名称", "标题", "动画", "动画名", "动画名称", "作品", "作品名", "anime", "subject"]);
const IMPORT_JSON_KEYS = ["name", "title", "name_cn", "番剧", "名称", "标题", "番名", "anime", "subject"];
const IMPORT_LIMIT = 2000;
const importState = { names: [], index: 0, added: new Set(), skipped: new Set(), cache: new Map(), token: 0 };
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
  return text
    .split(/\r?\n/)
    .map((line) => line.split(/\t|,|;|，/)[0])
    .map(importCleanName)
    .filter((name) => name && !IMPORT_HEADER_WORDS.has(name.toLowerCase()));
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
  const closeModal = () => {
    modal.close();
    importState.token++;
  };
  $("#collectionImportButton").onclick = () => {
    $("#collectionSearchModal").close();
    $("#importSetup").classList.remove("hidden");
    $("#importWork").classList.add("hidden");
    $("#importPaste").value = "";
    $("#importFile").value = "";
    importRowsAreVerbatim = false;
    importSetStatus("");
    modal.showModal();
  };
  $("#collectionImportClose").onclick = closeModal;
  modal.addEventListener("close", () => {
    importState.token++;
  });
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
