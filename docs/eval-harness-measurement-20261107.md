# Eval harness 测量：方法与用法

> 本文只讲**怎么触发、测什么、怎么读结论、判据边界**，不记录某一次运行的数字。
> 2026-11-07 的当日报表已作废并从本文删除；机械判据的边界以第 4 节为准。
> 历史快照（含已作废数字）见 PR #8 的 review 记录。
>
> 运营模式：**按需 `workflow_dispatch` 手动触发，不挂每次 push**。
> 测量对象：通用域 eval（`scripts/eval/generic-model-eval.py`，stock 夹具，mock 执行器）。
> 汇总：`scripts/eval/measure-summary.mjs`。
>
> **2026-11-13 M4 注（已退役 harness）**：本文所述的 `generic-model-eval.py` /
> `measure-summary.mjs` / stock 夹具与 `eval-measure` 工作流已全部退役
> （[`decision-log.md`](decision-log.md) §十三）；本方法说明按历史档案阅读，不要按本文
> 触发已删入口。

---

## 1. 怎么触发

### 1.1 GitHub Actions（常驻入口）

Workflow：`.github/workflows/eval-measure.yml`（名称 `Eval harness measurement`）。
Actions 页面点 **Run workflow**，或：

```bash
gh workflow run 'Eval harness measurement' \
  -f rounds=5 \
  -f weak_model=step-3.5-flash
# cases 不传则用 workflow input 的默认用例集；要缩范围再 -f cases='...'。
```

输入含义：

| 输入 | 含义 | 校验 |
|---|---|---|
| `rounds` | 稳定性测量的轮数（强模型，`--no-judge`） | 正整数；不合法 `exit 2`，不进 python |
| `cases` | 本轮用例集，逗号分隔的**集合**（重复 id 拒绝，不静默去重） | `^[A-Za-z0-9-]+(,[A-Za-z0-9-]+)*$`（等价要求 `^[A-Za-z0-9,-]+$` 且无空段）；另拒重复 id |
| `weak_model` | 区分度对照的弱档模型 | 模型 id 形状 `^[A-Za-z0-9._-]+$` |

输入只通过步骤 `env` 传入 shell（`$ROUNDS` / `$CASES` / `$WEAK_MODEL`），不拼进
`run` 脚本体；格式校验在任何模型调用之前完成。默认值以 workflow 的 input 声明为准，
本文不复制第二份。

`cases` 与汇总脚本的 `--expect-cases` 是**集合**，口径与探针 `--only` 一致（每例每轮
只跑一次）。重复 id 在 workflow 入口和 `scripts/eval/measure-summary.mjs` 都直接拒绝
（workflow 入口自校验 `exit 2`；汇总脚本 `exit 3`，按 `scripts/eval/exit-codes.ts` 的
「用法错误=3」口径），不静默去重：留在声明数组里会让区分度逐项比较给同一份证据加权（A,B 与
A,A,B 得出相反结论），阶段轮数若用未去重的个数当除数则会把完成轮数报小。

### 1.2 工作流内部阶段

1. **稳定性**：强模型 × `rounds` 轮，`--no-judge`，产出每用例机械通过率。
2. **强档区分度**：强模型 × 2 轮，带 judge。
3. **弱档区分度**：弱模型 × 2 轮，带 judge。
4. **汇总**：读前三阶段的结果与状态，写 step summary。

三个测量阶段**分别捕获退出码**（`.runtime/status-*.txt`），任一阶段失败都**不中断**
后续阶段与汇总；强档失败也照跑弱档。汇总步骤逐阶段报告「完成（N/M 轮）」或
「失败（退出码 X）」。工作流最后一步的退出码只反映**汇总 markdown 是否产出**，
不反映被测失败率——被测失败是测量结果，不是工作流错误。

产物（artifact `eval-measure-<run_id>`）：三份结果 JSON、三份文本日志、状态文件和
汇总 markdown。

### 1.3 本地复跑

