# R5 压缩机制归属审计（r5-cmpaudit）

- 基线：`arch/integration` @ `76bcf8d`（本审计在主仓同分支同 HEAD 只读完成；指定 worktree `~/projects/fshine-agent-r5-cmpaudit` 不存在，已如实登记）。
- 方式：**零模型调用、产品代码 0 修改**。全部结论读自实际源码（含 `node_modules/@earendil-works/pi-agent-core@0.85.1` 锁定版本，只读）与既有证据（`.runtime/r5p3s45/events.md`、`.runtime/r5preaudit/p0b.md`、decision-log §六十五/§六十八 的 S1–S5 实测数据）。
- 边界提醒：S1–S5 全部实测都在**测试窗口 W=8192** 下取得（`scripts/eval/p3/p3a-session.ts:109`、`p3b-session.ts:131`、`p3s5-session.ts:149` 显式注入 `LLM_CONTEXT_WINDOW:'8192'`）；本文**不把 W=8192 的表现外推为生产 128k 必然同故障**。

## 1. 压缩机制调用链（Pi vs fshine 各负责哪一段）

| 环节 | 实现 | 证据 |
| --- | --- | --- |
| 压缩设置缺省 | **Pi**：`DEFAULT_COMPACTION_SETTINGS={enabled:true, reserveTokens:16384, keepRecentTokens:20000}` | `node_modules/@earendil-works/pi-agent-core/dist/harness/compaction/compaction.js:75-79`（本次亲读） |
| 阈值判据 | **Pi**：`shouldCompact = contextTokens > contextWindow − reserveTokens` | compaction.js:144-148 |
| token 计量 | **Pi**：`calculateContextTokens`（provider usage，compaction.js:81-84）与 `estimateTokens`（chars/4，compaction.js:166-204）；fshine 复用 `estimateContextTokens` | compaction.js 同上；`packages/agent/src/pi-driver.ts`（splitForCompaction 内调用） |
| 摘要生成 | **Pi**：`generateSummary` → `generateSummaryWithRequest`（maxTokens = min(⌊0.8×reserve⌋, model.maxTokens)，每 chunk 一次 `completeSimpleWithRetries` 真实模型调用） | compaction.js:362-412（本次亲读 maxTokens 公式） |
| 回合内每条请求前的上下文变换钩子 | **Pi**：`Agent` 的 `config.transformContext` 在**每条**请求（含首条）前执行 | `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:178-180`（P0-B 实测核实，见 `.runtime/r5preaudit/p0b.md` 附录） |
| 设置按窗口缩放 | **fshine**：`compactionSettingsFor`（默认臂沿用 Pi 常数；小窗臂 25%/30% 缩放 + INV 下界 `reserve ≥ Δ_worst+1024`） | `packages/agent/src/pi-driver.ts:324-351` |
| 最坏差值 Δ_worst | **fshine**：`fixedRequestOverheadTokens = 4096 + sys/4 + tools/4` | pi-driver.ts:290-307 |
| 切分（保护当前回合） | **fshine**：`splitForCompaction`（lastUser 之后整轮保留，start ≤ lastUser） | pi-driver.ts:384-414 |
| 有界摘要（分片） | **fshine**：`summarizeWithinWindow`（前缀超单次预算时 oldest-first 分片续写，MAX_SUMMARY_CHUNKS 上限；每个 chunk 调一次 Pi `generateSummary`） | pi-driver.ts:441-477 |
| 产物裁剪 / 降解 | **fshine**：`trimToBudget`（pi-driver.ts:481-491，Pi 无对应物——grep compaction.js 无 trim）、`degradeByDropping`（pi-driver.ts:498-525） | 同左 |
| 压缩主函数 | **fshine**：`compactTranscriptWithPi`（阈值→切分→Pi 摘要→trim；no_cut 且超 LIMIT 抛 `context_invariant_violated` 有界失败） | pi-driver.ts:532-618 |
| 回合前 INV 复核 | **fshine**：`run()` 请求前 `T > W−Δ−1024` 先 force 压缩，仍无解则有界失败 | pi-driver.ts:655-692 |
| 回合内应急 | **fshine**：`transformContext`（Pi 定义的钩子，fshine 填实现）：`tokens > W − emergencyHeadroom` 时 force 压缩 | pi-driver.ts:701-711；`emergencyHeadroom = max(1024, Δ_worst+1024)` @ pi-driver.ts:657 |
| overflow 错误恢复 | **fshine**：`isContextOverflowError` 分支先压缩再重发；瞬时错误走 **Pi** `isRetryableAssistantError` 有界重试 | pi-driver.ts:746-759, :760, `@earendil-works/pi-ai/utils/retry` |
| 溢出恢复（另一套） | **Pi**：`prepareOverflowCompaction`，每代一次，`generation.overflowRecoveryUsed` 门控 | pi-agent-core `runtime/drive/structural.js:871-879`（owner 提供事实，本次未逐行复读 structural.js——登记为引证） |

