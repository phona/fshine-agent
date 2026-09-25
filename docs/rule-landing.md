# 规则 → 落点清单（唯一事实源索引）

> 本文是提示词规则的唯一事实源索引。原则（继承自已否决方向的复盘）：
>
> 1. 能用代码保证的，不写进提示词。
> 2. 同一事实只存在一处：**代码断言 / SKILL 事实 / 提示词**，三选一。
> 3. 提示词只写原则，不枚举场景。
> 4. 宿主多记住一个事实，模型就少填一个字段。
>
> **维护规则**：新增任何规则前先在这里登记落点；提示词里不允许出现本表之外的新规则。
> 落点失效（代码重构、SKILL 改写）时同步改本表，不要只改一侧。

## 1. 代码保证（确定性断言）

| # | 规则 | 落点 |
|---|---|---|
| C1 | （Phase 4 起删除）申报层实体证据校验随契约瘦身取消——实体范围守卫完全后移到计划层 C20；申报层只剩结构校验（C3） | 历史落点 `validateTurnDeclarationEvidence` 已删除；现由 C20 全权负责 |
| C2 | （Phase 4 起删除）referenced 分支随 8 字段契约取消。指代消解改为：宿主申报前注入证据（C18）→ 模型把实体加工进 request → 计划层 C20 逐字校验实体来源 | 现由 C18+C20 组合保证 |
| C3 | 自相矛盾申报退回模型重填，不消耗用户澄清轮次。Phase 4 后唯一检查：delegate 的 request 必须非空（把用户请求加工成自包含的一句话） | `turn-contract.ts` `isSelfContradictoryDeclaration` + `runtime.ts` 路由处 |
| C4 | 申报 platform_query 但零执行（无激活计划、无平台调用、无待确认计划）→ 不外发财务结论 | `packages/agent/src/runtime.ts` 出口校验（`delegate_without_execution`） |
| C5 | Main Agent 跳过申报 → 重试一次，仍跳过则失败关闭，丢弃自由文本 | `runtime.ts`（`route_declaration_missing`） |
| C6 | ~~账套存在性查询的计划必须且只能是一次 `finance.search-account-sets`，关键词在申报范围内~~ → 计划实体来源校验：每个 call 的 args 里所有字符串（`-` 开头的 flag 除外）必须能在「当前消息 / 检索证据 / 本轮平台响应」里逐字找到 | `packages/agent/src/turn-contract.ts` `validatePlanEntities`（宿主不再判别操作与任务类型的匹配，该项归 17dz `src/execution/plan.js` `PLAN_CALL_MISMATCH` + 17dz-query SKILL.md） |
| C7 | ~~余额计划只能调 `finance.query-receivables`；不得夹带凭证查询~~ → 同上（操作匹配归执行层；实体越权仍由 C20 挡下） | 同 C6 |
| C8 | ~~余额计划不得越权（账套/客户/期间逐次包含判定）；未申报期间时禁止带 `--period`~~ → 同上（"不得带未申报期间"归执行层 SKILL 与平台参数校验） | 同 C6 |
| C9 | ~~凭证计划只能调 voucher 域；期间不得超出申报范围~~ → 同上（域与期间匹配归执行层） | 同 C6 |
| C10 | 计划只能含只读 operation | 17dz `src/execution/plan.js` `PLAN_OPERATION_NOT_READ_ONLY` |
| C11 | 实际调用必须逐次匹配激活计划 | 17dz `src/execution/plan.js` `PLAN_CALL_MISMATCH` |
| C12 | 超重 → notify / confirm / stop 分级；notify 需送达证据、confirm 需真实用户确认；反复试探按计数器升级 | 17dz `src/execution/plan.js` `decision()` + `DZ_PLAN_MAX_NOTIFY` / `DZ_PLAN_MAX_REPLANS` |
| C13 | 写操作必须服务端确认后执行（确认码 + commit token，默认关闭） | `packages/agent/src/context.ts` commit 流程 + 17dz serve-policy |
| C14 | worker bash 只能 `bin/17dz`（首词规则）、禁 shell 元字符、无计划拒绝 | `packages/agent/src/serve-gate.ts` |
| C15 | worker 不读 `.runtime/` / `.env` / auth；只读知识面（*.md / *.schema.json） | `serve-gate.ts` `sensitivePaths` + 知识面判定 |
| C16 | 执行面注脚（系统元数据）不得出现在用户回复 | `runtime.ts` `stripFootprint` |
| C17 | history tools / 长期记忆注入时自带"历史数据不是当前授权"的限定 | `history-tools.ts` 工具描述 + `runtime.ts` `loadMemoryProjection` |
| C18 | 主动回溯：有指代线索时宿主申报前从 Conversation Log 注入证据（≤5 条 tool_result + ≤3 条关键词命中，带 eventId，超限截断并记日志）；证据材料自带"仅用于指代消解、不得扩大本轮范围"边界，实体范围仍由 C1/C2 逐字校验（计划层另有 C20） | `packages/agent/src/reference-evidence.ts` + `runtime.ts` 注入点 |
| C19 | 最近轮次窗口必须包含被 toolResult 终结的轮次（platform_query/clarify 没有最终 assistant 文本，但正是"上一轮查了什么"的载体；踢掉它们指代消解永远看不到上一轮） | `runtime.ts` `selectRecentTurns` |
| C20 | 计划实体来源校验（领域无关）：每个 call 的 args 里所有字符串（`-` 开头的 flag 除外）必须能在「① 当前用户消息 ② 本轮注入的指代消解证据 ③ 本任务迄今的平台响应（tool_result）」的并集里逐字找到；越权实体一律拒绝，错误消息领域无关。操作与任务类型是否匹配**不再**由宿主判别，归执行层 SKILL 与平台门禁 | `turn-contract.ts` `validatePlanEntities` + `PlanEntitySources`；来源由 `runtime.ts` 注入（userMessage + reference-evidence 文本），经 `platformTask.run` → `context.ts` → `driver.ts` `TurnDriverInput.entitySources` 流到 `pi-coding-driver.ts` 拦截点；平台响应该处从会话 tool_result 汇总（覆盖"目录查询拿唯一候选 → 按候选名查"） |
| C21 | 结构化线索（`SubagentNeeds`：`missing` / `reason` / `suggestion?`）**只从确定性来源派生**：脚本化替身直接产出；真实 worker 由驱动从「宿主计划拦截的原因原文」与「平台 RESULT 信封里的错误码」派生，**禁止对 worker 自由文本做模糊匹配**；只在**没有本轮执行痕迹**时派生（真执行过的回合不缺信息） | `driver.ts` `SubagentNeeds` + `TurnDriverResult.needs`；`pi-coding-driver.ts` `needsClue()`（C20 拦截点记录）、`needsFromPlatformResponses()` / `isInputInsufficientCode()` / `missingLabelFromCode()`（只认 `platform-contract.ts` 的 RESULT 信封，`PLAN_*` 门禁码不算"缺用户信息"）；经 `context.ts` 挂到 `SubagentTaskResult.needs` |
| C21a | 同任务内计划被拒的收敛保护：连续被拒超过 5 次即 terminal block（PLAN STOP，让 worker 停止重提、向用户说明缺什么）。计划被拒是确定性信号，反复重提只空转预算——实测 D1 类请求（派生期间）曾空转 5 分钟后 executor 崩溃 | `pi-coding-driver.ts` `MAX_DECLINED_PLANS_PER_TASK` |
| C22 | 委派结果带 `needs` 时宿主**不 terminate 整轮**：把线索（缺什么 / 为什么 / 建议用户提供什么 + taskId + continueTaskId 重派提示）作为工具结果交还 Main Agent，由其继续本回合——能自己补（实体只从当前消息 / 检索证据 / 本轮平台响应取）就重新申报 delegate（带 continueTaskId 与补齐后的 request），不能补就申报 conversation 转达用户；任务记录保持可续（worker 转录落库，taskId 已知会宿主侧）；单回合回路有上限，超限把线索转达用户而非失败 | `runtime.ts` delegate 分支：`renderNeedsToolResult` / `MAX_NEEDS_ROUNDS` / `delegation_needs` 埋点；转达用户用 `renderNeedsUserText`（零内部机制字样） |
| C23 | 出口校验（C4 的 Phase 5 修订）：`delegate` + 无执行 + 无 pending + **无 needs 回路进行中** → 才走 `delegate_without_execution` 兜底；needs 回路进行中时，Main Agent 转达用户的文本即本轮回复（不叠加"本轮没有真正查到平台数据"注脚），但**含数字结论仍须本轮有执行痕迹**——回路本身不是执行痕迹 | `runtime.ts` 出口校验：`needsLoop` / `needsRelay` / `needs_loop_relayed` 埋点 |
| C24 | 计划模式协议（roadmap Phase 6）：delegate 的 request 以「第N/M步：」开头 = 多步拆解的第 N 步（共 M 步）；**无前缀 = 单步模式，行为与 Phase 5 之前完全一样**（结果 terminate 成本轮回复）；有前缀 = 该步结果不 terminate，作为工具结果交还 Main Agent 继续下一步或申报 conversation 汇总。前缀由宿主用正则**机械**解析（`plan-steps.ts`），不做任何业务匹配；非法前缀（第 0 步 / 共 0 步 / N>M / 只有前缀没有正文）按单步处理——协议层 fail-open，fail-closed 仍在出口校验 | `plan-steps.ts` `PLAN_STEP_PREFIX_PATTERN` / `parsePlanStep` + `runtime.ts` delegate 分支；协议教学在 `ROUTE_CURRENT_TURN_TOOL.description`（**契约仍 3 字段，一个都没加**） |
| C25 | 计划模式的步骤 2..M 经 `continueTaskId` 在上一步返回的同一个 17dz 子任务内续跑（宿主透传为 taskId）：平台累计账本因此跨步累积，闸口看到的是全局重量（架构 §8"重计划不重置累计用量"的落地）。宿主不强制该字段——与 request 加工同属模型侧，协议在工具描述里教 | `runtime.ts` 委派参数透传 + `turn-contract.ts` continueTaskId 说明；e2e `turn-loop-plan-steps.test.ts` 6.1/6.2 断言三步 taskId 相同、账本调用数跨步累积 |
| C26 | 任务计划状态（架构 §2 第 6 条）：计划模式每步委派前 append `started` 事实（含 request/stepIndex/totalSteps），委派结果回来后按步补 `done`/`failed`/`needs` 终态事实，**taskId 写进该步的最后一条事实**（事前不知、事后回填）；停在用户确认门的步骤不写终态（投影保持 started，计划"打开"可跨回合续跑）。planId 由宿主在计划模式第一步生成（`plan_${requestId}`），同一拆解的所有步共享；跨回合续跑经 `latestOpenPlan` 找回（步号接得上且总步数一致才认同一个计划，否则新开）。状态只取宿主持机械可验证的信号：needs→needs、有执行痕迹→done、两者皆无→failed——**"这一步业务上成没成"由 Main Agent 汇总如实呈现，宿主不猜**。存储不可用/未注入 = 不落计划状态，功能降级但不报错 | `runtime.ts` `resolvePlanId` / `appendPlanFact` / `planStepSummary` + deps `taskPlans?: TaskPlanRepo`；事实与投影契约在 `packages/contracts/src/store.ts`（并行 stream），SQLite 实现在 `packages/core/src/store.ts` |
| C27 | 计划模式通知前缀：该步委派过程中平台计划门产出的 notify 文本，交付用户时加「第 N/M 步」前缀，让用户看到拆解的全局进度。前缀插在固定标记「计划通知：」**之后**——渠道适配器与 e2e 替身都按该标记识别通知帧；步骤标签由 runtime 从协议前缀解析，经委派参数 `stepLabel` 透传，宿主不进 Main Agent 工具 schema、不进 worker 提示词 | `runtime.ts` 委派参数 + `context.ts` `withStepLabel`（包装 `ctx.trusted.onNotice`）+ `plan-runtime.ts` `PLAN_NOTICE_PREFIX`；e2e 6.1 断言 `sdk.noticeTexts()` 含"第 1/3 步" |
| C28 | 汇总回合出口校验（C4/C23 的 Phase 6 扩展）：有计划模式执行痕迹（任一步真跑过）即放行汇总；**全部步骤都零执行时**，"三步都没查成"这种不含数字结论的如实汇总可以外发（不叠加"没有查到平台数据"注脚，埋点 `plan_steps_relayed`），但汇总里带数字结论仍被 `delegate_without_execution` 挡下——回路/拆解本身不是执行痕迹 | `runtime.ts` 出口校验：`planModeTurn` / `plan_steps_relayed`；单测 P6.9 |
| C29 | 业务 skill 只含程序性知识（架构 §5：任务类别与拆解表、每类必需信息、拆解原则、派单协议），**零执行口径**；由部署配置 `businessSkillPath`（默认 `docs/business-skill.md`）指向，启动时读文件注入 runtime deps，每回合追加进系统提示词（与日期行同性质）。文件缺失/读失败 = 跳过，不报错。删掉其中任意一条只会让编排变笨，不会产生错误数据结论（架构 §1 分层判据） | `docs/business-skill.md` + `apps/server/business-skill.ts`（唯一加载链，`assembly.ts` 与 `scripts/ask.ts` 共用）+ `runtime.ts` `businessSkill` / `BUSINESS_SKILL_HEADING` |
| C30 | 任一步失败不阻塞其他步骤（架构 §3）：单步失败（含 needs/零执行的错误结果）时宿主照常把后续步骤派出去，由汇总如实报告失败或缺信息的步骤。回路上限（`MAX_NEEDS_ROUNDS`）在计划模式下**按步计**——同一步反复重报才收口（收口方式是"跳过这一步继续后续步骤"，不是终止整轮），换一步即重新计数 | `runtime.ts` needs 分支 `needsStepIndex` / 计划模式 `renderPlanStepToolResult`；e2e 6.2 + 单测 P6.5 |

