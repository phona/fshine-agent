# 产品能力页：支持什么 / 预期行为 / 明确不做

> 状态：现行。对接正式平台前 owner 手里的那一页纸：这个产品支持什么、预期行为是什么、明确不做什么。
> 最后核对：2026-11-20。基线：`arch/integration` @ `d486d501`。
> **范围纪律**：本页只描述当前分支上的现实；只在别的分支存在的东西不写（合入后补一行），不写「下一版就有」这类预告。
> **守卫**：`scripts/product-capability-guard.test.ts`——① 本页每个「文件:用例标题」锚点必须唯一命中现存测试（用例被删/改名即红）；② 第三节 17 条每条必须有出处（守卫引用或裁定/登记日期，缺一即红）；③ 状态标记只允许四档枚举，模糊话禁词表在守卫里（出现即红）。守卫自带反向自检。
> **状态四档**：`已实现（有守卫）` ／ `已实现（无守卫）` ／ `未实现（设计在册）` ／ `明确不做（裁定）`。给不出守卫的约束只能标「无守卫」或「裁定」——不假称。

## 一、支持什么（用户视角）

锚点写法 = `文件:用例标题片段`，逐条由守卫解析、必须唯一命中现存 `it()` 用例。

### 1. 会话与主体

| 场景 | 锚点 | 状态 |
| --- | --- | --- |
| 单聊、群聊各自成主体；群=独立主体（同群共享转录/任务/文件，跨群隔离） | `apps/server/server-group-principal.test.ts:group-1 与 group-2 的 principal/session 不同`<br>`scripts/eval/long-session/multiuser/mu-group.test.ts:同群 A/B 交办归同一群主体` | 已实现（有守卫） |
| 未开通主体（个人/群同一路径）直接拒绝、不起回合、不建会话 | `apps/server/server-group-principal.test.ts:未开通群主体：终帧话术与未开通个人同形` | 已实现（有守卫） |
| 消息幂等：同 messageId 重投零新任务（进程内 + 关库重建 + 崩溃遗留） | `apps/server/server-inbound-idempotency.test.ts:① 同一 messageId 连发两次`<br>`apps/server/server-inbound-idempotency.test.ts:② 关掉 server、同 dbPath 重建` | 已实现（有守卫） |
| 会话记忆与压缩归 Pi 原生：压缩摘要跨重启存活、恢复不重放全量历史 | `packages/agent/pi-native-session-persistence.test.ts:① 摘要存活`<br>`packages/agent/pi-native-session-persistence.test.ts:② 重启不重放` | 已实现（有守卫） |

### 2. 查数与多轮指代

| 场景 | 锚点 | 状态 |
| --- | --- | --- |
| 查数如实报数、不编造、不串集合 | `scripts/eval/wecom-sim/cases-a-access.test.ts:W-02 documents W202611` | 已实现（有守卫） |
| 缺对象先澄清（问清集合与窗口），零执行 | `scripts/eval/wecom-sim/cases-a-access.test.ts:W-03 缺对象：先问集合与窗口，零执行` | 已实现（有守卫） |
| 含糊指代：有上下文正确沿用、不无谓追问 | `scripts/eval/wecom-sim/cases-a-access.test.ts:W-04b 刚查过 documents` | 已实现（有守卫） |
| 多轮指代：换窗口沿用集合、改口径只看指定对象 | `scripts/eval/wecom-sim/cases-b-multi.test.ts:W-05 接 W-02`<br>`scripts/eval/wecom-sim/cases-b-multi.test.ts:W-07 接 W-06` | 已实现（有守卫） |
| 范围不自行扩散：只查用户说过的窗口 | `scripts/eval/business-e2e/b03-scenario-reset.test.ts:② 未经请求自推扩到上月 W202610` | 已实现（有守卫） |
| 无数据 / 对象不存在：如实说，不编行 | `scripts/eval/wecom-sim/cases-c-failure.test.ts:W-08 empty-one W1：如实「没有记录」` | 已实现（有守卫） |
| 纯聊天不当成查询：零执行 | `scripts/eval/wecom-sim/cases-a-access.test.ts:W-01 闲聊：零执行、不编造数据` | 已实现（有守卫） |
| 确定性拒绝不重试：同类失败有界、随后如实说明 | `apps/server/server-retry-blocked-event.test.ts:同对象第二次尝试被拦` | 已实现（有守卫） |

