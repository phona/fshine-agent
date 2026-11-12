# 决策日志（decision-log）

> 本文件是 fshine-agent **删除/保留决定及其状态的权威记录**（2026-11-11 复审裁定，2026-11-12 落实）：每条决定写清对象、理由、证据与状态。`AGENTS.md` 的「已删及理由」只是面向改动的摘要与指向本文件的指针，不另维护一份状态；可执行判据与删除纪律以 `docs/architecture-laws.md` 为准；main 代码与开放 PR 是现状事实源——它们回答「现在是什么」，本文件回答「决定了什么、处于什么状态」。
> 状态字段不一致时，以本文件的五态为准，并先按本条目的证据复核 main/PR，再同步回填，不得各写一套。三份文档互链：`AGENTS.md`（改动归属判据 / 已删及理由摘要 + 指针）、`docs/architecture-laws.md`（可执行判据 / 删除纪律）、`docs/v0-architecture.md`（目标架构叙述）。
> 记录日期：2026-11-11。新增决定一律追加条目；状态变化只改状态字段并注明日期与依据；不删除旧条目。

## 读法

**条目字段**（每个决定必须写全）：

- **决定**：一句话，动词开头。
- **日期**：裁定日期，不是实现日期。
- **对象**：文件、机制名、PR 编号。
- **理由**：为什么做这个决定。
- **证据**：仓内相对路径 + 符号名（函数 / 常量 / 事件名）、PR 编号与正文、实跑命令与输出。没有证据的写「未验」；读者无法复现的引用（未推送提交、纯本机状态）不当作证据。
- **状态**（五态，必须可判）：
  - `已合入`：已在 main；
  - `在 PR`：有开放 PR——必须写编号与 draft/合并；允许写「部分」并单列未完成部分的状态；
  - `待实施`：有裁定、无代码、无 PR；
  - `已裁定未实现`：有裁定，但现有代码 / PR 不是裁定形态（临时修法、部分实现等），必须写明差在哪；
  - `未采纳`：候选未进入实施——无排期、无 PoC。
  - 混合态拆开写（例：「在 PR #54（部分：A 已移出）；完整删除待实施（前置 ⑦）」），不得把两态并成一个词。
- **加回来的判据**：已删条目必填；保留条目写「删除判据」，说明什么条件下才可以撤。

**三条硬纪律**：

1. 已删机制只允许出现在「已删及理由」语境，并标注状态；不得在其他章节按现存描述。
2. 未决不写成已解决；没有证据的结论写「未验」。
3. 目标状态不写成已实现状态（`AGENTS.md` 原有纪律，本次沿用）。

---

## 零、前提裁定（2026-11-11）

以下不是可选的背景，而是本日志所有条目的判据来源。

### 0.1 定位收紧

- 模型负责**决定如何完成任务**；fshine 负责让任务的**执行过程可追踪、执行结果可验证、异常状态可恢复**。
- fshine = **Pi Agent + Task Runtime + Execution Gateway + Channel Adapter**。
- 不再自称 Agent Harness，不追 OpenClaw / Claude Code / Codex 的通用功能。

**定位第三版（2026-11-11 复审裁定，2026-11-12 全文记于此；其他文档引用定位时以本节为完整出处，`AGENTS.md` 定位节为面向改动的摘要 + 指针）**：

- 目标：让不懂技术的业务人员，**愿意**把日常工作交给 AI，并在使用中逐渐建立信任。关键词是「愿意」不是「能」。
- 落地为四件事：交办简单 / 真正省事 / 行为可预期 / 随时能接管。
- 产品原则：不追求 Agent 自治程度最大化，而追求业务人员**净收益**最大化（净收益 = 省下的操作与思考时间 − 沟通/等待/审核/返工/风险成本）。
- 工程原则：允许 Agent 自由决定执行方法，但不允许它自行扩大任务授权。
- 停止线：每增加一个机制，问「它是否能让业务人员更容易、更放心、更省时间地完成工作？」不能明确证明就不优先做。

上列收紧三条与 0.2 的三层分工、0.3 的 A/B 分类是第三版的结构化落法；工程原则在本日志的实例就是四（T5 有界扩张门）：允许探索，不允许自行扩大授权。

### 0.2 三层分工

| 层 | 内容 | 证据 / 现状 |
| --- | --- | --- |
| 基座（Pi，直接复用，不重建） | agent loop、原生压缩、工具调用 | 见下「原生压缩激活链」与「contextWindow」 |
| 胶水层（fshine 的宿主编排部分） | 渠道/身份/会话、意图→结构化操作、计划门接平台、出口清洗、审计 | 本仓 `packages/agent/src`、`apps/server` |
| 执行层（当前接入实例） | 计划门预算梯子 execute/notify/confirm/stop、`SCOPE_EXPANSION` 检测 | 执行层仓；本仓只通过适配边界接入 |

> 命名口径：本文「fshine」指整体（Pi + Task Runtime + Execution Gateway + Channel Adapter）；「胶水层」与「宿主」指其中 fshine 自有的编排部分；「执行层」指当前接入实例。三者不混用。

**原生压缩激活链（激活改动只在 PR #54 分支；main 上尚未激活，不要读成已实现）**：

- `packages/agent/src/turn-persistence.ts:310-311`：`ensureHistoryBackfill` 在没有 `conversationLog` 时返回 `true`，在没有 `contextStates` 时返回 `false`。
- `packages/agent/src/runtime.ts:163`：backfill 返回 false → `effectiveContextMode = 'transcript'`。
- `packages/agent/src/runtime.ts:483-488`：只有 `effectiveContextMode === 'transcript'` 才执行过期会话强制压缩（`session_resume_seeding`）与每回合 `compactSafe`。
- 因此，摘掉 `contextStates` 接线后，每回合压缩与会话过期恢复才会同时激活（这是 PR #54 分支上的行为）。状态：**在 PR #54**（`arch/phase1-compaction`，draft，未合）。

**contextWindow**：

- main 上硬编码 `128_000`：`packages/agent/src/pi-driver.ts:158`（`contextWindow: 128_000`）。
- 这是假数：C2 实测跑到 241K token，压缩一次没触发（四路共用裁定事实）。
- PR #54 改为从模型能力读、缺省仍 `128_000`：分支上 `pi-driver.ts:177`（`capabilities.contextWindow ?? DEFAULT_CONTEXT_WINDOW`）。状态：**在 PR #54**。

**执行层自己的门是管用的（实测证据，四路共用裁定事实）**：

- 纯 pi 无自建编排下，平台侧 `SCOPE_EXPANSION` 触发 **17 次**、拒 **1 次** `PLAN_CALL_MISMATCH`；拒后同一轮重提计划并查询成功。
- 该证据属于执行层（当前接入实例）的行为，不是本仓实现；本仓只记录它支持「计划门预算梯子与范围检测归执行层」这一分工。

### 0.3 机制分类：A 类 / B 类（本次新增的核心审核纪律）

- **A 类 = 模型能力补丁**。判据：它存在是因为模型**现在做不到**。
  举例（含已删对象，状态见对应条目）：识别用户在引用历史（已删，2.5）、注入执行摘要提醒模型（已删，2.6）、强制申报回合类型（待实施，2.7）、检查回答是否遵循固定推理流程（仓内未见实现）。
- **B 类 = 确定性责任**。判据：换任何模型、模型强十倍，它都必须在。
  举例：授权、幂等、任务状态机、审计、结果验证、身份隔离。
