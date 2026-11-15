# B2 · Silent Shadow 出站机械闸门

> 状态：已实现（默认静默）。范围：**出站**——覆盖所有**用户可见发送路径**。
> 判据：每次出站尝试**可观测**（有事件/计数），**实际用户可见投递 = 0**。
> 零真实模型：确定性夹具（替身客户端），`npm test` 可复现。

## 1. 问题与机制

真实出站传输只有一条——官方 SDK 的 `SdkClientLike`（`adapter.ts:73-90`）。适配器里**所有**
用户可见发送路径最终都落到这个客户端的五个方法上：

| 底层方法 | 用户可见 | 用途 |
| --- | --- | --- |
| `replyStream` | 是 | 同步回帧 / 进度帧 / 终态帧 / 计划通知 / 终帧降级失败的降级目标 |
| `sendMessage` | 是 | 主动消息（`sendToConversation` 文字）、终帧拒收降级 |
| `sendMediaMessage` | 是 | 主动消息（`sendToConversation` 文件）、主动图片 |
| `replyMedia` | 是 | 被动回复的图片 / 文件回传 |
| `uploadMedia` | 否（前置） | 上传换 media_id；其后必接一条回传，故一并断 |

**机械保障**：把客户端**整体**包一层闸门（`SilentShadowGate.wrap`），就从唯一出口覆盖全部
路径——不是逐条堵，而是收在唯一传输面上。适配器构造期把工厂出口包住（`adapter.ts` 构造函数
`this.clientFactory = () => this.gate.wrap(baseFactory())`），于是 `start()` 建出的客户端已是
被闸替身；`reply()` / `notice` / `sendToConversation` / 降级分支全部经 `this.client`，无一漏网。

**缺省静默**：`resolveDeliveryMode` 仅在**显式选项** `deliveryMode:'live'` 或**显式环境开关**
`FSHINE_WECOM_DELIVERY=live`（逐字，大小写敏感）下放行；未设/空串/其它值一律静默。不引入向
真实平台的隐式回退。

**放行**（非投递）：`on` / `connect` / `disconnect`（长连接是收消息的前提）、`downloadFile`
（入站附件下载）。静默影子因此仍是一条**忠实的干跑**：入站照收、回合照跑、投递被截。

**可观测证据**：每次被抑制的发送追加一条 `SuppressedSend`（时间、方法、是否用户可见、字节数
——**不含正文**，避免把用户内容写进日志）+ 一行结构化日志 `wecom_silent_shadow_suppressed`。
`channel.shadowEvidence()` 返回 `{ mode, suppressed, userVisibleSuppressed, events }`。
启动日志含 `deliveryMode`（`apps/server/main.ts` server_started）。

## 2. 覆盖矩阵：六类路径 × 抑制 / 可观测 / 投递=0

测试文件：`packages/channel-wecom/adapter.silent-shadow.test.ts`（13 例）与
`apps/server/server.test.ts`（端到端 1 例）。底层是记录调用的替身 `DeliveryRecorder`；
静默模式下它**全零**——即"实际用户可见投递 = 0"的直接读数。

| # | 路径 | 触发 | 被抑制的底层调用 | 可观测证据 | 投递=0 | 用例 |
| --- | --- | --- | --- | --- | --- | --- |
| ① | 同步回帧（ACK） | 文本消息到达 | `replyStream`(ACK) | `reply_stream` | `sdk.userVisibleCalls===0` | ①②③⑤ 共同 |
| ② | 进度 | `progress()` | `replyStream`(finish=false) | `reply_stream` | 0 | 「② 进度帧」（3 条：ack+进度+终帧） |
| ③ | 终态 | handler 返回文本 / 多文件 | `replyStream`(finish=true) + `uploadMedia` + `replyMedia` | `reply_stream`/`upload_media`/`reply_media` | 0 | 「③ 终态（多文件回传）」（2/2/2） |
| ④ | 异常 | handler 抛错 → FALLBACK；图片上传失败兜底；附件等待超时 | `replyStream`(finish=true) | `reply_stream` | 0 | 「④ 异常兜底」（2 条：ack+FALLBACK） |
| ⑤ | 拒绝 | 宿主 `server.ts:222` 返回未开通文案 | `replyStream`(finish=true) | `reply_stream` | 0 | 「⑤ 拒绝」（2 条）+ 端到端 1 例 |
| ⑥ | 主动消息 | `sendToConversation(route, reply)` | `sendMessage` + `uploadMedia` + `sendMediaMessage` | `send_message`/`upload_media`/`send_media` | 0 | 「⑥ 主动消息」（1/2/2） |
| 补 | 计划通知（notice） | handler `await notice(...)` | `replyStream` | `reply_stream` | 0 | 「补充：计划通知」（3 条） |

端到端（`server.test.ts`）：未开通 principal → 宿主产出拒绝文案并登记 `message_refused`
（路径确实跑到），但底层 stub **零帧**（`frames.toHaveLength(0)`），`shadowEvidence.mode==='silent'`
且 `userVisibleSuppressed>=1`。

> 说明：静默模式下被抑制的 `replyStream` 恒 resolve，故**终帧降级**（`reply()` 的 `sendMessage`
> 分支）不会被触发；但降级目标是 `sendMessage`——已由 ⑥ 主动消息与单元用例覆盖在同一闸门下，
> 无独立通路。

