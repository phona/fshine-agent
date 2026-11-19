# 渠道适配（企微）

> 状态：现行。2026-11-18 核对；渠道三档、silent 闸、附件合并窗均已实施；真实企微联调仍需独立测试租户（issue #74）。
> 最后核对：2026-11-18（`path:line` 以现行代码为准；实施过程与真机踩坑记录在 git 历史）。
> 上游指针：`packages/channel-wecom/src/adapter.ts`（唯一渠道适配器）、`apps/server/channel-mode.ts`（三档装配）、`apps/server/attachment-nudge.ts`（30s 追问）、`docs/product/wecom-live-dummy-cases.md`（联调用例）。

## 1. 职责与装配入口

渠道层是官方 `@wecom/aibot-node-sdk` 的薄封装：认证/心跳/重连归 SDK（`packages/channel-wecom/src/adapter.ts:1128-1136`），本层只做 env 校验、入站归一化、附件落盘、出站帧整形与闸门。`start()` 缺 `WECOM_BOT_ID`/`WECOM_BOT_SECRET` 即拒启（`:293-298`），只订阅 `message.text / message.file / message.mixed`（`:332-341`）。

**身份不在渠道层派生**：适配器只给 `channel: 'wecom'` + `wecomUserId` + `conversationId` + `chatType`（`:668-685`）；宿主按 `chatType` 分流派生——1:1 `principalId = <channel>:<userid>`，群聊 `principalId = <channel>:group:<conversationId>`（群 = 独立主体，同群所有人共用一个主体；发言人只作审计 `speakerId`），`sessionId = <channel>:<conversationId>`；未开通 principal（群主体同样是名单里的 key，需显式开通）直接拒绝，走同一条拒绝路径（`apps/server/server.ts:779-790`）。档位只在 yaml `channel.mode`（`packages/contracts/src/config.ts:248-261`），无 `FSHINE_*` 覆盖口；`apps/server/main.ts:52-68` 按档位构造渠道并注入投递端口（`:79` 启动）。渠道层不判业务、不建实体授权门。

## 2. 入站归一化

`dispatchMessage` 只处理三类消息，其余（image/voice/video/event）静默忽略（`packages/channel-wecom/src/adapter.ts:553`）。`text` 取 `text.content`；`mixed` 只按序拼 `msg_item` 里的 text 项（`:478-497`）。会话键：单聊 `conversationId = userid`、群聊 `= chatid`（`:567`），群聊正文剥离开头 @机器人（`:677`）。无正文或正文去空白为空 → `attachmentOnly: true`（`:568`），宿主只登记、不启模型回合。

只接受 file 消息：文件名 basename 化 + 控制字符剥离 + 128 字符截断（`:538-544`）；单附件 >32MB 不落盘、进 failed（`:93`、`:523-526`）；下载失败不抛，转成 `[附件下载失败:…]` 文本（`:657-662`）。宿主二次上限：登记前 `bytes > 20MB` 整条消息拒绝、零登记零回合（`apps/server/server.ts:648-666`；常量 `packages/agent/src/file-store.ts:319`）。载荷 `IncomingChannelMessage` 携带 `messageId/chatType/text/attachments/receivedAt`（`packages/channel-wecom/src/adapter.ts:668-685`；契约 `packages/contracts/src/channel.ts:75-121`）。

## 3. 附件时序：8s 等文件 / 3s 合并窗 / 5s 上限

- **文字先到**：正文等待同会话在途附件处理（下载 + 交 handler 暂存）后继续；`ATTACHMENT_WAIT_TIMEOUT_MS = 8_000`，总上界从正文首次等待起算；超时回「附件尚未准备好,请稍后重试」终帧，**不调 handler**（`packages/channel-wecom/src/adapter.ts:53`、`:604-635`、`:861-891`）。此等待不是宿主防抖。
- **文件先到**：纯附件进合并窗，窗口内来的文字与附件合成一次 handler 调用；续期 3s、总上限 5s（起点+5s）、>5 个或 >25MB 立即 flush；到点无文字 → 按纯附件回合交付（宿主只登记）（`packages/channel-wecom/src/adapter.ts:84-90`、`:907-993`）。续期取 `min(now+3s, 起点+5s)`，不会无限后移（`:919-926`）；已有合并窗时文字并入、不再新开（`:604-620`）。
- ⚠️ 已删的 `FSHINE_INBOUND_DEBOUNCE_MS` / `waitForBurstSettle`（旧「4×2s burst 稳定器」）现行生产代码零命中，只在「已删环境键」守护测试里出现（`packages/agent/resource-policy-single-source.test.ts:73-79`）；`packages/channel-wecom/src/adapter.ts:49-52` 的「D-108 burst 稳定器」注释是陈旧指向。
- 覆盖：`packages/channel-wecom/adapter.merge-window.test.ts:154-329`；`scripts/eval/wecom-sim/cases-d-attachment.test.ts:38-209`。

