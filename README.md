# Obsidian Agent OS

> **Public beta / 测试版** — not a 1.0 release. APIs and vault layout may change.

**Vault-native agent operating system** for [Obsidian](https://obsidian.md): an OpenClaw-style chat UI, soul loops (thoughts / insights / care), digest + confirm gates, and **vector wiki memory**. The kernel is a remote [OpenClaw](https://openclaw.ai) gateway. The plugin does not bundle or spawn the OpenClaw CLI.

Two entry points, same kernel:

```
Vault (Markdown body)  ←→  Obsidian Agent OS (face)  ←→  OpenClaw gateway (kernel)
                                    ▲
                        Mac service (durable turns, notes)   ← phone over fixed HTTPS
```

- **Desktop / legacy** — the plugin talks to the gateway socket directly (Tailscale address).
- **Phone (recommended)** — the plugin talks to a small Mac service over a fixed HTTPS
  domain. Messages are saved on the phone first, then accepted by the Mac's SQLite queue,
  so a locked screen, a lost socket, or a killed WebView never loses a turn. See
  [docs/mobile-stability.md](./docs/mobile-stability.md).

Formerly prototyped as “Me.Soul”. Public project name is **Obsidian Agent OS**.

## Features (beta)

| Loop | What it does |
|------|----------------|
| **Command bar (primary)** | `Mod+Shift+Space` floating bar; model NL → insert / replace / show |
| **Full-screen chat** | Ribbon / command → main-tab Claude/ChatGPT-style chat; `@` `/` skills · raw drop |
| **Feedback** | 👍/👎 toggle/cancel → day log only; **写反馈** → reflect skill + confirm → profile/style |
| **Digest** | `/me-digest` → wiki under `agent-inbox/wiki/` → confirm card |
| **Insight (心迹)** | `/me-write-insight` → draft + confirm → profile |
| **Care (牵挂)** | `/me-care-check` + `cares.md` guardrails |
| **Thoughts (思绪)** | Short `:::thought` blocks in the UI |
| **Memory** | **Vector-only** wiki memory (`vectors.jsonl` + embed API; keyword index removed) |
| **Setup wizard** | First run: name your agent, seed **generic** soul templates |
| **Active note context** | Auto-attach the open Markdown note (follow / pin / off); digest can use it |
| **Voice input** | Hold 🎤 → xAI STT (stream / REST) fills the composer |

Wiki **相关记忆** is pure embedding retrieval. Configure Embed API Key, then `/memorized`.

**No author’s personal persona, API keys, or private vault notes are shipped.**  
You configure identity and keys after install.

## Credits / 创意致谢

Soul-loop product ideas (observable thoughts, user insights, proactive care) are **inspired by Cola** (KOLLA / ColaOS). See [NOTICE.md](./NOTICE.md).  
Obsidian Agent OS is an independent open-source project and is **not** affiliated with Cola.

## Requirements

- Obsidian **1.5+**
- Desktop or mobile Obsidian, plus an OpenClaw gateway (`ws://127.0.0.1:18789` on the gateway machine; other devices use the tailnet address)
- **Required for wiki memory:** OpenAI-compatible **embeddings** API (e.g. DMX + `bge-m3`)

## Install (from source)

```bash
git clone https://github.com/cht-114514/obsidian-agent-os.git
cd obsidian-agent-os
npm install
npm test
npm run build:plugin
```

Copy `plugin/dist/*` into your vault:

```text
<vault>/.obsidian/plugins/obsidian-agent-os/
  main.js
  manifest.json
  styles.css
```

Or auto-install:

```bash
OBSIDIAN_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/obsidian-agent-os" npm run build:plugin
```

Enable **Obsidian Agent OS** under Obsidian → Settings → Community plugins.

> **Note:** Homepage embed still uses the code fence ` ```me-soul ` for compatibility. CSS classes keep a `me-soul-*` prefix internally.

## First run

1. Command palette → **Obsidian Agent OS: Run setup wizard**
2. Set agent display name + optional vibe
3. Seed templates → creates `agent-inbox/soul/*`, home note, wiki folders
4. Edit `agent-inbox/soul/SOUL.md` / `profile.md` to taste
5. Settings → OpenClaw gateway URL, optional Embed API key
6. In any note: **Open Agent command bar** (`Mod+Shift+Space`) for rewrite / continue / ask
7. Optional: open the home note with a ` ```me-soul ` block or ribbon for full chat

### Memory migration (manual, beta)

1. Put existing notes under human zones or `agent-inbox/`
2. `/me-digest @path` for knowledge wiki
3. `/me-write-insight …` for stable preferences
4. `/memorized` after digests (writes vector memory)

## Layout

| Path | Role |
|------|------|
| `plugin/` | Obsidian plugin source → `plugin/dist/` |
| `service/` | Mac-side durable turn service (SQLite queue, device pairing, notes) |
| `packages/protocol` | Fence parser, confirm SM, write policy, care policy |
| `skills/*` | CLI skills (`me-digest`, insight, care, …) |
| `templates/vault/` | Generic vault seed files |
| `docs/mobile-stability.md` | Phone entry point: design, ops, failure behaviour |
| `NOTICE.md` | Cola credit + beta disclaimer |

Default write policy: free write under `agent-inbox/`; human zones  
`手记` / `项目库` / `资料库` / `基础学科` need confirmed pending  
(see `packages/protocol/src/paths.js` — fork to match your vault).

## Development

```bash
npm test
npm run build:plugin

# Mac service
npm run service:serve          # foreground
npm run service:pair           # one-time pairing code
npm run service:status         # kernel, queue, sessions, vault
```

See [docs/mobile-stability.md](./docs/mobile-stability.md) for the phone entry point,
failure behaviour, and how to fall back to the legacy socket.

## Versioning

- **0.3.x-beta** — durable Mac service: fixed HTTPS entry, device pairing, SQLite turn
  queue, restart reconciliation, notes + confirmation cards
- **0.2.0-beta** — OpenClaw gateway kernel, phone chat UI
- **0.1.x** — public beta on the local Grok / ACP runtime
- Later: polish, Community Plugin store packaging if/when ready

## License

[MIT](./LICENSE) — see [NOTICE.md](./NOTICE.md) for credits.
