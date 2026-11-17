# R4 · 稳定性加固报告（2026-11-14）

> 授权：owner 2026-11-14（1+2）——预注册更大黑盒批次（E05/E06/后台 E2E 各 N=15）+ 浸泡/压力/混沌套件 + 手工测试手册。
> 基线：`arch/integration @ 885ac638f2353be41e651f1ea3eb9199d905017b`；worktree `~/projects/fshine-agent-r4-stab`；分支 `arch/r4-stab`。
> 提交链：`adf8173`（预注册，先于任何运行）→ `99bd5f0`（套件先在红）→ `b191f45`（harness 转绿 + P5 单一配置源登记）→ 本 docs 提交。
> 纪律：纯测试与文档、**零产品语义变更**；判据/用例/冻结面/历史证据零改动；不接真实平台；k/N 一律附 Wilson 95% CI（`scripts/eval/exploration/stats.ts` `wilson95`）；**只读数，不作「稳定/达标」结论**。
> 预注册：`docs/product/r4-stability-prereg.md`（运行前写死）；手工手册：`docs/product/manual-test-handbook.md`。

## 一、回归门（实跑，HEAD `b191f45`）

| 门 | 命令 | 读数 | 证据 |
| --- | --- | --- | --- |
| typecheck | `TMPDIR=~/.tmp npx tsc --noEmit` | **exit 0** | `.runtime/stab/final-tsc.txt` / `green-tsc.txt` |
| 全量 unit（只增不减） | `TMPDIR=~/.tmp npm test` | **58 文件 / 603 例全绿**（启动基线 55/594 → +3 文件/+9 例，无删减、无弱化既有断言） | `.runtime/stab/final-full.txt` / `green-full.txt` |
| 套件复跑 | `TMPDIR=~/.tmp npx vitest run scripts/stab/soak.test.ts scripts/stab/pressure.test.ts scripts/stab/chaos.test.ts` | **3 文件 / 9 例全绿**（连续 4 轮一致） | `.runtime/stab/final-suites.txt` / `green-suites.txt` |

## 二、黑盒批次（真实模型 `step-3.7-flash` + 集成 Runtime + 仓内 dummy；N=15 预注册）

口径：模型 `step-3.7-flash`（baseUrlHost api.stepfun.com，keyPresent true）；git HEAD `b191f45`（dirty=false）；`criteriaSha256=9d4b0824…`、`casesSha256=6d55a42a…`（与 P7b 同，冻结零改动）；judgeVersion `convergence-r1.judge.1`。

| 批次 / 指标 | k/N | Wilson 95% CI | 归因 |
| --- | --- | --- | --- |
| E05（歧义/必要澄清） | 12/15 | [0.548, 0.930] | 3 例 FAIL（trial 3/4/13，FAIL_NO_DELEGATION/FAIL_WRONG_OBJECT/FAIL_ZERO_EXECUTION 同形态）＝**模型面**：`toolcalls.jsonl`=0 行、`executions.json` tasks=[]、回复为反问（如 trial-3「您提到的 contoso 是指什么…」），未委派、零执行；12 例 PASS 的 toolcalls=2 |
| E06（缺参数/必要澄清） | 15/15 | [0.796, 1.000] | 无 FAIL（不得读作 100%） |
| 后台 E2E·delegated | 15/15 | [0.796, 1.000] | 机械面 |
| 后台 E2E·completed | 15/15 | [0.796, 1.000] | 机械面 |
| 后台 E2E·resultText 可找回 | 15/15 | [0.796, 1.000] | 详情 + `tasks` CLI |
| 后台 E2E·通知三态送达 | 15/15 | [0.796, 1.000] | accepted/started/completed 全 deliveredAt + 假 sink 实收三类 |
| 后台 E2E·mechanicalPass | 15/15 | [0.796, 1.000] | 上四项合取 |
| 后台 E2E·回执含 #编号（观察） | 8/15 | [0.301, 0.752] | 措辞面，不设门槛 |
| 后台 E2E·复述业务名（观察） | 0/15 | [0.000, 0.204] | 措辞面，不设门槛 |
| 后台 E2E·含「已受理」（观察） | 11/15 | [0.480, 0.891] | 措辞面，不设门槛 |

