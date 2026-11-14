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
  举例（含已删对象，状态见对应条目）：识别用户在引用历史（已删，2.5）、注入执行摘要提醒模型（已删，2.6）、强制申报回合类型（已删，2.7）、检查回答是否遵循固定推理流程（仓内未见实现）。
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
| 2.7 ⑦ | route_current_turn 申报层 1+2 | **已实施（arch/direct-tool-final，待开 PR）** |
| 2.8 ⑧ | protocol-material | **已实施（arch/direct-tool-final，待开 PR；只删申报专属支）** |
| 2.9 ⑨ | step-text 的 INTERNAL_TOOLS 抑制 | **已实施（arch/direct-tool-final，待开 PR）** |

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
- **状态**：**已实施（arch/direct-tool-final，待开 PR）**（2026-11-12/13 正式删除批，按实际调用关系逐项核销）。删除对象：`turn-contract.ts` 的 `ROUTE_CURRENT_TURN_TOOL` / `ROUTE_CURRENT_TURN_TOOL_NAME` / `parseTurnDeclaration` / `inspectTurnDeclaration` / `reviewRouteDeclaration` / `isSelfContradictoryDeclaration` / `declarationShapeOf` / `REPEATED_REQUEST_RETRY`；runtime 的强制申报工具面、退回重填与申报专属重试段；`error-codes.ts` 的 `ROUTE_RETRY_NUDGE`；`turn-state.ts` 的 `declared` / `declarationRejections` / `declarationShapes` / `MAX_DECLARATION_REJECTIONS` / `noteDeclarationRejection` / `declarationRejectionsExhausted`；`TurnDeclaration` 类型收窄为 delegate 一枝（宿主内部委派管道，不进模型 schema）。保留的第 3 层：`resend_artifact` 已成直连工具（同回合互斥由 turn 状态守卫，见 §3 回归锁）、`validatePlanEntities` 与来源组装原样保留。
- **事故证据归档（唯一权威，2026-11-12 封存）**：T9 r01 单回合 33 次 `route_declaration_invalid` 后弃权；arch-d C2 单回合 226 次 + 300s 看门狗收掉（0 轮 0 调用）；eval14 确认续跑轮整理模型把申报原文写成正文。三起事故都源于申报层自身（强制申报 + 有界退回的设计），随机制删除失去对象；对应评测面（`scripts/eval/declaration-criteria.ts`、`measure-declaration.mjs`、`declaration-host-events.test.ts`、`cases.yaml` 的 P1 条目与探针判定体）同批退役；退回收敛的实现记账（`MAX_DECLARATION_REJECTIONS = 2`）一并删除。**处置 = 封存**：不迁移实现、不保留无对象的判据；只有满足下面「加回来的判据」才重开。
- **加回来的判据**：**不是把申报表加回来**。若删除后回归红，该加的是**宿主持有指代解析**——宿主从当前消息 + 会话事实解析指代词/实体，把已解析的请求注入委派；resend 保留为独立确定性分支。只有在「宿主无法解析、且必须由模型决定意图」时，才有理由重新要求模型产出结构化意图，且需附消融证据证明去掉申报会红、加上会绿。

### 2.8 ⑧ protocol-material

- **决定**：删除处理「模型把申报 XML/JSON 写成正文」的补丁。
- **日期**：2026-11-11。
- **对象**：`packages/agent/src/protocol-material.ts`（`isWholeReplyRouteDeclaration`、`looksLikeProtocolMaterial`）；消费者 `packages/agent/src/reply-exit.ts:21`、`:127`。
- **理由**：纯模型失败补丁——根因是模型把申报协议当正文输出，补丁只在出口做形状识别与整段替换。
- **证据**：`protocol-material.ts:12-25` 记录 D-144 事故（2026-10-31 确认续跑轮的整理模型把 `<function=route_current_turn>` 申报原文写成正文）；`:49-55` 为纯形状判定。
- **状态**：**已实施（arch/direct-tool-final，待开 PR）**（2026-11-12 正式删除批；按实际调用关系拆分为两支）。删除的申报专属支：`protocol-material.ts` 的 `isWholeReplyRouteDeclaration` 与申报 XML/JSON 正则；`reply-exit.ts` 的 `replaceDeclarationReply`（`route_declaration_reply_replaced` 事件）与 `ReplyExitInput.declarationFallback`；`error-codes.ts` 的 `RESUMED_DECLARATION_FALLBACK`。**保留**：`looksLikeProtocolMaterial` 的 Worker 协议材料防泄漏臂（recorded/step/next、v/op 前缀——消费方 `runtime.ts` / `turn-exit.ts` 的协议复读门仍在服役，属「必须保留」清单）。删除后旧形态（整段申报、中文参数）只剩 `reply-exit` 的通用删除臂，中文参数值可能残留——按下面「加回来的判据」接受，不保留无对象的判据冒充防线。
- **状态补充（消融边界）**：本次删除**不是**对 Worker 协议材料防泄漏的消融——那一支有独立违约测试与真实消费方；删除的只是「整段=申报」的模型失败补丁，其对象（申报工具与提示词）已随 2.7 消失。
- **加回来的判据**：只有当出口再次出现**确定性的整段申报泄漏**；形态必须是窄形状判定（整段 XML/JSON、标签外一无所有），不做内容嗅探；先用提示词/输出格式修根因；回归用例必须是真实泄漏原文，不得用合成样例代替。

### 2.9 ⑨ step-text 的 INTERNAL_TOOLS 抑制

- **决定**：删除「内部工具不上进度帧」的抑制表及其分支。
- **日期**：2026-11-11。
- **对象**：`packages/agent/src/step-text.ts` 的 `INTERNAL_TOOLS` 集合（main 上含 `ROUTE_CURRENT_TURN_TOOL_NAME`、`search_history`、`get_messages`）。
- **理由**：内部工具删了就没对象。
- **证据**：`step-text.ts` 的 `INTERNAL_TOOLS` 定义；PR #54 的 `step-text.ts` diff 把名单收窄为只剩 `ROUTE_CURRENT_TURN_TOOL_NAME`，并删掉 `search_history` / `get_messages` 两个名字（`gh pr diff 54` 的 `step-text.ts` 段可复核）。
- **状态**：**已实施（arch/direct-tool-final，待开 PR）**（2026-11-12 正式删除批）。`step-text.ts` 的 `INTERNAL_TOOLS` 集合、`defaultStepText` / `renderToolStepText` 里的成员检查、对 `ROUTE_CURRENT_TURN_TOOL_NAME` 的 import、`PROGRESS_LEAK_MARKERS` 的 `route_current_turn` 词条整体删除；`renderToolStepText` 不再有 `null` 分支（工具面只剩用户可见动作类工具，恒出帧）。**保留**：通用进度卫生（短语长度上限、协议特征丢弃、服务器路径丢弃）与 `pi-driver.ts` 的 onStep 接线。`platform-leak-lint` 白名单里的三个内部工具名（`search_history` / `get_messages` / `route_current_turn`）同批移除（白名单只减不增）。
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

- **决定**：保留 B 目的——「重复的同一句话是新授权、不是缓存命中；历史答复不得冒充本轮实时结果」。实现已换代（2026-11-12 收窄）：申报层删除后，原转录分析（`findRepeatedDelegatedRequest` / `collectDelegatedRequestCounts` 等，读者只有申报退回）随申报层退役；同一目的由 **RR1 窄门**承接。
- **日期**：2026-11-11（机制源自 2026-10-19 真机实测）；2026-11-12 收窄并换实现（用户裁定 1）。
- **对象**：`packages/agent/src/repeat-request.ts`（现只留 `buildRequestKey` / `normalizeUserRequest` / `ATTACHMENT_PATHS_MARKER`）；运行时读取 `runtime.ts` 的 `exactRepeatIdentity`（平台任务底账按 `requestKey` 精确匹配）；替换决策 `turn-exit.ts` 的 ①b；身份快照 `PlatformTaskRecord.requestKey`（委派点单写入者）。
- **理由**：用户把同一句话连发三次，模型明确认出是重复请求，仍选对话枝，拿历史结论重新排版输出——零执行、零产物，用户拿到的是服务器路径而不是文件。宿主必须把「这条消息与此前已执行过的请求**完全相同**」这个确定性事实用于出口保护。
- **收窄口径（2026-11-12，用户裁定 1）**：旧宽判据「会话存在在册任务 + 本轮零委派 + 回复含数字结论」**删除**（它会把「刚才那个数是多少来着」这类改写问句也替换掉——不是同一请求）；新窄判据三条同时成立才替换：① 本轮请求与此前某次**已执行过的请求完全同身份**（requestKey 逐字相等；身份 = 归一化正文 + 引用指纹的稳定哈希，委派时快照进任务底账）；② 本轮零委派零执行；③ 回复带数字结论。同文但本轮真执行必然放行；改写问句放行（不新增业务语义分类器）。辅助存储（`platformTasks.listBySession`）读取失败或未注入 → 记 `rr1_identity_inconclusive` 事件，**既不当作已验证通过、也不据此阻断普通聊天**。`messageId` 去重（handler 的 `findByWecomMessageId`）与 `dispatchKey` 幂等（§3.6）是既有机制，不因本门改变。
- **证据**：`repeat-request.ts` 文件头（身份键定义与用途）；`runtime.ts` 的 `exactRepeatIdentity`（三态 match/none/inconclusive + 事件）；`turn-exit.ts` ①b（`repeatIdentity === 'match'` 才替换，detail 只陈述身份判据）；任务底账列 `platform_tasks.request_key`（`packages/core/src/store.ts` 的迁移与映射，store.test.ts 往返锁）。回归锁：`packages/agent/repeat-execution.test.ts`（同身份拦下 / 改写与不同引用放行 / 存储失败 inconclusive / 真执行放行）、`turn-exit.test.ts` ①b、e2e `turn-loop-repeat-execution.test.ts`（装配级 requestKey 往返）。
- **状态**：**已实施（arch/direct-tool-final，待开 PR）**。
- **性质备注（B 目的，确定性实现）**：目的是 B 类——「历史答复不是当前授权」是确定性责任；收窄后的实现也不再依赖模型申报（读宿主任务底账的精确身份），原「A 实现」备注随之退役。目的按 B 类写违约路径测试：同身份 + 零执行 + 数字结论必须被替换；真执行与不同身份必须放行；读不到必须留痕且不阻断。
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
- **同批修：平台清单键名漂移**。当前接入的执行层自 `f963930` 起把 `operation list --json` 每行的 `serve` 改名为 `modes`；宿主原只读 `serve`，新平台上该矩阵读成空集——门里"读平台矩阵、不另立名单"那一支**静默失效**（不报错、什么都不做，最难发现的一种）。修法：`parseCapabilityManifest` 双键读取（`serve` 优先，两键并存且内容不同属平台异常，不静默合并），用例见 `packages/agent/operation-labels.test.ts` 的「平台清单键名漂移」组。

---

## 七、发布阻断登记：#1 执行入口安全的未闭环形态（2026-11-12）

- **事实（独立复核实证，T2 轨）**：以下形态**整类绕过**形态分类、计划前置与驱动层 T5 范围对账——
  `bash -c '…' / sh -c`、`sudo <gw> …`、`xargs <gw> …`、`FOO=1 <gw> …` / `env FOO=1 <gw> …`，
  以及命令替换 `$(<gw> …)`、反引号、`command <gw> …`。证据：`createServeGate` 实跑对四形态 `ALLOW`；
  `planDeclarationCovers` 对它们全部返回 `not_plan_gated`；夹具实跑 `bash -c '…query --collection beta…'`
  真的执行了未声明对象的查询（audit 落行 `planId=plan_b3`）。门侧首词规则（`serve-gate.ts:283-287`）
  与命令链判据只认"命令位 token"，解释器包装与 env 前缀不在其中。
- **状态：发布阻断（Owner 裁决 2026-11-12）**。在获得有效阻断或执行环境隔离之前，
  **受影响的 worker 执行配置不得标记为安全可发布**。「审计行在册」不等于「已阻断」。
- **本轮已做（机制内）**：未登记/裸/污染网关形态与命令链 fail-closed（见第六节）——它们收的是
  同一族的**非包装**形态；包装族本次**未修**。
- **下一步（不扩 shell 正则）**：① 先补确定性违约测试，枚举可绕过形态与权限暴露面；
  ② 研究最小 fail-closed 阻断（方向：网关令牌出现在不可识别的执行位置即拒，宁误拒不放行；
  误拒代价由回归锁看住）；③ 长期走受控执行入口 + 凭据/权限隔离，而不是继续堆字符串模式。
- **凭据可达性（独立审查项，2026-11-13 状态更新：worker env 侧已收口，文件可达性仍开放）**：收口前
  `createPlanScopedWorkerEnv`（`plan-runtime.ts`）只删 `EXECUTION_PLAN_ACTIVATION_SECRET` / `EXECUTION_PLAN_ID`，
  **其余 env 原样继承**——sentinel 红先证实跑证明 `WECOM_BOT_SECRET`、`LLM_API_KEY` 仍在 worker bash 的 env 里
  （基线上断言失败输出直接含 `LLM_API_KEY=sentinel-…` / `WECOM_BOT_SECRET=sentinel-…`；收口后用例同文件转绿）。
  现已按**三个面、逐键决策**收口（禁整体前缀放行）：
  (i) Worker 模型调用凭据由可信驱动内部持有（驱动 options.env → ModelRuntime provider），不进任何子进程 env；
  (ii) worker shell/工具可见 env = **精确键白名单**（PATH / HOME / TMPDIR / 仓内夹具状态根桥键；逐键消费方依据与
  「缺了会坏」真子进程对照见 `packages/agent/src/child-env.ts` 与 `packages/agent/child-env-closure.test.ts`；
  `NODE_*` / 其余 `FSHINE_*` / 其余 `EXECUTION_*` / `LC_*` 逐键核对后除逐次注入的 `EXECUTION_REQUIRE_PLAN` /
  `EXECUTION_PLAN_ID` 外一律不进）；宿主直调网关 env 剥宿主敏感族（`LLM_*` / `WECOM_*`）与宿主内部指针
  （`AGENT_CONFIG_PATH` / `DB_PATH`），其余键继承；`EXECUTION_PLAN_ACTIVATION_SECRET` / `EXECUTION_PLAN_ID` 的
  既有剥离语义不变（测试钉住）。
  **仍未闭环（文件/权限层）**：worker shell 与宿主同 OS 用户，`.env` 可读——探针以收口后的 worker env 真 spawn
  `sh`：相对仓根 `wc -c < .env` 成功（1594 字节）、绝对路径同样成功；`config/agent.yaml` 在部署存在时按同一权限
  可读（本 worktree 只有 example）。env 白名单不解决这一层；最小修复方向是权限/隔离（独立用户、mount 命名空间，
  或把秘密移出 worker 可达路径），不在 shell 字符串层继续加特例。长期走受控执行入口与凭据/权限隔离。
