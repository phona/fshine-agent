# fshine-agent 手工测试手册（R4 · 2026-11-14）

> 授权：owner 2026-11-14（1+2）。本手册**只测功能**：真机功能走查、交付物可读性、新功能验收、体验。
> 它不是第二套回归——**自动化已兜的部分不要手工重测**（见 §2）。手工证据不替代自动化门，也不产「稳定/达标」结论。
> 基线：`arch/integration @ 885ac638f2353be41e651f1ea3eb9199d905017b`；分支 `arch/r4-stab`；配对报告 `docs/product/r4-stability-report.md`、预注册 `docs/product/r4-stability-prereg.md`。

## 1. 手工测试的定位与硬边界

手工只回答自动化回答不了的问题：**真机上人看到什么、读得懂吗、愿不愿意用**。

- 不接真实平台/真实渠道；执行层用仓内 dummy 夹具；通知用假 sink（`docs/product/r4-stability-report.md` §blocked 已登记真实渠道未实现/未连接）。
- 不写真实凭据进文档/截图；不做写操作。
- 发现真实产品缺陷：**只登记**（写入报告或缺陷登记表），不在测试 Run 里改产品。
- 手工结论只标「通过 / 不通过 / 存疑（附原文）」，**不写「稳定」「100%」「已达标」**。

## 2. 不要重测自动化已兜部分

自动化已覆盖以下内容，手工**跳过**，不要重复执行（只作抽查确认入口可用）：

| 自动化面 | 命令 | 覆盖 |
| --- | --- | --- |
| 确定性全量门 | `npm test`（`TMPDIR=~/.tmp npm test`） | 58 文件 / 603 例：状态机、取消、故障注入（6 类）、联合接口、通知、展示词表等 |
| 类型门 | `TMPDIR=~/.tmp npx tsc --noEmit` | 全仓类型 |
| 故障注入（明确例） | `npx vitest run scripts/p7b-fault-injection.test.ts` | 模型超时 / Worker 崩溃 / 通知失败 / 重复消息幂等 / 池满拒绝 / 重启三态 |
| 浸泡/压力/混沌 | 见 §4 | 积压 500、池满持续、重启×通知失败×重复×取消（无重复副作用/无挂死/队列归零/未送达=0/RSS<10%） |
| 用户级黑盒 | `npm run eval:user -- --case E06 --trials 1` | 真实模型 + dummy（消耗 token；手工验收一般不需要） |

## 3. 环境准备

1. `.env`（gitignored）内 `LLM_API_KEY` / `LLM_API_BASE_URL` / `LLM_MODEL` 就绪；本手册的运行不打印密钥。
2. 在仓库根（worktree）执行；执行层自动用仓内 dummy（无需外部平台）。
3. 需要真实模型的走查用 `LLM_MODEL=step-3.7-flash` 显式指定，并在记录里标注模型。

## 4. 一条命令跑浸泡/压力（+ 证据去哪看）

```bash
# 浸泡 + 压力（假 executor/sink/渠道/时钟；确定性、不触网、不耗 token）
TMPDIR=~/.tmp npx vitest run scripts/stab/soak.test.ts scripts/stab/pressure.test.ts

# 混沌（重启×通知失败×重复消息×取消）——需要时单独跑
TMPDIR=~/.tmp npx vitest run scripts/stab/chaos.test.ts

# 重新生成逐场景读数（终态计数/未送达/队列深度/RSS 等）
TMPDIR=~/.tmp npx tsx .runtime/stab/probe-readings.ts
```

- 结果：命令 stdout 的 `Test Files / Tests` 行为准（`3 passed` = 通过）。
- 证据目录：`.runtime/stab/`（gitignored）——
  - `readings.json`：逐场景读数（S1/S2/P1–P3/C1–C4）；
  - `green-*.txt` / `red-*.txt`：套件与全量的绿/红输出；
  - `tripwire-summary.md`：反向绊线（4 类）红后复原记录；
  - `e05/ e06/ background-e2e/`：用户级黑盒批次样本；
  - `batch-summary.md`：批次 k/N + Wilson 95% CI 汇总。
- 说明：浸泡/压力以确定性阈值判定（预注册 `docs/product/r4-stability-prereg.md` §四）；命中阈值 = 套件红，按停止规则留证、不重跑刷绿。

## 5. 真机功能走查清单（人工执行）

按顺序走一遍主链，每步记录「实际现象 + 是否可读 + 是否省心」：

