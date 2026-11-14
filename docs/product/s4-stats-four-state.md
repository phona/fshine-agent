# S4 · 统计四态（stats.ts v2 口径）

> 性质：eval 维护轨切片（owner 2026-11-14 排程裁定：S4 即刻启动、与 P0 并行）。
> 依据：`docs/product/r4-slice-plan.md` S4（用户任务/范围/验收）+ `docs/product/r4-acceptance.md`
> 黑盒验收口径（四态 + 预注册等效界）+ `docs/product/r4-slices.md` §S4。
> 改动面：`scripts/eval/exploration/stats.ts`、统计单测 `scripts/eval/exploration/stats.test.ts`、本文件。
> 不碰 `criteria.lock`、cases、judge、runner、safety-gate、历史 `.runtime` 证据与历史报告；不新增依赖。

## 一、用户任务（研发侧）

比较结论必须区分 **改善 / 退化 / 证据不足 / 经验证的无实质变化**。三态口径把 CI 重叠统称
`NO_MEANINGFUL_CHANGE`，容易被读成「已证明无改善」；四态升级后：

- `NO_MEANINGFUL_CHANGE` 的语义在 v2 中对应 `INSUFFICIENT_EVIDENCE`（证据不足以判定方向或幅度），**不等于**无变化；
- 只有显式提供**预注册等效界 δ**、且差异区间整体严格落在等效区间内，才允许给出
  `NO_SUBSTANTIAL_CHANGE_VERIFIED`（经验证无实质变化）。

## 二、四态定义（v2）

| 状态 | 含义 | 可达条件 |
|---|---|---|
| `IMPROVED` | 改善 | 差异区间整体 > δ（未提供 δ 时为整体 > 0） |
| `REGRESSED` | 退化 | 差异区间整体 < −δ（未提供 δ 时为整体 < 0） |
| `NO_SUBSTANTIAL_CHANGE_VERIFIED` | 经验证无实质变化 | **仅在提供 δ 时**：差异区间整体严格落在 (−δ, δ) 内 |
| `INSUFFICIENT_EVIDENCE` | 证据不足 | 其余全部：任一臂 N<9；无 δ 且区间跨/触 0；有 δ 且区间跨界/触界/方向未定 |

判定细节（均为纯函数，见 `classifyDifference` / `classifyV2`）：

- **边界一律严格**：触界（`lower == −δ`、`upper == δ`、区间端点 == 0）不算达成结论，一律 fail-closed 到
  `INSUFFICIENT_EVIDENCE`；
- **方向也以 δ 为准**（有 δ 时）：`lower > δ` 才算 `IMPROVED`，`upper < −δ` 才算 `REGRESSED`；
  区间（0.05, 0.30）配 δ=0.1 这类「方向明确但幅度不足以越过界」的情况记 `INSUFFICIENT_EVIDENCE`；
- **样本不足归入 `INSUFFICIENT_EVIDENCE`**：v2 四态不再单列 `INSUFFICIENT_SAMPLES`（任一臂 N<9，
  含 N=0）；这与 `r4-acceptance.md` 对 smoke（3 run）标注 `INSUFFICIENT_EVIDENCE` 的用法一致；
- **δ 预注册要求**：δ 必须在使用（对比运行）前由使用方预先登记并写入报告口径，不得事后挑选；
  δ 无默认值、不得编造；未提供 δ 的代码路径结构上不可能产出 `NO_SUBSTANTIAL_CHANGE_VERIFIED`；
- **fail-closed**：非法 δ（≤0 / ≥1 / NaN / ±∞ / 非数）与非法差异区间（非有限数、lower>upper）一律抛错，
  不做静默兜底。

## 三、差异区间方法（确定性标准法）

`newcombe95(a, b)` 输出 Δ = pB − pA 的 95% 差异区间，采用
**Newcombe (1998) 方法 10（square-and-add，无连续性校正）**：以两臂各自的 Wilson 95% 区间
`[lA,uA]`、`[lB,uB]`（z=1.96，与既有 `wilson95` 同源）为原料——