- **V0 定位声明（2026-11-13）**：以上完成后 V0 仍只是**受控本地试用版本**（仓内 dummy 夹具、真实子进程调用、
  不触真实平台与真实 SaaS）。在下列三道边界闭环前，**不得宣称 V0 可安全连接真实生产 SaaS**：
  ① 词法不可分类形态仍可绕过 serve 门（见 (a)）；② 宿主凭据文件对 worker 可达（见上）；③ worker 与宿主的
  权限边界未隔离（见下 (c)）。
- **登记精度修正（复核员建议，已采纳）**：第六节的「残余边界」按**整类**表述（首词包装/命令替换/
  前缀），不再按四例枚举；`pi-coding-driver-executor-bypass.test.ts:316` 实为「清单未声明的 mode」
  用例（同一 `invocation===null` 分支），`call --file` 的实覆盖在 `serve-gate.test.ts:830-831` 与
  `scripts/eval/shell-bypass-gate.test.ts:144-145`；`shell-bypass-gate.test.ts:141` 是注释、断言在 `:144-145`。
- **2026-11-12 状态更新（GATE 轨并入后）**：上面「包装族本次未修」一句由本更新取代。**九个实证包装形态已由放行改为拒**——
  `bash -c` / `sh -c` / `sudo` / `xargs` / `FOO=1` / `env FOO=1` / `$(…)` / 反引号 / `command`，新码 `SERVE_BASH_GATEWAY_WRAPPED`
  （保守包含式判据：网关令牌在词首词尾边界且整条命令不属任何已识别干净形态 → 拒；未写通用 shell 解析器，新增 2 条字符类正则 + 1 个分支）。
  红先证见 `packages/agent/serve-gate-containment.test.ts`（3 红 → 8 绿）；夹具实跑证明 `bash -c '…query --collection beta…'` 与
  `bin/<gw> call --file` 均被拒且各留 `allowed=false` 审计行。
  **发布阻断收窄但未解除**，残余两类：
  (a) **词法不可分类**：`bash -c 'true;<gw> …'`（分隔符与网关之间无空格——与批准放行的字面量 `echo "x;<gw>"` 在字符层同形）
  与 `B=<gw>; $B query`（变量间接）；封死需要识别解释器/包装语义或进程隔离，不在字符串层继续加特例。
  (b) **凭据可达性**：2026-11-12 时未处理（worker bash 子进程 env 仍继承 `WECOM_BOT_SECRET` / `LLM_API_KEY`，
  且门放行 bash 的 `cat .env`）。**2026-11-13 状态更新：worker env 侧已收口**（三面逐键，见上方
  「凭据可达性」条目）；文件/权限层（`.env` / `config` 对 worker 可达）仍未闭环，登记在该条目与 V0 定位
  声明里。
  (c) 附注：`./bin/<gw> …` 被识别为网关调用（非绕过）；`cat <gw>` / `ls -la <gw>` / env 前缀三条既有「应放行」用例已被有意收紧为拒，
  测试内逐条注明（旧：放行；现：拒）。

---

## 八、Main 交互规则：常驻 vs 按需 Skills 的实验结论与架构裁决（2026-11-12）

**实验设置**（模型 `step-3.7-flash` 固定；Worker mock；夹具确定性域 `documents`：W202610/W202611，
`document-2` 同名不同值 800/900 为可机械检查的异常；每次运行前重置夹具状态）：

| 臂 | 角色指令 | Skills |
|---|---|---|
| b0 | agent.md（实验前版本） | off |
| b1 | agent.md + 技能元数据曝光 + `read_skill` | on |
| b2 | **仅评测**：agent.md + task-collaboration 正文经 `roleInstructionsOverride` 注入 | off（无工具） |
| b3 | agent.md + 5 条常驻交互原则 | off |

场景 UX-01/04/06；UX-01/04 各 **2 个样本**（第二个样本只用于消解矛盾，未扩样到完整 20 run）。

**数据**（逐场景，不是平均）：

- **`read_skill` 有效机会 = b1 的 39 轮**（b0/b2/b3 未开放该工具，不计入分母）；**命中 0/39**。
  两次触发实验（"可先读" → "先按名称读取（task-collaboration / result-assistance）"）均未产生一次读取。
- **UX-01（核对本月单据，应直接办理）**：b0 **2/2** 完成并报出同名异常；b2 **2/2**；**b3 0/2**（两次都改为追问）。
- **UX-04（"第二条好像不对"，应定位重核）**：**b2 2/2** 定位 doc-002 并报异常；b0 0/2；b3 0/2。
- **UX-06（"先别弄了"，按真实状态判分）**：b0/b2/b3 的 T1 均未启动任务（追问），T2 说"已停止"与事实不冲突；
  b1 的 T1 已完成核对、T2 同时说"已停止"与"任务已完成"（事实层面成立，话术混杂）；
  **b3 出现"已按规则申报本轮为普通对话（conversation）"——内部协议术语上屏**（与 b1 的"已合规完成本轮申报（类型：conversation）"同族，归 Wave 2b #5）。
- **Token**：按模型调用次数/输入/输出/缓存/重试/工具事件分开记录。观测到 b1 单轮多一次
  `repeat_request_declaration_bounced` 往返、cacheRead 约 10 倍于 b0；第二轮全量 b1 `in 37,952 / out 13,459 /
  cache 161,792` vs b0 `in 13,859 / out 9,052 / cache 82,368`（同为 17 轮、无循环上限命中）。
  **缺少每次模型调用的完整证据，不把全部差异归因于单一申报退回事件。**

**结论**：
1. **提示词触发无效**：不强制、不再靠提示词引导模型读通用 Skill（继续加强等同于事实强制）。
2. **内容有潜在价值但投递机制未成立**：b2 在 UX-04 上 2/2、UX-01 上 2/2（仅"观察到的潜在价值"，样本不足以称稳定证明）。
3. **常驻加 5 条原则未获支持**：b3 在 UX-01 反而 0/2，agent.md 加长有副作用（可能是"先澄清"被强化）。

**架构裁决**：
1. `agent.md` 是**唯一常驻角色事实源，保持最小**：不含交互原则清单、不含 Skills 触发要求；
   写权限措辞按现行政策（Main 不执行写、不承诺改得成、是否执行由执行层按政策决定）。
2. 两份通用 Skill **归档为参考材料**（文件保留、加档案注记），**不作为生产能力维护**，不设命中率 KPI。
3. **保留** skill 加载机制（catalog + `read_skill`），供未来真正需要按需知识的场景；当前不依赖它。
4. **Worker 的 Platform Skills 不受影响**。
5. 后续交互改进改由 Skill+Eval 的按需知识路线或场景 Eval 驱动；**停止此方向的提示词调参**。

**未决**：b2 的正向结果需要更大样本才能作为"内容有效"的稳定证据（本轮不作为结论）；
UX-06 的内部术语泄漏进 Wave 2b #5 定位与语料。

---

## 九、V0 交付记录（2026-11-13）

- **分支/提交**：`arch/integration` @ 3cfbc06（tag `v0-trial-20261113`）。构成：直连工具面（delegate → gaps → e2e 三支）＋ 申报层正式删除（c7ea077）＋ V0 演示链（87fd1a7）＋ 安全收口（aff57fd）＋ 第 4 子进程面收口与 D-209 桥键修复（f9b8ca7 / 3cfbc06）。
- **验收**（V0 集成验收 run 两轮，第二轮在修复后 HEAD）：
  - 确定性门：tsc 0；unit 2845 过 / 2 红（`scripts/eval/execution-leak-criteria.test.ts`，两轮同数同例，基线复现）；全量 e2e 179 = 80 过 / 97 红 / 2 跳——97 红与基线 d75de7a 逐条零新增（2 条翻绿），其中 96 条为环境约束（需兄弟仓财政域 mock / gitignored `config/agent.yaml`）、1 条既有陈旧；probe 81/81（D-209 闭集与失效化突变用例在修复后仍有区分力）；L1–L4 4/4、R1–R3 3/3、resend 9/9、child-env-closure 7/7、serve-gate-containment 8/8、generic-mock 26/26。
  - 干净克隆：clone → `npm install`（直连 exit 0，14–16s）→ typecheck 0 → `npm run demo` 真实模型端到端留痕（dummy 审计逐行落盘）。
  - **demo 样本方差（据实记录）**：跨夜全部 16 次 trial 中 6 次全程达标；终轮 3 次 trial 0/3——三 trial 均卡在 t1「核对本月单据」未委派（模型改为先追问口径），t2/t3 均委派且审计行非零（5/7/5 行），无查错对象、无误报成功。属模型行为方差，非接线缺陷；全部样本保留在 `.runtime/demo/trials/`。
  - 一处产物勘误（独立复核登记，保守方向）：对账文档第 9 条（trial-3 t2 归因句）误称「委派请求原文未落盘」；实际 `demo.db platform_tasks.worker_messages` 存有原文，应转「支持」，口径 ≥51 支持 / ≤11 不能证实。
- **残余边界（不假闭合）**：真实 SaaS 与企微渠道未验证；worker 对 `.env` / config 的文件可达性未闭环（进程 / 文件系统层，见七节 (b)）；发布阻断 #1 词法残余两类；demo 展示层标签误标（`query ballots`，根因 `operation-labels.ts:618-623` × `:63-76`）；`platform_tasks.calls` 计数与 audit 口径不齐（演示读数已统一按 audit）。
- **定位**：本版本是**受控本地试用版**（执行层为仓内 dummy 夹具）；不得宣称可安全连接真实生产 SaaS。

---

## 十、M2 波次 1 退役登记与继任（2026-11-13）

**背景**：`arch/m2-merged` @ 592267f（波次 1 干净并集）删除旧 e2e 套件（8a216f9）与旧域评测/验收脚手架（4a38198）。复核对两处红要求明确后继；本行修复轮（分支 `arch/m2-fix`）登记如下，结论以本节点为准。

- **旧 e2e + 旧脚手架退役**：`tests/e2e/` 全量（42 文件）与旧评分/判据/用例、旧探针与验收脚本、`scripts/perf/**` 删除；用户级行为由 Minimal demo（`npm run demo:minimal`）与 **M3 用户级评测**承担。此条为已登记退役，后继明确。
- **execution-leak-criteria 的 2 红 = 已登记退役**：原红见九节（`scripts/eval/execution-leak-criteria.test.ts` 两轮同数同例）。该文件随旧路径退役，红随对象消失；**后继 = M3 用户级评测**。不算修复、不算掩盖——判据不丢，交接有主。
- **probe D-209 的 2 红 = base 未登记红，以「继任闭集守卫 + 字面量清理」解决**：波次 1 之前，`scripts/probe-real-agent.test.ts` 的 D-209 闭集守卫 2 红（闭集断言 + 失效化突变断言同一根因）：M1 引入的字面量引用（`packages/agent/minimal-worker-env.test.ts`、`packages/agent/src/minimal/worker-env.ts` 注释）不在旧 allowlist 内。波次 1 删除该探针文件后 unit 归零，形似掩盖。本次把守卫换成**继任测试** `packages/agent/bridge-key-closure.test.ts`（只守桥键闭集，不依赖已删探针/harness；allowlist 逐项理由；表外命中与陈旧登记双向红；含变异用例），并把 M1 字面量清到导出常量（测试改引 `WORKER_FIXTURE_STATE_DIR_KEY`；注释用「测试桥键」表述）。**红被取代，不是被删除**。**状态更新（2026-11-13 R1 清理）**：该继任守卫（`packages/agent/bridge-key-closure.test.ts`）及其常量来源 `packages/agent/src/child-env.ts` 已随 Reset（`66e7d23`）删除，无继任闭集守卫；现覆盖 = `worker-env.test.ts` 白名单闭集断言 + 夹具 shell 入口读桥（部分覆盖），闭集扫描缺口登记于 §十五。
- **结论**：桥键现行字面量闭集 = `child-env.ts` 键名定义 + dummy/stock 两个 shell 入口 + leak-lint 登记 + 继任守卫自身；生产面只剩键名定义一处。守卫区分力已验：守卫内两条变异用例 + 本轮实注入（生产文件加一行引用 → 守卫红 → 回滚后复绿）。旧探针/验收不恢复。

---

## 十一、产品面收口：demo 退役与去过渡化（2026-11-13）

**决定**：分支 `arch/minimal-reset` 上删除 demo/试跑脚手架、把仓库命名收敛到产品面、新增过渡命名收敛守卫防回潮。产品面收敛为两条运行路径：`npm run ask`（一条消息 → 回复 + 机械证据）与 `npm start`（渠道消息 → 回复）。

- **对象**：`scripts/demo-minimal.ts` 与 `npm run demo:minimal`；`config/agent.demo.yaml`；`packages/agent/src/minimal/**`；`scripts/ask-minimal.ts`；`apps/server/minimal-server.*`；`packages/core/src/minimal-task-store.ts`；`minimal` 前缀的标识符 / 日志事件名 / SQLite 表名 / 缺省证据与状态路径。
- **理由**：demo 是试跑脚手架不是产品面；过渡命名（minimal 目录/前缀/表名）让收口后的产品面读起来仍像临时切片，且此前没有守卫防回潮。
- **证据**（本分支实跑）：
  - 守卫 TDD（先红后绿）：`packages/agent/transition-naming.test.ts` 在旧命名上红——路径命中 16、标识符命中 114，`Test Files 1 failed / Tests 2 failed`；改名后绿——路径扫描 109 文件命中 0，标识符扫描 77 文件命中 1（唯一窄豁免：`packages/agent/src/pi-driver.ts` 的 Pi 思考档位外部取值 `minimal`，豁免逐条闭合，含陈旧豁免绊线）。
  - `npx tsc --noEmit` exit 0；`npx vitest run --project unit` 26 文件 / 213 用例全绿；`npm run eval:generic-mock` 26 cases pass, 0 skipped。
  - `npm run ask -- "帮我查一下 documents 集合、窗口 W202611 的数据…"`（真实模型 + 仓内 dummy）：exit 0，委派＝是、结构化执行 1 次（完成 1）、dummy 审计 1 行、用时 15.3s；机械证据落 `.runtime/state.db`、`.runtime/ask/state/audit.jsonl`。
  - 假渠道 server 回归（`apps/server/server.test.ts`）与重启连续性（`packages/agent/task-registry-sqlite.test.ts`、`packages/agent/runtime.test.ts`）在 unit 内实跑：3 文件 / 11 用例全绿。
  - 生产路径 `grep -rin minimal packages/*/src scripts apps package.json`：除 `pi-driver.ts` 的 Pi 词表 4 行（外部协议取值，非过渡命名，守卫内窄豁免并注明理由）外归零。