```bash
export TMPDIR=~/.tmp
export EXECUTION_EXECUTOR=mock
export LLM_JUDGE_MODEL=step-5-preview
# 与 workflow 的 cases 默认值同集；默认值变更时以 workflow 声明为准。
export CASES='G-A1,G-A2,G-A3,G-A4,G-A5,G-B1,G-Y2'
# LLM_API_BASE_URL / LLM_API_KEY 由调用环境提供；本文不记录任何密钥文件位置。

# 稳定性（N 轮，no-judge）
LLM_MODEL=step-5-preview python3 scripts/eval/generic-model-eval.py \
  --no-judge --rounds 5 --only "$CASES" \
  --out .runtime/measure-stability.json

# 区分度：强 / 弱各 2 轮（带 judge）
LLM_MODEL=step-5-preview python3 scripts/eval/generic-model-eval.py \
  --rounds 2 --only "$CASES" \
  --out .runtime/measure-strong.json
LLM_MODEL=step-3.5-flash python3 scripts/eval/generic-model-eval.py \
  --rounds 2 --only "$CASES" \
  --out .runtime/measure-weak.json

# 汇总（通过率矩阵 + 双档分差 + 判据结论）
# --expect-cases / --expect-rounds 必填：期望结构（分母的声明值）只有调用方知道，
# 不声明就不许合并下结论——否则缺轮/缺用例会静默缩小分母（codex 复审 major）。
node scripts/eval/measure-summary.mjs \
  --expect-cases "$CASES" --expect-rounds 5 --expect-disc-rounds 2 \
  .runtime/measure-stability.json -- \
  .runtime/measure-strong.json .runtime/measure-weak.json
```

## 2. 测什么

| # | 问题 | 输入 | 输出 |
|---|---|---|---|
| 1 | 稳不稳 | 同模型 N 轮，机械判据 | 每用例 `通过轮数/N` 与通过率 |
| 2 | 分不分 | 强/弱模型各 2 轮，judge 四维 | 每用例双方 judge 合计分、分差、有效比较数/缺失数 |
| 3 | 为什么红 | 失败轮的 `calls` / `final_text` | 人工归因用的失败形态（机制违 vs 结果错） |

区分度的 judge 维度以 `scripts/eval/measure-summary.mjs` 的 `DIMENSIONS` 为准
（groundedness / entityFidelity / failureHonesty / presentationHygiene）。

## 3. 怎么读结论

### 3.1 稳定性矩阵

```text
| 用例 | 通过轮数 | 通过率 | 判定 |
```

- 通过率 = 机械通过轮数 / 总轮数。**80% 只是建议线，不是充分条件**。
- 低于建议线：该用例不能按 per-push required 门设计（多数决或判据修订需另拿证据）。
- 达到建议线也只是候选：还必须满足
  1. 最近一次 eval-real **无机械通过率下降**（含基线全通过后的 pass→fail，以及
     基线未全通过后的继续下降），且两份对照覆盖 `--expect-cases` 声明的全部用例；
  2. **无未消假红**。
  两项证据任一缺失或不为空，判定文案是「**稳定性达标但需先消回归**」，不是
  「可做 required」。缺证据按 fail-closed 处理，不默认清白。声明了却没被对照盖住的
  用例同样按缺失处理，不得写成已验证。

给汇总脚本补这两项证据：

```bash
node scripts/eval/measure-summary.mjs \
  --expect-cases "$CASES" --expect-rounds 5 --expect-disc-rounds 2 \
  .runtime/measure-stability.json \
  --eval-real-baseline .runtime/eval-real-baseline.json \
  --eval-real-latest .runtime/eval-real-latest.json \
  --regressions .runtime/unresolved-regressions.json \
  --min-valid 1 -- \
  .runtime/measure-strong.json .runtime/measure-weak.json
```

