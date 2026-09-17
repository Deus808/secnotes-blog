/* ============================================================
   SecNotes 内容编辑器
   ------------------------------------------------------------
   · 笔记的增 / 改 / 删与回收站还原，全部通过本地服务 API
   · 预览直接复用 assets/js/render.js（SecRender），与站点文章页
     共用 marked + highlight.js + 后处理 + 同一份 style.css，
     因此编辑器所见即站点所渲染
   ============================================================ */
(function () {
  'use strict';

  var TOKEN = window.ADMIN_TOKEN || '';
  var $ = function (s) { return document.querySelector(s); };

  var S = {
    notes: [],
    trashed: [],
    cats: [],
    tags: [],
    current: null,      // 当前笔记在磁盘上的 slug
    dirty: false,
    tab: 'notes',
    query: '',
    lastLang: 'bash',
    confirmCb: null,
    confirmCancel: null,
    declinedDrafts: {},  // 本次会话中已选择「不恢复」的草稿
    searchResults: null, // null 表示未检索；数组表示检索结果
    searching: false,
    searchTotal: 0,
    searchTruncated: false,
    searchRelaxed: false,
    searchToken: 0,      // 用于丢弃过期的检索响应
    links: {},           // 链接图（来自服务端，与站点同一实现）
    backlinks: {},
    broken: {},
    pickerFrag: null,    // 当前 [[ 联想片段的定位信息
    pickerItems: [],
    pickerIndex: 0,
    pickerSuppressed: false
  };

  var TA, PREVIEW, PREVIEW_SCROLL;

  /* ============================================================
     基础：API / 提示 / 状态
     ============================================================ */
  var OFFLINE_HINT = '无法连接本地服务（请确认 admin.py 正在运行，并通过它打印的地址访问）';

  function api(path, opt) {
    opt = opt || {};
    return fetch(path, {
      method: opt.method || 'GET',
      headers: {
        'X-Admin-Token': TOKEN,
        'Content-Type': 'application/json'
      },
      body: opt.body ? JSON.stringify(opt.body) : undefined
    }).then(function (res) {
      // 经 python -m http.server 等纯静态方式打开时，/api/ 会 404，
      // 与 file:// 一样应归入「未连接本地服务」并给出启动指引
      if (res.status === 404) {
        return { ok: false, error: OFFLINE_HINT, offline: true };
      }
      return res.json().catch(function () {
        return { ok: false, error: '服务响应异常（HTTP ' + res.status + '）' };
      });
    }).catch(function () {
      // 直接以 file:// 打开页面，或服务已停止
      return { ok: false, error: OFFLINE_HINT, offline: true };
    });
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, isErr ? 4600 : 2600);
  }

  function setStatus(text, kind) {
    var el = $('#stBuild');
    el.textContent = text;
    el.className = kind || '';
    if (kind === 'ok' || kind === 'err') {
      setTimeout(function () { el.className = ''; }, 4000);
    }
  }

  function buildSummary(build) {
    if (!build) return '';
    if (build.skipped) return build.output;
    var line = (build.output || '').split('\n').filter(function (l) { return /笔记总数|已生成/.test(l); });
    return line.length ? line.join(' / ').replace(/\s+/g, ' ').trim() : (build.ok ? '构建完成' : '构建失败');
  }

  function setDirty(v) {
    S.dirty = !!v;
    $('#btnSave').disabled = false;
    document.title = (S.dirty ? '● ' : '') + '内容编辑器 · SecNotes';
  }

  /* ============================================================
     加载与列表
     ============================================================ */
  function loadState() {
    return api('/api/state').then(function (r) {
      if (!r.ok) {
        if (r.offline) return showOffline();
        toast(r.error || '加载失败', true);
        return;
      }
      S.notes = r.notes || [];
      S.trashed = r.trash || [];
      S.cats = r.categories || [];
      S.tags = r.tags || [];
      S.links = r.links || {};
      S.backlinks = r.backlinks || {};
      S.broken = r.broken || {};

      /* 注册标题索引，双向链接才能解析；与站点做法一致 */
      if (SecRender.setNoteIndex) SecRender.setNoteIndex(S.notes);

      var dl = $('#catList');
      dl.innerHTML = S.cats.map(function (c) {
        return '<option value="' + SecRender.esc(c[0]) + '">' + c[1] + ' 篇</option>';
      }).join('');

      $('#countPill').textContent = S.notes.length + ' 篇笔记 · ' +
        S.cats.length + ' 分类 · ' + S.tags.length + ' 标签';
      renderList();
      renderLinkPanel();
    });
  }

  /* 未启动本地服务时的兜底提示（例如直接双击打开了本页面） */
  function showOffline() {
    $('#countPill').textContent = '未连接服务';
    $('#listScroll').innerHTML =
      '<div class="adm-list-empty">' +
        '<b style="color:var(--text);display:block;margin-bottom:10px">未连接本地服务</b>' +
        '编辑器需要通过本地服务读写 notes/ 目录。<br><br>' +
        '请在项目目录执行：<br><br>' +
        '<code style="font-family:var(--font-mono);color:var(--accent)">python admin.py</code><br><br>' +
        '然后打开终端中打印的地址（含访问令牌）。' +
      '</div>';
    showEmpty();
    setStatus('未连接服务', 'err');
  }

  function filteredNotes() {
    var q = S.query.trim().toLowerCase();
    if (!q) return S.notes;
    return S.notes.filter(function (n) {
      return (n.title + ' ' + n.category + ' ' + (n.tags || []).join(' ')).toLowerCase().indexOf(q) > -1;
    });
  }

  function renderList() {
    var host = $('#listScroll');
    // 有检索词时统一走服务端全文检索（覆盖标题 / 分类 / 标签 / 正文）
    if (S.query.trim()) return renderSearchResults(host);
    if (S.tab === 'trash') return renderTrash(host);

    var list = filteredNotes();
    if (!list.length) {
      host.innerHTML = '<div class="adm-list-empty">' +
        (S.query ? '没有匹配的笔记' : '还没有笔记，点击上方「新建笔记」开始') + '</div>';
      return;
    }

    host.innerHTML = list.map(function (n) {
      var meta = '<span class="tag-cat">' + SecRender.esc(n.category) + '</span>' +
        '<span>' + SecRender.esc(n.date) + '</span>' +
        '<span>' + n.words + ' 字</span>' +
        (n.draft ? '<span class="tag-draft">草稿</span>' : '');
      return '<button type="button" class="adm-item' + (n.slug === S.current ? ' active' : '') +
        '" data-slug="' + SecRender.esc(n.slug) + '">' +
        '<span class="adm-item-title">' + SecRender.esc(n.title) + '</span>' +
        '<span class="adm-item-meta">' + meta + '</span>' +
      '</button>';
    }).join('');
  }

  /* ------------------------------------------------------------
     正文全文检索：标题命中的排前面，正文命中给出行号可跳转
     ------------------------------------------------------------ */
  function runSearch() {
    var q = S.query.trim();
    if (!q) {
      S.searchResults = null;
      renderList();
      return;
    }
    var token = ++S.searchToken;
    S.searching = true;
    renderList();

    api('/api/search?q=' + encodeURIComponent(q)).then(function (r) {
      if (token !== S.searchToken) return;      // 已有更新的检索，丢弃本次结果
      S.searching = false;
      if (!r.ok) {
        S.searchResults = null;
        renderList();
        toast(r.error || '检索失败', true);
        return;
      }
      S.searchResults = r.results || [];
      S.searchTotal = r.total || 0;
      S.searchTruncated = !!r.truncated;
      S.searchRelaxed = !!r.relaxed;
      renderList();
    });
  }

  function renderSearchResults(host) {
    if (S.searching && S.searchResults === null) {
      host.innerHTML = '<div class="adm-list-empty">检索中…</div>';
      return;
    }

    var list = S.searchResults || [];
    var hint = S.searchRelaxed
      ? '<div class="adm-search-hint">未找到完整匹配，以下是放宽为词组后的相近结果</div>'
      : '';

    if (!list.length) {
      host.innerHTML = '<div class="adm-list-empty">' +
        '没有匹配「' + SecRender.esc(S.query.trim()) + '」的笔记<br>' +
        '<span style="font-size:12px">已检索标题、分类、标签与正文</span></div>';
      return;
    }

    var head = hint + '<div class="adm-list-head-note">' +
      (S.searchTruncated ? '命中 ' + S.searchTotal + ' 篇，显示前 ' + list.length : '命中 ' + list.length + ' 篇') +
      '</div>';

    host.innerHTML = head + list.map(function (r) {
      var countBadge = r.matchCount
        ? '<span class="adm-hit-count">正文 ' + r.matchCount + ' 处</span>'
        : '<span class="adm-hit-count meta-hit">标题/标签命中</span>';

      var hits = r.matches.slice(0, 3).map(function (m) {
        return '<button type="button" class="adm-hit" data-slug="' + SecRender.esc(r.slug) +
          '" data-line="' + m.line + '" title="跳转到第 ' + m.line + ' 行">' +
          '<span class="adm-hit-line">' + m.line + '</span>' +
          '<span class="adm-hit-text">' + SecRender.highlight(m.text, S.query.trim()) + '</span>' +
        '</button>';
      }).join('');

      var more = r.matchCount > 3
        ? '<div class="adm-hit-more">…另有 ' + (r.matchCount - 3) + ' 处命中</div>'
        : '';

      return '<div class="adm-search-item">' +
        '<button type="button" class="adm-item' + (r.slug === S.current ? ' active' : '') +
          '" data-open="' + SecRender.esc(r.slug) + '">' +
          '<span class="adm-item-title">' + SecRender.highlight(r.title, S.query.trim()) + '</span>' +
          '<span class="adm-item-meta">' +
            '<span class="tag-cat">' + SecRender.esc(r.category) + '</span>' +
            '<span>' + SecRender.esc(r.date) + '</span>' +
            (r.draft ? '<span class="tag-draft">草稿</span>' : '') +
            countBadge +
          '</span>' +
        '</button>' +
        (hits ? '<div class="adm-hits">' + hits + '</div>' : '') +
        more +
      '</div>';
    }).join('');
  }

  /* 把光标定位到正文指定行并选中该行，便于核对上下文 */
  function gotoLine(n) {
    if (!n || n < 1) return;
    var lines = TA.value.split('\n');
    if (n > lines.length) return;

    var offset = 0;
    for (var i = 0; i < n - 1; i++) offset += lines[i].length + 1;
    var text = lines[n - 1];

    TA.focus();
    TA.setSelectionRange(offset, offset + text.length);

    var lineHeight = 22;
    try {
      var cs = window.getComputedStyle(TA);
      var parsed = parseFloat(cs && cs.lineHeight);
      if (parsed > 0) lineHeight = parsed;
    } catch (e) { /* 忽略：取不到就用默认值 */ }
    try {
      TA.scrollTop = Math.max(0, (n - 1) * lineHeight - TA.clientHeight / 3);
    } catch (e) { /* 忽略 */ }

    updateStatus();
    setStatus('已跳转到第 ' + n + ' 行', 'ok');
  }

  function renderTrash(host) {
    if (!S.trashed.length) {
      host.innerHTML = '<div class="adm-list-empty">回收站是空的</div>';
      return;
    }
    host.innerHTML = S.trashed.map(function (t) {
      return '<div class="adm-item">' +
        '<span class="adm-item-title">' + SecRender.esc(t.title) + '</span>' +
        '<span class="adm-item-meta"><span>' + SecRender.esc(t.deleted_at) + '</span></span>' +
        '<span class="adm-item-meta" style="margin-top:7px;gap:6px">' +
          '<button type="button" class="adm-btn ghost" data-restore="' + SecRender.esc(t.name) + '">还原</button>' +
          '<button type="button" class="adm-btn danger ghost" data-purge="' + SecRender.esc(t.name) + '">彻底删除</button>' +
        '</span>' +
      '</div>';
    }).join('');
  }

  /* ============================================================
     双向链接：[[ 标题联想 + 出链/入链/待创建 面板
     ============================================================ */
  function titleOf(slug) {
    for (var i = 0; i < S.notes.length; i++) {
      if (S.notes[i].slug === slug) return S.notes[i].title;
    }
    return slug;
  }

  function noteChip(slug) {
    var t = titleOf(slug);
    return '<button type="button" class="adm-chip" data-open-note="' + SecRender.esc(slug) +
      '" title="打开《' + SecRender.esc(t) + '》">' + SecRender.esc(t) + '</button>';
  }

  function pendingChip(title) {
    return '<button type="button" class="adm-chip pending" data-create-note="' +
      SecRender.esc(title) + '" title="按此标题新建一篇笔记">+ ' + SecRender.esc(title) + '</button>';
  }

  function renderLinkPanel() {
    var panel = $('#linkPanel');
    if (!panel || !TA || !window.SecRender || !SecRender.findWikiLinks) return;

    var found = SecRender.findWikiLinks(TA.value);
    var out = [], broken = [], seen = {};
    found.forEach(function (l) {
      if (l.slug) {
        if (!seen[l.slug]) { seen[l.slug] = 1; out.push(l.slug); }
      } else if (broken.indexOf(l.target) < 0) {
        broken.push(l.target);
      }
    });

    var incoming = (S.current && S.backlinks[S.current]) || [];
    var empty = '<span class="adm-links-empty">—</span>';

    $('#linkOut').querySelector('.adm-chipset').innerHTML =
      out.length ? out.map(noteChip).join('') : empty;
    $('#linkIn').querySelector('.adm-chipset').innerHTML =
      incoming.length ? incoming.map(noteChip).join('') : empty;
    $('#linkBroken').querySelector('.adm-chipset').innerHTML =
      broken.length ? broken.map(pendingChip).join('') : empty;
  }

  /* ---------------- [[ 联想 ---------------- */
  function wikiFragment() {
    var before = TA.value.slice(0, TA.selectionStart);
    var m = /\[\[([^\[\]\n]*)$/.exec(before);
    if (!m) return null;
    var raw = m[1];
    var bar = raw.indexOf('|');
    return {
      raw: raw,
      text: bar > -1 ? raw.slice(0, bar) : raw,
      label: bar > -1 ? raw.slice(bar + 1) : null,
      // 起点必须含上开头的两个方括号，否则插入后会多出一对
      start: TA.selectionStart - raw.length - 2,
      end: TA.selectionStart
    };
  }

  function pickerOpen() {
    var el = $('#picker');
    return !!(el && !el.hidden);
  }

  function closePicker() {
    S.pickerFrag = null;
    S.pickerItems = [];
    S.pickerIndex = 0;
    var el = $('#picker');
    if (el) el.hidden = true;
  }

  /* 根据光标前是否是未闭合的 [[ 来决定弹出或收起联想面板 */
  function syncPicker() {
    if (S.pickerSuppressed) return;
    var frag = wikiFragment();
    if (frag) openPicker(frag);
    else if (pickerOpen()) closePicker();
  }

  function openPicker(frag) {
    if (!frag) return closePicker();
    var q = frag.text.trim().toLowerCase();

    var items = S.notes.filter(function (n) {
      if (n.slug === S.current) return false;         // 不推荐链接自己
      if (!q) return true;
      return n.title.toLowerCase().indexOf(q) > -1 || n.slug.toLowerCase().indexOf(q) > -1;
    }).slice(0, 8);

    S.pickerFrag = frag;
    S.pickerItems = items;
    S.pickerIndex = 0;

    if (!items.length) return closePicker();

    $('#pickerList').innerHTML = items.map(function (n, i) {
      return '<button type="button" class="adm-picker-item' + (i === 0 ? ' active' : '') +
        '" data-pick="' + SecRender.esc(n.slug) + '">' +
        '<span class="adm-picker-title">' +
          SecRender.highlight(n.title, frag.text.trim()) + '</span>' +
        '<span class="adm-picker-meta">' + SecRender.esc(n.category) + '</span>' +
      '</button>';
    }).join('');
    $('#picker').hidden = false;
  }

  function movePicker(delta) {
    if (!S.pickerItems.length) return;
    S.pickerIndex = (S.pickerIndex + delta + S.pickerItems.length) % S.pickerItems.length;
    var btns = document.querySelectorAll('#pickerList .adm-picker-item');
    Array.prototype.forEach.call(btns, function (b, i) {
      b.classList.toggle('active', i === S.pickerIndex);
    });
    var active = btns[S.pickerIndex];
    if (active && active.scrollIntoView) {
      try { active.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 忽略 */ }
    }
  }

  function insertPick(slug) {
    var frag = S.pickerFrag;
    var note = null;
    for (var i = 0; i < S.notes.length; i++) {
      if (S.notes[i].slug === slug) note = S.notes[i];
    }
    if (!frag || !note) return closePicker();

    var text = '[[' + note.title + (frag.label != null ? '|' + frag.label : '') + ']]';
    closePicker();
    replaceRange(frag.start, frag.end, text, frag.start + text.length, frag.start + text.length);
  }

  /* 按标题新建（点「待创建」链接时用） */
  function createFromTitle(title) {
    newNote();
    $('#fTitle').value = title;
    $('#fSlug').value = '';            // 由服务端按标题生成文件名
    setDirty(true);
    refreshPreview();
    renderLinkPanel();
    $('#fTitle').focus();
    toast('已按标题新建，填写内容后保存即可接上这条链接');
  }

  /* ============================================================
     编辑器：打开 / 新建
     ============================================================ */
  function showEmpty() {
    $('#editorEmpty').hidden = false;
    $('#editorInner').hidden = true;
    setDirty(false);
  }

  function fillForm(n) {
    $('#fTitle').value = n.title || '';
    $('#fSlug').value = n.slug || '';
    $('#fDate').value = n.date || '';
    $('#fCategory').value = n.category || '';
    $('#fTags').value = (n.tags || []).join(', ');
    $('#fSummary').value = (n.summary && n.summary.indexOf('…') === -1) ? n.summary : (n.summary || '');
    $('#fDraft').checked = !!n.draft;
    TA.value = n.body || '';
  }

  function openEditor() {
    $('#editorEmpty').hidden = true;
    $('#editorInner').hidden = false;
  }

  function openNote(slug) {
    return api('/api/note?slug=' + encodeURIComponent(slug)).then(function (r) {
      if (!r.ok) { toast(r.error || '打开失败', true); return; }
      var note = r.note;
      S.current = note.slug;
      fillForm(note);
      openEditor();
      closePicker();
      setDirty(false);
      $('#stDraft').textContent = '';
      renderList();
      refreshPreview();
      renderLinkPanel();
      updateStatus();
      offerDraftIfAny(S.current, note);
    });
  }

  /* 若存在与磁盘版本不同的本地草稿，询问是否恢复 */
  function offerDraftIfAny(key, note) {
    if (S.declinedDrafts[key]) return;
    var d = readDraft(key);
    if (!d || d.body === note.body) return;

    var t = new Date(d.savedAt || Date.now());
    confirmDialog(
      '发现未保存的本地草稿',
      '这份笔记有一份自动保存于 ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) +
      ' 的本地草稿（正文 ' + d.body.length + ' 字符），与磁盘上的版本不一致。是否用草稿覆盖编辑区？',
      function () {
        var meta = d.meta || {};
        fillForm({
          title: meta.title || note.title,
          slug: meta.slug || note.slug,
          date: meta.date || note.date,
          category: meta.category || note.category,
          tags: meta.tags || note.tags,
          summary: meta.summary || '',
          draft: !!meta.draft,
          body: d.body
        });
        setDirty(true);
        refreshPreview();
        updateStatus();
        $('#stDraft').textContent = '已恢复本地草稿';
        toast('已恢复本地草稿，核对后请记得保存');
      },
      function () {
        // 不恢复：草稿原样保留（避免误删未保存内容），但本次会话不再打扰
        S.declinedDrafts[key] = true;
        $('#stDraft').textContent = '';
      },
      '恢复草稿',
      '不用，用磁盘版本'
    );
  }

  function newNote() {
    S.current = null;
    var blank = {
      title: '', slug: '', date: new Date().toISOString().slice(0, 10),
      category: '', tags: [], summary: '', draft: false,
      body: '# 标题\n\n> 一句话说明这篇笔记要解决什么问题。\n\n## 一、背景 / 适用场景\n\n\n\n## 二、核心内容\n\n'
    };
    fillForm(blank);
    $('#fSlug').value = '';
    openEditor();
    closePicker();
    setDirty(false);              // 初始模板不算改动，避免产生无意义的草稿
    $('#stDraft').textContent = '';
    renderList();
    refreshPreview();
    renderLinkPanel();
    updateStatus();
    $('#fTitle').focus();
  }

  /* ============================================================
     预览（与站点同一渲染链路）
     ============================================================ */
  var previewTimer = null;
  function refreshPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      var keep = PREVIEW_SCROLL.scrollTop;
      SecRender.render(TA.value, PREVIEW);
      PREVIEW_SCROLL.scrollTop = keep;
    }, 110);
  }

  /* ============================================================
     图片：粘贴 / 拖入 / 选择文件 → 上传到 assets/uploads/ 并插入
     ============================================================ */
  function insertImageMarkdown(url, alt) {
    var label = alt || '图片';
    var sel = selection();
    var text = '![' + label + '](' + url + ')';
    var pre = padBefore(sel.s);
    var post = padAfter(sel.e);
    var altStart = sel.s + pre.length + 2;            // '![' 之后
    replaceRange(sel.s, sel.e, pre + text + post, altStart, altStart + label.length);
  }

  function uploadImage(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('只能插入图片文件', true); return; }
    if (file.size > 8 * 1024 * 1024) { toast('图片超过 8MB 上限', true); return; }

    setStatus('图片上传中…');
    var reader = new FileReader();
    reader.onload = function () {
      api('/api/upload', {
        method: 'POST',
        body: { dataUrl: reader.result, slug: S.current || $('#fSlug').value.trim() }
      }).then(function (r) {
        if (!r.ok) {
          setStatus('图片上传失败', 'err');
          toast(r.error || '图片上传失败', true);
          return;
        }
        insertImageMarkdown(r.url, '图片');
        setStatus(r.deduped ? '图片已存在，直接引用' : '图片已上传（' + Math.round(r.bytes / 1024) + ' KB）', 'ok');
      });
    };
    reader.onerror = function () {
      setStatus('图片读取失败', 'err');
      toast('无法读取该图片', true);
    };
    reader.readAsDataURL(file);
  }

  function imageFilesFrom(list) {
    return Array.prototype.slice.call(list || []).filter(function (f) {
      return f && /^image\//.test(f.type);
    });
  }

  /* ============================================================
     本地草稿自动保存（防浏览器崩溃或误关标签页导致内容丢失）
     ============================================================ */
  var DRAFT_PREFIX = 'secnote:draft:';
  var DRAFT_DELAY = 1500;
  var draftTimer = null;

  function storeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* file:// 或隐私模式 */ } }
  function storeDel(k) { try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ } }

  function draftKey(slug) { return DRAFT_PREFIX + (slug || '__new__'); }

  function readDraft(slug) {
    var raw = storeGet(draftKey(slug));
    if (!raw) return null;
    try {
      var d = JSON.parse(raw);
      return (d && typeof d.body === 'string') ? d : null;
    } catch (e) { return null; }
  }

  function clearDraft(slug) { storeDel(draftKey(slug)); }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function writeDraft() {
    if (!S.dirty) return;
    var payload = collect();
    payload.savedAt = Date.now();
    storeSet(draftKey(S.current), JSON.stringify(payload));
    var t = new Date(payload.savedAt);
    $('#stDraft').textContent = '草稿已自动保存 ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes());
  }

  function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(writeDraft, DRAFT_DELAY);
  }

  function markDirty() {
    setDirty(true);
    scheduleDraftSave();
  }

  /* ============================================================
     字数与光标（字数口径与 build.py 一致，标注为估算）
     ============================================================ */
  function countWords(md) {
    var text = String(md || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/^\s{0,3}#{1,6}\s+/gm, ' ')
      .replace(/^\s*[-*+>|]\s?/gm, ' ');
    var cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
    var word = text.match(/[A-Za-z0-9_]+/g);
    return (cjk ? cjk.length : 0) + (word ? word.length : 0);
  }

  function updateStatus() {
    var v = TA.value.slice(0, TA.selectionStart);
    var lines = v.split('\n');
    $('#stPos').textContent = '行 ' + lines.length + '，列 ' + (lines[lines.length - 1].length + 1);
    $('#stWords').textContent = '约 ' + countWords(TA.value) + ' 字（估算）';
  }

  /* ============================================================
     文本插入原语
     ============================================================ */
  function replaceRange(start, end, text, selStart, selEnd) {
    var v = TA.value;
    TA.value = v.slice(0, start) + text + v.slice(end);
    var a = selStart == null ? start + text.length : selStart;
    var b = selEnd == null ? a : selEnd;
    TA.focus();
    TA.setSelectionRange(a, b);
    afterEdit();
  }

  function afterEdit() {
    markDirty();
    renderLinkPanel();     // 链接面板开销很小，同步刷新，避免比预览慢半拍
    refreshPreview();
    updateStatus();
  }

  function selection() {
    return { s: TA.selectionStart, e: TA.selectionEnd, text: TA.value.slice(TA.selectionStart, TA.selectionEnd) };
  }

  /* 成对包裹（可再次点击取消包裹）
     两种可取消的情形都要认出来：
       ① 标记恰好在选区外侧（光标停在标记内侧）
       ② 标记包含在选区里（选中了整段带标记的文本） */
  function wrap(before, after, placeholder) {
    var sel = selection();
    var v = TA.value;
    var inner = sel.text;

    var outside = v.slice(Math.max(0, sel.s - before.length), sel.s) === before &&
      v.slice(sel.e, sel.e + after.length) === after;

    var inside = inner.length >= before.length + after.length &&
      inner.slice(0, before.length) === before &&
      inner.slice(inner.length - after.length) === after;

    if (outside) {
      replaceRange(sel.s - before.length, sel.e + after.length, inner,
        sel.s - before.length, sel.s - before.length + inner.length);
      return;
    }
    if (inside) {
      var bare = inner.slice(before.length, inner.length - after.length);
      replaceRange(sel.s, sel.e, bare, sel.s, sel.s + bare.length);
      return;
    }

    var content = inner || placeholder || '';
    replaceRange(sel.s, sel.e, before + content + after, sel.s + before.length, sel.s + before.length + content.length);
  }

  /* 逐行加/去前缀（再次执行视为取消） */
  function prefixLines(makePrefix, detect) {
    var sel = selection();
    var v = TA.value;
    var start = v.lastIndexOf('\n', sel.s - 1) + 1;
    var endIdx = v.indexOf('\n', sel.e);
    var end = endIdx === -1 ? v.length : endIdx;
    var block = v.slice(start, end);
    var lines = block.split('\n');
    var re = detect || null;
    var allHave = lines.every(function (l) {
      if (!l.trim()) return true;
      return re ? re.test(l) : l.indexOf(makePrefix(0)) === 0;
    });

    var out = lines.map(function (l, i) {
      if (allHave) return l.replace(/^(\s*)(?:[-*+]\s\[[ x]\]\s|[-*+]\s|\d+\.\s|#{1,6}\s|>\s)?/, '$1');
      if (!l.trim()) return l;
      return makePrefix(i) + l.replace(/^\s*[-*+]\s\[[ x]\]\s|^\s*[-*+]\s|^\s*\d+\.\s|^\s*#{1,6}\s|^\s*>\s/, '');
    }).join('\n');

    replaceRange(start, end, out, start, start + out.length);
  }

  /* 块级插入：自动补足前后空行，避免与正文粘连导致解析异常 */
  function padBefore(pos) {
    var v = TA.value;
    var lb = v.lastIndexOf('\n', pos - 1);
    var lineText = v.slice(lb + 1, pos);
    if (lineText.trim() !== '') return '\n\n';
    return '';
  }
  function padAfter(pos) {
    var v = TA.value;
    var nl = v.indexOf('\n', pos);
    var lineText = nl === -1 ? v.slice(pos) : v.slice(pos, nl);
    if (lineText.trim() !== '') return '\n\n';
    if (nl === -1) return '\n';
    return '';
  }
  function insertBlock(text) {
    var sel = selection();
    var pre = padBefore(sel.s);
    var post = padAfter(sel.e);
    var body = sel.text || text;
    replaceRange(sel.s, sel.e, pre + body + post, sel.s + pre.length, sel.s + pre.length + body.length);
  }

  /* ============================================================
     代码块：核心功能
     插入围栏代码块并处理空行与光标，使渲染结果与站点完全一致
     ============================================================ */
  function insertCodeBlock(lang) {
    lang = String(lang || '').trim().replace(/[^\w+#.-]/g, '');
    var sel = selection();
    var pre = padBefore(sel.s);
    var post = padAfter(sel.e);
    var fence = '```' + lang + '\n';
    var inner = sel.text;
    var text = pre + fence + inner + (inner && !/\n$/.test(inner) ? '\n' : '') + '```' + post;

    var innerStart = sel.s + pre.length + fence.length;
    var innerEnd = innerStart + inner.length;
    replaceRange(sel.s, sel.e, text, innerStart, innerEnd);

    if (!inner) {
      setStatus('已插入 ' + (lang || '无语言') + ' 代码块，直接输入内容即可');
    }
  }

  /* ============================================================
     工具栏动作
     ============================================================ */
  var ACTIONS = {
    h2: function () { prefixLines(function () { return '## '; }); },
    h3: function () { prefixLines(function () { return '### '; }); },
    h4: function () { prefixLines(function () { return '#### '; }); },
    bold: function () { wrap('**', '**', '加粗文本'); },
    italic: function () { wrap('*', '*', '斜体文本'); },
    strike: function () { wrap('~~', '~~', '删除内容'); },
    code: function () { wrap('`', '`', '代码'); },
    codeblock: function () { openLangModal(); },
    link: function () {
      var sel = selection();
      var t = sel.text || '链接文字';
      var url = /^https?:\/\//i.test(sel.text) ? sel.text : 'https://';
      wrap('[', '](' + url + ')', t);
    },
    wikilink: function () {
      var sel = selection();
      var inner = sel.text || '';
      var text = '[[' + inner + ']]';
      var caret = sel.s + 2 + inner.length;
      replaceRange(sel.s, sel.e, text, caret, caret);
      openPicker(wikiFragment());          // 立刻弹出标题联想
    },
    image: function () { $('#imgPicker').click(); },
    ul: function () { prefixLines(function () { return '- '; }); },
    ol: function () { prefixLines(function (i) { return (i + 1) + '. '; }, /^\s*\d+\.\s/); },
    task: function () { prefixLines(function () { return '- [ ] '; }); },
    quote: function () { prefixLines(function () { return '> '; }); },
    table: function () {
      insertBlock('| 项目 | 说明 |\n| --- | --- |\n| 示例 | 说明文本 |');
    },
    hr: function () { insertBlock('---'); }
  };

  /* ============================================================
     代码块语言选择
     ============================================================ */
  var PREFERRED = ['bash', 'shell', 'powershell', 'python', 'javascript', 'typescript',
    'php', 'java', 'go', 'rust', 'c', 'cpp', 'csharp', 'sql', 'xml', 'json',
    'yaml', 'ini', 'dockerfile', 'nginx', 'http', 'markdown', 'plaintext'];

  function buildLangOptions() {
    var all = (window.hljs && hljs.listLanguages) ? hljs.listLanguages() : [];
    var lower = all.map(function (l) { return l.toLowerCase(); });
    var ordered = PREFERRED.filter(function (l) { return lower.indexOf(l) > -1; });
    var rest = lower.filter(function (l) { return ordered.indexOf(l) === -1; }).sort();
    return { ordered: ordered, all: ordered.concat(rest) };
  }

  function openLangModal() {
    var langs = buildLangOptions();
    $('#langList').innerHTML = langs.all.map(function (l) { return '<option value="' + l + '">'; }).join('');
    $('#langQuick').innerHTML = langs.ordered.slice(0, 12).map(function (l) {
      return '<button type="button" data-lang="' + l + '">' + l + '</button>';
    }).join('');
    $('#langInput').value = S.lastLang;
    $('#modalLang').hidden = false;
    $('#langInput').focus();
    $('#langInput').select();
  }

  function closeModal(id) { $('#' + id).hidden = true; }

  function confirmDialog(title, text, onConfirm, onCancel, okLabel, cancelLabel) {
    $('#cfTitle').textContent = title;
    $('#cfText').textContent = text;
    $('#cfConfirm').textContent = okLabel || '确认';
    var cancelBtn = $('#modalConfirm').querySelector('[data-close]');
    if (cancelBtn) cancelBtn.textContent = cancelLabel || '取消';
    S.confirmCb = onConfirm;
    S.confirmCancel = onCancel || null;
    $('#modalConfirm').hidden = false;
  }

  function closeConfirm(confirmed) {
    var cb = confirmed ? S.confirmCb : S.confirmCancel;
    S.confirmCb = null;
    S.confirmCancel = null;
    closeModal('modalConfirm');
    if (cb) cb();
  }

  /* ============================================================
     保存 / 删除
     ============================================================ */
  function tagsFromInput(s) {
    return String(s || '').split(/[,，、;；]/).map(function (t) { return t.trim(); }).filter(Boolean);
  }

  function collect() {
    return {
      slug: S.current || '',
      meta: {
        slug: $('#fSlug').value.trim(),
        title: $('#fTitle').value.trim(),
        date: $('#fDate').value.trim(),
        category: $('#fCategory').value.trim() || '未分类',
        tags: tagsFromInput($('#fTags').value),
        summary: $('#fSummary').value.trim(),
        draft: $('#fDraft').checked
      },
      body: TA.value
    };
  }

  var saving = false;
  function save() {
    if (saving) return;
    var payload = collect();
    var prevKey = S.current;                 // 保存前所在的键，可能是 __new__
    if (!payload.meta.title && !payload.meta.slug) {
      toast('请先填写标题', true);
      $('#fTitle').focus();
      return;
    }
    saving = true;
    $('#btnSave').disabled = true;
    $('#btnSave2').disabled = true;
    setStatus('保存中…');

    api('/api/note', { method: 'POST', body: payload }).then(function (r) {
      saving = false;
      $('#btnSave').disabled = false;
      $('#btnSave2').disabled = false;
      if (!r.ok) {
        setStatus('保存失败', 'err');
        toast(r.error || '保存失败', true);
        return;
      }
      S.current = r.note.slug;
      $('#fSlug').value = r.note.slug;
      if (!$('#fDate').value) $('#fDate').value = r.note.date;
      setDirty(false);
      clearTimeout(draftTimer);
      clearDraft(prevKey);                   // 内容已落盘，本地草稿不再需要
      clearDraft(r.note.slug);
      clearDraft('');
      $('#stDraft').textContent = '';
      setStatus((r.build && !r.build.ok ? '构建有告警：' : '构建完成：') + buildSummary(r.build),
        r.build && !r.build.ok ? 'err' : 'ok');
      toast((r.created ? '已创建' : '已保存') + ' ' + r.note.file +
        (r.renamed ? '（文件名已同步修改）' : ''));
      if (S.query.trim()) runSearch();       // 检索结果可能已过期，重新拉一次
      return loadState();
    }).catch(function () {
      saving = false;
      $('#btnSave').disabled = false;
      $('#btnSave2').disabled = false;
      setStatus('保存失败', 'err');
      toast('保存失败：无法连接本地服务', true);
    });
  }

  function deleteCurrent() {
    if (!S.current) { toast('当前没有可删除的笔记', true); return; }
    var title = $('#fTitle').value.trim() || S.current;
    var slug = S.current;
    confirmDialog('删除笔记',
      '《' + title + '》将被移入回收站 .trash/（可在「回收站」标签页还原），并立即重建站点。',
      function () {
        api('/api/delete', { method: 'POST', body: { slug: slug } }).then(function (r) {
          if (!r.ok) { toast(r.error || '删除失败', true); return; }
          clearDraft(slug);
          toast('已移入回收站：' + r.trashed);
          S.current = null;
          $('#stDraft').textContent = '';
          showEmpty();
          $('#listTabs').querySelector('[data-tab="notes"]').click();
          loadState();
        });
      });
  }

  function guardDirty(next) {
    if (!S.dirty) { next(); return; }
    confirmDialog('有未保存的修改', '当前笔记的修改尚未保存，继续操作将丢失这些修改。', next);
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  function bind() {
    TA = $('#body');
    PREVIEW = $('#preview');
    PREVIEW_SCROLL = document.querySelector('.adm-preview-scroll');

    // 列表点击
    $('#listScroll').addEventListener('click', function (e) {
      var restore = e.target.closest('[data-restore]');
      if (restore) {
        api('/api/restore', { method: 'POST', body: { name: restore.getAttribute('data-restore') } })
          .then(function (r) {
            toast(r.ok ? '已还原：' + r.restored : (r.error || '还原失败'), !r.ok);
            loadState();
          });
        return;
      }
      var purge = e.target.closest('[data-purge]');
      if (purge) {
        var name = purge.getAttribute('data-purge');
        confirmDialog('彻底删除', '此操作不可恢复，将永久删除该文件：' + name, function () {
          api('/api/purge', { method: 'POST', body: { name: name, confirm: true } })
            .then(function (r) {
              toast(r.ok ? '已彻底删除' : (r.error || '删除失败'), !r.ok);
              loadState();
            });
        });
        return;
      }
      // 正文命中片段：打开笔记并跳到该行
      var hit = e.target.closest('.adm-hit[data-slug]');
      if (hit) {
        var hitSlug = hit.getAttribute('data-slug');
        var line = parseInt(hit.getAttribute('data-line'), 10);
        guardDirty(function () {
          openNote(hitSlug).then(function () { gotoLine(line); });
        });
        return;
      }

      // 检索结果里的标题：只打开，不跳转
      var opener = e.target.closest('[data-open]');
      if (opener) {
        var openSlug = opener.getAttribute('data-open');
        if (openSlug === S.current) return;
        guardDirty(function () { openNote(openSlug); });
        return;
      }

      var item = e.target.closest('.adm-item[data-slug]');
      if (item) {
        var slug = item.getAttribute('data-slug');
        if (slug === S.current) return;
        guardDirty(function () { openNote(slug); });
      }
    });

    // 标签页
    $('#listTabs').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-tab]');
      if (!btn) return;
      S.tab = btn.getAttribute('data-tab');
      Array.prototype.forEach.call(this.querySelectorAll('button'), function (b) {
        b.classList.toggle('active', b === btn);
      });
      renderList();
    });

    // 搜索：输入即防抖检索（覆盖正文），回车跳到第一条命中
    var searchTimer = null;
    $('#listSearch').addEventListener('input', function () {
      S.query = this.value;
      clearTimeout(searchTimer);
      if (!S.query.trim()) {
        S.searchResults = null;
        S.searching = false;
        renderList();
        return;
      }
      S.searching = true;
      renderList();
      searchTimer = setTimeout(runSearch, 250);
    });
    $('#listSearch').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        this.value = '';
        S.query = '';
        S.searchResults = null;
        renderList();
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var first = document.querySelector('#listScroll .adm-hit[data-slug]')
        || document.querySelector('#listScroll [data-open]');
      if (first) first.click();
    });

    // 新建
    $('#btnNew').addEventListener('click', function () {
      guardDirty(newNote);
    });

    // 工具栏
    $('#toolbar').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-md]');
      if (!btn) return;
      var fn = ACTIONS[btn.getAttribute('data-md')];
      if (fn) fn();
    });

    // 元信息变更即脏
    ['#fTitle', '#fSlug', '#fDate', '#fCategory', '#fTags', '#fSummary'].forEach(function (sel) {
      $(sel).addEventListener('input', markDirty);
    });
    $('#fDraft').addEventListener('change', markDirty);

    TA.addEventListener('input', function () {
      S.pickerSuppressed = false;
      markDirty();
      refreshPreview();
      updateStatus();
      syncPicker();
    });
    TA.addEventListener('click', function () { updateStatus(); syncPicker(); });
    TA.addEventListener('keyup', function (e) {
      updateStatus();
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === 'Tab') return;
      syncPicker();
    });

    /* ---- 双向链接联想面板 ---- */
    $('#pickerList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-pick]');
      if (btn) insertPick(btn.getAttribute('data-pick'));
    });

    /* ---- 双向链接面板（出链 / 入链 / 待创建）---- */
    $('#linkPanel').addEventListener('click', function (e) {
      var open = e.target.closest('[data-open-note]');
      if (open) {
        var target = open.getAttribute('data-open-note');
        if (target === S.current) return;
        guardDirty(function () { openNote(target); });
        return;
      }
      var create = e.target.closest('[data-create-note]');
      if (create) {
        var title = create.getAttribute('data-create-note');
        guardDirty(function () { createFromTitle(title); });
      }
    });

    // 点击编辑区以外的地方收起联想面板
    document.addEventListener('click', function (e) {
      if (!pickerOpen()) return;
      if (e.target.closest && (e.target.closest('#picker') || e.target === TA)) return;
      closePicker();
    });

    /* ---- 图片：粘贴 / 拖入 / 选择文件 ---- */
    TA.addEventListener('paste', function (e) {
      var dt = e.clipboardData;
      if (!dt) return;
      var files = imageFilesFrom(dt.files);
      if (!files.length) {
        Array.prototype.slice.call(dt.items || []).forEach(function (it) {
          if (it.kind === 'file') {
            var f = it.getAsFile();
            if (f && /^image\//.test(f.type)) files.push(f);
          }
        });
      }
      if (!files.length) return;              // 纯文本粘贴，走浏览器默认行为
      e.preventDefault();
      files.forEach(uploadImage);
    });

    ['dragenter', 'dragover'].forEach(function (ev) {
      TA.addEventListener(ev, function (e) {
        e.preventDefault();
        TA.classList.add('drop-active');
      });
    });
    TA.addEventListener('dragleave', function () { TA.classList.remove('drop-active'); });
    TA.addEventListener('drop', function (e) {
      e.preventDefault();
      TA.classList.remove('drop-active');
      var files = imageFilesFrom(e.dataTransfer && e.dataTransfer.files);
      if (!files.length) { toast('只支持拖入图片文件', true); return; }
      files.forEach(uploadImage);
    });

    $('#imgPicker').addEventListener('change', function () {
      imageFilesFrom(this.files).forEach(uploadImage);
      this.value = '';                        // 允许连续选择同一文件
    });

    // Tab 缩进 / 快捷键
    TA.addEventListener('keydown', function (e) {
      // 联想面板打开时，方向键与回车先归它用
      if (pickerOpen()) {
        if (e.key === 'ArrowDown') { e.preventDefault(); movePicker(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); movePicker(-1); return; }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (S.pickerItems.length) insertPick(S.pickerItems[S.pickerIndex].slug);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          S.pickerSuppressed = true;      // 避免 keyup 时又被重新弹出
          closePicker();
          return;
        }
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        var sel = selection();
        if (sel.s === sel.e && !e.shiftKey) {
          replaceRange(sel.s, sel.e, '  ');
        } else {
          var v = TA.value;
          var start = v.lastIndexOf('\n', sel.s - 1) + 1;
          var endIdx = v.indexOf('\n', sel.e);
          var end = endIdx === -1 ? v.length : endIdx;
          var lines = v.slice(start, end).split('\n');
          var out = lines.map(function (l) {
            if (e.shiftKey) return l.replace(/^ {1,2}/, '');
            return '  ' + l;
          }).join('\n');
          replaceRange(start, end, out, start, start + out.length);
        }
        return;
      }

      var mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      var k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); save(); }
      else if (k === 'b') { e.preventDefault(); ACTIONS.bold(); }
      else if (k === 'i') { e.preventDefault(); ACTIONS.italic(); }
      else if (k === 'k') { e.preventDefault(); ACTIONS.link(); }
      else if (k === 'e') { e.preventDefault(); ACTIONS.code(); }
      else if (e.shiftKey && k === 'c') { e.preventDefault(); ACTIONS.codeblock(); }
    });

    // 代码块语言弹窗
    $('#langQuick').addEventListener('click', function (e) {
      var b = e.target.closest('[data-lang]');
      if (!b) return;
      S.lastLang = b.getAttribute('data-lang');
      closeModal('modalLang');
      insertCodeBlock(S.lastLang);
    });
    $('#langConfirm').addEventListener('click', function () {
      S.lastLang = $('#langInput').value.trim() || 'plaintext';
      closeModal('modalLang');
      insertCodeBlock(S.lastLang);
    });
    $('#langInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('#langConfirm').click(); }
    });

    // 模态框通用关闭：确认框需要回调「取消」，不能只隐藏
    document.addEventListener('click', function (e) {
      var m = null;
      if (e.target.closest && e.target.closest('[data-close]')) m = e.target.closest('.adm-modal');
      else if (e.target.classList && e.target.classList.contains('adm-modal')) m = e.target;
      if (!m) return;
      if (m.id === 'modalConfirm') closeConfirm(false);
      else m.hidden = true;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var open = document.querySelector('.adm-modal:not([hidden])');
      if (!open) return;
      if (open.id === 'modalConfirm') closeConfirm(false);
      else open.hidden = true;
    });
    $('#cfConfirm').addEventListener('click', function () { closeConfirm(true); });

    // 保存 / 删除 / 重建 / 主题（含显眼操作栏的重复入口；btnNew 在前面已绑定）
    $('#btnSave').addEventListener('click', save);
    $('#btnSave2').addEventListener('click', save);
    $('#btnSave3').addEventListener('click', save);
    $('#btnDelete').addEventListener('click', deleteCurrent);
    $('#btnDelete2').addEventListener('click', deleteCurrent);
    $('#btnNew2').addEventListener('click', function () { guardDirty(newNote); });
    $('#btnRebuild').addEventListener('click', function () {
      setStatus('正在重建…');
      api('/api/rebuild', { method: 'POST', body: {} }).then(function (r) {
        if (!r.ok) { setStatus('重建失败', 'err'); toast(r.error || '重建失败', true); return; }
        setStatus('构建完成：' + buildSummary(r.build), r.build.ok ? 'ok' : 'err');
        toast('站点数据已重建');
      });
    });
    $('#btnTheme').addEventListener('click', function () { toggleTheme(); });

    window.addEventListener('beforeunload', function (e) {
      if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ============================================================
     主题（与站点共用 localStorage 键）
     ============================================================ */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('#hljs-theme-dark').disabled = t !== 'dark';
    $('#hljs-theme-light').disabled = t !== 'light';
    try { localStorage.setItem('sec-theme', t); } catch (err) { /* file:// 或隐私模式 */ }
  }
  function toggleTheme() {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  }

  /* ============================================================
     启动
     ============================================================ */
  function boot() {
    var saved = null;
    try { saved = localStorage.getItem('sec-theme'); } catch (err) { /* 忽略 */ }
    applyTheme(saved || 'dark');

    // 地址栏中的令牌用完即抹掉，避免被复制分享
    if (location.search.indexOf('token=') > -1) {
      try { history.replaceState(null, '', location.pathname); } catch (err) { /* 忽略 */ }
    }

    bind();
    showEmpty();
    loadState();
    setStatus('就绪');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 供自检脚本使用 */
  window.__ADMIN__ = {
    state: S,
    countWords: countWords,
    insertCodeBlock: insertCodeBlock,
    insertImageMarkdown: insertImageMarkdown,
    uploadImage: uploadImage,
    readDraft: readDraft,
    writeDraft: writeDraft,
    clearDraft: clearDraft,
    actions: ACTIONS,
    save: save,
    openNote: openNote,
    newNote: newNote,
    runSearch: runSearch,
    gotoLine: gotoLine,
    renderLinkPanel: renderLinkPanel,
    syncPicker: syncPicker,
    openPicker: openPicker,
    closePicker: closePicker,
    insertPick: insertPick,
    wikiFragment: wikiFragment,
    createFromTitle: createFromTitle,
    padBefore: padBefore,
    padAfter: padAfter
  };
})();
