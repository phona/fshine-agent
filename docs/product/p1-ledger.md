# P1 底账演化：数字 ID + 业务名称 + S1 回复存档（实施报告，2026-11-14）

> 分片依据：`docs/product/r4-slices.md` §三「P1 · 底账演化」；验收契约：`docs/product/r4-acceptance.md` P1-T01–T05 / P1-E01（v1 预注册基线）；口径裁定：`docs/product/r4-decisions-triage.md` #4（v1 机械命名）/ #12（同回合各任务行同值）/ #13（版本化迁移+迁移前备份）。
> 授权/边界：owner 2026-11-14 排程（P1 ∥ P7a，P0 验收合入后启动）与口径（数字 ID=SQLite 原子分配、并发安全、不复用；业务名称 v1 机械回落、零模型、不改 `run_task` 工具 schema；零新增机制/依赖）。不接企微真实环境、不触真实 SaaS、不开新写操作；不改 R3 冻结判据（criteria/cases/judge/lock 与 exploration）与历史评测证据；不碰其他工作树。
> 分支/基线/提交：worktree `fshine-agent-r4-p1`，分支 `arch/r4-p1-ledger`；基线 `arch/integration` 启动时 HEAD `46f757e3faceaf19f7b6642f0cdc2f1da0caae2b`（含 P0 合入）；本片提交 `6b21abe`（测试先行）→ `619fec5`（实现）→ `298aa7f`（迁移/备份口径登记）→ `a201357`（计数器语义修正，绊线轮）。未 push、未合并。
> 证据根：`.runtime/p1/`（gitignored：`red/` 测试先行红、`green/` 回归绿、`tripwires/` 反向绊线、`e01/` P1-E01、`smoke/` E06/E12、`ask-single/` 单轮金样、`baseline.txt` 启动记录）。真实模型 smoke/E01 使用本地 `.env`（gitignored，未入库；工作树原无 `.env`，为 smoke 从主工作树只读复制）。

## 一、产品要求（为什么做 P1）

- 用户可观察面：快速受理给**数字 ID + 业务名称**（`#<no> <name>`，稳定简短；内部 `taskId` 只做关联/审计证据）；完成后**结果可找回**——详情/`--out` 含 Main 最终回复全文；历史任务无存档时明确标注，不以执行层汇报冒充。
- 数字 ID 口径：SQLite 原子分配、并发安全、**不复用**；内部 UUID 不得充当业务 ID（owner 注记「数字 ID 稳定简短、不得回退面向业务的 UUID」）。
- 业务名称 v1：宿主机械回落（任务交办原文首段），零模型、零协议变更（#4-a 模型命名递延）。
- 回复存储（S1）：同回合各任务行存同一回复文本（最小 schema，不建 turns 表）；迁移一次版本化、幂等、向前兼容、迁移前自动备份副本并登记口径。
- 兼容硬边界：ask 单轮行为 / Dummy 执行契约 / 任务底账 / CLI / Eval 入口不变；不新增依赖与机制。

## 二、验收用例与结论（P1-T01–T05 / P1-E01）

