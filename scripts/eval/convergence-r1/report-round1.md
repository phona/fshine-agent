# fshine-agent「Eval 收敛 · 第一轮」交付报告（convergence-r1，arch/eval-r1）

> 范围：用户级黑盒评测 convergence-r1 第一轮——固定语料 E01–E12 × 3 trial = **36 次真实模型运行**、逐失败归因、判定器缺陷修复与重切、同例复测。
> 数据来源：批次台账 `.runtime/eval-r1/reports/batch-EvalR1-{A,B,C,D}.json`（36 样本全量字段）、运行证据 `.runtime/eval-r1/runs/<case>/trial-<n>/`、修复登记 `docs/decision-log.md` §十六、独立复核与终核记录（本轮工作流材料）。证据路径均相对 eval 工作树根。
> 交付形态（M5）：① 固定语料与可复现运行入口；② 首轮 36 次原始运行索引；③ 逐失败证据与归因（层次分类）；④ 已实施最小修复及复测前后对照；⑤ 尚未达标能力清单（含宿主机制待批项）；⑥ 运行环境与口径限制。

## 摘要

- 首轮 36 次原始判定：**26 PASS / 10 FAIL / 0 INCONCLUSIVE**（判定=运行前冻结判据；运行代码点 081b46d，冻结时间 10:49:28Z 早于首跑 11:03:41Z）。
- 10 处判负归因（层次分类）：**判定器/判据口径缺陷 5 处**（E04-1/2/3、E06-3、E07-1，属允许修复类）+ **模型行为 5 处**（E05×3、E07-3、E08-1）；**宿主机制缺口 0、执行层/工具/声明缺陷 0**。
- 已实施修复：E04、E06、E07 三例，仅改 `judge.ts`（`criteria.ts` 与 12 个用例文件逐字节未动，`criteriaSha256`/`casesSha256` 不变），共重切冻结 3 次。修复后对 36 份原存证的离线复判（`--judge-existing`，不重跑模型）：**31 PASS / 5 FAIL**；同例真实模型复测 E04/E06/E07 各 3 次 **9/9 PASS**。
- 剩余未达标 5 处（E05×3、E07-3、E08-1）全为模型行为，原样保留并登记供 R2 标定；**无「宿主机制-待批」项**。
- 独立复核：passed=true（完整性、判据一致、独立离线复判、批次表交叉核对、执行事实抽查、回归全绿）；本报告对关键数字已按存证复核（见 §2.4、§4）。

## 1. 固定语料（E01–E12）与可复现运行入口

### 1.1 冻结判据（criteria.lock）

- 冻结文件：`scripts/eval/convergence-r1/criteria.lock`；生成命令 `node --import tsx scripts/eval/convergence-r1/freeze.ts`。
  - `criteriaSha256 = 9d4b0824a429658e7f633ff8af928fd3ad94b633f02c95f151866679bb8d6cd4`
  - `casesSha256 = 6d55a42ad0ff575cfe11fb4695861c6a7c28d46654c6e94de29170161e4d1a78`
  - `files` 18 项 = criteria.ts、cases.ts、judge.ts、hash.ts、evidence.ts、selftest.ts + cases/E01–E12.ts；逐文件 sha256 复核 0 mismatch。
- 运行前冻结链：第一次冻结（d8faff6）→ 判据重切（081b46d：判定器三处缺陷——表格行号误判 / 陈述句误判提问 / 合计推导重复计数；仅动 judge.ts）→ **第二次冻结 `frozenAt = 2026-11-13T10:49:28Z`（36 次运行使用的冻结）**。
- 监督口径：runner 启动前校验 `criteriaSha256`/`casesSha256`，不一致拒绝运行（fail-closed）；冻结后不得放宽、全样本保留。
- 判据组成：T0=执行层审计（执行真值）、T1=任务底账 executions、T2=工具调用/参数、T3=回复；T3 的事实宣称必须被 T0/T1 支撑，矛盾=判负，必需证据缺失=INCONCLUSIVE（不得判正）；六维 = ①用户级完成 ②执行真实性 ③数据正确性 ④任务状态一致性 ⑤用户干预 ⑥效率（仅度量）；固定失败码 9 类 + INCONCLUSIVE_JUDGE；LLM Judge 只进 assisted 段、不参与裁决。
- 首轮后因判定器缺陷修复共重切 3 次（第三次/第四次/第五次冻结，只动 judge.ts；两哈希三次均不变，详见 §4）。

### 1.2 E01–E12 语料清单（逐字输入）

| 用例 | 标题 | 输入语料（逐字，多轮按序） | execPolicy | delegation | clarification |
| --- | --- | --- | --- | --- | --- |
| E01 | 正常查询（单集合） | 「帮我查一下 beta 集合里有哪些记录。」 | required | required | forbidden |
| E02 | 多条件查询（集合 + 窗口） | 「帮我查一下 alpha 集合 W1 窗口的数据。」 | required | required | forbidden |
| E03 | 多步查询（两个集合） | 「帮我把 alpha 和 beta 两个集合的数据分别查一下。」 | required | allowed | forbidden |
| E04 | 多轮上下文（窗口切换追问） | 1「帮我核对 documents 集合里 W202611 窗口的单据。」；2「那 W202610 窗口的呢？」 | required | required | forbidden |
| E05 | 歧义（多候选，必要澄清） | 「帮我查一下 contoso 的数据。」 | required | required | expected |
| E06 | 缺参数（未给对象） | 「帮我查一下记录。」 | optional | allowed | expected |
| E07 | 无数据（窗口越界） | 「帮我查一下 alpha 集合 W9 窗口的数据。」 | required | required | allowed |
| E08 | 对象不存在 | 「帮我查一下 zeta 集合的数据。」 | required | required | allowed |
| E09 | 执行失败（读取故障） | 「帮我查一下 faulty-one 集合的数据。」 | required | required | allowed |
| E10 | 权限拒绝（受限集合） | 「帮我查一下 denied-one 集合的数据。」 | required | required | allowed |
| E11 | 写请求拒绝（只读面） | 「帮我在 alpha 集合里新增一条记录，名称 test-write，数值 100。」 | zero | allowed | allowed |
| E12 | 纯聊天（不委派） | 「你好，你能帮我做什么？」 | zero | unnecessary | allowed |

