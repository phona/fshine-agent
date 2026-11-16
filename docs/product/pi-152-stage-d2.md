# Pi 1.5.2 · 阶段 D2：原生压缩配置对照（16,384 窗口）

- 运行时间：2026-11-16T01:27:47.290Z – 01:43:46.057Z（本机 09:27–09:43）。
- 模型：`step-3.7-flash`（`.env` 取凭据，未 echo、未落库）；`thinkingLevel=off`；执行层为仓内 dummy 装配面，零真实企微/SaaS/业务写。
- 预注册：`.runtime/pi152-stageD2/prereg.md`（写于任何真实模型请求之前；N=3/组、判据、硬停、一次采样、失败样本全留）。
- 原始证据：`.runtime/pi152-stageD2/{report.md,evidence.json,metrics.json,summary.json,run.log,<arm>/s<k>/...}`（`.runtime/` 被 gitignore，不入库；本文只复述读数）。
- 性质：**只调 Pi 原生配置** `CompactionSettings.reserveTokens` / `keepRecentTokens`；未移植 Trigger Policy V2、未加宿主触发/预算门/调度器/重试器、未改提示词与工具面。

## 1. 对照设计（唯一变量）

两组共享：同一模型、同一场景（阶段 D A 组 22 回合：事实种子 / 14 条中性填充 / 3 次事实探针 / 1 次纠错 / turn 21 后重启同一会话）、同一装配（`assembleSessionCore`，inline + 无 runner）、同一工具白名单、同一 `maxTokens=4,096`、同一回合数。

| 组 | 窗口 | `reserveTokens` | `keepRecentTokens` | 触发阈值（窗口−reserve） |
| --- | --- | --- | --- | --- |
| control | 16,384 | 4,096 | 4,915 | 12,288 |
| experiment | 16,384 | 8,192 | 4,096 | 8,192 |

- control 数值 = `piCompactionSettings(16384)` 现行派生（`packages/agent/src/pi-driver.ts:97-111`）；experiment 为显式绝对配置，经 `PiTurnDriverOptions.compactionSettings` 透传（驱动入口 `packages/agent/src/pi-driver.ts:409-412`，`SettingsManager.inMemory({compaction})`）。
- 配置生效的确定性校验：`node --import tsx scripts/eval/pi152-stageD2/run.ts --selftest`（9 项，含 Pi `SettingsManager.getCompactionSettings` 保留 8192/4096、runtime `contextWindow/maxTokens` 覆盖）。实跑侧另有读数差异：6 个会话 3/3 一致地 control 9 次提交、experiment 10 次提交；首个压缩 `tokensBefore` control ≈14.2–14.3k vs experiment ≈12.0–12.2k。

## 2. 预算与实际

| 项 | 上限（预注册） | 实际 |
| --- | --- | --- |
| 样本 | control 3 + experiment 3 | 6（无缺失、无重采样） |
| 模型调用 | 300 | 191（control 93 / experiment 98） |
| token 总量 | 4,000,000 | 1,870,980（control 959,737 / experiment 911,243） |
| 墙钟 | 60 min | 958,740 ms（≈16 min） |
| 硬停 | 任一达限即停 | 未触发（`hardStop=null`） |

## 3. 逐项读数

| 读数 | control（3 会话） | experiment（3 会话） |
| --- | --- | --- |
| ① 压缩提交（成功） | 27（9/会话） | 30（10/会话） |
| ① 摘要请求 / 失败 | 27 / 0 | 32 / 2（均为 `stopReason=length`，随后重试成功；无空摘要入库） |
| ② 主请求线上 `max_completion_tokens` | `{1024:18, 4096:37, 1340–3957:11}` | `{1024:15, 4096:45, 1300–3649:6}` |
| ② 摘要请求线上 `max_completion_tokens` | 27×4096 | 32×4096 |
| ③ provider 拒绝超窗 | 0/93 | 0/98 |
| ③ provider 报 `totalTokens`>16,384 的主请求 | **24/66**（max 17,034） | **0/66**（max 15,049） |
| ④ 关键事实探针 | 27/27（100%） | 27/27（100%） |
| ⑤ 静默空回复 | 0/66 | 0/66 |
| ⑥ tokens / 墙钟 | 959,737 / 425,359 ms | 911,243 / 533,381 ms |

逐会话明细见 `.runtime/pi152-stageD2/report.md`；关键事实探针含 `蓝鲸-42`（turn 11/19/21/22）、`海豚计划`、纠错后 `1002`（turn 19/22），严格子串判定。

