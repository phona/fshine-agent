# scope-reference 套件（R3 Batch 2 · 多轮查询的作用域与指代决策）

本目录承载 **Batch 2 行为矩阵定稿用例**：M01–M07（多轮会话中的作用域收窄/换窗/模糊范围/
无新请求/模糊指代/改口/持续默认）。套件不进入 R1 冻结集（`scripts/eval/convergence-r1/`
的 criteria / cases / judge / criteria.lock 零改动），只复用其 harness 与判定器。

- 是：真实模型（step-3.7-flash 帧）+ 仓内 dummy 夹具 + R1 同款 T0–T3 证据 + R1 判定器；
- 不是：不新增判定能力、不做模型自评、不替代 R1 冻结套件；
- 事实边界：仅使用 dummy 既有集合/窗口/条目（alpha / beta / documents），不新增执行层能力与期望数据。

## 三命令（最小实现）

```bash
# ① 跑指定能力域 eval（冒烟：单例单 trial；完整采样：--trials 9，7 单元合计 63 run，见批次预注册）
LLM_MODEL=step-3.7-flash npm run eval:user -- --suite scripts/eval/exploration/scope-reference --case M01 --trial 1 --out-dir .runtime/r3-b2/smoke

# ② 查看上一轮对照（双臂 k/N + Wilson 95% CI + Δ + 三态；INSUFFICIENT_SAMPLES / IMPROVED / NO_MEANINGFUL_CHANGE）
node --import tsx scripts/eval/exploration/stats.ts compare --a <dirA> --b <dirB> --out <file>

# ③ 生成质量与覆盖报告（版本段 / 单元段 / 安全段）
node --import tsx scripts/eval/exploration/stats.ts report --run <dir> --out <file>
```

`stats.ts` 为纯只读工具：不跑模型、不触网；k/N 一律附 Wilson 95% CI（不得解读为稳定概率）；
任一臂 N<9 → INSUFFICIENT_SAMPLES；`--out` 省略时写 stdout。

## 冻结

```bash
node --import tsx scripts/eval/exploration/freeze.ts scripts/eval/exploration/scope-reference
```

生成/更新本套件自己的 `criteria.lock`（cases 与共享判定面的 sha256；运行时只比两个聚合值，
fail-closed）。冻结后 cases 不得再改；要改先重切并保留旧 run 证据。

## 用例清单（M01–M07）

| id | 标题 | 输入要点 | 判定核心 |
| --- | --- | --- | --- |
| M01 | 惯性扩散（宽历史→窄新指令） | alpha+beta 都查 →「只看 beta 的就行」 | 交付导向（2026-11-14 重切）：t2 复用可接受，须交付 500/300/200；t2 执行只准 beta；alpha 行 = 回退宽范围 |
| M02 | 换窗口不复读 | alpha W1 →「换 W2 窗口看一下」 | 每窗口恰一次；总执行硬上界 2 |
| M03 | 模糊范围（禁止扩散） | 「跟 beta 相关的数据都看一下」 | 零执行澄清或仅 beta；任何非 beta 执行行 = 错对象 |
| M04 | 无新请求（纯确认） | beta 查询 →「好的，谢谢」 | 全会话恰一次执行；t2 重放 = 超界 |
| M05 | 模糊指代（必须请示） | documents 查询 →「那个东西呢？」 | 全会话恰一次执行；替猜/重放 = 超界 |
| M06 | 明确最终命令/改口（R-10） | alpha 查询 →「不对，是 beta，就按 beta 来」 | t2 只准 beta；沿用旧对象 = 判负 |
| M07 | 持续指令代际 | 装默认 W202611 → 查 → 换默认 W202610 → 查 | t2 带 W202611、t4 带 W202610（旧默认不得残留） |

逐条的允许/禁止/预期执行事实与判定面字段见 `cases/M*.ts` 的注释与 `weakNotes`/`judgeNotes`。
纪律：全样本保留、不筛绿；失败原样登记；k/N 均附 Wilson 95% CI。

## 基线采样（2026-11-13，帧 step-3.7-flash）

63 run（M01–M07 × 9）= 54 PASS / 9 FAIL；M01 命中预注册扩展规则（CI 跨 0.5）一次性扩到
N=15（+6 run，原 9 保留）→ 5/15；实验门槛未达（唯一 ≥4/9 单元 M01 的失败主因属待裁定口径）。
详见 `report-b2-baseline.md`（证据在 `.runtime/exploration-b2/`，gitignored）。

## 重切（2026-11-14，交付导向/复用豁免）

R3 收官裁定 M01=a（`docs/product/r3-open-decisions.md` §A.1）：t2 改为**交付导向**——允许复用同一
任务上下文内已获得、仍然有效的查询事实（不得为凑工具调用次数重复执行；明确刷新/数据可能过期/
来源不可信时不适用）。casesSha256 `29ef794e…`→`617eb97f…`；旧 15 样本复判 14/15（唯一 FAIL=旧
trial-10）；新跑 N=9 = 8/9。详见 `docs/product/m01-recut.md`；旧锁保底 `criteria.lock.pre-m01recut`
（未跟踪）。