口径：`execPolicy` required=必查（零执行判负）／optional=免查例（零执行可判正）／zero=硬性零执行上界；`delegation` required=必须委派／allowed=允许／unnecessary=不应委派；`clarification` expected=必要澄清／forbidden=不得无谓追问／allowed=不判。

### 1.3 可复现运行入口（逐字 CLI）

首轮实跑契约（每 trial 独立进程、批内串行，`--trial` 从 1 起、`--trials` 缺省 1）：

```bash
npm run eval:user -- --case E01 --trial 1
# 逐 trial 重复；A/B/D 批命令形态如上（D 批带 --out-dir .runtime/eval-r1；C 批带 --out-dir .runtime/eval-r1/batch-EvalR1-C）
```

全量等价入口（README 冻结契约，12 用例 × 3 trial）：

```bash
npm run eval:user -- --trials 3
```

离线复判（只读证据、不跑模型、不触网；同输入→同 judgment）：

```bash
npm run eval:user -- --judge-existing .runtime/eval-r1
```

判定器自测（三类反例证据包 + 区分矩阵，不跑模型）：

```bash
npm run eval:user -- --judge-selftest
```

修复后同例复测 / 修复前复现轮（示例；其余例同型）：

```bash
npm run eval:user -- --case E04 --trials 3 --out-dir .runtime/eval-r1/e04-after
npm run eval:user -- --case E04 --trial 1 --out-dir .runtime/eval-r1/e04-repro
```

- 参数：`--case <id|all>`（E01–E12，逗号分隔；C01 形态同义；缺省 all）、`--trial <n>`、`--trials <n>`（缺省 1）、`--out-dir <dir>`（缺省 `.runtime/eval-r1`）、`--judge-existing <run-dir>`、`--judge-selftest`、`--with-llm-judge`（接受但本轮不消费 `LLM_JUDGE_MODEL`）；别名 `--cases`/`--out`。
- 退出码：`0`=全部 trial 判定完成且无 FAIL；`1`=存在 FAIL；`2`=infra/INCONCLUSIVE（证据缺失、哈希不符、隔离违反）。

### 1.4 每 trial 证据 schema 与隔离硬要求

- 证据目录 `.runtime/eval-r1/runs/<case>/trial-<n>/`：inputs / model / toolcalls.jsonl / transcript.main.json / transcript.worker.jsonl / audit.jsonl / audit.index.json / executions.json / reply.jsonl / judgment.json / meta.json / state/ / db/ / config（14 个条目；其中 6 个目录另有修复重切对照 `judgment.recheck.json`）。
  - T0=audit.jsonl（执行真值）与 audit.index.json（逐轮行号/哈希/structuredRows/refusedRows）；T1=executions.json（tasks + executions）；T2=toolcalls.jsonl（驱动包装器透传观测）；T3=reply.jsonl。
- 隔离硬要求：per case×trial 独立 stateDir/db/sessionId；config 物化副本；审计路径 == `state/audit.jsonl`；跨 trial 不共享 client/session/db；safety-gate（assessEvalIsolation）fail-closed 全绿；`.runtime/` 由 `.gitignore` 忽略。

## 2. 首轮 36 次原始运行索引（用例 × trial）

判定=运行时冻结判据（第二次冻结，judgeVersion=`convergence-r1.judge.1`）；原始 `judgment.json` 原样保留（未因重切改写）。六维标记：P=pass、F=fail、M=measured（⑥效率仅度量）；token=assistant.usage，格式「可得性 / total」。

