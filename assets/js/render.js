/* ============================================================
   SecRender —— 共享渲染模块
   ------------------------------------------------------------
   博客正文与后台编辑器预览共用同一套渲染链路：
     marked.parse → sanitize → enhance（代码块包装/高亮/复制、
     表格滚动容器、外链、标题锚点）
   目的是从机制上保证「编辑器所见 == 站点所渲染」，
   而不是靠人工对齐两套实现。

   依赖（需在此之前加载）：
     assets/vendor/marked.min.js
     assets/vendor/highlight.min.js
   对外暴露：window.SecRender
   ============================================================ */
(function (global) {
  'use strict';

  if (global.SecRender) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function qsa(sel, root) {
    return Array.prototype.slice.call(root.querySelectorAll(sel));
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* 检索关键词高亮：先转义 HTML 再包 <mark>，避免注入 */
  function highlight(text, query) {
    var safe = esc(text);
    var terms = String(query == null ? '' : query).trim().split(/\s+/)
      .filter(Boolean)
      .map(function (t) { return escapeRe(esc(t)); });
    if (!terms.length) return safe;
    try {
      return safe.replace(new RegExp('(' + terms.join('|') + ')', 'gi'), '<mark>$1</mark>');
    } catch (e) { return safe; }
  }

  /* ------------------------------------------------------------
     双向链接：[[笔记标题]] / [[笔记标题|显示文字]]
     ------------------------------------------------------------ */
  var WIKILINK_RE = /\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]/g;
  // 用于在展开前把「围栏代码块」与「行内代码」切出来，避免代码里的 [[..]] 被误展开
  var CODE_SPLIT_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

  var titleMap = null;   // 小写标题 / slug -> slug

  function setNoteIndex(list) {
    titleMap = {};
    (list || []).forEach(function (n) {
      if (!n) return;
      if (n.title) titleMap[String(n.title).trim().toLowerCase()] = n.slug;
      if (n.slug) titleMap[String(n.slug).trim().toLowerCase()] = n.slug;
    });
  }

  function hasNoteIndex() { return !!titleMap; }

  function resolveLink(target) {
    if (!titleMap) return null;
    return titleMap[String(target == null ? '' : target).trim().toLowerCase()] || null;
  }

  /* 列出正文里的全部双向链接（含未解析的），供编辑器侧栏与测试使用 */
  function findWikiLinks(markdown) {
    var out = [];
    var src = String(markdown == null ? '' : markdown);
    src.split(CODE_SPLIT_RE).forEach(function (chunk, i) {
      if (i % 2 === 1) return;             // 奇数段是代码，跳过
      var re = new RegExp(WIKILINK_RE.source, 'g');
      var m;
      while ((m = re.exec(chunk)) !== null) {
        var target = m[1].trim();
        out.push({
          target: target,
          label: (m[2] || m[1]).trim(),
          slug: resolveLink(target)
        });
      }
    });
    return out;
  }

  /* 把 [[..]] 展开成链接；未解析的渲染为「待创建」样式但保留文字。
     opts.wikiHref(slug) 可定制已解析链接的地址（导出单文件时指向页内锚点）；
     opts.wikiMissingHref 定制未解析链接的地址。 */
  function expandWikiLinks(markdown, opts) {
    if (!titleMap) return markdown;
    var o = opts || {};
    var hrefFor = (typeof o.wikiHref === 'function')
      ? o.wikiHref
      : function (slug) { return '#/note/' + encodeURIComponent(slug); };
    var missingHref = (o.wikiMissingHref != null) ? o.wikiMissingHref : '#/';

    return String(markdown == null ? '' : markdown)
      .split(CODE_SPLIT_RE)
      .map(function (chunk, i) {
        if (i % 2 === 1) return chunk;     // 代码块原样保留
        return chunk.replace(WIKILINK_RE, function (whole, target, label) {
          var text = String(label || target).trim();
          var slug = resolveLink(target);
          if (slug) {
            return '<a class="wikilink" href="' + esc(hrefFor(slug)) + '">' +
              esc(text) + '</a>';
          }
          return '<a class="wikilink missing" href="' + esc(missingHref) +
            '" title="尚未创建该笔记">' + esc(text) + '</a>';
        });
      })
      .join('');
  }

  /* ------------------------------------------------------------
     标题容错：ATX 标题的 # 之后必须跟空格（CommonMark 规定）。
     手写时很容易漏掉，写成 "##三、补充目录111" —— 这样只会渲染成
     普通段落：字号比 "## 一、" 小一截，也进不了目录。
     这里在解析前把缺失的空格补上。只认行首（≤3 空格缩进），
     并跟踪围栏代码块，避免改坏代码里的 # 注释。
     ------------------------------------------------------------ */
  var FENCE_LINE_RE = /^\s{0,3}(`{3,}|~{3,})/;
  var ATX_MISSING_SPACE_RE = /^( {0,3})(#{1,6})(?=[^#\s])/;

  function normalizeHeadings(markdown) {
    var fence = null;
    return String(markdown == null ? '' : markdown).split('\n').map(function (line) {
      var m = line.match(FENCE_LINE_RE);
      if (m) {
        var mark = m[1].charAt(0);
        if (!fence) fence = mark;
        else if (fence === mark) fence = null;
        return line;
      }
      if (fence) return line;                        // 围栏代码块内一律不动
      return line.replace(ATX_MISSING_SPACE_RE, '$1$2 ');
    }).join('\n');
  }

  /* ------------------------------------------------------------
     HTML 净化：剥离脚本类标签与事件属性
     ------------------------------------------------------------ */
  var BANNED_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form'];

  function sanitize(html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;

    BANNED_TAGS.forEach(function (tag) {
      qsa(tag, tpl.content).forEach(function (el) { el.remove(); });
    });

    var walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_ELEMENT);
    var node;
    while ((node = walker.nextNode())) {
      Array.prototype.slice.call(node.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        var val = String(attr.value || '').replace(/\s/g, '').toLowerCase();
        if (name.indexOf('on') === 0) node.removeAttribute(attr.name);
        if (name === 'href' && /^(javascript|vbscript):/.test(val)) node.removeAttribute(attr.name);
      });
    }
    return tpl.innerHTML;
  }

  /* ------------------------------------------------------------
     复制到剪贴板（含无 Clipboard API 时的回退）
     ------------------------------------------------------------ */
  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok && done) done();
    } catch (e) { /* 静默失败，不影响阅读 */ }
  }

  function copyText(text, onDone) {
    var done = onDone || function () {};
    if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  /* ------------------------------------------------------------
     标题锚点 id
     ------------------------------------------------------------ */
  function slugifyHeading(text, used) {
    var base = String(text).trim().toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');
    if (!base) base = 'section';
    var id = base, i = 2;
    while (used[id]) { id = base + '-' + i++; }
    used[id] = true;
    return id;
  }

  /* ------------------------------------------------------------
     思维导图：把 ```mindmap 围栏代码块渲染为内联 SVG
     ------------------------------------------------------------
     语法：缩进决定层级，- / * / + 前缀可省略。
       ```mindmap
       中心主题
         分支 A
           子节点 A1
         分支 B
       ```
     布局：根节点居中，一级分支左右平分，同侧子树纵向堆叠（后序定 y，父节点居中）。
     配色按一级分支分配（.mm-b0 ~ .mm-b5），颜色与字体由 style.css 控制，
     因此自动跟随站点深浅主题；不在这里写死颜色。
     内容为空或只有空白时返回 null，调用方回退为普通代码块。
     ------------------------------------------------------------ */
  var MM = {
    font: 13,        // 字号，与 style.css 的 .mm-text 保持一致
    lineH: 18,       // 多行文本的行高
    padX: 12,        // 节点内水平留白（单侧）
    padY: 7,         // 节点内垂直留白（单侧）
    hGap: 46,        // 层级之间的水平间距
    vGap: 12,        // 同层节点之间的垂直间距
    maxUnits: 18,    // 单行最多容纳的「全角字宽」，超出则换行
    colors: 6        // 一级分支的配色数量，对应 .mm-b0 ~ .mm-b5
  };

  function mmRound(n) { return Math.round(n * 100) / 100; }

  /* 按视觉宽度计数：CJK / 全角记 1，ASCII 记 0.55 */
  function mmUnits(s) {
    var u = 0;
    for (var i = 0; i < s.length; i++) u += (s.charCodeAt(i) > 0x2e80) ? 1 : 0.55;
    return u;
  }

  function mmWrap(label) {
    var s = String(label == null ? '' : label).trim();
    if (!s) return [''];
    if (mmUnits(s) <= MM.maxUnits) return [s];
    var lines = [], cur = '', u = 0;
    for (var i = 0; i < s.length; i++) {
      var w = (s.charCodeAt(i) > 0x2e80) ? 1 : 0.55;
      if (u + w > MM.maxUnits && cur) { lines.push(cur); cur = ''; u = 0; }
      cur += s[i]; u += w;
    }
    if (cur) lines.push(cur);
    if (lines.length > 3) lines = lines.slice(0, 2).concat([lines.slice(2).join('')]);
    return lines;
  }

  function mmParse(text) {
    var stack = [], root = null;
    String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n').forEach(function (raw) {
      if (!raw.trim()) return;
      var indent = raw.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
      var label = raw.trim().replace(/^[-*+]+\s+/, '').trim();
      if (!label) return;
      var node = { label: label, children: [], lines: mmWrap(label), branch: 0, side: 1 };
      if (!root) { root = node; stack = [{ indent: indent, node: node }]; return; }
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
      node.parent = stack[stack.length - 1].node;
      node.parent.children.push(node);
      stack.push({ indent: indent, node: node });
    });
    return root;
  }

  /* 后序计算子树占位高度：叶子 = 自身高度，否则 = max(自身高度, 子树总跨度) */
  function mmMeasure(node) {
    var w = 0;
    node.lines.forEach(function (l) { w = Math.max(w, mmUnits(l) * MM.font); });
    node.boxW = w + MM.padX * 2;
    node.boxH = node.lines.length * MM.lineH + MM.padY * 2;

    if (!node.children.length) { node.h = node.boxH; return node.h; }
    var span = 0;
    node.children.forEach(function (c, i) { span += mmMeasure(c) + (i ? MM.vGap : 0); });
    node.h = Math.max(node.boxH, span);
    return node.h;
  }

  /* 把子树放进 [top, top+node.h] 的纵向区间；父节点 y 取首尾子节点的中点 */
  function mmPlace(node, cx, top, side) {
    node.cx = cx;
    if (!node.children.length) { node.cy = top + node.h / 2; return; }
    var cursor = top;
    node.children.forEach(function (c) {
      mmPlace(c, cx + side * (node.boxW / 2 + MM.hGap + c.boxW / 2), cursor, side);
      cursor += c.h + MM.vGap;
    });
    node.cy = (node.children[0].cy + node.children[node.children.length - 1].cy) / 2;
  }

  function mmEach(node, fn) {
    fn(node);
    node.children.forEach(function (c) { mmEach(c, fn); });
  }

  function renderMindmap(text) {
    var root = mmParse(text);
    if (!root) return null;

    mmMeasure(root);
    root.branch = -1;                       // 根节点单独配色
    var kids = root.children;
    var rightN = Math.ceil(kids.length / 2);  // 一半在右、一半在左
    kids.forEach(function (c, i) {
      c.side = i < rightN ? 1 : -1;
      c.branch = i % MM.colors;
      (function stamp(n) {                  // 后代继承所属分支的颜色与展开方向
        n.children.forEach(function (k) { k.branch = c.branch; k.side = c.side; stamp(k); });
      })(c);
    });

    root.cx = 0;
    root.cy = 0;
    [1, -1].forEach(function (side) {
      var group = kids.filter(function (k) { return k.side === side; });
      if (!group.length) return;
      var total = 0;
      group.forEach(function (k, i) { total += k.h + (i ? MM.vGap : 0); });
      var cursor = root.cy - total / 2;
      group.forEach(function (k) {
        mmPlace(k, root.cx + side * (root.boxW / 2 + MM.hGap + k.boxW / 2), cursor, side);
        cursor += k.h + MM.vGap;
      });
    });

    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    mmEach(root, function (n) {
      minX = Math.min(minX, n.cx - n.boxW / 2);
      maxX = Math.max(maxX, n.cx + n.boxW / 2);
      minY = Math.min(minY, n.cy - n.boxH / 2);
      maxY = Math.max(maxY, n.cy + n.boxH / 2);
    });

    var edges = [], nodes = [];
    mmEach(root, function (n) {
      var cls = n.branch < 0 ? 'mm-root' : ('mm-b' + n.branch);

      if (n.parent) {
        var sx = n.cx - n.side * (n.boxW / 2);            // 子节点靠近父节点的一侧
        var ex = n.parent.cx + n.side * (n.parent.boxW / 2);
        var mx = (sx + ex) / 2;
        edges.push('<path class="mm-edge ' + cls + '" d="M' + mmRound(sx) + ',' + mmRound(n.cy) +
          ' C' + mmRound(mx) + ',' + mmRound(n.cy) +
          ' ' + mmRound(mx) + ',' + mmRound(n.parent.cy) +
          ' ' + mmRound(ex) + ',' + mmRound(n.parent.cy) + '"/>');
      }

      nodes.push(
        '<g class="mm-node ' + cls + '">' +
          '<rect x="' + mmRound(n.cx - n.boxW / 2) + '" y="' + mmRound(n.cy - n.boxH / 2) +
            '" width="' + mmRound(n.boxW) + '" height="' + mmRound(n.boxH) + '" rx="7" ry="7"/>' +
          '<text class="mm-text" x="' + mmRound(n.cx) + '" y="' +
            mmRound(n.cy - (n.lines.length - 1) * MM.lineH / 2) +
            '" text-anchor="middle" dominant-baseline="middle">' +
            n.lines.map(function (l, i) {
              return '<tspan x="' + mmRound(n.cx) + '"' + (i ? ' dy="' + MM.lineH + '"' : '') +
                '>' + esc(l) + '</tspan>';
            }).join('') +
          '</text>' +
        '</g>'
      );
    });

    var pad = 8;
    var box = document.createElement('div');
    box.className = 'mindmap';
    box.innerHTML =
      '<svg class="mm-svg" viewBox="' + mmRound(minX - pad) + ' ' + mmRound(minY - pad) + ' ' +
      mmRound(maxX - minX + pad * 2) + ' ' + mmRound(maxY - minY + pad * 2) +
      '" role="img" aria-label="' + esc(root.label) + ' 的思维导图">' +
      '<g class="mm-edges">' + edges.join('') + '</g>' +
      '<g class="mm-nodes">' + nodes.join('') + '</g>' +
      '</svg>';
    return box;
  }

  /* ------------------------------------------------------------
     后处理：把 marked 的原始输出增强为站点最终形态
     返回标题列表（供生成目录使用）
     ------------------------------------------------------------ */
  function enhance(root, opts) {
    var o = opts || {};
    var used = {};
    var headings = [];

    if (o.headingIds !== false) {
      qsa('h1, h2, h3, h4', root).forEach(function (h) {
        if (!h.textContent.trim()) return;
        var base = slugifyHeading(h.textContent, used);
        // 单文件导出会把多篇笔记放进同一文档，需加前缀避免 id 冲突
        var id = o.idPrefix ? o.idPrefix + base : base;
        h.id = id;
        headings.push({ id: id, text: h.textContent.trim(), level: parseInt(h.tagName.slice(1), 10) });
      });
    }

    /* 代码块：包裹容器 + 语言标签 + 复制按钮 + 语法高亮
       与站点文章页的呈现完全一致 */
    qsa('pre', root).forEach(function (pre) {
      if (pre.parentNode && pre.parentNode.classList.contains('code-block')) return;

      var code = pre.querySelector('code');
      var lang = '';
      if (code) {
        var m = (code.className || '').match(/language-([\w+#.-]+)/i);
        if (m) lang = m[1].toLowerCase();
      }

      /* 思维导图：整体替换为内联 SVG，不套代码块容器、不加复制按钮。
         内容为空时 renderMindmap 返回 null，自动回退成普通代码块。 */
      if (lang === 'mindmap' && o.mindmap !== false) {
        var diagram = renderMindmap(code ? code.textContent : pre.textContent);
        if (diagram) { pre.parentNode.replaceChild(diagram, pre); return; }
      }

      var wrap = document.createElement('div');
      wrap.className = 'code-block';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);

      if (lang && global.hljs && hljs.getLanguage(lang)) {
        try { hljs.highlightElement(code); } catch (e) { /* 忽略单个块的高亮失败 */ }
      }

      if (lang) {
        var tag = document.createElement('span');
        tag.className = 'code-lang';
        tag.textContent = lang;
        wrap.appendChild(tag);
      }

      if (o.copyBtn !== false) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'copy-btn';
        btn.textContent = '复制';
        btn.setAttribute('aria-label', '复制代码');
        btn.addEventListener('click', function () {
          var text = code ? code.innerText : pre.innerText;
          copyText(text, function () {
            btn.textContent = '已复制';
            btn.classList.add('done');
            setTimeout(function () {
              btn.textContent = '复制';
              btn.classList.remove('done');
            }, 1600);
          });
        });
        wrap.appendChild(btn);
      }
    });

    /* 表格：包裹滚动容器，避免宽表撑破正文 */
    qsa('table', root).forEach(function (t) {
      if (t.parentNode && t.parentNode.classList.contains('table-wrap')) return;
      var w = document.createElement('div');
      w.className = 'table-wrap';
      t.parentNode.insertBefore(w, t);
      w.appendChild(t);
    });

    /* 外链新窗口打开 */
    if (o.openExternalLinks !== false) {
      qsa('a[href]', root).forEach(function (a) {
        var href = a.getAttribute('href') || '';
        if (/^https?:\/\//i.test(href)) {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        }
      });
    }

    return headings;
  }

  /* 是否具备可用的 Markdown 解析器 */
  function available() {
    return !!(global.marked && typeof global.marked.parse === 'function');
  }

  /* ------------------------------------------------------------
     主入口：把 Markdown 渲染进指定容器
     ------------------------------------------------------------ */
  function render(markdown, root, opts) {
    if (!root) return [];

    if (!available()) {
      root.innerHTML = '<pre class="render-fallback">' + esc(markdown) + '</pre>';
      return [];
    }

    var raw = global.marked.parse(expandWikiLinks(normalizeHeadings(markdown), opts));
    root.innerHTML = sanitize(raw);
    return enhance(root, opts);
  }

  global.SecRender = {
    render: render,
    enhance: enhance,
    sanitize: sanitize,
    available: available,
    copyText: copyText,
    highlight: highlight,
    slugifyHeading: slugifyHeading,
    normalizeHeadings: normalizeHeadings,
    esc: esc,
    renderMindmap: renderMindmap,
    /* 双向链接 */
    setNoteIndex: setNoteIndex,
    hasNoteIndex: hasNoteIndex,
    resolveLink: resolveLink,
    findWikiLinks: findWikiLinks,
    expandWikiLinks: expandWikiLinks
  };
})(window);
