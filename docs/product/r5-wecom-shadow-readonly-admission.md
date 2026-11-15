# R5 真实企微「只读影子 E2E」准入审计

> **硬声明（调查 ≠ 授权接入）**：本档是**准入审计**，owner 于 2026-11-15 只授权「调查、不接入生产」。
> 本轮**不授权真实企微生产接入、不授权真实业务写操作、不接真实企微/真实 SaaS、不开放新写操作、零真实模型调用**。
> 本档只回答一件事：**要在今天跑通一条「真实企微入站 + dummy 执行层 + 用户可见出站受控」的只读影子链路，缺什么、哪些已就绪、最小接入面是什么**。
> 结论**不构成**已授权接入，也不得读作安全结论。
>
> - 分支/worktree：`arch/r5-wecom-audit` @ `~/projects/fshine-agent-r5-wecom-audit`（基线 = `arch/integration` 启动时 HEAD `b0606db`）。
> - 口径：docs-only；产品代码零改动；`.runtime` 不入库；不改 `docs/decision-log.md`（集成 Agent 单点写）。
> - 判据纪律：每个面给「**已实现 / 仅接口 / 缺失**」三分类并附 `文件:行号` 证据；**接口/类型/函数存在一律不读作能力已实现**（本轮实际出现了一个反向案例：**入站能力有真实实现**，见 ①）。
> - 与既有就绪件的关系：`docs/product/real-read-readiness.md`（三步接入设计与安全评审）、`docs/product/real-shadow-runbook.md`（执行面双源 shadow，**不接渠道**）、`docs/product/r4-shadow-dryrun.md`（双源读数）。本档专审**企微入站/出站面**——即上述就绪件明确排除的「渠道面」。
> - **证据复核（本次）**：本档所有 `文件:行号` 引用由本会话对 worktree `arch/r5-wecom-audit` 逐条重读源码核验（`grep -n` / `sed -n`，见各结论旁证据）；行号以本分支当前工作树为准。**未做联调**：本档为静态审计，未启动 server、未连企微、未跑真实模型。

## 0. 结论摘要

| # | 面 | 结论 | 一句话 |
|---|---|---|---|
| ① | 入站能力 | **已实现**（真实实现，非仅接口） | `WecomBotChannel` 官方 SDK 薄封装，已在 `main.ts` 接线；但**无「只读影子/入站-only」开关**，装配即会向真实用户回帧 |
| ② | 身份与 principal 映射 | **已实现（最小）+ 登记缺口** | `principalId = <channel>:<userid>`，`enabled` 门在宿主；身份取自渠道帧，宿主信任 SDK 边界；跨渠道独立授权未实现（D-112） |
| ③ | 会话路由 | **已实现** | `(principalId, sessionId)` 双键会话缓存 + 同会话串行化 + 同 messageId 幂等重放；群聊按 principal 隔离 |
| ④ | 出站 NotificationSink | **缺失（真实企微 = 0）** | 只有渠道无关「落盘 sink」；真实企微 sink 未实现、未接线。`sendToConversation`（主动推送）是真实实现但**从 outbox 不可达** |
| ⑤ | 回执 | **部分实现** | 入站 ack/进度/终帧/降级/附件收据已实现；出站端**无真实企微投递回执**（无 sink）；入站 ack 是流帧不是持久回执 |
| ⑥ | 授权与测试环境隔离 | **已实现（宿主侧最小）+ 一处缺口** | 宿主只留 `enabled` + 只读允许集合 + worker env 白名单 + 评测 safety-gate；但**「渠道影子隔离」只有文字纪律，无机械门** |

**总判定**：入站面**就绪度高**（真实实现已接线）；出站通知面**完全缺失**（真实企微 sink = 0）；「只读影子」形态**今日缺一个机械闸**——现有装配是「接真凭据即向真实用户回帧」的生产形态，不是一个默认不产用户可见结果的影子形态。因此**可进只读短会话影子的硬件在前，但需 owner 逐项授权 + 选独立测试租户/收件人 + 补一条影子隔离判定**，见 §3、§4。

---

## 1. 审计口径：「只读影子」定义

**只读影子 E2E（本轮准入对象）**：真实企微**测试租户**入站消息 → 宿主 → **execution 面 = 仓内 dummy（不触真实平台）** → 用户可见出站**受控**（只落测试租户/落盘，绝不到达真实业务用户）→ 证据落盘（executions 底账 + 执行层 audit + notifications.jsonl）。