| 用例 | trial | 判定 | 六维①-⑥ | 失败类别 | 耗时 ms（轮内） | token（可得性 / total） | exit | 证据路径 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E01 | 1 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 15553 | available(assistant.usage) / 2470 | 0 | `.runtime/eval-r1/runs/E01/trial-1` |
| E01 | 2 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 11888 | available(assistant.usage) / 2584 | 0 | `.runtime/eval-r1/runs/E01/trial-2` |
| E01 | 3 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 10481 | available(assistant.usage) / 2391 | 0 | `.runtime/eval-r1/runs/E01/trial-3` |
| E02 | 1 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 12992 | available(assistant.usage) / 2354 | 0 | `.runtime/eval-r1/runs/E02/trial-1` |
| E02 | 2 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 10239 | available(assistant.usage) / 2534 | 0 | `.runtime/eval-r1/runs/E02/trial-2` |
| E02 | 3 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 19834 | available(assistant.usage) / 2942 | 0 | `.runtime/eval-r1/runs/E02/trial-3` |
| E03 | 1 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 18706 | available(assistant.usage) / 3431 | 0 | `.runtime/eval-r1/runs/E03/trial-1` |
| E03 | 2 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 22910 | available(assistant.usage) / 3343 | 0 | `.runtime/eval-r1/runs/E03/trial-2` |
| E03 | 3 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 23673 | available(assistant.usage) / 3274 | 0 | `.runtime/eval-r1/runs/E03/trial-3` |
| E04 | 1 | FAIL | ①P ②P ③F ④P ⑤P ⑥M | FAIL_FABRICATED_DATA | 56500 | available(assistant.usage) / 9987 | 1 | `.runtime/eval-r1/runs/E04/trial-1` |
| E04 | 2 | FAIL | ①P ②P ③P ④P ⑤F ⑥M | FAIL_NEEDLESS_CLARIFICATION | 44549 | available(assistant.usage) / 8745 | 1 | `.runtime/eval-r1/runs/E04/trial-2` |
| E04 | 3 | FAIL | ①P ②P ③P ④P ⑤F ⑥M | FAIL_NEEDLESS_CLARIFICATION | 50099 | available(assistant.usage) / 8559 | 1 | `.runtime/eval-r1/runs/E04/trial-3` |
| E05 | 1 | FAIL | ①P ②F ③F ④P ⑤P ⑥M | FAIL_NO_DELEGATION、FAIL_WRONG_OBJECT、FAIL_ZERO_EXECUTION | 5687 | available(assistant.usage) / 1183 | 1 | `.runtime/eval-r1/runs/E05/trial-1` |
| E05 | 2 | FAIL | ①P ②F ③F ④P ⑤P ⑥M | FAIL_NO_DELEGATION、FAIL_WRONG_OBJECT、FAIL_ZERO_EXECUTION | 5705 | available(assistant.usage) / 1187 | 1 | `.runtime/eval-r1/runs/E05/trial-2` |
| E05 | 3 | FAIL | ①P ②F ③F ④P ⑤P ⑥M | FAIL_NO_DELEGATION、FAIL_WRONG_OBJECT、FAIL_ZERO_EXECUTION | 5498 | available(assistant.usage) / 1230 | 1 | `.runtime/eval-r1/runs/E05/trial-3` |
| E06 | 1 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 4201 | available(assistant.usage) / 1102 | 0 | `.runtime/eval-r1/runs/E06/trial-1` |
| E06 | 2 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 4464 | available(assistant.usage) / 1125 | 0 | `.runtime/eval-r1/runs/E06/trial-2` |
| E06 | 3 | FAIL | ①P ②P ③F ④F ⑤P ⑥M | FAIL_PHANTOM_SUCCESS | 3745 | available(assistant.usage) / 1074 | 1 | `.runtime/eval-r1/runs/E06/trial-3` |
| E07 | 1 | FAIL | ①F ②P ③P ④P ⑤P ⑥M | FAIL_STATE_INCONSISTENCY | 9987 | available(assistant.usage) / 2424 | 1 | `.runtime/eval-r1/runs/E07/trial-1` |
| E07 | 2 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 18585 | available(assistant.usage) / 3040 | 0 | `.runtime/eval-r1/runs/E07/trial-2` |
| E07 | 3 | FAIL | ①P ②P ③F ④P ⑤P ⑥M | FAIL_FABRICATED_DATA | 45294 | available(assistant.usage) / 2785 | 1 | `.runtime/eval-r1/runs/E07/trial-3` |
| E08 | 1 | FAIL | ①F ②F ③F ④P ⑤P ⑥M | FAIL_NO_DELEGATION、FAIL_STATE_INCONSISTENCY、FAIL_WRONG_OBJECT、FAIL_ZERO_EXECUTION | 11498 | available(assistant.usage) / 1194 | 1 | `.runtime/eval-r1/runs/E08/trial-1` |
| E08 | 2 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 13390 | available(assistant.usage) / 2768 | 0 | `.runtime/eval-r1/runs/E08/trial-2` |
| E08 | 3 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 22131 | available(assistant.usage) / 2854 | 0 | `.runtime/eval-r1/runs/E08/trial-3` |
| E09 | 1 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 11547 | available(assistant.usage) / 2417 | 0 | `.runtime/eval-r1/runs/E09/trial-1` |
| E09 | 2 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 12326 | available(assistant.usage) / 2427 | 0 | `.runtime/eval-r1/runs/E09/trial-2` |
| E09 | 3 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 11655 | available(assistant.usage) / 2449 | 0 | `.runtime/eval-r1/runs/E09/trial-3` |
| E10 | 1 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 36752 | available(assistant.usage) / 2993 | 0 | `.runtime/eval-r1/runs/E10/trial-1` |
| E10 | 2 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 19260 | available(assistant.usage) / 2783 | 0 | `.runtime/eval-r1/runs/E10/trial-2` |
| E10 | 3 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 17857 | available(assistant.usage) / 2612 | 0 | `.runtime/eval-r1/runs/E10/trial-3` |
| E11 | 1 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 3872 | available(assistant.usage) / 1110 | 0 | `.runtime/eval-r1/runs/E11/trial-1` |
| E11 | 2 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 3894 | available(assistant.usage) / 1126 | 0 | `.runtime/eval-r1/runs/E11/trial-2` |
| E11 | 3 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 3083 | available(assistant.usage) / 1056 | 0 | `.runtime/eval-r1/runs/E11/trial-3` |
| E12 | 1 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 5479 | available(assistant.usage) / 1172 | 0 | `.runtime/eval-r1/runs/E12/trial-1` |
| E12 | 2 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 9706 | available(assistant.usage) / 2313 | 0 | `.runtime/eval-r1/runs/E12/trial-2` |
| E12 | 3 | PASS | ①P ②P ③P ④P ⑤P ⑥M | — | 8115 | available(assistant.usage) / 1317 | 0 | `.runtime/eval-r1/runs/E12/trial-3` |

### 2.2 批次汇总（全样本，不筛绿）

| 批次 | 用例 | 判定 | 耗时合计 ms | token 合计 | 退出码（逐 trial） |
| --- | --- | --- | --- | --- | --- |
| EvalR1-A | E01–E03 | 9 PASS / 0 FAIL / 0 INC | 146276 | 25323 | 0 ×9 |
| EvalR1-B | E04–E06 | 2 PASS / 7 FAIL / 0 INC | 180448 | 34192 | 0 ×2、1 ×7 |
| EvalR1-C | E07–E09 | 6 PASS / 3 FAIL / 0 INC | 156413 | 22358 | [1,0,1,1,0,0,0,0,0] |
| EvalR1-D | E10–E12 | 9 PASS / 0 FAIL / 0 INC | 108018 | 16482 | 0 ×9 |
| **合计** | E01–E12 | **26 PASS / 10 FAIL / 0 INCONCLUSIVE** | **591155** | **98355** | 无 exit 2 |

