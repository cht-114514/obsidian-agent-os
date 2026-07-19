---
name: me-write-insight
description: Grok Build 起草心迹草案 + 确认卡（非讨论笔记）。
---

# me-write-insight

## Goal

Draft a **心迹** (stable user-model update), not a chat about a note.

## Refuse when

User is clearly discussing a note (`@` / 讨论 / 分析笔记) — tell them to drop the skill pill and chat normally.

## Steps

1. Parse user intent → `title` + `body` (optional `title|body`)  
2. Write `agent-inbox/soul/insights/drafts/YYYY-MM-DD-<slug>.md`  
3. Write `agent-inbox/pending/YYYY-MM-DD-insight-<slug>.md` with `type: insight`, target `agent-inbox/soul/profile.md`  
4. Output `:::thought` + `:::confirm type=insight path=...`  

Plugin Accept → user can `/me-apply-insight` or plugin apply path merges into profile.