产物：`.runtime/stab/e05/`、`.runtime/stab/e06/`（`runs/E05|E06/trial-1..15/` 逐样本落盘）、`.runtime/stab/background-e2e/`（`run-1..15/sample.json` + `samples.jsonl` + `summary.json`，harness 版本 `stab-background-e2e-v1`）；汇总 `.runtime/stab/batch-summary.md`。

## 三、浸泡 / 压力 / 混沌读数（确定性假件；阈值＝预注册 §四）

| 场景 | 关键读数 | 阈值判定 |
| --- | --- | --- |
| S1 持续 10×50 | 提交/受理/拒绝 500/500/0；completed 500；openOnDrain 0；重复副作用 {}；未送达 0；RSS +6.22% | 全守（I1–I5） |
| S2 浸泡 × 通知间歇失败（每 3 次） | 500/500/0；completed 500；未送达 0；RSS +1.85% | 全守 |
| P1 积压 500（受控排队） | 500/500/0；completed 500；未送达 0；队列观察 policy=0 / ledger=498（只读） | 全守 |
| P2 池满持续（cap 0） | 受理 1 / 拒绝 499；completed 1 + failed 499（全部 `resource_limited`）；前台探针 1 次可用；未送达 0 | 全守 |
| P3 压力 × 通知间歇失败（每 5 次） | 500/500/0；completed 500；未送达 0；RSS +0.12% | 全守 |
| C1 重启 × 通知失败 | completed 19 + failed 1（result_unknown）；已完成零重放；过期租约零重放；通知行无重复；未送达 0；无挂死 | 全守 |
| C2 重启 × 重复消息 | 回执幂等重放 true；重复消息新增任务 0 / 新增执行 0；重启不重放已完成；未送达 0 | 全守 |
| C3 取消 × 通知失败 | 取消确认 true（终态 cancelled，非 cancelling 滞留）；无二次执行；cancelled 通知恢复后送达；未送达 0 | 全守 |
| C4 全组合（重启×通知失败×重复×取消） | 提交 31：completed 29 + failed 1 + cancelled 1；回执幂等 true；重复新增任务/执行 0；取消确认 true；零重放；通知无重复；未送达 0；无挂死 | 全守（I1–I5） |

> RSS 口径：基线取预热＝前半程 cycles（per-cycle 剖析显示增长集中在前几 cycle 后进入稳态），阈值 `<10%` 逐字取自预注册。**无任何场景命中阈值 → 未发现产品机械面缺陷。**

## 四、反向绊线（4 类；临时破坏 → 对应套件红 → 逐字节复原）

| # | 破坏点 | 红跑读数 | 证据 |
| --- | --- | --- | --- |
| 1 | `apps/server/server.ts` 关同 messageId 查重 | chaos `2 failed \| 2 passed`（C2/C4 `tasksCreatedByDuplicate`=1） | `.runtime/stab/tripwire-1-run.txt` |
| 2 | `packages/agent/src/task-runner.ts` 取消不发起 abort | chaos `2 failed \| 2 passed`（C3/C4 `cancelledConfirmed`=false） | `.runtime/stab/tripwire-2-run.txt` |
| 3 | `packages/agent/src/notifications.ts` 成功不写 `delivered_at` | chaos+soak `6 failed`（未送达>0） | `.runtime/stab/tripwire-3-run.txt` |
| 4 | `packages/agent/src/task-registry-sqlite.ts` 过期租约不处置 | chaos `3 failed \| 1 passed`（C1/C2/C4 `openOnDrain`=1） | `.runtime/stab/tripwire-4-run.txt` |

复原：逐文件 `git checkout --`；`grep -rn TRIPWIRE packages apps scripts` = 0；`git status` 仅提交面文件。详见 `.runtime/stab/tripwire-summary.md`。

