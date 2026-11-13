# convergence-r1 用户级黑盒评测（真实模型走 .env；执行层一律仓内 dummy 夹具）

12 条用户级用例（E01–E12），跑的是**生产同一路径**：与 `scripts/ask.ts` 同源的装配函数链
（`materializeEvalConfig → loadConfig → effectiveDeploymentEnv → safety-gate → createDummyCliClient
→ readOnlyOperationNames → createSqliteTaskRegistry(per-case db) → loadWorkerSkills → loadAgentProfile
→ createSession(真实 createPiTurnDriver ×2)`）。唯一允许的插桩是 TurnDriver 记录包装器（透传不改语义）。

## 运行入口（CLI 契约，逐字）

```bash
npm run eval:user -- [--case C01] [--trial 1] [--trials 1] [--out-dir <dir>] [--judge-existing <run-dir>]
```

| 参数 | 语义 |
| --- | --- |
| `--case <id\|all>` | 选择用例：E01–E12（逗号分隔；`C01` 形态同义）；缺省 `all`（12 例） |
| `--trial <n>` | 只跑第 n 次（1 起） |
| `--trials <n>` | 每个用例的轮数；缺省 1。nightly 用 `--trials 3`（12×3，全样本保留） |
| `--out-dir <dir>` | 输出根目录；缺省 `.runtime/eval-r1` |
| `--judge-existing <dir>` | 离线复判：只读该 run-dir 内冻结副本与证据，不跑模型、不读仓内可变文件、不触网；同输入 → 同 judgment |
| `--judge-selftest` | 判定器自测：三类反例证据包 + 区分矩阵（不跑模型），写 `<out-dir>/judge-selftest/` |
| `--with-llm-judge` | 接受但本轮不消费 `LLM_JUDGE_MODEL`（判据无 judge 面，接口冻结项 d；assisted 留空缺说明） |

别名：`--cases`（同 `--case`）、`--out`（同 `--out-dir`）。

**退出码**：`0`=全部 trial 判定完成且无 FAIL；`1`=存在 FAIL；`2`=infra/INCONCLUSIVE（证据缺失、哈希不符、隔离违反）。

默认输出与逐样本目录：

```
.runtime/eval-r1/
  manifest.json                 # runId/git/node/model/judge/criteriaSha256/casesSha256/isolation
  criteria/criteria.json       # 冻结判据副本（判官自包含复判来源）
  criteria/cases.json          # 冻结用例副本（12 例输入语料 + 期望事实）
  runs/E01/trial-1/            # 每 case×trial 独立目录（审计 B【4】schema；本入口以 <out>/<case>/trial-<n> 直落）
  summary.json                  # 12×3 矩阵、逐维分布、失败码直方图
  report.md                     # 全样本报告（不筛绿、失败原样）
```

## 每 trial 证据 schema（runs/<case>/trial-<n>/）

| 文件 | 内容 |
| --- | --- |
| `inputs.json` | caseId/trial/principalId/sessionId/turns(sha256)/configPath/profileRoot/gateway/dbPath |
| `model.json` | 本 trial 生效模型/来源/思考档/重试次数（不含密钥） |
| `toolcalls.jsonl` | T2：轮、agent(main\|worker)、seq、tool、args、result、resultSummary、isError、耗时（驱动包装器透传观测） |
| `transcript.main.json` | 每轮 Main 转录快照（含 usage）。`transcript.worker.jsonl` = Worker 逐次委派转录（P3） |
| `audit.jsonl` | T0：执行层审计字节副本（`state/audit.jsonl`） |
| `audit.index.json` | 每轮 fromLine/toLine/sha256、structuredRows/refusedRows |
| `executions.json` | T1 全量导出：tasks + executions 原样 |
| `reply.jsonl` | 每轮回复文本与 sha256 |
| `judgment.json` | 判定结果（见下） |
| `meta.json` | 每轮 durationMs、模型调用数（assistant 消息下界）、重试、token（assistant.usage；缺=null+原因） |
| `state/` | 原始 dummy-state/plans/proposals 快照 |
| `db/state.db` | 任务底账原文件 |

隔离硬要求：per case×trial 独立 stateDir/db/sessionId；config 物化副本内 root 绝对、store.dbPath 指入本 case 目录；
审计路径 == `state/audit.jsonl`；跨 trial 不共享 client/session/db。

## 判定（确定性；LLM Judge 只进 assisted，不翻转 verdict）

- T0=审计（执行真值）、T1=底账、T2=工具调用/参数、T3=回复。T3 的事实宣称必须被 T0/T1 支撑；
  T3 与 T0/T1 矛盾=判负；T0 缺失而 T3 宣称成功=虚构成功；必需证据缺失=INCONCLUSIVE，不得判正。
- 六维：①用户级完成 ②执行真实性 ③数据正确性 ④任务状态一致性 ⑤用户干预 ⑥效率（仅度量）。
- 失败类别（冻结）：`FAIL_NO_DELEGATION` / `FAIL_ZERO_EXECUTION` / `FAIL_WRONG_OBJECT` /
  `FAIL_PHANTOM_SUCCESS` / `FAIL_FABRICATED_DATA` / `FAIL_NEEDLESS_CLARIFICATION` /
  `FAIL_MISSING_EXECUTION_FACTS` / `FAIL_STATE_INCONSISTENCY` / `FAIL_UNNECESSARY_DELEGATION` / `INCONCLUSIVE_JUDGE`。
- `judgment.json = {caseId,trial,criteriaSha256,casesSha256,judgeVersion,deterministic{verdict,failureCodes[],dimensions{①..⑥}},
  weakNotices[],assisted{},evidenceRefs[{path,line|row,what}],inconclusiveReasons[],judgedAt,judgmentSha256}`；
  `judgmentSha256` 排除 `judgedAt`——离线复判同输入必须同哈希。

## 冻结与纪律

- 判据 = `criteria.ts` + `cases/E01..E12.ts` + `judge.ts` 等（`freeze.ts` 的 sha256 清单写入 `criteria.lock`）；
  冻结后不得修改，不得因失败放宽；零执行不得判成功（required 例）；免查例不得强制委派；全样本保留。
- 未冻结（`criteria.lock` 不存在）仅允许 smoke/首轮；有 lock 时 runner 校验 `criteriaSha256`/`casesSha256`，不一致拒绝运行（fail-closed）。
- 重新冻结：`node --import tsx scripts/eval/convergence-r1/freeze.ts`（只在确实需要且经允许时使用；冻结后改判据=违规）。

## 与 workflow 的关系

- `eval-real.yml`（per-push，advisory 非阻断）：`npm run eval:user -- --trials 1`；
- `eval-nightly.yml`（schedule）：`npm run eval:user -- --trials 3`；
- 真实模型密钥走 `LLM_API_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（本地 `.env`，CI secrets）；不消费 `LLM_JUDGE_MODEL`。