## 4. 纯附件回执与 30s 追问的分工

同一条「只发文件不说话」的消息会产生两条不同职责的气泡：**渠道回执**说「已收到 N 个文件」（`RECEIPT_COALESCE_MS = 2_000`，不带文件名，`packages/contracts/src/channel.ts:79-82`；`packages/channel-wecom/src/adapter.ts:1048`）；**宿主追问**在登记成功且 30s 内该会话无新消息时发「刚才这 N 个文件：<名…>。你想让我先做什么？」+ 3~4 个业务选项（`runtime.attachmentNudgeAfterMs` 缺省 30_000，0=关闭，`packages/agent/src/resource-policy.ts:193`、`:322-324`；`apps/server/attachment-nudge.ts:104-149`）。追问仅单聊、10 分钟冷却；非 live 只记 `attachment_nudge_suppressed`、不记 sent（`apps/server/attachment-nudge.ts:218-313`）；同一份选项作为系统注记入队，下一回合模型可见（`:303-305`；`apps/server/server.ts:261-274`）。

任何新入站消息取消待发追问；非附件消息丢弃本批；纯附件并入同批并重新计时（`apps/server/attachment-nudge.ts:199-210`、`:218-254`）。回执并窗从第一条附件-only 回合起算，后续只追加、不续期（`packages/channel-wecom/src/adapter.ts:1010-1023`）。纯附件路径宿主不消费 `message.text`，下载失败项不进回执/追问（`apps/server/server.ts:668-721`）；全部失败时用户侧静默——现行行为，未定义专门话术。

> ⚠️ `formatFileReceipt`（带文件名）只有定义与注释，**无生产调用点**：2026-11-19 起正文回合**不再发受理帧**（「收到,正在处理…」那张卡片已删，owner 判定无用），文件名以 `[附件:<名>]` 拼进入站正文（`packages/channel-wecom/src/adapter.ts:662`）。`packages/contracts/src/channel.ts:53` 与该文件 `:191` 的旧说法以代码为准。

## 5. silent 闸与 `channel.mode` 三档

三档只来自 yaml；每档都把出站模式**显式**传给适配器（`apps/server/channel-mode.ts:52-59`）。`offline`（缺省）：不 `start`，出站 `silent`，投递一律 suppressed（`packages/contracts/src/config.ts:253`；`apps/server/channel-mode.ts:57`）；`shadow`：建连、入站照收、回合照跑，六类用户可见发送全被闸（`apps/server/channel-mode.ts:36-49`；`packages/channel-wecom/src/adapter.ts:281-282`）；`live`：真实投递。

解析 fail-safe：显式 `live` → live；显式 `silent|shadow` → silent；显式非法或缺失 → silent；仅当显式缺失才看环境开关 `FSHINE_WECOM_DELIVERY`，且必须逐字 `live`（`packages/channel-wecom/src/silent-shadow-gate.ts:49-57`）。闸门包在客户端工厂出口（`packages/channel-wecom/src/adapter.ts:281-282`），所有出站路径只经 `this.client`，不逐条堵。拦：`replyStream / sendMessage / sendMediaMessage / replyMedia / uploadMedia`；放行：`on / connect / disconnect / downloadFile`（`packages/channel-wecom/src/silent-shadow-gate.ts:137-161`）。每次抑制记 `SuppressedSend`（时间/方法/可见性/字节数，**不含正文**）+ `wecom_silent_shadow_suppressed`；`shadowEvidence()` 只返进程内快照，不落盘（`:165-176`；`packages/channel-wecom/src/adapter.ts:378-385`）。反向绊线：缺省静默、显式 live 必真发、环境开关只认逐字 `live`（`packages/channel-wecom/adapter.silent-shadow.test.ts:251-456`）；档位不能被环境开关覆盖（`apps/server/channel-mode.test.ts:241-253`）。

## 6. 出站六路与主动投递面

六类用户可见路径全部落在唯一客户端上（闸门能机械覆盖的前提）：① 同步回帧 ACK（`packages/channel-wecom/src/adapter.ts:573`）；② 进度帧（3s 节流、4 帧预算、首帧不占预算，`:55-56`、`:732-741`）；③ 终态 `replyStream(finish=true)`（`:802`）；④ 异常兜底 `FALLBACK_REPLY`/附件等待超时/图片失败（`:773-780`、`:626-635`、`:840-843`）；⑤ 拒绝（宿主未开通 principal，走 ③ 同一终帧，`apps/server/server.ts:618-620`）；⑥ 主动消息（回合末文件投递、任务完成、追问，`packages/channel-wecom/src/adapter.ts:391-471`）。计划通知 `notice()` 当前宿主 handler 未调用（`:744-768`）。

