"""Outbound connections for desktop playback. Resolve and pin public addresses."""
from __future__ import annotations

import ipaddress
import select
import socket
import threading
from contextlib import contextmanager
from http.client import HTTPConnection, HTTPSConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, urljoin, urlsplit

from .http_support import RequestProblem

TIMEOUT = 8


def public_url(value):
    try:
        url = urlsplit(value)
        if (url.scheme in {"https", "http"} and url.hostname and
                url.username is None and url.password is None and
                not any(ord(char) < 33 or char == "\\" for char in value)):
            return url, url.port or (443 if url.scheme == "https" else 80)
    except ValueError:
        pass
    raise RequestProblem("片源返回了无效的网址", 502)


def connect_public(host, port, timeout=TIMEOUT):
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    for family, kind, protocol, _, address in addresses:
        ip = ipaddress.ip_address(address[0].split("%", 1)[0])
        ip = getattr(ip, "ipv4_mapped", None) or ip
        if not ip.is_global or ip.is_multicast:
            raise RequestProblem("片源不能访问本机或内网地址", 502)
    last_error = OSError("No public address")
    for family, kind, protocol, _, address in addresses:
        sock = socket.socket(family, kind, protocol)
        try:
            sock.settimeout(timeout)
            sock.connect(address)
            return sock
        except OSError as error:
            last_error = error
            sock.close()
    raise last_error


@contextmanager
def request_public(value, *, method="GET", headers=None, body=None, follow=True):
    headers = dict(headers or {})
    for _ in range(6):
        url, port = public_url(value)
        cls = HTTPSConnection if url.scheme == "https" else HTTPConnection
        conn = cls(url.hostname, port, timeout=TIMEOUT)
        conn._create_connection = lambda address, timeout, source: connect_public(*address, timeout)
        try:
            path = quote(url.path or "/", safe="/%:@!$&'()*+,;=-._~")
            if url.query:
                path += "?" + quote(url.query, safe="/?%:@!$&'()*+,;=-._~")
            conn.request(method, path, body=body, headers=headers)
            response = conn.getresponse()
            location = response.getheader("Location")
            if not follow or response.status not in {301, 302, 303, 307, 308} or not location:
                yield response, value
                return
            destination = urljoin(value, location)
            new_url, _ = public_url(destination)
            if new_url.netloc != url.netloc or new_url.scheme != url.scheme:
                headers = {key: val for key, val in headers.items()
                           if key.lower() in {"accept", "accept-encoding", "user-agent", "range", "referer", "origin"}}
                if body is not None:
                    raise RequestProblem("片源接口跳转到了另一个站点", 502)
            if response.status == 303 or (response.status in {301, 302} and method == "POST"):
                method, body = "GET", None
            value = destination
        finally:
            conn.close()
    raise RequestProblem("片源网址跳转次数过多", 502)


class BrowserProxy(BaseHTTPRequestHandler):
    """Isolated Chromium sends HTTPS tunnels and HTTP requests through here."""
    def log_message(self, *_):
        pass

    def setup(self):
        self.request.settimeout(TIMEOUT)
        super().setup()

    def do_CONNECT(self):
        try:
            target, port = public_url("https://" + self.path)
            with connect_public(target.hostname, port) as upstream:
                self.send_response_only(200)
                self.end_headers()
                peers = {self.connection: upstream, upstream: self.connection}
                while True:
                    ready, _, _ = select.select(list(peers), [], [], TIMEOUT)
                    if not ready:
                        break
                    for sock in ready:
                        data = sock.recv(65536)
                        if not data:
                            return
                        peers[sock].sendall(data)
        except (OSError, RequestProblem):
            return

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def forward(self):
        excluded = {"host", "connection", "proxy-connection", "proxy-authorization",
                    "transfer-encoding", "content-length"}
        try:
            size = int(self.headers.get("Content-Length", 0))
            if not 0 <= size <= 2_000_000 or self.headers.get("Transfer-Encoding"):
                return self.send_error(400)
            headers = {key: value for key, value in self.headers.items() if key.lower() not in excluded}
            body = self.rfile.read(size) if self.command == "POST" else None
            with request_public(self.path, method=self.command, headers=headers, body=body, follow=False) as (response, _):
                self.send_response_only(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in excluded:
                        self.send_header(key, value)
                self.send_header("Connection", "close")
                self.end_headers()
                while chunk := response.read(65536):
                    self.wfile.write(chunk)
        except (OSError, ValueError):
            return


@contextmanager
def browser_proxy():
    with ThreadingHTTPServer(("127.0.0.1", 0), BrowserProxy) as server:
        worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        worker.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            worker.join()
