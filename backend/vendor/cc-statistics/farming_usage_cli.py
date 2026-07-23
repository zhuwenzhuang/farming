#!/usr/bin/env python3
"""JSON stdin/stdout entry point for Farming's cc-statistics adapter."""

from __future__ import annotations

import json
import sys

from cc_stats.farming_usage import collect_usage


def main() -> int:
    try:
        request = json.load(sys.stdin)
        result = collect_usage(request)
        json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
        return 0
    except Exception as exc:  # pragma: no cover - surfaced to the Node caller
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
