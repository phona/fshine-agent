# Pi 压缩复用 · 方案对照（A/B/C + 直接复用评估）

> 配套：`pi-compaction-api-audit.md`（导出面/能力图谱）、`pi-compaction-poc.md`（实测）、`pi-compaction-migration-plan.md`（推荐方案实施）。
> 锁版本 0.85.1（同 audit §0）。行号对应当前 `packages/agent/src/pi-driver.ts` 与 0.85.1 `dist/**`。
> **本文不实施任何修改**；所有方案只列影响与代价。

## 0. 核心分叉：改哪里能省最多

fshine 自研压缩 = **编排层**（`pi-driver.ts:324-618`），Pi 公开 = **原子件层**（audit §1.1）。因此“复用 Pi”分两档：

- **原子件复用（现状）**：已做（`pi-driver.ts:6`）。问题是编排层里有**重复实现**（D1/D2/D3，见 §1）。
- **整套编排复用**：需迁到 Pi 的 Session/Entry 模型（`prepareCompaction(Entry[], settings)`），才能直接调 `compact`。这是 **方案 S**，评估见 §4。

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
2. **迁移 Session 能否真正删自研压缩？**
   部分能：`prepareCompaction`/`compact` 可替代 `splitForCompaction` + `summarizeWithinWindow` 的主体。但 fshine 的 **INV 不变式**（`T ≤ W − Δ_worst − MIN_OUTPUT`，`pi-driver.ts:266-307`）、**窗口缩放 settings**（`compactionSettingsFor:324-344`）、**产物裁剪 `trimToBudget`**（`:481-491`）、**确定性降解 `degradeByDropping`**（`:498-515`）在 Pi 0.85.1 无对应物，仍须保留。⇒ 迁 Session **不能**删干净；反而新增适配。
3. **会不会破坏 fshine 对业务会话与执行事实的控制？**
   风险点：Pi Session store 会成为**第二套会话状态**，与 fshine 的 `execution-runtime.ts:279 Session` / `task-registry` 并存；须把 fshine 的 `AgentMessage[]` 转录与 Pi `Entry[]` **双向同步/对账**（同步恢复一致性成本），并新引入一处失败面。执行事实（taskNo/resultText）本就在 fshine 底账、独立于转录（本文 PoC ⑧），大概率不受影响；但会话状态与压缩产物的控制权会部分让渡给 Pi Session 生命周期。

**S 的代价 vs 收益**：收益 = 可能少维护约 100–150 行编排；代价 = 引入第二套会话状态 + 同步对账 + 一处新失败面 + 迁移风险，且**仍删不掉 INV/缩放/裁剪/降解四处**。**代价 > 现有编排的最小修复 ⇒ 判据要求明确建议不迁移**（decision-log §六十九“不能删到完全交给 Pi”同结论）。

## 5. 未验证项

- A 的**行为等价**目前有：D3 恒等（代数可证）、D1 的 transformContext 覆盖（实测，见 PoC ③b）。但 A 实施后的**反向绊线未跑**（migration-plan §回归矩阵列出）——列为实施前置。
- S 的同步对账成本为**定性估计**，未做迁移原型。
- 零收益循环（D3 相关）在**生产 128k** 的命中率无读数，不外推（PoC 几何取自 W=8192）。