**两套并存的真相**：阈值/预留/溢出恢复在 Pi harness（Session/serve 路径）与 fshine 驱动（Agent + transformContext 路径）各有一套。fshine 的 `createPiTurnDriver` 走 Agent 循环，**Pi harness 的 compaction/overflow 管线不在这条路径上运行**；fshine 复用的是 Pi 的原子件（settings/shouldCompact/estimate/generateSummary/transformContext 钩子），编排是自己的。另有一处**fshine 内部的双重把关**：`run()` 请求前 INV 复核（pi-driver.ts:661-692）与 `transformContext` 应急线（:701-711）功能重叠，且 `pi-driver.ts:658` 注释「transformContext 只在回合内兜底，首条请求前不经过它」已被 P0-B 实测**证伪**（agent-loop.js:178-180 对每条请求含首条先跑 transformContext）——注释失实已登记，未改码（.runtime/r5preaudit/p0b.md 附录）。

## 2. 机制分类表

| 机制 | 分类 | 依据（一行） |
| --- | --- | --- |
| `generateSummary` / 摘要 prompt / 重试 | **Pi Native** | compaction.js:362-412，fshine 直接调用（pi-driver.ts:466-470） |
| `estimateContextTokens` / `estimateTokens` 计量 | **Pi Native** | compaction.js:81-84, 166-204 |
| `transformContext` 钩子机制 | **Pi Native** | agent-loop.js:178-180，每条请求前执行 |
| `isRetryableAssistantError` 瞬时错误重试 | **Pi Native** | pi-ai/utils/retry；pi-driver.ts:760 |
| `Agent` 装配、`plannerMessagesToLlm` 转录续用 | **Integration** | pi-driver.ts:682-696 |
| `compactionSettingsFor`（小窗缩放 + INV 下界） | **Necessary Extension**（有实证） | Pi 常数按 128k 设计，小窗口下摘要请求装不下（pi-driver.ts:312-323 注释陈述的机械理由 + P0-B 实测 W=40000 场景）；Pi 无按 Δ_worst 缩放的入口 |
| `summarizeWithinWindow` 分片 | **Necessary Extension**（有实证） | Pi `generateSummaryWithRequest` 单请求装整段前缀（compaction.js:385-395 serializeConversation 全量），超窗前缀必然失败；fshine 分片后每片有界（pi-driver.ts:441-477） |
| `trimToBudget` / `degradeByDropping` | **Integration**（Pi 无对应物，产物兜底属宿主确定性责任） | grep compaction.js 无 trim/degrade；pi-driver.ts:481-525 |
| `compactTranscriptWithPi` 编排（阈值→切分→摘要→trim） | **Integration**（Pi harness 的 compaction 编排不在 Agent 路径上，必须有人填 transformContext） | pi-driver.ts:532-618；Pi harness 管线在 Session/serve 路径 |
| `run()` 请求前 INV 复核臂 | **Duplicate**（与 transformContext 双闸重叠，且其存在理由的注释已被实测证伪） | pi-driver.ts:661-692 vs :701-711；agent-loop.js:178-180 |
| `transformContext` 内第二套阈值（emergencyHeadroom 公式） | **Duplicate/边缘**（与 INV 复核线同公式同值：W−Δ−1024；小窗下两线重合为 2512） | pi-driver.ts:657 vs :661；W=8192 实测两线均 2512 |
| `pi-driver.ts:658` 注释（transformContext 首请求前不执行） | **Duplicate（失实文档）** | P0-B 实测证伪，登记未修 |
| fshine 内部重复实现 Pi harness 已有的溢出恢复语义（错误分支 force 压缩重发） | **边缘 Integration**（Pi 的 `prepareOverflowCompaction` 不在 Agent 路径，此为路径内等价物；是否可收敛到 Pi 上游待上游验证） | pi-driver.ts:746-759 vs structural.js:871-879 |
| 「压缩冷却 / 摘要治理器」类设想 | **Unproven**（且违反本次边界：不新增状态机/冷却器） | 无任何失败注入或消融证据；未实施 |
| 「摘要文本落盘观测」 | **Unproven（未做）** | 摘要正文未落盘是 S4/S5 归因的证据缺口（见 §7） |

