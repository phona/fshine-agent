# 渠道适配（企微）

> 状态：现行。2026-11-18 核对 @ `32a331c`（`packages/`、`apps/` 与 `2823880` 无 diff）；渠道三档、silent 闸、附件合并窗均已实施；真实企微联调仍需独立测试租户（issue #74）。
> 口径：只写今天做决定 / 排障需要的边界；实施过程与真机踩坑记录在 git 历史（`git log --diff-filter=D -- docs/`）。
> 指针：`packages/channel-wecom/src/adapter.ts`（唯一渠道适配器）、`apps/server/channel-mode.ts`（三档装配）、`apps/server/attachment-nudge.ts`（30s 追问）；测试见 §8。

## 1. 职责与装配入口

渠道层是官方 `@wecom/aibot-node-sdk` 的薄封装：认证/心跳/重连归 SDK（`packages/channel-wecom/src/adapter.ts:1128-1136`），本层只做 env 校验、入站归一化、附件落盘、出站帧整形与闸门。

- 连接：`start()` 缺 `WECOM_BOT_ID`/`WECOM_BOT_SECRET` 即拒启（`packages/channel-wecom/src/adapter.ts:293-298`）；只订阅 `message.text / message.file / message.mixed`（`packages/channel-wecom/src/adapter.ts:332-341`）。
- 身份不在渠道层派生：适配器给出 `channel: 'wecom'` + `wecomUserId` + `conversationId`，不拼 principal（`packages/channel-wecom/src/adapter.ts:668-685`）；宿主拼 `principalId = <channel>:<userid>`、`sessionId = <channel>:<conversationId>`，未开通 principal 直接拒绝（`apps/server/server.ts:611-620`）。
- 档位只在 yaml `channel.mode`（`packages/contracts/src/config.ts:248-261`），无 `FSHINE_*` 覆盖口；`apps/server/main.ts:52-68` 按档位构造渠道并注入文字/文件投递端口，`apps/server/main.ts:79` 启动。
- 边界：渠道层不判业务、不建实体授权门；写/取消/产物归执行层与宿主后续切片（AGENTS.md「职责边界」）。

## 2. 入站归一化

`dispatchMessage` 只处理三类消息，其余（image/voice/video/event）静默忽略（`packages/channel-wecom/src/adapter.ts:553`）。

- 正文：`text` 取 `text.content`；`mixed` 只按序拼 `msg_item` 里的 text 项，图片项不进正文（`packages/channel-wecom/src/adapter.ts:478-497`）。
- 会话键：单聊 `conversationId = userid`，群聊 `= chatid`（`packages/channel-wecom/src/adapter.ts:567`）；群聊正文剥离开头 @机器人（`packages/channel-wecom/src/adapter.ts:677`）。
- 纯附件判定：无正文或正文去空白为空 → `attachmentOnly: true`（`packages/channel-wecom/src/adapter.ts:568`），宿主据此只登记、不启模型回合。
- 附件落盘：只接受 file 消息；文件名 basename 化 + 控制字符剥离 + 128 字符截断（`packages/channel-wecom/src/adapter.ts:538-544`）；单附件下载后 >32MB 不落盘、进 failed（`packages/channel-wecom/src/adapter.ts:93,523-526`）；下载失败不抛，转成 `[附件下载失败:…]` 文本（`packages/channel-wecom/src/adapter.ts:657-662`）。
- 宿主二次上限：登记前 `bytes > 20MB` 整条消息拒绝、零登记零回合（`apps/server/server.ts:648-666`，常量 `packages/agent/src/file-store.ts:319`）。
- 载荷：`IncomingChannelMessage` 携带 `messageId/chatType/text/attachments/receivedAt`（`packages/channel-wecom/src/adapter.ts:668-685`，契约 `packages/contracts/src/channel.ts:75-121`）。

## 3. 附件时序：8s 等文件 / 3s 合并窗 / 5s 上限

两条路径按“谁先到”分流；合并窗内到达的文字会吸收已缓冲附件，只调一次 handler。

