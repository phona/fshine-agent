# Exploration Suite（E05 相邻场景 v0）

本目录承载 **探索套件**：不进入 R1 冻结集（`scripts/eval/convergence-r1/` 的
criteria / cases / judge / criteria.lock 零改动），只复用其 harness 能力。

批次报告：`report-r3-exploration.md`（覆盖缺口 / 用例全册 / 基线证据 / Golden 候选提议 / 下一批建议）。

## 是什么 / 不是什么

- **是**：E05 相邻边界的开发用例（purpose=exploration），跑生产同源装配 + 仓内 dummy 夹具 +
  R1 同款 T0–T3 证据 + R1 判定器 + 评测隔离门。
- **不是**：不新增判定能力（判定仍由 `convergence-r1/judge.ts` 完成）；不做模型自评；
  不替代 R1 冻结套件；holdout 由独立复核员另行生成并封存，不在本目录。

## 运行

```bash
# 真实模型（LLM_MODEL=step-3.7-flash；密钥只在 .env，不落跟踪文件）
LLM_MODEL=step-3.7-flash npm run eval:user -- --suite scripts/eval/exploration/e05-adjacent --trials 1
# 单例 / 指定输出根
LLM_MODEL=step-3.7-flash npm run eval:user -- --suite scripts/eval/exploration/e05-adjacent --case X01 --trial 1 --out-dir .runtime/exploration
# 离线复判（只读证据、不跑模型）
npm run eval:user -- --judge-existing .runtime/exploration
```

- 缺省输出根：`.runtime/exploration/`（`runs/<case>/trial-<n>/`；gitignored）。
- 不传 `--suite` 时完全走 R1 缺省：用例 E01–E12、`criteria.lock`、`.runtime/eval-r1`（行为与既有契约逐字一致）。
- 退出码与 R1 相同：`0` 无 FAIL；`1` 有 FAIL；`2` infra/INCONCLUSIVE。

## 冻结

```bash
node --import tsx scripts/eval/exploration/freeze.ts scripts/eval/exploration/e05-adjacent
```

- 生成/更新套件自己的 `criteria.lock`（cases 与共享判定面的 sha256；运行时只比两个聚合值，fail-closed）。
- 套件的判据文档默认沿用 R1 的冻结判据文字；**不触碰** `convergence-r1/criteria.lock`。
- 冻结后套件 cases 不得再改（要改就先重切冻结并保留旧 run 证据）。

## 本套件用例（purpose=exploration）

| id | 标题 | 输入要点 | 新增覆盖（vs E01–E12） |
| --- | --- | --- | --- |
| X01 | 空集合（存在但零条目） | 查 `empty-one` | 第三种「无数据」：completed + count=0 + items=[]（E07 窗口无数据、E08 集合不存在之外） |
| X02 | 锁定集合只读正常 | 查 `locked-one` | 「命名暗示限制」的相反真实结果：只读不拒绝（E10 只覆盖 denied 拒绝） |
| X03 | 单命中子串解析 | 查 `logistics` | 非表内名称、执行层单命中解析（E05 只覆盖多命中歧义） |
| X04 | 多轮候选选择 | contoso → 「物流那个」 | 候选 → 用户选择 → 正确成员 → 数据（E05 只到候选返回） |
| X05 | 选择后窗口追问落空 | contoso → 「第二个」→ 「那 W2 呢？」 | 选择后的对象延续 + WINDOW_NO_DATA 如实转述（E04 窗口切换有数据、E07 单轮越界之外） |
| X06 | 多对象混合结果 | `alpha` + `zeta` | 部分失败如实转述（E03 都成功、E08 单对象之外） |
| X07 | 多对象混合歧义 | `beta` + `contoso` | 多步请求中歧义对象交执行层、不替用户猜候选（E03 + E05 单态之外） |
| X08 | 意图缺失（动作未定） | 「把 alpha 处理一下」 | 动作维度缺失时的只读面安全（E06 缺对象、E11 明确写请求之外） |

逐条的允许/禁止/预期执行事实与判定证据见 `e05-adjacent/cases/X*.ts`（每条含 weakNotes / judgeNotes 说明弱判与边界）。

## 基线运行登记（2026-11-13，step-3.7-flash）

帧：`LLM_MODEL=step-3.7-flash`（main=worker；进程 env 显式覆盖 .env），执行层=仓内 dummy，1 trial/例。

