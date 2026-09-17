#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SecNotes 本地内容管理服务
--------------------------
为静态博客提供一个本地编辑器：列出 / 新建 / 修改 / 删除笔记，
保存后自动调用 build.py 重建站点数据。

设计要点
  · 仅监听 127.0.0.1，不对外暴露；
  · 所有 /api/ 请求必须携带启动时随机生成的 X-Admin-Token（同时校验 Origin），
    防止本机其他页面发起跨站请求篡改笔记；
  · 删除采用「移入 .trash/ 回收站」而非直接抹除，可从界面还原；
  · 文件名与路径做白名单校验并强制限定在 notes/ 目录内，阻断目录穿越；
  · 复用 build.py 的 front-matter 解析/序列化，保证与构建脚本完全一致。

用法：
    python admin.py                 # 默认 http://127.0.0.1:8080
    python admin.py --port 9000
    python admin.py --no-rebuild    # 保存后不自动重建（自行运行 build.py）
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

# 中文 Windows 的控制台默认是 GBK，无法编码 emoji（本脚本的启动提示含 ⚠）。
# 强制 UTF-8，避免一句提示文字把整个服务打挂。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import build as builder  # noqa: E402  复用构建脚本的解析与校验逻辑

NOTES_DIR = ROOT / "notes"
TRASH_DIR = ROOT / ".trash"
ADMIN_INDEX = ROOT / "admin" / "index.html"
NOTICE_FILE = ROOT / "notice.json"   # 站点维护通知（管理端读写，deploy.py 读取注入）

SLUG_RE = re.compile(r"^[A-Za-z0-9_\-\u4e00-\u9fff]{1,80}$")

# 静态资源白名单：只对外提供站点运行必需的资源。
# notes/ 与 .trash/ 是写作产物，一律不通过 HTTP 暴露（编辑器走 /api/ 读写）。
STATIC_FILES = {"index.html", "manage.html", "favicon.ico", "robots.txt", "rss.xml", "sitemap.xml"}
STATIC_DIRS = ("assets/", "data/", "admin/")

# 图片上传
UPLOADS_DIR = ROOT / "assets" / "uploads"
IMAGE_TYPES = {"png": "png", "jpg": "jpg", "jpeg": "jpg", "gif": "gif", "webp": "webp"}
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_BODY_BYTES = 12 * 1024 * 1024

TOKEN = secrets.token_urlsafe(24)
CLI_ARGS: argparse.Namespace | None = None
BUILD_LOCK = threading.Lock()


def static_allowed(rel: str) -> bool:
    """判断某个相对路径是否允许通过 HTTP 提供。"""
    if not rel or rel in STATIC_FILES:
        return True
    # 任何以点开头的路径段都拒绝（.trash、.git、.workbuddy 等）
    if any(seg.startswith(".") for seg in rel.split("/")):
        return False
    return rel.startswith(STATIC_DIRS)


# ==========================================================================
# 文件读写
# ==========================================================================
def slug_to_path(slug: str) -> Path:
    """把 slug 映射为 notes/ 下的安全路径，非法输入直接拒绝。"""
    if not slug or not SLUG_RE.match(slug) or slug.startswith((".", "_")):
        raise ValueError(f"非法的文件名：{slug!r}")
    path = (NOTES_DIR / f"{slug}.md").resolve()
    if path.parent != NOTES_DIR.resolve():
        raise ValueError("路径越界，已拒绝")
    return path


def render_front_matter(meta: dict) -> str:
    """front-matter 序列化统一由 build.py 提供（单一实现，避免两处漂移）。"""
    return builder.render_front_matter(meta)


def write_note(path: Path, meta: dict, body: str) -> None:
    builder.write_note_file(path, meta, body)