## 3. 55/79 无收益压缩：原因与实际成本

**分布**（`.runtime/r5p3s45/events.md`，driverEvents 逐条核验）：

- 79 次 `context_compacted` 中 55 次（69.6%）tokensAfter == tokensBefore：S1=36、S2=19。
- 55/55 均为严格三连 `context_emergency_compact → context_compact_trimmed(removedMessages=0) → context_compacted(零收益)`，全部来自 emergency 臂。
- **55/55 都真实调用了模型**（summaryChunks=1，摘要成功但产物 token 与压缩前相等）——「零收益」≠「没调模型」。代码链：transformContext force（pi-driver.ts:710）→ `compactTranscriptWithPi` → `summarizeWithinWindow` 每 chunk 一次 Pi `generateSummary`（pi-driver.ts:466-470；compaction.js:369-412）。
- **根因是结构性互锁，不是计量错误**：W=8192 下 emergencyHeadroom = max(1024, 4656+1024) = 5680 ⇒ 触发线 2512（pi-driver.ts:657,703；与 S1/S2 实测 headroom≈5680、触发线≈2512 逐位吻合）。`splitForCompaction` 保护当前回合（start ≤ lastUser，pi-driver.ts:398-405），prefix 只剩 0-1 条旧消息 ⇒ 摘要换摘要，tokensAfter 精确等于 tokensBefore ⇒ 下一条请求前 transformContext 再触发（S1 turn13 单轮 10 连三连）。循环条件：触发线(2512) < 无效压缩稳态 tokens(2546-8154)。
- 对照组：真正生效的压缩 S1=13 次（共削 51,711 tok）、S2=11 次（共削 34,260 tok），全部发生在回合边界（keptMessages=0）。

**实际成本合计**：

- 55 次零收益 = **≥55 次纯开销摘要模型调用**（每次 ≥1 chunk），token 削减 0。
- 耗时：带无效链的轮 S1 t13=205s（10 连）、t14=97s、t15=85s、t3=65s；无压缩轮 4-12s。
- 会话总账（budget 计数）：S1=32 calls/265,450 tok/862s，S2=30 calls/150,444 tok/596s。
- **核账缺口（如实登记）**：budget 计数（32）< emergency 次数（36），摘要调用疑似不经 budget hook，真实模型调用总数 ≥ budget 计数 + 压缩摘要调用，无法精确核账；摘要 token 消耗未单独计量。

## 4. 删除候选清单

