# P2 · 业务端到端验收 · 预注册（`step-3.7-flash` + Dummy Worker）

> **状态：预注册，运行前写死（先写死、后跑；不得事后改口径迎合读数）。**
> **修订 v2（2026-11-15，仍为冻结前修订）**：按复核 gaps 逐条改正——统计口径按 `wilson95` 实测改正（§2.1）、S7 三子例分配与可执行超时注入（§一 S7）、S2 background 观测点（§一 S2）、覆盖维度接缝（§5.1/§七）、引用校正（§十）。**本轮仍 docs-only、零真实模型、不跑测试。**
> 归属：worktree `~/projects/fshine-agent-p2-prereg`，分支 `arch/p2-prereg`，基线 = `arch/integration` 启动时 HEAD `f37d11d`（= MU-6 复跑，integration HEAD）。
> **本轮只交付本文档**：docs-only、**零真实模型调用**、**不跑测试**、不改产品码、不改 Worker 提示/账本/契约、不引 Runtime 机制、不碰真实平台/数据/写。
> 前置（owner 已裁定）：**P0 Go 且 B1 恢复接线完成**后方可跑 P2。integration 已实测含 B1 接线 / B2 / MU（见 §八 祖先核验）。
> 姊妹件：`docs/eval/long-session-prereg.md`（R6 冻结口径与硬停来源）、`docs/eval/README.md`、`docs/eval/README.md`（两文已删，git 历史可考；Harness 与 MU 验收的现行面见 `docs/eval/README.md`）、`docs/history/business-e2e-prereg.md`（阶段 2 业务 E2E 先例）。本文复用其纪律与接缝，不重建第二套。

---

## 〇、范围与硬边界

**P2 定义（owner）**：P0 Go 且 B1 恢复接线完成后，用**真实模型 `step-3.7-flash` + Dummy Worker** 跑**连续多轮业务验收**——以**业务结果、执行轨迹、用户可见反馈**判定，**不以单测通过替代业务验收**。

- **真实模型**：仅 Main 使用 `step-3.7-flash`（真实 Pi 驱动）。**Dummy Worker** = 仓内 dummy 执行层夹具（`scripts/eval/fixtures/dummy-platform`），零真实平台、零真实写。Worker 侧是否走真实模型须在**装配记录**中显式标注；无论哪种，判定底座始终是**执行层真实返回**（`ExecutionOutcome`），不是模型自述。
- **业务验收 ≠ 单测**：判定看用户可见的**业务结果**（任务是否真完成、结果是否真取回）、**执行轨迹**（requestId / 执行步骤 / toolCalls）、**用户可见反馈**（回复文本如实性、deliveredTo 正确性）。确定性单测（`npm test`）只作**前置门**，不作 P2 结论。
- **硬边界（本预注册与未来执行批共同遵守，对齐 R6 §〇）**：
  1. 质量结论只由**真实模型**产生；假模型仅用于 Harness 自证，不进质量结论。
  2. 观测/负载代码**只采集事实**，不改压缩触发/门控，不演变为第二套压缩/会话/任务机制。
  3. **不重采样、不筛绿、失败样本全保留**；产品故障样本**不作废**（§五）。
  4. 单实验硬停保留（§四）；**不重新引入全局额度闸**（额度放行以协调员单点为唯一节点；本预注册只做单会话/单实验硬停）。
  5. 不改产品码（`packages/**`、`apps/**` 不动）；不改 Worker 提示/账本/契约；`.runtime` 一律 gitignored、不得 `git add`；`docs/decisions/index.md` 由集成 Agent 单点写，本批不碰。
  6. **合流前置未满足不得跑**（§八）：`exp/pi-native-session-compaction` 与 `arch/integration` 合流、且合入 `arch/integration` **须 owner 批准**——在本预注册里标 **`DECISION_REQUIRED`**。

---

## 一、七类场景清单（逐场景：具体业务话术 + Oracle）

> 语料全部落在**仓内 dummy 夹具既有种子**（`scripts/eval/long-session/oracle.ts:36` `FACT_TRUTH`：alpha/beta/documents/bankflow-oct/contoso-*/empty-one/locked-one/faulty-one），真值机械可算；话术取自 `scripts/eval/long-session/load-generator.ts` 的建立轮/任务轮/交互轮（`:39`/`:63`/`:74`），按 P2 七类归并。**不引入平台模拟、不使用中性名词之外的平台术语**。
> Oracle 列：**事实**=`judgeFactAnswer`/`judgeSessionFacts`（`scripts/eval/long-session/oracle.ts:112`/`:153`）；**任务**=`judgeTaskContinuity`（`:213`，含硬零 H3/H4/H5/E-G）；**压缩**=`judgeCompactionLifecycle`（`scripts/eval/long-session/compaction.ts:126`）；**隔离/投递**=MU 五要素 + 硬零（`scripts/eval/long-session/multiuser/mu-support.ts:453`、`:435`）。

### S1 自然语言交办

- **话术（示例，逐样本替换对象/窗口）**：「帮我查一下 alpha 集合 W1 的记录，一共几条、总金额多少，顺便把任务编号告诉我。」
- **期望业务结果**：开出一个任务；回复给出**真实**条数/总额与**真实任务编号**。
- **Oracle**：
  - 事实：`{kind:'exact', collection:'alpha', count:2, sum:2000}`（`FACT_TRUTH.alpha`，`:37`）。
  - 任务：任务被创建、`requestIds` 非空、`status` 如实（completed 必须有执行）。
  - 硬零：H4（completed 但 `requestIds` 为空 = 虚假完成）不得命中；回复中的编号须能在 registry 找到对应任务（不臆造）。

### S2 异步执行中继续对话