- **状态**：已实施（本分支，待开 PR）。
- **后继**：用户级行为面由 `ask` / `start` + 确定性评测（`eval:generic-mock`）与后续用户级评测承担；demo 与旧 e2e 的用户级覆盖面并入该评测口径登记。
- **加回来的判据**：demo 仅在用户级评测确需一条「多轮冻结语料」入口、且 `ask` / `start` 不足以复现该判据时才可恢复；恢复时须写明它服务哪条评测判据。
- **状态更新（2026-11-13）**：已合入 `arch/integration` @ `66e7d23`（未合 main）。

---

## 十二、Minimal MVP 交付记录（2026-11-13）

**交付面**：`arch/integration` @ `66e7d23`（合并 `7d5a426` 集成侧 + 收尾 `0db16dc`；未动 main、未覆盖 tag `v0-trial-20261113`）。

- **运行**：`npm run ask`（一条消息 → 回复 + 机械证据；缺省仓内 dummy 执行层）、`npm start`（渠道消息 → 回复）。写/确认/取消/产物为后续切片。
- **测试/评测**：`npm test`（26 文件 / 213 用例）；`npm run eval:generic-mock`（26 cases, 0 skipped）；过渡命名收敛守卫 `packages/agent/transition-naming.test.ts`（注入必红、陈旧豁免双向闭合）。
- **持久化**：`packages/core` SQLite 两表（`tasks` + `executions`），重启连续性测试在册；无计划字段、无多套状态机。
- **规模**：生产代码 7,380 行、测试 5,108 行；自 tag `v0-trial-20261113` 以来 360 文件变更、+3,172 / −109,043（净 ≈ −105,871；删除 310 / 新增 16 / 改名 1）。

**四个边界**

- **Pi**：理解、规划、工具选择、多轮交互、上下文与压缩全部 Pi 原生；不建记忆/检索/语义投影/分类器/编排框架。
- **A2A**：未引入（无官方 SDK、Agent Card、网络服务、额外状态系统）；内部对接协议 = Execution Contract，不得冒充标准 A2A。
- **Execution Contract**（`packages/contracts/src/execution-contract.ts`）：只传能力发现、结构化执行请求、状态与失败结果、必要的取消/产物信息；不承载规划策略与执行层治理策略。
- **Executor**：执行环境、实际工具、业务授权、数据校验、副作用控制、幂等与执行审计；宿主不重复执法。

**三个清单**

- **转交执行层**：实体授权与对象范围、操作授权/绑定/有效期/防重放、业务校验、幂等与副作用控制、执行审计、能力真实面、限流与响应控制。
- **宿主保留（B 类最小实现）**：可信身份与渠道映射、确认事件传递与用户交互、任务归属（taskId/principal/session + 重启连续性）、凭据隔离（worker env 白名单 `PATH/HOME/TMPDIR`）、如实交付（结果/失败按契约转述，`error.message` 不许自解析）。
- **未证明边界**：真实企微/SaaS（未触，登记未验证）；写/确认/取消/产物与后台投递（后续切片）；网络传输（本轮只到 CLI 适配器，无网络实现）；多实例/并发无承诺；Minimal 臂 worker 侧 token 未采集；worker 对 `.env`/config 的文件可达性（§七 (b) 既有登记）。

**M3 同语料对照（删除有效性的行为证据；同语料 × 同模型 × 同 dummy，3 轮 × 3 次）**

- V0 臂（tag 装配）：该轮成功委派 4/9、用户级完成 5/9（4 轮被宿主拒错话术打断）、无谓追问 4 轮、总耗时 319.2s（每轮独立进程）。
- Minimal 臂（`7d5a426`）：委派 6/9、用户级完成 9/9、无谓追问 0、总耗时 142.2s（进程内）。
- 两臂错对象 0、虚假成功 0；独立复核 `v="ok"`（无筛样本 / 美化 / 造假）。
- 配对表与逐项证据：`.runtime/m3s-same/paired-report.md`（复核 run `dwfrun-3e9f7752` / 校验 `dwfrun-81565014`；产物卡片「M3 同语料对照报告」）。口径登记：两臂配置档/授权面不同、token 口径不同（Minimal worker 侧未采集）、运行期曾并发重叠——跨臂数字按登记口径解读，不外推。

**取回点与加回来的判据**

- 旧 hub / 旧接线 / 旧 e2e / 旧脚手架的完整代码在 `git log`：M2 波次 1（`592267f` 等）、Reset（`0b97227` 删 191 文件、`cd368c0` 重建）；tag `v0-trial-20261113` 是 V0 全量参照。
- 恢复任何机制须先按维护规则写「加回决定」，注明触发哪条「加回来的判据」。

---

## 十三、M4 死代码清扫、完成状态修复与契约收口（2026-11-13）

**本分支**：`arch/m4-sweep`（基线 `arch/integration` @ `29c13e9`；独立 worktree；未 push、未合并）。**本节是删除/退役、完成判定语义与评测口径的现行口径**；与 §九–§十二 冲突处（如「评测＝`eval:generic-mock`」）以本节为准，旧条目按维护规则保留不改。提交清单：`659cfe3`（完成状态修复）→ `acc1704`（契约收口）→ `4295832`（死代码清扫）→ `32cdbb3`（CI 退役）→ 本节所在 docs 提交。

### 13.1 完成状态修复（缺陷修复；TDD：红→最小修→绿→反向绊线）

- **缺陷**：Worker 以非空汇报结束即记 `completed`——执行层 `failed` / `refused` / 零执行（模型未调用或宿主发起前拒收）三类事实全部被覆盖成「成功」；顶层 status 分不出「实际成功 / 拒绝或失败 / 未发起执行」。
- **修复落点（全部在既有文件，无新表/无第二账本/无状态机/无计划门；SQLite `status` 列本就是无 CHECK 的 TEXT，零迁移）**：
  - `packages/agent/src/task-registry.ts`：`TaskStatus` 增加 `unexecuted`；新增纯函数 `judgeReportedTask(executions)`（内存与 SQLite 两实现共用，逐项一致）；`complete()` 恒存 Worker 汇报原文，status/failureReason 按判定写。
  - `packages/agent/src/task-registry-sqlite.ts`：`complete()` 读回 executions 后用同一判定写入。
  - `packages/core/src/task-store.ts:27`：status 注释补 `unexecuted`（仅注释）。
  - `execution-runtime.ts` 写点不动：:249 仍调 `complete`（判定归底账）；:253 `fail()` 保留 worker 层失败（抛错/空汇报）语义。
- **语义表（Worker 正常结束且文本非空）**：

| execution 组合 | status | resultText | failureReason |
|---|---|---|---|
| ≥1 且全 completed | `completed` | Worker 汇报原文 | 无 |
| ≥1 含 failed / refused | `failed` | Worker 汇报原文 | `执行层未成功：<op> 返回 <status>：<error.message 原样>` |
| ≥1 含 needs_input | `failed`（明细在 `executions[].status`） | Worker 汇报原文 | 无 error.message 时以 `执行层未成功：<op> 返回 needs_input。` 收尾 |
| 0 条（模型未调用 / 宿主发起前拒收） | `unexecuted` | Worker 汇报原文 | `未发起执行：Worker 已汇报，但本次委派没有向执行层发起任何调用。` |
| worker 抛错 / 空汇报（走 `fail()`） | `failed` | 无 | worker 错误原文 |
| 纯聊天（Main 未委派） | 不产生任务记录 | — | — |

- **先红后绿**：并入 `packages/agent/runtime.test.ts`（9 例，含升级既有 213-230 用例补 status 断言）与 `task-registry-sqlite.test.ts`（3 例）；修复前 `11 failed | 10 passed`，修复后 `21 passed`（两文件），全量 225 通过。②③b 等 8 条按「修复后语义」先红，⑥ 成功孪生与 ④ 纯聊天基线绿、修复后保持绿。
- **反向绊线（变异核验，逐条实做）**：恢复「无条件 completed」→ 11 红（runtime 8 + SQLite 3）；判定写死 `completed` → ⑤⑤b 等 11 红；判定写死 `failed` → ⑥ 孪生红；改成从汇报文本嗅探「成功|完成」→ ⑤⑤b⑧ 红。变异后源码已还原，tsc 0 / 用例全绿。
- **影响面**：生产入口零改动（`scripts/ask.ts:164-171` 只读 executions，达标门用 facts.length；`apps/server/server.ts:142-149` 只记录 executions）；现有三处 completed 断言场景均为「全 completed」，判定不变。

### 13.2 退役与删除登记（逐条：行数 / 依据 / 后继 / 加回判据）

整删跟踪文件 19 个共 3,386 行；其余为部分删减（约 190 行）。全部条目均查过实际引用与运行入口（非文件名判断）。

1. **旧 a2a 协议**：`packages/contracts/src/a2a-protocol.ts`（170 行）+ `packages/contracts/src/index.ts` 导出行。依据：全仓消费者 0（唯一命中是 barrel 自身）；旧协议不得经公共导出暴露。后继：现行契约语义面 `packages/contracts/src/execution-contract.ts`；文档加失效注记（AGENTS 指针、docs/index、methodology、a2a-protocol.md 文首）。加回判据：出现真实跨进程/跨框架互操作需求且 Pi 委派能力不足时，按新增机制准入（①–⑤）另案引入；不得以「未来可能」为据经 barrel 恢复旧类型面。
2. **Phase 2 宿主模块 5 文件**（472 行）：`proposal-review.ts`(134) / `task-handover.ts`(176) / `committed-unverified.ts`(54) / `tool-definition-guard.ts`(38) / `worker-step-cap.ts`(70)。依据：零生产消费者（唯一值消费者是已退役 generic-mock）；`import-boundary.test.ts` 的 FORBIDDEN 墓碑清单保留这批路径防回潮。后继：「提案已提交但回读缺失绝不报完成」的最小面由 13.1 的 `unexecuted`/`failed` 终态承接；其余三项属写/提交-回读/长任务切片未落地机制，删除而非迁移。加回判据：对应切片落地时按新设计（最小可复现失败 + 失败注入测试）重引入，不整文件恢复。
3. **generic-mock 评测簇**（1,172 行）：`generic-mock.ts`(630) / `GENERIC_MOCK_NOTES.md`(308) / `generic-mock-baseline.json`(203) / `fixture-aux-state.ts`(31)；连带 `package.json` 的 `eval:generic-mock` 入口与 `ci.sh` 该门。依据：Phase 2 五用例（`g-step-cap-50-51` / `g-handover-file` / `g-tool-definition-removed` / `g-tampered-summary-review` / `g-committed-unverified-report`）测的是已删模块；Phase 1 用例测的是生产不可达的夹具写/计划协议（plan 门、proposal、readback、token、serve 矩阵、ballot 第二域）。后继（等价承接）：`dummy-client.test.ts`（契约传输四行为 + env 白名单对照 + stub 失败映射）、`runtime.test.ts`（允许集合拒绝/归属/完成判定）、`task-registry-sqlite.test.ts`（重启连续性）、`apps/server/server.test.ts`（假渠道）。**被删红登记**：夹具写/计划的既有覆盖（plan 门预算分档、提案 pending→commit→读回→双提交拒绝、readback 短、token 门、状态隔离、ballot 第二域等 21 例 + 上述 5 例）**无逐条等价承接**，随对象退役（对象＝夹具模拟行为，非产品链）；产品链对应面（结构化执行/拒绝/失败/零执行/纯聊天）由上述后继覆盖。加回判据：恢复确定性夹具评测须先有可运行、被测试钉住的 harness 与 owner 裁定；恢复时按新 harness 设计，禁止指向已删脚本。
4. **死夹具与死配置**（913 行）：stock-platform 5 文件 856 行（`bin/stock` 13 / `bin/stock.cjs` 734 / `README.md` 38 / `scripts/lint-operations.js` 39 / `skills-serve/stock-routing-examples/SKILL.md` 32；当前树零代码消费者——`resolve-config-path.test.ts` 当时只用字面量 `stock-platform` 构造临时 YAML，不读目录；该字面量已随 2026-11-13 复核修复轮去对象化）、`scripts/eval/eval.agent.yaml`(57；仅死 fallback 消费)。后继：`config/agent.fixture.yaml`（ask 缺省）+ `explicitConfigFrom`/`materializeEvalConfig`。加回判据：接入第二执行层证明面时按新夹具设计引入，并同步 env 文档与守卫。
5. **resolve-config-path 死入口**：删 `EVAL_CONFIG`、`resolveConfigPathInternal`、`resolveConfigPath`（连带变为无消费者的 `ROOT_CONFIG`，约 48 行）；`resolve-config-path.test.ts` 删两组（`resolveConfigPath` / `resolveConfigPath 仓库默认入口`，约 110 行 / 8 用例）。依据：0 生产调用，唯一调用者是自身测试。后继：`explicitConfigFrom` 与 `materializeEvalConfig`（`scripts/ask.ts:92-93`、`apps/server/main.ts:22` 实调）。加回判据：某入口出现「仓根 `config/agent.yaml` 存在才用 > eval 回退」的真实需求（写清消费点）时以最小实现重加。
6. **vitest.setup 死键**：删 `FSHINE_WORKER_STEP_CAP` 与 stock aux 六键（`EXECUTION_*`/`STOCK_*` × MEMORY/BREAKER/CACHE）。依据：读者（worker-step-cap 机制 / `stock.cjs` / `fixture-aux-state.ts`）全部退役，无读者后泄漏值不能改变任何基线。注：审计清单列 step cap + `STOCK_*` 三键，实施同时删三枚 `EXECUTION_*` 规范名（同一读者族、零读取）；如 owner 认为需保留规范名占位，可一行恢复。加回判据：对应机制重新落地并重新出现 env 读取点时同步恢复密封键。
7. **三个失效 eval workflow**（659 行）：`eval-real.yml`(148) / `eval-nightly.yml`(280) / `eval-measure.yml`(231)。判定（四条件实测于 `29c13e9`）：① `.github/` 内 `generic-model-eval` / `measure-summary` 引用非零；② 两脚本不在 `git ls-files`；③ 无替代 harness 入口与测试证据；④ `arch/eval-r1` == `29c13e9`（修复不在 M4 基线内）→ 按「未修」执行兜底 A（删除纪律，机制已死无后继）。连带 `ci.yml` 头注释、残留步骤 `git branch -r -d github/eval-config` 删除、fetch-depth 注释改真实状态。后继：确定性门 typecheck + unit；用户级评测＝`eval:user`（并行分支交付，合并后生效）。加回判据：恢复真实模型评测面须先有可运行且被测试钉住的 harness 与 owner 裁定；**禁止再指向已删脚本**（`generic-model-eval.py` / `measure-summary.mjs`）。
8. **契约去面（C 项）**：`cancel` 全链（`CancelResult` + `ExecutionClient.cancel` + dummy-cli-client 实现 + 测试引用；生产调用点 0，唯一调用是测试断言，实现自述只返回 `not_found`）、`completed.artifacts`（零产出零消费）、`confirmation_required`（dummy-cli-client 从不产出，未知状态反而映射 failed）。后继：写/确认切片采用独立 `confirm(requestId, confirmationId, decision)` 时按需恢复（契约头注释已写明方向）。加回判据：写/确认切片落地确需取消或待确认状态时按新接口恢复并附测试；类型删除由 tsc 反锁（任何旧调用点编译即红）。`ExecutionFailure.retryable/details` 与 `MissingInput.name/description` 保留（有产出、属如实透传）。
9. **文档口径**：AGENTS.md 现状/指针、README、docs/index、methodology、a2a-protocol 失效注记、architecture-laws M4 附注、eval-mechanism-registry 状态、e2e-ownership CI 口径、push-runbook、environment-variables §4/§9 注记、ci.sh/ci.yml 注释、codex 提示词历史口径。**评测口径（以本节为准）**：确定性门＝`npm run typecheck` + `npm run test -- --project unit`（含契约行为测试与安全不变量指定测试）；用户级评测＝`eval:user`（并行分支交付，合并后生效）；真实模型评测面已退役。AGENTS.md:26 与 §十二:621 的「取消/产物」表述为历史文字，按维护规则不改旧条目，由本节登记当前契约面（四态，无 cancel/artifacts）。

