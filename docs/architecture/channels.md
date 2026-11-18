# 渠道适配（企微）

> 状态：现行。2026-11-18 核对 @ `2823880`；渠道三档、silent 闸、附件合并窗均已实施；真实企微联调仍需独立测试租户（issue #74）。
> 口径：只写今天做决定 / 排障需要的边界；实施过程与真机踩坑记录在 git 历史（`git log --diff-filter=D -- docs/`）。
> 指针：`packages/channel-wecom/src/adapter.ts`（唯一渠道适配器）、`apps/server/channel-mode.ts`（三档装配）、`apps/server/attachment-nudge.ts`（30s 追问）；测试见 §8。

## 1. 职责与装配入口

渠道层是官方 `@wecom/aibot-node-sdk` 的薄封装：认证/心跳/重连归 SDK（`packages/channel-wecom/src/adapter.ts:1128-1137`），本层只做 env 校验、入站归一化、附件落盘、出站帧整形与闸门。

- 连接：`start()` 缺 `WECOM_BOT_ID`/`WECOM_BOT_SECRET` 即拒启（`adapter.ts:294-297`）；只订阅 `message.text / message.file / message.mixed`（`adapter.ts:332-339`）。
- 身份不在渠道层派生：适配器只报 `channel: 'wecom'` + `wecomUserId` + `conversationId`（`adapter.ts:668-685`）；宿主拼 `principalId = <channel>:<userid>`、`sessionId = <channel>:<conversationId>`，未开通 principal 直接拒绝（`apps/server/server.ts:612-620`）。
- 档位只在 yaml `channel.mode`（`packages/contracts/src/config.ts:248-261`），无 `FSHINE_*` 覆盖口；`apps/server/main.ts:52-68` 按档位构造渠道并注入文字/文件投递端口，`main.ts:79` 启动。
- 边界：渠道层不判业务、不建实体授权门；写/取消/产物归执行层与宿主后续切片（AGENTS.md「职责边界」）。

## 2. 入站归一化

`dispatchMessage` 只处理三类消息，其余（image/voice/video/event）静默忽略（`adapter.ts:553`）。

- 正文：`text` 取 `text.content`；`mixed` 只按序拼 `msg_item` 里的 text 项，图片项不进正文（`adapter.ts:478-503`）。
- 会话键：单聊 `conversationId = userid`，群聊 `= chatid`（`adapter.ts:567`）；群聊正文剥离开头 @机器人（`adapter.ts:677`）。
- 纯附件判定：无正文或正文去空白为空 → `attachmentOnly: true`（`adapter.ts:568`），宿主据此只登记、不启模型回合。
- 附件落盘：只接受 file 消息；文件名 basename 化 + 控制字符剥离 + 128 字符截断（`adapter.ts:539-544`）；单附件 >32MB 直接进 failed（`adapter.ts:93,523-526`）；下载失败不抛，转成 `[附件下载失败:…]` 文本（`adapter.ts:657-662`）。
- 宿主二次上限：登记前 `bytes > 20MB` 整条消息拒绝、零登记零回合（`server.ts:645-664`，常量 `packages/agent/src/file-store.ts:319`）。
- 载荷：`IncomingChannelMessage` 携带 `messageId/chatType/text/attachments/receivedAt`（`adapter.ts:668-685`，契约 `packages/contracts/src/channel.ts:75-101`）。

## 3. 附件时序：8s 等文件 / 3s 合并窗 / 5s 上限

两条路径按“谁先到”分流，**不会同时生效**：

| 到达顺序 | 机制 | 常量 / 判据 | 超时行为 | 指针 |
|---|---|---|---|---|
| 文字先到 | 正文等待同会话在途附件下载，再交给 handler | `ATTACHMENT_WAIT_TIMEOUT_MS = 8_000` | 回「附件尚未准备好,请稍后重试」终帧，**不调 handler** | `adapter.ts:53,573-636` |
| 文件先到 | 纯附件先进合并窗，窗口内来的文字与附件合成一次 handler 调用 | 续期 3s、总上限 5s（起点+5s）、>5 个或 >25MB 立即 flush | 到点无文字 → 按纯附件回合交付（宿主只登记） | `adapter.ts:84-90,907-1000` |

