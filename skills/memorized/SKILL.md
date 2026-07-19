---
name: memorized
description: 准备向量记忆库；确认后由插件执行 embedding。
---

# memorized

## Goal

Refresh **vector memory** for accepted wiki pages.

## You (Grok Build) do

1. List `agent-inbox/wiki/sources/*.md` excluding `wiki_status: pending_review`  
2. Count pages and summarize titles  
3. **Do not** invent vectors. Embedding HTTP is plugin-side.  
4. Emit:

```
:::thought
准备将 N 篇 accepted wiki 写入向量记忆库。
:::

:::confirm type=memorized path=agent-inbox/wiki/vectors.jsonl
title: 写入向量记忆库
body: 将 N 篇 wiki 切块 embedding → vectors.jsonl；删除遗留 index.md
actions: [accept, reject]
:::
```

## Plugin on Accept

Runs local embedder (settings → 向量记忆) into `vectors.jsonl`.

Alias: `/me-reindex`
