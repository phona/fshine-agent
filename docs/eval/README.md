# 评测口径（eval）

> 状态：现行。评测入口、判据冻结与全样本纪律以代码和预注册为准；过程记录不在此页。
> 最后核对：2026-11-18（worktree `2823880`；全文指针存在性与行号已脚本核对；`eval-gate` 对 14 例的实测见 §四）。
> 上游指针：`package.json:15-19`（入口）、`scripts/eval/convergence-r1/criteria.lock`（冻结面）、`docs/product/r6-longsession-prereg.md`（长会话预注册）。

## 一、三类入口

| 入口 | 命令 / 启动 | 跑什么 | 判据与退出码 |
|---|---|---|---|
| 用户级黑盒 | `npm run eval:user`（`package.json:15`） | 真实模型 + 仓内 dummy 执行层，与 `npm run ask` 同源装配；E01–E14 共 14 例（`scripts/eval/convergence-r1/cases.ts:111`） | `judge.ts` 机械判定 + `criteria.ts` 冻结词表；0=无 FAIL、1=有 FAIL、2=infra/INCONCLUSIVE（`scripts/eval/convergence-r1/runner.ts:868-871`） |
| 确定性面 | `npm run eval:cap01`（`package.json:16`） | 零真实模型、零网络、零真实渠道；8 个面串行：r2/r2d/r3/r3b/r5/r6/r7/r8（`scripts/eval/cap01/run-all.ts:38-47`） | 每面子进程退出码即结论；汇总 `summary.json`（`scripts/eval/cap01/run-all.ts:91-102`） |
| 渠道级 | `node --import tsx scripts/eval/wecom-sim/run.ts`（无 npm script，`scripts/eval/wecom-sim/run.ts:3-4`） | 真 `createServer` 装配 + 仓内 dummy + 假企微 SDK；W-01–W-28（A/B/C/D/E/F 写确认/G 任务面） | 判定全部来自 vitest 用例结果；任一失败退出码非 0（`scripts/eval/wecom-sim/run.ts:7-9`） |

- 补充入口：`eval:bizprobe` / `eval:bizbatch2` / `eval:bizbatch3` 是预注册业务 E2E 批次（`package.json:17-19`）；infra 门（`.env` + `LLM_API_KEY` + 模型解析 + `verifyLock`）失败即 `exit 2`、不烧样本（`scripts/eval/business-e2e/run.ts:108-119,188-194`）。
- 渠道级 F 组钉写确认回环：提案零写入 → 确认后 commit 且可读回 → 二次确认只执行一次（`scripts/eval/wecom-sim/cases-f-write.test.ts:5-8`）；G 组钉后台受理与查询不重执行（`scripts/eval/wecom-sim/cases-g-task.test.ts:5-10`）。
- ⚠️ `cap01` 的 `r6` 面指向 `scripts/eval/cap01/r6-lifecycle.ts`，该文件**不存在**（实际为 `scripts/eval/cap01/lifecycle.ts`，`test -f` 实测 MISSING）→ 全量 `eval:cap01` 在该面会因模块不存在而失败；`--only` 其余面不受影响。
- ⚠️ `convergence-r1/README.md`、`eval-real.yml`、`eval-nightly.yml` 仍写「12 例」，现行用例集是 14 例（`scripts/eval/convergence-r1/cases.ts:111` 含 E13/E14）。

## 二、判据与 criteria.lock 的冻结纪律

- 冻结工具：`node --import tsx scripts/eval/convergence-r1/freeze.ts` 重算 `criteriaSha256`/`casesSha256` 与逐文件哈希，写入 `criteria.lock`（`scripts/eval/convergence-r1/freeze.ts:36-50`）。
- 运行前校验：runner 重算两个聚合哈希并与锁比对，不一致打印「冻结后不得修改」并以 `exit 2` 拒绝运行（fail-closed，`scripts/eval/convergence-r1/runner.ts:217-230,610-618`）。
- 套件锁同构：`verifySuiteLock` 对套件 `criteria.lock` 做同样比对（`scripts/eval/business-e2e/run.ts:84-100`）；bizprobe 锁的 `casesSha256` 即 2026-11-15 B03 重设后重冻结值（`scripts/eval/exploration/bizprobe/criteria.lock:6`；重设登记见 `docs/product/business-e2e-prereg-addendum.md:69-73`）。
- 判据本体是代码：`CRITERIA_VERSION` / `JUDGE_VERSION` / `RUNNER_VERSION` 与失败码表都在 `scripts/eval/convergence-r1/criteria.ts:7-24`；判定入口 `judgeMechanical`（`scripts/eval/business-e2e/judge.ts:138`）与用户级 `judge.ts` 的 `FAIL_*` 码族同属冻结面。
- 变更纪律：不得回改旧预注册；只能「作废对应批次 → 追加新预注册（新 run 编号）→ 重跑」，旧锁与旧证据存档（`docs/product/r4-stability-prereg.md:5-6`；`business-e2e-prereg-addendum.md:69-73`）。
- ⚠️ **锁只校验 criteria/cases 两个聚合值，不校验 `files` 表**：runner 只读两个字段（`scripts/eval/convergence-r1/runner.ts:225-226`），套件同（`scripts/eval/business-e2e/run.ts:89-95`）。实测 bizprobe 锁里 `judge.ts` 记 `d16871e6…`、`cases.ts` 记 `e9bf5c79…`，而现文件是 `2715950e…` / `4a7f29d6…`。因此「判定器/用例文件冻结」今天靠提交纪律，不靠锁：改 `judge.ts` 不会让任何锁拒绝运行。