- 窗口续期：每来一个新附件重排到 `min(now+3s, 起点+5s)`，不会无限后移（`adapter.ts:919-926`）。
- 文字先到时文件不进合并窗（`textWaiting` 分支，`adapter.ts:604-620`）；两条路径都守“同一批输入一个回合”。
- ⚠️ **文档与代码不一致**：已删的 `docs/manual-test-wecom.md` §8.5 让排查 `FSHINE_INBOUND_DEBOUNCE_MS`/`waitForBurstSettle`（“宿主 burst 稳定器最多 4×2s”）。现行生产代码零命中；`FSHINE_INBOUND_DEBOUNCE_MS` 只出现在“已删环境键、不再派生”的守护测试里（`packages/agent/resource-policy-single-source.test.ts:73-79`、`packages/core/config.test.ts:474-477`），`waitForBurstSettle` 只在历史档。`adapter.ts:50-52` 的“D-108 burst 稳定器”注释是陈旧指向。今天的 8s 只是下载等待，不是宿主防抖。
- 覆盖：`packages/channel-wecom/adapter.merge-window.test.ts:162-317`（8 例）；`scripts/eval/wecom-sim/cases-d-attachment.test.ts:38-171`（W-13～W-18）。

## 4. 纯附件回执与 30s 追问的分工

同一条“只发文件不说话”的消息会产生**两条**不同职责的气泡，机制分属两层：

| | 渠道回执 | 宿主追问 |
|---|---|---|
| 触发 | 纯附件回合交付后进入收据并窗 | 纯附件登记成功，30s 内该会话无新消息 |
| 时间 | `RECEIPT_COALESCE_MS = 2_000`（并窗到点） | `runtime.attachmentNudgeAfterMs`，缺省 30_000，0=关闭（`packages/agent/src/resource-policy.ts:193,322-324`） |
| 文案 | `formatFileAck`：只报「已收到 N 个文件」，**不带名**（`packages/contracts/src/channel.ts:70-73`；`adapter.ts:1048`） | 「刚才这 N 个文件：<名…>。你想让我先做什么？回复数字即可：」+ 2~4 业务选项（`attachment-nudge.ts:104-119`） |
| 送达条件 | 渠道闸门 / 终帧降级纪律 | 仅单聊；10 分钟冷却；非 live 只记 `attachment_nudge_suppressed`、不记 sent（`attachment-nudge.ts:188-310`） |
| 副作用 | 无 | 同一份选项作为**系统注记**入队，下一回合模型可见（`attachment-nudge.ts:303-305`；`server.ts:263-274`） |

- 任何新入站消息取消待发追问；非附件消息丢弃本批；纯附件消息并入同批并重新计时（`attachment-nudge.ts:204-230`）。
- 分工理由：回执说“收下了”，追问说“是哪几个 + 下一步”，避免两份几乎相同的清单（`channel.ts:53-57`）。
- ⚠️ **文档与代码不一致**：`formatFileReceipt`（带文件名）只有定义与注释，**无生产调用点**（全仓 `grep` 仅命中 `channel.ts:62` 与注释）。已删的 `manual-test-wecom.md` §8.4/§8.8 所称“带指令回合首帧收据（带文件名）”在现行代码中不存在：带指令回合不发「已收到」气泡，文件名经 manifest 交给模型。
- 覆盖：`apps/server/server-attachment-nudge.test.ts:292-500`（12 例）；`scripts/eval/wecom-sim/cases-d-attachment.test.ts:65-171`。

## 5. silent 闸与 `channel.mode` 三档

三档只来自 yaml；每档都把出站模式**显式**传给适配器，不依赖缺省：

