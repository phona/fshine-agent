# P1 切片报告：任务查看 v1（`npm run tasks`）

> 范围（一句话）：业务用户交办任务后**不读日志**即可查看「我交办的活儿怎么样了」——最近任务列表（时间/状态/摘要/id）与单任务详情（状态/失败原因/执行步骤/任务结果）；状态与失败原因必须与既有 `judgeReportedTask` 语义一致。
> 分支/提交：`arch/p1-taskview`（基线 `arch/integration` @ `99c651883686beeb797b78ea87a5375f8850545e`）；实现 `353fd10`（未 push、未合并）；本报告与 decision-log 登记见本次 docs 提交。
> 运行面：真实模型 `LLM_MODEL=step-3.7-flash` + 仓内 dummy 执行层（不触真实平台、不触网）。
> 证据根：`.runtime/product-p1/`（gitignored；各条证据指针相对仓根）。

## 一、目标

- 用户任务：交办若干任务后，用一条命令看到最近任务与单任务详情，**不读日志、不跑模型、不触网**。
- 硬约束：状态语义复用 `judgeReportedTask`（completed/failed/unexecuted），不新造状态、不读时重算；只读消费既有 SQLite 任务注册表；不改 schema；R1 冻结集与 exploration 零改动；无新依赖。

## 二、结果

**命令面**：`npm run tasks`（最近任务列表，上限 20 条，最新在前）与 `npm run tasks -- <taskId>`（详情）。
`--config=<path>` / `AGENT_CONFIG_PATH` 与 `npm run ask` 同源；非空 `DB_PATH` 同 ask 一样覆盖底账路径；缺省 `<仓根>/.runtime/state.db`。

**只读**：`openTaskStore` / `createSqliteTaskRegistry` 增 `readOnly` 选项——不建目录、不设 pragma、不建表，`new Database(path, { readonly: true, fileMustExist: true })`；写由 SQLite 拒绝（`SQLITE_READONLY`）；库不存在时给空态且**不创建文件**；运行期间不阻塞写者（WAL）。

**状态呈现**：词表终态键绑定 `ReturnType<typeof judgeReportedTask>['status']`（已完成/失败/未执行），未收尾单独给「进行中」；查看侧只消费注册表写入的终态——不在读时重算（`fail()` 路径零执行与 running 行会被重算错报）。`decision-log §17.2` 已追加复评登记（状态查询切片触发、保持既有语义）。

**验收标准逐条（勾选 + 证据指针）**

- [x] completed：查 beta → 列表显示「已完成」；详情含执行步骤与回复 —— 证据 S1。
- [x] unexecuted：指定纯聊天输入**不产生任务**（与冻结语义一致，前提修正见 §五）；以真实模型「已委派、零执行」路径验证详情显示「未执行」 —— 证据 S2。
- [x] failed：查 faulty-one → 「失败」+ 机械失败原因（judgeReportedTask 合成文本） —— 证据 S3。
- [x] 只读：`npm run tasks` 与详情运行前后 `state.db` sha256 不变（`2e83a252…`） —— `.runtime/product-p1/readonly-proof.txt`。
- [x] 列表可核事实：条数=库内任务数、最新在前、含时间/状态词/摘要/id；纯聊天后列表不变 —— `tasks-list-*.log`。
- [x] 详情可核事实：状态/创建·更新/交办/失败原因|未执行原因/执行步骤/任务结果 —— `tasks-detail-*.log`。
- [x] 空态与未知 id：缺库空态 exit 0 且不建库、未知 id exit 2（commit `353fd10` 的 e2e 单测断言）。
- [x] 状态语义与 judgeReportedTask 一致：单测矩阵 + 失败详情文本与其合成文本逐字一致（commit `353fd10`）。
- [x] 回归：E06 ×3、E12 ×3 全过 —— 见 §三 / `.runtime/product-p1/eval-e06.log`、`eval-e12.log`。
- [x] 确定性门：`npx tsc --noEmit` exit 0；`npx vitest run --project unit` 30 文件 / 253 例全过（本报告提交前复跑）。
- [x] 冻结面零改动：`git diff --name-only 99c6518..HEAD` 无 `scripts/eval/convergence-r1/**`、`scripts/eval/exploration/**`、`packages/agent/task-status-boundary.test.ts`。

## 三、验证证据

### S1 completed（真实模型）

- 命令（逐字）：`LLM_MODEL=step-3.7-flash npm run ask -- "帮我查一下 beta 集合的数据。"`
  → 回复含 beta 3 条（500/300/200）；机械证据 `taskId=task_ca68731d-23cb-4f2c-82c2-b0ef2712919e 结构化执行=1 次（完成 1）`。证据：`.runtime/product-p1/ask-completed.log`。
- `npm run tasks` → `2026-11-14 00:19  已完成  …` + `id: task_ca68731d-…`。证据：`tasks-list-scenario1.log`。
- `npm run tasks -- task_ca68731d-23cb-4f2c-82c2-b0ef2712919e` → `状态：已完成`；`执行步骤：1. dummy.query  完成`；`任务结果：`（Worker 汇报：beta 3 条）。证据：`tasks-detail-completed.log`。
- 该轮前后 `state.db` sha256 一致（`00975df5…`）。证据：`db-hash-before-scenario1.txt` / `db-hash-after-scenario1.txt`。

### S2 unexecuted（真实模型；前提修正）