### 3. 附件

| 场景 | 锚点 | 状态 |
| --- | --- | --- |
| 文件+指令合并窗：一条消息或 3 秒内补指令，一次处理、只回一次 | `scripts/eval/wecom-sim/cases-d-attachment.test.ts:W-13 文件+3 秒窗口内补指令` | 已实现（有守卫） |
| 只发文件：回执只报个数（不带名）+ 30s 追问一次（列名+选项，不刷屏） | `scripts/eval/wecom-sim/cases-d-attachment.test.ts:W-14 只发文件`<br>`apps/server/server-attachment-nudge.test.ts:② 30 秒无消息 → 发一次追问` | 已实现（有守卫） |
| 追问冷却与开关：10 分钟内第二次不发；`attachmentNudgeAfterMs=0` 永不发 | `apps/server/server-attachment-nudge.test.ts:⑥ 冷却期（10 分钟内第二次）→ 不发` | 已实现（有守卫） |
| 群聊只发文件：登记照常，但不发追问（仅单聊触发） | `apps/server/server-attachment-nudge.test.ts:④ 群聊 → 不发追问` | 已实现（有守卫） |
| 附件→整理汇总成表发回：xlsx 真实可开、数值逐格对 | `scripts/eval/wecom-sim/cases-e-execution.test.ts:W-19 汇总成表发我` | 已实现（有守卫） |
| 只要数字不要文件：只回文字数字、零文件投递 | `scripts/eval/wecom-sim/cases-e-execution.test.ts:W-20 只要数字不要文件` | 已实现（有守卫） |
| 超过 20MB 附件：整条拒绝、话术含上限、会话不失活 | `apps/server/server-cap01-attachment-limit.test.ts:② 21MB 被拒` | 已实现（有守卫） |
| 非结构化附件（文本 PDF）：读出日期/金额、作为产物回传 | `scripts/eval/fixtures/unstructured/invoice-fixture.test.ts:文本提取器读出预期三行（日期 / 金额 / 客户）` | 已实现（有守卫） |

### 4. 任务（交办 / 短活 / 后台 / 长任务）

| 场景 | 锚点 | 状态 |
| --- | --- | --- |
| 慢活：交办回合照发模型说的话，任务后台推进，完成后主动投递恰一次 | `scripts/eval/wecom-sim/cases-g-task.test.ts:W-26 超窗请求` | 已实现（有守卫） |
| 快活：同回合给结果、零受理回执、零主动投递 | `scripts/eval/wecom-sim/cases-g-task.test.ts:W-28 快活（缺省 8000ms 窗口内完成）` | 已实现（有守卫） |
| 后台完成：唤醒会话模型、投递它说的话，恰一次 | `apps/server/server-completion-wake.test.ts:① 主路径` | 已实现（有守卫） |
| 等补信息：主动说清还缺什么，补答后同一任务续跑完成 | `scripts/needs-input-resume.test.ts:① 执行层要补输入` | 已实现（有守卫） |
| 取消：在飞中止（请求≠已取消）、已完成任务再取消如实拒绝 | `packages/agent/task-cancel-inflight.test.ts:① 在飞 run_js`<br>`packages/agent/task-cancel-inflight.test.ts:③ 已完成任务再取消` | 已实现（有守卫） |
| 长任务 accepted→wait→abort；未声明 long_running 却返回 accepted 一律 fail-closed | `packages/agent/long-task-async.test.ts:③ abort → 任务 cancelled`<br>`packages/agent/long-task-async.test.ts:⑤ 未声明 long_running 的 operation 返回 accepted` | 已实现（有守卫） |
| 长任务跨重启：新 runner 从底账 accepted 行重新 wait，不重复发起 | `packages/agent/long-task-async.test.ts:④ 重启：关库重开` | 已实现（有守卫） |
| 久等提醒一档（超阈值恰一条、每任务一次、重启不重发）；群聊也发（话术去业务名，owner 2026-11-19 #9 迁移） | `packages/agent/long-running-notice.test.ts:① 10 分钟内零发送`<br>`apps/server/server-long-running-notice.test.ts:② 群聊也发` | 已实现（有守卫） |
| 长任务等待与执行层断联系：先自查一次，兜得住照常走；连续两次拿不到回执才如实说一次（任务不判死、退避封顶 60s 继续等） | `packages/agent/long-task-wait-truncation.test.ts:② 先兜能兜住`<br>`packages/agent/long-task-wait-truncation.test.ts:任务不判死` | 已实现（有守卫） |