与「长期业务试用」的区别见 §5。本轮**只判定能否进「短会话只读影子」**，不判定长期试用。

---

## 2. 六个必查面逐条

### ① 入站能力 — 结论：**已实现**（真实实现，非仅接口）

**已实现（真实企微入站）**

- `WecomBotChannel` 类：`packages/channel-wecom/src/adapter.ts:162`；实现 `ChannelAdapter`（`packages/contracts/src/channel.ts:199-204`）。
- 官方 SDK 薄封装：`@wecom/aibot-node-sdk` 为真实依赖（根 `package.json` `dependencies`），默认工厂建真实 `WSClient`：`packages/channel-wecom/src/adapter.ts:832-841`。
- 启动/连接/订阅/超时/释放：`adapter.ts:192-255`；订阅三类事件 `message.text / message.file / message.mixed`：`adapter.ts:231-240`。
- 缺凭据即拒启（fail-closed）：`adapter.ts:194-197`（缺 `WECOM_BOT_ID`/`WECOM_BOT_SECRET` 抛错）。
- 消息归一化 → `IncomingChannelMessage`：`adapter.ts:430-533`（`userid`/`conversationId`/`messageId`/`text`/`attachments` 组装见 `:516-533`）。
- 附件下载落盘（file 消息，basename 化 + 大小上限 + 失败不抛）：`adapter.ts:392-428`。
- **已在生产入口接线**：`apps/server/main.ts:45` `new WecomBotChannel(...)` → `:46` `channel.start(server.handler)`。

**仅接口 / 声明但未消费**

- `config.channel.port` / `callbackPath`（HTTP 回调形态）在 `packages/core/src/config.ts:398-407` 解析，但 V0 走 WebSocket 长连接，**无消费方**（`config.ts:404` 注释明示）。
- 契约 `ChannelAdapter.sendToConversation?` 为可选主动交付面（`channel.ts:203`）——见 ④。

**缺失**

- **无「只读影子 / 入站-only / 出站抑制」开关**：装配 `start(server.handler)` 后，适配器对每条非附件消息**先发受理帧**（`adapter.ts:457`）、**发进度帧**（`adapter.ts:547-558`）、**发终帧**（`adapter.ts:617`）；阻塞流帧被拒还会降级为**主动新消息**（`adapter.ts:790-809`）。即：**一旦凭据接入，产物必定回到发起消息的会话**，无影子形态下的「只入不出」路径。
- 无独立测试租户/收件人概念（隔离靠凭据与操作纪律，非代码开关）。

**判定**：真实企微入站**不是「只有接口无实现」**——实现在且已接线。可进影子的硬件在；缺的是「影子形态」而非「入站能力」。

---

### ② 身份与 principal 映射 — 结论：**已实现（最小）+ 登记缺口**

**已实现**

- 渠道身份在源头显式给出：`adapter.ts:439-441`（`from.userid`）、`:521`（`channel: 'wecom'`）。
- 契约字段：`IncomingChannelMessage.wecomUserId` / `channel` / `conversationId`（`packages/contracts/src/channel.ts:68-92`）。
- **可信身份由宿主派生、非模型输入**：`apps/server/server.ts:215-218`
  `principalId = <channel>:<wecomUserId>`、`sessionId = <channel>:<conversationId>`。
- **准入门（fail-closed）**：`server.ts:219-223`——`config.principals[principalId]` 不存在或 `enabled !== true` 即拒绝并回「未开通使用权限」。
- 名单解析：`packages/core/src/config.ts:275-289`（`enabled` 缺省 false）；模板说明 `config/agent.example.yaml`（`key = <渠道>:<用户ID>`；**UserID 来源 = 机器人收到的 `from.userid`（明文）**）。

**仅接口 / 未实现**

- 跨渠道独立授权**未实现**：契约自述 `channel` 前缀「当前授权存储仍以原始用户 ID 为键……尚未实现渠道间独立授权（D-112）」（`channel.ts:80-83`）。

**缺失 / 信任边界（须在影子准入里明说）**