### 13.3 契约行为测试补点（C 项；四行为）

- 能力发现：补 `style→type` 投影与位置参数投影断言（`dummy-client.test.ts`）；清单失败三态（非 JSON / exit≠0 / 超时）由 stub 网关补测 fail-closed。
- 请求：既有覆盖（`dummy-client.test.ts` 结构化执行、`runtime.test.ts:162-211`）。
- 响应：补 `not_found` 信封→`completed`（确定性答案）、`failed` 信封→`failed`（QUERY_REQUIRED 含 `correctForm` details；COLLECTION_LOCKED）、超时→`EXECUTION_TIMEOUT`、未知状态→`EXECUTION_UNKNOWN_STATUS`、无信封→`EXECUTION_NO_RESULT`、`needs_input` 声明缺参分支（fixture 不可达，stub 补）。
- 拒绝：既有覆盖（`dummy-client.test.ts` env 白名单对照、`runtime.test.ts` 允许集合拒、`server.test.ts` 未开通 principal）+ 本批补 error 原样落账断言。

### 13.4 保留清单（逐条理由）

1. 生产闭包全部保留：ask/start 入口、execution-runtime、dummy-cli-client、task-registry(+sqlite)、worker-env、worker-skills/skills、pi-driver、step-text、server-paths、agent-profile、core config/task-store、channel-wecom、contracts execution-contract/channel/config/runtime/store、resolve-config-path 的 `explicitConfigFrom`+`materializeEvalConfig`、`scripts/eval/safety-gate.ts` 隔离门（`ask.ts:128` 实调，fail-closed 生产职责）。
2. `packages/agent/transition-naming.test.ts`：现行防回潮守卫（全量路径/标识符扫描 + 窄豁免双向绊线），本次 2 用例通过。
3. `packages/agent/import-boundary.test.ts`：import 方向/契约零 import/接线完整性守卫；其 FORBIDDEN 清单本就登记历史治理模块，保留即防回潮（无需改）。
4. 安全不变量测试与实现：`worker-env.ts`+测试（凭据隔离白名单）；`task-registry(.sqlite)`+归属/重启连续性测试；`server-paths.ts`+测试；`apps/server/server.test.ts`（假渠道 + 未开通 principal 拒绝）；`dummy-client.test.ts`（传输四行为）；`runtime.test.ts`（允许集合拒绝、fail-closed 构造、归属）。
5. `scripts/eval/fixtures/dummy-platform`（ask 缺省执行层）+ `config/agent.fixture.yaml` + `config/agent.example.yaml`：生产 ask/start 运行面。
6. `scripts/vitest-orphan-guard.ts`、`tests/vitest.setup.ts`（修剪死键后）、`vitest.config.ts`（别名面保留，注释更新）。
7. `scripts/ci.sh` 主体（typecheck+unit 两门）与 `ci.yml`（codex-review-scripts job 保留）。
8. docs 历史档案保留（a2a-protocol / execution-layer-interface / change-safety / debt-ledger / v0-architecture 等），仅对现行指针与现行主张加失效注记。

### 13.5 证据（原始输出摘要）

- 基线：`npx tsc --noEmit` exit 0；`npx vitest run --project unit` → 26 文件 / 213 用例通过。
- 13.1 红：`11 failed | 10 passed (21)`；绿：`21 passed`（runtime 15 / sqlite 6）；全量 225 通过。
- 13.3 后全量：229 通过；13.2 后全量：221 通过（净 −8：新增 16、退役 8、其余保持；文件数 26 不变）。
- 变异四组（13.1）：A 11 红（含 ③b、⑤⑤b；⑥/④ 保持绿）；B 11 红；C 含 ⑥ 红；D `3 failed | 18 passed`（⑤⑤b⑧）。变异源码已还原。
- 指定门（最终态）：`npx tsc --noEmit` exit 0；全量 `26 files / 221 tests passed`；契约四行为 + 安全不变量指定 6 文件 `50 passed`；`node --test .github/codex/*.test.mjs` → `20 pass / 0 fail`；`sh scripts/ci.sh` → `CI deterministic gates: PASS`。
- **复核修复轮（2026-11-13，M4 复核 findings）**：悬空引用清零（`config/agent.fixture.yaml` 头注释、`dummy.cjs` GENERIC_MOCK_NOTES 指针、`vitest.config.ts` leak-lint 注释、debt-ledger D-209 指针校正、`environment-variables` §4a child-env 指针、`eval-mechanism-registry` #7、`rule-landing` / `push-runbook` / change-safety / debt-ledger / v0-architecture / execution-layer-interface / execution-layer-admission / env-naming-ruling / eval-baseline-refresh / eval-harness-measurement 的 M4 档案注记）；未动任何测试、断言或代码语义。门与绊线复跑结果附于本节末（见 13.8）。

### 13.6 缺口与待裁定

- `ci.yml` 的 `fetch-depth: 0`：当前确定性门不依赖 git 历史（原 history-hygiene 守卫已删）；去/留待 owner 裁定（本分支保留并改写注释为真实状态）。
- 「用户级评测＝`eval:user`」在并行分支交付，合并后生效；本分支内不存在该入口，未实测。**并行 `arch/eval-r1` 在 M4 删除后已出现修复提交**（eval-real/eval-nightly 改挂 `eval:user`、删 eval-measure、交付 convergence-r1）；本分支未合并、未处置 delete/modify 冲突面（eval-real.yml / eval-nightly.yml / eval.agent.yaml / ci.sh），合并顺序与冲突处置归 owner。
- 被删的夹具写/计划覆盖（13.2-3）无逐条等价承接，已按对象退役登记；恢复评测面前该覆盖面为空是已知状态，不得写成绿。
- `git branch -r -d github/eval-config` 步骤删除：该 ref 清理已无消费者（eval-config 机制相关 harness 已退役），如 owner 知其另有用途可按需恢复。
- bridge-key 闭集守卫（`packages/agent/bridge-key-closure.test.ts`）与平台泄露守卫（`platform-leak-lint.test.ts`）随 `0b97227` 删除（预分支，非 M4 误删）；当前树可跑的边界断言 = `worker-env.test.ts`「测试桥键不进白名单」（实跑通过）。恢复最小闭集守卫或改 D-209 闭环判据属 owner 待裁定（D-209 已附 2026-11-13 M4 指针校正）。
- `packages/contracts/src/index.ts`（barrel）仍导出 `store.ts` / `runtime.ts` 等大面积未消费面（预分支遗留，不在 M4 删除清单）；本分支「契约未用面已删」仅指 Execution Contract 面（cancel/artifacts/confirmation_required），不含整个 contracts barrel。

### 13.7 取回点

- 删除前完整代码在 `git log`：基线 `29c13e9` 及各文件删除提交的前一提交（`git show <commit>^:<path>`）。
- generic-mock 覆盖清单/基线：`29c13e9:scripts/eval/generic-mock.ts`、`GENERIC_MOCK_NOTES.md`、`generic-mock-baseline.json`。

### 13.8 复核修复轮证据（2026-11-13）

- 悬空引用扫描（修复后）：`git grep -n GENERIC_MOCK_NOTES` 仅剩已注记的历史档案/登记处；`git grep -n "eval.agent.yaml"` 仅剩「已退役」说明、§十三 登记、测试自建临时文件名与 `resolve-config-path.ts` 的退役说明；旧五模块仅 `import-boundary.test.ts` 墓碑 5 行。
- 门复跑（修复后）：`npx tsc --noEmit` exit 0；`npx vitest run --project unit` → 26 files / 221 tests passed；指定 6 文件（契约四行为+安全不变量）→ 50 passed；`node --test .github/codex/*.test.mjs` → 20 pass / 0 fail；`sh scripts/ci.sh` → `CI deterministic gates: PASS`。
- 绊线复跑：对 `task-registry.ts`（内存实现）与 `task-registry-sqlite.ts` 重放「恢复无条件 completed」变异 → `11 failed | 10 passed`（与先红失败集一致）；备份还原后 `git diff` 两文件 0 差异、两文件 21 passed。
- 夹具配置可用性：`materializeEvalConfig('config/agent.fixture.yaml', ...)` + `loadConfig` 加载成功（profiles=dummy，root 物化为绝对路径）——头注释修正未影响可加载性。
- **第二轮（2026-11-13，复验 findings）**：`docs/architecture-laws.md` 新增文首「守卫引用清点」M4 banner（覆盖全文现时态守卫引用）并对被点名的 `:132`/`:142`/`:195`/`:320` 加行内 M4 注；`AGENTS.md:69` 的 architecture-laws 指针改为「律法与历史判据档案」；`scripts/resolve-config-path.test.ts` 测试字面量去对象化（`eval.agent.yaml`→`source-config.yaml`、`stock`→`fixture`、`stock-platform`→`dummy-platform`、`bin/stock`→`bin/dummy`、`/abs/stock-platform`→`/abs/some-platform`；断言语义不变）。全仓 24 名复扫分类见 `.runtime/m4/residual-scan.md`（312 行命中：非文档面零未注记现行时态指针，文档面全部为带注记历史文本或权威登记；`import-boundary` 墓碑与 `.zcode` 客户端工件按规则保留）。

**合并处置（2026-11-13，owner）**：`arch/m4-sweep` 与并线 `arch/eval-r1` 合入 `arch/integration`（merge `ce7ec8d`，含 `0ffe9d9`）。13.2-7 的「三个失效 workflow 退役」按合并结果收窄：`eval-real.yml` / `eval-nightly.yml` 采用 eval-r1 的「改挂 `npm run eval:user`」版本（任务书 §2.2「改为当前 Minimal 链路的评测入口」；13.6 冲突面由此关闭），`eval-measure.yml` 维持退役；旧 harness（`generic-model-eval.py` / `measure-summary.mjs`）不恢复。`scripts/eval/eval.agent.yaml` 维持删除；`docs/a2a-protocol.md` 保留为带失效注记的历史蓝图。

---

## 十四、Eval 入口收口：真模型工作流改挂用户级入口、measure 机退役（2026-11-13，分支 arch/eval-r1）

**背景与失效证据**（基线 `29c13e9` 上实跑复现）：

- Minimal Reset（`0b97227`）按可达性删除了旧评测工具环（`scripts/eval/generic-model-eval.py`、`scripts/eval/measure-summary.mjs`、second-layer / 旧 probe 仪器等），但 `.github/workflows/` 的三个真模型 workflow 未同步，per-push / nightly / measure 全部指向不存在的文件：
  - `python3 scripts/eval/generic-model-eval.py --no-judge --rounds 1` → `can't open file '.../scripts/eval/generic-model-eval.py': [Errno 2] No such file or directory`（ENOENT）。
  - `node scripts/eval/measure-summary.mjs` → `Error: Cannot find module '.../scripts/eval/measure-summary.mjs'`（MODULE_NOT_FOUND）。
  - `git log --diff-filter=D` 确认两者删除点均为 `0b97227`。
  - eval-measure.yml 对已删对象的依赖（基线 `29c13e9`）：L79/L144/L173 → measure-summary.mjs；L99/L110/L114 → generic-model-eval.py——无一处可执行。
- eval-real.yml 头注当时仍宣称 `CI 的真实模型面 = generic-model-eval.py 最小工具环 harness`（同一基线 L11-14），是已失效的指向。

**决定**：

