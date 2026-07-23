---
name: me-reflect-feedback
description: 根据用户对某条回复的具体反馈，起草心迹/风格更新并走确认门。
---

# me-reflect-feedback

## Goal

把**用户对某一条 Agent 回复的具体反馈**变成可确认的记忆更新（profile / style，必要时 SOUL），不是闲聊。

## Input（插件会拼进 user message）

- 原 Agent 回复摘录  
- 用户反馈原文  
- 可选 👍 / 👎  
- 当前笔记路径（若有）  

## Refuse when

反馈为空或只有无意义符号 → 说明无法反思，不要写文件。

## Steps

1. 用 1–3 句 `:::thought` 说明你从反馈里读到什么（可观察、可执行）。  
2. 起草 **心迹草案**：  
   `agent-inbox/soul/insights/drafts/YYYY-MM-DD-feedback-<slug>.md`  
   - YAML：`type: insight`，`source: feedback`，`created`  
   - 正文：稳定偏好/边界/沟通风格（不是复述整段对话）  
3. 写 pending：  
   `agent-inbox/pending/YYYY-MM-DD-insight-feedback-<slug>.md`  
   - `type: insight`  
   - target：`agent-inbox/soul/profile.md` 和/或 `agent-inbox/soul/style.md`（沟通风格改 style）  
4. 输出确认卡：

```
:::confirm type=insight path=agent-inbox/pending/...
title: 根据反馈更新记忆
body: 摘要用户反馈与拟写入 profile/style 的要点
actions: [accept, reject]
:::
```

5. **只写** `agent-inbox/`。不要静默改人区；不要改 IDENTITY 除非用户明确要求。  
6. 若反馈只是「这题讲错了」等一次性纠错、不形成稳定偏好 → 可只写 feedback 反思摘要到 draft，pending 说明「无需改 profile」并让用户 reject，或写极轻量 style 提示。

## Accept semantics

Plugin Accept → 用户可用 `/me-apply-insight` 或现有 insight apply 路径合并进 profile/style。