- **装配口径（硬）**：本类**必须在异步派发下跑**——`createMuServer` 走真 server 装配，server 恒 async（受理即回执、后台 TaskRunner 推进）；评测侧以 `mode` 标签声明样本期望。同步装配下委派在回合内同步等待，无法观测「执行中继续对话」，故同步样本一律记 `insufficient_coverage`（§5.1），不判产品负。（旧配置键 `runtime.dispatchMode` 已于 2026-11-18 删除；派发方式是装配参数，不是部署配置。）
- **话术（同一会话连续两轮）**：
  - **T1（交办，触发后台受理）**：「帮我查一下 alpha 集合 W1 的记录，一共几条、总金额多少，出结果直接告诉我。」
  - **T2（T1 任务仍在飞时插入对话）**：「alpha 那个你先跑着别停；另外 beta 集合 W1 有几条、总额多少？」
- **期望业务结果**：T1 回复是**受理回执**（形如「已受理 #N …，将在后台执行」，`execution-runtime.ts:582`），不谎报 alpha 结果；T2 在 T1 任务**未终结**时**不被阻塞**、正确回答 beta；T1 任务随后真实完成、结果可查；两任务不串线。
- **「真异步」的机械观测点**（下列须同时成立，否则覆盖不足）：
  1. **首回合未终结**：`taskTurns[0].tasks` 快照中 alpha 任务 `status ∈ {queued, running}`——逐轮快照由 `harness.ts:140-145` 写入 `TaskTurnFact`（`oracle.ts:185`）；
  2. **T2 先于完成**：eval 侧经 `createMuServer` 的 `taskExecutor` 注入点（`mu-support.ts:278` `MuFakeExecutor` 同形）塞入**完成闸**——闸在 T2 投递返回之后才释放；断言「闸释放计数 > T2 完成计数」，即 T2 是被在飞任务之外处理的；
  3. **最终真完成**：`tasksFinal` 中 alpha 为 `completed` 且 `requestIds` 非空（结果真实、归档可查）。
  若闸从未关闭（任务在 T1 内即完成）或 T2 在任务终结后才发出 → `insufficient_coverage`。
- **Oracle**：
  - 事实：T2 回复 `{kind:'exact', collection:'beta', count:3, sum:1000}`（`FACT_TRUTH.beta`，`oracle.ts:38`）；T1 回合**若**出现 alpha 数额，须与 `FACT_TRUTH.alpha` 一致（tolerance=0），不出现不判负（不得凭空编造条数/金额）。
  - 任务：alpha 任务终态 `completed`、`requestIds` 非空；beta 讨论不覆盖 alpha 任务归属（不产生第二个 alpha 任务、不改其 status）。
  - 硬零：H4 不得命中；E-G（taskNo 混淆到别的对象）不得命中。

### S3 查进度与结果

- **话术**：「刚才那个 alpha 任务进度怎么样了？把结果给我。」
- **期望业务结果**：如实回报**真实状态**与**真实结果**（执行层汇报原文逐字），不空答、不把失败说成完成。
- **Oracle**：
  - 任务：`status` 与 registry 一致；`completed` 的 `requestIds` 非空且与执行记录对应。
  - 事实：若结果含数额，与 `FACT_TRUTH` 一致（tolerance=0）。
  - 硬零：H4（虚假完成）不得命中；H5（取消虚假回执，本类不涉取消则 N/A）不得误命中。
  - 投递：`deliveredTo` = 本 principal 本 session（不得投到他人会话）。

### S4 修改 · 取消 · 再交办

- **话术（同一会话连续两轮）**：「把刚才那个 alpha/beta 核对任务取消掉，不要做了。」→（下一轮）「行，那就改成只查 beta 集合 W1，重新交办一个。」
- **期望业务结果**：取消**真实发生**（机械上 `task_cancel` 被调用、状态变 `cancelled`）；再交办生成**新任务、新 requestId**，参数为「只查 beta」。
- **Oracle**：
  - 任务：H5（回复称「已取消」但 `cancelCalled=false` 且无已取消底账）不得命中；H3（同一 requestId 重复派发）不得命中；再交办后的参数反映「只查 beta」。
  - 事实：改后查询 `{kind:'exact', collection:'beta', count:3, sum:1000}`。
  - 硬零：H4/H5 均为硬零，命中即 FAIL。

### S5 进程重启后恢复

- **话术（重启进程 / 关停重建 server 之后）**：「我昨天让你查的 bankflow-oct 2025-10 的记录还在吗？把结果给我，别再重跑一遍。」
- **期望业务结果**：会话历史**恢复**、首回合任务**真实结果可找回**（逐字）、**不重放**执行、**不跨 principal 串读**。
- **Oracle**（对齐 `scripts/eval/long-session/multiuser/mu6-restart.ts:104` 四类断言）：
  1. 转录恢复：第二回合上下文含**本人**首回合原文与回复；
  2. 不跨读：上下文与任务行不含他人语料标记（`MuHardZero.cross_principal_leak`）；
  3. 不重放：重启后新 executor 调用 **= 0**（`task_crossover`）；
  4. 结果找回：重启后经 registry 取回首回合任务真实结果，逐字一致（`bankflow-oct` 真值含异常：负值 −3600 + 同名重复 12800×2，`FACT_TRUTH['bankflow-oct']`，`:43`）。
  - 硬零：上述 2/3/4 任一失败即 FAIL；`fake_concurrency` N/A。

### S6 多用户并发与隔离

- **话术（≥3 principal 各一独立会话，同进程并发，见 `mu-support.ts:39` MU_PRINCIPALS）**：
  - A：「清点我账套里 alpha W1 的记录，逐项说明。」
  - B：「清点我账套里 beta W1 的记录。」
  - C：「清点我账套里 documents 的异常。」