1. **启动**：`npm start`（渠道面）或 `npm run ask -- "帮我查一下 documents 集合在 W202611 窗口的数据。"` 能起来、无异常退出。
2. **交办与受理**：发一条交办；受理回执是否给出**数字任务号**与业务名（措辞质量人工判断，自动化只做形态观测）。
3. **进展通知**：受理/开始/完成（或失败/取消/超时/资源受限）各阶段是否可感知、措辞是否符合业务语言。
4. **结果找回**：`npm run tasks -- "#<编号>"`（真实 CLI 入口）能否找回最终回复与「通知投递」段。
5. **失败如实**：制造一次执行层拒绝/失败，确认回复不冒充成功、失败原因可见。
6. **取消**：对运行中任务发起取消，确认最终是「已取消」而非停留在「取消中」。
7. **重启恢复**：后台有排队/在飞任务时重启进程，确认已完成不重跑、排队重领、结果未知如实标注。
8. **越权/权限**：未开通账号被拒（如渠道面）；跨会话不可见他人任务。

> 第 2/3/5/6/7 条的**机械事实**已由自动化兜住（§2）；人工只判断**措辞与可用性体验**。

## 6. 交付物可读性检查

- 受理回执：是否含任务号/业务名；是否用业务语言而非协议术语。
- 通知文案：阶段词是否清晰（已受理/已开始/已完成/失败/已取消/已超时/资源受限）。
- `tasks` 详情 / ops 页面：状态词、原因行、执行步骤、结果正文是否一致、无内部路径/凭据/百分比编造。
- 记录：把原文贴进记录（不改写），可读性结论标注「通过/不通过/存疑」。

## 7. 新功能验收（每切片模板）

| 项 | 内容 |
| --- | --- |
| 切片 | 名称 + 报告指针 |
| 入口 | 精确命令 / 渠道操作 |
| 前置 | 配置、模型、夹具 |
| 步骤 | 逐条可复现 |
| 预期 | 用户可见现象（非内部状态） |
| 实际 | 现象原文 + 截图/输出路径 |
| 判定 | 通过 / 不通过 / 存疑（附原文） |
| 登记 | 新缺陷或观察（不改产品） |

## 8. 体验检查（主观，记录依据）

- 响应时延（受理是否即时返回、后台是否不阻塞前台）。
- 无谓追问次数（该查执行层却先问用户，或反之）。
- 措辞一致性（同一事实多次呈现是否同口径）。
- 随时能接管（进展可见、状态可查、任务可续跑）。

## 9. 预期状态机一览（人工对照；词表来自 `scripts/tasks.ts`）

| 状态 | 用户词 | 含义 |
| --- | --- | --- |
| `queued` | 排队中 | 已受理、未派发（后台队列＝底账 queued 行） |
| `running` | 进行中 | 执行回合在飞 |
| `waiting_user` | 等待用户 | 需用户补齐输入，释放执行槽、同任务可接续 |
| `cancelling` | 取消中 | 已请求取消，等执行端确认（**请求 ≠ 取消**） |
| `cancelled` | 已取消 | 终态（执行端已确认中止） |
| `completed` | 已完成 | 终态（执行端确认成功且结果存档） |
| `failed` | 失败 | 终态（机械原因见下表） |
| `timed_out` | 已超时 | 终态 |
| `unexecuted` | 未执行 | 终态（保留；inline 零执行场景） |

合法转换（`packages/agent/src/task-registry.ts` `LEGAL_TRANSITIONS`）：

```
queued       → running | cancelling | timed_out
running      → completed | failed | waiting_user | cancelling | timed_out | unexecuted
waiting_user → running | cancelling | timed_out
cancelling   → cancelled | running        （中止未获确认 → 回 running，不得宣称取消）
终态（无出边）：cancelled / completed / failed / timed_out / unexecuted
```

机械原因 → 用户词：`cancelled_by_user` 用户取消、`timeout` 超时、`failed_confirmed` 执行层失败、`result_unknown` 结果未知、`resource_limited` 资源受限。

通知意图（九类）→ 用户词：已受理 / 已开始 / 等待用户 / 已恢复 / 已完成 / 失败 / 已取消 / 已超时 / 资源受限。

## 10. 记录格式与纪律

- 每条记录：时间、命令/操作、实际现象（原文）、判定（通过/不通过/存疑）、证据路径。
- 证据放 `.runtime/`（gitignored）或另行指定；**不入库密钥、不贴凭据**。
- 手工证据与自动化证据分列，不互相冒充；手工不产「稳定/达标」结论。
