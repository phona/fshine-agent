## Context

工作流 `dwfrun-f654ab99-4b95-43b5-b30d-93c77df3b564` 的流 C 执行员上报了一个 blocking question，停在 `dwfq-f654ab99-1`（其余流 A/P3 与编排层继续跑，未受影响）。它的实测成立：brief 里写的 `npm run eval:probe -- --quick` 与基线 v3 的覆盖面对不齐，score 对基线内缺行用例直接 fail——即每 push 结构性常红，而方案红线禁止为绿灯动基线。plan mode 挡着 `ResolveWorkflowQuestion`（非只读），需要你核准答复才能送进运行。

## 升级问题（执行员·C，已实测核实）

- `probe --quick` 只跑 A1/A2/A4/A5/B1（`probe-real-agent.ts:2060`）；基线 v3 含 probe-A3、probe-Y2 期望
- `score.ts:163` 对基线内缺行用例返回 fail、`:362` exit 1 → `--quick` + score = 每次结构性红
- 附带发现：`package.json` 的 `eval:score` 硬编码 `--judge`、parseArgs 无 `--no-judge` 开关 → 方案要求的「不带 judge」需在工作流里直调脚本本体
- `eval:acceptance` 默认 4 例恰好产出基线 writeChain 键，无需动

## 推荐答复（已备好，核准即发）

1. **eval-real.yml 改用默认 7 例集**（`npm run eval:probe`，即 `--only A1,A2,A3,A4,A5,B1,Y2`）——把跑的面补齐到基线覆盖面，不动基线（红线）。实测 ~8 分钟，timeout-minutes: 30 充裕
2. **nightly 双档对照两腿同样用 7 例集**——同用例集比模型；用 quick 比的是覆盖面不是模型能力，区分度结论会失真
3. **score 不带 judge：直调脚本本体**（`node --import tsx scripts/eval/score.ts`），文件头注释写清原因（npm script 硬编码 --judge、无开关）+「日后长出 --no-judge 开关就切回」；先确认无 .env 时机械分量跑得通（读 run 产物 + baseline.json，不依赖 LLM_*），跑不通如实报 openIssues
4. **eval:acceptance 不动**
5. **成本认知更新带进终报**：每 push 模型时间 ~3 → ~8 分钟（模型侧 token，不占 CI 的 2000 分钟/月）
6. **judge 保持只在 nightly**（per-push 只出机械分量报告发 PR 评论）——judge 方差不进每 push 的门禁面

## 核准后的动作

1. `ResolveWorkflowQuestion(dwfq-f654ab99-1)` 送出上述答复，流 C 执行员解锁继续
2. 继续 15 分钟监控循环：计时器 `exec_dfbcffe9` 在跑，到点 `GetWorkflowRun` 快照 → 按协议表处理（有进展汇报 / 新 pendingQuestions 转你 / stopped-interrupted 就 ResumeWorkflowRun / errored 就改 `public-landing.dwf.ts` 再 amend / 超 30 分钟没进展查卡点）→ 重挂 `sleep 900`
3. 跑完收终报：五流合入情况、终门八项、基线重定写/没写、剩余 owner 动作清单（LICENSE / 17dz PR / 四个小裁示 / eval-real 转 required 的时机）