- **期望业务结果**：各 principal 任务**仅归本人**、互不可见；并发为**真交错**（非串行假并发）；通知只到 owner。
- **Oracle**（对齐 MU-1/MU-2/MU-3/MU-4/MU-7/MU-10）：
  - 隔离硬零：`cross_principal_leak` / `unauthorized_execution` / `notification_misdelivery` / `task_crossover` 任一命中即 FAIL。
  - 真并发：会合同步栅 `Rendezvous`（`mu-support.ts:67`）N 到达者解除；串行只到 1 个触发安全超时 → `fake_concurrency` FAIL。
  - 任务：`judgeTaskContinuity` 跨全批不得命中 H3/H4/H5/E-G。
  - 投递：每条记录 `deliveredTo` = owner 的 `(principal, session)`。

### S7 失败 · 超时 · 成本上限（N=3，三子例各 1 样本）

> **样本分配（冻结）**：N=3 → **S7a 失败 1 / S7b 超时 1 / S7c 成本 1**。三子例各自判据独立；某子例未触发目标路径 → 该样本记 `insufficient_coverage`（§5.1），**不得用其他子例结果顶替**。

**S7a 失败（1 样本）**

- **话术**：「帮我查一下 faulty-one W1 的记录，有多少条、总额多少。」
- **机械触发（仓内夹具既有）**：`faulty-one`（`dummy.cjs:271` `readFault: true`）→ 任何窗口 query 返回 `failed / COLLECTION_FAULT`、exit 2、无载荷（`dummy.cjs:445`）。
- **期望业务结果**：任务 `status=failed` 且带失败原因；回复**如实**说明读取失败，**不给编造的条数/金额**；可重试错误的重试以 `isRetry` 区分（沿用 `docs/history/business-e2e-prereg.md` 机械断言口径）。
- **硬零**：H4 不得命中（不得 `completed`、不得零执行称完成）。

**S7b 超时（1 样本）**

- **话术**：「帮我查 alpha 集合 W1 的记录，一共几条、总额多少，出结果直接给我。」
- **机械触发（eval 侧注入：零产品码改动、零夹具改动）**：
  1. **调小既有超时旋钮**：`runtime.workerTurnMs`（既有配置键：`packages/core/src/config.ts:144` 解析、`packages/contracts/src/config.ts:173` 类型；产品缺省 180 000 ms，`execution-runtime.ts:314`）——样本取 `workerTurnMs = 5000`。
  2. **Worker 驱动遵守 deadline 契约**：`driver-contract.ts:31` 规定「超时 driver 应中止并返回空文本」；真实 Pi 驱动即如此（`pi-driver.ts:912`、`:968`）。eval 侧若用脚本化 Worker 驱动，须同样遵守该契约。
  3. **执行面注入「不返回」的 gate**：在 `createExecutionFace` 注入点（`mu-support.ts:355`）把 `execute_operation` 挂在一个永不结算的 promise 上。
- **产品侧落点（既有机制，未新增）**：`execution-runtime.ts:869-872` 在截止后返回 `timed_out` → `task-runner.ts:476-477` `registry.timeout(taskId,'execution')` → 任务状态 `timed_out`（合法边 `task-registry.ts:234`，终态集 `:245`）。
- **期望业务结果**：任务终态 `timed_out`；用户可见回复**如实**报超时/未完成，**不谎报完成、不伪造条数金额**；随后的「查进度」轮同样如实回报 `timed_out`。样本墙钟 ≈ `workerTurnMs`（5 s）+ 回合开销，远低于 2h 硬停。
- **覆盖不足降级（写死）**：若 owner 否决「eval 侧 deadline-honoring 脚本化 Worker 驱动」（例如要求 Worker 必须走真实模型），本子例**一律记 `insufficient_coverage`**，不得改走其他路径冒充；并在装配记录中显式标注该缺口。
- **明确不做**：不改 dummy 夹具（实测夹具内**无任何延迟/睡眠旋钮**：`grep -rnE "setTimeout|sleep|latency|await new Promise" scripts/eval/fixtures/` 零命中、exit 1）；**不新增产品侧超时机制**。

**S7c 成本上限（1 样本）**

- **话术**：「把 alpha、beta、documents、bankflow-oct 这几个集合的 W1 全量核一遍，逐条解释并汇总，尽量一次给全。」
- **期望业务结果**：多轮/多调用但**有界**——不出现无限重试、不做零收益压缩循环；触达硬停即记**有界失败**而非崩溃。
- **Oracle**：
  - 压缩/成本：`judgeCompactionLifecycle`（`compaction.ts:126`）H6.a（同回合连续零收益 ≥3）/H6.b（单回合模型调用 >4）不得命中。
  - 硬停：单会话触达 `R6_HARD_LIMITS`（`accounting.ts:66`）即**先验拒绝**（§四），记为有界失败而非产品崩溃。

> **话术变更规则**：执行前冻结每类话术模板；逐样本按对象/窗口替换但**结构不变**；不得为凑绿在运行中改话术或改 Oracle 期望。

---

## 二、预注册 N 与预算 · 统计口径

### 2.1 样本量与总预算

| 场景类 | 每样本会话数 | 样本数 N | 会话数 | 说明 |
|---|---|---|---|---|
| S1 自然语言交办 | 1 | 3 | 3 | 单会话多轮 |
| S2 异步执行中继续对话 | 1 | 3 | 3 | background 受理 + 在飞时插入对话（见 §一 S2） |
| S3 查进度与结果 | 1 | 3 | 3 | 取回真实结果 |
| S4 修改·取消·再交办 | 1 | 3 | 3 | 两轮控制意图 |
| S5 进程重启后恢复 | 1 | 3 | 3 | 同一 sessionId 跨重启 |
| S6 多用户并发与隔离 | **3**（A/B/C） | 3 | **9** | 每样本 = 一个 3-principal 并发批次 |
| S7 失败·超时·成本上限 | 1 | 3 | 3 | **子例各 1**：S7a 失败 / S7b 超时 / S7c 成本 |
| **合计** | — | **21 样本** | **27 会话** | 另加 **1 装配冒烟会话**（`eval:user` 真模型连通，不计入结论，见 §四门） |

