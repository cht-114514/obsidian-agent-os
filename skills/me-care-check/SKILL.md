---
name: me-care-check
description: 牵挂 scan using cares.md policy; writes pending-care.md only.
---

# me-care-check

## Palace

Read `agent-inbox/soul/cares.md` and `agent-inbox/palace/care_check_room.md`.

## How to run

```bash
node "$ME_SOUL_ROOT/skills/me-care-check/run.mjs" --vault "/path/to/your/vault"
```

Options: `--quiet-today`, `--sent-today N`, `--now ISO`.

## Rules

- daily cap, quiet hours, blacklist from cares.md
- evidence-backed items only
- write `agent-inbox/soul/pending-care.md` only