| 候选 | 可删什么 | 删后谁负责 | 边界风险 |
| --- | --- | --- | --- |
| D1 `run()` 请求前 INV 复核臂 | pi-driver.ts:661-692（含 `pi_driver_pre_request_compacted`/`pi_driver_context_invariant_rejected` 事件） | Pi `transformContext` 钩子（实测每条请求含首条前执行，agent-loop.js:178-180）+ `compactTranscriptWithPi` 内 no_cut 抛错 | P0-B 曾实测该臂拦截「不可救」场景 calls=0；删除前必须用同一夹具反向验证 transformContext 臂同样拦截（否则回退）。`no_cut 且超 LIMIT` 的有界失败在 compactTranscriptWithPi 仍有，但「压缩产物仍超线」的复查将失去一道闸 |
| D2 `pi-driver.ts:658-660` 失实注释 | 注释两行 | 无（文档修正） | 无 |
| D3 emergency 线与 INV 线二选一 | 两线同公式同值（657 vs 661），若留 D1 则 transformContext 阈值可直接复用 invariantLimit 变量 | 同一公式单一来源 | 行为等价（小窗下已证重合；大窗下需断言 max(1024, Δ+1024) ≥ Δ+1024 恒真 ⇒ 恒等） |
| D4 评测配置 W=8192 | 非产品码：p3 系列 session 脚本的小窗注入 | 评测按需保留（它本就是为触发压缩而设的实验变量） | 删除会失去压缩触发的可控实验窗口——**不建议删，建议登记「W=8192 读数不得外推生产」** |
| 不建议删 | `compactionSettingsFor`/`summarizeWithinWindow`/`trimToBudget`/`degradeByDropping`/`splitForCompaction` | — | 均为 Necessary Extension/Integration（§2），Pi 在 Agent 路径上无对应物；删除即失去小窗可用性，且违反「删除需先证无退化」纪律 |

## 5. A/B/C 三方案比较

- **方案 A（删重收敛）**：执行 D1+D2+D3——去掉 fshine 内部重复闸与失实注释，单一阈值、单一把关（transformContext），其余保持。
- **方案 B（A + 最小机制修复无效循环）**：在 A 之上，让 emergency 臂复用现有 `degradeByDropping`/`trimToBudget` 语义处理「压缩产物零缩减」的情形（例如 transformContext 发现产物 tokens 不降时不再原样返回触发下一轮，而走确定性降解）——**注意：任何「每回合只压一次」式门控都新增 Runtime 状态，违反本次边界，只能列为需 owner 裁定 + Eval 前置的候选，不是本审计建议**。
- **方案 C（现状不动，仅补观测）**：不删不修，先落盘摘要正文与摘要调用计量，补齐 §3/§7 的证据缺口后再裁。

| 维度 | A 删重收敛 | B A+最小机制修复 | C 现状+观测 |
| --- | --- | --- | --- |
| 正确性 | 不变（双闸行为等价，见 D3 恒真断言） | 可能改善（消除 55 次零收益循环） | 不变（空答/交办丢失照旧） |
| 长任务可靠性 | 不变 | W=8192 下改善；128k 未验证 | 不变 |
| 交互质量 | 不变 | 可能改善（减少 205s 级卡顿轮） | 不变 |
| 维护成本 | ↓（少一套闸 + 修失实注释） | ↓↓ 但引入新行为需长期维护 | → 但失实注释持续误导 |
| 代码规模 | −约 30-40 行 | −30 加 ~10-20 | 0 |
| 额外 token 开销 | 0（删除不产生调用） | W=8192 下省 ≥55 次摘要调用/会话；128k 未测 | +落盘观测成本，模型调用不变 |
| 前置条件 | 反向绊线（P0-B 不可救夹具必须仍拦截） | B 类失败注入 + A 类消融 Eval（准入五条） | 无 |

**推荐：A 立即可做（纯删重、行为等价可证）；B 必须先过机制准入五条（尤其①最小可复现失败已有 W=8192 证据、⑤前后 Eval——128k 生产窗口读数尚缺）；C 是 B 的证据前置，可与 A 并行。**

## 6. 最小实施计划（只列不实施）

