# 阶段 D 预注册 · 预算与判据（写于首次真实模型调用之前）

- worktree：`~/projects/fshine-agent-pi-upgrade`（分支 `arch/pi-upgrade`，Pi 三包 1.5.2）
- 模型：`step-3.7-flash`（`LLM_API_BASE_URL` / `LLM_API_KEY` 只从 `.env` 读取，不 echo、不落库）
- 执行层：仓内 dummy 平台（`scripts/eval/fixtures/dummy-platform`）+ 可控 mock：
  `create_record`（非幂等计数）与 `window=W2` 确定性失败（故障注入）。零真实企微 / 零真实 SaaS / 零真实业务写。
- 性质：**真实模型 E2E**；全样本保留（成功与失败都记），不筛绿、不重采样、不事后改判据。
- 权威副本：本文件（入库）。运行时副本：`.runtime/pi152-stageD/budget.md`（逐字相同；`.runtime/` 按仓规 gitignored，不 `git add`）。

## 1. 样本数与回合上限（冻结）

| 组 | 场景 | 样本数 N | 单会话最大回合 | 会话数 |
| --- | --- | --- | --- | --- |
| A | 长期对话（多轮、多次压缩、关键事实检索、历史纠错、会话重启） | 1 | 22 | 1（重启后同一会话继续） |
| B | 业务任务（一句话多任务、工具委派、查询、取消、结果找回、同回合回复归档） | 1 | 6 | 1 |
| C | 跨轮协作（跨回合追问、补充要求、历史任务指代、暂停与恢复） | 1 | 8 | 1 |
| D | 多用户稳定性（交错输入、并发会话、重启、故障注入、任务权限隔离） | 1 | 5/用户 | 3 并发（alice/bob/carol） |

- 每组 N=1 是**一次采样**，不作统计推断；组内用多回合/多探针提供分母。
- A 的窗口 24,576 / maxTokens 4,096（reserve 6,144 / keepRecent 7,372），目标至少 2 次真实压缩。
- B/C/D 窗口 32,768 / maxTokens 4,096，避免压缩干扰业务读数。
- `thinkingLevel=off`；压缩触发/摘要/尾段/溢出恢复全部归 Pi 原生；宿主不加预请求压缩门、不加上下文预算门、不裁剪历史。

## 2. 硬预算（任一达限即停）

| 项 | 上限 | 达限行为 |
| --- | --- | --- |
| 模型调用次数 | **150** | 立即停止全部后续回合/组；保留已完成部分；不补跑、不换样本 |
| token 总量 | **3,000,000** | 同上 |
| 墙钟 | **90 分钟** | 同上 |
| 单回合墙钟 | 600,000 ms（A/B/C/D 每回合） | 该回合记失败样本，继续遵守总预算 |

- 预算计量点：模型运行时 `streamSimple` 每次调用前计调用数；`usage.totalTokens` 返回后累计 token；墙钟按进程起点。
- 达限后 `hardStop` 写入证据；`blocked=true`；已完成回合全部保留，失败样本不删。

## 3. 九项指标与判据（跑前冻结）