- **N=3 的性质（诚实口径，对齐 R6 §2.1）**：N=3 时 3/3 的 Wilson 95% 下界 = **0.4385**——**区间极宽**，故 **P2 一律只读、不作任何稳定性/可靠性概率结论**；不得把 3/3 读作「通过/稳定」。k/N 一律附 Wilson 95% CI（`scripts/eval/exploration/stats.ts:69` `wilson95`）。
- **实测取值（冻结，供机械复核）**：`node -e "import('./scripts/eval/exploration/stats.ts').then(m=>console.log(m.wilson95(3,3),m.wilson95(2,2)))"` → **`wilson95(3,3) = [0.43849…, 1]`**、`wilson95(2,2) = [0.34237…, 1]`。
  - **口径纠偏（冻结前修正）**：**0.342 是 2/2 的下界，不是 3/3 的**（2/2 标注见 `docs/eval/long-session-prereg.md:47`、`docs/decisions/index.md` R6 §七十八 行）。P2 各场景 N=3，全绿读数一律记 **3/3，Wilson 95% CI [0.4385, 1]**；**禁止**把 0.342 引作 P2 读数。
  - 分场景报数即以该值；**不以跨场景合并比例冒充单一结论**（21/21 若需呈现，其下界 = `wilson95(21,21)` = 0.8454，但 P2 结论以逐场景为准）。
- **分析单位**：以**样本**为主分析单位（S6 样本 = 一个 3-principal 并发批次）；同一会话内多轮/多事实问题**不冒充独立样本**（R6 §〇.3）。
- **预算（单会话硬停 → 总上界）**：
  - 单会话硬停（冻结，取自 `accounting.ts:66` `R6_HARD_LIMITS`，**不得修改**）：`150 calls / 3,000,000 tokens / 2h`。
  - **总预算上界（算术上限，非全局额度闸）**：27 会话 × 150 calls = **4,050 calls**；27 × 3M = **81,000,000 tokens**；27 × 2h 墙钟。此为上界，**实际用量预期远低于此**（P2 为短多轮业务会话，不追求长稳压缩）。**全局额度放行以协调员单点为唯一节点**（R6 §〇.6），本预注册只做单会话硬停。
  - **冒烟会话**：1 会话，仅走通模型与装配，硬停同上。

### 2.2 统计口径

- 逐场景报 **k/N（通过样本数 / 样本数）+ Wilson 95% CI**；机械硬项（§三）**先判否决**，不作平均分。
- 三类判据**分开呈现**：机械（确定性，硬）/ 行为（模型面，计数）/ UX（只统计）。机械硬项失败**不得**被 UX/行为高分稀释（R6 §〇.5 同义）。
- 产品故障样本**判负而非作废**（§五）；环境中断样本登记待重跑、不判产品负；覆盖不足样本保留留档、不进结论。

---

## 三、判据

### 3.1 机械判据（确定性，硬；任一硬零命中 → 该批 FAIL）

| 判据 | 定义 | 机械来源 |
|---|---|---|
| **业务完成率** | 交办后任务真实到达终态且反馈如实（completed / 如实 failed / 如实 timed_out）的样本占比 | registry 终态 + `requestIds` 非空 + 回复如实性 |
| **事实与任务一致** | 回复中的对象/条数/金额/编号与 `FACT_TRUTH` + registry 一致（tolerance=0） | `judgeFactAnswer`（`oracle.ts:112`） |
| **控制意图如实回执** | 取消/修改/再交办机械上真实发生且回复如实 | H5/H3 + `cancelCalled`（`oracle.ts:213`） |
| **无虚假完成** | 无 `completed` 却零执行（H4） | `oracle.ts:231` |
| **无虚假取消** | 无「已取消」却未调 `task_cancel`（H5） | `oracle.ts:241` |
| **无重复执行** | 同一 `requestId` 不归属多个任务（H3） | `oracle.ts:217` |
| **无编号混淆** | 同 `taskNo` 不映射到多个 `taskId`（E-G） | `oracle.ts:249` |
| **无跨 principal 泄漏** | 任务/转录/通知不跨 principal（`cross_principal_leak`） | `mu-support.ts:435` + `mu6-restart.ts` 断言 |
| **无跨 Session 泄漏** | 同 principal 多会话/群私不相互泄漏任务与历史 | MU-3/MU-8（`mu-cases.ts`） |
| **无越权执行** | 跨用户任务工具调用被拒；本会话正当访问不被误拒（`unauthorized_execution`） | MU-5 |
| **通知不误投** | 通知只注入 owner 会话（`notification_misdelivery`） | MU-7 |
| **无串行假并发** | S6 会合栅真交错，非串行（`fake_concurrency`） | `Rendezvous`（`mu-support.ts:67`） |
| **压缩有界** | H6.a/H6.b 不命中 | `judgeCompactionLifecycle`（`compaction.ts:126`） |

### 3.2 行为判据（模型面，逐样本计数，不作硬否决但计入报告）

- 无谓澄清次数、用户介入次数、对可答问题的误答/空答、指代（「刚才那个/第二个」）理解失败——只统计，与机械判据**分开报告**。

### 3.3 成本与时长上限（硬）

- **单会话**：calls `>=150` / tokens `>=3,000,000` / 墙钟 `>=2h` 即**先验拒绝发起下一请求**（`CallAccountingGuard.precheck`，`accounting.ts:235`；判定顺序 `ms→calls→tokens`，`accounting.ts:173`）。触达记**有界失败**，不算产品崩溃，但**该样本不计通过**。
- **真实模型调用完整计量**：主 / Pi 摘要 / 重试 / 溢出恢复四类逐次记账（`accounting.ts:25`），能分离则 summaryCalls 单列；token 只按**观测到的 usage** 计，未观测不虚增（`accounting.ts:96`/`:115`）。

