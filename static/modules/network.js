let pendingDesktopWrites = 0;
async function api(path, options = {}) {
  if (window.handbookOnline) return window.handbookOnline.request(path, options);
  if (typeof desktopShutdownPending !== "undefined" && desktopShutdownPending) throw new Error("手账后台已关闭，请重新启动后刷新页面");
  const write = options.method && options.method !== "GET";
  if (write) pendingDesktopWrites += 1;
  try {
    const response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || `请求失败（${response.status}）`);
    }
    return payload;
  } finally { if (write) pendingDesktopWrites -= 1; }
}

