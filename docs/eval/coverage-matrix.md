# 用户级自动化覆盖矩阵（coverage-matrix）

> 状态：现行。全仓**用户级能力**的自动化覆盖矩阵——按「用户能做什么」组织，不是按代码模块；取代 `docs/product/business-coverage.md` 的业务级覆盖图（该页只留指针，见文末「与 business-coverage.md 的关系」）。每条「已覆盖」必须能唯一定位到现存测试用例；用例被删/改名，守卫即红。
> 最后核对：2026-11-19（用例标题与行号以现行代码为准；本页由 `scripts/coverage-matrix-guard.test.ts` 逐行守卫，不是手工台账）。
> 上游指针：`scripts/eval/wecom-sim/harness.ts:515`（渠道级真实 server + 假 SDK 装配）、`scripts/eval/wecom-sim/run.ts:11`（渠道级一条命令入口）、`scripts/eval/convergence-r1/cases.ts:120`（eval:user 用户级用例全集 E01–E15）、`scripts/eval/cap01/run-all.ts:34`（八面确定性门）、`scripts/eval/sim/run-real.ts`（模拟用户真实模型跑批入口，预注册制）、`scripts/coverage-matrix-guard.test.ts`（本页守卫本体）。

## 口径

- **层级**三档：`宿主机制` = 确定性自动化（生产装配链，脚本化/假件模型）；`执行层` = dummy/真实执行面（子进程、夹具断言）；`真模型统计` = 真实模型跑批（CI 或预注册入口，读数归真模型行为）。
- **覆盖度**三态：`已覆盖` = 有自动用例钉住且可唯一定位；`部分` = 有自动用例但只覆盖一部分，缺口说明写明缺什么；`缺口` = 无自动用例或只有确定性守卫，缺口说明写明依据。
- **自动用例**列每条 `文件路径:用例标题片段`（`<br>` 分隔多条）；标题片段必须**精确、唯一**命中该文件里某个 `it()` / `it.each()` 标题——守卫逐条解析，找不到或命中多个即红。
- 真模型统计行的自动用例引用的是**判定器/报告/套件守卫**（这些钉住运行机制的测试），真实模型运行本身在 CI/预注册入口（缺口说明注明）。

## 一、查数与多轮指代

| 场景 | 自动用例 | 层级 | 覆盖度 | 缺口说明 |
| --- | --- | --- | --- | --- |
| 查单集合、如实报数（不编造、不串集合） | `scripts/eval/wecom-sim/cases-a-access.test.ts:W-02 documents W202611`<br>`scripts/eval/wecom-sim/cases-b-multi.test.ts:W-06 alpha 和 beta 各有多少条` | 宿主机制 + 执行层 | 已覆盖 | — |
| 缺对象 / 含糊指代：先澄清或正确沿用对象，零执行 / 不无谓追问 | `scripts/eval/wecom-sim/cases-a-access.test.ts:W-03 缺对象：先问集合与窗口，零执行`<br>`scripts/eval/wecom-sim/cases-a-access.test.ts:W-04 新会话含糊指代`<br>`scripts/eval/wecom-sim/cases-a-access.test.ts:W-04b 刚查过 documents` | 宿主机制 + 执行层 | 已覆盖 | — |
| 多轮指代：换窗口沿用集合（「那 W202610 呢」）、改口只看 beta | `scripts/eval/wecom-sim/cases-b-multi.test.ts:W-05 接 W-02`<br>`scripts/eval/wecom-sim/cases-b-multi.test.ts:W-07 接 W-06` | 宿主机制 + 执行层 | 已覆盖 | — |
| 语义范围扩散：只说当期，不自行扩到上月 / 整集合 | `scripts/eval/business-e2e/b03-scenario-reset.test.ts:② 未经请求自推扩到上月 W202610` | 宿主机制 | 已覆盖 | 真模型面在 eval:user E13（`scripts/eval/convergence-r1/cases/E13.ts`），CI 自动跑；本行自动化面=判据守卫 |
| 确定性拒绝不重试：错参数 WHERE_INVALID，同类失败有界、随后如实说明 | `scripts/eval/wecom-sim/cases-c-failure.test.ts:W-12 finance-invoices 给窗口`<br>`apps/server/server-retry-blocked-event.test.ts:同参数第二次尝试被拦` | 宿主机制 + 执行层 | 已覆盖 | 真模型面在 eval:user E14（`scripts/eval/convergence-r1/cases/E14.ts`） |
| 无数据 / 对象不存在：如实说没有 / 不存在，不编行 | `scripts/eval/wecom-sim/cases-c-failure.test.ts:W-08 empty-one W1：如实「没有记录」`<br>`scripts/eval/wecom-sim/cases-c-failure.test.ts:W-09 contract-archive：如实「不存在」` | 宿主机制 + 执行层 | 已覆盖 | — |
| 纯聊天不当成查询：零执行、不编数据 | `scripts/eval/wecom-sim/cases-a-access.test.ts:W-01 闲聊：零执行、不编造数据` | 宿主机制 + 执行层 | 已覆盖 | — |

## 二、附件 → 整理汇总（单文件 / 多文件 / 群里）

