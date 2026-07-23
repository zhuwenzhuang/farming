"""Persistent incremental token collection for Farming.

This adapter intentionally lives inside the vendored cc-statistics package.
It reuses cc-statistics' token normalization and adds only the integration
boundary needed by a long-running product:

* byte-offset continuation for append-only JSONL files;
* a bounded SQLite cache that survives Farming restarts;
* Claude streaming-message de-duplication;
* recent exact events plus older per-session hourly aggregation.

The adapter never parses message content or tool payloads.  It only decodes
records that can carry cc-statistics token usage, session identity, or Codex
rate-limit metadata.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .parser import _extract_codex_text, _extract_codex_token_usage, _to_int


SCHEMA_VERSION = 4
SOURCE_VERSION = "cc-statistics-1.1.0-c98be0a"
PREFIX_BYTES = 64 * 1024
READ_CHUNK_BYTES = 1024 * 1024
MAX_JSON_LINE_BYTES = 8 * 1024 * 1024
MAX_JSON_KEY_BYTES = 256
MAX_CAPTURED_SCALAR_BYTES = 64 * 1024
DEFAULT_RETENTION_DAYS = 52 * 7
DEFAULT_RECENT_RAW_MS = 24 * 60 * 60 * 1000

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_files (
    path TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ns INTEGER NOT NULL,
    committed_offset INTEGER NOT NULL,
    file_dev INTEGER NOT NULL,
    file_ino INTEGER NOT NULL,
    prefix_bytes INTEGER NOT NULL,
    prefix_sha256 TEXT NOT NULL,
    carry BLOB NOT NULL,
    parser_state TEXT NOT NULL,
    session_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    latest_quota_at INTEGER,
    latest_quota TEXT
);
CREATE TABLE IF NOT EXISTS usage_events (
    source_path TEXT NOT NULL,
    event_key TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    PRIMARY KEY (source_path, event_key),
    FOREIGN KEY (source_path) REFERENCES source_files(path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS usage_events_time
    ON usage_events(timestamp_ms);
CREATE INDEX IF NOT EXISTS usage_events_provider_session_time
    ON usage_events(provider, session_id, timestamp_ms);
CREATE INDEX IF NOT EXISTS usage_events_dedupe
    ON usage_events(provider, session_id, dedupe_key, output_tokens);
"""


def _timestamp_ms(value: Any) -> int | None:
    if isinstance(value, (int, float)):
        number = float(value)
        if number <= 0:
            return None
        return int(number * 1000 if number < 10_000_000_000 else number)
    if not isinstance(value, str) or not value:
        return None
    try:
        if value.isdigit():
            return _timestamp_ms(int(value))
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    except (ValueError, OSError, OverflowError):
        return None


def _json_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


_LARGE_SCALAR_PATHS = {
    ("type",),
    ("timestamp",),
    ("sessionId",),
    ("cwd",),
    ("payload", "type"),
    ("payload", "id"),
    ("payload", "cwd"),
    ("payload", "name"),
    ("payload", "role"),
    ("message", "id"),
}
_LARGE_SCALAR_PREFIXES = (
    ("message", "usage"),
    ("payload", "info", "total_token_usage"),
    ("payload", "info", "last_token_usage"),
    ("payload", "rate_limits"),
)


