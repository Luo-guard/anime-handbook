function openDetailWallpaperPicker() {
  const anime = state.progressAnime;
  if (!anime || state.user?.read_only) return;

  const dialog = $("#detailWallpaperPicker");
  const menu = $("#modernDetailMenu");
  const gallery = $("#detailWallpaperGallery");
  const galleryStatus = $("#detailWallpaperGalleryStatus");
  const galleryTitle = $("#detailWallpaperGalleryTitle");
  const preview = $("#detailWallpaperPreview");
  const caption = $("#detailWallpaperPreviewCaption");
  const hint = $("#detailWallpaperHint");
  const settings = $("#detailWallpaperSettings");
  const errorMessage = $("#detailWallpaperError");
  const input = $("#detailWallpaperFile");
  const browse = $("#browseDetailWallpaper");
  const save = $("#saveDetailWallpaper");
  const reset = $("#resetDetailWallpaper");
  const close = $("#closeDetailWallpaper");
  const cancel = $("#cancelDetailWallpaper");
  const controller = new AbortController();
  const { signal } = controller;
  const route = `/api/detail-wallpapers/${encodeURIComponent(anime.id)}`;
  const wallpaperEnabled = state.settings.detail_custom_wallpaper_enabled !== false;
  const canShowWallpaper = wallpaperEnabled && state.settings.detail_layout === "artwork";
  let selected = null;
  let selectionVersion = 0;
  let custom = false;
  let busy = false;

  const showError = (message = "") => {
    errorMessage.textContent = message;
    errorMessage.hidden = !message;
  };
  const showPreview = (url, label) => {
    if (url) preview.src = url;
    else preview.removeAttribute("src");
    preview.hidden = !url;
    caption.textContent = label;
  };
  const updateButtons = () => {
    save.disabled = busy || !selected;
    reset.disabled = busy;
    reset.hidden = !custom;
    browse.disabled = close.disabled = cancel.disabled = settings.disabled = busy;
    gallery.inert = busy;
  };
  const select = (choice, url, tile) => {
    selected = choice;
    for (const option of gallery.querySelectorAll("button")) {
      option.setAttribute("aria-pressed", String(option === tile));
    }
    showPreview(url, "待应用 · 效果预览");
    updateButtons();
  };

  menu.open = false;
  $("#detailWallpaperAnime").textContent = anime.display_name;
  hint.hidden = canShowWallpaper;
  $("#detailWallpaperHintText").textContent = wallpaperEnabled
    ? "选择「番剧图片」背景后显示。"
    : "在「番剧图片」背景下开启「优先使用自定义壁纸」后显示。";
  settings.onclick = () => {
    dialog.close();
    openHandbookSettings("detail", wallpaperEnabled ? 'input[name="detailBackground"][value="artwork"]' : "#detailCustomWallpaperInput");
  };
  showPreview(null, "选一张图预览");
  showError();
  gallery.replaceChildren();
  gallery.hidden = true;
  galleryTitle.textContent = window.handbookOnline ? "选择图片" : "关联图库";
  galleryStatus.textContent = window.handbookOnline ? "支持 JPG、PNG、WebP、AVIF，最大 8 MB。" : "正在读取关联截图…";
  input.value = "";
  updateButtons();
  close.onclick = cancel.onclick = () => dialog.close();
  dialog.oncancel = event => {
    if (busy) event.preventDefault();
  };
  dialog.onclose = () => {
    controller.abort();
    selected = null;
    showPreview(null, "");
    gallery.replaceChildren();
    if ($("#progressModal").open && !$("#settingsModal").open) menu.querySelector("summary").focus();
  };
  browse.onclick = () => input.click();
  input.onchange = async () => {
    const file = input.files[0];
    input.value = "";
    if (!file || busy) return;
    const version = ++selectionVersion;
    showError();
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("请选择不超过 8 MB 的图片");
      const url = await themeFileToDataUrl(file);
      const image = new Image();
      image.src = url;
      await image.decode();
      if (!signal.aborted && version === selectionVersion && !busy) {
        select({ action: "upload", data: url.slice(url.indexOf(",") + 1) }, url);
      }
    } catch (error) {
      if (!signal.aborted && version === selectionVersion) {
        showError(error.name === "EncodingError" ? "无法读取图片，请选择有效的 JPG、PNG、WebP 或 AVIF" : error.message);
      }
    }
  };

  async function apply(choice) {
    if (busy) return;
    busy = true;
    showError();
    updateButtons();
    try {
      const result = await api(route, { method: "POST", body: JSON.stringify(choice) });
      if (result.custom !== (choice.action !== "reset")) throw new Error("壁纸保存结果未确认，请重新打开后查看");
      if (state.progressAnime?.id === anime.id) {
        detailArtworkRevision += 1;
        if (canShowWallpaper) updateDetailArtwork();
      }
      dialog.close();
      toast(result.custom ? (canShowWallpaper ? "已应用自定义壁纸" : "已保存自定义壁纸") : "已恢复自动壁纸");
    } catch (error) {
      showError(error.message);
    } finally {
      busy = false;
      updateButtons();
    }
  }
  save.onclick = () => selected && apply(selected);
  reset.onclick = () => apply({ action: "reset" });
  dialog.showModal();

  api(route, { signal }).then(result => {
    if (signal.aborted) return;
    custom = result.custom;
    if (custom && !selected) showPreview(`${route}?image=1`, "已保存的自定义壁纸");
    updateButtons();
  }).catch(error => {
    if (!signal.aborted && !selected) showError(error.message);
  });
  if (window.handbookOnline) return;

  api(`/api/offline/screenshots?anime_id=${encodeURIComponent(anime.id)}`, { signal }).then(result => {
    if (signal.aborted) return;
    const images = (result.groups || []).flatMap(group => group.images)
      .sort((a, b) => b.mtime - a.mtime);
    gallery.hidden = !images.length;
    galleryStatus.textContent = images.length ? `${images.length} 张关联截图` : "还没有关联截图，可以从电脑选图。";
    const fragment = document.createDocumentFragment();
    for (const image of images) {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.setAttribute("aria-pressed", "false");
      tile.setAttribute("aria-label", image.name);
      tile.title = image.name;
      const thumbnail = document.createElement("img");
      const url = libImageUrl(image.relative);
      thumbnail.src = url;
      thumbnail.alt = "";
      thumbnail.loading = "lazy";
      tile.append(thumbnail);
      tile.onclick = () => {
        selectionVersion += 1;
        showError();
        select({ action: "gallery", relative: image.relative }, url, tile);
      };
      fragment.append(tile);
    }
    gallery.append(fragment);
  }).catch(() => {
    if (!signal.aborted) galleryStatus.textContent = "暂时无法读取关联图库，可以从电脑选图。";
  });
}

$("#openDetailWallpaper").addEventListener("click", openDetailWallpaperPicker);
