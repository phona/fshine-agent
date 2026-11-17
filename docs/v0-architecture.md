# fshine-agent 架构

状态：**目标架构**。当前实现与它的差距见 §10；未完成项在那里列明，不在正文里假装已存在。**2026-11-11 定位收紧**：fshine 的组成 = Pi Agent + Task Runtime + Execution Gateway + Channel Adapter；已删机制单列在 §12，正文只在仍然有效的部分引用它们，且带状态。**本版已与 2026-11-11 删除裁定同批修订**：§12 九类、§2 相关行与 laws 的 L1 防御排除均已标状态；裁定记录以 decision-log.md 为准。**2026-11-12 修订**：§1 定位换第三版（业务人员视角：愿意 / 净收益 / 停止线）；§2 第 5 条与 §3 补拆解计划所有权仲裁（Main 拥有 Business Workflow，Worker 拥有 Platform Execution Plan）。**2026-11-13 M4 注**：正文引用的 `committed-unverified.ts` 与其它 Phase 2 宿主模块已随 M4 死代码清扫退役（decision-log §十三）；相关叙述按历史档案阅读。

---

## 1. 定位与三层分工

**定位（第三版，2026-11-12）**：让不懂技术的业务人员，**愿意**把日常工作交给 AI，并在使用中逐渐建立信任。关键词是「愿意」不是「能」。衡量它的是四件事：**交办简单 / 真正省事 / 行为可预期 / 随时能接管**。

**产品原则**：不追求 Agent 自治程度最大化，而追求**业务人员净收益最大化**（净收益 = 省下的操作与思考时间 − 沟通 / 等待 / 审核 / 返工 / 风险成本）。

**工程原则**：允许 Agent 自由决定执行方法，但**不允许它自行扩大任务授权**。落到架构上就是：模型负责决定如何完成任务；fshine 负责让任务的执行过程**可追踪**、执行结果**可验证**、异常状态**可恢复**——fshine 不是财税系统，**不拥有任何业务口径**，也不替模型规划每一步。前半句由基座与执行层承载（§1.1 / §8：方法与参数是模型和执行层的事）；后半句的落点是 T5 的判据——**执行集合 ⊆ 已确认计划，有界扩张门**（帽 = 既有读类探测帽缺省值 5；裁定形态待实施，见 [architecture-laws.md](architecture-laws.md)「机制分类」）。

**停止线**：每增加一个机制，问「**它是否能让业务人员更容易、更放心、更省时间地完成工作？**」不能明确证明就不优先做。

**组成（2026-11-11）**：**Pi Agent + Task Runtime + Execution Gateway + Channel Adapter**。四部分与 §1.1 三层的关系：**Pi Agent = 基座；Task Runtime、Execution Gateway、Channel Adapter = 胶水层（宿主）的三个组成，不是第四层**。Task Runtime 承载任务/计划状态、续跑与恢复、审计，概念模型见 §1.2；渠道适配与执行网关同住 §1.1 的胶水层。

**术语（2026-11-11 统一）**：**fshine（整体）** = Pi Agent + Task Runtime + Execution Gateway + Channel Adapter；**胶水层 / 宿主** = fshine 自有的编排与运行时部分（不含基座 Pi）；**执行层** = 当前接入实例的 agent 与业务实现。下文不再用「fshine」单独指胶水层；凡说「宿主」即指胶水层。

**不再自称 Agent Harness**：不追 OpenClaw / Claude Code / Codex 的通用功能面（不把它们的 feature 清单当 roadmap，不为"对齐某个 harness"新增机制）。基座用现成的 Pi，不重建 agent loop。

### 1.1 三层

```text
┌─ 基座（Pi，直接复用，不重建）──────────────────────────────┐
│  agent loop · 原生压缩 · 工具调用                          │
│  仓内实装：pi-agent-core 0.85.1 + pi-coding-agent +        │
│            pi-ai + chord + pi-telemetry                    │
│  Pi Durable 未采纳（§1.4）                                 │
└───────────────────────────┬────────────────────────────────┘
                            │ 复用 loop / 压缩 / 工具调用；模型自己决定如何完成
┌─ 胶水层（宿主 = fshine 自有编排）──────────────────────────┐
│  渠道适配（Channel Adapter）/ 身份 / 会话                  │
│  Task Runtime：任务与计划状态、续跑与恢复、审计            │
│  意图 → 结构化操作                                         │
│  Execution Gateway：计划门接平台                           │
│  出口清洗（状态由宿主机械渲染，模型只答数据）               │
└───────────────────────────┬────────────────────────────────┘
                            │ 结构化调用协议（目标见 a2a-protocol.md）
┌─ 执行层（当前接入实例，部署声明注入）──────────────────────┐
│  计划门预算梯子 execute / notify / confirm / stop           │
│  SCOPE_EXPANSION 检测                                      │
│  业务实体与口径、能力与参数声明、提案 schema、执行与读回    │
└────────────────────────────────────────────────────────────┘
```

| 层 | 职责 | 分工判据 |
|---|---|---|
| 基座（Pi） | agent loop、原生压缩、工具调用 | 能直接用就不重建；能力缺口从模型能力声明读，不写死常数 |
| 胶水层（宿主 = fshine 自有编排） | 渠道适配（Channel Adapter）/ 身份 / 会话；Task Runtime（任务与计划状态、续跑与恢复、审计）；意图→结构化操作；执行网关（计划门接平台，双门并行期只收紧不放宽，§8）；出口清洗 | 换一个执行层仍成立 |
| 执行层（当前实例） | 计划门预算梯子 execute/notify/confirm/stop；SCOPE_EXPANSION 检测；业务实体、口径、能力、提案、执行与读回 | 换一个执行层就换掉 |

> **执行层实例名不在本文复述**：当前实例由 AGENTS.md 与部署 profile 声明承载。`packages/agent/public-surface-lint.test.ts` 把 docs 中的实例名命中判为表外新命中即红——本文复述实例名会当场破门，所以三层图与全表只用「执行层（当前实例）」。这不是"没有实例"，是"实例名只许住部署声明、AGENTS.md 与改造史台账（debt-ledger / change-safety，该守卫显式排除）"。

