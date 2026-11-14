# E01 判据形态修复：数字提取排除行首有序列表标记（2026-11-14，分支 `arch/e01-fix`）

> 授权：R3 收官裁定 E01=a（保留旧版冻结基线与历史判定结果、生成新版本；加入正反测试）。
> 范围：仅 `scripts/eval/convergence-r1/judge.ts` 的数字提取（`extractNumberTokens`）排除「行首（含缩进）有序列表标记」；用例与判定语义的其他部分零改动。
> 证据根：本工作树 `.runtime/e01/`（gitignored）：`refreeze/`、`preserved/`、`sweep/`；各档案帧内逐 judgment 的 `.pre-e01fix.json` 保底副本。
> 本报告不含绝对路径；帧名列用「工作树代号/帧」标示，与 `.runtime/e01/sweep/compare.json` 的 label 逐一对应。

## 一、背景与形态

- 登记表第 2 项（全语料扫描）：FAIL_FABRICATED_DATA 共 6 次，其中 4 次为同一形态——回复中的**有序列表序号**（「1.」「2)」等）被 `extractNumberTokens` 当作实体不可溯源数值（E04-1、pre-freeze2 E04-1、post-cleanup E01、认证帧 E01）；另 2 次为同一 E07-3 样本的真实模型错误（跨对象污染，正当判负）。
- 机制：行首（含缩进）的「数字 + [.、)）]」是排版标记；修复前它既可能在「实体-数值对」子句检查中触发 `FAIL_FABRICATED_DATA`（序号与实体同子句时），也会产生「无法溯源的独立数字」弱告警（序号单独成子句时）。

## 二、改动（patch 说明）

- `judge.ts:77-82`（`extractNumberTokens`，+6 行；同函数既有标识符排除保持不变）：
  - `:81` `const lineStart = text.lastIndexOf('\n', start - 1) + 1;`
  - `:82` `if (/^[ \t\u3000]*$/.test(text.slice(lineStart, start)) && /[.、)）]/.test(after)) continue;`
- 判定：token 前缀（自本行首起）仅空格/制表/全角空格（含零缩进）且其后紧跟 `[.、)）]` → 视为列表标记，不计独立数值。
- 明确不动：行内数字、标记后的正文数值、千分位/小数（`1,200`、`800.5`）、标识符内数字（`W202611`/`doc-002`/`req_…`）。
- 提交：`55a8eb6`（仅 `judge.ts` + `selftest.ts` 两文件，+33 行）。

## 三、自测（selftest 对照）

新增 2 包（`selftest.ts:277` / `:290`），先红后绿（命令 `npm run eval:user -- --judge-selftest`）：

| 包 | 形态 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| `ordered-list-markers-not-data`（正向） | 回复含行首「1.」「2)」「2、」，其余数值均可溯 | exit 2；`FAIL FAIL_FABRICATED_DATA` → MISMATCH（note：『beta-item-2 所在子句出现不可溯源数值 2』；另有「无法溯源的独立数字：2」弱告警） | `PASS`、failureCodes=[]、弱告警=[]（断言无「无法溯源」弱告警） |
| `list-item-fabricated-value`（反向绊线） | 列表项内真实编造数值 999 | `FAIL + FAIL_FABRICATED_DATA` | `FAIL + FAIL_FABRICATED_DATA`（note 指向 999） |

- 修复前：exit 2，新正向包 MISMATCH、既有 8 包全 OK；修复后：exit 0，10/10 OK，`allPass=true`。
- 确定性门：`npx tsc --noEmit` → 0；`npx vitest run --project unit` → 33 文件 / 305 用例全过（exit 0）。

## 四、冻结重切（criteria.lock）

| 锁 | 旧文件 sha256（`.pre-e01fix` 保底） | 新文件 sha256 | criteriaSha256 | casesSha256 | `files` 变化 |
| --- | --- | --- | --- | --- | --- |
| convergence-r1 | `a177b50e…` | `e03b61e8…` | `9d4b0824…`（不变） | `6d55a42a…`（不变） | `judge.ts` `a6a5b293…`→`d16871e6…`；`selftest.ts` `98cc9f33…`→`aaff9094…` |
| exploration/e05-adjacent | `498f3c0e…` | `412c6e60…` | `9d4b0824…`（不变） | `b011c46e…`（不变） | 仅 `judge.ts` 项 |
| exploration/scope-reference | `5cd423a2…` | `7d6f3f10…` | `9d4b0824…`（不变） | `29ef794e…`（不变） | 仅 `judge.ts` 项 |
| exploration/holdout | `d917fbb5…` | 未动 | — | — | 封存保持；首次使用前需按新版本重切 |