### 5. 写确认回环

| 场景 | 锚点 | 状态 |
| --- | --- | --- |
| 写请求先给提案、零写入；确认后写入读回；二次确认确定性拒绝（句柄一次性） | `scripts/eval/wecom-sim/cases-f-write.test.ts:W-22 写请求先给提案、零写入`<br>`packages/agent/write-confirmation.test.ts:重复确认：同一句柄只执行一次` | 已实现（有守卫） |
| 提案摘要=机械事实交给模型；模型说什么用户逐字收什么 | `apps/server/server-task-wait-window.test.ts:b2. 提案回合：模型自己说要写入什么` | 已实现（有守卫） |
| 显式确认动作 `task_confirm`（任务/后台路径）；没有等待中的提案时确认=确定性拒绝（零执行） | `packages/agent/background-write-confirmation.test.ts:① 确认路径：task_confirm`<br>`packages/agent/background-write-confirmation.test.ts:④ 无提案确认：没有等待中的提案时` | 已实现（有守卫） |
| 句柄安全：越权/过期/缺句柄/绑定不一致 → 拒绝且零写入 | `packages/agent/write-confirmation.test.ts:越权：另一个会话`<br>`packages/agent/write-confirmation.test.ts:过期：构造过期提案` | 已实现（有守卫） |
| 改口径（`task_resume`）永不透传句柄：旧提案作废，Worker 重新提案 | `packages/agent/background-write-confirmation.test.ts:② 改口径路径：task_resume` | 已实现（有守卫） |
| 过期重提：不判失败、不结束任务，接续一轮重新生成同一提案，任务回等待 | `packages/agent/background-write-confirmation.test.ts:③ 过期确认：task_confirm 触发一轮重新提案` | 已实现（有守卫） |
| 同回合自我确认结构性挡住：句柄只在用户表态后的回合透传 | `packages/agent/background-write-confirmation.test.ts:⑦ 同回合 prepare 后立刻 commit` | 已实现（有守卫） |
| 只读装配下写请求：明确拒绝、零写入、不宣称成功 | `scripts/eval/wecom-sim/cases-f-write.test.ts:W-25 只读装配下同一写请求` | 已实现（有守卫） |
| 批量写入逐条结果：一条坏不拖累整批汇报，partial 不得说成成功 | `packages/agent/batch-write-items.test.ts:② 注入一条写失败` | 已实现（有守卫） |
| 写回合终局=末次决定性结果：先失败后成功不再误报失败、失败那次留痕 | `packages/agent/write-outcome-last-attempt.test.ts:① 主形状：确认回合 commit 失败（参数错）` | 已实现（有守卫） |

### 6. 文件交付

| 场景 | 锚点 | 状态 |
| --- | --- | --- |
| 模型只认 fileId（宿主派生路径、name 不进路径）；同内容登记去重、TTL 过期不可读 | `packages/agent/file-store-layout.test.ts:① 派生路径确定性`<br>`packages/agent/file-store-dedupe-ttl.test.ts:fileRefTtlDays=7 生效` | 已实现（有守卫） |
| 交付物只从 Worker 出：Main 面 `run_js` 写 out/ 被权限拒绝、零登记 | `packages/agent/run-js-executor.test.ts:①d 权限层收窄：writableDirs=scratch-only` | 已实现（有守卫） |
| 大响应自动落文件：执行层 completed 结果超 64KiB 写成任务文件、回 fileId，不打满上下文 | `packages/agent/oversize-data-fileize.test.ts:② >64KiB 结果落任务文件` | 已实现（有守卫） |
| 保留期：run 目录缺省 30 天清扫；过期文件字节回收、行留审计 | `packages/agent/file-retention-policy.test.ts:缺省解析值 = 30`<br>`packages/agent/file-store-dedupe-ttl.test.ts:行未过期但字节已被回收（文件不存在）→ 不复用` | 已实现（有守卫） |
| 表格投递门报告驱动（宿主不解析 xlsx）：fail 报告拦下、混合批次给「部分未投递」话术 | `packages/agent/recalc-delivery-gate.test.ts:有匹配 fail 报告 → 不投递`<br>`packages/agent/recalc-delivery-gate.test.ts:批次含 fail 报告表 + 无报告 CSV` | 已实现（有守卫） |

