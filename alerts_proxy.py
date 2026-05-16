from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
import json

HOST = "0.0.0.0"
PORT = 8787
TARGET = "https://www.oref.org.il/WarningMessages/alert/alerts.json"


class AlertsProxyHandler(BaseHTTPRequestHandler):
    def _set_headers(self, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if not self.path.startswith("/alerts"):
            self._set_headers(404)
            self.wfile.write(json.dumps({"error": "Not found"}).encode("utf-8"))
            return

        req = Request(
            TARGET,
            headers={
                "Accept": "application/json, text/plain, */*",
                "Referer": "https://www.oref.org.il/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.97 Safari/537.36",
                "X-Requested-With": "XMLHttpRequest"
            }
        )

        try:
            with urlopen(req, timeout=10) as response:
                body = response.read().decode("utf-8", errors="replace").lstrip("\ufeff").strip()
                payload = json.loads(body) if body else {}
                self._set_headers(200)
                self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        except HTTPError as exc:
            self._set_headers(exc.code)
            self.wfile.write(json.dumps({"error": "Upstream request failed"}).encode("utf-8"))
        except (URLError, TimeoutError, json.JSONDecodeError):
            self._set_headers(502)
            self.wfile.write(json.dumps({"error": "Proxy fetch failed"}).encode("utf-8"))


if __name__ == "__main__":
    server = HTTPServer((HOST, PORT), AlertsProxyHandler)
    print(f"Alerts proxy listening on http://{HOST}:{PORT}")
    server.serve_forever()
