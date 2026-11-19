# 运营告警（ops/alerts）

> 状态：现行。用户侧已改「静默到有结果」——出事必须我方自己看得见，本页是这套告警的口径与操作面。
> 最后核对：2026-11-20（`path:line` 以现行代码为准；规则/阈值单源在 `packages/agent/src/alert-rules.ts`）。
> 上游指针：`packages/agent/src/alert-rules.ts:49`（阈值常量）、`packages/agent/src/alert-rules.ts:431`（判定+冷却入口）、`packages/agent/src/alert-persistence.ts:1`（共享投影/持久化）、`apps/server/inprocess-alerts.ts:1`（进程内引擎）、`scripts/ops/alerts.ts:1`（手动巡检）、`package.json`（`alerts` 入口）。

## 1. 两个执行者、干什么、不干什么

告警有**两个执行者**，共用**同一套规则 / 同一份 jsonl / 同一个冷却文件**：

- **进程内告警引擎**（`apps/server/inprocess-alerts.ts`）——**产品运行时里的执行者**。server 产出结构化事件时
  **就地判**（不读自己的日志），聚合规则挂低频扫描（5 分钟，`SCAN_INTERVAL_MS` 模块常量，不加配置键）。
  命中后追加 `.runtime/ops/alerts.jsonl` 并通过**server 自己的投递端口**私聊推 owner。main.ts 装配时启用。
- **手动 / 离线巡检脚本**（`scripts/ops/alerts.ts`，`npm run alerts`）——进程外诊断入口：读运行日志增量 +
  只读底账，判出四类运营异常，命中后**双出口**（落盘 + 推企微）。**保留**，不删。

两者都**不是 Prometheus / metrics 端点**（owner 明确不要）。

- 脚本入口：`npm run alerts`（= `node --env-file-if-exists=.env --import tsx scripts/ops/alerts.ts`）。
- 脚本**缺省 `--dry-run`**：只打印命中，**不落盘、不推送**；加 `--run` 才落盘并推送。
- 收件人：`config/agent.yaml` 里 `enabled` 的**单聊**企微主体（`wecom:<userid>`，排除 `wecom:group:`），
  **不硬编码**（脚本 `resolveRecipients`；进程内引擎由 main.ts 取第一个 enabled 单聊主体）。
- 凭据：`WECOM_BOT_ID` / `WECOM_BOT_SECRET`，取部署配置与 `.env` 的合并结果（`effectiveDeploymentEnv`）。

**硬边界**（写进代码注释，见 `packages/agent/src/alert-persistence.ts:1`）：**绝不改任务事实、绝不重启服务、绝不写 state.db**。
state.db 一律只读打开（`openTaskStore(dbPath, { readOnly: true })`），不建库、不迁移、不触碰一行。

**两者关系**：共享同一个 `alerts.jsonl` 与冷却文件 `alerts-state.json`（同 schema）；同时跑**可能重复告警**，
共享冷却文件可减重复但**不强一致**（两个进程各自缓存冷却读回时机不同）。需要强去重时只用其中一个。

## 2. 四条规则、阈值与去重

判定是纯函数 `evaluateAlerts(facts, { now, cooldownMs, cooldownState })`
（`packages/agent/src/alert-rules.ts:422`）；事实、`now`、冷却状态都由脚本注入——不读文件、不连网、不取系统时钟。

| 规则 | 命中判据 | 严重度 | subject（去重键） | 阈值单源 |
| --- | --- | --- | --- | --- |
| `host_fault_reported` | 出现我方故障：执行失败分类 `host_fault`、协议违约（`execution_accepted_undeclared` / `EXECUTION_PROTOCOL_VIOLATION`）、确认句柄丢失（`CONFIRMATION_NOT_FOUND`）等 ≥1 | critical | `task:<id>` / `global` | `HOST_FAULT_EVENTS` / `HOST_FAULT_ERROR_CODES`（`alert-rules.ts:65`） |
| `retry_storm` | 同一任务执行事实 ≥5 条，**或**同一 `(operation, 错误码)` 在同一任务 ≥3 次——**后者只计失败类结局**（`failed` / `refused` / `unknown` / `timed_out`；`completed` / `needs_confirmation` / `accepted` / `needs_input` 的合法重复不算，无错误码时也必须有失败状态） | warning | `task:<id>` | `RETRY_STORM_TASK_FACTS=5`、`RETRY_STORM_OP_ERROR=3`（`alert-rules.ts:53`）、`FAILURE_EXECUTION_STATUSES`（`alert-rules.ts:87`） |
| `task_stuck` | 任务 `running` 超 10 分钟无事件；`waiting_user` 超 30 分钟 | warning | `task:<id>` | `TASK_RUNNING_STUCK_MS=10min`、`USER_WAITING_STUCK_MS=30min`（`alert-rules.ts:49`） |
| `delivery_failed` | 文件/结果投递失败 ≥1：`file_delivery` 状态非 `sent`、`task_result_delivery_failed`，**通知投递终局** `notification_delivery_terminal` 的 `exhausted`（失败到 attempts 上限：用户最终没收到），**长活提醒** `task_long_running_notice` 的 `failed`——终态跳过（`result=skipped`：没有东西可发/永不可能送达）**不告警**（静默部署上每条都 skipped，告警只会成噪音） | critical | `session:<id>` / `task:<id>` / `global` | `isDeliveryFailure`（`alert-rules.ts:238`） |