| 档位 | 长连接 | 出站模式 | 行为 | 指针 |
|---|---|---|---|---|
| `offline`（缺省） | 不 `start` | `silent` | 不认证、不建 WS；投递一律 suppressed | `config.ts:253`；`channel-mode.ts:52-59` |
| `shadow` | 建连 | `silent` | 入站照收、回合照跑，六类用户可见发送全部被闸 | `channel-mode.ts:36-49`；`adapter.ts:281-282` |
| `live` | 建连 | `live` | 真实投递（改动前语义） | 同上 |

- 解析：显式 `live` → live；显式 `silent|shadow` → silent；显式非法或缺失 → silent（fail-safe）；仅当显式缺失时才看环境开关 `FSHINE_WECOM_DELIVERY`，且必须逐字 `live`（`packages/channel-wecom/src/silent-shadow-gate.ts:35,49-56`）。适配器对“未声明/非法”另发 `wecom_delivery_mode_undeclared`（`adapter.ts:268-283`）。
- 机械覆盖：闸门包在客户端工厂出口上，`start()` 建出的客户端即被闸替身（`adapter.ts:265-282`），因此所有出站路径只经 `this.client`，不逐条堵。
- 拦：`replyStream / sendMessage / sendMediaMessage / replyMedia / uploadMedia`；放行：`on / connect / disconnect / downloadFile`（`silent-shadow-gate.ts:29-32,129-160`）。
- 证据：每次抑制记 `SuppressedSend`（时间/方法/是否可见/字节数，**不含正文**）+ `wecom_silent_shadow_suppressed`；`shadowEvidence()` 返回 mode/抑制数/事件（`silent-shadow-gate.ts:163-174`；`adapter.ts:378-388`）。
- 反向绊线：缺省静默、显式 live 必真发、环境开关只认逐字 `live`、`wrap` 在 live 原样返回（`adapter.silent-shadow.test.ts:251-459`）；档位不能被环境开关覆盖（`apps/server/channel-mode.test.ts:242-261`）。

## 6. 出站六路与主动投递面

六类用户可见路径全部落在唯一客户端上——这是闸门能机械覆盖的前提：

| # | 路径 | 触发 | 底层调用 | 指针 |
|---|---|---|---|---|
| ① | 同步回帧 ACK | 非纯附件消息到达 | `replyStream` | `adapter.ts:573` |
| ② | 进度帧 | handler 调 `progress()`；3s 节流、4 帧上限、首帧豁免 | `replyStream` | `adapter.ts:57-58,732-742` |
| ③ | 终态 | handler 返回文本 | `replyStream(finish=true)` | `adapter.ts:802` |
| ④ | 异常兜底 | handler 抛错 → `FALLBACK_REPLY`；附件等待超时；图片失败 | `replyStream` | `adapter.ts:773-780,627-633,842` |
| ⑤ | 拒绝 | 宿主未开通 principal 返回文案 | 走 ③ 同一终帧 | `server.ts:616-619` |
| ⑥ | 主动消息 | `sendToConversation` 文字/文件（任务完成、追问） | `sendMessage` + `uploadMedia` + `sendMediaMessage` | `adapter.ts:391-486` |
| 补 | 计划通知（当前宿主 handler 只用 `message` 入参，未调用） | handler `notice()` | `replyStream(finish=false)` | `adapter.ts:744-767` |

- 文件/图片回传：`uploadMedia` + `replyMedia`，单个失败只记事件不外抛（`adapter.ts:813-845`）。
- 终帧降级：`replyStream` 失败且 `finish=true` 时改走 `sendMessage`，同一次回复只降级一次（`adapter.ts:1060-1096`）；再失败记 `wecom_reply_degrade_fail`。
- 主动投递面（宿主）：`fileDelivery.sendToConversation` 发文件、`sendText` 发文字（`main.ts:64-68`）；非 live 由宿主先行记 suppressed，不采信闸门的假回执（`server.ts:501-604`）；任务完成投递与追问同端口（`server.ts:306-330`；`apps/server/task-completion-delivery.ts:49-104`）。

## 7. 事件目录（渠道面）

按发出点分组；名字即 `event` 字段逐字值。宿主全量 29 个事件见 `docs/product/event-catalog.md`。