- **审核问句**：「如果明天模型的推理和工具使用能力提高十倍，这个模块还需要存在吗？」
  - 不需要 → 持续接受消融测试的候选；
  - 需要（执行系统的确定性责任）→ 值得长期投入的基础设施。
- **两类用不同测试**：B 类用**确定性测试**证明违约路径被阻断；A 类用**消融 / 模型 Eval** 决定去留。
- **混合形态**：目的与实现可分属两类（如 `repeat-request.ts`：目的是 B、实现是 A）。此时两手证据都要——目的按 B 类写违约路径测试，实现按 A 类做消融 / 模型 Eval（同 `docs/architecture-laws.md` 机制分类节、`docs/change-safety.md` §1.1）。
- **命名冲突提醒**：本文「A 类 / B 类」指**机制类别**；`change-safety.md` 与 `exposure-lint.test.ts` 里的「B 类 / D 类」是**暴露面词表标签**，同形不同义。跨文档引用时写全「机制 A 类 / 机制 B 类」。
- 今天实际用到的分类：T5 范围对账 / T6 确认门兜底 / T10 四段是 **B 类**；T7 无空回复 / T8 执行语言不外泄是 **A 类穿工程外衣**，文档里必须标出来（见 3.8、5.3）。

### 0.4 Task Runtime 执行四态（不能混用）

> 命名：本文统一叫「**执行四态**」。`docs/v0-architecture.md` §1.3 的「意图 / 已受理 / 已返回 / 已验证生效」是同一组态的别名（待统一，不写成另一组概念）；它区别于 `change-safety.md` 的「写链四段」「交接四类」与本文 3.8 的「T10 四段」。

| 态 | 含义 | 仓里对应 |
| --- | --- | --- |
| ① 模型提出调用 | **仅代表意图** | 模型侧 toolCall；尚未获准 |
| ② 工具调用被接受 | 请求已进入执行流程 | 审计 `authorized` / `invoked` 梯级 |
| ③ 网关返回成功 | **提交动作**已成功返回 | `completed` 梯级；异步操作可能只代表任务被接受，不代表业务已处理完 |
| ④ 查询目标业务系统确认状态 | **有证据支持业务结果已生效** | 独立读回 / `verified`；写链缺回读 = 终态 `confirm_committed_unverified`（简称 `committed_unverified`），不报完成 |

- 异步操作尤其危险：网关返回成功可能只意味着任务被接受，不意味着业务已处理完。
- 仓里已有对应：`AGENTS.md`「修改前检查」第 4 条「区分调用获准、实际执行和执行成功」；eval 报告梯子 `scripts/eval/evidence.ts`（authorized/invoked/completed/verified/delivered）；`packages/agent/src/committed-unverified.ts`。
- **缺的是统一契约**：四态目前分散在审计、eval 报告、写链终态里，没有一份跨入口的统一约定。状态：**待实施**。

### 0.5 新增对象前置审计

- `AuditStore` 有 **12 个 Repo**（`packages/contracts/src/store.ts:501-520`）：principalScopes、requests、toolCalls、sessions、conversationLog、contextStates、taskPlans、memoryRecords、platformTasks、changeIntents、sessionArtifacts、taskRuns。**注（2026-11-12）**：`contextStates` / `memoryRecords` 的存储层残留已在 `arch/purge-memory-residue`（分支；截至写入未推送、未开 PR）删除，该分支上为 **10 个**；main 上仍为 12 个（残留补登记见 2.2 / 2.4）。本行其余部分按 main 实测。
- 记录「发生了什么」的有**五个**：**ToolCall / PlatformTask / TaskPlan / TaskRun / AgentRequest**。身份/会话/产物是不同关注点，但那五个是平行事实源。
- **新增 Task / TaskEvent / Evidence 之前必须先定**：哪个权威、哪些派生、哪些能合并。
- 今天已经因多源映射导致治理代码膨胀过一次（四路共用裁定事实）。
- 状态：**待实施**（哪个权威未定，见 5.4）。

### 0.6 Pi Durable（候选底座，未采纳）

- registry 上有 `@earendil-works/pi-durable@1.5.2`（`npm view @earendil-works/pi-durable name version` 实测输出 `name = ...` / `version = '1.5.2'`），但本仓没装。
- 本仓装的是 `pi-agent-core 0.85.1` + `pi-coding-agent 0.85.1` + `pi-ai 0.85.1` + `chord 0.85.1` + `pi-telemetry 0.85.1`（`package.json:39-41` 声明 `^0.85.1`；`node_modules` 实测 0.85.1）。
- 已知 issue **#10386**：与 pi-coding-agent 扩展系统不完全兼容——本仓正用 pi-coding-agent，要采用正撞它。
- **两个同时活动的 Harness 共用一个数据库不受支持**——多实例部署要自己设计所有权与调度。
- 它**不解决**外部业务操作的 exactly-once（工具写入成功 → 回执未持久化 → 崩溃 → 判不出是否生效），那一层只能 fshine 做。
- **裁定：候选底座，现在不采纳也不做 PoC。** 引入判据 = T10 的崩溃恢复用例（T10 四段见 3.8；该用例截至写入尚不存在，见本条末）。
- 唯一值得抄的一条：**按工具声明 replay 安全性**——可重放的崩后重跑；不可重放的返回 `interrupted`，不盲目再执行。
- 状态：**未采纳**（候选；不是待实施：无排期、无 PoC）。截至写入，`grep -rnE '崩溃|crash' tests/e2e | wc -l` = `0`；PR #55 正文四段是结果对账 / 停滞检测 / 冻结续跑 / 挂死留痕，`gh pr diff 55 | grep -Ei '崩溃|crash|interrupted'` 也零命中——该引入判据**尚未有对应用例**，不能把 PR #55 写成它的出处。

### 0.7 我们已有的持久化（够用，差的是一处）

- `TaskRunRecord` 已有（`packages/contracts/src/store.ts:140-168`）：`dispatchKey` 幂等键、`state` 状态机、`planId`/`stepIndex`/`totalSteps`/`lastProgress` 进度、`deadline`、`originMessage` 锚点。
- `confirm` 档是 **return pending 而非阻塞进程**：`packages/agent/src/plan-runtime.ts:208-223` 返回 `{ status: 'confirm', pending: {...} }`。
- **恢复粒度是任务级，不是工具执行级**——唯一缺口，而那正是 Pi Durable 也没堵的那条缝。
- 状态：现有能力**已合入**；缺口**待实施**。

---

## 一、条目格式

新增条目按下列七字段写，缺一不可：

```markdown
### <编号> <对象名>

- **决定**：
- **日期**：
- **对象**：
- **理由**：
- **证据**：
- **状态**：
- **加回来的判据**：   <!-- 保留条目改写「删除判据」 -->
```

规则：

- 状态必须落到「读法」里的五态之一；`在 PR` 必须写编号与 draft/合并；未合入时必须补一句「main 上仍在/已无此文件」，避免读者误判。混合态按「主体状态 + 未完成部分独立状态」拆开写，不得混成一个词。
- 「加回来的判据」写**可观测的触发条件 + 必须采用的形态**，不写「以后再说」。
- 证据引仓内相对路径与**符号名**（函数 / 常量 / 事件名），行号只作辅助且必须与当前 main 实跑核对（行号对插行免疫性为零，见 `architecture-laws.md` 执行纪律 4）；PR 证据引 `phona/fshine-agent#NN` 与正文原话；不可复现的引用（未推送提交、纯本机状态）不算证据。