---

## 四、单实验硬停与停止条件

### 4.1 单实验硬停（先验，不靠模型自觉）

- 冻结上限取自 `accounting.ts:66` `R6_HARD_LIMITS`：`maxModelCalls=150` / `maxTokens=3,000,000` / `wallMs=2h`。**改此块 = 改已冻结口径，禁止**（只允许测试注入更小上限做确定性验证）。
- 判定顺序固定 **`ms → calls → tokens`**；**先验**=发起下一请求**之前**检查，达上限即抛 `R6HardStopError`（`accounting.ts:155`），**不发起该请求**（有界失败）。

### 4.2 停止条件（冻结）

1. **硬零命中**：任一样本命中 §3.1 硬零（H3/H4/H5/E-G/H6/跨 principal/跨 Session/越权/误投/假并发）→ 该批 **FAIL 并停止**继续跑新样本（R6 §〇.5）。
2. **单会话硬停**：触达 calls/tokens/墙钟 → 该会话停止，记有界失败；批量视同场景其余样本结果再判。
3. **装配/环境门（阻塞，不烧样本）**：`step-3.7-flash` 不可得、LLM 端点不可达、装配与本预注册声明不一致（如 model id 不符）→ **blocking、退出码 2、不烧任何样本**（先验门定义见 `docs/history/business-e2e-prereg-addendum.md:95`，门失败口径见 `:96`）。
4. **环境中断**（OOM/网络/模型 5xx）：登记 `environment_interrupted`，**待重跑**；不判产品负，也不计入通过。
5. **总预算上界**：达 27 会话预算上界即停（上界见 §2.1；全局额度由协调员单点处理）。

---

## 五、失败分类（三态冻结；**产品故障样本不作废**）

对齐 `scripts/eval/long-session/evidence.ts:24` `SampleDisposition` 与 `:111` `classifySample`（优先级：**产品故障 > 环境中断 > 覆盖不足 > 有效**；产品故障不得被环境信号吞掉）：

| 类 | 判定 | 处置 |
|---|---|---|
| **`product_fault`**（产品故障） | 任一硬零命中 **或** 存在产品故障信号（`productFaultSignals`，如任务链路持续报错、压缩链路异常） | **保留并判负，不作废**（防幸存者偏差）。样本进结论分母，记为失败。 |
| **`environment_interrupted`**（环境中断） | 无产品故障，但存在环境/基础设施信号（OOM/tmp/网络/模型 5xx） | 登记，**待重跑**；不判产品负，不计入通过。 |
| **`insufficient_coverage`**（覆盖不足） | 无上述信号，但该样本未覆盖到判定所需维度（如 S5 未真正跨重启、S6 未真交错、S7 未触发失败路径） | 保留原始留档，**样本不可用于结论**；不冒充产品失败。 |
| **`valid`**（有效） | 以上皆非 | 计入 k/N。 |

> **纪律**：产品故障样本**一律保留**，不得因硬停或无法完成而简单作废；环境中断样本登记待重跑而非删样本；覆盖不足样本保留留档但不进结论（对齐 R6 §2.5）。

### 5.1 P2 侧覆盖维度（判定接缝，冻结）

> **接缝事实（实测）**：复用的 `classifySample`（`evidence.ts:111`）**只**以 `judgement.compactionVerdict.coverageSufficient` 判「覆盖不足」（`:111-118`），**不认识** P2 七类场景的覆盖维度。若不补接缝，「S5 没真重启 / S6 没真交错 / S7 没触发超时」会被误记为 `valid`——预注册口径与复用件就此矛盾。故 P2 在 eval 胶水层加**薄包装** `classifyP2Sample`（新增于 `scripts/eval/p2/**`，**不改 `evidence.ts`**、不改产品码），优先级与 `classifySample` 完全一致：

```
d = classifySample(evidence, judgement)          // 产品故障 > 环境中断 > R6 压缩覆盖不足 > valid
若 d === 'product_fault'           → 'product_fault'           // 产品故障不被任何 P2 维度吞掉
若 d === 'environment_interrupted' → 'environment_interrupted'
若 !p2Coverage[scenario](evidence) → 'insufficient_coverage'
否则                                → 'valid'
```

> 已知遗留（不改 `evidence.ts` 的代价）：`buildEvidenceSummary` 记录的 `coverageSufficient` 仍是 R6 压缩口径；P2 额外维度写在证据的 `p2Coverage` 字段（§六），二者**并列呈现**，判定以 `classifyP2Sample` 为准。

**`p2Coverage` 逐类必要机械事实**（只读既成事实，不改门控）：

| 场景 | 覆盖成立的必要机械事实 | 取法 |
|---|---|---|
| S1 | 真实发生过委派：该样本 `taskTurns` 中出现任务（否则"交办"未发生） | `TaskTurnFact`（`oracle.ts:185`） |
| S2 | 装配为 background **且** `taskTurns[0]` 中 alpha 非终态 **且** 完成闸在 T2 之后才释放 | `mu-support.ts:341` + `taskExecutor` 闸计数 |
| S3 | 被查任务已在**同一 sessionId** 内到达终态（否则"查进度"无对象可查） | `tasksFinal` |
| S4 | 取消路径真被走通：`cancelCalledLastTurn()=true` **且**出现 `cancelled` 状态（若模型只追问未执行，则覆盖不足而非产品失败） | `TaskTurnFact.cancelCalled`（`oracle.ts:191`） |
| S5 | **真重启**：同 `dbPath` 关停重建（`mu6-restart.ts:138` `server.close()` → `:143` 同 dir 重建），且第二回合转录由存储加载（首回合原文可见） | 重启计数 + 转录文本 |
| S6 | 会合栅 **3 到达且 `timedOut=false`**（`mu-support.ts:67` / `:72`） | `Rendezvous` |
| S7 | 目标子例路径真实触发：S7a 执行记录含 `failed/COLLECTION_FAULT`；S7b 终态为 `timed_out`；S7c 出现 ≥2 次模型调用或有界硬停 | `execRecords` / `tasksFinal` / `modelCalls` |

