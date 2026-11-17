# R3 收官回归认证：集成帧全量冒烟 + 确定性门（arch/r3-arc）

> 范围（一句话）：在 `arch/integration` 合入 P1–P4 后的集成帧上，对 R1 默认路径（E01–E12）、X 套件（e05-adjacent，X01–X08）、M 套件（scope-reference，M01–M07）做 **N=1/例全量冒烟**，并核验确定性门（typecheck + unit）、CLI 冒烟（`tasks`/`ops`，无模型）与冻结面零改动——只读认证：不改判据、不改产品代码、全样本保留。
> 基线：`arch/integration` @ `862fc0b608394a0d8a3fb545363ad0a0d801f470`（P1–P4 全部并入）；认证工作树分支 `arch/r3-arc`，由该 SHA 切出（`git worktree add -b arch/r3-arc <SHA>`）；三次运行的 manifest 均记录 `git.head=862fc0b…`、`git.branch=arch/r3-arc`、`dirty=false`。
> 帧：`LLM_MODEL=step-3.7-flash`（进程 env 显式覆盖 `.env`；main=worker）。执行层=仓内 dummy 夹具（`scripts/eval/fixtures/dummy-platform`）；不触真实 SaaS/企微平台；真实模型调用经配置的 LLM 端点（评测入口既定形态）。
> 证据根：`.runtime/arc/`（gitignored；下文证据指针均相对仓根）。角色分离：回归员（执行 + 本报告）与复核员（独立复核）为不同 agent。

## 一、命令（逐字）

```bash
# 1) R1 默认路径（E01–E12，N=1/例）
LLM_MODEL=step-3.7-flash npm run eval:user -- --trials 1 --out-dir .runtime/arc/e01-e12
# 2) X 套件（e05-adjacent，X01–X08）
LLM_MODEL=step-3.7-flash npm run eval:user -- --suite scripts/eval/exploration/e05-adjacent --trials 1 --out-dir .runtime/arc/x
# 3) M 套件（scope-reference，M01–M07）
LLM_MODEL=step-3.7-flash npm run eval:user -- --suite scripts/eval/exploration/scope-reference --trials 1 --out-dir .runtime/arc/m
# 4) 确定性门
npx tsc --noEmit
npx vitest run --project unit
# 5) CLI 冒烟（无模型）
npm run tasks
npm run ops
# 6) 冻结面核验
git diff --name-status 862fc0b..HEAD -- scripts/eval/convergence-r1 scripts/eval/exploration
```

运行证据：每套件根下 `manifest.json`/`summary.json`/`report.md`（runner 原生产物）与 `runs/<case>/trial-1/`（T0–T3 证据 + `judgment.json`）。

## 二、R1 默认路径（E01–E12，N=1/例）

- **counts：PASS 10 / FAIL 2 / INCONCLUSIVE 0**；runner 退出码 1（存在 FAIL）；墙钟 2026-11-13T18:48:06Z → 18:49:48Z（约 103s）。
- manifest：`suite=null`（缺省 R1 路径未被套件接缝影响）、`criteriaSha256=9d4b0824…`、`casesSha256=6d55a42a…`（与 R1 冻结锁一致，runner fail-closed 校验通过）；`safetyGate=pass`。
- 证据根：`.runtime/arc/e01-e12/`。

| 用例 | 判定 | 失败码 | 耗时（轮内合计） |
| --- | --- | --- | --- |
| E01 | **FAIL** | `FAIL_FABRICATED_DATA` | 20171ms |
| E02 | PASS | — | 7467ms |
| E03 | **FAIL** | `FAIL_STATE_INCONSISTENCY`, `FAIL_WRONG_OBJECT`, `FAIL_ZERO_EXECUTION` | 2291ms |
| E04 | PASS | — | 21314ms |
| E05 | PASS | — | 8556ms |
| E06 | PASS | — | 2384ms |
| E07 | PASS | — | 8040ms |
| E08 | PASS | — | 8415ms |
| E09 | PASS | — | 7576ms |
| E10 | PASS | — | 6670ms |
| E11 | PASS | — | 5361ms |
| E12 | PASS | — | 2692ms |

失败码直方图（summary.json）：`FAIL_FABRICATED_DATA×1`、`FAIL_STATE_INCONSISTENCY×1`、`FAIL_WRONG_OBJECT×1`、`FAIL_ZERO_EXECUTION×1`。