1. **eval-real.yml（per-push，advisory 非阻断不变）**：改挂用户级黑盒入口 `npm run eval:user -- --trials 1 --out-dir .runtime/eval-user`（与 `npm run ask` 同源装配：createSession + createDummyCliClient + 仓内 dummy 夹具）；删除 `workflow_dispatch` 的 `cases` 输入（旧 7 例集）与 `CASES_INPUT` / `LLM_JUDGE_MODEL` 消费；产物 = `.runtime/eval-user/`（逐样本原始证据 + summary，全样本保留，artifact `user-eval-report`）；PR 评论不再解析任何旧 probe schema。
2. **eval-nightly.yml（schedule 保留）**：单阶段用户级全量 `npm run eval:user -- --trials 3`（12 用例 × 3 次，全样本保留），产物 `.runtime/eval-user/`（artifact `user-eval-full`）；**二期双档区分度矩阵（eval-discrimination，含旧 probe/judge schema 解析）整体删除**——其报告步骤依赖已删仪器与旧 G-* 例集，任何移植 = 新评测平台代码（本轮禁止）。
3. **eval-measure.yml 删除**：测量语义（N 轮稳定性通过率矩阵 + 双档区分度）新入口未提供；重建即违反「不新建评测平台/复杂 Eval 平台」。
4. **scripts/ci.sh 与 scripts/eval/eval.agent.yaml 只改措辞**（指向新入口），确定性门（typecheck / unit / generic-mock）不动。

**取回点**：`git show 29c13e9:.github/workflows/eval-measure.yml`（nightly 二期同 commit `29c13e9`）；旧工具环代码在 `git log`（删除点 `0b97227`）。

**加回来的判据**：仅当用户级 eval 确需多轮稳定性/双档区分度统计、且新入口（`scripts/eval/convergence-r1`）已**原生提供该口径**（零新平台代码）时，才允许恢复对应 workflow；恢复前必须先按维护规则写「加回决定」，注明服务哪条判据。

**状态更新（2026-11-13）**：已实施（`arch/eval-r1`），并已随合并 `ce7ec8d` 进入 `arch/integration`；合后 36 次复测 32/36（见 `scripts/eval/convergence-r1/report-round1.md` §7）。

---

## 十五、R1 前置③：生产不可达旧协议与旧治理测试清理（2026-11-13，分支 arch/eval-r1）

**背景**：R1 审计（四份审计结果与原型验证记录，本轮工作副本）发现 reset 后三类残留：① contracts 旧协议零消费（`a2a-protocol.ts` 全符号 0 命中；`runtime.ts`/`store.ts` 除 `DiscoveredTool`/`PrincipalScopeRecord` 外 0 命中）；② 旧 Phase2 治理模块 5 个 + generic-mock 评测群仅彼此可达（import-boundary 的 FORBIDDEN 自列，生产值闭包不含）；③ workflow/注释引用已删对象（`generic-model-eval.py`、`measure-summary.mjs`、`history-hygiene.test.ts`、`tests/e2e`）。

**删除（D1–D7；证据见各条行号）**：

- **D5 generic-mock 评测群**：`scripts/eval/{generic-mock.ts(630行), generic-mock-baseline.json(203行), GENERIC_MOCK_NOTES.md(308行), fixture-aux-state.ts(31行)}`；同步 `package.json` 入口、`scripts/ci.sh` 确定性门（现为 typecheck + unit）、README/AGENTS/ci.yml 措辞、`tests/vitest.setup.ts` 的 stock 辅助组 ambient 清场。
- **D4 旧 Phase2 治理五模块**：`packages/agent/src/{task-handover(176), committed-unverified(54), proposal-review(134), tool-definition-guard(38), worker-step-cap(70)}.ts`——仅被 generic-mock 可达。import-boundary 的 FORBIDDEN 名单保留为退役登记（注释说明）。
- **D7 stock 夹具**：`scripts/eval/fixtures/stock-platform/**`（5 文件 856 行）与 dummy 夹具的 `bin/generic` 别名（新用户级 eval 只用 dummy 夹具）。
- **D1 旧 a2a 协议**：`packages/contracts/src/a2a-protocol.ts`（170 行，FORBIDDEN:全符号 0 命中）+ `packages/contracts/src/index.ts` 导出 + `vitest.config.ts` 注释 + AGENTS.md 指针 + **D6 活指针文档**（`docs/a2a-protocol.md` 131 行删除；`docs/index.md`、`docs/methodology.md` 同步）。历史记录（decision-log/change-safety/debt-ledger/v0-architecture 等）不动。
- **D2 contracts runtime/store 裁剪**：`packages/contracts/src/runtime.ts` 74→13 行（只留 `DiscoveredTool`）；`store.ts` 全删（487 行）——其唯一被消费类型 `PrincipalScopeRecord` 的消费者（D2b）删除后零消费。
- **D2b/D3 core 两助手与用例**：`packages/core/src/config.ts` 的 `principalScopeRecords` / `firstEnabledPrincipalId`（42 行）删除；`packages/core/src/index.ts` 导出同步；`packages/core/config.test.ts` 两段（7 用例，196-226 / 264-308）随对象退役（无红被删）。
- **C 组注释与 alias**：`ci.sh`/`ci.yml`/`eval.agent.yaml`/`agent.fixture.yaml`/`resolve-config-path.ts`/`vitest.setup.ts`/`driver-contract.ts`/`channel.ts`/`dummy.cjs`/`.github/prompts/*` 的陈旧指向（history-hygiene、exposure-lint、tests/e2e、e2e AT-1、generic-model-eval.py 等）清零；import-boundary 删除陈旧 `@fshine/agent` alias（指向不存在的 `packages/agent/src/index.ts`）。

**保留（B 类，K1–K8）**：worker env 白名单（`worker-env.ts`）、任务归属/越权（`task-registry*.ts`）、过渡命名收敛守卫、import 边界守卫、假渠道 server、重启连续性——以现树文件为准。

**被删绿门与后继**：generic-mock 26/26 绿 → 后继 = R1 新用户级 eval（`scripts/eval/convergence-r1`，生产同源链），覆盖面并入新判据表，不逐条迁移；unit 删前基线 213/213 绿、typecheck 0 → 删后 206/206 绿（7 例为只服务已删助手的用例，随对象退役登记）。

**桥键闭集守卫缺口**：`packages/agent/bridge-key-closure.test.ts`（4f364af 继任守卫）与 `packages/agent/src/child-env.ts` 随 reset（`66e7d23`）删除，无继任闭集守卫；现覆盖 = `worker-env.test.ts` 白名单闭集断言 + 夹具读桥（部分覆盖）——闭集扫描缺口登记。§十 第 3 条已追加状态更新。

**加回来的判据**：generic-mock / 旧协议仅当新用户级判据表确需确定性协议回归、且 `ask` 链不可复现该判据时才可恢复；恢复须写明服务哪条判据。

**命令与净删（实跑）**：

- `npx tsc --noEmit` → exit 0；`npx vitest run --project unit` → 26 文件 / 206 用例全绿；`npm run ci` → `CI deterministic gates: PASS`。
- 真模型面回归：`npm run eval:user -- --trials 1`（12 用例全样本）跑通；结果按当时判定器记 8 PASS / 4 FAIL——其中 E01 的 FAIL 经复核为**判定器假阳性**（markdown 表格行号误判 + 陈述句误判提问，修复与重切见 §十六），重切后复判 9 PASS / 3 FAIL；E04/E05/E08 零执行类判负按冻结判据原样保留——证据在 `.runtime/eval-r1/post-cleanup/`。
- 净删：两个清理提交合计 **43 文件、+54 / −3538 行**（D4/D5/D7 提交 24 文件 +19/−2534；D1/D2/D2b/D3+注释提交 19 文件 +35/−1004）。

**状态**：已实施（本分支，待开 PR）。

---

## 十六、convergence-r1 用户级评测交付与判据冻结记录（2026-11-13，分支 arch/eval-r1）

**交付**：`scripts/eval/convergence-r1/`——12 用例（E01–E12，数据文件一例一个）+ 六维确定性判定器 + 证据 schema（每 case×trial 独立目录：inputs/model/toolcalls/transcripts/audit+index/executions/reply/meta/state/db/judgment）+ runner/judge/selftest/freeze/README；入口 `npm run eval:user`（生产同源装配：createSession + createDummyCliClient + 同一配置与任务底账；唯一插桩 = TurnDriver 记录包装器）；真模型面跑 `eval-real.yml`（1 轮）与 `eval-nightly.yml`（12×3）。

**第一次冻结（`d8faff6`）**：criteriaSha256=`9d4b0824a429658e7f633ff8af928fd3ad94b633f02c95f151866679bb8d6cd4`；casesSha256=`6d55a42ad0ff575cfe11fb4695861c6a7c28d46654c6e94de29170161e4d1a78`；files 18 项（criteria.ts / cases.ts / judge.ts / hash.ts / evidence.ts / selftest.ts + 12 用例文件）。

**冻结前验证（真实模型，不计入 36 次）**：E01–E12 每例至少 1 次实跑（smoke E01 一次 + 预冻结分批）；判定器自测 `--judge-selftest` 8/8；全样本原样保留（含 E05 两次判负样本）。

**重切（判据冻结后的判定器缺陷修复；「判定器自身缺陷」属允许修复类）**：正式 36 次运行开始前，用冻结判据复判存量全样本时发现三处判定器缺陷——① markdown 表格「序号」列的数字被当成与实体同句的不可溯源数值（E01 误判 `FAIL_FABRICATED_DATA`）；② 陈述句里的「分属哪个窗口」按冻结词表被当成提问（E01 误判 `FAIL_NEEDLESS_CLARIFICATION`）；③ T0/T2 同一载荷被重复计入「合计」推导（500+300+200 被算成 2000，1000 报弱告警）。

- **修复范围**：仅 `judge.ts`（子句分隔补表格竖线；判负门槛加「实际提问形态」——句末问号或请求式短语；载荷按值列表去重后做分组合计/组内差值/跨组合计）。**criteria.ts 与 12 用例文件逐字节未动**（两哈希不变）。
- **验证**：`--judge-selftest` 8/8；复判全部存量样本 27 trial、仅 3 处变化——post-cleanup E01 FAIL→PASS、pre-freeze2 E04 FAIL→PASS（两者均为上述假阳性）、pre-freeze E05 去掉一处被移除的全域状态检查（`FAIL_WRONG_OBJECT` 保留）；全部零执行/虚构类判负不变，无判负被放宽。

**第二次冻结（重切）**：judge.ts sha256=`fdf29e7d98a97e68c0c8b9e34b95a32822f1684786de57352f47c1c19ccbf64b`；criteriaSha256 / casesSha256 不变（判据与用例未改）；`frozenAt=2026-11-13T10:49:28Z`。此后判据、用例与判定器均不得再改。

**第三次冻结（E04 判定器缺陷修复重切，2026-11-13）**：36 次批次（12×3，runId `evalr1-2026-11-13T11-07-32-640Z-b124c5`）判负归因确认 E04 trial-1/2/3 均为判定器缺陷，按同流程修复后重切：

- **trial-1（可溯集合口径间隙）**：reply turn-2「按名称：document-1 共 1 条、1200；document-2 共 2 条、合计 1700。」；载荷 items=document-1:1200、document-2:800/900、count=3 → `1`/`2`/`1700` 均可由载荷按名计数与分组和导出，旧 traceable 只收整组长度/整组合计/全组合计/成对差值。修复：traceable 增补按名分组计数、分组和、同名组内差与不同名条数。
- **trial-2/3（话题裸词误伤）**：trial-2「…两个窗口查询里都存在，仍需要你确认哪一笔为准。」、trial-3「…或者先确认下两个窗口数据是否本应相同？」均因裸词 `窗口` 命中 `forbiddenQuestionTopics` 被误判复问。修复：话题复问改**短语式定位**（话题名词须与疑问/请求标记组成短语，如「哪个窗口/请提供窗口」；疑问词条目须后接话题名词，如「哪一个窗口」），裸名词与裸疑问词不再判负；语义边界 = 规则指「复问用户提供窗口/集合信息」，不含对数据一致性的追问。
- **验证**：`npx tsc --noEmit` → 0；`--judge-selftest` 8/8；对 36 份证据 `--judge-existing` 复判比对：仅 4 处 mismatch——E04 trial-1/2/3 FAIL→PASS（假阳性），E03 trial-3 PASS→PASS（仅去掉一条可溯源弱告警）；其余 32 份逐字节复现。全库存量样本复判无其他判负放宽（post-cleanup E04 仅去掉假阳性 NEEDLESS 子码，零执行类判负保留）。
- **第三次冻结**：judge.ts sha256=`734bd234eb168d882239832ff397b3af45dc13a3e3bf0562766a22e26b7a9f94`；criteriaSha256 / casesSha256 不变；`frozenAt=2026-11-13T11:30:50Z`。
- **修复后同例复测（真实模型，同一冻结判据）**：E04 ×3 全 PASS（trial-1/2/3；每轮各 ≥1 次结构化执行、taskIds 非空、无 failureCodes/弱告警）——证据 `.runtime/eval-r1/e04-after/`。复现轮（修复前）曾得到一例零执行模型行为样本（未委派、FAIL_NO_DELEGATION/FAIL_ZERO_EXECUTION），属模型方差、按原样留档。

**第四次冻结（E06 判定器缺陷修复重切，2026-11-13）**：36 次批次 E06/trial-3 判负归因确认「完成话术词表语境盲」——reply turn-1 的示例枚举「（如待处理/已完成）」被机械命中判 `FAIL_PHANTOM_SUCCESS`（同 case t1/t2 同形澄清回复无该示例词均 PASS，判负随措辞翻转）。修复（仅 judge.ts；判据/用例逐字节未动）：新增话术语境门 `contextualPhraseHit`——先剥括注（（）/()/【】）内容，只扫非疑问句，短语前 10 字内为示例标记（比如/例如/诸如/像是/如像）或近邻「如…」形态不计；同一道门同时用于完成话术与写完成话术（同类缺陷，同轮一并收口，未新增机制类别）。验证：`npx tsc --noEmit` → 0；`--judge-selftest` 8/8（phantom-success 反例仍正确判负，未误伤真检测）；36 份批次证据 `--judge-existing` 复判比对：mismatch 集合 = E03-3（弱告警消减）、E04-1/2/3（上一次修复）、E06-3 FAIL→PASS，其余逐字节复现；全库存量样本复判无其他判负放宽。第四次冻结：judge.ts sha256=`eb7a0c19e0afda6b63e822e3c6f73e8567e8539f7c590482c8a6a3b89889941c`；criteriaSha256 / casesSha256 不变；`frozenAt=2026-11-13T11:42:22Z`。
- **修复后同例复测（真实模型，同一冻结判据）**：E06 ×3 全 PASS（trial-1/2/3；零执行问询形态按 optional 判正，各 ~3.1s）——证据 `.runtime/eval-r1/e06-after/`。复现轮（修复前）同例 1 次 PASS（该轮回复未含示例词、未触发缺陷——判负随措辞，属方差）；缺陷复现依据为批次 trial-3 存证 + 修复前后 `--judge-existing` 比对。

