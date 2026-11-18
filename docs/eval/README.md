# 评测口径（eval）

> 状态：现行。三类入口、判据冻结与预注册先写死是硬纪律；过程读数与三轴报告不在此页（见 `docs/product/business-coverage.md`）。
> 最后核对：2026-11-18（分支 `docs/restructure`；代码指针的行号与存在性以 `32a331c` 那次逐条核对为准，本轮只复核被移动/改名的文档指针，eval-gate 三态见 §四；`long-session-coverage.md`、`perf-baseline.md` 本次任务点名但仓内不存在（无 `docs/` 路径，按「存在的才读」跳过））。
> 上游指针：`package.json:15-19`（npm 入口）、`scripts/eval/eval-gate.mjs`（通过率门）、`scripts/eval/convergence-r1/criteria.ts`（冻结判据本体）、`docs/product/r6-longsession-prereg.md`（长会话预注册）。

## 一、三类入口

| 入口 | 命令 / 启动 | 跑什么 | 判定与退出码 |
|---|---|---|---|
| 用户级黑盒 `eval:user` | `npm run eval:user`（`package.json:15`） | 真模型 + 仓内 dummy，与 `ask` 同源装配；E01–E14 共 14 例（`scripts/eval/convergence-r1/cases.ts:111`，`cases/E*.ts` 实测 14 个） | 确定性判定 + 冻结词表；0=无 FAIL、1=有 FAIL、2=infra/INCONCLUSIVE（`scripts/eval/convergence-r1/runner.ts:17`） |
| 确定性面 `eval:cap01` | `npm run eval:cap01`（`package.json:16`） | 零真模型/零网络/零真渠道；8 面串行 r2/r2d/r3/r3b/r5/r6/r7/r8（`scripts/eval/cap01/run-all.ts:34-43`） | 每面子进程退出码即结论，汇总 `summary.json`（同文件 `:90-102`） |
| 渠道级 wecom-sim | `node --import tsx scripts/eval/wecom-sim/run.ts`（无 npm script，`scripts/eval/wecom-sim/run.ts:4`） | 真 createServer + 仓内 dummy + 假企微 SDK；W-01–W-28（含 F 写确认/G 任务面） | 判定全来自 vitest 用例，任一失败退出码非 0（`scripts/eval/wecom-sim/run.ts:6-9,52`） |

- F 组钉写确认：提案零写入 → 确认后 commit 可读回 → 二次确认只执行一次（`scripts/eval/wecom-sim/cases-f-write.test.ts:5-8`）；G 组钉后台受理与查询不重执行（同目录 `scripts/eval/wecom-sim/cases-g-task.test.ts:7-10`）。
- 补充入口 `eval:bizprobe` / `eval:bizbatch2` / `eval:bizbatch3` 是业务 E2E 预注册批次（`package.json:17-19`）；infra 门缺 key / 锁不符 → `exit 2`、不烧样本（`scripts/eval/business-e2e/run.ts:188-194`）。
- ✅ 2026-11-18 修复：`scripts/eval/cap01/run-all.ts` 引用的 `r6-lifecycle.ts` 已随改名同步为 `lifecycle.ts`，全量面恢复可跑。
- ⚠️ 旧文案仍写「12 例」（`.github/workflows/eval-real.yml:66`、nightly `:5`、convergence-r1 README `:34`），现行用例集是 14 例（`scripts/eval/convergence-r1/cases.ts:111`）。

## 二、判据与 criteria.lock 冻结纪律

- 冻结工具：`node --import tsx scripts/eval/convergence-r1/freeze.ts` 重算 `criteriaSha256`/`casesSha256` 与逐文件哈希写入 `criteria.lock`（`scripts/eval/convergence-r1/freeze.ts:22-48`）。
- 运行前校验：runner 重算两个聚合哈希比对，不一致打印「冻结后不得修改」并 `exit 2` 拒绝运行（fail-closed，`scripts/eval/convergence-r1/runner.ts:217-230,610-616`）；套件锁同构 `verifySuiteLock`（`scripts/eval/business-e2e/run.ts:85-100`）。
- 判据本体是代码：`CRITERIA_VERSION`/`JUDGE_VERSION`/`RUNNER_VERSION` 与 `FAILURE_CODES` 失败码表（`FAIL_PHANTOM_SUCCESS` 等）在 `scripts/eval/convergence-r1/criteria.ts:7-24`；机械判定入口 `judgeMechanical`（`scripts/eval/business-e2e/judge.ts:138`）。
- 变更纪律：不得回改旧预注册，只能「作废对应批次 → 追加新预注册（新 run 编号）→ 重跑」（`docs/history/r4-stability-prereg.md:5`）；B03 场景重设后在运行前重冻 bizprobe 锁，`casesSha256` `b9695e6a… → e138d5b3…`、其余套件零改动（`docs/history/business-e2e-prereg-addendum.md:69-73`）。
- ⚠️ **锁只校验 criteria/cases 两个聚合值，不校验 `files` 表**：runner 只读这两个字段（`scripts/eval/convergence-r1/runner.ts:225-226`），套件同（`business-e2e/run.ts:89-95`）。实测 bizprobe 锁 `judge.ts` 记 `d16871e6…`、`cases.ts` 记 `e9bf5c79…`（`scripts/eval/exploration/bizprobe/criteria.lock:17,19`），现文件是 `2715950e…` / `4a7f29d6…`（`sha256sum` 本 ask 实测）→ 判定器/用例文件冻结靠提交纪律，不靠锁。