```
lower = Δ − sqrt((pB − lB)² + (uA − pA)²)
upper = Δ + sqrt((uB − pB)² + (pA − lA)²)
```

结果裁剪到 [−1, 1]。方法来源：Newcombe R.G. (1998), *Interval estimation for the difference between
independent proportions: comparison of eleven methods*, Statist. Med. 17:873–890, method 10。
方法锚点（Newcombe Table II 例 1）：A=48/80 vs B=56/70 → 方法 10 区间四位小数 `[0.0524, 0.3339]`；
单测写死的期望值由该方法公式独立计算后固化（独立计算脚本与输出见工作树 `.runtime/s4/newcombe-reference.mjs`、
`.runtime/s4/reference-values.txt`，不进仓库；锚点四位小数与公开表值一致）。

## 四、v1 兼容与口径版本标注

`compare` 命令新增**可选** `--bound <δ>`，两种口径互不混读：

```
node --import tsx scripts/eval/exploration/stats.ts compare --a <dirA> --b <dirB> [--bound <δ>] [--out <file>]
```

- **缺省（未提供 δ）= v1 三态输出**：`INSUFFICIENT_SAMPLES / IMPROVED / NO_MEANINGFUL_CHANGE`，
  既有表头与行格式不变，仅新增「口径版本：v1」标注行（并提示 `NO_MEANINGFUL_CHANGE` 不代表已证明无改善）；
- **提供 δ = v2 四态输出**：新增「口径版本：v2」标注（含 δ、方法名）与
  `Δ 95% CI（Newcombe）` 列，状态列为四态；
- v1 纯函数面（`wilson95` / `classify` / `classifyCIs` 及状态字符串）原样保留，供历史口径复现；
- 非法 `--bound` fail-closed：退出码 2、不写出对比正文（`parseBound` 空串/非数/0/负/≥1/NaN/∞ 均抛错）；
- **历史报告不改写**：本文件与代码只新增口径，不回改既有报告与历史证据。

### 口径对照（v1 ↔ v2）

| 项 | v1（缺省；无等效界） | v2（`--bound <δ>`；显式预注册等效界） |
|---|---|---|
| 状态 | INSUFFICIENT_SAMPLES / IMPROVED / NO_MEANINGFUL_CHANGE | IMPROVED / REGRESSED / INSUFFICIENT_EVIDENCE / NO_SUBSTANTIAL_CHANGE_VERIFIED |
| 样本不足（任一臂 N<9） | INSUFFICIENT_SAMPLES | INSUFFICIENT_EVIDENCE |
| 方向判定 | 两臂 Wilson CI 分离（B 下界 > A 上界 → IMPROVED；只判改善） | Newcombe 差异区间（Δ=pB−pA）整体 >δ → IMPROVED / <−δ → REGRESSED（双向） |
| CI 重叠 / 跨 0 | NO_MEANINGFUL_CHANGE（**≠ 已证明无改善**） | INSUFFICIENT_EVIDENCE |
| 「无实质变化」结论 | 不可达 | 仅在差异区间严格落在 (−δ, δ) 内 |
| 输出 | 表头与行格式原样 +「口径版本：v1」 | 新增 Δ 95% CI（Newcombe）列 +「口径版本：v2（含 δ）」 |

### 用法示例

```
# v1：缺省三态（口径版本：v1）
node --import tsx scripts/eval/exploration/stats.ts compare --a <dirA> --b <dirB>

# v2：显式预注册等效界 δ=0.2（口径版本：v2；四态 + Newcombe 差异区间列）
node --import tsx scripts/eval/exploration/stats.ts compare --a <dirA> --b <dirB> --bound 0.2

# 非法 δ：fail-closed（stderr 报错、退出码 2、不写出对比正文）
node --import tsx scripts/eval/exploration/stats.ts compare --a <dirA> --b <dirB> --bound 1
```

