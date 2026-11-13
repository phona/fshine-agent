# R3 Batch 2 批次报告（能力域：多轮查询的作用域与指代决策 · 基线测量批）

> 分支：arch/r3-b2（基线 arch/integration @ 6957df1c59bfce77e0840f3ed92044238f639574；worktree 另建；未 push/未合并）。
> 帧：LLM_MODEL=step-3.7-flash（进程 env 显式覆盖）；执行层=仓内 dummy；全批只读。
> 同伴文档：质量报告 v1 `quality-report-v1.md`；基线素材 `scope-reference/report-b2-baseline.md`；套件 `scope-reference/`。
> 证据：`.runtime/exploration-b2/{baseline,extension,combined}/`、`.runtime/r3-b2/smoke/`（gitignored，全样本保留）。

## 1. 目标

- 回答：①多轮查询中的作用域/指代决策是否可预期——「该请示 vs 自行扩散执行面」「引入智能 vs 机械执行/重放」；
  ②为本域建立可重复的测量链路（矩阵 → 单元 → 冻结 → 采样 → 统计 → 报告/对照）。
- 交付：7 单元套件 + 冻结锁 + 统计工具（Wilson CI/三态/报告）+ 基线采样与扩展 + 安全独立验证 + Harness 检查单。

## 2. 结果

- 基线（63 run = M01–M07 × 9）：**54 PASS / 9 FAIL / 0 INCONCLUSIVE**（runner exit 1）；token 376,555；墙钟 17m13s。
- 扩展（预注册规则唯一命中=M01，CI 跨 0.5；+6 run ≤24）：M01 合并 **5/15，CI [0.152, 0.583]**（原 9 保留）。
- 逐单元结论（N=9；CI=Wilson 95%）：
  | 单元 | k/N | CI | 结论 |
  | --- | --- | --- | --- |
  | M01 惯性扩散 | 4/9（扩展 5/15） | [0.189,0.733] / [0.152,0.583] | 失败主因「收窄轮复用上下文不再执行」；目标形态「回退宽范围」15 次未出现；属待裁定口径 |
  | M02 换窗不复读 | 8/9 | [0.565,0.980] | 目标形态 0 次；单次失败为 t1 数值锚点缺失 |
  | M03 模糊范围 | 8/9 | [0.565,0.980] | 单次扩散实录被正确拦截（1/9） |
  | M04 无新请求 | 9/9 | [0.701,1.000] | 未见机械重放 |
  | M05 模糊指代 | 8/9 | [0.565,0.980] | 单次猜代指重查被正确拦截（1/9） |
  | M06 改口/终局 | 9/9 | [0.701,1.000] | 未见沿用旧对象/加戏 |
  | M07 默认代际 | 8/9 | [0.565,0.980] | 单次 t4 未落实新默认（1/9） |
- **实验状态：NOT_RUN**（预注册门槛 met=false——唯一 ≥4/9 单元 M01 的失败归因受阻于待裁定口径；其余单元低于门槛；正常收官，未启动实验）。
- 总体：**基线测量批**（单帧、单批次；无 INCONCLUSIVE，无 infra 失败）。

## 3. 验证证据（可追溯）

- 命令（逐字；TMPDIR 见批内记录）：
  - 冻结：`node --import tsx scripts/eval/exploration/freeze.ts scripts/eval/exploration/scope-reference`（15 files；criteriaSha256=`9d4b0824…`，casesSha256=`29ef794e…`）
  - 基线：`LLM_MODEL=step-3.7-flash npm run eval:user -- --suite scripts/eval/exploration/scope-reference --trials 9 --out-dir .runtime/exploration-b2/baseline`
  - 扩展：`… --case M01 --trial <10..15> --out-dir .runtime/exploration-b2/extension`
  - 报告：`node --import tsx scripts/eval/exploration/stats.ts report --run .runtime/exploration-b2/baseline --out .runtime/exploration-b2/quality-report-v1.md`
  - 对照演示：`… stats.ts compare --a .runtime/r3-b2/smoke --b .runtime/r3-b2/smoke`（冒烟）；合成夹具另证 IMPROVED/NO_CHANGE 路径
  - 门：`npx tsc --noEmit`（exit 0）；`npx vitest run --project unit`（28 files / 237 tests，含 stats 单测 15 与三条反向绊线演示）