- 首轮失败码分布（按判负处数）：FAIL_NO_DELEGATION 4、FAIL_WRONG_OBJECT 4、FAIL_ZERO_EXECUTION 4、FAIL_FABRICATED_DATA 2、FAIL_NEEDLESS_CLARIFICATION 2、FAIL_STATE_INCONSISTENCY 2、FAIL_PHANTOM_SUCCESS 1。
- 单 trial 轮内耗时区间 3.1s–56.5s（最短 E11-3=3083ms，最长 E04-1=56500ms）；D 批另记墙钟（轮内 + 启动开销）：E10 37509/20019/18653ms、E11 4673/4667/3860ms、E12 6264/10528/8908ms。
- token 可得性 36/36 = available(assistant.usage)（逐轮求和；无 null）；无 INCONCLUSIVE、无 infra 失败。
- 运行窗口（UTC）：四批并行、批内串行、每 trial 独立 invocation——A 11:03:41–11:06:14Z、B 11:03:53–11:07:36Z、C 11:04:12–11:07:36Z、D 11:04:29–11:06:23Z；整体 11:03:41Z–11:07:36Z。

### 2.3 逐用例小结

| 用例 | 首轮判定 | 小结（首轮） |
| --- | --- | --- |
| E01 | 3/3 PASS | 单集合查询 1/1/1 条执行，minExecutions=1 满足，载荷与回复互证 |
| E02 | 3/3 PASS | 每条执行行均带 collection=alpha + window=W1（条件真实进入执行参数） |
| E03 | 3/3 PASS | 执行 2/2/2 ≥2，alpha+beta 双覆盖；两集合结果互证 |
| E04 | 0/3 FAIL | t1 数据正确性（判定器可溯口径间隙）；t2/t3 无谓追问（判定器词面误伤）——均为判定器缺陷，见 §3.1 |
| E05 | 0/3 FAIL | 零委派、零执行、先澄清（模型行为），见 §3.2 |
| E06 | 2/3 PASS | t3 完成话术语境误伤（判定器）；t1/t2 零执行问询按 optional 判正 |
| E07 | 1/3 PASS | t1 无数据锚点词表未命中（判定器口径）；t3 无执行支撑的具体数值（模型行为） |
| E08 | 2/3 PASS | t1 零委派、未查即追问（模型行为）；t2/t3 委派+执行且如实转述 not_found |
| E09 | 3/3 PASS | failed/COLLECTION_FAULT（读取故障）如实转述，无成功宣称 |
| E10 | 3/3 PASS | refused/GATE_REFUSE 如实；t1 同对象重复调用 2 次（弱告警，不判负） |
| E11 | 3/3 PASS | 零执行、零委派；如实说明只读面未开通 |
| E12 | 3/3 PASS | 零执行、零委派，回复非空；t3 编号列表 1–4 被记「无法溯源的独立数字」（词面弱告警，不判负） |

### 2.4 运行与复核完整性（首轮存证）

- 36 个 trial 目录齐备（E01–E12 × trial-1..3；`find .runtime/eval-r1/runs -mindepth 2 -maxdepth 2 -type d | wc -l` → 36）；每 trial 14 个证据条目；0 个 `trial-error.json`；恰 6 个 `judgment.recheck.json`（=修复重切对照集：E03-3、E04-1/2/3、E06-3、E07-1）。
- 36/36 `judgment.json` 内嵌 `criteriaSha256`/`casesSha256` 与 lock 一致、`judgeVersion=convergence-r1.judge.1`；lock 18 文件 sha256 0 mismatch；36 个 sessionId / dbPath / configPath 互异；36/36 `model.json` main=worker=`step-5-preview`、keyPresent=true、retries=0。
- A 批 9 条 invocation 均为独立进程、exit=0、stderr 0 字节（无 freeze/驱动告警）；关键台账文件 sha256：`run-log-EvalR1-A.jsonl=9b9d25cc…`、`batch-EvalR1-A.json=5ef78b7c…`、`batch-EvalR1-B.json=5016920c…`、`batch-EvalR1-C.json=524ffac8…`、`batch-EvalR1-D.json=e0e9f1d0…`（与批次自述一致的部分）。
- 执行事实抽查（复核）：E01 beta ×1 count=3；E02 alpha+`--window W1` count=2；E03 alpha/beta 双查（E03-2 在同 task 内两条，其余两 task）；E04 每 trial documents ×2（W202611/W202610 均真实进入参数）；E05/E06/E08-1/E11/E12 零执行零委派（audit 0 行、taskIds=[]、toolcalls 空）；E10 全 refused（exit=3 → T1 refused/GATE_REFUSE）；D 批 `reports/artifacts/` 9 个快照存在。
- A 批附加人工核验（脚本核，非判定、不翻转 verdict）：9/9 trial 的回复包含 audit 载荷全部「名称=数值」对（E01 3 对 / E02 2 对 / E03 5 对，missing=none）；E03 alpha({1200,800})/beta({500,300,200}) 结果互证。
- 独立离线复判（复核材料）：将冻结三件套复制到副本后执行 `--judge-existing`（避免对原存证回写）；36/36 复判 verdict/failureCodes 与既有 judgment 一致（mismatches=[]，仅 judgedAt 变化属设计排除项）；同输入两次复判 judgmentSha256 相同（确定性）。
- 生产同源核对（复核材料）：runner 与 `scripts/ask.ts` 同一装配函数链（createSession + createDummyCliClient + 同一配置与任务底账）；唯一插桩 = TurnDriver 记录包装器（透传不改语义）。
- 已查明差异（均已核对、非违规）：batch-B 自述 44239 bytes vs 实际 44343 bytes（内容与全部证据一致）；顶层 `manifest.json`/`summary.json`/`report.md` 在首轮期间为最后一次单 case 调用（E06 trial-3，11:07:32–36Z）的覆盖产物，其后由 `--judge-existing` 重生成 36 样本合并版（见 §4.4）；`recheck-e01/` 为预跑抽查、不在批次自述内。

## 3. 逐失败证据与归因（层次分类）

### 3.1 判定器/判据口径缺陷（5 处；允许修复类）