**方向不变**：结构化调用协议（[a2a-protocol.md](a2a-protocol.md)）仍是外部调用的目标形态——意图 → 结构化操作 → 网关调用，六阶段、失败分类与声明原则照旧。本文删除的是 `route_current_turn` 的申报层 1+2（§12 ⑦），不是协议方向。**状态更新（2026-11-12）**：申报层已随直连工具面在 `arch/direct-tool-final` 正式删除（工具/解析/退回/申报状态字段与提示词全删；`resend_artifact` 已成直连工具），待开 PR；现行协议 = Main Agent 直接调用执行层委派工具（缺省 `run_task`），普通回合直接文本回复。

**基座的两条实测现状（2026-11-11）**：

- **原生压缩此前未激活**：`compact()` 的调用点被 `effectiveContextMode === 'transcript'` 挡着，而该模式要 `contextStates` 缺席才成立（`turn-persistence.ts` 的 `ensureHistoryBackfill` → `runtime.ts` 的 `effectiveContextMode` → `runtime.ts` 的 `compactSafe` 调用点）。摘掉 `contextStates` 接线后，**每回合压缩与会话过期恢复同时激活**。该改动**在 PR #54 未合**。
- **`contextWindow` 硬编码是假数**：`pi-driver.ts` 的缺省 `contextWindow: 128_000` 与模型真实能力无关——C2 实测跑到 241K token，压缩一次没触发。目标改为**从模型能力读**（**在 PR #54 未合**，缺省 128_000 保留）。这是"基座常数必须能被实测证伪"的实例。

**计划门是谁的**：预算梯子 `execute / notify / confirm / stop` 与 `SCOPE_EXPANSION` 检测住在**执行层**。实测证据（2026-11-11）：纯 Pi、无自建编排，平台侧 `SCOPE_EXPANSION` 触发 17 次、拒 1 次 `PLAN_CALL_MISMATCH`，拒后同一轮重提计划并查询成功——**平台自己的门是管用的**。胶水只做"接平台 + 叠加更严档"，不复制业务判据（迁移期边界见 §8）。

### 1.2 Task Runtime（概念模型：Task / TaskEvent / Evidence）

Task Runtime 回答三个问题：**任务现在到哪了**（Task）、**发生过什么**（TaskEvent）、**凭什么说结果生效了**（Evidence）。三者是**概念模型，不是三张新表**：字段优先映射到已有持久化与审计源，不新增平行事实源（新增对象前的三问见 [architecture-laws.md](architecture-laws.md)「不许平行事实源」）。

**Task**——一次用户意图的执行单元：

| 概念字段 | 现有来源 | 说明 |
|---|---|---|
| taskId | `TaskRunRecord.taskId` / `PlatformTaskRecord.taskId` | 两处各持一份；**权威归属与合并是新增对象前必须回答的问题**，不是既成事实 |
| principal / session | `TaskRunRecord.principalId/sessionId`、`PlatformTaskRecord.principalId/parentSessionId` | 身份隔离 |
| dispatchKey | `TaskRunRecord.dispatchKey` | 宿主生成的**任务级源派发键**（注释原话：idempotency key for the source dispatch event/tool call）。它是 exactly-once 三要素（业务操作 ID / 网关幂等键 / 回读对账）第一样的**任务级载体**，**不等于调用级业务操作 ID**——单次调用的业务操作 ID 是另一层（a2a-protocol.md 的 `callId` 缺口登记，未落地），二者不得混用 |
| state | `TaskRunState`（queued / running / cancelling / completed / failed / cancelled / waiting_input / waiting_confirmation / interrupted） | 状态机；CAS 迁移 |
| 进度 | `planId` / `stepIndex` / `totalSteps` / `lastProgress` | 长任务第几步 |
| 截止 | `deadline` | 超时收口 |
| 续跑锚点 | `originMessage` / `originRequestId` / `originUserEventId` | 同一 taskId 从断点续跑，不新开任务 |
| 平台事实 | `PlatformTaskRecord.calls/outcome/resultText` | 宿主解析的计划调用与结局 |

**TaskEvent**——append-only 的"发生了什么"：

| 概念事件 | 现有来源 |
|---|---|
| 会话 / 回合事实 | Conversation Log（append-only，eventId 幂等） |
| 工具调用事实 | ToolCall 审计（callId、exitCode、状态阶梯行） |
| 请求事实 | AgentRequest |
| 计划步骤事实 | TaskPlan（append-only 步骤 + 可重建投影） |
| 任务状态迁移 | `TaskRunRepo.transition`（CAS） |
| 委派结局 | `delegation_span`（outcome=timeout / stalled / result_shortfall 等） |

**Evidence**——"结果生效"的可核对证据：

| 证据 | 现有来源 |
|---|---|
| 网关返回 | RESULT 信封 `{v:1, op, status, data, error}` + exitCode（[execution-layer-interface.md](execution-layer-interface.md) §7） |
| 平台任务事实 | `platform_tasks` 的 calls / outcome / resultText |
| 独立读回 | result-contract 的声明 N 与 observations 对账（**在 PR #55 未合**） |
| 未验证终态 | `committed-unverified.ts`：提案已提交但回读缺失 → **绝不报完成**，独立终态 `confirm_committed_unverified`（简称 `committed_unverified`）留人对账 |
| 用户可见交付 | 最后回复非空（eval 的 `delivered` 判据） |

**判断口径**：Task 的 `state`、TaskEvent 的行、Evidence 的档位不是同一件事；把"网关返回成功"写进 Task 的完成态，就是把第 ③ 态冒充第 ④ 态（§1.3）。

**已有持久化够用，差的是一处**：`TaskRunRecord` 已有 dispatchKey 幂等键、state 状态机、planId/stepIndex/totalSteps/lastProgress 进度、deadline、originMessage 锚点；confirm 档是**返回 pending 而非阻塞进程**（`plan-runtime.ts` 的 confirm 分支返回 `{status:'confirm', pending}`）。**恢复粒度是任务级，不是工具执行级**——这是唯一缺口，而那正是 Pi Durable 也没堵的那条缝（§1.4）。

