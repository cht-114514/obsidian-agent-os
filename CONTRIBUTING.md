# Contributing

Obsidian Agent OS is a **beta**. Small, focused PRs are easiest to review.

## Dev

```bash
npm install
npm test
npm run build:plugin
```

## Rules of thumb

- Do **not** commit API keys, personal `SOUL.md` content, or vault notes.
- Keep write policy defaults conservative (`agent-inbox` free, human zones gated).
- Prefer tests for protocol / memory helpers.
- UI strings: Chinese + English is fine; avoid hardcoding a personal agent name (use settings).

## Issues

When filing bugs, include Obsidian version, engine (Grok / OpenClaw), and whether embeddings are enabled — never paste live API keys.
