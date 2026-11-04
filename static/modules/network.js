let pendingDesktopWrites = 0;

// Own both the fetch and JSON-body deadline. Caller cancellation is preserved;
// timing out never retries a mutation whose result may already be committed.
async function withRequestDeadline(path, options, operation) {
  const controller = new AbortController();
  const upstream = options.signal;
  const abortError = () => { const error = new Error("请求已取消"); error.name = "AbortError"; return error; };
  if (upstream?.aborted) throw abortError();
  const budget = options.timeoutMs ?? (/^\/api\/(?:webdav|sharing)\//.test(path) ? 180000 : /characters/.test(path) ? 120000 : 30000);
  let timer, rejectAbort, timedOut = false;
  const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
  const cancel = () => { controller.abort(); rejectAbort(abortError()); };
  upstream?.addEventListener("abort", cancel, {once:true});
  if (budget > 0) timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    const error = new Error("请求超时，请稍后重试；保存操作请先核对是否已保存");
    error.name = "TimeoutError";
    rejectAbort(error);
  }, budget);
  const {timeoutMs, ...requestOptions} = options;
  try {
    return await Promise.race([operation({...requestOptions, signal:controller.signal}), cancelled]);
  } catch (error) {
    if (timedOut && error.name === "AbortError") {
      const timeout = new Error("请求超时，请稍后重试；保存操作请先核对是否已保存");
      timeout.name = "TimeoutError";
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener("abort", cancel);
  }
}

async function api(path, options = {}) {
  if (window.handbookOnline) return window.handbookOnline.request(path, options);
  if (typeof desktopShutdownPending !== "undefined" && desktopShutdownPending) throw new Error("手账后台已关闭，请重新启动后刷新页面");
  const write = options.method && !["GET", "HEAD"].includes(options.method.toUpperCase());
  if (write) pendingDesktopWrites += 1;
  try {
    return await withRequestDeadline(path, options, async (requestOptions) => {
      let response;
      try {
        response = await fetch(path, {...requestOptions, headers:{"Content-Type":"application/json", ...(requestOptions.headers || {})}});
      } catch (error) {
        if (error.name === "AbortError") throw error;
        throw new Error("无法连接手账后台，请检查后台是否运行；保存结果尚未确认");
      }
      let payload;
      try { payload = await response.json(); }
      catch (error) {
        if (error.name === "AbortError") throw error;
        throw new Error("后台响应不完整，请稍后重试；保存结果尚未确认");
      }
      if (!response.ok) throw new Error(payload.message || `请求失败（${response.status}）`);
      return payload;
    });
  } finally { if (write) pendingDesktopWrites -= 1; }
}