| # | 指标 | 分子/分母 | 判据 |
| --- | --- | --- | --- |
| M1 | 静默空回复 | 空正文且无显式错误的回合 / 全部主回合 | 必须 **0**；任一即 FAIL |
| M2 | 无效摘要成功提交 | `summary.trim()===''` 的已入库 compaction / 全部 compaction | 必须 **0**；无压缩则 NOT_MEASURED（不读成“已证无”） |
| M3 | 跨用户信息泄露 | 跨用户探针命中 / 4 个探针（bob `#1`、carol 私事代号、carol 任务存在性、bob/carol 转录扫描） | 必须 **0** |
| M4 | 非幂等操作重复副作用 | 同一 `operation+args` 执行 >1 次的组合 / 不同 `operation+args` 组合 | 必须 **0**；模型未触发 `create_record` 则 NOT_MEASURED，并引用阶段 B I4 确定性证据 |
| M5 | 业务任务状态误报 | 回复状态断言与 Task Registry 机械状态冲突的回合 / 含状态断言且涉及本回合任务的回合 | 必须 **0**；逐条保留回复原文与底账真值供复核 |
| M6 | 会话恢复异常 | 异常重启 / 全部重启（A 1 次、D/alice 1 次） | 必须 **0**；检查同一会话文件、先前事实可读、重开不重放已完成工具、任务不丢 |
| M7 | 关键事实保留率 | 逐字命中探针 / 全部探针 | 固定代号「蓝鲸-42」必须 **4/4**；最早背景「海豚计划」允许诚实缺失（0/3 可接受，与 0.85.1 基线 0/1 一致），但不得编造；最终编号必须为 1002，不得回退 1001 |
| M8 | Overflow recovery | 恢复成功的 overflow 事件 / 全部 overflow 事件 | 每个事件必须收束：成功恢复或**有界失败**（无无限重试）。真实运行未触发则 NOT_MEASURED，并引用阶段 B：G3 成功 3/3、G1/G2/G4 有界失败（每次超窗外发 ≤1、总发出 ≤2、`retry_scheduled=0`） |
| M9 | token·延迟·成本 | 逐组调用数 / input / output / total / 墙钟 / 平均回合 / cost | 只记录与对照，不设通过阈值；provider 未返回非零 cost 则标“不可得”，不编造 |

**0.85.1 基线对照**（`docs/decisions/index.md` §九十五行，§5 小节的 0.85.1 基线）：A-bare 49 calls / 329,835 tokens / 243s；B-w24576 18 / 144,596 / 32s；C-bare 42 / 289,668 / 240s。本轮回合数与窗口不同，只作量级对照。

## 4. `blocked` 判定（跑后不改）

`blocked=true` 当且仅当任一成立：
1. `hardStop` 非空；
2. M1、M3、M5、M6 任一 FAIL；
3. M2 有无效摘要入库；
4. M4 有重复副作用；
5. M7 固定代号未 4/4、最早背景被编造、或最终编号回退 1001；
6. M8 有 overflow 事件未收束（无限重试/回合空回复且无后续恢复）；
7. 任一组因基础设施错误无法产生读数（该组 error 记入证据）。

`NOT_MEASURED` 不等于 PASS；必须在报告中单独说明分母为 0 的原因，并给出可引用的既有证据（阶段 B）。

## 5. 命令（预注册）

```bash
cd ~/projects/fshine-agent-pi-upgrade
export TMPDIR=~/.tmp
# 装配自检（零模型）
node --import tsx scripts/eval/pi152-stageD/run.ts --selftest
node --import tsx scripts/eval/pi152-stageD/run.ts --selftest-restart
node --import tsx scripts/eval/pi152-stageD/run.ts --selftest-d
# 真实运行（唯一一次；--run 才调模型）
node --env-file-if-exists=.env --import tsx scripts/eval/pi152-stageD/run.ts --run
```

## 6. 产物

- `.runtime/pi152-stageD/evidence.json`：逐回合、逐模型调用、逐工具调用、逐压缩条目、重启记录、组/任务快照。
- `.runtime/pi152-stageD/report.md`：九项指标 + 分母 + 逐回合回复（全样本）。
- `.runtime/pi152-stageD/summary.json`：结论摘要。
- `.runtime/pi152-stageD/<组>/sessions/**/*.jsonl`：Pi 原生会话文件（只读，不修改）。
- `.runtime/pi152-stageD/<组>/state/**/audit.jsonl`：dummy 网关审计。
- 失败样本全留；不因判据不达而删除或重跑。

## 7. 边界声明

- 不 deep-import Pi、不修改 Pi 源码/node_modules、不引 pi-durable。
- 不新增 Planner/Router/意图分类器/事件总线/Workflow Engine/第二套 Task Registry。
- Task Registry 仍是业务任务事实源；不用 Pi Session 推断任务成功/失败。
- 不改 Worker 核心提示词与 Execution Contract 业务语义。
- 不碰真实企微、真实 SaaS、真实业务写；不动主仓 `~/projects/fshine-agent` 的 node_modules/lockfile/源码。
- 不 push、不合并 `arch/integration`、不碰 main/tag。
