# taskBudget 运行时计量接线（R4 · P5 边界）：实施报告（2026-11-14）

> 授权：owner 2026-11-14「3a」——把 P5 的 taskBudget 运行时 consume 接上：按任务累计调用数与时长（含子 Worker 共享父预算同一对象，不复制/不放大）；预算耗尽 → 后续调用确定性拒绝（`budget_exhausted` → 任务 `resource_limited`），不静默继续。
> 分片依据：`docs/product/r4-integration.md` §四.3（blocked：`taskBudget` 运行时 consume，生产回合不累计用量）、`docs/product/r4-acceptance.md` §3.6 R-E 与 P5-T05、`docs/product/p5-resource-policy.md` §五.1/§五.5。
> 冻结契约：`docs/product/r4-joint-interfaces.md` §2（`TaskBudget.consume/exhausted`；子许可共享父预算）+ §5（拒绝 reason → 任务 `resource_limited`）；本片未改 §2 接口、类型或判据。
> 分支/基线/提交：worktree `fshine-agent-r4-budget`，分支 `arch/r4-budget`；基线 `arch/integration @ 885ac63`。提交链：`0c509c7`（测试先行 RED 8 例）→ `59c09e3`（实现 8 行）→ 本报告提交。未 push、未合并。
> 证据根：`.runtime/budget/`（gitignored：red/green/绊线/读数日志）。

## 一、计量点

- **位置**：`packages/agent/src/execution-runtime.ts` `delegate()`（inline 委派路径——Main 回合内的 `run_task`）。
- **调用前检查**（未动，P5 既有）：委派前 `policy.acquire('background', { taskId, parentPermit })` 派生许可——派生时查父预算 `exhausted()`（resource-policy.ts:359-367），耗尽即拒绝 `budget_exhausted`；execution-runtime 把拒绝落为任务 `failed + reason=resource_limited` 并向 Main 抛出（execution-runtime.ts:371-377），**未进入 Worker**。
- **调用后计量**（本片新增 8 行）：`finally` 中
  `delegationPermit?.budget.consume({ calls: 1, ms: Date.now() - workerStartedAt })`
  （起点 execution-runtime.ts:386，消费 :410）。每次 Worker 调用计 **1 次调用数 + 该回合墙钟时长（ms）**，累计在任务共享预算上。
- **计入口径**：成功与失败回合都计（调用已发生、资源已消耗）；被许可拒绝、未进入 Worker 的委派不计（acquire 失败即抛，`finally` 未进入）。Main 回合本身不计调用数——口径按 owner 授权原文「每次 worker 调用」（另一口径见 §六.2）。

## 二、共享语义（子 Worker 不复制 / 不放大）

- 派生许可与前台回合许可共享**同一 `TaskBudget` 对象**：resource-policy.ts 派生分支 `budget: parent.budget`（:374）且 `budgets.set(taskId, parent.budget)`（:378）。
- 一次 Worker 调用只在 execution-runtime 计一次（不在父、子两处重复计）；子视角用量恒等于父用量（`policy.budgetFor(child) === policy.budgetFor(parent)`）。
- 测试钉住（`packages/agent/budget-metering.test.ts`）：「父（前台回合）与子（委派）同一预算对象：两次调用只计两次、子视角=父用量」；policy 套件「子 Worker 共享父预算：同一对象、子消费父可见；派生不放大」保持全绿。

## 三、耗尽链路（reason 链）

- 判据（不变）：`usedMs >= ms` → `reason=ms`；`usedCalls >= calls` → `reason=calls`；声明 tokens 且 `usedTokens >= tokens` → `reason=tokens`（resource-policy.ts:270-278，判定顺序固定）。
- **同回合内超额**：下一次委派在派生许可处被拒 `budget_exhausted` → `taskFailureReasonFor` = `resource_limited`（§5）→ 任务行 `failed + reason=resource_limited`、Main 收到工具错误；零 Worker 调用、零执行层调用。
- **会话已耗尽后重入**：新的前台回合在准入处被拒 `ForegroundRejectionError(reason=budget_exhausted)`（前台准入对 knownBudget 的既有检查）；不进入 Main、不产生调用。
- **「恰好」语义**：`used == limit` 即 exhausted，无「超发一次」窗口——下一次调用在准入处确定性拒绝（测试钉住 ms 与 calls 两口径）。

## 四、零配置证明（无 taskBudget = 零行为变化）

1. 缺省 `resolveTaskBudget(undefined)` 返回 `null`（resource-policy.ts:177）→ `budget.limits === null` → `exhausted()` 恒 `null`（:270-271）→ 不发生任何预算拒绝。
2. limits=null 时计量照实记录但不构成上限（P5 既有语义；本片 T6 断言连续 3 回合零拒绝、`limits null`、`exhausted null`）。
3. **inline 金样逐字**：`git diff 885ac63..HEAD --name-status -- '*.test.ts'` 仅 `A packages/agent/budget-metering.test.ts`——无任何既有测试被改/删；非测试面仅 `M packages/agent/src/execution-runtime.ts (+8)`。全量 `npx vitest run` 56 files / 602 tests 全绿，含 ask-runtime / ask-interactive / ask-replay / p0-gates-cli / p0-assembly-single-point / p0-runner-lock / tasks / ops / p7a-* / reply-archive / runtime / task-registry-contract 等金样文件逐字通过。
4. 未注入 policy 的路径完全不变：`delegationPermit` 仅在 policy 注入且前台许可存在时非空；policy 缺省（undefined）不进 acquire/consume。

