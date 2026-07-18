---
name: me-digest
description: Grok 编译笔记为待审 wiki；Accept 定稿，Reject 删除 wiki。
---

# me-digest

## 语义（确认门）

1. 用 **Grok Build（ACP）** 根据源笔记生成完整 wiki（`wiki_status: pending_review`）
2. 写入 `agent-inbox/wiki/sources/…` + `agent-inbox/pending/…`
3. **Accept** → `wiki_status: accepted`（定稿）
4. **Reject** → **删除** wiki 文件，pending → rejected

禁止机械截断摘要。

## UI

在 Me.Soul 对话台：`/me-digest` + `@笔记` 发送。

引擎必须为 **Grok Build**（设置 → Me.Soul → 引擎）。
