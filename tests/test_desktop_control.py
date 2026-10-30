"""Exercise local shutdown on an isolated ephemeral server, never the user's backend."""
import http.client
import json
import threading
import unittest
from handbook.control import DesktopHTTPServer


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