| 场景 | 自动用例 | 层级 | 覆盖度 | 缺口说明 |
| --- | --- | --- | --- | --- |
| 文件 + 指令合并窗：一条消息或 3 秒内补指令，一次处理、只回一次终帧 | `scripts/eval/wecom-sim/cases-d-attachment.test.ts:W-13 文件+3 秒窗口内补指令`<br>`apps/server/server-cap01-inbound.test.ts:③ 激活语义：文字+附件一条消息` | 宿主机制 + 执行层 | 已覆盖 | — |
| 只发文件：回执（只报个数、不带名）+ 30s 追问（列名 + 选项），不刷屏 | `scripts/eval/wecom-sim/cases-d-attachment.test.ts:W-14 只发文件`<br>`apps/server/server-attachment-nudge.test.ts:② 30 秒无消息 → 发一次追问`<br>`apps/server/attachment-nudge.test.ts:令牌有效 → 30s 到点发一次` | 宿主机制 + 执行层 | 已覆盖 | — |
| 连发多个文件：只发一条追问且提到全部文件 | `scripts/eval/wecom-sim/cases-d-attachment.test.ts:W-17 连发 3 个文件`<br>`apps/server/server-attachment-nudge.test.ts:⑤ 连发 3 个文件` | 宿主机制 + 执行层 | 已覆盖 | — |
| 冷却期 / 关闭追问：10 分钟内第二次不发；`attachmentNudgeAfterMs=0` 永不发 | `apps/server/server-attachment-nudge.test.ts:⑥ 冷却期（10 分钟内第二次）→ 不发`<br>`apps/server/server-attachment-nudge.test.ts:⑦ attachmentNudgeAfterMs=0 → 永不发` | 宿主机制 | 已覆盖 | — |
| 群聊只发文件：附件登记照常，但**不发追问**（仅单聊触发） | `scripts/eval/wecom-sim/cases-d-attachment.test.ts:W-16 群聊只发文件`<br>`apps/server/server-attachment-nudge.test.ts:④ 群聊 → 不发追问` | 宿主机制 + 执行层 | 已覆盖 | — |
| 附件 → 汇总成表发回：xlsx 真实可开、数值逐格对、不含单元格行数据 | `scripts/eval/wecom-sim/cases-e-execution.test.ts:W-19 汇总成表发我`<br>`scripts/eval/wecom-sim/cases-d-attachment.test.ts:W-18 追问后用户直接说要求`<br>`packages/agent/runtime-worker-run-js.test.ts:② 转录与工具参数里 grep 不到任何单元格数值`<br>`scripts/eval/cap01/r2d-judge.test.ts:委派链路带 inputFiles 且副本绑定任务：宿主绿` | 宿主机制 + 执行层 | 已覆盖 | — |
| 只要数字不要文件：只回文字数字、零文件投递 | `scripts/eval/wecom-sim/cases-e-execution.test.ts:W-20 只要数字不要文件` | 宿主机制 + 执行层 | 已覆盖 | — |
| 超过 20MB 附件：整条拒绝、话术与事件含上限、不失活 | `apps/server/server-cap01-attachment-limit.test.ts:② 21MB 被拒`<br>`apps/server/server-cap01-attachment-limit.test.ts:③ 恰好 20MB：放行并登记` | 宿主机制 | 已覆盖 | — |
| 非结构化附件（文本 PDF）：读出日期 / 金额、作为产物回传 | `scripts/eval/fixtures/unstructured/invoice-fixture.test.ts:文本提取器读出预期三行（日期 / 金额 / 客户）`<br>`scripts/eval/cap01/r2d-judge.test.ts:回复里同时出现正确日期与金额 = read（绿）` | 执行层 | 已覆盖 | 文本 PDF 的提取与判读守卫已有；**图片 / 截图**形态见下行缺口 |
| 图片 / 截图附件业务识别（如发票截图）：登记后识别并汇总 | — | 宿主机制 + 真模型统计 | 缺口 | 只有机械登记（`lifecycle` 对 `.pdf/.zip` 只做登记、内容 UNDEFINED）；图片附件无识别/汇总自动用例，也无图片夹具。登记与产物回传链路可确定性补；识别质量只可能真模型/人工验证（business-coverage 盲区 #7） |

## 三、后台任务（受理 / 静默 / 完成 / 失败 / 取消 / 并存 / 跨重启）

