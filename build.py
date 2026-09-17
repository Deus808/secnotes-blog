#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SecNotes 构建脚本
-----------------
扫描 notes/ 目录下的所有 Markdown 笔记，解析 front-matter 元数据，
生成前端可直接读取的 data/notes.js（以 JS 变量形式内联，规避 file:// 协议下
浏览器禁止 fetch 本地文件的问题，使站点双击 index.html 即可运行）。

用法：
    python build.py                       # 构建
    python build.py --check               # 只做校验，不写文件
    python build.py --stats               # 打印统计信息
    python build.py --gc-images           # 列出未被引用的上传图片（只列出）
    python build.py --gc-images --yes     # 确认删除上述图片
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape as xml_escape

# --------------------------------------------------------------------------
# 标准输出强制 UTF-8
# --------------------------------------------------------------------------
# 中文 Windows 的控制台与管道默认使用 GBK（cp936），而 GBK 无法编码 emoji
# （本脚本的统计输出用了 📚🗂🏷 等）。一旦被以 GBK 为标准输出的进程调用
# （例如 admin.py 用管道捕获本脚本的输出），第一条 print 就会抛
# UnicodeEncodeError 导致**整个构建失败**，且报错里中文路径还会显示成乱码，
# 极难定位。这里统一改成 UTF-8 + errors="replace"，保证任何终端下都能正常输出。
try:  # reconfigure 需要 Python 3.7+；失败也不该影响构建本身
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

ROOT = Path(__file__).resolve().parent
NOTES_DIR = ROOT / "notes"
DATA_DIR = ROOT / "data"
CONFIG_FILE = ROOT / "blog.config.json"

CJK_RE = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")
WORD_RE = re.compile(r"[A-Za-z0-9_]+")
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
# 双向链接：[[笔记标题]] 或 [[笔记标题|显示文字]]
WIKILINK_RE = re.compile(r"\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]")


# --------------------------------------------------------------------------
# 数据结构
# --------------------------------------------------------------------------
@dataclass
class Note:
    slug: str
    title: str
    date: str
    category: str
    tags: list[str] = field(default_factory=list)
    summary: str = ""
    body: str = ""
    source: str = ""
    words: int = 0
    reading_time: int = 1
    updated: str = ""
    draft: bool = False


# --------------------------------------------------------------------------
# front-matter 解析（手写轻量解析器，避免引入 PyYAML 依赖）
# --------------------------------------------------------------------------
def split_front_matter(text: str) -> tuple[dict, str]:
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    if not text.startswith("---"):
        return {}, text

    lines = text.split("\n")
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() in ("---", "..."):
            end = i
            break
    if end is None:
        return {}, text

    raw_meta = lines[1:end]
    body = "\n".join(lines[end + 1:]).strip("\n")

    meta: dict = {}
    current_key: str | None = None
    for line in raw_meta:
        if not line.strip() or line.strip().startswith("#"):
            continue
        # 列表续行： "- item"
        m_list = re.match(r"^\s+-\s+(.*)$", line)
        if m_list and current_key:
            meta.setdefault(current_key, [])
            if isinstance(meta[current_key], list):
                meta[current_key].append(_strip_quotes(m_list.group(1).strip()))
            continue
        m_kv = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", line)
        if not m_kv:
            continue
        key, value = m_kv.group(1).lower(), m_kv.group(2).strip()
        current_key = key
        if value == "":
            meta[key] = []
        elif value.startswith("[") and value.endswith("]"):
            items = [x.strip() for x in value[1:-1].split(",")]
            meta[key] = [_strip_quotes(x) for x in items if x]
        else:
            meta[key] = _strip_quotes(value)
    return meta, body


def _strip_quotes(s: str) -> str:
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        return s[1:-1]
    return s


def as_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return [x.strip() for x in re.split(r"[,，、;；]", str(value)) if x.strip()]