### 反向绊线（绕过闸门 → 测试必红）

| 绊线 | 断言 | 若被绕过（缺省翻 live / 工厂出口未包裹 / 闸门退化为透传） |
| --- | --- | --- |
| 缺省静默 | 不传 `deliveryMode` 时 `mode==='silent'` **且** `sdk.userVisibleCalls===0` **且** `userVisibleSuppressed>=1` | 替身收到 ack+终帧 → 红 |
| 显式 live 不拦 | `deliveryMode:'live'` 时替身**确实收到** ≥2 帧、`suppressed===0` | 证明"零投递"来自闸门，而非替身吞掉 |
| 环境开关 | 仅逐字 `live` 放行；`'1'/'LIVE'/''/未设` 全静默 | 缺省翻 live → 红 |
| 单元 | silent：`wrap` 返回新实例且底层零调用；live：`wrap` 原样返回同一实例 | 闸门退化为透传 → 红 |

## 3. 改动清单（最小）

- 新增 `packages/channel-wecom/src/silent-shadow-gate.ts`：闸门 + 模式解析 + 证据。
- `packages/channel-wecom/src/adapter.ts`：新增 `deliveryMode` 选项（缺省静默）、构造期包裹工厂、
  `shadowEvidence()` 访问器。
- `packages/channel-wecom/src/index.ts`：导出闸门与类型。
- `apps/server/main.ts`：启动日志补 `deliveryMode`。
- 既有机械测试（adapter/adapter.degrade/notice/server）**显式** `deliveryMode:'live'`：它们测的是
  适配器真实投递行为，保留原语义；缺省静默由新用例专项覆盖。**未删/未弱化任何断言**。
- 新增 `packages/channel-wecom/adapter.silent-shadow.test.ts`（13 例）、`server.test.ts` 端到端 1 例。

## 4. 联调运行手册（**本 run 不执行真实联调**）

> 授权边界：本 run **不连生产租户、不向非白名单真实用户发消息、不碰真实业务数据/写**。真实
> 企微联调需**独立测试租户凭据 + 白名单测试账号**，当前**不具备 → 登记「待凭据」**（见 §6）。

### 4.1 前置条件

1. **独立测试租户**：企微「智能机器人 → 长连接 API」测试应用的 `botId` / `secret`（**非生产**）。
2. **白名单测试账号**：`config/agent.yaml` 的 `principals` 只列**测试账号** `<渠道>:<测试UserID>`
   且 `enabled: true`；非白名单账号走确定性拒绝路径（`server.ts:220`）。
3. **Dummy 执行层**：`contextProfiles.<id>.gateway` 指向**仓内 dummy**（`scripts/eval/fixtures/…`
   的 `bin/dummy`），不接真实业务网关；只读 operation，不写真实数据。
4. **落盘证据**：任务库与通知 sink 落在临时目录（`store.dbPath` 指临时路径），联调后整体清理。

### 4.2 运行（先影子，后放行）

```
# 阶段 A —— 影子干跑（缺省，抑制所有用户可见投递）
# 不设 FSHINE_WECOM_DELIVERY，直接起 server；入站照收、回合照跑、投递被闸。
npm start
#   观测：启动日志 deliveryMode:"silent"；
#         被抑制发送以 wecom_silent_shadow_suppressed 逐条落日志；
#         测试账号在企微端**看不到任何机器人消息**（期望）。
#   核对：三次不同路径（文本问询 / 未开通账号 / 后台任务通知）都只在日志留痕、会话静默。

# 阶段 B —— 显式放行（仅测试租户 + 白名单账号）
FSHINE_WECOM_DELIVERY=live npm start
#   观测：启动日志 deliveryMode:"live"；消息真实送达**白名单测试账号**。
#   核对：仅白名单账号可收发；非白名单仍被拒；执行层仍为 dummy、无真实写。
```

### 4.3 回退 / 熔断

- **回退**：去掉 `FSHINE_WECOM_DELIVERY`（或置任意非 `live` 值）重启 = 回到静默；无需改配置。
- **熔断**：联调中发现任何意外外发/异常送达 → 立即以「未设开关」重启回到静默；`principals`
  白名单即时收紧到空集即可全线拒绝（`server.ts:220`）。执行层保留 dummy，随时可整体停用渠道。
- **证据留存**：`shadowEvidence()`/日志与通知 `notifications.jsonl` 一并归档，作为"尝试可观测、
  投递=0/受控"的核验材料。

## 5. 非用户可见的旁路（不在闸门范围，已核实）

- 通知 sink = **文件**（`apps/server/notification-file-sink.ts`；`main.ts:43` 装配）：写
  `notifications.jsonl`，**不是用户可见投递**，故不经闸门；若将来接入真实企微 sink，其用户可见
  发送必经 `sendToConversation`（已覆盖于 ⑥）。
- 附件落盘、任务库写入均为本地状态，非渠道投递。

## 6. 待凭据登记

| 项 | 状态 |
| --- | --- |
| 测试租户 botId/secret | **待凭据**（本 run 未执行真实联调） |
| 白名单测试账号 UserID | **待凭据** |
| 真实（测试租户）联调执行 | **未执行**（授权边界：需独立凭据，本 run 不跑） |
