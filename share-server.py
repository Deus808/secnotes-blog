#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only whitelist static server for sharing the site via a tunnel.

Only exposes index.html / assets/ / data/. Everything else (notes/, admin/,
.trash/, .workbuddy/, *.py, config files) returns 404, so note sources,
drafts, memory files and the admin panel never leak to the public.

Usage:
    python share-server.py          # default port 8090
    python share-server.py 9000     # custom port
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 与其它脚本保持一致：中文 Windows 控制台是 GBK，统一改成 UTF-8，
# 免得将来在这里加任何非 ASCII 提示时踩同一个坑。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

ROOT = Path(__file__).resolve().parent

if any(a in ("-h", "--help") for a in sys.argv[1:]):
    print(__doc__.strip())
    raise SystemExit(0)

try:
    PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
except ValueError:
    print(f"[ERROR] invalid port: {sys.argv[1]!r} (expected an integer, e.g. 8090)")
    raise SystemExit(2)


def is_allowed(rel):
    rel = rel.replace("\\", "/").lstrip("/")
    return (
        rel in ("", ".", "index.html")
        or rel.startswith("assets/")
        or rel.startswith("data/")
    )


class WhitelistHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def translate_path(self, path):
        translated = super().translate_path(path)
        rel = os.path.relpath(translated, str(ROOT))
        if not is_allowed(rel):
            return str(ROOT / "__forbidden__404__")
        return translated

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), WhitelistHandler)
    print("[share] serving whitelist-only on http://127.0.0.1:%d" % PORT)
    print("[share] exposing index.html / assets/ / data/ only  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[share] stopped")