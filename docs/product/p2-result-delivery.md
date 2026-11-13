# P2 切片报告：结果交付 v1（`npm run tasks -- <id> --out <path>`）

> 范围（一句话）：业务用户把已交办任务的结果**取走**——一条命令生成可保存/可转发的「任务交付件」（Markdown）：任务信息、状态与失败原因、执行步骤、执行层汇报原文与如实限制标注；纯读底账，不写库、不落任何新数据。
> 分支/提交：`arch/p2-delivery`（基线 `arch/integration` @ `6bdbc800386a400e98d2b74a1c9ff2be355e52b4`）；实现提交 `bcfd24d`（未 push、未合并）；本报告与 decision-log 登记见本次 docs 提交。
> 运行面：真实模型 `LLM_MODEL=step-3.7-flash` + 仓内 dummy 执行层（不触真实平台、不触网业务面）。
> 证据根：`.runtime/product-p2/`（gitignored；各条证据指针相对仓根）。

## 一、目标

- 用户任务：把已交办任务的结果取走——生成可保存/可转发的任务交付件。
- 硬约束：交付件与 `npm run tasks -- <id>` 详情同源逐行一致（不维护第二套渲染）；纯读（导出前后主库哈希不变）；不新增 schema/写语义、不落库任何新数据；R1 冻结集与 exploration 零改动；无新依赖。

## 二、结果

**命令面**：`npm run tasks -- <taskId> --out <path>`（Markdown 交付件）。`--out <path>` / `--out=<path>` 均可；相对路径按「调用点目录」解析（npm 注入的 `INIT_CWD`，其次进程 cwd）；绝对路径原样。

**交付件结构**：标题（任务 id + 状态中文词）→ 任务信息（id/创建·更新时间/交办原文）→ 状态（含机械失败原因或未执行原因）→ 执行步骤（operation/状态/错误消息；零执行提示）→ 任务结果（底账持久化的执行层汇报原文）→ 限制与说明（如实标注「Main 的最终回复当前不落库」等 4 条；进行中任务追加未收尾提示）。

**与详情同源**：详情字段行抽为共享构建函数（`scripts/tasks.ts:187-227`），`renderTaskDetail`（230）与 `renderTaskDeliverable`（254）共同消费；详情输出逐字节不变（金样测试钉住，P1 既有测试零改动）。

**--out 语义（最小安全面）**：目标已存在（文件/目录/符号链接）拒绝覆盖（exit 2、原文件不动；`writeFileSync` 以 `flag:'wx'` 原子独占兜底竞态）；父目录不存在拒绝且不自动创建（exit 2）；目录不可写等 IO 失败 exit 1。退出码 0 成功 / 2 用法与前置 / 1 环境与 IO。

**只读**：沿用 P1 的 `readOnly` 打开；导出只写「用户指定的那一个文件」，不写库、不建目录。

**验收标准逐条（勾选 + 证据指针）**

- [x] 导出 completed：真实模型查 beta → `task_34bebf1c-…` → 导出 exit 0，交付件含全部段落 —— 证据 S1、`deliverable-completed.md`。
- [x] 导出 failed：查 faulty-one → `task_1f6a2130-…` → 交付件含机械失败原因与失败步骤 —— 证据 S2、`deliverable-failed.md`。
- [x] 内容与详情逐字一致：详情正文全部非空行在交付件逐字出现（completed 8 行 / failed 9 行）—— `verbatim-proof.txt`。
- [x] 只读：详情/导出/边界实跑全程前后主库 sha256 一致（`715b6d3e…`）—— `readonly-proof.txt`。
- [x] 边界·未知 id：exit 2「找不到任务：…」且不产生输出文件 —— `boundary-unknown.log`。
- [x] 边界·目标已存在：exit 2 拒绝覆盖提示、原文件哈希不变 —— `boundary-exists.log`。
- [x] 边界·不可写：exit 1 明确错误（EACCES）、无半成品文件 —— `boundary-unwritable.log`。
- [x] 边界·缺库/父目录缺失/用法错误：单测 e2e 覆盖（缺库 exit 2 不建库不产文件；父目录缺失 exit 2 不建目录）—— `scripts/tasks.test.ts`。
- [x] 既有输出零回归：P1 基线 CLI（主仓 @ `6bdbc80`）与 P2 CLI 对同一底账的列表/详情正文逐字一致（唯一差异为「任务底账：…」路径显示随所在仓根）—— `list-baseline.log` vs `list-new.log`、`detail-completed-baseline.log` vs `detail-completed.log`。
- [x] 回归：E06 ×3、E12 ×3 全过（`step-3.7-flash`）—— `eval-e06.log`、`eval-e12.log`。
- [x] 确定性门：`npx tsc --noEmit` exit 0；`npx vitest run --project unit` 30 文件 / 267 例全过 —— 本报告提交前复跑。
- [x] 冻结面零改动：`git diff --name-only 6bdbc80..HEAD` 无 `scripts/eval/convergence-r1/**`、`scripts/eval/exploration/**`、`packages/agent/task-status-boundary.test.ts`。