| 场景 | 自动用例 | 层级 | 覆盖度 | 缺口说明 |
| --- | --- | --- | --- | --- |
| 慢活受理：交办回合**照发模型说的话**（逐字，宿主不再静默/替换），任务后台推进 | `scripts/eval/wecom-sim/cases-g-task.test.ts:W-26 超窗请求`<br>`apps/server/server-task-wait-window.test.ts:b. 慢活：只交办回合照发模型说的话`<br>`scripts/eval/smoke/slow-faults.test.ts:交办回合照发模型说的话`<br>`scripts/r4-integ-joint.test.ts:① 受理快速返回` | 宿主机制 + 执行层 | 已覆盖 | — |
| 快活：同回合给结果、零受理回执、零主动投递 | `scripts/eval/wecom-sim/cases-g-task.test.ts:W-28 快活（缺省 8000ms 窗口内完成）`<br>`apps/server/server-task-wait-window.test.ts:a. 快活：同回合回复带结果` | 宿主机制 + 执行层 | 已覆盖 | — |
| 后台完成：唤醒会话模型 → 投递它说的话，恰一次；silent 部署不唤醒、零投递（suppressed） | `apps/server/server-task-wait-window.test.ts:c. 慢活完成（live）：主动投递恰好一次`<br>`apps/server/server-task-wait-window.test.ts:c. 慢活完成（silent）：零投递`<br>`apps/server/server-cap01-delivery.test.ts:⑧ 完成投递文本 = 唤醒回合模型那句`<br>`apps/server/server-notification-push.test.ts:③ 后台完成 → 恰一次完成投递`<br>`apps/server/server-completion-wake.test.ts:① 主路径`<br>`apps/server/server-completion-wake.test.ts:⑥ silent 部署不唤醒` | 宿主机制 | 已覆盖 | — |
| 后台完成·唤醒降级：宿主如实报完成事实（业务名 + 结果正文，不说「再试一次」）+ 事实留待注入 | `apps/server/server-completion-wake.test.ts:③ 唤醒失败（空回复）`<br>`apps/server/server-completion-wake.test.ts:③b 会话拿不到（驱动无唤醒能力）`<br>`apps/server/server-completion-wake.test.ts:④ 走岔路` | 宿主机制 | 已覆盖 | — |
| 投递失败不静默（2026-11-19 投递真相切片）：唤醒送达失败 → 事实退回待注入、下次开口补说；文件未送达话术本身失败同样退回；待注入事实在「本回合没有用户可见输出」时不核销 | `apps/server/server-completion-wake.test.ts:⑦ 唤醒成功但投递失败`<br>`apps/server/server-completion-wake.test.ts:⑨ 待注入事实遇上空回复/驱动失败`<br>`apps/server/server-completion-wake.test.ts:⑧ 不许修过头`<br>`apps/server/server-cap01-delivery.test.ts:①d 未送达话术本身也投递失败`<br>`apps/server/server-cap01-delivery.test.ts:①e 不许修过头` | 宿主机制 | 已覆盖 | — |
| 完成消息要让用户看出是哪件事（业务名）：**评测守（真模型）**，宿主不再保证 | `apps/server/server-completion-wake.test.ts:⑤ 完成消息要让用户看出是哪件事` | 宿主机制 + 真模型统计 | 部分 | 宿主身份行已随唤醒切片删除：用户可见文本 = 模型写的话，宿主不再拼业务名。确定性用例只钉「事实里带业务名 →（脚本）模型复读后用户可见文本出现该名」这条链。**未覆盖范围：模型可能不说业务名（收着名字只报结果、或用指代）——当前无真模型用例守（`npm run eval:user` / 真模型跑批未覆盖此点），不许写成已覆盖**。 |
| 后台失败：**唤醒模型说**（宿主只喂事实：业务名 + 归类后的业务种类 + 机械原因），不冒充成功 | `apps/server/server-state-wake.test.ts:① 后台失败 → 投递文本 == 脚本模型唤醒回合那句`<br>`apps/server/server-state-wake.test.ts:①d 回合抛错（执行器/Worker 驱动故障）也是失败终局`<br>`apps/server/server-notification-push.test.ts:① 后台失败 → 主动一句人话`<br>`scripts/eval/smoke/slow-faults.test.ts:跑了 2.5s 才失败`<br>`scripts/eval/wecom-sim/cases-c-failure.test.ts:W-10 faulty-one` | 宿主机制 | 已覆盖 | 失败话术本身降级为「模型回合挂掉」的兜底（`server-cap01-delivery.test.ts:⑨ 失败投递的用户文本等于话术模板` 仍钉那条兜底路径） |
| 后台失败·唤醒降级/走岔路：模型只调工具或说不出话 → 用户仍拿到既有失败话术；事实留待注入 | `apps/server/server-state-wake.test.ts:①b 走岔路`<br>`apps/server/server-state-wake.test.ts:①c 唤醒不可用` | 宿主机制 | 已覆盖 | — |
| 唤醒回合不得碰执行层：只读任务工具声明、执行层零新增调用、任务不被误判终态 | `apps/server/server-state-wake.test.ts:①b 走岔路`<br>`packages/agent/runtime.test.ts:冷会话（驱动可唤醒但实例级会话还没建）→ 补一次**只读任务工具**单回合`<br>`packages/agent/pi-driver-wake.test.ts:走岔路：脚本模型在唤醒回合硬发工具调用` | 宿主机制 | 已覆盖 | — |
| 用户说停：唤醒模型说（不再由宿主渲染「已按你说的停了」）；模型说不出话才投渲染文案 | `apps/server/server-state-wake.test.ts:② 取消 → 唤醒模型说`<br>`apps/server/server-state-wake.test.ts:②b 走岔路`<br>`apps/server/notification-chat-sink.test.ts:① user_stop 不再由本 sink 渲染直发` | 宿主机制 | 已覆盖 | — |
| 重启对账：启动时「用户以为在办、租约已过期」的任务如实写结束事实（结果未知）→ 唤醒原会话说清；不重放 | `apps/server/server-state-wake.test.ts:④ 启动时租约已过期`<br>`apps/server/server-state-wake.test.ts:④b 走岔路：模型说不出话`<br>`apps/server/server-state-wake.test.ts:④c 非 live 部署不唤醒` | 宿主机制 | 已覆盖 | — |
| 快活失败 + 模型沉默：兜底判据只看模型沉默（**与有没有文件无关**），失败话术照样送达（审计 #8） | `apps/server/server-relay-silent-turn.test.ts:③c 快活失败 + 沉默` | 宿主机制 | 已覆盖 | — |
| 等补信息：主动说清还缺什么，补答后同一任务续跑完成 | `apps/server/server-notification-push.test.ts:② 后台任务等你说一句话`<br>`scripts/needs-input-resume.test.ts:① 执行层要补输入`<br>`scripts/needs-input-resume.test.ts:② 用户补答 → 同一 taskId/taskNo 续跑到有汇报`<br>`scripts/eval/smoke/slow-faults.test.ts:缺参 → waiting_user 且问题可见` | 宿主机制 + 执行层 | 已覆盖 | — |
| 不补答：停在 waiting_user、绝不重复执行 | `scripts/needs-input-resume.test.ts:③ 用户不补答`<br>`scripts/eval/smoke/slow-faults.test.ts:不补答：停在 waiting_user` | 宿主机制 + 执行层 | 已覆盖 | — |
| 取消在跑任务：进程内（在飞 run_js / 执行层调用中止）；请求 ≠ 已取消 | `packages/agent/task-cancel-inflight.test.ts:① 在飞 run_js`<br>`scripts/r4-integ-joint.test.ts:⑥ 取消请求不被报成已取消` | 宿主机制 | 已覆盖 | — |
| 取消已完成任务：如实拒绝、不把 completed 改成 cancelled | `packages/agent/task-cancel-inflight.test.ts:③ 已完成任务再取消`<br>`scripts/eval/business-e2e/experiments/experiments.test.ts:T01：task_run/task_status/task_result/task_cancel 各发生一次` | 宿主机制 | 已覆盖 | — |
| 排队长尾：排队受控、超界确定性拒绝（resource_limited）、满员不影响运行中任务 | `packages/agent/background-queue-bound.test.ts:① 上界内接受`<br>`packages/agent/background-queue-bound.test.ts:② 超界拒绝`<br>`apps/server/server-capq-queue.test.ts:① 缺省 16：5 个会话并发`<br>`scripts/stab/pressure.test.ts:P2 池满持续` | 宿主机制 | 已覆盖 | — |
| 后台并存：后台满载不阻塞前台；同会话并发消息各自回复、不互覆盖 | `scripts/r4-integ-joint.test.ts:⑰ 后台满载不阻塞前台`<br>`apps/server/server-r4-background.test.ts:⑪ 同会话两条并发消息` | 宿主机制 | 已覆盖 | — |
| 跨重启：任务不重放、结果找回、queued 重领 / 过期租约如实 result_unknown | `scripts/r4-integ-joint.test.ts:⑤ 重启恢复`<br>`apps/server/server-b1-persistence.test.ts:②③ 任务恢复不重放 + 结果找回`<br>`packages/agent/dispatch-key-identity.test.ts:恢复后的同名操作：回放已有结果`<br>`scripts/stab/chaos.test.ts:C1 重启 × 通知失败` | 宿主机制 | 已覆盖 | — |
| 消息幂等：同 messageId 重投回执重放、零新任务（进程内 + 跨重启 + 崩溃遗留） | `apps/server/server-inbound-idempotency.test.ts:① 同一 messageId 连发两次`<br>`apps/server/server-inbound-idempotency.test.ts:② 关掉 server、同 dbPath 重建`<br>`apps/server/server-inbound-idempotency.test.ts:③ 底账留 processing`<br>`scripts/stab/chaos.test.ts:C2 重启 × 重复消息` | 宿主机制 | 已覆盖 | — |