1. **D2 注释修正**（先行，零风险）：`packages/agent/src/pi-driver.ts:658-660` 改为如实陈述「transformContext 每条请求（含首条）前执行（agent-loop.js:178-180）；本复核为纵深防御」或随 D1 一并删除。
2. **D1 删 INV 复核臂**：删除 pi-driver.ts:661-692 中请求前 force 压缩分支；保留 `fixedOverhead` 计算（emergency 线仍用）。`compactTranscriptWithPi` 的 no_cut 抛错（:553-566）不动。
3. **D3 阈值单一来源**：transformContext 阈值改用 `invariantLimit`（或反向：删 emergencyHeadroom 变量），补一条断言两式恒等的单测。
4. **回归测试**：
   - 反向绊线：用 P0-B 同款夹具（`.runtime/r5preaudit/p0b.md` 的不可救 220k 场景与 66k 可救场景）验证删除后：不可救 → calls=0 且有界失败事件仍出现（事件名可能改为 transformContext 臂发出，需同步测试断言）；可救 → 首请求 tokens ≤ W−MIN_OUTPUT。
   - 全量 `npx tsc --noEmit` + `npx vitest run`（基线 794 passed）。
   - 涉及事件断言的单测同步更新（`pi_driver_pre_request_compacted` 相关）。
5. **不实施项登记**：B 方案机制修复、摘要落盘观测、W=128k 生产窗口复测——均待 owner 裁定与本审计之外的预算。

## 7. 未解决问题（已证实缺陷 vs 未验证假设，严格区分）

**已证实（有机制证据）**：
- F1：55/79 无收益压缩全部真实调用模型，结构性互锁成因（§3，代码+实测双证）。
- F2：`pi-driver.ts:658` 注释与依赖事实不符（agent-loop.js:178-180 实测证伪）。
- F3：`run()` INV 复核臂与 `transformContext` 双闸功能重叠（W=8192 下两线恒等 2512）。
- F4：W=8192 下压缩后空答（S4/S5 塌缩轮均对应 tokensAfter=15 近空摘要，tokensAfter>200 无反例）——**层级归 Pi 压缩层成立，但仅在测试窗口证实**。

**未验证假设（明确标注）**：
- H1：近空摘要的直接成因（`maxTokens=min(0.8×reserve, model.maxTokens)` 在 W=8192 下是否被压到近零，pi-driver.ts:449 / compaction.js:380 公式已亲读，但摘要正文未落盘，无法判定是预算近零还是模型行为）。
- H2：W=128k 生产窗口是否存在同类无效循环/近空摘要——**无任何读数，不得由 W=8192 外推**。
- H3：摘要调用是否计入 budget hook（32 < 36 的缺口未闭合）。
- H4：原始 JSON 泄漏——S4/S5 **未复现**（44 轮扫描 0 命中），不得归咎 Pi 压缩；此前 S2 的 1 例无机制定位，维持未验证。
- H5：取消悬空（S5 t18 虚答「未执行过取消」）已判定为控制意图回执失败、安全面无失控（task_cancel 确有执行），其与压缩的因果共变未定（摘要未落盘）。

## 结论

1. **fshine 当前压缩管理是否超出必要集成职责？——部分超出，幅度有限且可精确切除**：编排面（compactTranscriptWithPi/分片摘要/缩放设置/降解）是 Agent 路径上 Pi 未提供、且有实证必要的 Integration/Necessary Extension，**不超职责**；超出职责的是 fshine **内部**的第二道闸（run() 请求前 INV 复核臂）+ 与 transformContext 重复的阈值公式 + 失实注释（§2 Duplicate 三行），其存在理由已被依赖源码实测证伪。
2. **能否直接复用 Pi 原生并删除重复实现？——能，且仅限上述重复三处（D1/D2/D3）**：Pi 原生 `transformContext` 钩子实测覆盖首条请求，删除 fshine 重复闸后单一把关仍成立；行为等价可由恒真断言 + P0-B 夹具反向绊线证明。**不能**删到「完全交给 Pi」——Pi harness 的 compaction/overflow 管线不在 `createPiTurnDriver` 的 Agent 路径上，settings 缩放、有界分片摘要、产物裁剪在 Pi 0.85.1 中无 Agent 路径对应物，删除它们没有「Pi 原生可承接」的证据。条件：D1 实施必须先跑反向绊线；若 128k 生产窗口复测出现 transformContext 臂拦不住的场景，则回退 D1。
