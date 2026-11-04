"""Exercise local shutdown on an isolated ephemeral server, never the user's backend."""
import http.client
import json
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from handbook.control import DesktopHTTPServer, DesktopRequestHandler
from handbook.http import RequestHandler


class DesktopShutdownTest(unittest.TestCase):
    def setUp(self):
        self.busy = False
        self.server = DesktopHTTPServer(('127.0.0.1', 0), busy=lambda: self.busy)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        if self.thread.is_alive():
            self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def call(self, method, path, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        conn.request(method, path, body='{}' if method=='POST' else None, headers=headers or {})
        response = conn.getresponse()
        status, result = response.status, json.loads(response.read())
        conn.close()
        return status, result

    def test_shutdown_requires_same_origin_and_token(self):
        status, health = self.call('GET', '/api/health')
        self.assertEqual(status, 200)
        self.assertEqual(health['features']['desktop_shutdown'], 1)
        for headers in [{}, {'Origin':'https://other.example','X-Handbook-Shutdown':health['shutdown_token']}, {'Origin':self.origin,'X-Handbook-Shutdown':'invalid'}]:
            self.assertEqual(self.call('POST', '/api/desktop/shutdown', headers)[0], 403)
        self.assertFalse(self.server.stopping)

    def test_busy_backend_rejects_then_gracefully_stops(self):
        _, health = self.call('GET', '/api/health')
        headers = {'Origin':self.origin,'X-Handbook-Shutdown':health['shutdown_token']}
        self.busy = True
        self.assertEqual(self.call('POST', '/api/desktop/shutdown', headers)[0], 409)
        self.assertFalse(self.server.stopping)
        self.busy = False
        status, result = self.call('POST', '/api/desktop/shutdown', headers)
        self.assertEqual(status, 200)
        self.assertTrue(result['shutting_down'])
        self.thread.join(timeout=3)
        self.assertFalse(self.thread.is_alive())
        self.server.server_close()
        with self.assertRaises(OSError):
            self.call('GET', '/api/health')


class WriteGateScopeTest(unittest.TestCase):
    """Network-bound writes must not freeze every other save in the window."""

    def handler(self, path, gate, *, stopping=False):
        handler = object.__new__(DesktopRequestHandler)
        handler.server = SimpleNamespace(write_gate=gate, stopping=stopping)
        handler.path = path
        return handler

    def test_network_writes_do_not_take_the_global_gate(self):
        gate = threading.Lock()
        gate.acquire()
        handler = self.handler('/api/webdav/sync', gate)
        handler.send_error_json = lambda *args, **kwargs: self.fail('unexpected rejection')
        done = []
        try:
            with patch.object(RequestHandler, 'do_POST', return_value='posted'):
                thread = threading.Thread(target=lambda: done.append(handler._write('POST')), daemon=True)
                thread.start()
                thread.join(timeout=2)
        finally:
            gate.release()
        self.assertEqual(done, ['posted'], 'sync must not wait for an occupied write gate')

    def test_ordinary_writes_still_serialise(self):
        gate = threading.Lock()
        gate.acquire()
        handler = self.handler('/api/settings', gate)
        done = []
        try:
            with patch.object(RequestHandler, 'do_POST', return_value='posted'):
                thread = threading.Thread(target=lambda: done.append(handler._write('POST')), daemon=True)
                thread.start()
                thread.join(timeout=0.3)
                self.assertEqual(done, [], 'an ordinary save still waits for the gate')
                gate.release()
                thread.join(timeout=2)
        finally:
            if gate.locked():
                gate.release()
        self.assertEqual(done, ['posted'])

    def test_unlocked_writes_still_notice_a_pending_shutdown(self):
        handler = self.handler('/api/collection-status', threading.Lock(), stopping=True)
        calls = []
        handler.send_error_json = lambda status, message: calls.append((status, message))
        with patch.object(RequestHandler, 'do_POST') as do_post:
            handler._write('POST')
        self.assertEqual(calls, [(503, '后台正在关闭，请稍后重新启动手账')])
        do_post.assert_not_called()