只读干跑样例（历史 run-dir `.runtime/eval-r1/r2-e05-flash37` 与 `r2-e05b-flash37`，E05 0/9 vs 5/9；
两次调用均只读，未写任何文件）：

- v1 行：`| E05 | 0/9（CI [0.000, 0.299]） | 5/9（CI [0.267, 0.811]） | +55.6 | NO_MEANINGFUL_CHANGE |`
- v2 行（δ=0.2）：`| E05 | 0/9（CI [0.000, 0.299]） | 5/9（CI [0.267, 0.811]） | +55.6 | [0.140, 0.811] | INSUFFICIENT_EVIDENCE |`

该例正是 v1/v2 语义差异的典型：v1 的 `NO_MEANINGFUL_CHANGE` 在 v2 中只对应 `INSUFFICIENT_EVIDENCE`
（差异区间下界 0.140 未越过 δ=0.2，既不能宣告实质改善，也不能验证无实质变化）。

## 五、测试与反向绊线

单测：`scripts/eval/exploration/stats.test.ts`（`npx vitest run --project unit scripts/eval/exploration/stats.test.ts`）。

覆盖：Newcombe 锚点与参考向量；四态方向；重叠无界=INSUFFICIENT_EVIDENCE；有界且区间在界内=
NO_SUBSTANTIAL_CHANGE_VERIFIED；触界（上下界）与跨界=INSUFFICIENT_EVIDENCE；非法界/非法区间 fail-closed；
无界不变量扫描（任何臂组合都不得产出 NO_SUBSTANTIAL_CHANGE_VERIFIED）；v1 面保持；renderCompare 行级
标注（缺省 v1 / 有界 v2）；CLI 端到端（v2 有界输出、缺省 v1、非法界退出码 2）。

反向绊线（故意破坏必须红，证据 `.runtime/s4/tripwire-*.txt`）：

1. 给 δ 编造默认值（无界也进等效判定）→ 无界不变量与无界方向用例转红；
2. 界边界放宽（`<` → `<=`）→ 触界用例转红；
3. `IMPROVED`/`REGRESSED` 方向反转 → 方向与 renderCompare 行级用例转红；
4. Newcombe 退化为朴素 Wald 正态近似 → 锚点与参考向量用例转红。

## 六、边界与回退

- **边界**：只改 `scripts/eval/exploration/stats.ts`、统计单测 `scripts/eval/exploration/stats.test.ts` 与本文件；
  不新增依赖；不触碰 `criteria.lock`、cases、judge、runner、safety-gate、历史 `.runtime` 证据与历史报告；
  v1 纯函数面（Wilson/三态）不变。
- **回退（运行时零残留）**：`git revert` 实现提交 `bd43fc2`（或把 `stats.ts` 单文件回退到基线版本）
  即回到 v1 运行行为——本片不含数据迁移、不新增依赖、无持久化状态、无 Runtime 接线，产品侧零残留。
  注意：新增单测引用 v2 面，回退实现时应一并回退统计单测（`f10ad25`/`e02c197`），避免留下红测试；
  本文档可随实现一并回退，单独保留也不影响产品运行时（`stats.ts` 不被产品代码引用）。
- **口径回退不改写结论**：已产出的 v2 输出按其「口径版本：v2（δ=…）」标注解释；历史报告与历史证据
  不被改写、不重新解读。

## 七、限制与非目标

- 四态是**给定 δ 下**的判定：换 δ 值结论可能改变；δ 必须在使用前预注册，不得事后挑选；
- `NO_SUBSTANTIAL_CHANGE_VERIFIED` 只在 δ 与置信水平共同限定下成立，不读作「两组完全相同」；
- `9/9` 仍不是 100%（Wilson CI 不覆盖 1）；样本量与扩展规则沿用批次预注册，不在本工具内自动扩展；
- `INSUFFICIENT_EVIDENCE` 是常态结论（尤其小样本），不得当作「无变化」或「失败」；
- 本工具只做读数与判定呈现，不替代黑盒评估、独立复核与发布决策。
