// Search history stays on this device and is isolated by handbook profile.
(() => {
  const form = document.querySelector('#collectionSearchForm');
  const section = document.querySelector('#collectionSearchHistory');
  if (!form || !section) return;
  const query = document.querySelector('#collectionSearchQuery');
  const list = document.querySelector('#collectionHistoryList');
  const manage = document.querySelector('#collectionHistoryManage');
  const clear = document.querySelector('#collectionHistoryClear');
  const pause = document.querySelector('#collectionHistoryPause');
  const expand = document.querySelector('#collectionHistoryExpand');
  const status = document.querySelector('#collectionHistoryStatus');
  const prefix = 'handbook:collection-search-history:';
  const cache = new Map();
  const normalize = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
  const identity = value => normalize(value).toLocaleLowerCase();
  const key = () => prefix + (state.active_profile?.id || 'default');
  let editing = false, expanded = false, currentKey = null;

  function read() {
    const storageKey = key();
    if (!cache.has(storageKey)) {
      let saved;
      try { saved = JSON.parse(localStorage.getItem(storageKey)); } catch (_) { /* unavailable or corrupt storage */ }
      const seen = new Set();
      const items = (Array.isArray(saved?.items) ? saved.items : []).map(normalize).filter(value => {
        const id = identity(value);
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      }).slice(0, 20);
      cache.set(storageKey, {enabled: saved?.enabled !== false, items});
    }
    return cache.get(storageKey);
  }
  function save() {
    try { localStorage.setItem(key(), JSON.stringify(read())); }
    catch (_) { /* retain working session history when browser storage is unavailable */ }
    render();
  }
  function render() {
    if (currentKey !== key()) {
      currentKey = key();
      editing = false;
      expanded = false;
    }
    const history = read();
    section.hidden = false;
    manage.disabled = clear.disabled = history.items.length === 0;
    if (!history.items.length) editing = false;
    manage.textContent = editing ? '完成' : '管理';
    manage.setAttribute('aria-pressed', String(editing));
    pause.textContent = history.enabled ? '暂停记录' : '恢复记录';
    pause.setAttribute('aria-pressed', String(!history.enabled));
    status.textContent = !history.enabled ? '已暂停记录' : !history.items.length ? '暂无记录' : '';
    list.replaceChildren();
    const shown = expanded || editing ? history.items : history.items.slice(0, 6);
    shown.forEach(value => {
      const chip = document.createElement('span');
      chip.className = 'collect-history-chip';
      const search = document.createElement('button');
      search.type = 'button';
      search.className = 'collect-history-query';
      search.textContent = value;
      search.title = value;
      search.setAttribute('aria-label', `重新搜索：${value}`);
      search.onclick = () => {
        query.value = value;
        query.focus();
        form.requestSubmit();
      };
      chip.append(search);
      if (editing) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'collect-history-remove';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `删除搜索历史：${value}`);
        remove.onclick = () => {
          const index = history.items.indexOf(value);
          history.items = history.items.filter(item => item !== value);
          save();
          const buttons = list.querySelectorAll('.collect-history-remove');
          (buttons[Math.min(index, buttons.length - 1)] || pause).focus();
        };
        chip.append(remove);
      }
      list.append(chip);
    });
    expand.hidden = history.items.length <= 6 || editing;
    expand.textContent = expanded ? '收起' : `展开全部（${history.items.length}）`;
    expand.setAttribute('aria-expanded', String(expanded));
  }
  form.addEventListener('submit', () => {
    const value = normalize(query.value);
    const history = read();
    if (!value || !history.enabled) return;
    history.items = [value, ...history.items.filter(item => identity(item) !== identity(value))].slice(0, 20);
    save();
  });
  manage.onclick = () => { editing = !editing; render(); };
  expand.onclick = () => { expanded = !expanded; render(); };
  clear.onclick = () => {
    if (!read().items.length || !window.confirm('清空当前档案在这台设备上的全部搜索历史？')) return;
    read().items = [];
    expanded = editing = false;
    save();
    query.focus();
  };
  pause.onclick = () => { read().enabled = !read().enabled; save(); };
  document.querySelector('#collectionSearchButton')?.addEventListener('click', render);
  // Reload on dialog opening, including openings initiated outside the toolbar.
  new MutationObserver(() => {
    if (document.querySelector('#collectionSearchModal').open) render();
  }).observe(document.querySelector('#collectionSearchModal'), {attributes: true, attributeFilter: ['open']});
  window.addEventListener('storage', event => {
    if (event.key === null || event.key === key()) {
      cache.delete(key());
      render();
    }
  });
})();