# --------------------------------------------------------------------------
# 双向链接图（[[标题]] → 出链 / 入链 / 待创建）
# --------------------------------------------------------------------------
def build_link_graph(items: list[tuple[str, str, str]]) -> dict:
    """根据 (slug, title, body) 三元组计算链接关系。

    站点（build.py）与编辑器（admin.py）共用这一份实现，避免两处规则漂移。
    链接目标先按标题匹配，再退回按 slug 匹配；均无命中则计入「待创建」。
    """
    by_title: dict[str, str] = {}
    by_slug: dict[str, str] = {}
    for slug, title, _ in items:
        by_title.setdefault(title.strip().lower(), slug)
        by_slug.setdefault(slug.strip().lower(), slug)

    links: dict[str, list[str]] = {}
    broken: dict[str, list[str]] = {}
    backlinks: dict[str, list[str]] = {slug: [] for slug, _, _ in items}

    for slug, _, body in items:
        targets: list[str] = []
        missing: list[str] = []
        for m in WIKILINK_RE.finditer(body or ""):
            raw = m.group(1).strip()
            key = raw.lower()
            target = by_title.get(key) or by_slug.get(key)
            if not target:
                missing.append(raw)
            elif target != slug and target not in targets:
                targets.append(target)
        links[slug] = targets
        broken[slug] = list(dict.fromkeys(missing))
        for t in targets:
            backlinks.setdefault(t, [])
            if slug not in backlinks[t]:
                backlinks[t].append(slug)

    return {"links": links, "backlinks": backlinks, "broken": broken}


# --------------------------------------------------------------------------
# 正文处理
# --------------------------------------------------------------------------
def strip_markdown(md: str) -> str:
    """粗略剥离 Markdown 标记，用于生成摘要与搜索文本。"""
    text = re.sub(r"```[\s\S]*?```", " ", md)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"^\s{0,3}#{1,6}\s+", "", text, flags=re.M)
    text = re.sub(r"^\s{0,3}>\s?", "", text, flags=re.M)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.M)
    text = re.sub(r"^\s*\|.*\|\s*$", " ", text, flags=re.M)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def make_summary(body: str, limit: int = 130) -> str:
    for para in strip_markdown(body).split("\n"):
        para = para.strip()
        if len(para) >= 20 and not para.startswith(("http://", "https://")):
            return para[:limit] + ("…" if len(para) > limit else "")
    plain = strip_markdown(body)
    return plain[:limit] + ("…" if len(plain) > limit else "")


def count_words(text: str) -> int:
    plain = strip_markdown(text)
    return len(CJK_RE.findall(plain)) + len(WORD_RE.findall(plain))


def slugify(name: str) -> str:
    """把标题 / 文件名规整成 slug。

    规则必须与前端 assets/js/manage.js 的 slugify **完全一致**：
    否则管理端认为这篇叫 X、写盘却成了 Y，同一篇笔记会被当成两篇
    （曾导致「保存一次就多一篇文章」）。空输入返回空串，
    由调用方决定是拒绝保存还是另作处理 —— **绝不在这里编造名字**。
    """
    s = str(name or "").strip().lower()
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"[^a-z0-9\u4e00-\u9fff-]", "", s)
    return re.sub(r"-{2,}", "-", s).strip("-")


def first_heading(body: str) -> str:
    for line in body.split("\n"):
        m = HEADING_RE.match(line)
        if m:
            return strip_markdown(m.group(2))
    return ""


# --------------------------------------------------------------------------
# 写回 Markdown（build.py 与 admin.py 共用这一份序列化实现）
# --------------------------------------------------------------------------
def yaml_scalar(value) -> str:
    """按需给 front-matter 值加引号，保证能被解析器正确读回。"""
    s = str(value if value is not None else "")
    need_quote = (
        s == ""
        or s != s.strip()
        or re.search(r'[:#\[\]{},&*?|>%@`"\']', s) is not None
        or s.lower() in ("true", "false", "null", "~", "yes", "no")
        or re.fullmatch(r"-?\d+(\.\d+)?", s) is not None
    )
    if not need_quote:
        return s
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def render_front_matter(meta: dict) -> str:
    lines = ["---"]
    lines.append(f"title: {yaml_scalar(meta.get('title', ''))}")
    lines.append(f"date: {yaml_scalar(meta.get('date') or datetime.now().strftime('%Y-%m-%d'))}")
    lines.append(f"category: {yaml_scalar(meta.get('category') or '未分类')}")
    lines.append("tags: [" + ", ".join(yaml_scalar(t) for t in as_list(meta.get("tags"))) + "]")
    summary = str(meta.get("summary") or "").strip()
    if summary:
        lines.append(f"summary: {yaml_scalar(summary)}")
    if meta.get("draft"):
        lines.append("draft: true")
    lines.append("---")
    return "\n".join(lines)