### 1.3 执行四态（不能混用）

| # | 态 | 仅代表 | 判据 / 现有锚点 |
|---|---|---|---|
| ① | **意图**（模型提出调用） | **仅代表意图** | 模型提出的调用 / 计划 calls；尚未进入执行流程 |
| ② | **已受理**（工具调用被接受） | 请求已进入执行流程 | plan evaluate 放行；ToolCall 审计开始行（invoked） |
| ③ | **已返回**（网关返回成功） | 提交动作已成功返回 | RESULT 信封 + exitCode=0（completed） |
| ④ | **已验证生效**（查询目标业务系统确认状态） | **有证据支持业务结果已生效** | 独立读回（verified）；写路径缺回读 = `confirm_committed_unverified`（简称 `committed_unverified`），不报完成 |

**别名（同义，不是第二套语义）**：本表 ①–④ 在 AGENTS.md 与 decision-log 中写作「模型提出调用 / 工具调用被接受 / 网关返回成功 / 查询目标业务系统确认状态」，逐字一一对应。**撞名区分**：本文的「执行四态」只指本表；change-safety 的「写链路四态」「交接四态」与 T10 的「任务生命周期四段」是另外的概念，不共用这个名字。

**异步操作尤其危险**：网关返回成功可能只意味着任务被接受，不意味着业务已处理完。③ 与 ④ 之间的缝是崩溃恢复与对账的落点。

**与 eval 梯子的关系**：`scripts/eval/evidence.ts` 的梯子是 `authorized → invoked → completed → verified → delivered` 五档；四态是其中的**业务语义分组**（① ≈ authorized 之前、② ≈ authorized/invoked、③ ≈ completed、④ ≈ verified），`delivered` 另属"用户可见交付"，不是业务生效。仓里已有对应：AGENTS.md「区分调用获准、实际执行和执行成功」、eval 报告的阶梯、`committed-unverified.ts`；**缺的是统一契约**——四态在文档与代码里还没有单一入口。

### 1.4 基座选型：Pi Durable 未采纳（2026-11-11 裁定）

- registry 上有 1.5.2，但**本仓没装**；装的是 pi-agent-core 0.85.1 + pi-coding-agent + pi-ai + chord + pi-telemetry。
- 已知 issue #10386：与 pi-coding-agent 扩展系统不完全兼容——本仓正用 pi-coding-agent，采用即正撞它。
- 两个同时活动的 Harness 共用一个数据库不受支持——多实例部署要自己设计所有权与调度。
- 它**不解决外部业务操作的 exactly-once**（工具写入成功 → 回执未持久化 → 崩溃 → 判不出是否生效）；那一层只能 fshine 做。
- **裁定**：候选底座，**现在不采纳也不做 PoC**；**T10 的崩溃恢复用例是引入判据**。该用例**尚不存在**：截至 2026-11-11 `tests/e2e` 对 `崩溃|crash` 零命中，PR #55 的任务生命周期四段（结果对账 / 停滞冻结 / 冻结续跑 / 挂死留痕）不含崩溃恢复（decision-log 0.6 末条）。在它建成前，不引入 Pi Durable。唯一值得抄的一条：**按工具声明 replay 安全性**——可重放的崩后重跑，不可重放的返回 `interrupted`，不盲目再执行。

### 1.5 分层的判据

三类知识有不同的主要影响面，不能把这种分工当成结果正确性的自动保证：

> - 编排层 skill 影响拆解、派单和信息补齐；**拆解决策由模型（Main Agent）作出**，宿主不实现拆解器、不复制拆解逻辑，只承载拆解结果的计划状态、派单与续跑机制（§2 第 5 条）。它不能独立定义业务结论。
> - 编排层长期记忆**已删**（§12 ②，**在 PR #54 未合**）；历史内容本来就不能充当本轮数据或授权，会话内上下文（Conversation Log）只提供交互与指代材料。
> - 执行层 skill / 领域记忆影响业务选择和口径；错误可能直接导致执行错误。

编排层不得独立生成数据结论；它依据执行层本轮返回的结果组织回复。知识隔离只能缩小错误来源，不能代替结果来源和出口校验。分层的收益是让业务口径错误局限于执行层，并让派单、执行与回复各有可核对的证据。

---

## 2. 编排层职责（冻结清单）

加新业务域时，以下**仍然有效**的条目一行不改；已删项在行内标状态并指向 §12。

| # | 职责 | 说明 |
|---|---|---|
| 1 | 渠道、身份、会话 | 企微接入；principal 由可信用户 ID 解析 |
| 2 | 上下文装配 | Conversation Log（会话事实）；Context State 与主动回溯**已删**（§12 ④⑤，**在 PR #54 未合**） |
| 3 | 指代消解 | 只用**机械来源**：当前消息、Log 里的实体、平台自己返回的响应；历史检索通道**已删**（§12 ①，**在 PR #54 未合**） |
| 4 | 回合分类 | `conversation` / `delegate`；强制申报形态本身是 A 类（§12 ⑦，**已实施：`arch/direct-tool-final`，待开 PR**） |
| 5 | 长任务拆解与派单 | **拆解决策归模型**（凭业务 skill 的**程序性**知识）；宿主只维护拆解结果的计划状态、派单与续跑机制，**不复制拆解器** |
| 6 | 任务计划状态维护 | 第几步、每步结果、失败重试 |
| 7 | 长期记忆 | **已删**（§12 ②，**在 PR #54 未合**）：不再维护跨任务长期记忆；会话事实归 Conversation Log |
| 8 | 通用闸口 | 预算 / 通知 / 确认 / 执行凭证 |
| 9 | 领域无关校验 | 计划里的实体须可溯源到当前消息、平台响应或本会话已由用户确立的实体。**检索证据来源随 §12 ⑤ 删除**；main 上该来源仍存在，删除**在 PR #54 未合** |
| 10 | 出口规则 | 回复含数字结论 → 必须本轮有执行凭证 |

**第 3 条的边界**：实体消解（简称→全名、歧义→候选）归执行层，它有目录查询能力。编排层只做"从已知文本里把实体取出来"，不做"猜这个实体是谁"。

