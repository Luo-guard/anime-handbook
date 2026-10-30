// Shared by the first paint and live settings changes.
(() => {
  // Device-local layout preference: available before the first paint and API load.
  const sidebarStorageKey = "handbook.sidebarCollapsed";
  let sidebarCollapsed = false;
  try { sidebarCollapsed = localStorage.getItem(sidebarStorageKey) === "true"; } catch (_) {}
  document.documentElement.dataset.sidebarCollapsed = String(sidebarCollapsed);
  window.handbookSidebar = {
    set(collapsed) {
      document.documentElement.dataset.sidebarCollapsed = String(Boolean(collapsed));
      try { localStorage.setItem(sidebarStorageKey, String(Boolean(collapsed))); } catch (_) {}
    },
  };

  function apply(settings = {}, accountId = "local") {
    const root = document.documentElement;
    root.dataset.theme = settings.theme_color || "forest";
    ["--green-950", "--green-900", "--green-800", "--green-700", "--green-600", "--green-500", "--green-100", "--green-50", "--theme-rgb", "--active-inset"].forEach(property => root.style.removeProperty(property));
    if (root.dataset.theme === "custom") applyCustomThemeColor(settings.custom_theme_color || "#2e6d4e");
    const enabled = settings.custom_background_enabled === true;
    root.classList.toggle("has-custom-background", enabled);
    if (enabled) root.style.setProperty("--custom-background", `url('/api/background?profile=${encodeURIComponent(settings.active_theme_profile || "default")}&account=${encodeURIComponent(accountId)}&v=${Number(settings.custom_background_version) || 0}')`);
    else root.style.removeProperty("--custom-background");
    root.style.setProperty("--background-overlay-opacity", `${Math.min(100, Math.max(0, Number(settings.custom_background_overlay_opacity ?? 82))) / 100}`);
  }

  function applyCustomThemeColor(hex) {
    const match = String(hex).match(/^#([0-9a-f]{6})$/i);
    if (!match) return;
    const rgb = [0, 2, 4].map((index) => parseInt(match[1].slice(index, index + 2), 16));
    const mix = (target, amount) => rgb.map((value, index) => Math.round(value * (1 - amount) + target[index] * amount));
    const color = (value) => `rgb(${value.join(" ")})`;
    const root = document.documentElement;
    root.style.setProperty("--green-700", color(rgb));
    root.style.setProperty("--green-600", color(mix([255, 255, 255], 0.16)));
    root.style.setProperty("--green-500", color(mix([255, 255, 255], 0.33)));
    root.style.setProperty("--green-800", color(mix([0, 0, 0], 0.18)));
    root.style.setProperty("--green-900", color(mix([0, 0, 0], 0.38)));
    root.style.setProperty("--green-950", color(mix([0, 0, 0], 0.63)));
    root.style.setProperty("--green-100", color(mix([255, 255, 255], 0.82)));
    root.style.setProperty("--green-50", color(mix([255, 255, 255], 0.93)));
    root.style.setProperty("--theme-rgb", rgb.join(", "));
    root.style.setProperty("--active-inset", color(mix([255, 255, 255], 0.58)));
  }

  window.handbookAppearance = { apply };
  const initial = document.getElementById("initialAppearance");
  if (initial) {
    try {
      const appearance = JSON.parse(initial.textContent);
      apply(appearance.settings, appearance.account_id);
    } catch (error) {
      console.warn("初始外观设置无法读取", error);
    }
  }
})();