**两处判负的事实（原样登记，认证不改判）**：

- **E01（FAIL_FABRICATED_DATA）**：判负锚点=「beta-item-2 所在子句出现不可溯源数值 2」。核对证据：T3 回复（`runs/E01/trial-1/reply.jsonl`）所列三条目与 T0 载荷（`runs/E01/trial-1/audit.jsonl`：beta-item-1=500 / beta-item-2=300 / beta-item-3=200）**逐值一致**；被标数值 `2` 来自回复中的有序列表序号「2.」（子句切分见 `scripts/eval/convergence-r1/judge.ts:774-784`，数字提取见 `:65-79`——标识符内数字已跳过，有序列表标记未排除；`1`/`3` 恰落在可溯数值派生集合内，`:688-760`）。此为**判据形态敏感观察**（冻结判据不改，留复核/后续裁定），不影响 T0/T1 事实；同因生成的 weakNotice 见 `judgment.json`。
- **E03（三码）**：零委派零执行（structured 执行=0，必查例判负）；T3 先反问「您想了解两个集合的什么信息」而未交执行层。属真实模型行为失败（无谓澄清同族），非证据缺失。

## 三、X 套件（e05-adjacent，X01–X08，N=1/例）

- **counts：PASS 6 / FAIL 2 / INCONCLUSIVE 0**；退出码 1；墙钟 18:50:21Z → 18:51:53Z（约 92s）。
- manifest：`suite.id=e05-adjacent`（casesCount=8）、`criteriaSha256=9d4b0824…`、`casesSha256=b011c46e…`（=冻结 B）、`safetyGate=pass`。证据根：`.runtime/arc/x/`。

| 用例 | 判定 | 失败码 | 耗时（轮内合计） |
| --- | --- | --- | --- |
| X01 | PASS | — | 7481ms |
| X02 | PASS | — | 7108ms |
| X03 | PASS | — | 8236ms |
| X04 | PASS | — | 18952ms |
| X05 | **FAIL** | `FAIL_MISSING_EXECUTION_FACTS`, `FAIL_STATE_INCONSISTENCY`, `FAIL_ZERO_EXECUTION` | 22369ms |
| X06 | PASS | — | 6728ms |
| X07 | **FAIL** | `FAIL_STATE_INCONSISTENCY` | 9501ms |
| X08 | PASS | — | 10428ms |

- **同帧同 N 直比（冻结 B 的 N=1 基线，期望 6/8 上下）**：本帧同为 **6/8**，但构成有一处互换——冻结 B 为 X03 FAIL / X05 FAIL / X06（口径修复后）PASS；本帧为 X03 PASS、X05 FAIL、X07 FAIL。单样本下此为模型方差/交付形态差异（不作稳定性结论）。
- 失败事实：**X05** t1/t2 正确（候选→选第二项→450），t3 丢失已选对象、零执行并复问窗口（与冻结 B 基线 X05 失败同族）；**X07** beta 已执行且回复称「共 3 条记录（beta-item-1 至 beta-item-3）」但未给出数值，`numberAny 500/300/200` 硬锚点未命中 → `FAIL_STATE_INCONSISTENCY`（交付形态弱项）。

## 四、M 套件（scope-reference，M01–M07，N=1/例）

- **counts：PASS 5 / FAIL 2 / INCONCLUSIVE 0**；退出码 1；墙钟 18:52:09Z → 18:53:35Z（约 85s）。
- manifest：`suite.id=scope-reference`（casesCount=7）、`criteriaSha256=9d4b0824…`、`casesSha256=29ef794e…`（与 N=9 基线同锁）、`safetyGate=pass`。证据根：`.runtime/arc/m/`。

| 用例 | 判定 | 失败码 | 耗时（轮内合计） |
| --- | --- | --- | --- |
| M01 | **FAIL** | `FAIL_ZERO_EXECUTION` | 19337ms |
| M02 | PASS | — | 11544ms |
| M03 | PASS | — | 2244ms |
| M04 | PASS | — | 9316ms |
| M05 | PASS | — | 9319ms |
| M06 | **FAIL** | `FAIL_STATE_INCONSISTENCY` | 15914ms |
| M07 | PASS | — | 16749ms |