## 三、验证证据

### S1 completed（真实模型）

- 命令（逐字）：`LLM_MODEL=step-3.7-flash npm run ask -- "帮我查一下 beta 集合的数据。"` → `taskId=task_34bebf1c-3686-4fbb-8bd7-e071367b7068`、`结构化执行=1 次（完成 1）`。证据：`ask-completed.log`。
- `npm run tasks -- task_34bebf1c-…`（详情）与 `npm run tasks -- task_34bebf1c-… --out .runtime/product-p2/deliverable-completed.md`（导出）均 exit 0；stdout：`已导出任务交付件：…` + `任务底账：.runtime/state.db（只读）`。
- 逐字核对：详情正文 8 个非空行全部逐字出现在交付件 —— `VERBATIM-OK (8)`（`verbatim-proof.txt`）。
- 交付件关键行：`状态：已完成`；`执行步骤：1. dummy.query  完成`；`任务结果：`（执行层汇报原文）；限制段含「Main 的最终回复当前不落库」。

### S2 failed（真实模型）

- 命令（逐字）：`LLM_MODEL=step-3.7-flash npm run ask -- "帮我查一下 faulty-one 集合的数据。"` → `taskId=task_1f6a2130-c7a5-46e6-857c-9c146b74ab4f`、`结构化执行=1 次（完成 0）`、`status=failed / COLLECTION_FAULT`。证据：`ask-failed.log`。
- 导出 exit 0；交付件：`状态：失败`；`失败原因：执行层未成功：dummy.query 返回 failed：Collection faulty-one cannot be read in its current state`（judgeReportedTask 机械合成文本，与详情一致）；步骤行 `1. dummy.query  失败  …`；逐字核对 `VERBATIM-OK (9)`。

### 边界实跑

- 未知 id：`npm run tasks -- task_does_not_exist --out .runtime/product-p2/boundary-unknown.md` → exit 2、stderr「找不到任务：task_does_not_exist（任务底账中没有这条记录）。」、输出文件未产生。证据：`boundary-unknown.log`。
- 目标已存在：对已存在的 `deliverable-completed.md` 再次导出 → exit 2、「输出文件已存在：…（拒绝覆盖；…）」；原文件 sha256 前后不变。证据：`boundary-exists.log`。
- 不可写：目录 `chmod 500` 后导出 → exit 1、「无法写入输出文件：…（EACCES: permission denied…）」、目录内零文件。证据：`boundary-unwritable.log`。

### 只读证明

`.runtime/product-p2/readonly-proof.txt`：写库阶段（两次 ask）结束后主库 sha256 = `715b6d3e7d732ebad04128322f8eea2e995e67ac03fd03c8d2ef4c3fcd229c56`；此后完成 2 次详情、2 次导出、3 次边界实跑、2 次基线 CLI 对照，哈希不变。旁路口径沿用 P1（WAL 库只读打开可出现 `-wal`/`-shm` 旁路；不对旁路做删除以免干扰活跃写者）。

### 既有输出零回归（抽一处 diff 说明）