def write_note_file(path: Path, meta: dict, body: str) -> None:
    body = str(body or "").replace("\r\n", "\n").replace("\r", "\n").strip("\n")
    path.write_text(render_front_matter(meta) + "\n\n" + body + "\n", encoding="utf-8")


def import_from_json(json_path: Path) -> tuple[int, list[str]]:
    """把管理端导出的 notes.json 落回 notes/ 目录。

    返回 (写入篇数, 问题列表)。只写笔记文件，不删除任何已存在的文件——
    删除是破坏性操作，交给用户决定（回收站机制在 admin.py 里）。
    """
    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        return 0, [f"读取 {json_path.name} 失败：{e}"]

    items = data.get("notes") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return 0, ["JSON 里没有找到 notes 数组"]

    problems: list[str] = []
    written = 0
    seen: set[str] = set()
    for raw in items:
        if not isinstance(raw, dict):
            problems.append("跳过一条格式不正确的记录（不是对象）")
            continue
        slug = slugify(raw.get("slug") or raw.get("title") or "")
        if not slug or slug == "note":
            problems.append(f"跳过一条没有标题/文件名的记录：{str(raw)[:40]}")
            continue
        if slug in seen:
            problems.append(f"JSON 内重复的文件名：{slug}")
            continue
        seen.add(slug)
        write_note_file(NOTES_DIR / f"{slug}.md", {
            "title": raw.get("title") or slug,
            "date": raw.get("date") or "",
            "category": raw.get("category") or "未分类",
            "tags": raw.get("tags") or [],
            "summary": raw.get("summary") or "",
            "draft": bool(raw.get("draft")),
        }, raw.get("body") or "")
        written += 1

    return written, problems