## 2. SKILL 事实（17dz 执行层持有，worker 经 Skill 机制读取）

运行态技能面：`17dz-platform/.agents/skills-serve`（`config/agent.yaml` `contextProfiles.17dz.skillRoots`）。

| # | 事实 | 落点 |
|---|---|---|
| S1 | 只问账套存在性 → 只调 `finance.search-account-sets --query`，不得用余额/科目/凭证探测 | `17dz-query/SKILL.md` 查询边界 |
| S2 | 余额未指定期间只查当前期间；查询失败后停止并如实报告，不用凭证跨期回溯估算 | 同上 |
| S3 | 未给账套且紧邻上下文无唯一指代时先问用户；历史账套不自动成为当前范围 | 同上 |
| S4 | 网关唯一入口 `bin/17dz query <脚本>`，不加 cd/env 前缀 | 同上，怎么查 |
| S5 | 不读 `.runtime/` / `.env` / auth；不写文件；不调用带 `--save` 的命令 | 同上，红线 |
| S6 | 账套名以本次查询结果匹配；多候选列出转问用户，禁止自行选择 | 同上，账套与期间解析 |
| S7 | 回答必含账套全名、期间、来源、截断说明；严禁编造金额 | 同上，回答要求 |
| S8 | 录入类写操作走 prepare 技能产出变更提案，服务端确认后落账 | `17dz-bookkeeping-prepare/SKILL.md` |