- 命令：`node --import tsx scripts/eval/convergence-r1/freeze.ts`；`node --import tsx scripts/eval/exploration/freeze.ts <suite-dir>`（两个套件）。
- R1 锁的 `files` 含 `selftest.ts`（测试脚手架；正反 fixture 属本修复的交付要求）：**语义面实质变化仅 `judge.ts`**；两个 exploration 锁仅 `judge.ts` 一项变化；三把锁的 criteriaSha256/casesSha256 内容哈希均不变。
- 旧锁同目录保底为 `criteria.lock.pre-e01fix`（未跟踪文件；旧版内容亦存于 git 历史）。重切前全量 eval 路径 fail-closed，`--judge-selftest` 路径不校验锁（已实测）。

## 五、保底清单（judgment 副本，修复前完成）

- 范围：全部 runner 可复判档案帧 **65 帧 / 388 份 judgment**（10 个工作树代号：evalr1 89、main 86、r3-b2 76、r3 54、r3-arc 27、explore 18、p1 14、r3-p2 12、r3-p3 6、r3-p4 6）。
- 动作：逐 judgment 同目录复制 `judgment.pre-e01fix.json`（不覆盖任何原文件）；逐文件 sha256 记录于 `.runtime/e01/preserved/judgment-copies.json`（388 条、errors=0）。
- 排除：32 份 `judge-selftest` 生成物（每次 `--judge-selftest` 重生成，非档案）。

## 六、全帧复判对照

机制：runner 现有 `--judge-existing`（在**副本**上复判；原档案只读；结果落副本内的 `judgment.json`/`judgment.recheck.json`）。三列口径：
`stored`=档案判定；`unfixed`=基线 `e07796a` 判据（未修复）复判；`fixed`=本分支判据复判。65/65 帧完成（summary 全产出）。

**A. 本修复归因差异（unfixed → fixed，判定体不同）：114 处 = 1 判定 + 113 仅弱告警。**

| # | 帧 | 用例/trial | unfixed | fixed | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | arc/e01-e12（认证帧） | E01-1 | `FAIL [FAIL_FABRICATED_DATA]` | `PASS` | 认证帧形态样本；弱告警「无法溯源的独立数字：2」同时消失 |

113 处仅弱告警变化（共移除 307 条）；连同上表认证帧 1 处（1 条），本修复共移除 308 条「无法溯源的独立数字：1/2/3/4」类弱告警（逐条核验 308/308 对应回复中的行首有序列表标记；**弱告警新增 0**），判定与失败码不变。按帧计数：

| 帧 | 处数 | 帧 | 处数 |
| --- | --- | --- | --- |
| eval-r1（36 次帧） | 10 | main/postmerge | 8 |
| eval-r1/batch-EvalR1-C | 3 | main/r2-e05-flash37 | 8 |
| eval-r1/post-cleanup | 3 | main/r2-e05b-flash37 | 8 |
| eval-r1/pre-freeze2 | 3 | main/r2-e06-flash37 | 2 |
| eval-r1/e06-after | 2 | main/r2-e12-flash37 | 1 |
| eval-r1/e04-repro、e06-repro、e07-after、pre-freeze3、pre-freeze4 | 各 1 | main/p1-review-base-e06-n5 | 4 |
| explore/exploration、exploration-preserved-A | 各 3 | r3/b1-baseline-e05 | 6 |
| p1/eval-e06-n5、p1/regression-e06 | 各 3 | r3/b1-exp1b-e05 | 5 |
| arc/m、r3-b2/baseline、r3-p2/regression-e06、r3-p2/review-e06、r3-p2/review-e12、r3-p3/eval-e12 | 各 1 | r3/b1-exp1-e05、r3/b1-exp2-e05 | 各 5 |
| arc/e01-e12（不含上表 1 处）、r3-p3/eval-e06、r3-p4/regression-e06 | 各 3 | r3/b1-exp1b-e06、r3/b1-exp2-e06 | 各 3 |
| | | r3/b1-exp1b-e12、r3/b1-exp1-e06 | 各 1 |

其中 2 处（eval-r1 E06-3、eval-r1/e04-repro E04-1）叠加在修复前既有差异之上。

**B. 档案 → 修复复判 判定差异（stored → fixed）：11 处 = 3 预期 + 8 登记。**

