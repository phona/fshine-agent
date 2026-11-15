# R5-B 压缩前判定设计：调用摘要模型之前判断「这次压缩有没有意义」

- 基线：worktree `~/projects/fshine-agent-r5-bdesign`，分支 `arch/r5-bdesign` @ `7a769a7`。
- 方式：**docs-only、产品代码 0 修改、零真实模型调用**。结论读自实际源码（含主仓只读 `node_modules/@earendil-works/pi-agent-core@0.85.1`）与已合入的 `docs/product/r5-compaction-audit.md`。
- 本文**只设计，不实施**：不新增 Runtime 冷却器/状态机、不做默认的事后确定性丢弃、不动冻结面、不重写 Worker 提示。
- 窗口边界提醒（继承审计 §5）：全部实测在测试窗口 **W=8192** 下取得；本文不把 W=8192 的表现外推为生产 128k 必然同故障。

---

## ① 最小复现（既有 W=8192 证据链 + 可复跑的确定性夹具）

### 1.1 真实会话证据链（观察到的现象，引用既有产物）

- **分布**：79 次 `context_compacted` 中 55 次（S1=36、S2=19）`tokensAfter == tokensBefore`（零收益），全部为严格三连 `context_emergency_compact → context_compact_trimmed(removedMessages=0) → context_compacted(零收益)`，全部来自回合内应急臂；55/55 都真实发起过摘要模型调用（`summaryChunks=1`）。证据：`docs/product/r5-compaction-audit.md` §3；原始 `driverEvents` 逐条位于 phase3 worktree 的 `.runtime/r5phase3/s1/evidence.json`（123 条）与 `s2`（71 条）——`.runtime` 不入库，属本机产物。
- **单轮放大**：S1 turn13 单轮连续 10 次三连（审计 §3）。耗时对照：带无效链轮 205s/97s/85s，无压缩轮 4–12s。
- **成因**（审计 §3，代码+实测双证）：`emergencyHeadroom = max(1024, Δ+1024) = 5680` ⇒ 触发线 `W − 5680 = 2512`；`splitForCompaction` 保护当前回合（`pi-driver.ts:398-405`）⇒ 前缀只剩 0–1 条旧消息 ⇒ 摘要换摘要 ⇒ `tokensAfter == tokensBefore` ⇒ 下一条请求前 `transformContext` 再触发。循环条件：`触发线(2512) < 无效压缩稳态 tokens(2546–8154)`。

### 1.2 可复跑的确定性夹具（零真实模型）

无需真实模型即可复现触发条件与阈值几何，路径：

- `scripts/eval/p3/compaction-proof.ts`（**零真实模型**，`node --import tsx scripts/eval/p3/compaction-proof.ts`）：用确定性转录夹具 `p3aTranscript(40)` + 真实 sys/tools 量级，打印 W=8192 下 `compactionThreshold = contextWindow − reserveTokens`、`shouldCompact`、`preRequestInvariantBreach`、`invariantLimit`、`reserveTokens`、`keepRecentTokens`。**它能复现的只是「越线事实」**：W=8192 在该量级转录下 `shouldCompact=true`、`preRequestInvariantBreach=true`（对照 128k 两项均 `false`），脚本 `verdict=true`。
  - **该夹具本身并不产出 2512**（2026-11-15 在本仓实跑复现）：输出为 `contextWindow=8192, transcriptTokens=11320, compactionThreshold=6144, invariantLimit=3002, reserveTokens=2048, keepRecentTokens=2457, fixedOverheadDeltaWorst=4166`。原因是它调用 `compactionSettingsFor(contextWindow)` **未传 Δ**（`fixedOverhead=0 ⇒ invariantReserve=1024 ⇒ reserveTokens = max(1024, min(16384, floor(8192·0.25))) = 2048`，`pi-driver.ts:324-343`），且它自带的 sys/tools 量级给出 `Δ=4166`、**不是真实会话的 Δ=4656**。故软阈值 `6144`、`invariantLimit 3002`、`2512` **三者互不相等**。
  - 「三线重合 = 2512」**不是本夹具的读数**，而是 §2.3 在 **Δ=4656** 下的独立算术结果（`emergencyHeadroom` 触发线 / 软阈值 / INV limit 三者在 Δ=4656 下同为 2512）。按本节复跑只会得到 6144/3002——**切勿把 §2.3 的 2512 当成本夹具的输出**。