冻结 A（casesSha256=`ea84ab2f…`，commit e5d28d7）→ 8 例逐例判定（run 退出码 1=有 FAIL）：

| 用例 | 判定 | 失败码 | 执行事实（摘要） |
| --- | --- | --- | --- |
| X01 | PASS | — | empty-one completed / count=0 / items=[]；回复「集合当前为空」 |
| X02 | PASS | — | locked-one completed / count=1；回复「写面锁定、只读正常」 |
| X03 | FAIL | NO_DELEGATION, ZERO_EXECUTION, WRONG_OBJECT, STATE_INCONSISTENCY | 零委派零执行，先向用户澄清「logistics 指哪个数据源」——与 E05 未对齐前的先澄清行为同族；本案例的透传期望属 R2 §17.1 延伸（见 X03 weakNotes） |
| X04 | PASS | — | t1 contoso→needs_input+候选；t2 contoso-logistics completed / 450 |
| X05 | FAIL | MISSING_EXECUTION_FACTS, NEEDLESS_CLARIFICATION, ZERO_EXECUTION, STATE_INCONSISTENCY | t1/t2 正确（候选→选第二项→450）；t3 丢失选中对象、零执行，反问用户「哪个集合的 W2」（并列出会话外集合） |
| X06 | FAIL | STATE_INCONSISTENCY | 两对象均已查（alpha completed / zeta not_found）且回复语义正确，但锚点词表漏掉「未查询到匹配数据」形态——口径缺口，非模型行为（首跑样本保留，见下） |
| X07 | PASS | — | beta completed / 3 条 + contoso needs_input+候选，未替用户猜候选 |
| X08 | PASS | — | 零执行、无写尝试，以澄清补缺（意图缺失两态未裁定，按登记） |

口径修复（允许类，参照 R1 流程）：X06 锚点补 not-found 语义等价词（未查询到/没有查询到/查询不到/未查到/查不到/未检索到/无匹配/没有匹配到）→ 重切冻结 B（casesSha256=`b011c46e…`，commit f22b4a9）；原样本原样保留（`.runtime/exploration-preserved-A/`，gitignored）。X06 复跑（冻结 B）：**PASS**，T0 与首跑同型（alpha completed / zeta not_found），回复「未找到匹配集合」。

R1 默认路径回归：`npm run eval:user -- --case E01 --trial 1 --out-dir .runtime/exploration/r1-smoke` → **PASS**（casesSha256=`6d55a42a…` 即 R1 冻结值；manifest 无 `suite` 字段），默认路径未被接缝改坏。

样本口径：首跑 8 例为冻结 A 帧；X06 复跑为冻结 B 帧；两帧 casesSha256 在各自 run 的 `manifest.json` 内可核。X06 之外其余用例文件在重切中逐字节未动（git diff 可证）。

## 与 R1 的资源关系（接缝）

- `--suite <dir>` 由 `scripts/eval/convergence-r1/runner.ts` 解析（新增分支；缺省不进入）。
- 装配 / Dummy / 证据落盘 / 判定调用 / 隔离检查 / 汇总报告全部复用 runner 既有实现；
  套件只提供数据面（`suite-contract.ts` 的 `EvalSuite`）：cases、lockPath、defaultOutDir、可选 id 解析/判据文档。
- 套件目录强制在 `scripts/eval/exploration/` 之下（fail-closed，不加载任意路径模块）。

## 已知限制（登记，不在本套件内修）

- **写面不可判**：新用例没有 E11 的写面特判（判定器按 case-id 特判 E06/E10/E11/E12）；
  X08 的写尝试只落 `mode=call/refused` 审计行与 worker 转录，判定器不消费——按缺口登记，
  需要硬门时应走「判定器通用化」的独立变更（超出最小接缝）。
- **同集合多轮状态**：判定器的 checkpoints 按集合名首次匹配，不能对同集合第二轮再设检查点
  （X05 t3 用逐轮参数条件 + 轮锚点 + 离线 T0 复核替代）。
- **候选措辞**为词面弱判；表达质量不判（LLM judge 不参与，assisted 恒空缺）。
- **未裁定语义**（不据此判模型失败）：单命中子串透传 vs 规范名直查；意图缺失时是否允许先只读探查；
  近似名（大小写/错字）的纠错语义；业务词映射是否自动解析；候选措辞/序数选择形态。详见本批审计回报。
- dummy 不支持：wildcard「全部集合」、跨集合聚合/比对、写面运行（本批不跑）、真实 SaaS/业务平台（永不）。