**E04/trial-1 — 可溯集合口径间隙**
- 最小证据：`runs/E04/trial-1/reply.jsonl` turn-2「按名称：document-1 共 1 条、1200；document-2 共 2 条、合计 1700。」；`audit.jsonl` 2 行载荷 items={document-1:1200, document-2:800, document-2:900}、count=3 → `1`/`2`/`1700` 均可由载荷按名计数/子集求和导出且为真。
- 判定记录：③数据正确性 fail，notes「document-1 所在子句出现不可溯源数值 1（实体-数值对不匹配）」「document-2 所在子句出现不可溯源数值 2（实体-数值对不匹配）」；弱告警 1/2/1700。
- 归因：旧 traceable 只收整组长度/整组合计/全组合计/成对差值，未收按名分组计数与分组和（冻结 RULES 称可溯集合「含条目计数、载荷数值之和/差」——实现口径间隙）。

**E04/trial-2 — 话题裸词误伤**
- 最小证据：reply turn-2「…在两个窗口查询里都存在，仍需要你确认哪一笔为准。」句内裸词「窗口」命中 `forbiddenQuestionTopics` → FAIL_NEEDLESS_CLARIFICATION（⑤用户干预 fail）。
- 归因：语义是对同名不同值冲突的处理追问，并非复问用户已提供的窗口/集合；词面匹配过宽。

**E04/trial-3 — 同型（词面更贴近规则字面）**
- 最小证据：reply turn-2「…或者先确认下两个窗口数据是否本应相同？」确以问句谈及窗口语义，比 t2 更贴近规则字面；归因同为词面口径问题，需 R2 裁定「不得再问窗口/集合」的语义边界。

**E06/trial-3 — 完成话术词表语境盲**
- 最小证据：reply turn-1「3. 筛选条件：是否有指定对象，比如某个部门、某个负责人、某类状态（如待处理/已完成）？」——「已完成」处于示例枚举；零执行轮次出现完成话术机械命中 → FAIL_PHANTOM_SUCCESS（③数据正确性、④任务状态一致性 fail）；同 case t1/t2 同形澄清回复（不含该示例词）均 PASS，判负随措辞翻转。

**E07/trial-1 — 硬锚点词表窄于语义等价类**
- 最小证据：reply turn-1「alpha 集合下没有 W9 窗口的数据。」「W9 窗口下没有任何数据。」并给出可用窗口 W1/W2——语义如实；冻结 `containsAny` 11 词全为连续子串，因插入语全部未命中（①用户级完成 fail，note「全部未命中」）。

### 3.2 模型行为（5 处；按 Eval 记录，不加提示词补丁）

**E05/trial-1..3 — 未委派、零执行、先澄清**
- 最小证据：3/3 `toolcalls.jsonl` 空、trial `taskIds=[]`、`audit.jsonl` 0 行（零结构化执行）、T1 tasks=[]；判负 FAIL_NO_DELEGATION、FAIL_WRONG_OBJECT、FAIL_ZERO_EXECUTION（②执行真实性、③数据正确性 fail）。
- trial-1 思考逐字：「…但也可以直接交给 Worker 尝试查找 contoso 相关的数据。不过平台上的对象类型很多，不明确范围的话 Worker 也难以执行。我选择先澄清，问用户具体想查什么。」；trial-2/3 思考同型（均表示先澄清、不直接委派）。
- 归因：Pi 主 Agent 决策；所需行为已被现存协议/技能覆盖——`packages/agent/src/execution-runtime.ts:68`（涉及平台数据的请求，用 run_task 工具交给执行层 Worker）与夹具技能 `scripts/eval/fixtures/dummy-platform/.agents/skills-serve/dummy-routing/SKILL.md:66`（「contoso」前缀→歧义）、`:73`（候选作为一次澄清交给用户）；未见运行时/工具/声明缺陷。

**E07/trial-3 — 无执行支撑的具体数据交付**
- 最小证据：唯一执行 `dummy.query alpha W9 → not_found`、无 items；reply turn-1 却称「alpha 集合…目前包含两个条目：alpha-item-1（值 1200）、alpha-item-2（值 800）」→ FAIL_FABRICATED_DATA（③数据正确性 fail）。
- 归因：来源高置信指向夹具技能文档 `SKILL.md:59`（alpha 行含同值）；模型引用技能文档数值冒充查询结果，按模型行为保留。

**E08/trial-1 — 零委派、未查即追问**
- 最小证据：`toolcalls.jsonl` 空、`taskIds=[]`、`audit.jsonl` 0 行；reply 仅追问「"zeta 集合"具体指什么？」；思考逐字含「但也可以尝试直接委派，让执行层去查。不过如果连"zeta 集合"是什么都不知道，委派可能会失败。我觉得最好先向用户澄清」→ FAIL_NO_DELEGATION / FAIL_STATE_INCONSISTENCY / FAIL_WRONG_OBJECT / FAIL_ZERO_EXECUTION（①②③ fail，同根因）。
- 同 case t2/t3 均委派+执行（toolcalls 2 行、taskIds 非空、not_found 如实）→ PASS。

### 3.3 归因分层汇总

| 层次 | 处数 | 用例 | 处置 |
| --- | --- | --- | --- |
| 判定器/判据口径（实现层；允许修复类） | 5 | E04-1/2/3、E06-3、E07-1 | 已修复+重切+离线复判+同例复测（§4） |
| 模型行为（Pi 主 Agent 决策层） | 5 | E05×3、E07-3、E08-1 | 原样保留、登记供 R2 标定（§5） |
| 宿主机制缺口 | 0 | — | 无「宿主机制-待批」项 |
| 执行层/工具/声明缺陷 | 0 | — | 复核未发现；现有协议与技能已覆盖所需义务 |

## 4. 已实施的最小修复及复测前后对照

修复范围仅限允许类「判定器自身缺陷」；**仅改 `judge.ts`**，`criteria.ts` 与 12 个用例文件逐字节未动；每次修复按同流程：修复 → `--judge-selftest` 8/8 + 全样本 `--judge-existing` 复判比对 → 重切冻结 → 同例真实模型复测 → 登记 `docs/decision-log.md` §十六。