**第 5 条的边界（2026-11-11 统一口径）**：拆解**决策**由模型（Main Agent）作出——这是模型的能力，也是编排 skill 程序性知识的用途；宿主**不实现拆解器、不生成步骤内容、不做业务判别**。宿主拥有的是拆解结果的**承载机制**：计划步骤事实（TaskPlan append-only）、逐步派单（delegate request 的步骤前缀）、同任务续跑（continueTaskId）、任一步失败不阻塞、通知步序。判据：换一个执行层仍成立的是机制（归 fshine）；随业务变化的步骤内容归模型/执行层。AGENTS.md 的「拆解由模型决定，宿主不复制拆解器」与「拆解与续跑仍归 fshine」是同一口径的两半，不是两句反向结论。

**计划所有权（2026-11-12 仲裁，两类 Plan 不能混）**：**Main 拥有 Business Workflow**（业务步骤拆解：做什么、分几步、依赖与汇总），**Worker 拥有 Platform Execution Plan**（平台调用计划：operation、参数与顺序）。拆解的**决策**归模型——Main 定 Business Workflow 的内容，Worker 定 Platform Execution Plan 的内容；拆解与续跑的**状态与执行归宿主**——计划步骤事实、派单、同任务续跑、通知步序是宿主的机制，宿主对两类计划的内容都不做决策、不做翻译：Business Workflow 的步骤是「做什么」，Platform Execution Plan 的 calls 是「平台侧怎么做」，宿主承载两者并核对执行范围（对账判据 = T5，裁定形态待实施，见 [architecture-laws.md](architecture-laws.md)「机制分类」），不把一类计划改写成另一类。

**第 9 条不需要领域知识**：宿主不需要知道"幻辰财税"是不是账套，只校验实体的可信来源。执行层调目录查询拿到的规范名可以来自平台响应；会话实体须有用户先前确立的记录。来源校验不代替执行层的名称解析。

**「平台响应」的边界（2026-10-14 标定复审明确）**：它 = 本任务迄今**全部** tool_result，两个通道——转录里现存的 + 宿主在 `afterToolCall` 上记的账本（SDK 的自动压缩会把早期 tool_result 整条摘出转录，只读转录到不了"迄今全部"）。两条排除：① **宿主自己写的拒绝理由不算平台响应**——它逐字带 offending token，算进去就等于"先故意提一个越权实体、再原样提一次"能过门（按 `toolCallId` 身份排除，不按 `isError`、不按文案前缀：平台 CLI exit 3 的真错误信封与宿主拦截在 `isError` 上完全同形）；② 单条按**保尾**截断（SDK bash 工具保尾弃头、`RESULT` 信封在末行，读头只会得到既不是开头也没有信封的中段）。条数不设上限——上限由任务自己的形状给（平台预算门 + 执行超时）。信封 `data` 的结构化叶值作为**附加**来源，只增覆盖。详见 [architecture-laws.md](architecture-laws.md) 的实体门标定复审。

**写路径的边界（保险箱条款）**：写提案在编排层是**不透明 payload**——提案结构、域校验、确认摘要文案、commit 执行与读回，全归执行层；编排层只持一套**通用确认状态机**（确认码 / 有效期 / principal / 计划版本绑定，均不可由模型填写）。§2 第 9 条的领域无关包含校验可留编排层；一旦要懂「voucher 必须带账套 + 期间」这类口径，就是越界——那归执行层。判据见 [architecture-laws.md](architecture-laws.md) L4。

---

## 3. 两个 Agent 的分工

```text
Main Agent = 规划者          Subagent = 执行者
  知道：任务类别、依赖关系       知道：参数、口径、红线
       每类必须的信息                 怎么做这一步
  做：  拆解 → 派单 → 收结果      做：  执行一步
       出错时与用户/执行层交互            成功 → 返回结果
  不做：产出任何数据结论                失败 → 返回原因和所需信息
                                  不做：跨步规划、自行扩大范围
```

**纠错环是有意设计的**：Subagent 执行不了就报错回来，Main Agent 重新拆解、追问用户、或换步骤。它让知识漂移从"致命"降级为"多问一句"。

**计划所有权（2026-11-12 仲裁）**：Main 拥有 **Business Workflow**（业务步骤拆解），Worker 拥有 **Platform Execution Plan**（平台调用计划），两类 Plan 不能混；拆解决策归模型，拆解与续跑的状态与执行（派单、续跑、审计）归宿主。细目见 §2 第 5 条。

Main Agent 依然不能产出财务结论——它只能编排。出口校验（§2 第 10 条）一动不动地守着。这比把执行工具直接还给 Main Agent 安全得多。

---

## 4. 委派契约

> **状态（2026-11-12 更新）**：`route_current_turn` 的**申报层 1+2 已正式删除**——强制申报回合类型是 A 类纪律（它存在是因为模型现在做不到，判据见 [architecture-laws.md](architecture-laws.md)「机制分类」）；删除已在 `arch/direct-tool-final` 实施（待开 PR；工具/解析/退回重填/申报状态字段/提示词全删，`resend_artifact` 与实体范围校验保留，见 §12 ⑦–⑨ 与 decision-log 2.7–2.9）。**现行协议**：Main Agent 直接调用执行层委派工具（缺省 `run_task`），普通回合直接文本回复；「意图 → 结构化请求」的加工归模型，第 3 层的范围校验（`validatePlanEntities`）与来源组装仍是宿主的确定性责任。
>
> **层号定义（首次出现处）**：**第 1 层** = 强制模型每回合申报回合类型；**第 2 层** = 申报结构校验与不合规退回重填；**第 3 层** = resend 分支（会话产物清单引用，现为直连工具 `resend_artifact`）+ 实体范围校验（`validatePlanEntities`）。删的是 1+2，保留的是第 3 层。
>
> **以下为删除前形态（史实，供理解 §4 的判据与变更史）**：

Main Agent 每回合先申报一次：

```ts
route_current_turn({
  kind: 'conversation' | 'delegate' | 'resend',
  request?: string,             // delegate：加工后的用户请求
  continueTaskId?: string,      // delegate：仅在补充子 Agent 索要的信息时使用
  artifactRef?: string,         // resend：指向宿主注入的会话产物清单 #编号
})
```