- `packages/agent/pi-driver-context-invariant.test.ts`：假模型运行时 `invariantRuntime()`（`streamSimple`/`completeSimple` 夹具，`calls()` 计数器），**零网络**，用 `compactTranscriptWithPi(...)` 直测生产压缩实现。可在此构造「当前回合占满窗口、无可摘要前缀」的 `noCutOverLimit` 夹具（文件内 `userMessage(23_600)`）。
- `packages/agent/compaction-product.test.ts`：假模型运行时 `fakeRuntime()`（返回固定摘要、零网络），`longTranscript()` 造大前缀长转录，直测压缩确实发生。

**结论**：**触发链（越线事实）** 在确定性夹具内可复跑（1.2）；但 **2512 三线重合的阈值几何是 Δ=4656 下的算术结果（§2.3），不是夹具（1.2）的输出**——夹具未传 Δ、自带 Δ=4166，读数为 `threshold=6144 / invariantLimit=3002`。真实会话数据（1.1）只作现象引用。压测脚本（`scripts/eval/p3/p3a-session.ts:109`、`p3b-session.ts:131` 显式注入 `LLM_CONTEXT_WINDOW:'8192'`）用于产生 1.1 的读数，本身不进入本次设计回归。

---

## ② 方案：无状态预判（纯函数，摘要调用之前）

### 2.1 判定位置

在 `compactTranscriptWithPi` 内、**切分之后、`summarizeWithinWindow(prefix, ...)` 之前**（`pi-driver.ts:543` 与 `:577` 之间）。此处 prefix/kept 已定，且**尚未发起任何模型调用**——正是「不发起无收益摘要调用」的判定点。

### 2.2 用到的既有量（全部在判定点已可用，无需新状态）

| 量 | 来源 | 含义 |
| --- | --- | --- |
| `est.tokens`（即 `tokensBefore`） | `estimateContextTokens(messages)` `pi-driver.ts:540`；Pi `compaction.js:117-142` | 压缩前转录估算 |
| `settings` | `compactionSettingsFor(W, Δ)` `pi-driver.ts:539` | `reserveTokens` / `keepRecentTokens` |
| `prefix` / `kept` | `splitForCompaction(...)` `pi-driver.ts:543` | 可摘要前缀 / 保留尾段（含当前回合保护） |
| `Δ`（`fixedOverhead`） | `fixedRequestOverheadTokens` `pi-driver.ts:298-307` | 最坏请求框架差值 |
| `MIN_OUTPUT` | `MIN_OUTPUT_BUDGET_TOKENS=1024` `pi-driver.ts:292` | 最小输出预算 |
| `target` | `max(1, W − settings.reserveTokens)` `pi-driver.ts:598` | 压缩产物目标上界（== 触发线） |
| `limit` | `W − Δ − MIN_OUTPUT` `pi-driver.ts:661`（`invariantLimit`） | 硬安全上界（INV） |
| `estimateTokens(msg)` | Pi `compaction.js:166-204` | 逐消息估算（与 usage 锚点无关） |
| `SUMMARY_PROMPT_OVERHEAD_TOKENS` | `pi-driver.ts:261` | 摘要模板余量 |

补充观察（不改，仅记录）：`estimateContextTokens` 已返回 `usageTokens/trailingTokens/lastUsageIndex`（provider 实测锚点），但 `pi-driver.ts` 目前只取 `.tokens` 丢弃锚点。预判**不需要**锚点——切分用逐消息 `estimateTokens`，锚点不改变 prefix/kept 结构。

### 2.3 判定式与伪代码

设（均为纯函数、无副作用、无跨调用记忆）：

```
W         = model.contextWindow
Δ         = fixedOverhead
target    = max(1, W − settings.reserveTokens)          // == 软触发线
limit     = W − Δ − MIN_OUTPUT                          // == 硬安全上界 INV
estTok    = estimateContextTokens(messages).tokens       // == tokensBefore
prefixTok = estimateContextTokens(prefix).tokens
keptTok   = estimateContextTokens(kept).tokens
summaryFloor = estimateTokens(摘要消息空正文)  // 仅包装串【此前会话摘要】+尾注的最小成本
```

**核心不变式**：压缩产物是 `[摘要消息, ...kept]`，故 `tokensAfter ≥ keptTok + summaryFloor`。因此——

