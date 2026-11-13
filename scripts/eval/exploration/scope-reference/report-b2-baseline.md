# scope-reference 基线采样报告（R3 Batch 2；帧 step-3.7-flash）

> 范围：M01–M07 × 9 trial 基线 + M01 预注册一次性扩展（N=15）。
> 帧：LLM_MODEL=step-3.7-flash（进程 env 显式覆盖，main=worker）；执行层=仓内 dummy；基线提交 e741fc8（arch/r3-b2）。
> 证据：`.runtime/exploration-b2/baseline/`、`.runtime/exploration-b2/extension/`、组合视图 `.runtime/exploration-b2/combined/`（均 gitignored，全样本保留）。
> 口径：k/N 一律附 Wilson 95% CI（z=1.96）；不得解读为稳定概率（9/9 亦然）；不为凑绿重跑或筛样。

## 0. 摘要

- 基线（63 run = 7 单元 × 9）：**54 PASS / 9 FAIL / 0 INCONCLUSIVE**（runner 退出码 1）；轮内合计 1,024.3s，墙钟 17m13s（manifest startedAt→finishedAt），token 376,555（assistant.usage）。
- 逐单元：M01 **4/9**；M02 **8/9**；M03 **8/9**；M04 **9/9**；M05 **8/9**；M06 **9/9**；M07 **8/9**。
- 扩展：仅 M01 命中预注册规则（4/9 的 CI [0.189,0.733] 跨 0.5；成本 6 run ≤24）→ M01 一次性扩到 N=15（trial 10–15，单独目录，原 9 保留）；扩展后 **5/15，CI [0.152,0.583]**。
- 实验门槛：**未达**（唯一 ≥4/9 的 M01 失败主因为已登记口径问题「收窄轮是否必须重新执行」；不启动实验，正常收官）。

## 1. 版本与修订（读数，非推断）

- 模型：step-3.7-flash（main=worker；gateway host 见 run manifest，本文不展开）。
- 代码：branch=arch/r3-b2，head=e741fc83426fc562edb926666a07e34a1499b423，dirty=false（baseline manifest）。
- suite lock：criteriaSha256=9d4b0824a429658e7f633ff8af928fd3ad94b633f02c95f151866679bb8d6cd4，casesSha256=29ef794e82ef05f39bd91b7b7d46fe7f828d3452e8cca287c6ae7ab6e9d2f7c6（与 manifest 一致）。
- Skill revision（sha256）：`.agents/agents/fshine-main/agent.md` = a5bba051…；`scripts/eval/fixtures/dummy-platform/.agents/skills-serve/dummy-routing/SKILL.md` = c5aea97a…。
- 判定器：convergence-r1.judge.1（冻结判据，未改）。

## 2. 命令（逐字）

```bash
# 基线（63 run）
LLM_MODEL=step-3.7-flash npm run eval:user -- --suite scripts/eval/exploration/scope-reference --trials 9 --out-dir .runtime/exploration-b2/baseline

# 扩展（M01；对 trial=10..15 各一次，共 6 run）
LLM_MODEL=step-3.7-flash npm run eval:user -- --suite scripts/eval/exploration/scope-reference --case M01 --trial <10..15> --out-dir .runtime/exploration-b2/extension

# 质量报告 v1（基线）与扩展合并视图（统计以 15 计；combined 为 symbolic link 组合，原两段保留）
node --import tsx scripts/eval/exploration/stats.ts report --run .runtime/exploration-b2/baseline --out .runtime/exploration-b2/quality-report-v1.md
node --import tsx scripts/eval/exploration/stats.ts report --run .runtime/exploration-b2/combined --out .runtime/exploration-b2/quality-report-v1-extension.md
```

## 3. 逐单元结果（基线 N=9）

| 单元 | k/N | Wilson 95% CI | 失败 trial | 失败码分布 | 证据路径（相对 baseline/） |
| --- | --- | --- | --- | --- | --- |
| M01 | 4/9 | [0.189, 0.733] | 2,4,5,7,8 | FAIL_ZERO_EXECUTION×5 | runs/M01/trial-* |
| M02 | 8/9 | [0.565, 0.980] | 7 | FAIL_STATE_INCONSISTENCY×1 | runs/M02/trial-* |
| M03 | 8/9 | [0.565, 0.980] | 4 | FAIL_WRONG_OBJECT×1 | runs/M03/trial-* |
| M04 | 9/9 | [0.701, 1.000] | — | — | runs/M04/trial-* |
| M05 | 8/9 | [0.565, 0.980] | 8 | FAIL_UNNECESSARY_DELEGATION×1 | runs/M05/trial-* |
| M06 | 9/9 | [0.701, 1.000] | — | — | runs/M06/trial-* |
| M07 | 8/9 | [0.565, 0.980] | 7 | FAIL_NEEDLESS_CLARIFICATION×1、FAIL_STATE_INCONSISTENCY×1、FAIL_ZERO_EXECUTION×1 | runs/M07/trial-* |

