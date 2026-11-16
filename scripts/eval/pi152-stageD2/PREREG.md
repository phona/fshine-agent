# 阶段 D2 预注册 · Pi 原生压缩配置对照实验

- 写入时间：2026-11-16T09:22:29+08:00（**先于任何真实模型请求**；`prereg.md` 落盘后才允许 `--run`）
- worktree：`~/projects/fshine-agent-pi-upgrade`（分支 `arch/pi-upgrade`；`@earendil-works/pi-agent-core` / `pi-ai` / `pi-coding-agent` 均 1.5.2）
- 模型：`step-3.7-flash`（`LLM_API_BASE_URL` / `LLM_API_KEY` 只从 `.env` 读，不 echo、不落跟踪文件）
- 性质：真实模型 E2E；**只调 Pi 原生配置**（`CompactionSettings.reserveTokens` / `keepRecentTokens`）。
  不移植 StepCode Trigger Policy V2、不加宿主侧触发/预算门/调度器/重试器、不裁剪历史、不改提示词。
- 全样本保留：成功与失败的会话都落盘；一次采样、不重采样、不筛绿、不事后改判据。

## 1. 对照设计（唯一变量：压缩配置）

两组共享：同一模型 `step-3.7-flash`、`thinkingLevel='off'`、同一装配（`assembleSessionCore`，inline 派发、
无 runner，与阶段 D A 组逐项一致）、同一场景文本（`scripts/eval/pi152-stageD/scenarios.ts` 的 `A_TURNS`，
22 回合：2 条事实种子 + 14 条中性填充 + 3 次事实探针 + 1 次纠错 + 1 条约束）、同一工具白名单（同一装配面原样）、
同一 `maxTokens=4096`（模型能力声明，单请求输出上限）、同一回合数/重启点（turn 21 后关闭并重开同一会话）。

| 组 | 上下文窗口 | `reserveTokens` | `keepRecentTokens` | 压缩触发阈值（窗口−reserve） |
| --- | --- | --- | --- | --- |
| 对照组（control，原配置） | 16,384 | **4,096** | **4,915** | 12,288 |
| 实验组（experiment） | 16,384 | **8,192** | **4,096** | 8,192 |

- 对照组数值 = `piCompactionSettings(16384)` 的现行派生结果（`packages/agent/src/pi-driver.ts:97-111`：
  `floor(16384×0.25)=4096`、`floor(16384×0.3)=4915`），即当前产品在 16k 窗口下的原配置。
- 实验组数值 = 预注册写死的显式 `CompactionSettings`，经 `PiTurnDriverOptions.compactionSettings` 原样透传给 Pi；
  触发/执行/摘要/尾段/溢出恢复仍全部归 Pi。
- 观测只读：eval 侧在模型运行时外包一层记录器（不改请求、不改响应），并用 Pi 的 `onPayload` 钩子记录
  **线上实际** `max_completion_tokens`。不向宿主/驱动新增任何压缩逻辑。

## 2. 样本数 N 与预算（冻结）

| 组 | 场景 | N（会话数） | 每会话回合 |
| --- | --- | --- | --- |
| control | A 长期对话（含压缩、事实探针、纠错、重启） | **3** | 22 |
| experiment | 同上 | **3** | 22 |

- N=3/组 是**一次采样**（每会话只跑一遍），作描述性对照，不作显著性或总体推断。
- 硬预算（任一达限即停全部后续会话；保留已完成部分，不补跑、不换样本）：

| 项 | 上限 |
| --- | --- |
| 模型调用次数 | 300 |
| token 总量 | 4,000,000 |
| 墙钟 | 60 分钟 |

## 3. 逐项读数（全部报告，不挑选）

1. **压缩次数与成功/失败**：会话 JSONL 中 `type=compaction` 条目数（成功提交，含空摘要检查 U2 的前置拒绝；
   空摘要不得入库）；摘要请求数（`isSummary` 模型调用）、其中 `stopReason=error/length` 或带 errorMessage 的失败数；
   每次成功压缩提交的 `tokensBefore` 分布（用于验证配置确实生效：对照组应聚集在 12k 附近，实验组在 8k 附近）。
2. **每次请求的输出预算**：线上实际 `max_completion_tokens`（Pi `onPayload` 观测），按主请求/摘要请求分别给出分布。
3. **实际超窗率（真实 provider 侧）**：模型调用返回 provider 错误且错误文本匹配上下文超限
   （`/context[_ ]length|maximum context|too many tokens|reduce the length|prompt is too long|413/i`）
   的调用数 / 全部模型调用数；同时原样保留错误文本，便于复核分类。**不是** Pi 的本地
   `estimateContextTokens` 估算。
4. **关键事实保留率**：A 组严格子串探针（`蓝鲸-42`、`海豚计划`、纠错后 `1002`，含重启后探针）通过数 / 探针总数。
5. **空回复数**：产品面 `session.send()` 返回的最终回复 `trim()===''` 的回合数（已含驱动的一次收尾催问；即用户可感知的静默空回复）。
6. **token/耗时**：每会话/每组 token 总量、模型调用数、墙钟。

## 4. 判据（预注册，跑后不改）

- **J1（硬）**：实验组静默空回复数必须为 **0**（N=3 的全部 66 个回合）。
- **J2（硬）**：实验组实际超窗率不得高于对照组（按调用数计；两组任一为 0 视为不劣）。
- **J3（硬）**：实验组关键事实保留率不得低于对照组（探针口径相同）。
- **J4（硬，收敛）**：实验组每个会话的压缩必须收敛——
  (a) 每组至少 1 次有效压缩提交，且所有提交的摘要非空；
  (b) 会话最后 3 个回合回复均非空；
  (c) 压缩失败（摘要 error/length 或 errorMessage）不得出现在会话最后 3 个回合的模型调用中；
  (d) 会话无异常终止（`session.send` 未抛错、无 `stopReason=error` 的最终回复）。
  对照组只作对照读数，不由此判据裁定。
- 其余读数（压缩次数、预算分布、tokens/耗时）为描述性，不作硬判据，但全部报告。

## 5. 失败与 BLOCKED 处置

- 任一硬预算达限 → 立即停，保留已完成样本，`hardStop` 记为达限项；已跑样本照常报告。
- 若实验组**原生压缩仍无法收敛**（J4 不成立）或 J1/J2/J3 任一不成立 → 结论 **BLOCKED**，
  保留完整证据（含失败样本与原始错误文本）；**不得**为了通过而扩大补丁、增加宿主触发逻辑、重采样或修改判据。
- 会话级异常：记录错误、保留该样本；不重跑同一 (arm, sample)。

## 6. 证据落盘

- `.runtime/pi152-stageD2/`：`evidence.json`（逐会话/逐调用原始读数）、`metrics.json`、`report.md`、`summary.json`、`run.log`。
- 预注册副本（运行时）：本文件；仓内权威副本：`docs/product/pi-152-stage-d2.md`（运行后按实测补读数，不预先写结果）。