**边界口径**：`task_stuck` 用**严格大于**——**刚好 10 分钟不告、10 分 1 秒告**（`alert-rules.ts:358` 的 `elapsed > 阈值`）。
**去重**：同一 `(rule, subject)` 在**冷却窗口（缺省 30 分钟，`DEFAULT_COOLDOWN_MS`）内只告一次**；
冷却状态是可 JSON 序列化的纯数据，持久化在 `.runtime/ops/alerts-state.json`（键 = `rule + \u0000 + subject`）。
时间只从注入的 `now` 取（同输入 + 同 now ⇒ 同输出）。

**四类事实的来源**：
- **事件驱动就地判**（进程内引擎，`apps/server/inprocess-alerts.ts` 的 `observe`）：server 产出的结构化事件
  （经 `log` 出口喂入）即时投影成 AlertFact，**不读自己的日志**。覆盖
  `host_fault` / `execution_accepted_undeclared` / `task_long_task_unsupported`（host_fault 规则）与
  `task_result_delivery_failed` / `notification_delivery_terminal`(result=exhausted) /
  `task_long_running_notice`(result=failed) / `file_delivery`(status 非 sent)（delivery_failed 规则）。
- **聚合低频扫描**（进程内引擎的 `scanNow`，5 分钟一跳，单 `setTimeout` 链，`SCAN_INTERVAL_MS` 模块常量）：
  只读底账投影出 `task_state`（running / waiting_user，带 `running_since` / `waiting_since`）与
  `execution`（每次执行一行，带 `operation` / `error.code` / `status`）事实，判 `task_stuck` / `retry_storm`。
- **进程外手动脚本**（`npm run alerts`）：读日志增量（同上事件名）+ 只读底账（同上 fact 形状），
  离线补判全部四类。投影函数单源在 `packages/agent/src/alert-persistence.ts` 的 `logLineToFact` / `ledgerFacts`。

## 3. 双出口怎么落

命中一条告警后（落盘与推送单源在 `packages/agent/src/alert-persistence.ts` 的 `evaluateAndPersistAlerts`）：

1. **落盘**：追加到 `.runtime/ops/alerts.jsonl`，每行一条**自包含 v:1 JSON**（见 §3.1）。
   同一 `.runtime/` 已 gitignore，属运行产物，永不 `git add`。
2. **推 owner**：
   - 进程内引擎：通过 **server 自己的投递端口**（`fileDelivery.sendText`，**同一条 WS**，不另开企微
     WS——单 WS 约束）私聊推给 owner；main.ts 从 `config/agent.yaml` 取第一个 enabled 单聊主体做路由。
   - 手动脚本：经 SDK `sendMessage`（`--run` 才推）推给 owner。
   **推送失败只记一条 `alert_push_failed`，不影响落盘**（失败是独立观测事件，已落盘的事实不因推送失败被改写）。

**增量与状态**：冷却表存 `.runtime/ops/alerts-state.json`（30 分钟 `(rule, subject)`，重启不重发）；
进程内引擎每次判定从文件读回冷却（持久化生效）；手动脚本另有日志字节偏移 `logOffset`（同一文件同 schema）。
手动脚本半行不消费（只读到最后一个完整换行），文件轮转（`size < offset`）时从头再读。

### 3.1 落盘行格式（v:1，为回溯与 AI 分析服务）

`.runtime/ops/alerts.jsonl` 每行是**自包含**结构化 JSON，`v:1` 是 schema 版本。字段：