## 五、token unavailable（不伪造硬上限）

- `TurnDriverResult`（`packages/agent/src/driver-contract.ts:36`）不提供可验证的 Pi `assistant.usage` → 接线**不 consume tokens**。
- 未声明 `taskBudget.tokens`：`budget.tokens === 'unavailable'`，`used` 无 tokens 字段。
- 显式声明 tokens 但无可验证用量：用量不虚增（保持 0）、不会由伪造触发 `tokens` 耗尽——「token 仅当 Pi usage 可验证时接入，否则记 unavailable、不得伪造」（§2 分诊 #10）由两例测试钉住。

## 六、登记 / 未做（不宣称）

1. **background 派发的 taskBudget 归属缺口**：P6 runner `pump()` 以无 taskId 许可准入（`packages/agent/src/task-runner.ts:343`：先取许可再 claim），许可预算挂自动 id、无法归属任务；若在 `createTaskExecutor` 按 `budgetFor(task.taskId)` 计量会 fail-fast 抛「未知任务预算」，容错跳过则是静默不计量。按任务计量需改 P6 runner 或冻结 §2 面 → 本片未接线，留集成/裁定。
2. **`calls` 口径**：本片按 owner 授权「每次 Worker 调用=1」；`TaskBudgetConfig.calls` 注释「任务总执行层调用次数预算」若按 `execute_operation` 次数计，需另行裁定（测试结构不变、断言数值需调整）。
3. **失败回合计量语义**：每次调用完成即计（含未产出汇报的失败回合），由反向绊线 TW1 钉住；若改「仅成功回合」，需调整该 1 例。
4. 本片不宣称 R-E / P5-T05 端到端黑盒通过（黑盒批次归 P7b/集成）；确定性面（计量/耗尽拒绝/共享/零配置/token）本片已钉住。

## 七、回退

- **配置级（首选，一改即回）**：移除或清空 `config/agent.yaml` 的 `runtime.taskBudget` 段（乃至整个 `runtime` 段）→ `taskBudget === undefined` → `limits === null` → 无预算耗尽路径；本片唯一新增行为（consume + 耗尽拒绝）随之不生效。并发/队列/深度等其他 runtime 旋钮各自独立，不受本片影响。**无需数据迁移**：预算为进程内单实例内存账本（P5 §八.1），随进程退出消失；无 schema / 库表 / 协议改动。
- **提交级**：`git revert 59c09e3`（实现 8 行）→ 回到「准入时耗尽检查已接线、生产回合不累计用量」的接线前状态；测试提交 `0c509c7` 可保留为守卫或一并 revert。回退后 `npx tsc --noEmit` 与全量单测应仍全绿（实现未改共享接线的运行语义）。

## 八、本片实跑读数

| 检查 | 命令（worktree 内，TMPDIR=/home/tao/.tmp） | 读数 | 日志 |
|---|---|---|---|
| 类型 | `npx tsc --noEmit` | exit 0 | `.runtime/budget/final-tsc.txt` |
| 目标批次 | `npx vitest run packages/agent/budget-metering.test.ts` | 8 passed (8)（RED 时为 8 failed） | green-metering.txt / red-metering.txt |
| 全量 unit | `npx vitest run` | 56 files / 602 tests 全绿 | final-full-suite.txt |
| 基线对照 | 同仓（本片 RED 前） | 55 files / 594 tests 全绿 | full-suite-red.txt（+1 文件 / +8 例，只增不减） |
| 反向绊线 | 4 类破坏（不提交、还原后全绿） | 各必红：①去掉 consume→8 红；②子许可复制→9 红；③零配置隐式限额→4 红；④耗尽后放行→5 红 | tripwire-A…D + tripwire-round2.txt |

## 九、涉及文件

| 文件 | 性质 | 内容 |
|---|---|---|
| `packages/agent/src/execution-runtime.ts` | 修改（+8 行） | `delegate()`：`workerStartedAt` 起点 + finally `consume({calls:1, ms})`（成功/失败回合都计；被拒委派不计） |
| `packages/agent/budget-metering.test.ts` | 新增（8 例） | 计量计数（calls/ms）、恰好耗尽（ms/calls）与拒绝零调用、子共享不复制不放大、零配置零行为变化、token 不伪造、失败回合仍计量 |
| `docs/product/r4-budget-consume.md` | 新增 | 本报告 |

未改 `resource-policy.ts`（P5 冻结面原样消费）、未改 schema / 冻结 §2 接口 / 判据 / 历史证据、未动 background 路径与其他共享热点。
