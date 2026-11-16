# SimCase 机制预注册（薄机制，冻结口径）

> 位置纪律：SimCase 只住在 `scripts/eval/sim/`；不改产品码、不给宿主加机制、不建「模拟用户平台」
> （不引框架、不建服务、不加数据库）。复用现有资产：`scripts/ask-runtime.ts`（生产同源装配）、
> `scripts/eval/fixtures/dummy-platform`（仓内 dummy 执行层）、`scripts/eval/business-e2e/batch.ts`
> （并发池 + 硬上限登记）、`scripts/eval/business-e2e/collect.ts`（证据/manifest sha256 纪律）、
> `scripts/eval/r6/oracle.ts`（事实真值机械判定）、`scripts/eval/r6/accounting.ts`（分类记账语义）。

## 冻结参数

| 项 | 值 | 说明 |
| --- | --- | --- |
| 样本级并发度 | **5**（`SIM_DEFAULT_CONCURRENCY`） | 上限由 `batch.ts` 的 `HARD_LIMIT_REGISTRY.evalBatchConcurrency.max=8` 熔断 |
| 每 trial 目录 | `<outRoot>/<caseId>/<trial>/{session,state.db,evidence}` | 并发 ≥2 时由 `assertTrialIsolation` 断言互不共享 |
| 预算缺省 | `maxUserTurns=8` / `maxWaitTurns=2` / `maxWallMs=300000` / `trials=1` | 用例可覆盖；`wait` 超过上限即 `budget_exhausted` |
| 终态 | `satisfied` / `gave_up` / `budget_exhausted` / `contaminated` / `protocol_error` | 五类**分开记**；`terminal=null` 只表示 Harness/用例卫生缺陷，永不 pass |
| 协议修复 | 首答非法动作 → 最多 **2 次修复重问**（`SIM_PROTOCOL_REPAIRS`，每次计入 `kind: simulator`） | 原始输出逐条留证；仍非法 → `protocol_error`（`pass=false`，不计入 gave_up / satisfied） |
| 通过判据 | `satisfied` **且** Oracle 判真值通过 | `gave_up` / `protocol_error` 永不算通过 |
| 污染判据 | 用户消息（含 `initialMessage`）命中 `forbiddenKnowledge` 或 Oracle 真值模式 | 命中 → `contaminated`（作废，不计通过），证据保留原文与命中项 |
| 注入锚点 | `systemTurn` / `toolCall` / `event` 的第 `at` 个位置 | 只绑确定性计数，**不挂墙钟**；证据记 planned/applied |
| 记账 | `kind: simulator` / `kind: judge` / 系统 `main|summary|retry|overflow_recovery` | 分类别计数与 token 总计；不可得类别标注 `unobservedKinds`，不补零 |

## 不变量

1. 模拟用户**知道业务目标但不知道正确答案**；`fixtureId`/`oracleId`/真值/禁知不得出现在**用例字段构造的
   prompt 段落**，`fixtureId`/`oracleId`/非真值禁知不得出现在整段 prompt
   （`findCaseLeaks` 先验 + `findPromptLeaks` 逐轮守卫，命中即拒绝；见 `simulator.ts`）。
   系统**用户可见回复**里出现答案属正常（模拟用户本来就看得见），用户复述真值由运行时污染检测作废。
2. 模拟用户每轮只能输出 `say(text)` / `wait(reason)` / `finish(finishKind, reason)`；
   非法动作先做最多 2 次修复重问（明确要求「只输出 JSON 动作，不要解释」），仍非法记
   `protocol_error`（`pass=false`），不冒充 gave_up / satisfied；`terminal=null` 只留给用例卫生/
   prompt 泄漏等 Harness 缺陷。
3. 只有用户可见的上一轮回复进入模拟用户视角；工具结果内部字段、日志、Oracle 一律不可见。
4. 并发池以样本（case × trial）为单位；每 trial 独立 `sessionDir` / `state.db` / 证据目录。
5. 429/限流不自动重试掩盖：样本照常记录，失败样本保留（不筛绿）。

## 机制自检（零真实模型）

命令（仓库根；退出码 0 = 七项全过，1 = 至少一项失败）：

```sh
TMPDIR=/tmp/sim-eval-tmp node --import tsx scripts/eval/sim/selftest.ts
```

被测系统 / 模拟用户 / 判官全部是 `./fakes` 里的确定性假件，不读 `LLM_API_KEY`、不触网。
七项自检与对应的回归用例：

| # | 自检 | 断言 | 回归用例 |
| --- | --- | --- | --- |
| 1 | 模拟用户说出真值 | `contaminated` + `pass=false` + `oracle=null`，该条不发给系统 | `run.test.ts`「模拟用户中途说出真值」 |
| 2 | 提前放弃 | `gave_up` + `pass=false`（同一正确回复下 `satisfied` 会 `pass=true` 作对照） | `run.test.ts`「gave_up 永不算通过」 |
| 3 | 无限追问 | 到 `maxUserTurns` 停：`budget_exhausted(user_turns)`，询问次数 = `maxUserTurns-1` | `run.test.ts`「永不收尾的模拟用户」 |
| 4 | 注入锚点 | `systemTurn@2` / `toolCall@3` 按计数命中并记 `appliedTurn`；未实现如实 `applied=false` | `run.test.ts`「注入锚点」四条 |
| 5 | 并发隔离 | `concurrency=5` 跑 5 条：`observedMaxConcurrency=5`，session/state.db/evidence 5/5/5 唯一 | `run.test.ts`「并发 5 · 5 条假会话」 |
| 6 | 记账分离 | simulator / judge / main / summary 各自 calls 与 tokens 独立，总计 = 分项和 | `run.test.ts`「记账」三条 |
| 7 | 轨迹分叉 | 同一用例三个 persona：三条轨迹两两不同，且首轮 prompt 去掉人设/规则后三份逐字相同 | `divergence.test.ts` |

反向绊线（2026-11-16 实测）：把 `contaminated` 分支改成 `pass:true`、把 `gave_up` 分支改成 `pass:true`、
把 `simTrialPaths.sessionDir` 改成共享目录，自检分别在第 1/2/5 项 FAIL（退出码 1）；
恢复后 7/7 PASS。自检不是装饰——破坏机制必须变红。