- 用未改动的 P1 基线 CLI（主仓 @ `6bdbc80`）与 P2 CLI 对同一底账运行：列表与详情正文逐字一致（脚本化比较输出 `detail: IDENTICAL` / `list: IDENTICAL`）。
- 唯一差异是 stdout 末行「任务底账：…（只读）」的路径显示：基线 CLI 从主仓运行、底账在其仓外 → 显示绝对路径；P2 CLI 从本 worktree 运行、底账在仓内 → 显示 `.runtime/state.db`。属所在仓根导致的显示范围差异，非输出内容变化。

### 回归（同模型 step-3.7-flash）

- `LLM_MODEL=step-3.7-flash npm run eval:user -- --case E06 --trials 3 --out-dir .runtime/product-p2/regression-e06` → 3/3 PASS，exit 0。证据：`eval-e06.log`、`regression-e06/summary.json`（`runs/E06/trial-*/model.json` main=worker=`step-3.7-flash`）。
- `LLM_MODEL=step-3.7-flash npm run eval:user -- --case E12 --trials 3 --out-dir .runtime/product-p2/regression-e12` → 3/3 PASS，exit 0。证据：`eval-e12.log`、`regression-e12/summary.json`。

### 确定性门（本报告提交前复跑）

- `npx tsc --noEmit` → exit 0。
- `npx vitest run --project unit` → Test Files 30 passed / Tests 267 passed（含 P2 新增 14 例；P1 既有 12 例零改动）。
- 实现阶段反向绊线 2 组（演示红后恢复并复跑全绿）：①覆盖保护——仅 `wx`→`w` 不红（前置检查独立兜底，属双层防护），完整模拟「默认覆盖」（移除前置 + `w`）→ 2 例红；②渲染分叉——交付件「任务结果」独写为「（无）」→ 4 例红（结构/失败形态/一致性/e2e 导出）。

## 四、保留内容

- **未改动**：SQLite schema（tasks/executions 两表原样）、写语义、`scripts/ask.ts`、`apps/server/**`、R1 冻结集（criteria/cases/judge/criteria.lock）与 exploration；`packages/agent/task-status-boundary.test.ts` 字节零改动；无新依赖。
- **新增最小面**：`scripts/tasks.ts` 导出模式（参数解析 + 交付件渲染 + 独占写出）；交付件与详情共享同一组字段渲染函数（详情逐字节不变）；README 两处用法。
- **不落新数据**：交付件为纯读导出；「Main 最终回复」持久化仍为 owner 待裁项（登记不实施）。

## 五、剩余问题

1. **Main 最终回复不落库**：交付件「任务结果」= 底账持久化的执行层汇报原文；用户可见最终回复由 Main 生成、当前不落库（交付件已如实标注）。持久化涉 schema/写语义，超出本切片冻结。
2. **执行步骤无时间戳**：`executions` 表无时间列（冻结），交付件以步骤序号呈现；任务级时间在「任务信息」段。
3. **无 `INIT_CWD` 回落进程 cwd** 仅单测覆盖（e2e 未做：spawn 改 cwd 会影响 tsx 解析，不为测试改运行条件）。
4. **running 形态**交付件仅单测覆盖（真实演示不易构造实时进行中快照），如实登记。
5. **权限用例前提**：目录不可写用例以非 root 门控（root 环境跳过）。
6. **Markdown 转义**：字段行保真优先、不转义（原文含 `#`/`|` 等符号时渲染形状可能变化，文本内容不变）；大字段不截断（与详情口径一致）。
7. **只读访问 WAL 库会留 `-wal`/`-shm` 旁路**（SQLite 固有；主库哈希不变；不删除旁路，P1 已登记）。

## 六、需要你决定

1. 是否在后续切片持久化「Main 最终回复」（与执行步骤时间戳），涉 schema 或写语义变更——超出本切片冻结？
2. 是否需要 `--force` 之类的显式覆盖选项？（当前最小=拒绝覆盖；未有更强理由。）
3. 交付件是否需要「导出生成时间」一行？（当前刻意不加：渲染纯函数化、两次导出可 diff。）
4. 是否需要批量/多任务导出或目录级导出？（当前最小：单任务单文件。）
