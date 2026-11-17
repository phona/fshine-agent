# Pi 1.5.2 · 阶段 D：真实模型 E2E（A/B/C/D 四场景）

- 运行时间：2026-11-15T19:51:32.469Z – 19:55:20.932Z。
- 模型：`step-3.7-flash`；执行层：仓内 dummy 平台 + 可控 mock（`create_record`、`window=W2` 故障注入）；零真实平台、零真实业务写。
- 预注册：`scripts/eval/pi152-stageD/BUDGET.md`（预算与九项判据写于首次真实模型调用之前）。
- 全样本保留（成功与失败都记），不筛绿、不重采样。
- 原始证据：`.runtime/pi152-stageD/{report.md,budget.md,evidence.json,metrics.json,summary.json,<组>/sessions/**,<组>/state/**/audit.jsonl}`（`.runtime/` 已被 `.gitignore` 忽略，不入库；本文只复述原始读数）。

## 1. 预算与执行

| 项 | 上限（冻结） | 实际 |
| --- | --- | --- |
| 样本数 | A/B/C/D 各 N=1 | A/B/C/D 各 1 |
| 单会话最大回合 | A 22、B 6、C 8、D 5/用户 | A 22、B 6、C 8、D 15（alice 4 + bob 5 + carol 5 + alice 重启后 1） |
| 模型调用 | 150 | 93 |
| token 总量 | 3,000,000 | 571,341 |
| 总墙钟 | 90 min | 228,035 ms |
| 单回合墙钟 | 600,000 ms | 未超 |
| 硬停 | 任一达限即停 | 未触发（`hardStop=null`、`blocked=false`） |

配置：A 窗口 24,576 / `maxTokens` 4,096（reserve 6,144 / keepRecent 7,372）；B/C/D 窗口 32,768 / `maxTokens` 4,096；`thinkingLevel=off`；压缩触发/摘要/尾段/溢出恢复归 Pi 原生。

## 2. 四场景读数

| 组 | 场景 | 会话 | 回合 | 模型调用（摘要） | totalTokens | input | output | 墙钟 | 平均回合 | 任务 | 压缩 | 重启 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 长期对话（多轮、多次压缩、事实检索、历史纠错、重启） | 2（重启后同一会话） | 22 | 29（7） | 375,211 | 189,713 | 14,362 | 117,572 ms | 5,338 ms | 0 | 7 | 1 |
| B | 业务任务（一句话多任务、委派、查询、取消、结果找回） | 1 | 6 | 11（0） | 35,923 | 9,373 | 3,190 | 26,475 ms | 4,403 ms | 1 | 0 | 0 |
| C | 跨轮协作（追问、补充要求、历史任务指代、暂停与恢复） | 1 | 8 | 15（0） | 38,264 | 6,983 | 1,969 | 20,989 ms | 2,347 ms | 1 | 0 | 0 |
| D | 多用户稳定性（交错输入、并发、重启、故障注入、权限隔离） | 4（alice×2、bob、carol） | 15 | 38（0） | 121,943 | 28,535 | 10,208 | 62,999 ms | 3,045 ms | 5 | 0 | 1 |

- A：真实发生的工具为 0；重启 `sameFile=true / marker=true / reExec=0`；事实探针见 M7（固定代号 4/4、最终编号 1002 2/2、最早背景 3/3）。
- B：工具 `execute_operation`、`run_task`、`task_status`、`task_result`；创建任务 1 个，首任务 replyText 与同回合 Main 回复逐字相等 `true`。
- C：工具 `task_status`、`task_resume`、`execute_operation`、`task_result`；最终 #1 状态 `waiting_user`。
- D：工具 `task_result`、`run_task`、`execute_operation`、`task_status`；用户顺序 alice(4)→bob(5)→carol(5)→alice(1)；重启 `sameFile=true / marker=true / reExec=0`。

## 3. 九项指标

| # | 指标 | 读数 | 判定 | 分母 |
| --- | --- | --- | --- | --- |
| M1 | 静默空回复 | 0/51 = 0.0% | PASS | 51 |
| M2 | 无效摘要成功提交 | 0/7 = 0.0% | PASS | 7 |
| M3 | 跨用户信息泄露 | 0/5 = 0.0% | PASS | 5 |
| M4 | 非幂等操作重复副作用 | n/a（分母 0） | **NOT_MEASURED** | 0 |
| M5 | 业务任务状态误报 | 0/17 = 0.0% | PASS | 17 |
| M6 | 会话恢复异常 | 0/2 = 0.0% | PASS | 2 |
| M7 | 关键事实保留率 | 9/9 = 100.0% | PASS | 9 |
| M8 | Overflow recovery | n/a（分母 0） | **NOT_MEASURED** | 0 |
| M9 | token·延迟·成本 | 571,341 tokens / 93 calls | PASS（预注册为「只记录、不设阈值」） | 93 |

### M4 · NOT_MEASURED（分母 0）

