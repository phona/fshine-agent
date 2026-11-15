# Pi 压缩复用 · 方案对照（A/B/C + 直接复用评估）

> 配套：`pi-compaction-api-audit.md`（导出面/能力图谱）、`pi-compaction-poc.md`（实测）、`pi-compaction-migration-plan.md`（推荐方案实施）。
> 锁版本 0.85.1（同 audit §0）。行号对应当前 `packages/agent/src/pi-driver.ts` 与 0.85.1 `dist/**`。
> **本文不实施任何修改**；所有方案只列影响与代价。

## 0. 核心分叉：改哪里能省最多

fshine 自研压缩 = **编排层**（`pi-driver.ts:324-618`），Pi 公开 = **原子件层**（audit §1.1）。因此“复用 Pi”分两档：

- **原子件复用（现状）**：已做（`pi-driver.ts:6`）。问题是编排层里有**重复实现**（D1/D2/D3，见 §1）。
- **整套编排复用**：需迁到 Pi 的 Session/Entry 模型（`prepareCompaction(Entry[], settings)`），才能直接调 `compact`。这是 **方案 S**，评估见 §4。其**更小形态**（fshine 保留自管会话，仅额外挂一个 Pi 内存 Session 作转录镜像供压缩入口）为 **方案 T**，补评见 §4.T。

## 1. 现状缺陷（已实测/已登记）

- **D1** `run()` 请求前 INV 复核臂（`pi-driver.ts:661-686`，事件 `pi_driver_pre_request_compacted`/`pi_driver_context_invariant_rejected`）与 `transformContext` 应急臂（`:701-711`）**功能重叠**；`transformContext` 已被实测覆盖**每条请求含首条**（`agent-loop.js:179-180`；P0-B ③-b；本文 PoC ③b）。
- **D2** `pi-driver.ts:658-660` 注释“transformContext 只在回合内兜底，首条请求前不经过它”**已证伪**（同上）。
- **D3** emergency 线（`:657`）与 INV 线（`:661`）**二源同值**：`max(1024, Δ+1024) ≡ Δ+1024`，恒等，可合一。
- **零收益摘要循环（结构性）**：`splitForCompaction` 保护当前回合（`:396-405`）⇒ 前缀仅 0–1 条旧消息，摘要换摘要；W=8192 下 emergency 线与 INV 线同值 2512（`:657/:661`）⇒ 逐条请求前复触发。**实测复现**：55/79 次 `context_compacted` 的 `tokensAfter == tokensBefore`（decision-log §六十九；本文 PoC ②b/⑥）。

## 2. A / B / C 对照

| 维度 | **A：删重收敛（D1+D2+D3）** | **B：A + 事前预判** | **C：现状 + 观测落盘** |
|---|---|---|---|
| 内容 | 删 `run()` INV 复核臂；删失实注释；emergency/INV 线合一 | 在 A 上于 `splitForCompaction` 后、`summarizeWithinWindow` 前插入**纯函数** `compactTranscriptWithPi` 预判（NOT_WORTH ⇒ 不发摘要调用） | 不改编排，落盘摘要正文 + 计量观测，供 B 取证 |
| 代码影响 | 净删（约 −26 行 + 1 处注释 + 1 处常量合并） | 净增约 35–50 行（纯函数 + 事件常量） | 增观测代码（plan 未定） |
| 维护成本 | **降**（第二道闸消失，单一来源） | 微升（多一个纯函数，无状态） | 升（多观测面） |
| 安全边界 | **等价**（删重复闸后 `transformContext` + `compactTranscriptWithPi` no_cut 有界失败仍单一把关）；**前置**：先跑反向绊线 | A 的边界 + 预判为**跳过决定非失败**，误判有**三重既有兜底**（`transformContext` 原样返回 `:701-711`；overflow 臂 `tokensAfter>=tokensBefore` break `:750`；`run()` INV 臂抛错 `:669`→catch `:676-678`） | 不变 |
| 可行性 | **高**（行为等价可证；D3 恒等可按断言） | 中（需过新增机制准入五条 + 128k 复测） | 高（纯观测） |
| 是否删自研切片编排 | **否** | 否 | 否 |
| 是否引入第二套会话状态 | **否** | **否**（预判无状态，无双计数器/无冷却器） | 否 |

