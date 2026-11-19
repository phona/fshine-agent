# 运营告警（ops/alerts）

> 状态：现行。用户侧已改「静默到有结果」——出事必须我方自己看得见，本页是这套告警的口径与操作面。
> 最后核对：2026-11-19（`path:line` 以现行代码为准；规则/阈值单源在 `packages/agent/src/alert-rules.ts`）。
> 上游指针：`packages/agent/src/alert-rules.ts:49`（阈值常量）、`packages/agent/src/alert-rules.ts:422`（判定+冷却入口）、`scripts/ops/alerts.ts:340`（巡检主流程）、`package.json`（`alerts` 入口）。

## 1. 干什么、不干什么

一个**仓内 ops 脚本**：读运行日志与任务底账，判出四类运营异常，命中后**双出口**（落盘 + 推企微）。
它**不进产品运行时**（`apps/server/*` 不引用它），也**不是 Prometheus / metrics 端点**（owner 明确不要）。

- 入口：`npm run alerts`（= `node --env-file-if-exists=.env --import tsx scripts/ops/alerts.ts`）。
- **缺省 `--dry-run`**：只打印命中，**不落盘、不推送**；加 `--run` 才落盘并推送。
- 收件人：`config/agent.yaml` 里 `enabled` 的**单聊**企微主体（`wecom:<userid>`，排除 `wecom:group:`），
  **不硬编码**（`scripts/ops/alerts.ts:260`）。
- 凭据：`WECOM_BOT_ID` / `WECOM_BOT_SECRET`，取部署配置与 `.env` 的合并结果（`effectiveDeploymentEnv`）。

**硬边界**（写进代码注释，见 `scripts/ops/alerts.ts:1`）：**绝不改任务事实、绝不重启服务、绝不写 state.db**。
state.db 一律只读打开（`openTaskStore(dbPath, { readOnly: true })`），不建库、不迁移、不触碰一行。

## 2. 四条规则、阈值与去重

判定是纯函数 `evaluateAlerts(facts, { now, cooldownMs, cooldownState })`
（`packages/agent/src/alert-rules.ts:422`）；事实、`now`、冷却状态都由脚本注入——不读文件、不连网、不取系统时钟。

| 规则 | 命中判据 | 严重度 | subject（去重键） | 阈值单源 |
| --- | --- | --- | --- | --- |
| `host_fault_reported` | 出现我方故障：执行失败分类 `host_fault`、协议违约（`execution_accepted_undeclared` / `EXECUTION_PROTOCOL_VIOLATION`）、确认句柄丢失（`CONFIRMATION_NOT_FOUND`）等 ≥1 | critical | `task:<id>` / `global` | `HOST_FAULT_EVENTS` / `HOST_FAULT_ERROR_CODES`（`alert-rules.ts:65`） |
| `retry_storm` | 同一任务执行事实 ≥5 条，**或**同一 `(operation, 错误码)` 在同一任务 ≥3 次——**后者只计失败类结局**（`failed` / `refused` / `unknown` / `timed_out`；`completed` / `needs_confirmation` / `accepted` / `needs_input` 的合法重复不算，无错误码时也必须有失败状态） | warning | `task:<id>` | `RETRY_STORM_TASK_FACTS=5`、`RETRY_STORM_OP_ERROR=3`（`alert-rules.ts:53`）、`FAILURE_EXECUTION_STATUSES`（`alert-rules.ts:87`） |
| `task_stuck` | 任务 `running` 超 10 分钟无事件；`waiting_user` 超 30 分钟 | warning | `task:<id>` | `TASK_RUNNING_STUCK_MS=10min`、`USER_WAITING_STUCK_MS=30min`（`alert-rules.ts:49`） |
| `delivery_failed` | 文件/结果投递失败 ≥1：`file_delivery` 状态非 `sent`、`task_result_delivery_failed`，**通知投递终局** `notification_delivery_terminal` 的 `exhausted`（失败到 attempts 上限：用户最终没收到），**长活提醒** `task_long_running_notice` 的 `failed`——终态跳过（`result=skipped`）**按部署模式切**（owner 2026-11-19）：`deliveryMode=live` 的 skipped **告警**（渠道配置/路由配错，用户彻底收不到任何消息）；`silent` / `unavailable` 的 skipped 是部署属性，**不告警** | critical | `session:<id>` / `task:<id>` / `global` | `isDeliveryFailure`（`alert-rules.ts:238`） |

