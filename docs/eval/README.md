# 评测口径（eval）

> 状态：现行。三类入口、判据冻结与预注册先写死是硬纪律；过程读数与三轴报告不在此页（见 `docs/product/business-coverage.md`）。
> 最后核对：2026-11-20（代码指针以现行代码为准；本轮核对被移动/改名的文档指针与过期陈述）。
> 上游指针：`package.json:16-22`（npm 入口）、`scripts/eval/eval-gate.mjs`（通过率门）、`scripts/eval/convergence-r1/criteria.ts`（冻结判据本体）、`docs/history/long-session-prereg.md`（长会话预注册，已归档）、`docs/history/long-session-coverage.md`（轨道覆盖台账，已归档）。

## 一、三类入口

| 入口 | 命令 | 判定与退出码 |
| --- | --- | --- |
| 用户级黑盒 `eval:user` | `npm run eval:user`（`package.json:16`） | 真模型 + 仓内 dummy，与 `ask` 同源装配；E01–E15 共 15 例（`scripts/eval/convergence-r1/cases.ts:129` 的 `ALL_CASES`；E15 的夹具前置已随聚合支持落地（316607b2，2026-11-18），2026-11-20 实跑 PASS）；确定性判定 + 冻结词表，0=无 FAIL、1=有 FAIL、2=infra/INCONCLUSIVE（`scripts/eval/convergence-r1/runner.ts:645-660`） |
| 确定性面 `eval:cap01` | `npm run eval:cap01`（`package.json:19`） | 零真模型/零网络/零真渠道；8 面串行（`scripts/eval/cap01/run-all.ts:34-43`），每面子进程退出码即结论，汇总 `summary.json`（`:98-99`） |
| 渠道级 wecom-sim | `node --import tsx scripts/eval/wecom-sim/run.ts`（`scripts/eval/wecom-sim/run.ts:4`） | 真 createServer + dummy + 假企微 SDK；判定全来自 vitest 用例，任一失败退出码非 0（`:6-9`） |

- F 组钉写确认（提案零写入 → 确认后 commit 可读回 → 二次确认只执行一次，`scripts/eval/wecom-sim/cases-f-write.test.ts:5-8`）；G 组钉后台受理与查询不重执行（`scripts/eval/wecom-sim/cases-g-task.test.ts:7-10`）。
- 补充入口 `eval:bizprobe` / `eval:bizbatch2` / `eval:bizbatch3`（`package.json:20-22`）；infra 门缺 key / 锁不符 → `exit 2`、不烧样本（`scripts/eval/business-e2e/run.ts:188-194`）。
- ⚠️ 旧文案仍写「12 例」（`.github/workflows/eval-real.yml:66`、nightly `:5`、convergence-r1 README `:34`、`scripts/ci.sh:16`）或「14 例」，现行用例集以 `scripts/eval/convergence-r1/cases.ts:129` 的 `ALL_CASES` 为准，共 **15 例**。
## 二、判据与 criteria.lock 冻结纪律

- 冻结：`node --import tsx scripts/eval/convergence-r1/freeze.ts` 重算 `criteriaSha256`/`casesSha256` 与逐文件哈希写入 `criteria.lock`（`scripts/eval/convergence-r1/freeze.ts:22-48`）。
- 运行前 runner 重算两个聚合哈希比对，不一致打印「冻结后不得修改」并 `exit 2` 拒绝运行（fail-closed，`scripts/eval/convergence-r1/runner.ts:217-230`）；套件锁同构（`scripts/eval/business-e2e/run.ts:85-100`）。
- 判据本体是代码：`CRITERIA_VERSION`/`JUDGE_VERSION`/`RUNNER_VERSION` 与失败码表（`scripts/eval/convergence-r1/criteria.ts:7-24`）；机械判定 `judgeMechanical`（`scripts/eval/business-e2e/judge.ts:138`）。
- 变更纪律：不得回改旧预注册，只能「作废对应批次 → 追加新预注册（新 run 编号）→ 重跑」（`docs/history/r4-stability-prereg.md:5`）。
- ⚠️ **锁只校验 criteria/cases 两个聚合值，不校验 `files` 表**（`scripts/eval/convergence-r1/runner.ts:225-226`）：判定器/用例文件冻结靠提交纪律，不靠锁。
## 三、预注册：N 与判据先写死

