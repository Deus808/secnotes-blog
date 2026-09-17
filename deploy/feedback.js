/* ==========================================================================
   SecNotes 展示端反馈模块
   --------------------------------------------------------------------------
   站内一个极简反馈入口（文字 + 图片，无富文本）：
   提交时把内容组装成一条 GitHub Issue 的预填草稿，在新标签页打开
   GitHub 的 issues/new 页面，访客用自己的账号点一下「Submit」即落地。
   纯前端、无后端、不泄露任何 token。

   约束：
     · GitHub 创建 issue 必须登录 —— 弹层里已醒目提示。
     · issue body 有大小限制，图片会被压缩到较小的 base64 内嵌，避免提交失败。
   ========================================================================== */
(function () {
  var REPO = "你的用户名/你的仓库"; // TODO: 改成你的反馈落点仓库（GitHub Issue），与 feedback-inbox.py 保持一致
  var MAX_IMGS = 3;                  // 最多图片张数
  var MAX_IMAGE_DATA = 24000;        // 单张图 base64 上限（字符）
  var MAX_BODY = 29000;              // 组装后 body 上限（字符），GitHub 约 64KB，保守留余量

  // ------------------------------------------------------------------
  // DOM 构建
  // ------------------------------------------------------------------
  function el(tag, html, cls) {
    var n = document.createElement(tag);
    if (html != null) n.innerHTML = html;
    if (cls) n.className = cls;
    return n;
  }
  // 共享的图片选择输入（避免每次重绘时向 body 追加多个 input）
  var fileEl = el("input");
  fileEl.type = "file";
  fileEl.accept = "image/*";
  fileEl.style.display = "none";
  document.body.appendChild(fileEl);
  fileEl.addEventListener("change", function () {
    if (fileEl.files && fileEl.files[0]) addImage(fileEl.files[0]);
    fileEl.value = "";
  });

  // 弹层
  var overlay = el("div", "", "fb-overlay");
  overlay.innerHTML =
    '<div class="fb-modal">' +
      '<h3>反馈问题</h3>' +
      '<p class="fb-sub">欢迎指出错误、遗漏或改进建议。请先选择一种反馈方式。</p>' +
      '<div class="fb-tabs" id="fbTabs" role="tablist">' +
        '<button type="button" class="fb-tab active" id="fbTabEmail" data-tab="email">方式一 · 邮箱</button>' +
        '<button type="button" class="fb-tab" id="fbTabGithub" data-tab="github">方式二 · GitHub</button>' +
      '</div>' +
      '<div class="fb-recip" id="fbRecip">' +
        '<span class="fb-recip-label">接收邮箱：</span>' +
        '<label class="fb-recip-item"><input type="radio" name="fbRecip" value="cn" checked>中国境内 · you@example.com</label>' +
        '<label class="fb-recip-item"><input type="radio" name="fbRecip" value="intl">国际 · you-intl@example.com</label>' +
      '</div>' +
      '<textarea id="fbText" placeholder="请描述你要反馈的问题…（支持纯文本，无需排版）"></textarea>' +
      '<div class="fb-imgs" id="fbImgs"></div>' +
      '<div class="fb-tip" id="fbTip"></div>' +
      '<div class="fb-actions">' +
        '<span class="fb-note" id="fbNote"></span>' +
        '<button class="fb-btn secondary" id="fbCancel">取消</button>' +
        '<button class="fb-btn primary" id="fbSubmit">打开邮箱</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  function $(id) { return document.getElementById(id); }
  var textEl = $("fbText"), imgsEl = $("fbImgs"),
      tipEl = $("fbTip"), submitBtn = $("fbSubmit"),
      noteEl = $("fbNote"), recipEl = $("fbRecip"),
      tabEmail = $("fbTabEmail"), tabGithub = $("fbTabGithub");
  var items = [];          // { dataUrl }
  var currentTab = "email";

  // 方式切换：邮箱 与 GitHub 共用同一块界面
  function switchTab(tab) {
    currentTab = tab;
    tabEmail.classList.toggle("active", tab === "email");
    tabGithub.classList.toggle("active", tab === "github");
    recipEl.hidden = tab !== "email";
    imgsEl.hidden = tab !== "github";              // 邮箱方式不支持图片附件
    if (tab === "email") {
      submitBtn.textContent = "打开邮箱";
      noteEl.textContent = "将调用你的邮件客户端写信，收件人已自动填入所选邮箱；邮箱方式暂不支持图片附件。";
    } else {
      submitBtn.textContent = "提交";
      noteEl.textContent = "提交后会打开 GitHub 新标签页，登录后点击「Submit new issue」即完成。";
    }
  }
  tabEmail.addEventListener("click", function () { switchTab("email"); });
  tabGithub.addEventListener("click", function () { switchTab("github"); });
  switchTab("email");

  function iconBtnHTML(c) {
    if (c === "img") {
      return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
    }
    return "";
  }

  // “添加图片”小按钮容器的容器，生成到 imgsEl
  function renderImgs() {
    imgsEl.innerHTML = "";
    items.forEach(function (it, i) {
      var w = el("div", "", "fb-thumb");
      w.appendChild(el("img", null));
      w.children[0].src = it.dataUrl;
      var d = el("button", "×", "fb-del");
      d.setAttribute("aria-label", "删除图片");
      d.addEventListener("click", function () { items.splice(i, 1); renderImgs(); });
      w.appendChild(d);
      imgsEl.appendChild(w);
    });
    if (items.length < MAX_IMGS) {
      var up = el("button", "", "fb-upload");
      up.innerHTML = iconBtnHTML("img") + "添加图片";
      up.addEventListener("click", function () { fileEl.click(); });
      imgsEl.appendChild(up);
    }
  }

  // 图片压缩到接近固定大小的 base64 内嵌
  function compress(file, targetPx) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, targetPx / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var c = document.createElement("canvas");
        c.width = w; c.height = h;
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        // 质量从 0.6 起步，逐步下调直到达标
        var attempt = function (q) {
          var data = c.toDataURL("image/jpeg", q);
          if (data.length <= MAX_IMAGE_DATA || q < 0.28) return resolve(data);
          return attempt(q - 0.1);
        };
        attempt(0.6);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function addImage(file) {
    var cap = MAX_IMAGE_DATA;
    // 先试 900px；若单图不值，自动降目标像素重压
    var tryTarget = function (px) {
      compress(file, px).then(function (data) {
        if (!data) return void showTip("该图片无法解析，请换一张", true);
        items.push({ dataUrl: data });
        renderImgs();
      });
    };
    tryTarget(900);
  }

  function showTip(msg, isErr) {
    tipEl.textContent = msg;
    tipEl.className = "fb-tip show" + (isErr ? " error" : "");
  }
  function hideTip() { tipEl.className = "fb-tip"; }

  // ------------------------------------------------------------------
  // 组装并跳转 GitHub
  // ------------------------------------------------------------------
  function buildText() {
    return (textEl.value || "").trim();
  }
  function buildTitle(text) {
    var head = text.replace(/\s+/g, " ").trim();
    head = head.slice(0, 40);
    return "[反馈] " + (head || "站点反馈");
  }
  function buildBody(text) {
    var lines = ["## 反馈内容", "", text || "（未填写正文）", "",
      "---", "",
      "- **时间**：" + new Date().toLocaleString("zh-CN"),
      "- **来源页**：[" + document.title + "](" + location.href + ")"];
    lines.push("", "## 图片", "");
    var used = 0;
    for (var i = 0; i < items.length; i++) {
      var md = "![图片" + (i + 1) + "](data:image/jpeg;base64," + items[i].dataUrl.replace(/^data:image\/jpeg;base64,/, "") + ")";
      if (buildLen(lines) + md.length > MAX_BODY) break;
      lines.push(md, "");
      used++;
    }
    lines = lines.concat([
      "> 本反馈由站点访客填写，已自动生成为 GitHub Issue。",
      "> 若图片以文本形式显示，可在下方编辑框中拖入原图后提交。"
    ]);
    return lines.join("\n");
  }
  function buildLen(lines) { return lines.join("\n").length; }

  function commit() {
    hideTip();
    var text = buildText();
    if (!text && items.length === 0) {
      return void showTip("请至少填写一段文字" + (currentTab === "email" ? "" : "或添加一张图片"), true);
    }
    if (currentTab === "email") return commitByEmail(text);

    var title = buildTitle(text);
    var body = buildBody(text);
    var url = "https://github.com/" + REPO + "/issues/new?"
      + "title=" + encodeURIComponent(title)
      + "&body=" + encodeURIComponent(body);
    window.open(url, "_blank", "noopener");
    showTip("已在新标签页打开 GitHub。若未弹出，请点击悬浮按钮重试。确认内容无误后，点击「Submit new issue」即完成提交。");
    closePanel();
  }

  // 方式一：通过本机邮件客户端发信到所选邮箱
  function commitByEmail(text) {
    var recip = document.querySelector('input[name="fbRecip"]:checked');
    var to = recip && recip.value === "intl" ? "you-intl@example.com" : "you@example.com";
    var subject = buildTitle(text);
    var body = [
      text,
      "",
      "---",
      "",
      "- **时间**：" + new Date().toLocaleString("zh-CN"),
      "- **来源页**：[" + document.title + "](" + location.href + ")",
      "",
      "> 本邮件由站点访客填写，通过本机邮件客户端发送。"
    ].join("\n");
    location.href = "mailto:" + to
      + "?subject=" + encodeURIComponent(subject)
      + "&body=" + encodeURIComponent(body);
    showTip("已为你打开邮件客户端，收件人：" + to + "。补全后点击「发送」即完成反馈。");
    closePanel();
  }

  // ------------------------------------------------------------------
  // 开关
  // ------------------------------------------------------------------
  function openPanel() {
    hideTip();
    renderImgs();
    overlay.classList.add("open");
    setTimeout(function () { textEl.focus(); }, 60);
  }
  function closePanel() {
    overlay.classList.remove("open");
  }

  $("fbCancel").addEventListener("click", closePanel);
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closePanel();
  });
  submitBtn.addEventListener("click", commit);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && overlay.classList.contains("open")) closePanel();
  });

  // 供导航栏「反馈」入口复用同一弹层（由 deploy.py 把“关于”替换为 #navFeedback）
  window.SecFeedbackOpen = openPanel;
  function bindTrigger(el) {
    if (el) el.addEventListener("click", function (e) { e.preventDefault(); openPanel(); });
  }
  bindTrigger(document.getElementById("navFeedback"));     // 桌面顶栏
  bindTrigger(document.getElementById("mobileFeedback"));  // 移动端侧栏抽屉顶部
})();