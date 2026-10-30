"""Local-only lifecycle controls. Never imported by the online server."""
import secrets
import threading
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse

from .http import RequestHandler


class DesktopRequestHandler(RequestHandler):
    def do_GET(self):
        if urlparse(self.path).path == '/api/health':
            return self.send_json({'ok': True, 'features': {'schedule_sorting': 2, 'keyboard_shortcuts': 1, 'desktop_shutdown': 1}, 'shutdown_token': self.server.shutdown_token})
        return super().do_GET()

    def _write(self, method):
        with self.server.write_gate:
            if self.server.stopping:
                return self.send_error_json(503, '后台正在关闭，请稍后重新启动手账')
            if method == 'POST' and urlparse(self.path).path == '/api/desktop/shutdown':
                host = self.headers.get('Host', '')
                allowed_hosts = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
                token = self.headers.get('X-Handbook-Shutdown', '')
                if host not in allowed_hosts or self.headers.get('Origin') != 'http://' + host or not secrets.compare_digest(token, self.server.shutdown_token):
                    return self.send_error_json(403, '关闭后台的请求校验失败，请刷新页面后重试')
                if self.server.busy():
                    return self.send_error_json(409, '正在同步资料，请等待同步完成后再关闭后台')
                self.server.stopping = True
                try:
                    self.send_json({'ok': True, 'shutting_down': True})
                    self.wfile.flush()
                finally:
                    # shutdown() must run outside the serve_forever thread.
                    threading.Thread(target=self.server.shutdown, name='handbook-shutdown', daemon=True).start()
                return
            return getattr(super(), 'do_' + method)()

    def do_POST(self):
        return self._write('POST')

    def do_PATCH(self):
        return self._write('PATCH')

    def do_DELETE(self):
        return self._write('DELETE')


class DesktopHTTPServer(ThreadingHTTPServer):
    def __init__(self, address, busy=lambda: False):
        if address[0] not in {'127.0.0.1', 'localhost'}:
            raise ValueError('桌面后台仅允许监听本机')
        self.write_gate = threading.Lock()
        self.shutdown_token = secrets.token_urlsafe(32)
        self.stopping = False
        self.busy = busy
        super().__init__(address, DesktopRequestHandler)