### 7. 权限与身份

| 场景 | 锚点 | 状态 |
| --- | --- | --- |
| RBAC 三档：viewer 只读（发起前拒绝、不提 operation 名）、operator/admin 可写、未写 role=viewer | `scripts/rbac-roles.test.ts:① viewer 调写：宿主发起前拒绝`<br>`scripts/rbac-roles.test.ts:④ 未写 role 的 principal → viewer` | 已实现（有守卫） |
| 部署写总闸：关闭时角色含 write 也不放宽 | `scripts/rbac-roles.test.ts:⑥ 部署总闸关闭` | 已实现（有守卫） |
| 群主体按配置授权；群里 viewer 写被拒、同一人员工 operator 个人可写 | `scripts/rbac-roles.test.ts:⑦ 群主体 role: viewer` | 已实现（有守卫） |
| 凭据隔离：执行子进程 env 精确白名单，宿主机密不进 worker | `packages/agent/worker-env.test.ts:宿主机密族/内部指针/测试桥键/计划旋钮不进子进程` | 已实现（有守卫） |
| A2b 同对象锁：确定性拒绝后同对象本回合不再发起（换对象/换回合不误伤） | `packages/agent/background-retry-lock.test.ts:① 同键确定性拒绝两次` | 已实现（有守卫） |
| `dispatchKey` 两层身份：同一业务操作至多一次自动执行、重试不另铸身份、重复交办回放回执 | `packages/agent/dispatch-key-identity.test.ts:每次执行层请求都携带非空 dispatchKey`<br>`packages/agent/dispatch-key-identity.test.ts:恢复后的同名操作：回放已有结果` | 已实现（有守卫） |
| 多用户隔离：越权查/取消/接续被拒、事实只注入 owner 会话 | `scripts/eval/long-session/multiuser/mu.test.ts:B 经任务工具访问 A 的 #1` | 已实现（有守卫） |
| 任务引用跨会话不可见：越权=找不到，不泄露存在性 | `packages/agent/task-surface.test.ts:越权=找不到：同一底账内跨会话同编号不可见` | 已实现（有守卫） |

### 8. 通知与投递

| 场景 | 锚点 | 状态 |
| --- | --- | --- |
| 后台失败：唤醒模型说（宿主只喂事实）；模型说不出话才投既有失败话术 | `apps/server/server-state-wake.test.ts:① 后台失败 → 投递文本 == 脚本模型唤醒回合那句`<br>`apps/server/server-state-wake.test.ts:①b 走岔路：唤醒回合只调工具` | 已实现（有守卫） |
| 取消/重启对账同出口：说停唤醒模型说、重启租约过期如实说清、非 live 不唤醒零投递 | `apps/server/server-state-wake.test.ts:② 取消 → 唤醒模型说`<br>`apps/server/server-state-wake.test.ts:④ 启动时租约已过期`<br>`apps/server/server-state-wake.test.ts:④c 非 live 部署不唤醒` | 已实现（有守卫） |
| 完成事实 = 业务名 + 结果正文，正文逐字不截断不改写 | `apps/server/server-completion-wake.test.ts:② 模型把结果正文逐字说给用户` | 已实现（有守卫） |
| 完成消息让用户看出是哪件事（业务名进用户可见文本） | `apps/server/server-completion-wake.test.ts:⑤ 完成消息要让用户看出是哪件事` | 已实现（无守卫） |
| 不许静默终局：快活失败+模型沉默照样送达；资源受限给人话+动作 | `apps/server/server-relay-silent-turn.test.ts:③c 快活失败 + 沉默`<br>`apps/server/server-relay-silent-turn.test.ts:③b 资源拒绝` | 已实现（有守卫） |
| 失败话术 = 业务话 + 一个动作，无内部术语、无绝对路径 | `packages/agent/user-facing-failure.test.ts:③ 每种失败都带可执行动作`<br>`packages/agent/user-facing-failure.test.ts:⑤ 内部术语闸` | 已实现（有守卫） |
| 投递记账如实：没送达不记 delivered、终态跳过不重试；投递终局进告警面 | `packages/agent/notifications.test.ts:终态跳过（sink 报 skipped）`<br>`scripts/ops/alerts.test.ts:通知投递失败到 attempts 上限` | 已实现（有守卫） |
| silent/shadow 部署：六类用户可见发送全闸、零投递（suppressed 是正常事实不是失败） | `apps/server/server-notification-push.test.ts:④ silent 部署 → 零投递` | 已实现（有守卫） |

