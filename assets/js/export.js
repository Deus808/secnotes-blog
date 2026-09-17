/* ============================================================
   SecNotes 单文件导出 — 导出页逻辑
   ------------------------------------------------------------
   由 export.py 内联进生成的单文件 HTML，因此：
     · 数据来自内联的 window.EXPORT_DATA
     · 正文渲染复用 assets/js/render.js（与站点同一链路）
     · 双向链接指向页内锚点而非站内路由（通过 render 的
       wikiHref / idPrefix 选项定制）
   ============================================================ */
(function () {
  'use strict';

  var D = window.EXPORT_DATA || { notes: [], categories: [], backlinks: {} };
  var NOTES = D.notes || [];
  var BACKLINKS = D.backlinks || {};

  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) {
    return (window.SecRender && SecRender.esc) ? SecRender.esc(s) : String(s == null ? '' : s);
  };

  function anchorOf(slug) { return '#note-' + slug; }
  function titleOf(slug) {
    for (var i = 0; i < NOTES.length; i++) if (NOTES[i].slug === slug) return NOTES[i].title;
    return slug;
  }

  /* ------------------------------------------------------------
     正文渲染：与站点共用 render.js，但锚点与链接指向页内
     ------------------------------------------------------------ */
  function renderBody(note, host) {
    if (!window.SecRender) {
      host.textContent = note.body || '';
      return;
    }
    SecRender.render(note.body, host, {
      wikiHref: anchorOf,            // [[标题]] → 页内锚点
      wikiMissingHref: '#',          // 待创建的链接在导出件里无处可跳
      idPrefix: note.slug + '--'     // 避免多篇笔记的标题 id 冲突
    });
  }

  /* ------------------------------------------------------------
     侧边目录
     ------------------------------------------------------------ */
  function bodyHitCount(note, q) {
    if (!q) return 0;
    var body = String(note.body || '').toLowerCase();
    var hits = 0, from = 0, at;
    while ((at = body.indexOf(q, from)) > -1) { hits++; from = at + q.length; }
    return hits;
  }

  function renderToc() {
    var q = ($('#expSearch') && $('#expSearch').value || '').trim().toLowerCase();
    var groups = {};
    var shown = 0;

    NOTES.forEach(function (n) {
      var hay = (n.title + ' ' + n.category + ' ' + (n.tags || []).join(' ')).toLowerCase();
      var inBody = q ? bodyHitCount(n, q) : 0;
      if (q && hay.indexOf(q) === -1 && !inBody) return;
      (groups[n.category] = groups[n.category] || []).push({ note: n, bodyHits: inBody });
      shown++;
    });

    $('.exp-sub').textContent = q ? ('命中 ' + shown + ' 篇') : '笔记全集';

    var html = '';
    var order = (D.categories || []).map(function (c) { return c[0]; });
    Object.keys(groups).sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia === -1) ia = 999; if (ib === -1) ib = 999;
      return ia - ib;
    }).forEach(function (cat) {
      html += '<div class="exp-toc-group">' +
        '<div class="exp-toc-head">' + esc(cat) + '<span>' + groups[cat].length + '</span></div>' +
        groups[cat].map(function (item) {
          var n = item.note;
          var title = q ? SecRender.highlight(n.title, q) : esc(n.title);
          return '<a href="' + anchorOf(n.slug) + '" data-slug="' + esc(n.slug) + '">' +
            '<span>' + title + '</span>' +
            (item.bodyHits ? '<span class="hit">正文 ' + item.bodyHits + ' 处</span>' : '') +
          '</a>';
        }).join('') +
      '</div>';
    });

    $('#expToc').innerHTML = html || '<div class="exp-toc-empty">没有匹配的笔记</div>';
  }

  /* ------------------------------------------------------------
     正文
     ------------------------------------------------------------ */
  function renderNotes() {
    var host = $('#expMain');
    host.innerHTML = NOTES.map(function (n) {
      return '<article class="exp-note" id="note-' + esc(n.slug) + '">' +
        '<div class="exp-note-head">' +
          '<h2 class="exp-note-title">' + esc(n.title) + '</h2>' +
          '<div class="exp-note-meta">' +
            '<span class="cat">' + esc(n.category) + '</span>' +
            '<span>' + esc(n.date) + '</span>' +
            '<span>约 ' + n.reading_time + ' 分钟</span>' +
            '<span>' + (n.words || 0).toLocaleString('zh-CN') + ' 字</span>' +
            (n.tags || []).map(function (t) {
              return '<span class="tag">#' + esc(t) + '</span>';
            }).join('') +
            '<a class="exp-anchor" href="#top">↑ 回到顶部</a>' +
          '</div>' +
        '</div>' +
        '<div class="post-body exp-note-body" data-body="' + esc(n.slug) + '"></div>' +
        backlinksHtml(n) +
      '</article>';
    }).join('');

    // 逐篇渲染正文（复用与站点一致的链路）
    Array.prototype.forEach.call(host.querySelectorAll('.exp-note-body'), function (el) {
      var slug = el.getAttribute('data-body');
      for (var i = 0; i < NOTES.length; i++) {
        if (NOTES[i].slug === slug) { renderBody(NOTES[i], el); break; }
      }
    });
  }

  function backlinksHtml(note) {
    var sources = (BACKLINKS[note.slug] || []).filter(function (s) {
      return NOTES.some(function (x) { return x.slug === s; });
    });
    if (!sources.length) return '';
    return '<div class="exp-backlinks">' +
      '<h4>反向链接 · ' + sources.length + '</h4>' +
      '<div class="exp-bl-list">' +
        sources.map(function (s) {
          return '<a href="' + anchorOf(s) + '">' + esc(titleOf(s)) + '</a>';
        }).join('') +
      '</div>' +
    '</div>';
  }

  /* ------------------------------------------------------------
     主题
     ------------------------------------------------------------ */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var dark = $('#hljs-theme-dark'), light = $('#hljs-theme-light');
    if (dark) dark.disabled = theme !== 'dark';
    if (light) light.disabled = theme !== 'light';
    try { localStorage.setItem('sec-theme', theme); } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------
     目录高亮：随滚动标出当前笔记
     ------------------------------------------------------------ */
  function spyToc() {
    var links = Array.prototype.slice.call(document.querySelectorAll('#expToc a'));
    if (!links.length || !('IntersectionObserver' in window)) return;

    var map = {};
    links.forEach(function (a) { map[a.getAttribute('data-slug')] = a; });

    var observer = new IntersectionObserver(function (entries) {
      var visible = entries.filter(function (e) { return e.isIntersecting; })
        .sort(function (a, b) { return a.boundingClientRect.top - b.boundingClientRect.top; });
      if (!visible.length) return;
      var slug = visible[0].target.id.replace(/^note-/, '');
      links.forEach(function (a) { a.classList.remove('active'); });
      if (map[slug]) map[slug].classList.add('active');
    }, { rootMargin: '-90px 0px -70% 0px', threshold: [0, 1] });

    Array.prototype.forEach.call(document.querySelectorAll('.exp-note'), function (el) {
      observer.observe(el);
    });
  }

  /* ------------------------------------------------------------
     启动
     ------------------------------------------------------------ */
  function boot() {
    if (window.SecRender && SecRender.setNoteIndex) SecRender.setNoteIndex(NOTES);

    var saved = null;
    try { saved = localStorage.getItem('sec-theme'); } catch (e) { /* 忽略 */ }
    applyTheme(saved || (D.config && D.config.defaultTheme) || 'dark');

    renderToc();
    renderNotes();
    spyToc();

    var search = $('#expSearch');
    if (search) {
      var timer = null;
      search.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(function () { renderToc(); spyToc(); }, 120);
      });
      search.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var first = document.querySelector('#expToc a');
        if (first) first.click();
      });
    }

    var themeBtn = $('#expTheme');
    if (themeBtn) {
      themeBtn.addEventListener('click', function () {
        applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
      });
    }

    var printBtn = $('#expPrint');
    if (printBtn) printBtn.addEventListener('click', function () { window.print(); });

    document.title = (D.config && D.config.title ? D.config.title : 'SecNotes') +
      ' · 笔记全集' + (D.exportedAt ? '（' + D.exportedAt.slice(0, 10) + '）' : '');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 供自检脚本使用 */
  window.__EXPORT__ = { renderToc: renderToc, renderNotes: renderNotes, state: D };
})();