class _BoundedJsonFields:
    """Extract selected JSON paths without retaining large string values."""

    def __init__(self) -> None:
        self.values: dict[tuple[str, ...], Any] = {}
        self.stack: list[dict[str, Any]] = []
        self.mode = ""
        self.token = bytearray()
        self.token_path: tuple[str, ...] = ()
        self.capture_token = False
        self.token_overflow = False
        self.string_marker_path: tuple[str, ...] = ()
        self.escaped = False
        self.root_started = False
        self.complete = False
        self.invalid = False

    @staticmethod
    def _wanted(path: tuple[str, ...]) -> bool:
        return path in _LARGE_SCALAR_PATHS or any(
            path[:len(prefix)] == prefix for prefix in _LARGE_SCALAR_PREFIXES
        )

    def _next_value_path(self) -> tuple[str, ...]:
        if not self.stack:
            return ()
        context = self.stack[-1]
        if context["kind"] == "object":
            key = context.get("key")
            return context["path"] + ((key,) if isinstance(key, str) else ())
        return context["path"] + ("[]",)

    def _accept_value(self) -> bool:
        if not self.stack:
            if self.root_started or self.complete:
                self.invalid = True
                return False
            self.root_started = True
            return True
        context = self.stack[-1]
        allowed = (
            context["state"] == "value"
            if context["kind"] == "object"
            else context["state"] in ("value_or_end", "value")
        )
        if not allowed:
            self.invalid = True
            return False
        context["state"] = "comma_or_end"
        return True

    def _start_string(self, is_key: bool) -> None:
        self.mode = "key_string" if is_key else "value_string"
        self.token = bytearray(b'"')
        self.token_overflow = False
        self.string_marker_path = ()
        self.escaped = False
        if is_key:
            self.capture_token = True
            self.token_path = ()
        else:
            self.token_path = self._next_value_path()
            self.string_marker_path = (
                self.token_path
                if self.token_path == ("payload", "message")
                else ()
            )
            self.capture_token = (
                self._wanted(self.token_path)
                and not self.string_marker_path
            )

    def _finish_string(self) -> None:
        if self.capture_token and not self.token_overflow:
            self.token.append(0x22)
            try:
                value = json.loads(bytes(self.token))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self.invalid = True
                value = ""
        else:
            value = ""
        if self.mode == "key_string":
            if not self.stack or self.stack[-1]["kind"] != "object":
                self.invalid = True
            else:
                self.stack[-1]["key"] = value
                self.stack[-1]["state"] = "colon"
        elif self.string_marker_path:
            self.values[self.string_marker_path] = "large message"
        elif self.capture_token and not self.token_overflow:
            self.values[self.token_path] = value
        self.mode = ""
        self.token = bytearray()
        self.string_marker_path = ()

    def _start_scalar(self, byte: int) -> None:
        self.mode = "scalar"
        self.token_path = self._next_value_path()
        self.capture_token = self._wanted(self.token_path)
        self.token_overflow = False
        self.token = bytearray([byte]) if self.capture_token else bytearray()
        self._accept_value()

    def _finish_scalar(self) -> None:
        if self.capture_token and not self.token_overflow:
            try:
                self.values[self.token_path] = json.loads(bytes(self.token))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self.invalid = True
        self.mode = ""
        self.token = bytearray()

    def feed(self, data: bytes) -> None:
        cursor = 0
        while cursor < len(data) and not self.invalid:
            byte = data[cursor]
            if self.mode in ("key_string", "value_string"):
                if not self.capture_token and not self.escaped:
                    quote_at = data.find(b'"', cursor)
                    escape_at = data.find(b"\\", cursor)
                    candidates = [
                        index for index in (quote_at, escape_at) if index >= 0
                    ]
                    if not candidates:
                        return
                    cursor = min(candidates)
                    byte = data[cursor]
                if self.capture_token:
                    limit = (
                        MAX_JSON_KEY_BYTES
                        if self.mode == "key_string"
                        else MAX_CAPTURED_SCALAR_BYTES
                    )
                    if len(self.token) < limit:
                        self.token.append(byte)
                    else:
                        self.capture_token = False
                        self.token_overflow = True
                if self.escaped:
                    self.escaped = False
                elif byte == 0x5C:
                    self.escaped = True
                elif byte == 0x22:
                    if self.capture_token:
                        self.token.pop()
                    self._finish_string()
                cursor += 1
                continue
            if self.mode == "scalar":
                if byte not in b" \t\r\n,]}":
                    if self.capture_token:
                        if len(self.token) < MAX_CAPTURED_SCALAR_BYTES:
                            self.token.append(byte)
                        else:
                            self.capture_token = False
                            self.token_overflow = True
                    cursor += 1
                    continue
                self._finish_scalar()
                continue
            if byte in b" \t\r\n":
                cursor += 1
                continue
            if self.complete:
                self.invalid = True
                continue
            if byte == 0x22:
                is_key = bool(
                    self.stack
                    and self.stack[-1]["kind"] == "object"
                    and self.stack[-1]["state"] in ("key_or_end", "key")
                )
                if not is_key and not self._accept_value():
                    continue
                self._start_string(is_key)
                cursor += 1
                continue
            if byte == 0x3A:
                if not self.stack or self.stack[-1]["state"] != "colon":
                    self.invalid = True
                else:
                    self.stack[-1]["state"] = "value"
                cursor += 1
                continue
            if byte in (0x7B, 0x5B):
                path = self._next_value_path()
                if not self._accept_value():
                    continue
                self.stack.append({
                    "kind": "object" if byte == 0x7B else "array",
                    "path": path,
                    "state": "key_or_end" if byte == 0x7B else "value_or_end",
                    "key": None,
                })
                cursor += 1
                continue
            if byte in (0x7D, 0x5D):
                expected = "object" if byte == 0x7D else "array"
                valid_states = (
                    ("key_or_end", "comma_or_end")
                    if expected == "object"
                    else ("value_or_end", "comma_or_end")
                )
                if (
                    not self.stack
                    or self.stack[-1]["kind"] != expected
                    or self.stack[-1]["state"] not in valid_states
                ):
                    self.invalid = True
                else:
                    self.stack.pop()
                    if not self.stack:
                        self.complete = True
                cursor += 1
                continue
            if byte == 0x2C:
                if (
                    not self.stack
                    or self.stack[-1]["state"] != "comma_or_end"
                ):
                    self.invalid = True
                else:
                    context = self.stack[-1]
                    context["state"] = (
                        "key" if context["kind"] == "object"
                        else "value"
                    )
                    context["key"] = None
                cursor += 1
                continue
            self._start_scalar(byte)
            cursor += 1

    def record(self, provider: str) -> dict[str, Any] | None:
        if self.mode == "scalar":
            self._finish_scalar()
        if self.invalid or not self.complete:
            return None
        value = self.values.get
        timestamp = value(("timestamp",), "")
        if provider == "claude":
            if value(("type",)) != "assistant":
                return None
            usage = {
                field: value(("message", "usage", field), 0)
                for field in (
                    "input_tokens",
                    "output_tokens",
                    "cache_read_input_tokens",
                    "cache_creation_input_tokens",
                )
            }
            if not timestamp or not any(_to_int(item) for item in usage.values()):
                return None
            return {
                "type": "assistant",
                "timestamp": timestamp,
                "sessionId": value(("sessionId",), ""),
                "cwd": value(("cwd",), ""),
                "message": {
                    "id": value(("message", "id"), ""),
                    "usage": usage,
                },
            }
        obj_type = value(("type",), "")
        payload_type = value(("payload", "type"), "")
        if obj_type == "session_meta":
            return {
                "type": obj_type,
                "timestamp": timestamp,
                "payload": {
                    "id": value(("payload", "id"), ""),
                    "cwd": value(("payload", "cwd"), ""),
                },
            }
        if obj_type == "event_msg" and payload_type == "agent_message":
            return {
                "type": obj_type,
                "timestamp": timestamp,
                "payload": {"type": payload_type, "message": "large message"},
            }
        if obj_type == "event_msg" and payload_type == "token_count":
            total_usage = {
                "total_tokens": value(
                    ("payload", "info", "total_token_usage", "total_tokens"), 0
                ),
            }
            last_usage = {
                field: value(
                    ("payload", "info", "last_token_usage", field), 0
                )
                for field in (
                    "input_tokens",
                    "output_tokens",
                    "cached_input_tokens",
                    "cache_read_input_tokens",
                    "cache_creation_input_tokens",
                    "total_tokens",
                )
            }
            rate_limits: dict[str, Any] = {}
            prefix = ("payload", "rate_limits")
            for path, scalar in self.values.items():
                if path[:len(prefix)] != prefix:
                    continue
                target = rate_limits
                remainder = path[len(prefix):]
                for key in remainder[:-1]:
                    target = target.setdefault(key, {})
                if remainder:
                    target[remainder[-1]] = scalar
            return {
                "type": obj_type,
                "timestamp": timestamp,
                "payload": {
                    "type": payload_type,
                    "info": {
                        "total_token_usage": total_usage,
                        "last_token_usage": last_usage,
                    },
                    **({"rate_limits": rate_limits} if rate_limits else {}),
                },
            }
        if obj_type != "response_item":
            return None
        if payload_type == "function_call":
            payload = {
                "type": payload_type,
                "name": value(("payload", "name"), "") or "large_call",
            }
        elif payload_type == "web_search_call":
            payload = {"type": payload_type}
        elif payload_type == "message" and value(("payload", "role")) == "assistant":
            payload = {
                "type": payload_type,
                "role": "assistant",
                "content": [{"type": "output_text", "text": "large message"}],
            }
        else:
            return None
        return {"type": obj_type, "timestamp": timestamp, "payload": payload}