**逐项结论**：
- **能否删除切片编排（`splitForCompaction`/`summarizeWithinWindow`/`trimToBudget`）？——不能**。Pi 0.85.1 的 Agent 路径**无对应物**：`prepareCompaction`/`findCutPoint` 输入是 session `Entry[]`；harness 的 settings 缩放/有界分片/产物裁剪在 Agent 路径不存在（`structural.js` 管线不在此路径）。删即失去小窗可用性（decision-log §六十九「不删」项；audit §2）。
- **是否引入第二套会话状态？——A/B/C 均否**。S 才会（见 §4）。
- **同步恢复一致性成本？——A/B/C 不受影响**。fshine 转录即状态（`pi-driver.ts:652`），压缩产物直接回填 `agent.state.messages`（`:670/:751`），无跨存储对账。

## 3. 推荐（判据已应用）

**推荐 = A（条件式）**。理由：删除优先于迁移、复用优先于抽象（AGENTS.md 删除纪律）。A 是**净删 + 单一来源**，行为等价可证，直接消灭 D1/D2/D3 三处重复；B 的证据前置（C）与机制准入未完成；直接复用整套编排（S）代价高于现有编排的最小修复（§4）——按判据**明确建议不迁移**。

## 4. 方案 S（直接复用 Pi 整套压缩编排 / 迁移 Session）——**评估为不建议**

owner 关心的三问，逐一给结论：

1. **能否在 Agent Core 路径直接复用 Pi 压缩编排？**
   `compact(preparation, ...)` / `prepareCompaction(pathEntries, settings)` 虽为**公开 API**（audit §1.1），但输入是 Pi 的 **session `Entry[]`**（`compaction.d.ts:413`），且 harness 的溢出/同步恢复管线 `prepareOverflowCompaction`（`structural.js:872-887`）**不在 exports map、仅 Session/serve 路径可达**。fshine 走的是 `Agent` + `transformContext`（`agent-loop.js:179-180`），**该路径上 Pi 不提供现成编排**。⇒ 直接复用编排**不可行**，除非迁移到 Pi Session 模型。
   - **恰回答复核缺口③「是否需复制 Pi 源码？」——不需要，且本项目判据不许。** 三种可能都不成立：(a) 现在**未复制**任何 Pi 源码（fshine 只从根入口 `import` 公开原子件，见 api-audit §3）；(b) 把 `structural.js` 的 `prepareOverflowCompaction` 等**内部**管线源码抄进 fshine 会违反 AGENTS.md 判据「**不能把复制 Pi 源码包装成复用 Pi**」——那是冒充复用，且内部符号本不在 exports map（api-audit §1.2），抄来即自担漂移；(c) `compact`/`prepareCompaction` **本就是公开的**，无需复制即可 `import`（约束只在其**输入类型 `Entry[]`** 而非可达性）。⇒ 结论：**复用靠 import，不用复制；复制 Pi 源码在本项目中明确被排除**（判据层面否决，非技术不可行）。
2. **迁移 Session 能否真正删自研压缩？**
   部分能：`prepareCompaction`/`compact` 可替代 `splitForCompaction` + `summarizeWithinWindow` 的主体。但 fshine 的 **INV 不变式**（`T ≤ W − Δ_worst − MIN_OUTPUT`，`pi-driver.ts:266-307`）、**窗口缩放 settings**（`compactionSettingsFor:324-344`）、**产物裁剪 `trimToBudget`**（`:481-491`）、**确定性降解 `degradeByDropping`**（`:498-515`）在 Pi 0.85.1 无对应物，仍须保留。⇒ 迁 Session **不能**删干净；反而新增适配。
3. **会不会破坏 fshine 对业务会话与执行事实的控制？**
   风险点：Pi Session store 会成为**第二套会话状态**，与 fshine 的 `execution-runtime.ts:279 Session` / `task-registry` 并存；须把 fshine 的 `AgentMessage[]` 转录与 Pi `Entry[]` **双向同步/对账**（同步恢复一致性成本），并新引入一处失败面。执行事实（taskNo/resultText）本就在 fshine 底账、独立于转录（本文 PoC ⑧），大概率不受影响；但会话状态与压缩产物的控制权会部分让渡给 Pi Session 生命周期。