- 指定输入（逐字）：`LLM_MODEL=step-3.7-flash npm run ask -- "你好，你能帮我做什么？"`
  → `委派=否 taskId=（无委派） 结构化执行=0 次`；**不产生任务记录**（与冻结语义一致：纯聊天零委派→无任务，`runtime.test.ts:434-443`）；ask 以自身「未达标」门 exit 1 如实记录。证据：`ask-unexecuted.log`；随后 `npm run tasks` 仍 1 条（`tasks-list-after-purechat.log`）。
- 为端到端验证「未执行」呈现，追加真实模型探针（逐字）：
  `LLM_MODEL=step-3.7-flash npm run ask -- "执行层现在能帮我查哪些数据？"`
  → `委派=是 结构化执行=0 次`，`taskId=task_eb1f8c12-d728-4276-8c5a-89e358f9acf2`（Worker 依能力快照汇报、未发起任何调用）。证据：`ask-unexecuted-probe.log`。
- `npm run tasks` → `2026-11-14 00:20  未执行  …`；详情 → `状态：未执行`；`未执行原因：未发起执行：Worker 已汇报，但本次委派没有向执行层发起任何调用。`；`执行步骤：（无：本次任务未向执行层发起任何调用）`。证据：`tasks-list-unexecuted.log` / `tasks-detail-unexecuted.log`。

### S3 failed（真实模型）

- 命令（逐字）：`LLM_MODEL=step-3.7-flash npm run ask -- "帮我查一下 faulty-one 集合的数据。"`
  → `taskId=task_e778287b-f8ba-4264-9307-859d64415ffb`；执行事实 `dummy.query status=failed error.code=COLLECTION_FAULT`。证据：`ask-failed.log`。
- `npm run tasks` → `2026-11-14 00:21  失败  …`；详情 → `状态：失败`；`失败原因：执行层未成功：dummy.query 返回 failed：Collection faulty-one cannot be read in its current state`；`1. dummy.query  失败  Collection faulty-one cannot be read in its current state`。证据：`tasks-list-failed.log` / `tasks-detail-failed.log`。

### 只读证明

`.runtime/product-p1/readonly-proof.txt`：运行 `npm run tasks` 与详情前后 `state.db` sha256 均为 `2e83a2527d6fdafa7c1186da4c4e7777dd8ba4d4bc49b66ee616b0707a818657`（不变）；实现提交的只读单测另钉写被拒、缺库不创建、不锁写四保证。

### 回归（同模型 step-3.7-flash）

- `LLM_MODEL=step-3.7-flash npm run eval:user -- --case E06 --trials 3 --out-dir .runtime/product-p1/regression-e06` → 3/3 PASS，exit 0。证据：`eval-e06.log`、`regression-e06/summary.json`（`runs/E06/trial-*/model.json` = step-3.7-flash）。
- `LLM_MODEL=step-3.7-flash npm run eval:user -- --case E12 --trials 3 --out-dir .runtime/product-p1/regression-e12` → 3/3 PASS，exit 0。证据：`eval-e12.log`、`regression-e12/summary.json`。

### 确定性门（本报告提交前复跑）

- `npx tsc --noEmit` → exit 0。
- `npx vitest run --project unit` → Test Files 30 passed / Tests 253 passed（含 P1 新增 16 例：只读四保证 + CLI 渲染/端到端；三组反向绊线在实现提交中先红后恢复）。

## 四、保留内容

- **未改动**：SQLite schema（tasks/executions 两表原样）；`scripts/ask.ts`、`apps/server/**`（ask 早已持久化任务，无需接线）；R1 冻结集（criteria/cases/judge/criteria.lock）与 exploration 冻结用例；`packages/agent/task-status-boundary.test.ts`（字节零改动，只追加 decision-log 登记）。
- **新增最小面**：只读消费面（`scripts/tasks.ts` + `readOnly` 选项）；默认路径行为不变（选项缺省 = 原读写打开的既有调用零影响）；无新依赖。

## 五、剩余问题

1. **执行步骤无时间戳**：`executions` 表无时间列（冻结），详情以步骤序号替代；任务级时间在标题段。
2. **Main 最终回复不落库**：详情「任务结果」= 底账持久化的执行层汇报原文；用户可见最终回复由 Main 生成、当前不落库。
3. **纯聊天不产生任务**：指定验收输入（「你好，你能帮我做什么？」）经实跑为 `委派=否`、无任务记录——「未执行」状态出现在「已委派、零执行」路径（S2 探针已实证）。
4. **只读访问 WAL 库会留 `-wal`/`-shm` 旁路文件**（SQLite 固有；主库哈希不变，不删除旁路文件以免干扰活跃写者）。
5. **列表为库内全 principal 视图**（本地运维视角）；渠道侧归属校验不受影响，但多用户部署下无按 principal 过滤。
6. **running 行无自愈**：进程中断会留下「进行中」的存量行（无状态系统可改，如实显示）。

## 六、需要你决定

1. 是否在后续切片持久化「Main 最终回复」与「执行步骤时间戳」（涉及 schema 或写语义变更，超出本切片冻结）？
2. 「未执行」验收口径：接受现行语义（纯聊天不产生任务；未执行 = 已委派但零执行），还是要求宿主让纯聊天也落一条任务（语义/行为变更，需按准入评估）？
3. 多 principal 部署下 `tasks` 是否需要 `--principal` 过滤（当前刻意不做，保持最小）？