1. **零缩减**（摘要比它替换的前缀还大，数学上不可能降）：`prefixTok ≤ summaryFloor`。
2. **无法达标**（保留尾段自身已到/超目标，任何非负摘要都只会把它推得更高）：
   `keptTok + summaryFloor ≥ target`。
   此时即便摘要为**零长度**，`tokensAfter ≥ target`，下一条请求前必然再次触发——**结构上不可能终止循环**。

```
function compactionWorthwhile(prefix, kept, settings, W, Δ, estTok):
    target = max(1, W − settings.reserveTokens)
    limit  = W − Δ − MIN_OUTPUT
    if prefix.length == 0:
        return NO_CANDIDATE                 // 边界②③：无可摘候选，交既有 no_cut 路径
    prefixTok = estimateContextTokens(prefix).tokens
    keptTok   = estimateContextTokens(kept).tokens
    summaryFloor = estimateTokens(空正文摘要消息)
    // (1) 零缩减（严格可证）
    if prefixTok <= summaryFloor:
        return NOT_WORTH(reason="zero_reduction")
    // (2) 无法达标 → 结构上无法终止循环（严格可证，不假设摘要长度）
    if keptTok + summaryFloor >= target and estTok <= limit:
        return NOT_WORTH(reason="tail_at_or_over_target_loop")
    // (3) 否则值得压
    return WORTH

// compactTranscriptWithPi 内：
if (compactionWorthwhile(...) == NOT_WORTH):
    emit 事件 context_compact_precheck_skipped { estTok, prefixTok, keptTok,
         summaryFloor, target, limit, prefixMessages, reason }
    return messages                      // 不发起摘要模型调用
// WORTH：沿用既有 summarizeWithinWindow → trim 路径，行为不变
```

**触发线在 W=8192 下三线重合的几何事实**（审计 §3 复核）：`compactionSettingsFor(8192, 4656)` ⇒ `reserveTokens = max(5680, min(16384, 2048)) = 5680`，故 `target = 8192 − 5680 = 2512`；`limit = 8192 − 4656 − 1024 = 2512`；`shouldCompact` 阈值 `W − reserve = 2512`。**三线同为 2512**，因此规则 (2) 中 `estTok ≤ limit` 与「越软触发」在 W=8192 下同义——这正是 S1/S2 无效循环的窗口特征。（**等式口径**：三线同为 2512 的前提是把真实会话的 **Δ=4656** 传入 `compactionSettingsFor`；§1.2 夹具未传 Δ、自带 Δ=4166，故其读数 `threshold=6144 / limit=3002` 与本节 2512 **不同口径，勿混用**。）

### 2.4 为什么判定 (2) 是安全的

规则 (2) 只在 `keptTok + summaryFloor ≥ target` 时判 NOT_WORTH，即**保留尾段自身已够满**。这不是启发式，而是「任何非负摘要都改不了 `tokensAfter ≥ keptTok + floor ≥ target`」的直接推论。因此它**不会**误杀「前缀很大、尾段很小」的正常压缩（那种情形 `keptTok` 远小于 `target`，规则 (3) 判 WORTH）。

---

## ③ 边界表（四类逐类给判定与预期行为）

| # | 场景 | 判定式落点 | 预期行为 | 不变量 |
| --- | --- | --- | --- | --- |
| ① | **有可压缩候选但摘要零收益**（最核心） | `prefix.length > 0` 且 `keptTok + summaryFloor ≥ target`（或 `prefixTok ≤ summaryFloor`） | 规则 (2)/(1) 判 NOT_WORTH；发 `context_compact_precheck_skipped`；**不调用摘要模型**；`compactTranscriptWithPi` 原样返回 `messages` | 相对现状省去 ≥55 次零收益摘要调用；不引入新状态 |
| ② | **当前回合自身已超窗**（无可压缩历史时的行为） | `prefix.length == 0` → NO_CANDIDATE | 落回**既有** `no_cut` 分支（`pi-driver.ts:549-575`）：`estTok > limit` ⇒ `context_invariant_violated` 有界失败；否则 `context_compact_no_cut` 原样返回 | 与现状**逐字节一致**，预判不介入 |
| ③ | **无历史可压缩**（prefix 为空，如首条消息/极小转录） | `prefix.length == 0` → NO_CANDIDATE | 同上，既有 `no_cut` 路径；通常 `estTok ≤ limit`，原样返回、放行请求 | 与现状一致；不伪造摘要 |
| ④ | **正常溢出恢复**（真溢出时应走的既有路径不能被挡） | 大前缀、小尾段 ⇒ `keptTok + summaryFloor < target` → WORTH | 规则 (3) 判 WORTH，**照常调用** `summarizeWithinWindow`；`run()` 前 INV 臂、overflow 恢复臂（`pi-driver.ts:746-759`）行为不变 | 预判在可救场景**零改动**；且即便误判 NOT_WORTH，三处既有网兜仍兜底（见 ④ 说明） |