---

## 二、已删机制（九类）

**总览（截至写入）**：九类均为 2026-11-11 裁定；**没有一条已合入 main**。①–⑥ 为**在 PR #54**（draft，未合）；⑨ 为**在 PR #54（部分）**——两个历史检索工具名已移出，完整删除**待实施**（前置 ⑦）；⑦、⑧ 为**待实施**。main 上这些文件/机制仍在，读代码时不要按「已删」理解。

**残留补登记（2026-11-12）**：早期删除清单只列了 agent 侧文件与装配接线，`packages/core` / `packages/contracts` 的存储层残留（②、④ 的存储与契约面，见 2.2 / 2.4 的「对象」补登记）不在其中；`packages/core/src/memory-records.ts` 还自带测试 suite，让「机制健在」的错觉可复现。该残留随 `arch/purge-memory-residue`（基于 `origin/arch/integration` 的分支；截至写入未推送、未开 PR）整簇删除：三表两 repo（`conversation_context_states` / `long_memory_records` / `long_memory_cursors`；`contextStates` / `memoryRecords`）、契约类型与 `AuditStore` 成员、`packages/core/src/index.ts` 桶导出、`memory-records.ts` 与其测试。守卫扫描面同时从 `packages/agent/src` + `apps` 扩到含 `packages/core/src` 与 `packages/contracts/src`（`apps/server/no-learning-path-wiring.test.ts` 的 `SCAN_DIRS`；扫描面只加不减）。**main 上这些残留仍在**，读 main 代码时不要按「已删」理解。

**消费者处置（2026-11-12，同分支）**：存储层删除后，还留着两个引用它的消费者，随同一分支处置（机制已实证无人写；不是为凑绿删守卫——两处怎么改都仍是红的）：

① `tests/e2e/turn-loop-pingpong.test.ts`：`awaitContextState` 轮询 helper（`contextStates.get`）与 8.4 里直接读 store 的调用、8.3/8.4 的 `unresolvedQuestions` 断言、8.4 的 `search_history` / `get_messages` 工具断言、「未决问题被清空 / 问句原文被最近窗口挤出」的窗口 characterization，以及 8.3 里"模型自己上一轮说过的话在下一轮上下文里"的两条断言（该内容原由投影注入提供，属被删机制），一并移除。理由：集成分支上该表已无生产写入方，继续轮询只会拿到 5s 超时（处置前该文件 8.3/8.4 即挂在这里）；用户原话延续与子任务归属的断言保留。**该文件其余行为断言保留**，在 dummy 夹具上仍因域耦合为红（与 `origin/main` 对照组的失败集一致），不因本次处置转绿。转录模式下"上一轮自己说的话在下一轮上下文里"的连续性无现有用例覆盖，登记为 PR #54 转录模式落地面的补测项。

② `scripts/acceptance.ts`：`drainBackgroundPersistence` 的判据 ①（`conversation_context_states.through_event_id` 游标）随对象消失移除，保留判据 ②（`PRAGMA data_version` 静默地平线）作残余安全网。不如此则表删后该脚本在**写报告之前**抛 `SqliteError`（drain 在报告落盘之前执行，见 D-084③ 的关停次序），整轮验收报告丢失。

| 编号 | 机制 | 状态 |
| --- | --- | --- |
| 2.1 ① | history-tools（search_history / get_messages） | 在 PR #54（draft） |
| 2.2 ② | long-memory / memory-consolidator / memory-candidate-extractor / memory-model | 在 PR #54（draft） |
| 2.3 ③ | compaction-context sidecar | 在 PR #54（draft） |
| 2.4 ④ | context-state / context-extractor / context-model | 在 PR #54（draft） |
| 2.5 ⑤ | reference-evidence | 在 PR #54（draft）；同对象另有 #51 的「修复而非删除」竞争草案（两案未合并，权威裁定是删除） |
| 2.6 ⑥ | execution-facts | 在 PR #54（draft） |
| 2.7 ⑦ | route_current_turn 申报层 1+2 | 待实施 |
| 2.8 ⑧ | protocol-material | 待实施 |
| 2.9 ⑨ | step-text 的 INTERNAL_TOOLS 抑制 | 在 PR #54（部分：两个名字已移出）；完整删除待实施（前置 ⑦） |

### 2.1 ① history-tools（search_history / get_messages）

- **决定**：删除两个历史检索工具及其工具面注册与指引文案。
- **日期**：2026-11-11。
- **对象**：`packages/agent/src/history-tools.ts`（`createHistoryTools`、`SEARCH`、`GET_MESSAGES`）；注册点 `packages/agent/src/runtime.ts:494-500`。
- **理由**：无价值 + 已知复合通道——模型自己的错误发表进日志、被后续召回轮捞回、再发表。
- **证据**：`history-tools.ts:28-52` 直接对 `conversationLog` 做 `list` / `search`；`turn-persistence.ts:177` 把 `assistant_message` 写入同一日志，因此检索结果可以包含模型自己写过的错误内容；PR #54 正文 T1 记「工具面不含两者；召回轮 delegate 在作答前真实发起平台获取并落 tool_result 审计」。
- **状态**：**在 PR #54**（draft，未合）。main 上文件与注册仍在。
- **加回来的判据**：只有当宿主没有可注入的材料、且实测证明模型必须自主检索历史才能答对时；形态必须是**宿主持有的只读事实检索**，且**不得把模型自己写进日志的 assistant 文本作为证据源**（切断复合通道）；加之前先做消融，证明「不检索会红」，否则不加。

### 2.2 ② long-memory / memory-consolidator / memory-candidate-extractor / memory-model

- **决定**：删除长期记忆的抽取、合并、候选模型与装配接线。
- **日期**：2026-11-11。
- **对象**：`packages/agent/src/long-memory.ts`、`memory-consolidator.ts`、`memory-candidate-extractor.ts`、`memory-model.ts`；装配点 `apps/server/assembly.ts:259-261`；注入点 `packages/agent/src/runtime.ts:458` 与 `turn-persistence.ts:54-61`。**存储层残留（2026-11-12 补登记）**：`packages/core/src/memory-records.ts`（`renderMemoryProjection` + `MemoryRecord*` 类型；全仓无生产消费者，只被自己的测试与桶导出引用）与其测试 `packages/core/memory-records.test.ts`；`packages/core/src/store.ts` 的 `long_memory_records` / `long_memory_cursors` 两表与 `memoryRecords` repo（含行类型、行映射、`sameMemoryRecord`）；`packages/contracts/src/store.ts` 的 `MemoryRecordType` / `MemoryRecordStatus` / `MemoryRecordRecord` / `MemoryRecordRepo` 与 `AuditStore.memoryRecords`；`packages/core/src/index.ts` 的桶导出。
- **理由**：战争故事机制——从历史学用户行为 → 借新指令扩大执行范围（曾打爆下游基础设施）。
- **证据**：`memory-candidate-extractor.ts:24-26` 的系统提示词要求从用户原始消息中提取 `preference|fact` 并持久化；`memory-consolidator.ts:30-31` 按 principal 合并并重建投影；`turn-persistence.ts:58` 把投影作为「长期记忆资料」注入上下文；`runtime.ts:458` 每回合读取。
- **状态**：**在 PR #54**（draft，未合）。main 上四个文件与接线仍在。存储层残留（上列补登记项）随 `arch/purge-memory-residue`（分支；截至写入未推送、未开 PR）删除；**main 上仍在**。
- **加回来的判据**：仅当跨会话个性化被证明必须保留，且同时满足四条——(a) 记忆只能由用户**显式声明/编辑**，不从历史推断用户行为；(b) 每条记忆有原始用户消息来源与确立轮次；(c) 有确定性测试证明**记忆内容不能成为平台调用的授权或实体来源**；(d) 记忆不参与执行范围决定。缺任一条都不加。