# --------------------------------------------------------------------------
# 校验
# --------------------------------------------------------------------------
def validate(note: Note, problems: list[str]) -> None:
    where = note.source
    if not note.title:
        problems.append(f"[标题缺失] {where} —— front-matter 中缺少 title")
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", note.date or ""):
        problems.append(f"[日期异常] {where} —— date 应为 YYYY-MM-DD，当前为 {note.date!r}")
    if not note.body.strip():
        problems.append(f"[正文为空] {where}")

    fences = sum(1 for line in note.body.split("\n") if FENCE_RE.match(line))
    if fences % 2 != 0:
        problems.append(f"[代码块未闭合] {where} —— 检测到 {fences} 个围栏标记，数量应为偶数")

    if note.draft:
        problems.append(f"[草稿] {where} —— draft: true，已跳过收录")


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def collect() -> tuple[list[Note], list[str]]:
    notes: list[Note] = []
    problems: list[str] = []
    if not NOTES_DIR.exists():
        return notes, [f"笔记目录不存在：{NOTES_DIR}"]

    seen_slug: dict[str, str] = {}
    seen_title: dict[str, str] = {}

    for path in sorted(NOTES_DIR.rglob("*.md")):
        if path.name.startswith("_"):
            continue
        meta, body = split_front_matter(path.read_text(encoding="utf-8", errors="replace"))
        rel = path.relative_to(ROOT).as_posix()

        slug = str(meta.get("slug") or slugify(path.stem))
        stat = path.stat()
        date = str(meta.get("date") or datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d"))
        title = str(meta.get("title") or first_heading(body) or path.stem)

        note = Note(
            slug=slug,
            title=title,
            date=date,
            category=str(meta.get("category") or "未分类"),
            tags=as_list(meta.get("tags")),
            summary=str(meta.get("summary") or make_summary(body)),
            body=body,
            source=rel,
            updated=datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d"),
            draft=bool(meta.get("draft", False)),
        )
        note.words = count_words(body)
        note.reading_time = max(1, math.ceil(note.words / 400))

        validate(note, problems)
        if note.draft:
            continue
        if slug in seen_slug:
            problems.append(f"[slug 重复] {rel} 与 {seen_slug[slug]} 冲突，已自动加后缀")
            note.slug = f"{slug}-{len(notes) + 1}"
        if title in seen_title:
            problems.append(f"[标题重复] {rel} 与 {seen_title[title]} 同名")
        seen_slug[note.slug] = rel
        seen_title[title] = rel
        notes.append(note)

    notes.sort(key=lambda n: (n.date, n.slug), reverse=True)
    return notes, problems


def build_index(notes: list[Note]) -> dict:
    categories: dict[str, int] = {}
    tags: dict[str, int] = {}
    for n in notes:
        categories[n.category] = categories.get(n.category, 0) + 1
        for t in n.tags:
            tags[t] = tags.get(t, 0) + 1
    return {
        "categories": sorted(categories.items(), key=lambda kv: (-kv[1], kv[0])),
        "tags": sorted(tags.items(), key=lambda kv: (-kv[1], kv[0])),
    }


def write_output(notes: list[Note], index: dict, config: dict) -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    graph = build_link_graph([(n.slug, n.title, n.body) for n in notes])
    payload = {
        "config": config,
        "stats": {
            "notes": len(notes),
            "categories": len(index["categories"]),
            "tags": len(index["tags"]),
            "words": sum(n.words for n in notes),
            "builtAt": datetime.now().strftime("%Y-%m-%d %H:%M"),
        },
        "categories": index["categories"],
        "tags": index["tags"],
        "notes": [asdict(n) for n in notes],
        "links": graph["links"],
        "backlinks": graph["backlinks"],
        "broken": graph["broken"],
    }
    out = DATA_DIR / "notes.js"
    body = json.dumps(payload, ensure_ascii=False, indent=0, separators=(",", ":"))
    banner = (
        "/* 本文件由 build.py 自动生成，请勿手动修改。\n"
        "   新增笔记：在 notes/ 目录下新建 .md 文件后重新运行 python build.py */\n"
    )
    out.write_text(f"{banner}window.SEC_BLOG = {body};\n", encoding="utf-8")
    return out


def gc_images(confirm: bool) -> int:
    """列出（并在显式确认后删除）没有任何笔记引用的上传图片。"""
    if not UPLOADS_DIR.exists():
        print("\n🖼  还没有上传过图片，跳过。\n")
        return 0

    orphans = find_orphan_images()
    if not orphans:
        print("\n🖼  图片目录干净，没有未引用的文件。\n")
        return 0

    total = sum(size for _, size in orphans)
    print(f"\n🖼  发现 {len(orphans)} 个未被任何笔记引用的图片，合计 {total / 1024:.1f} KB：")
    for rel, size in orphans:
        print(f"   · {rel}   {size / 1024:.1f} KB")

    if not confirm:
        print("\n⚠ 当前为预览模式，未删除任何文件。")
        print("  已确认这些图片确实不再需要时，执行：")
        print("    python build.py --gc-images --yes\n")
        return 0

    for rel, _ in orphans:
        (ROOT / rel).unlink(missing_ok=True)
    print(f"\n🧹 已删除 {len(orphans)} 个文件，释放 {total / 1024:.1f} KB。\n")
    return 0


def load_config() -> dict:
    default = {
        "title": "SecNotes",
        "subtitle": "网络安全知识笔记",
        "description": "",
        "author": "",
        "footer": "",
        "defaultTheme": "dark",
        "pageSize": 8,
        "siteUrl": "",
    }
    if CONFIG_FILE.exists():
        try:
            default.update(json.loads(CONFIG_FILE.read_text(encoding="utf-8")))
        except json.JSONDecodeError as e:
            print(f"⚠ blog.config.json 解析失败，使用默认配置：{e}")
    return default


# --------------------------------------------------------------------------
# 图片引用检查（未引用的上传图片清理）
# --------------------------------------------------------------------------
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
UPLOADS_DIR = ROOT / "assets" / "uploads"


def _image_refs(text: str) -> set[str]:
    """提取正文中引用的图片路径（Markdown 与 HTML 两种写法）。"""
    refs: set[str] = set()
    for m in re.finditer(r"!?\[[^\]]*\]\(\s*([^)\s]+)", text):
        refs.add(m.group(1))
    for m in re.finditer(r"<img[^>]*?\ssrc\s*=\s*[\"']([^\"']+)", text, re.I):
        refs.add(m.group(1))
    return refs


def collect_image_refs() -> set[str]:
    """收集所有被引用的图片。

    刻意扫描 notes/ 下的**全部** Markdown（含草稿与 _ 前缀文件），
    并连同 .trash/ 一起纳入——否则草稿或可还原笔记用到的图片会被误判为孤儿。
    """
    used: set[str] = set()
    sources: list[Path] = []
    for base in (NOTES_DIR, ROOT / ".trash"):
        if base.exists():
            sources.extend(base.rglob("*.md"))

    for path in sources:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for ref in _image_refs(text):
            ref = ref.strip().lstrip("./").lstrip("/")
            if not ref:
                continue
            used.add(ref)
            used.add(Path(ref).name)  # 同时按文件名比对，容忍路径写法差异
    return used


def find_orphan_images() -> list[tuple[str, int]]:
    if not UPLOADS_DIR.exists():
        return []
    used = collect_image_refs()
    orphans: list[tuple[str, int]] = []
    for path in sorted(UPLOADS_DIR.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in IMAGE_EXT:
            continue
        rel = path.relative_to(ROOT).as_posix()
        if rel in used or path.name in used:
            continue
        orphans.append((rel, path.stat().st_size))
    return orphans


# --------------------------------------------------------------------------
# RSS 2.0 与 sitemap.xml（仅在配置了 siteUrl 时生成）
# --------------------------------------------------------------------------
_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _rfc822(date_str: str) -> str:
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        dt = datetime.now()
    return f"{_DAYS[dt.weekday()]}, {dt.day:02d} {_MONTHS[dt.month - 1]} {dt.year} 00:00:00 +0800"


def _note_url(base: str, slug: str) -> str:
    # 站点为 hash 路由的单页应用，笔记地址形如 <base>/#/note/<slug>
    return f"{base}/#/note/{quote(slug)}"


def write_feed(notes: list[Note], config: dict) -> None:
    base = str(config.get("siteUrl") or "").strip().rstrip("/")
    if not base:
        print("ℹ 未配置 siteUrl，跳过 rss.xml / sitemap.xml（部署后再填即可生成）")
        return

    title = config.get("title") or "SecNotes"
    desc = config.get("description") or config.get("subtitle") or ""
    author = config.get("author") or ""
    esc = xml_escape

    items = "\n".join(
        "    <item>\n"
        f"      <title>{esc(n.title)}</title>\n"
        f"      <link>{esc(_note_url(base, n.slug))}</link>\n"
        f"      <guid isPermaLink=\"false\">{esc(_note_url(base, n.slug))}</guid>\n"
        f"      <pubDate>{_rfc822(n.date)}</pubDate>\n"
        f"      <category>{esc(n.category)}</category>\n"
        f"      <description>{esc(n.summary)}</description>\n"
        "    </item>"
        for n in notes
    )

    rss = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n'
        "  <channel>\n"
        f"    <title>{esc(title)}</title>\n"
        f"    <link>{esc(base)}/</link>\n"
        f"    <description>{esc(desc)}</description>\n"
        "    <language>zh-CN</language>\n"
        f"    <lastBuildDate>{_rfc822(datetime.now().strftime('%Y-%m-%d'))}</lastBuildDate>\n"
        f'    <atom:link href="{esc(base)}/rss.xml" rel="self" type="application/rss+xml"/>\n'
        + (f"    <managingEditor>{esc(author)}</managingEditor>\n" if author else "")
        + items + "\n"
        "  </channel>\n"
        "</rss>\n"
    )
    (ROOT / "rss.xml").write_text(rss, encoding="utf-8")

    urls = [f"  <url><loc>{esc(base)}/</loc><changefreq>daily</changefreq></url>"]
    urls += [
        f"  <url><loc>{esc(_note_url(base, n.slug))}</loc>"
        f"<lastmod>{esc(n.date)}</lastmod></url>"
        for n in notes
    ]
    sitemap = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(urls) + "\n"
        "</urlset>\n"
    )
    (ROOT / "sitemap.xml").write_text(sitemap, encoding="utf-8")

    print(f"✅ 已生成 rss.xml（{len(notes)} 条）与 sitemap.xml（{len(notes) + 1} 条 URL）")