| 用例 | 层级 | 命令（工作树内） | 结果 | 证据 |
|---|---|---|---|---|
| P1-T01 迁移幂等与回填 | 确定性 | `npx vitest run packages/core/task-store-p1.test.ts` | **passed（10/10，含 T01 组）**：旧库加列 task_no/name/reply_text、按 (created_at, task_id) 升序回填编号（同刻 tie-break 钉住）、历史 reply/name 保持 NULL、旧字段与执行记录零改动、备份 `<db>.backup-v2` 字节=迁移前、二次打开零差异且不新增备份、user_version=2；新库直接建 v2 无备份 | `.runtime/p1/green/target-tests.log` |
| P1-T02 并发分配与不复用 | 确定性 | 同上（P1-T02 组） | **passed**：同进程双连接交错 1,2,3；重复 taskId 失败不占号；编号不回退；迁移历史库后接续 4,5；跨进程 4 进程×10=1..40 唯一连续；**删除模拟（删行后重分配）不复用、存量不重排、计数器跨重启续号** | `.runtime/p1/green/target-tests.log`、`.runtime/p1/tripwires/02-deletion-reuse-green.log` |
| P1-T03 显示金样 | 确定性 | `npx vitest run scripts/tasks.test.ts scripts/ops.test.ts scripts/tasks-redo.test.ts scripts/ask-display.test.ts` | **passed**：tasks 列表/详情/`--out`、ops 页面、ask 机械证据行、redo 配对行统一 `#<no> <name>`；UUID 不出现在业务展示位（仅执行证据 JSON/底账）；`#编号`/纯数字/taskId 三种引用解析；e2e 子进程金样 | `.runtime/p1/green/target-tests.log` |
| P1-T04 Main 回复存档（S1） | 确定性 | `npx vitest run packages/agent/reply-archive.test.ts` | **passed（8/8）**：completed/failed/unexecuted 三场景逐字存档（SHA 一致）+ 详情/交付件全文；同回合多任务同值；内存/SQLite 同口径；历史行「该任务无最终回复存档」且不以汇报冒充；反向绊线（跨回合不串写、回合失败/空文本不落） | `.runtime/p1/green/target-tests.log` |
| P1-T05 只读路径哈希不变 | 确定性 | `npx vitest run packages/core/task-store-p1.test.ts` + `scripts/tasks.test.ts` e2e | **passed**：旧库只读不迁移/不建备份/主库哈希不变（新列读出缺省）；迁移后只读可读且哈希不变；CLI 列表/详情/导出前后主库哈希不变 | `.runtime/p1/green/target-tests.log` |
| P1-E01 回复逐字（黑盒） | 真实模型黑盒 | `node --import tsx .runtime/p1/e01/harness.ts`（`LLM_MODEL=step-3.7-flash`） | 预注册 N=9：合格轮（有任务行）**6**，**k=6/6**，Wilson 95% CI **[0.6097, 1.0000]**（z=1.96，`stats.ts wilson95`）；零任务行轮 3/6/9 不计入并报告；k/N 不作稳定概率解读 | `.runtime/p1/e01/{PREREGISTRATION.md,summary.json,summary.md,rounds/}` |

**P1-E01 覆盖边界（如实登记）**：9 轮按 completed/failed/unexecuted 意图轮换；实际 completed×3、failed×3 均为有任务行且逐字一致；unexecuted 意图语料（E06 文本「帮我查一下记录。」）3/3 未委派（零任务行，`ask` 按其既有行为报「未达标」exit 1）。**unexecuted 任务状态的存档逐字**由确定性用例覆盖（`reply-archive.test.ts` 三场景之一，绿）；另跑 2 轮辅助探针（写入权限确认语料，明确不在 N=9 内）：均委派且逐字一致（completed/failed 各一）。即：有任务行轮共 8 轮观测全部逐字一致（6 预注册 + 2 辅助），报告分开计数。

确定性门（回归）读数见 §四；五门拒绝话术字节金样由 `scripts/ask-runtime.test.ts` / `scripts/p0-gates-cli.test.ts` 覆盖（含在全量 unit 内，全过）。

## 三、实施改动（文件级）