### 2.3 ③ compaction-context sidecar

- **决定**：删除压缩 sidecar，压缩产物只留 pi 原生摘要 + 保留尾段。
- **日期**：2026-11-11。
- **对象**：`packages/agent/src/compaction-context.ts`（`COMPACTION_CONTEXT_MESSAGE_TYPE`、`buildCompactionContextSidecar`、`readCompactionContext`）；消费点 `packages/agent/src/pi-driver.ts:289`、`repeat-request.ts:193`。
- **理由**：宣言层；同型禁令在仓内三处，实测全失效。
- **证据**：`compaction-context.ts:9` 定义 sidecar 类型，`:40-44` 构建，`:117` 写入 `custom` 消息，`:167` 渲染「【宿主压缩引用索引】」；三处同型禁令分别在 `pi-driver.ts:270`（「引用是转述数据，不得总结成用户本人直接陈述、选择、确认或授权」）、`turn-persistence.ts:58`（「不得把历史对象、范围或执行许可当作当前授权」）、`turn-contract.ts:42`（「之前的回答、工具结果、确认计划也只是历史资料，不是当前授权」）。PR #54 正文 T3 记「产物不含 `compacted_request_context` / `宿主压缩引用索引` / `request-v1:`，且每条都是原生 pi 消息」。
- **状态**：**在 PR #54**（draft，未合）。main 上文件与两个消费点仍在。
- **加回来的判据**：仅当原生压缩被证明丢掉重复请求/续跑所必需、且无法按需重算的事实；形态必须 (a) 有消费者测试证明「删除即红」，(b) 不改变每回合上下文前缀，(c) 有界；(d) 不得再用「再写一条禁令」代替机制——三处禁令实测全失效是这条判据的直接来源。

### 2.4 ④ context-state / context-extractor / context-model

- **决定**：删除 Context State 的确定性归约、语义抽取与抽取模型调用。
- **日期**：2026-11-11。
- **对象**：`packages/agent/src/context-state.ts`、`context-extractor.ts`、`context-model.ts`；装配点 `apps/server/assembly.ts` 的 `contextStates` 接线。**存储层残留（2026-11-12 补登记）**：`packages/core/src/store.ts` 的 `conversation_context_states` 表与 `contextStates` repo（含行类型与行映射）；`packages/contracts/src/store.ts` 的 `ContextStateRecord` / `ContextStateRepo` 与 `AuditStore.contextStates`（必填成员）。
- **理由**：语义投影；C2 一次跑出现 **8 次** `context_semantic_extract_failed`，失败即落正则兜底。
- **证据**：`context-state.ts:28-32` 用正则做决策/假设/问题归约；`context-extractor.ts:40-45` 把模型输出视为不可信、要求调用方以 `reduceContextState` 兜底；`context-model.ts:21-26` 记超时 10s→60s 与「超时后 extract 落空 → context_semantic_extract_failed」；`turn-persistence.ts:284-288` 失败后直接 `reduceContextState`。
- **状态**：**在 PR #54**（draft，未合）。main 上三个文件与 `contextStates` 接线仍在。存储层残留（上列补登记项）随 `arch/purge-memory-residue`（分支；截至写入未推送、未开 PR）删除；**main 上仍在**。
- **加回来的判据**：只有当「跨回合未决问题」在原生压缩后确实丢失并影响正确性；形态优先**无模型的确定性事件归约**，不做每回合语义抽取；失败必须显式记为 `INCONCLUSIVE` 或可见事件，**不许静默落回正则后仍写绿**。若必须调用模型，需先证明抽取成功率与降级行为都有实测数据，而不是单测全绿。

### 2.5 ⑤ reference-evidence

- **决定**：删除主动回溯证据（指代消解证据注入）。
- **日期**：2026-11-11。
- **对象**：`packages/agent/src/reference-evidence.ts`；注入点 `packages/agent/src/runtime.ts:415`（`collectReferenceEvidence` 分支）。
- **理由**：线索词尺只认中文，九个英文长会话用例上静默全关，单测全绿而机制一次不跑。
- **证据**：`reference-evidence.ts:33` 的 `REFERENCE_CUE_RE` 只含中文线索词；`reference-evidence.ts:104` 无命中即返回 `null`。`spike/generic-agent`（PR #51）分支的修复注释实测记录：「原尺只有中文直陈形态，实测全语料中文开门 4 轮、补英文后 34 轮——九个零中文线索的用例正好全是长会话用例，台账/指代证据在那些轮次根本没机会注入」。PR #54 正文 T9 把两个注入分支一并删除。
- **状态**：**在 PR #54**（draft，未合）。main 上文件与注入分支仍在。**同对象的竞争草案在 PR #51**（draft，未合）：保留机制并补英文线索尺的「修复而非删除」方案；两案未合并，当前权威裁定是删除（本条）。
- **加回来的判据**：只有当召回/归因在非中文或长会话上出现红；形态必须**语言无关**（中文 + 英文线索表），并把那 **9 个零中文线索的长会话用例**作为必过正控；验收必须证明「机制开过门」（注入事件计数 > 0），单测全绿不算。若 #51 先合入，以它的英文尺为起点，但仍需补上述正控。

### 2.6 ⑥ execution-facts

- **决定**：删除执行事实台账注入（渲染 + runtime 注入分支 + turn-context 参数）。
- **日期**：2026-11-11。
- **对象**：`packages/agent/src/execution-facts.ts`；注入点 `packages/agent/src/runtime.ts:438-450`、`turn-context.ts` 的 `executionFactsText`。
- **理由**：T9 的红有混淆（历史被挤掉 ≠ 台账缺失）；而「无条件注入」这个候选变体有确定成本（每回合改写上下文头部，破坏前缀稳定）。
- **证据（T9 的红，将来加回来的依据，逐条留档）**：
  - 中间实验的归属（不可复核，只登记不作证据）：「无条件注入」只出现在未推送的本地提交 `ab9c1c9`（`git ls-remote --heads origin backup/arch-phase1-prev` 空输出）——它不在 main，也不在 PR #54 的提交历史；该提交与分支读者无法复核，**未验**。
  - 混淆源：main 上 `contextMode` 默认 `state_recent`、`recentTurns` 默认 **2**（`runtime.ts:122-123`），模型本来就没全文，「答不出」可能因为历史被挤掉而不是台账缺失；T9 不是在默认改成 `transcript` 之后跑的（PR #54 正文「T9 用户裁定」原话：「路 A 虽已把默认改成 transcript 把这个变量翻过来，但 T9 不是在翻过来之后跑的」）。
  - 无条件注入的成本（PR #54 正文原话）：`executionFactsText` 放进 `assembleTurnContext` 的头部参数，每回合改写上下文头部 = 破坏前缀稳定 = prompt cache 命中率下降。
  - 删除后实测：PR #54 正文 T9 探针绿，两查询（alpha W1 → contoso-trade W2）后的召回轮回答「刚才查询的是 **contoso-trade collection W2** 的记录值」，平台调用 4（被拒 2），`✓ T9 40.9s`；PR #54 分支提交 `15f50d7`（`origin/arch/phase1-compaction`，可用 `git show 15f50d7` 复核）记「T9 探针 --only T9 实测绿：答对 contoso-trade W2」。
  - main 上的真实形态补正：main 并非无条件注入——注入分支以 `runtime.ts` 的 `looksLikeReferenceCue(userMessage)` 开门，而该尺只认中文（`reference-evidence.ts` 的 `REFERENCE_CUE_RE`）。「无条件注入」只在未推送的中间实验（见上），不在 main，也不在 PR #54 历史。读旧报告时不要把两者混为一谈。
