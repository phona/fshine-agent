# Eval harness 测量报告（2026-11-07）

> 第一次给这套 harness 量尺。三个问题、三个测量、判据预先写死——数字说了算。
> 测量对象：通用域 eval（`scripts/eval/generic-model-eval.py`，stock 夹具，mock 执行器）。
> 复跑：`bash` 手动触发 GitHub workflow「Eval harness measurement」，或本地照第 6 节命令。

---

## 1. 框架

| # | 问题 | 测法 | 判据 |
|---|---|---|---|
| 1 | 稳不稳 | 同模型 N 轮，统计每用例通过率 | <80% 不能做 per-push required 门 |
| 2 | 分不分 | 强/弱模型双档 + judge 打分 | 弱 ≥ 强的用例过半 = 该改 eval 不是模型 |
| 3 | 比不比 | 同用例跨环境 vs 旧基线 + 失败归因 | 失败归因集中 = 卡在那个原因；弥散 = 真漂了 |

## 2. 测量 1：稳定性（step-5-preview × 5 轮，no-judge）

| 用例 | 通过率 | 判定 |
|---|---|---|
| G-A1 / A2 / A3 / A4 / A5 / Y2 | 5/5 = 100% | 可做 required |
| **G-B1** | **4/5 = 80%** | **压线，不能按原样做 required** |

**G-B1 失败形态**（唯一失败轮）：`calls=4/5`——五轮里有一轮没发新 CALL（复用了上轮工具结果，违反 SYSTEM 明写的「Every user turn that asks a stock question must begin with a fresh CALL」），但**五轮答案全对**（"3 items on the south shelf"）。

**读数**：这是「结果对、机制违」的方差，不是能力缺陷。G-B1 的判据把机制合规当成唯一标准，所以它按 ~20% 的频率假红。**在 characteristic 完成前，G-B1 不能进 per-push required。**

## 3. 测量 2：区分度（step-5-preview vs step-3.5-flash，各 2 轮，judge=step-5-preview）

| 用例 | 强 judge 合计 | 弱 judge 合计 | 差 | 强机械 | 弱机械 | 判定 |
|---|---|---|---|---|---|---|
| G-A1 | 8 | 5 | +3.0 | 100% | **0%** | 可分 |
| G-A2 | 6 | 6 | 0 | 100% | 100% | 不可分 |
| G-A3 | 8 | 8 | 0 | 100% | 100% | 不可分 |
| G-A4 | 7 | 5 | +2.0 | 100% | 100% | 可分 |
| G-A5 | 6 | 6 | 0 | 100% | 100% | 不可分 |
| G-B1 | 5 | 7 | **-2.0** | 0% | 0% | 不可分 |
| G-Y2 | 7 | 8 | **-1.0** | 100% | 100% | 不可分 |

**弱模型失败形态**：`FINAL: (no answer)`——空答案（G-A1 第 2 轮、G-B1 第 1 轮）。

**读数**：
- **机械判据层是有效的**——它抓住了弱模型的空答案（G-A1 弱模型机械 0%）。
- **评委层目前不是量尺**——5/7 用例分不出强弱，2 例倒挂。原因假设：评委按 transcript 打分，弱模型的 transcript 短、没有可挑错的内容，四个维度（groundedness / entityFidelity / failureHonesty / presentationHygiene）里没有一个把「没回答」本身当成失分项。
- **待修**：judge 维度需要一条「应答完整性」判据（空 final / 无结论 = 该维 0 分），或评分前加一道机械空答案检查。修完重跑本测量，判据 = 弱模型均分应系统性低于强模型。

## 4. 测量 3：可比性（12 条财税基线用例 vs 旧基线）——阻塞

**结果**：探针 11 例全红，验收 1 例红，score 无法产出（exit 2，缺验收报告）。

**红的不是域不匹配，是配置**：`未声明有效的 profile.gateway：宿主不再回退任何遗留网关名（C7b 起删除实例名缺省）`——主仓 `config/agent.yaml`（gitignored，本地部署配置）的 contextProfiles 未声明 gateway。探针/验收走 `AGENT_CONFIG_PATH` 显式指向它，解析正确，但配置里没有网关声明。

**读数**：这是 D-181 首阻塞点的另一面——harness 侧的两参调用早已修好（`pi-coding-driver.ts:1720` 三参带 gateway），但**部署配置必须自己声明 gateway**。真实执行层路径的本地依赖清单又长了一项。这不阻挡 Wave 6（域无关化走仓内夹具配置，gateway 已声明），但它是「baseline comparability on the real layer」的前置。

## 5. 结论

1. **稳定性**：6/7 用例可 required；G-B1 需先做方差 characteristic（或拆分「机制合规」与「结果正确」两个判据）。
2. **区分度**：机械层可用，评委层待修（空答案判分）。修完前，judge 分数只作参考、不进任何门禁。
3. **可比性**：真实层路径被「配置未声明 gateway」挡住；自包含路径（仓内夹具）不受影响——Wave 6 的方向获得第三方证据支持。

## 6. 复跑命令

```bash
# 测量 1+2（本地；CI 用 workflow_dispatch「Eval harness measurement」）
export TMPDIR=~/.tmp \
  LLM_API_BASE_URL=https://api.stepfun.com/step_plan/v1 \
  LLM_API_KEY=$(cat ~/.tmp/llm-ci-key) \
  LLM_JUDGE_MODEL=step-5-preview EXECUTION_EXECUTOR=mock

# 稳定性：step-5 × 5 轮
LLM_MODEL=step-5-preview python3 scripts/eval/generic-model-eval.py \
  --no-judge --rounds 5 --only G-A1,G-A2,G-A3,G-A4,G-A5,G-B1,G-Y2 \
  --out .runtime/measure-stability.json

# 区分度：双档各 2 轮带 judge
LLM_MODEL=step-5-preview    python3 scripts/eval/generic-model-eval.py --rounds 2 --only <同上> --out .runtime/measure-strong.json
LLM_MODEL=step-3.5-flash    python3 scripts/eval/generic-model-eval.py --rounds 2 --only <同上> --out .runtime/measure-weak.json

# 汇总（通过率矩阵 + 双档分差 + 判据结论）
node scripts/eval/measure-summary.mjs .runtime/measure-stability.json -- .runtime/measure-strong.json .runtime/measure-weak.json
```

## 7. 已知限制

- 样本量小（5 轮 / 2 轮）；G-B1 的 80% 是 4/5 的点估计，不是置信区间。
- judge 为空答案 transcripts 的打分行为是假设，未逐条读评委引文核实。
- 测量 3 未跑通，无可比性数据；blocked on the gateway declaration。