## 3. 提示词现状（Phase 3 后）

### 3.1 SYSTEM_PROMPT（Main Agent，`packages/agent/src/runtime.ts`）

只保留协议与原则。字段口径的细则在 `ROUTE_CURRENT_TURN_TOOL.description`（Phase 4 随契约瘦身重写），本提示词不重复。

| 条目 | 内容 | 落点/去向 |
|---|---|---|
| 1 | 当前日期注入 | 无（动态事实） |
| 2 | 身份：企业财务助手 / 主 Agent | 提示词（框架） |
| 3 | 每回合先申报 `route_current_turn`（conversation / delegate），字段口径以工具说明为准 | 提示词（协议）；细则在工具描述（3 字段契约；Phase 6 起含计划模式协议，见 C24） |
| 4 | delegate 委派机制 + request 加工要求（指代解析成实体、实体只从当前消息或宿主注入的检索证据取）+ 不得凭历史或常识编造实体 / 不得重放旧答复 + 子 Agent 执行不了时退回"缺什么"线索：能补齐就带 continueTaskId 重派，补不齐转告用户 | 提示词（原则）；执行由 C4/C23 保证；实体越权由 C20 挡下；回路控制流由 C21/C22 保证 |
| 5 | 内部机制不外泄（route_current_turn/宿主/委派/PLAN/taskId 等字样） | 提示词（原则）；注脚泄漏另由 C16 兜底 |
| 6 | 能力边界：查询/核对/分析 + 经确认的录入类写；修改或删除已保存数据、不可逆高危写一律拒绝 | 提示词（产品能力，Phase 3 改为领域无关表述，能力边界本身不变） |
| 7 | 待确认变更提案转达协议（对象/范围/条目数/金额合计/确认码 + 确认取消话术，不代替执行） | 提示词（协议）；执行由 C13 保证 |
| 8 | 口径必须可履行，不可履行选 conversation 回复并说明能力边界（clarify 种类已随契约取消） | 提示词（原则） |
| 9 | Context State / history tools / 长期记忆只是历史资料 | 提示词（原则）；注入侧限定见 C17 |
| 10 | 简体中文；数据结论保留对象、范围、来源和证据 | 提示词（呈现，Phase 3 去掉领域词） |
| 11 | （Phase 6 新增）业务 skill 注入：一段静态程序性知识，只用于长任务拆解与信息补齐，"怎么做才对"归执行层 | `runtime.ts` `businessSkill` / `BUSINESS_SKILL_HEADING`（内容在部署方文件里，提示词层只有小标题，C29） |