- **无适配层签名校验**：`userid` 直接取自 SDK 回调帧（`adapter.ts:439-441`），适配器**不独立验证**来源真实性——信任边界落在官方 SDK 的认证之上。宿主侧无可信身份的第二道机械校验，`principalId` 后半段**完全等于渠道上报字符串**。
- 因此「可伪造性」的答案取决于 SDK 认证面：在 SDK 认证边界内，身份按面值采信；宿主层面**没有**能识别伪造帧的机制。影子阶段必须把这一点计入风险（§3 风险）。

**判定**：映射与准入门已实现且最小可信（宿主不建实体门，符合 AGENTS.md）。但对「真实渠道身份可信」的保证是**传递性**的（依赖 SDK），须在影子准入里作为显式残余风险登记。

---

### ③ 会话路由 — 结论：**已实现**

**已实现**

- 会话按 `(principalId, sessionId)` 双键缓存，群聊不同用户不共享会话对象：`server.ts:145-179`（key `principalId\u0000sessionId`，`:147`）；注释明示「群聊里不同用户不共享同一个会话对象」（`:144`）。
- 同会话串行化（promise 链，前序失败不阻塞后续）：`server.ts:186-198`；派发点 `server.ts:238-241`。
- 渠道重投幂等（同 messageId 只产生一次回执、按既有回执重放、查重先于副作用、失败不缓存）：`server.ts:205-212` + `:229-265`。
- conversationId 推导：单聊 = `userid`，群聊 = `chatid`（`adapter.ts:450-451`）；群聊正文剥离 @机器人（`adapter.ts:525`）。

**仅接口 / 未实现**：无独立「路由器」机制——路由是宿主确定性键，符合 AGENTS.md「禁止新增 Router」（非缺口，是纪律）。

**缺失**：无跨用户会话隔离的**独立测试证据**（群聊隔离在确定性单测覆盖，但影子阶段无真实跨用户样本，见 §5）。

**判定**：一条消息路由到哪个会话/任务、如何隔离不同用户，**已实现且是最小确定性键**（非模型/规则引擎）。

---

### ④ 出站 NotificationSink — 结论：**缺失（真实企微 = 0）**

**已实现（渠道无关面）**

- `NotificationSink` 接口：`packages/agent/src/notifications.ts:131-133`（`send(notification) → DeliveryReceipt`）。
- outbox（落同库 + 去重 + 有界重试 + 未送达可见）：`notifications.ts:379-489`（`record` `:456-470`、`deliverPending` `:471-478`、`deliverOnce` `:411-453`）。
- **唯一真实 sink = 渠道无关落盘 sink**：`apps/server/notification-file-sink.ts:11-38`（JSON Lines 追加，写失败返回 `delivered:false`，不抛）。
- 生产接线：`apps/server/main.ts:38-44`——`notificationSink: createFileNotificationSink(...)`；注释明示「**真实企微 sink 仍 blocked，不接真实平台**」（`main.ts:38`、`notification-file-sink.ts:2`）。
- 通知文案渲染（纯函数）：`packages/agent/src/notification-render.ts:57`。

**仅接口 / 存在但不可达**

- `WecomBotChannel.sendToConversation(route, reply)`**是真实主动推送实现**（`adapter.ts:275-355`：文字先发、文件逐个上传回传、返回 `DeliveryReceipt`）。但**从 outbox 不可达**：全仓 `sendToConversation` 引用仅出现在 `adapter.ts`、契约 `channel.ts:203` 与 `adapter.test.ts`（grep 证据，非测试无消费方）。即「主动推送能力」有实现，「通知→企微投递」这条链**没有接线**。

**缺失**

- **真实企微 `NotificationSink` 实现 = 0**：全仓非测试 `NotificationSink` 实现只有落盘 sink 一个（`notification-file-sink.ts:11`）；脚本层另有测试替身 `RecordingSink`（`scripts/shadow/double-source-harness.ts:45`）与 `InjectingSink`（`scripts/stab/fakes.ts:205`），均为记录/注入假件，不是真实投递。无任何把 `Notification` 渲染 `renderNotification` 后经企微送达的 sink。
- `renderNotification` 当前唯一非测试消费点是 R5 B 通道的**进程内经会话注入**（`scripts/ask-runtime.ts:388`），**不是**企微出站。