耗时与规模（轮内合计；逐 trial 明细见各 meta.json）：M01 122.4s / M02 128.3s / M03 160.0s / M04 85.9s / M05 127.4s / M06 135.5s / M07 264.8s；token 合计 376,555。

## 4. 扩展（预注册规则命中与结果）

- 触发：M01 4/9 的 CI 跨 0.5（全批唯一命中；规则=Batch 2 预注册，扩展成本 6 run ≤24）。
- 结果（trial 10–15，单独目录）：trial-12 PASS，trial-10/11/13/14/15 FAIL。
- 合并 N=15：**5/15，CI [0.152, 0.583]**；失败码分布：FAIL_ZERO_EXECUTION×10、FAIL_NO_DELEGATION×1、FAIL_STATE_INCONSISTENCY×1、FAIL_WRONG_OBJECT×1；轮内合计 61.8s（6 run），token 26,741。
- 说明：统计以 15 计；原 9 与扩展 6 均为原始证据，未改写。

## 5. 失败模式登记（按证据）

- **M01（9/10 次失败）**：收窄轮（t2）零新执行、复用 t1 上下文作答（t1 两集合均已执行）。目标失效形态「回退宽范围」在 15 次运行中未出现（无 FAIL_WRONG_OBJECT）；本形态属实施阶段已登记的口径问题（收窄轮是否必须重新执行一次），等待裁定。
- **M01 ext-10（1 次）**：两轮均零委派零执行、以澄清代替执行（FAIL_NO_DELEGATION/WRONG_OBJECT/STATE_INCONSISTENCY/ZERO_EXECUTION）——与历史「先澄清」方差同族，非本单元目标形态。
- **M02-7**：两轮均正确执行（W1+W2 各 1 行），t1 回复未含数据数值（硬锚点缺失 → FAIL_STATE_INCONSISTENCY）——交付形态弱项，登记。
- **M03-4**：扩散实录：查询 beta/alpha 两域 + 自造名（beta-test / beta-group / alpha-beta）共 7 行 → FAIL_WRONG_OBJECT（正是本单元目标形态；1/9）。
- **M05-8**：t2 猜测指代并重新执行 documents（总执行 2 > 硬上界 1）→ FAIL_UNNECESSARY_DELEGATION（正是本单元目标形态；1/9）。
- **M07-7**：t4 未落实新默认（零执行 + 追问窗口）→ FAIL_ZERO_EXECUTION / FAIL_NEEDLESS_CLARIFICATION / FAIL_STATE_INCONSISTENCY（目标形态；1/9；同一 trial 的 t1 安装轮出现 2 行执行，登记）。

## 6. 实验门槛评估（预注册口径）

- **met=false（不做实验，正常收官）**。
- reason：唯一 ≥4/9 的单元是 M01（5/9；扩展后 10/15）；其失败主因（9/10）为「收窄轮复用上下文不再执行」，判负成立与否取决于待裁定口径（M01 t2 是否要求落实一次窄执行），在裁定前不满足「非口径/基建」条件。其余单元失败率均 <4/9（M02/M03/M05/M07 各 1/9；M04/M06 0/9）。
- hypothesis：无满足条件的最小假设（把「收窄轮必须重查」写成 Skill/Prompt 不是用户级改进的合理假设；更合理路径是先裁口径/按流程重切用例）。
- cells：空。候补触发器：若 owner 裁定 M01 口径有效（t2 必须落实一次窄执行）且确认最小假设，再按预注册实验规格启动（pre N=9 + post N=9 + 复核员新探针 ≥2×3 + E06/E12×3 + E01–E12 全量回归；E09/E10/E11 任一失败即不保留）。

## 7. 口径限制

- N=9（扩展 15）为小样本；CI 只量化抽样不确定性；不得把 9/9 读作 100%（如 M04/M06）。
- 单次失败仅为频率观察（1/9），非稳定性结论；失败样本全量保留、未重跑、未筛。
- 组合视图（以 15 计）为 symbolic link 组合；原始两段证据未改写。
- 本报告数字全部来自本批实跑（manifest / summary / judgment 与 stats.ts 输出）；前阶段 smoke 样本保留于 `.runtime/r3-b2/smoke/`，不计入本报告统计。