def main() -> int:
    parser = argparse.ArgumentParser(description="SecNotes 静态站点构建脚本")
    parser.add_argument("--check", action="store_true", help="仅校验，不写入文件")
    parser.add_argument("--stats", action="store_true", help="仅打印统计信息")
    parser.add_argument("--gc-images", action="store_true",
                        help="列出笔记中未被引用的上传图片（默认只列出，不删除）")
    parser.add_argument("--yes", action="store_true", help="配合 --gc-images，确认执行删除")
    parser.add_argument("--from-json", metavar="FILE",
                        help="把管理端（manage.html）导出的 notes.json 写回 notes/ 目录，然后继续构建")
    args = parser.parse_args()

    if args.from_json:
        src = Path(args.from_json)
        if not src.is_absolute():
            src = ROOT / src
        written, import_problems = import_from_json(src)
        if import_problems:
            print("\n⚠ 导入提示：")
            for p in import_problems:
                print(f"   · {p}")
        if not written:
            print(f"\n❌ 没有从 {src.name} 导入任何笔记，已中止。")
            return 1
        print(f"\n📥 已从 {src.name} 写回 {written} 篇笔记到 notes/ 目录")

    notes, problems = collect()

    if args.gc_images:
        return gc_images(args.yes)

    index = build_index(notes)

    print(f"\n📚 笔记总数 : {len(notes)}")
    print(f"🗂  分类数量 : {len(index['categories'])}")
    print(f"🏷  标签数量 : {len(index['tags'])}")
    print(f"✍  总字数   : {sum(n.words for n in notes):,}")
    if index["categories"]:
        top = "、".join(f"{k}({v})" for k, v in index["categories"])
        print(f"   分类分布 : {top}")

    graph = build_link_graph([(n.slug, n.title, n.body) for n in notes])
    link_total = sum(len(v) for v in graph["links"].values())
    broken_total = sum(len(v) for v in graph["broken"].values())
    linked_notes = sum(1 for v in graph["backlinks"].values() if v)
    print(f"🔗 双向链接 : {link_total} 条出链，{linked_notes} 篇被引用"
          + (f"，{broken_total} 个待创建" if broken_total else ""))
    if broken_total:
        pend = sorted({t for v in graph["broken"].values() for t in v})
        print(f"   待创建   : {'、'.join(pend[:5])}" + (" 等" if len(pend) > 5 else ""))

    if problems:
        print("\n⚠ 校验提示：")
        for p in problems:
            print(f"   · {p}")

    if args.check or args.stats:
        return 1 if any("重复" in p or "缺失" in p for p in problems) else 0

    config = load_config()
    out = write_output(notes, index, config)
    size_kb = out.stat().st_size / 1024
    print(f"\n✅ 已生成 {out.relative_to(ROOT).as_posix()} ({size_kb:.1f} KB)")
    write_feed(notes, config)
    print("   启动预览： python -m http.server 8080\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
