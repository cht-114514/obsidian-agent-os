---
name: me-reindex
description: 重建 agent-inbox/wiki/index.md（关键词）与 vectors.jsonl（embedding，可选）。
---

# me-reindex

```
/me-reindex
```

## 做什么

1. 扫描 `agent-inbox/wiki/sources` 中**非** `pending_review` 的页面  
2. 重建 **关键词索引** → `agent-inbox/wiki/index.md`  
3. 若插件已配置 Embed API Key 且启用向量检索：  
   - 切块 → 调用 embedding 模型（默认 `bge-m3` via DMX）  
   - 写入 **向量索引** → `agent-inbox/wiki/vectors.jsonl`  
   - 内容 hash 未变则复用旧向量，避免重复计费  

## 配置（Obsidian Agent OS 设置 → 记忆检索）

| 项 | 默认 |
|----|------|
| Embed Base URL | `https://www.dmxapi.cn/v1` |
| Embed 模型 | `bge-m3` |
| 检索模式 | `hybrid`（向量 + 关键词） |

未配置 API Key 时只更新关键词索引，并提示跳过向量。

## 何时运行

- 首次启用 embedding  
- 更换 embed 模型后（旧向量按 model 字段过滤，需全量重建）  
- sources 与 index 明显不同步时  