| 文件 | 改动 |
|---|---|
| `packages/core/src/task-store.ts` | v2 一次版本化迁移（加列 + 部分唯一索引 + `task_sequences` 计数器 + `user_version=2`）；迁移前自动备份；单条 SQL（ROW_NUMBER）回填；只读打开旧库不迁移且缺列不 prepare 新列语句；`insertTask` 计数器同事务原子分配并返回落库行；`setReplyForTasks` 单事务同值写入；读映射三列缺省 |
| `packages/core/src/index.ts` | 导出 `TASK_STORE_SCHEMA_VERSION` |
| `packages/agent/src/task-registry.ts` | `TaskRecord` + taskNo/name/replyText；`deriveTaskName`（首段/空白折叠/40 字符截断，零模型）；`TaskRegistry.archiveReply`；内存实现同口径 |
| `packages/agent/src/task-registry-sqlite.ts` | `begin` 写机械名称；读映射三列；`archiveReply` 走 store 单事务 |
| `packages/agent/src/execution-runtime.ts` | send 收尾回复写点（非空白才落、同回合各任务行同值；全入口共用） |
| `scripts/tasks.ts` | `taskNoLabel/taskLabel/findTaskRef/taskReplyLines`；列表/详情/交付件显示；`--out` 含回复全文并更新限制文案；redo 配对行 `#编号`；`#编号`/纯数字引用解析 |
| `scripts/ops.ts` | recent/failures 首列 `#编号+名称`；限制文案改已存档口径 |
| `scripts/ask.ts` | 抽出 `renderAskEvidenceLines`（证据行 `任务=#编号 名称`）；`import.meta.main` 守卫（直接运行行为不变） |
| 测试（4 新 + 3 更新） | `packages/core/task-store-p1.test.ts`、`packages/agent/reply-archive.test.ts`、`scripts/ask-display.test.ts`、`tests/p1-concurrent-writer.ts`（并发夹具）；`scripts/{tasks,ops,tasks-redo}.test.ts` 金样更新 |

最小性：只加 3 列 + 1 部分索引 + 1 计数器表 + 1 写点 + 显示替换；不新增依赖/模块/队列/事件/双状态机；`run_task` 工具 schema 未动；不建 turns 表。

## 四、执行证据（命令 + 结果 + 路径）

| 检查 | 命令（工作树内） | 结果 | 证据 |
|---|---|---|---|
| typecheck | `npx tsc --noEmit` | **exit 0** | `.runtime/p1/green/regression-tsc.log` |
| 全量 unit（回归） | `npx vitest run` | **exit 0；40 文件 / 347 例全过**（P0 基线 33/305，只增不减；含 P0 守卫与全部冻结面测试） | `.runtime/p1/green/regression-unit.log` |
| ask 单轮金样（真实模型） | `LLM_MODEL=step-3.7-flash DB_PATH=.runtime/p1/ask-single/state.db npm run ask -- "帮我查一下 documents 集合、窗口 W202611 的数据"` | **exit 0**；回复非空；机械证据行 `任务=#1 … 结构化执行=1 次（完成 1）`；**回复 SHA=存档 SHA=375b247dd20c8f32（逐字）**；存档≠执行层汇报；UUID 仅出现在执行证据 JSON | `.runtime/p1/ask-single/{stdout.txt,verify.mjs}` |
| E06 ×1 smoke | `LLM_MODEL=step-3.7-flash npm run eval:user -- --case E06 --trials 1 --out-dir .runtime/p1/smoke/e06` | **exit 0；[judge] E06 trial-1: PASS** | `.runtime/p1/smoke/e06.log`、`.runtime/p1/smoke/e06/` |
| E12 ×1 smoke | `LLM_MODEL=step-3.7-flash npm run eval:user -- --case E12 --trials 1 --out-dir .runtime/p1/smoke/e12` | **exit 0；[judge] E12 trial-1: PASS** | `.runtime/p1/smoke/e12.log`、`.runtime/p1/smoke/e12/` |
| P1-E01 黑盒 N=9 | `node --import tsx .runtime/p1/e01/harness.ts` | k=6/6（合格轮），Wilson CI [0.6097, 1.0000]；零任务行轮 3/6/9 | `.runtime/p1/e01/`（预注册、逐轮 stdout、summary） |
| 反向绊线（≥2 类，均破坏后复原、未提交） | 见 §六 | 迁移双跑改写→红；删除后重分配（复用编号）→红；回复截断→红；复跑全绿、工作树干净 | `.runtime/p1/tripwires/`、`.runtime/p1/green/tripwires/` |