## 四、长任务（accepted / 续跑 / abort）

| 场景 | 自动用例 | 层级 | 覆盖度 | 缺口说明 |
| --- | --- | --- | --- | --- |
| 长任务受理：交办回合照发模型的话、后台挂起不占会话、完成后主动投递一次 | `scripts/eval/wecom-sim/cases-h-newcap.test.ts:W-42 长任务`<br>`scripts/long-task-assembly.test.ts:accepted → 任务仍在推进且槽位/租约释放` | 宿主机制 + 执行层 | 已覆盖 | — |
| accepted 后续跑 / abort 取消 / 停不下来如实说仍在推进（不编造已停） | `packages/agent/long-task-async.test.ts:① accepted → 回合结束、槽位释放`<br>`packages/agent/long-task-async.test.ts:③ abort → 任务写结束事实` | 宿主机制 | 已覆盖 | — |
| 长任务跨重启：新 runner 从底账 accepted 行重新 wait 续跑、不重复发起 | `packages/agent/long-task-async.test.ts:④ 重启：关库重开，新 runner 从底账 accepted 行重新 wait` | 宿主机制 | 已覆盖 | — |
| 未声明 long_running 却返回 accepted → fail-closed | `packages/agent/long-task-async.test.ts:⑤ 未声明 long_running 的 operation 返回 accepted` | 宿主机制 | 已覆盖 | — |
| 预期式提醒：超阈值恰一条、长任务也要提醒、群聊覆盖（#9） | `scripts/eval/wecom-sim/cases-h-newcap.test.ts:W-43 预期式提醒`<br>`apps/server/server-long-running-notice.test.ts:① 1:1 会话：任务超阈值无事件`<br>`apps/server/server-long-running-notice.test.ts:② 群聊也发` | 宿主机制 + 执行层 | 已覆盖 | — |

## 五、写确认（提案 / 确认 / 重复 / 权限）