- **状态**：**在 PR #54**（draft，未合）。main 上 `execution-facts.ts` 与注入分支仍在；`platformTasks` 数据源保留（超时恢复与实体来源仍在用）。
- **加回来的判据**：必须在**无混淆配置**下复跑 T9——`transcript` 全文 + 原生压缩已激活（模型真的拿到历史）——仍然红，且红不能由「历史被挤掉」解释；同时满足：注入**不得每回合改上下文前缀**（追加到尾部或按需触发），并留下注入事件与计数。满足这些条件时，`platform_tasks` 数据源仍在，重写渲染 + 注入是小事。仅凭 PR #54 所记的那次带混淆的红（T9 不在 transcript 默认之后跑），不加。

### 2.7 ⑦ route_current_turn 申报层 1+2

- **决定**：删除「强制模型每回合申报」与「申报结构校验 + 退回重填」两层；保留 resend 分支与实体范围校验（第 3 层）。
- **日期**：2026-11-11。
- **对象**：`ROUTE_CURRENT_TURN_TOOL`、`reviewRouteDeclaration`（均在 `packages/agent/src/turn-contract.ts`）、runtime 的强制申报工具面与退回分支（`packages/agent/src/runtime.ts`）。
- **三层口径**（首次出现处写明）：第 1 层 = 强制模型每回合申报回合类型；第 2 层 = 申报结构校验 + 不合法退回重填；第 3 层 = resend 分支与实体范围校验（保留）。与 `v0-architecture.md` §10 的「申报层 1+2」同义。
- **理由**：A 类纪律——强制模型申报回合类型，属于「模型现在做不到/不可靠」的补丁。
- **证据**：`turn-contract.ts` 文件头自述本文件做两件事——结构校验（`reviewRouteDeclaration`）与范围守卫（`validatePlanEntities`）；`runtime.ts` 主 Agent 工具面只注册申报工具（加后台控制 / 历史检索）；申报不合法即退回重填。
- **保留的第 3 层**：resend 分支（`ROUTE_CURRENT_TURN_TOOL` schema 的 `artifactRef`；文件头说明产物存在性由宿主回答）与实体范围校验 `validatePlanEntities`（`turn-contract.ts`）。
- **状态**：**待实施**。截至写入，没有任何分支或 PR 删除这两层（本地与 `origin` 分支遍历：所有分支的 `runtime.ts` 仍含 `ROUTE_CURRENT_TURN_TOOL`）。
- **加回来的判据**：**不是把申报表加回来**。若删除后回归红，该加的是**宿主持有指代解析**——宿主从当前消息 + 会话事实解析指代词/实体，把已解析的请求注入委派；resend 保留为独立确定性分支。只有在「宿主无法解析、且必须由模型决定意图」时，才有理由重新要求模型产出结构化意图，且需附消融证据证明去掉申报会红、加上会绿。

### 2.8 ⑧ protocol-material

- **决定**：删除处理「模型把申报 XML/JSON 写成正文」的补丁。
- **日期**：2026-11-11。
- **对象**：`packages/agent/src/protocol-material.ts`（`isWholeReplyRouteDeclaration`、`looksLikeProtocolMaterial`）；消费者 `packages/agent/src/reply-exit.ts:21`、`:127`。
- **理由**：纯模型失败补丁——根因是模型把申报协议当正文输出，补丁只在出口做形状识别与整段替换。
- **证据**：`protocol-material.ts:12-25` 记录 D-144 事故（2026-10-31 确认续跑轮的整理模型把 `<function=route_current_turn>` 申报原文写成正文）；`:49-55` 为纯形状判定。
- **状态**：**待实施**。main 上文件仍在，PR #54 未删除它（PR #54 的 diff 不含 `protocol-material.ts`）。
- **加回来的判据**：只有当出口再次出现**确定性的整段申报泄漏**；形态必须是窄形状判定（整段 XML/JSON、标签外一无所有），不做内容嗅探；先用提示词/输出格式修根因；回归用例必须是真实泄漏原文，不得用合成样例代替。

### 2.9 ⑨ step-text 的 INTERNAL_TOOLS 抑制

- **决定**：删除「内部工具不上进度帧」的抑制表及其分支。
- **日期**：2026-11-11。
- **对象**：`packages/agent/src/step-text.ts` 的 `INTERNAL_TOOLS` 集合（main 上含 `ROUTE_CURRENT_TURN_TOOL_NAME`、`search_history`、`get_messages`）。
- **理由**：内部工具删了就没对象。
- **证据**：`step-text.ts` 的 `INTERNAL_TOOLS` 定义；PR #54 的 `step-text.ts` diff 把名单收窄为只剩 `ROUTE_CURRENT_TURN_TOOL_NAME`，并删掉 `search_history` / `get_messages` 两个名字（`gh pr diff 54` 的 `step-text.ts` 段可复核）。
- **状态**：**在 PR #54（部分）**——两个已删工具的名字被移出名单；**完整删除待实施**，前置是 ⑦：`route_current_turn` 今天仍是内部工具，抑制表仍有对象。main 上三名字俱在。
- **加回来的判据**：不是「加回抑制表」，而是：任何**新内部工具**进入主工具面时，必须同时登记到抑制表并附「工具名零上屏」断言（含模型自填短语路径）；若主工具面只剩模型工具，则整表与 `null` 分支一起删除，不保留空壳。

---

## 三、保留的 B 类机制

**总览（截至写入）**：以下机制全部在 main 上（**已合入**），2026-11-11 裁定保留。保留理由统一用 0.3 的审核问句：换任何模型、模型强十倍，它们仍是执行系统的确定性责任。

### 3.1 session-entities

- **决定**：保留「本会话用户亲自操作过的实体」作为实体门禁的合法出处。
- **日期**：2026-11-11（机制源自 2026-09-27 一次真实企微通话事故）。
- **对象**：`packages/agent/src/session-entities.ts`；接线 `runtime.ts:663-682`；门禁来源 `turn-contract.ts:235-257`。
- **理由**：实体门禁若只按每轮无状态标定，连续会话中用户补一个范围编码就会被判死；门禁防幻觉的功能必须保留，但出处范围要包含「本会话用户亲自操作过」。
- **证据**：`session-entities.ts:1-19` 文件头记录事故与边界；`session-entities.ts:93-146` 从 `platform_tasks` 的 calls 快照按平台 args 规格机械提取，绝不从结果原文/worker 文本解析；`turn-contract.ts:244-257` 把它列为第五来源。
- **状态**：**已合入**（保留，main 在位）。
- **为什么模型强十倍还在**：授权与范围事实由宿主拥有。模型再强也不能把「用户操作过哪些对象」变成可推断的授权；否则等于让模型自证范围，幻觉防线失效。
- **删除判据**：只有实体门禁整体迁到执行层，且仍保留「本会话已操作」这一来源与审计；不得因为模型更准就删。

