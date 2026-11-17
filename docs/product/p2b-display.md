# P2b 展示面收口（状态词/原因行）· 实施报告与 P2 验收状态表（2026-11-14）

> 基线：`arch/integration` `19b79c9`（含 P2a 合入 `ecbf297`；worktree `arch/r4-p2` 内 `git rebase arch/integration` 零冲突后即此基线）；
> 范围：**仅** `scripts/tasks.ts` / `scripts/ops.ts` 与对应测试；不碰 `execution-runtime` / `server.ts` / `ask-runtime.ts`，
> 不改 P2a 冻结判据与冻结文档、不碰其他工作树。契约依据：`r4-joint-interfaces.md` §1 + v1.1/v1.2、`r4-acceptance.md` P2-T01–T05。

## 1. 状态词金样（9 态）

| 状态 | 用户词 |
|---|---|
| `queued` | 排队中 |
| `running` | 进行中 |
| `waiting_user` | 等待用户 |
| `cancelling` | 取消中 |
| `cancelled` | 已取消 |
| `completed` | 已完成 |
| `failed` | 失败 |
| `timed_out` | 已超时 |
| `unexecuted` | 未执行 |

- 单一来源：`scripts/tasks.ts` 的 `TASK_STATUS_WORDS` / `taskStatusWord`；`ops.ts` 直接复用（不复制词表）。
- **未知状态 fail-open**：`未知状态（<原值>）`（不崩、不落 `undefined`；ops 页同样经 `escapeHtml` 转义原值）。

## 2. 原因行金样（5 种机械原因）

| `reason` | 用户词 | 行文本 |
|---|---|---|
| `cancelled_by_user` | 用户取消 | `终止原因：用户取消` |
| `timeout` | 超时 | `终止原因：超时` |
| `failed_confirmed` | 执行层失败 | `终止原因：执行层失败`（**仅当无失败原文**；有原文时只显示失败原因行，不重复） |
| `result_unknown` | 结果未知 | `终止原因：结果未知` |
| `resource_limited` | 资源受限 | `终止原因：资源受限`（联合接口 §5：话术由展示层定） |

- 展示位置：tasks 详情/交付件（`taskMechanicalReasonLine`，状态行同段其后）；ops 未成功终态清单单元格（`taskOutcomeReasonLine`＝机械原因优先、其次失败/未执行原文）。
- **未知原因 fail-open**：`未知原因（<原值>）`；**历史行（无 `reason`）不伪造原因行**。
- `pending_question` / `waiting_since` 的展示不在本片（属 T02 接线面；登记留待接线/P8）。

## 3. ops 结构变化（最小）

- 统计段：`queued/waiting_user/cancelling/cancelled/timed_out` 各成一词，**仅非零时出行**（存量页面不添恒零噪音）；`其他（未知状态）` 只收未识别存储值。
- 最近任务：状态列 9 态词（与 tasks 列表同源对账测试钉住）。
- 清单：`失败与未执行清单` → **`未成功终态清单`**，收录 `failed/unexecuted/cancelled/timed_out`（终态非成功）；排序/上限/空态/限制文案同步更新；单元格原因取机械词或失败原文。
- stdout 计数行：基础四态 + 非零新状态 + 非零其他。

## 4. 历史行（无新字段）兼容

旧行无 `reason`/`pending_question`：状态词照旧、无「终止原因」行、原因单元格退回原文或「（底账未记录原因）」；既有 P0/P1 金样与只读/导出判据全量复跑通过（见 §5）。

## 5. 证据与读数（均本片实跑；证据在 `.runtime/p2a/`）

- RED（测试先行）：`npx vitest run scripts/tasks.test.ts scripts/ops.test.ts` → 2 files failed；**11 failed / 55 passed**（`p2b-red.txt`）。
- GREEN：同一命令 → **66 passed (66)**（`p2b-green1/green2.txt`）。
- 全量门：`npx tsc --noEmit` → 0 错误；`npm test` → **48 files / 472 tests passed**（P2a 冻结读数 462；本片 +10，只增不减；基线 `9ae895d` = 45/425）。
- 反向绊线（破坏未提交、已还原）：① 移除未知状态 fail-open（`taskStatusWord` 直取词表）→ tasks 未知态金样 + ops 恶意状态页 2 红；② 未成功清单剔除 `cancelled` → ops 清单金样 1 红（`p2b-tripwire-a/b.txt`）。
- **E05/E06 smoke**（`LLM_MODEL=step-3.7-flash`，N=1，真实模型；命令 `npm run eval:user -- --case E05|E06 --trial 1 --out-dir .runtime/p2b-smoke`）：
  - **E05**: FAIL（`FAIL_NO_DELEGATION` / `FAIL_WRONG_OBJECT` / `FAIL_ZERO_EXECUTION`；模型直接向用户追问、未委派执行层；④任务状态一致性 pass）。**归因**：展示面不在评测闭包内（`runner.ts`/`ask-runtime.ts`/`execution-runtime.ts`/`server.ts` 均不 import `tasks.ts`/`ops.ts`），本片对 `judgeReportedTask` 零 diff（表征测试 8/8 绿）⇒ 判定为**模型行为差异**，非展示面回归。
  - **E06**: PASS（①用户级完成/②执行真实性/③数据正确性/④任务状态一致性/⑤用户干预 全 pass）。
  - 两例均为 **N=1 smoke，不作稳定性结论**；P2-E01 黑盒仍 **blocked←集成 Run**（预注册 N/判定复合时执行）。

## 6. P2 验收状态表（T01–T05 + E01）

| 验收项 | 本片状态 | 证据 |
|---|---|---|
| **T01 状态转移矩阵** | **完成**（P2a 冻结；本片复核） | 契约测试 27/27（9×9 合法/非法矩阵，双实现）；`docs/product/p2a-task-contract.md` §1/§4；本片全量 48/472 绿 |
| **T05 展示词表** | **本片完成** | 本文 §1–§4；`scripts/tasks.test.ts`/`ops.test.ts` 66/66（状态词 9 态金样、原因行 5 词金样、未知 fail-open、历史行兼容）；反向绊线 2 类红后复原 |
| T02 等待用户与接续 | 域核心完成（P2a 契约测试：`waiting_user` 持久化/同 Task 接续/跨重启）；展示与接续的 execution-runtime 接线 **blocked←集成 Run** | 契约测试「waiting_user 持久化与接续」+ SQLite 跨重启；接线未做（本片不动 runtime） |
| T03 取消请求与确认 | 域核心完成（请求≠取消、确认才 cancelled、未确认回 running）；用户侧取消入口接线 **blocked←集成 Run** | 契约测试「取消语义」；接线未做 |
| T04 超时 | 域核心完成（queued/execution/waiting_user 三链 + 关闭活跃等待保留历史）；执行超时接线 **blocked←集成 Run** | 契约测试「超时」；接线未做 |
| P2-E01 黑盒（E05/E06） | **blocked←集成 Run**（本片仅 N=1 smoke 证据） | §5 smoke：E05 FAIL（模型未委派）/E06 PASS；非稳定性结论 |

## 7. 边界与登记

- 未碰：`execution-runtime.ts` / `server.ts` / `ask-runtime.ts` / `packages/agent|core` 实现 / P2a 冻结文档与判据 / 其他工作树。
- `scripts/tasks.ts` 的 `--redo` 等写路径语义未改（终态集合仍 `completed/failed/unexecuted`；取消/超时任务 fail-closed 拒绝重新推进——如后续需要放开，属集成裁决）。
- smoke 环境：worktree `.env` 指向主仓 `.env` 的符号链接（gitignored；不落密钥、不改主仓）。