| # | 帧 | 用例/trial | stored | unfixed（归因参照） | fixed | 归因 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | eval-r1（36 次帧） | E04-1 | `FAIL [FAIL_FABRICATED_DATA]` | `PASS` | `PASS` | 预期清单；此前重切已翻转（非本修复） |
| 2 | eval-r1（36 次帧） | E04-2 | `FAIL [FAIL_NEEDLESS_CLARIFICATION]` | `PASS` | `PASS` | 登记：此前重切残留（第三次重切） |
| 3 | eval-r1（36 次帧） | E04-3 | `FAIL [FAIL_NEEDLESS_CLARIFICATION]` | `PASS` | `PASS` | 登记：同上 |
| 4 | eval-r1（36 次帧） | E06-3 | `FAIL [FAIL_PHANTOM_SUCCESS]` | `PASS` | `PASS` | 登记：此前重切残留（第四次重切） |
| 5 | eval-r1（36 次帧） | E07-1 | `FAIL [FAIL_STATE_INCONSISTENCY]` | `PASS` | `PASS` | 登记：此前重切残留（第五次重切） |
| 6 | eval-r1/batch-EvalR1-C | E07-1 | `FAIL [FAIL_STATE_INCONSISTENCY]` | `PASS` | `PASS` | 登记：同形（第五次重切） |
| 7 | eval-r1/e07-repro | E07-1 | `FAIL [FAIL_STATE_INCONSISTENCY, FAIL_WRONG_OBJECT]` | `PASS` | `PASS` | 登记：同形 |
| 8 | eval-r1/post-cleanup | E01-1 | `FAIL [FAIL_FABRICATED_DATA, FAIL_NEEDLESS_CLARIFICATION]` | `PASS` | `PASS` | 预期清单；此前重切已翻转（非本修复） |
| 9 | eval-r1/post-cleanup | E04-1 | `FAIL [FAIL_NEEDLESS_CLARIFICATION, FAIL_NO_DELEGATION, FAIL_STATE_INCONSISTENCY, FAIL_WRONG_OBJECT, FAIL_ZERO_EXECUTION]` | `FAIL [FAIL_NO_DELEGATION, FAIL_STATE_INCONSISTENCY, FAIL_WRONG_OBJECT, FAIL_ZERO_EXECUTION]` | 同左 | 登记：NEEDLESS 子码此前已消除（非本修复） |
| 10 | eval-r1/pre-freeze2 | E04-1 | `FAIL [FAIL_FABRICATED_DATA]` | `PASS` | `PASS` | 登记：此前重切已翻转（非本修复） |
| 11 | arc/e01-e12（认证帧） | E01-1 | `FAIL [FAIL_FABRICATED_DATA]` | `FAIL [FAIL_FABRICATED_DATA]` | `PASS` | 预期清单；**本修复归因**（FAIL→PASS） |

**C. 档案 → 修复复判 仅判定体差异（verdict/failureCodes 相同）：115 处**（弱告警/维度 note 等；明细 `.runtime/e01/sweep/compare.md` §C）。与 A 合并即：stored→fixed 判定体差异合计 126 = 本修复涉及 114 + 修复前既有且本修复未触及 12；修复前既有差异（stored→unfixed）合计 14 = 10 判定 + 4 仅体（其中 2 处叠加本修复）。

**D. E07-3 核验**：两份副本（eval-r1、batch-EvalR1-C）`stored = unfixed = fixed = FAIL [FAIL_FABRICATED_DATA]`（跨对象污染 1200/800）——保持判负，未受影响。

**E. 未完成复判的帧**：0（65/65 帧产出 summary）。

## 七、限制与登记

- **8 处预期外档案差异已逐条登记**（表 B 的 #2–#7、#9、#10）：全部为「档案未回写的历史重切残留」——`unfixed` 列证明修复前就已存在，与本修复无关；未扩散、档案未回写。
- **113 处弱告警清理**是修复的预期效果（同一提取路径的假弱告警），判定零影响；308 条移除逐条核验对应行首标记，弱告警新增 0。
- **行内序号不在本修复范围**（仅行首/含缩进）：只读探针（修复版 vs 未修复版）显示「备注 4. beta-item-1…」修复前后一致判负；若后续证据出现行内形态样本，需另行授权。
- **「1.」形态可观察性**：E01/beta 载荷下序号 1 与派生计数 1 重合，无法以单形态 FAIL→PASS 独立观察；以同一字符类 `[.、)）]` 覆盖 + 308 条弱告警清理核验。
- **「、」形态**：因「、」同时是子句分隔符，修复前仅弱告警（非判负）；以弱告警断言与清理核验覆盖。
- **档案零回写**：历史判定原样保留（`.pre-e01fix` 副本 + 原文件）；表 B/C 为「档案 → 新判据」对照，不代表档案被判据覆盖。
- **复判覆盖**：全部 runner 可复判帧（65/388）；非 manifest 生成物（selftest 32 份）排除；保底/重切/复判均在本地完成，未 push/未合并。
- holdout 保持封存；首次使用前需按新版本重切。

## 八、结论

- 本修复消除列表序号假阳性：判定层仅 1 处翻转（认证帧 E01 `FAIL_FABRICATED_DATA`→`PASS`，即预期形态样本）；E07-3 跨对象污染判负保持；unfixed→fixed 无其他判定差异。
- 三把锁重切完成（语义面实质变化仅 `judge.ts`），holdout 未动；388 份 judgment 保底副本完成；正反 selftest 先红后绿、全绿 10/10。
- 实施/复核分离：本提交待独立复核后按流程合入；本分支未 push、未合并。