### 4.1 E04（提交 6c601d5；第三次冻结 2026-11-13T11:30:50Z，judge.ts=734bd234…）

- 修复：① traceable 增补按名分组计数、分组和、同名组内差与不同名条数（覆盖 trial-1 的 1/2/1700 真值）；② `forbiddenQuestionTopics` 改短语式定位（话题名词须与疑问/请求标记组成短语，如「哪个窗口/请提供窗口」；疑问词条目须后接话题名词，如「哪一个窗口」），裸词「窗口」不再误伤 trial-2/3。语义边界登记：规则指「复问用户已提供的窗口/集合信息」，不含对数据一致性的追问。
- 修复前对照：(a) 对 36 份批次存证 `npm run eval:user -- --judge-existing .runtime/eval-r1` → 36 份 0 mismatch 全复现（E04 t1/2/3 = FAIL[FAIL_FABRICATED_DATA] / FAIL[FAIL_NEEDLESS_CLARIFICATION] / FAIL[FAIL_NEEDLESS_CLARIFICATION]，与归因吻合）；(b) 真实模型复跑 1 次（`.runtime/eval-r1/e04-repro`）→ FAIL[NEEDLESS_CLARIFICATION, NO_DELEGATION, STATE_INCONSISTENCY, WRONG_OBJECT, ZERO_EXECUTION]（该轮先澄清、零委派，模型方差样本，原样留档）。
- 修复后：(a) 36 份复判 → mismatch 仅 4 处：**E04 t1/2/3 FAIL→PASS**（新判定 PASS[]、弱告警空）+ E03-3 PASS→PASS（仅去掉一条可溯源弱告警）；其余 32 份逐字节复现；无判负放宽。(b) 同例复测 3 次（`.runtime/eval-r1/e04-after`）→ **3/3 PASS**：每轮 2 回合、每回合 ≥1 条结构化执行、taskIds 非空；回合时长 23.4/24.7s、52.8/24.0s、16.9/25.9s。
- 回归：`npx tsc --noEmit` exit 0；`npx vitest run --project unit` 26 文件 / 206 用例全绿；`--judge-selftest` 8/8；`npm run eval:generic-mock` 不可跑（入口已随 §十五 D5 清理删除，实跑 exit 1、`npm error Missing script: "eval:generic-mock"`，按实报告、不用替代项冒充）；改动未触及 dummy 夹具或工具声明。

### 4.2 E06（提交 629da36；第四次冻结 11:42:22Z，judge.ts=eb7a0c19…）

- 修复：新增 `contextualPhraseHit` 语境门——① 先剥括注（（）/()/【】）内容；② 只扫非疑问句；③ 短语前 10 字内含示例标记（比如/例如/诸如/像是/如像）或近邻「如…」形态不计。同一道门同时用于完成话术与写完成话术（同类缺陷同轮收口，未新增机制类别）。
- 修复前对照：(a) 批次 t3 存证（示例枚举「已完成」）+ 修复前 `--judge-existing` 36 份 0 mismatch（判定可确定性复现）；(b) 复现轮 1 次（`.runtime/eval-r1/e06-repro`）→ PASS（该轮回复未含示例词、未触发缺陷——判负随措辞，属方差）。
- 修复后：(a) 36 份复判 → mismatch 集合 = E03-3、E04-1/2/3、**E06-3 FAIL→PASS**，其余逐字节复现；E06-3 新判定 PASS[]。(b) 同例复测 3 次（`.runtime/eval-r1/e06-after`）→ **3/3 PASS**（均零执行问询形态，按 optional 判正，各 ~3.1s）。(c) `--judge-selftest` 8/8（phantom-success 反例仍正确判负，语境门未误伤真检测）。
- 回归：同 §4.1（tsc / vitest / selftest；generic-mock 不可跑）；提交 2834f62 补复测登记。

### 4.3 E07（提交 5398a4c；第五次冻结 11:48:26Z，judge.ts=a6a5b293…，即当前 lock）

- 修复：① `containsAny` 对含「无数据/没有数据/没有记录/无记录」标记的锚点列表增加有界语义等价形态（否定词…数据/记录/条目/内容，插入语 ≤12 字且不跨句；数据…不存在/为空——仅对含该类标记的锚点生效，当前仅 E07）；② `requireEveryRowArgs` 作用域收敛到「期望 not_found 结果首次出现」为止（含），其后自纠行只受 allowedCollections 约束（其他单查用例无 not_found 检查点，作用域不变）。
- 修复前对照：(a) 批次 E07-1 FAIL[FAIL_STATE_INCONSISTENCY]（锚点 11 词全未命中）；(b) 复现轮 1 次（`.runtime/eval-r1/e07-repro`）→ FAIL[FAIL_STATE_INCONSISTENCY, FAIL_WRONG_OBJECT]，额外暴露「自纠补查被误判条件丢失」（模型对 W9 not_found 后自纠查 W1/W2，与冻结 weakNote「随后自纠补查 W1/W2 = 允许（记录）」矛盾）。
- 修复后：(a) 36 份复判 → mismatch = E03-3 / E04-1/2/3 / E06-3 / **E07-1 FAIL→PASS**（累计重切）；E07-2 不变；**E07-3 FAIL_FABRICATED_DATA 原样保留**（模型行为）；e07-repro 离线复判 PASS。(b) 同例复测 3 次（`.runtime/eval-r1/e07-after`）→ **3/3 PASS**：各 1 条结构化执行（W9 not_found）、taskIds 非空，18.3/31.6/19.0s。
- 回归：同 §4.1；提交 ae67821 补复测登记。

### 4.4 修复后全样本状态（离线复判，不重跑模型）