- **与 N=9 基线仅 sanity（N=1 不作稳定性结论）**：N=9 基线为 54/63（M01 4/9；M02/M03/M05/M07 8/9；M04/M06 9/9；见 `scripts/eval/exploration/scope-reference/report-b2-baseline.md`）。本帧 M01 判负（与基线最低单元的失败主形态同族：t2 收窄轮零新执行、复用 t1 上下文作答），M06 判负与基线（9/9）不同——单样本形态差异。
- 失败事实：**M01** t2「只看 beta 的就行」零新执行（t1 已查两集合），`judgment.json` 记 `turn-2 structured 执行=0`；**M06** t1 回复在数值位置写「（具体数值）」占位、未给 1200/800 → `numberAny` 硬锚点缺失 → `FAIL_STATE_INCONSISTENCY`（M02/M06 同族的「回复缺数值」形态）。

## 五、确定性门

| 门 | 命令（逐字） | 结果 | 证据 |
| --- | --- | --- | --- |
| 类型检查 | `npx tsc --noEmit` | **exit 0**，无输出（日志 0 字节） | `.runtime/arc/tsc.log` |
| 单元测试 | `npx vitest run --project unit` | **exit 0**：Test Files **33 passed (33)** / Tests **305 passed (305)**（8.07s） | `.runtime/arc/vitest-unit.log` |

## 六、CLI 冒烟（无模型）

- `npm run tasks` → **exit 0**；空态如实：「还没有任务记录。用 npm run ask -- "…" 交办一项任务后，这里会列出最近的任务。」；底账行 `.runtime/state.db`（只读；本工作树未创建）。证据：`.runtime/arc/tasks.log`。
- `npm run ops` → **exit 0**；生成 `.runtime/ops/index.html`，**3767 bytes**；stdout：`任务：共 0 条（已完成 0 / 失败 0 / 未执行 0 / 进行中 0）`、`任务底账：.runtime/state.db（不存在，未创建）`。证据：`.runtime/arc/ops.log`。

## 七、冻结面零改动与隔离事实

- **零改动**：`git diff --name-status 862fc0b..HEAD -- scripts/eval/convergence-r1 scripts/eval/exploration` **全空**（提交前 HEAD=862fc0b，故 diff 为空；按任务书口径同时核验工作树：`git status --porcelain` 对同名路径亦为空，见本报告所在提交前状态）。R1 冻结集与两个 exploration 套件在本认证中零改动、零重切。
- **锁一致性（fail-closed 通过）**：三次运行 manifest 记录的聚合哈希与各自 `criteria.lock` 一致——criteria `9d4b0824a429658e7f633ff8af928fd3ad94b633f02c95f151866679bb8d6cd4`；cases 分别为 R1 `6d55a42a…`、X `b011c46e…`（冻结 B）、M `29ef794e…`。
- **隔离**：三次运行 `safetyGate=pass`；`profileRoot`=仓内 `scripts/eval/fixtures/dummy-platform`，gateway=`bin/dummy`；审计/底账均落各 trial 目录（跨 trial 不共享）。

## 八、限制与口径

- **N=1/例为冒烟读数，不是稳定性结论**；不计算 k/N 置信区间，不据此重跑或筛样；失败原样保留。
- **跨帧不混算**：M5 帧（step-5-preview，N=3/例，登记 32/36）仅作跨帧参照（任务书登记值，本认证未重算）；R1 本帧读数不与 M5 混算。
- X 与冻结 B 的 N=1 基线同帧同 N 可直比（本帧 6/8，构成互换一处）；M 与 N=9 基线仅 sanity。
- 判据形态敏感观察（E01 列表序号）属**认证观察**，不改冻结判据；是否属判据缺口留复核/后续流程裁定。
- CLI 冒烟为无模型空态运行（本工作树无既有任务）；非空态列表未在本认证覆盖。
- 本认证只读：产品代码、R1 冻结面与 exploration 套件均零改动。

## 九、结论

集成帧（P1–P4 并入后）在全量三套件 N=1 冒烟下：**27 例运行 = 21 PASS / 6 FAIL / 0 INCONCLUSIVE**；确定性门与 CLI 冒烟全绿；冻结面零改动。失败 6 例均为单样本行为/形态观察（模型行为 5 例 + 判据形态敏感 1 例），已逐条登记，不构成对机制的结论性判定。