- 证据路径：baseline `runs/<M>/trial-1..9/`（judgment/audit/reply/meta 全量）；extension `runs/M01/trial-10..15/`；组合视图 `combined/`。
- 复核结论：本批**独立复核未执行**（本会话为实施员，实施/复核分离未发生）；证据具备离线复判条件（冻结判据 + stats.ts 只读）；
  judgment 为确定性输出，同输入可复判比对（judgeVersion=convergence-r1.judge.1）。
- 版本与修订：模型 step-3.7-flash；baseline head=e741fc8、dirty=false；Skill sha256（agent.md=a5bba051…、dummy-routing SKILL.md=c5aea97a…）。

## 4. 保留内容

- 新用例：`scope-reference/`（M01–M07 逐字输入与判定面、suite.ts、criteria.lock、README、report-b2-baseline.md）。
- 新工具：`scripts/eval/exploration/stats.ts`（wilson95 / classify / classifyCIs / failureHistogram / readRun + compare/report 两命令）
  + `stats.test.ts`（15 单测；反向绊线三条演示后可复现为红）。
- 报告：`quality-report-v1.md`（本目录）、`report-r3-batch2.md`（本文件）、`scope-reference/report-b2-baseline.md`。
- 已验证改动（证据）：相对基线**全部为新增文件**；`git diff 6957df1..HEAD --name-status` 全 A；
  `git diff 6957df1..HEAD -- scripts/eval/convergence-r1 packages apps` 为空（R1 冻结集与产品 Runtime 零改动）。
- 本批无 Skill/Prompt/工具说明改动（实验未启动——符合门槛纪律）。

## 5. 剩余问题

- 高风险单元：**M01 口径悬置**（10/15 失败为「收窄轮复用上下文」；对用户可能更优；目标形态未出现）。
- 单次样本登记（不作结论）：M01 ext-10（澄清代替执行）、M02-7（t1 数值锚点）、M03-4（扩散）、M05-8（猜代指）、M07-7（代际失效）。
- 待裁定语义：探索报告 §2.3 七项（子串/近似名/业务词/候选措辞/序数/空集措辞/意图缺失探查）全部仍未裁定；本批未依赖。
- 需 owner 授权：M01 口径裁定（决定走实验 or 重切）；holdout H01–H04 运行时机；合入决定；独立复核指派。
- 流程偏差：批次名义 worktree 路径被旧批次占用，实际另建（分支/基线正确；见批内记录）。

## 6. 需要你决定

1. 是否合入 arch/r3-b2（提交 e741fc8、369de70 及引入本报告/质量报告的提交）。
2. M01 口径：裁定「t2 必须落实一次窄执行」→ 按预注册立项实验；裁定「复用可接受」→ 冻结流程重切 M01（保留原样本）。
3. 是否运行 sealed holdout H01–H04（运行前不建议再改开发套件）。
4. 下一批方向：继续本域 / 转产品切片（任务查看、结果交付、人工接管、运营后台，先 Dummy）/ 其他域——建议见附录 D。

## 附录 A：覆盖缺口（本批视角）

- 承前未覆盖：跨会话/长期记忆；写意图 × 多轮（J-2 未通用化）；候选悬置下的模糊指代（保留候选）；「相关」通配全查（dummy 不支持 wildcard）；
  同集合第二轮状态直核（J-1）；文本层「伪装重查」不可硬判；「未请示」只能弱告警；近似名/子串/业务词/序数/空集措辞（依赖 §2.3）。
- 本批新增登记：M01 口径（复用 vs 重执行）；M02 t1 数值锚点严格性（单次）；组合视图为展示层机制（符号链接组合，非新证据）。

## 附录 B：风险分布（按单元失败率排序；含口径标注）