### 3.2 clarification-events

- **决定**：保留澄清选择的 append-only 事件，以及宿主对裸编号的机械绑定。
- **日期**：2026-11-11。
- **对象**：`packages/agent/src/clarification-events.ts`；接线 `runtime.ts:380-386`、`:472`。
- **理由**：宿主发出澄清后，用户的裸编号答复此前只能由模型解释；2026-09-27 实测模型把「1」猜成范围编码，查询带着猜错的范围执行。绑定改宿主持有。
- **证据**：`clarification-events.ts:1-19` 记录 `issued` / `resolved` 载荷与关联键；`:11-15` 说明判据（纯编号落在候选个数内或与候选逐字相同，且会话里有 issued 未 resolved 的澄清）。
- **状态**：**已合入**（保留，main 在位）。
- **为什么模型强十倍还在**：绑定是一条可审计事件 + 确定性关联键；模型理解力不产生可审计的绑定记录，且编号语义只有宿主持有（`issued` 的候选列表）。
- **删除判据**：只有澄清协议被移除，或绑定整体迁到执行层且保留同等审计。

### 3.3 committed-unverified

- **决定**：保留「提案已提交但回读缺失」的独立终态，绝不报完成。
- **日期**：2026-11-11。
- **对象**：`packages/agent/src/committed-unverified.ts`；终态 `confirm_committed_unverified`（`context.ts:455`、`:464`、`:1077`）；任务结局映射 `task-manager.ts:148`。
- **理由**：平台侧提案已标记提交（不可重复提交），但落账后读回数量不足；此时报「完成」是假，报「失败」也假（失败暗示什么都没提交）。必须留人对账。
- **证据**：`committed-unverified.ts:1-11` 说明三种话术不可混用；`:20-23` 是唯一文案来源；`:41-52` 是纯机械分类（`PROPOSAL_VERIFY_SHORT` 或读回差额 < 声明）。
- **状态**：**已合入**（保留，main 在位）。
- **为什么模型强十倍还在**：这是**证据缺口**，不是判断力问题。模型再强也不能证明一个未发生的读回；把「缺证据」说成「完成」只会更流畅地骗人。
- **删除判据**：只有平台提供可证明的「提交—读回」原子回执，或读回缺失不再可能发生。

### 3.4 freeze-task-inputs

- **决定**：保留附件集冻结，排队任务不重读可变会话池。
- **日期**：2026-11-11。
- **对象**：`packages/agent/src/freeze-task-inputs.ts`；接线 `packages/agent/src/context.ts:1162-1172`。
- **理由**：排队任务在真正执行前，用户可能替换/删除附件；重读可变池会让「用户提交的输入」与「实际执行的输入」不一致。
- **证据**：`freeze-task-inputs.ts:1`「Freeze the host-selected attachment set; queued tasks never reread a mutable session pool」；`:32-38` 在 dispatch-key 去重之后、受理回执之前物化；`:49-77` 逐文件 realpath/大小/哈希校验并写只读副本。
- **状态**：**已合入**（保留，main 在位）。
- **为什么模型强十倍还在**：这是竞态与所有权不变量；模型无法保证队列执行时文件未被替换，也无法替宿主做哈希对账。
- **删除判据**：只有执行层提供不可变输入快照并承担同等校验。

### 3.5 repeat-request

- **决定**：保留「重复的同一句话是新授权、不是缓存命中」的机械复核。
- **日期**：2026-11-11（机制源自 2026-10-19 真机实测）。
- **对象**：`packages/agent/src/repeat-request.ts`；接线 `runtime.ts:616-625`。
- **理由**：用户把同一句话连发三次，模型明确认出是重复请求，仍选对话枝，拿历史结论重新排版输出——零执行、零产物，用户拿到的是服务器路径而不是文件。宿主必须把「这条消息本会话已经委派执行过」这个确定性事实递到申报处。
- **证据**：`repeat-request.ts:1-30` 记录事故与判据（逐轮配对 user 消息 ↔ `route_current_turn` 调用 ↔ 回执；不读 worker 文本、不做语义判断）；命中后退回重填一次，之后放行（增强不是门）。
- **状态**：**已合入**（保留，main 在位）。
- **性质备注（B 目的 A 实现）**：目的是 B 类——「历史答复不是当前授权」是确定性责任；实现是 A 类手法——用转录形状补模型的误判。两类证据都要：**目的**按 B 类写确定性违约路径测试（同一句话重复出现时，不得以「缓存命中」为由跳过执行）；**实现**（退回一次这一增强）按 A 类管，用消融 / 模型 Eval 决定去留，并观察误伤与漏判（与 `architecture-laws.md` 机制分类节、`change-safety.md` §1.1 同口径）。若将来模型稳定判对，只能用**消融**决定「退回一次」是否还需要，不能放宽「历史不是当前授权」本身。
- **删除判据**：只有「重复请求 = 新授权」的判据整体迁到执行层/协议，且仍有确定性阻断与留痕。

### 3.6 TaskRunRecord.dispatchKey

- **决定**：保留宿主生成的幂等键。
- **日期**：2026-11-11。
- **对象**：`packages/contracts/src/store.ts:143-144`（注释原话：「Host-generated idempotency key for the source dispatch event/tool call」）；使用点 `packages/agent/src/task-manager.ts:724-741`。
- **理由**：重复提交必须返回原 run，不能新建；`submitIdempotently` 先查 `getByDispatchKey`，再查进程内 in-flight，二者都命中原 run。
- **证据**：`store.ts:143-144`；`task-manager.ts:724-741`；`store.ts:198-207` 的 `getByDispatchKey`。
- **状态**：**已合入**（保留，main 在位）。
- **为什么模型强十倍还在**：幂等键是宿主生成的事实，模型无法代替。它是**任务级源派发键**（`dispatchKey` 注释原话：「Host-generated idempotency key for the source dispatch event/tool call」），保证同一源派发事件不重复建任务；exactly-once 三要素的第一样「业务操作 ID」是**调用级**标识（候选载体 `callId`，见 `docs/a2a-protocol.md` 标识词汇节，**未落地**），两者不在同一层，不能互相冒充。少任务级键，重试会重复建任务；少调用级 ID，崩溃后判不出单次调用是否已生效。
- **删除判据**：永不删除；只能替换为等价的宿主生成键，并保留去重语义。

### 3.7 WT-1 / WT-2

- **决定**：保留两条端到端回归：超时收掉并留部分转录；同一 `taskId` 从持久化断点续跑。
- **日期**：2026-11-11。
- **对象**：`tests/e2e/turn-loop-worker-timeout.test.ts` 的 WT-1（`:234`）与 WT-2（`:292`）。
- **理由**：超时不是「什么都没发生」；已经产生的部分转录必须留存。续跑必须复用同一任务与断点，不新开任务、不从零重付。
- **证据**：WT-1 标题「worker 跑过截止后返回空稿：用户收到超时话术，span 记 failed/timeout，任务留痕带部分转录」；WT-2 标题「超时后续跑：同一 taskId 从持久化断点继续，不新开任务也不从零重付」。PR #55 正文记录 WT-1/WT-2/WT-3 一字未改且绿，并给出变异验证：去掉超时 catch 的部分转录持久化 → 3 failed；续跑不复用 taskId、新开任务 → WT-2 failed（records 2 条）。
- **状态**：**已合入**（保留，回归保护在 main）。
- **为什么模型强十倍还在**：资源与持久化不变量。模型更强不会让超时成本消失，也不会自动从持久化断点续跑；这是 Task Runtime 的责任。
- **删除判据**：只有超时/续跑语义被整体移除，或由等价机制接管并有同等回归。