| 场景 | 自动用例 | 层级 | 覆盖度 | 缺口说明 |
| --- | --- | --- | --- | --- |
| 写请求先给提案零写入；确认后写入读回；二次确认确定性拒绝 | `scripts/eval/wecom-sim/cases-f-write.test.ts:W-22 写请求先给提案、零写入`<br>`packages/agent/write-confirmation.test.ts:prepare 只出提案不写`<br>`packages/agent/write-confirmation.test.ts:重复确认：同一句柄只执行一次`<br>`scripts/host-write-confirmation.test.ts:1 正常：prepare → 用户「确认」` | 宿主机制 + 执行层 | 已覆盖 | — |
| 提案内容让用户看到「要写入什么」：摘要作为机械事实交给模型，模型怎么说用户就逐字收到什么 | `apps/server/server-task-wait-window.test.ts:b2. 提案回合：模型自己说要写入什么`<br>`packages/agent/background-write-confirmation.test.ts:⑧ 提案回合走岔路`<br>`scripts/eval/wecom-sim/cases-f-write.test.ts:W-22 写请求先给提案、零写入` | 宿主机制 + 真模型统计 | 部分 | **宿主不再保证**（提案卡替换已删）：自动化只钉住「执行层摘要作为机械事实到达模型」与「模型说什么，用户逐字收到什么」；**没有真模型用例断言模型稳定转述摘要**（eval:user E01–E15 无写确认场景）。这条只能由真模型评测守——脚本模型走岔路（W-29 / ⑧）时用户看不到「要写入什么」，属已接受的措辞风险 |
| 不确认 / 改说别的：零写入、提案未被消费仍可拒绝 | `packages/agent/write-confirmation.test.ts:不确认：零写入`<br>`scripts/host-write-confirmation.test.ts:2 不确认、改说别的` | 宿主机制 + 执行层 | 已覆盖 | — |
| 句柄安全：越权 / 过期 / 缺句柄 / 绑定不一致 → 拒绝且零写入 | `packages/agent/write-confirmation.test.ts:越权：另一个会话`<br>`packages/agent/write-confirmation.test.ts:过期：构造过期提案`<br>`packages/agent/write-confirmation.test.ts:缺句柄：commit 没有 confirmation`<br>`packages/agent/write-confirmation.test.ts:绑定不一致：commit 的 collection/window/count 与提案不符` | 宿主机制 + 执行层 | 已覆盖 | — |
| 只读装配下写请求：明确拒绝、零写入、不宣称成功（E11 同口径） | `scripts/eval/wecom-sim/cases-f-write.test.ts:W-25 只读装配下同一写请求`<br>`scripts/write-confirm-loop.test.ts:默认只读 principal`<br>`scripts/write-confirm-loop.test.ts:写链路专用 principal`<br>`scripts/write-confirm-loop.test.ts:resolveExecutionFace（不开开关）` | 宿主机制 + 执行层 | 已覆盖 | — |
| 后台任务写确认：待确认提案阻塞新交办、接续轮透传、句柄不进模型/用户面 | `packages/agent/background-write-confirmation.test.ts:⑧ 已有待确认提案时再 task_run 被拒绝`<br>`packages/agent/background-write-confirmation.test.ts:⑤ S2 待确认推送`<br>`packages/agent/oversize-data-fileize.test.ts:⑤ needs_confirmation 不受影响` | 宿主机制 | 已覆盖 | — |
| 批量写入：items 逐条、一条坏整批拒、partial 不谎报成功 | `packages/agent/batch-write-items.test.ts:① 全成功：items 逐条 ok`<br>`packages/agent/batch-write-items.test.ts:② 注入一条写失败`<br>`packages/agent/dummy-client.test.ts:第 137 条不合法` | 执行层 | 已覆盖 | — |

## 六、提醒（10 分钟 · 群聊覆盖）

| 场景 | 自动用例 | 层级 | 覆盖度 | 缺口说明 |
| --- | --- | --- | --- | --- |
| 长任务提醒阈值 10min：**唤醒模型说**（事实 = 业务名 + 已跑多久）、每任务一次、第二次扫描不再发 | `packages/agent/long-running-notice.test.ts:① 10 分钟内零发送`<br>`apps/server/server-state-wake.test.ts:③ 任务超阈值无事件 → 唤醒模型说`<br>`apps/server/server-long-running-notice.test.ts:③ 长任务（accepted 后租约被清）也要提醒` | 宿主机制 | 已覆盖 | 30 分钟「卡住」档已整档删除（文案/阈值/扫描/领取/配置键）——**不覆盖**该档是设计，不是缺口；旧 YAML 里的该键按未知字段拒绝（`resource-policy-single-source.test.ts` 已删键守卫） |
| 提醒降级：模型说不出话 → 宿主兜底句（停下来 / 继续等）、任务仍在推进（有活 worker） | `apps/server/server-state-wake.test.ts:③b 走岔路`<br>`apps/server/server-long-running-notice.test.ts:① 1:1 会话：任务超阈值无事件` | 宿主机制 | 已覆盖 | — |
| 重启不重发：已发落库，重开扫描零次发送 | `packages/agent/long-running-notice.test.ts:② 重启不重发` | 宿主机制 | 已覆盖 | — |
| 提醒投递失败要能重来：同一档内重试一次（首投失败 + 重试成功 = 用户收得到）；成功即止、一直失败止于两次（不无限重试、不重复打扰） | `packages/agent/long-running-notice.test.ts:⑥ 先领取后投递失败`<br>`packages/agent/long-running-notice.test.ts:⑦ 不该重试的仍然不重试` | 宿主机制 | 已覆盖 | — |
| 群聊**也发**久无动静提醒（owner 2026-11-19 #9：群 = 独立主体，群里的任务就是这个群的事）；群主体话术**不带业务名**（隐私口径），1:1 照常带 | `packages/agent/long-running-notice.test.ts:③ 群聊也发`<br>`apps/server/server-long-running-notice.test.ts:② 群聊也发`<br>`apps/server/server-long-running-notice.test.ts:群主体：照样发`<br>`scripts/eval/wecom-sim/cases-h-newcap.test.ts:W-43 预期式提醒`<br>`scripts/eval/wecom-sim/cases-i-interaction.test.ts:I-6 群聊` | 宿主机制 | 已覆盖 | 旧口径「群聊零主动提醒」已作废（sim 的 W-43 群对照 / I-6 / J-2 按新口径迁移，非删除）；**附件追问**仍只在单聊（`apps/server/server-attachment-nudge.test.ts:④ 群聊 → 不发追问`，本轮未改） |
| 提醒判据只看底账任务事实（任务属于谁、活在哪个会话）：**重启后**（进程内无任何 inbound、无会话集合）照样发 | `apps/server/server-long-running-notice.test.ts:②b 重启后判据` | 宿主机制 | 已覆盖 | 进程内 `directSessions` 集合整体删除（#10） |

