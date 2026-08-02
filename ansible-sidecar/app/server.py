"""Bun-agent-shaped HTTP surface for the Ansible sidecar: health, start, stream, cancel.

Deliberately stdlib-only. The routes are few enough that a framework would add
dependency and licence surface without removing meaningful code, which is the same
call the Bun agent made with raw Bun.serve().
"""

from __future__ import annotations

import hmac
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .runs import HostBusyError, RunRegistry

VERSION = "0.1.0"
PORT = int(os.environ.get("ANSIBLE_SIDECAR_PORT", "9095"))
TOKEN = os.environ.get("ANSIBLE_SIDECAR_TOKEN", "")
MAX_BODY_BYTES = 1 << 20
HEARTBEAT_SECONDS = 5.0

_EVENTS_PATH = re.compile(r"^/runs/([A-Za-z0-9_-]{1,64})/events$")
_CANCEL_PATH = re.compile(r"^/runs/([A-Za-z0-9_-]{1,64})/cancel$")
_PLAYBOOK_NAME = re.compile(r"^[A-Za-z0-9_-]+\.ya?ml$")

registry = RunRegistry()


class InvalidRequest(Exception):
    pass


def parse_start_request(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise InvalidRequest("body must be an object")

    run_id = payload.get("runId")
    if not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", run_id):
        raise InvalidRequest("runId must match [A-Za-z0-9_-]{1,64}")

    playbook = payload.get("playbook")
    if not isinstance(playbook, str) or not _PLAYBOOK_NAME.fullmatch(playbook):
        raise InvalidRequest("playbook must be a bare .yml filename")

    hosts = payload.get("hosts")
    if not isinstance(hosts, list) or not hosts or not all(isinstance(h, str) and h for h in hosts):
        raise InvalidRequest("hosts must be a non-empty array of strings")

    extravars = payload.get("extravars", {})
    if not isinstance(extravars, dict):
        raise InvalidRequest("extravars must be an object")

    return {
        "run_id": run_id,
        "playbook": playbook,
        "hosts": hosts,
        "check": bool(payload.get("check", False)),
        "extravars": extravars,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"hlm-ansible-sidecar/{VERSION}"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        print(f"[sidecar] {self.address_string()} {fmt % args}", flush=True)

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        provided = header[7:] if header.startswith("Bearer ") else ""
        return bool(TOKEN) and hmac.compare_digest(provided, TOKEN)

    def _json(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _read_json(self) -> Any:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            raise InvalidRequest("missing or oversized body")
        return json.loads(self.rfile.read(length))

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._json(200, {"status": "healthy", "version": VERSION})
            return
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        match = _EVENTS_PATH.match(self.path)
        if match:
            self._stream_events(match.group(1))
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        if self.path == "/runs":
            self._start_run()
            return
        match = _CANCEL_PATH.match(self.path)
        if match:
            found = registry.cancel(match.group(1))
            self._json(202 if found else 404, {"cancelled": found})
            return
        self._json(404, {"error": "not found"})

    def _start_run(self) -> None:
        try:
            request = parse_start_request(self._read_json())
        except (InvalidRequest, json.JSONDecodeError) as err:
            self._json(400, {"error": str(err)})
            return
        try:
            registry.start(**request)
        except HostBusyError as err:
            self._json(409, {"error": str(err), "hosts": err.hosts})
            return
        except Exception as err:
            self._json(500, {"error": str(err)})
            return
        self._json(202, {"runId": request["run_id"]})

    def _stream_events(self, run_id: str) -> None:
        run = registry.get(run_id)
        if run is None:
            self._json(404, {"error": "unknown run"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        stop = threading.Event()

        def heartbeat() -> None:
            while not stop.wait(HEARTBEAT_SECONDS):
                try:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                except OSError:
                    return

        beat = threading.Thread(target=heartbeat, daemon=True)
        beat.start()
        try:
            for event in run.stream():
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                self.wfile.flush()
            self.wfile.write(b"event: end\ndata: {}\n\n")
            self.wfile.flush()
        except OSError:
            pass
        finally:
            stop.set()
        self.close_connection = True


def main() -> None:
    if not TOKEN:
        raise SystemExit("ANSIBLE_SIDECAR_TOKEN is required")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[sidecar] listening on :{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
