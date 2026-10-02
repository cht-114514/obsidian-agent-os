# 手机稳定性改造：实现与运维

这份文档记录 `/Users/chen/Downloads/PLAN (1).md` 的落地情况。核心原则：

> 连接可以中断，消息、任务和结果必须能够恢复。

## 架构（现状）

```
手机 Obsidian（本机消息、待发队列、结果缓存）
        │  短 HTTPS 请求：提交 / 查询进度 / 补取结果 / 读笔记
        ▼
agent.chenhaotong.one   ← Cloudflare Tunnel
        ▼
Mac 常驻服务（launchd: com.chenhaotong.agent-os, 127.0.0.1:8788）
  · SQLite 任务库（幂等接收、任务状态、run ID、结果）
  · 设备配对与可撤销凭据、限流、日志脱敏
  · 资料读写（agent-inbox 直写；human zone 走确认卡）
        │  WebSocket（仅本机回环）
        ▼
OpenClaw Gateway（127.0.0.1:18789）→ 推理与 skills
        ▼
Mac 上的 Me.Inc vault（iCloud 同步）
```

## 组件

| 位置 | 作用 |
|---|---|
| `plugin/src/kernel/transport.js` | 网关 WebSocket：请求关联、事件缓冲、**每个等待都有上限** |
| `plugin/src/kernel/outbox-runner.js` | 唯一的出站通道：先落盘、再发送、只发一次 |
| `plugin/src/kernel/session-store.js` | 本机消息缓存 + 待发队列 + 设备凭据 |
| `plugin/src/kernel/service-client.js` | 手机端 HTTPS 客户端（service 模式） |
| `service/src/store.js` | SQLite 任务库（`node:sqlite`） |
| `service/src/turns.js` | 接收—执行—核对状态机 |
| `service/src/gateway.js` | Node 侧 OpenClaw 客户端（复用插件的握手代码） |
| `service/src/vault.js` | 笔记读写、路径防护、内容指纹 |
| `service/src/api.js` | 最小 HTTP 接口 |

## 运行

```bash
# 服务（前台，便于观察）
npm run service:serve

# 服务（常驻）
launchctl kickstart -k gui/$(id -u)/com.chenhaotong.agent-os
launchctl list | grep agent-os

# 生成一次性配对码（5 分钟有效，只能用一次）
npm run service:pair

# 本机状态：内核、队列、会话、vault
npm run service:status

# 设备管理
node service/bin/agent-os.mjs devices
node service/bin/agent-os.mjs revoke <deviceId>
node service/bin/agent-os.mjs rotate <deviceId>
```

手机上：Obsidian → 设置 → Obsidian Agent OS → **手机入口 → 配对这台设备**，填入配对码即完成。

### 入口方式

| 模式 | 含义 |
|---|---|
| `auto`（默认） | 已配对就走固定 HTTPS 服务；未配对保持旧版网关直连 |
| `service` | 强制走固定 HTTPS 服务 |
| `direct` | 旧版网关直连（手动回退） |

切换时先确认没有未完成任务：`npm run service:status` 看队列，手机端聊天里的「状态未知，需要核对」消息需要你决定重发或忽略。**不要两条链路同时发送**。

### 凭据迁移（切换后执行）

设备配对完成后，桌面实例会在 `entryMode` 不是 `direct` 时自动清掉 `data.json` 里的共享 Gateway token。剩下的收尾动作需要人工确认，因为它们影响其他使用者：

1. 确认没有其他设备 / 自动化还在用那个共享 token（`grep -r gatewayToken` vault 配置、检查 launchd 任务与脚本）。
2. 观察一周无异常后，停掉旧入口：手机设置改为 `service`，桌面设置改为 `service`。
3. 轮换 Gateway token：改 `~/.openclaw/openclaw.json` 的 `gateway.auth.token`，重启 OpenClaw，再让需要的设备重新配对。轮换前先确认旧 token 已无人使用，否则会一次性断开所有旧链路。

设备凭据可单独撤销，不会被 vault 同步，也不需要轮换 Gateway token：

```bash
node service/bin/agent-os.mjs devices
node service/bin/agent-os.mjs revoke <deviceId>
```

### 回退

把设置里的「入口方式」改为 `direct`，或 `AOS_START=0` 后 `launchctl unload ~/Library/LaunchAgents/com.chenhaotong.agent-os.plist` 停掉服务。手机端未发出的消息留在本机，重新配对或切回 service 后继续。