### 9. 运维与真模型评测面

| 场景 | 锚点 | 状态 |
| --- | --- | --- |
| 运营告警四规则（host_fault / retry_storm / task_stuck / delivery_failed）+ 双出口（alerts.jsonl / 企微推送）、冷却去重、原文可回溯 | `packages/agent/alert-rules.test.ts:命中：同一任务执行事实达到阈值`<br>`packages/agent/alert-rules.test.ts:告警项 raw 字段包含被命中的内部原文`<br>`scripts/ops/alerts.test.ts:长活提醒投递两次都失败` | 已实现（有守卫） |
| 我方故障（装配面缺陷/协议违约）落告警第 3 档，不给用户编话 | `packages/agent/long-task-async.test.ts:⑤b 声明了长任务但装配没给等待端口`<br>`packages/agent/alert-rules.test.ts:命中：装配面缺陷` | 已实现（有守卫） |
| 用户级黑盒评测（E01–E15 共 15 例：编造/假成功/无谓追问判负；真模型跑批在 CI/预注册入口，判据与报告有守卫） | `scripts/eval/user-eval-comment.test.ts:全部用例按 CASE_IDS 顺序出现在表里` | 已实现（有守卫） |
| 真模型写闭环验收（`npm run eval:write-loop`：九条机械判据，缺模型配置如实失败） | `scripts/eval/real/write-loop.test.ts:九条判据全 pass` | 已实现（有守卫） |
| 覆盖矩阵守卫：矩阵每条引用唯一命中现存用例（用户级能力台账不漂移） | `scripts/coverage-matrix-guard.test.ts:逐条引用都能唯一定位到现存用例` | 已实现（有守卫） |
| 单实例纪律与双实例行为 | `apps/server/instance-guard.test.ts:② 锁被另一个存活且命令行匹配的 pid 占用 → 取锁失败，话术可操作（含 kill pid）` | 已实现（有守卫） |

## 二、预期行为（交互契约浓缩）

detail 在 `docs/product/interaction-contract.md`（五条尺子逐条现状），这里只留摘要。

