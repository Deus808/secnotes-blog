#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SecNotes 单文件导出
-------------------
把整个笔记库导出成**一个自包含的 HTML 文件**：笔记正文、样式、代码高亮、
双向链接与上传的图片全部内联，双击即可离线阅读、可直接发给别人，
也可用浏览器「打印 → 另存为 PDF」得到一册 PDF。

设计要点
  · 正文渲染复用 assets/js/render.js —— 与站点、编辑器同一条链路，
    因此导出件的排版与站点文章页一致（代码块、表格、目录锚点、复制按钮）。
  · 上传的图片以 data URI 内联，导出件不依赖 assets/ 目录。
  · 双向链接在导出件里指向页内锚点（通过 render 的 wikiHref / idPrefix 定制）。
  · 不在导出件里留任何外部请求：不引用 CDN、不 fetch 任何文件。

用法：
    python export.py                          # 输出到 export/<标题>-<日期>.html
    python export.py --out 我的笔记.html
    python export.py --no-images              # 不内联图片（文件更小，但图会缺）
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import re
import sys
from datetime import datetime
from pathlib import Path

# 中文 Windows 控制台默认 GBK，无法编码 emoji（本脚本的提示含 📦/✗ 等）。
# 强制 UTF-8，避免打印统计信息时抛 UnicodeEncodeError 导致导出失败。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import build as builder  # noqa: E402  复用笔记收集、链接图与配置读取

VENDOR = ROOT / "assets" / "vendor"
EXPORT_DIR = ROOT / "export"

# 正文中引用上传图片的两种写法
IMG_REF_RE = re.compile(
    r"!?\[[^\]]*\]\(\s*(assets/uploads/[^)\s]+)"
    r"|<img[^>]*?\ssrc\s*=\s*[\"'](assets/uploads/[^\"']+)",
    re.I,
)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def inline_scripts(text: str) -> str:
    """防止内联脚本里出现 </script> 提前闭合标签。"""
    return text.replace("</script", "<\\/script")


def inline_styles(text: str) -> str:
    return text.replace("</style", "<\\/style")


def to_data_uri(path: Path) -> str:
    mime = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def inline_images(notes: list[dict]) -> tuple[int, list[str]]:
    """把正文里引用到的上传图片换成 data URI。返回 (内联数量, 缺失列表)。"""
    cache: dict[str, str] = {}
    missing: list[str] = []
    count = 0
    seen: set[str] = set()

    for note in notes:
        body = note.get("body") or ""
        paths: list[str] = []
        for m in IMG_REF_RE.finditer(body):
            rel = m.group(1) or m.group(2)
            if rel and rel not in paths:
                paths.append(rel)

        for rel in paths:
            if rel not in cache:
                file = ROOT / rel
                if not file.is_file():
                    missing.append(rel)
                    cache[rel] = rel          # 保持原样，至少不破坏正文
                    continue
                cache[rel] = to_data_uri(file)
                count += 1
                if rel not in seen:
                    seen.add(rel)
            body = body.replace(rel, cache[rel])
        note["body"] = body

    return count, missing


def human_size(n: float) -> str:
    for unit in ("B", "KB", "MB"):
        if n < 1024 or unit == "MB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} MB"


HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN" data-theme="{theme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} · 笔记全集</title>
<meta name="generator" content="SecNotes export.py">
<meta name="description" content="{description}">
<!-- 代码高亮主题（两套，按主题切换） -->
<style id="hljs-theme-dark">{hljs_dark}</style>
<style id="hljs-theme-light" disabled>{hljs_light}</style>
<!-- 站点样式：正文排版与站点完全一致 -->
<style>{site_css}</style>
<!-- 导出页专属样式（含打印 / 存为 PDF 规则） -->
<style>{export_css}</style>
</head>
<body class="exp">

<header class="exp-top">
  <div class="exp-top-in">
    <strong class="exp-title">{title}</strong>
    <span class="exp-sub">笔记全集</span>
    <span class="exp-meta">{stats_line}</span>
    <span class="exp-actions">
      <button type="button" id="expTheme" title="切换明暗主题">◐ 主题</button>
      <button type="button" id="expPrint" title="打印或另存为 PDF">打印 / 存为 PDF</button>
    </span>
  </div>
</header>

<div class="exp-body" id="top">
  <aside class="exp-side">
    <input type="search" id="expSearch" placeholder="过滤标题 / 分类 / 标签 / 正文" autocomplete="off">
    <div class="exp-toc" id="expToc"></div>
  </aside>
  <main class="exp-main" id="expMain">
    <section class="exp-cover">
      <h1>{title} · {subtitle}</h1>
      <p>{description}</p>
      <div class="exp-cover-stats">{cover_stats}</div>
    </section>
  </main>
</div>

<footer class="exp-foot">
  由 <code>export.py</code> 生成于 {exported_at} · 单文件自包含，可离线阅读
</footer>

