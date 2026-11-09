"""
The Slither analyzer service

POST /analyze  runs analyze.py on the request, in a child process with a
               time limit, one analysis at a time.
GET  /healthz  200 when the service is up.

Deployed to Cloud Run as its own private service: only the API's service
account may call it (roles/run.invoker), so it has no login of its own.
Standard library only: the analysis's own dependencies are Slither's.
"""
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8080"))
MAX_BODY = int(os.environ.get("ANALYZER_MAX_BODY", str(25 * 1024 * 1024)))
TIMEOUT_S = int(os.environ.get("ANALYZER_TIMEOUT_S", "270"))  # under Cloud Run's 300s request timeout
ANALYZE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "analyze.py")

# Cloud Run sends one request at a time (--concurrency=1); this keeps it so
# when the server is run anywhere else.
one_at_a_time = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802 — http.server's naming
        if self.path == "/healthz":
            return self._send(200, {"ok": True})
        return self._send(404, {"error": "not_found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/analyze":
            return self._send(404, {"error": "not_found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._send(413, {"error": "too_large", "detail": f"The request must be 1 to {MAX_BODY} bytes."})
        body = self.rfile.read(length)
        with one_at_a_time:
            try:
                run = subprocess.run([sys.executable, ANALYZE], input=body, capture_output=True, timeout=TIMEOUT_S)
            except subprocess.TimeoutExpired:
                return self._send(504, {"error": "timeout", "detail": f"The analysis took longer than {TIMEOUT_S}s and was stopped."})
        try:
            result = json.loads(run.stdout.decode() or "null")
        except ValueError:
            result = None
        if not isinstance(result, dict):
            tail = run.stderr.decode(errors="replace")[-2000:]
            return self._send(500, {"error": "analysis_failed", "detail": tail})
        if result.get("error"):
            status = 400 if result["error"] in ("bad_request", "unsupported_path") else 422
            return self._send(status, result)
        return self._send(200, result)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.command, fmt % args))


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