## 三、预注册：N 与判据先写死

- 铁律：预注册先于运行写死；运行后新增数字只进报告与 `.runtime`，不得回填预注册（`r4-stability-prereg.md:5,165-167`；`r6-longsession-prereg.md:319`；`p2-business-e2e-prereg.md:3`）。
- N 必须显式：业务 E2E 原预注册「每类 N=5」（`docs/product/business-e2e-prereg.md:40`），owner 2026-11-15 裁定为探测口径 **N=3、每轮 18 会话、总上限 150**（`docs/product/business-e2e-prereg-addendum.md:44-47`）；跨轮不可比模型须单独登记（同文件 `:51-53`）。
- 硬上限缺一不跑：`maxModelCalls` / `maxTokens`（不可得则写 `unavailable`，不编造）/ `maxWallMs` / `concurrency`（≤ `evalBatchConcurrency.max=8`），见 `business-e2e-prereg-addendum.md:82-91`。
- P2 业务验收：21 样本 / 27 会话，N=3 全绿须记 `Wilson 95% CI [0.4385, 1]`，不得读作「通过/稳定」（`p2-business-e2e-prereg.md:141-159`）；单会话硬停取自 `R6_HARD_LIMITS`（`scripts/eval/long-session/accounting.ts:66`）。
- 长会话 Wave1：五轨各 3 会话 = 2×40k 探索 + 1×128k 可行性，合计 15，窗口政策与失败分类在冻结块（`r6-longsession-prereg.md:334-361`）；runner 运行前记录预注册文档 `sha256`（`scripts/eval/long-session/wave1-runner.ts:191-194,531`）。
- infra 门先于运行：缺 key / 锁不一致 → `blocking=true`、`exit 2`、**不烧任何样本**（`scripts/eval/business-e2e/run.ts:108-119,188-194`）；experiments 入口另钉 `LLM_MODEL === step-3.7-flash`（`scripts/eval/business-e2e/experiments/run.ts:26,84`）。
- N 变更必须走正式修订；变更前批次按各自声明的 N 归属，旧读数不得改写（`business-e2e-prereg-addendum.md:21-25`）。

## 四、读数模板与通过率门

- 用户级产物：`summary.json` 固定含 `matrix`（逐 case×trial 的 verdict/failureCodes）、`counts`、`failureCodeHistogram`、`dimensionHistogram`、`trialsPlanned`、`samples`（`scripts/eval/convergence-r1/runner.ts:802-815`）；`report.md` 标题即「全样本，不筛绿」，逐样本列维度与回复原文（`scripts/eval/convergence-r1/runner.ts:818-866`）。
- 退出码即三态：`INCONCLUSIVE` 或 infra 失败 → 2，任何 FAIL → 1，全 PASS → 0（`scripts/eval/convergence-r1/runner.ts:868-871`）。
- 批次读数：逐场景 `k/N + Wilson 95% CI`（`scripts/eval/exploration/stats.ts:69`）；两臂比较用 `newcombe95` 差异区间 + 显式预注册等效界 δ（`scripts/eval/exploration/stats.ts:126,162`），不得用「Wilson 下界 ≥ baseline−δ」这类小样本无法通过的门（`r6-longsession-prereg.md:81-85`）。
- 报告纪律：只呈现读数 + 失败分布 + 逐条归因 + 限制；INCONCLUSIVE 不计入 k；无 history 对照不产 IMPROVED/REGRESSED（`r4-stability-prereg.md:55-57`）。
- 通过率门：`scripts/eval/eval-gate.mjs` 校验 ① 用例集合完整（调用方必须传**独立**预期集，不信摘要自述）② 硬失败码 `FAIL_PHANTOM_SUCCESS` 不得被通过率抵消 ③ 每例通过率 ≥ `minRate`（`scripts/eval/eval-gate.mjs:9-19,49,52-98,104-118`）。
- ⚠️ 门槛缺省值不一致：文件头写「缺省 0.6」（`scripts/eval/eval-gate.mjs:14`），`parseArgs` 实际缺省 `0.5`（`scripts/eval/eval-gate.mjs:24`）。
- ⚠️ 现行 CI 里通过率门**不执行**且预期集合已过时：`.github/workflows/eval-real.yml` 把 trial 数写死 `n=1`（`.github/workflows/eval-real.yml:62`），门步骤条件是 `n != '1'`（`.github/workflows/eval-real.yml:76-78`）；即使启用，`--expect-cases E01,…,E12`（`.github/workflows/eval-real.yml:78`）对 14 例摘要会报完整性失败。实测：以 14 例 PASS 摘要跑该命令 → `完整性校验失败……多余用例：E13,E14`，`exit=2`（本 ask 内运行）。
- nightly 跑 `--trials 3` 全 14 例但不设门（`.github/workflows/eval-nightly.yml:47`）。
- 性能读数不设模板：`perf:suite` / `perf:report` 已不在 `package.json`（`package.json:7-21`），`docs/perf-baseline.md` 已删（`3e68e23`）→ 耗时不作现行门，只作观察项（同 `docs/product/r4-stability-prereg.md:55-57` 的「措辞面只登记、不设门槛」）。