- **用户看到的话全部由模型说**；宿主只做四件事：时机（状态变化才唤醒/投递）、事实（喂机械事实）、凭据（身份与句柄透传）、投递与记账。唯一例外 = 模型回合挂掉时的如实兜底句。状态：已实现（有守卫）。锚点：`apps/server/server-relay-silent-turn.test.ts:用户看到的话永远是模型说的`。
- **受理静默**：宿主不发「收到，正在处理」受理帧、不静默派发——交办回合照发模型说的话。状态：已实现（有守卫）。锚点：`apps/server/server-task-wait-window.test.ts:b. 慢活：只交办回合照发模型说的话`。
- **确认必回执**：确认/接续回合必有用户可见归宿（结果、失败话术或重新提案），不许静默终局。状态：已实现（有守卫）。锚点：`packages/agent/write-outcome-last-attempt.test.ts:① 主形状：确认回合 commit 失败（参数错）`、`apps/server/server-relay-silent-turn.test.ts:① 主形状：窗口内完成 + 模型全程空正文`。
- **失败三选一归宿**：Main 兜（既有兜路径的刹车不放宽：wait 退避封顶 60s / A2b 同对象锁 / 失败缺省不可重试 / retry_storm 告警）→ 告诉用户（业务话 + 一个动作）→ 告警/开发介入（不给用户编话）。状态：已实现（有守卫）。锚点：`packages/agent/long-task-wait-truncation.test.ts:退避单调翻倍到 60s 封顶`、`packages/agent/background-retry-lock.test.ts:① 同键确定性拒绝两次`、`packages/agent/deterministic-failure-guard.test.ts:失败但**未声明** retryable → 按不可重试处理`、`packages/agent/alert-rules.test.ts:命中：同一任务执行事实达到阈值`。
- **消息自含**：完成/失败/等补信息的事实都带业务名，用户不用猜是哪件事；用户可见文本最终由模型转述——事实链有守卫，模型转述面无自动用例（真模型评测守）。状态：已实现（无守卫）。锚点：`apps/server/server-completion-wake.test.ts:⑤ 完成消息要让用户看出是哪件事`。
- **久等只提示不停**：超阈值恰一条「要我停下来，还是继续等？」；任务不判死、不杀，处置权在用户。提醒 1:1 与群聊都发（owner 2026-11-19 #9：群 = 独立主体；群话术不带业务名——隐私口径归端口，重启判据只看底账任务事实 #10）。状态：已实现（有守卫）。锚点：`packages/agent/long-running-notice.test.ts:① 10 分钟内零发送`、`apps/server/server-long-running-notice.test.ts:② 群聊也发`。
- **失败话术 = 业务话 + 一个动作，无内部词**（operation 名、任务编号、执行层、uuid、绝对路径不出现）。状态：已实现（有守卫）。锚点：`packages/agent/user-facing-failure.test.ts:⑤ 内部术语闸`。
- **完成 = 业务名 + 结果正文**（机械事实），正文逐字交给模型转述。状态：已实现（有守卫）。锚点：`apps/server/server-completion-wake.test.ts:② 模型把结果正文逐字说给用户`。

## 三、明确不做（owner 裁定清单）

语义以本表为准，不许增删；每条出处 = 守卫引用或裁定/登记日期（守卫强制）。

