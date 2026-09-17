# SecNotes —— 基于 Markdown 的个人知识笔记库

一个开箱即用的静态笔记站点：把 `notes/` 下的 Markdown 笔记构建成前端数据，
双击 `index.html` 即可离线浏览，构建一次即可发布到 GitHub Pages。
无数据库、无后端、零运行时依赖，适合用来沉淀个人知识库 / 学习笔记 / 技术博客。

## 特性

- **front-matter 元数据**：`---` 之间声明标题、日期、分类、标签，自动归档与聚合
- **分类 / 标签 / 归档**：侧边栏聚合、归档页时间倒序浏览
- **全文搜索**：按 `/` 聚焦搜索框，实时过滤全部笔记
- **双向链接**：`[[笔记标题]]` 自动生成出链 / 入链，未创建的标题进入「待创建」
- **思维导图**：```mindmap 围栏代码块渲染为内联 SVG，自动跟随明暗主题
- **明暗主题**：一键切换，偏好本地记忆
- **字数与阅读时长统计**：构建时自动计算
- **管理端**：网页编辑器（`admin.py` + `manage.html`），写作、维护通知开箱即用
- **公网分享**：`bin/demo.bat` 一条命令把站点通过 SSH 反向隧道分享给朋友
- **发布工具**：`deploy/` 一键整理发布目录、注入反馈 / 维护通知等展示端功能

## 依赖

- **Python 3.8+**：构建 / 管理 / 发布脚本全部只用标准库，**无任何第三方 pip 依赖**，不需要 `pip install`；
- 前端第三方库（marked、highlight.js 等）已内置在 `assets/vendor/`，**不依赖 CDN**，断网也能完整运行。

> Windows 用户甚至不用关心依赖细节：双击根目录的 `start-here.bat` 即可自动化完成
> 「检测 Python → 构建 → 打开站点」全部流程，没装 Python 时会提示去官网安装。

## 目录结构

```
secnotes/
├── index.html            # 站点入口（双击即可打开）
├── blog.config.json      # 站点标题 / 副标题 / 页脚等配置
├── build.py              # 构建脚本：notes/ -> data/notes.js
├── new-note.py           # 命令行新建笔记
├── export.py             # 导出笔记
├── admin.py              # 管理服务（写作 / 同步 / 维护通知 API）
├── manage.html           # 网页编辑器（需配合 admin.py 使用）
├── start-admin.bat       # Windows 双击启动管理服务并打开编辑器
├── start-here.bat        # Windows 一键上手：检测 Python → 构建 → 打开站点
├── share-server.py       # 只读分享白名单静态服务（bin/demo.bat 内部使用）
├── notes/                # ★ 你的 Markdown 笔记原稿
├── data/                 # 构建产物：notes.js（不要手改）
├── assets/               # 样式 / 前端脚本 / 第三方库 / 上传图片
├── bin/                  # 一键公网分享（demo.bat / demo.ps1 / 说明）
└── deploy/               # 发布工具集（构建 + 整理 + 注入 + git 提交/推送）
```

## 快速开始

**零门槛一条命令（Windows）**：双击根目录的 `start-here.bat`，自动检测 Python → 构建 → 打开页面。

手动方式：

```bash
# 1. 构建（扫描 notes/ 生成 data/notes.js）
python build.py