## 五、迁移/备份口径（登记）

- **版本化**：`PRAGMA user_version=2`；新库直接建 v2；旧库（缺列）首次可写打开时迁移；只读打开永不迁移（旧库可读，新列读出缺省）。
- **幂等**：列存在即不重跑；回填只填 NULL 行（二次打开零差异）；备份只生成一次（存在即保留最早副本，不覆盖、不自动删）。
- **回填**：历史行 `task_no` 按 `(created_at, task_id)` 升序单条 SQL（ROW_NUMBER）连续分配；历史 `reply_text/name` 保持 NULL（无存档不伪造）。
- **备份**：`wal_checkpoint(FULL)` 后整文件复制为 `<dbPath>.backup-v2`；`:memory:` 与库文件不存在不生成。权威口径=`packages/core/src/task-store.ts` 文首注；`docs/decision-log.md` §二十九登记。
- **编号**：`task_sequences` 计数器同事务 `UPDATE … value+1 RETURNING` + INSERT；打开时按 `MAX(现值, 历史最大编号)` 单调校正；失败回滚不占号；删除/修剪不复用、存量不重排。
- **① 版次说明**：初版实现用 `MAX(task_no)+1` 单条 SQL，绊线轮「模拟删除后重分配」暴露其回收编号（`expected 4 got 3`），已按 TDD 修复为计数器语义（提交 `a201357`，含删除模拟守卫测试）；§二十九 与本节均已登记该修正。

## 六、边界登记与绊线轮发现

- 绊线轮（本轮）三组必修项：①迁移双跑改写数据（去幂等保护）→ core 3 failed | 7 passed；②删除后重分配→复用编号（**真实缺口**，见 §五①）→修复后对已修复代码再破坏（按 MAX 重算）→ 1 failed | 9 passed；③回复截断→reply-archive 4 failed | 4 passed。破坏均未提交；`git diff --stat`/`git status --short` 为空（复原后全绿：40 文件/347 例、tsc 0）。更早一轮绊线（archiveReply 移除/编号去 +1/备份次序/空白回复守卫/编号标签）见 `619fec5` 提交信息与 `.runtime/p1/green/tripwires/`。
- 测试侧随绿修正 2 处（非放宽）：旧库夹具标识符避开过渡命名守卫（legacy→prior）；交付件「无存档」短语断言限定在最终回复段（限制文案本身含该短语）。
- 冻结面：R3 判据、eval 锁/cases/judge、历史证据、其他工作树零触碰（`git status` 无 scripts/eval 改动）；全量 unit 含 P0 单一装配点守卫（3/3）与 runner 锁校验。
- P1-E01 覆盖边界见 §二注（unexecuted 任务状态由确定性用例覆盖，黑盒未稳定复现）。

## 七、独立复核（占位）

- **未做（待分派）**。建议入口：只读复核 P1 6 个测试文件与 `task-store.ts`/`task-registry(-sqlite).ts`/`execution-runtime.ts` 改动；复跑 `npx tsc --noEmit` + `npx vitest run`；抽验 `.runtime/p1/e01/summary.json` 与 `rounds/*.json`（含逐字 SHA）；绊线可于只读副本复做。裁决记录待独立复核员填写（passed/integrity）。

## 八、回退方式（整片 revert）

- **代码 revert**：回到 P0 行为即够——迁移为加列/加表（向前兼容），回退代码后旧 SELECT 照常（旧列可读）；新增列/表保留无害。
- **历史行不伪造**：`reply_text=NULL` 显示「该任务无最终回复存档（历史任务，Main 最终回复未持久化；不以执行层汇报冒充）」；无回复文本的回合不落存档。
- **备份保留**：`<db>.backup-v2` 不随回退删除（可人工用于恢复）。
- 已核实回退面：加列不破坏旧代码 SELECT（T01 旧列快照零改动）；只读路径零写、哈希不变（T05）；不新增依赖/机制。

## 九、blocked 项

- **无**。