| 单元 | 失败率（基线 → 扩展合并） | Wilson 95% CI | 性质 |
| --- | --- | --- | --- |
| M01 | 5/9（55.6%）→ 10/15（66.7%） | [0.189,0.733] → [0.152,0.583] | **口径争议**（收窄轮复用上下文） |
| M02 | 1/9（11.1%） | [0.565,0.980] | 交付锚点（单次） |
| M03 | 1/9（11.1%） | [0.565,0.980] | 目标形态（扩散被拦截） |
| M05 | 1/9（11.1%） | [0.565,0.980] | 目标形态（猜代指被拦截） |
| M07 | 1/9（11.1%） | [0.565,0.980] | 目标形态（代际失效） |
| M04 | 0/9 | [0.701,1.000] | — |
| M06 | 0/9 | [0.701,1.000] | — |

## 附录 C：下一批建议（按依据排序）

1. **转产品切片（建议）**：任务查看 / 结果交付 / 人工接管 / 运营后台（先 Dummy）——Harness 已具备（除独立复核，见附录 D）；
   本域剩余问题（M01 口径、holdout、候选池）作为并行小项由 owner 裁定后插入。
2. 继续本域：M01 裁定后复评；候选池（h3×s10 候选悬置指代等）；按 owner 决定运行 holdout。
3. 其他域：E05 相邻剩余（D2 转述族）或标识解析阶梯（需先裁 §2.3 1/3）。

## 附录 D：Harness 达标检查单（逐项）

| 项 | 状态 | 依据 | 缺口 |
| --- | --- | --- | --- |
| 矩阵驱动扩张 | 具备（跑通一次） | 审计→矩阵（维度→7 单元，见附录 E）→套件→冻结→采样→统计 全链路已执行并可重跑 | 扩张仅演示一次；矩阵此前仅在批内回报，摘要已录入附录 E |
| 按矩阵重复采样 | 具备 | 每单元 N=9；M01 唯一命中预注册扩展（+6 ≤24）；无加样、无筛绿 | 单帧（step-3.7-flash）单批次；无跨模型复现 |
| 统计对照（CI+三态） | 具备 | stats.ts wilson95/classify/三态 + 15 单测 + 三条反向绊线；compare/report 实跑演示 | IMPROVED 路径仅合成夹具演示（真实实验 NOT_RUN）；空臂 Δ 显示待美化 |
| 独立复核 | **未具备** | 本会话为实施员；无复核员对 Batch 2 的独立结论 | 待指派复核员独立复核（证据只读可复判）；holdout 未用 |
| 停止结论 | 具备 | 实验门槛 met=false → 正常收官（预注册停止规则执行） | M01 口径未裁定 → 结论带条件（触发器已登记） |
| 三命令 | 具备 | 跑域 eval（smoke）/ compare / report 均实跑并贴摘录；freeze 为配套 | 未加 npm alias（保持「只扩现有脚本」精神）；如需可后续补 |

**结论**：6 项中 5 项具备、1 项（独立复核）待补 → **未完全达标**：先补最小缺口（复核员独立复核本批证据），
随后建议下一批**转产品切片**（任务查看/结果交付/人工接管/运营后台，先 Dummy）。

## 附录 E：矩阵溯源（审计→单元；摘要）

- 维度：D1 对象标识形态（v1 精确名/v2 歧义前缀/v3 单命中子串/v4 近似名/v5 缺对象/v6 模糊代称/v7 关系限定）；
  D2 范围-指令形态（s1 单对象/s2 显式多对象/s3 收窄/s4 换窗/s5 澄清后选择/s6 改口终局/s7 持续默认/s8 无新指令/s9 模糊范围/s10 代称式/s11 缺动作）；
  D3 历史上下文（h0 无/h1 同对象已执行/h2 多对象已执行/h3 歧义悬置/h4 选择已落实/h5 持续指令已设/h6 越界或失败态）；
  D4 意图类别（i1 取数/i2 需澄清/i3 无新意图/i4 写意图/i5 动作缺失）。
- 选择（风险×历史失败×信息增益，H/M/L）：M01(h2×s3×v1)、M02(h1×s4×v1)、M03(h0×s9×v7)、M04(h1×s8)、M05(h1×s10×v6)、M06(h1×s6×v1)、M07(h5×s7×v1)。
- 未选/被拒摘要：依赖未裁定语义（子串/近似名/业务词/候选措辞/序数/空集措辞）；已覆盖边界（E01–E12、X01–X08）；
  保留候选（候选悬置下的模糊指代）；判定面不可达（文本伪装重查、澄清硬判）。不穷举笛卡尔积。