### 3.8 今日新增的 B 类与 A 类（状态另计，不与「保留」混用）

| 项 | 类别 | 对象 | 状态 |
| --- | --- | --- | --- |
| T5 执行范围对账 | B | `execution-scope.ts`、`planDeclarationCovers` | **已裁定未实现**：裁定形态 = 有界扩张门（帽 5，与既有读类探测帽同源，见四），尚未实现；PR #53 为临时严格拒收，不是裁定形态（见四） |
| T6 确认门兜底 | B | `task-budget.ts`、`confirm-gate-hold.test.ts` | **在 PR #53**（draft，未合） |
| T10 四段（结果对账 / 停滞冻结 / 冻结续跑 / 挂死留痕） | B | `result-contract.ts`、`task-stall.ts`、`tests/e2e/turn-loop-task-liveness.test.ts` | **在 PR #55**（draft，未合） |
| T8 执行语言不外泄 | A（穿工程外衣） | `execution-language.ts`、`reply-exit.ts` | **在 PR #53**（draft，未合） |
| T7 无空回复 | A（穿工程外衣） | `pi-driver.ts`（`pi_driver_empty_reply`、`shouldNudgeFinalReply`）、`assembly.ts` 的 `parseContextWindow` 接线 | **在 PR #54**（窗口贴边治理；修复已提交 4ef557b——即该 PR 现头，未合入 main；成色待用例 3 判定） |

- T5/T6/T10 判为 B 类的理由：范围对账、确认门顺序、结果验证与任务生命周期都是「换模型也必须在」的确定性责任。
- T8 判为 A 类的理由：它补的是模型把错误码/脚本路径/operation 名/控制词写进用户可见文本的倾向；确定性删除层是工程外衣，去留应由消融/模型 Eval 决定。
- T7 判为 A 类的理由：空回复是模型在窗口贴边时的产出失败；能否用更强模型/压缩策略消掉，需消融验证，不能直接当可靠性基础设施建。
- **状态更正（2026-11-11 复审，注明依据）**：
  - T5 原写「待实施」，与本文件状态定义冲突（PR #53 已有代码）。更正为「已裁定未实现」——裁定是有界扩张门，PR #53 的现有提交是严格拒收的临时修法（见四）。
  - T7 原写「无实现、无分支/PR」不成立。依据：PR #54 正文含「T7 窗口贴边空回复」节；分支 `arch/phase1-compaction` 有 `shouldNudgeFinalReply`（`packages/agent/src/pi-driver.ts`）与 `LLM_CONTEXT_WINDOW` 接线（`apps/server/assembly.ts` 的 `parseContextWindow`）及相关单测。更正为「在 PR #54」。修复已提交（4ef557b，2026-11-11，现为该 PR 现头，`gh pr view 54 --json headRefOid` 可复核）；成色待用例 3 判定——判定前不得把 PR 正文那轮 20/20 单次绿当成已收口（见 5.2）。

---

## 四、争议裁定记录：T5 为什么选「有界扩张门」而不是「严格超出即拒」

- **争点**：T5 的字面判据是「执行集合 ⊆ 已确认计划」。按字面，任何对不上计划声明的网关调用都应拒。另一方案是「有界扩张门」：允许有限次数的未声明读类探索，超过帽才拒。
- **裁定（2026-11-11）**：**有界扩张门**。不是严格超出即拒。
- **理由**：
  - 既成断言 `packages/agent/serve-gate.test.ts:397-403` 把「探索性查询不锁死」钉成有意为之的设计决定：计划里写查 alpha，worker 看了结果想查 beta——正当探索，不能拦死。`:495` 的结构化读调用用例同样钉了这条。
  - 为一句 spec 推翻它，是**以措辞压过代码判断**。判据与实现冲突时，先看哪一边是经过测试与实测钉住的产品行为。
  - 帽用**既有**读类探测帽默认值 **5**：`packages/agent/src/pi-coding-driver.ts:114`（`DEFAULT_READ_PROBE_CAP = 5`），同一个 `readProbeCap` option、同一个数，不新造第二份阈值。
- **实现史（事实，不是裁定）**：
  - `d54a0c9` 的 T5 已实现过有界扩张门（额度与读类探测帽共用同一 option 与同一个数）。
  - Codex review（PR #53）对 `d54a0c9` 提了 blocking：结构化调用绕过扩张额度、扩张拒收发生在放行审计与执行计数之后、累计确认门可被恢复路径绕过、范围对账假绿。此外还有 T6/T8 的 blocking。
  - `2d3d312` 因此去掉额度，改成「第一跳即拒」，并让结构化通道同判据。当前 PR #53 的头就是严格拒收（`pi-coding-driver.ts` 分支版本 `:1887-1894` 注释原话「不设探索额度」）。注意：这是**修 review 缺陷时的临时收法**，不是本节的最终裁定。
  - 同一头上的另一个事实：`execution-scope.ts` 的审计对账生产代码**没有调用点**（`git grep reconcileAuditAgainstDeclarations` 只命中 `execution-scope.test.ts` 与注释，`index.ts` 未导出），且仍保留自己的 `referenceKey` / `argsContainDeclared`（`referenceKey` 丢掉 operation 域、`argsContainDeclared` 用有序子序列判参数）——Codex 对 `d54a0c9` 提的「对账器假绿」blocking 在现有头上仍可复核。T5 的状态因此是**已裁定未实现**，不是「门已拒、对账已通」。
- **落地判据（重新实现有界门时必须同时满足）**：
  1. bash 与 `structured_call` 两个入口共用同一份范围分类与同一个计数；
  2. 拒收裁决发生在放行审计与执行计数之前，被拒调用不得留下 `allowed:true` 的假执行痕迹；
  3. 审计侧对账复用运行时同一份覆盖判据（`planDeclarationCovers` / `coversPlanStep`），不另建第二套；
  4. 覆盖 `cap + 1` 次被拒的测试，且 `cap = DEFAULT_READ_PROBE_CAP`；
  5. `serve-gate.test.ts:397-403` 与 `:495` 的既有断言一字不改。
- **状态**：**已裁定未实现**（裁定形态待实施）。PR #53 的现有代码与本节裁定不一致；在改完之前，不得把 PR #53 的严格拒收当成 T5 的最终实现，也不得引用它证明「有界门已落地」。
- **跨文档更正登记**：`architecture-laws.md` 的在册实例表把 T5 判据写成「声明 N 与独立读回 N 的对账」——那是 T10 的 result-contract（`v0-architecture.md` §1.2 Evidence 行、PR #55 段 1）；T5 的判据是「执行集合 ⊆ 已确认计划」（本节）。两处口径需在收口前对齐。
- **反向判据**：若将来要改回「严格超出即拒」，必须显式推翻 `serve-gate.test.ts:397-403`/`:495` 并给出新的实测证据（例如探索性查询确实是范围渗入的主因），不能以一句 spec 或「更安全」为由直接推翻。