**判定**：**不得把「sink 类型/函数存在」读作能力已实现**。真实企微出站通知投递**今天为 0**——影子阶段出站通知只能落盘（`notifications.jsonl`），这对「只读影子」是**合格**的（影子本就不要真实通知外发）。

---

### ⑤ 回执 — 结论：**部分实现**

**已实现（入站 ack / 回帧）**

- 受理帧文案与发送：`adapter.ts:35`（`ACK_TEXT='收到,正在处理…'`）、`:457`（`reply(..., false)`）。
- 进度帧（节流 + 帧数上限 + 首帧豁免）：`adapter.ts:45-46`、`:547-558`。
- 终帧：`adapter.ts:617`；终帧被拒降级为主动新消息：`adapter.ts:790-809`。
- 附件-only 收据并窗（到点合成一条）：`adapter.ts:712-762`、`:749-762`。
- 失败降级/截断守夜事件：`:576-583`、`:604-612`。

**已实现（回执形状，但未接线）**

- `DeliveryPartReceipt` / `DeliveryReceipt` / `ChannelDeliveryError`：`packages/contracts/src/channel.ts:160-184`；实现 `adapter.ts:93-114`、`sendToConversation` 返回 `:275-355`——但仅 `sendToConversation` 产出，而它不可达（见 ④），故**用户可见回复路径没有渠道级回执链**。
- 通知 sink 回执：`notifications.ts:124-128`（`delivered` 布尔）；落盘 sink 写成功即 `delivered:true`（`notification-file-sink.ts:32`）。

**缺失**

- **无真实企微出站投递回执**（无真实企微 sink，自然无进出站投递确认）；无出站投递状态台账。
- 入站 ack 是**流式帧**，不是持久回执——入站侧的可核账只有宿主 `messageReplies` 幂等重放缓存（`server.ts:205-212`，内存有界，进程重启即失效）。

**判定**：入站侧回执齐；出站侧无渠道级回执。影子阶段（出站落盘）可接受。

---

### ⑥ 授权与测试环境隔离 — 结论：**已实现（宿主侧最小）+ 一处缺口**

**已实现**

- 宿主准入门（身份 `enabled`）：`server.ts:219-223`。
- 只读允许集合**确定性拒绝**（不依赖模型遵守提示词）：`packages/agent/src/execution-runtime.ts:454-456`、`:778-779`（集合外 operation 在**发起执行前**抛错）；集合非空且 ⊆ 快照，否则构造即失败：`execution-runtime.ts:324-334`、`:759-766`。
- 执行子进程 env 白名单（凭据隔离，fail-closed）：`packages/agent/src/worker-env.ts:25-35`（仅 `PATH/HOME/TMPDIR`）。
- 评测隔离门（fail-closed，root 必须在仓内夹具下 + gateway 存在 + 审计通道可写回）：`scripts/eval/safety-gate.ts:17-59`。
- 影子源开关 fail-closed（未知源含 `real` 即拒）：`scripts/shadow/fixtures/execution-sources.ts:96-102`；`realConnection:false` 明示（`scripts/shadow/double-source-harness.ts:531`）。
- 既有纪律：shadow 阶段不接渠道、不产用户可见结果（`docs/product/real-read-readiness.md:80`，「影子只读（无用户流量）……不接渠道、不产用户可见结果」）。

**缺口（须在准入里明说）**

- **「渠道影子隔离」只有文字纪律，无机械门**：`safety-gate.ts` 只管**评测 run 的 execution 面**（root 是否在夹具内），**不覆盖** `apps/server/main.ts` 的真实企微入站/出站装配。没有等价于 safety-gate 的代码门能在启动时判定「本次 server 不得向真实用户出帧」。生产形态下凭据接入即出帧（见 ① 缺失），环境隔离**完全依赖凭据选择与操作纪律**。
- 测试环境与真实企微的隔离**无代码开关**：只能靠「使用独立测试租户凭据」这一运维事实。

**判定**：宿主侧授权/只读/凭据隔离机制齐备且最小；**渠道面缺一个机械隔离判定**（影子阶段靠测试租户 + 纪律兜底）。

---

## 3. 最小接入方案（要做哪几步 / 每步准入证据 / 风险与回退）

> 前提：**本方案不执行**；执行须 owner 逐项授权（§4 全勾）。原则——**能不动产品代码就不动**：影子靠「独立测试租户 + 只读名单 + dummy 执行 + 出站落盘」实现，把「不加代码开关」作为最小性约束（加抑制开关属产品代码改动，本轮 docs-only 不做，登记为可选）。