| 字段 | 含义 |
| --- | --- |
| `v` | schema 版本，恒 `1` |
| `id` | 唯一 id：`<毫秒时间戳>-<序号>-<来源>-<rule>`（来源 `server` / `server-scan` / 脚本为 `<rule>`） |
| `rule` | 规则身份（四条之一） |
| `severity` | `critical` / `warning` / `info` |
| `subject` | 去重键（task/session/global） |
| `evidenceRef` | 回溯键（task/msg/log/event 派生） |
| `summary` | 人读摘要 |
| `raw` | **被命中的原始文本全文，不截断**（嵌套 JSON 已转义） |
| `at` | 判定时刻（ISO） |
| `taskId` | 任务归属（有则带，供结构化消费） |
| `evidencePath` | 仅当 raw 超长时出现，指向 `.runtime/ops/evidence/<id>.txt` |

一行**真实**（进程内引擎注入 host_fault 事件产出）：

```json
{"v":1,"rule":"host_fault_reported","severity":"critical","subject":"task:task-doc-demo","evidenceRef":"task:task-doc-demo","summary":"我方故障（host_fault），归属 task:task-doc-demo","raw":"{\"event\":\"host_fault\",\"taskId\":\"task-doc-demo\",\"failureKind\":\"host_fault\",\"message\":\"我方执行层装配缺陷\"}","at":"2026-11-20T09:00:00.000Z","taskId":"task-doc-demo","id":"1795165200000-0-server-host_fault_reported"}
```

后续 AI / 人消费：逐行 `JSON.parse`，按 `v` 判版本，凭 `evidenceRef` + `raw` 回到原始现场；超长 raw 走
`evidencePath` 指向的 UTF-8 原文文件（`raw` 字段仍保留全文）。

## 4. 不变量：原始文本必须可回溯

**告警只带摘要，但每条告警必须能凭一个键回到当时的原始文本**（原始错误、原始日志行、原始载荷、原始回复）。

- 每条落盘行都带 `evidenceRef`——`messageId` / `taskId` / 日志字节偏移 / 事件 id（`alert-rules.ts` 的
  `evidenceRefOf`：显式键优先，否则按 `task:` → `msg:` → `log@<偏移>` → `event:` 派生）。
- 每条告警项都带 **`raw`——被命中的原始文本，不截断**（`alert-rules.ts:272` 起各候选只搬运原文，绝不裁剪）。
- **既有日志里的原文不许因为「对用户收口」而被删**：日志原文是回溯链的末端，一旦删除，`evidenceRef`
  就指向空气。对用户收口只收敛**面向上游用户的措辞**，不删**面向运维证据**的原文。

**证据文件格式**（原文超长时，`packages/agent/src/alert-persistence.ts` 的 `buildAlertLine`）：
- 内联上限 `EVIDENCE_INLINE_LIMIT_BYTES = 8192` 字节；`raw` 不超过上限时**整条内联**在 `alerts.jsonl` 行里；
- 超过上限时，全文另落 `.runtime/ops/evidence/<id>.txt`（**UTF-8、逐字原文，不截断**），
  落盘行里给 `evidencePath` 指向它——但 **`raw` 字段仍保留全文**（证明链不断）；
- `<id>` 与 `alerts.jsonl` 行里的 `id` 一致（进程内引擎为 `<毫秒时间戳>-<序号>-server[-scan]-<rule>`）。

## 5. 真跑前置

- **进程内引擎随 server 自动运行**（main.ts 装配 `inprocessAlerts.enabled:true`），无需调度：
  事件驱动即时判 + 聚合扫描 5 分钟一跳。owner 路由取配置里第一个 enabled 单聊企微主体；
  没有单聊主体时只落盘不推。
- **手动脚本** `--run` 推送到真实企微需要：
  - `config/agent.yaml` 里有**已启用的单聊主体**（`principals: {"wecom:<userid>": {enabled: true, ...}}`）
    作为收件人；缺配置时脚本只记 `alerts_config_missing` 并对空收件人推送（判失败，不静默发送）。
  - `WECOM_BOT_ID` / `WECOM_BOT_SECRET`（`.env` 或 `config/agent.yaml` 的 `wecom.*`）；
  - 有当日底账 `.runtime/state.db`（可缺省——不存在时只按日志判，记一条 `alerts_ledger_note` 跳过底账）。
  - 巡检节奏由部署侧调度（cron 等）；`--dry-run` 是唯一无副作用形态，建议先空跑核对。
- **红线沿用**：两者都绝不改任务事实、绝不写 state.db、绝不重启服务。