| 到达顺序 | 机制 | 常量 / 判据 | 超时行为 | 指针 |
|---|---|---|---|---|
| 文字先到 | 正文等待同会话在途附件处理（下载 + 交给 handler 暂存）后继续 | `ATTACHMENT_WAIT_TIMEOUT_MS = 8_000`；总上界从正文首次等待起算 | 回「附件尚未准备好,请稍后重试」终帧，**不调 handler** | `packages/channel-wecom/src/adapter.ts:53,604-635,861-891` |
| 文件先到 | 纯附件先进合并窗，窗口内来的文字与附件合成一次 handler 调用 | 续期 3s、总上限 5s（起点+5s）、>5 个或 >25MB 立即 flush | 到点无文字 → 按纯附件回合交付（宿主只登记） | `packages/channel-wecom/src/adapter.ts:84-90,907-993` |

- 窗口续期：每来一个新附件重排到 `min(now+3s, 起点+5s)`，不会无限后移（`packages/channel-wecom/src/adapter.ts:919-926`）。
- 文字先到时不再新开合并窗（已有窗则并入；`textWaiting` 分支 `packages/channel-wecom/src/adapter.ts:604-620`）。
- ⚠️ **文档与代码不一致**：已删的 `docs/architecture/channels.md` §8.5 让排查 `FSHINE_INBOUND_DEBOUNCE_MS`/`waitForBurstSettle`（“宿主 burst 稳定器最多 4×2s”）。现行生产代码零命中；`FSHINE_INBOUND_DEBOUNCE_MS` 只出现在“已删环境键、不再派生”的守护测试里（`packages/agent/resource-policy-single-source.test.ts:73-79`、`packages/core/config.test.ts:474-477`），`waitForBurstSettle` 全仓零命中。`packages/channel-wecom/src/adapter.ts:49-52` 的“D-108 burst 稳定器”注释是陈旧指向：今天的 8s 是附件处理等待（下载 + 交 handler 暂存），不是宿主防抖。
- 覆盖：`packages/channel-wecom/adapter.merge-window.test.ts:154-329`（9 例）；`scripts/eval/wecom-sim/cases-d-attachment.test.ts:38-209`（W-13～W-18，6 例）。

## 4. 纯附件回执与 30s 追问的分工

同一条“只发文件不说话”的消息会产生**两条**不同职责的气泡，机制分属两层：

| | 渠道回执 | 宿主追问 |
|---|---|---|
| 触发 | 纯附件回合交付且宿主返回空文本 → 进入收据并窗 | 纯附件登记成功，30s 内该会话无新消息 |
| 时间 | `RECEIPT_COALESCE_MS = 2_000`（并窗到点） | `runtime.attachmentNudgeAfterMs`，缺省 30_000，0=关闭（`packages/agent/src/resource-policy.ts:193,322-324`） |
| 文案 | `formatFileAck`：只报「已收到 N 个文件」，**不带名**（`packages/contracts/src/channel.ts:70-73`；`packages/channel-wecom/src/adapter.ts:1048`） | 「刚才这 N 个文件：<名…>。你想让我先做什么？回复数字即可：」+ 3~4 业务选项（含「其他」；写类仅在 `allowWriteOperations=true` 时出现；`apps/server/attachment-nudge.ts:104-149`，选项 `:112-127`） |
| 送达条件 | 渠道闸门 / 终帧降级纪律 | 仅单聊；10 分钟冷却；非 live 只记 `attachment_nudge_suppressed`、不记 sent（`apps/server/attachment-nudge.ts:218-313`） |
| 副作用 | 无 | 同一份选项作为**系统注记**入队，下一回合模型可见（`apps/server/attachment-nudge.ts:303-305`；`apps/server/server.ts:261-274`） |