| 发出点 | 事件（指针） |
|---|---|
| `adapter.ts` 出站 / 连接 | `wecom_delivery_mode_undeclared`:274；`wecom_dispatch_fail`:336；`wecom_reply_truncated`:421/753/791；`wecom_notice_fail`:763；`wecom_handler_error`:776；`wecom_file_fail`:821；`wecom_image_fail`:837；`wecom_reply_fail`:1069；`wecom_reply_degraded`:1085；`wecom_reply_degrade_fail`:1093；`wecom_media_fail`:1114 |
| `silent-shadow-gate.ts` | `wecom_silent_shadow_suppressed`:170（每次抑制，含 kind/userVisible/bytes） |
| 纯附件追问 | `attachment_nudge_suppressed`:290；`attachment_nudge_sent`:299；`attachment_nudge_failed`:308 |
| 入站 / 回合（`server.ts`） | `message_refused`:618；`message_duplicate_replayed`:628；`inbound_attachment_too_large`:653；`message_attachment_only`:682；`inbound_files_registered`:692/739；`pending_files_activated`:750；`message_done`:808；`message_done_log_write_failed`:826 |
| 文件投递（`server.ts`） | `file_delivery`:514/519/575/588（status=`delivery_unavailable`/`suppressed`/`delivery_failed`/`sent`）；`file_delivery_log_write_failed`:592 |
| 任务完成投递 | `task_result_delivery_suppressed`:63/72/83；`task_result_delivery_sent`:93；`task_result_delivery_failed`:101 |
| 进程 | `server_started`（`channel-mode.ts:66` 构造，`main.ts:81` 打印）；`server_shutdown`（`main.ts:93`） |

- 判读纪律：`file_delivery.status` 只有 `sent` 表示真实送达；`suppressed` 在 silent 部署是正常事实，不是失败（`server.ts:512-530`）。
- `wecom_*` 用 `console.warn/error` 直写，不经宿主 logger；按事件名采集需劫持 console（`docs/product/event-catalog.md` §七）。

## 8. 核对与验证入口

- 渠道机制确定性测试：`packages/channel-wecom/adapter.merge-window.test.ts`、`adapter.silent-shadow.test.ts`、`adapter.test.ts:1053-1165`（收据并窗）、`apps/server/channel-mode.test.ts`、`apps/server/server-attachment-nudge.test.ts`。
- 真装配 + 假 SDK 的端到端：`scripts/eval/wecom-sim/`（`harness.ts` + `cases-{a..g}`，D 组覆盖附件时序），入口 `TMPDIR=~/.tmp node --import tsx scripts/eval/wecom-sim/run.ts`（`docs/product/wecom-live-dummy-cases.md:291-320`）。
- 本页核对实跑：`export TMPDIR=/home/tao/.tmp && npx vitest run packages/channel-wecom/adapter.merge-window.test.ts packages/channel-wecom/adapter.silent-shadow.test.ts apps/server/channel-mode.test.ts apps/server/server-attachment-nudge.test.ts` → 4 files / 50 tests passed。
- 未验证：真实企微网络时序与真机气泡观感仍需 live 人工面（`wecom-live-dummy-cases.md` H 组）；本页不把静态/离线结论读作已联调。

## 来源

- `docs/manual-test-wecom.md`（已删）：保留附件收据/30s 追问分工、真机时序不可替代的边界；其 `FSHINE_INBOUND_DEBOUNCE_MS` 与“首帧带文件名收据”两条已与现行代码不符，按代码更正。
- `docs/product/b2-silent-shadow-gate.md`（已删）：保留闸门出口覆盖、六类路径矩阵、fail-safe 与反向绊线。
- `docs/product/r5-wecom-shadow-readonly-admission.md`（已删）：保留入站/出站面审计口径与“入站已实现、主动推送未接 outbox”的事实；其“渠道影子隔离无机械门”已被 B2 闸门取代，不再作为现状。
- `docs/product/wecom-live-dummy-cases.md`（活）：保留 D 组附件时序用例与自动/人工分工。
- `docs/product/event-catalog.md`（活）：保留事件判读口径与 `wecom_*` 走 console 的采集纪律。