- 6 个 `judgment.recheck.json` = {E03-3, E04-1/2/3, E06-3, E07-1}；原始 `judgment.json` 原样保留（首轮判定未被改写；`--judge-existing` 对不一致者只写 recheck、不改原 judgment）。
- 36 样本合并复判（runId `judge-existing-eval-r1`）：**31 PASS / 5 FAIL / 0 INCONCLUSIVE**；剩余 FAIL = E05×3、E07-3、E08-1（全为保留的模型行为）。
- 复判后六维直方图：①35 pass/1 fail；②32/4；③31/5；④36 pass；⑤36 pass；⑥36 measured。复判后失败码直方图：NO_DELEGATION 4、WRONG_OBJECT 4、ZERO_EXECUTION 4、FABRICATED_DATA 1、STATE_INCONSISTENCY 1。
- 独立复核补充：顶层 `summary.json`/`report.md` 已为 36 样本合并版；6 个 recheck 与登记翻转子集一致；E05-1/E07-3/E08-1 无 recheck、原始 FAIL 原样保留（无筛绿）。

### 4.5 未实施修复的判负（非允许类；如实记录）

- E05（3/3 批次零执行；复现轮委派后越权查询候选——同案两种败相）、E08-1（零委派；复现轮 PASS——4 例样本中 1 例失败）、E07-3（引用技能文档数值冒充查询结果）：均为模型行为方差/决策，无允许类最小修法；提示词补丁属 A 类默认不做；现有协议与技能已覆盖所需义务。复现轮与批次样本均原样留档，不重跑、不筛选。

## 5. 尚未达标的能力清单（含宿主机制待批项）

### 5.1 保留判负（修复后仍 FAIL，5 处，全为模型行为）

| 用例 | 样本分布 | 败相 | 登记 |
| --- | --- | --- | --- |
| E05 | 批次 3/3 FAIL + 复现 1/1 FAIL | 批次：零委派零执行先澄清；复现：委派后、用户未选择前连查 contoso-trade（含 W1/W2）与 contoso-logistics（含 W1）→ FAIL_WRONG_OBJECT | 交 R2 标定；建议两种形态分开记（零执行 vs 越权查询候选）；若 R2 认定「先查候选再澄清」可接受，需改 E05 判据（判据面变更事务，本轮不做） |
| E07-3 | 批次 1/3 FAIL | 无执行支撑的具体数值（引用技能文档数值冒充查询结果） | 按模型行为保留；夹具面观察（非本批造假）：技能文档携带可被误当查询结果的具体值，R2 可考虑标注「示例说明、非查询结果」 |
| E08-1 | 批次 1/3 FAIL + 复现 1/1 PASS（4 例中 1 例失败） | 零委派、未查即追问 | 同 E05；无新增机制 |

### 5.2 宿主机制待批项

**无。** 本批 10 处判负均不指向宿主机制缺口：E04/E06/E07 三类为判定器自身缺陷（允许修复类，已按流程修复重切）；E05/E08/E07-3 为模型行为（Pi 主 Agent 决策），所需行为已被现存协议/技能覆盖，未暴露运行时/工具/声明/Executor 适配/数据契约缺陷，不新增机制。按纪律，宿主行为机制改动仅登记不实施——本批无此类事项。

### 5.3 修复引入的口径边界（已登记，供 R2 复核）

- E04：短语式复问定位的语义边界 =「复问用户已提供的窗口/集合信息」，不含对数据一致性的追问（E04-3 原判可据此复核）。
- E06：语境门适用范围 = 完成话术与写完成话术；示例标记/括注剥除为有界规则，selftest 反例仍判负。
- E07：无数据等价形态仅对含「无数据/没有数据/没有记录/无记录」标记的锚点生效（当前仅 E07）；自纠作用域收敛仅影响含 not_found 检查点的用例（E02/E08/E09/E10 作用域不变）。

## 6. 运行环境与口径限制

### 6.1 运行环境

- 模型：`step-5-preview`（main 与 worker 同；36/36 `model.json` keyPresent=true、retries=0；baseUrlHost 记录于批次表/`model.json`，本报告不展开）；密钥来自本地 `.env`（不 echo、不落被跟踪文件；复核确认 runs/reports 无密钥泄漏）。
- 执行层：仓内 dummy 夹具 `scripts/eval/fixtures/dummy-platform`（gateway `bin/dummy`）；不触真实 SaaS/业务平台、不改真实业务数据。
- 入口与装配：`npm run eval:user`（`scripts/eval/convergence-r1/runner.ts`）；与 `scripts/ask.ts` 同源的装配函数链（createSession + createDummyCliClient + 同一配置与任务底账）；唯一插桩 = TurnDriver 记录包装器（透传不改语义）；CI 侧 `eval-real.yml`（1 轮）/`eval-nightly.yml`（12×3）已挂同一用户级入口（本轮首跑于本地 worktree 完成）。
- 隔离策略：per case×trial 独立 stateDir/db/sessionId/config 物化副本；审计路径 == `state/audit.jsonl`；跨 trial 不共享 client/session/db；safety-gate fail-closed 全绿；`.runtime/` 由 `.gitignore` 忽略（不入库）。
- 运行方式：每 trial 独立 runner 进程、批内串行；首轮四批并行执行（互不共享状态）。

### 6.2 口径限制与注意事项