<script>{js_marked}</script>
<script>{js_hljs}</script>
<script>{js_render}</script>
<script>{js_export}</script>
<script>window.EXPORT_DATA = {payload};</script>
</body>
</html>
"""


def build_payload(notes, config, graph, stats) -> dict:
    return {
        "config": config,
        "stats": stats,
        "categories": sorted(stats["categories"].items(), key=lambda kv: (-kv[1], kv[0])),
        "tags": sorted(stats["tags"].items(), key=lambda kv: (-kv[1], kv[0])),
        "notes": notes,
        "links": graph["links"],
        "backlinks": graph["backlinks"],
        "broken": graph["broken"],
        "exportedAt": stats["exportedAt"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="把笔记库导出为单个自包含 HTML 文件")
    parser.add_argument("--out", help="输出文件路径（默认 export/<标题>-<日期>.html）")
    parser.add_argument("--no-images", action="store_true", help="不内联图片")
    args = parser.parse_args()

    collected, problems = builder.collect()
    if not collected:
        print("✗ 没有可导出的笔记（notes/ 下没有已收录的 Markdown）")
        return 1

    config = builder.load_config()
    title = config.get("title") or "SecNotes"
    subtitle = config.get("subtitle") or "笔记全集"
    description = config.get("description") or ""

    # 与 data/notes.js 一致的结构
    notes = []
    for n in collected:
        notes.append({
            "slug": n.slug, "title": n.title, "date": n.date, "category": n.category,
            "tags": n.tags, "summary": n.summary, "body": n.body, "source": n.source,
            "words": n.words, "reading_time": n.reading_time, "updated": n.updated,
            "draft": n.draft,
        })

    # 链接图基于原始正文计算（与 build.py 完全一致），此时还没内联图片
    graph = builder.build_link_graph([(n["slug"], n["title"], n["body"]) for n in notes])

    image_count, missing_images = (0, [])
    if not args.no_images:
        image_count, missing_images = inline_images(notes)

    words_total = sum(n["words"] for n in notes)
    cats: dict[str, int] = {}
    tags: dict[str, int] = {}
    for n in notes:
        cats[n["category"]] = cats.get(n["category"], 0) + 1
        for t in n["tags"]:
            tags[t] = tags.get(t, 0) + 1

    exported_at = datetime.now().strftime("%Y-%m-%d %H:%M")
    stats = {
        "notes": len(notes), "words": words_total,
        "categories": cats, "tags": tags, "exportedAt": exported_at,
    }
    payload = build_payload(notes, config, graph, stats)

    stats_line = f"{len(notes)} 篇 · {words_total:,} 字 · 导出 {exported_at}"
    cover_stats = "".join([
        f"<span>{len(notes)} 篇笔记</span>",
        f"<span>{len(cats)} 个分类</span>",
        f"<span>{len(tags)} 个标签</span>",
        f"<span>{words_total:,} 字</span>",
        f"<span>双向链接 {sum(len(v) for v in graph['links'].values())} 条</span>",
        (f"<span>待创建 {sum(len(v) for v in graph['broken'].values())} 个</span>"
         if any(graph["broken"].values()) else ""),
    ])

    html = HTML_TEMPLATE.format(
        theme=config.get("defaultTheme") or "dark",
        title=builder.strip_markdown(title),
        subtitle=builder.strip_markdown(subtitle),
        description=description,
        stats_line=stats_line,
        cover_stats=cover_stats,
        exported_at=exported_at,
        hljs_dark=inline_styles(read_text(VENDOR / "hljs-github-dark.min.css")),
        hljs_light=inline_styles(read_text(VENDOR / "hljs-github-light.min.css")),
        site_css=inline_styles(read_text(ROOT / "assets" / "css" / "style.css")),
        export_css=inline_styles(read_text(ROOT / "assets" / "css" / "export.css")),
        js_marked=inline_scripts(read_text(VENDOR / "marked.min.js")),
        js_hljs=inline_scripts(read_text(VENDOR / "highlight.min.js")),
        js_render=inline_scripts(read_text(ROOT / "assets" / "js" / "render.js")),
        js_export=inline_scripts(read_text(ROOT / "assets" / "js" / "export.js")),
        payload=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
    )

    if args.out:
        out = Path(args.out)
        if not out.is_absolute():
            out = ROOT / out
    else:
        safe = re.sub(r"[^\w\u4e00-\u9fff.-]+", "-", title).strip("-") or "SecNotes"
        out = EXPORT_DIR / f"{safe}-{datetime.now().strftime('%Y-%m-%d')}.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")

    size = out.stat().st_size
    print("\n📦 已导出单文件笔记全集")
    print(f"   路径   : {out}")
    print(f"   大小   : {human_size(size)}")
    print(f"   内容   : {len(notes)} 篇 · {len(cats)} 分类 · {len(tags)} 标签 · {words_total:,} 字")
    print(f"   图片   : 内联 {image_count} 张" + (f"，缺失 {len(missing_images)} 张" if missing_images else ""))
    print(f"   链接   : {sum(len(v) for v in graph['links'].values())} 条出链，"
          f"{sum(1 for v in graph['backlinks'].values() if v)} 篇被引用")
    if missing_images:
        for rel in missing_images[:5]:
            print(f"   ⚠ 找不到图片：{rel}")
    if problems:
        print(f"   ⚠ 构建校验提示 {len(problems)} 条（可运行 python build.py --check 查看）")
    print("\n   双击打开即可离线阅读；浏览器「打印 → 另存为 PDF」可得到一册 PDF。\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