**四个字段，零业务知识。** 没有 `taskType`、没有 `accountQueries`、没有 `periods`、没有 `accountResolution`——那些都要求编排者做领域判别（区分账套名/科目名/客户名、知道凭证必须带期间），正是知识污染的来源。

`request` 需要加工，这是编排层的核心价值，而且加工全是机制：

| 用户说 | 加工成 |
|---|---|
| 这个账套 202608 呢？ | 「查询新兴五金账套 202608」（实体从 Log 取） |
| 那把 202607 也看一下 | 「查询新兴五金账套 202607」 |
| 继续 | 「继续 task_xxx：<子 Agent 上次索要的信息>」 |

宿主持做的确定性的事：校验申报结构、记录执行凭证、出口拒绝"委派了却零执行"的回复。

---

## 5. 业务 skill（编排层持有）

### 内容边界

**只含程序性知识**：这是什么任务、拆成几步、每步需要什么信息、步骤之间什么依赖。
**不含口径性知识**：什么能算什么不能算、什么参数必须带、结果为空怎么办。

### 拆解示意（不定义执行参数）

```markdown
# 财税业务编排知识（fshine-agent）

## 用途
只用于长任务拆解与信息补齐。不含任何执行口径——"怎么做是对的"归执行层。

## 任务类别与拆解
| 类别 | 拆解 |
|---|---|
| 单点请求 | 1 步，执行层决定参数、默认值和能力边界 |
| 跨账套核对（N 个账套同一口径） | 按账套拆 N 步，互不影响，最后汇总 |
| 跨期间对比（1 个账套 M 个期间） | 用户明确给出可拆范围时按期间拆；范围解释交执行层 |
| 有副作用的单步请求 | 派单后由宿主通用确认流程控制实际执行 |

## 拆解原则
- 一步只做一件可独立成败的事
- 任一步失败不阻塞其他步，汇总时如实报告失败的那几步
- 只有用户明确说"全部/各/逐个"才拆多步；否则先按单步派单，
  执行层回报需要扩大再议
- 不要为了"顺手"把无关账套或期间并入某一步
```

这份示意是任务地图，不是执行手册。2026-11-04 纯编排波已把 `docs/business-skill.md` 的执行默认值与业务路由例子中性化移出（业务示例归 执行层 `.agents/skills-serve/`），现运行态只留路由与编排纪律（该文件的执行默认词表守卫实测零命中）；迁移缺口见 §10，不能把它当作新域模板。

---

## 6. 记忆（编排层不存跨任务记忆）

| | 编排层（fshine） | 执行层（当前实例） |
|---|---|---|
| 存什么 | 任务计划状态、会话事实（Conversation Log）、产物清单 | 客户录入格式差异、录汇票规则、历史口径 |
| 不存什么 | **跨任务长期记忆已删**（§12 ②，**在 PR #54 未合**）：用户偏好 / 稳定事实的抽取、合并与召回不再存在 | — |
| 用来 | **承载**拆解结果的计划状态、怎么呈现、怎么续跑（**拆解决策归模型**；宿主不复制拆解器，见 §2 第 5 条） | 决定**怎么把这件事做对** |
| 跨域有效 | 会话内有效；跨任务**无** | 否 |
| Main Agent 需要理解 | 会话事实需要 | **完全不** |

执行层的记忆归执行层自己存储和使用。编排层不存、不转发、不理解。用户说"跟上次一样"时，跨任务的口径记忆在执行层那儿，它查得到，不需要编排层转手。

---

## 7. 执行层必须提供什么

```text
SKILL.md          worker 选择业务能力和处理缺口的简短指引
operation 清单    名称、参数、est_seconds（权重）、access/effects
领域契约          输入与提案 schema、业务校验、结构化结果
执行端            逐次核对授权范围、平台硬上限，执行并读回验证
自己的记忆        领域性、按客户/账套等维度持久化
```

编排层提供通用委派与安全框架；执行层提供简短的业务能力指引。可由机器校验的参数、业务契约和成功判据归执行层声明与代码，不靠提示词保证。

---

## 8. 通用闸口（编排层与执行层各占一半）

```text
Main Agent 申报 delegate
      │
      ▼
宿主附加可信身份 / 任务 ID / 计划版本（不可由模型填写）
      │
      ▼
宿主通用预算与计划门：execute / notify / confirm / stop
      │
      ├─ execute  放行已声明操作，累计计量
      ├─ notify   宿主先把范围与预计耗时发给用户，确认送达后才激活
      ├─ confirm  暂停，等用户真实回复；确认绑定用户 + 计划版本 + 有效期
      └─ stop     达到通用上限或执行层硬拒绝，带明确原因码
      │
      ▼
执行端逐次核对：操作、实体参数、平台硬上限
      │
      ▼
宿主记录执行凭证 → 出口校验 → 用户可见回复
```

- **notify 的送达是激活授权的一部分**：没送达成功就不激活。
- **模型自报的确认字段不是凭据**：激活密钥由宿主持有，只在激活子进程短暂注入，worker 环境主动剥离。
- **重计划不重置累计用量**；同一任务的 notify 次数和重计划次数都有上限，反复试探会被升级为必须等用户确认。
- **迁移期现状**：当前 `执行层 plan evaluate` 仍决定预算档位并保存累计账本，宿主执行通知、确认与激活。通用预算策略上收前保留平台计划门与执行端复核，不得先删现有防线。
- **执行层自己的门是管用的（2026-11-11 实测）**：纯 Pi、无自建编排下，平台侧 `SCOPE_EXPANSION` 触发 17 次、拒 1 次 `PLAN_CALL_MISMATCH`，拒后同一轮重提计划并查询成功。所以胶水的计划门只做"接平台 + 更严叠加"，不复制执行层的业务判据。

---

## 9. 安全边界