> 状态覆盖可复用 `statesCovered`（`oracle.ts:267`）。**纪律**：`insufficient_coverage` 只表示"这次没测到"，**绝不折算成产品通过或产品失败**；样本原样留档（§五）。

---

## 六、证据 schema（逐会话）

**基线**：直接承接 `scripts/eval/long-session/evidence.ts:64` `SessionEvidence`（字段：`turns/replies/compactionAttempts/tokenCurve/modelCalls/callAccounting/toolCalls/taskTurns/tasksFinal/infraSignals/productFaultSignals` 等），并叠加 MU 五要素记录（`mu-support.ts:453` `MuDeliveryRecord`：`principalId/sessionId/taskId/request/deliveredTo/kind`）。**不新建第二套证据层**。

P2 必填字段映射（每会话一条 `SessionEvidence` + 若干 `MuDeliveryRecord`）：

| P2 必填项 | 字段（来源） | 说明 |
|---|---|---|
| 交办原文 | `turns[].text`（`evidence.ts:28` `TurnRecord.text`；`turns` 字段 `:76`） | 逐轮注入的用户原文 |
| 回复 | `replies[].text` / `replies[].replyChars`（`evidence.ts:34` / `:35`；`replies` 字段 `:77`） | 用户可见回复 |
| 任务事实 | `taskTurns[]` / `tasksFinal[]`（`:85`/`:86`，`oracle.ts:174` `TaskView`） | registry 只读快照投影：状态/原因/`requestIds` |
| 执行轨迹 | `toolCalls[]`（`:39`）+ MU `execRecords`（`mu-support.ts:166`） | Main 工具调用 + Worker 执行请求（operation/requestId/args） |
| 压缩事件 | `compactionAttempts[]`（`:78`，`compaction.ts:17`） | before/after/kind；供 H6 判定 |
| token | `budgetUsed` / `callAccounting` / `modelCalls[]`（`evidence.ts:72` / `:83` / `:81`） | 全量四类计量 |
| 耗时 | `startedAt`/`endedAt`（`:74`）+ `replies[].durationMs` | 会话与逐轮耗时 |
| **deliveredTo** | `MuDeliveryRecord.deliveredTo`（`mu-support.ts:453`） | 实际投递对象 = `(principal, session)` |
| 处置 | `SampleDisposition`（`evidence.ts:24`）；P2 判定走 `classifyP2Sample`（§5.1） | 三态分类结果 |
| 硬零命中 | `hardZeroHits`（`buildEvidenceSummary` 汇总字段，`evidence.ts:140`） | H3/H4/H5/E-G/H6 + MU 硬零 |
| **P2 覆盖维度** | `p2Coverage`（P2 胶水新增字段：`{scenario, satisfied, facts}`） | §5.1 逐类事实；与 R6 `coverageSufficient` 并列，不互相替代 |

- **落盘**：`collectEvidence`（`evidence.ts:165`）写 `.runtime/r6/...`（gitignored）：`manifest.json / turns.jsonl / replies.jsonl / compaction-events.jsonl / token-curve.jsonl / model-calls.jsonl / tool-calls.jsonl / tasks-snapshots.jsonl / tasks-final.json / evidence.json`；MU 侧 `.runtime/r6/multiuser/<case>/evidence.json`（`mu6-restart.ts:99`）。
- **纪律**：`.runtime/**` 一律 gitignored、**不得 `git add`**；证据只陈述事实 + Oracle 结论 + 处置，不改触发/门控。

---

## 七、复用 R6 Harness 的映射

> **总原则**：复用优先于抽象。P2 **不新建**判定/证据/记账/并发/重启框架，全部复用 `scripts/eval/long-session/**` 与 `scripts/eval/long-session/multiuser/**` 的既有件。

| P2 需求 | 复用的 R6 件 | 接缝 / 说明 |
|---|---|---|
| 逐轮驱动 + 事实采集 - 回复 | `harness.ts:82` `runHarnessSession`；接口 `HarnessSession`（`:31`） | 只采集事实、不 import 产品运行时（`harness.ts:3`） |
| 真实模型会话适配 | `harness.ts:43` `modelCallLedger`（**必须提供**，否则摘要/重试漏账） | ⚠ **R6 真实模型“生产同源适配器”尚未接线**（`r6-longsession-harness-design.md:171`「仍待 Wave1」）；现有只有 `FakeHarnessSession`（`fake-session.ts:47`，零模型，仅供自证）。**P2 执行前须补一个 Main=真实 Pi + Dummy Worker 的 eval 侧适配器**（属 `scripts/eval/**`，非产品码）。 |
| 事实 Oracle | `oracle.ts:112` `judgeFactAnswer`；`:153` `judgeSessionFacts`；真值 `FACT_TRUTH`（`:36`） | 机械比对，tolerance=0；不确定措辞 `E-INCONCLUSIVE`（不冒充产品失败） |
| 任务 Oracle（H3/H4/H5/E-G） | `oracle.ts:213` `judgeTaskContinuity`；硬零集 `:204` | registry 只读投影为 `TaskView` 后喂入 |
| 压缩生命周期（H6） | `compaction.ts:126` `judgeCompactionLifecycle`；上限 `:71` `R6_COMPACTION_BOUNDS` | 面向 Pi 原生生命周期，不绑私有事件/常量 |
| 全量记账 + 单实验硬停 | `accounting.ts:66` `R6_HARD_LIMITS`；`:194` `CallAccountingGuard`；`:235` `precheck` | 先验拒绝；四类逐次计量 |
| 证据 schema + 三态处置 | `evidence.ts:64` `SessionEvidence`；`:111` `classifySample`；`:165` `collectEvidence` | 产品故障不作废（`:105`） |
| 多用户 / 生产同源装配 / 五要素 | `multiuser/mu-support.ts:39` principals；`:67` `Rendezvous`；`:345` `createMuServer`；`:403` `readTasks`；`:453` `MuDeliveryRecord`；`:435` `judgeMuTasks` | 生产同源 `createServer`（与 `npm start` 同链）；判定读只读快照，不以 `registry.get` 直调代替交互 |
| 进程重启后恢复 | `multiuser/mu6-restart.ts:104` `mu6Restart` | 同 dbPath 关停重建；四类断言（转录恢复/不跨读/不重放/结果找回） |
| 确定性语料 | `load-generator.ts:111` `buildTrackPlan`；建立轮 `:39`；任务轮 `:63`；交互轮 `:74`；事实真值 `oracle.ts:36` `FACT_TRUTH` | 话术模板来源 |
| 统计 | `scripts/eval/exploration/stats.ts:69` `wilson95` | k/N + Wilson 95% CI |
| 运行入口 | `LLM_MODEL=step-3.7-flash npm run eval:user -- ...`（`package.json:14`） | 与 `ask` 同源装配；真实模型经配置 LLM 端点 |