**Step 1 — 独立测试租户与只读 principal 名单**
- 动作：owner 指定一个**非生产**企微机器人/租户；`config/agent.yaml` 的 `principals` 只列**测试 UserID**（`wecom:<测试UserID>`，`enabled: true`），生产 UserID 一个都不列；机器人只有只读演示数据可见。
- 准入证据：owner 逐项授权文本；名单文件（不含任何生产 UserID）；`enabled` 门生效的机械证明（`server.ts:219-223` 拒绝未列身份）。
- 风险：误把生产 UserID 写进名单 → 真实用户可达。**回退**：改名单即可（无 schema 迁移）。

**Step 2 — 出站受控（影子不达真实用户）**
- 动作：**只**把测试租户凭据接入；出站通知保持落盘 sink（`main.ts:43` 现状，**不**接真实企微 sink）；用户可见回帧只落测试租户会话。
- 准入证据：`grep` 证明唯一非测试 `NotificationSink` 实现是 `notification-file-sink.ts`（④ 证据）；测试租户内观察回帧不出测试会话。
- 风险：测试租户若关联真实业务用户 → 回帧外泄。**回退**：撤销凭据（见 Step 6）或改测试租户成员。
- 登记：若 owner 要求**完全不出帧**，需新增「影子抑制」开关——**属产品代码改动，本轮不做**，另立切片 + 独立评审。

**Step 3 — 执行面 = 仓内 dummy 且只读**
- 动作：`contextProfiles` 指向仓内 dummy 网关（缺省即 dummy CLI）；确认允许集合非空且 ⊆ 快照。
- 准入证据：`typecheck` 与单测通过（`execution-runtime.ts:324-334` 空集合拒启）；`runtime.dispatchMode` 显式（影子建议 `background` 以验证受理/通知路径，或 `inline` 为最小）。
- 风险：误指真实执行层 checkout。**回退**：改 `root`/`gateway` 回仓内夹具。

**Step 4 — 写入面关闭（只读）**
- 动作：只开放执行层自述 `access=read` 的 operation；无写/确认/取消/产物（后续切片）。
- 准入证据：`execution-runtime.ts:454-456` 越权拒绝路径单测绿；本影子**零写尝试**（执行层 audit 无 write 行）。
- 风险：dummy 之外的真实层若声明写 → 越权拒绝路径先拦（集合外 operation 在发起执行前抛错：`execution-runtime.ts:453-456`；worker 工具面同判：`execution-runtime.ts:778-779`）。**回退**：撤列。

**Step 5 — 证据落盘**
- 动作：打开 executions 底账 + 执行层 `EXECUTION_AUDIT_PATH` + notifications.jsonl（`main.ts:43`）。
- 准入证据：`state.db` executions 行 / `audit.jsonl` 行 / `notifications.jsonl` 行可读回；`realConnection` 事实留痕。
- 风险：证据缺 → 影子结论不可信。**回退**：删 `.runtime` 证据重跑。

**Step 6 — 回退与熔断**
- 动作：停机 = 移除 `WECOM_BOT_ID/SECRET`（server **拒启**，`adapter.ts:194-197`）→ 改回纯 dummy/无渠道形态。
- 准入证据：去掉凭据后 `npm start` 抛「缺少环境变量」；`runtime.dispatchMode:'inline'`（或移除 `runtime` 段）回现行同步路径（见 `real-shadow-runbook.md` §5）。
- 风险：进程残留连接。**回退**：`SIGINT/SIGTERM` 走 `channel.stop()`（`main.ts:50-59`）。

---

## 4. 准入清单（逐项可勾；任一项不满足即停，fail-closed）

