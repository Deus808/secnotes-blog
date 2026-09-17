#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SecNotes 新笔记脚手架
----------------------
按规范生成一篇带 front-matter 的 Markdown 笔记，避免手工填写格式出错。

用法：
    python new-note.py "Nmap 实战用法"
    python new-note.py "Nmap 实战用法" -c "渗透测试" -t "Nmap,信息收集"
    python new-note.py "草稿标题" --slug my-draft --draft

参数：
    title            必填，笔记标题
    -c / --category  分类，默认「未分类」
    -t / --tags      标签，逗号分隔
    -s / --slug      自定义文件名（不含 .md），默认由标题生成
    -d / --draft     标记为草稿（构建时跳过收录）
    --open           生成后用系统默认程序打开
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

# slugify 只有一份实现（build.py），且必须与前端 assets/js/manage.js 完全一致。
# 不要在本文件另写一份：规则一旦漂移，同一篇笔记在命令行与管理端下会落到
# 不同的文件名，表现为「保存一次却多出一篇」。
from build import slugify

# 中文 Windows 控制台默认 GBK，无法编码 emoji（下面的提示含 ✅/✗）。
# 强制 UTF-8，避免打印提示时抛 UnicodeEncodeError。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

ROOT = Path(__file__).resolve().parent
NOTES_DIR = ROOT / "notes"

CJK_RE = re.compile(r"[\u4e00-\u9fff]")

TEMPLATE = """---
title: {title}
date: {today}
category: {category}
tags: [{tags}]
summary: {summary}
{draft}---

# {title}

> 一句话说明这篇笔记要解决什么问题。

## 一、背景 / 适用场景

在这里交代问题出现的上下文。

## 二、核心内容

正文。支持 GFM 语法：表格、任务列表、代码块高亮。

```bash
# 示例命令
echo "hello secnotes"
```

### 子小节

| 项目 | 说明 |
| --- | --- |
| 示例 | 说明文本 |

## 三、验证方式

- [ ] 复现步骤一
- [ ] 复现步骤二

## 小结

用两三句话收束结论，方便日后翻阅时快速回忆。
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="生成一篇新的 SecNotes 笔记")
    parser.add_argument("title", help="笔记标题")
    parser.add_argument("-c", "--category", default="未分类", help="分类，默认「未分类」")
    parser.add_argument("-t", "--tags", default="", help="标签，逗号分隔")
    parser.add_argument("-s", "--slug", default="", help="文件名（不含 .md）")
    parser.add_argument("-d", "--draft", action="store_true", help="标记为草稿")
    parser.add_argument("--open", action="store_true", help="生成后打开文件")
    args = parser.parse_args()

    NOTES_DIR.mkdir(parents=True, exist_ok=True)

    tags = [t.strip() for t in re.split(r"[,，、;；]", args.tags) if t.strip()]
    slug = args.slug.strip() or slugify(args.title)
    if not slug:
        print("✗ 标题里没有可用字符（纯标点 / emoji 等），无法生成文件名。")
        print("  请用 -s 手动指定文件名。")
        return 1
    target = NOTES_DIR / f"{slug}.md"

    if target.exists():
        print(f"✗ 文件已存在：{target.relative_to(ROOT).as_posix()}")
        print("  如需新建请用 -s 指定其他文件名。")
        return 1

    content = TEMPLATE.format(
        title=args.title,
        today=date.today().isoformat(),
        category=args.category,
        tags=", ".join(tags),
        summary="（一句话摘要，留空则自动截取正文首段）",
        draft=("draft: true\n" if args.draft else ""),
    )
    target.write_text(content, encoding="utf-8")

    rel = target.relative_to(ROOT).as_posix()
    print(f"\n✅ 已创建 {rel}")
    print(f"   标题   : {args.title}")
    print(f"   分类   : {args.category}")
    print(f"   标签   : {', '.join(tags) if tags else '（无）'}")
    if args.draft:
        print("   状态   : 草稿（构建时不会收录，去掉 draft 字段即可发布）")
    print("\n下一步：编辑该文件后运行  python build.py  刷新站点。\n")

    if args.open:
        try:
            if sys.platform == "win32":
                subprocess.run(["cmd", "/c", "start", "", str(target)], check=False)
            else:
                subprocess.run(["open" if sys.platform == "darwin" else "xdg-open", str(target)], check=False)
        except Exception as e:  # noqa: BLE001
            print(f"（打开文件失败：{e}）")

    return 0


if __name__ == "__main__":
    sys.exit(main())
