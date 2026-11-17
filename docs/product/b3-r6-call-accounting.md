# B3 · R6 Harness 全量调用记账与单实验硬停

> 定位：R6 长会话可靠性验收（`scripts/eval/r6/**`）的**评测侧**计量增强。
> **不改产品语义**（`packages/`、`apps/` 不动）、**不改已冻结口径**（150/3,000,000/2h 数字仍取预注册 §十三.D）。
> 本文件只说明「记账面 / 硬停口径 / 与生产 budget 解耦 / 测试证据」。
> 关联：`docs/product/r6-longsession-prereg.md` §六.1、§六.3、§十三.D（单实验硬停与摘要入账）。

## 一、为什么需要本增强（缺口）

预注册 §十三.D 要求「`maxModelCalls=150` / `maxTokens=3,000,000` / `wallMs=2h`，**真实模型调用完整计量**（含摘要调用）」，§六.1 要求「**先验拒绝**（达限即停、留证）」。增强前：

- 数据模型只到**聚合**粒度：`BudgetUsage{calls,tokens,tokensObserved,ms,summaryCalls}`（`evidence.ts:54-61`），`summaryCalls` 还是假会话的静态 scenario 值（`fake-session.ts`），**harness 从不消费**；
- 主模型调用只有一揽子计数（`harness.ts` 用 `session.budget().calls` 前后差）；
- **重试**无任何字段/计数器；**溢出恢复**触发的附带调用被折进逐回合计数、无法单独归属；
- 硬停**非先验**：旧管线无条件跑完 `plan.turns`，`budgetStopped` 硬编码 `null`，150/3M/2h 三个上限均未在 r6 生效。

本增强补齐以上缺口，使「主模型 + Pi 摘要 + 重试（+ 溢出恢复）」**全部**进入逐次记账并**全部**纳入单实验硬停。

## 二、记账面（逐次）

新增 `scripts/eval/r6/accounting.ts`，定义逐次调用记录 `ModelCallRecord`：

| 字段 | 含义 |
|---|---|
| `seq` | 会话内单调序号（1 起） |
| `kind` | `main` / `summary` / `retry` / `overflow_recovery`（四类） |
| `sessionId` / `turn` | 关联会话与回合（harness 统一回填 `sessionId`） |
| `tokens` | `{input, output, total}` |
| `tokensObserved` | 是否观测到真实 usage（未观测不虚增、不伪造） |
| `durationMs` | 本次耗时（ms） |

- **四类分类别求和**：`accountCalls(records)` → `AccountedUsage`（总计 + `byKind`，含 calls/tokens/input/output/duration）。
- **摘要独立计数**：`summary` 类别**不依赖** `session.budget()` 的 `summaryCalls`——它由会话面 `modelCallLedger()` 单独暴露、按**实际发起**逐次记录。harness 只回填、不再从 budget hook 推。
- **重试**：`retry` 类别逐次显式记录（主模型瞬时失败重试 / provider 重试的**每一次实际请求**）。
- **溢出恢复**：`overflow_recovery` 类别显式归属（overflow 后重发、摘要分片等附带调用）。
- **反向绊线**：`missingCallKinds(usage, REQUIRED_CALL_KINDS)` 返回「主/摘要/重试中一条记录都没有」的类别 —— 漏记任一类即可由测试判红。

会话面契约新增（可选方法，`harness.ts` `HarnessSession`）：

```ts
modelCallLedger?(): readonly ModelCallRecord[];
```

- 生产同源装配适配器**必须**提供（否则摘要/重试会漏账）；
- 未提供时 harness **退化**为按 `budget().calls` 调用差补记「主模型」粗记录（`tokensObserved=false`，不虚增），并在 doc 中标注为 Wave1 前冒烟项。

生产侧可对应的现有观测（**不接线、不改产品**，仅供 Wave1 适配器参考）：`packages/agent/src/pi-driver.ts` 的 `context_compaction_metrics`（`summaryCalls` / `summaryUsage` / `elapsedMs`）可映射为 `summary` 记录；重试层映射为 `retry`。

## 三、硬停口径（先验拒绝）

- 上限常量 `R6_HARD_LIMITS`（`accounting.ts`）**逐字取自预注册 §十三.D 冻结值**：
  `maxModelCalls=150` / `maxTokens=3,000,000` / `wallMs=2h`。**不得修改**；`harness.ts` 经 `resolveLimits(input.limits)` 使用，`input.limits` 仅供**测试注入更小上限**做确定性验证。
