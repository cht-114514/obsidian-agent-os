---
name: me-write-insight
description: Draft a 心迹 (insight) for profile learning; confirm before merge.
---

# me-write-insight

## When to use

User corrects a preference, 👍/👎 patterns, or explicit "记住…".

## How to run

```bash
node "$ME_SOUL_ROOT/skills/me-write-insight/run.mjs" \
  --title "偏好更新" \
  --body "..." \
  --vault "/path/to/your/vault"
```

## Output

- `agent-inbox/soul/insights/drafts/*`
- `agent-inbox/pending/*-insight-*`
- Fences: thought + confirm
