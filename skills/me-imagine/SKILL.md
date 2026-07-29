---
name: me-imagine
description: Grok Imagine 文生图；插件自动吸入 agent-inbox/raw/ 并可一键插入当前笔记。
---

# me-imagine

Run as **Grok Build** (vault cwd). The Obsidian plugin auto-ingests completed `image_gen` / `image_edit` files into `agent-inbox/raw/` and shows **插入当前笔记**.

## Goal

Generate (or edit) an image for the user's prompt using **native** Imagine tools — never curl the xAI HTTP API yourself.

## Tools

| Need | Tool |
|------|------|
| New image, no source | `image_gen` |
| Edit / restyle an existing image | `image_edit` |

## Steps

1. Craft a clear 2–5 sentence prompt from the user intent (or use their prompt verbatim if they gave one).
2. Call `image_gen` once (or `image_edit` if they attached / referenced a source image). Prefer `aspect_ratio` `1:1` unless they asked otherwise (`16:9`, `9:16`, `4:3`, `3:4`, `auto`).
3. After the tool completes, tell the user the short session-relative path (e.g. `images/1.jpg`) and that Agent OS will offer **插入当前笔记** for the vault copy under `agent-inbox/raw/`.
4. Optionally emit:

```
:::attachment path=agent-inbox/raw/<plugin-will-fill>.jpg
:::
```

Do **not** invent a vault path if you have not copied the file yourself. Prefer letting the plugin ingest.

## Boundaries

- Resolve deixis from **本会话此前对话** first（该 / 这个 / 刚才 / 上面的模型）. Do not search the vault for a different model when the chat already defined one.
- Only write under `agent-inbox/` if you choose to copy the file; never silent-write 手记 / 项目库 / 资料库 / 基础学科.
- Do not describe the generated image pixel-by-pixel (tool guidance). Confirm it was generated and how to insert it.
- Exact charts / labeled diagrams with precise text → prefer code (HTML/CSS) over Imagine; say so if asked.
- Named real people → use `image_edit` with a real reference, not pure `image_gen`.

## User-facing tone

Short Chinese. One thought fence max. Point them to the chat preview button for insert.