终帧降级：`replyStream` 失败且 `finish=true` 时改走 `sendMessage`，同一次回复只降级一次（`:1054-1102`）。文件/图片回传：`uploadMedia` + `replyMedia`；文件失败只记事件不外抛，图片失败且本轮无正文时补发「图片发送失败,请稍后再试」（`:815-847`）；主动交付只支持文字与文件（`:402-403`）。宿主主动投递面：`fileDelivery.sendToConversation` / `sendText`（`apps/server/main.ts:63-69`）；非 live 由宿主先行记 suppressed，不采信闸门的假回执（`apps/server/server.ts:517-527`；`apps/server/task-completion-delivery.ts:102-148`）。通知 outbox：落盘 sink 做审计（`apps/server/notification-file-sink.ts:11`），另有聊天推送 sink 把 `waiting_user`/`timed_out`/`resource_limited` 三类推回原会话（`apps/server/notification-chat-sink.ts`）——`completed` 归完成投递、`failed` 归失败唤醒出口、「用户说停」（`cancelled`）归取消唤醒出口；**2026-11-19 唤醒切片起：完成/失败/取消/久无动静/重启对账四条状态变化都由宿主喂事实、唤醒原会话模型、投递它说的话**（宿主常规文案已删，只留「模型回合挂掉」的兜底句；统一出口 = `apps/server/server.ts` 的 wakeStateChangeText/wakeAndDeliverStateChange + `packages/agent/src/pi-driver.ts` 的驱动侧 wake；驱动实例级会话还没建时本层补一次零工具单回合）；同回合已交给模型的不重复发，**非 live 部署不唤醒（零模型调用）、只记 suppressed 不记 sent**，事实一律留待下次注入。

## 7. 事件目录（渠道面）

`wecom_*` 走 `console.*` 直写、不经宿主 logger（`packages/channel-wecom/src/adapter.ts:274`、`:336`、`:1084`），按事件名采集需劫持 console。分组指针：适配器构造/入站/出站（`packages/channel-wecom/src/adapter.ts:274` 起）；silent 抑制（`packages/channel-wecom/src/silent-shadow-gate.ts:170`）；追问（`apps/server/attachment-nudge.ts:290-308`）；入站/回合（`apps/server/server.ts:618` 起）；文件投递（`apps/server/server.ts:514-592`）；任务完成投递（`apps/server/task-completion-delivery.ts:91` 的事实拼装 + `:110` 的降级兜底句 + `:187` 的投递记账）；进程（`apps/server/main.ts:81`、`:93`）。

**判读纪律**：`file_delivery.status` 只有 `sent` 表示真实送达；`suppressed` 在 silent 部署是正常事实，不是失败（`apps/server/server.ts:512-530`）。`docs/product/event-catalog.md` 基线 `23ae585`、未收录 `attachment_nudge_*`/`task_result_delivery_*`/`recalc_*`，排障以代码为准。

## 8. 核对与验证入口

渠道机制确定性测试：`packages/channel-wecom/adapter.merge-window.test.ts`、`adapter.silent-shadow.test.ts`、`packages/channel-wecom/adapter.test.ts:1037-1162`、`apps/server/channel-mode.test.ts`、`apps/server/server-attachment-nudge.test.ts`；附件时序端到端（真 `createServer` + dummy 执行层 + 假 SDK）`scripts/eval/wecom-sim/cases-d-attachment.test.ts`。**未验证**：真实企微网络时序与真机气泡观感仍需 live 人工面（`docs/product/wecom-live-dummy-cases.md:291-320`）；适配器没有时钟注入缝（3s/2s 是真实定时器，仅 3s 合并窗长度可用构造参数收紧，`packages/channel-wecom/src/adapter.ts:170-175`），不把离线结论读作已联调。

## 9. 信任边界与残余风险

适配层**不做签名校验**：`userid` 直接取自 SDK 帧，宿主没有第二道机械校验，身份可信性完全依赖企微 SDK 与 token 认证（`docs/history/decision-log-part04-2026-11.md:131`；实现 `packages/channel-wecom/src/adapter.ts:668-685`）。排障含义：principal 判错时先查「这条帧是谁转进来的」，而不是查宿主的身份映射。
