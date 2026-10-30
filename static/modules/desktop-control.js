// Desktop lifecycle UI is separate from shared business pages and online sessions.
let desktopShutdownPending = false;

async function shutdownHandbookBackend() {
  if (window.handbookOnline || desktopShutdownPending) return;
  if (pendingDesktopWrites > 0) return toast('正在保存数据，请保存完成后再关闭后台', 'error');
  if (!confirm('确定关闭动漫手账后台？尚未保存的内容不会自动保存。\n关闭后，需要通过“启动动漫手账”快捷方式重新打开。')) return;
  const buttons = $$('[data-desktop-shutdown]');
  buttons.forEach(button => button.disabled = true);
  try {
    const health = await api('/api/health');
    if (!health.features?.desktop_shutdown || !health.shutdown_token) throw Error('当前旧后台还不支持关闭按钮，请先手动关闭并重新启动手账；之后即可使用此按钮。');
    const result = await api('/api/desktop/shutdown', {method: 'POST', headers: {'X-Handbook-Shutdown': health.shutdown_token}, body: '{}'});
    if (!result.shutting_down) throw Error('后台未确认关闭，请稍后重试');
    desktopShutdownPending = true;
    clearInterval(state.statusTimer);
    stopSchedulePolling();
    timelineAbort?.abort();
    timelineObserver?.disconnect();
    $$('dialog[open]').forEach(dialog => dialog.close());
    $('#backendClosedTitle').textContent = '正在关闭后台…';
    $('#backendClosedMessage').textContent = '正在完成剩余任务，请稍候。';
    $('#backendClosedDialog').showModal();
    // A successful shutdown reply means accepted, not yet fully stopped.
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 350));
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1000);
      try {
        await fetch('/api/health', {cache:'no-store', signal:controller.signal});
      } catch {
        $('#backendClosedTitle').textContent = '后台已关闭';
        $('#backendClosedMessage').textContent = '再次使用时，请运行“启动动漫手账”快捷方式，然后刷新此页面。';
        return;
      } finally { clearTimeout(timer); }
    }
    $('#backendClosedMessage').textContent = '已请求关闭，后台正在等待剩余任务结束；请稍候再重新启动。';
  } catch (error) {
    toast(error.message, 'error');
    buttons.forEach(button => button.disabled = false);
  }
}

$$('[data-desktop-shutdown]').forEach(button => button.addEventListener('click', shutdownHandbookBackend));
$('#backendClosedDialog').addEventListener('cancel', event => event.preventDefault());