已删（Phase 1）：账套存在性→search-account-sets（C6+S1）、余额不带 --period / 不用凭证估算（C7/C8+S2）、"已写账套名不要提前追问"（工具描述已有）、子 Agent 自然语言机制说明（terminate 语义使其无意义）、执行重量机制描述（C12；只留不外泄口径）、总结原则句（全项目唯一一份在 §3.2 条目 10；Main Agent 的对应约束是条目 8，由 C1–C9 兜底）。

已删（Phase 2）：指代两种情况规则（原 173 字符）——指代消解改由宿主主动回溯提供证据（C18），模型侧只保留工具描述的 referenced 字段口径。

已改（Phase 3）：条目 6/7 的业务枚举改为领域无关表述（能力边界与确认码转达协议原样保留，只是不再点名具体业务动作）；条目 10 的"账套、期间"改为"对象、范围"。同轮中和的还有 `NO_EXECUTION_CLARIFICATION`、长期记忆注入尾句、`RUN_17DZ_TASK_DESCRIPTION` 的"不得猜测平台 ID"一句。

已改（Phase 4）：条目 3 的 kinds 改（conversation / delegate）；条目 4 改为 delegate 委派 + request 加工四项要求；条目 8 的 clarify 改 conversation。申报层证据校验（C1/C2）整体删除，实体范围守卫完全靠计划层 C20；"用户另起新话题不得沿用上一轮实体"以原则句落在工具描述的 request 加工节（原 C1 的 explicit 分支曾结构性盖住，见 §6）。