## 七、失败与话术

| 场景 | 自动用例 | 层级 | 覆盖度 | 缺口说明 |
| --- | --- | --- | --- | --- |
| 执行层失败 / 拒绝 / 超时：如实转述、不假装成功、不给数 | `scripts/eval/wecom-sim/cases-c-failure.test.ts:W-10 faulty-one`<br>`scripts/eval/wecom-sim/cases-c-failure.test.ts:W-11 denied-one`<br>`scripts/eval/p2/p2-scenarios.test.ts:S7a 失败：faulty-one COLLECTION_FAULT 如实失败`<br>`scripts/eval/p2/p2-scenarios.test.ts:S7b 超时` | 宿主机制 + 执行层 | 已覆盖 | — |
| 失败话术：每种失败带可执行动作、无内部术语 | `packages/agent/user-facing-failure.test.ts:③ 每种失败都带可执行动作`<br>`packages/agent/user-facing-failure.test.ts:⑤ 内部术语闸` | 宿主机制 | 已覆盖 | — |
| 虚假完成 / 编造数值：判负、宿主防假成功（不嗅探文本） | `scripts/eval/business-e2e/judge.test.ts:虚假完成判负：回复称完成但执行记录为空`<br>`scripts/eval/cap01/r2d-judge.test.ts:回复编数：宿主红，模型红`<br>`packages/agent/runtime.test.ts:⑤b 反向绊线：零执行 + 声称成功的汇报文本 → 不产生任何执行行（只认执行事实，不嗅探文本）` | 宿主机制 + 执行层 | 已覆盖 | — |
| needs_input / 结果未知：如实「待核对」、补答续跑、不冒充成功 | `packages/agent/result-unknown-cancel.test.ts:写操作已 unknown 后同回合取消`<br>`packages/agent/dispatch-key-identity.test.ts:外部写入结果未知：停止自动重试`<br>`scripts/eval/sim/cases/cases.test.ts:SIM-10：回执丢失` | 宿主机制 + 执行层 | 已覆盖 | — |
| 快活失败（窗口内落定）：零推送，模型同回合已说明，不重复打扰 | `apps/server/server-notification-push.test.ts:⑤ 快活失败（窗口内落定）→ 零推送` | 宿主机制 | 已覆盖 | — |
| 资源受限失败（池满）：走既有「系统太忙，这个没接」句 + 一个动作，不说成「执行端没办成」（审计 #18） | `apps/server/server-relay-silent-turn.test.ts:③b 资源拒绝` | 宿主机制 | 已覆盖 | — |
| 装配面缺陷（accepted 但没有等待端口）：写结束事实 + 结构化事件进告警面，**不给用户编话**（审计 #3 · 归宿第 3 档） | `packages/agent/long-task-async.test.ts:⑤b 声明了长任务但装配没给等待端口`<br>`packages/agent/alert-rules.test.ts:命中：装配面缺陷` | 宿主机制 | 已覆盖 | 告警面 = 既有 `npm run alerts`（host_fault 规则认 `task_long_task_unsupported`；双出口 alerts.jsonl / 企微推送），未新建规则 |

## 八、权限（viewer / operator / admin / 群主体）

| 场景 | 自动用例 | 层级 | 覆盖度 | 缺口说明 |
| --- | --- | --- | --- | --- |
| 角色三档：viewer 写被发起前拒绝（不提 operation 名）、operator 放行、admin 同 operator、未写 role=viewer | `scripts/rbac-roles.test.ts:① viewer 调写：宿主发起前拒绝`<br>`scripts/rbac-roles.test.ts:② operator 调写：放行`<br>`scripts/rbac-roles.test.ts:③ admin 同 operator`<br>`scripts/rbac-roles.test.ts:④ 未写 role 的 principal → viewer` | 宿主机制 | 已覆盖 | — |
| 部署总闸关闭：角色含 write 也不放宽 | `scripts/rbac-roles.test.ts:⑥ 部署总闸关闭`<br>`scripts/write-confirm-loop.test.ts:resolveExecutionFace（不开开关）` | 宿主机制 | 已覆盖 | — |
| 群主体权限：群 role=viewer 群里写被拒、该人员工 operator 个人可写 | `scripts/rbac-roles.test.ts:⑦ 群主体 role: viewer`<br>`scripts/eval/wecom-sim/cases-h-newcap.test.ts:W-44 viewer 只读` | 宿主机制 | 已覆盖 | — |
| 群组身份与隔离：同群共享（转录 / 任务 / 文件）、跨群全拒绝、无内容泄漏 | `scripts/eval/long-session/multiuser/mu-group.test.ts:同群 A/B 交办归同一群主体`<br>`scripts/eval/long-session/multiuser/mu-group.test.ts:同群 B 能用 A 的 fileId 交办`<br>`apps/server/server-group-principal.test.ts:group-1 与 group-2 的 principal/session 不同` | 宿主机制 | 已覆盖 | — |
| 多用户隔离：越权查 / 取消 / 接续被拒、通知只投 owner（MU-1\~MU-10） | `scripts/eval/long-session/multiuser/mu.test.ts:≥3 principal 并发交办`<br>`scripts/eval/long-session/multiuser/mu.test.ts:B 经任务工具访问 A 的 #1`<br>`scripts/eval/long-session/multiuser/mu.test.ts:事实只注入 owner 会话`<br>`scripts/eval/business-e2e/shared-instance.test.ts:B 查/取 A 的任务 → 找不到` | 宿主机制 | 已覆盖 | — |