| # | 不做什么 | 语义边界 | 状态 | 出处 |
| --- | --- | --- | --- | --- |
| 1 | 跨会话续办 | 任务作用域恒为（主体+会话）；任务引用跨会话=找不到，不扩成跨会话授权面 | 明确不做（裁定） | 裁定 2026-11-17（owner，CAP-01 收口；`docs/architecture/tasks.md` §7）。守卫：`packages/agent/task-surface.test.ts:越权=找不到：同一底账内跨会话同编号不可见` |
| 2 | 长期记忆 / 历史检索 / 语义投影 / 执行台账注入 | 宿主不做「帮模型记忆/帮模型理解历史」的机制；上下文与压缩归 Pi 原生（`docs/architecture/sessions.md`） | 明确不做（裁定） | 裁定 2026-11-13（AGENTS.md「职责边界」硬约束）。无专项守卫（结构上转录/压缩只有 Pi 单一所有者） |
| 3 | 周期状态播报 | 不做周期性状态播报；状态信息只在状态变化（触发式唤醒/再同步）与用户主动查询时给；30 分钟「卡住」档已整档删除 | 明确不做（裁定） | 裁定 2026-11-19（owner，唤醒切片，merge `1eeb38a2` 删 30 分钟档）。守卫：`packages/agent/long-running-notice.test.ts:>30min 也没有第二档` |
| 4 | 时间到了就杀 | 时间只提示不停：超阈值只有提醒一档，任务不判死、不杀，处置权（停/等）在用户 | 明确不做（裁定） | 裁定 2026-11-19（owner「能兜则兜、兜不住才暴露」；`docs/product/interaction-contract.md` §1）。守卫：`packages/agent/long-task-wait-truncation.test.ts:任务不判死` |
| 5 | 宿主替模型说话 / 改写 / 吞掉模型文本 | 用户可见文本永远逐字=模型的话；唯一例外 = 模型回合挂掉时的如实兜底句 | 明确不做（裁定） | 裁定 2026-11-19（owner，删三处宿主替换，commit `e2a4b91c`）。守卫：`apps/server/server-relay-silent-turn.test.ts:用户看到的话永远是模型说的` |
| 6 | 宿主探文件结构 | 宿主不解析业务文件内容/结构（只持字节与登记事实；格式判断归模型与执行层）——recalc 投递门完全报告驱动、不打开内容 | 明确不做（裁定） | 裁定 2026-11-18（owner，recalc 集成；`docs/architecture/files.md` §7）。守卫：`packages/agent/recalc-delivery-gate.test.ts:门不打开内容` |
| 7 | Router / Planner / 意图分类器 / 规则引擎 / 事件总线 / 通用 Workflow Engine / 第二套协议 / 沙箱·Docker | 理解、规划、工具选择归 Pi；治理裁决归执行层；旧治理模块不得经值边复活 | 明确不做（裁定） | 裁定 2026-11-13（AGENTS.md 禁止新增清单）。守卫：`packages/agent/import-boundary.test.ts:值闭包不触及旧治理模块` |
| 8 | 单任务 operation 硬上限 | 「单任务 operation ≤ 3」只是登记的观察判据，owner 推迟不做硬上限；已实现的只有单回合上限（缺省 5） | 明确不做（裁定） | 裁定 2026-11-18（owner 推迟；判据登记于 `docs/product/wecom-live-dummy-cases.md` §9 I 组）。单回合上限守卫：`packages/agent/resource-policy.test.ts:maxOperationsPerTurn：缺省 5`；单任务上限无守卫 |
| 9 | 附件 emoji / 模板卡 | 企微 SDK 无 reaction 接口；「已接收」轻反馈（模板卡原地更新）未验证前不新增机制 | 明确不做（裁定） | 裁定 2026-11-19（owner 记债 X-1；`docs/decisions/debt.md` §九）。无守卫 |
| 10 | 群聊附件追问 | 纯附件追问仅单聊触发；群聊登记照常但不追问（久无动静提醒的群聊规则**不同此**：owner 2026-11-19 #9 已改为群聊也发、话术去业务名——与本条不冲突，附件追问仍单聊） | 明确不做（裁定） | 裁定 2026-11-17（owner，W-16 立卷）。守卫：`apps/server/server-attachment-nudge.test.ts:④ 群聊 → 不发追问` |
| 11 | inline（`npm run ask`）面的显式确认动作 | 显式确认（`task_confirm`/`task_resume`）只覆盖任务/后台路径；inline 冻结为会话级最小状态 + 下一回合透传，语义不得混用 | 明确不做（裁定） | 裁定 2026-11-19（owner 拍板显式确认切片范围；`docs/architecture/contract.md` §1）。无专项守卫；inline 现行行为被 `scripts/host-write-confirmation.test.ts:1 正常：prepare → 用户「确认」` 钉住 |
| 12 | 读/写传输超时分叉 | 传输入口只有单一缺省界（60s），不分读/写设不同超时；截断语义=结果未知、不冒充失败已确认 | 明确不做（裁定） | 裁定 2026-11-19（owner，call-timeout 切片；`docs/architecture/tasks.md` §3）。无专项守卫；单一界与语义被 `packages/agent/execution-call-timeout.test.ts:缺省界常量 = 60s` 钉住 |
| 13 | host_fault 类失败全面改第 3 档 | 是否把全部 host_fault 类失败从「告诉用户」移到「告警/开发介入」= **登记待裁，未裁定不推进**；个案（装配面缺陷/投递终局）已在第 3 档 | 未实现（设计在册） | 登记 2026-11-19（owner「失败归宿三选一」切片，commit `516f42ce`）。个案守卫：`packages/agent/alert-rules.test.ts:命中：装配面缺陷` |
| 14 | 给 Worker 注入「已成功写入」的机械事实 | Worker 上下文不注入「写已成功」的机械事实（现行注入只有执行事实注记）；owner 暂不做 | 明确不做（裁定） | 裁定 2026-11-19（owner 会话，本页登记；现行文档无其他登记行）。无守卫 |
| 15 | run_js 沙箱化 | `run_js` 是受限子进程而不是沙箱（网络未阻断、无 OS 级隔离，风险如实登记）；沙箱化属禁止新增 | 明确不做（裁定） | 裁定 2026-11-13（AGENTS.md 禁止清单；风险登记 `docs/architecture/contract.md` §3）。无专项守卫；受限面被 `packages/agent/run-js-executor.test.ts:①d 权限层收窄：writableDirs=scratch-only` 钉住 |
| 16 | 17dz 实现确认句柄之前开启真实写 | 真实执行层没实现 `needs_confirmation` 句柄前，写路径 fail-closed 拒绝是正确行为，不是缺陷 | 明确不做（裁定） | 裁定 2026-11-17（`docs/product/wecom-live-dummy-cases.md` §6 第 8 条）。守卫：`scripts/write-confirm-loop.test.ts:默认只读 principal` |
| 17 | 跨主体数据共享 / 群继承私人授权 | MU 硬零：越权查/取/接续全拒绝、无内容泄漏；群主体按配置授权，个人角色不自动带入群 | 明确不做（裁定） | 裁定 2026-11-18（owner：群=独立主体；`docs/architecture/tasks.md` §6）。守卫：`scripts/eval/long-session/multiuser/mu-group.test.ts:同群 A/B 交办归同一群主体` |

