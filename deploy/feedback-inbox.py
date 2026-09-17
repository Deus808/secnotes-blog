#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SecNotes 反馈收件箱
-------------------
读取展示端生成的「反馈 GitHub Issue」并集中浏览 / 打开 / 关闭。
依赖：本机已 gh 登录（gh auth status 确认账号即可）。

    python feedback-inbox.py           # 交互：列出反馈，可查看详情 / 浏览器打开 / 关闭
    python feedback-inbox.py list      # 仅列表一次
"""
from __future__ import annotations

import json
import subprocess
import sys
import webbrowser

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

REPO = "你的用户名/你的仓库"  # TODO: 改成反馈落点仓库（与前端 deploy/feedback.js 的 REPO 保持一致）
FEED_TITLE_PREFIX = "[反馈]"


def gh(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(["gh", "api", *args], capture_output=True,
                          text=True, encoding="utf-8", errors="replace")


def fetch_issues() -> list[dict]:
    r = gh(["repos/" + REPO + "/issues", "-X", "GET", "-F", "state=all", "-F", "per_page=100"])
    if r.returncode != 0:
        raise RuntimeError("无法读取 GitHub issues：" + (r.stderr.strip() or "请先 gh auth login"))
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise RuntimeError("GitHub 返回了无法解析的内容")
    return [i for i in data if "pull_request" not in i]


def is_feedback(issue: dict) -> bool:
    if any(l.get("name") == "feedback" for l in issue.get("labels", [])):
        return True
    return str(issue.get("title", "")).strip().startswith(FEED_TITLE_PREFIX)


def short(body: str, n: int = 120) -> str:
    body = body.strip() or "（无正文）"
    return body[:n] + ("…" if len(body) > n else "")


def render(issues: list[dict]) -> None:
    if not issues:
        print("（暂无反馈）")
        return
    for i, it in enumerate(issues, 1):
        state = "已关闭" if it["state"] == "closed" else "待处理"
        n = it["number"]
        title = it["title"]
        created = it["created_at"][:16].replace("T", " ")
        print(f"  {i:>2}. #{n:<5} [{state}] {title}  ({created})")
        print(f"       {short(it['body'])}")


def main() -> int:
    only_list = len(sys.argv) > 1 and sys.argv[1] == "list"
    print(f"\n📥 加载仓库 {REPO} 的反馈 issue……")
    try:
        all_issues = fetch_issues()
    except RuntimeError as e:
        print(f"  ✗ {e}")
        return 1
    fbs = [i for i in all_issues if is_feedback(i)]
    print(f"  共 {len(all_issues)} 个 issue，其中 {len(fbs)} 条为站点反馈。\n")

    list_only_rendered = False

    def show_list():
        nonlocal list_only_rendered
        print("=" * 60)
        render(fbs)
        print("=" * 60)
        list_only_rendered = True

    show_list()
    if only_list:
        return 0

    while True:
        try:
            cmd = input("\n[操作] 回看列表=回车 | 序号=查看详情 | o序号=浏览器打开 | c序号=关闭 | q=退出\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if cmd in ("", "list"):
            show_list()
            continue
        if cmd.lower() == "q":
            break
        m = cmd[0].lower()
        rest = cmd[1:]
        if m in ("o", "c") and rest:
            phase = "list_only_rendered" and None  # noqa: F841 占位
        try:
            idx = int(rest) if rest else int(cmd)
        except ValueError:
            idx = 0
        if idx < 1 or idx > len(fbs):
            print("  ⚠ 编号无效。")
            continue
        it = fbs[idx - 1]
        number = it["number"]
        if m == "o":
            print(f"  正在打开 https://github.com/{REPO}/issues/{number} ……")
            webbrowser.open(f"https://github.com/{REPO}/issues/{number}")
            continue
        if m == "c":
            r = gh(["repos/" + REPO + "/issues/" + str(number), "-X", "PATCH", "-f", "state=closed"])
            if r.returncode != 0:
                print("  ✗ 关闭失败：" + (r.stderr.strip() or "未知错误"))
            else:
                it["state"] = "closed"
                print(f"  ✅ 已关闭 #{number}")
            continue
        # 详情
        print("\n" + "-" * 60)
        print(f"  #{number}  [{it['state']}] {it['title']}")
        print(f"  时间  {it['created_at']}  · 作者  {it['user']['login']}")
        print("  链接  https://github.com/%s/issues/%d" % (REPO, number))
        print("-" * 60)
        print((it.get("body") or "（无正文）").strip())
        print("-" * 60 + "\n")
        continue
    return 0


if __name__ == "__main__":
    sys.exit(main())