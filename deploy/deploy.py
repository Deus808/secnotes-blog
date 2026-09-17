#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SecNotes 发布整理脚本（随项目存放于 <博客根>/deploy/）
---------------------------------------------------
把博客源站整理成只含**公开运行时文件**的干净发布目录，
排除管理端（admin/manage/export）与笔记原稿，供 GitHub Pages 部署。
稳定静态资源可（可选）改写为 jsDelivr CDN 前缀实现国内加速（见 CDN_ENABLED 开关）；数据文件保持不变。

用法：
    python deploy.py              # 构建 + 整理 + git 提交
    python deploy.py --push       # 构建后再推送到 GitHub（Pages 自动重新部署）
    python deploy.py --pub <路径> # 或设置环境变量 SECNOTES_PUB 指定发布目录
"""
from __future__ import annotations

import os
import html
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

# 源站目录：本脚本随项目存放于 <博客根>/deploy/，其父目录即为博客源站
BLOG = Path(__file__).resolve().parent.parent
# 发布目录（GitHub Pages 部署源）：默认项目内的 pub/；
# 可用环境变量 SECNOTES_PUB 或参数 --pub <目录> 覆盖（例如独立 Pages 仓库）
PUB = Path(os.environ.get("SECNOTES_PUB") or (BLOG / "pub"))
if "--pub" in sys.argv:
    _pub_i = sys.argv.index("--pub")
    if _pub_i + 1 < len(sys.argv):
        PUB = Path(sys.argv[_pub_i + 1])
DEPLOY_DIR = Path(__file__).resolve().parent   # 发布脚本所在目录（内置模板）
DATA_DIR = BLOG / "data"
ASSETS = BLOG / "assets"

FILE_COPIES = [
    (BLOG / "index.html", "index.html"),
    (DATA_DIR / "notes.js", "data/notes.js"),
    (ASSETS / "css" / "style.css", "assets/css/style.css"),
    (ASSETS / "js" / "app.js", "assets/js/app.js"),
    (ASSETS / "js" / "render.js", "assets/js/render.js"),
    (ASSETS / "vendor" / "marked.min.js", "assets/vendor/marked.min.js"),
    (ASSETS / "vendor" / "highlight.min.js", "assets/vendor/highlight.min.js"),
    (ASSETS / "vendor" / "hljs-github-dark.min.css", "assets/vendor/hljs-github-dark.min.css"),
    (ASSETS / "vendor" / "hljs-github-light.min.css", "assets/vendor/hljs-github-light.min.css"),
]

DIR_COPIES = [
    (ASSETS / "uploads", "assets/uploads"),
]

# 是否把稳定静态资源改写为 jsDelivr CDN 前缀（国内加速）。
# 开源项目默认 False：保持相对路径、克隆即用，也不依赖任何人的 CDN 仓库。
# 需要加速时改为 True，并把 CDN_BASE 换成你自己的 GitHub 仓库。
CDN_ENABLED = False

# jsDelivr 静态资源前缀（国内加速）。例：https://cdn.jsdelivr.net/gh/你的用户名/你的仓库@main/（CDN_ENABLED=True 时生效）
CDN_BASE = "https://cdn.jsdelivr.net/gh/你的用户名/你的仓库@main/"

# 发布版 index.html 中应改为 CDN 前缀的引用（稳定、低频变化的静态资源）。
# 注意：data/notes.js、assets/js/app.js 以及「反馈/进入通知」资源
# （feedback.* / sync-notice.*）都保持相对路径，保证更新即时 ——
# 若走 jsDelivr 的 @main 分支会被缓存最长 12 小时，出现「推送成功却不生效」。
CDN_REPLACES = [
    ("assets/vendor/hljs-github-dark.min.css", CDN_BASE + "assets/vendor/hljs-github-dark.min.css"),
    ("assets/vendor/hljs-github-light.min.css", CDN_BASE + "assets/vendor/hljs-github-light.min.css"),
    ("assets/css/style.css", CDN_BASE + "assets/css/style.css"),
    ("assets/vendor/marked.min.js", CDN_BASE + "assets/vendor/marked.min.js"),
    ("assets/vendor/highlight.min.js", CDN_BASE + "assets/vendor/highlight.min.js"),
    ("assets/js/render.js", CDN_BASE + "assets/js/render.js"),
]


def rewire_jsdelivr(index_path: Path) -> None:
    """把发布目录 index.html 的静态资源引用改写为 jsDelivr CDN 前缀。

    CDN_ENABLED = False 时直接跳过，保持相对路径、开箱即用。
    """
    if not CDN_ENABLED:
        return
    text = index_path.read_text(encoding="utf-8")
    for src, dst in CDN_REPLACES:
        text = text.replace(f'href="{src}"', f'href="{dst}"')
        text = text.replace(f'src="{src}"', f'src="{dst}"')
    index_path.write_text(text, encoding="utf-8")


def tag_feedback_version(index_path: Path, version: str) -> None:
    """给「反馈/进入通知」资源追加 ?v= 版本参数，强制浏览器取最新。

    这些资源改走相对路径（不经 jsDelivr @main 缓存），由 GitHub Pages 即时
    提供；?v= 仅用于刷新浏览器自身的缓存，确保发布后立即生效。
    """
    text = index_path.read_text(encoding="utf-8")
    for rel in ("assets/css/feedback.css", "assets/js/feedback.js",
                "assets/css/sync-notice.css", "assets/js/sync-notice.js"):
        text = text.replace(f'href="{rel}"', f'href="{rel}?v={version}"')
        text = text.replace(f'src="{rel}"', f'src="{rel}?v={version}"')
    index_path.write_text(text, encoding="utf-8")


def inject_feedback(index_path: Path) -> None:
    """向发布版 index.html 注入反馈资源（CSS 于 head、JS 于 body 末尾）。

    反馈模板（feedback.css / feedback.js）随本脚本存放，源站不引入任何改动；
    页面引用用相对路径，交给 rewire_jsdelivr 统一改写为 CDN 前缀。
    """
    text = index_path.read_text(encoding="utf-8")
    if "feedback.css" not in text:
        text = text.replace(
            '<link rel="stylesheet" href="assets/css/style.css">',
            '<link rel="stylesheet" href="assets/css/style.css">\n'
            '<link rel="stylesheet" href="assets/css/feedback.css">', 1)
    if "feedback.js" not in text:
        text = text.replace(
            '</body>',
            '<script src="assets/js/feedback.js"></script>\n</body>', 1)
    # 顶部导航：剔除任何「关于」导航项（兼容源站残留半状态：只改文案但 href 仍为
    # #/about），再补插「反馈」入口（点击由 feedback.js 打开弹层，href 不触发路由跳转）
    text = re.sub(r'<a\b(?=[^>]*data-nav="about")[^>]*>\s*(?:关于|反馈)\s*</a>', '', text)
    if 'id="navFeedback"' not in text:
        text = text.replace(
            '</nav>',
            '<a href="javascript:void(0)" id="navFeedback" data-nav="feedback">反馈</a>\n    </nav>', 1)
    # 移动端侧栏（左侧三条杠展开的抽屉）顶部也加「反馈」入口，复用 side-list 样式
    if 'id="mobileFeedback"' not in text:
        text = text.replace(
            '<aside class="sidebar" id="sidebar">',
            '<aside class="sidebar" id="sidebar">\n'
            '<ul class="side-list mobile-feedback" style="margin:0 0 12px">\n'
            '<li><a href="javascript:void(0)" id="mobileFeedback" data-nav="feedback" '
            'style="font-weight:600">反馈</a></li>\n'
            '</ul>', 1)
    index_path.write_text(text, encoding="utf-8")


def inject_sync_notice(index_path: Path) -> None:
    """向发布版 index.html 注入进入站点通知（sync-notice）资源。

    CSS 于 head、JS 于 body 末尾，相对路径交由 rewire_jsdelivr 统一改写为 CDN。
    """
    text = index_path.read_text(encoding="utf-8")
    if "sync-notice.css" not in text:
        text = text.replace(
            'assets/css/style.css">',
            'assets/css/style.css">\n'
            '<link rel="stylesheet" href="assets/css/sync-notice.css">', 1)
    if "sync-notice.js" not in text:
        text = text.replace(
            '</body>',
            '<script src="assets/js/sync-notice.js"></script>\n</body>', 1)
    index_path.write_text(text, encoding="utf-8")


def inject_site_notice(index_path: Path) -> None:
    """把源站 notice.json 的站点维护通知注入发布版 index.html。

    命中（enabled 且非空文字）→ 在导航栏下方插入一条可关闭的琥珀色横幅；
    否则什么都不注入。横幅样式内联，不走 CDN，杜绝缓存问题。
    """
    try:
        data = json.loads((BLOG / "notice.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        data = {}
    text = html.escape(str(data.get("text") or "").strip())
    if not data.get("enabled") or not text:
        return
    if 'id="siteNotice"' in index_path.read_text(encoding="utf-8"):
        return

    css = (
        '<style id="site-notice-css">'
        '.site-notice{display:flex;align-items:center;gap:10px;padding:9px 16px;'
        'font:13.5px/1.6 var(--font-sans);color:#4a2f00;'
        'background:linear-gradient(90deg,#fff6dc,#ffe9b8);'
        'border-bottom:1px solid rgba(180,130,20,.35)}'
        '.site-notice .sn-ic{flex:0 0 auto;display:grid;place-items:center}'
        '.site-notice .sn-t{flex:1;min-width:0}.site-notice b{font-weight:700}'
        '.site-notice .sn-x{flex:0 0 auto;width:24px;height:24px;border:0;border-radius:50%;'
        'background:rgba(120,80,0,.12);color:#4a2f00;font-size:15px;line-height:1;cursor:pointer}'
        '.site-notice .sn-x:hover{background:rgba(120,80,0,.24)}'
        '</style>'
    )
    bar = (
        '<div class="site-notice" id="siteNotice" role="status">'
        '<span class="sn-ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" '
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h13a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
        '<path d="M12 9v4"/><path d="M12 17h.01"/></svg></span>'
        '<span class="sn-t"><b>维护通知：</b>' + text + '</span>'
        '<button class="sn-x" type="button" aria-label="关闭通知">&times;</button>'
        '</div>'
    )
    js = (
        '<script>(function(){var b=document.getElementById("siteNotice");if(!b)return;'
        'var x=b.querySelector(".sn-x");if(x)x.addEventListener("click",function(){'
        'sessionStorage.setItem("secnot_notice_closed","1");b.remove();});})();</script>'
    )

    text_whole = index_path.read_text(encoding="utf-8")
    text_whole = text_whole.replace('</head>', css + '</head>', 1)
    text_whole = text_whole.replace('</header>', '</header>\n' + bar, 1)
    text_whole = text_whole.replace('</body>', js + '\n</body>', 1)
    index_path.write_text(text_whole, encoding="utf-8")


def inject_mobile_toc(index_path: Path, app_js_path: Path) -> None:
    """移动端文章目录：顶栏「目录」按钮 + 右侧滑出抽屉。

    纯发布层注入（源站零改动），逻辑以独立 IIFE 追加到发布版 app.js，
    通过 MutationObserver 监听 #app 渲染，路由为文章时才启用按钮并填充目录。
    样式内联进 <head>，不走 jsDelivr，杜绝缓存滞后。
    """
    text = index_path.read_text(encoding="utf-8")

    # 1) 顶栏按钮（放在 topbar-actions 最前 = 搜索按钮之前；仅移动端显示）
    if 'id="tocBtn"' not in text:
        btn = (
            '<button class="icon-btn toc-btn" id="tocBtn" aria-label="目录" title="目录" hidden>'
            '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" '
            'stroke-width="2" stroke-linecap="round"><path d="M9 6h12M9 12h12M9 18h12"/>'
            '<path d="M3 6h.01M3 12h.01M3 18h.01" stroke-width="3"/></svg></button>'
        )
        text = text.replace(
            '<button class="icon-btn" id="searchToggle"',
            btn + '\n      <button class="icon-btn" id="searchToggle"', 1)

    # 2) 目录抽屉（置于 #backdrop 之后，独立于 #app，渲染时不会被清掉）
    if 'id="tocDrawer"' not in text:
        drawer = (
            '<div class="toc-drawer" id="tocDrawer" aria-hidden="true">'
            '<div class="toc-drawer-head"><span>目录</span>'
            '<button type="button" class="icon-btn" id="tocClose" aria-label="关闭目录">&times;</button></div>'
            '<nav class="toc" id="tocMobile"></nav>'
            '</div>'
        )
        text = text.replace('</body>', drawer + '\n</body>', 1)

    # 3) 内联样式（按钮显隐 + 抽屉滑出 + backdrop 联动）
    if 'id="toc-drawer-css"' not in text:
        css = (
            '<style id="toc-drawer-css">'
            '.toc-btn{display:none!important}'
            '@media (max-width:900px){.toc-btn{display:inline-flex!important}'
            '.toc-btn[hidden]{display:none!important}}'
            '.toc-drawer{position:fixed;top:0;right:0;bottom:0;z-index:56;width:288px;max-width:86vw;'
            'background:var(--bg);border-left:1px solid var(--border);padding:70px 18px 28px;'
            'transform:translateX(103%);transition:transform .24s var(--ease);overflow-y:auto}'
            'body.toc-open .toc-drawer{transform:none}'
            'body.toc-open .backdrop{opacity:1;visibility:visible}'
            '.toc-drawer-head{display:flex;align-items:center;justify-content:space-between;'
            'margin:0 2px 8px;font-size:13px;font-weight:600;color:var(--text-strong)}'
            '.toc-drawer .toc{display:block;position:static;top:auto;max-height:none;overflow:visible;padding-bottom:24px}'
            '.toc-drawer ul{border-left:1px solid var(--border)}'
            '</style>'
        )
        text = text.replace('</head>', css + '</head>', 1)
    index_path.write_text(text, encoding="utf-8")

    # 4) 追加 IIFE 到发布版 app.js：按钮显隐 + 抽屉填充/开关 + 滚动高亮
    js = app_js_path.read_text(encoding="utf-8")
    if 'id="tocMobile"' in js:
        return  # 已注入过
    hook = r'''
/* ===== 移动端文章目录（发布层注入）===== */
(function () {
  var btn = document.getElementById('tocBtn');
  var drawer = document.getElementById('tocDrawer');
  var closeBtn = document.getElementById('tocClose');
  var body = document.body;
  var app = document.getElementById('app');
  if (!btn || !drawer || !closeBtn || !app) return;

  function isNoteRoute() { return location.hash.indexOf('#/note/') === 0; }
  function openToc() { body.classList.add('toc-open'); drawer.setAttribute('aria-hidden', 'false'); }
  function closeToc() { body.classList.remove('toc-open'); drawer.setAttribute('aria-hidden', 'true'); }

  function fillToc() {
    var nav = document.getElementById('tocMobile');
    btn.hidden = !isNoteRoute();
    if (!isNoteRoute()) {
      if (body.classList.contains('toc-open')) closeToc();
      if (nav) nav.innerHTML = '';
      return;
    }
    if (!nav) return;
    var hs = document.querySelectorAll('#postBody h1,h2,h3,h4');
    var items = [];
    hs.forEach(function (h) {
      if (h.id) items.push({ level: parseInt(h.tagName.slice(1), 10), id: h.id, text: h.textContent });
    });
    if (items.length < 2) { nav.innerHTML = ''; return; }
    nav.innerHTML = '<h5>目录</h5><ul>' + items.map(function (h) {
      return '<li class="lvl-' + h.level + '"><a href="#' + encodeURIComponent(h.id) +
        '" data-toc="' + h.id + '">' + h.text.replace(/</g, '&lt;') + '</a></li>';
    }).join('') + '</ul>';
    nav.querySelectorAll('a[data-toc]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        closeToc();
        var el = document.getElementById(a.getAttribute('data-toc'));
        if (el) {
          var top = el.getBoundingClientRect().top + window.pageYOffset - 76;
          window.scrollTo({ top: top, behavior: 'smooth' });
        }
      });
    });
    syncActive();
  }

  function syncActive() {
    var nav = document.getElementById('tocMobile');
    if (!nav) return;
    var links = nav.querySelectorAll('a[data-toc]');
    if (!links.length) return;
    var pos = window.pageYOffset + 110;
    var cur = null;
    links.forEach(function (a) {
      var el = document.getElementById(a.getAttribute('data-toc'));
      if (el && el.offsetTop <= pos) cur = a;
    });
    links.forEach(function (a) { a.classList.toggle('active', a === cur); });
  }

  btn.addEventListener('click', function () {
    body.classList.contains('toc-open') ? closeToc() : openToc();
  });
  closeBtn.addEventListener('click', closeToc);
  var backdrop = document.getElementById('backdrop');
  if (backdrop) backdrop.addEventListener('click', closeToc);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeToc(); });
  window.addEventListener('scroll', syncActive, { passive: true });
  new MutationObserver(function () { fillToc(); }).observe(app, { childList: true, subtree: true });
  fillToc();
})();
'''
    app_js_path.write_text(js.rstrip() + '\n' + hook, encoding="utf-8")


def strip_about(app_js_path: Path) -> None:
    """清理发布版 app.js 中「关于（about）」视图的残留代码，确保线上无关于页。"""
    js = app_js_path.read_text(encoding="utf-8")
    js = js.replace("|| head === 'about'", "")                        # 路由识别
    js = js.replace("else if (route.name === 'about') html = viewAbout();\n", "")  # 分发分支

    # 删除 viewAbout 函数及其前导注释块：定位注释起点，再到函数结束的配对右花括号
    ci = js.find("视图：关于")
    if ci != -1:
        start = js.rfind("/*", 0, ci)          # 最近的 /* 即该注释块起点
        key_fn = js.find("function viewAbout(", ci)
        if key_fn == -1:
            key_fn = js.find("function viewAbout(") if "viewAbout" in js else -1
        if key_fn != -1:
            brace = js.find("{", key_fn)
            depth, idx = 0, brace
            while idx < len(js):
                if js[idx] == "{":
                    depth += 1
                elif js[idx] == "}":
                    depth -= 1
                    if depth == 0:
                        end = idx + 1
                        js = js[:start] + js[end:]
                        break
                idx += 1
    app_js_path.write_text(js, encoding="utf-8")


def git_commit(pub: Path, message: str) -> bool:
    """在发布目录执行 git add + commit（不 push，push 由 --push 触发）。

    · 默认发布目录在项目内（pub/）→ 提交落回**项目仓库本身**（GitHub Pages
      可用「分支 main + 目录 /pub」方式部署，提交即上线）；
    · 发布目录是独立仓库（--pub / SECNOTES_PUB 指定）→ 提交落在发布仓库内。
    返回是否成功调用 git（returncode 0/1 视为成功：1 表示无变更可提交）。
    """
    inside = False
    try:
        pub.relative_to(BLOG)
        inside = True
    except ValueError:
        pass
    GIT_CWD = str(BLOG if inside else pub)
    target = pub.name if inside else "."
    cmds = [
        ["git", "add", "-A", "--", target],
        ["git", "commit", "-m", message],
    ]
    for c in cmds:
        r = subprocess.run(c, cwd=GIT_CWD, capture_output=True, text=True, encoding="utf-8")
        if r.stdout.strip():
            print("   " + r.stdout.strip().splitlines()[-1])
        if r.returncode not in (0, 1):
            print("⚠ git 执行异常:", r.stderr.strip())
            return False
    return True


def main() -> int:
    push = "--push" in sys.argv[1:]
    # 1) 先构建，保证 data/notes.js 最新
    sys.path.insert(0, str(BLOG))
    import build as builder
    collected, problems = builder.collect()
    config = builder.load_config()
    index = builder.build_index(collected)
    builder.write_output(collected, index, config)
    builder.write_feed(collected, config)
    n = len(collected)
    w = sum(x.words for x in collected)

    # 2) 重建发布目录（保留 .git，保留 remote / 凭据配置；清理其余内容）
    def _force_rm(func: object, path: str, exc_info: object) -> None:
        try:
            os.chmod(path, 0o777)
            rm = getattr(shutil, "rmdir", None) or os.rmdir
            if func is os.unlink or func is os.remove:
                os.chmod(path, 0o777)
            func(path)
        except OSError:
            pass

    if PUB.exists():
        for child in PUB.iterdir():
            if child.name == ".git":
                continue
            if child.is_dir():
                shutil.rmtree(child, onerror=_force_rm)
            else:
                child.unlink()
    PUB.mkdir(parents=True, exist_ok=True)

    # 阻止 GitHub Pages 走 Jekyll：否则文件名以下划线开头的资源
    # （如 __new__-xxxx.jpg）会被 Jekyll 忽略而不发布，导致文章图片 404。
    (PUB / ".nojekyll").write_text("", encoding="utf-8")

    for src, rel in FILE_COPIES:
        if not src.exists():
            print(f"⚠ 缺少公开文件：{src}")
            continue
        dst = PUB / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)

    for src, rel in DIR_COPIES:
        if src.exists():
            shutil.copytree(src, PUB / rel, dirs_exist_ok=True)

    # 反馈 + 进入通知资源模板（随本脚本存放）：复制进发布目录
    for name, rel in [("feedback.css", "assets/css/feedback.css"),
                      ("feedback.js", "assets/js/feedback.js"),
                      ("sync-notice.css", "assets/css/sync-notice.css"),
                      ("sync-notice.js", "assets/js/sync-notice.js")]:
        tpl = DEPLOY_DIR / name
        if tpl.exists():
            dst = PUB / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(tpl, dst)

    # 3) 注入反馈资源引用，再把静态资源改写为 jsDelivr CDN 前缀，
    #    并对反馈资源追加版本号，避免浏览器/CDN 缓存旧版
    inject_feedback(PUB / "index.html")
    inject_sync_notice(PUB / "index.html")
    inject_site_notice(PUB / "index.html")
    inject_mobile_toc(PUB / "index.html", PUB / "assets/js/app.js")
    rewire_jsdelivr(PUB / "index.html")
    tag_feedback_version(PUB / "index.html", datetime.now().strftime("%Y%m%d%H%M%S"))
    strip_about(PUB / "assets/js/app.js")

    total = sum(f.stat().st_size for f in PUB.rglob("*") if f.is_file())
    count = sum(1 for f in PUB.rglob("*") if f.is_file())
    print("\n📦 已整理发布目录", PUB)
    print(f"   文件数 : {count} 个，{total/1024:.1f} KB")
    print(f"   内容   : {n} 篇 · {len(index['categories'])} 分类 · {w:,} 字  （静态资源 CDN 开关见 deploy.py 顶部 CDN_ENABLED）")
    if problems:
        print(f"   ⚠ 构建校验 {len(problems)} 条")

    # 4) git 提交（默认提交到项目仓库的 pub/，独立发布目录则提交在发布仓库内）
    git_ok = git_commit(PUB, "自动部署更新")

    # 5) 可选：推送到 GitHub（--push）
    if push and git_ok:
        print("\n🚀 正在推送到 GitHub……")
        inside = False
        try:
            PUB.relative_to(BLOG)
            inside = True
        except ValueError:
            pass
        r = subprocess.run(["git", "push"], cwd=str(BLOG if inside else PUB),
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.stdout.strip():
            print("   " + r.stdout.strip().replace("\n", "\n   "))
        if r.returncode != 0:
            print("⚠ push 失败：")
            print("   " + (r.stderr.strip() or "(无错误信息)"))
            return 1
        print("✅ 已推送成功。GitHub Pages 约 1-2 分钟后自动重新部署。")
    elif push:
        print("\n⚠ 跳过推送：git 提交未成功（发布目录不在任何 git 仓库中？）")
    else:
        print("\n   推送上线：git push  （或用 --push 参数一键完成）")

    print("   线上地址: 推送后见你的 GitHub Pages 地址（仓库 Settings > Pages）")
    return 0


if __name__ == "__main__":
    sys.exit(main())