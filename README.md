# Obsidian Agent OS

> **Public beta / 测试版** — not a 1.0 release. APIs and vault layout may change.

**Vault-native agent operating system** for [Obsidian](https://obsidian.md): a resident companion and a full-screen chat on one session, soul loops (thoughts / insights / care), digest + confirm gates, and **MemCell memory**. The kernel is a remote [OpenClaw](https://openclaw.ai) gateway. The plugin does not bundle or spawn the OpenClaw CLI.

Two entry points, same kernel. Companion and full-screen chat share one queue:

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
| **Companion (primary)** | `Mod+Shift+Space` capsule on the note. The panel uses the same session as full-screen chat. Context is frozen when you send. **插入原位置 / 替换原选区** writes only if that snapshot still matches the note. |
| **Full-screen chat** | Ribbon / command → main-tab Claude/ChatGPT-style chat; `@` `/` skills · raw drop. Opening it hides the capsule. Sidebar: **删除** then **确认** drops that session on the kernel and locally. |
| **Feedback** | 👍/👎 toggle/cancel → day log only; **写反馈** → reflect skill + confirm → profile/style |
| **Digest** | `/me-digest` → wiki under `agent-inbox/wiki/` → confirm card |
| **Insight (心迹)** | `/me-write-insight` → draft + confirm → profile |
| **Care (牵挂)** | `/me-care-check` + `cares.md` guardrails |
| **Thoughts (思绪)** | Short `:::thought` blocks in the UI |
| **Memory** | After each assistant reply, a cheap model cuts a MemCell, files it into a scene, and embeds it. The next turn recalls scenes, recent narrative, facts, unexpired foresight, and wiki vectors. |
| **Setup wizard** | First run: name your agent, seed **generic** soul templates |
| **Active note context** | Follow / pin / off. Switching notes updates the companion chip only — it does not send a request. Digest can still use the open note. |
| **Voice input** | Hold 🎤 → xAI STT (stream / REST) fills the composer. `Mod+Shift+V` is live voice. |

Cells, scenes, and the unclosed-turn buffer live under `agent-inbox/wiki/memories/`. Vectors stay in `vectors.jsonl`. Formation defaults to `qwen3.7-flash` and reuses the Embed API key (`memoryLlmApiKey` can override). `/memorized` still indexes accepted wiki pages. Turn settings off under **Settings → 记忆** or **常驻陪伴窗**.

**No author’s personal persona, API keys, or private vault notes are shipped.**  
You configure identity and keys after install.

## Credits / 创意致谢

Soul-loop product ideas (observable thoughts, user insights, proactive care) are **inspired by Cola** (KOLLA / ColaOS). See [NOTICE.md](./NOTICE.md).  
Obsidian Agent OS is an independent open-source project and is **not** affiliated with Cola.

## Requirements

- Obsidian **1.5+**
- Desktop or mobile Obsidian, plus an OpenClaw gateway (`ws://127.0.0.1:18789` on the gateway machine; other devices use the tailnet address)
- **Required for chat recall:** OpenAI-compatible **embeddings** API (e.g. DMX + `bge-m3`). MemCell formation uses a cheap chat model on that same key unless you set a separate one.

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
5. Settings → OpenClaw gateway URL, Embed API key (recall + formation)
6. In any note: **Open Agent companion** (`Mod+Shift+Space`). Ask from the note you care about; insert or replace only lands if that note has not changed since send.
7. Optional: ribbon or **Open Agent full-screen chat** for the same session in a main tab. The home note ` ```me-soul ` block still opens chat.

### Memory migration (manual, beta)

1. Put existing notes under human zones or `agent-inbox/`
2. `/me-digest @path` for knowledge wiki
3. `/me-write-insight …` for stable preferences
4. `/memorized` after digests (wiki vectors). Chat turns write MemCells on their own while formation is on.

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

- **0.3.x-beta** — durable Mac service (fixed HTTPS, device pairing, SQLite turn
  queue, restart reconciliation, notes + confirmation cards), a resident companion
  on the same chat queue, MemCell lifecycle memory, and session delete
- **0.2.0-beta** — OpenClaw gateway kernel, phone chat UI
- **0.1.x** — public beta on the local Grok / ACP runtime
- Later: polish, Community Plugin store packaging if/when ready

## License

[MIT](./LICENSE) — see [NOTICE.md](./NOTICE.md) for credits.