已增（Phase 6）：条目 11 = 业务 skill 注入（C29）。**没有**为计划模式在 SYSTEM_PROMPT 里加规则——协议只有一份，落在 `ROUTE_CURRENT_TURN_TOOL.description` 的【计划模式】节（C24/C25）与业务 skill 的「派单协议」节（C29）；本提示词只保留条目 3 的"字段口径以工具说明为准"这一句总入口。

### 3.2 workerSystemPrompt（17dz 子 Agent，`packages/agent/src/context.ts`）

| 条目 | 内容 | 落点/去向 |
|---|---|---|
| 1 | 身份 + 回复直接展示给用户 + 不输出内部协议文案 | 提示词（框架） |
| 2 | 平台工作目录 | 部署配置注入 |
| 3 | 先读 SKILL/MECHANISMS 再调脚本；数据必须来自脚本结果 | 提示词（机制） |
| 4 | 按平台 SKILL 与 operation 文档声明的能力边界执行；超边界直接如实报告 | 提示词（能力边界，Phase 3 下沉：细则归 17dz SKILL.md）；执行由 C13 保证 |
| 5 | 计划协议：先提交 plan JSON，PLAN ACTIVE 后才能查询；DECLINED 重提 / NEEDS_USER_CONFIRM 收手 / STOP 说明原因 | 提示词（协议）；门禁裁决由 C10–C12 保证 |
| 6 | 宿主已核验的本轮请求（turnDeclaration.request 注入，不再序列化 JSON） | 宿主可信上下文 |
| 7 | 知识只经 read 读固定知识面 | 提示词（机制）；阻断由 C15 保证 |
| 8 | 应用层授权名单（allowedAccountSetIds） | 宿主可信上下文（Phase 3 去掉领域词） |
| 9 | 缺少信息或执行不了时，直接用自然语言向用户说明缺什么、为什么做不了、建议用户提供什么；完成时直接给出结论、数据和来源证据 | 提示词（原则）；结构化线索由 C21 从确定性来源派生，提示词层只负责"如实报告" |
| 10 | 总结原则：只执行宿主批准的计划内的调用；能力不足/不确定/被拒时如实说明并停止，不换口径试探，不代替用户做选择 | 提示词（原则）——**全项目只此一处** |

已删（Phase 1）：网关调用形式（S4+C14）、账套存在性→search-account-sets（C6+S1）、未指定账套先问/不带入历史（S3+C1）、余额期间与失败停止（C8+S2）、实现源码不可读的展开说明（C15 阻断时自带原因）。

已改（Phase 3）：条目 4 的"只读查询与录入类准备；修改/删除已保存凭证、过账、结账直接报告能力边界"整条改为"按平台 SKILL 与 operation 文档声明的能力边界执行"——能力边界细则归 17dz SKILL.md（另一 agent 并行补充），编排层不再枚举业务动作。

已改（Phase 5）：条目 9 并入纠错环规程——"执行不了时报缺什么/为什么/建议用户提供什么"，与条目 10 的总结原则同一份表述（能力不足/不确定/被拒时如实说明并停止，不换口径试探），不新增场景枚举。**17dz SKILL 里教 worker 输出结构化块归 Phase 6 的 17dz stream，本 Phase 不碰 17dz 仓**——所以真实 worker 的线索只能由驱动从确定性原因派生（C21），提示词层只保证"如实报告"。