---

## 五、未决

以下为 2026-11-11 实测发现、但当天**尚未有结论**的事项。未决不写成已解决；后续结论另起条目并回填本节的指向。

### 5.1 e2e 全量红，全链行为本机未验

- **现状**：`tests/e2e` 全量红这一事实成立；但**根因不止一个**，失败规模随环境变化。本日志写入时**未复跑**全量 e2e，不写「33 个文件同根」这类未复核的数字。
- **可复核的旁证（PR 正文原话）**：PR #51/#52/#53/#54 声明存量红的根因是 `example-gateway` 二进制缺失；PR #55 声明的根因是「网关/平台状态注入面与 config 派生的环境差异」——**不是同一个根因**，不能合并成一句。
- **仓内记录**：`change-safety.md` §27「e2e 实测」与 §29「e2e 红基线冻结」记有具体失败集合（如 C9 期 28 文件 / 106 用例失败、后续 22 文件 / 86 用例）与逐层归因；引用时以那边的命令与输出为准。
- **未验**：全链行为在本机没有验过；在补齐环境（兄弟仓检出 + gitignored 配置 + 二进制）并复跑之前，任何「全链通过」或「单一根因」的说法都不成立。

### 5.2 每配置只跑一次，模型方差未测

- **现状**：当天每个配置只跑了一次探针/对照；模型方差未测。
- **未决**：单次绿不能区分「机制有效」与「这次模型碰巧对」；需要同一配置多次独立运行，至少给出通过率或数值收敛，才能把 A 类去留与 B 类回归分开。
- **影响**：2.6 的 T9 绿、2.5 的开门率、T8 的零泄漏，目前都只有单次证据。

### 5.3 T7/T8：类别已定 A，处置未定——按消融验还是按 B 类长期维护？

- **现状**：T8（执行语言不外泄）在 PR #53 作为「可靠性三件」之一提交；T7（无空回复）在 PR #54 随窗口贴边治理提交（`LLM_CONTEXT_WINDOW`、压缩随窗缩放、thinking-only 催问，见 3.8）。两者均未合入 main。
- **未决（处置）**：类别已定 A（见 0.3、3.8），但当前工程处置把它们放在可靠性批次里。是按 A 类做**消融 / 模型 Eval**（强模型下是否还需要），还是按 B 类长期维护，尚未裁定。
- **不许写成已解决**：本日志只登记「类别已定、处置未定」，不宣布「应该保留」或「应该删除」。

### 5.4 五个平行事实源哪个权威未定

- **现状**：`AuditStore` 12 个 Repo（0.5）中，记录「发生了什么」的有五个——ToolCall / PlatformTask / TaskPlan / TaskRun / AgentRequest；它们目前是平行事实源。
- **未决**：新增 Task / TaskEvent / Evidence 之前必须定「哪个权威、哪些派生、哪些能合并」，但今天没有定。
- **风险**：今天已经因多源映射导致治理代码膨胀过一次；在权威未定前新增第六个源，会把同一问题再付一遍。

### 5.5 拆解归属：模型还是宿主，跨文档说法相反，未裁定

- **冲突原文（doc-1 / doc-3）**：`AGENTS.md` 定位节写「拆解由模型决定，宿主不复制拆解器」，同文件迁移期适配节又写「拆解与续跑仍归 fshine」；`v0-architecture.md` 的「编排层职责（冻结清单）」把「长任务拆解与派单」列为编排层职责，§6 又写编排层「决定怎么拆解」。
- **未决**：至少先区分「谁决定拆解内容」与「谁持有拆解协议 / 任务状态 / 续跑恢复机制」两层，才能裁定归属；本日志不替 doc-1/doc-3 下结论。
- **影响**：四份文档一起合入后，读者无法判断拆解器归谁；本文件 0.1 只沿用「模型负责决定如何完成任务」，不展开拆解器归属。

---

## 六、门语义政策修订：未登记形态 / 命令链 fail-closed（2026-11-12）

- **决定**：`AGENTS.md`「授信期门语义」里「未登记形态放行仅审计」修订为 **fail-closed**——门答不出"这是哪个 operation"的网关调用（未登记/未知形态、裸网关命令、后缀污染）一律进计划门；命令链里夹带网关调用（`cd … && 网关调用`、`;` / `&&` / `||` / 管道之后的网关调用）同样 fail-closed。网关在**首位**的元字符软放行**不变**；修订方向只有收紧、没有放宽。
- **日期**：2026-11-12。**对象**：分支 `arch/gate-unregistered-failclosed`（轨道 B），文件 `packages/agent/src/serve-gate.ts` 等。
- **理由**：旧政策与该门代码注释（「宁拦勿猜」）自相矛盾；且「未登记形态放行」这条有实证绕过——B3 最小复现里 `bin/<gateway> call --file …` 经夹具真的执行了**未声明对象**的查询（控制组 3 绿 / 被测线 2 红），gate 行 `serve_gate:bash ok`、驱动层 T5 对账因 `extractGateScript` 取不到引用而 `not_plan_gated`：放行等于没有任何一步证明它不在执行面内。
- **证据**：`scripts/eval/shell-bypass-gate.test.ts`（B3 复现转绿是本条客观验收信号）；`packages/agent/serve-gate.test.ts` 的 E1 / 「猜的形状」/ 「命令链」三组用例（本次修订逐条改期望，旧行为与新行为都写在测试注释里）；`packages/agent/pi-coding-driver-executor-bypass.test.ts` 的 `call --file` 用例。
- **状态**：在分支 `arch/gate-unregistered-failclosed`（未合入 main；并入集成分支后随集成验证）。
- **回退判据**：若实测证明 fail-closed 误伤真实业务路径（平台新增合法形态而宿主不认识 → 正常查询被拒），先把该形态登记进"认得出的形态"，**不得整体回退为放行**——整体回退等于把已实证的绕过洞重新打开。
- **残余边界（登记，不在本轮范围）**：worker 工具面仍含 `bash` / `write` / `edit`，SaaS 凭据未与脚本环境隔离。「命令文本检查」证明不了脚本内部的越权副作用；真正的隔离要么让 SaaS 操作走受控执行入口、要么让写凭据不暴露给普通脚本环境——属**进程/权限/凭据层**，本轮的字符串形态收口不是它的替代品，**不得声称安全边界已闭环**。
- **同批修：平台清单键名漂移**。17dz 平台自 `f963930` 起把 `operation list --json` 每行的 `serve` 改名为 `modes`；宿主原只读 `serve`，新平台上该矩阵读成空集——门里"读平台矩阵、不另立名单"那一支**静默失效**（不报错、什么都不做，最难发现的一种）。修法：`parseCapabilityManifest` 双键读取（`serve` 优先，两键并存且内容不同属平台异常，不静默合并），用例见 `packages/agent/operation-labels.test.ts` 的「平台清单键名漂移」组。

---

## 维护规则

- 新增删除/保留决定：追加条目，不改旧条目；编号延续（二、三节内）。
- PR 合并后：把对应条目的状态从 `在 PR` 改为 `已合入`，补 merge commit 与日期；**不得**因为「PR 已合」就删除条目。
- 已删机制重新加回：先在本日志新增一条「加回决定」，写清触发的是哪条「加回来的判据」、采用了什么形态；没有这一条，不得直接加代码。
- 未决转已决：保留原未决文字，追加「结论」与日期，避免读者以为它从未未决。