## 三、预注册：N 与判据先写死

> 已收官轮次的预注册与附录于 2026-11-18 移入 `docs/history/`（`docs/history/business-e2e-prereg.md`、`docs/history/business-e2e-prereg-addendum.md`、`docs/history/r4-stability-prereg.md`）；仍在治理未来运行的 `docs/product/r6-longsession-prereg.md`、`docs/product/p2-business-e2e-prereg.md` 留在原处。历史件的行号以移入后文件为准。

- 铁律：预注册先于运行写死；运行后新增数字只进报告与 `.runtime`，不得回填（`docs/history/r4-stability-prereg.md:5,167`；`docs/product/r6-longsession-prereg.md:319`；`docs/product/p2-business-e2e-prereg.md:3`）。
- N 必须显式：业务 E2E 原每类 N=5（`docs/history/business-e2e-prereg.md:40`），owner 裁定探测口径 N=3、每轮 18 会话、总上限 150（原 60）（`docs/history/business-e2e-prereg-addendum.md:44-46`）；换模型（R1 step-5-preview → R2/R3 step-3.7-flash）的读数不可跨轮比较（同文件 `:51-53`）。
- 硬上限缺一不跑：`maxModelCalls`/`maxTokens`（不可得写 `unavailable`，不编造）/`maxWallMs`/`concurrency`（≤ `evalBatchConcurrency.max=8`）（`docs/history/business-e2e-prereg-addendum.md:82-91`）；experiments 另钉 `LLM_MODEL === step-3.7-flash`（`scripts/eval/business-e2e/experiments/run.ts:26,84`）。
- P2 业务验收：21 样本 / 27 会话，N=3 全绿须记 3/3、Wilson 95% CI `[0.4385,1]`，不得读作「通过/稳定」（`docs/product/p2-business-e2e-prereg.md:150-154`）；单会话硬停取自 `R6_HARD_LIMITS`（`scripts/eval/long-session/accounting.ts:66`）。
- 长会话 Wave1：五轨各 3 会话 = 2×40k 探索 + 1×128k 可行性，合计 15（`docs/product/r6-longsession-prereg.md:334-343`）；runner 运行前记录预注册文档 sha256（`scripts/eval/long-session/wave1-runner.ts:191-194,531`）。
- infra 门先于运行：缺 key / 模型不符 / 锁不一致 → `blocking=true`、`exit 2`、不烧样本（`scripts/eval/business-e2e/run.ts:108-119,188-194`）；N 变更须正式修订，旧批次按各自声明的 N 归属、旧读数不得改写（`docs/history/business-e2e-prereg-addendum.md:21-25`）。

## 四、读数模板与通过率门

- 用户级产物：`summary.json` 含 `matrix`（逐 case×trial 的 verdict/failureCodes）、`counts`、`failureCodeHistogram`、`dimensionHistogram`、`trialsPlanned`、`samples`（`scripts/eval/convergence-r1/runner.ts:802-815`）；`report.md` 标题即「全样本，不筛绿」，逐样本列维度与回复原文（同文件 `:818-866`）。
- 退出码即三态：INCONCLUSIVE 或 infra 失败 → 2，任何 FAIL → 1，全 PASS → 0（`scripts/eval/convergence-r1/runner.ts:868-871`）。
- 批次读数：逐场景 `k/N + Wilson 95% CI`（`scripts/eval/exploration/stats.ts:69`）；两臂比较用 `newcombe95` 差异区间 + 显式预注册等效界 δ（`scripts/eval/exploration/stats.ts:126,162`），不得用「下界 ≥ baseline−δ」这类 N=15 数学上无法通过的小样本门（`docs/product/r6-longsession-prereg.md:81-85`）。
- 报告纪律：只呈现读数 + 失败分布 + 逐条归因 + 限制；INCONCLUSIVE 不计入 k，无 history 对照不产 IMPROVED/REGRESSED（`docs/history/r4-stability-prereg.md:55-57`）。
- 通过率门 `scripts/eval/eval-gate.mjs`：① 完整性（调用方须传**独立**预期集，不信摘要自述）② 硬失败码 `FAIL_PHANTOM_SUCCESS` 不得被通过率抵消 ③ 每例通过率 ≥ `minRate`（`scripts/eval/eval-gate.mjs:9-19,49,66-98,104-118`）。三态本 ask 实测：14 例 PASS 摘要 + 旧 12 例预期集 → `多余用例：E13,E14`、`exit=2`；换 14 例预期集 → `合计：14/14`、`exit=0`；注入一次 `FAIL_PHANTOM_SUCCESS` → `硬失败码命中……`、`exit=1`。
- ⚠️ 门槛缺省值不一致：文件头写「缺省 0.6」（`scripts/eval/eval-gate.mjs:14`），`parseArgs` 实际缺省 `0.5`（同文件 `:24`）。现行 CI 门**不执行**且预期集过时：eval-real 把 n 写死 1（`.github/workflows/eval-real.yml:62`）、门条件 `n != '1'`（`:77`）、预期集止于 E12（`:78`）；nightly 跑 `--trials 3` 但不设门（`.github/workflows/eval-nightly.yml:47`）。
- 性能读数不设门：`perf:suite`/`perf:report` 已不在 `package.json`（`:7-21`，`grep` 实测无命中）；耗时/资源只作观察项，同 R4「措辞面只登记、不设门槛」（`docs/history/r4-stability-prereg.md:55-57`）。