**字符数**：Phase 1 验收时 SYSTEM_PROMPT 1491→908、workerSystemPrompt 1545→885。Phase 3 是改写不是删除（领域词换成领域无关表述，能力边界与协议原样保留），同一把尺子量：SYSTEM_PROMPT 831→845、workerSystemPrompt 838→835，基本持平；真正的删除发生在 `ROUTE_CURRENT_TURN_TOOL.description`（1101→1045，业务示例与字段判别教学整段移除）。

## 4. Phase 2/3/4/5 预告（避免重复登记）

- **Phase 2（已完成）**：指代规则整条删除；宿主申报前经 `reference-evidence.ts` 注入检索证据（C18）；`route_reference_hint` 与 `looksLikeReference` 已删除。
- **Phase 3（已完成）**：`validatePlanAgainstTurnDeclaration` 的 balance/voucher/account_search 三分支换成领域无关的 `validatePlanEntities`（C20）；两个提示词的业务条目改为领域无关表述；`ROUTE_CURRENT_TURN_TOOL.description` 的领域判别教学移除；`reference-evidence.ts` 注入材料与进度/压缩提示词同步中和。宿主不再做领域判别，操作与任务类型的匹配归执行层 SKILL 与平台门禁。
- **Phase 4（已完成）**：`ROUTE_CURRENT_TURN_TOOL` 8 字段 → 3 字段（kind/request/continueTaskId，schema 属性数=3）；`validateTurnDeclarationEvidence`/`previousTurnText`/`applyRouteDeclaration`/clarify 种类全部删除；委派 request 用加工后的 `intent.request`（原始消息只留在 `entitySources.currentMessage`）；申报层只剩结构校验，范围守卫完全靠 C20。
- **Phase 5（已完成）**：纠错环落地（C21/C22/C23）。`route_current_turn` 契约**一个字段都没加**——"缺什么"挂在委派结果（`SubagentTaskResult.needs`）上，不进申报 schema（宿主多记住一个事实，模型就少填一个字段）；工具描述只补一段回路协议教学（委派被退回时怎么办）。结构化块的教学归 17dz SKILL，留给 Phase 6。
- **Phase 6（已完成）**：计划模式协议（C24/C25/C30）、任务计划状态（C26）、通知步骤前缀（C27）、汇总出口校验（C28）、业务 skill 注入（C29）。同样**一个 schema 字段都没加**——「第N/M步：」写在 request 里，宿主机械解析。17dz 仓的 worker 结构化块教学不在本 Phase 范围（fshine 侧零改动）。
- **Phase 5（已完成）**：纠错环落地（C21/C22/C23）。`route_current_turn` 契约**一个字段都没加**——"缺什么"挂在委派结果（`SubagentTaskResult.needs`）上，不进申报 schema（宿主多记住一个事实，模型就少填一个字段）；工具描述只补一段回路协议教学（委派被退回时怎么办）。结构化块的教学归 17dz SKILL，留给 Phase 6。

## 5. Phase 3 验收 grep 的剩余命中（为什么允许）

`grep -rn "应收\|凭证\|科目\|账套\|期间" packages/agent/src/` 剩余 4 处，全部是**执行机制本身的字面量**，不是规则文案：

| 位置 | 内容 | 为什么允许 |
|---|---|---|
| `memory-candidate-extractor.ts` `ACCOUNT_SET_RE` / `BALANCE_RE` / `FINANCIAL_RESULT_RE` | 防止财务数据进长期记忆的过滤正则 | 代码断言（`isEphemeralFinance` 的匹配器），不是给模型的指令 |
| `context-extractor.ts` `hasContradiction` 的 oppositeTerms | "更多期间 / 当前期间"等反义词表 | 代码断言（短期上下文矛盾检测的词表） |

申报契约（C1）explicit 分支的澄清话术原也含领域词且被 `tests/e2e` 1.6/5.4 逐字断言，验收时已一并中和为"请直接告诉我要查询的对象；我不能从旧对话补入范围"，e2e 断言同步改为 `toContain('对象')`（测试名保留手工用例编号）——规则文案现已清零。

**Phase 6 复跑同一把尺子：仍是这 4 处，零新增。** 计划模式协议刻意只用"步/第 N 步"这类与领域无关的词（步骤标签 `第 1/3 步`、`第N/M步：`）；新代码同样避开"凭证"（用"执行痕迹"）、"账套"（用"对象"）、"期间"（用"时间范围/这一步"）。业务词只出现在 `docs/business-skill.md`（部署方持有的程序性知识）与 e2e 的业务替身里，不进 `packages/agent/src/`。