- 任何新入站消息取消待发追问；非附件消息丢弃本批；纯附件消息并入同批并重新计时（`apps/server/attachment-nudge.ts:199-210,218-254`）。带正文的消息同时撤掉挂起的回执（`packages/channel-wecom/src/adapter.ts:656`）。
- 回执并窗从第一条附件-only 回合起算，后续附件只追加、不续期（`packages/channel-wecom/src/adapter.ts:1010-1023`）；这与 3s 合并窗的续期语义不同。
- 边界：纯附件路径宿主不消费 `message.text`，下载失败项不进回执/追问（宿主分支 `apps/server/server.ts:668-721` 直接返回空串；回执只数已登记的 `attachments`，`packages/channel-wecom/src/adapter.ts:807`）；全部失败时用户侧静默——属现行行为，未定义专门话术。
- 分工理由：回执说“收下了”，追问说“是哪几个 + 下一步”，避免两份几乎相同的清单（`packages/contracts/src/channel.ts:53-57`）。
- ⚠️ **文档与代码不一致**：`formatFileReceipt`（带文件名）只有定义与注释，**无生产调用点**（全仓 `grep` 只命中定义/注释、`docs/product/wecom-live-dummy-cases.md` 与历史档）。该文 `:262` 与 `packages/channel-wecom/src/adapter.ts:191`/`packages/contracts/src/channel.ts:53` 仍称“带指令回合首帧用 `formatFileReceipt`（带文件名）”；现行行为是带指令回合的受理帧为「收到,正在处理…」（`packages/channel-wecom/src/adapter.ts:573`），不发「已收到 N 个文件」收据、不列文件名；文件名以 `[附件:<名>]` 拼进入站正文（`packages/channel-wecom/src/adapter.ts:662`）。已删的 `manual-test-wecom.md` §8.4/§8.8 同一说法同样与代码不符。
- 覆盖：`apps/server/server-attachment-nudge.test.ts`（全文件 12 例；§4 相关 10 例在 292-500）；`scripts/eval/wecom-sim/cases-d-attachment.test.ts:65-209`（W-14～W-18）。

## 5. silent 闸与 `channel.mode` 三档

三档只来自 yaml；每档都把出站模式**显式**传给适配器，不依赖缺省：

| 档位 | 长连接 | 出站模式 | 行为 | 指针 |
|---|---|---|---|---|
| `offline`（缺省） | 不 `start` | `silent` | 不认证、不建 WS；投递一律 suppressed | `packages/contracts/src/config.ts:253`；`apps/server/channel-mode.ts:52-59` |
| `shadow` | 建连 | `silent` | 入站照收、回合照跑，六类用户可见发送全部被闸 | `apps/server/channel-mode.ts:36-49`；`packages/channel-wecom/src/adapter.ts:281-282` |
| `live` | 建连 | `live` | 真实投递（改动前语义） | 同上 |

- 解析：显式 `live` → live；显式 `silent|shadow` → silent；显式非法或缺失 → silent（fail-safe）；仅当显式缺失时才看环境开关 `FSHINE_WECOM_DELIVERY`，且必须逐字 `live`（`packages/channel-wecom/src/silent-shadow-gate.ts:49-57`）。适配器对“未声明/非法”另发 `wecom_delivery_mode_undeclared`（`packages/channel-wecom/src/adapter.ts:272-280`）；装配层总会显式传模式，正常启动不会触发。
- 机械覆盖：闸门包在客户端工厂出口上（`packages/channel-wecom/src/adapter.ts:281-282`），`start()` 建出的客户端即被闸包装（live 原样返回，silent 为替身），因此所有出站路径只经 `this.client`，不逐条堵。
- 拦：`replyStream / sendMessage / sendMediaMessage / replyMedia / uploadMedia`；放行：`on / connect / disconnect / downloadFile`（`packages/channel-wecom/src/silent-shadow-gate.ts:137-161`）。
- 证据：每次抑制记 `SuppressedSend`（时间/方法/是否可见/字节数，**不含正文**）+ `wecom_silent_shadow_suppressed`；`shadowEvidence()` 返回进程内快照（mode/抑制数/事件）；组件不落盘，抑制流水只经 console（`packages/channel-wecom/src/silent-shadow-gate.ts:165-176`；`packages/channel-wecom/src/adapter.ts:378-385`）。
- 反向绊线：缺省静默、显式 live 必真发、环境开关只认逐字 `live`、`wrap` 在 live 原样返回（`packages/channel-wecom/adapter.silent-shadow.test.ts:251-456`）；档位不能被环境开关覆盖（`apps/server/channel-mode.test.ts:241-253`）。

## 6. 出站六路与主动投递面

六类用户可见路径全部落在唯一客户端上——这是闸门能机械覆盖的前提：