## 五、长会话轨 LS1–LS6（各一句）

- 共同口径：以**会话**为分析单位，可用于结论须 ≥3 次有效压缩 + 窗口装配一致 + 无硬停 + 证据完整（`docs/product/r6-longsession-prereg.md:241-243`）；每轨 Wave1 3 会话 = 2×40k + 1×128k（`:340-343`）。
- **LS1 事实保留**：F1–F8 八类事实先建立、经 ≥3 次压缩后追问，全对才算会话通过（`docs/product/r6-longsession-prereg.md:107-126`；判定 `scripts/eval/long-session/oracle.ts:112,153`）。
- **LS2 任务连续性**：以 Task Registry 为唯一 Oracle 核五态与编号不混淆（`docs/product/r6-longsession-prereg.md:128-134`；判定 `scripts/eval/long-session/oracle.ts:213`）。
- **LS3 交互质量**：≥10 轮覆盖近指/序数/跨压缩指代、改要求、暂停恢复取消、追加条件（`docs/product/r6-longsession-prereg.md:136-142`）。
- **LS4 压缩生命周期**：CMP1–CMP9，H6.a 同回合连续零收益 ≥3 判负、H6.b 单回合模型调用 >4 或摘要分片 >16 判负（`docs/product/r6-longsession-prereg.md:144-161,216`；上限 `scripts/eval/long-session/compaction.ts:71`，判定同文件 `:126`）。
- **LS5 长稳**：同进程 ≥2h、≥2 会话并行、跨 Session 转录污染 = 0，RSS 按预热 + 中位数 3 次采样（`docs/product/r6-longsession-prereg.md:163-169`）。
- **LS6：现行未定义**——预注册只领号 LS1–LS5（同文件 `:6`），全仓 grep 无 `LS6`；要新增须先写新预注册，本页不臆造。
- 运行入口 `scripts/eval/long-session/wave1-runner.ts --track=LS4` / `--all`；缺省并发 1——step 账号模型级并发上限 5，多开会话会产生假红（`scripts/eval/long-session/wave1-runner.ts:27-36`）。

## 六、全样本不筛绿

- 报告与摘要保留每 trial、不剔失败：`report.md` 标题「全样本，不筛绿」（`scripts/eval/convergence-r1/runner.ts:819`），矩阵含全部 case×trial（同文件 `:802-808`），INCONCLUSIVE 单列并令退出码为 2（`:868`）。
- 开跑即跑满 N，不因中途读数提前停；崩溃/中断则本批作废登记，**不补跑、不重采样**，重跑须新预注册 + 新 run-dir（`docs/history/r4-stability-prereg.md:123-126`）。
- 长会话：不重采样、不筛绿、失败样本全保留（`docs/product/r6-longsession-prereg.md:16-17`）；产品故障样本**保留判负**，不被环境信号吞掉（`:88-100`；优先序 `scripts/eval/long-session/evidence.ts:120`）。
- P2 同口径：`product_fault` 判负留档、`environment_interrupted` 待重跑、`insufficient_coverage` 留档不进结论（`docs/product/p2-business-e2e-prereg.md:218-229`）。
- 判据变更令旧读数作废 ≠ 改写旧读数：R1 #3 的 0/3 宣布作废且不复用，原读数原样保留（`docs/history/business-e2e-prereg-addendum.md:67-69`）。
- 安全失败不能抵消：硬失败码一旦命中整批失败，不因其它样本通过转绿（`scripts/eval/eval-gate.mjs:12-13,104-107`；本 ask 实测 `exit=1`，见 §四）。

## 七、读数保留与可复现

- **三件套分别保留、不改写**：原始 `judgment.json`、离线复判结果、重跑结果各自留存；重判不得覆盖原判。
- **报告必须标**：样本规模 N、模型版本（含 thinking level）、代码点（commit）、技能 revision。缺任一项的读数只能当参考，不能当基线（裁定原文 `docs/history/decision-log-part02-2026-11.md:78`）。