- **判定顺序固定 `ms → calls → tokens`**（与既有 `TaskBudget.exhausted` / `scripts/eval/p3/enforce.ts` 同序）。
- **先验 = 请求前检查**：`CallAccountingGuard.precheck()` 在每回合 `send` **之前**运行；累计耗用 `>=` 上限即抛 `R6HardStopError`，**不发起该请求**（有界失败），并把首次事实写入 `evidence.budgetStopped`（`{reason, limit, used, at}`）。已停则沿用首次事实直接抛，不再前进。
- **`calls` 口径 = 四类合计**（主 + 摘要 + 重试 + 溢出恢复），与记账面同源，杜绝「摘要/重试不计入 calls 上限」的漏账。
- **`tokens` 口径 = 观测到的 usage 之和**；仅当**全部**记录 `tokensObserved` 时才启用 token 硬停（未观测不虚增、不伪造，同 p3 纪律）。部分未观测时由 `calls` 上限兜底。
- 硬停 ≠ 全局额度闸（预注册 §〇.6）：本模块只做**单会话/单实验**硬停，不引入全局配额。

## 四、与生产 budget 解耦说明

- **不改生产语义**：`TaskBudget` / `resource-policy` / `pi-driver` 一行未动（B3 明确「暂不改生产语义」）。
- **本增强只在评测侧（`scripts/eval/r6/**`）**：记账与硬停由 harness 自己的 `CallAccountingGuard` 承担，**不依赖**生产 budget hook，也不向其写入。
- **为什么摘要必须独立**：旧路径摘要生成绕过生产 budget（`BudgetUsage.calls` 不含摘要），若硬停读 budget 就会漏掉摘要调用。本增强改为**按实际发起逐次记录**，与 budget 计数并列，互不覆盖。
- 两者关系：`evidence.budgetUsed`（生产/会话面聚合，原样保留）与 `evidence.callAccounting`（评测侧全量逐次账本）**并列留档**，便于交叉核对。

## 五、测试证据（确定性、零真实模型）

新增 `scripts/eval/r6/accounting.test.ts`（15 例）；`evidence.test.ts` / `g3-readiness.ts` 的 schema 断言补入 `model-calls.jsonl`。全部经假会话（`FakeHarnessSession`），**不调用任何模型**。

- **三类记账齐**：三类调用（主/摘要/重试）逐次记账且与会话/回合关联；`missingCallKinds` 空；`model-calls.jsonl` 落盘含 kind/tokens/duration/session/turn。
- **硬停超限拒发**：
  - `calls`：`maxModelCalls=2`、计划 5 轮、脚本仅 2 轮——第 3 轮前拒发，`turns` 长度 2、`budgetStopped.reason='calls'`（脚本用尽即抛 = 证明未多发）；
  - `tokens`：累计（**含摘要调用**）达 `maxTokens` 即停；
  - `wallMs`：注入时钟超 `wallMs` 即停；
  - 判定顺序：同时越限报 `ms`。
- **反向绊线（故意破坏必须红）**：
  - 把 `accountCalls` 中对 `summary` 的计数去掉 → `scripts/eval/r6/accounting.test.ts` **7 例红**（含三类覆盖与 `byKind.summary.calls` 断言）；
  - 把 `CallAccountingGuard.precheck` 改成不复用 → **4 例红**（calls/tokens/wall/顺序）。
  两处破坏均已回滚，最终全绿。

### 本次实际运行的命令与读数

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（worktree，`tsc --noEmit`） | **0 错误** |
| `vitest run scripts/eval/r6` | **7 文件 / 66 例全绿** |
| `vitest run`（全量；worktree） | **93 文件 / 937 passed + 3 todo（940）全绿** |
| `vitest run`（全量；基线 `arch/integration@b90f12f` 主仓） | 92 文件 / 922 passed + 3 todo（925） |

> 例数对比：925 → 940（**+15**，无删除、无弱化）。首次全量跑出现一次与本改动无关的 `p0-assembly-single-point.test.ts` 假失败（vitest worker `onTaskUpdate` 超时），单跑该文件与二次全量均绿，判为高负载抖动。

## 六、边界与残留

- 生产 `HarnessSession` 适配器**尚未接线**（`modelCallLedger` 待 Wave1 前冒烟）——本文件不冒充通过；G3-M1/M2/M3 仍标注 `wave1-smoke-pending`。
- 未闭合完整实验硬停（本增强 + 确定性测试）**之前不得启动真实模型 Wave1**；本增强即为此前置的一部分。
- **不改** Worker 提示、**不引**第二套压缩/会话机制、**不改** `docs/decision-log.md`；证据落 `.runtime/r6/`（gitignored，不 `git add`）。
