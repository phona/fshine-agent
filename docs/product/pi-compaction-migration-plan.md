# Pi 压缩迁移/修复计划 · 仅针对推荐方案 A

> **范围（硬）**：本文只覆盖**推荐方案 A**（删重收敛 D1+D2+D3，见 `pi-compaction-options.md` §3）。**不实施**，只列最小步骤。**产品代码本轮零修改**（本 worktree 只新增文档与 PoC 测试）。
> 前置裁决：A 为**条件式**推荐——实施前需 owner 批准且**先跑反向绊线**（decision-log §六十九「条件」）。

## 1. 目标与不变量

- **目标**：消除 fshine 压缩编排里的三处重复：
  - **D1** `run()` 请求前 INV 复核臂（`pi-driver.ts:661-686`）与 `transformContext` 应急臂（`:701-711`）重叠。
  - **D2** `pi-driver.ts:658-660` 失实注释（transformContext 覆盖首条请求已被证伪：`agent-loop.js:179-180`；PoC ③b）。
  - **D3** emergency 线（`:657`）与 INV 线（`:661`）二源同值，合一。
- **保持的不变量**：删重复闸后，**单一把关**仍成立——`transformContext`（每请求含首条）+ `compactTranscriptWithPi` 的 no_cut 有界失败（`:553-566`）承接“不发超窗请求”。
- **不删**：`compactionSettingsFor`/`summarizeWithinWindow`/`trimToBudget`/`degradeByDropping`/`splitForCompaction`（Pi Agent 路径无对应物，见 options §2）。

## 2. 最小实施步骤（3 步，单文件）

全部改动限于 `packages/agent/src/pi-driver.ts`。

**Step 0（前置，非改码）**：跑反向绊线（§4 矩阵第 6/7 项）确认当前 red/green 基线，作为 D1 的实施前置。

**Step 1（D3：阈值单源合一）**
- 在 `pi-driver.ts:654-661` 附近，令 `emergencyHeadroom` 直接由 `invariantLimit` 派生（或反之），消除 `:657` 与 `:661` 的**同式二写**。
- 加**恒等断言**：`max(1024, Δ+1024) == Δ+1024`（对 `fixedOverhead ≥ 0` 恒真），防缩放公式漂移。
- 预期：`emergencyHeadroom` 与 `invariantLimit` 共享同一 `Δ_worst = fixedOverhead` 来源。

**Step 2（D2：删/修失实注释）**
- 删除或改写 `pi-driver.ts:658-660` 的“transformContext 只在回合内兜底，首条请求前不经过它”——改为如实表述“transformContext 对**每条**请求（含首条）触发”。

**Step 3（D1：删 `run()` 请求前 INV 复核臂）**
- 删除 `pi-driver.ts:661-686` 整段（`invariantLimit` 复核 + `try/catch` + `pi_driver_pre_request_compacted`/`pi_driver_context_invariant_rejected` 事件发射）。
- 删除后首条请求的 INV 保护由 `transformContext`（`:701-711`）承担；无解场景由 `compactTranscriptWithPi` 的 no_cut 有界失败（`:553-566`）抛出、由 Agent 循环 / 现有错误面承接。
- ⚠️ **验证点**：`transformContext` 抛错时 Agent 路径是否产生等价于原 `pi_driver_context_invariant_rejected` 的可观测失败面——**须在 Step 0 绊线中以用例固定**；若无法等价，则 D1 **回退**（见 §3 条件）。

## 3. 回滚与条件

- **回滚**：A 为单文件、约 3 处改动，封装为**单个 commit**；回滚 = `git revert <commit>`（无兼容层、无双实现态，符合删除纪律）。
- **D1 回退条件**：若 128k 生产窗口复测出现 `transformContext` 臂**拦不住**的场景（首条请求仍可能越窗且未被 no_cut 捕获），则回退 Step 3（保留 `run()` INV 臂），仅保留 D2/D3。
- **不做**：不引入“每回合只压一次”门控、不引入冷却器/第二套状态（属 B/S 范畴，越界）。

## 4. 回归矩阵

| # | 检查 | 命令/文件 | 通过判据 |
|---|---|---|---|
| 1 | 类型检查 | `npm run typecheck`（或等价） | 0 error |
| 2 | 全量单测 | `npm test`（vitest） | 目标：既有绿集不减少（口径见未验证项） |
| 3 | INV 拒绝路径（a） | `packages/agent/pi-driver-context-invariant.test.ts` | no_cut 且超 LIMIT ⇒ 有界失败、0 摘要调用（对应 PoC ③a） |
| 4 | INV 拒绝路径（b） | `pi-driver-context-invariant.test.ts:114` `noCutOverLimit` | 仍抛 `context_invariant_violated`、`calls()==0` |
| 5 | 压缩产物 | `packages/agent/compaction-product.test.ts` | 产物含【此前会话摘要】且 tokens 下降 |
| 6 | 窗口缩放 | `packages/agent/compaction-window.test.ts` + 断言 | `target==W−reserveTokens`、`limit==W−Δ−MIN_OUTPUT`；W=8192 下 `target==limit==2512` |
| 7 | **反向绊线** | `scripts/eval/piopt/piopt-phase3.test.ts`（③a/③b/④/⑤） | ③b 仍 `streamCalls()==0` 且有界失败事件；④ toolCall/toolResult 配对不拆 |
| 8 | PoC 全场景 | `TMPDIR=~/.tmp npx vitest run scripts/eval/piopt/piopt-phase3.test.ts` | 11 passed（当前基线），无新增红 |

**反向绊线特别说明**：D1 卡点在于“删除重复闸后，不可救→有界失败、可救→首请求 ≤ W−MIN_OUTPUT”两向均须被用例固定（decision-log §六十九「条件」）。3 号/4 号 + 7 号 ③b 共同承担。

## 5. 预计删除范围

- `packages/agent/src/pi-driver.ts`：**净删约 26 行**（D1 臂 `:661-686`）+ 注释改写 3 行（`:658-660`）+ 常量合并（`:657`/`:661` 二写合一，约 0–1 行）。
- **不新增文件**（A 无新机制；若实施，新增的只是既有测试文件的用例）。
- 无协议、无 Runtime 状态、无第二套会话状态。

## 6. 未验证项

- **`794 passed` 等全量基线未在本会话复跑**（decision-log §七十 同口径）；矩阵第 2 项为**目标**，非已测读数。
- A 步 Step 3 的“失败面等价性”（§2 验证点）**未验证**——是 D1 能否落地的关键未知，须由 Step 0 绊线关闭。
- 128k 生产窗口的表现**无读数、不外推**。