**Phase 5 复跑同一把尺子：仍是这 4 处，零新增。** 纠错环全部用领域无关表述——`missing` 的标签由平台错误码机械切分而来（`INVALID_PERIOD` → `period`，`ACCOUNT_SET_NOT_FOUND` → `account set`），fshine 侧不维护任何"错误码 → 中文业务名"的词表（那是执行层的知识）；C20 拦截点的线索用 `请求中未给出的对象`。新代码里刻意避开了"凭证"一词（用"执行痕迹"），免得和业务义的凭证混味。
## 6. Phase 4 验收记录：新话题实体沿用（模型侧失效）

**现象**（探针 `--quick` A2）：用户新话题「帮我查一下猫一杯的应收账款还有多少」，Main Agent 把上一轮的账套实体顺带加工进 request（"在幻辰财税里查猫一杯"），worker 先目录搜到该账套（平台响应含该实体）再查客户 → C20 全部放行，回复带上了旧账套。

**根因**：Phase 4 删除申报层实体校验（C1）后，"新话题不得沿用旧实体"失去结构性防线；C20 挡不住它——worker 的目录搜索响应会让该实体变成"平台解析出来的合法实体"。这是"实体只从当前消息/证据取"原则的模型侧违反，不是宿主契约漏洞。

**审计证据**（复刻探针保留 stateDir 后查 17dz audit.jsonl）：渗入轮的 worker 调用是 `query-receivables --query 幻辰财税`——即 Main Agent 把上一轮实体加工进了 request，宿主不再拦截（C1 已删），worker 的目录搜索响应又让该实体成为 C20 的合法"平台响应"来源。宿主契约无洞：C20 正确校验了实体**来源**，但按设计无法区分"解析用户的指代"与"沿用上一轮实体"——后者是 request 加工质量，归模型。

**处置与实测**：工具描述 request 加工节补原则句"用户另起新话题（新的查询对象）时，不得把上一轮的实体顺带沿用"（一行原则，非场景枚举——Phase 1 原则 3）。复测结果为**偶发**：同一代码下两次 A2，一次仍渗入（模型把幻辰加工进 request），一次worker 直接 `--query 猫一杯` 被平台以 ACCOUNT_SET_NOT_FOUND 拒并如实追问（零渗入）。与历史结论一致：提示词原则降低概率但不根除，归类为**模型侧已知失效**，由 A2/C1 类探针持续观察；若后续要结构性收敛，方向在 Phase 5 纠错环或宿主对 request 的轻量范围锚，不在提示词加规则。

## 7. Phase 5 验收记录：纠错环的边界与已知取舍

**落地形状**：线索 `{ missing: string[]; reason: string; suggestion?: string }` 挂在**委派结果**（`SubagentTaskResult.needs` → `TurnDriverResult.needs`）上，申报契约仍是 3 字段一个没加。

**两条产生路径**（都确定性，都不看 worker 自由文本）：

| 路径 | 来源 | 落点 |
|---|---|---|
| 脚本化替身 | e2e `gatedWorker` 的 `{ need: {...} }` 步骤直接产出 | `tests/e2e/harness.ts` |
| 真实 worker | ① 宿主计划拦截的原因原文（C20 越权）② 平台 RESULT 信封里的错误码（`isInputInsufficientCode`：`INVALID_`/`MISSING_`/`AMBIGUOUS_`/`REQUIRED_`/`NOT_FOUND`；`PLAN_*` 门禁码排除——那类停止原因不是"缺用户信息"，问用户也没有答案） | `pi-coding-driver.ts` `needsClue()` + `needsFromPlatformResponses()` |

**只在没有本轮执行痕迹时派生**（C21）：真执行过的回合不缺信息，把成功的结果拖进无谓的追问只会打扰用户——e2e 1.5/1.6"目录搜完如实报告"因此行为不变。

**回路里的数字结论**：needs 回路本身不是执行痕迹。Main Agent 在回路里给出含数字的结论仍被 C23 挡下（e2e 5.3 + 单测 P5.3）；转达用户的问题文本不外发注脚（用户已经知道在等什么）。

**已知取舍（记录待观察）**：
- 工具结果里带 continueTaskId 字样与任务编号，是给模型的内部协议材料。模型若把工具结果原样贴给用户会泄漏协议文案——归提示词第 5 条与 C16 兜底的模型侧失效类别，与 Phase 2 记录的同类问题一致；任务编号在落 Conversation Log 时已被 `redactInternalIds` 脱敏。
- 回路轮数上限 `MAX_NEEDS_ROUNDS = 3`：超限停止重派，把线索转达给用户（转达不是失败）。防的是模型在同一回合里反复空转，每轮都是一次完整委派。
- 真实 worker 的自由文本（"平台要求凭单查询必须显式给出期间"这类诚实汇报）仍走 terminate 路径，由 C4 的既有转发兜底——本 Phase 没有把它升级成结构化线索，因为那需要 17dz SKILL 教 worker 输出结构化块（Phase 6 的 17dz stream）。

