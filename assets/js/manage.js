/* ============================================================
   SecNotes 笔记管理端（免服务版）
   ------------------------------------------------------------
   直接双击 manage.html 即可使用，不需要启动任何服务：
     · 笔记数据保存在浏览器 localStorage；
     · 首次打开时从 data/notes.js（站点当前数据）导入；
     · 预览调用 assets/js/render.js，与展示端文章页同一渲染链路；
     · 落回站点：写入 notes/ 目录（需浏览器支持）或导出 notes.json。
   注意：浏览器不能静默改动磁盘文件，因此"落地"一定是显式操作。
   ============================================================ */
(function () {
  'use strict';

  var STORE_KEY = 'secnotes.manage.v1';
  var DRAFT_KEY = 'secnotes.manage.draft';
  var RELOAD_KEY = 'secnotes.reloadAt';   // 通知已打开的展示端刷新
  var SYNC_PORTS = [8080, 8081, 9000];    // 依次探测本地服务

  var S = {
    syncBase: '',       // 形如 http://127.0.0.1:8080/
    syncToken: '',
    syncNoRebuild: false,  // 服务是否以 --no-rebuild 启动（同步不会重建站点数据）
    notes: [],          // [{slug,title,date,category,tags,summary,draft,body}]
    current: null,      // 当前编辑的 slug（null 表示新建未保存）
    dirty: false,
    query: '',
    synced: {},         // 已写入 notes/ 目录的 slug → true
    removed: [],        // 本地库里删掉的 slug，同步时让服务端移入回收站
    dirHandle: null,    // File System Access API 的目录句柄（仅本次会话有效）
    picker: { open: false, items: [], index: 0, frag: null, suppressed: false }
  };

  var TA, PREVIEW, PREVIEW_SCROLL;

  /* ---------------- 基础工具 ---------------- */
  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function today() { return new Date().toISOString().slice(0, 10); }

  /* 与 build.py / admin.py 的 slugify 规则**完全一致**（改任一侧都要同步另一侧）。
     空输入返回空串，**绝不在这里编造随机名**：随机名会让「同一篇再保存一次」
     变成「多出一篇新文章」—— 管理端每次保存都拿到不同的 slug，
     写到磁盘就是一个个新文件（真实踩过这个坑）。 */
  function slugify(text) {
    var s = String(text || '').trim().toLowerCase();
    s = s.replace(/[\s_]+/g, '-');
    s = s.replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '');
    return s.replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  function countWords(md) {
    var t = String(md || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/[#>*_~\[\]()!|-]/g, ' ');
    var cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
    var en = (t.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
    return cjk + en;
  }

  function parseTags(v) {
    return String(v || '').split(/[,，、;；]/).map(function (x) { return x.trim(); })
      .filter(function (x) { return !!x; });
  }

  /* ---------------- 存储 ---------------- */
  /* 少数浏览器在 file:// 下禁用 localStorage：检测一次，明确告知而不是静默丢数据 */
  function storageOk() {
    try {
      localStorage.setItem('secnotes.probe', '1');
      localStorage.removeItem('secnotes.probe');
      return true;
    } catch (e) { return false; }
  }

  function loadStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.notes)) return null;
      return data;
    } catch (e) { return null; }
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        synced: S.synced,
        // removed 必须一起持久化：它是"待同步删除"的意图队列。
        // 不存的话，一刷新就归零 → 同步时服务端收不到删除指令 →
        // notes/ 里的文件还在 → 展示端继续收录，而管理端已经看不到它，
        // 于是两端数量长期不一致（曾导致线上出现这个 bug）。
        removed: S.removed,
        notes: S.notes
      }));
    } catch (e) {
      toast('本地存储写入失败：' + e.message, true);
    }
  }

  /* 从站点数据（data/notes.js）导入 */
  function notesFromSite() {
    var src = window.SEC_BLOG && window.SEC_BLOG.notes;
    if (!src || !src.length) return [];
    return src.map(function (n) {
      return {
        slug: n.slug, title: n.title || '', date: n.date || today(),
        category: n.category || '未分类', tags: (n.tags || []).slice(),
        summary: n.summary || '', draft: !!n.draft, body: n.body || ''
      };
    });
  }

  /* ---------------- 提示与确认 ---------------- */
  var toastTimer = null;
  function toast(msg, isErr) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'adm-toast' + (isErr ? ' err' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  /* onOk：主按钮；alt：{ label, action } 可选的第三个按钮 */
  function confirmDialog(title, text, onOk, altLabel, altAction) {
    $('#cfTitle').textContent = title;
    $('#cfText').innerHTML = text;
    var modal = $('#modalConfirm');
    var btn = $('#cfConfirm');
    var alt = $('#cfAlt');
    modal.hidden = false;

    var fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', function () { modal.hidden = true; onOk(); });

    if (alt) {
      if (altLabel && typeof altAction === 'function') {
        alt.hidden = false;
        alt.textContent = altLabel;
        var freshAlt = alt.cloneNode(true);
        alt.parentNode.replaceChild(freshAlt, alt);
        freshAlt.addEventListener('click', function () { modal.hidden = true; altAction(); });
      } else {
        alt.hidden = true;
      }
    }
  }

  /* ---------------- 列表 ---------------- */
  function sortedNotes() {
    return S.notes.slice().sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });
  }

  function matchNote(n, terms) {
    var hay = [n.title, n.category, (n.tags || []).join(' '), n.body].join('\n').toLowerCase();
    return terms.every(function (t) { return hay.indexOf(t.toLowerCase()) > -1; });
  }

  function renderList() {
    var box = $('#listScroll');
    var terms = S.query.trim().split(/\s+/).filter(Boolean);
    var list = sortedNotes().filter(function (n) { return !terms.length || matchNote(n, terms); });

    if (!list.length) {
      box.innerHTML = '<div class="adm-list-empty">' +
        (S.notes.length ? '没有匹配的笔记' : '本地库还是空的，点「导入」从站点数据载入') + '</div>';
      return;
    }

    box.innerHTML = list.map(function (n) {
      var tags = (n.tags || []).slice(0, 3).map(function (t) {
        return '<span class="tag-cat">' + esc(t) + '</span>';
      }).join('');
      return '<button type="button" class="adm-item' + (n.slug === S.current ? ' active' : '') +
        '" data-slug="' + esc(n.slug) + '">' +
        '<span class="adm-item-title">' + esc(n.title || '（未命名）') +
        (n.draft ? ' <span class="tag-draft">草稿</span>' : '') + '</span>' +
        '<span class="adm-item-meta">' + esc(n.date || '') + '<span class="tag-cat">' +
        esc(n.category || '未分类') + '</span>' + tags +
        (S.synced[n.slug] ? '' : '<span class="mg-unsynced">未写入</span>') +
        '</span></button>';
    }).join('');
  }

  function updatePill() {
    var total = S.notes.length;
    var pending = S.notes.filter(function (n) { return !S.synced[n.slug]; }).length;
    $('#libPill').textContent = total + ' 篇' + (pending ? ' · ' + pending + ' 篇未写入' : ' · 已同步');
  }

  /* ---------------- 双向链接面板 ---------------- */
  function renderLinkPanel() {
    if (!window.SecRender || !SecRender.findWikiLinks) return;
    var body = TA ? TA.value : '';
    var links = SecRender.findWikiLinks(body);

    var out = [], broken = [];
    links.forEach(function (l) {
      if (l.slug && l.slug !== S.current) out.push(l);
      else if (!l.slug) broken.push(l.target);
    });

    var back = [];
    S.notes.forEach(function (n) {
      if (n.slug === S.current) return;
      var hits = SecRender.findWikiLinks(n.body || '').filter(function (l) {
        return l.slug === S.current;
      });
      if (hits.length) back.push(n);
    });

    function chips(list, kind) {
      if (!list.length) return '<span class="adm-links-empty">—</span>';
      return list.map(function (item) {
        var slug = item.slug || item;
        var title = item.title || item;
        return '<button type="button" class="adm-chip' + (kind === 'new' ? ' pending' : '') +
          '" data-' + (kind === 'new' ? 'newtitle' : 'open') + '="' + esc(slug) + '">' +
          esc(title) + '</button>';
      }).join('');
    }

    $('#linkOut').querySelector('.adm-chipset').innerHTML = chips(out.filter(function (l) {
      return !!l.slug;
    }).map(function (l) {
      var t = S.notes.filter(function (n) { return n.slug === l.slug; })[0];
      return { slug: l.slug, title: t ? t.title : l.target };
    }), 'open');
    $('#linkIn').querySelector('.adm-chipset').innerHTML = chips(back, 'open');
    $('#linkBroken').querySelector('.adm-chipset').innerHTML = chips(broken, 'new');
  }

  /* ---------------- 预览 ---------------- */
  var previewTimer = null;
  function refreshPreview(now) {
    clearTimeout(previewTimer);
    var run = function () {
      if (!TA || !PREVIEW || !window.SecRender) return;
      var keep = PREVIEW_SCROLL ? PREVIEW_SCROLL.scrollTop : 0;
      SecRender.render(TA.value, PREVIEW);
      if (PREVIEW_SCROLL) PREVIEW_SCROLL.scrollTop = keep;
    };
    if (now) run(); else previewTimer = setTimeout(run, 110);
  }

  function refreshIndex() {
    if (window.SecRender && SecRender.setNoteIndex) SecRender.setNoteIndex(S.notes);
    refreshCategories();
  }

  /* ---------------- 分类选择栏 ----------------
     输入框始终是「真值」，选择栏只负责把已有分类快捷填进去；
     直接敲一个新名字就等于新建分类。两者互不排斥。 */
  var NEW_CAT = '__new__';

  function categoryCounts() {
    var map = {};
    (S.notes || []).forEach(function (n) {
      var c = String(n && n.category || '').trim();
      if (!c) return;
      map[c] = (map[c] || 0) + 1;
    });
    return Object.keys(map).sort(function (a, b) {
      return a.localeCompare(b, 'zh-Hans-CN');
    }).map(function (c) { return { name: c, count: map[c] }; });
  }

  function refreshCategories() {
    var sel = $('#fCategoryPick');
    if (!sel) return;
    var input = $('#fCategory');
    var current = (input ? input.value : '').trim();
    var cats = categoryCounts();

    var html = '<option value="">选择已有分类…</option>' +
      cats.map(function (c) {
        return '<option value="' + esc(c.name) + '">' + esc(c.name) + '（' + c.count + '）</option>';
      }).join('');

    /* 输入的是新名字时也放进列表，否则 select 找不到匹配项会跳回「选择…」，
       看起来像是把刚输入的分类丢了 */
    if (current && !cats.some(function (c) { return c.name === current; })) {
      html += '<option value="' + esc(current) + '">' + esc(current) + '（新分类）</option>';
    }
    html += '<option value="' + NEW_CAT + '">＋ 新建分类…</option>';

    sel.innerHTML = html;
    sel.value = current;
  }

  function bindCategoryPicker() {
    var sel = $('#fCategoryPick');
    var input = $('#fCategory');
    if (!sel || !input) return;

    sel.addEventListener('change', function () {
      if (sel.value === NEW_CAT) {
        input.value = '';
        input.focus();
      } else {
        input.value = sel.value;
      }
      setDirty(true);
      refreshCategories();
    });

    /* 手动输入时同步选择栏的选中态；不改动选项列表，避免边打字边重建 */
    input.addEventListener('input', function () {
      var v = input.value.trim();
      var hit = Array.prototype.slice.call(sel.options)
        .filter(function (o) { return o.value === v; })[0];
      sel.value = hit ? v : '';
    });
  }

  /* ---------------- 表单 ---------------- */
  function fillForm(n) {
    $('#fTitle').value = n.title || '';
    $('#fSlug').value = n.slug || '';
    $('#fDate').value = n.date || today();
    $('#fCategory').value = n.category || '';
    $('#fTags').value = (n.tags || []).join(', ');
    $('#fSummary').value = n.summary || '';
    $('#fDraft').checked = !!n.draft;
    if (TA) TA.value = n.body || '';
  }

  function collectForm() {
    var title = $('#fTitle').value.trim();
    var slug = $('#fSlug').value.trim() || slugify(title);
    return {
      slug: slug,
      title: title || '（未命名）',
      date: $('#fDate').value || today(),
      category: $('#fCategory').value.trim() || '未分类',
      tags: parseTags($('#fTags').value),
      summary: $('#fSummary').value.trim(),
      draft: !!$('#fDraft').checked,
      body: TA ? TA.value : ''
    };
  }

  function setDirty(v) {
    S.dirty = !!v;
    var mark = $('#dirtyMark');
    if (mark) mark.hidden = !v;
  }

  function setStatus(text, kind) {
    var el = $('#stState');
    if (!el) return;
    el.textContent = text;
    el.className = kind || '';
  }

  function updateWordCount() {
    var w = countWords(TA ? TA.value : '');
    $('#stWords').textContent = '约 ' + w.toLocaleString('en-US') + ' 字（估算）';
  }

  function showEditor() {
    $('#editorEmpty').hidden = true;
    $('#editorInner').hidden = false;
  }

  function showEmpty() {
    $('#editorEmpty').hidden = false;
    $('#editorInner').hidden = true;
    setDirty(false);
  }

  function openNote(slug) {
    var n = S.notes.filter(function (x) { return x.slug === slug; })[0];
    if (!n) return;
    S.current = slug;
    fillForm(n);
    showEditor();
    setDirty(false);
    refreshIndex();
    refreshPreview(true);
    renderLinkPanel();
    renderList();
    updateWordCount();
    setStatus('已打开：' + n.title);
  }

  function newNote() {
    S.current = null;
    fillForm({
      title: '', slug: '', date: today(), category: '', tags: [], summary: '', draft: false,
      body: '# 标题\n\n> 一句话说明这篇笔记要解决什么问题。\n\n## 一、背景 / 适用场景\n\n\n\n## 二、核心内容\n\n'
    });
    $('#fSlug').value = '';
    showEditor();
    setDirty(false);
    refreshPreview(true);
    renderLinkPanel();
    renderList();
    refreshCategories();
    updateWordCount();
    setStatus('新建笔记：填写后保存');
    $('#fTitle').focus();
  }

  /* skipOffer：由「同步到站点」按钮调用时已明确要同步，不再二次询问 */
  function saveCurrent(skipOffer) {
    var data = collectForm();
    if (!data.title.trim()) { toast('请先填写标题', true); return false; }
    /* slug 由标题（或手填的「文件名」）决定。为空说明标题里没有一个可用字符
       （纯标点 / 纯 emoji 等）—— 直接拒绝，绝不让它落到随机文件名上，
       否则「同一篇再存一次」就会变成「多一篇新文章」。 */
    if (!data.slug) {
      toast('标题里需要有文字或数字才能生成文件名；也可以在「文件名」里手动指定', true);
      return false;
    }

    var clash = S.notes.filter(function (n) { return n.slug === data.slug && n.slug !== S.current; })[0];
    if (clash) {
      toast('文件名已被「' + clash.title + '」占用，请换一个', true);
      return false;
    }

    if (S.current && S.current !== data.slug) {
      // 改名：新建一条并删除旧的
      S.notes = S.notes.filter(function (n) { return n.slug !== S.current; });
      if (S.synced[S.current]) { delete S.synced[S.current]; }
    }
    S.notes = S.notes.filter(function (n) { return n.slug !== data.slug; });
    S.notes.push(data);
    S.current = data.slug;
    S.synced[data.slug] = false;
    // 改名或重新保存都意味着这篇笔记应当留在站点上
    S.removed = S.removed.filter(function (s) { return s !== data.slug; });
    persist();
    setDirty(false);
    refreshIndex();
    renderList();
    renderLinkPanel();
    updatePill();
    setStatus('已保存到本地库', 'ok');
    if (skipOffer) return true;
    offerSync();
    return true;
  }

  function deleteCurrent() {
    if (!S.current) { toast('当前是未保存的新笔记', true); return; }
    var slug = S.current;
    var n = S.notes.filter(function (x) { return x.slug === slug; })[0];
    confirmDialog('删除笔记', '将从本地库删除「' + esc(n ? n.title : slug) + '」。<br>' +
      '下次<b>同步到站点</b>时，<code>notes/</code> 里对应的文件会移入回收站（<b>可还原</b>）。',
      function () {
        S.notes = S.notes.filter(function (x) { return x.slug !== slug; });
        delete S.synced[slug];
        if (S.removed.indexOf(slug) === -1) S.removed.push(slug);
        persist();
        S.current = null;
        showEmpty();
        refreshIndex();
        renderList();
        updatePill();
        setStatus('已删除：' + (n ? n.title : slug) + '（同步后站点上才会移除）');
      });
  }

  /* ---------------- 预览面板：收起 / 展开（默认展开，偏好本地记忆） ----------------
     开关统一放在编辑栏顶部的操作栏，展开/收起都改这一个按钮的文案与提示。
     预览栏本身不再带按钮（因为收起后整栏不可见，按钮会一起失踪，体验割裂）。 */
  function applyPreviewCollapsed(collapsed) {
    document.body.classList.toggle('preview-collapsed', !!collapsed);
    var btn = $('#btnPreviewBar');
    if (!btn) return;
    btn.hidden = false;                            // 始终可见，单纯切换文案
    btn.textContent = collapsed ? '展开预览' : '收起预览';
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.title = (collapsed ? '展开预览' : '收起预览') + '  Ctrl+Shift+V';
  }

  function readPreviewPref() {
    try { return localStorage.getItem('secnotes.manage.preview') === 'collapsed'; }
    catch (e) { return false; }        // 读不到就按默认（展开）
  }

  function togglePreview() {
    var collapsed = !document.body.classList.contains('preview-collapsed');
    applyPreviewCollapsed(collapsed);
    try { localStorage.setItem('secnotes.manage.preview', collapsed ? 'collapsed' : 'open'); }
    catch (e) { /* 忽略：不可用时仅本次会话生效 */ }
    if (!collapsed) refreshPreview(true);   // 展开时补一次渲染，避免收起期间的改动看不到
    setStatus(collapsed ? '预览已收起' : '预览已展开');
  }

  /* ---------------- 与本地服务协同：一键写回 notes/ 并重建 ---------------- */
  /* file:// 页面读不到本地文件，但可以跨域加载脚本——用 JSONP 拿到服务令牌，
     这样用户不必手工抄令牌；只有本地来源（含 file:// 的 Origin: null）才拿得到。 */
  function detectSyncService() {
    var i = 0;
    function tryNext() {
      if (i >= SYNC_PORTS.length) {
        setSyncState(false);
        /* 以 file:// 打开时，浏览器禁止页面向 http://127.0.0.1 发起脚本请求，
           所以连不上服务**不是**因为"服务没启动"，而是打开方式不对。
           这一点必须讲清楚，否则用户会一直以为同步成功、只是展示端没刷新。 */
        if (String(location.protocol) === 'file:') warnFileProtocol();
        return;
      }
      var port = SYNC_PORTS[i++];
      var base = 'http://127.0.0.1:' + port + '/';
      var s = document.createElement('script');
      s.src = base + 'api/token.js';
      s.onload = function () {
        if (window.SEC_SYNC_TOKEN) {
          S.syncBase = base;
          S.syncToken = window.SEC_SYNC_TOKEN;
          /* 服务若以 --no-rebuild 启动：同步会写文件但不重建站点数据，
             展示端永远看不到变化。令牌接口会把这个标志一起下发，
             这里提前摆到台面上，而不是等用户发现"删了却没反应"。 */
          S.syncNoRebuild = window.SEC_SYNC_NO_REBUILD === true ||
            window.SEC_SYNC_NO_REBUILD === 'true';
          setSyncState(true);
        } else {
          tryNext();
        }
      };
      s.onerror = function () { tryNext(); };
      document.head.appendChild(s);
    }
    tryNext();
  }

  function setSyncState(up) {
    var btn = $('#btnSync');
    if (!btn) return;
    if (up) {
      if (S.syncNoRebuild) {
        btn.textContent = '同步（不会重建）';
        btn.title = '服务以 --no-rebuild 启动：文件会写回 notes/，但站点数据不会重建，展示端看不到变化';
        btn.classList.add('ready', 'warn');
      } else {
        btn.textContent = '同步到站点';
        btn.title = '写回 notes/ 目录并重新构建（展示端会自动刷新）';
        btn.classList.add('ready');
        btn.classList.remove('warn');
      }
    } else {
      btn.textContent = '导出到 notes/';
      btn.title = '未检测到本地服务，改用导出方式';
      btn.classList.remove('ready', 'warn');
    }
    var hint = $('#stHint');
    if (hint) {
      hint.textContent = up
        ? (S.syncNoRebuild ? '⚠ 服务跳过了重建，展示端不会更新' : '服务已连接：保存后可直接同步')
        : 'Ctrl+S 保存';
    }
  }

  function syncWithServer() {
    if (!S.syncBase || !S.syncToken) { $('#modalSync').hidden = false; return Promise.resolve(false); }
    if (typeof fetch !== 'function') {
      setStatus('当前环境不支持网络请求', 'err');
      toast('当前环境无法调用本地服务，请用导出方式', true);
      return Promise.resolve(false);
    }
    setStatus('正在同步到站点…');
    return fetch(S.syncBase + 'api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': S.syncToken },
      body: JSON.stringify({ notes: sortedNotes(), removed: S.removed.slice() })
    }).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, error: '服务响应异常（HTTP ' + r.status + '）' };
      });
    }).then(function (res) {
      if (!res || !res.ok) {
        setStatus('同步失败', 'err');
        toast(res && res.error ? res.error : '同步失败', true);
        return false;
      }
      /* 必须校验构建结果，不能只看 res.ok：
           · 服务以 --no-rebuild 启动时，文件会照常写回/移入回收站，
             但 data/notes.js **不会重建** → 展示端永远看不到变化；
           · build.py 自身失败时同样如此。
         过去只判断 res.ok，于是这两种情况下都会谎报「站点已重建」，
         用户以为同步成功、展示端却没反应（真实踩过）。 */
      var build = res.build || {};
      S.notes.forEach(function (n) { S.synced[n.slug] = true; });
      S.removed = [];
      persist();
      renderList();
      updatePill();

      if (build.skipped) {
        setStatus('已写回 notes/，但服务跳过了重建：站点数据未更新', 'err');
        toast('文件已写入，但服务以 --no-rebuild 启动，展示端不会更新。' +
          '请去掉该参数重启服务，或手动运行 python build.py', true);
        return true;
      }
      if (build.ok === false) {
        setStatus('已写回 notes/，但重建失败', 'err');
        /* 显示服务端提炼的异常摘要（异常类型 + 消息），而不是截取 traceback 开头。
           完整堆栈在服务端日志里，摘要足够定位问题。 */
        toast('重建失败：' + (build.error || (build.output || '').slice(-160) || 'build.py 返回非 0 退出码'), true);
        return false;
      }
      notifySite();          // 只有真正重建成功，才值得让展示端刷新
      setStatus('已同步：写入 ' + res.written + ' 篇，站点已重建', 'ok');
      toast('已写回 notes/ 并重建，展示端会自动刷新');
      return true;
    }).catch(function (e) {
      setStatus('同步失败', 'err');
      toast('连不上本地服务：' + (e && e.message ? e.message : e), true);
      return false;
    });
  }

  /* 通知同一浏览器里已打开的展示端自动刷新（尽力而为，不生效时手动刷新即可） */
  function notifySite() {
    try { localStorage.setItem(RELOAD_KEY, String(Date.now())); } catch (e) { /* 忽略 */ }
    try {
      if (window.BroadcastChannel) {
        var ch = new BroadcastChannel('secnotes');
        ch.postMessage({ type: 'reload' });
        ch.close();
      }
    } catch (e) { /* 忽略 */ }
  }

  /* file:// 下同步不可用 —— 明确告知，而不是让"导出模式"静默接管 */
  function warnFileProtocol() {
    var hint = $('#stHint');
    if (hint) hint.textContent = '⚠ 以 file:// 打开，无法连接服务';
    var banner = $('#banner'), text = $('#bannerText');
    if (!banner || !text) return;
    text.innerHTML = '<b>当前是以 file:// 打开的，同步功能不可用。</b><br>' +
      '浏览器禁止 file:// 页面访问 <code>http://127.0.0.1:8080</code>，因此连不上本地服务 —— ' +
      '保存与删除<b>不会</b>写回 <code>notes/</code>，展示端自然也不会变化。<br>' +
      '请用这个地址打开管理端：<code>http://127.0.0.1:8080/manage.html</code>' +
      '（或重新双击 <code>start-admin.bat</code>，它会用该地址打开）。';
    banner.hidden = false;
  }

  /* ---------------- 回收站（读取 .trash/，需要本地服务） ----------------
     删除是「移入 .trash/」而不是物理删除，所以需要一个入口让用户能还原或彻底清掉。
     这条链路依赖本地服务：浏览器读不到磁盘，服务不在时明确说明而不是静默失败。 */
  function openTrash() {
    $('#modalTrash').hidden = false;
    loadTrash();
  }

  function trashApi(path, payload, done) {
    if (!S.syncBase || !S.syncToken) {
      done({ ok: false, error: '未连接本地服务' });
      return;
    }
    var init = { method: payload ? 'POST' : 'GET', headers: { 'X-Admin-Token': S.syncToken } };
    if (payload) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }
    fetch(S.syncBase + path, init).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, error: '服务响应异常（HTTP ' + r.status + '）' };
      });
    }).then(done).catch(function (e) {
      done({ ok: false, error: '连不上本地服务：' + (e && e.message ? e.message : e) });
    });
  }

  function loadTrash() {
    var box = $('#trashList');
    if (!box) return;
    if (!S.syncBase || !S.syncToken) {
      box.innerHTML = '<div class="mg-trash-empty">回收站需要本地服务。<br>' +
        '请运行 <code>python admin.py</code> 后刷新本页面 —— ' +
        '未启动服务时浏览器无法读取 <code>.trash/</code> 目录。</div>';
      return;
    }
    box.innerHTML = '<div class="mg-trash-empty">正在读取…</div>';
    trashApi('api/state', null, function (res) {
      if (!res || !res.ok) {
        box.innerHTML = '<div class="mg-trash-empty">读取失败：' +
          esc(res && res.error ? res.error : '未知错误') + '</div>';
        return;
      }
      renderTrash(res.trash || []);
    });
  }

  function renderTrash(items) {
    var box = $('#trashList');
    if (!box) return;
    if (!items.length) {
      box.innerHTML = '<div class="mg-trash-empty">回收站是空的</div>';
      return;
    }
    box.innerHTML = items.map(function (t) {
      var kb = Math.max(1, Math.round((t.size || 0) / 1024));
      return '<div class="mg-trash-item" data-name="' + esc(t.name) + '">' +
        '<div class="mg-trash-meta">' +
          '<strong>' + esc(t.title || t.original || t.name) + '</strong>' +
          '<span>' + esc(t.deleted_at || '') + ' · ' + kb + ' KB</span>' +
          '<code>' + esc(t.original || t.name) + '</code>' +
        '</div>' +
        '<div class="mg-trash-acts">' +
          '<button class="adm-btn ghost" data-restore type="button">还原</button>' +
          '<button class="adm-btn danger" data-purge type="button">彻底删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function restoreTrash(name, title) {
    trashApi('api/restore', { name: name }, function (res) {
      if (!res || !res.ok) {
        toast('还原失败：' + (res && res.error ? res.error : '未知错误'), true);
        return;
      }
      var b = res.build || {};
      if (b.skipped || b.ok === false) {
        toast('文件已还原，但站点数据未重建（' +
          (b.skipped ? '服务以 --no-rebuild 启动' : '构建失败') + '）', true);
      } else {
        /* 还原后必须把这篇补回本地库，否则管理端看不到它。
           重新拉一次站点数据（用 <script> 而非 fetch，file:// 下也能跨域取到），再对账。 */
        reloadSiteDataThenReconcile();
        toast('已还原「' + (title || name) + '」');
      }
      loadTrash();
    });
  }

  function purgeTrash(name, title) {
    confirmDialog('彻底删除', '将<b>永久删除</b>「' + esc(title || name) +
      '」，<b>无法还原</b>。确定吗？', function () {
      trashApi('api/purge', { name: name, confirm: true }, function (res) {
        if (!res || !res.ok) {
          toast('删除失败：' + (res && res.error ? res.error : '未知错误'), true);
          return;
        }
        toast('已彻底删除');
        loadTrash();
      });
    });
  }

  /* 重新载入站点数据（更新 window.SEC_BLOG）后与本地库对账 */
  function reloadSiteDataThenReconcile() {
    var base = String(S.syncBase || '').replace(/\/+$/, '');
    if (!base) return;
    var s = document.createElement('script');
    s.src = base + '/data/notes.js?t=' + Date.now();
    s.onload = function () {
      var added = reconcileWithSite();
      if (added) setStatus('已从回收站还原 ' + added + ' 篇并载入本地库', 'ok');
    };
    s.onerror = function () { /* 取不到就保持现状，可手动刷新 */ };
    document.head.appendChild(s);
  }

  /* 保存后询问是否同步——点保存即可走完"写回 + 重建"两步 */
  function offerSync() {
    if (S.syncBase && S.syncToken) {
      var nWrite = sortedNotes().length;
      var nDrop = S.removed.length;
      var detail = '将写入 <b>' + nWrite + '</b> 篇到 <code>notes/</code>';
      if (nDrop) {
        detail += '，并把 <b>' + nDrop + '</b> 篇移入回收站（<b>可还原</b>）';
      }
      detail += '，然后运行 <code>build.py</code>。展示端刷新后就能看到。';
      confirmDialog('已保存到本地库', '现在<b>同步到站点</b>吗？' + detail,
        syncWithServer, '稍后再说', function () { /* 仅本地保存 */ });
    } else {
      $('#syncText').innerHTML =
        '没有检测到本地服务，无法自动写回 <code>notes/</code> 目录。<br>' +
        '启动一次即可（之后每次保存都能一键同步）：<br>' +
        '<code>python admin.py</code>';
      $('#modalSync').hidden = false;
    }
  }

  /* ---------------- 导入 / 导出 ---------------- */
  function yamlValue(v) {
    var s = String(v == null ? '' : v);
    if (!s) return '""';
    if (/[:#\-{}[\]&*?|>!%@`"'\n]/.test(s) || s !== s.trim()) {
      return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
    }
    return s;
  }

  function toMarkdown(n) {
    var lines = ['---'];
    lines.push('title: ' + yamlValue(n.title));
    lines.push('date: ' + yamlValue(n.date));
    lines.push('category: ' + yamlValue(n.category));
    if (n.tags && n.tags.length) lines.push('tags: [' + n.tags.map(yamlValue).join(', ') + ']');
    if (n.summary) lines.push('summary: ' + yamlValue(n.summary));
    if (n.draft) lines.push('draft: true');
    lines.push('---', '');
    return lines.join('\n') + (n.body || '');
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportJson() {
    var payload = {
      version: 1,
      source: 'manage.html',
      exportedAt: new Date().toISOString(),
      notes: sortedNotes().map(function (n) {
        return {
          slug: n.slug, title: n.title, date: n.date, category: n.category,
          tags: n.tags || [], summary: n.summary || '', draft: !!n.draft, body: n.body || ''
        };
      })
    };
    download('notes.json', JSON.stringify(payload, null, 2), 'application/json');
    setStatus('已导出 notes.json', 'ok');
    toast('把 notes.json 放到项目根目录后运行：python build.py --from-json notes.json');
  }

  function downloadCurrentMd() {
    var data = collectForm();
    download((data.slug || 'note') + '.md', toMarkdown(data), 'text/markdown');
    setStatus('已下载 ' + data.slug + '.md', 'ok');
  }

  function downloadAllMd() {
    var list = sortedNotes();
    if (!list.length) { toast('本地库是空的', true); return; }
    list.forEach(function (n, i) {
      setTimeout(function () { download(n.slug + '.md', toMarkdown(n), 'text/markdown'); }, i * 350);
    });
    setStatus('正在下载 ' + list.length + ' 个 .md 文件', 'ok');
  }

  function importFromFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(String(reader.result)); }
      catch (e) { toast('不是有效的 JSON 备份', true); return; }
      var incoming = Array.isArray(data) ? data : (data && data.notes);
      if (!Array.isArray(incoming)) { toast('备份里没有 notes 数组', true); return; }

      var count = 0;
      incoming.forEach(function (raw) {
        if (!raw || !raw.slug) return;
        var note = {
          slug: String(raw.slug),
          title: raw.title || '',
          date: raw.date || today(),
          category: raw.category || '未分类',
          tags: Array.isArray(raw.tags) ? raw.tags.slice() : parseTags(raw.tags),
          summary: raw.summary || '',
          draft: !!raw.draft,
          body: raw.body || ''
        };
        S.notes = S.notes.filter(function (n) { return n.slug !== note.slug; });
        S.notes.push(note);
        S.synced[note.slug] = false;
        count++;
      });
      persist();
      refreshIndex();
      renderList();
      updatePill();
      setStatus('已导入 ' + count + ' 篇', 'ok');
      toast('已导入 ' + count + ' 篇笔记');
    };
    reader.onerror = function () { toast('读取文件失败', true); };
    reader.readAsText(file);
  }

  function importFromSite() {
    var list = notesFromSite();
    if (!list.length) { toast('站点数据里没有笔记（data/notes.js）', true); return; }
    var merge = S.notes.length > 0;
    confirmDialog('从站点数据导入',
      '将用 <code>data/notes.js</code> 里的 ' + list.length + ' 篇笔记' +
      (merge ? '<b>覆盖本地库中同名的笔记</b>（其它笔记保留）' : '填充本地库') + '。',
      function () {
        list.forEach(function (n) {
          S.notes = S.notes.filter(function (x) { return x.slug !== n.slug; });
          S.notes.push(n);
          if (S.synced[n.slug] === undefined) S.synced[n.slug] = true;  // 站点已有的视为已同步
        });
        persist();
        refreshIndex();
        renderList();
        updatePill();
        setStatus('已从站点数据导入 ' + list.length + ' 篇', 'ok');
        toast('已导入 ' + list.length + ' 篇');
      });
  }

  /* 站点数据是否已成功加载。
     用 stats 判定：data/notes.js 无论站点有没有笔记都会写入 stats；
     脚本加载失败时 window.SEC_BLOG 整个是 undefined。
     这个区分至关重要——把「站点为空」误判成「数据没加载」会漏清理，
     反之把「数据没加载」当成「站点为空」会把用户整个本地库清空。 */
  function siteDataLoaded() {
    return !!(window.SEC_BLOG && typeof window.SEC_BLOG === 'object' && window.SEC_BLOG.stats);
  }

  /* 启动时与站点数据对账。站点（notes/ 的构建产物）是唯一权威来源，双向对齐：
     方向一：站点有、本地库既没有也没标记删除 → 补进来。
       没有这一步，管理端会与展示端无声地长期不一致——
       例如笔记是通过 admin/ 或手工加进 notes/ 的，本地库完全不知情。
       被显式删除过（在 S.removed 里）的笔记不会被重新拉回来。
     方向二：本地库标记为「已同步」但站点上已不存在 → 移除。
       这是「管理端删除后展示端不同步」的根因：同步成功后 S.removed 会被清空，
       若本地库仍留着那篇（例如曾被过期的站点数据补回），下次同步就会把它
       重新写回 notes/，等于把删除操作悄悄撤销，两端永远对不上。
       站点没有的已同步笔记不该留在本地库里。 */
  function reconcileWithSite() {
    if (!siteDataLoaded()) return 0;      // 站点数据没加载：不做任何判断
    var site = notesFromSite();
    var siteSlugs = {};
    site.forEach(function (n) { siteSlugs[n.slug] = true; });

    var have = {}, gone = {};
    S.notes.forEach(function (n) { have[n.slug] = true; });
    S.removed.forEach(function (s) { gone[s] = true; });

    /* ---- 方向一：补入站点上新增的笔记 ---- */
    var added = 0;
    site.forEach(function (n) {
      if (have[n.slug] || gone[n.slug]) return;
      S.notes.push(n);
      if (S.synced[n.slug] === undefined) S.synced[n.slug] = true;
      added++;
    });

    /* ---- 方向二：清理站点上已不存在的已同步笔记（幻影条目） ----
       保留两类：
         · synced === false —— 本地有未同步的新建或修改，不能丢
         · 在 removed 队列里 —— 待同步的删除意图，交给同步流程处理
       其余一律以站点为准。 */
    var before = S.notes.length;
    S.notes = S.notes.filter(function (n) {
      if (S.synced[n.slug] === false) return true;
      if (gone[n.slug]) return true;
      return siteSlugs[n.slug] === true;
    });
    var dropped = before - S.notes.length;
    if (dropped) {
      var kept = {};
      S.notes.forEach(function (n) { kept[n.slug] = true; });
      Object.keys(S.synced).forEach(function (s) {
        if (!kept[s]) delete S.synced[s];
      });
    }

    if (added || dropped) persist();
    return added;
  }

  /* ---------------- 写入 notes/ 目录（File System Access API） ---------------- */
  function syncSupported() {
    return typeof window.showDirectoryPicker === 'function';
  }

  async function syncToDir() {
    if (!syncSupported()) return;
    try {
      if (!S.dirHandle) {
        S.dirHandle = await window.showDirectoryPicker({ id: 'secnotes-notes', mode: 'readwrite' });
      }
      var written = 0;
      for (var i = 0; i < S.notes.length; i++) {
        var n = S.notes[i];
        var fh = await S.dirHandle.getFileHandle(n.slug + '.md', { create: true });
        var w = await fh.createWritable();
        await w.write(toMarkdown(n));
        await w.close();
        S.synced[n.slug] = true;
        written++;
      }
      persist();
      renderList();
      updatePill();
      setStatus('已写入 ' + written + ' 个文件到 notes/ 目录', 'ok');
      toast('写好了，接下来在项目目录运行：python build.py', false);
    } catch (e) {
      if (e && e.name === 'AbortError') return;      // 用户取消
      toast('写入失败：' + (e && e.message ? e.message : e), true);
    }
  }

  /* ---------------- 双向链接联想 ---------------- */
  var WIKI_OPEN = /\[\[([^\[\]\n]*)$/;

  function wikiFragment() {
    var pos = TA.selectionStart;
    var before = TA.value.slice(0, pos);
    var m = before.match(WIKI_OPEN);
    if (!m) return null;
    return { start: pos - m[0].length, end: pos, raw: m[1] };
  }

  function openPicker() {
    var frag = wikiFragment();
    if (!frag) return;
    var q = frag.raw.trim().toLowerCase();
    var items = S.notes.filter(function (n) {
      return n.slug !== S.current && (!q || n.title.toLowerCase().indexOf(q) > -1);
    });
    if (!items.length) return closePicker();
    S.picker = { open: true, items: items, index: 0, frag: frag, suppressed: false };
    renderPicker();
    $('#picker').hidden = false;
  }

  function renderPicker() {
    var list = $('#pickerList');
    if (!list) return;
    if (!S.picker.items.length) {
      list.innerHTML = '<div class="adm-links-empty">没有匹配的笔记</div>';
      return;
    }
    list.innerHTML = S.picker.items.map(function (n, i) {
      var title = esc(n.title);
      if (S.picker.frag && S.picker.frag.raw.trim()) {
        var q = S.picker.frag.raw.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        title = title.replace(new RegExp(q, 'ig'), function (m) { return '<mark>' + m + '</mark>'; });
      }
      return '<button type="button" class="adm-picker-item' + (i === S.picker.index ? ' active' : '') +
        '" data-slug="' + esc(n.slug) + '">' +
        '<span class="adm-picker-title">' + title + '</span>' +
        '<span class="adm-picker-meta">' + esc(n.category || '') + '</span></button>';
    }).join('');
  }

  function movePicker(delta) {
    if (!S.picker.items.length) return;
    S.picker.index = (S.picker.index + delta + S.picker.items.length) % S.picker.items.length;
    renderPicker();
  }

  function insertPick(slug) {
    var note = S.notes.filter(function (n) { return n.slug === slug; })[0];
    var frag = S.picker.frag;
    if (!note || !frag) return closePicker();
    var text = '[[' + note.title + ']]';
    closePicker();
    TA.focus();
    TA.setSelectionRange(frag.start, frag.end);
    document.execCommand ? document.execCommand('insertText', false, text) : (function () {
      var v = TA.value;
      TA.value = v.slice(0, frag.start) + text + v.slice(frag.end);
    })();
    TA.setSelectionRange(frag.start + text.length, frag.start + text.length);
    setDirty(true);
    refreshPreview();
    renderLinkPanel();
  }

  function closePicker() {
    S.picker = { open: false, items: [], index: 0, frag: null, suppressed: S.picker.suppressed };
    var p = $('#picker');
    if (p) p.hidden = true;
  }

  /* ---------------- 工具栏 ---------------- */
  function selection() {
    return { s: TA.selectionStart, e: TA.selectionEnd, text: TA.value.slice(TA.selectionStart, TA.selectionEnd) };
  }

  function replaceRange(start, end, text, selStart, selEnd) {
    TA.focus();
    TA.setSelectionRange(start, end);

    /* execCommand 能用就用（可进入浏览器原生撤销栈）；被忽略或不可用时兜底，
       否则会出现"点了没反应"——这类静默失败排查成本很高。 */
    var before = TA.value;
    var done = false;
    if (typeof document.execCommand === 'function') {
      try { done = document.execCommand('insertText', false, text); } catch (e) { done = false; }
    }
    if (!done || TA.value === before) {
      if (typeof TA.setRangeText === 'function') {
        TA.setRangeText(text, start, end, 'end');
      } else {
        TA.value = before.slice(0, start) + text + before.slice(end);
      }
    }

    if (selStart != null) TA.setSelectionRange(selStart, selEnd == null ? selStart : selEnd);
    setDirty(true);
    updateWordCount();
    refreshPreview();
    renderLinkPanel();
  }

  function wrap(before, after, placeholder) {
    var sel = selection();
    var text = sel.text || placeholder || '';
    replaceRange(sel.s, sel.e, before + text + after,
      sel.s + before.length, sel.s + before.length + text.length);
  }

  function linePrefix(prefix) {
    var sel = selection();
    var start = TA.value.lastIndexOf('\n', sel.s - 1) + 1;
    var block = TA.value.slice(start, sel.e) || '';
    var lines = block.split('\n').map(function (l) { return prefix + l; });
    replaceRange(start, sel.e, lines.join('\n'), start, start + lines.join('\n').length);
  }

  function linePrefixOrdered() {
    var sel = selection();
    var start = TA.value.lastIndexOf('\n', sel.s - 1) + 1;
    var block = TA.value.slice(start, sel.e) || '第一项';
    var lines = block.split('\n').map(function (l, i) { return (i + 1) + '. ' + l; });
    replaceRange(start, sel.e, lines.join('\n'), start, start + lines.join('\n').length);
  }

  function padBefore(pos) {
    var prev = TA.value.slice(pos - 1, pos);
    if (!pos) return '';
    return (prev && prev !== '\n') ? '\n' : '';
  }

  function padAfter(pos) {
    var next = TA.value.slice(pos, pos + 1);
    if (pos >= TA.value.length) return '\n';
    return (next && next !== '\n') ? '\n' : '';
  }

  function insertBlock(text) {
    var sel = selection();
    var pre = padBefore(sel.s);
    var post = padAfter(sel.e);
    replaceRange(sel.s, sel.e, pre + text + post,
      sel.s + pre.length, sel.s + pre.length + text.length);
  }

  /* ---------------- 图片：调用系统文件选择器 → 上传 → 插入 Markdown ----------------
     需要同步服务在跑；免服务模式下管理端没有上传能力（浏览器不允许网页直写本地文件），
     这时给出明确提示，不要静默失败。 */
  function pickAndInsertImage() {
    var input = S.imagePicker;
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.setAttribute('aria-hidden', 'true');
      input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
      S.imagePicker = input;
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        // 不立刻清 input.value：允许连选同一文件时再次触发
        if (file) uploadAndInsertImage(file);
      });
      document.body.appendChild(input);
    }
    input.click();
  }

  function uploadAndInsertImage(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('只能插入图片文件', true); return; }
    if (file.size > 8 * 1024 * 1024) { toast('图片超过 8MB 上限', true); return; }
    if (!S.syncBase || !S.syncToken) {
      toast('图片上传需要启动同步服务', true);
      setStatus('同步服务未启动，无法上传图片（请运行 start-admin.bat）', 'err');
      return;
    }
    setStatus('图片上传中…');
    var reader = new FileReader();
    reader.onload = function () {
      fetch(S.syncBase + 'api/upload', {
        method: 'POST',
        headers: {
          'X-Admin-Token': S.syncToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          dataUrl: reader.result,
          slug: S.current || ($('#fSlug').value || '').trim() || '__new__'
        })
      }).then(function (resp) {
        return resp.json().then(function (b) { return { status: resp.status, body: b }; });
      }).then(function (out) {
        if (out.status >= 200 && out.status < 300 && out.body && out.body.ok) {
          insertImageMarkdown(out.body.url, '图片');
          var kb = Math.round((out.body.bytes || 0) / 1024);
          setStatus((out.body.deduped ? '图片已存在，直接引用' : '图片已上传') + '（' + kb + ' KB）', 'ok');
        } else {
          var msg = (out.body && out.body.error) || ('HTTP ' + out.status);
          toast('图片上传失败：' + msg, true);
          setStatus('图片上传失败', 'err');
        }
      }).catch(function (err) {
        toast('图片上传失败：' + (err && err.message || err), true);
        setStatus('图片上传失败', 'err');
      });
    };
    reader.onerror = function () {
      toast('无法读取该图片', true);
      setStatus('图片读取失败', 'err');
    };
    reader.readAsDataURL(file);
  }

  function insertImageMarkdown(url, alt) {
    var label = alt || '图片';
    var sel = selection();
    var text = '![' + label + '](' + url + ')';
    var pre = padBefore(sel.s);
    var post = padAfter(sel.e);
    var altStart = sel.s + pre.length + 2;        // '![' 之后
    replaceRange(sel.s, sel.e, pre + text + post, altStart, altStart + label.length);
  }

  /* ---------------- 右键笔记列表：上下文菜单 ----------------
     原生 contextmenu 被禁用，自绘一个小菜单：打开 / 复制标题 / 删除这篇。
     关闭条件：点菜单内、点列表外、Esc、右键到空白处。 */
  function showNoteContextMenu(slug, x, y) {
    var n = (S.notes || []).filter(function (it) { return it.slug === slug; })[0];
    if (!n) return;
    closeNoteContextMenu();
    var menu = document.createElement('div');
    menu.className = 'adm-context-menu';
    menu.setAttribute('role', 'menu');
    menu.dataset.slug = slug;
    menu.innerHTML =
      '<button type="button" class="adm-context-item" data-act="open" role="menuitem">打开</button>' +
      '<button type="button" class="adm-context-item" data-act="copy" role="menuitem">复制标题</button>' +
      '<button type="button" class="adm-context-item danger" data-act="delete" role="menuitem">删除这篇…</button>';
    var w = 180, h = 120;
    menu.style.left = Math.min(Math.max(8, x), window.innerWidth  - w - 8) + 'px';
    menu.style.top  = Math.min(Math.max(8, y), window.innerHeight - h - 8) + 'px';
    document.body.appendChild(menu);
    S.contextMenu = menu;
    setTimeout(function () {
      document.addEventListener('mousedown', onCtxAway, true);
      document.addEventListener('keydown', onCtxKey, true);
    }, 0);
  }

  function closeNoteContextMenu() {
    if (S.contextMenu) { S.contextMenu.remove(); S.contextMenu = null; }
    document.removeEventListener('mousedown', onCtxAway, true);
    document.removeEventListener('keydown', onCtxKey, true);
  }

  function onCtxAway(e) {
    if (S.contextMenu && !S.contextMenu.contains(e.target)) closeNoteContextMenu();
  }
  function onCtxKey(e) {
    if (e.key === 'Escape') { closeNoteContextMenu(); e.stopPropagation(); }
  }

  function onContextItemClick(e) {
    var item = e.target.closest && e.target.closest('.adm-context-item');
    if (!item) return;
    var menu = item.closest && item.closest('.adm-context-menu');
    if (!menu || menu !== S.contextMenu) return;
    var slug = menu.dataset.slug;
    var act = item.dataset.act;
    var n = (S.notes || []).filter(function (x) { return x.slug === slug; })[0];
    closeNoteContextMenu();
    if (act === 'open') {
      openNote(slug);
    } else if (act === 'copy') {
      var text = (n && n.title) || slug;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          setStatus('已复制标题：' + text, 'ok');
        }, function () { toast('复制失败：浏览器拒绝'); });
      } else {
        toast('当前浏览器不支持复制到剪贴板', true);
      }
    } else if (act === 'delete') {
      // 切换当前笔记再走统一的删除流程（弹确认、清理 localStorage 与待移除列表）
      S.current = slug;
      deleteCurrent();
    }
  }

  function bindNoteContextMenu() {
    var list = $('#listScroll');
    if (!list) return;
    list.addEventListener('contextmenu', function (e) {
      var btn = e.target.closest && e.target.closest('.adm-item');
      if (!btn) return;
      e.preventDefault();
      var slug = btn.getAttribute('data-slug');
      if (slug) showNoteContextMenu(slug, e.clientX, e.clientY);
    });
    /* 右键点到空白处时若菜单已开，先关掉 */
    document.addEventListener('contextmenu', function (e) {
      if (!S.contextMenu) return;
      if (!(e.target.closest && e.target.closest('.adm-item'))) closeNoteContextMenu();
    }, true);
    document.addEventListener('click', onContextItemClick);
  }

  var TOOL_ACTIONS = {
    h2: function () { linePrefix('## '); },
    h3: function () { linePrefix('### '); },
    h4: function () { linePrefix('#### '); },
    bold: function () { wrap('**', '**', '加粗'); },
    italic: function () { wrap('*', '*', '斜体'); },
    code: function () { wrap('`', '`', 'code'); },
    ul: function () { linePrefix('- '); },
    ol: linePrefixOrdered,
    quote: function () { linePrefix('> '); },
    hr: function () { insertBlock('---'); },
    codeblock: function () { insertBlock('```bash\n\n```'); },
    link: function () {
      var sel = selection();
      var label = sel.text || '链接文字';
      replaceRange(sel.s, sel.e, '[' + label + '](https://)',
        sel.s + label.length + 3, sel.s + label.length + 3);
    },
    wikilink: function () {
      var sel = selection();
      var label = sel.text || '笔记标题';
      replaceRange(sel.s, sel.e, '[[' + label + ']]',
        sel.s + 2, sel.s + 2 + label.length);
    },
    image: function () { pickAndInsertImage(); },
    table: function () {
      insertBlock('| 项目 | 说明 |\n| --- | --- |\n|  |  |');
    }
  };

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    TA = $('#body');
    PREVIEW = $('#preview');
    PREVIEW_SCROLL = document.querySelector('.adm-preview-scroll');

    $('#btnNew').addEventListener('click', newNote);
    $('#btnNew2').addEventListener('click', newNote);
    // 注意：不要直接把 saveCurrent 当监听器——事件对象会被当成 skipOffer 参数
    $('#btnSave').addEventListener('click', function () { saveCurrent(); });
    $('#btnDelete').addEventListener('click', deleteCurrent);
    $('#btnDownloadMd').addEventListener('click', downloadCurrentMd);
    $('#btnExportJson').addEventListener('click', exportJson);
    $('#btnTrash').addEventListener('click', openTrash);
    $('#btnTrashRefresh').addEventListener('click', loadTrash);
    /* 回收站条目用事件委托：renderTrash 会重建列表，逐项绑定会失效 */
    $('#trashList').addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.hasAttribute) return;
      var row = t.closest ? t.closest('.mg-trash-item') : null;
      if (!row) return;
      var name = row.getAttribute('data-name') || '';
      var strong = row.querySelector('strong');
      var title = strong ? strong.textContent : '';
      if (t.hasAttribute('data-restore')) restoreTrash(name, title);
      else if (t.hasAttribute('data-purge')) purgeTrash(name, title);
    });

    $('#btnImport').addEventListener('click', function () {
      if (window.SEC_BLOG && window.SEC_BLOG.notes && window.SEC_BLOG.notes.length) {
        confirmDialog('导入笔记', '要导入哪一类？<br>' +
          '· <b>站点数据</b>：读取 <code>data/notes.js</code>（当前站点上的 ' +
          window.SEC_BLOG.notes.length + ' 篇）<br>' +
          '· <b>备份文件</b>：选择之前导出的 notes.json',
          importFromSite, '选择备份文件', function () { $('#importPicker').click(); });
      } else {
        $('#importPicker').click();
      }
    });
    $('#importPicker').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) importFromFile(f);
      e.target.value = '';
    });

    $('#btnSync').addEventListener('click', function () {
      if (S.syncBase && S.syncToken) {
        if (S.current || $('#fTitle').value.trim()) {
          if (saveCurrent(true)) syncWithServer();   // 先落本地库，再一步同步
        } else {
          syncWithServer();
        }
      } else if (syncSupported()) {
        syncToDir();
      } else {
        $('#modalSync').hidden = false;
      }
    });
    $('#btnSyncDir').addEventListener('click', function () {
      $('#modalSync').hidden = true;
      syncToDir();
    });
    $('#btnSyncJson').addEventListener('click', exportJson);
    $('#btnSyncAllMd').addEventListener('click', downloadAllMd);

    /* 两个入口（预览栏内 / 操作栏）都指向同一个状态 */
    Array.prototype.forEach.call(document.querySelectorAll('[data-preview-toggle]'), function (btn) {
      btn.addEventListener('click', togglePreview);
    });

    $('#btnTheme').addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('secnotes.theme', next); } catch (e) { /* 忽略 */ }
      var dark = $('#hljs-theme-dark'), light = $('#hljs-theme-light');
      if (dark && light) { dark.disabled = next !== 'dark'; light.disabled = next !== 'light'; }
    });

    $('#bannerClose').addEventListener('click', function () {
      $('#banner').hidden = true;
    });

    document.querySelectorAll('[data-close]').forEach(function (el) {
      el.addEventListener('click', function () {
        var m = el.closest('.adm-modal');
        if (m) m.hidden = true;
      });
    });
    document.querySelectorAll('.adm-modal').forEach(function (m) {
      m.addEventListener('click', function (e) { if (e.target === m) m.hidden = true; });
    });

    /* 列表：打开 / 链接面板跳转 */
    $('#listScroll').addEventListener('click', function (e) {
      var item = e.target.closest('.adm-item[data-slug]');
      if (item) {
        var slug = item.getAttribute('data-slug');
        if (slug !== S.current) openNote(slug);
        return;
      }
    });

    $('#linkPanel').addEventListener('click', function (e) {
      var open = e.target.closest('[data-open]');
      if (open) {
        var slug = open.getAttribute('data-open');
        var n = S.notes.filter(function (x) { return x.slug === slug; })[0];
        if (n) openNote(slug);
        return;
      }
      var fresh = e.target.closest('[data-newtitle]');
      if (fresh) {
        newNote();
        $('#fTitle').value = fresh.getAttribute('data-newtitle');
        setDirty(true);
        refreshPreview();
        renderLinkPanel();
      }
    });

    /* 搜索 */
    $('#listSearch').addEventListener('input', function (e) {
      S.query = e.target.value;
      renderList();
    });

    /* 编辑区 */
    TA.addEventListener('input', function () {
      setDirty(true);
      updateWordCount();
      refreshPreview();
      renderLinkPanel();
      if (!S.picker.suppressed) openPicker();
    });
    TA.addEventListener('click', function () { if (!S.picker.suppressed) openPicker(); });
    TA.addEventListener('keydown', function (e) {
      if (S.picker.open) {
        if (e.key === 'ArrowDown') { e.preventDefault(); movePicker(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); movePicker(-1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          insertPick(S.picker.items[S.picker.index].slug);
          return;
        }
        if (e.key === 'Escape') { e.preventDefault(); S.picker.suppressed = true; closePicker(); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveCurrent(); }
    });

    $('#pickerList').addEventListener('click', function (e) {
      var item = e.target.closest('.adm-picker-item[data-slug]');
      if (item) insertPick(item.getAttribute('data-slug'));
    });

    $('#toolbar').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-md]');
      if (!btn) return;
      var fn = TOOL_ACTIONS[btn.getAttribute('data-md')];
      if (fn) fn();
    });

    /* 元信息变化 */
    ['#fTitle', '#fSlug', '#fDate', '#fCategory', '#fTags', '#fSummary'].forEach(function (sel) {
      $(sel).addEventListener('input', function () { setDirty(true); });
    });
    $('#fDraft').addEventListener('change', function () { setDirty(true); });
    bindCategoryPicker();
    bindNoteContextMenu();

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        document.querySelectorAll('.adm-modal').forEach(function (m) { m.hidden = true; });
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (S.current || $('#fTitle').value.trim()) saveCurrent();
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        togglePreview();
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    bind();
    applyPreviewCollapsed(readPreviewPref());   // 先应用布局偏好，避免加载后跳动

    try {
      var saved = localStorage.getItem('secnotes.theme');
      if (saved) {
        document.documentElement.setAttribute('data-theme', saved);
        var dark = $('#hljs-theme-dark'), light = $('#hljs-theme-light');
        if (dark && light) { dark.disabled = saved !== 'dark'; light.disabled = saved !== 'light'; }
      }
    } catch (e) { /* 忽略 */ }

    if (!storageOk()) {
      $('#bannerText').innerHTML =
        '<b>当前浏览器禁用了本地存储</b>：笔记只在本次会话有效，关掉页面就会丢失。' +
        '请改用 Chrome / Edge 打开，或在编辑过程中随时「导出 JSON」留底。';
      $('#banner').hidden = false;
      setStatus('本地存储不可用，改动不会持久保存', 'err');
    }

    var store = loadStore();
    if (store) {
      S.notes = store.notes;
      S.synced = store.synced || {};
      S.removed = Array.isArray(store.removed) ? store.removed.slice() : [];
      setStatus('已从本地库载入 ' + S.notes.length + ' 篇');
    } else {
      S.notes = notesFromSite();
      S.synced = {};
      S.removed = [];
      S.notes.forEach(function (n) { S.synced[n.slug] = true; });
      if (S.notes.length) {
        persist();
        setStatus('首次打开：已从站点数据导入 ' + S.notes.length + ' 篇', 'ok');
      } else {
        setStatus('本地库为空，点「导入」载入站点数据');
      }
    }

    /* 与站点双向对账：补入站点新增的，清理站点已删除的（显式删除过的不补） */
    var beforeReconcile = S.notes.length;
    var adopted = reconcileWithSite();
    if (adopted) {
      setStatus('已从站点数据补入 ' + adopted + ' 篇', 'ok');
    } else if (S.notes.length < beforeReconcile) {
      setStatus('已按站点数据清理 ' + (beforeReconcile - S.notes.length) + ' 篇本地残留', 'ok');
    }

    refreshIndex();
    renderList();
    updatePill();
    showEmpty();
    updateWordCount();

    /* 探测本地服务：在则保存后可直接一键同步（写回 notes/ + 重建） */
    if (syncSupported()) $('#btnSyncDir').hidden = false;
    setSyncState(false);
    detectSyncService();
  }

  /* 供自检脚本使用 */
  window.__MANAGE__ = {
    state: S,
    boot: boot,
    newNote: newNote,
    openNote: openNote,
    saveCurrent: saveCurrent,
    deleteCurrent: deleteCurrent,
    renderList: renderList,
    renderLinkPanel: renderLinkPanel,
    refreshPreview: refreshPreview,
    refreshCategories: refreshCategories,
    categoryCounts: categoryCounts,
    NEW_CAT: NEW_CAT,
    toMarkdown: toMarkdown,
    slugify: slugify,
    countWords: countWords,
    parseTags: parseTags,
    exportJson: exportJson,
    importFromFile: importFromFile,
    importFromSite: importFromSite,
    reconcileWithSite: reconcileWithSite,
    notesFromSite: notesFromSite,
    syncWithServer: syncWithServer,
    offerSync: offerSync,
    notifySite: notifySite,
    setSyncState: setSyncState,
    togglePreview: togglePreview,
    applyPreviewCollapsed: applyPreviewCollapsed,
    saveCurrent: saveCurrent,
    setQuery: function (q) { S.query = q; renderList(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