# 2. 打开站点
#   · 直接双击 index.html 即可离线浏览；
#   · 命令行预览：python -m http.server 8090 --bind 127.0.0.1
```

仓库自带 3 篇示例笔记，构建后即可看到分类、标签、搜索、思维导图、双向链接等全部效果。
`data/notes.js` 默认**不**在 `.gitignore` 里：示例数据可直接公开，你的真实笔记若要保密，
取消 `.gitignore` 末尾可选段的注释即可。

## 写作

两种方式任选：

1. **直接编辑 `notes/*.md`**：front-matter 格式见下，改完重新 `python build.py`。
2. **网页编辑器（推荐）**：双击 `start-admin.bat`，自动启动管理服务并打开 `manage.html`，
   支持新建 / 编辑 / 删除笔记、上传图片、维护通知等，保存后经 admin.py 写回 `notes/`。

每篇笔记的 front-matter：

```yaml
---
title: 笔记标题
date: 2026-09-16
category: 分类
tags: [标签1, 标签2]
summary: 可选的摘要（留空则自动截取正文）
---
```

## 发布到 GitHub Pages

两种方式任选：**方式 A** 用仓库自带的 GitHub Actions 自动构建发布（推荐），
**方式 B** 用 `deploy/` 工具在本地构建后提交 / 推送。

### 方式 A（推荐）：GitHub Actions 自动发布

仓库已内置工作流 `.github/workflows/pages.yml`（push 到 `main` 自动运行），
自动**构建 notes → 整理站点文件 → 部署到 Pages**：

1. 把仓库推送到 GitHub 后，进入 **Settings → Pages**；
2. **Source** 选择 **GitHub Actions**（只需这一次手动开启，GitHub 不允许通过 API 开启）；
3. 之后每次 `push` 到 `main` 都会自动重新构建并发布；
4. 约 1-2 分钟后访问 `https://<你的用户名>.github.io/<你的仓库>/` 即可看到完整示例站点。

> 该方式发布的是公开演示页面（`index.html` + `data/` + `assets/`），每次基于当前
> `notes/` 重新构建。想发布自己的笔记时，把自己的内容写进 `notes/` 再推上去即可。

### 方式 B：deploy/ 工具本地发布

发布工具位于 `deploy/`，会**构建 → 整理公开文件 → 注入反馈/维护通知等功能 → git 提交（可选推送）**，
源站 `index.html` 零改动。

```bash
python deploy\deploy.py            # 构建 + 整理 + 提交
python deploy\deploy.py --push     # 构建 + 整理 + 提交 + 推送
```

或双击 `deploy\更新到GitHub.bat` 一键完成构建 + 推送。

- **默认发布目录**是项目内的 `pub/`，`deploy.py` 会把提交落回本仓库（`git add -A -- pub`），
  然后在 GitHub 仓库 **Settings → Pages** 选择 *Deploy from a branch*、分支 `main`、目录 `/pub`，
  之后每次推送即自动上线。
- 想用**独立 Pages 仓库**（推荐用于「公开站点 + 私有源码」）时，用环境变量 `SECNOTES_PUB`
  或参数 `--pub <目录>` 指向该仓库路径，`deploy.py` 会如同旧工作流一样在发布仓库内提交/推送。
- **国内静态资源加速（可选）**：默认关闭，发布版保持相对路径、克隆即用。需要加速时把
  `deploy/deploy.py` 顶部的 `CDN_ENABLED` 改为 `True`，并把 `CDN_BASE` 换成你自己的 GitHub
  仓库地址（jsDelivr 会缓存 `@main` 分支，改库后注意版本管理）。

> ⚠️ 推送到公开仓库前，请确认 `notes/`、`data/`、`assets/uploads/` 下没有不愿公开的个人内容；
> 需要保密时按 `.gitignore` 里的注释说明排除。

## 反馈功能（可选）

展示端的「反馈」入口默认注入到发布版页面（提交到 GitHub Issue 或邮件），配套收件箱脚本。

- 把 `deploy/feedback.js` 顶部的 `REPO` 和两个邮箱改成你自己的；
- `deploy/feedback-inbox.py` 里的 `REPO` 同步修改，双击 `deploy\反馈收件箱.bat` 查看 / 关闭反馈。
- 不需要该功能时，直接删除 `deploy.py` 中对 `inject_feedback` 的调用即可。

## 公网一键分享（可选）

```bash
# Windows：双击 bin\demo.bat
# 流程：停止 admin.py → 启动只读静态服务 → SSH 反向隧道(localhost.run) → 复制公网链接到剪贴板
```

适合临时把笔记分享给朋友；`bin\README.md` 有完整的原理与排障说明。

## 常见问题

- **笔记不显示**：改完笔记后忘记重新 `python build.py`。
- **管理端打开后「保存到站点」按钮缺失**：确认 `start-admin.bat` 的服务窗口保持开启，按 F5 刷新。
- **`siteUrl` 为空导致没有 RSS/Sitemap**：发布后把线上地址填进 `blog.config.json` 的 `siteUrl` 再构建。

## 许可

[MIT](./LICENSE)