4. **对多 principal 的影响（复核缺口④，本文补评）——S 会新增一处身份耦合面，须显式适配。**
   fshine 的会话身份是**确定性不变量**：`execution-runtime.ts:279-288 Session` 携带 `readonly principalId`/`sessionId`，`createSession` 强制二者非空（`:321-322`），并据此构造 `TaskScope`（`:351`）、做任务归属校验（`registry.get(... { principalId, sessionId })`，`:496`）、`registry.begin`（`:551`）。而 Pi `SessionMetadata` 只有 `id/createdAt/storageVersion/cwd/parentSessionId/...`（`node_modules/@earendil-works/pi-agent-core/dist/harness/session/types.d.ts:399-407`），**无任何 principal/归属概念**。⇒ 迁 S 后若用 Pi Session 承载转录，**principal 归属仍只能留存在 fshine 的 `Session` 里**，Pi Session 退化为纯转录容器；压缩产物（Pi 生成）与 fshine 任务 scope（principal 派生）之间**多一层搬运与对账**。归属纪律本身不会被 Pi 破坏（Pi 不碰 task），但**多 principal 的隔离边界更依赖 fshine 侧不变式**，任何搬入搬出都必须逐会话绑定 principal——**未做迁移原型，成本为定性评估**。
5. **对异步取消通知的影响（复核缺口④，本文补评）——S **不**改变该面；取消/通知本就不走会话转录。**
   取消是**执行层生命周期复用**：`task_cancel` 直接 `runner.cancel(...)` 原样转述 `CancelOutcome`（`execution-runtime.ts:408-413`，`requested ≠ cancelled`，不宣称已取消）。通知是**独立 outbox**：`notifications.ts` 把「通知事实」先落同库 outbox 再由渠道无关 sink 投递，投递成败不改任务结果（`:1-20`），并含 `cancelled` 意图（`NOTIFICATION_KINDS`，`notifications.ts:28-40`）。两条链**均不依赖会话转录/压缩产物**，自然也不依赖 Pi Session。⇒ 迁 S **对异步取消通知无影响**（它不是被让渡的控制权之一）；但若将来有人把「取消/进度」塞进 Pi Session 事件流，将违反 AGENTS.md「宿主不重复执行层执法」「不建第二套对话历史」——**本轮明确不做**。
6. **装配同源（复核缺口④，本文补评）——PoC 与生产装配**不同源**，结论须按此降级。**
   生产装配在 `scripts/ask-runtime.ts:305`、`:475` 调 `createPiTurnDriver({ env: input.env, ...contextWindowFrom(input.env) })`，其模型运行时**由 env 构造的真实 Pi runtime**；PoC（`scripts/eval/piopt/piopt-phase3.test.ts:37-106`）直接调生产函数并注入**确定性假 `PiModelRuntime`**（`completeSimple` 回夹具、`streamSimple` 计数/抛错，`:9-10` 明示「不发任何网络请求」）。⇒ 本文 PoC 实测的是**压缩编排函数的机械行为**，**不是** ask/eval 的真实装配路径（无 `loadConfig`/env→contextWindow 接线、无真实 provider runtime）。故 PoC ⑧「执行事实独立于转录」等结论**只在函数层成立**，**未在真实装配下复验**——已登记为未验证项（§5）。

**S 的代价 vs 收益**：收益 = 可能少维护约 100–150 行编排；代价 = 引入第二套会话状态 + 同步对账 + 一处新失败面 + 迁移风险，且**仍删不掉 INV/缩放/裁剪/降解四处**。**代价 > 现有编排的最小修复 ⇒ 判据要求明确建议不迁移**（decision-log §六十九“不能删到完全交给 Pi”同结论）。

### 4.T 曾被遗漏的第四选项 T：**内存 Session 只借上下文管理**（不迁整套，仅借 Pi 压缩入口）——复核缺口④，本文补评