def _prefix_hash(path: Path, length: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        prefix = handle.read(length)
    digest.update(prefix)
    return digest.hexdigest(), len(prefix)


def _session_id_for_path(path: Path, provider: str) -> str:
    if provider == "claude" and path.parent.name == "subagents":
        parent_id = path.parent.parent.name
        parent_file = path.parent.parent.parent / f"{parent_id}.jsonl"
        return parent_id if parent_file.is_file() else path.stem
    return path.stem


def _discover(roots: Iterable[str]) -> list[Path]:
    files: set[Path] = set()
    for raw_root in roots:
        root = Path(raw_root).expanduser()
        if not root.is_dir():
            continue
        try:
            for path in root.rglob("*.jsonl"):
                if path.is_file():
                    files.add(path.resolve())
        except OSError:
            continue
    return sorted(files)


def _connect(cache_file: Path) -> sqlite3.Connection:
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(cache_file, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute(
        "CREATE TABLE IF NOT EXISTS metadata "
        "(key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    current = connection.execute(
        "SELECT value FROM metadata WHERE key = 'schema_version'"
    ).fetchone()
    current_source = connection.execute(
        "SELECT value FROM metadata WHERE key = 'source_version'"
    ).fetchone()
    source_columns = {
        row["name"]
        for row in connection.execute("PRAGMA table_info(source_files)")
    }
    event_columns = {
        row["name"]
        for row in connection.execute("PRAGMA table_info(usage_events)")
    }
    if (
        current is not None
        and current["value"] != str(SCHEMA_VERSION)
    ) or (
        current_source is not None
        and current_source["value"] != SOURCE_VERSION
    ) or (
        source_columns
        and not {"prefix_bytes", "file_dev", "file_ino"}.issubset(source_columns)
    ) or (
        event_columns
        and "dedupe_key" not in event_columns
    ):
        connection.executescript(
            """
            DROP TABLE IF EXISTS usage_events;
            DROP TABLE IF EXISTS source_files;
            DELETE FROM metadata;
            """
        )
    connection.executescript(SCHEMA_SQL)
    connection.execute(
        "INSERT OR REPLACE INTO metadata(key, value) VALUES('schema_version', ?)",
        (str(SCHEMA_VERSION),),
    )
    connection.execute(
        "INSERT OR REPLACE INTO metadata(key, value) VALUES('source_version', ?)",
        (SOURCE_VERSION,),
    )
    connection.commit()
    try:
        os.chmod(cache_file, 0o600)
    except OSError:
        pass
    return connection


def _empty_state(provider: str, path: Path) -> dict[str, Any]:
    return {
        "last_total_tokens": None,
        "session_id": _session_id_for_path(path, provider),
        "project_path": "",
        "quotas": {},
        "last_assistant_timestamp": None,
    }


def _file_row(connection: sqlite3.Connection, path: Path) -> sqlite3.Row | None:
    return connection.execute(
        "SELECT * FROM source_files WHERE path = ?",
        (str(path),),
    ).fetchone()


def _insert_source_file(
    connection: sqlite3.Connection,
    path: Path,
    provider: str,
    stat: os.stat_result,
    prefix_sha256: str,
    prefix_bytes: int,
    state: dict[str, Any],
) -> None:
    connection.execute(
        """
        INSERT OR REPLACE INTO source_files(
            path, provider, size, mtime_ns, committed_offset, file_dev, file_ino,
            prefix_bytes, prefix_sha256,
            carry, parser_state, session_id, project_path,
            latest_quota_at, latest_quota
        ) VALUES(?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, '', NULL, NULL)
        """,
        (
            str(path),
            provider,
            stat.st_size,
            stat.st_mtime_ns,
            int(stat.st_dev),
            int(stat.st_ino),
            prefix_bytes,
            prefix_sha256,
            b"",
            json.dumps(state, separators=(",", ":")),
            state["session_id"],
        ),
    )


def _codex_record(
    obj: dict[str, Any],
    state: dict[str, Any],
) -> tuple[dict[str, int] | None, dict[str, Any] | None]:
    obj_type = obj.get("type")
    payload = _json_dict(obj.get("payload"))
    if obj_type == "session_meta":
        session_id = payload.get("id")
        if isinstance(session_id, str) and session_id:
            state["session_id"] = session_id
        project_path = payload.get("cwd")
        if isinstance(project_path, str) and project_path:
            state["project_path"] = project_path
        return None, None
    timestamp = obj.get("timestamp")
    if obj_type == "event_msg" and payload.get("type") == "agent_message":
        if isinstance(payload.get("message"), str):
            state["last_assistant_timestamp"] = timestamp
        return None, None
    if obj_type == "response_item":
        item_type = payload.get("type")
        is_assistant = (
            item_type == "function_call"
            and isinstance(payload.get("name"), str)
            and bool(payload.get("name"))
        ) or item_type == "web_search_call" or (
            item_type == "message"
            and payload.get("role") == "assistant"
            and bool(_extract_codex_text(payload.get("content")))
        )
        if is_assistant:
            state["last_assistant_timestamp"] = timestamp
        return None, None
    if obj_type != "event_msg" or payload.get("type") != "token_count":
        return None, None

    info = _json_dict(payload.get("info"))
    totals = _json_dict(info.get("total_token_usage"))
    total_tokens = _to_int(totals.get("total_tokens", 0))
    if (
        total_tokens > 0
        and state.get("last_total_tokens") is not None
        and total_tokens == state["last_total_tokens"]
    ):
        usage = None
    else:
        if total_tokens > 0:
            state["last_total_tokens"] = total_tokens
        normalized = _extract_codex_token_usage(payload)
        usage = None if not normalized else {
            "input_tokens": _to_int(normalized.get("input_tokens", 0)),
            "output_tokens": _to_int(normalized.get("output_tokens", 0)),
            "cache_read_tokens": _to_int(
                normalized.get("cache_read_input_tokens", 0)
            ),
            "cache_write_tokens": _to_int(
                normalized.get("cache_creation_input_tokens", 0)
            ),
        }
    rate_limits = payload.get("rate_limits")
    return usage, rate_limits if isinstance(rate_limits, dict) else None


def _claude_record(
    obj: dict[str, Any],
    state: dict[str, Any],
) -> tuple[dict[str, int] | None, str | None]:
    if obj.get("type") != "assistant":
        return None, None
    raw_message = _json_dict(obj.get("message"))
    usage = _json_dict(raw_message.get("usage"))
    if not usage:
        return None, None
    project_path = obj.get("cwd")
    if isinstance(project_path, str) and project_path:
        state["project_path"] = project_path
    normalized = {
        "input_tokens": _to_int(usage.get("input_tokens", 0)),
        "output_tokens": _to_int(usage.get("output_tokens", 0)),
        "cache_read_tokens": _to_int(usage.get("cache_read_input_tokens", 0)),
        "cache_write_tokens": _to_int(
            usage.get("cache_creation_input_tokens", 0)
        ),
    }
    if sum(normalized.values()) <= 0:
        return None, None
    message_id = raw_message.get("id")
    return normalized, message_id if isinstance(message_id, str) else None


def _interesting_line(provider: str, line: bytes) -> bool:
    if provider == "codex":
        if (
            b'"session_meta"' in line
            or b'"token_count"' in line
            or b'"agent_message"' in line
        ):
            return True
        return b'"response_item"' in line and any(marker in line for marker in (
            b'"function_call"',
            b'"web_search_call"',
            b'"message"',
        ))
    return b'"assistant"' in line


def _event_upsert(
    connection: sqlite3.Connection,
    *,
    path: Path,
    event_key: str,
    provider: str,
    session_id: str,
    timestamp_ms: int,
    usage: dict[str, int],
    deduplicate_by_output: bool,
) -> None:
    values = (
        str(path),
        event_key,
        event_key.removeprefix("message:") if event_key.startswith("message:") else "",
        provider,
        session_id,
        timestamp_ms,
        usage["input_tokens"],
        usage["output_tokens"],
        usage["cache_read_tokens"],
        usage["cache_write_tokens"],
    )
    if deduplicate_by_output:
        connection.execute(
            """
            INSERT INTO usage_events(
                source_path, event_key, dedupe_key, provider, session_id, timestamp_ms,
                input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_path, event_key) DO UPDATE SET
                session_id = excluded.session_id,
                timestamp_ms = excluded.timestamp_ms,
                input_tokens = excluded.input_tokens,
                output_tokens = excluded.output_tokens,
                cache_read_tokens = excluded.cache_read_tokens,
                cache_write_tokens = excluded.cache_write_tokens
            WHERE excluded.output_tokens > usage_events.output_tokens
            """,
            values,
        )
    else:
        connection.execute(
            """
            INSERT OR IGNORE INTO usage_events(
                source_path, event_key, dedupe_key, provider, session_id, timestamp_ms,
                input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            values,
        )


def _scan_file(
    connection: sqlite3.Connection,
    path: Path,
    provider: str,
    stat: os.stat_result,
    metrics: dict[str, int],
) -> None:
    row = _file_row(connection, path)
    if (
        row is not None
        and row["provider"] == provider
        and stat.st_size == row["size"]
        and stat.st_mtime_ns == row["mtime_ns"]
    ):
        metrics["reused_files"] += 1
        return

    rebuild = row is None or row["provider"] != provider
    prefix_bytes = min(stat.st_size, PREFIX_BYTES)
    prefix_sha256 = ""
    if row is not None and not rebuild:
        same_identity = (
            int(row["file_dev"]) != 0
            and int(row["file_ino"]) != 0
            and int(row["file_dev"]) == int(stat.st_dev)
            and int(row["file_ino"]) == int(stat.st_ino)
        )
        if stat.st_size < int(row["committed_offset"]) or not same_identity:
            rebuild = True
        elif stat.st_size == int(row["size"]):
            prefix_bytes = int(row["prefix_bytes"])
            prefix_sha256, bytes_read = _prefix_hash(path, prefix_bytes)
            metrics["bytes_read"] += bytes_read
            if prefix_sha256 != row["prefix_sha256"]:
                rebuild = True
            else:
                connection.execute(
                    """
                    UPDATE source_files SET
                        mtime_ns = ?, file_dev = ?, file_ino = ?
                    WHERE path = ?
                    """,
                    (
                        stat.st_mtime_ns,
                        int(stat.st_dev),
                        int(stat.st_ino),
                        str(path),
                    ),
                )
                metrics["reused_files"] += 1
                return

    if rebuild:
        if row is not None:
            connection.execute(
                "DELETE FROM source_files WHERE path = ?",
                (str(path),),
            )
        prefix_bytes = min(stat.st_size, PREFIX_BYTES)
        prefix_sha256, bytes_read = _prefix_hash(path, prefix_bytes)
        metrics["bytes_read"] += bytes_read
        state = _empty_state(provider, path)
        _insert_source_file(
            connection,
            path,
            provider,
            stat,
            prefix_sha256,
            min(stat.st_size, PREFIX_BYTES),
            state,
        )
        row = _file_row(connection, path)
        metrics["rebuilt_files"] += 1
    else:
        prefix_bytes = int(row["prefix_bytes"])
        prefix_sha256 = row["prefix_sha256"]
        metrics["appended_files"] += 1

    assert row is not None
    offset = int(row["committed_offset"])
    state = json.loads(row["parser_state"])
    latest_quota_at = row["latest_quota_at"]
    latest_quota = (
        json.loads(row["latest_quota"]) if row["latest_quota"] else None
    )

    def consume_obj(obj: dict[str, Any], line_end: int) -> bool:
        nonlocal latest_quota_at, latest_quota
        timestamp_ms = _timestamp_ms(obj.get("timestamp"))
        if provider == "codex":
            usage, quota = _codex_record(obj, state)
            message_id = None
            if usage is not None and not state.get("last_assistant_timestamp"):
                state["last_assistant_timestamp"] = obj.get("timestamp")
            if quota is not None and (
                timestamp_ms is None
                or latest_quota_at is None
                or timestamp_ms >= latest_quota_at
            ):
                latest_quota_at = timestamp_ms
                latest_quota = quota
            if quota is not None:
                quota_key = str(
                    quota.get("limit_id") or quota.get("limitId") or ""
                )
                previous_quota = state.setdefault("quotas", {}).get(quota_key)
                if (
                    previous_quota is None
                    or timestamp_ms is None
                    or previous_quota.get("timestamp") is None
                    or timestamp_ms >= previous_quota["timestamp"]
                ):
                    state["quotas"][quota_key] = {
                        "timestamp": timestamp_ms,
                        "rateLimits": quota,
                    }
        else:
            usage, message_id = _claude_record(obj, state)
        if usage is None or timestamp_ms is None:
            return True
        if provider == "codex":
            timestamp_ms = (
                _timestamp_ms(state.get("last_assistant_timestamp"))
                or timestamp_ms
            )
        event_key = (
            f"message:{message_id}"
            if message_id
            else f"offset:{line_end}"
        )
        _event_upsert(
            connection,
            path=path,
            event_key=event_key,
            provider=provider,
            session_id=state["session_id"],
            timestamp_ms=timestamp_ms,
            usage=usage,
            deduplicate_by_output=bool(message_id),
        )
        metrics["parsed_events"] += 1
        return True

    def consume_line(raw_line: bytes, line_end: int) -> bool:
        if not _interesting_line(provider, raw_line):
            return True
        try:
            obj = json.loads(raw_line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return False
        return consume_obj(obj, line_end)

    committed_offset = offset
    physical_offset = offset
    line_start = offset
    pending_line = b""
    large_fields: _BoundedJsonFields | None = None
    with path.open("rb") as handle:
        handle.seek(offset)
        while True:
            chunk = handle.read(READ_CHUNK_BYTES)
            if not chunk:
                break
            metrics["bytes_read"] += len(chunk)
            chunk_start = physical_offset
            physical_offset += len(chunk)
            cursor = 0
            while cursor < len(chunk):
                newline = chunk.find(b"\n", cursor)
                end = len(chunk) if newline < 0 else newline + 1
                part = chunk[cursor:end]
                if large_fields is not None:
                    large_fields.feed(part)
                else:
                    pending_line += part
                    if len(pending_line) > MAX_JSON_LINE_BYTES:
                        large_fields = _BoundedJsonFields()
                        large_fields.feed(pending_line)
                        pending_line = b""
                if newline >= 0:
                    line_end = chunk_start + end
                    if large_fields is not None:
                        obj = large_fields.record(provider)
                        if obj is not None:
                            consume_obj(obj, line_end)
                    else:
                        consume_line(pending_line, line_end)
                    committed_offset = line_end
                    line_start = line_end
                    pending_line = b""
                    large_fields = None
                cursor = end

    if large_fields is not None:
        obj = large_fields.record(provider)
        if large_fields.complete and not large_fields.invalid:
            if obj is not None:
                consume_obj(obj, physical_offset)
            committed_offset = physical_offset
        else:
            committed_offset = line_start
    elif pending_line and _interesting_line(provider, pending_line):
        if consume_line(pending_line, physical_offset):
            committed_offset = physical_offset
    else:
        committed_offset = line_start

    final_stat = path.stat()
    connection.execute(
        """
        UPDATE source_files SET
            size = ?, mtime_ns = ?, committed_offset = ?,
            file_dev = ?, file_ino = ?, prefix_bytes = ?, prefix_sha256 = ?,
            carry = ?, parser_state = ?, session_id = ?, project_path = ?,
            latest_quota_at = ?, latest_quota = ?
        WHERE path = ?
        """,
        (
            final_stat.st_size,
            final_stat.st_mtime_ns,
            committed_offset,
            int(final_stat.st_dev),
            int(final_stat.st_ino),
            prefix_bytes,
            prefix_sha256,
            b"",
            json.dumps(state, separators=(",", ":")),
            state["session_id"],
            state["project_path"],
            latest_quota_at,
            (
                json.dumps(latest_quota, separators=(",", ":"))
                if latest_quota is not None
                else None
            ),
            str(path),
        ),
    )
    connection.execute(
        "UPDATE usage_events SET session_id = ? WHERE source_path = ?",
        (state["session_id"], str(path)),
    )
    metrics["scanned_files"] += 1


def _event_dict(row: sqlite3.Row, timestamp_ms: int | None = None) -> dict[str, Any]:
    input_tokens = int(row["input_tokens"])
    output_tokens = int(row["output_tokens"])
    cache_read_tokens = int(row["cache_read_tokens"])
    cache_write_tokens = int(row["cache_write_tokens"])
    total_tokens = (
        input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
    )
    return {
        "timestamp": int(
            row["timestamp_ms"] if timestamp_ms is None else timestamp_ms
        ),
        "sessionId": row["session_id"],
        "totalTokens": total_tokens,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cacheReadTokens": cache_read_tokens,
        "cacheWriteTokens": cache_write_tokens,
        "unattributedTokens": 0,
    }


def _provider_events(
    connection: sqlite3.Connection,
    provider: str,
    retention_cutoff_ms: int,
    recent_cutoff_ms: int,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT e.source_path, e.event_key, e.dedupe_key, e.session_id,
               e.timestamp_ms, e.input_tokens, e.output_tokens,
               e.cache_read_tokens, e.cache_write_tokens
        FROM usage_events AS e
        WHERE e.provider = ?
          AND e.timestamp_ms >= ?
          AND (
            e.dedupe_key = ''
            OR NOT EXISTS (
              SELECT 1
              FROM usage_events AS better
              WHERE better.provider = e.provider
                AND better.session_id = e.session_id
                AND better.dedupe_key = e.dedupe_key
                AND (
                  better.output_tokens > e.output_tokens
                  OR (
                    better.output_tokens = e.output_tokens
                    AND (
                      better.source_path < e.source_path
                      OR (
                        better.source_path = e.source_path
                        AND better.event_key < e.event_key
                      )
                    )
                  )
                )
            )
          )
        ORDER BY e.timestamp_ms
        """,
        (provider, retention_cutoff_ms),
    )
    recent: list[dict[str, Any]] = []
    older: dict[tuple[str, int], dict[str, Any]] = {}
    for row in rows:
        timestamp_ms = int(row["timestamp_ms"])
        if timestamp_ms >= recent_cutoff_ms:
            recent.append(_event_dict(row))
            continue
        local_hour = datetime.fromtimestamp(
            timestamp_ms / 1000,
            tz=timezone.utc,
        ).astimezone().replace(minute=0, second=0, microsecond=0)
        hour_timestamp_ms = int(local_hour.timestamp() * 1000)
        key = (row["session_id"], hour_timestamp_ms)
        aggregate = older.get(key)
        if aggregate is None:
            aggregate = {
                "session_id": row["session_id"],
                "timestamp_ms": hour_timestamp_ms,
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
            }
            older[key] = aggregate
        for field in (
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
        ):
            aggregate[field] += int(row[field])
    older_events = [
        _event_dict(row)
        for row in sorted(
            older.values(),
            key=lambda row: (row["timestamp_ms"], row["session_id"]),
        )
    ]
    return older_events + recent


def _latest_quotas(
    connection: sqlite3.Connection,
    provider: str,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT parser_state
        FROM source_files
        WHERE provider = ?
        """,
        (provider,),
    ).fetchall()
    candidates: list[dict[str, Any]] = []
    for row in rows:
        state = json.loads(row["parser_state"])
        for candidate in state.get("quotas", {}).values():
            if isinstance(candidate, dict):
                candidates.append(candidate)
    candidates.sort(
        key=lambda candidate: candidate.get("timestamp") or 0,
        reverse=True,
    )
    return candidates[:32]


def collect_usage(request: dict[str, Any]) -> dict[str, Any]:
    cache_file = Path(str(request["cacheFile"])).expanduser()
    now_ms = int(request.get("nowMs") or time.time() * 1000)
    retention_days = max(
        1, int(request.get("retentionDays") or DEFAULT_RETENTION_DAYS)
    )
    recent_raw_ms = max(
        60_000, int(request.get("recentRawMs") or DEFAULT_RECENT_RAW_MS)
    )
    roots_by_provider = _json_dict(request.get("roots"))
    providers = ("codex", "claude")
    discovered: dict[str, list[Path]] = {
        provider: _discover(roots_by_provider.get(provider, []))
        for provider in providers
    }
    metrics = {
        "discovered_files": sum(len(paths) for paths in discovered.values()),
        "scanned_files": 0,
        "reused_files": 0,
        "appended_files": 0,
        "rebuilt_files": 0,
        "parsed_events": 0,
        "bytes_read": 0,
        "pruned_events": 0,
        "removed_files": 0,
        "errors": 0,
        "errors_by_provider": {provider: 0 for provider in providers},
    }
    connection = _connect(cache_file)
    seen: set[str] = set()
    try:
        for provider in providers:
            for path in discovered[provider]:
                seen.add(str(path))
                try:
                    stat = path.stat()
                    _scan_file(connection, path, provider, stat, metrics)
                    connection.commit()
                except (OSError, ValueError, sqlite3.Error, json.JSONDecodeError):
                    metrics["errors"] += 1
                    metrics["errors_by_provider"][provider] += 1
                    connection.rollback()

        cached_paths = {
            row["path"]
            for row in connection.execute("SELECT path FROM source_files")
        }
        stale_paths = cached_paths - seen
        for stale_path in stale_paths:
            connection.execute(
                "DELETE FROM source_files WHERE path = ?", (stale_path,)
            )
        metrics["removed_files"] = len(stale_paths)

        retention_cutoff_ms = now_ms - retention_days * 24 * 60 * 60 * 1000
        before = connection.total_changes
        connection.execute(
            "DELETE FROM usage_events WHERE timestamp_ms < ?",
            (retention_cutoff_ms,),
        )
        metrics["pruned_events"] = connection.total_changes - before
        connection.commit()

        recent_cutoff_ms = max(
            retention_cutoff_ms, now_ms - recent_raw_ms
        )
        result_providers: dict[str, Any] = {}
        for provider in providers:
            provider_errors = metrics["errors_by_provider"][provider]
            provider_available = (
                len(discovered[provider]) > 0
                and provider_errors == 0
            )
            result_providers[provider] = {
                "events": _provider_events(
                    connection,
                    provider,
                    retention_cutoff_ms,
                    recent_cutoff_ms,
                ),
                "quotaCandidates": (
                    _latest_quotas(connection, provider)
                    if provider == "codex"
                    else []
                ),
                "fileCount": len(discovered[provider]),
                "available": provider_available,
                **(
                    {}
                    if provider_available
                    else {
                        "reason": (
                            f"{provider_errors} session file(s) could not be parsed."
                            if provider_errors
                            else "No cc-statistics session files were found."
                        )
                    }
                ),
            }
        return {
            "schemaVersion": SCHEMA_VERSION,
            "source": SOURCE_VERSION,
            "sampledAt": now_ms,
            "retentionDays": retention_days,
            "providers": result_providers,
            "cache": {
                **metrics,
                "path": str(cache_file),
            },
        }
    finally:
        connection.close()