- 铁律：预注册先于运行写死；运行后新增数字只进报告与 `.runtime`，不得回填（`docs/history/long-session-prereg.md:321`；`docs/history/business-e2e-batch2-prereg.md:5`）。
- N 必须显式：业务 E2E 原每类 N=5（`docs/history/business-e2e-prereg.md:40`），owner 裁定探测口径 N=3、每轮 18 会话、总上限 150（`docs/history/business-e2e-prereg-addendum.md:44-46`）；换模型的读数不可跨轮比较（同文件 `:51-53`）。
- 硬上限缺一不跑：`maxModelCalls`/`maxTokens`（不可得写 `unavailable`，不编造）/`maxWallMs`/`concurrency`（≤ 8）（`docs/history/business-e2e-prereg-addendum.md:82-91`）；experiments 另钉 `LLM_MODEL === step-3.7-flash`（`scripts/eval/business-e2e/experiments/run.ts:26`）。
- P2 业务验收：21 样本 / 27 会话，N=3 全绿须记 3/3、Wilson 95% CI `[0.4385,1]`，不得读作「通过/稳定」（`docs/history/business-e2e-batch2-prereg.md:152-156`）；单会话硬停取自 `R6_HARD_LIMITS`（`scripts/eval/long-session/accounting.ts:66`）。
- 长会话 Wave1：五轨各 3 会话 = 2×40k 探索 + 1×128k 可行性，合计 15（`docs/history/long-session-prereg.md:336-345`）；runner 运行前记录预注册文档 sha256（`scripts/eval/long-session/wave1-runner.ts:191-194`）。
- infra 门先于运行：缺 key / 模型不符 / 锁不一致 → `blocking=true`、`exit 2`、不烧样本（`scripts/eval/business-e2e/run.ts:108-119`）；N 变更须正式修订，旧读数不得改写。
## 四、读数模板与通过率门
- 用户级产物：`summary.json` 含 `matrix`（逐 case×trial 的 verdict/failureCodes）、`counts`、`failureCodeHistogram`、`dimensionHistogram`、`trialsPlanned`、`samples`（组装与落盘见 `scripts/eval/convergence-r1/runner.ts:880` 的 `matrix` 与 `:890` 的 `writeFileSync`）；`report.md` 标题即「全样本，不筛绿」，逐样本列维度与回复原文（`:893` 起）。
- 退出码即三态：INCONCLUSIVE 或 infra 失败 → 2，任何 FAIL → 1，全 PASS → 0（`scripts/eval/convergence-r1/runner.ts:645-660` 的 `process.exitCode` 赋值链）。
- 批次读数：逐场景 `k/N + Wilson 95% CI`（`scripts/eval/exploration/stats.ts:69`）；两臂比较用 `newcombe95` 差异区间 + 预注册等效界 δ（`:126`、`:162`），不得用小样本数学上无法通过的门（`docs/history/long-session-prereg.md:83-87`）。
- 报告纪律：只呈现读数 + 失败分布 + 逐条归因 + 限制；INCONCLUSIVE 不计入 k，无 history 对照不产 IMPROVED/REGRESSED（`docs/history/r4-stability-prereg.md:55-57`）。
- 通过率门 `scripts/eval/eval-gate.mjs`：① 完整性（调用方须传**独立**预期集，不信摘要自述）② 硬失败码 `FAIL_PHANTOM_SUCCESS` 不得被通过率抵消 ③ 每例通过率 ≥ `minRate`（`:9-19`、`:104-118`）。⚠️ 现行 CI 门实际不执行：trial 固定 1，门条件 `n != '1'` 永不成立（`.github/workflows/eval-real.yml:62`、`:77`）；nightly 只跑不设门（`.github/workflows/eval-nightly.yml:47`）。
- 性能读数不设门：`perf:suite`/`perf:report` 已不在 `package.json`（`:7-21`），耗时/资源只作观察项。
## 五、长会话轨 LS1–LS6
- 共同口径：以**会话**为分析单位；可用于结论须 ≥3 次有效压缩 + 窗口装配一致 + 无硬停 + 证据完整（`docs/history/long-session-prereg.md:243-245`）；每轨 Wave1 3 会话（`:342-345`）。
- **LS1 事实保留**：F1–F8 八类事实先建立、经 ≥3 次压缩后追问，全对才算通过（`docs/history/long-session-prereg.md:109-128`）；**LS2 任务连续性**：Task Registry 为唯一 Oracle 核五态与编号（`:130-136`）；**LS3 交互质量**：≥10 轮覆盖近指/序数/跨压缩指代/改要求/暂停恢复取消（`:138-144`）；**LS4 压缩生命周期**：CMP1–CMP9，H6.a/H6.b 上限（`:146-163`；`scripts/eval/long-session/compaction.ts:71`）；**LS5 长稳**：同进程 ≥2h、≥2 会话并行、转录污染 = 0（`:165-171`）；**LS6** 为 2026-11-18 追加的自然交互扰动轨（`scripts/eval/long-session/evidence.ts:30-32`），判据与盲区见 `docs/history/long-session-coverage.md`。
- **安全硬零 H1–H7 不在此复述**：清单与机械判据见 `docs/history/long-session-prereg.md` §五；任一命中即整批 FAIL、停止、登记 blocker。
- **读数适用边界**：R5 长稳全部取自 **W=8192**，不得外推生产 128k（`docs/history/long-session-prereg.md:279`）。
- 运行入口 `scripts/eval/long-session/wave1-runner.ts --track=LS4` / `--all`；缺省并发 1——step 账号模型级并发上限 5，多开会话会产生假红（`:27-36`）。
## 六、全样本不筛绿
报告与摘要保留每 trial、不剔失败：`report.md` 标题「全样本，不筛绿」（`scripts/eval/convergence-r1/runner.ts:893`），矩阵含全部 case×trial（`:880`）；开跑即跑满 N，崩溃/中断则本批作废登记，**不补跑、不重采样**（`docs/history/r4-stability-prereg.md:123-126`）。长会话同口径：产品故障样本保留判负（`docs/history/long-session-prereg.md:90-102`）；硬失败码命中即整批失败，不因其它样本通过转绿（`scripts/eval/eval-gate.mjs:12-13`）。
## 七、读数保留与可复现

原始 `judgment.json`、离线复判结果、重跑结果各自留存，重判不得覆盖原判；报告必须标 N、模型版本（含 thinking level）、代码点（commit）、技能 revision——缺任一项只能当参考，不能当基线（`docs/history/decision-log-part02-2026-11.md:78`）。

## 八、dummy 夹具能力（2026-11-18，声明式，产品码零改动）

慢：`--delay-ms 0..60000`（超限 exit 2 `DELAY_OUT_OF_RANGE`，真实 sleep）；久后失败：场景 `faults[]` 的 `kind:"slow_fault"`（`slow-fault-one`）；待补答：集合 `requires:["window"|"customer"]`（`receivables-open`）→ `needs_input`+`missing`，补参后完成、缺参不写数据。
结果聚合（不是入参）：`sum`（均带数值 `value` 时，alpha W1=2000）、`amountSum`、`byDimension`（声明维度时分组和=总数）；空/非数值不带（不返回 0），E15 读的就是审计 `result` 里的这些字段。冒烟：`scripts/eval/smoke/slow-faults.test.ts`。