---

## 8. Phase 6 验收记录（含主代理补丁）

真实模型探针（`--only D1,D2`）发现两个协议缺口，已修：

1. **M 未知时模型弃赛**（D2「把所有账套…查一遍」→ `route_declaration_missing`）：skill 教了"按账套拆 N 步"但没教总数未知怎么办。修复：`business-skill.md` 派单协议补一条——M 未知时先用无前缀单步委派枚举候选或向用户确认范围，拿不出 M 就不是多步任务。
2. **worker 反复重提被拒计划空转整回合**（D1 派生期间 → 302s 后 executor_error）：宿主对同任务内连续被拒没有收敛。修复：`MAX_DECLINED_PLANS_PER_TASK = 5`，超过即 PLAN STOP terminal block（C21a）。

**验证缺口已关闭**（模型切换至 StepFun `step-5-preview` 后复跑）：`--only D1,D2` **2/2 通过**——D1：worker 查到 1、2 月后被包含校验连续拒绝 → 收敛上限 PLAN STOP 触发 → worker 如实报告"只取到 1、2 月、3–9 月未查询、原因与建议逐字列出期间"，零估算，通知正常；D2：worker 按 skill 的"M 未知先枚举候选"枚举目录（含 `*`/空词/关键词试探，其中"有"真捞到幻辰实业），明确结论"平台没有列出全部账套的接口"并向用户索要关键词——模型不再弃赛，两条退路规程生效。最终 `--quick` 与基线同构（A1/A4/A5 ✓；A2 为 §6 已记录模型侧观察项；B1 ⚠ 为探针把"0"与"0.00"措辞差异当口径不一致的误报，五轮数据实际一致）。另记：从 StepCode 环境跑探针需先 `env -u LLM_*`（harness 继承变量会压过 `.env`），已写入 roadmap 验证协议。：计划模式、任务计划状态与业务 skill

**协议形状**（C24）：`request` 的「第N/M步：」前缀是宿主与 Main Agent 之间的协议，正则机械解析，零业务匹配。无前缀 = 单步，terminate 语义与 Phase 5 之前逐字相同；有前缀 = 交还模型，模型继续下一步或汇总。**申报契约仍 3 字段**（schema 属性数=3 有断言），协议全部写在工具描述的【计划模式】节。

**写入时序**（C26）：每步委派前 `started` → 委派结果回来后按步补 `done`/`failed`/`needs`，`taskId` 写进该步最后一条事实；停在用户确认门的步骤不写终态（计划保持"打开"，跨回合经 `latestOpenPlan` 找回，判据是"步号接得上且总步数一致"）。

**通知前缀**（C27）：`计划通知：【第 N/M 步】…`——固定标记保持在最前（渠道适配器与 e2e 替身按它识别通知帧），步骤标签由 runtime 解析后经 `stepLabel` 透传到 `context.ts` 的 `onNotice` 包装处。

**已知取舍（记录待观察）**：
- **步骤事实的 status 只记宿主持机械可验证的结局**：needs→`needs`、有执行痕迹→`done`、两者皆无→`failed`。"这一步业务上成没成"（平台回了 not_found、结果为空）由 Main Agent 在汇总里如实呈现，宿主不做文本匹配式猜测——与 C21"禁止对自由文本模糊匹配"同一条线。e2e 6.1 的第 2 步因此记 `done`（真调用了平台、平台真回了 not_found），失败由汇总报告。
- **回路上限按步计**：单步模式仍是"连续 3 轮缺信息就转达用户"（P5.4 不变）；计划模式下同一步反复重报 3 次才收口，收口方式是"跳过这一步继续后续步骤"而不是终止整轮——否则任一步失败会阻塞其他步，与架构 §3 相反。
- **计划模式被用户确认门打断时只续那一步**：该步 terminate 等真实确认，用户确认后走既有的 `resumeTaskId` 续跑路径（只整理已激活计划的结果，不带工具），后续步骤由下一回合的申报继续。这是 Phase 5 既有确认流的形状，未为计划模式新开一条恢复通道。
- **通知前缀只覆盖计划门的 notify/confirm 文本**（唯一经 `onNotice` 送达用户的链路）；普通进度帧（`onStep`）不带步骤标签——它本来就是阶段进度，不是范围通知。
- **业务 skill 的文件内容不在本表管辖范围**：它是部署方持有的程序性知识（架构 §5），fshine 侧只保证"存在才读、每回合进提示词、缺失不报错"（C29）。改写 skill 内容不需要改本表。