**边界 ④ 的三重既有兜底**（证明预判退回原样不会造成回归）：
- `transformContext`（`:701-711`）返回原样 → 该请求照发，不重复模型调用。
- overflow 恢复臂（`:746-751`）：`compactTranscriptWithPi` 返回原样 ⇒ `tokensAfter == tokensBefore` ⇒ 命中既有 `if (tokensAfter >= tokensBefore) break`（`:750`）——**现状本就把「压不动」当停止条件**。
- `run()` 前 INV 臂（`:662-686`）：返回原样 ⇒ 若仍 `> limit` ⇒ `:669` 抛错 ⇒ 被 catch ⇒ `pi_driver_context_invariant_rejected` 有界失败。
即使预判把某个可救场景**误判**为 NOT_WORTH，上述任一路径都不会把超窗请求发出去、也不会无限重试。故预判是**安全叠加**，不是新决策路径。

---

## ④ 有界失败定义（何种情况判不值得压、如何如实上报）

**「不值得压」本身不是失败**，是一条**跳过**决定。仅当跳过之后请求**不可交付**时才升级为有界失败：

- **NOT_WORTH 判定的两种原因**（如实写入事件，不粉饰）：
  - `zero_reduction`：`prefixTok ≤ summaryFloor`——数学上摘要不可能小于被替换量。
  - `tail_at_or_over_target_loop`：`keptTok + summaryFloor ≥ target`——保留尾段自身已达/超目标，压缩结构上不能终止再触发循环。
- **升级为有界失败的唯一条件**：`estTok > limit`（转录已越硬安全上界、请求不可交付）**且**预判判 NOT_WORTH。此时：
  - **不**调用摘要模型（现状态下它救不回，且会白烧一次调用）；
  - 走既有有界失败（一次判定、立即拒绝、不发请求、不重试）；
  - **事件名随失败分支而定（以源码为准）**：预判 NOT_WORTH 发生在 `prefix.length > 0`，`compactTranscriptWithPi` 在发起摘要前原样返回 `messages`；超窗判定随后落到 `run()` 的 pre-request 臂（`pi-driver.ts:662-686`），其 `catch` 发出 **`pi_driver_context_invariant_rejected`**（`:676-678`）。**`context_invariant_violated` 只在 `prefix.length == 0` 的 no_cut 分支发出**（`pi-driver.ts:555-556`）——该分支由边界②③（NO_CANDIDATE）走既有路径触发，**预判自身不发出 `context_invariant_violated`**。§3④ 与本条现已统一为 `pi_driver_context_invariant_rejected`。
  - 事件面：`context_compact_precheck_skipped`（worth 决定）+ `pi_driver_context_invariant_rejected`（交付失败）两条并列，语义分明。
- **不算失败的情形**：`estTok ≤ limit` 时判 NOT_WORTH ⇒ 只是跳过，请求照发、正常作答（S1/S2 稳态 tokens 2546–8154 中，凡 ≤ 触发线的轮据此不再空转模型）。
- **有界性保证**：预判无双状态、无重试计数；NOT_WORTH ⇒ 本次返回原样，下一次判定由**同一纯函数在同一结构**上重算——结构不变则结论不变，因此**不会反复调用模型**；结构改变（产生有效前缀）则自动转 WORTH。这满足「无法安全继续时有界失败、不反复调模型、不无限重试」。

---

## ⑤ 回归测试清单（含反向绊线）

全部走假模型运行时（`invariantRuntime` / `fakeRuntime` 同款，`calls()` 计数、零网络）。

