# Pi 压缩编排 · PoC 方法与实际结果（r5-piopt 汇总员复跑）

> 目的：在**产品代码零修改、零付费模型、零网络**前提下，确定性验证 fshine 现有压缩编排（`packages/agent/src/pi-driver.ts`）在 8 类场景下的机械行为，作为 A/B/C 与迁移判断的证据。
> 本文件结果由**汇总员本会话亲自复跑**确认，非转述。

## 1. 方法与边界

- **对象**：生产函数 `compactTranscriptWithPi`（`pi-driver.ts:532-618`）与 `createPiTurnDriver().run()`（`:621-...`）。
- **驱动**：确定性**假模型运行时**（`piopt-phase3.test.ts:37-106`）——`models.completeSimple` 返回夹具摘要（可开关“像真实供应商一样拒绝超窗请求”/“摘要失败”），`models.streamSimple` 计数/抛错。**不发任何网络请求**。
- **边界（硬）**：产品代码 0 修改；不升级 Pi；不读 `.env`；不烧付费额度；仅新增 `scripts/eval/piopt/piopt-phase3.test.ts`（`scripts/**` 纳入 vitest unit）。
- **复跑命令**（本会话执行）：
  ```
  TMPDIR=/home/tao/.tmp npx vitest run scripts/eval/piopt/piopt-phase3.test.ts
  ```
  **输出**：`Test Files 1 passed (1)`；`Tests 11 passed | 3 todo (14)`；`Duration 689ms`。

## 2. 实测结果（逐场景，含机械证据）

| 场景 | 断言结果 | 实测证据（运行输出） |
|---|---|---|
| ① 接近阈值→有效压缩 | **通过** | `context_compacted tokensBefore=29649→tokensAfter=20460 keptMessages=62 summaryChunks=1 window=40000`；首条为【此前会话摘要】；token 严格下降且 ≤ 阈值；当前回合问题保留 |
| ②a 未越阈值→原样返回 | **通过** | `summaryRequests.length==0`；`compacted === messages`（同一数组） |
| ②b 有 prefix 但尾段自身超目标 | **通过（暴露缺陷）** | `context_compact_trimmed tokensBefore=5011→tokensAfter=5042 removedMessages=0`；`context_compacted tokensBefore=5011→tokensAfter=5042 summaryChunks=1`——**零收益摘要调用**，§七十 precheck **未实施**故未被避免 |
| ③a no_cut 且超 LIMIT | **通过** | `compactTranscriptWithPi` 抛「上下文不变式不满足」；`summaryRequests.length==0`；发 `context_invariant_violated` |
| ③b driver.run 请求前把关 | **通过** | 超窗当前回合下 `streamCalls()==0`、`result.text===''`、发 `pi_driver_context_invariant_rejected` |
| ④ 保护当前回合 | **通过** | 保留尾段首条非 `toolResult`；`assistant`(toolCall) 与 `toolResult` 同在且 `idxCall < idxResult` |
| ⑤ 大型工具结果：摘要输入有界 | **通过** | 单条 ~100k token 下每次摘要请求 `promptTokens+maxTokens ≤ window`；`context_compacted tokensBefore=100014→tokensAfter=35 removedMessages=2`；注入摘要含「具体数据请以重新调用工具的结果为准」 |
| ⑤ 保留尾段内结果原文一致 | **通过** | `context_compacted tokensBefore=29808→tokensAfter=20619 keptMessages=64`；`toolResult` 正文字节 == 原文（无驱动级静默截断） |
| ⑥ 重复摘要循环 | **通过（复现）** | 两轮 `context_compact_trimmed`+`context_compacted`：`5011→5042`、`5042→5042`——`tokensAfter ≥ tokensBefore`，每轮 `summaryChunks≥1`（≥1 次真实摘要调用） |
| ⑦ 压缩后继续交办（机制面） | **通过** | 摘要指令含「当前正在处理的对象标识」「分页游标原值」「未决问题」；注入摘要含「更早的逐字内容已不在上下文中」；当前回合问题保留 |
| ⑧ 执行事实找回 | **通过** | 转录被压掉 `ORD-2026-0999` 后，`task-registry` 仍原样读回 `taskNo`/`name`/`resultText`/`executions`——**事实存于 fshine 底账，独立于被压缩的转录** |

**核心实测结论**：
1. **有效压缩可用**：大转录（29.6k→20.5k）首条原生摘要、严格下降并回落阈值下、当前回合保留（场景①）。
2. **避免无收益调用的缺口被证实**：有 prefix 但尾段自身超目标时，**当前仍发起摘要且零/负收益**（场景②b、⑥）——§七十 precheck 未实施，缺陷真实存在且可复现。
3. **有界失败成立**：no_cut 且超 LIMIT 时**一次请求都不发**（场景③a/③b）。
4. **执行事实不受压缩影响**（场景⑧）——fshine 对业务事实的控制**不被压缩层破坏**。

## 3. 失败项 / 复现的非缺陷现象

- **无失败断言**：11 个断言全绿。
- **②b、⑥ 是“通过但暴露缺陷”**：用例断言的是“现状会发起零收益摘要调用”，故绿；但它**复现了 decision-log §六十九的 55/79 零收益结构**，是 B 方案要修的目标。

## 4. 未验证项（严格登记，不默认通过）

`piopt-phase3.test.ts:427-431` 以 `it.todo` 显式登记 3 项，本会话复跑确认仍为 `todo`（未运行）：

1. **⑦ 摘要正文的语义质量**（是否真的无损保留对象标识/游标/未决问题）——需真实模型判质量，本轮零付费实验，**未验证**。
2. **②b/⑥ 在 128k 生产窗口的命中率与用户级影响**——无真实长会话读数，**不外推**（本 PoC 零收益几何取自 §六十九的 W=8192 测试窗口，非生产 128k）。
3. **⑤ 大型工具结果在真实执行层侧的裁剪策略**——本 PoC 只覆盖**驱动消费侧**，执行层侧**未验证**。

另登记（非本 test 内）：Pi harness `structural.js` 的 overflow 管线**未运行**（只读静态阅读）。

## 5. 证据路径

- 测试源：`scripts/eval/piopt/piopt-phase3.test.ts`（431 行）。
- 被测生产代码：`packages/agent/src/pi-driver.ts`（`compactTranscriptWithPi:532-618`、`createPiTurnDriver:621-`）。
- 复跑命令与输出：见 §1。
- 关联台账：`docs/decision-log.md` §六十九（55/79 零收益）、§七十（precheck 设计）；审计全文 `docs/product/r5-compaction-audit.md`。
