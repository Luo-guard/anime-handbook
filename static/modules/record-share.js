{
  const dialog = $("#recordShareDialog");
  const text = $("#recordShareText");
  const status = $("#recordShareStatus");
  const images = $("#recordShareImages");
  const copyButton = $("#recordShareCopy");

  function showRecordShare({ title, episodes, content }) {
    const attachments = recordImageMatches(content);
    const heading = [title ? `《${title}》` : "", episodes].filter(Boolean).join(" ");
    text.value = [heading, recordTextWithoutImages(content, attachments)].filter(Boolean).join("\n\n");
    if (!text.value && !attachments.length) {
      toast("请先写一点内容或插入图片");
      return;
    }
    $("#recordShareAttachments").hidden = !attachments.length;
    images.replaceChildren(...attachments.map(([, name, url], index) => {
      const link = document.createElement("a");
      link.href = url;
      const image = document.createElement("img");
      image.src = url;
      image.alt = name || `配图 ${index + 1}`;
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      if (url.startsWith("/api/")) {
        const extension = /\.(png|jpg|webp)$/.exec(url)?.[1] || "jpg";
        link.download = `手账配图-${index + 1}.${extension}`;
        link.append(image, `保存图片 ${index + 1}`);
      } else {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.append(image, `打开原图 ${index + 1}`);
      }
      return link;
    }));
    status.textContent = "";
    copyButton.disabled = !text.value.trim();
    dialog.showModal();
  }

  async function copyRecordShareText() {
    const value = text.value.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      if (dialog.open && text.value.trim() === value) status.textContent = "正文已复制";
    } catch {
      if (!dialog.open || text.value.trim() !== value) return;
      text.focus();
      text.select();
      status.textContent = "浏览器未能复制，正文已选中，可按 Ctrl+C 手动复制。";
    }
  }

  $("#shareNoteButton").addEventListener("click", () => {
    const draft = parseRecordDirectives($("#noteContent").value);
    const anime = state.animes.find(item => String(item.id) === $("#noteAnime").value);
    const title = draft.animeName || (!newRecordDefaultsToOther() ? anime?.display_name : "");
    showRecordShare({ title, episodes: draft.episodeText, content: draft.content });
  });
  $("#timeline").addEventListener("click", event => {
    const button = event.target.closest(".share-event");
    if (!button) return;
    const { eventTitle, eventEpisodes, eventContent } = button.closest(".event-actions").querySelector(".edit-event").dataset;
    showRecordShare({ title: eventTitle, episodes: eventEpisodes, content: eventContent });
  });
  text.addEventListener("input", () => {
    status.textContent = "";
    copyButton.disabled = !text.value.trim();
  });
  copyButton.addEventListener("click", copyRecordShareText);
  $("#recordShareTargets").addEventListener("click", event => {
    if (event.target.closest("a")) copyRecordShareText();
  });
  dialog.addEventListener("close", () => {
    text.value = "";
    images.replaceChildren();
    status.textContent = "";
  });
}