1. **核心：零收益夹具判 NOT_WORTH 且 calls()==0**。构造 W=8192 几何：`Δ=4656`、`keepRecentTokens=2457`、`target=limit=2512`；造「当前回合 = 尾段、前缀 0–1 条、`keptTok + summaryFloor ≥ 2512`」的转录，直调 `compactTranscriptWithPi(messages, {force:true, fixedOverheadTokens:4656})`：断言**摘要模型调用为 0**、返回 `messages` 原样、且发出 `context_compact_precheck_skipped`（reason=`tail_at_or_over_target_loop`）。
2. **边界① 零缩减**：`prefixTok ≤ summaryFloor` 的极小前缀 ⇒ NOT_WORTH（reason=`zero_reduction`），calls()==0。
3. **边界② 当前回合超窗、无前缀**：复用 `noCutOverLimit`（`pi-driver-context-invariant.test.ts:114`）⇒ 仍抛 `context_invariant_violated`、calls()==0（与既有 P0-B ③ 断言一致）。
4. **边界③ 首条消息 / prefix 为空**：小转录 ⇒ 原样返回，calls()==0，无 exception。
5. **边界④ 正常溢出恢复不被挡**：大前缀、小尾段（如 `longTranscript()`）⇒ 预判判 WORTH、**摘要模型被调用（calls()>0）**、产物含【此前会话摘要】且 tokens 下降（沿用 `compaction-product.test.ts` 判据）。
6. **反向绊线 A（预判误判「无意义」→ 必须红）**：给一个**确实可压缩**的转录（大前缀/小尾段），把 `compactionWorthwhile` 的返回值打桩为 NOT_WORTH；断言此时 `calls()==0` 且 `tokensAfter == tokensBefore`、且**既有 INV/overflow 兜底随后触发**（`pi_driver_context_overflow_recovered` 不出现或 `break`）。该用例在预判真实返回 WORTH 时必须绿、被打桩成误判时必须红——即「预判一旦误判无意义，测试必须变红」。
7. **反向绊线 B（三线重合恒等断言）**：对 W=8192 与 W=128k 断言 `target == W − reserveTokens`、`limit == W − Δ − MIN_OUTPUT`，并断言 W=8192 下 `target == limit == 2512`（防止缩放公式漂移后再无人发现规则 (2) 的窗口特征变化）。
8. **回归**：`compactionSettingsFor` 缺省臂与旧行为逐字段一致（`pi-driver-context-invariant.test.ts:31-39` 已在）；`npx vitest run` 全量不得因本设计回归（实施后基线 794 passed 需保持）。**口径说明**：`794 passed` 取自 `docs/product/r5-compaction-audit.md:101` 的既有读数，是实施后需保持的**目标**；**本设计 ask 未复跑全量**，仅复跑被点名的两个文件（`pi-driver-context-invariant.test.ts` 8 tests + `compaction-product.test.ts` 1 test = 9 passed，零网络夹具）。

---

## ⑥ 是否值得改产品代码：判断与代价估计

**判断：值得，但仅为「有界、纯函数、可证」的最小切片；其余（启发式阈值 / 事后丢弃 / 冷却器）不值当。**

- **支持改的证据**：①最小可复现失败已具（本设计 §1，S1/S2 真实读数 + 确定性夹具）；②收益明确（S1/S2 各消 ≥36/≥19 次零收益摘要调用，带无效链轮 205s→可回落至无压缩轮量级）；③方案无状态、纯函数、可证（规则 (1)(2) 皆为数学推论，非启发式）；④不扩边界（不新增 Runtime 状态/冷却器、不动冻结面、不重写 Worker 提示）。
- **反对扩大的理由**：任何 `MIN_MEANINGFUL_REDUCTION_TOKENS` 式启发式常量、任何「每回合只压一次」门控，都会引入需长期维护的新行为——**均需先过机制准入五条**（含 128k 生产窗口 Eval），本次**不建议**纳入。
- **代价估计**（仅改 `packages/agent/src/pi-driver.ts` 一个文件 + 一个测试文件）：
  - 新增 `compactionWorthwhile` 纯函数 + `summaryFloor` 常量：约 25–35 行。
  - `compactTranscriptWithPi` 判定点插入 + `context_compact_precheck_skipped` 事件：约 10–15 行。
  - 回归测试 6.1–6.8：约 120–180 行（多数复用既有假运行时）。
  - **文档**：本节即交付；实施另需更新 `docs/decision-log.md`（由集成 Agent 单点写，本文不改）。
  - **风险**：低。边界 ④ 三重兜底（§③）保证预判误判也不会造成「超窗请求外发 / 无限重试」。128k 生产窗口的触发频率**无读数、不外推**，实施前建议在 128k 复测规则 (2) 命中率。
- **结论**：**值得做**——但只做 ②2.3 的严格可证判定（NOT_WORTH 跳过），不做启发式常量、不做冷却器、不做默认事后丢弃。若实施，必须先落 §⑤ 的反向绊线（预判误判「无意义」→ 红），再改生产代码。