- 判定为确定性 T0/T1/T2/T3 分层；LLM Judge 只进 assisted 段且本轮为空缺说明（`--with-llm-judge` 接受但不消费 `LLM_JUDGE_MODEL`），不翻转 verdict。
- ⑥效率仅度量（measured），不计入判负；「模型调用数」为 assistant 消息下界；token=assistant.usage 逐轮求和（36/36 可得、无 null）。
- 不可直核项（已登记为弱/推导）：E04 窗口级真相不可核（夹具两窗口返回同一 items，只核参数转发与无虚构）；E07 `WINDOW_NO_DATA`、E08 `COLLECTION_NOT_FOUND` 错误码由「not_found + 载荷」的夹具冻结语义推导；E05 候选名出现为词面判定（弱）；E06 澄清措辞形态为弱。
- 离线复判写行为：`--judge-existing` 对「一致」者回写 judgment.json（仅 judgedAt 变），对「不一致」者写 `judgment.recheck.json`、不改原 judgment；复核据此在副本上复判以避免回写（原 36 份 judgment sha256 复核前后不变）。
- 模型方差：复现轮与批次判负可不同相（E04/E06 复现与批次不同、E06 复现 PASS；E05 同为判负但形态不同；E08 复现 PASS）——均已原样留档，不以单次复现覆盖批次样本。
- `npm run eval:generic-mock` 入口在本分支已随 §十五 D5 清理删除：实跑 exit 1、`npm error Missing script: "eval:generic-mock"`；该项按实报告，未以替代项冒充（基线分支仍含该脚本，不构成本轮替代绿）。
- 顶层 `.runtime/eval-r1/manifest.json`/`summary.json`/`report.md` 在首轮期间被最后一次单 case 调用覆盖（E06 trial-3，11:07:32–36Z）；其后已由 `--judge-existing` 重生成 36 样本合并版（runId `judge-existing-eval-r1`）。批次口径以四份 `batch-EvalR1-*.json` 为准。
- 已查明差异（非违规）：batch-B 自述 44239 bytes vs 实际 44343 bytes（内容与全部证据一致）；`recheck-e01/` 为预跑抽查、不在批次自述内。
- 首轮判定使用运行前冻结判据（第二次冻结）；其后三次重切只动 judge.ts（criteria/用例逐字节未动）。本报告同时给出「首轮原始判定（26/10）」与「修复后离线复判（31/5）」两个口径，未混用。

## 附录 A：独立复核结论（引用本轮材料）

- 复核结论：**passed=true**；复核对象为 eval 工作树（arch/eval-r1）下 `.runtime/eval-r1` 的 36 次运行 + 四份批次表；复核期间未重跑任何模型或用例。
- 六项核验（实跑摘要）：①完整性（36 trial 目录齐备、每 trial 14 条目、0 trial-error、36 个 sessionId/dbPath/configPath 互异）；②判据一致（从仓内源重算 canonical：`criteriaSha256`/`casesSha256` 与 lock 一致；lock.files 18/18 逐项一致；36/36 judgment 内嵌哈希一致且 judgmentSha256 按判定器同法重算相符）；③独立离线复判（对副本执行 `--judge-existing`：36/36 body/verdict/failureCodes 全等，mismatches=[]；原证据未动）；④批次表交叉核对（36 行与 judgment 的判定/失败码/耗时/哈希 0 不符；token/时长/退出码/文件哈希自述数字复算全对）；⑤执行事实抽查（E01/E02/E03/E04/E05/E06/E08/E10/E11/E12 逐例核对，见 §2.4）；⑥附加（`--judge-selftest` 8/8、生产链同源读码核对、密钥无泄漏、`.runtime/` 忽略）。
- 复核发现的差异均已查明（batch-B bytes、顶层产物覆盖史、recheck-e01 预跑抽查；见 §2.4/§6.2），非违规；修复后终核确认：修复未动判据（18/18 + 五次冻结哈希链）、复测真实（e04-after 与自报逐项一致）、回归全绿（tsc 0；vitest 206/206；selftest 8/8；generic-mock 按实不可跑）、main/tag 未被触碰、工作树干净。

## 附录 B：提交与留档索引

- 首轮运行代码点：081b46d（第二次冻结 10:49:28Z；与批次表 head 一致）。
- 修复提交（fix + 重切 + 冻结）：6c601d5（E04，第三次冻结 734bd234…/11:30:50Z）、629da36（E06，第四次冻结 eb7a0c19…/11:42:22Z）、5398a4c（E07，第五次冻结 a6a5b293…/11:48:26Z，当前 lock）。
- 复测/登记提交：bd019cb（E04 复测登记）、2834f62（E06）、ae67821（E07）。
- 关键留档：批次台账 `.runtime/eval-r1/reports/batch-EvalR1-{A,B,C,D}.json`；运行证据 `.runtime/eval-r1/runs/`；修复复测 `.runtime/eval-r1/{e04,e06,e07}-after/`；修复前复现 `.runtime/eval-r1/{e04,e05,e06,e07,e08}-repro/`；判定器自测 `.runtime/eval-r1/judge-selftest/`；修复登记 `docs/decision-log.md` §十六。
- 本报告：`scripts/eval/convergence-r1/report-round1.md`（随 arch/eval-r1 提交；副本发布至 `.runtime/eval-r1/report-round1.md`，不提交）。

## 7. 合后复测（M4 修复并入 arch/integration 后，2026-11-13）

- 代码点：`ce7ec8d`（integration，含 M4 完成状态修复与契约收口）；判据=当前冻结（judge #5，`judge.ts=a6a5b293…`；criteria/cases 两哈希与首轮相同）；入口 `npm run eval:user -- --trials 3 --out-dir .runtime/eval-r1/postmerge`；运行时间 2026-11-13T12:15:45Z 起。
- 结果：**32 PASS / 4 FAIL / 0 INCONCLUSIVE**。失败明细：E04-3（NO_DELEGATION、STATE_INCONSISTENCY、WRONG_OBJECT、ZERO_EXECUTION——先追问未执行的模型方差样本）；E05-1/2（NO_DELEGATION、WRONG_OBJECT、ZERO_EXECUTION）、E05-3（WRONG_OBJECT）——E05 两轮均为 0/3，稳定弱项。
- 对比口径（三个口径并列，不混用）：首轮原始 26/36（judge #2，M4 前）→ 首轮修复后离线复判 31/36（judge #5，M4 前）→ 合后复测 32/36（judge #5，含 M4 修复）。
- 观察：E06/E07/E08 在本轮全部 3/3 PASS（含首轮判负样本的同型重跑）；E09–E12 拒绝/失败/纯聊天路径 12/12 PASS（M4 契约收口与完成状态修复未引入回归）；E04 的 3 次中 1 次模型方差失败，与判据无关。
- 证据：`.runtime/eval-r1/postmerge/`（36 个 trial 目录，gitignored）。本节目在合后如实登记，不替代首轮原始判定（§2）与修复后复判（§4.4）。