- `--eval-real-baseline` / `--eval-real-latest`：两份 `generic-model-eval.py` 探针
  JSON（至少含 `results[].id` 与 `results[].mechanical_pass`）。同一用例 latest 的
  机械通过率严格低于 baseline
  （`latestPasses * baselineRounds < baselinePasses * latestRounds`，不经浮点）
  即一条机械回归：既包括基线全通过、latest 出现失败，也包括基线未全通过后的继续下降
  （如 4/5 → 3/5）。通过率持平或上升不是回归。latest 未覆盖 baseline 的用例，或两份
  对照没有覆盖 `--expect-cases` 声明的某个用例时，无法证明「无回归」，按条件未满足
  处理，reason 列明缺号。
- `--regressions`：未消假红清单，接受 `{"unresolved":[]}`（空数组 = 清白）或
  `{"items":[]}` 或字符串数组。文件缺失/无法解析 = 未核验，不得当作清白。

### 3.2 区分度矩阵

只有**双方该用例四维都有数值**才计入「有效比较」。任一侧缺维度、缺用例、judge
被跳过（`judge_mean` 为 `"skipped (--no-judge)"`）或为 `null`，该例整体计入「缺失」，
**不得**把已出现的维度合计成假分差。

| 分差（强 − 弱，四维合计） | 单例判定 |
|---|---|
| `≥ +0.5` | 强模型明显更优 |
| `≤ −0.5` | 弱模型明显更优 |
| 其余 | 无显著差异 |

总判定只有四类：**强模型明显更优 / 弱模型明显更优 / 无显著差异 / 无法判定
（数据不足：缺失 N 例）**。缺失项不计入前三类，也不能当作区分度证据。

- 有效比较数为 0，或低于 `--min-valid`（默认 1）：总判定固定为「无法判定（数据不足）」，
  汇总脚本**退出码 3（数据不足）**。这是测量结论，不是工作流故障。
- 弱模型更优或无显著差异占多数：说明 harness 在该用例集上没有区分度，该改的是
  eval/判据，不是模型。

### 3.3 阶段状态与退出码

- 阶段「完成（N/M 轮）」：该阶段拿到了完整轮数。M 为稳定性 `rounds` 或区分度的 2。
- 阶段「失败（退出码 X）」：该阶段没跑完；失败是测量结果的一部分，汇总仍会继续，
  但缺该阶段的数据不得写成结论。
- 汇总脚本（语义唯一出处 `scripts/eval/exit-codes.ts`，2026-11-12 Owner 批准对齐）：
  `0` = 通过（被请求的测量都有可用数据且判据通过，结论已给出）；`2` = 判据红
  （有实证的判据违例，如稳定性某用例通过率低于建议线）；`3` = 数据不足/用法错误
  （输入不完整、期望结构缺失/不符、重复声明、证据不可读——无法得出有效判定；
  判据红与灰并存时取 2）。GitHub 工作流只在**汇总 markdown 未产出**时失败，
  不因被测失败率或数据不足失败。

## 4. 判据边界（fail-closed）

1. **80% 是建议线，不是充分条件**。通过率达到线不等于可以进 per-push required；
   还要过 3.1 的两项回归证据。证据缺失时宁可写「稳定性达标但需先消回归」。
2. **机械通过率下降永远 blocking**（含基线全通过后的 pass→fail，以及未全通过基线的
   继续下降）。不能用「结果对、机制违」「假红」「方差」之类解释把它降级成非阻断；
   要么修 harness/判据并拿证据，要么保持 blocking。把机械下降写成假红、或把未覆盖的
   声明用例写成无回归，本身违反仓库规定。
3. **judge 缺失不是区分度证据**。缺维度、跳过评委、双方全 `null` 都只能得到
   「无法判定」；既不能证明有区分度，也不能证明没有。
4. **小样本只给点估计**：N 轮通过率是点估计，不是置信区间；不要把一次通过率当成
   长期概率。
5. **不复制权威**：用例期望值、参数默认值和域规则以 `scripts/eval/cases.yaml`、
   `scripts/eval/expectations.ts`、`scripts/eval/generic-model-eval.py` 与 workflow
   声明为准；本文只写测量方法与读法。

## 5. 历史快照

历史快照（含已作废数字）见 PR #8 的 review 记录。本文不再复述其中的数字与对个案
的结论。