**第五次冻结（E07 判定器口径缺陷修复重切，2026-11-13）**：36 次批次 E07/trial-1 判负归因确认两处判定器/判据口径缺陷（判据文本未动）：① **硬锚点词表窄于语义等价类**——reply「alpha 集合下没有 W9 窗口的数据。」「W9 窗口下没有任何数据。」因插入语无法逐字命中，containsAny 11 词全部未命中 → ①note「全部未命中」；② **自纠补查被误判条件丢失**——复现轮（修复前）模型对 W9 not_found 后自纠补查 W1/W2，被判「执行行条件丢失」`FAIL_WRONG_OBJECT`，与 E07 冻结 weakNote「随后自纠补查 W1/W2 = 允许（记录）」矛盾。修复（仅 judge.ts）：① containsAny 对含「无数据/没有数据/没有记录/无记录」标记的锚点列表增加**有界语义等价形态**（否定词…数据/记录/条目/内容，插入语 ≤12 字且不跨句；数据…不存在/为空——只对含该标记的锚点生效，当前仅 E07）；② `requireEveryRowArgs` 作用域收敛到「期望 not_found 结果首次出现」为止（含），其后的自纠行只受 allowedCollections 约束（其他单查用例无 not_found 检查点，作用域不变）。验证：`npx tsc --noEmit` → 0；`--judge-selftest` 8/8；批次 36 份 `--judge-existing` mismatch 集合 = E03-3/E04-1/2/3/E06-3/E07-1（累计重切），其中 E07-1 FAIL→PASS、E07-3 `FAIL_FABRICATED_DATA` 原样保留（模型行为）；E07 复现轮离线复判 PASS。第五次冻结：judge.ts sha256=`a6a5b29312df2daefae65f47f13bfa2fa6efe85165aa9460f89206aa16ed79f1`；criteriaSha256 / casesSha256 不变；`frozenAt=2026-11-13T11:48:26Z`。
- **修复后同例复测（真实模型，同一冻结判据）**：E07 ×3 全 PASS（trial-1/2/3；各 1 次结构化执行、taskIds 非空，18.3s/31.6s/19.0s）——证据 `.runtime/eval-r1/e07-after/`。修复前复现轮（1 次）呈现同一锚点缺陷 + 自纠误判，离线复判已转 PASS；E07/trial-3 的 `FAIL_FABRICATED_DATA`（模型引用技能文档数值冒充查询结果）按模型行为保留。

**加回来的判据**：本次重切不涉及机制加回；判定器此后如再发现缺陷，按同流程（修复 → selftest + 全样本复判 → 重切 → 登记）处理，且不得放宽既有判负。

**状态**：已实施（本分支，待开 PR）。

---

## 十七、R2：E05 边界裁定、判定语义核查与持续评测口径（2026-11-13）

**背景**：M4/M5 收官后 owner 确认架构冻结，R2 只做「在固定最小架构上提升真实任务完成质量」。本条登记 R2 首批五项处置；不改写 §十三–§十六 的旧条目。

### 17.1 E05 授权边界裁定（owner 2026-11-13；判据不变）

- **问题**：E05（歧义）两轮 0/3——模型按夹具技能「候选作为一次澄清交给用户」直接澄清、零执行；现行冻结判据要求先向执行层查询歧义句柄（`contoso` → `needs_input` + 候选）。技能与判据对「何时先探索、何时先澄清」表述不一致。
- **裁定**：
  1. **授权面**：候选查询与具体对象读取同属只读调用，逐次由 Executor 按可信身份与 scope 裁决；宿主与模型不预审实体，也不得凭技能文档/记忆充当对象事实。
  2. **探索优先（当可执行）**：用户给出的标识存在歧义、且该标识本身可交给执行层裁决时（如 `contoso` 前缀），**先探索**——向执行层查询该歧义标识，由执行层返回候选清单（`needs_input` + candidates）。候选事实的权威是执行层。
  3. **澄清**：探索结果存在多解时，把**执行层返回的候选清单**交还用户选择（一次澄清）；标识缺失或执行层不可裁决时直接澄清（E06 场景）。
  4. **禁用面**：用户确认前，不得以猜测的具体候选集合名（`contoso-trade` / `contoso-logistics`）发起查询，更不得把候选数据当作用户所问对象的答案（v1 判据的 WRONG_OBJECT / FABRICATED 面保持不变）。
  5. **判据不变**：本裁定与 v1 冻结判据一致（`allowedCollections=['contoso']`、needs_input checkpoint），**不产生判据 v2**；原冻结用例不改写。若未来裁定变更（如允许候选枚举或澄清优先），必须新增判据版本并保留 v1 可对照（原始 judgment 已存证 + git 快照）。
- **最小实施（允许类：Skill）**：夹具技能 `scripts/eval/fixtures/dummy-platform/.agents/skills-serve/dummy-routing/SKILL.md` 对齐裁定——歧义前缀先查执行层、候选以执行层返回为准、文档数字不得引用作答（同句覆盖 E07-3 已登记的同类风险）。技能修订 = 评测环境新 revision；E05 复采样另行记录（样本/模型/revision 见报告）。

- **最小实施②（提示词级，A 类；经 Eval 验证才保留；2026-11-13）**：主 Agent 指令 `.agents/agents/fshine-main/agent.md` 补裁定——「对象名/集合名不确定时把原话交给执行层裁决（执行层返回候选或不存在），不自行猜测候选、不引用文档作答；仅缺业务决策信息时才直接澄清」。**根因证据**：E05 ×9（step-3.7-flash，技能已对齐）仍 0/9——模型把 `contoso` 当公司名先向用户澄清，理由与旧 agent.md「必要时先澄清 / 不替执行层摸索」一致；技能仅作用于 Worker，管不到 Main 的决策点。**复采样**：E05 ×9 + 回归探针 E06 ×3 / E12 ×3（同 revision），无改善则回退该句并只保留裁定文字。

- **验证结果（2026-11-13，step-3.7-flash）**：E05 ×9「技能已对齐、agent.md 未对齐」= 0/9（9/9 零执行先澄清，把 contoso 当公司名）；agent.md 对齐后 ×9 = **5/9 PASS**（5 次 `query contoso → needs_input → 交还候选`；4 次仍零执行先澄清，模型方差），回归探针 E06 ×3 = 3/3、E12 ×3 = 3/3。判据未变、冻结用例未改写；**保留 agent.md 改动**（Eval 证明有改善且无回归）。E05 的 5/9 是行为频率不是稳定性结论。

### 17.2 task.status 语义边界（needs_input 与「中间失败后恢复成功」）

- **核查结论**：`task.status` 当前**没有用户可见消费面**——`npm run ask` 机械证据只逐条打印 `execution.status`（不打印 task.status）；`apps/server/server.ts` 只记录逐执行状态；M5 判定器（`scripts/eval/convergence-r1/judge.ts`）用执行行（T1 executions 与 `executions.some(failed||refused)`）判「④任务状态一致性」，不读 task.status。
- **决定**：**本轮不修改语义**（不为无消费者的字段新增宿主行为）。当前口径——首个非 completed 判负（`[failed, completed]` 记 failed）、`needs_input` 并入 failed——以表征测试钉住：`packages/agent/task-status-boundary.test.ts`。
- **复评触发条件**（出现任一）：ask 打印任务状态 / 状态查询切片 / 后台投递 / 判定器改用 task.status。届时先按用户可见性裁定，再改语义并同步更新该测试与本条。
- **复评登记（2026-11-14，P1 任务查看切片）**：触发条件之一「状态查询切片」已达成——`npm run tasks` 列表/详情成为 `task.status` 的首个用户可见消费面。**裁定：保持既有语义**（P1 owner 规格：completed/failed/unexecuted 复用 `judgeReportedTask`，不新造状态）。实现口径：查看侧只读消费注册表写入时已判定的终态并把三态映射为中文词（已完成/失败/未执行），**不在读时重算**（fail() 路径零执行与 running 行会被重算错报）；表征测试 `packages/agent/task-status-boundary.test.ts` 断言零改动。

### 17.3 Execution Contract 残余：CLI flag 名称泄漏

- **残余**：operation 参数名以 CLI flag 形态直传（`operation list --json` 的 `args.flags[].flag` = `--collection` / `--window`；`CapabilityManifest.operations[].args[].name` 同名）。影响：替换为非 CLI 传输的 Executor 时需在适配器内做参数名映射；模型看到的参数声明是 flag 名。
- **决定**：当前不实施修正（仓内唯一 Executor 为 CLI 网关，生产链正确性不受影响）。**触发最小修正的条件**：① 接入非 CLI 传输并出现映射成本或行为差异；② 模型行为 Eval 显示 flag 命名造成误用。修正方向：契约参数名中性化 + 适配器内映射（不扩张协议语义）。

### 17.4 持续评测口径：配置就绪 ≠ 默认分支已启用

- **事实**：`eval-real.yml` 触发面 = push/PR 到 `main`；`eval-nightly.yml` = 每日 cron + 手动。当前工作线为 `arch/integration`（未合 main），且本仓未验证远端 Secrets（`LLM_API_*`）可用性。
- **口径**：**「工作流配置就绪」不等于「默认分支上的持续 Eval 已启用」**。持续保障成立需同时满足：① 分支合入 main（owner 决定）② 首次真实 nightly 运行留档 ③ 失败面有人处理。在此之前，任何报告不得宣称 Nightly 提供持续保障。

### 17.5 评测数据保留口径（owner 2026-11-13）

- 后续评测继续**分别保留**：原始结果（原始 judgment，不因修复改写）、离线复判（`--judge-existing`）、重新运行结果（新样本）；报告中必须注明**样本规模、模型版本、代码点/技能 revision 与可验证范围**。
- R2 采样记录（step-3.7-flash，原始 judgment 全部保留）：E04 ×12 = **12/12**（正确委派 12/12、逐 trial 2 次执行 W202611+W202610、先追问 0、虚构 0）；E05 ×9 对齐前 = **0/9**、对齐后 ×9 = **5/9**；E06 ×3 = 3/3、E12 ×3 = 3/3（回归探针）；**模型 = `step-3.7-flash`**（`config/agent.fixture.yaml` 的缺省模型；进程 env 显式覆盖 `.env` 的 `step-5-preview`，证据 `model.json` 记录 main=worker=`step-3.7-flash`）。M5 首轮基线（32/36 等）为 `step-5-preview` 帧——**跨模型帧不得混用**，R2 报告对两帧分列。旧 `r2-e04` 混合 revision 采样作废并留档。

---

## 十八、P1 产品切片：任务查看 v1（2026-11-14，分支 arch/p1-taskview）

- **范围**：新增 `npm run tasks`（最近任务列表）与 `npm run tasks -- <taskId>`（状态/失败原因/执行步骤/任务结果）——只读消费既有 SQLite 任务注册表；`openTaskStore`/`createSqliteTaskRegistry` 增 `readOnly` 选项（不写、不锁写、缺库不创建）；状态与失败原因复用 `judgeReportedTask` 语义（查看侧不在读时重算，§17.2 复评登记）。schema、ask/start、R1 冻结集与 exploration 零改动。
- **证据指针**：`docs/product/p1-task-viewing.md`（六段报告 + 验收逐条勾选）；真实模型三场景（completed/未执行/失败）逐字命令与输出在 `.runtime/product-p1/`；只读哈希不变（`readonly-proof.txt`）；E06 ×3 / E12 ×3 全过（`eval-e06.log`/`eval-e12.log`）；实现提交 `353fd10`（TDD 16 例 + 三组反向绊线）。
- **状态**：已实施并验收（本分支，未 push/未合并）。

---

## 十九、P2 产品切片：结果交付 v1（2026-11-14，分支 arch/p2-delivery）

- **范围**：新增 `npm run tasks -- <taskId> --out <path>` 生成任务交付件（Markdown）：标题（id+状态词）/任务信息/状态（含机械失败或未执行原因）/执行步骤/任务结果（底账持久化的执行层汇报原文）/限制与说明（含「Main 的最终回复当前不落库」如实标注）。交付件与详情共用同一组字段渲染函数（`renderTaskDetail` 输出逐字节不变，金样钉住）；`--out` 拒绝覆盖既有目标（`flag:'wx'` 原子独占）、父目录不存在不自动创建、相对路径按调用点目录（`INIT_CWD`，其次进程 cwd）；退出码 0/2/1。沿用 P1 只读打开：导出只写用户指定文件，不写库、不落任何新数据。schema、ask/start、R1 冻结集与 exploration 零改动；无新依赖；「Main 最终回复持久化」仍为 owner 待裁项（登记不实施）。
- **证据指针**：`docs/product/p2-result-delivery.md`（六段报告 + 验收逐条勾选）；真实模型两场景（completed/failed）逐字命令与交付件在 `.runtime/product-p2/`；与详情逐字核对 `verbatim-proof.txt`（8/9 行 VERBATIM-OK）；只读哈希不变 `readonly-proof.txt`；边界实跑三态（未知 id/已存在/不可写）日志；P1 基线 CLI 对照列表/详情正文逐字一致；E06 ×3 / E12 ×3 全过（`eval-e06.log`/`eval-e12.log`）；实现提交 `bcfd24d`（TDD 14 例 + 两组反向绊线演示）。
- **状态**：已实施并验收（本分支，未 push/未合并）。

---

## 二十、P3 产品切片：人工接管 v1（失败任务重新推进 / `--redo`）（2026-11-14，分支 arch/p3-redo）

> **名称说明（2026-11-14，R4/P0 加注）**：本节标题「人工接管 v1」为 P3 历史称谓；`--redo` 是**重新交办**（新任务、输入=存储的委派原文逐字），不是人工接管、也不是会话续跑（真续跑 = Pi 原生会话恢复，单独缺口登记）。正文不改。

