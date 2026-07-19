---
name: me-digest
description: Grok Build 编译笔记为待审 wiki；确认卡 Accept/Reject。
---

# me-digest

Run as **Grok Build** (vault cwd). The Obsidian plugin only streams your reply and renders confirm cards.

## Goal

Compile source note(s) → `pending_review` wiki under `agent-inbox/`.

## Resolve sources

1. Explicit `@path` / ref chips in the prompt context  
2. Else **current open note** if provided  
3. Else batch intents:
   - 「所有/全部日记」→ recursively all `.md` under `手记/日记` and `手记/手写日记`  
   - Prefer **≤8 files per turn**; list remaining and tell user to re-run  

Skip `README.md` / `00-入口.md` when batching.

## For each source

1. Read full note with tools  
2. Write `agent-inbox/wiki/sources/YYYY-MM-DD-<slug>.md`:
   - YAML: `type: wiki-source`, `wiki_status: pending_review`, `source_paths: [...]`, `managed_by: me-digest`, `created`
   - Body: structured wiki (结论 / 要点 / 证据 / 对我意味着什么 / 开放问题). **No mechanical truncation.**  
3. Write `agent-inbox/pending/YYYY-MM-DD-digest-<slug>.md` pending record  
4. Emit:

```
:::confirm type=digest path=agent-inbox/pending/...
title: 确认 digest: <filename>
body: 待审 wiki：... 预览：...
actions: [accept, reject]
:::
```

## Rules

- Only write under `agent-inbox/`  
- If collision on filename, add a short suffix  
- End with a short summary table of sources → wiki/pending paths  