## 九、幂等（进程内 / 跨重启）

| 场景 | 自动用例 | 层级 | 覆盖度 | 缺口说明 |
| --- | --- | --- | --- | --- |
| 同任务重复受理被拒；同 code+inputs 重放命中 memo 不重跑、不重复登记 | `packages/agent/runtime-worker-run-js.test.ts:幂等（v8 §5）：同 code+inputs 的重放命中 memo`<br>`packages/agent/task-runner.test.ts:④ 幂等：同 taskId 重复受理被确定性拒绝`<br>`packages/agent/dispatch-key-registry.test.ts:参数完全相同的两条合法操作` | 宿主机制 | 已覆盖 | — |
| 通知去重 / 投递失败有界退避重试 / 重启后去重与未送达仍可见 | `packages/agent/notifications.test.ts:投递成功：写 delivered_at`<br>`packages/agent/notifications.test.ts:连续失败→恢复`<br>`packages/agent/notifications.test.ts:重启后去重仍生效、未送达仍可见`<br>`scripts/stab/soak.test.ts:S2 浸泡 × 通知间歇失败` | 宿主机制 | 已覆盖 | — |
| 通知投递不假记送达（2026-11-19 投递真相切片）：终态跳过不写 delivered_at、不再重试；改期不消耗尝试次数；推送失败由既有退避重试接管 | `packages/agent/notifications.test.ts:终态跳过（sink 报 skipped）`<br>`packages/agent/notifications.test.ts:改期（sink 报 deferred）`<br>`apps/server/notification-chat-sink.test.ts:③ 非 live`<br>`apps/server/notification-chat-sink.test.ts:⑤ 会话有回合在跑`<br>`apps/server/notification-chat-sink.test.ts:改期/瞬时故障一路不记 delivered` | 宿主机制 | 已覆盖 | — |

## 十、运维告警

| 场景 | 自动用例 | 层级 | 覆盖度 | 缺口说明 |
| --- | --- | --- | --- | --- |
| 运营告警规则：执行失败 / 超时（10min / 30min 边界）/ 投递非 sent 命中；冷却窗口去重 | `packages/agent/alert-rules.test.ts:命中：同一任务执行事实达到阈值`<br>`packages/agent/alert-rules.test.ts:边界：仍在推进、10 分 1 秒没有新事实告`<br>`packages/agent/alert-rules.test.ts:命中：file_delivery 状态非 sent`<br>`packages/agent/alert-rules.test.ts:同一 (rule, subject) 冷却窗口内只出一次` | 宿主机制 | 已覆盖 | — |
| 投递终局进告警面（2026-11-19 第 3 档）：通知 attempts 用尽（exhausted）/ 长活提醒投递失败 / **live 部署上的终态跳过**（配错：用户彻底收不到）→ `delivery_failed`（critical，真投影+真规则）；silent·unavailable 的 skipped 与正常送达不告警 | `scripts/ops/alerts.test.ts:通知投递失败到 attempts 上限`<br>`scripts/ops/alerts.test.ts:长活提醒投递两次都失败`<br>`scripts/ops/alerts.test.ts:终态跳过按`<br>`packages/agent/alert-rules.test.ts:命中：通知投递终局 exhausted`<br>`packages/agent/alert-rules.test.ts:命中：长活提醒投递 failed`<br>`packages/agent/alert-rules.test.ts:命中：live 部署上的终态跳过`<br>`packages/agent/alert-rules.test.ts:不命中：silent / unavailable 部署上的终态跳过` | 宿主机制 | 已覆盖 | — |
| 告警原文可回溯：raw 字段含被命中内部原文、不截断 | `packages/agent/alert-rules.test.ts:告警项 raw 字段包含被命中的内部原文，且不截断` | 宿主机制 | 已覆盖 | — |
| 运营页面：统计 / 失败清单 / 转义防注入 / 幂等生成 | `scripts/ops.test.ts:统计：总数与事实桶计数；恒等式 总数 = 各桶之和`<br>`scripts/ops.test.ts:恶意文本全字段：逐字段断言「原文不出现、转义实体出现」` | 宿主机制 | 已覆盖 | — |

## 十一、任务查询与结果找回

| 场景 | 自动用例 | 层级 | 覆盖度 | 缺口说明 |
| --- | --- | --- | --- | --- |
| 任务查询：task_status / #编号 / 详情 / 交付件 / 最终回复存档 | `packages/agent/task-surface.test.ts:task_status：空 ref 列本会话任务`<br>`packages/agent/task-surface.test.ts:task_result：completed 返回逐字存档`<br>`scripts/tasks.test.ts:详情：事实行 + 机械时刻；历史行不出现机械事实行`<br>`packages/agent/reply-archive.test.ts:completed/failed/unexecuted 三场景：回合收尾后回复逐字存档` | 宿主机制 | 已覆盖 | — |
| 结果找回：回查同一结果不重查；长会话回查早期结果 | `scripts/eval/sim/cases/cases.test.ts:首轮交付 + 第二次询问 + 找回同一结果 + 仅一次读取`<br>`scripts/eval/sim/cases/cases.test.ts:SIM-08#2：4 条消息后回查` | 宿主机制 + 执行层 | 已覆盖 | — |