## 四、未实现（设计在册）

只列不改语义；出处 = 现行登记行。

| # | 事项 | 现状与出处 |
| --- | --- | --- |
| 1 | 图片/截图附件业务识别 | 只有机械登记（lifecycle 对 `.pdf/.zip` 只登记、内容 UNDEFINED）；无图片夹具与识别用例（`docs/eval/coverage-matrix.md` §二缺口行） |
| 2 | 完成消息业务名的模型转述面 | 宿主只保证事实带业务名；模型可能不说名（收着名字只报结果）——无真模型用例守，`npm run eval:user` 未覆盖此点（`docs/eval/coverage-matrix.md` §三部分行） |
| 3 | 指定接收人 / 转发结果到其它会话 | 所有投递都是「回到发起会话」；定向投递无语义无用例（`docs/eval/coverage-matrix.md` §十三缺口行） |
| 4 | 跨重启消息级幂等 | messageId 去重是 server 进程内存（上限 1024）；重启后同 messageId 是新回合（debt #68；`docs/architecture/tasks.md` §7） |
| 5 | 会话存储 retention / 容量上限 | 活跃段随消息数线性增长、归档 .gz 无保留期（debt #67；`docs/architecture/sessions.md` §5） |
| 6 | 细粒度（实体级）授权 | 谁能看哪些账套/记录未做透传或校验，归执行层研判（debt P-2；`docs/decisions/debt.md` §七） |
| 7 | 长任务 L-2/L-3/L-4 | 执行中回合静默阈值、实体级并发写、执行层侧幂等键——设计保留、真实执行层未验（`docs/decisions/debt.md` §八） |
| 8 | 步骤级白盒 | 执行层报 phase 的进度级查询未做（`docs/product/interaction-contract.md` §3 现状） |
| 9 | 真实企微租户联调 | 真网络时序、真机气泡观感、真实文件上传下载需独立测试租户（debt #74；`docs/architecture/channels.md` §8） |
| 10 | 真实执行层（17dz）只读冒烟与真实写 | 只读=仅准备档待 owner 授权；写未验（`docs/product/real-read-readiness.md`；`docs/ops/real-write-loop.md` §6） |
| 11 | P8 ops 扩展 | 「数字 ID→执行树/资源/通知投递」未获授权、未实施（debt #71） |
| 12 | executions 时间列 / tasks CLI 增强 | 未清（debt #69、#70） |
| 13 | 文件去重边界 F-2/F-3 | 入站复用无来源判据、同消息同名塌缩——登记不修，产品语义待裁（`docs/decisions/debt.md` §六；F-1 pending 复用已于 2026-11-18 清账） |
| 14 | 双实例共享 `.runtime/state.db` 的并发写语义 | 启动锁把第二个实例挡在连接渠道之前（`apps/server/main.ts:53`），锁失效/被绕开时的并发写未定义、未测（登记 2026-11-20：文档面复核发现原「无进程锁/仅靠操作纪律」陈述已过期） |

## 五、指针

- 用户级能力矩阵（每条已覆盖能力的用例台账）：`docs/eval/coverage-matrix.md`
- 交互契约（五条「省心」尺子与逐条现状）：`docs/product/interaction-contract.md`
- 裁定与未清债：`docs/decisions/index.md`、`docs/decisions/debt.md`
- 架构现实（渠道/任务/文件/权限/会话/契约）：`docs/architecture/*.md`
- 本页守卫：`scripts/product-capability-guard.test.ts`