def read_note(path: Path) -> dict:
    meta, body = builder.split_front_matter(path.read_text(encoding="utf-8", errors="replace"))
    stat = path.stat()
    plain = builder.strip_markdown(body)
    return {
        "slug": path.stem,
        "file": path.relative_to(ROOT).as_posix(),
        "title": str(meta.get("title") or builder.first_heading(body) or path.stem),
        "date": str(meta.get("date") or datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d")),
        "category": str(meta.get("category") or "未分类"),
        "tags": builder.as_list(meta.get("tags")),
        "summary": str(meta.get("summary") or "") or plain[:130],
        "draft": bool(meta.get("draft", False)),
        "body": body,
        "words": builder.count_words(body),
        "reading_time": max(1, -(-builder.count_words(body) // 400)),
        "mtime": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M"),
    }


def list_notes() -> list[dict]:
    if not NOTES_DIR.exists():
        return []
    out = []
    for path in sorted(NOTES_DIR.rglob("*.md")):
        if path.name.startswith("_"):
            continue
        try:
            out.append(read_note(path))
        except Exception as e:  # noqa: BLE001
            print(f"⚠ 跳过无法解析的文件 {path.name}：{e}")
    out.sort(key=lambda n: (n["date"], n["slug"]), reverse=True)
    return out


MAX_BODY_MATCHES = 5          # 每篇笔记最多回传的正文命中片段
MAX_SNIPPET = 160             # 命中行预览的最大字符数
CJK_RANGE = re.compile(r"[\u4e00-\u9fff]")


def _cjk_bigrams(term: str) -> list[str]:
    """把较长的中文词切成相邻二字组，用于放宽匹配。

    中文没有词边界，只做精确子串匹配会让「内网渗透」这类词组召回极差
    （笔记里写的是「内网探测」「渗透测试」）。切成二字组后能召回相关内容。
    """
    if len(term) < 3 or not CJK_RANGE.search(term):
        return []
    return [term[i:i + 2] for i in range(len(term) - 1)]


def _bigram_hits(text: str, term: str) -> list[str]:
    return [b for b in _cjk_bigrams(term) if b in text]


def _note_hit(hay: str, terms: list[str], relaxed: bool) -> bool:
    """整篇是否入选：每个关键词都要能被满足。"""
    if not relaxed:
        return all(t in hay for t in terms)

    hits = 0
    for t in terms:
        if t in hay:
            continue
        found = _bigram_hits(hay, t)
        if not found:
            return False
        hits += len(found)
    # 多关键词时，放宽至少要有两处词组命中。否则像「存在」这种极常见的
    # 二字片段会把大量无关笔记带进来，让放宽结果失去意义。
    if len(terms) > 1 and hits < 2:
        return False
    return True


def _line_hit(line: str, terms: list[str], relaxed: bool) -> bool:
    """单行是否作为命中片段展示（任一关键词满足即可）。"""
    for t in terms:
        if t in line:
            return True
        if relaxed and _bigram_hits(line, t):
            return True
    return False


def search_notes(raw_query: str, limit: int = 60) -> dict:
    """全文检索。

    语义：空格分隔的多个关键词为 **AND** 关系，每个关键词可命中标题、分类、标签或正文。
    精确匹配无结果时自动放宽为「中文二字组」匹配，并在响应中标记 relaxed=true，
    由界面明确告知用户这是相近结果。
    """
    terms = [t.lower() for t in re.split(r"\s+", raw_query.strip()) if t]
    if not terms:
        return {"ok": True, "query": raw_query, "terms": [], "results": [],
                "total": 0, "truncated": False, "relaxed": False}

    def scan(relaxed: bool) -> list[dict]:
        found: list[dict] = []
        paths = sorted(NOTES_DIR.rglob("*.md")) if NOTES_DIR.exists() else []
        for path in paths:
            if path.name.startswith("_"):
                continue
            try:
                note = read_note(path)
            except Exception:  # noqa: BLE001
                continue

            title_low = note["title"].lower()
            meta_low = (note["category"] + " " + " ".join(note["tags"])).lower()
            hay = title_low + "\n" + meta_low + "\n" + note["body"].lower()
            if not _note_hit(hay, terms, relaxed):
                continue

            matches: list[dict] = []
            for idx, line in enumerate(note["body"].split("\n")):
                low = line.lower()
                if _line_hit(low, terms, relaxed):
                    matches.append({
                        "line": idx + 1,
                        "text": line.strip()[:MAX_SNIPPET],
                        "cols": {t: low.find(t) for t in terms if t in low},
                    })

            title_hit = _line_hit(title_low, terms, relaxed)
            meta_hit = _line_hit(meta_low, terms, relaxed)
            found.append({
                "slug": note["slug"],
                "title": note["title"],
                "date": note["date"],
                "category": note["category"],
                "tags": note["tags"],
                "draft": note["draft"],
                "titleHit": title_hit,
                "metaHit": meta_hit,
                "matchCount": len(matches),
                "matches": matches[:MAX_BODY_MATCHES],
                "score": (100 if title_hit else 0) + (20 if meta_hit else 0) + min(len(matches), 10),
            })
        return found

    results = scan(False)
    relaxed_used = False
    if not results:
        results = scan(True)
        relaxed_used = bool(results)

    results.sort(key=lambda r: r["date"], reverse=True)   # 先按时间新→旧
    results.sort(key=lambda r: -r["score"])               # 稳定排序：分数降序，同分保持时间序

    total = len(results)
    return {
        "ok": True,
        "query": raw_query,
        "terms": terms,
        "results": results[:limit],
        "total": total,
        "truncated": total > limit,
        "relaxed": relaxed_used,
    }


def list_trash() -> list[dict]:
    """回收站列表（按删除时间倒序）。

    deleted_at 从文件名的 `<YYYYMMDD>-<HHMMSS>-` 前缀解析 —— 那是删除动作发生的时刻。
    不要用 path.stat().st_mtime：shutil.move 会**保留原文件的修改时间**，
    那样显示的会是「笔记最后一次修改时间」，而不是「被删除的时间」。
    """
    if not TRASH_DIR.exists():
        return []
    items = []
    for path in sorted(TRASH_DIR.glob("*.md"), reverse=True):
        m = re.match(r"^(\d{8})-(\d{6})-(.+)$", path.name)
        if m:
            d, t, orig = m.group(1), m.group(2), m.group(3)
            deleted_at = f"{d[:4]}-{d[4:6]}-{d[6:]} {t[:2]}:{t[2:4]}"
        else:
            deleted_at = datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
            orig = path.name
        try:
            title = read_note(path)["title"]
        except Exception:  # noqa: BLE001
            title = orig
        items.append({
            "name": path.name,
            "title": title,
            "size": path.stat().st_size if path.exists() else 0,
            "deleted_at": deleted_at,
            "original": orig,
        })
    return items


# ==========================================================================
# 构建
# ==========================================================================
def run_build() -> dict:
    if CLI_ARGS is not None and CLI_ARGS.no_rebuild:
        return {"ok": True, "skipped": True, "output": "已跳过自动重建（--no-rebuild）"}
    with BUILD_LOCK:
        # 必须显式给子进程 UTF-8 输出环境：中文 Windows 的默认代码页是 GBK，
        # 而 build.py 的统计输出含 emoji（GBK 无法编码），会直接抛
        # UnicodeEncodeError 让整个构建失败。build.py 自身也做了 reconfigure 兜底，
        # 这里再加一层，避免将来换脚本时又踩同一个坑。
        build_env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        proc = subprocess.run(
            [sys.executable, str(ROOT / "build.py")],
            cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=build_env,
        )
    tail = [ln for ln in (proc.stdout or "").strip().splitlines() if ln.strip()][-6:]
    if proc.returncode == 0:
        return {"ok": True, "code": 0, "output": "\n".join(tail)}

    # 构建失败：异常详情在 stderr。切勿只回传末 500 字符 —— 完整 traceback 往往
    # 更长，截尾后只剩 "Traceback (most recent call last): ... ~~~~^^" 这类开头，
    # 真正指出原因的那一行（异常类型与消息）恰恰在**末尾**，会被切掉（真实踩过）。
    # 因此同时给出：完整文本（供排查）+ 末行的异常摘要（供界面直接展示）。
    err = (proc.stderr or "").strip()
    summary = ""
    for line in reversed([l for l in err.splitlines() if l.strip()]):
        if re.match(r"^\w+(\.\w+)*(Error|Exception|Warning)\b", line.strip()):
            summary = line.strip()
            break
    if not summary:
        last = [l for l in err.splitlines() if l.strip()]
        summary = last[-1].strip() if last else f"build.py 退出码 {proc.returncode}"
    return {
        "ok": False,
        "code": proc.returncode,
        "error": summary,
        "output": err[-4000:],
    }


# ==========================================================================
# 请求处理
# ==========================================================================
class Handler(BaseHTTPRequestHandler):
    server_version = "SecNotesAdmin"
    protocol_version = "HTTP/1.1"

    # ---------------- 基础工具 ----------------
    def log_message(self, fmt, *args):  # 精简日志
        if self.path.startswith("/api/"):
            sys.stderr.write(f"  {self.command} {self.path}\n")

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8", extra=self._cors_headers())

    def _fail(self, msg: str, code: int = 400):
        self._json({"ok": False, "error": msg}, code)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        # 上限需容纳 8MB 图片的 base64（约 10.7MB）后再留出余量
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("请求体为空或过大")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    # file:// 页面的 fetch 会带上 Origin: null，属于本地使用场景，允许；
    # 其它站点（Origin 是它自己的域名）一律拒绝，避免任意网页调用本服务写文件。
    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin or origin == "null":
            return True
        return re.match(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$", origin) is not None

    def _cors_headers(self) -> dict:
        origin = self.headers.get("Origin") or "*"
        return {
            "Access-Control-Allow-Origin": origin if self._origin_ok() else "null",
            "Access-Control-Allow-Headers": "X-Admin-Token, Content-Type",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Vary": "Origin",
        }

    def _auth_ok(self) -> bool:
        if self.headers.get("X-Admin-Token") != TOKEN:
            self._fail("缺少或无效的访问令牌，请通过启动时打印的地址访问", 403)
            return False
        if not self._origin_ok():
            self._fail("来源不被允许", 403)
            return False
        return True

    # ---------------- 路由 ----------------
    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        route, query = parsed.path, parse_qs(parsed.query)

        # 令牌下发（JSONP）：file:// 页面读不到本地文件，但可以跨域加载脚本。
        # 只在来源是本地（含 file:// 的 Origin: null）时给，第三方站点拿不到。
        if route == "/api/token.js":
            if not self._origin_ok():
                return self._fail("来源不被允许", 403)
            # 一并下发「是否跳过重建」：管理端据此提前警告，
            # 否则 --no-rebuild 会让同步静默不更新展示端，问题很难被发现。
            no_rebuild = "true" if (CLI_ARGS is not None and CLI_ARGS.no_rebuild) else "false"
            body = (f"window.SEC_SYNC_TOKEN = {json.dumps(TOKEN)};\n"
                    f"window.SEC_SYNC_PORT = {self.server.server_address[1]};\n"
                    f"window.SEC_SYNC_NO_REBUILD = {no_rebuild};\n").encode("utf-8")
            return self._send(200, body, "application/javascript; charset=utf-8",
                              extra=self._cors_headers())

        if route == "/api/version.js":
            # 站点数据版本戳（JSONP，免令牌）。
            # 展示端据此判断「站点数据是否已更新」，需要刷新就自行重载。
            #
            # 为什么不用 localStorage 传信号：那个方案依赖「同 origin」，
            # 而 manage.html 常以 file:// 打开、展示端常以 http://127.0.0.1:8080 打开，
            # 两者跨 origin，localStorage 与 BroadcastChannel **完全不通**，
            # 于是「管理端删了、展示端没反应」。script 标签不受同源策略限制，
            # 用 JSONP 走服务端中转，才能覆盖所有打开组合。
            if not self._origin_ok():
                return self._fail("来源不被允许", 403)
            try:
                stamp = str(int((ROOT / "data" / "notes.js").stat().st_mtime))
            except OSError:
                stamp = "0"
            body = f'window.SEC_SITE_VERSION = "{stamp}";\n'.encode("utf-8")
            return self._send(200, body, "application/javascript; charset=utf-8",
                              extra=self._cors_headers())

        if route.startswith("/api/"):
            if not self._auth_ok():
                return
            return self._api_get(route, query)
        return self._serve_static(route)

    def do_OPTIONS(self):  # noqa: N802
        """CORS 预检：file:// 页面发自定义头前会先发 OPTIONS。"""
        if self._origin_ok():
            self._send(204, b"", "text/plain; charset=utf-8", extra=self._cors_headers())
        else:
            self._fail("来源不被允许", 403)

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        if not self._auth_ok():
            return
        try:
            payload = self._read_json()
        except Exception as e:  # noqa: BLE001
            return self._fail(f"请求体解析失败：{e}")
        return self._api_post(parsed.path, payload)

    # ---------------- 静态资源 ----------------
    def _serve_static(self, route: str):
        if route in ("/", "/admin", "/admin/"):
            if not ADMIN_INDEX.exists():
                return self._send(500, b"admin/index.html missing", "text/plain; charset=utf-8")
            html = ADMIN_INDEX.read_text(encoding="utf-8").replace("__ADMIN_TOKEN__", TOKEN)
            return self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")

        rel = unquote(route).lstrip("/")
        # 只对外提供站点运行所需的资源；notes/、.trash/ 等写作产物不经 HTTP 暴露
        if not static_allowed(rel):
            return self._send(404, b"Not Found", "text/plain; charset=utf-8")

        target = (ROOT / rel).resolve()
        if not str(target).startswith(str(ROOT)) or not target.is_file():
            return self._send(404, b"Not Found", "text/plain; charset=utf-8")

        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    # ---------------- GET API ----------------
    def _api_get(self, route: str, query: dict):
        if route == "/api/state":
            notes = list_notes()
            cats: dict[str, int] = {}
            tags: dict[str, int] = {}
            for n in notes:
                cats[n["category"]] = cats.get(n["category"], 0) + 1
                for t in n["tags"]:
                    tags[t] = tags.get(t, 0) + 1
            meta = [{"slug": n["slug"], "title": n["title"], "date": n["date"],
                     "category": n["category"], "tags": n["tags"], "draft": n["draft"],
                     "words": n["words"], "mtime": n["mtime"]} for n in notes]
            # 链接图与 build.py 共用同一实现，保证编辑器与站点判断一致
            graph = builder.build_link_graph(
                [(n["slug"], n["title"], n["body"]) for n in notes])
            return self._json({
                "ok": True,
                "notes": meta,
                "categories": sorted(cats.items(), key=lambda kv: (-kv[1], kv[0])),
                "tags": sorted(tags.items(), key=lambda kv: (-kv[1], kv[0])),
                "trash": list_trash(),
                "links": graph["links"],
                "backlinks": graph["backlinks"],
                "broken": graph["broken"],
            })

        if route == "/api/search":
            raw = (query.get("q") or [""])[0]
            try:
                limit = max(1, min(int((query.get("limit") or ["60"])[0]), 200))
            except ValueError:
                limit = 60
            return self._json(search_notes(raw, limit))

        if route == "/api/note":
            slug = (query.get("slug") or [""])[0]
            try:
                path = slug_to_path(slug)
            except ValueError as e:
                return self._fail(str(e))
            if not path.is_file():
                return self._fail("笔记不存在", 404)
            return self._json({"ok": True, "note": read_note(path)})

        if route == "/api/notice":
            notice = {"enabled": False, "text": ""}
            if NOTICE_FILE.exists():
                try:
                    n = json.loads(NOTICE_FILE.read_text(encoding="utf-8"))
                    notice = {"enabled": bool(n.get("enabled")), "text": str(n.get("text") or "")}
                except Exception:  # noqa: BLE001
                    pass
            return self._json({"ok": True, "notice": notice})

        return self._fail("未知接口", 404)

    # ---------------- POST API ----------------
    def _api_post(self, route: str, payload: dict):
        try:
            if route == "/api/note":
                return self._save_note(payload)
            if route == "/api/upload":
                return self._upload_image(payload)
            if route == "/api/delete":
                return self._delete_note(payload)
            if route == "/api/restore":
                return self._restore_note(payload)
            if route == "/api/purge":
                return self._purge_trash(payload)
            if route == "/api/rebuild":
                return self._json({"ok": True, "build": run_build()})
            if route == "/api/sync":
                return self._sync_notes(payload)
            if route == "/api/notice":
                return self._save_notice(payload)
        except ValueError as e:
            return self._fail(str(e))
        except Exception as e:  # noqa: BLE001
            return self._fail(f"服务器内部错误：{e}", 500)
        return self._fail("未知接口", 404)

    def _save_notice(self, payload: dict):
        """保存站点维护通知：enabled 开关 + 纯文本内容。"""
        enabled = bool(payload.get("enabled"))
        text = str(payload.get("text") or "").strip()
        NOTICE_FILE.write_text(
            json.dumps({"enabled": enabled, "text": text}, ensure_ascii=False, indent=2),
            encoding="utf-8")
        return self._json({"ok": True, "notice": {"enabled": enabled, "text": text}})

    def _upload_image(self, payload: dict):
        """接收 base64 图片，按内容摘要命名存入 assets/uploads/<年月>/。

        内容寻址：同一张图重复上传不会产生冗余文件。
        刻意不支持 SVG —— SVG 可内嵌脚本，一旦站点公开部署会变成同源 XSS 载体。
        """
        data_url = str(payload.get("dataUrl") or "")
        m = re.match(r"^data:image/([A-Za-z0-9.+-]+);base64,(.+)$", data_url, re.S)
        if not m:
            return self._fail("仅支持图片（需为 base64 data URL）")

        kind = m.group(1).lower()
        ext = IMAGE_TYPES.get(kind)
        if not ext:
            return self._fail(f"不支持的图片类型：{kind}（支持 png / jpg / gif / webp）")

        try:
            raw = base64.b64decode(m.group(2), validate=True)
        except Exception:  # noqa: BLE001
            return self._fail("图片数据解析失败，可能传输不完整")
        if not raw:
            return self._fail("图片内容为空")
        if len(raw) > MAX_UPLOAD_BYTES:
            return self._fail(f"图片超过 {MAX_UPLOAD_BYTES // 1024 // 1024}MB 上限")

        month = datetime.now().strftime("%Y%m")
        dest_dir = UPLOADS_DIR / month
        dest_dir.mkdir(parents=True, exist_ok=True)

        digest = hashlib.sha1(raw).hexdigest()[:10]
        hint = re.sub(r"[^A-Za-z0-9_-]", "", str(payload.get("slug") or ""))[:32]
        name = f"{hint + '-' if hint else ''}{digest}.{ext}"
        path = dest_dir / name
        existed = path.exists()
        if not existed:
            path.write_bytes(raw)

        # 相对路径：站点直接双击打开（file://）时同样能取到图
        url = f"assets/uploads/{month}/{name}"
        return self._json({
            "ok": True,
            "url": url,
            "markdown": f"![图片]({url})",
            "bytes": len(raw),
            "deduped": existed,
        })

    def _save_note(self, payload: dict):
        meta = dict(payload.get("meta") or {})
        body = str(payload.get("body") or "")
        origin_slug = str(payload.get("slug") or "").strip()
        target_slug = str(meta.get("slug") or "").strip() or origin_slug or builder.slugify(
            str(meta.get("title") or "")) or "note"
        if not SLUG_RE.match(target_slug):
            target_slug = builder.slugify(target_slug)

        path = slug_to_path(target_slug)

        # 定位原始文件：存在 → 视为修改；不存在 → 视为新建
        origin_path = None
        if origin_slug:
            try:
                candidate = slug_to_path(origin_slug)
                if candidate.is_file():
                    origin_path = candidate
            except ValueError:
                origin_path = None

        created = origin_path is None

        # 新建时若目标文件已存在，直接拒绝——绝不允许静默覆盖已有笔记
        if created and path.exists():
            return self._fail(
                f"文件已存在：{target_slug}.md。请换一个文件名，或先打开该笔记再保存")

        renamed = bool(origin_path and origin_path != path)

        write_note(path, meta, body)
        if renamed:
            origin_path.unlink(missing_ok=True)

        result = run_build()
        saved = read_note(path)
        return self._json({
            "ok": True,
            "created": created,
            "renamed": renamed,
            "note": saved,
            "build": result,
            "warnings": self._collect_warnings(result),
        })

    def _collect_warnings(self, result: dict) -> list[str]:
        return [ln.strip() for ln in (result.get("output") or "").splitlines()
                if ln.strip().startswith(("·", "⚠"))]

    def _sync_notes(self, payload: dict):
        """管理端一键同步：把整份本地库写回 notes/ 并重建站点。

        · 写入：逐篇覆盖（管理端是唯一数据源，与"绝不静默覆盖他人文件"不冲突——
          这些文件名由管理端库里的笔记决定）。
        · 删除：payload.removed 里的笔记移入 .trash/ 回收站，可还原，不做物理删除。
        · 最后统一执行一次 build.py，返回构建输出。
        """
        notes = payload.get("notes")
        removed = payload.get("removed")
        # 允许"只删不写"的同步（notes 为空但 removed 非空）
        if not isinstance(notes, list):
            return self._fail("notes 必须是数组")
        if not notes and not (isinstance(removed, list) and removed):
            return self._fail("没有需要同步的笔记")

        written: list[str] = []
        skipped: list[str] = []
        for raw in notes:
            if not isinstance(raw, dict):
                skipped.append("格式不正确的记录")
                continue
            slug = builder.slugify(str(raw.get("slug") or raw.get("title") or ""))
            if not slug or not SLUG_RE.match(slug) or slug.startswith((".", "_")):
                skipped.append(str(raw.get("title") or raw.get("slug") or "（无标题）")[:40])
                continue
            builder.write_note_file(NOTES_DIR / f"{slug}.md", {
                "title": raw.get("title") or slug,
                "date": raw.get("date") or "",
                "category": raw.get("category") or "未分类",
                "tags": raw.get("tags") or [],
                "summary": raw.get("summary") or "",
                "draft": bool(raw.get("draft")),
            }, raw.get("body") or "")
            written.append(slug)

        # 管理端里删掉的笔记：移入回收站而不是直接删除
        trashed: list[str] = []
        if isinstance(removed, list):
            TRASH_DIR.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            for item in removed:
                slug = builder.slugify(str(item or ""))
                if not slug or not SLUG_RE.match(slug) or slug.startswith((".", "_")):
                    continue
                path = NOTES_DIR / f"{slug}.md"
                if not path.is_file():
                    continue
                dest = TRASH_DIR / f"{stamp}-{path.name}"
                shutil.move(str(path), str(dest))
                trashed.append(dest.name)

        if not written and not trashed:
            return self._fail("没有任何可写入的笔记")

        result = run_build()
        return self._json({
            "ok": True,
            "written": len(written),
            "writtenSlugs": written,
            "trashed": trashed,
            "skipped": skipped,
            "build": result,
            "warnings": self._collect_warnings(result),
        })

    def _delete_note(self, payload: dict):
        slug = str(payload.get("slug") or "")
        path = slug_to_path(slug)
        if not path.is_file():
            return self._fail("笔记不存在", 404)

        TRASH_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        dest = TRASH_DIR / f"{stamp}-{path.name}"
        shutil.move(str(path), str(dest))

        result = run_build()
        return self._json({
            "ok": True,
            "trashed": dest.name,
            "canRestore": True,
            "build": result,
        })

    def _restore_note(self, payload: dict):
        name = str(payload.get("name") or "")
        src = (TRASH_DIR / name).resolve()
        if src.parent != TRASH_DIR.resolve() or not src.is_file():
            return self._fail("回收站中找不到该文件", 404)

        # 还原文件名：去掉 "时间戳-" 前缀
        stem = re.sub(r"^\d{8}-\d{6}-", "", src.name)
        dest = NOTES_DIR / stem
        if dest.exists():
            dest = NOTES_DIR / f"{dest.stem}-restored{dest.suffix}"
        NOTES_DIR.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dest))

        result = run_build()
        return self._json({"ok": True, "restored": dest.name, "build": result})

    def _purge_trash(self, payload: dict):
        name = str(payload.get("name") or "")
        src = (TRASH_DIR / name).resolve()
        if src.parent != TRASH_DIR.resolve() or not src.is_file():
            return self._fail("回收站中找不到该文件", 404)
        if not payload.get("confirm"):
            return self._fail("彻底删除需要显式确认参数")
        src.unlink()
        return self._json({"ok": True, "purged": name})


# ==========================================================================
# 启动
# ==========================================================================
def main() -> int:
    global CLI_ARGS
    parser = argparse.ArgumentParser(description="SecNotes 本地内容管理服务")
    parser.add_argument("--port", type=int, default=8080, help="监听端口，默认 8080")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认仅本机")
    parser.add_argument("--no-rebuild", action="store_true", help="保存后不自动重建站点数据")
    CLI_ARGS = parser.parse_args()

    if not ADMIN_INDEX.exists():
        print(f"✗ 找不到 {ADMIN_INDEX}，无法启动编辑器")
        return 1

    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    url = f"http://{CLI_ARGS.host}:{CLI_ARGS.port}/?token={TOKEN}"
    count = len(list_notes())

    print("\n" + "=" * 62)
    print("  SecNotes 内容编辑器")
    print("=" * 62)
    print(f"  笔记目录 : {NOTES_DIR}")
    print(f"  现有笔记 : {count} 篇")
    print(f"  回收站   : {TRASH_DIR}（删除的笔记会移到这里，可还原）")
    print(f"  图片目录 : {UPLOADS_DIR}（粘贴/拖入的截图会存到这里）")
    print(f"\n  打开下面的地址进行编辑（含访问令牌，请勿分享）：\n")
    print(f"  {url}\n")
    print("  站点预览 : " + f"http://{CLI_ARGS.host}:{CLI_ARGS.port}/index.html")
    print("  管理端   : 直接双击 manage.html 也能用；**保持本窗口运行**，")
    print("             管理端点保存后即可一键写回 notes/ 并重建站点。")
    print("  停止服务 : Ctrl+C（停止后管理端回到「导出」模式）")
    if CLI_ARGS.no_rebuild:
        print()
        print("  ⚠ 已启用 --no-rebuild：同步只把文件写回 notes/，")
        print("     **不会重建 data/notes.js**，展示端因此不会更新。")
        print("     改完笔记需要手动运行：python build.py")
    print("=" * 62 + "\n")

    httpd = ThreadingHTTPServer((CLI_ARGS.host, CLI_ARGS.port), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
