# Me.Soul

> **Public beta / 测试版** — not a 1.0 release. APIs and vault layout may change.

**Vault-native agent shell** for [Obsidian](https://obsidian.md): chat UI, soul loops (thoughts / insights / care), digest + confirm gates, optional embedding memory, Grok Build (ACP) or OpenClaw gateway.

```
Vault (Markdown body)  ←→  Me.Soul plugin (face)  ←→  Grok / OpenClaw (nerve)
```

## Features (beta)

| Loop | What it does |
|------|----------------|
| **Chat** | Homepage / sidebar; `@` notes, `/` skills, drag files into `agent-inbox/raw/` |
| **Digest** | `/me-digest` → wiki under `agent-inbox/wiki/` → confirm card |
| **Insight (心迹)** | `/me-write-insight` → draft + confirm → profile |
| **Care (牵挂)** | `/me-care-check` + `cares.md` guardrails |
| **Thoughts (思绪)** | Short `:::thought` blocks in the UI |
| **Memory** | Keyword `wiki/index.md` + optional hybrid embeddings (`bge-m3` etc.) |
| **Setup wizard** | First run: name your agent, seed **generic** soul templates |

**No author’s personal persona, API keys, or private vault notes are shipped.**  
You configure identity and keys after install.

## Credits / 创意致谢

Soul-loop product ideas (observable thoughts, user insights, proactive care) are **inspired by Cola** (KOLLA / ColaOS). See [NOTICE.md](./NOTICE.md).  
Me.Soul is an independent open-source project and is **not** affiliated with Cola.

## Requirements

- Obsidian **1.5+**
- Desktop: [Grok Build](https://grok.com) CLI (`~/.grok/bin/grok`) **or** OpenClaw HTTP gateway
- Optional: any OpenAI-compatible **embeddings** API for semantic wiki memory

## Install (from source)

```bash
git clone https://github.com/<you>/me-soul.git
cd me-soul
npm install
npm test
npm run build:plugin
```

Copy `plugin/dist/*` into your vault:

```text
<vault>/.obsidian/plugins/me-soul/
  main.js
  manifest.json
  styles.css
```

Or auto-install into a vault:

```bash
OBSIDIAN_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/me-soul" npm run build:plugin
```

Then enable **Me.Soul** in Obsidian → Community plugins (or installed plugins).

## First run

1. Command palette → **Me.Soul: Run setup wizard**
2. Set agent display name + optional vibe
3. Seed templates → creates `agent-inbox/soul/*`, home note, wiki folders
4. Edit `agent-inbox/soul/SOUL.md` / `profile.md` to taste
5. Settings → engine (Grok / OpenClaw), optional Embed API key
6. Open home note with ````me-soul` block (created by setup)

### Memory migration (manual, beta)

There is no one-click import from other products yet. Typical path:

1. Put existing notes under human zones or `agent-inbox/`
2. `/me-digest @path` for knowledge wiki
3. `/me-write-insight …` for stable preferences
4. `/me-reindex` after digests (keywords + embeddings if configured)

## Layout

| Path | Role |
|------|------|
| `plugin/` | Obsidian plugin source → `plugin/dist/` |
| `packages/protocol` | Fence parser, confirm SM, write policy, care policy |
| `skills/*` | CLI skills (digest, insight, care, reindex helpers) |
| `templates/vault/` | Generic vault seed files (also embedded in setup) |
| `NOTICE.md` | Cola credit + beta disclaimer |

Default write policy: free write under `agent-inbox/`; human zones  
`手记` / `项目库` / `资料库` / `基础学科` need confirmed pending  
(see `packages/protocol/src/paths.js` — fork to match your vault).

## Development

```bash
npm test
npm run build:plugin
```

## Versioning & roadmap

- **0.1.x** — public beta; expect rough edges
- Later: installable release, polished onboarding, formal 1.0 if the project sticks

Contributions welcome once issues/PRs are opened on the GitHub repo.

## License

[MIT](./LICENSE) — see [NOTICE.md](./NOTICE.md) for credits.