## 五、长会话轨 LS1–LS5

- 共同口径：R6 长会话以**会话**为分析单位；会话可用于结论须 ≥3 次有效压缩 + 窗口装配一致 + 无硬停 + 证据完整（`r6-longsession-prereg.md:242-243,355`）。
- **LS1 事实保留**：先建立事实、经 ≥3 次压缩后追问，F1–F8 全对才算该会话通过（`r6-longsession-prereg.md:107-126`；判定 `scripts/eval/long-session/oracle.ts:112,153`）。
- **LS2 任务连续性**：以 Task Registry 为唯一 Oracle，查已完成/取消/失败/待确认/执行中五态与编号不混淆（`docs/product/r6-longsession-prereg.md:128-134`；判定 `scripts/eval/long-session/oracle.ts:213`）。
- **LS3 交互质量**：≥10 个交互轮覆盖近指/序数/跨压缩指代、改要求、暂停恢复取消、追加条件（`docs/product/r6-longsession-prereg.md:136-142`）。
- **LS4 压缩生命周期**：CMP1–CMP9；H6.a 同回合连续零收益尝试 ≥3 判负，H6.b 单回合模型调用 >4 或摘要分片 >16 判负（`docs/product/r6-longsession-prereg.md:144-161,216`；上限常量 `scripts/eval/long-session/compaction.ts:71`，判定 `scripts/eval/long-session/compaction.ts:126`）。
- **LS5 长稳**：同进程 ≥2h、≥2 会话并行、跨 Session 转录污染 = 0，资源按预热 + 中位数 3 次采样（`docs/product/r6-longsession-prereg.md:163-169`）。
- **LS6：现行**未定义——预注册只领号 LS1–LS5（`r6-longsession-prereg.md:6`），全仓检索无 `LS6`；要新增须先写新预注册，本页不臆造。
- 运行入口：`scripts/eval/long-session/wave1-runner.ts --track=LS4` / `--all`；缺省并发 1——step 账号模型级并发上限 5，多开会话会顶爆并产生假红（`scripts/eval/long-session/wave1-runner.ts:26-30`）。

## 六、全样本不筛绿

- 报告与摘要保留每个 trial，不剔除失败样本：`report.md` 标题「全样本，不筛绿」（`scripts/eval/convergence-r1/runner.ts:819`），`summary.json` 矩阵含全部 case×trial（`scripts/eval/convergence-r1/runner.ts:802-808`），INCONCLUSIVE 单列并令退出码为 2（`scripts/eval/convergence-r1/runner.ts:868`）。
- 开跑即跑满 N：不因中途读数提前停；崩溃/中断则本批作废并登记，**不补跑、不重采样**；重跑必须新预注册 + 新 run-dir（`r4-stability-prereg.md:123-126`）。
- 长会话：不重采样、不筛绿、失败样本全保留（`docs/product/r6-longsession-prereg.md:16-17`）；产品故障样本**保留判负**，不得被环境信号吞掉或作废（`docs/product/r6-longsession-prereg.md:88-100`；`scripts/eval/long-session/evidence.ts:120` 的优先序）。
- P2 同口径：`product_fault` 判负留档、`environment_interrupted` 待重跑、`insufficient_coverage` 留档不进结论（`p2-business-e2e-prereg.md:218-229`）。
- 判据变更令旧读数作废 ≠ 改写旧读数：R1 #3 的 0/3 被宣布作废且不复用，但原读数原样保留（`business-e2e-prereg-addendum.md:66-73`）。
- 安全失败不能抵消：硬失败码一旦命中，整批失败，不因其它样本通过而转绿（`scripts/eval/eval-gate.mjs:12-13,104-107`）。