**边界口径**：`task_stuck` 用**严格大于**——**刚好 10 分钟不告、10 分 1 秒告**（`alert-rules.ts:358` 的 `elapsed > 阈值`）。
**去重**：同一 `(rule, subject)` 在**冷却窗口（缺省 30 分钟，`DEFAULT_COOLDOWN_MS`）内只告一次**；
冷却状态是可 JSON 序列化的纯数据，持久化在 `.runtime/ops/alerts-state.json`（键 = `rule + \u0000 + subject`）。
时间只从注入的 `now` 取（同输入 + 同 now ⇒ 同输出）。

**四类事实的来源**（`scripts/ops/alerts.ts:113` / `:199`）：
- 日志行（`.runtime/server/wecom-live.log`）：投影成 `file_delivery` / `task_result_delivery_failed` /
  `notification_delivery_terminal`（通知投递终局：`result=exhausted|skipped` + `deliveryMode`，2026-11-19 接线）/
  `task_long_running_notice`（长活提醒投递：`result=sent|failed`）/ `execution_accepted_undeclared` 等事实；
- 底账行（`state.db`，只读）：`task_state`（running / waiting_user，带 `running_since` / `waiting_since`）
  与 `execution`（每次执行一行，带 `operation` / `error.code`）事实。

## 3. 双出口怎么落

命中一条告警后（`scripts/ops/alerts.ts:340` 之后）：

1. **落盘**（`--run` 才写，`scripts/ops/alerts.ts:320`）：追加到 `.runtime/ops/alerts.jsonl`，
   每行一条 JSON = 告警项 + `id`。同一 `.runtime/` 已 gitignore，属运行产物，永不 `git add`。
2. **推企微**（`--run` 才推，`scripts/ops/alerts.ts:278`）：经 SDK `sendMessage`（宿主 sendText 同一通道）
   把「规则 + 摘要 + 证据键」发到 owner 账号。**推送失败只记一条 `alert_push_failed`，不影响落盘**
   （失败是独立观测事件，已落盘的事实不因推送失败被改写）。

**增量与状态**：日志按**字节偏移**续读（`scanLog`，`scripts/ops/alerts.ts:162`）；偏移与冷却表一起
存 `.runtime/ops/alerts-state.json`。**半行不消费**（只读到最后一个完整换行），避免读到写一半的行；
文件被截断/轮转（`size < offset`）时从头再读，避免永久漏读。

## 4. 不变量：原始文本必须可回溯

**告警只带摘要，但每条告警必须能凭一个键回到当时的原始文本**（原始错误、原始日志行、原始载荷、原始回复）。

- 每条落盘行都带 `evidenceRef`——`messageId` / `taskId` / 日志字节偏移 / 事件 id（`alert-rules.ts` 的
  `evidenceRefOf`：显式键优先，否则按 `task:` → `msg:` → `log@<偏移>` → `event:` 派生）。
- 每条告警项都带 **`raw`——被命中的原始文本，不截断**（`alert-rules.ts:272` 起各候选只搬运原文，绝不裁剪）。
- **既有日志里的原文不许因为「对用户收口」而被删**：日志原文是回溯链的末端，一旦删除，`evidenceRef`
  就指向空气。对用户收口只收敛**面向上游用户的措辞**，不删**面向运维证据**的原文。

**证据文件格式**（原文超长时，`scripts/ops/alerts.ts:320`）：
- 内联上限 `EVIDENCE_INLINE_LIMIT_BYTES = 8192` 字节；`raw` 不超过上限时**整条内联**在 `alerts.jsonl` 行里；
- 超过上限时，全文另落 `.runtime/ops/evidence/<id>.txt`（**UTF-8、逐字原文，不截断**），
  落盘行里给 `evidencePath` 指向它——但 **`raw` 字段仍保留全文**（证明链不断）；
- `<id>` = `<毫秒时间戳>-<序号>-<rule>`，与 `alerts.jsonl` 行里的 `id` 一致。

## 5. 真跑前置

`--run` 推送到真实企微需要：
- `config/agent.yaml` 里有**已启用的单聊主体**（`principals: {"wecom:<userid>": {enabled: true, ...}}`）
  作为收件人；缺配置时脚本只记 `alerts_config_missing` 并对空收件人推送（判失败，不静默发送）。
- `WECOM_BOT_ID` / `WECOM_BOT_SECRET`（`.env` 或 `config/agent.yaml` 的 `wecom.*`）；
- 有当日底账 `.runtime/state.db`（可缺省——不存在时只按日志判，记一条 `alerts_ledger_note` 跳过底账）。
- 巡检节奏由部署侧调度（cron 等），本仓不内置定时器；`--dry-run` 是唯一无副作用形态，建议先空跑核对。
