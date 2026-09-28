#!/usr/bin/env python3
"""Loopback Responses proxy that rejects completed, answerless model responses.

Codex retries a disconnected SSE request. The proxy closes the stream only when
the completed response contains neither a user-visible answer nor a tool call,
so retrying cannot repeat a tool action from that response.
"""

import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import requests


UPSTREAM = os.environ["RESPONSES_GUARD_UPSTREAM"].rstrip("/")
HOST = os.environ.get("RESPONSES_GUARD_HOST", "127.0.0.1")
PORT = int(os.environ.get("RESPONSES_GUARD_PORT", "39099"))
MAX_REQUEST_BYTES = 16 * 1024 * 1024
HOP_HEADERS = {"host", "content-length", "connection", "accept-encoding", "transfer-encoding"}
RESPONSE_HOP_HEADERS = {"content-length", "connection", "transfer-encoding", "content-encoding"}
LEADING_MARKERS = re.compile(r"^(?:\s|</think>|<\|assistant\|>)+")
SSE_EVENT_END = re.compile(rb"\r?\n\r?\n")


def has_visible_result(response):
    for item in response.get("output", []):
        kind = item.get("type", "")
        if kind == "function_call" or kind.endswith("_call"):
            return True
        if kind != "message":
            continue
        for part in item.get("content", []):
            if part.get("type") not in ("output_text", "refusal"):
                continue
            value = part.get("text", part.get("refusal", ""))
            if LEADING_MARKERS.sub("", str(value)).strip():
                return True
    return False


def completed_response(event):
    for line in event.split(b"\n"):
        if not line.startswith(b"data: "):
            continue
        try:
            payload = json.loads(line[6:])
        except (ValueError, UnicodeDecodeError):
            continue
        if payload.get("type") == "response.completed":
            return payload.get("response", {})
    return None


class GuardHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        pass  # Never log prompts, authorization, or response content.

    def do_GET(self):
        if self.path != "/healthz":
            self.send_error(404)
            return
        body = b"ok\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if urlsplit(self.path).path != "/v1/responses":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400)
            return
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self.send_error(413)
            return
        body = self.rfile.read(length)
        try:
            request = json.loads(body)
        except ValueError:
            self.send_error(400)
            return
        headers = {key: value for key, value in self.headers.items()
                   if key.lower() not in HOP_HEADERS}
        headers["Accept-Encoding"] = "identity"
        try:
            with requests.post(UPSTREAM + self.path, headers=headers, data=body,
                               stream=True, timeout=(10, 240)) as upstream:
                if not request.get("stream") or upstream.status_code != 200 or \
                        "text/event-stream" not in upstream.headers.get("Content-Type", ""):
                    payload = upstream.content
                    self.send_response(upstream.status_code)
                    for key, value in upstream.headers.items():
                        if key.lower() not in RESPONSE_HOP_HEADERS:
                            self.send_header(key, value)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return

                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                pending = b""
                for chunk in upstream.raw.stream(8192, decode_content=False):
                    pending += chunk
                    if len(pending) > 8 * 1024 * 1024:
                        raise ValueError("upstream SSE event exceeds 8 MiB")
                    while match := SSE_EVENT_END.search(pending):
                        event, pending = pending[:match.end()], pending[match.end():]
                        completed = completed_response(event)
                        if completed is not None and not has_visible_result(completed):
                            print("rejected completed response without answer or tool call",
                                  file=sys.stderr, flush=True)
                            self.close_connection = True
                            return
                        if completed is not None:
                            print("forwarded completed response", file=sys.stderr, flush=True)
                        self.wfile.write(("%x\r\n" % len(event)).encode() + event + b"\r\n")
                        self.wfile.flush()
                if pending:
                    self.wfile.write(("%x\r\n" % len(pending)).encode() + pending + b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            print("upstream request failed: %s" % type(error).__name__,
                  file=sys.stderr, flush=True)
            self.close_connection = True


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), GuardHandler)
    server.daemon_threads = True
    server.serve_forever()