## 十二、业务技能与用户级真模型统计

| 场景 | 自动用例 | 层级 | 覆盖度 | 缺口说明 |
| --- | --- | --- | --- | --- |
| 财务应收技能：汇总 / 未结清拆客户 / 指定客户筛选 / 逾期识别 / 数据缺失如实 | `scripts/eval/sim/cases/finance.test.ts:场景 1 正常交办：应收/已核销/未结清`<br>`scripts/eval/sim/cases/finance.test.ts:场景 3 指定客户筛选`<br>`scripts/eval/sim/cases/finance.test.ts:场景 4 发现逾期`<br>`scripts/eval/sim/cases/finance.test.ts:场景 5 数据缺失`<br>`scripts/eval/finance/truth.test.ts:按客户：应收 / 已核销 / 未结清` | 宿主机制 + 执行层 | 已覆盖 | 真模型面在 SIM-FIN（`scripts/eval/sim/cases/finance-cases.ts`），CI 预注册入口自动跑 |
| 用户级黑盒查数（E01–E15）：真模型如实交付、编造 / 假成功 / 无谓追问判负 | `scripts/eval/user-eval-comment.test.ts:全部用例按 CASE_IDS 顺序出现在表里`<br>`scripts/eval/business-e2e/judge.test.ts:干净样本判过：请求范围内读取 + 如实回复`<br>`scripts/eval/business-e2e/judge.test.ts:部分失败 + 如实不称完成：机械面判过` | 真模型统计 | 已覆盖 | 运行在 CI（`.github/workflows/eval-real.yml`；检测到 eval:eval-real 用真模型 + 仓内 dummy）；本行引用的是报告生成与判定器守卫——用例删 / 判据改，守卫即红；模型不可得时 CI 跳跑不等于用户能力退化，属 infra |
| 业务 E2E（B/T/C/DS 系列）：越界判负、部分失败诚实、取消如实、隔离 | `scripts/eval/business-e2e/bizprobe.test.ts:机械判负：越界执行 → 样本 failed`<br>`scripts/eval/business-e2e/bizprobe.test.ts:经真实 model-executor 全链跑一个样本` | 真模型统计 | 已覆盖 | 真模型跑批 `npm run eval:bizprobe`（`package.json:17`），infra 门 / 冻结锁在前；本行引用判定器与全链冒烟守卫 |
| 模拟用户长对话（SIM-01\~10）：部分失败、指代、叫停、两套账、排队写 | `scripts/eval/sim/cases/cases.test.ts:全部 15 个场景形状有效，且 SIM-05 先跑`<br>`scripts/eval/sim/cases/cases.test.ts:SIM-05：部分失败如实说明` | 真模型统计 | 已覆盖 | 真实跑批 `scripts/eval/sim/run-real.ts`（预注册 + 硬停 12）；本行引用 Oracle 与套件守卫 |
| 长会话跨压缩（LS 轨）：事实保留、任务连续性、回查内存 | `scripts/eval/long-session/oracle.test.ts:会话内约定事实字面匹配`<br>`scripts/eval/long-session/oracle.test.ts:H4：已汇报却零执行 → 虚假完成硬零` | 宿主机制 + 真模型统计 | 部分 | LS1–LS6 真实模型轨跑在 `wave1-runner.ts`（预注册 `docs/history/long-session-prereg.md`，已归档）；本行引用的是 Oracle 自检（确定性），真实模型读数尚未成为持续全体绿门（N 依赖模型可得性） |

## 十三、单实例

| 场景 | 自动用例 | 层级 | 覆盖度 | 缺口说明 |
| --- | --- | --- | --- | --- |
| 单实例纪律与双实例行为 | `apps/server/instance-guard.test.ts:② 锁被另一个存活且命令行匹配的 pid 占用 → 取锁失败，话术可操作（含 kill pid）` | 宿主机制 | 已覆盖 | 2026-11-19 起启动时取独占锁（`apps/server/main.ts:53` `guardSingleInstance`，先于连接渠道）；存活实例在则 exit(1)、陈旧锁可覆盖；双实例共享同一 `.runtime/state.db` 的**并发写**行为仍未测（第二个实例会被锁挡在连接渠道之前） |
| 指定接收人 / 转发结果到其它会话 | — | 宿主机制 | 缺口 | 所有投递断言都是「回到发起会话」（business-coverage 盲区 #9）；没有「把结果转发给指定人 / 其它群」的自动用例。真要做：先定语义（宿主把任务结果定向投递允许吗 / 谁授权），再写渠道侧定向投递守卫 |

## 与 business-coverage.md 的关系

`docs/product/business-coverage.md`（2026-11-17 业务级覆盖图）已被本矩阵**取代**：其八节场景（E 系列、文件面 S1–S3、能力与安全验收、多用户 MU、业务流程 B/T/C/DS、模拟用户 SIM、异步后台 P2、覆盖盲区）已全部吸收进上面各节，并补上了它没有的行（提醒、权限角色全档、运维告警、幂等、单实例、任务查询）。原文件暂留，仅作历史与盲区依据；新的增删改一律写在本矩阵，由 `scripts/coverage-matrix-guard.test.ts` 守卫。