- [ ] **owner 逐项授权**：真实企微接入的平台/租户/范围/数据边界；本档**未获取**。
- [ ] **测试租户隔离**：非生产租户/机器人；`principals` 名单不含生产 UserID（`server.ts:219-223`）。
- [ ] **出站受控**：只落测试租户会话 + 通知落盘 sink（`main.ts:43`）；**不**实现/接线真实企微 `NotificationSink`（④：当前 = 0，保持）。
- [ ] **执行面 = 仓内 dummy**：`contextProfile.root` 在仓内；允许集合非空且只读（`execution-runtime.ts:324-334`）。
- [ ] **只读边界**：无写/确认/取消/产物；越权拒绝路径单测绿（`execution-runtime.ts:454-456`）。
- [ ] **凭据隔离**：企微凭据只住 gitignored `config/agent.yaml`/`.env`；worker env 白名单（`worker-env.ts:25`）；前置硬条件 `docs/decision-log.md` §七 文件层缺口闭环前，真实凭据不得落 worker 可读路径。
- [ ] **影子隔离判定**：确认本次运行「不向真实业务用户出帧」——**今日无机械门**（⑥ 缺口），须以测试租户事实 + 人工确认替代，并登记为残余风险。
- [ ] **证据可得**：executions 底账 + `audit.jsonl` + `notifications.jsonl` 可读回。
- [ ] **回退就绪**：撤凭据即拒启（`adapter.ts:194-197`）；`dispatchMode` 可回 `inline`。
- [ ] **零真实模型口径**：影子若跑真实模型须另计额度与授权；**本审计未跑任何真实模型**。

---

## 5. 「只读影子」与「长期业务试用」的差别

| 维度 | 只读影子（本轮准入对象） | 长期业务试用（另条四轴报告） |
|---|---|---|
| 时长 | 短会话、单次/少量 | 长稳（跨天/跨批） |
| 用户面 | 测试租户/受控收件人 | 真实业务用户 |
| 写操作 | 关闭（只读） | 按业务授权（写/确认/取消/产物） |
| 会话恢复 | 不要求 | 须有会话恢复/续跑准入 |
| 跨用户隔离 | 确定性单测即可 | 须真实跨用户样本证据 |
| 出站通知 | 落盘即可 | 须真实企微投递 + 回执链 |
| 稳定性 | 不判定 | 须长稳/压力证据（Phase 3 口径） |

**结论纪律**：影子通过**不得**读作「业务试用通过」；长期试用须另加长稳、会话恢复、跨用户隔离、出站真实投递准入（四轴报告为准）。

---

## 6. 边界重申与指针

- 本轮**不授权真实企微生产接入**、**不授权真实业务写操作**；本档只做「能否进短会话只读影子」的准入判断，**不执行联调**。
- 冻结面/治理面未动；未改产品代码；未访问真实平台；`.runtime` 未入库；未改 `docs/decision-log.md`。
- 相关档：
  - `docs/product/real-read-readiness.md`（三步接入设计与安全评审；§1.1 ExecutionClient 唯一接缝、§3 只读保障、§4 评审清单）。
  - `docs/product/real-shadow-runbook.md`（执行面双源 shadow；**不接渠道**；§4 停止条件、§5 回退）。
  - `docs/product/r4-shadow-dryrun.md`（双源读数）。
  - `docs/product/p4-notifications.md`（通知 outbox 实施报告）。
  - `docs/product/r5-phase4-audit.md`（四轴/Phase 4 汇总，长期试用证据面）。
  - 代码：`packages/channel-wecom/src/adapter.ts`、`apps/server/main.ts`、`apps/server/server.ts`、`apps/server/notification-file-sink.ts`、`packages/agent/src/notifications.ts`、`packages/agent/src/execution-runtime.ts`、`packages/core/src/config.ts`。

## 7. 局限（本档不能回答的）

- **未联调、未运行**：本档全是静态阅读 + 源码核验，**未启动 server、未连接企微、未跑执行、未跑真实模型**。因此「入站就绪」是**代码面判断**，不是「今天实际收到过一条真实帧」的运行证据；任何运行结果仍须在 owner 授权后按 §3 执行取得。
- **无 SDK 认证面证据**：② 的残余风险（身份取自 SDK 帧、适配层无签名校验）只做到「宿主侧无第二道机械校验」这一事实判断；官方 SDK 认证强度**未在仓内**，本档不评估。
- **无真实跨用户/长稳样本**：③ 的会话隔离只有确定性单测，无真实多用户样本；长稳/跨天不属本轮（见 §5）。
- **行号时效**：所有 `文件:行号` 以本分支当前工作树为准；基线漂移后须复核。
- **不构成安全结论/授权**：本档是准入判断，既非安全审计也非接入授权；§4 任一 gate 未过即 fail-closed，不得读作已就绪。