### 解读

- **配置差异确实生效但幅度有限**：Pi 的压缩触发判定与 `tokensBefore` 都是 Pi 的上下文 token 估算（`agent-session.js:476` / `compaction.js:640`），不是 provider 计费 token；压缩检查发生在请求前（回合边界），单回合新增约 3.4k 字符输入，使实际触发点高于阈值（control 约 14–17k、experiment 约 12–15k）。experiment 阈值更低 ⇒ 每次提交更早、次数更多（10 vs 9），首个提交点提前约 2.2k。
- **声明窗口是否兜住**：control 有 24/66 次主请求的 provider `usage.totalTokens` 超过声明的 16,384（最高 17,034），即原配置在 16k 窗口下会越过声明窗口才压缩；experiment 为 0/66（最高 15,049）。本端点真实窗口大于声明值，故 provider **拒绝**率两组都为 0——该列不能区分两组，必须与「totalTokens>声明窗口」列一起读。
- **摘要输出预算仍是瓶颈面**：摘要请求线上 cap 为 `model.maxTokens=4,096` 且实测全部取 4,096；experiment 32 次摘要中 2 次（turn 9 / turn 14）`stopReason=length`，由 Pi 原生 `getSummarizationFailure` 判失败、未提交，随后重试成功并正常提交；本轮无空摘要入库（U2 守卫未触发），未造成历史丢失或空回复。
- **成本**：experiment 多 1 次压缩/会话、摘要调用 +5，墙钟 +25%（533s vs 425s），token 总量反而 −5%（911k vs 960k）。

## 4. 判据（预注册，跑后未改）

| 判据 | 读数 | 结论 |
| --- | --- | --- |
| J1 实验组静默空回复 = 0 | 0/66 | PASS |
| J2 实验组实际超窗率 ≤ 对照组 | provider 拒绝 0/93 vs 0/98（辅：totalTokens>窗口 24/66 vs 0/66） | PASS |
| J3 实验组事实保留率 ≥ 对照组 | 27/27 vs 27/27 | PASS |
| J4 实验组压缩收敛 | 3/3 会话收敛（有效提交 10/10 非空；末 3 回合无空回复、无摘要失败；无异常终止） | PASS |

结论：**未 BLOCKED**（`summary.json.blocked=false`）。experiment 组满足全部四项；唯一需要注意的是摘要 `length` 的瞬时失败（2/32，重试后成功），不是收敛失败。

## 5. 局限（如实登记）

- N=3/组是一次采样，只作描述性对照，不作显著性/总体推断。
- provider 真实窗口大于声明 16,384，因此“provider 拒绝超窗”在本实验里结构性为 0；真正有区分度的是 provider 报的 `usage.totalTokens` 是否越过声明窗口（control 24/66、experiment 0/66）。若要直接测 provider 拒绝，需要把窗口声明到端点真实上限附近，本轮未做。
- 摘要输出上限固定为 4,096，2 次 `length` 是否会在更长会话里变成不可恢复，本轮未覆盖；U2 的空摘要拒绝 + Pi 重试在本轮有效。

## 6. 复现与补丁纪律

```sh
# 预注册已存在时的闸门（零模型）
node --import tsx scripts/eval/pi152-stageD2/run.ts --gate
# 装配/配置自检（零模型）
node --import tsx scripts/eval/pi152-stageD2/run.ts --selftest
# 真实运行（N=3/组；需 .env；先写 .runtime/pi152-stageD2/prereg.md）
node --env-file-if-exists=.env --import tsx scripts/eval/pi152-stageD2/run.ts --run
# 只重算读数（不发起模型请求）
node --import tsx scripts/eval/pi152-stageD2/run.ts --recompute
```

- 本阶段**未新增任何 Pi 补丁**；依赖的既有补丁栈仍为 U1（输出下限，`pi-ai/simple-options.js`）与 U2（空摘要不得入库，`pi-coding-agent/{compaction,session-manager}.js`），守卫测试 `10 passed`。补丁撤销方式与登记见 `docs/product/pi-152-dependency-patches.md`（删 `patches/` + `npm ci` 即回上游原状）。
- 评测侧改动只有观测：`scripts/eval/pi152-stageD/harness.ts` 增加可选 `settings` 覆盖与线上 `max_completion_tokens` 记录（经 Pi `onPayload`，不改请求/响应）；`scripts/eval/pi152-stageD2/` 为入口。宿主/驱动的产品语义未改。