| # | 路径 | 触发 | 底层调用 | 指针 |
|---|---|---|---|---|
| ① | 同步回帧 ACK | 非纯附件消息到达 | `replyStream` | `packages/channel-wecom/src/adapter.ts:573` |
| ② | 进度帧 | handler 调 `progress()`；3s 节流、4 帧预算、首帧不占预算 | `replyStream` | `packages/channel-wecom/src/adapter.ts:55-56,732-741` |
| ③ | 终态 | handler 返回文本 | `replyStream(finish=true)` | `packages/channel-wecom/src/adapter.ts:802` |
| ④ | 异常兜底 | handler 抛错 → `FALLBACK_REPLY`；附件等待超时；图片失败 | `replyStream` | `packages/channel-wecom/src/adapter.ts:773-780,626-635,840-843` |
| ⑤ | 拒绝 | 宿主未开通 principal 返回文案 | 走 ③ 同一终帧 | `apps/server/server.ts:618-620` |
| ⑥ | 主动消息 | 回合末文件投递、任务完成、追问 | `sendMessage` + `uploadMedia` + `sendMediaMessage` | `packages/channel-wecom/src/adapter.ts:391-471` |
| 补 | 计划通知（当前宿主 handler 只用 `message` 入参，未调用） | handler `notice()` | `replyStream(finish=false)` | `packages/channel-wecom/src/adapter.ts:744-768` |

- 文件/图片回传：`uploadMedia` + `replyMedia`；文件失败只记事件不外抛，图片失败且本轮无正文时补发「图片发送失败,请稍后再试」（`packages/channel-wecom/src/adapter.ts:815-847`）；主动交付只支持文字与文件，图片直接拒绝（`packages/channel-wecom/src/adapter.ts:402-403`）。
- 终帧降级：`replyStream` 失败且 `finish=true` 时改走 `sendMessage`，同一次回复只降级一次（`packages/channel-wecom/src/adapter.ts:1054-1102`）；再失败记 `wecom_reply_degrade_fail`。
- 主动投递面（宿主）：`fileDelivery.sendToConversation` 发文件、`sendText` 发文字（`apps/server/main.ts:63-69`）；非 live 由宿主先行记 suppressed，不采信闸门的假回执（`apps/server/server.ts:517-527`；`apps/server/attachment-nudge.ts:288-294`；`apps/server/task-completion-delivery.ts:61-68`）；任务完成投递与追问同端口（`apps/server/server.ts:306-330`；`apps/server/task-completion-delivery.ts:54-108`）。
- 通知 outbox 仍只接渠道无关落盘 sink（`apps/server/main.ts:63`、`apps/server/notification-file-sink.ts:11`）；真实企微 `NotificationSink` 实现仍为 0，任务完成/追问走 `fileDelivery` 端口而非 outbox。

## 7. 事件目录（渠道面）

按发出点分组；名字即 `event` 字段逐字值。`docs/product/event-catalog.md` 以 `23ae585` 为基线列 29 个宿主事件（不含 `wecom_*`），该清单未收录 `attachment_nudge_*`、`task_result_delivery_*`、`recalc_*`、`run_dir_cleanup_startup*`，且行号已漂移——排障以本表/代码为准。

| 发出点 | 事件（指针） |
|---|---|
| `adapter.ts` 构造 / 入站 / 出站 | `wecom_delivery_mode_undeclared`:274；`wecom_dispatch_fail`:336；`wecom_reply_truncated`:421/753/791；`wecom_notice_fail`:763；`wecom_handler_error`:776；`wecom_file_fail`:821；`wecom_image_fail`:837；`wecom_reply_fail`:1069；`wecom_reply_degraded`:1085；`wecom_reply_degrade_fail`:1093；`wecom_media_fail`:1114 |
| `silent-shadow-gate.ts` | `wecom_silent_shadow_suppressed`:170（每次抑制，含 kind/userVisible/bytes） |
| 纯附件追问 | `attachment_nudge_suppressed`:290；`attachment_nudge_sent`:299；`attachment_nudge_failed`:308 |
| 入站 / 回合（`apps/server/server.ts`） | `message_refused`:618；`message_duplicate_replayed`:628；`inbound_attachment_too_large`:653；`message_attachment_only`:682；`inbound_files_registered`:692/739；`pending_files_activated`:750；`message_done`:808；`message_done_log_write_failed`:826 |
| 文件投递（`apps/server/server.ts`） | `file_delivery`:514/519/560/575/588（status=`delivery_unavailable`/`suppressed`/`recalc_gated`/`delivery_failed`/`sent`）；`recalc_delivery_gated`:550；`file_delivery_log_write_failed`:592 |
| 任务完成投递 | `task_result_delivery_suppressed`：`apps/server/server.ts:312`（本回合已转述）/`apps/server/task-completion-delivery.ts:63/72/83`；`task_result_delivery_sent`:`apps/server/task-completion-delivery.ts:93`；`task_result_delivery_failed`:`apps/server/task-completion-delivery.ts:101` |
| 进程 | `server_started`（`apps/server/channel-mode.ts:74` 构造，`apps/server/main.ts:81` 打印）；`server_shutdown`（`apps/server/main.ts:93`） |