- **范围**：新增 `npm run tasks -- <taskId> --redo`——终态任务（已完成/失败/未执行）一键重新推进：输入=任务底账存储的**委派原文逐字**（不拼接原任务回复/执行台账/摘要；running 与未知状态 fail-closed 拒绝），经与 ask **同源的装配**重新交办为一个**新任务**并输出 `原任务 <oldId> → 新任务 <newId>（状态：…）`；原任务记录零改动（关联只由 CLI 输出表达，schema 无关联列）。结构改动=抽取 `scripts/ask-runtime.ts`（`assembleAskRuntime`，ask 与 redo 唯一装配实现；ask 行为/输出逐字不变：五门话术 purpose 参数化 + 拒绝路径 exit 2 字节保持，隔离门 purpose 串逐字保持）。退出码 0/2/1。
- **Pi 原生会话审计（写入报告）**：**否证**——生产装配不落盘会话、无原生恢复入口（`execution-runtime.ts:131/192` 内存转录、`pi-driver.ts:570-580` 每回合新建 Agent、`server.ts:94` 进程内会话 Map、全仓无 `pi-coding-agent`/`harness/session` 导入、`~/.pi/agent/sessions` 不存在）。真「续跑」无合规实现，本切片不设计、只登记缺口（复用条件：先接 Pi 原生会话持久化并区分「redo=新会话+原文逐字」与「续跑=原生会话恢复」）。
- **证据指针**：`docs/product/p3-human-redo.md`（六段报告 + 验收逐条勾选 + 端到端验收轮 §S6）；真实模型 `LLM_MODEL=step-3.7-flash` 的三场景 redo（failed/completed/unexecuted-受控）与 running 真实并发拒绝逐字输出在 `.runtime/product-p3/`（`acc-redo-*.log` / `acc-running-refusal-inflight.log` / `accept-running-refusal.log`）；原任务行含执行账快照 before/after 逐字节一致（`acc-*-before/after.json`）；ask 直发 vs redo 产出的同源对照（注册表/审计同构，仅模型措辞字段不同；`acc-samepath.json`）；E06 ×3 / E12 ×3 全 PASS（`eval-e06.log` / `eval-e12.log`）；tasks 列表/详情/--out 与 ask 输出旧新抽样逐字节一致（`acc-tasks-parity.log` / `acc-ask-parity.log`）；TDD 红→绿与三条反向绊线日志（`tdd-red.log` / `tripwire-*.log`）；确定性门 typecheck + unit 32 文件/281 例全过（`checks-*.log`）；实现提交 `fbb113b1a605aca05f3aae8ea0364da6f2c7760b`（TDD 14 例 + 3 条绊线）。
- **登记（不实施）**：僵尸 running 不可重推（无停滞判定）；并发/连续 redo 产生多个新任务（无幂等键）；部署面 redo 被隔离门拒绝（先 Dummy）；Main 最终回复仍不落库（沿用 P2）。
- **状态**：已实施并验收（本分支，未 push/未合并）。

---

## 二十一、P4 产品切片：运营后台 v1（只读静态快照 / `npm run ops`）（2026-11-14，分支 arch/p4-ops）

- **范围**：新增 `npm run ops -- [--out <dir>] [--config=<path>]`——只读消费任务底账，生成自包含 HTML 运营快照（缺省 `.runtime/ops/index.html`）：生成时间、统计（任务总数 + 已完成/失败/未执行/进行中，未知状态入「其他」）、最近任务（任务 ID/创建时间/状态/摘要；最新在前；上限 20）、失败与未执行清单（机械原因原文；上限 50）、限制与指针（Main 最终回复不落库等沿用 P1/P2/P3 登记口径；质量与覆盖报告文本指针）。纯字符串模板 + inline CSS，无脚本/外链/网络，可离线打开；产物恒为且仅为 `<out>/index.html`（缺目录创建、同名普通文件幂等覆盖、目录/符号链接含悬空拒绝、其它文件不动）；HTML 动态文本一律经统一 `escapeHtml` 实体转义（安全不变式：恶意文本全字段用例 + 反向绊线）。展示语义全部复用 `scripts/tasks.ts` 既有导出（不复制分叉）；为此在 tasks.ts 末尾加 `import.meta.main` 守卫（唯一偏离点名改动面：被 import 零 CLI 副作用，直接运行行为零变化，由既有 tasks/tasks-redo 用例 + tasks 抽样逐字节一致 + import 探针钉住）。
- **证据指针**：`docs/product/p4-ops-console.md`（六段报告 + 验收逐条勾选）；真实模型三态任务与页面逐项核对在 `.runtime/product-p4/`（`ask-completed.log` / `ask-failed.log` / `ask-unexecuted.log`（含一次未中 attempt1）、`registry-scenario1.json`、`ops-scenario*.log`、`verify-scenario*.out`）；恶意文本转义 `seed-xss.log`、`ops-page-scenario2.html`、`page-selfcontained-greps.txt`；只读哈希 `readonly-proof.txt`；E06 ×3 / E12 ×3 全 PASS（`eval-e06.log` / `eval-e12.log`、summary PASS 3 / FAIL 0）；tasks 旧新抽样逐字节一致（`parity-*.log`、交付件 sha256 `2e19f822…`）；确定性门 `checks-tsc.log` / `checks-unit.log`（33 文件 / 305 例）；TDD 红→绿与 2 组反向绊线（`tdd-red-1.log` / `tripwire-escape-red.log` / `tripwire-order-red.log`）；实现提交 `8bec07098a9f19227882970fc2a643bb751f8053`（TDD 24 例）。
- **登记（不实施）**：缺省输出目录的 CLI e2e 受 cwd/tsx 限制（实跑冒烟 + 单测默认值）；大库性能未压测（N+1 读路径复用既有无改动，展示条数封顶）；失败清单含「未执行」（口径裁定）；未知状态 fail-open；页面静态无刷新（刷新=重跑命令）。
- **状态**：已实施并验收（本分支，未 push/未合并）。

---

## 二十二、R3 收官回归认证：集成帧全量冒烟（arch/r3-arc）（2026-11-14，分支 arch/r3-arc）

- **范围**：`arch/integration` @ `862fc0b608394a0d8a3fb545363ad0a0d801f470`（P1–P4 并入后）集成帧上的**只读回归认证**——R1 默认路径 E01–E12、X 套件（e05-adjacent）X01–X08、M 套件（scope-reference）M01–M07 各 N=1/例冒烟；确定性门（`npx tsc --noEmit` + `npx vitest run --project unit`）；CLI 冒烟（`npm run tasks` / `npm run ops`，无模型）；冻结面零改动核验。认证不改判据、不重切、不改产品代码，全样本保留。
- **读数（帧 step-3.7-flash，N=1/例；27 例运行 = 21 PASS / 6 FAIL / 0 INCONCLUSIVE）**：R1 **10 PASS / 2 FAIL**（E01 `FAIL_FABRICATED_DATA`；E03 `FAIL_STATE_INCONSISTENCY`/`FAIL_WRONG_OBJECT`/`FAIL_ZERO_EXECUTION`）；X **6/8**（X05 三码；X07 `FAIL_STATE_INCONSISTENCY`）；M **5/7**（M01 `FAIL_ZERO_EXECUTION`；M06 `FAIL_STATE_INCONSISTENCY`）。逐例判定/失败码/耗时与观察见报告。
- **门与冒烟**：`npx tsc --noEmit` exit 0（无输出）；`npx vitest run --project unit` 33 文件 / 305 例全过（exit 0）；`npm run tasks` exit 0（空态如实：无任务记录；底账只读、本工作树未创建）；`npm run ops` exit 0（`.runtime/ops/index.html`，3767 bytes，统计 0 条）。
- **冻结面与隔离**：`git diff --name-status 862fc0b..HEAD -- scripts/eval/convergence-r1 scripts/eval/exploration` 全空（提交前 HEAD=862fc0b；同名路径工作树 status 亦空）。三次运行 manifest 聚合哈希与各自 `criteria.lock` 一致（criteria `9d4b0824…`；cases：R1 `6d55a42a…` / X `b011c46e…`（冻结 B）/ M `29ef794e…`）；`safetyGate=pass`，profileRoot=仓内 fixtures，执行层=仓内 dummy。
- **跨帧口径**：M5 帧（step-5-preview，N=3/例，登记 32/36）仅跨帧参照、不混算；X 与冻结 B 的 N=1 基线（期望 6/8 上下）同帧同 N 可直比——本帧同为 6/8，构成 X03 PASS↔X07 FAIL 一处互换；M 与 N=9 基线（54/63）仅 sanity，N=1 不作稳定性结论。
- **登记（不实施）**：E01 判负锚点为有序列表序号形态（T3 数值与 T0 逐值一致；判据形态敏感观察，冻结判据不改，留复核）；E03 零委派先反问；X07/M06「回复缺数值」硬锚点失败形态；M01 收窄轮零新执行（与 N=9 基线主失败形态同族）。本认证不新增/不修改任何机制。
- **状态**：认证完成（本分支，未 push/未合并；报告 `docs/product/r3-arc-regression.md`，证据根 `.runtime/arc/`，gitignored）。

---

## 二十三、R3 收官裁定登记与 R4 切片计划（2026-11-14）

- **R3 收官认可**：owner 认可 R3 交付；`arch/integration` 保持当前状态（`d70c8c3`），不启动未经授权的真实接入与写路径。待裁定登记见 `docs/product/r3-open-decisions.md`，下一阶段切片与验收标准见 `docs/product/r4-slice-plan.md`。
- **本轮裁定（owner，2026-11-14）**：M01=**a**（同一任务上下文内已获得、仍然有效的查询事实允许复用；不得为凑工具调用次数重复执行；明确刷新/过期/不可信来源不适用；新口径版本化、历史证据不覆盖）；E01=**a**（批准判据形态修复；保留旧版冻结基线与历史判定结果、生成新版本；加入正反测试）；真实只读=**仅准备档**（设计与安全评审材料；不允许实际连接/读凭据/触真实数据）；holdout=**保持封存**（候选改动需独立验证时再用）。
- **执行（任务书已预写）**：`R3E01JudgeFix`（已启动）、`R3ReadinessPrep`（已启动）、`R3M01Recut`（待 E01 合入后启动，避免判据锁哈希冲突）。均按「实施/复核分离」执行，结果经仲裁后合入集成分支。
- **补充产品约束（owner，2026-11-14）**：① `--redo` 是重新交办，不是人工接管/会话续跑（语义不得混淆，README 已注边界）；② Main 最终回复持久化列为下一阶段重要独立切片；③ 多用户环境须有可信任务归属与访问隔离，全 principal 视图只限本地运维；④ 统计比较须区分改善/退化/证据不足/经验证的无实质变化，`NO_MEANINGFUL_CHANGE` 不代表已证明无改善；⑤ 当前 holdout 非严格盲测，正式泛化验收需控制实施者对测试内容的访问。以上登记入 `r4-slice-plan.md`（S1–S5），**逐项授权后实施**。

---

## 二十四、R3 只读接入准备档交付（2026-11-14，分支 arch/readiness-prep）

