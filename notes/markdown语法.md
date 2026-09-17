---
title: Markdown 基础语法
date: 2026-09-15
category: 写作
tags: [Markdown, 语法]
summary: 常用 Markdown 语法速查：标题、列表、表格、代码与引用
---

## 标题与段落

```markdown
# 一级标题
## 二级标题
### 三级标题

普通段落之间用空行分隔。
```

## 列表

```markdown
- 无序列表项
- 另一个列表项

1. 有序列表项
2. 第二个有序项
```

## 表格

| 语法 | 说明 | 示例 |
| --- | --- | --- |
| `**加粗**` | 加粗 | **加粗** |
| `*斜体*` | 斜体 | *斜体* |
| `` `代码` `` | 行内代码 | `代码` |

## 代码块

````markdown
```python
def hello(name: str) -> str:
    return f"Hello, {name}!"

print(hello("SecNotes"))
```
````

效果如下：

```python
def hello(name: str) -> str:
    return f"Hello, {name}!"

print(hello("SecNotes"))
```

## 引用与分割线

> 引用一段话：好记性不如烂笔头。

---

## 图片

图片统一放在 `assets/uploads/` 下，用相对路径引用：

```markdown
![图片说明](assets/uploads/202609/xxx.jpg)
```

更多站点特性（思维导图、双向链接）见 [[笔记功能展示]]。