前面只把「直接复用」等同于**整套迁移 Session（S）**。复核指出还有一个更小的形态：**fshine 保留自己的内存会话与 principal/任务边界不变，只额外挂一个 Pi 内存 Session 作为转录镜像，专供 `prepareCompaction/compact` 取 `Entry[]`**。本文补评如下：

- **技术上是否可行？——可行但有硬约束，且未见更好，标「未验证」。**
  Pi **公开**导出了内存会话实现：exports map 含 `./harness/session`（`node -e "…exports"` 亲验），其入口 `dist/harness/session/index.d.ts` re-export `MemorySessionRepo` 与 `StorageBackedSession`。故一个纯内存 Session **可 import、可 `appendMessage` 建 `Entry[]`**。但两处警戒：(a) `session.d.ts:35-36` 把 `StorageBackedSession` 自述为“**Package-internal typed boundary** shared by concrete session repositories”——**虽在 exports 子路径可达，其文档定位是内部边界**，按证据纪律**不得当作稳定公开 API**（api-audit §1 判则）；(b) `AgentOptions` **无 session 字段**（`node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts:7-27`），即 fshine 的 `new Agent(...)` 路径**无法把 Pi Session 接进 Agent 循环**——镜像必须**手工**由 fshine 转录灌入。
- **代价：这不是「只借上下文管理」，而是「多一套内存转录 + 一个灌入适配层」。**
  要喂 `prepareCompaction(pathEntries, settings)`（`Entry[]`，audit §1.1），须在每次压缩前把 fshine 的 `AgentMessage[]` **全量重建成 `Entry[]`** 并写入内存 Session，压缩后再把产物回填 `agent.state.messages`（现状已回填，`pi-driver.ts:670/:751`）——即**同一转录两份表示（fshine 转录 = 权威，Pi Entry[] = 派生镜像）+ 每次压缩一次全量序列化**。压缩产物仍只能落回 fshine 转录，Pi Session 生命周期结束即弃。
- **收益：至多少维护 `splitForCompaction`+`summarizeWithinWindow` 主体，仍删不掉 INV/缩放/裁剪/降解四处**（与 S 同，见 §4 第2点）。且 T **不引入跨存储对账**（镜像全内存、随回合丢弃），比 S 的持久 Session 风险小。
- **结论：T 比 S 更小、更可逆，但仍是「为用 Pi 编排而自造镜像 + 适配层」，且只省中间两段。对照判据「复用优先于抽象、删除优先于迁移、不能把复制/自造包装成复用」——T 的净收益不高于方案 A 的删重收敛（A 是净删 26 行、无新表示），却多一份派生状态与序列化**。⇒ **在 A 可行且证据已足的前提下，判据仍指向 A，不建议引入 T**；T 仅作为「若将来要彻底复用 Pi 编排」的中间形态登记，**未做原型、未验证**。

## 5. 未验证项

- A 的**行为等价**目前有：D3 恒等（代数可证）、D1 的 transformContext 覆盖（实测，见 PoC ③b）。但 A 实施后的**反向绊线未跑**（migration-plan §回归矩阵列出）——列为实施前置。
- S 的同步对账成本为**定性估计**，未做迁移原型。
- 零收益循环（D3 相关）在**生产 128k** 的命中率无读数，不外推（PoC 几何取自 W=8192）。
- **方案 T（内存 Session 只借上下文管理，§4.T）未做原型、未验证**：`MemorySessionRepo` 虽在 exports 子路径可达，但其 `StorageBackedSession` 自述“Package-internal typed boundary”（`session.d.ts:35-36`），**是否可作稳定公开 API 未验证**；`AgentMessage[]→Entry[]` 全量重建适配层**未实现**。
- **多 principal / 异步取消通知的影响（§4 第4点/第5点）为源码静态分析结论**（`execution-runtime.ts` + Pi `types.d.ts`），**未做 S/T 迁移原型**，未在真实多 principal 会话上跑通。
- **PoC 与生产装配不同源（§4 第6点）**：已实测项仅在**生产函数层**成立；ask/eval 真实装配路径（`scripts/ask-runtime.ts:305/475` 的 env→runtime）**未纳入 PoC**，相应结论**未在真实装配下复验**。