## 接口

| 方法 | 路径 | 职责 |
|---|---|---|
| POST | `/v1/pair/claim` | 一次性配对码换设备凭据 |
| GET | `/v1/health` | 入口 / 服务 / 内核诊断（匿名只读缓存状态） |
| POST | `/v1/turns` | 幂等接收消息 |
| GET | `/v1/turns/{id}?after=N` | 状态 + 增量 + 最终结果 |
| POST | `/v1/turns/{id}/cancel` | 用户主动终止 |
| POST | `/v1/turns/{id}/retry` | 用户确认后重发 |
| GET | `/v1/sessions` | 会话列表 |
| GET | `/v1/sessions/{key}/history` | 历史消息 |
| GET | `/v1/notes` · `/v1/notes/search` | 笔记列表 / 检索 |
| GET | `/v1/note` · POST `/v1/note/read` | 读一条笔记（含 sha256 指纹） |
| POST | `/v1/notes/write` | 写入；human zone 返回 `428 CONFIRMATION_REQUIRED` |
| GET | `/v1/notes/confirm/{token}` | 重新核对确认卡所依据的当前正文 |
| GET/POST | `/v1/devices` · `/v1/devices/{id}/revoke` · `/rotate` | 设备管理（需 admin token） |

凭据：业务接口用设备凭据（`Authorization: Bearer`），管理员接口用本机文件 `~/.local/share/agent-os/admin.token`（0600，不经隧道）。

## 状态语义

| 状态 | 含义 | 会自动重发吗 |
|---|---|---|
| `queued` | 还没交给网关 | 会 |
| `running` | 正在执行 | — |
| `completed` / `failed` / `aborted` | 终态 | 不会 |
| `needs_verification` | 无法确认是否已执行 | **不会**，需用户决定 |

只有 `queued` 会被自动重发。`needs_verification` 出现在手机上时，消息下方会显示「重发 / 忽略」。

## 故障行为

| 场景 | 行为 |
|---|---|
| 冷启动无网络 / 电梯里 | 消息先落本机，显示「待发出（已排队）」 |
| 握手各阶段断线 | 每段等待都有上限，失败即重连，不会永久卡住 |
| Wi-Fi / 蜂窝切换 | 换 URL 时旧 socket 立即失败，新连接重新握手 |
| 锁屏 / 后台 | 停止轮询，保留任务 id 与游标；回前台先核对再续传 |
| 系统终止后重开 | 从本机队列恢复；`sending` 的消息用同一 `clientTurnId` 续查 |
| 服务收到消息但回执丢失 | 同一 `clientTurnId` 再提交返回已有任务，不重复执行 |
| 手机离线期间任务完成 | 回前台按 `after` 游标补取增量与最终结果 |
| 服务重启 | 先向 OpenClaw 核对；已完成的补记结果，不确定的标为「需要核对」，禁止盲目重跑 |
| OpenClaw 重启 | 连接中断按「状态未知」处理，不假定失败 |
| 两个会话同时排队 | 每个会话一个在跑，按到达顺序 |
| 手机与 Mac 同时使用 | 同一会话说到底；服务是唯一执行入口 |
| 存储写入失败 | 输入框保留文字并明确报错，不假装已发送 |
| 手机笔记尚未同步 | 以 Mac 读到的正文与指纹为准，确认后若有变化重新展示差异 |
| 重复点击确认 | 确认令牌一次性；过期或复用返回明确错误 |
| 设备凭据撤销 | 该设备所有请求立即 401 |

## 测试

```bash
npm test                 # 协议 + 插件 + 服务 + skills
npm run service:pair     # 生成配对码
AOS_INTEGRATION_CODE=XXXX node service/scripts/integration.mjs   # 真机链路（真跑一轮对话）
```

`service/scripts/smoke.mjs` 覆盖鉴权、幂等、设备撤销；`integration.mjs` 用**插件真正打包的那份客户端**跑一遍配对、对话、笔记读写与确认卡。

## 边界

- 不新增 VPS，不迁出 Obsidian，不重建知识库。
- Mac 关机 / 家庭断网 / 重启未登录时任务不能执行；消息留在手机等待。
- iOS 后台不承诺自动送达；已被 Mac 确认收到的任务继续运行。
- 手机笔记内容不会因 Mac 上的旧副本被回退：写入使用内容指纹 compare-and-set。
- 诊断接口与日志不记录凭据与笔记正文（`service/src/logger.js` 强制脱敏）。