- principal 由可信的企微用户 ID 解析，模型不得改变用户身份或授权配置。
- 工作目录与 skill 路径只来自部署配置，启动前 realpath 校验。
- credentials 不经用户消息或模型参数传递。
- Main Agent 不直接执行平台命令；命令与脚本选择由执行层约束。
- 只读计划才能过计划门。**写提案在编排层是不透明 payload**：提案 schema、域校验、确认摘要文案、commit 执行与读回全归执行层；编排层只持通用确认状态机（确认码 / 有效期 / principal / 计划版本绑定）。判据见 [architecture-laws.md](architecture-laws.md) L4。
- 审计不写 API key、密码、未授权数据或完整页面内容。

---

## 10. 与当前实现的差距

已落地（能力）：Conversation Log / 计划门与累计账本 / 通知送达屏障 / 跨轮确认与 superseded / 网关写路径（提案归平台，宿主持不透明引用 + 通用确认状态机）。**离线全链 e2e / 跨仓真实 CLI e2e 只有能力落地，不是「已稳定」**——`tests/e2e` 当前存量红（change-safety 记录 28 文件/106 用例失败），全链行为本机未验（2026-11-11 未复跑），见 decision-log 5.1。**已删机制不在"稳定"之列**：Context State / history tools / 带来源长期记忆 / 主动回溯分别是 §12 的 ④ / ① / ② / ⑤，状态为**在 PR #54 未合**；本行此前把它们写成已稳定，按 2026-11-11 裁定更正。

2026-10-24 新增首版实现（尚未生产验收）：企微原生引用与正文分离、引用历史检索及去重（其中**检索注入面随 §12 ⑤ 删除**，在 PR #54 未合；引用解析与正文分离保留）；可选后台 Worker、同会话串行 Planner/完成事件、任务查询和取消、独立结果与文件推送。`FSHINE_WORKER_DISPATCH_MODE` 缺省 `inline`，显式设为 `background` 才启用后台委派。它是单进程任务管理器，不提供崩溃自动重跑、运行中 steer、暂停恢复或分布式调度。实现边界、验证及回滚见 [interactive-session-plan.md](interactive-session-plan.md) §9 和 [change-safety.md](change-safety.md) §18。

尚未按本文档实现的部分：

> 写路径违规此前不可见，即因本表缺一行——业务字段住进编排层这类越界，若不在此显式列项就会一直藏在已落地的叙事里。