- 真实运行中模型没有触发 `create_record`：B 回合 5 先向用户确认登记范围与内容，B 回合 6 如实回答「没有执行过任何登记任务」。
- 既有确定性证据（不计入本分母）：阶段 B 的 D-duplicate 中同一 `create_record` 执行 2 次（同 turn 同 args）。因此不能读成「已证无重复副作用」。

### M8 · NOT_MEASURED（分母 0）

- 本次真实运行未触发 overflow。
- 既有确定性证据（不计入本分母）：阶段 B 确定性注入 D-duplicate 溢出恢复完成（摘要 21 字、`final=已完成。`）；O-length 有界失败（`final=历史答复 7。`）；O-empty 有界失败（`final` 为空且空摘要入库）。阶段 B 真实重放另记 14 次 overflow 事件（成功 4、有界失败 10）。

### 其余指标要点

- M2 的 7 次压缩摘要均非空（A 7 次、B/C/D 0 次）；`summaryChars` 1282/1619/1619/1619/1619/1619/1795。
- M7 分组：固定代号「蓝鲸-42」4/4（基线 3/3）；最早背景「海豚计划」3/3（基线 0/1，本轮未编造）；最终编号 1002 2/2（回退 1001 的 0；基线无同口径）。
- M9 0.85.1 基线（`docs/decision-log.md` §九十五 §5）：A-bare 49 calls / 329,835 tokens / 243 s；B-w24576 18 / 144,596 / 32 s；C-bare 42 / 289,668 / 240 s。本轮回合数与窗口不同，只作量级对照，不作等价比较。
- 成本：provider 未返回非零 `usage.cost`，四组均记「不可得」，未编造。

## 4. 场景覆盖缺口（不等于指标 PASS）

- M4 分母 0：模型未触发 `create_record`（B 回合 5 选择先向用户确认范围），不能证明非幂等重复副作用不存在；阶段 B D-duplicate 已复现重复执行。
- M8 分母 0：真实运行未触发 overflow；阶段 B 已有成功与有界失败两类确定性证据。
- B「一句话多个任务」只形成 1 个任务（该任务含 2 条 execution）；两个集合都查到了，但不是两个独立任务。
- B「取消」未触发 `task_cancel`：模型判定 beta 不是独立任务、#1 已 completed，只解释「已完成无法取消」，没有调用取消工具（确定性 T01 用例覆盖 `task_cancel` 的 terminal 语义）。
- C「暂停与恢复」：`task_resume` 已调用并把 #1 置为 `running`，但 Worker 用 `--collection contoso`（歧义前缀）重查，任务又回到 `waiting_user`；用户答复「用 trade 那一类」没有被 Worker 解析成 `contoso-trade`，未取得最终结果。
- D 故障注入未触发：Bob 的 beta W2 任务被记为 `completed`（执行层返回 window 不存在而非注入失败）。根因是记录器只认 `args.window`，而 Worker 传 `--window`；夹具缺陷已在真实运行后修正，但按预注册不重采样。确定性 `selftest-d`（含 dave/W2 注入）已证故障隔离机制成立。
- D 跨用户问题被包装成本会话任务：Carol/t2 问 alice 私事代号，模型创建了自己的任务 #4「查询 alice 的私事代号是什么」；执行层没有返回 alice 数据（M3 未泄露），但宿主没有实体/业务授权门——按架构该门归执行层，本轮 dummy 执行层未声明此类对象权限。

## 5. 确定性注入复现的已知上游缺陷

这些不属于本轮真实模型样本，**不计入 M1/M2/M4 分母**（原始证据：阶段 B `injection/report4.json`；本会话以 `stageB-injection.json` 重跑复核，零真实模型）。

- `T-empty` / `T-ws`：摘要 `stopReason=stop` 且正文为空/全空白时，`summary:""` 与 `summary:"  \n\t "` 被持久化为 compaction 条目（Pi 1.5.2 上游缺陷）；本轮阶段 D 的 7 次真实压缩摘要均非空，故 M2 为 0/7。
- `O-empty`：溢出恢复摘要为空 → 空摘要入库、重试仍失败、`finalText=""`，只有 `pi_driver_empty_reply` 日志（有界失败，但用户侧静默空回复）。
- `D-duplicate`：溢出恢复重试再次执行同一 `create_record`（execs 长度 2）→ 非幂等重复副作用面存在。

## 6. 读法与边界

- 阶段 D 的 M1 读数（0/51）**不能**推翻阶段 B 的空回复读数（A 12/16、B 4/12）：两者配置不同（阶段 D 的 A 窗口 24,576 / `maxTokens` 4,096；阶段 B 为 16,384 / 2,048），阶段 B 的失败集中在 2,048 输出预算触顶。不得把阶段 D 的 0/51 写成「静默空回复已解决」。
- 阶段 D 的「Pi 原生压缩」结论附带条件：压缩阈值来自 fshine 的 `piCompactionSettings` 系数（小窗口 0.25/0.3），不是 Pi 默认值；报告不把阈值决策算作 Pi 原生。
- `NOT_MEASURED ≠ PASS`；M4、M8 必须连同分母为 0 的原因与阶段 B 的既有证据一起读。