- 判读纪律：`file_delivery.status` 只有 `sent` 表示真实送达；`suppressed` 在 silent 部署是正常事实，不是失败（`apps/server/server.ts:512-530`）。
- `wecom_*` 走 `console.*` 直写（多数 warn/error，`wecom_reply_degraded` 为 info），不经宿主 logger；按事件名采集需劫持 console（`packages/channel-wecom/src/adapter.ts:274,336,1084`；`docs/product/event-catalog.md:8,149-150`）。

## 8. 核对与验证入口

- 渠道机制确定性测试：`packages/channel-wecom/adapter.merge-window.test.ts`、`adapter.silent-shadow.test.ts`、`packages/channel-wecom/adapter.test.ts:1053-1171`（收据并窗）、`apps/server/channel-mode.test.ts`、`apps/server/server-attachment-nudge.test.ts`。
- 本页核对实跑（2026-11-18，worktree `32a331c`）：`export TMPDIR=/home/tao/.tmp && npx vitest run packages/channel-wecom/adapter.merge-window.test.ts packages/channel-wecom/adapter.silent-shadow.test.ts apps/server/channel-mode.test.ts apps/server/server-attachment-nudge.test.ts` → **4 files / 50 tests passed**。
- 另跑 `npx vitest run packages/channel-wecom/adapter.test.ts` → **1 file / 47 tests passed**（含 `1053-1171` 收据并窗 8 例）。
- 附件时序端到端（真 `createServer` + dummy 执行层 + 假 SDK）：`npx vitest run scripts/eval/wecom-sim/cases-d-attachment.test.ts` → **1 file / 6 tests passed**（W-13～W-18）。入口与真/假边界见 `docs/product/wecom-live-dummy-cases.md:291-320`。
- 未验证：真实企微网络时序与真机气泡观感仍需 live 人工面（`docs/product/wecom-live-dummy-cases.md` §0 的人工分界；稳定性另见 H 组）；适配器没有时钟注入缝（3s/2s 都是真实定时器；仅 3s 合并窗长度可用构造参数收紧，`packages/channel-wecom/src/adapter.ts:170-175`），自动用例按事件驱动等待（同文 §10），不把离线结论读作已联调。

## 来源

- `docs/architecture/channels.md`（已删）：保留附件收据/30s 追问分工、真机时序不可替代的边界；其 `FSHINE_INBOUND_DEBOUNCE_MS` 与“首帧带文件名收据”两条已与现行代码不符，按代码更正。
- `docs/architecture/channels.md`（已删）：保留闸门出口覆盖、六类路径矩阵、fail-safe 与反向绊线。
- `docs/architecture/channels.md`（已删）：保留入站/出站面审计口径与“入站已实现、真实企微 NotificationSink=0”的事实；其“渠道影子隔离无机械门”已被 B2 闸门取代，不再作为现状。
- `docs/product/wecom-live-dummy-cases.md`（活）：保留 D 组附件时序用例与自动/人工分工；§8 的“带指令回合首帧用 formatFileReceipt”与代码不符（见 §4）。
- `docs/product/event-catalog.md`（活）：保留事件判读口径与 `wecom_*` 不在清单内的边界；基线 23ae585，行号已漂移。