| 项 | 现状 | 目标 |
|---|---|---|
| 写路径 | 已落地（C 波收口，2026-10-13）：提案载荷全程不住编排层——`ChangeIntentRecord` 只剩取物单 `proposalId` + 通用确认字段；宿主不解析 payload、不渲染业务摘要（用户文本 = 平台 `summaryText` 原样 + 宿主通用状态行）。旧文本路径（worker 贴提案 JSON → `extractChangeProposal` → 服务端 dry-run 预检 → 按文件路径落账）与 `apps/server/commit.ts` 已整文件删除；B 波那两个灰度开关（管提案创建、管落账接线）已随 D 波退役（2026-10-14）——宿主恒定拦截提案命令、落账后端恒接；D 波之后 `proposalCommitEnabled` 曾由 `isCommitEnabled` 单独派生，**该派生位亦随 2026-11-08 架构裁定删除**（写能不能真落地归执行层，宿主不再持"允不允许落账"的布尔，执行层的拒绝/warning 由平台信封给出并上行转述，见 debt-ledger 的 D-075/D-197 重登记节）。残留：① SQLite 里的五列历史列只为旧库 NOT NULL 兼容保留（W5 fail-closed：不带 `proposalId` 的旧行业一律按过期处理） | 同左；结构化调用协议已落地（C6/C9），env 级接线退役中（C8 部分落地，serve 令牌门与真写门执法点未动） |
| 申报契约 | **已删除（2026-11-12，`arch/direct-tool-final`，待开 PR）**：申报工具、解析/复核/退回（1+2 层）与申报状态字段全删；`TurnDeclaration` 收窄为宿主内部委派管道（不进模型 schema）。现行协议 = 直连委派工具（缺省 `run_task`，schema 只有 request / taskId 两参数），普通回合直接文本回复；范围守卫靠计划层包含校验（§2 第 9 条） | 保持直连形态；目标形态 = 意图 → 结构化操作，不靠模型每回合自报回合类型；`resend_artifact` 与实体范围校验（第 3 层）保留 |
| 领域判别 | `validatePlanEntities` 已做通用来源校验。**2026-10-14 标定复审后**：覆盖 = 本任务迄今全部平台响应（转录 ∪ 宿主账本双通道，治 SDK 自动压缩）、单条保尾、宿主拒绝理由按身份排除、信封 `data` 叶值作附加来源；包含判据仍是逐字包含，防幻觉功能不变。剩余差距：名称重新检索规则仍在 fshine worker 提示词（context.ts 输出纪律条），与执行层 serve skill 重复——业务 skill 已明写名称解析归执行层（2026-10-11/2026-11-04 两波收口） | 通用宿主只校验来源与授权；执行选择和业务参数规则由执行层拥有 |
| 业务 skill | 已清执行口径（2026-10-11）：必需信息表整表删除，默认应收/默认当前期间/名称检索/范围替代四条执行口径已删或迁执行层 SKILL；剩余内容只有路由与编排纪律，执行默认词表有机械守卫（apps/server/business-skill.test.ts）。2026-11-04 纯编排波再收口：执行默认值与业务路由例子中性化移出（业务示例归执行层 `.agents/skills-serve/`，执行默认词表守卫实测零命中）。文件内容本身仍由部署方持有，除词表守卫外无内容级校验 | 只保留跨步骤拆解、依赖与信息补齐；执行默认值和范围解释归执行层 |
| 执行凭证 | 当前 `gateCalls > 0` 主要证明网关调用获准；普通 conversation 的无来源金额主要告警。**执行四态（§1.3）尚无统一契约**：①意图 / ②已受理 / ③已返回 / ④已验证生效在代码里分散在 plan evaluate、ToolCall 审计、RESULT 信封、readback 与 `confirm_committed_unverified` | 四态区分落地为统一契约；数据回复关联可核对的执行结果；T10 结果对账（声明 N / 读回 N，**在 PR #55 未合**）与任务生命周期四段（**在 PR #55 未合**） |
| Task Runtime 三对象 | 概念模型见 §1.2：Task / TaskEvent / Evidence 已能映射到 `TaskRunRecord` / `PlatformTaskRecord` / TaskPlan / Conversation Log / ToolCall / AgentRequest / RESULT 信封；**尚未作为对象立项**，也尚未回答"哪个权威、哪些派生、哪些能合并" | 先按 [architecture-laws.md](architecture-laws.md)「不许平行事实源」完成前置审计，再决定是否新增对象；不新增平行事实源 |
| Task Runtime 前置审计 | AuditStore 有 12 个 Repo，其中五个（ToolCall / PlatformTask / TaskPlan / TaskRun / AgentRequest）都在记"发生了什么"，是平行事实源；今天已因多源映射导致治理代码膨胀过一次（2026-11-11） | 新增 Task / TaskEvent / Evidence 前先定：哪个权威、哪些派生、哪些能合并；审计结果进台账，不靠口头约定 |
| 长任务拆解承载 | 已落地（**承载机制，不是宿主拆解器**；拆解决策归模型，见 §2 第 5 条）：计划模式协议（delegate request 的「第N/M步：」前缀，宿主机械解析；无前缀 = 单步行为不变）+ 任务计划状态（append-only 步骤事实 + 可重建投影）+ 逐步派单同任务续跑（continueTaskId，累计账本跨步累积）+ 任一步失败不阻塞 + 通知带「第 N/M 步」 | 同左（已达成）；协议写在 request 与工具描述里 |
| 通用预算策略 | 截至 2026-11-06 W4 状态：AGENTS.md 的「迁移期适配现状」段仍自述预算档位在执行层（原文「当前预算档位决定及累计账本仍在…」，迁移通用策略前不得先删平台门）；通用预算协议缺省档位线的单一真相源已由宿主持有（`budget-policy.ts`，W4 上收；12 个缺省不再是「逐字对齐执行层」的第二份）；双门并行期执行层 `plan evaluate` 仍决定 execute/notify/confirm/stop 并保存累计账本，宿主叠加档只收紧不放宽 | fshine 复用通用预算与计划状态策略；执行层经声明面给 est_seconds/weight/effects、可声明更严硬上限并在实际调用处复核；一致性校验归执行层仓（D-150/D-168）。迁移中保留现有门禁 |
| Subagent 报错回路 | 已落地：needs 结构化线索（确定性派生）+ 宿主不 terminate + continueTaskId 重派，3 轮上限 | 同左（已达成） |
| 主动回溯 | **已删**（2026-11-11 裁定，§12 ⑤，**在 PR #54 未合**）：`reference-evidence.ts` 的线索词尺只认中文，九个英文长会话用例上静默全关，单测全绿而机制一次不跑。删除后模型直接读保留下来的历史；配套改动是 §1.1 的原生压缩激活（同一 PR）。原「根因修复：查询轮次曾被 `selectRecentTurns` 踢出最近窗口」是上下文装配的修正，不与注入机制捆绑 | 不再注入检索证据；实体来源见 §2 第 9 条 |
| 执行层记忆 | 已落地：平台 memory 命令（scope 隔离 + 锁 + fail-closed；W1 起网关名由部署 profile 声明，宿主不再持实例名缺省），SKILL 读写规程；编排层不存不转发不理解 | 同左（已达成） |
| 提示词面积 | 主提示词以协议与通用原则为主；worker 提示词已纯静态清场（迁移期对账 2026-10-19：只含协议义务、机械边界与输出纪律，**零网关名**；**名称检索等执行层指令仍在**——`context.ts` 的 `workerSystemPrompt` 输出纪律条，见本表「领域判别」行，逐任务范围随委派块走 user message），静态部分零执行层名有渲染级机械锁（docs-reality.test.ts，2026-11-05 W3-A 落地）；W1 身份参数化收尾：委派工具名/称谓/网关名/profileId 缺省全部改为 profile 声明 + 中性缺省（change-safety §27），宿主提示词面不再持有任何实例身份；网关命令形态经 planCommandForm 参数注入（唯一渗入点，取值来自部署配置）；业务 skill 的执行默认值中性化见本表「业务 skill」行 | 通用宿主只保留委派和安全控制指令；业务语义归执行层，机器可校验的规则归清单、schema 和执行代码 |
| 多任务回溯绑定 | 已落地（rule-landing C31）：续跑计划绑定按优先级机械判定——`continueTaskId` 按 taskId 反查 > 用户编号消歧 > 形状唯一自动续跑；多候选且无依据时宿主发编号消歧问题（`【任务消歧】`，选项由计划事实机械生成），**紧跟问题**的纯编号回复才绑定（中间插过回合即失效）。宿主持有绑定权，模型只申报"做什么"；不解任务语义、不引入判别模型 | 同左（已达成） |
| 公开迁移 | 波次 1–5 已按方案落地：现行树四类敏感物脱敏 + 历史重写 + 身份参数化 + 预算策略上收 + 结构化调用协议 + 门面中性化 + CI 最小权限 + 迁移门守卫常驻 + debt-ledger 三件套补齐 + push runbook + change-safety 关账。公开库定稿前必须闭环的条目限期 = 波次 5；D-153（eval 基线重定）需 LLM 凭据，限期波次 5 前。 | 同左（公开到 GitHub 后即终局，不带中间态） |

**公开迁移暴露面现状（2026-11-05 脱敏波，change-safety §25）**：现行树的四类敏感物——真实企微 UserID、内部绝对路径、真实客户名/主体名、真实财务读数——已机械替换为虚构值，并由 `packages/agent/exposure-lint.test.ts`（扫 `git ls-files` 全量、四类零命中断言 + 假绿自校验）常驻看守；CI 三门 + 三把守卫全绿，Tier B 未跑。**尚未处理的三面**：① git 历史里的同批串（归波次 2 历史重写，替换表由波次 1 产出）；② 产品面执行层实例名词（归 W1 / 波次 4，含 `config/agent.example.yaml` 的 `contextProfiles` 结构键，D-155）；③ Tier B 对兄弟仓 mock seed 目录的耦合（D-154）。各债的归属、闭环判据与限期见 debt-ledger 脱敏波新账（D-153–D-156）。

