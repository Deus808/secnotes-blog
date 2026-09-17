/* ============================================================
   SecNotes — 前端应用
   数据来源：data/notes.js（由 build.py 生成）
   ============================================================ */
(function () {
  'use strict';

  var DB = window.SEC_BLOG || { config: {}, notes: [], categories: [], tags: [], stats: {} };
  var NOTES = DB.notes || [];
  var BACKLINKS = DB.backlinks || {};   // slug -> [引用它的 slug]
  var BROKEN = DB.broken || {};         // slug -> [尚未创建的链接标题]

  var CONFIG = Object.assign({
    title: 'SecNotes',
    subtitle: '网络安全知识笔记',
    description: '个人网络安全学习与实战笔记库',
    author: '',
    footer: '',
    defaultTheme: 'dark',
    pageSize: 8,
    siteUrl: ''
  }, DB.config || {});

  /* ------------------------------------------------------------
     状态
     ------------------------------------------------------------ */
  /* 本地文件（file://）协议下部分浏览器禁止访问 localStorage，
     统一包一层安全读写，避免整站因异常中断 */
  var store = {
    get: function (k) {
      try { return window.localStorage.getItem(k); } catch (e) { return null; }
    },
    set: function (k, v) {
      try { window.localStorage.setItem(k, v); } catch (e) { /* 忽略：无痕模式或 file:// 限制 */ }
    }
  };

  var state = {
    q: '',
    theme: store.get('sec-theme') || CONFIG.defaultTheme || 'dark',
    observer: null,
    shown: 0          // 首页当前已展示的笔记条数（分页用）
  };

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ------------------------------------------------------------
     工具函数
     ------------------------------------------------------------ */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 关键词高亮统一由 assets/js/render.js 的 SecRender.highlight 提供 */
  function hl(text, q) {
    if (window.SecRender && SecRender.highlight) return SecRender.highlight(text, q);
    return esc(text);
  }

  function searchTerms(q) {
    return q.trim().toLowerCase().split(/\s+/).filter(function (t) { return t.length > 0; });
  }

  /* 计分检索：命中标题权重最高，其次标签/分类，最后正文 */
  function matchNote(note, terms) {
    if (!terms.length) return { hit: true, score: 0 };
    var title = note.title.toLowerCase();
    var cat = (note.category || '').toLowerCase();
    var tags = (note.tags || []).join(' ').toLowerCase();
    var summary = (note.summary || '').toLowerCase();
    var body = (note.body || '').toLowerCase();
    var score = 0;

    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      var s = 0;
      if (title.indexOf(t) > -1) s += 60;
      if (tags.indexOf(t) > -1) s += 30;
      if (cat.indexOf(t) > -1) s += 20;
      if (summary.indexOf(t) > -1) s += 10;
      if (body.indexOf(t) > -1) s += 4;
      if (s === 0) return { hit: false, score: 0 };
      score += s;
    }
    return { hit: true, score: score };
  }

  function fmtNum(n) { return Number(n || 0).toLocaleString('zh-CN'); }

  /* 每页条数：读取 blog.config.json 的 pageSize，非法值回退到 8 */
  function pageSize() {
    var n = parseInt(CONFIG.pageSize, 10);
    return (isNaN(n) || n < 1) ? 8 : n;
  }

  function findNote(slug) {
    for (var i = 0; i < NOTES.length; i++) { if (NOTES[i].slug === slug) return NOTES[i]; }
    return null;
  }

  function fmtDate(d) {
    var p = String(d || '').split('-');
    return p.length === 3 ? p[0] + '-' + p[1] + '-' + p[2] : String(d || '');
  }

  function longDate(d) {
    var p = String(d || '').split('-');
    if (p.length !== 3) return String(d || '');
    return p[0] + ' 年 ' + parseInt(p[1], 10) + ' 月 ' + parseInt(p[2], 10) + ' 日';
  }

  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

  function reEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* ------------------------------------------------------------
     路由
     ------------------------------------------------------------ */
  function parseRoute() {
    var raw = location.hash.replace(/^#\/?/, '');
    var parts = raw.split('/').filter(Boolean).map(function (p) {
      try { return decodeURIComponent(p); } catch (e) { return p; }
    });
    if (!parts.length) return { name: 'home' };
    var head = parts[0];
    if (head === 'note') return { name: 'note', slug: parts.slice(1).join('/') };
    if (head === 'category') return { name: 'home', category: parts.slice(1).join('/') };
    if (head === 'tag') return { name: 'home', tag: parts.slice(1).join('/') };
    if (head === 'archive' || head === 'tags' || head === 'about') return { name: head };
    return { name: 'home' };
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  /* ------------------------------------------------------------
     过滤与排序
     ------------------------------------------------------------ */
  function filtered(route) {
    var terms = searchTerms(state.q);
    var list = NOTES.slice();

    if (route.category) list = list.filter(function (n) { return n.category === route.category; });
    if (route.tag) list = list.filter(function (n) { return (n.tags || []).indexOf(route.tag) > -1; });

    var matched = [];
    for (var i = 0; i < list.length; i++) {
      var r = matchNote(list[i], terms);
      if (r.hit) { matched.push({ note: list[i], score: r.score }); }
    }
    if (terms.length) {
      matched.sort(function (a, b) { return b.score - a.score; });
      return matched.map(function (m) { return m.note; });
    }
    return list.sort(function (a, b) {
      return a.date === b.date ? a.title.localeCompare(b.title, 'zh') : (a.date < b.date ? 1 : -1);
    });
  }

  /* ------------------------------------------------------------
     视图：主页
     ------------------------------------------------------------ */
  function noteCard(n, q) {
    var tags = (n.tags || []).slice(0, 4).map(function (t) {
      return '<span>' + esc(t) + '</span>';
    }).join('');

    return '' +
      '<a class="note-card animate" href="#/note/' + encodeURIComponent(n.slug) + '">' +
        '<h3>' + hl(n.title, q) + '</h3>' +
        '<p>' + hl(n.summary, q) + '</p>' +
        '<div class="note-meta">' +
          '<span class="cat">' + esc(n.category) + '</span>' +
          '<span>' + fmtDate(n.date) + '</span>' +
          '<span>' + n.reading_time + ' 分钟</span>' +
          '<span>' + fmtNum(n.words) + ' 字</span>' +
          (tags ? '<span class="tags">' + tags + '</span>' : '') +
        '</div>' +
      '</a>';
  }

  function viewHome(route) {
    var list = filtered(route);
    var q = state.q;
    var parts = [];

    var isFiltered = !!(route.category || route.tag || q);

    if (!isFiltered) {
      parts.push(
        '<section class="hero animate">' +
          '<h1>' + esc(CONFIG.title) + ' · <em>' + esc(CONFIG.subtitle) + '</em></h1>' +
          '<p>' + esc(CONFIG.description || '') + '</p>' +
          '<div class="hero-meta">' +
            '<span class="chip">' + DB.stats.notes + ' 篇笔记</span>' +
            '<span class="chip">' + (DB.categories || []).length + ' 个分类</span>' +
            '<span class="chip">' + (DB.tags || []).length + ' 个标签</span>' +
            '<span class="chip">' + fmtNum(DB.stats.words) + ' 字</span>' +
          '</div>' +
        '</section>'
      );
    }

    var title = '全部笔记';
    if (route.category) title = '分类：' + esc(route.category);
    if (route.tag) title = '标签：' + esc(route.tag);
    if (q) title = '搜索结果';

    var pill = '';
    if (route.category || route.tag) {
      pill = '<span class="filter-pill">' + esc(route.category || route.tag) +
        '<button type="button" data-clear-filter title="清除筛选">×</button></span>';
    }

    parts.push(
      '<div class="list-head animate">' +
        '<h2>' + title + ' <span class="badge">' + list.length + '</span></h2>' +
        pill +
        '<span class="spacer"></span>' +
        (q ? '<span class="chip">关键词：' + esc(q) + '</span>' : '') +
      '</div>'
    );

    if (!list.length) {
      parts.push(
        '<div class="empty">' +
          '<b>没有找到匹配的笔记</b>' +
          (q ? '尝试更换关键词，或点击左侧分类浏览' : '在 notes/ 目录下新增 Markdown 文件后运行 <code>python build.py</code>') +
        '</div>'
      );
    } else {
      var size = pageSize();
      state.shown = Math.min(size, list.length);
      var visible = list.slice(0, state.shown);
      parts.push('<div class="note-list" id="noteList">' +
        visible.map(function (n) { return noteCard(n, q); }).join('') + '</div>');
      parts.push(loadMoreBar(list.length, state.shown));
    }

    return parts.join('');
  }

  /* 分页控件：仅在还有未展示的笔记时渲染 */
  function loadMoreBar(total, shown) {
    if (total <= shown) return '';
    return '<div class="load-more-wrap" id="loadMoreWrap">' +
      '<button type="button" class="load-more" data-load-more>加载更多</button>' +
      '<span class="load-more-hint">已显示 ' + shown + ' / ' + total + ' 篇，' +
      '剩余 ' + (total - shown) + ' 篇</span>' +
    '</div>';
  }

  /* 追加下一页内容，不整页重渲染，避免阅读位置跳动 */
  function loadMore() {
    var route = parseRoute();
    var list = filtered(route);
    var host = $('#noteList');
    if (!host) return;

    var next = list.slice(state.shown, state.shown + pageSize());
    if (!next.length) return;

    var box = document.createElement('div');
    box.innerHTML = next.map(function (n) { return noteCard(n, state.q); }).join('');
    while (box.firstChild) host.appendChild(box.firstChild);
    state.shown += next.length;

    var wrap = $('#loadMoreWrap');
    if (state.shown >= list.length) {
      if (wrap) wrap.remove();
    } else if (wrap) {
      wrap.querySelector('.load-more-hint').textContent =
        '已显示 ' + state.shown + ' / ' + list.length + ' 篇，剩余 ' + (list.length - state.shown) + ' 篇';
    }
  }

  /* ------------------------------------------------------------
     视图：归档
     ------------------------------------------------------------ */
  function viewArchive() {
    if (!NOTES.length) return '<div class="empty"><b>暂无笔记</b></div>';

    var sorted = NOTES.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var groups = {};
    sorted.forEach(function (n) {
      var y = String(n.date).slice(0, 4);
      (groups[y] = groups[y] || []).push(n);
    });

    var out = ['<div class="list-head animate"><h2>归档 <span class="badge">' + NOTES.length + '</span></h2></div>'];

    Object.keys(groups).sort(function (a, b) { return b - a; }).forEach(function (y) {
      out.push(
        '<div class="archive-year animate">' +
          '<div class="year-title">' + y + '<span style="font-size:12px;color:var(--muted-2)">' +
          groups[y].length + ' 篇</span></div>' +
          groups[y].map(function (n) {
            return '<a class="arch-item" href="#/note/' + encodeURIComponent(n.slug) + '">' +
              '<time>' + fmtDate(n.date).slice(5) + '</time>' +
              '<span class="t">' + esc(n.title) + '</span>' +
              '<span class="c">' + esc(n.category) + '</span>' +
            '</a>';
          }).join('') +
        '</div>'
      );
    });

    return out.join('');
  }

  /* ------------------------------------------------------------
     视图：标签
     ------------------------------------------------------------ */
  function viewTags() {
    var cats = DB.categories || [];
    var tags = DB.tags || [];
    var out = ['<div class="list-head animate"><h2>标签与分类</h2></div>'];

    out.push(
      '<div class="tag-section animate">' +
        '<h3>按分类浏览（' + cats.length + '）</h3>' +
        '<div class="tag-cloud-lg">' +
          cats.map(function (c) {
            return '<a href="#/category/' + encodeURIComponent(c[0]) + '">' + esc(c[0]) + ' <b>' + c[1] + '</b></a>';
          }).join('') +
        '</div>' +
      '</div>'
    );

    out.push(
      '<div class="tag-section animate">' +
        '<h3>按标签浏览（' + tags.length + '）</h3>' +
        '<div class="tag-cloud-lg">' +
          tags.map(function (t) {
            return '<a href="#/tag/' + encodeURIComponent(t[0]) + '">#' + esc(t[0]) + ' <b>' + t[1] + '</b></a>';
          }).join('') +
        '</div>' +
      '</div>'
    );

    return out.join('');
  }

  /* ------------------------------------------------------------
     视图：关于
     ------------------------------------------------------------ */
  function viewAbout() {
    return '' +
      '<div class="list-head animate"><h2>关于</h2></div>' +
      '<div class="about-card animate">' +
        '<h2>' + esc(CONFIG.title) + '</h2>' +
        '<p>' + esc(CONFIG.description || '') + '</p>' +
        '<h3>这个站点是什么</h3>' +
        '<p>一个纯静态的个人网络安全笔记库。所有内容以 Markdown 存放在 <code>notes/</code> 目录下，' +
        '运行构建脚本后生成单页应用所需的索引数据，无需数据库与后端服务。</p>' +
        '<h3>如何新增笔记</h3>' +
        '<p>笔记以 Markdown 文件存放在 <code>notes/</code> 目录。管理入口是项目根目录下的 ' +
        '<code>manage.html</code>，双击即可打开，不需要启动任何服务。也可以直接新建/编辑文件：</p>' +
        '<pre>---\n' +
        'title: 笔记标题\n' +
        'date: 2026-09-10\n' +
        'category: Web 安全\n' +
        'tags: [SQL注入, OWASP]\n' +
        'summary: 一句话摘要（可省略，省略时自动截取正文首段）\n' +
        '---\n\n' +
        '# 正文标题\n\n' +
        '正文内容，支持 GFM 表格、任务列表与代码高亮。</pre>' +
        '<p>保存后回到项目根目录执行：</p>' +
        '<pre>python build.py</pre>' +
        '<p>然后刷新浏览器即可看到新笔记。若要本地以 HTTP 方式预览：</p>' +
        '<pre>python -m http.server 8080\n# 浏览器打开 http://127.0.0.1:8080</pre>' +
        '<h3>功能一览</h3>' +
        '<ul>' +
          '<li>标题、标签、分类、正文的加权全文检索（按 <code>/</code> 快速聚焦搜索框）</li>' +
          '<li>分类与标签筛选、按年份归档视图</li>' +
          '<li>代码高亮、一键复制、长文自动生成目录</li>' +
          '<li>明暗主题切换，阅读进度条，响应式布局</li>' +
          '<li>纯静态，可离线打开，可直接部署到任意静态托管</li>' +
        '</ul>' +
        '<h3>当前状态</h3>' +
        '<ul>' +
          '<li>笔记总数：' + DB.stats.notes + ' 篇</li>' +
          '<li>分类 / 标签：' + (DB.categories || []).length + ' / ' + (DB.tags || []).length + '</li>' +
          '<li>最后构建：' + esc(DB.stats.builtAt || '—') + '</li>' +
        '</ul>' +
      '</div>';
  }

  /* ------------------------------------------------------------
     视图：文章
     注：Markdown 渲染、HTML 净化、代码块（语言标签/复制/高亮）与
         表格后处理统一由 assets/js/render.js 的 SecRender 提供，
         与后台编辑器预览共用同一套链路，确保两处呈现完全一致。
     ------------------------------------------------------------ */
  function buildToc(headings, host) {
    var items = headings.filter(function (h) { return h.level >= 2 && h.level <= 4; });
    if (items.length < 2) { host.innerHTML = ''; return; }

    host.innerHTML = '<h5>目录</h5><ul>' + items.map(function (h) {
      return '<li class="lvl-' + h.level + '"><a href="#' + escAttr(h.id) + '" data-toc="' + escAttr(h.id) + '">' +
        esc(h.text) + '</a></li>';
    }).join('') + '</ul>';

    $$('a[data-toc]', host).forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var el = document.getElementById(a.getAttribute('data-toc'));
        if (el) {
          var top = el.getBoundingClientRect().top + window.pageYOffset - 84;
          window.scrollTo({ top: top, behavior: 'smooth' });
        }
      });
    });
  }

  function spyToc(headings) {
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    var links = $$('.toc a[data-toc]');
    if (!links.length) return;

    var targets = headings.filter(function (h) { return h.level >= 2 && h.level <= 4; })
      .map(function (h) { return document.getElementById(h.id); })
      .filter(Boolean);
    if (!targets.length) return;

    var current = null;
    var setActive = function (id) {
      if (current === id) return;
      current = id;
      links.forEach(function (a) {
        a.classList.toggle('active', a.getAttribute('data-toc') === id);
      });
    };

    state.observer = new IntersectionObserver(function (entries) {
      var visible = entries.filter(function (e) { return e.isIntersecting; })
        .sort(function (a, b) { return a.boundingClientRect.top - b.boundingClientRect.top; });
      if (visible.length) setActive(visible[0].target.id);
    }, { rootMargin: '-84px 0px -70% 0px', threshold: [0, 1] });

    targets.forEach(function (t) { state.observer.observe(t); });
  }

  /* 反向链接：列出正文中引用了本篇的其他笔记，并附上引用处的上下文 */
  function contextSnippet(body, title) {
    var re = new RegExp('\\[\\[\\s*' + reEscape(title) + '\\s*(?:\\|[^\\]]*)?\\]\\]', 'i');
    var lines = String(body || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        var t = lines[i].trim().replace(/^[-*+>]\s*/, '');
        return esc(t.length > 96 ? t.slice(0, 96) + '…' : t);
      }
    }
    return '';
  }

  function backlinksSection(note) {
    var sources = (BACKLINKS[note.slug] || []).map(findNote).filter(Boolean);
    if (!sources.length) return '';

    return '<section class="backlinks animate">' +
      '<h3>反向链接 <span class="bl-count">' + sources.length + '</span></h3>' +
      '<div class="backlink-list">' +
        sources.map(function (s) {
          var ctx = contextSnippet(s.body, note.title);
          return '<a class="backlink" href="#/note/' + encodeURIComponent(s.slug) + '">' +
            '<span class="backlink-title">' + esc(s.title) + '</span>' +
            (ctx ? '<span class="backlink-ctx">' + ctx + '</span>' : '') +
          '</a>';
        }).join('') +
      '</div>' +
    '</section>';
  }

  /* 相关笔记：同分类计 3 分，每命中一个相同标签计 2 分 */
  function relatedNotes(note, limit) {
    var scored = [];
    NOTES.forEach(function (o) {
      if (o.slug === note.slug) return;
      var score = 0;
      var shared = [];
      if (o.category === note.category) score += 3;
      (o.tags || []).forEach(function (t) {
        if ((note.tags || []).indexOf(t) > -1) { score += 2; shared.push(t); }
      });
      if (score > 0) scored.push({ note: o, score: score, shared: shared });
    });
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.note.date < b.note.date ? 1 : -1;
    });
    return scored.slice(0, limit || 4);
  }

  function relatedSection(note) {
    var rel = relatedNotes(note, 4);
    if (!rel.length) return '';

    return '<section class="related animate">' +
      '<h3>相关笔记</h3>' +
      '<div class="related-list">' +
        rel.map(function (r) {
          var meta = esc(r.note.category);
          if (r.shared.length) meta += ' · 共同标签 ' + esc(r.shared.slice(0, 3).join('、'));
          return '<a href="#/note/' + encodeURIComponent(r.note.slug) + '">' +
            '<span class="related-title">' + esc(r.note.title) + '</span>' +
            '<span class="related-meta">' + meta + '</span>' +
          '</a>';
        }).join('') +
      '</div>' +
    '</section>';
  }

  function viewPost(route, n) {
    if (!n) {
      return '<div class="empty"><b>笔记不存在</b>该链接可能已失效，' +
        '<a href="#/">返回首页</a></div>';
    }

    var idx = NOTES.indexOf(n);
    var newer = idx > 0 ? NOTES[idx - 1] : null;
    var older = idx > -1 && idx < NOTES.length - 1 ? NOTES[idx + 1] : null;

    var tags = (n.tags || []).map(function (t) {
      return '<a class="tag" href="#/tag/' + encodeURIComponent(t) + '">#' + esc(t) + '</a>';
    }).join('');

    var head =
      '<div class="post-header">' +
        '<div class="crumbs">' +
          '<a href="#/">首页</a><span class="sep">/</span>' +
          '<a href="#/category/' + encodeURIComponent(n.category) + '">' + esc(n.category) + '</a>' +
          '<span class="sep">/</span><span>' + esc(n.title) + '</span>' +
        '</div>' +
        '<h1>' + esc(n.title) + '</h1>' +
        '<div class="post-meta">' +
          '<span>' + longDate(n.date) + '</span>' +
          '<span class="sep">·</span>' +
          '<span>约 ' + n.reading_time + ' 分钟</span>' +
          '<span class="sep">·</span>' +
          '<span>' + fmtNum(n.words) + ' 字</span>' +
          (tags ? '<span class="sep">·</span>' + tags : '') +
        '</div>' +
      '</div>';

    var nav =
      '<div class="post-nav">' +
        (newer
          ? '<a href="#/note/' + encodeURIComponent(newer.slug) + '"><small>← 更新的一篇</small><strong>' + esc(newer.title) + '</strong></a>'
          : '<span class="placeholder"></span>') +
        (older
          ? '<a class="next" href="#/note/' + encodeURIComponent(older.slug) + '"><small>更早的一篇 →</small><strong>' + esc(older.title) + '</strong></a>'
          : '<span class="placeholder"></span>') +
      '</div>';

    return '<div class="post-wrap"><article class="post-layout">' +
      '<div><div class="animate">' + head + '</div>' +
      '<div class="post-body animate" id="postBody"></div>' +
      backlinksSection(n) +
      relatedSection(n) +
      nav + '</div>' +
      '<nav class="toc" id="toc"></nav>' +
      '</article></div>';
  }

  /* ------------------------------------------------------------
     渲染入口
     ------------------------------------------------------------ */
  function render() {
    var route = parseRoute();
    var app = $('#app');
    if (!app) return;

    if (state.observer) { state.observer.disconnect(); state.observer = null; }

    var note = route.name === 'note' ? findNote(route.slug) : null;

    var html;
    if (route.name === 'note') html = viewPost(route, note);
    else if (route.name === 'archive') html = viewArchive();
    else if (route.name === 'tags') html = viewTags();
    else if (route.name === 'about') html = viewAbout();
    else html = viewHome(route);

    app.innerHTML = html;

    if (route.name === 'note' && note) {
      var body = $('#postBody');
      if (body) {
        var headings = window.SecRender
          ? SecRender.render(note.body, body)
          : (body.innerHTML = '<pre>' + esc(note.body) + '</pre>', []);
        var toc = $('#toc');
        if (toc) { buildToc(headings, toc); spyToc(headings); }
      }
      document.title = note.title + ' · ' + CONFIG.title;
    } else {
      document.title = CONFIG.title + ' · ' + CONFIG.subtitle;
    }

    syncActive(route);
    syncProgress();
  }

  function syncActive(route) {
    $$('.topnav a').forEach(function (a) {
      var key = a.getAttribute('data-nav');
      var on = (key === 'home' && route.name === 'home' && !route.category && !route.tag) ||
        (key === route.name);
      a.classList.toggle('active', !!on);
    });

    $$('#categoryList a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-category') === route.category);
    });
    $$('#tagCloud a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-tag') === route.tag);
    });
  }

  function syncProgress() {
    var bar = $('#progressBar');
    var top = $('#toTop');
    if (!bar) return;
    var route = parseRoute();
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    var pct = 0;
    if (route.name === 'note' && max > 40) {
      pct = Math.min(100, Math.max(0, (h.scrollTop / max) * 100));
    }
    bar.style.width = pct + '%';
    if (top) top.hidden = h.scrollTop < 420;
  }

  /* ------------------------------------------------------------
     侧边栏构建
     ------------------------------------------------------------ */
  function buildSidebar() {
    var catList = $('#categoryList');
    if (catList) {
      var total = '<li><a href="#/" data-category="" style="' + ('' ) + '">' +
        '<span>全部</span><span class="count">' + NOTES.length + '</span></a></li>';
      catList.innerHTML = total + (DB.categories || []).map(function (c) {
        return '<li><a href="#/category/' + encodeURIComponent(c[0]) + '" data-category="' + escAttr(c[0]) + '">' +
          '<span>' + esc(c[0]) + '</span><span class="count">' + c[1] + '</span></a></li>';
      }).join('');
    }

    var cloud = $('#tagCloud');
    if (cloud) {
      cloud.innerHTML = (DB.tags || []).map(function (t) {
        return '<a class="tag" href="#/tag/' + encodeURIComponent(t[0]) + '" data-tag="' + escAttr(t[0]) + '">' +
          esc(t[0]) + '<i>' + t[1] + '</i></a>';
      }).join('') || '<span style="font-size:13px;color:var(--muted-2)">暂无标签</span>';
    }

    var set = function (id, val) { var el = $(id); if (el) el.textContent = val; };
    set('#statNotes', DB.stats.notes || 0);
    set('#statCats', (DB.categories || []).length);
    set('#statTags', (DB.tags || []).length);
    set('#statWords', fmtNum(DB.stats.words));
    set('#builtAt', '构建于 ' + (DB.stats.builtAt || '—'));

    $('#brandTitle').textContent = CONFIG.title;
    $('#brandSub').textContent = CONFIG.subtitle;
    $('#footerText').textContent = (CONFIG.author ? CONFIG.author + ' · ' : '') +
      (CONFIG.footer || '') + ' © ' + new Date().getFullYear();
  }

  /* ------------------------------------------------------------
     主题
     ------------------------------------------------------------ */
  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    var dark = $('#hljs-theme-dark');
    var light = $('#hljs-theme-light');
    if (dark) dark.disabled = theme !== 'dark';
    if (light) light.disabled = theme !== 'light';
    store.set('sec-theme', theme);
  }

  /* ------------------------------------------------------------
     搜索
     ------------------------------------------------------------ */
  function bindSearch() {
    var input = $('#searchInput');
    var clear = $('#searchClear');
    if (!input) return;

    var timer = null;
    input.addEventListener('input', function () {
      state.q = input.value;
      if (clear) clear.hidden = !input.value;
      clearTimeout(timer);
      timer = setTimeout(function () {
        var route = parseRoute();
        if (route.name !== 'home' && state.q) {
          location.hash = '#/';
        } else {
          render();
        }
      }, 130);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        input.value = ''; state.q = ''; render(); input.blur();
      }
    });

    if (clear) {
      clear.addEventListener('click', function () {
        input.value = ''; state.q = ''; if (clear) clear.hidden = true; render(); input.focus();
      });
    }

    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        openNav(false);
        input.focus();
      }
      if (e.key === 'Escape') { openNav(false); }
      if (e.key.toLowerCase() === 't' && !typing && !e.ctrlKey && !e.metaKey) {
        applyTheme(state.theme === 'dark' ? 'light' : 'dark');
      }
    });
  }

  /* ------------------------------------------------------------
     移动端导航
     ------------------------------------------------------------ */
  function openNav(open) {
    document.body.classList.toggle('nav-open', !!open);
  }

  function bindNav() {
    var btn = $('#menuBtn');
    var backdrop = $('#backdrop');
    if (btn) btn.addEventListener('click', function () { openNav(!document.body.classList.contains('nav-open')); });
    if (backdrop) backdrop.addEventListener('click', function () { openNav(false); });
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.sidebar a')) openNav(false);
    });
  }

  /* ------------------------------------------------------------
     启动
     ------------------------------------------------------------ */
  function boot() {
    applyTheme(state.theme);
    buildSidebar();
    bindSearch();
    bindNav();

    /* 注册笔记索引，双向链接 [[标题]] 才能解析为站内链接 */
    if (window.SecRender && SecRender.setNoteIndex) SecRender.setNoteIndex(NOTES);

    /* 仅在配置了站点地址（即已生成 rss.xml）时声明订阅源 */
    if (CONFIG.siteUrl) {
      var feed = document.createElement('link');
      feed.rel = 'alternate';
      feed.type = 'application/rss+xml';
      feed.title = CONFIG.title;
      feed.href = 'rss.xml';
      document.head.appendChild(feed);
    }

    var themeBtn = $('#themeToggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', function () {
        applyTheme(state.theme === 'dark' ? 'light' : 'dark');
      });
    }

    var searchToggle = $('#searchToggle');
    if (searchToggle) {
      searchToggle.addEventListener('click', function () {
        var input = $('#searchInput');
        if (document.body.classList.contains('nav-open') || window.innerWidth > 900) {
          if (input) input.focus();
        } else {
          openNav(true);
          setTimeout(function () { if (input) input.focus(); }, 220);
        }
      });
    }

    var toTop = $('#toTop');
    if (toTop) toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

    window.addEventListener('scroll', syncProgress, { passive: true });
    window.addEventListener('resize', syncProgress, { passive: true });

    window.addEventListener('hashchange', function () {
      var r = parseRoute();
      render();
      if (!(r.name === 'note' && location.hash.indexOf('#', 1) > -1)) {
        window.scrollTo(0, 0);
      }
    });

    /* 管理端同步完成后会广播刷新信号，让已打开的展示端自动重载。
       但下面两条通道都只在「同 origin」成立，且各有盲区：
         · storage 事件不跨 origin，部分浏览器在 file:// 下也不派发；
         · BroadcastChannel 在 file:// 下可能直接不可用。
       所以再叠一层**轮询兜底**：直接读标记值，变了就重载。
       这是唯一在 file:// 与 http 下都可靠的通道，也是「删了却看不到变化」
       这类问题的最后一道保障。 */
    var RELOAD_KEY = 'secnotes.reloadAt';
    var POLL_MS = 3000;
    var lastReloadAt = null;
    try { lastReloadAt = localStorage.getItem(RELOAD_KEY); } catch (e) { /* 存储不可用 */ }

    window.addEventListener('storage', function (e) {
      if (e.key === RELOAD_KEY && e.newValue) window.location.reload();
    });
    if (window.BroadcastChannel) {
      try {
        var ch = new BroadcastChannel('secnotes');
        ch.addEventListener('message', function (e) {
          if (e.data && e.data.type === 'reload') window.location.reload();
        });
      } catch (err) { /* 忽略：特性不可用时退化为轮询 */ }
    }
    try {
      setInterval(function () {
        if (document.hidden) return;            // 后台标签页不检查，省电
        var v;
        try { v = localStorage.getItem(RELOAD_KEY); } catch (err) { return; }
        if (v && v !== lastReloadAt) {
          lastReloadAt = v;
          window.location.reload();
        }
      }, POLL_MS);
    } catch (err) { /* 环境不支持定时器时忽略 */ }

    /* ---- 兜底（关键）：轮询服务端的站点数据版本戳 ----
       上面两条通道与 localStorage 轮询都依赖「同 origin」，
       但 manage.html 常以 file:// 打开、展示端常以 http://127.0.0.1:8080 打开，
       两者**跨 origin** —— 实测 localStorage 与 BroadcastChannel 此时完全不通，
       于是「管理端删了、展示端没反应」。
       <script> 标签不受同源策略限制，所以改用 JSONP 去服务端取版本戳：
       只要 data/notes.js 被重建过，版本就会变，展示端随即重载。
       服务不可达时静默跳过，不影响纯静态阅读。 */
    var SYNC_PORTS = [8080, 8081, 9000];
    var verBase = null, lastVer = null, verBusy = false;

    function loadVersion(cb) {
      var s = document.createElement('script');
      s.src = (verBase || 'http://127.0.0.1:' + SYNC_PORTS[0] + '/') +
        'api/version.js?t=' + Date.now();
      s.onload = function () { cb(true); };
      s.onerror = function () { cb(false); };
      document.head.appendChild(s);
    }
    function probePort(i) {
      if (i >= SYNC_PORTS.length) { verBusy = false; verBase = null; return; }
      verBase = 'http://127.0.0.1:' + SYNC_PORTS[i] + '/';
      loadVersion(function (ok) {
        if (ok && window.SEC_SITE_VERSION) {
          lastVer = window.SEC_SITE_VERSION;
          verBusy = false;
        } else {
          probePort(i + 1);
        }
      });
    }
    try {
      setInterval(function () {
        if (document.hidden) return;
        if (verBusy) return;
        verBusy = true;
        if (!verBase) { probePort(0); return; }      // 首次/服务重启后重新探测端口
        loadVersion(function (ok) {
          verBusy = false;
          if (!ok) { verBase = null; return; }       // 服务关了，下次重新探测
          var v = window.SEC_SITE_VERSION;
          if (!v) return;
          if (lastVer && v !== lastVer) {
            lastVer = v;
            window.location.reload();
          } else {
            lastVer = v;
          }
        });
      }, POLL_MS);
    } catch (err) { /* 环境不支持时忽略 */ }

    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.hasAttribute) return;
      if (t.hasAttribute('data-clear-filter')) {
        go('#/');
      } else if (t.hasAttribute('data-load-more')) {
        loadMore();
      }
    });

    if (!location.hash) location.hash = '#/';
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
