#!/usr/bin/env python3
import importlib.util
import json
import os
import pathlib
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests


source = pathlib.Path(__file__).with_name("responses-empty-final-guard.py")
os.environ.setdefault("RESPONSES_GUARD_UPSTREAM", "http://127.0.0.1")
spec = importlib.util.spec_from_file_location("responses_empty_final_guard", source)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def sse(output, line_ending="\n"):
    response = {"type": "response.completed", "response": {"status": "completed", "output": output}}
    return (line_ending.join(("event: response.completed", "data: " + json.dumps(response),
                              "", "data: [DONE]", "", ""))).encode()


class FakeUpstream(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        case = self.headers.get("X-Test-Case")
        base_case = case.removesuffix("-crlf")
        if base_case == "tool":
            output = [{"type": "reasoning"}, {"type": "function_call", "name": "lookup"}]
        elif base_case == "answer":
            output = [{"type": "message", "content": [{"type": "output_text", "text": "结果正确"}]}]
        elif base_case == "marker":
            output = [{"type": "message", "content": [{"type": "output_text", "text": "</think><|assistant|>"}]}]
        else:
            output = [{"type": "reasoning"}]
        payload = sse(output, "\r\n" if case.endswith("-crlf") else "\n")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class GuardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        guard.UPSTREAM = f"http://127.0.0.1:{cls.upstream.server_port}"
        cls.proxy = ThreadingHTTPServer(("127.0.0.1", 0), guard.GuardHandler)
        cls.threads = [threading.Thread(target=server.serve_forever, daemon=True)
                       for server in (cls.upstream, cls.proxy)]
        for thread in cls.threads:
            thread.start()

    @classmethod
    def tearDownClass(cls):
        for server in (cls.proxy, cls.upstream):
            server.shutdown()
            server.server_close()

    def request(self, case):
        return requests.post(f"http://127.0.0.1:{self.proxy.server_port}/v1/responses",
                             headers={"X-Test-Case": case}, json={"stream": True},
                             stream=True, timeout=5)

    def test_answer_and_tool_step_pass(self):
        for case in ("answer", "tool", "answer-crlf", "tool-crlf"):
            with self.subTest(case=case), self.request(case) as response:
                self.assertEqual(response.status_code, 200)
                self.assertIn(b"response.completed", response.content)

    def test_answerless_completion_disconnects_for_codex_retry(self):
        for case in ("reasoning", "marker", "reasoning-crlf", "marker-crlf"):
            with self.subTest(case=case), self.request(case) as response:
                self.assertEqual(response.status_code, 200)
                with self.assertRaises(requests.exceptions.ChunkedEncodingError):
                    _ = response.content


if __name__ == "__main__":
    unittest.main()