## 五、发现的缺陷登记（不修）

- **产品机械面缺陷：无。** 浸泡/压力/混沌全部阈值未命中（§三）；黑盒机械面 E06/后台 E2E 无 FAIL。
- **模型面观察（非产品缺陷，只登记）**：E05 3/15 未委派先澄清（`toolcalls`=0）；后台 E2E 回执业务名复述 0/15、含 #编号 8/15。属模型措辞/委派行为波动，改进需另行 Eval 归因 + owner 裁定（提示词补丁属 A 类），**本 Run 不修**。
- **测试基建调整（非产品语义）**：① 3 个 harness 登记进 P5 单一配置源守卫的所有者表（守卫设计即「新增读者必须登记」；harness 只构造测试场景 RuntimeConfig 输入）；② RSS 基线取预热＝前半程 cycles；③ C1/C3 把注入时钟对齐真实时钟（底账租约以系统时钟落库，注入时钟须在其之后才能判定过期）。均在 `.runtime/stab/` 与提交信息登记。

## 六、blocked 审计（不计入通过）

| blocked 项 | 事实 | 解除条件 |
| --- | --- | --- |
| `queueCapacity>0` 底账队列上界未强制 | policy 排队许可与底账 queued 行未合一（P7b §五登记；触冻结 §2 接口） | policy 侧裁决面扩展 + owner 批准 |
| messageId 幂等跨重启/多实例不保持 | 进程内有界 FIFO（1024） | 持久幂等键（新 schema/机制，owner 决定） |
| cancelling 孤儿恢复 / waiting_user 无租约接续 / queued·waiting_user 超时计时触发 | P6 §七遗留 | 后续切片（P5/P2 边界） |
| `taskBudget` 运行时 consume 未接线 | 集成报告 §四.3 | 预算计量点接线（P5 边界） |
| 真实 WeCom sink 投递 | 适配器不实现、不连接；通知一律假 sink | 渠道适配器切片（新授权） |
| 多进程/多实例、ops 通知投递清单/执行树完整面 | 单实例登记 | ops/多实例立项 |
| 手工手册的真机走查 | 手册已交付（`docs/product/manual-test-handbook.md`），**本轮未执行人工走查** | 按手册由人工执行并记录 |

## 七、限制

- N=15 为预注册小样本：CI 宽（15/15 下界 0.796；E05 [0.548,0.930] 跨 0.5），**不得据此区分真实水平或判「稳定」**；禁止重采样至绿。
- 未与历史帧对照（未预注册等效界）→ 不产出 IMPROVED/REGRESSED 结论。
- 措辞观察单语料（一条交办请求）、单模型、单窗口，不推广。
- 浸泡/压力/混沌为确定性假件（无真实模型/平台）；真实渠道语言面 blocked。
- 手工手册的判定口径是「通过/不通过/存疑」，不替代自动化门。

## 八、证据索引（`.runtime/stab/`，gitignored）

- 环境/提交：`baseline.txt`、`commits.txt`。
- 回归门：`final-tsc.txt`、`final-full.txt`、`final-suites.txt`、`green-*`、`red-*`。
- 套件读数：`readings.json`、`probe-readings.ts`；绊线 `tripwire-1..4-run.txt`、`tripwire-summary.md`。
- 黑盒：`e05/`、`e06/`、`background-e2e/`、`e05-run.log`、`e06-run.log`、`background-e2e-run.log`、`e05-report.md`、`e06-report.md`、`batch-summary.md`、`background-e2e.ts`。

## 九、回退

- **提交级**：`git revert b191f45`（仅测试基建：4 个 harness + P5 守卫登记），无产品代码；预注册/报告文档可单独 revert。
- **行为级**：零产品语义变更，无 schema 迁移；回退后 inline/产品路径完全不变。
- **证据级**：`.runtime/stab/` 整体 gitignored，可删除/重跑；重跑即新批次，须重新标注口径（不得冒充本次 N=15）。