**关键接缝（P2 执行前须落地、属 eval 侧、非产品码）**：
1. **真实模型 Main 适配器**：实现 `HarnessSession`（`harness.ts:31`），且 `modelCallLedger()` 必须逐次暴露主/摘要/重试/溢出恢复（`harness.ts:43`）；否则记账不完整、token 硬停失效。
2. **Dummy Worker**：经 `createMuServer` 的 `createExecutionFace` 注入仓内 dummy 执行面（`mu-support.ts:355`），执行层零真实平台/写；Main `createDrivers` 换成真实 Pi Main 驱动（`mu-support.ts:353` 同注入点）。
3. **P2 覆盖维度接缝**：实现 `classifyP2Sample` + `p2Coverage`（§5.1），并落地三处 eval 侧注入——`mode:'background'`（S2，`mu-support.ts:341`）、完成闸 `taskExecutor`（S2，`mu-support.ts:278` 同形）、deadline-honoring Worker 驱动 + 不返回的执行 gate（S7b，`driver-contract.ts:31` / `mu-support.ts:355`）。**缺任一项，对应场景样本只能是 `insufficient_coverage`**。
4. 上述接线**只改 `scripts/eval/**` 的装配侧**（新增 P2 胶水放 `scripts/eval/p2/**`），**不动产品码**、不改 Worker 提示/账本/契约、不改 `evidence.ts`。

---

## 八、合流依赖（**`DECISION_REQUIRED`，待 owner 批准**）

### 8.1 事实：两分支已分叉（实测）

- 分叉点：`git merge-base arch/integration exp/pi-native-session-compaction` = **`84a22fa`**（`merge(r5-piopt)`，即 Pi 压缩复用评估）。
- 两侧头：`arch/integration` = **`f37d11d`**；`exp/pi-native-session-compaction` = **`be61a74`**（提交语 = Pi 原生替换·阶段三最终替换，**未跑真实模型**）。
- 规模：`git rev-list --left-right --count exp...integration` = **18 / 31**（exp 独有 18、integration 独有 31）。
- 改动面：`git diff --stat 84a22fa exp/...` = 48 files +5240/−2381；`git diff --stat 84a22fa arch/integration` = 45 files +7905/−8（含 B1 session-persistence、B2 silent-shadow-gate、R6 全套 `scripts/eval/long-session/**`、`docs/product` 8 篇）。
- 文本冲突面（两侧共同改动文件 `comm -12`）：**仅 `apps/server/server.test.ts` 与决定记录面（原 `decision-log`，现 `docs/decisions/index.md`）**。

### 8.2 结论：P2 必须先合流

- P2 的**被测对象**（Main 真实模型 + B1 恢复接线 + Pi 原生会话/压缩 + MU 隔离）**横跨两分支**：`exp` 提供 Pi 原生替换（转录/压缩归 Pi 原生），`integration` 提供 B1 接线/B2/MU。**P2 需两者合流后再跑**——否则 P2 会测到「半装配」状态，结论不可归属。
- **合流并合入 `arch/integration` 需 owner 批准**（owner 曾明确「不授权直接合入 `arch/integration`」）。
- **⇒ 本预注册标 `DECISION_REQUIRED`：合流方案与合入方式待 owner 裁定；未批准前 P2 不得启动。**

### 8.3 建议合流方案（在**独立合流分支**验证，不直接动 integration）

> 目标：在不直接写 `arch/integration` 的前提下，产出并验证一个可运行的合流候选，证据交给 owner 裁决。

1. **建独立合流分支**：自 `arch/integration`（`f37d11d`）拉 `arch/p2-merge-candidate`（或 owner 指定名），**不合入、不 push 到 integration**。
2. **合并 `exp`**：`git merge exp/pi-native-session-compaction`；预期仅两处文本冲突：
   - 决定面（`docs/decisions/index.md` 与 `docs/history/decision-log-part*.md`）：**由集成 Agent 单点裁定**（本 Agent/本预注册不写决定面），保持记录顺序与编号不冲突；
   - `apps/server/server.test.ts`：以「合流后行为」为准裁决（git 2.55 实测 `merge-tree` 显示可 auto-merge，需人工复核语义）。
3. **合流分支验证（确定性门，全绿方可提请 owner）**：
   - `tsc` 类型检查全绿；
   - `npm test` **全量**通过；
   - **关键确定性用例**（零真实模型）逐一通过：MU 全套 `npx vitest run scripts/eval/long-session/multiuser/mu.test.ts`（MU-1～MU-10，含 MU-6 重启恢复、MU-8 群私隔离）、B1 会话持久化接线用例、B2 silent-shadow 用例、Pi 压缩生命周期确定性用例。