**改造顺序的原则**：先删"代码已保证"的提示词冗余；主动回溯**已删**（§12 ⑤，在 PR #54 未合），不再作为后续波次；申报契约的申报层 1+2 **已删除**（§12 ⑦，`arch/direct-tool-final`，待开 PR）。任何删除按 [architecture-laws.md](architecture-laws.md)「删除纪律」执行：带回归用例，红写进 PR 正文。分阶段计划、每步验收与验证协议见 [`roadmap.md`](roadmap.md)。

---

## 11. 明确不做

MCP server/host、通用多 Agent registry、跨域结果聚合、调度与浏览器人工接管。**编排层长期记忆整体已删**（§12 ②，在 PR #54 未合）——因此"长期记忆的定时生产调度 / `MEMORY.md` 落盘"不再是"范围外待办"，而是随机制一起不存在；不要把删除读成"以后再做"。fshine 也不追 OpenClaw / Claude Code / Codex 的通用功能面（§1）。

---

## 12. 已删机制（2026-11-11 裁定）

**本节九项均已裁定删除（2026-11-11），但表内 ①–⑥ 在 PR #54 未合，main 上仍在**——列的是裁定，不等于 main 上已物理删除。状态只取三种基态：**已合入**（main 上已删）/ **在 PR 未合**（删除改动在 draft PR，**main 上文件仍在**）/ **待实施**（有裁定、无删除改动）；局部完成的写成可判组合：**在 PR 未合（局部）** 或 **待实施（局部在 PR 未合）**，并写清哪一部分在哪个 PR；**已实施但未开 PR** 的批次写「已实施（`arch/direct-tool-final`，待开 PR）」——实施已落地、审查入口尚缺，不许读成已合并。**读法**：①–⑥ 按现状读代码，不要按已删除写新代码；⑦–⑨ 已在本分支实施（⑦⑧⑨，见各行状态），本分支上不要再按申报层写新代码。裁定记录以 [decision-log.md](decision-log.md) 为准；删除纪律（带回归用例、红写进 PR 正文）见 [architecture-laws.md](architecture-laws.md)。

| # | 机制 | 删除理由（一句） | 状态 |
|---|---|---|---|
| ① | `history-tools.ts`（`search_history` / `get_messages`） | 无价值 + 已知复合通道：模型自己的错误发表进日志、被后续召回轮捞回、再发表 | **在 PR #54 未合** |
| ② | `long-memory.ts` / `memory-consolidator.ts` / `memory-candidate-extractor.ts` / `memory-model.ts` | 战争故事机制：从历史学用户行为 → 借新指令扩大执行范围（曾打爆下游基础设施） | **在 PR #54 未合** |
| ③ | `compaction-context.ts` sidecar | 宣言层；同型禁令在仓内三处，实测全失效 | **在 PR #54 未合** |
| ④ | `context-state.ts` / `context-extractor.ts` / `context-model.ts` | 语义投影；C2 一次跑出现 8 次 `context_semantic_extract_failed`，失败即落正则兜底 | **在 PR #54 未合** |
| ⑤ | `reference-evidence.ts` | 线索词尺只认中文，九个英文长会话用例上静默全关，单测全绿而机制一次不跑 | **在 PR #54 未合**；同对象另有 #51 的「保留 + 补英文线索尺」修复草案，两案未合并，**当前权威裁定是删除**（decision-log 2.5） |
| ⑥ | `execution-facts.ts` | 台账注入。T9 的红有混淆：main 上 `contextMode` 默认 `state_recent`、`recentTurns` 默认 2，模型本来就没全文；**main 上注入也不是无条件**——`runtime.ts` 的 `looksLikeReferenceCue` 开门，只有带召回线索的回合才注入，无条件版本只存在于中间提交 `ab9c1c9`；无条件注入的确定成本 = 每回合改上下文头部、破坏前缀稳定、cache 命中率下降 | **在 PR #54 未合** |
| ⑦ | `route_current_turn` 申报层 1+2 | A 类纪律（强制申报回合类型是模型能力补丁）；保留 resend 分支与实体范围校验（第 3 层） | **已实施（`arch/direct-tool-final`，待开 PR）**：工具/解析/退回/申报状态字段/提示词全删；`resend_artifact` 直连工具与 `validatePlanEntities` 保留 |
| ⑧ | `protocol-material.ts` | 处理「模型把申报 XML 写成正文」，纯模型失败补丁 | **已实施（`arch/direct-tool-final`，待开 PR）**：只删申报专属整段替换支；Worker 协议材料防泄漏（`looksLikeProtocolMaterial`）保留 |
| ⑨ | `step-text.ts` 的 `INTERNAL_TOOLS` 抑制 | 内部工具删了就没对象 | **已实施（`arch/direct-tool-final`，待开 PR）**：集合、两处检查与 `route_current_turn` 词条整体删除；通用进度卫生保留 |

**没有随波删除的保留项（复核结论见 [architecture-laws.md](architecture-laws.md)「机制分类」）**：`session-entities.ts`、`clarification-events.ts`、`committed-unverified.ts`、`freeze-task-inputs.ts`、`TaskRunRecord.dispatchKey`、WT-1 / WT-2，以及 `repeat-request.ts` 的**B 目的**（重复的同一句话是新授权、不是缓存命中——2026-11-12 收窄后由 RR1 窄门承接：requestKey 精确身份 + 出口替换决策，见 decision-log 3.5）。它们不是"漏删"，其余是换任何模型都必须在的确定性责任。**申报层删除的三项收口同批落地**（2026-11-12，`arch/direct-tool-final`）：G3 恢复路径实体来源 fail-closed（inline 缺快照 = 拒绝恢复；后台缺快照 = `originMessage` 窄重建）、RR1 收窄（改写问句不拦；存储读不到记 inconclusive 不阻断）、resend 与委派同回合互斥（先发生的动作赢）。

**禁止的读法**：不要把本表当成"曾经有过、随时可以加回来"的清单。加回来的判据是删除时留下的那条红（写在该删除的 PR 正文里）——先让红变绿，再解释为什么现在需要它。