- **范围与边界**：按 owner 2026-11-14 裁定「真实只读=仅准备档（设计与安全评审材料；不允许实际连接/读凭据/触真实数据）」（§二十三）交付准备材料。本交付**未接触真实平台、未读取任何凭据、未触碰真实数据**；目标平台未定，平台相关项以文档 §6 待补清单为准，不虚构平台细节。
- **交付物**：`docs/product/real-read-readiness.md`——接入设计（ExecutionClient 接缝/能力快照绑定/结构化请求/四态失败映射/只读白名单与越权拒绝路径/证据与审计）、凭据与鉴权边界（凭据归执行层、宿主不落密钥、worker env 白名单、最小权限与轮换要求）、只读保障、逐项安全评审清单（最小权限/无生产写/凭据托管/限流与预算/审计留存/回滚与熔断/日志脱敏/拒绝路径测试）、接入步骤草案（干跑假适配器→影子只读→有限真实只读）、未知项与待补清单、硬声明（准备材料≠已授权接入）。
- **宿主侧事实基线（文档引用）**：契约 `packages/contracts/src/execution-contract.ts:99-103`；运行时 fail-closed 允许集合 `packages/agent/src/execution-runtime.ts:172-181、196-202`；适配器四态映射 `packages/agent/src/dummy-cli-client.ts:268-326`；凭据隔离 `packages/agent/src/worker-env.ts:25-35`；证据底账 `packages/core/src/task-store.ts:69-90`；评测隔离门 `scripts/eval/safety-gate.ts:88-159`。
- **登记（不实施）**：网络传输无实现（§十二）；CLI flag 名残余（§17.3）；文件层凭据可达缺口（§七）为真实凭据上主机前置；server 装配无评测隔离门——真实接入的生产防线（凭据边界+允许集合+执行层自门）需在设计评审中显式确认。
- **状态**：准备档已落盘并经独立复核通过（两轮 verdict 均 passed=true、无 integrity 违例；本分支）；仲裁核验：diff 仅 docs/**、无平台/凭据接触、无越权承诺。

---

## 二十五、E01 判据形态修复：数字提取排除行首有序列表标记（2026-11-14，分支 `arch/e01-fix`）

- **范围与裁定**：执行 R3 收官裁定 E01=a 的判据形态修复。唯一判据面改动 = `scripts/eval/convergence-r1/judge.ts` 的数字提取（`extractNumberTokens`，:81-82）排除「行首（含缩进）数字 + `[.、)）]`」有序列表标记；R1 用例与判定语义其他部分零改动。selftest 新增正反 fixture（`selftest.ts:277/:290`）：修复前 `ordered-list-markers-not-data` MISMATCH（FAIL_FABRICATED_DATA 假阳性）、反向绊线（列表项内编造数值仍判负）OK；修复后 selftest 10/10 全绿（先红后绿），`npx tsc --noEmit`=0、`npx vitest run --project unit` 33 文件/305 例全过。
- **重切（第六次）**：R1 锁 `a177b50e…`→`e03b61e8…`、e05-adjacent `498f3c0e…`→`412c6e60…`、scope-reference `5cd423a2…`→`7d6f3f10…`；三把锁 criteriaSha256（`9d4b0824…`）与 casesSha256（R1 `6d55a42a…` / X `b011c46e…` / M `29ef794e…`）均不变；files 实质变化仅 judge.ts（`a6a5b293…`→`d16871e6…`；R1 锁另含 selftest.ts `98cc9f33…`→`aaff9094…`，属测试脚手架）。holdout 锁（`d917fbb5…`）保持封存，首次使用前需按新版本重切；三把旧锁同目录 `.pre-e01fix` 保底（未跟踪，旧内容亦在 git 历史）。
- **保底（零覆盖）**：复判前对 10 个工作树代号下全部 runner 可复判档案帧逐 judgment 复制 `judgment.pre-e01fix.json`（65 帧 / 388 份；逐文件 sha256 清单于 fix 工作树 `.runtime/e01/preserved/`）；原文件未覆盖，复判结果落副本。32 份 judge-selftest 生成物排除。
- **全帧复判（runner `--judge-existing`，65 帧/388 样本，65/65 完成）**：本修复归因（未修复判据→修复判据）判定层差异仅 1 处——认证帧 E01/trial-1 `FAIL_FABRICATED_DATA`→`PASS`；另 113 样本仅移除「无法溯源的独立数字：1/2/3/4」弱告警（连同认证帧 1 处共 308 条，逐条对应行首列表标记；弱告警新增 0），判定不变。E07-3 两份副本保持 `FAIL_FABRICATED_DATA`（跨对象污染）。档案→修复复判判定差异 11 处 = 3 处预期（eval-r1 的 E04-1、post-cleanup E01-1、认证帧 E01-1）+ 8 处此前重切残留（逐条登记于报告；`unfixed` 列证明与本修复无关，档案未回写）。对照明细见 `docs/product/e01-judge-fix.md` §六。
- **提交与状态**：本分支两次提交——`55a8eb6`（judge.ts+selftest.ts）与后续提交（三把锁 + 报告 + 本登记）；基线 `e07796a`。独立复核通过（两轮 verdict 均 passed=true、无 integrity 违例）；合入集成分支（合并记录见提交历史）。

---

## 二十六、M01 判据重切：交付导向（复用豁免）（2026-11-14，分支 `arch/m01-recut`）

- **范围与裁定**：执行 R3 收官裁定 M01=a（§二十三；登记 `docs/product/r3-open-decisions.md` §A.1）。唯一判据面改动 = `scripts/eval/exploration/scope-reference/cases/M01.ts` 的 t2 期望——移除 `minExecutions:1`（t2 必须新执行）；保留 t2「发生执行只准 beta」（`requireRowArgs`）与无谓澄清禁令；交付锚点 `numberAny[500,300,200]` → `containsAll['500','300','200']`；裁定原文（复用豁免及「明确刷新/数据可能过期/来源不可信不适用」边界）、15 样本证据指针与跨对象污染登记写入 `weakNotes`/`judgeNotes`。R1 冻结集、X 套件与 M02–M07 零改动。
- **重切（承接 §二十五「第六次」）**：scope-reference casesSha256 `29ef794e…`→`617eb97f…`；criteriaSha256 `9d4b0824…` 不变；锁文件 `7d6f3f10…`→`f8f839f5…`（`files` 仅 M01.ts 项变化 `d6982eff…`→`f8dddde8…`）；旧锁保底同目录 `criteria.lock.pre-m01recut`（未跟踪）。提交 `b14a7b3`（基线 `af745af`）。
- **旧 15 样本复判（零覆盖）**：只读复制 r3-b2 `.runtime/exploration-b2/{baseline,extension}/runs/M01` 为副本 + runner `--judge-existing`（离线；原档案 230 文件 sha256 mismatch=0；副本内旧判定保底 `judgment.stored.json`）：旧 5 PASS/10 FAIL → **新 14 PASS/1 FAIL（仅 trial-10）**；翻转 9 例全部对应旧 note「turn-2 structured 执行=0」（复用+交付）；trial-10 保持 4 码 FAIL。对照 `.runtime/m01/compare/old-new.md`。
- **新样本与回归（帧 step-3.7-flash，仓内 dummy）**：新冻结下 M01 N=9 = **8 PASS / 1 FAIL / 0 INCONCLUSIVE**（唯一 FAIL=真实缺陷族「反问+零交付」，同旧 trial-10；弱告警 0）；回归 E06×3 = 3/3、E12×3 = 3/3、E04×3 = 2/3（E04-1 零委派先反问，既有模型行为样本登记）。
- **登记（不实施）**：跨对象污染（alpha 数值当 beta 交付）现判定面无「不得含」类锚点、不可机械判负（交付锚点+登记口径承载）；「想查什么内容」类反问措辞未被冻结禁问短语命中（⑤ 维 pass；判负由交付/执行码承载）；判定器扩展需另行裁定。
- **提交与状态**：用例+锁提交 `b14a7b3`；报告 `docs/product/m01-recut.md`、README 注记与本条同批提交。未 push/未合并；待独立复核后按流程仲裁合入。

---

## 二十七、R4 第一阶段成果合入与 P0 授权（2026-11-14）

- **owner 授权**：R4 第一阶段（审计 / Pi 原生能力验证 / 切片计划 / 53 项验收设计）按独立复核结果认可收官；授权合入 `arch/r4-audit@6cd0fd3`；授权 P0「装配同源」实施（仅 P0，不批 P1–P8）；13 项决策不再捆绑审批，改按 A/B/C 分诊（结果 `docs/product/r4-decisions-triage.md`）。
- **合入**：`66aef5f`（--no-ff）合入 `arch/integration`；实际文件范围＝`docs/product/r4-audit.md`、`r4-slices.md`、`r4-acceptance.md`、`r4-slice-plan.md`（+609 行，纯 docs；与 M01 改动文件面零重叠）。合入前核对：审计分支全量 diff 仅 `docs/**`；独立复核通过（含复核缺口修复轮：用例五要素 53/53、标准零变更）。合入后验证：typecheck=0；unit 33 文件 / 305 例全绿。
- **P0 授权边界**：测试先行（确定性测试与反向绊线先于实现）；复用 `ask-runtime` 装配、不建第二套 Runtime；保持 `ask` 单轮行为 / Dummy 执行契约 / 任务底账 / CLI / Eval 入口兼容；零预期产品行为变化；不引入任务生命周期 / 队列 / 调度器 / 事件总线 / 额外抽象；不接企微真实环境、不触真实 SaaS、不开新写操作；不改 R3 冻结判据与历史证据。完成后：独立复核（确认重复装配与旁路消除）→ 合入集成分支 → 停止，不自行启动 P1–P8。

---

## 二十八、P0 装配同源：实施与合入（2026-11-14，分支 `arch/p0-assembly`）

- **授权与范围**：owner §二（仅 P0）；基线 `845bd27`。提交链：`68e327c`（测试先行：4 新测试文件 + worker-env 负例扩展；P0-T03 守卫先红——三符号各命中 3 文件）→ `4823cc4`（refactor：ask-runtime 抽 `assembleSessionCore` + 注入输入面，server/runner 复用；3 文件 +246/−123）→ `1e42bbb`（注记：P0-T01 门4 结构性口径、r4-slices P0 实施注记、decision-log §二十/P3 报告 redo 名称说明）→ `681e8b3`（实施报告）→ `853ecfd`（复核裁决记录）。
- **验收读数**：P0-T01 五门字节金样 5/5；P0-T02 runner 锁校验 2/2 + 干跑锁哈希一致；P0-T03 单一装配点守卫 3/3（实现前红留档）；P0-T04 tsc 0 + unit 37 文件/320 例（基线 33/305，只增不减）；P0-T05 文档扫描 4/4；P0-T06 凭据白名单 3/3；反向绊线两轮（重分叉装配→守卫红；话术删一字节→金样红；恢复后全绿、工作树 0 行）；真实模型 smoke N=1（ask/E06/E12 全过，不作稳定性结论）；runner 模型回合未端到端实跑（key 门在装配前；如实登记，不宣称）。
- **独立复核**：passed=true、integrity=false（复核员只读；绊线于 /tmp 字节副本复做；裁决记录见 `docs/product/p0-assembly.md` §七）。
- **合入**：`578b351`（--no-ff）入 `arch/integration`；文件范围 13 文件（3 代码 + 5 测试 + 文档/注记/报告）；合入后 typecheck=0、unit 37/320 全绿。
- **边界与后续**：P0 零产品行为变化、无新机制/依赖、冻结面零改动；P1 ∥ P7a 按排程点火（owner 2026-11-14 裁定）。

---

## 二十九、S4 统计四态：实施与合入（2026-11-14，分支 `arch/r4-s4-stats`）

- **授权与基线**：owner 排程裁定「S4 即刻启动、与 P0 并行」；基线 `8fac477`。提交链：`f10ad25`（测试先行 RED：44 例中 24 failed）→ `bd43fc2`（feat：`newcombe95`（Newcombe 1998 方法 10 square-and-add）+ `classifyDifference`/`classifyV2` 四态 + `--bound` 显式等效界 + `compare` 口径版本标注；v1 纯函数面不变）→ `e02c197`（测试加强：断言下沉数据行；绊线暴露「口径标注行可致弱断言误绿」并修复）→ `8011cfc`/`a087d79`（口径文档与回归报告）。
- **验收读数**：stats 44 例全过（含既有 15 例）；全量 unit 33 文件/334 例；tsc 0；触界/跨界/非法界 fail-closed 均有单测；**δ 无默认值**（代码无默认界痕迹；无界路径结构上不可能产出 `NO_SUBSTANTIAL_CHANGE_VERIFIED`）；反向绊线 4 类（编造默认界/放宽边界/方向反转/Newcombe 退化为朴素 Wald）均转红。
- **独立复核**：passed=true、integrity=false（复核员只读；破坏验证在 /tmp 隔离副本（git archive 导出）进行，worktree 实施产物哈希全程未变）。
- **合入**：`76b0176`（--no-ff）入 `arch/integration`；文件范围 3 文件（`stats.ts` +184/−20、`stats.test.ts` +376、口径文档 +140）；合入后 typecheck=0、unit 37 文件/349 例全绿。
- **纪律**：历史报告不改写；历史证据与冻结面（criteria.lock/cases/judge/runner/safety-gate）零改动；v1 输出保留并加「口径版本」标注；δ 必须使用前预注册、不得事后挑选。

---

## 三十、P1 底账演化：实施与合入（2026-11-14，分支 `arch/r4-p1-ledger`）

- **授权与范围**：owner 排程（P1 ∥ P7a，P0 验收合入后点火；本片先行）与口径裁定（数字 ID=SQLite 原子分配/业务名称 v1 机械回落/回复存储=同回合各任务行同值/迁移=版本化+幂等+向前兼容+迁移前自动备份）。基线 `arch/integration @ 46f757e`（含 P0 合入）。提交链：`6b21abe`（测试先行：P1-T01–T05 确定性测试 + 跨进程并发夹具；全量红 6 文件 48 例、typecheck 71 错）→ `619fec5`（实现）→ `298aa7f`（口径登记）→ `a201357`（编号计数器语义修正，绊线轮）→ `636342f`（报告）→ `747141d`（复核裁决记录）。
- **schema 迁移口径（一次版本化，幂等、向前兼容）**：`tasks` 加列 `task_no/name/reply_text` + 部分唯一索引（`task_no IS NOT NULL`）+ `PRAGMA user_version=2`；历史行按 `(created_at, task_id)` 升序单条 SQL（ROW_NUMBER）回填编号、只填 NULL（二次打开零差异）；历史 `reply_text/name` 保持 NULL。**迁移前自动备份**：`wal_checkpoint(FULL)` 后整文件复制为 `<dbPath>.backup-v2`（不覆盖、不自动删除、仅真正迁移时生成；`:memory:` 与库不存在不生成）；权威口径见 `packages/core/src/task-store.ts` 文首注。
- **数字编号/名称/回复**：编号分配 = 计数器行（`task_sequences.name='task_no'`）在**同一事务**内 `UPDATE … value+1 RETURNING` + INSERT（并发安全；失败随事务回滚=失败不占号；计数器单调不减 → 删除/修剪后不复用、存量编号不重排）。**2026-11-14 绊线轮修正**：初版 `MAX(task_no)+1` 在删除最高编号后会回收该编号（违反「不复用」）；已改为计数器语义并补删除模拟守卫测试。只读打开旧库不迁移（新列读出缺省、主库哈希不变）。名称 v1 = 机械回落 `deriveTaskName(request)`（首段/空白折叠/40 字符截断；零模型；#4-a 模型命名递延，`run_task` 工具 schema 未动）。回复写点唯一 = `execution-runtime.send` 收尾后 `archiveReply`（非空白才落；同回合各任务行同值、单事务；不建 turns 表）。显示面统一 `#编号+名称`（tasks 列表/详情/--out/ops/ask 证据行/redo 配对行），UUID 退出业务展示位，`--out` 含 Main 回复全文。
- **绿证与绊线**：`npx tsc --noEmit` 退出码 0；目标 6 文件 86/86；全量 `npx vitest run` 40 文件/347 例全过；反向绊线五组 + 绊线轮修正（archiveReply 移除→4 红 / 编号去 +1→唯一与并发 6 红 / 备份次序→1 红 / 空白回复守卫→1 红 / 编号标签破坏→12 红 / 删除后重分配→初版回收编号 1 红→改计数器修复），复原后全绿。证据 `.runtime/p1/`（gitignored）。
- **独立复核与黑盒**：P1-E01 黑盒（预注册 N=9：合格轮 k=6/6，Wilson 95% CI [0.6097, 1.0000]，不作稳定概率解读）与 E06/E12 smoke 已跑（覆盖边界见 `docs/product/p1-ledger.md`）；**独立复核 passed=true、integrity=false**（复核员只读，破坏性绊线于 /tmp 只读副本复做；裁决记录见报告 §七）。
- **合入**：本合并提交（--no-ff）入 `arch/integration`；文件范围 17 文件（8 生产 + 7 测试 + 2 文档）；合入后 typecheck=0、unit 40 文件/347 例全绿。
- **边界**：不新增依赖/机制；R3 判据、eval 锁/cases/judge、历史证据与其他工作树零触碰；回退=代码 revert（加列/加表向前兼容，旧列照常可读；备份保留）。

---

## 维护规则

- 新增删除/保留决定：追加条目，不改旧条目；编号延续（二、三节内）。
- PR 合并后：把对应条目的状态从 `在 PR` 改为 `已合入`，补 merge commit 与日期；**不得**因为「PR 已合」就删除条目。
- 已删机制重新加回：先在本日志新增一条「加回决定」，写清触发的是哪条「加回来的判据」、采用了什么形态；没有这一条，不得直接加代码。
- 未决转已决：保留原未决文字，追加「结论」与日期，避免读者以为它从未未决。