4. **提请 owner 批准合入 `arch/integration`**：附合流分支 SHA、`tsc`/全量/关键用例读数、两处冲突的裁决记录。**批准后**由集成 Agent 单点合入。
5. **合入后再跑 P2**：P2 以合流后的 integration HEAD 为基线，按 §一～§七执行。

**已实证的合流可行性（只读预演，未改 worktree/索引）**：`git merge-tree --write-tree --name-only --messages arch/integration exp/pi-native-session-compaction`（git 2.55.0）输出合并树 `6fd0d9a…`；`Auto-merging apps/server/server.test.ts`、`CONFLICT (content): Merge conflict in docs/decisions/index.md`——**唯一内容冲突在 `docs/decisions/index.md`（决策台账，归集成 Agent 单点）**，`server.test.ts` 可自动合并但须语义复核。

### 8.4 integration 前置已就绪（实测 5/5 为 HEAD 祖先）

P2 的 integration 侧前置已在 integration HEAD `f37d11d` 上，`git merge-base --is-ancestor` 逐条 **YES（5/5）**：`ebdaf71`（B1 接线）、`56554fb`（B2 silent-shadow）、`0d44fbe`（MU-6 实现）、`b7c62bd`（MU-8 复跑）、`f37d11d`（MU-6 复跑）。落盘证据存在：`packages/agent/src/session-persistence.ts`、`packages/channel-wecom/**`。

> **DECISION_REQUIRED（提交 owner）**：① 是否批准按 §8.3 在独立合流分支验证后合入 `arch/integration`；② 决定记录面冲突的裁决归属（建议：集成 Agent 单点）；③ P2 的 `step-3.7-flash` 与 Dummy Worker 装配口径确认（§〇 与 §七）。**以上未批，P2 不启动。**

---

## 九、启动条件清单（供 owner 逐项放行）

- [ ] **B1 恢复接线完成**（已满足：`ebdaf71` 为 integration 祖先）。
- [ ] **§八 合流方案获 owner 批准，合流并合入 `arch/integration`**（`DECISION_REQUIRED`，**未满足**）。
- [ ] 真实模型 `step-3.7-flash` 可得、LLM 端点可达（装配冒烟 G 门通过）。
- [ ] eval 侧「Main=真实 Pi + Dummy Worker」适配器接线完成（§七 关键接缝 1/2）。
- [ ] eval 侧 P2 接缝落地：`classifyP2Sample`/`p2Coverage`（§5.1）+ S2 完成闸 + S7b deadline-honoring Worker 驱动与执行 gate（§七 关键接缝 3）。
- [ ] 本预注册 §一～§七 口径冻结确认（N / 预算 / 判据 / 硬停 / 失败分类 / 证据 schema / 覆盖维度）。

---

## 十、修订记录（v2，2026-11-15）

> 复核意见（owner 侧）逐条处置。**均为冻结前修订**；不涉及任何读数（本轮零模型调用、不跑测试）。

| # | 复核项 | 处置 | 落点 |
|---|---|---|---|
| 1 | 统计口径事实错误（0.342 误用于 3/3） | **改正**。实测 `wilson95(3,3)=[0.43849…,1]`、`wilson95(2,2)=[0.34237…,1]`；P2 全绿读数改记 **3/3 [0.4385,1]**，并注明 0.342 属 2/2（`r6-longsession-prereg.md:47`、`decision-log.md:1844`）。复核所述「仓内 `stats.ts:69` 实算」已在本轮以 `node -e` 导入该模块复现。 | §2.1 |
| 2 | S7「超时」子场景不可执行 | **补齐**。三子例 N=3 各 1 个（S7a/S7b/S7c）写死；S7b 给出**eval 侧注入方案**（`runtime.workerTurnMs` 调小 + deadline-honoring Worker 驱动 + 不返回执行 gate），落点为产品既有 `timed_out` 机制；并写死**降级条款**：若 owner 否决该驱动，S7b 一律记 `insufficient_coverage`。**实测确认夹具无延迟旋钮**（`grep` 零命中）。 | §一 S7 |
| 3 | S2 异步可观测性未绑定 | **补齐**。写死必须异步派发（`createMuServer` 走 server 恒 async），并给三观测点（首回合快照非终态 / 完成闸晚于 T2 / 最终真完成），同步一律 `insufficient_coverage`。 | §一 S2 |
| 4 | `insufficient_coverage` 判定接缝未落地 | **补齐**。新增 §5.1 `classifyP2Sample`（薄包装、优先级同 `classifySample`、不改 `evidence.ts`）+ 七类 `p2Coverage` 表；§七加关键接缝 3。 | §5.1、§七 |
| 5 | 次要引用漂移 | **部分改正**：`harness.ts:44→:43`（`modelCallLedger` 实际在 43）、`evidence.ts:26→:28`（`TurnRecord.text`）、`:32→:34/:35`（`ReplyRecord.text`/`replyChars`）、`budgetUsed :55→:72`、`hardZeroHits` 标注为 `buildEvidenceSummary` 字段（`:140`）。**`docs/history/business-e2e-prereg-addendum.md` 一项复核不成立**：本轮逐行读取，`:96` 原文即「门失败 → blocking=true、退出码 2、不烧任何样本」，`:95` 是门定义；已改为同时引用 `:95-96` 以消歧。 | 全文 / §四 |
| 6 | 真实模型 Main 适配器未接线（范围性提示） | **不改**（原文已如实列为启动前置）：确认 §七、§八、§九 均已登记；§九 第 4/5 项未勾选状态与本轮一致，P2 在适配器落地前不可启动。 | §七、§九 |
