# 债务台账（Wave 1 · Lane D0 清债审计）

> 本文件是本轮「架构硬约束化」唯一的技术债登记处。**只登记，不修复。**
> 覆盖范围：fshine-agent 与 17dz-platform 双仓，2026-09-25 17:58 → 2026-09-27 13:35 的全部 commit（圈法见附录 A）。
> 生成方式：逐条现场核实（跨仓、保留原文标点、可复现命令写在「位置」里）。凡未能核实的断言不进本台账。

---

## 导言：台账哲学

**一、债务不可枚举就不可清理。**
隐性债的危险不在"存在"，而在"不可见"。今天双仓 42+ commit、30 小时、并行 subagent、事故驱动——这正是养债的节奏：每个 commit 单独看都合理，合起来看就没人说得清"我们还欠什么"。本台账的第一个产出不是任何一条债，而是**"我们到底欠什么"这个问题的可枚举答案**。枚举不完整没关系，但必须有一个地方在枚举，且每条都能被下一个人用同一条命令重新核实。

**二、"接受不修"也是有效状态，但必须写理由。**
把债分成"待办"和"已关"两类是假的二分法——还有第三类：看过、评估过、决定不修。这类条目不写理由就会退化成"忘了修"，而"忘了修"和"决定不修"的处置完全不同（前者要排期，后者要写进文档让后人别再提）。因此本台账每条都有状态字段，`接受不修` 必须带理由与复核条件。

**三、关账判据优先于修复速度。**
每条债都先写"怎么算关"，再谈什么时候修。没有闭环判据的债不许进待办——那会变成一张永远画不完勾的愿望清单。反过来，判据达成的债立刻标 `已关`，哪怕实现很糙；判据没达成的债不许因为"快做完了"就标关。

**四、每条债必须现场核实，核实必须跨仓、必须保留原文标点。**
这是本台账的第一条纪律，也是它的第一条债务（见 D-000）：我们自己就是"证伪被证伪"教训的执行对象。台账里出现一条未核实的断言，比没有台账更糟——它会让后人以为这块地已经扫过了。

**五、债务状态是快照，不是负担。**
任何一波失败只 revert 该波 commit，宪章与台账保留。明天的台账比今天的更接近真相，这就够了。

---

## 字段约定

| 字段 | 含义 |
|---|---|
| ID | `D-000` 起，永久不变；删条目标 `已关` 不回收号 |
| 位置 | `仓库 文件:行` 或 `commit`，附可复现的核实方式 |
| 根因 | 为什么会欠这笔债（不是"这是什么"） |
| 律法归属 | L1–L7 之一；`元` = 先于七律法的核实纪律 |
| 闭环判据 | 机械可验的关账条件（ grep 计数 / 测试红绿 / 走查结果 ） |
| 建议波次 | Wave 1–4；Wave 1 内注明建议 Lane |
| 状态 | `待办` / `已关` / `接受不修`（必须带理由） |

**四标签归属制度**（先于一切违例清单存在）：台账里每条痕迹必须挂且仅挂一类——`警职执法`（守卫/解析器本身）、`防御排除`（删它=防御变聋）、`平台下发`（文本由执行层数据携带）、`遗留待清`（已知该走还没走）。漏挂标签比违例本身更危险。

---

## D-000 · 元：诊断报告核实结论的归档与证伪撤回

**位置**：外部架构诊断报告的核实结论（本轮方案 §一 输入）。原结论「6 真 1 半 1 假」，实为 **6 真 1 半，证伪项撤回**。

**根因（原样登记撤回经过）**：
初核把「architecture.md 写着"勿用加抽象"」判为编造。实际该句存在于：

```
17dz-platform/docs/architecture.md:74
### 已知短板（用「建评测」解决，勿用「加抽象」解决）
```

（本次已重新核实：`grep -rn "勿用" 17dz-platform/docs/ fshine-agent/docs/` 唯一命中即该行；`grep -rn "建评测"` 跨双仓 md 唯一命中 17dz-platform/docs/architecture.md:74 与 tmp/ 下同一文件的导出副本。）

失误原因二选一或兼具：

1. **只 grep 了 fshine 的 docs（未跨仓）**——该句在 17dz 仓，fshine 仓的 docs 里当然没有；
2. **检索串丢了直角引号「」**——搜 `勿用加抽象` 永远命中不了 `勿用「加抽象」解决`。

**为什么是债**：一次错误的证伪比一次漏检更危险——漏检只是没发现，错误证伪会让后人相信"这块已经查过了、是干净的"。本次若直接采用「1 假」结论，L7 的"端到端 eval 缺失"短板就会被当成外部报告的编造而驳回，整条律法的立项依据随之消失。

**律法归属**：元（核实纪律，先于 L1–L7）。

**纪律（三条，全部写进本台账的执行方式）**：
1. **核实必须跨仓做**——任何"X 仓没有 Y"的结论，必须先证明在另一个仓里也搜过；
2. **检索必须保留原文标点**——直角引号「」、全角括号、弯引号都是检索字符，不是装饰；
3. **证伪行为本身也要能被证伪**——每条证伪都要附"我当时搜了什么、在哪些路径搜的"，让下一个人能重放这次搜索并发现它漏了什么。

**闭环判据**：本台账每条债的「位置」字段都附可复现核实方式；本台账之后新增任何条目，若不含核实方式，视为未完成条目。

**建议波次**：Wave 1（本条即落地）。

**状态**：待办（纪律已立，待 Wave 4 关账复核时验证"本台账是否真的没有未核实断言"）。

### 其余 6 真 1 半的证据链

| # | 诊断项 | 核实结论 | 本次复核 |
|---|---|---|---|
| 1 | 契约介质是散文（跨仓协议无编译器，漂移不报错） | 真 | 复核通过，且比诊断时更严重：见 D-011（plan 形状 6 处散文且自相矛盾）、D-012、D-013 |
| 2 | 文档内部矛盾（§2 要求编排层不懂口径 vs §9 把写操作人机确认派给编排层） | 真 | 复核通过：context.ts:360 渲染「借贷合计」+ ChangeIntentRecord 持 accountSet/period/summary，正是该矛盾的必然形状（D-003 / D-030） |
| 3 | 验收标准错位（按"零泄漏"审永远不满意） | 真 | 复核通过：物理极限是"受控"而非"零"，需 Tier-1 量化（D-060） |
| 4 | 无 eval（可信度无法量化，只能靠审计轮次人肉挑） | 真 | 复核通过：`.runtime/` 有 40+ 探针 JSON，无 scores.jsonl、无语料库、无评委提示词（D-060） |
| 5 | 今日节奏本身在养隐性债（并行 subagent、事故驱动、未经整体 review） | 真 | 复核通过，且本次审计本身就是该结论的实证：本台账 38 条目中 18 条为本次新发现（D-004/005/010/011/015/017/021/022/052/056/057/061/062/063/064 及 D-018 的阴性结论），其余为对账登记 |
| 6 | 2048 常数证明未经质疑的假设会腐烂 | 真 | 复核通过：cef97c9 已修（MAX_REPLY_BYTES=20480），但留下两条尾债 D-021 / D-022 |
| 半 | FSHINE_* 已被 lint 禁绝 | **半真** | 见下 |

**半真项 · FSHINE_* 现状（本次顺手核实）**：

- lint 的 `FORBIDDEN` 正则只禁绝 **E4 治理六名**：`FSHINE_(MODE|INVOCATION|COMMIT_TOKEN|GATE_SECRET|EXECUTOR|MOCK_STATE)`（`packages/agent/platform-leak-lint.test.ts`）。
- 该六名在 fshine src **确已零出现**（`grep -rn "FSHINE_" packages/*/src apps scripts` 无命中）——**"已被 lint 禁绝"这半句为真**。
- 但 fshine src 仍有 **3 个 FSHINE_\* 名字不在禁绝集内**：`FSHINE_REAL_COMMIT`（platform-mock.ts:16，写放行总闸）、`FSHINE_PI_AGENT_DIR`（pi-coding-driver.ts:172）、`FSHINE_PLATFORM_CONCURRENCY`（context.ts:274）——**"FSHINE_* 已禁绝"这半句为假**（见 D-017）。
- 17dz 侧残留确为 **dz-env 过渡期双读/双写**：`src/lib/dz-env.js:12/18/23/27/31/35/39` 六处 `DZ_* ?? FSHINE_*` 回退 + `setServe` 双写；`src/execution/gateway.js:90` 仍写 `env.FSHINE_INVOCATION`（注释标 `E4 双写过渡`）。
- **关键发现**：dz-env.js 注释写的移除条件是「写入端（fshine / 网关铸造）全部切换到 DZ_\* 并稳定一个周期后」。而 fshine（assembly.ts:84 / ask.ts:52 / acceptance.ts:200）**已经只写 `DZ_SERVE='1'`、不写 FSHINE_MODE**；仍在双写 FSHINE_\* 的是 **17dz 自己的 `src/execution/runner.js:25`（`dzEnv.setServe`）与 `gateway.js:90`**。即：退役阻塞在 17dz 自身，且移除条件里没写"稳定一个周期"是多久、谁来判断（见 D-016）。

---

## L1 · 业务词汇只住执行层 + 夹具 + 文档；宿主 src 非防御性零出现

> 机械守卫：leak-lint 业务词预算（`BUSINESS_WORD_RE = /应收|凭证|科目|账套|期间|目录/`，命中集冻结只减不增）。
> 四标签：以下 D-001/D-002 为非防御违例（必修）；D-003 属 L4 结构性违例；D-004/D-005 是守卫本身的洞。

### D-001 · persona 仍写"企业财务助手"

- **位置**：`fshine-agent/packages/agent/src/runtime.ts:1539`
  `'你是企业财务助手和面向用户的主 Agent。'`
  核实：`grep -rn "企业财务助手" --include=*.ts packages apps scripts | grep -v test` → 唯一命中。
- **根因**：persona 把宿主定位成"财务助手"——领域定语住进了编排层。亲和力本应由每回合注入的 business skill 提供，不靠 persona 声明身份。
- **律法归属**：L1。
- **闭环判据**：该行不含任何领域定语（改为"面向用户的主 Agent"）；`grep -rn "财务" packages/*/src apps scripts` 在非测试 src 零命中（需先把 `财务` 加进 `BUSINESS_WORD_RE`，见 D-005）。
- **建议波次**：Wave 1 · Lane C④。
- **状态**：待办。

### D-002 · 错误码消息文案含"税号"

- **位置**：`fshine-agent/packages/agent/src/error-codes.ts:158`
  `text: '没有找到匹配"{query}"的对象。请确认准确名称（或编号/税号）后我再查。'`
  核实：`grep -rn "税号" --include=*.ts packages apps scripts | grep -v test` → 唯一命中。
- **根因**：选择类澄清模板由宿主持有，宿主不该知道"税号"这个领域概念。中性措辞应由平台 correctForm 作为**数据**加回（Wave 2 依赖 Lane B③ 的错误信封 correctForm）。
- **律法归属**：L1。
- **闭环判据**：模板文案零领域词；「或编号/税号」改由平台信封 correctForm 携带，宿主渲染层零业务词（测试：`clarificationTextFor` 两条模板不匹配 `/应收|凭证|科目|账套|期间|目录|税号|财务/`）。
- **建议波次**：Wave 1 先降级为中性；Wave 2 由平台 correctForm 作为数据加回。
- **状态**：**已关**（2026-09-27 Wave 2 Lane D 关闭）。
  关闭方式：`error-codes.ts` 的 NOT_FOUND_SELECTION 退化为纯结构模板
  `没有找到匹配“{query}”的对象。{hint}我再查。`——`{hint}` 槽位优先取平台信封
  `error.correctForm`（platform-contract 的 `selectionClarificationOf` 解析，带控制字符
  清洗 + 200 字截断），宿主表只存"信封没带时的兜底"（`hintFallback: '请确认准确名称后'`，
  挂「遗留待清」）。测试：`error-codes.test.ts` 钉住"带 correctForm 渲染平台措辞 / 不带
  用宿主兜底且不出现空泛占位"；e2e `turn-loop-clarification.test.ts` C3 走真 mock 信封
  （期望值经 harness 的 `platformCorrectForm` 跨仓读平台错误码表，不抄第二份台词）。
  复核条件：平台若给 ACCOUNT_SET_NOT_FOUND 的 correctForm 带上领域词，那是**平台下发**
  数据（宪章四标签之"平台下发"），不算宿主违例；宿主兜底字符串在平台全域携带后删除。

### D-003 · 写路径确认摘要在编排层渲染"借贷合计"

- **位置**：`fshine-agent/packages/agent/src/context.ts:360`
  `` `- 条目：${proposal.summary.count} 条，借贷合计各 ${proposal.summary.credit} 元` ``
  同源：`packages/agent/src/context.ts:340-346`（`ChangeIntentRecord` 持 `accountSet` / `period` / `summary{count,debit,credit}`）。
  核实：`grep -rn "借贷合计" --include=*.ts packages apps scripts | grep -v test` → 2 处命中（另一处见 D-006）。
- **根因**：写路径的业务字段住在编排层（架构 §2 判据要求"编排层不懂口径"，§9 却把写操作人机确认派给编排层——文档内部矛盾的必然形状）。
- **律法归属**：L1（业务词泄漏）+ L4（写路径保险箱，主归属）。
- **闭环判据**：`ChangeIntentRecord` 只剩不透明 payload；"条目数/借贷合计"由 17dz 盖章 summary 并经平台渲染；`grep -rn "借贷" packages/*/src` 零命中。**与 D-030 同一条债，不重复关账。**
- **建议波次**：Wave 3。
- **状态**：待办。

### D-004 · 业务词预算的扫描范围只覆盖 `packages/agent/src`，`apps/` 生产代码在守卫之外

- **位置**：`fshine-agent/packages/agent/platform-leak-lint.test.ts`（`businessWordHits(path.join(REPO_ROOT, 'packages/agent/src'))` 一处硬编码单目录）。
  核实（本次实扫，命令与结果）：
  ```
  node -e "… 对 packages/ apps/ scripts/ 三目录跑同一把 BUSINESS_WORD_RE …"
  packages: 27 hits（其中 22 行在冻结基线内）
  apps:      6 hits  ← 守卫盲区
  scripts: 144 hits ← 守卫盲区
  ```
  `apps/` 6 处命中逐条：`assembly.ts:149,157 目录`、`commit.ts:3 账套`、`commit.ts:105 账套,凭证`、`commit.ts:113 凭证`、`reply.ts:11 凭证`。
  对照：同一文件里第三条预算（字面量 if）的 `LITERAL_IF_SCAN_DIRS = ['packages/agent/src', 'apps']` **覆盖 apps**，第一条预算（平台实现细节）的 `SCAN_DIRS = ['packages','apps','scripts']` **覆盖三目录**。唯独第二条（业务词）只有一个目录——是三条预算里唯一的范围不一致。
- **根因**：守卫写的时候只想到"编排层 = packages/agent/src"，忘了 `apps/server`（生产装配、落账执行器）与 `scripts` 也属编排层。且 `commit.ts` 正是写路径代码，`reply.ts:11` 正是彩蛋文案——盲区恰好压在风险最高的两个文件上。
- **律法归属**：L1。
- **闭环判据**：`businessWordHits` 的扫描目录与 `LITERAL_IF_SCAN_DIRS` 对齐为 `['packages/agent/src', 'apps']`（scripts 的排除须显式声明并注释理由，见 D-005 附条）；`apps/` 现有 6 处命中逐条归类进基线（带四标签）或清除；新增任意一行即红。
- **建议波次**：Wave 1 · Lane C③（加词与归属制度落地时一并扩范围；顺序仍须"先清违例再加词"）。
- **状态**：待办。

### D-005 · 业务词表收词不全：正在用的伪装形一个都抓不到

- **位置**：`fshine-agent/packages/agent/platform-leak-lint.test.ts` 的 `BUSINESS_WORD_RE = /应收|凭证|科目|账套|期间|目录/g`。
  核实（读码）：
  - `packages/agent/src/step-text.ts:57-76` 的进度帧模板写的是「正在检索**目录**」「查询当前**时间范围**」「拉取**记录**」「正在做摸底」「检索**档案**」——`时间范围` 是 `期间` 的伪装形，`记录`/`档案` 是 `凭证` 的伪装形，`摸底` 是域操作的伪装形；
  - `runtime.ts:1539` 的「企业**财务**助手」含 `财务`，不在表内；
  - `context.ts:481` 的 `期间` 命中，但 `context.ts:55/99/493/644/683/690/697` 七处 `目录` 只有部分进基线。
- **根因**：词表按"最显而易见的六个领域词"定，而泄漏的真实形状是**同义改写**。进度帧尤其危险——它是唯一直接上用户屏的宿主生成文本，却靠一串近义词绕过守卫。
- **律法归属**：L1。
- **闭环判据**：词表扩充为 `应收|凭证|科目|账套|期间|目录|税号|财务|余额|往来` 加一张**同义改写对照表**（`时间范围→期间`、`记录/档案→凭证`、`摸底→域操作`）；进度帧模板（`step-text.ts` + `operationStepText`）逐条过对照表后命中数为 0，或全部挂 `平台下发` 标签（label 来自 operations.json 第 5 列）。
- **建议波次**：Wave 2（需先有 D-004 的范围修正，否则扩词只在 packages/agent/src 内生效）。
- **状态**：待办。

### D-005 附条 · `scripts/` 144 处命中：接受不修，但必须把"不修"写成显式决策

- **位置**：`fshine-agent/scripts/**`（144 处业务词命中，集中在 `acceptance.ts` 45 处、`long-session-acceptance.ts` 9 处、`ask.ts` 3 处、`acceptance-22-supplement.ts` 2 处、`mock-commit-smoke.ts` 1 处）。
- **律法归属**：L1。
- **建议波次**：Wave 1 · Lane C③（与 D-004 同一处改动）。
- **状态**：**接受不修**。
- **理由**：`scripts/` 是验收夹具与探针替身，领域词在这里是**测试数据**不是**宿主替平台说话**——`L1 律法原文即"业务词汇只住执行层 + 夹具 + 文档"`，夹具本就在白名单内。把它们纳入"只减不增"预算会直接冻结 144 行，反而挡住后续收敛。
- **复核条件**：若 `scripts/` 下新增**非夹具**用途文件（如把某段验收逻辑提升为生产代码），本条即失效，该文件须并入 D-004 的扫描范围。**排除必须写成 lint 里一行显式常量 + 注释，不允许继续以"忘了传这个目录"的形式存在。**

### D-006 · 编排层脚本编造财务数字（验收替身数据）

- **位置**：`fshine-agent/scripts/long-session-acceptance.ts:34`
  `` assistant: `已完成 ${name}（${id}）${period} 期查询：凭证共 ${...} 张，借贷合计各 ${((i * 3517) % 900000 + 1000).toLocaleString()} 元，全部借贷平衡。` ``
  核实：`grep -rn "借贷合计" --include=*.ts packages apps scripts | grep -v test` → 与 context.ts:360 并列两处命中。
- **根因**：长会话验收脚本用算术公式现场生成"借贷合计各 N 元"的假财务结论，作为模型替身回复。这与 rule-landing §9/§14 记录的事故（在真实数据旁编造补充数字）是同一形状，只是发生在夹具里。
- **律法归属**：L1（领域词进编排层）+ L7（编造数字的形态进了语料）。
- **闭环判据**：替身回复改为逐字引用脚本预置的真实数字（`ScriptLine` 里的 expected 值），不再用公式生成；或显式挂 `防御排除`/`夹具` 标签并在文件头注明"本文件的数字全部是编造的，不得作为期望值引用"。
- **建议波次**：Wave 1（与 Lane C⑤ 的测试密封性同批）。
- **状态**：**接受不修（显式决策）**（2026-09-27 Wave 2 Lane D 登记）。
  **决策**：走闭环判据的第二条路——**显式挂夹具标签**，不改代码逻辑。
  理由：① 该脚本是长会话压缩/记忆探针的验收夹具，`round()` 的数字用途是给 compact
  与探针提供"真实感"输入材料，**不作为任何期望值**（脚本本身不断言数字，只观察压缩
  与记忆行为）；② 第一条路（逐字引用预置真实数字）需要为 40 轮各准备一组平台真实
  返回值——夹具的输入多样性（不同账套/期间/游标）正是压缩质量的考察面，换成同一组
  真实数字会削弱考察；③ 与 D-005 附条同一判据：scripts/ 是验收夹具与探针替身，
  领域词与编造数字在这里是**测试数据**，不是宿主替平台说话。
  **落地**：`scripts/long-session-acceptance.ts` 文件头新增【夹具声明（D-006 显式决策）】
  ——数字全部编造、不得作为期望值引用、要断言先换平台真实值。业务词预算的 scripts/
  显式排除（`BUSINESS_WORD_EXCLUDED_DIRS`）与本条互为印证。
  **复核条件**：若该脚本的任何输出被当作期望值引用（如进 CI 断言），本条重开并升级为
  待办（按第一条路修）。

---

## L2 · 跨仓协议事实平台机器可读地拥有，宿主消费不抄写

> 机械守卫：`bin/17dz` 在 fshine src 的出现次数只减不增（grep 计数）+ 镜像表存在性。
> 四标签：`警职执法`（解析器常量：parsePlanCallsCommand / 拦截正则 / serve-gate 形式判定——平台看不到提交前命令，替不了宿主解析，挂标签保留）。

### D-010 · 网关名 `bin/17dz` 在审查窗口内**增加** 75%，违反"只减不增"

- **位置**：`fshine-agent` 非测试 src。
  核实（两次快照对比，同一种统计方法）：
  | 时点 | 次数 | 文件数 |
  |---|---|---|
  | `f4eed9c`（窗口起点） | 20 | 8 |
  | `5e011ca`（HEAD） | 35 | 10 |
  | 增量 | **+15（+75%）** | +2 |

  新增来源逐文件：`error-codes.ts` 0→7（新文件）、`plan-runtime.ts` 1→7（+6）、`operation-labels.ts` 0→1（新文件）、`context.ts` 2→3（+1）。
  另：方案里写的基线「33 处/8 文件」**少算 2 处**——`git grep -- 'scripts/**/*.ts'` 的 pathspec 匹配不到 `scripts/` 顶层文件，`acceptance.ts` 与 `mock-commit-smoke.ts` 各 1 处被漏掉。真实 HEAD 基线是 **35 处 / 10 文件**。
- **根因**：窗口内两个新文件（`error-codes.ts` 建表、`operation-labels.ts` 接 CLI）与 `plan-runtime.ts` 的错误消息扩写，都在往宿主里抄网关名。没有任何机械守卫在拦"只减不增"——这条律法目前**只有判据没有锁**。
- **律法归属**：L2。
- **闭环判据**：`bin/17dz` 字面量在 fshine 非测试 src 的出现次数 ≤ 20（回到窗口起点），且全部挂在 `警职执法` 标签下（解析器/spawn 路径构造）；消息文本与提示词里的网关名改由 `GATEWAY_INVOCATION` 常量或 context profile 配置派生。**锁的形式**：把该计数写成 leak-lint 第四条预算（新增即红，收敛直接通过）。
- **建议波次**：Wave 1 · Lane C①（进行中：工作区已有把字面量替换为 `GATEWAY_INVOCATION` 的未提交改动，替换后需补计数锁）。
- **状态**：待办。

### D-011 · plan 形状散文 6 处，且**自相矛盾**：5 处教一个平台不存在的字段

- **位置**（`fshine-agent`，非测试 src，全部 6 处）：
  | 位置 | 教的形状 |
  |---|---|
  | `packages/agent/src/error-codes.ts:55`（`CORRECT_PLAN_SHAPE`） | `plan {"goal":"…","calls":[…]}` |
  | `packages/agent/src/error-codes.ts:73`（`PLAN_SUBCOMMAND_RESERVED`） | `plan {"goal":"…","calls":[…]}` |
  | `packages/agent/src/error-codes.ts:81`（`PLAN_JSON_NOT_OBJECT`） | `plan {"calls":[…]}` ← **唯一与平台一致的一处** |
  | `packages/agent/src/error-codes.ts:85` | `plan {"goal":"…","calls":[…]}` |
  | `packages/agent/src/error-codes.ts:191`（`PLAN_SHAPE_GATE_TEACHING`） | `plan {"goal":"…","calls":[{...}]}` |
  | `packages/agent/src/context.ts:693`（worker 系统提示词） | `plan {"goal":"…","calls":[…]}` |

  核实（跨仓，读平台权威实现）：
  - `17dz-platform/src/execution/plan.js:221-226` `function evaluate(taskId, input, env)` 只读 `input.calls` 与 `input.requestId`，**全文没有 `goal`**（`grep -n "goal" src/execution/plan.js` → 0 命中）；
  - `17dz-platform/.agents/skills/automation-orchestrator/SKILL.md:36`（计划契约节，48fe99b 起被定为 worker 领域规则唯一事实源）教的是 `{"calls":[{"operation":"voucher.query-saved","args":["账套名","YYYYMM"]}]}`——**无 goal**；
  - `17dz-platform` 全仓 `grep -rn '"v":2\|schema v2\|RESULT v2' src/` → 0 命中，无 v2 信封。
- **根因**：`goal` 是宿主自己发明的幻影字段。平台静默丢弃它（不校验、不存储、不报错），所以模型带不带都能跑——直到某天平台开始严校验，或模型因为"这个字段明明在错误消息里"而坚持填写而与 `calls` 位置打架。更直接的伤害是**同一张错误码表给出两种互相矛盾的形状**：模型撞到 `PLAN_JSON_NOT_OBJECT` 时被告知 `{"calls":[…]}`，撞到其他四个码时被告知 `{"goal":"…","calls":[…]}`——这正是"模型静默选一份信"的机制。
- **律法归属**：L2。
- **闭环判据**：6 处散文收敛为 1 处（正确形状从 17dz SKILL 或平台 JSON schema 派生，宿主只持指针/常量）；`grep -rn 'plan {"goal"' packages/*/src apps scripts` → 0 命中；`error-codes.ts` 全部 `correctForm` 与平台 `plan.js` 的 `canonicalCall` 实际接受形状逐字一致（测试断言，不是人眼比对）。
- **建议波次**：Wave 2（与 Lane B④「SKILL 两节删改」同批——本条的权威源正是那一节）。
- **状态**：**已关**（2026-09-27 Wave 2 Lane D 关闭）。
  关闭方式：`error-codes.ts` 新增唯一教学源 `planDraftExample()`——内容与平台
  `src/execution/plan-schema.json` 声明一致（`{"goal":"…","calls":[{"operation":"…","args":[…]}]}`，
  calls 必填、goal 是声明过的可选元数据）；error-codes 表内 5 处（CORRECT_PLAN_SHAPE /
  PLAN_SUBCOMMAND_RESERVED / PLAN_JSON_NOT_OBJECT / PLAN_CALLS_NOT_ARRAY /
  PLAN_SHAPE_GATE_TEACHING）与 context.ts worker 提示词 1 处**全部**由它派生。
  **闭环判据的修订**：原判据 `grep 'plan {"goal"'` → 0 命中已作废——Lane B 交付的
  plan-schema.json 把 goal **收编为声明过的可选元数据**（平台判断"宿主已经在教它，
  声明 + 校验比否决更符合单一来源"），教学示例因此合法地含 goal。新锁是机械的：
  `packages/agent/plan-teaching.test.ts` 跨仓读平台 schema 断言①顶字段全在声明内
  （additionalProperties:false 镜像）、calls 必填、goal 在 properties 里（不是幻影字段）；
  ②宿主解析器 parsePlanCallsCommand 认同一形状（教学与解析不打架）；③两个源文件里
  除 planDraftExample 外零第二种草案形状字面量。`bin/17dz plan --schema` CLI 形态平台
  未提供（plan 只有 evaluate/current/status/activate），按方案许可读平台文件核验。

### D-012 · `KEY_ARG_FLAGS` 镜像：17dz `operations.json` 无 args 规格

- **位置**：`fshine-agent/packages/agent/src/serve-gate.ts:72`
  `export const KEY_ARG_FLAGS: readonly string[] = ['--query', '--period', '--subject-code'];`
  测试同款：`packages/agent/serve-gate.test.ts:153`。
  核实（跨仓）：`17dz-platform/src/finance/operations.json` 的 operation 条目只有 `name/est_seconds/command/script/executor/compat/access/label/effects/serve`——**无 `args` 规格字段**（`python3 -c "import json; ..."` 逐条打印确认）。
- **根因**：宿主为渲染进度帧自己维护"哪些 flag 是用户认得出的"名单。平台注册表才是这个事实的权威处，但还没把它机器可读地下发。
- **律法归属**：L2。
- **闭环判据**：17dz `operations.json` 每 operation 有 `args` 规格（Lane B① 交付）→ 宿主 `KEY_ARG_FLAGS` 删除，改为读平台清单；删除后 `serve-gate.test.ts:153` 的名单断言改为"从 operations.json 派生"。
- **建议波次**：Wave 2（**依赖 Lane B①**，B 不落地则本条顺延）。
- **状态**：**已关**（2026-09-27 Wave 2 Lane D 关闭；Lane B① 已交付 args 规格）。
  关闭方式：`operation-labels.ts` 新增 `parseOperationArgStyles` / `loadOperationArgStyles`——
  经同一公共 CLI 的 `operation list --json`（平台把 args 规格只放机器消费面，TSV 维持 5 列
  纪律取 label）派生 flag→样式表；`serve-gate.ts` 的 `KEY_ARG_FLAGS`/`KEY_ARG_STYLES`
  硬编码表**已删**，`describeKeyArgs(command, styles)` 改为查规格渲染：规格里没有的 flag
  / 无规格 → 不进摘要（与 label 缺失同族的安全缺省，绝不回退硬编码名单）。
  `pi-coding-driver` 按平台根缓存派生并注入（测试替身注入点同名保留）。
  测试：`serve-gate.test.ts` 原"名单断言"改为"规格是唯一口径"（含"无规格 → 空摘要"反向
  断言，防回退硬编码）；`operation-labels.test.ts` 新增规格解析/派生两面用例（含 none
  布尔开关不入表、CLI 失败三态空表）。
  变异验证：把 `describeKeyArgs` 改回硬编码名单 → 上述反向断言红。

### D-013 · `ask.ts` 逐字复刻装配层的 `planConfirmation.savePending`

- **位置**：`fshine-agent/scripts/ask.ts:131-136` 与 `fshine-agent/apps/server/assembly.ts:167-172`。
  两处代码逐字相同（含 `decision: 'confirm'`、`expiresAt: new Date(Date.now() + 10 * 60_000)`、`evaluation: {}` 三个字面量）。
- **根因**：`cc4ea40`（ask.ts 接计划确认门）为了让单进程 CLI 覆盖 confirm 档，把装配层的接线整段抄了一份。抄的时候没有共用的装配函数可调。
- **律法归属**：L2。
- **闭环判据**：`planConfirmation` 对象从装配层导出（如 `createPlanConfirmationWiring(deps)`），`ask.ts` 与 `assembly.ts` 都调它；两文件中不再出现 `savePending` 的字面量实现；`10 * 60_000` 的 TTL 只有一处定义（可命名 `PLAN_CONFIRMATION_TTL_MS`）。
- **建议波次**：Wave 2（方案已列为夹带小刀）。
- **状态**：**已关**（2026-09-27 Wave 2 Lane D 关闭）。
  关闭方式：`apps/server/plan-confirmation-route.ts` 新增导出工厂
  `createPlanConfirmationWiring({dbPath, platformRoot, planActivationSecret})`——仓库创建、
  verifyActivatable（loadPlanStatus → PlanSupersededError）/ activate（activatePendingPlan）
  两个平台回调、savePending 落库形状全部收在这一处；assembly.ts 与 scripts/ask.ts 都调它
  （ask.ts 退出前多调一次 wiring.close()，行为等价于原来的进程退出）。TTL 收敛为
  `PLAN_CONFIRMATION_TTL_MS`（一处定义）。行为逐字不变：决策仍固定 'confirm'、
  evaluation 仍为 {}、verify 仍先问平台计划状态。装配接线的测试覆盖见 D-063（同波补齐）。

### D-014 · `workerTimeoutMs` 默认值 600_000 在 5 处各写一遍

- **位置**：`packages/agent/src/context.ts:32`（`DEFAULT_WORKER_TIMEOUT_MS = 600_000`）+ `apps/server/assembly.ts:186` + `scripts/ask.ts:98` + `scripts/long-session-acceptance.ts:74` + `scripts/acceptance-22-supplement.ts:44`（四处同样的 `config.contextProfiles['17dz']?.workerTimeoutMs ?? 600_000` + `+ 120_000`）。
- **根因**：`turnBudgetMs` 的派生公式（worker 超时 + 2 分钟余量）没有共用函数，四个入口各写一遍。改一次 worker 超时语义要改五个地方。
- **律法归属**：L2。
- **闭环判据**：公式收敛为一个导出函数（如 `turnBudgetMsFor(profile)`），`grep -rn "600_000" packages apps scripts | grep -v test` → ≤1 处（常量定义）。
- **建议波次**：Wave 2。
- **状态**：**已关**（2026-09-27 Wave 2 Lane D 关闭）。
  关闭方式：`packages/contracts/src/config.ts` 导出 `DEFAULT_WORKER_TIMEOUT_MS` +
  `TURN_BUDGET_MARGIN_MS` + `turnBudgetMsFor(profile)`（公式 = worker 超时 + 2 分钟余量，
  一处定义）；context.ts 的本地常量与 assembly/ask/long-session-acceptance/
  acceptance-22-supplement 四处公式全部改为调它。
  grep 现状（非测试 src）：`600_000` 只剩两处**命名常量定义**——contracts 的
  DEFAULT_WORKER_TIMEOUT_MS 与 probe-real-agent.ts 的 PROBE_REPLY_WAIT_MS（后者是探针
  自己的回复轮询地平线，故意不随配置漂移，已注释说明；D-014 收敛的是 worker 超时公式，
  不是这个等待）。公式字面量零残留。

### D-015 · 17dz mock 的 `fill.js` flag 清单是手抄，无机械锁

- **位置**：`17dz-platform/src/execution/mocks/respond.js:245-253`：
  ```js
  const LEGAL_FLAGS = {
    ...
    'fill.js': ['--save', '--batch', '--start-no'],
  };
  ```
  注释自述「fill.js 按真实 fill.js 的 commander 声明」——即人工转抄。
  核实（读锁）：`17dz-platform/test/test-mock-responder.js:144-158` 的机械锁只覆盖 `query-receivables.js` 与 `search-account-sets.js` 两个 operation（与真脚本导出的 `LEGAL_FLAGS` 逐项 deepEqual）；`fill.js` 的三条**没有锁**。真脚本侧 `src/voucher/scripts/fill.js:14-16` 用 commander 声明 `--batch/--save/--start-no <n>`，不导出 `LEGAL_FLAGS`，所以也没法被现有的锁覆盖。
- **根因**：`a44e128`（"补 Tier-1 打分暗区"）把 flag 卫生同步做成了机械锁，但只锁了能导出 `LEGAL_FLAGS` 的两个 finance 脚本。fill.js 走 commander，锁够不着它，于是留了一处手抄。
- **律法归属**：L2。
- **闭环判据**：`fill.js` 的合法 flag 集合要么从 commander 声明机械派生（导出 `LEGAL_FLAGS` 或提供等价派生函数）并进 `test-mock-responder.js` 的同一把锁，要么 mock 侧改为从 `operations.json`/脚本声明读取；锁的覆盖集合 = `respond.js` 的 `LEGAL_FLAGS` 全部键，一个不漏。
- **建议波次**：Wave 1（17dz 侧小刀，与 Lane B 同批不冲突——B 动的是 operations.json 的 args 规格与本文件的 fill 条目，需协调）。
- **状态**：待办。

### D-016 · FSHINE_\* 环境变量退役：移除条件不可执行，且阻塞在 17dz 自身

- **位置**：`17dz-platform/src/lib/dz-env.js`（`serve:12`、`setServe:15-19`、`invocation:23`、`commitToken:27`、`gateSecret:31`、`executor:35`、`mockState:39` 六处 `DZ_* ?? FSHINE_*` 回退）+ `src/execution/gateway.js:90`（`env.FSHINE_INVOCATION = invocation; // E4 双写过渡`）+ `src/execution/runner.js:25`（`dzEnv.setServe(env)` 双写）。
  核实（跨仓）：fshine 侧写入端**已全部只写 DZ_\***（`assembly.ts:84` / `ask.ts:52` / `acceptance.ts:200` 均 `DZ_SERVE='1'`，无 `FSHINE_MODE`）；仍在写 FSHINE_\* 的是 17dz 自己的 `runner.js` 与 `gateway.js`。测试侧依赖：`test/test-auth.js:54,59,83,104,105` 与 `test/test-serve-e2e.js:2,29` 直接用 `FSHINE_MODE` 造场景；`test/test-all.js:20` 的 `LEAKY_EXACT` 含 `FSHINE_REAL_COMMIT`/`FSHINE_EXECUTOR`。
- **根因**：dz-env.js 注释写的移除条件是「写入端全部切换到 DZ_\* **并稳定一个周期**后」——"一个周期"没有定义（多少天？多少次发布？谁签字？），所以这条双读会一直"过渡"下去。且写入端已经切换了，真正在双写的是 17dz 自己，条件里却没提。
- **律法归属**：L2（协议名双真相）。
- **闭环判据**：`dz-env.js` 中 `FSHINE_*` 回退分支全部删除（六处 `??` 链变单读）；`runner.js` 的 `setServe` 只写 `DZ_SERVE`；`gateway.js:90` 双写行删除；`test-auth.js`/`test-serve-e2e.js` 的 `FSHINE_MODE` 用例改为 `DZ_SERVE`；`grep -rn "FSHINE_" src/ test/` → 0 命中（`test-all.js` 的 LEAKY_EXACT 同步收缩）。
- **建议波次**：Wave 2（方案已列）。
- **状态**：待办。

### D-017 · 三个 FSHINE_\* 名字不在 lint 禁绝集内，"FSHINE_\* 已禁绝"是半真

- **位置**：`fshine-agent/packages/agent/src/platform-mock.ts:16`（`REAL_COMMIT_ENV = 'FSHINE_REAL_COMMIT'`，:28 读它做写放行总闸）、`packages/agent/src/pi-coding-driver.ts:172`（`FSHINE_PI_AGENT_DIR`）、`packages/agent/src/context.ts:274`（`FSHINE_PLATFORM_CONCURRENCY`）。
  核实：`grep -rn "FSHINE_" packages/*/src apps scripts | grep -v test` → 恰好这 3 个名字、4 处（另 context.ts:151/272 是注释与文档串）。
  禁绝集实际内容（`platform-leak-lint.test.ts` 的 `FORBIDDEN`）：`FSHINE_(MODE|INVOCATION|COMMIT_TOKEN|GATE_SECRET|EXECUTOR|MOCK_STATE)`——恰好不含这三个。
- **根因**：E4 命名统一只覆盖"治理接口"六名；`FSHINE_REAL_COMMIT` 是写放行安全开关（比治理接口更危险——它是真写的总闸），却因为"不是 E4 那一批"而没被纳入禁绝集，也没被改名。命名空间从此分裂：治理接口叫 DZ_\*，安全开关叫 FSHINE_\*。
- **律法归属**：L2。
- **闭环判据**：三者要么统一改名（`DZ_REAL_COMMIT` / `DZ_PI_AGENT_DIR` / `DZ_PLATFORM_CONCURRENCY`，17dz `test-all.js` 的 LEAKY_EXACT 已预留 `DZ_REAL_COMMIT`）并把 `FSHINE_` 整体加入 lint 禁绝集，要么在 lint 里显式登记"这三个是有意保留的 FSHINE_\*"并注明理由。二选一，不许继续处于"没决定"状态。
- **建议波次**：Wave 2。
- **状态**：待办。

### D-018 · 双仓错误码表零漂移（对账通过，登记为"已关"的守卫）

- **位置**：`fshine-agent/packages/agent/src/error-codes.ts`（32 条）↔ `17dz-platform/src/lib/error-codes.js`（27 条）。
  核实（本次机械比对）：两侧码集合**完全不相交**——fshine 持宿主码（PLAN_SHAPE_\* / PLAN_CALL_\* / DELEGATION_\* / FALLBACK_\* / 状态话术），17dz 持平台码（INVALID_\* / \*_NOT_FOUND / \*_AMBIGUOUS / AUTH_\* / GATE_\* / PLAN_CALL_MISMATCH / NO_SAMPLES）。唯一双侧共名的 `ACCOUNT_SET_AMBIGUOUS`/`ACCOUNT_SET_NOT_FOUND` 是有意分层（平台持错误码+消息，宿主持澄清模板），非漂移。
- **律法归属**：L2。
- **闭环判据**：已达成（本次比对即判据）。
- **建议波次**：—（本条是"查了没漂移"的阴性记录，供 Wave 4 关账复核时确认无需动作）。
- **状态**：**已关**（2026-09-27 D0 审计关闭；若后续任一侧新增与对侧同名的码，本条重开）。

---

## L3 · 状态转换消息 = 宿主持结构化事实机械组装；模型只答数据

> 机械守卫：探针"执行语言指纹"断言 + 回复模板零业务词（L1 叠加）。
> 四标签：`平台下发`（label / correctForm / 候选名——文本由执行层数据携带，宿主只渲染）。

### D-020 · F4 残留：回合真有过执行时，出口校验整体跳过

- **位置**：`fshine-agent/packages/agent/src/runtime.ts:897`
  `const replyText = needsRelay || result.text;`
  上下文：:846-892 的整块出口校验（`!turn.delegationFailed && !turn.execution && ...` 才进）以 `!turn.execution` 为闸门；`turn.execution === true` 时模型文本**不经 `usefulWorkerNote`、不经 `executionLanguageFingerprints`、不经 `hasFinancialFigure`** 直接外发。
  对照（已有守卫的两条路）：`usefulWorkerNote`（runtime.ts:1275-1280）与 `composeClarificationReply`（:1286-1290）是 `delegate_without_execution` / `activated_plan_not_executed` / 选择类澄清三条路的共用尺；`executionLanguageFingerprints`（:65-72）是 Stage 3 事故后新增的准入。
- **根因**：F4-F8 批修（`1e8f2ec`）补的是"零执行"侧的出口校验；"有执行"侧的假设是"真调过平台所以模型说的是数据答案"。但 Stage 3 实测事故的形状恰恰是**execution 为真**（目录搜索真的发生过、`gateCalls>0`）而模型把信封翻译成 1201 字符技术报告——794eab2 用 `clarification` 字段绕过了这一刀，但没有执行语言指纹的通用出口仍在。
- **律法归属**：L3。
- **闭环判据**：`execution === true` 的最终回复也过 `executionLanguageFingerprints`（命中即记守夜事件 `execution_language_leak` 并回落宿主兜底文案，不放行）；测试：构造"execution 为真 + 模型复读协议 JSON"的用例，断言不外发（现有 S1-S5 全部是 `clarification` 挂载路径，需补一条无 clarification 的）。
- **建议波次**：Wave 2（方案已列为夹带小刀）。
- **状态**：**已关**（2026-09-27 Wave 2 Lane D 关闭）。
  关闭方式：`runtime.ts` 新增 `looksLikeProtocolMaterial(text)`——内部协议材料的**形状**判据
  （开头是协议 JSON 且首字段是 recorded/step/next，含 NEEDS_TOOL_RESULT_PREFIX），不嗅探
  内容。复读检测由此**不依赖 execution**：零执行分支的判定同步换成这把尺（顺带盖上
  `{"recorded":"conversation"}` 回显的泄漏），并在出口处独立补一道——有执行也拦，用宿主
  步骤事实汇总（计划模式）/ needs 线索转达替换，守夜事件 `execution_language_leak`
  （reason=protocol_material_replay）。可达性说明：单步委派的执行结果以 ToolUserError
  终止回合（模型说不上话），needs 与 execution 互斥，故"有执行+复读"只可能是计划模式，
  替换文本因此总能落到步骤事实；末级 NO_EXECUTION_CLARIFICATION 只服务零执行形状。
  **判据修订**：原判据的"最终回复全量过 executionLanguageFingerprints"未采纳为硬拦——
  指纹模式（花括号/全大写下划线码）会误伤合法数据答案，且这把尺的既有职责是"注脚准入"
  不是"整回复准入"；复读检测是同一事故形状的更精确子集（协议 JSON 必含花括号，但含
  花括号的不一定是协议 JSON）。守夜事件名沿用原判据的 `execution_language_leak`。
  测试：`runtime.test.ts` F4.1–F4.4（形状判据不误判数据答案 / 计划模式有执行+复读 →
  步骤事实汇总 / needs 回路复读回归 / 零执行申报回显 → 不外发协议 JSON）。

### D-021 · 企微 notice 路径仍用无声截断：cef97c9 只改了最终回复路径

- **位置**：`fshine-agent/packages/channel-wecom/src/adapter.ts:160`
  `await client.replyStream(frame, streamId, truncateUtf8(text, MAX_REPLY_BYTES), false);`
  对照（已修的那条）：同文件 :191-199 最终回复路径用 `truncateReply`（超限追加 `REPLY_TRUNCATED_MARK` + 记 `wecom_reply_truncated` 守夜事件）。
  第三条路径 :157 `void this.reply(frame, reqId, streamId, text, false)`（progress）**完全不截断**。
- **根因**：`cef97c9` 的修法是"用户可见的最终回复要看得见地被截断"，但渠道有三个出口（progress / notice / final），只改了 final。notice 是计划门通知——平台生成的 `noticeText` 由 `账套「…、…、…」；期间…；客户「…」；科目「…」` 拼接（`17dz-platform/src/execution/plan.js:193-219`，accounts/customers/subjectCodes 三个集合用 `、`  join，**无条数上限**），是最可能超长的一个出口，却用的是无声硬切。
- **律法归属**：L3（状态消息呈现卫生）+ L6（改了一半）。
- **闭环判据**：`truncateUtf8` 在 `adapter.ts` 中不再被直接调用（三个出口统一走 `truncateReply` 或等价"看得见的截断"）；补测试：notice 超长 → 带标记 + 守夜事件（现有 `notice.acceptance.test.ts` 只测送达语义，无长度用例）。
- **建议波次**：Wave 1（与 675bd15 同属渠道层，改动小）。
- **状态**：**已关**（2026-09-27 Wave 2 Lane D 关闭）。
  关闭方式：`adapter.ts` 的 notice 路径从 `truncateUtf8(text, MAX_REPLY_BYTES)`（无声硬切）
  换成 `truncateReply(text)`（超限带 REPLY_TRUNCATED_MARK）+ 守夜事件
  `wecom_reply_truncated`（与 final 同一事件线，新增 `frame` 字段区分出口：notice/final）；
  `truncateUtf8` 的 import 随之删除。progress 路径（第三条出口）仍不截断——它有 4 帧
  硬顶且每帧是平台 label 驱动的短句，登记为既有行为不属本条范围。
  测试：`notice.acceptance.test.ts` 新增长度用例（超长 notice → 带标记 + ≤20480 字节 +
  守夜事件 JSON 断言）。

### D-022 · `adapter.ts` 文件头注释仍写"2048 字节截断"

- **位置**：`fshine-agent/packages/channel-wecom/src/adapter.ts:4`
  `…进度与最终回复的 stream 帧、2048 字节截断、图片上传回传。`
  实际：`MAX_REPLY_BYTES = 20480`（`text.ts:8`，cef97c9 改）。
- **根因**：`cef97c9` 在 `text.ts` 里特意加了"改这个值之前先核对 SDK README，不要再凭感觉抄"的长注释防再抄错，却在同一批改动的 `adapter.ts` 文件头留了一个 2048 的旧数——**防抄错的注释旁边就有一个抄错的注释**。下一个人读文件头会以为上限是 2048。
- **律法归属**：L3（呈现层的注释与代码不符归此；亦可归 L6 化石）。
- **闭环判据**：`grep -rn "2048" packages apps scripts tests | grep -v "历史事故\|W1 曾"` → 0 命中（`text.ts:4` 的事故记述除外，它是故意的历史记录）。
- **建议波次**：Wave 1。
- **状态**：**已关**（2026-09-27 Wave 2 Lane D 关闭）。
  关闭方式：`adapter.ts` 文件头注释"2048 字节截断"改为实情（MAX_REPLY_BYTES = 20480）
  并指向 `text.ts` 常量与"改值前先核 SDK README"的事故记述。grep 判据实测：
  `grep -rn "2048" packages apps scripts tests` 仅剩 `text.ts` 文件头两处故意的历史记录
  （事故记述 + "W1 曾把它写成 2048"）。

---

## L4 · 写路径保险箱：提案 schema / 域校验 / 确认摘要 / commit 读回全归 17dz；fshine 只持不透明 payload + 通用确认状态机

> 机械守卫：走查测试"新增 payroll 写路径，fshine 改动数 = 0"。
> 当前状态：生产写关闭中（`capabilities: ["read"]`），是重构最安全窗口。

### D-030 · 写路径业务字段住编排层（§2 与 §9 矛盾的必然形状）

- **位置**：`fshine-agent/packages/agent/src/context.ts:340-346`（`ChangeIntentRecord` 持 `accountSet` / `period` / `summary{count,debit,credit}` / `kind:'voucher.batch'`）+ `:357-361`（确认摘要渲染「条目：N 条，借贷合计各 X 元」）+ `packages/contracts/src/store.ts:233-243`（契约类型定义处）。
- **根因**：架构文档 §2 判据要求"编排层不懂口径"，§9 却把写操作的人机确认派给编排层——确认凭证批就必须懂"金额"。§10 差距表里没有"写路径"这一行，所以违规长期不可见。
- **律法归属**：L4（主）+ L1（D-003，同一处的业务词面）。
- **闭环判据**：`ChangeIntentRecord` 改不透明 `payload` + 平台盖章 `summary`；"条目数/借贷合计"由 17dz 渲染；fshine 只留通用确认状态机（确认码/有效期/principal/计划版本绑定）；§10 差距表补"写路径"行。**与 D-003 同一条债，关账判据合并。**
- **建议波次**：Wave 3（大项目，可再拆并行）。
- **状态**：待办。

### D-031 · §17 写路径卫生七项（生产写开放前必修）

- **位置**：`fshine-agent/docs/rule-landing.md:326`（登记处）。本次逐条核实 17dz 侧现状：

  | 项 | 位置（17dz） | 本次核实 |
  |---|---|---|
  | S2 | `src/voucher/scripts/fill.js:45,51`（`discoverToken(context, page, contracts[0].accountSet)`、`const firstDate = contracts[0].date`） | **仍在**：批量契约只用 `contracts[0]`，其余静默丢 → 凭证落错账套 |
  | S3 | `src/voucher/scripts/gen-from-journal.js`（账户下拉子串 + `.first()`） | 登记在案（本次未逐行复勘，Wave 3 开工时复核） |
  | S4 | `src/voucher/scripts/gen-from-journal.js`（`--direction`/`--date-mode` 无枚举白名单） | 登记在案（同上） |
  | S5③ | `src/voucher/scripts/fill.js`（`--start-no` NaN 静默丢起始号） | 登记在案（3707bac 只修了 `parseCountFlag` 一族，`--start-no` 是 `parseInt` 另一处） |
  | S7 | `src/voucher/scripts/upload-all.js`（未找到凭证静默跳过仍 exit 0） | 登记在案（文件存在，`git ls-files` 确认） |
  | S9 | `src/voucher/scripts/`（`fuzzyFind` 子串 + `stripCity` 静默采纳简称，写路径） | 登记在案 |
  | S10 | `src/voucher/scripts/parse-tianren-bills.py`（creditRules 未命中静默回落 1122） | 登记在案 |

- **根因**：读路径 live 批（3707bac / 1e8f2ec）已把"静默回落/答非所问"扫清，写路径因为是 latent（生产写关闭）没扫。风险不对称：编排层错误廉价高频，执行层错误昂贵低频（静默落错公司账套）。
- **律法归属**：L4。
- **闭环判据**：七项各自有守卫（枚举白名单 / fail-loud 三态 / 非零退出）；§17 的"遗留"段可整段删除。**判据必须在新结构（保险箱）里成立——不许在旧结构上先修，那会被 Wave 3 重构掉。**
- **建议波次**：Wave 3（与 D-030 同批；若 Wave 3 顺延，本条不得单独提前修）。
- **状态**：待办。

### D-032 · fshine F1：`extractChangeProposal` 剥 ```json 围栏（与被删的 stripCommandWrapping 同族）

- **位置**：`fshine-agent/docs/rule-landing.md:326` 登记处；代码在 `packages/agent/src/context.ts` 的 `extractChangeProposal`（写提案路径）。
  核实：`95b584b` 已删计划命令侧的 `stripCommandWrapping`，`348648e` 已删 C2 兜底绑定；写提案侧的围栏剥除**未删**。
- **根因**：同一族"宿主替模型猜格式"的容忍层，读路径按"不建容忍层"架构删干净了，写路径因为 latent 没删。留着一个同族反例，会让后人怀疑那条架构决定是否只适用于读路径。
- **律法归属**：L4。
- **闭环判据**：`extractChangeProposal` 不再做围栏剥离；模型提交非法形状时按 `PLAN_*` 错误码 fail-loud（三要素消息）；有测试钉住"带围栏的提案被拒"而不是"被正确解析"。
- **建议波次**：Wave 3（与 D-031 同批；写提案 schema 迁移时一并了结）。
- **状态**：待办。

---

## L5 · 失败二分流（模型可修 / 用户对齐）+ 全回路有界

> 机械守卫：B 审计清单（①/②，无第三类）+ 熔断上限测试。
> 现状：`6601ee1` 已把 4 处第三类去向收口；熔断上限已闭环转为不变量。

### D-040 · auth 分类的中文正则兜底（自带移除条件的过渡债）

- **位置**：`fshine-agent/packages/agent/src/context.ts:592`
  `: /平台登录已过期/.test(error instanceof Error ? error.message : '') ? 'auth'`
  注释（:585-591）自述：「平台 auth.js 的自动重登录失败消息是既有唯一不带码前缀的形态，17dz 侧尚未给它挂码；在平台收口之前先留正则兜底……平台侧该消息一带码（走 messageFor），这行即可删除」。
  核实（跨仓）：`17dz-platform/src/lib/auth.js` 的 `headlessRelogin` 失败路径仍未走 `errorFor(...)` 挂码（`grep -n "errorFor\|messageFor" src/lib/auth.js` 无命中），即移除条件**尚未满足**。
- **根因**：平台有唯一一条失败消息不带码前缀，宿主只能嗅探中文。这是 L5 二分流里唯一一处"靠文本不靠码"的判定。
- **律法归属**：L5。
- **闭环判据**：17dz `auth.js` 的自动重登录失败改走 `errorFor('AUTH_*', …)` 挂码 → 宿主删除该正则行，auth 分类 100% 走 `isPlatformAuthError`（码级判据）；测试：一条不带码的 auth 失败不再需要中文正则也能分到 `DELEGATION_AUTH_FAILURE`。
- **建议波次**：Wave 2（与 17dz 六个错误码登域文档同批，D-064）。
- **状态**：**接受不修（限期）**。
- **理由**：删了它，那一条 auth 失败会退化成 `executor_error` → 用户收到"请稍后再试"——对登录态过期是**错指令**（重试多少次都没用）。在平台挂码之前，留正则比删正则正确。这是本条唯一合理的"接受"形态：附带明确移除条件与对侧动作。
- **复核条件**：17dz `auth.js` 一带码即删；Wave 4 关账复核时若平台仍未挂码，须重写理由或升级为待办。

---

## L6 · 零沉积：死代码 / 彩蛋 / 化石 / 空壳 / 陈旧日志不进主干

> 机械守卫（待建）：`src` 为空/无实质源码的 `packages/*` 目录即红；彩蛋/假数据模式扫描。

### D-050 · `mcp-fake` / `mcp-host` 空 src 目录

- **位置**：`fshine-agent/packages/mcp-fake/src/`、`fshine-agent/packages/mcp-host/src/`——**两个目录都存在且为空**（`list_directory` 确认 0 条目）。
  核实（引用面）：全仓 `grep -rn "mcp-fake\|mcp-host" --include=*.json --include=*.ts --include=*.md`（排除 node_modules 与本台账/方案文件）→ **0 命中**；根 `package.json` **无 `workspaces` 字段**，故也不在 npm 工作区里。即：不被任何构建、类型、测试、文档引用。
- **根因**：MCP 层已被 `15cfe1b`（drop mcp layer）删除，目录树没删干净。"无 src 目录"的 lint 措辞抓不到它们——src 存在但是空的。
- **律法归属**：L6。
- **闭环判据**：两个目录删除；新增 lint：`packages/*/src` 下无任何 `.ts` 文件即红（把"空 src"纳入判据，不只是"缺 src"）。
- **建议波次**：Wave 1 · Lane C②。
- **状态**：待办。

### D-051 · `reply.ts` 演示图片彩蛋返回编造的财务数据（在生产入口上）

- **位置**：`fshine-agent/apps/server/reply.ts:9-20`
  ```ts
  const DEMO_IMAGE_PATTERN = /发图|测试图片|图片/;
  ... return { text: '幻晟 202607 凭证金额分布(模拟数据 · 图片通道演示)',
              image: { data: renderBarChartPng([1200, 1850, 990, 2400, 1750, 3000, 1500, 2200]), ... } };
  ```
  核实：`createServerReplyHandler` 由 `apps/server/assembly.ts` 作为 `replyHandler` 导出（生产装配出口）；`DEMO_IMAGE_PATTERN` 匹配任意含"图片"的用户消息。
- **根因**：图片通道演示短路写在生产入口包装里。用户只要打出"图片"两个字，就会收到一张带 8 个编造金额的柱状图——文本虽标了"模拟数据"，图上的数字没有任何标注。这与 rule-landing §9/§14 记录的事故（真实数据旁编造补充数字）同族，且**可从生产入口触发**。
- **律法归属**：L6（彩蛋/假数据）+ L1（:11 的 `凭证`）。
- **闭环判据**：彩蛋从生产入口移除（演示逻辑移入手动脚本或测试替身，并显式挂标签）；`grep -rn "模拟数据\|DEMO_" apps packages --include=*.ts | grep -v test` → 0 命中。
- **建议波次**：Wave 1 · Lane C②。
- **状态**：待办。

### D-052 · `step-text.ts` 6 个退役工具名死分支，且测试把它们当活平台工具钉住

- **位置**：`fshine-agent/packages/agent/src/step-text.ts:57-76` 的 `switch (toolName)` 六个 case：`search_account_sets` / `get_current_accounting_period` / `list_vouchers` / `inspect_account_set` / `search_references` / `get_login_status`。
  测试同款：`packages/agent/step-text.test.ts:31-34`「平台工具仍照常出默认帧」逐条断言这些工具的返回文本。
  核实（工具面）：主 Agent 工具面只剩 `route_current_turn` / `search_history` / `get_messages`（`INTERNAL_TOOLS`，step-text.ts:9-13；`turn-contract.ts` 的申报契约）。`grep -rn "renderToolStepText" --include=*.ts | grep -v test` → 唯一调用点 `pi-driver.ts:317`，而 pi-driver 处理的是宿主内部工具。故六个 case 与 `default` 分支的"正在调用 X…"**全部不可达**。
- **根因**：直接平台工具面已退役（Phase 3 领域判别下沉），渲染层的分支没跟着删。`platform-leak-lint.test.ts` 的白名单注释已经点明这六条是"已退役工具名（死代码）……只有'该删'的债务"，但一直没删。
- **律法归属**：L6。
- **闭环判据**：`step-text.ts` 的 `switch` 删除（或收敛为 `INTERNAL_TOOLS.has(toolName) ? null : null`——既然工具面只剩内部工具，`defaultStepText` 整体可退化为常量 null）；`step-text.test.ts` 的"平台工具仍照常出默认帧"用例改为断言"主 Agent 工具面上不存在平台工具，故一律不出帧"；`LITERAL_IF_WHITELIST` 中 6 条对应条目同步移除。
- **建议波次**：Wave 1 · Lane C②。
- **状态**：待办。

### D-053 · 17dz 仓根 465KB 会话日志被 git 跟踪

- **位置**：`17dz-platform/codex-session-01a0bd75-38f6-79f3-91ed-617ba8fe5ce9.md`（465,137 字节）。
  核实：`git ls-files | grep session` → 该文件在索引中；`git cat-file -s` → 465137；`git log --oneline --follow` → 最后一次改动是 `9140a45`（2026-09-25 07:51，**窗口起点之前**，本窗口内未增长——如实记录，不是本轮新增）。
  同目录未跟踪的 `tmp/kimi-export-session_-20260916-012933.md`（336,605 字节）已被 `.gitignore` 的 `tmp/` 覆盖，非仓库债。
- **根因**：codex 会话导出物落在了仓库根，且被 `git add` 进主干。它同时是 L2 的风险面——本次审计中多处"平台侧事实"的旧文本就存在这个文件里（如 `codex-session-*.md:76,79,80` 引述的旧 `serve-gate.js` / `auth.js` 源码），后人容易把会话记录当成现行文档引用。
- **律法归属**：L6。
- **闭环判据**：`git rm --cached` 该文件并在 `.gitignore` 登记 `codex-session-*.md` / `*-session-*.md`；`git ls-files | grep -c "session.*\.md"` → 0；仓库根不再有任何会话导出物。
- **建议波次**：Wave 1 · Lane B⑤（方案已归本 lane）。
- **状态**：待办。

### D-054 · `.env.real` 本地残留（已 gitignore，本地卫生）

- **位置**：`fshine-agent/.env.real`（1,635 字节，mtime 2026-09-26 19:00）。
  核实：`.gitignore` 已含 `.env.real`（`95fbd6b` 加入）；`git status --porcelain` 不显示它 → **仓库侧已闭环**。
- **根因**：真实平台联调副本（`95fbd6b` 提交信息自述"含同 etc 凭据"）。gitignore 之后它只是本机文件。
- **律法归属**：L6。
- **闭环判据**：仓库侧已达成（未跟踪 + 已 ignore）。
- **建议波次**：—（无仓库动作）。
- **状态**：**接受不修（仓库侧已关）**。
- **理由**：它是真实平台联调的活副本（含企微 UserID 与本机路径），联调还要用；gitignore 已经切断它进主干的路。保留本机文件不构成仓库债。
- **复核条件**：若该文件内容被复制进任何会被跟踪的路径（如 `config/agent.yaml` 或 `.env.example`），本条重开并升级为待办。

### D-055 · `.agents/skills/finance` 死技能 + 配置模板仍指向会复活它的路径

- **位置**：`fshine-agent/.agents/skills/finance/SKILL.md`（2,539 字节，唯一文件）。
  `fshine-agent/config/agent.example.yaml:28`：`skillRoots: [".agents/skills"]`
  对照生产配置 `config/agent.yaml:19`：`skillRoots: [".agents/skills-serve"]`，且 `packages/agent/src/pi-coding-driver.ts:415` 注释「只认显式 skillRoots（.agents/skills-serve）；关闭 cwd/.agents/skills 默认」。
- **根因**：建造期技能面（`.agents/skills`）已被运行态技能面（`.agents/skills-serve`）取代，`.agents/skills/finance` 无运行时加载链。但**版本库里的模板 `agent.example.yaml` 还写着旧路径**——新部署者照模板复制一份 `config/agent.yaml`，配的是一个驱动明确拒绝加载的 skillRoots，于是"技能注入静默失效"。这是"改了一半的新旧并存"：生产配置改了，模板没改。
- **律法归属**：L6（死技能）+ L2（配置默认值双真相）。
- **闭环判据**：`.agents/skills/finance` 删除；`config/agent.example.yaml` 的 `skillRoots` 改为 `.agents/skills-serve` 并加注释说明与建造技能面互斥；新增测试或 lint 断言模板与生产示例一致（或模板值必须在合法集合内）。
- **建议波次**：Wave 1 · Lane C②（模板那一行建议同批改，属于一行修复）。
- **状态**：**已关**（2026-09-27 Wave 2 Lane D 关闭；死技能本体已由 Wave 1 `4362cef` 删除）。
  关闭方式：`config/agent.example.yaml:28` 的 `skillRoots: [".agents/skills"]` 改为
  `[".agents/skills-serve"]` 并加注释（与建造技能面互斥、noSkills 只认显式 skillRoots、
  指错面会静默失效）；新增机械锁 `packages/core/config.test.ts` 的 D-055 用例——读模板
  YAML 断言 17dz profile 的 skillRoots 必须等于 `['.agents/skills-serve']`（模板回退到
  建造面即红）。运行期加载链核实：worker `noSkills:true` + `additionalSkillPaths` 只认
  显式 skillRoots，`.agents/skills` 无任何加载入口（`discoverSkills/createSkillRegistry`
  运行期零调用），删除配置引用不会复活死技能。

### D-056 · 17dz `src/voucher/scripts/` 下住着 5 个测试夹具，其中 2 个已孤儿化

- **位置**：`17dz-platform/src/voucher/scripts/` 下 `test-contract.json`、`test-contract-bad-balance.json`、`test-contract-bad-structure.json`、`test-contract-bad-subject.json`、`test-contract-need-assistant.json`（`git ls-files src/voucher/scripts/` 确认全部被跟踪）。
  同目录还有未跟踪的 `__pycache__/`（本地生成物，`.gitignore` 的 `__pycache__/` 已覆盖，非仓库债）。
  核实（引用面逐条查）：
  - `test/test-validate.js:5` 只读其中 **3 个**（`test-contract` / `-bad-structure` / `-bad-balance`）；
  - `src/voucher/TEMPLATES.md:31` 把 `scripts/test-contract.json` 当 worked example 引用（文档用途）；
  - `test-contract-bad-subject.json` 与 `test-contract-need-assistant.json` **在 src/ test/ 里 0 引用**（`grep -rn "bad-subject\|need-assistant" test/ src/` → 空）——只在 D-053 那个 465KB 会话日志里被提到过。即 **2/5 是孤儿夹具**；
  - 历史决策：`docs/superpowers/plans/2026-08-11-voucher-cleanup.md:426` 明确写过「fixture JSON（`test-contract*.json` 5 个）**留在 `voucher/scripts/` 不动**……双用途」。即"留在 scripts/"是**有意决定过的**，不是疏漏——但它同时是 D-057 那批已无人维护的旧计划文档之一。
- **根因**：契约校验的测试夹具直接放在生产脚本目录里。脚本目录是 `operations.json` 的声明面，夹具混在里面会让"这个目录里全是可执行脚本"的直觉失效，也让按目录扫描的工具（lint、打包、审计）多一类要排除的噪音。两个孤儿夹具连"双用途"的理由都不成立。
- **律法归属**：L6。
- **闭环判据**：`test-contract-bad-subject.json` 与 `test-contract-need-assistant.json` 删除（0 引用，删除零风险）或被某个测试引用；其余 3 个移入 `test/fixtures/`（或显式登记"这是文档 worked example，有意留在 scripts/"并写进 `TEMPLATES.md` 的同一条注释）；`git ls-files src/voucher/scripts/ | grep -c "test-contract"` → 0（或 = 登记数）。
- **建议波次**：Wave 2。
- **状态**：待办。

### D-057 · 17dz `docs/superpowers/` 7 个 2026-08 旧计划/设计文档，零引用

- **位置**：`17dz-platform/docs/superpowers/`（7 个跟踪文件，160K）：
  `plans/2026-08-01-stealth.md`、`plans/2026-08-05-prompt-architecture-refactor.md`、`plans/2026-08-11-voucher-cleanup.md`、`plans/2026-08-11-voucher-flow-trim.md`、`specs/2026-08-01-stealth-design.md`、`specs/2026-08-05-prompt-architecture-refactor-design.md`、`specs/2026-08-06-opencode-mask-plugin-design.md`。
  核实：`grep -rn "superpowers" --include=*.js src/ test/ AGENTS.md .agents/` → **0 命中**；`AGENTS.md` 与 `.agents/skills-serve/README.md` 均不指向该目录；唯一引用它的是 `docs/lifecycle-roadmap.md`（被 superpowers 自己的计划文档反向提及）。
- **根因**：2026-08 的旧轮次计划/设计文档从未清理。它们描述的是当时的代码形状（如 `2026-08-11-voucher-cleanup.md:426` 关于夹具留在 scripts/ 的决定），与现状已有实质差异——却仍然在 `docs/` 下，与现行 `docs/architecture.md`、`AGENTS.md` 并列。后人无法从路径判断哪份是权威。
- **律法归属**：L6。
- **闭环判据**：二选一，都要落成显式决策——(a) 整目录删除（若结论已被 rule-landing / architecture.md 吸收）；(b) 目录改名为 `docs/archive/2026-08-*/` 并在每份文件头加「历史存档，非现行权威；现行定义见 AGENTS.md / docs/architecture.md」横幅。判据：`docs/` 下不存在"无法从路径判断是否现行"的文档。
- **建议波次**：Wave 1 · Lane B（与 B⑤ 的"删仓根 465KB 会话日志"同属文档卫生，一次做完）。
- **状态**：待办。

---

## L7 · 可信度可量化：eval 基线跑漂移，不靠审计轮次

> 机械守卫（待建）：Tier-1 打分器（探针升级 + 记分台 + 语料库）；评委提示词与语料库版本化进仓库。

### D-060 · Tier-1 打分器未建

- **位置**：`fshine-agent/scripts/probe-real-agent.ts`（现有探针，含金额越界/串台/落地/执行语言指纹等判定helper）。
  核实：`find . -name "scores.jsonl" -o -name "*scorer*" -o -name "*tier1*" -o -name "*Tier-1*"`（排除 node_modules）→ 0 命中；`grep -rn "评委\|judge\|四维\|groundedness\|实体保真\|失败诚实\|呈现卫生" scripts/probe-real-agent.ts` → 0 命中；`.runtime/` 有 40+ 个 `probe-fshine-probe-*.json` 原始报告但无记分台、无语料库、无评委提示词文件。
- **根因**：探针是"跑一轮、人读报告、人判过不过"的形态——判定逻辑散在 helper 函数里，没有基线分、没有阈值、没有回归对比。四维分数（groundedness/实体保真/失败诚实/呈现卫生）目前只能靠审计轮次人肉挑，正是今日 30 小时里最贵的成本。
- **律法归属**：L7。
- **闭环判据**：`.runtime/scores.jsonl` 记分台存在且每轮探针写入；四维各有可复现的机械分量（探针断言）+ LLM 评委分量；**评委提示词与语料库随仓库版本化**（否则四维分数不可比）；基线分可复现（同语料同提示词重跑分差在阈值内）；回归有阈值；今日全部事故各一条用例（围栏/驼峰/抽象泄漏/2048/复读/实体串台…）。
- **建议波次**：Wave 4。
- **状态**：待办。

### D-061 · 17dz 测试套件与 `.runtime/rate-limit.json` 耦合，`test-agent-pipeline.js` 当前 RED

- **位置**：`17dz-platform/test/test-agent-pipeline.js`（:69 `assert.equal(r.status, 0, …)` 的 `prepare` 调用被限流拒绝）。
  根因定位：该文件 `agentEnv`（:19-24）设了 `DZ_SERVE/DZ_EXECUTOR/DZ_MOCK_STATE/DZ_GATE_SECRET`，**未设 `DZ_RATE_LIMIT_STATE`**，于是用默认 `.runtime/rate-limit.json`——与真实运行、其他测试、上一轮测试共用同一个令牌桶。
  核实（三连，全部可复现）：
  1. `node test/test-all.js` → `FAILED: agent-pipeline`（`SOME FAILED`，其余全绿）；
  2. 失败消息：`GATE_REFUSE: … 实际 RATE_LIMITED 限流：write 类调用超出速率，约 15s 后重试 …`，exit 3 ≠ 期望 0；
  3. `.runtime/rate-limit.json` 的 `write` 桶 `tokens: 0.339`（近乎耗尽）；
  4. `DZ_RATE_LIMIT_STATE=<临时文件> node test/test-agent-pipeline.js` → **passed**。
  范围核实：`grep -rln "DZ_RATE_LIMIT_STATE" test/` → 只有 `test-rate-limit.js`。其余 6 个会 spawn CLI 的测试文件（`test-agent-pipeline` / `test-auth` / `test-gate` / `test-memory` / `test-mock-responder` / `test-serve-e2e`）**都不隔离**。
- **根因**：`test-all.js` 的测试环境自封（出向）只删了 `LEAKY_EXACT` 名单里的 8 个变量（`DZ_EXECUTOR/FSHINE_EXECUTOR/FSHINE_REAL_COMMIT/DZ_REAL_COMMIT/proxy*/LLM_*`），**没有覆盖"不设就会落到共享真实状态文件"这一类泄漏**。限流是有意做成持久化的（跨进程累计），于是测试就继承了真实运行的桶。
- **律法归属**：L7（验收标准不可复现）+ L5（全回路有界——限流本身没问题，是测试前提被污染）。
- **闭环判据**：`test-all.js` 的自封名单扩展为"所有会落到 `.runtime/` 共享状态的 env（`DZ_RATE_LIMIT_STATE` / `DZ_PLAN_STATE` / `DZ_MEMORY_STATE` / `DZ_AUDIT_PATH`）在未显式设置时指向临时目录"；或每个 spawn CLI 的测试文件自行隔离（推荐前者——一处修，六个文件受益）；修后 `node test/test-all.js` 在**连续两次运行**下全绿（第二次不复现第一次的失败）。
- **建议波次**：Wave 1（这是当前唯一的红灯，阻塞"验收总标准：全量测试"）。
- **状态**：待办。

### D-062 · fshine `npm test` 在无凭据环境 17 文件 52 例全红

- **位置**：`fshine-agent/package.json:10`（`"test": "vitest run"`，无 `--env-file`）+ `vitest.config.ts`（无 `loadEnv` / `envFile` 配置）+ `packages/channel-wecom/src/adapter.ts:60-63`（`start()` 硬性要求 `WECOM_BOT_ID`/`WECOM_BOT_SECRET`）+ `tests/e2e/harness.ts:449`（`assembly.channel.start(recordingHandler)`）。
  核实（本次实测，不是推断）：
  ```
  env -u WECOM_BOT_ID -u WECOM_BOT_SECRET npx vitest run
  → Test Files  17 failed | 44 passed (61)
    Tests       52 failed | 522 passed (574)
  失败信息：Error: 缺少环境变量 WECOM_BOT_ID、WECOM_BOT_SECRET,无法启动机器人长连接
             ❯ WecomBotChannel.start packages/channel-wecom/src/adapter.ts:62:13
             ❯ boot tests/e2e/harness.ts:449:37
  ```
  即：失败与项目代码无关，纯粹是测试进程没继承到本机 `.env`。
- **根因**：e2e  harness 启动**真实** `WecomBotChannel`（只有 SDK client 是替身），而渠道启动硬性要求企微凭证；`npm test` 是裸 vitest 不加载 `.env`。于是"验收总标准：全量测试"只在开发机上成立，在干净机器/CI 上不可复现。附带伤害：狼来了——52 例环境性红灯会掩护真回归。
- **律法归属**：L7。
- **闭环判据**：`vitest.config.ts` 配 `loadEnv`（或 harness 在无凭据环境装假通道/跳过 start），使 `env -u WECOM_BOT_ID -u WECOM_BOT_SECRET npx vitest run` → 0 failed；同时保留"有凭据环境跑真实渠道"的能力（不为了绿而把真实路径测掉）。基线数字：574 例 / 61 文件全绿。
- **建议波次**：Wave 1 · Lane C⑤。
- **状态**：待办。

### D-063 · `loadPlanStatus` 与 `verifyActivatable` 的装配接线无测试

- **位置**：`fshine-agent/packages/agent/src/plan-runtime.ts:81-92`（`loadPlanStatus` → `bin/17dz plan status --plan-id <id>`）+ `apps/server/plan-confirmation-route.ts:12`（`verifyActivatable` 可选注入点）+ `apps/server/assembly.ts:150-153` 与 `scripts/ask.ts:111-114`（两处装配：`loadPlanStatus` → `PlanSupersededError`）。
  核实（引用面）：`grep -rn "loadPlanStatus\|createPlanConfirmationRoute" --include=*.ts packages apps scripts tests | grep -v node_modules` → `loadPlanStatus` 只出现在 `index.ts:66`（导出）、`plan-runtime.ts:81`（定义）、`assembly.ts:150`、`ask.ts:112`；**0 个测试文件引用它**。`plan-confirmation-route.test.ts` 三个用例**都不传 `verifyActivatable`**（只测了 `activate` 成功/失败/provenance 三条）。底层 `matchAndResolvePlanConfirmation` 的 `verifyActivatable` 行为有单测（`plan-confirmation.test.ts:56-76`），但那是替身 stub。
- **根因**：`cc4ea40`（ask.ts 接计划确认门）与 `436aea4`（17dz 新增 `plan status --plan-id`）都是窗口内新代码。安全语义是"用户说'确认继续'时，先问平台这个待确认计划是否还活着，被取代了就解释而不是 generic-fail"——这条链现在只有底层单测 + 人工联调，**没有任何测试断言 assembly/ask.ts 真的把 `loadPlanStatus` 接进了 `verifyActivatable`**。删掉那三行接线，全库依旧全绿。
- **律法归属**：L7。
- **闭环判据**：至少一个测试（单测或 e2e）断言"装配层确实注入了 `verifyActivatable`，且平台返回 `superseded` 时用户收到 `superseded` 解释而非激活/通用失败"；变异验证：删掉 `assembly.ts:150-153` 的注入 → 该测试红。
- **建议波次**：Wave 2。
- **状态**：**已关**（2026-09-27 Wave 2 Lane D 关闭）。
  关闭方式：新增 `apps/server/plan-confirmation-wiring.test.ts`——走**真工厂**
  （D-013 收敛后的 `createPlanConfirmationWiring`，assembly 与 ask.ts 共用同一份接线，
  测工厂即测两个入口）+ 真 SQLite 仓库 + 假平台 CLI（临时目录 bin/17dz 壳脚本，记录每次
  调用）。三条用例：① 平台 status 非 pending → `superseded` 结局、且调用日志里确有
  `plan status --plan-id`（**变异锁**：删掉 verifyActivatable 注入即红）、没有 `plan activate`；
  ② status 为 pending → 放行并真激活；③ savePending 落库形状（decision 固定 confirm、
  evaluation 为 {}、TTL = PLAN_CONFIRMATION_TTL_MS 单一来源）。
  注：原判据的"删掉 assembly.ts:150-153 的注入"已不适用——那三行在 D-013 里收敛进工厂，
  注入只有一处；变异锁改为"删工厂里的 verifyActivatable 传参 → 本测试红"。

### D-064 · 17dz 五个错误码未登域文档（纠正"六个"的说法）

- **位置**：`17dz-platform/src/lib/error-codes.js` 的 `TABLE`（27 条）。
  核实（本次机械比对，`node -e` 扫全部 41 个 .md 后与 TABLE 求差集）：
  - **未登任何域文档**：`INVALID_LIMIT`、`INVALID_COUNT`、`UNKNOWN_DOMAIN`、`PLAN_CALL_MISMATCH`、`NO_SAMPLES`（**5 个**）；
  - `src/finance/MECHANISMS.md:39` 已登 16 个（含 `ACCOUNT_SET_AMBIGUOUS`/`ACCOUNT_SET_NOT_FOUND` 及 `INVALID_PERIOD_RESPONSE`/`INVALID_BALANCE_*`/`INVALID_ASSISTANT_PANEL` 一族）；
  - `src/lib/README.md:182` 已登 `BAD_PERIOD`（作渲染示例）。
  即：`rule-landing.md:326` 写的「17dz 新错误码（ACCOUNT_SET_AMBIGUOUS/BAD_PERIOD/INVALID_LIMIT/INVALID_COUNT/NO_SAMPLES/UNKNOWN_DOMAIN）尚未登域文档」**六个里有俩冤枉**——`ACCOUNT_SET_AMBIGUOUS` 与 `BAD_PERIOD` 其实已登。真实欠账 5 个，且漏了同批新增的 `PLAN_CALL_MISMATCH`。
- **根因**：`b25550b` 把 27 个码收口进一张表，域文档（MECHANISMS/README）只补了当时想到的几个；`PLAN_CALL_MISMATCH` 是 `9fcbf4c` 之后才有的码，两边都没回头对齐。
- **律法归属**：L7（可信度：调用方拿不到码的域级含义）+ L2（协议事实的文档面）。
- **闭环判据**：新增机械锁——测试断言 `TABLE` 每个码至少在 `src/**/*.md` 或 `.agents/skills-serve/**/SKILL.md` 里出现一次（死条目锁已有：`test-error-codes.js` 锁"表里每个码在 src/ 有消费点"；本条锁反向："每个码在域文档有解释"）；5 个码补登后该断言通过。
- **建议波次**：Wave 2（方案已列）。
- **状态**：待办。

### D-065 · P2 结构化事实欠账：`platform_tasks` 无账套/期间/calls 字段，召回只能读记录原文

- **位置**：`fshine-agent/packages/contracts/src/store.ts:213-226`
  ```ts
  export interface PlatformTaskRecord {
    taskId: string; parentSessionId: string; principalId: string;
    workerMessages: unknown[]; createdAt: string; updatedAt: string;
  }
  export interface PlatformTaskRepo { get(taskId): …; upsert(record): …; }
  ```
  核实（两处独立佐证）：
  1. `packages/agent/src/execution-facts.ts:16-30` 的数据源取舍注释，逐条读过 store.ts 后如实记录「没有对象、没有时间范围、没有调用次数……仓库接口也只有 get/upsert，没有按会话列举的入口。→ 不贡献任何事实」；
  2. `docs/rule-landing.md:326`（§18 表格）同一结论。
- **根因**：任务记录只存 worker 原始转录。要回答"本会话迄今执行过哪些/结果是什么"，只能渲染转录原文（截断到 300 字）——这正是 execution-facts 明确不做的"对业务文本做模糊匹配"。缺的是 `accountSet` / `period` / `calls` 三个结构化字段 + 一个"按会话列举"的入口。
- **律法归属**：L2（宿主在抄写平台执行事实，而非机器可读地持有）。
- **闭环判据**：`PlatformTaskRecord` 增加 `accountSet?` / `period?` / `calls?`（由 worker 出口的结构化数据回填，不是从转录解析）；`PlatformTaskRepo` 增加 `listBySession(principalId, sessionId)`；执行台账改为读结构化字段（原文仅作兜底并标注）；测试钉住"结构化字段缺失时不猜、不解析原文"。
- **建议波次**：Wave 2 或 Wave 3（视 Lane B① 的 operations.json args 规格进度定—— args 规格落地后回填成本最低）。
- **状态**：**已关**（2026-09-27 Wave 2 Lane D 关闭；Lane B① 的 args 规格已交付，回填走规格查表）。
  关闭方式（字段与填充点比方案描述的略窄，宁缺勿猜）：
  - `PlatformTaskRecord` 增 `accountSet?` / `period?` / `calls?` / `label?` / `outcome?` /
    `resultText?`（最小集 + 渲染必需的 label/outcome/兜底原文）；`PlatformTaskRepo` 增
    `listBySession(principalId, sessionId)`（时间正序，注释注明消费者=execution-facts）。
  - 填充点全部在**委派时的确定性信息**上：`calls` 来自宿主自己解析的 worker 计划命令
    （pi-coding-driver latch `parsePlanCallsCommand` 的结果，随 TurnDriverResult.planFacts
    上交）；`accountSet`/`period` 按平台 `operation list --json` 的 args 规格**声明名**机械
    提取（位置参数按序、flag 按平台自己的 kebab→camel 归一）——`--query` 推导出的 query
    **不**当作 accountSet（检索关键词 ≠ 已解析规范名，宁缺勿猜）；`label` 是平台清单第 5 列；
    `resultText` 由 runtime 在落 Conversation Log 的同一处以 `recordTaskResult` 回写
    （与 Log 的 tool_result 同文同脱敏）；`outcome` 由委派结局（done/needs/failed）定。
    **没有任何一步从 worker 文本解析。**
  - `execution-facts.ts` 改为枚举 `listBySession`：有结构化字段 → 机械条目
    「<时间>｜<账套> <期间> <平台label> → <done/缺信息/失败>」，**结果原文仍附在其后**
    （数值结论只能来自原文——结构化条目管归因不管数值，这也是 e2e 10.1/10.2 既有断言
    不被打弱的原因）；字段缺失 → 降级为原文（现有行为）；两者都没有的条目不进台账。
  - 测试：execution-facts.test.ts 重写为任务仓库形态（结构化渲染 / 结局机械映射 / 旧任务
    降级 / 混合 / 零业务词 / 上限截断 / 存储抛错）；store.test.ts 钉结构化字段往返、缺失
    不补、upsert 替换语义、listBySession 隔离与正序、**旧库前向迁移**（无结构化列的库打开
    即补列、旧行读回不带新字段）；plan-runtime.test.ts 钉 planCallFacts 的规格查表提取
    （位置参数/flag 声明名、--query 不当账套、规格缺失不猜）；e2e 10.4 走真链路钉结构化
    条目 + 原文数值并存（harness 替身与真实驱动共用同一个 planCallFacts）。
  - 已知边界（登记在案）：升级前的旧任务记录没有任何结构化字段也没有 resultText，不进
    台账（Conversation Log 仍是完整档案）；计划模式跨步委派只保留最后一次提交的 calls
    快照（resultText 追加，保留完整结果 trail）。

---

### D-066 · 账套读授权是软控制：名单模式下读路径仅提示词约束

- **位置**：`fshine-agent/packages/agent/src/context.ts` 的 `workerSystemPrompt`——`allowedAccountSetIds.length > 0` 时只拼一句提示词（"调用者的应用层授权名单：…。不得查询或操作名单外对象。"）。同场景写路径是**硬门**：同文件 `finalizeProposal` 对 capability 不含 write、名单非空两种形态确定性拒绝（`proposal_declined`）。
  核实：`grep -n "allowedAccountSetIds" packages/agent/src apps/server --include=*.ts | grep -v test` → 消费点只有三处：提示词拼接（软）、写路径拒绝（硬）、handler 的可信上下文装配（透传）。
- **根因**：读路径授权从第一天就是提示词约束——Stage 1–3 单用户全量授权（`accountSetScope: 'all'`，e2e 亦如此）下"够用"，从未按多用户标定。提示词是**软控制**：模型压力下可绕过、可遗忘，名单外读操作当前没有任何代码级拦截。软控制与硬控制的差别不是强度是**性质**（见 architecture-laws.md「控制的标定审查」）。
- **律法归属**：L4（授权边界硬门化家族；写路径已硬门化，读路径欠账）。
- **闭环判据**：读路径硬门——宿主或平台对**读操作**的实体按 `allowedAccountSetIds` 做确定性校验，名单外即拒；测试钉"名单外主体的读计划被确定性拒绝（不是提示词劝阻）"。
- **建议波次**：Stage 4 多用户上线前（激活条件 = principal 配 `accountSetScope` 名单模式且 `accountSetIds` 非空）。
- **状态**：待办（watch：当前单用户全量授权，未激活；上线多用户前必须闭环）。

### D-067 · 模型机制 confabulation：内部控制状态被编成"说明"交给用户

- **位置**：`fshine-agent/packages/agent/src/runtime.ts` 的 `EXECUTION_LANGUAGE_FINGERPRINTS`（"内部控制词"一族：额度/配额/熔断/计划门/拒绝上限/重试上限）+ `context.ts` worker 提示词第②条 + 探针断言（`scripts/probe-real-agent.ts` 对歧义/not_found 用例）。
  核实：`grep -rn "额度\|配额\|熔断" packages/agent/src --include=*.ts | grep -v test` → 指纹表一处、提示词两处（守卫自身，挂"警职执法/防御排除"）。
- **根因**：真实通话里模型把宿主/平台的内部控制状态编成给用户的"说明"（"本次已用满平台的查询计划额度"）。禁词汇已修（2026-09-27 第三波：内部控制词进指纹表 + 提示词明令），但 confabulation 是**模型机制**不是词表问题——换个说法（"今天的查询次数到顶了"）机械防不住。当前防线 = 指纹形状 + 探针断言 + 人工守夜，没有确定性拦截（也不该有：合法数据答案与编造说明无法用形状完全区分）。
- **律法归属**：L3（模型发音权：内部控制不上屏）+ L7（证据靠探针基线累积，不靠审计轮次）。
- **闭环判据**：watch 项，**不设机械关闭判据**——新形态现形即登记（进指纹表或词表，附真实用例）；靠探针指纹 + 真实使用攒案，每条新说法都要有一次真实出处。
- **建议波次**：持续（每波探针跑分时复核；Stage 4 前结合真实使用记录复审一次）。
- **状态**：待办（watch）。

### D-068 · 实体门按每轮无状态标定：连续会话里"用户亲自查过的对象"被误拦（已关）

- **位置**：事故形状 = 2026-09-27 一次真实企微通话：回合① 用户查某对象 → 宿主发澄清（两个候选）→ 回合② 用户"1" → 查询执行成功（platform_tasks 有记录）→ 回合③ 用户只发期间编码 → `validatePlanEntities`（`packages/agent/src/turn-contract.ts`）拒绝：对象名不在「本轮消息 / 宿主证据 / 平台响应」任一里 → 查询死局，用户被要求重新报名字。
  修复位置：`PlanEntitySources.sessionEntities`（第四来源）、`session-entities.ts`（来源 A：执行过的任务的 calls 快照按平台 args 规格机械提取）、`clarification-events.ts`（来源 B：`clarification_event` 的 issued/resolved 与裸编号/候选名绑定）、`runtime.ts` 接线、`error-codes.ts` 的 `ENTITY_OUT_OF_SCOPE.correctForm` 正路径。
- **根因**：实体门按**每轮无状态**标定，产品是**连续会话**——标定范围错位。门禁防幻觉的功能必须保留（flash 模型真幻觉过对象名），错的是出处范围不是门本身。用户已明确否决"拆安全机制"方案：只做标定与接线，零拆除。
- **律法归属**：L3（宿主持事实、模型不发音的同族守卫）+ architecture-laws.md「控制的标定审查」（现形案例）。
- **闭环判据**（已达成）：
  1. e2e 复刻事故形状：回合1 查询成功（task 落库）→ 回合2 用户只发期间编码（无线索词）→ 门禁放行、查询执行、回复不含"请确认账套"；
  2. 单测：来源 A 提取（按规格 / 只取执行过的 / 规格缺失降级）、澄清 issued→resolved 绑定（纯数字 / 逐字名称 / 非编号不误绑 / 插回合失效）、haystack 合并去重；
  3. 变异三项全红：sessionEntities 注入短路 → e2e 红；correctForm 删"检索"指引 → 钉措辞的测试红；裸编号绑定关掉 → 绑定测试红；
  4. `npm test` 全量只增不减；platform-leak-lint 通过。
- **建议波次**：本波（Wave 3 任务 1/2）。
- **状态**：**已关**（证据 = 本波任务 1/2 的测试；边界随 D-065 已知边界：`--query` 检索词与位置参数一并进 haystack——门禁要回答"用户本会话亲自确立过吗"，检索词同样算数；计划模式跨步只保留末次 calls 快照）。

---

## 附录 A · 审查范围圈法

**圈法规则（两条同时满足）**：

1. **时间**：`git log --since="30 hours ago"`——与方案「今日 42 commit / 30 小时」同一把尺；
2. **会话连续性**：向前扩到 30 小时窗格切掉的、属于同一连续工作会话的 commit。

**实际圈定**：

| 仓库 | commit 数 | 范围 | 命令 |
|---|---|---|---|
| fshine-agent | **34** | `f4eed9c`（09-26 09:20）→ `5e011ca`（09-27 13:35） | `git log --since="30 hours ago" --oneline` |
| 17dz-platform | **10** | `5566488`（09-26 19:33）→ `a44e128`（09-27 10:35） | 同上 |
| 17dz-platform（连续性外扩） | **3** | `367c1ca`（09-26 00:16）、`d587de9`（09-25 20:12）、`48fe99b`（09-25 17:58） | 同一会话，30h 窗格外 |

**合计 47 个 commit**（fshine 34 + 17dz 13）。

**与方案「约 42 个 commit」的差异说明**：方案数字偏小。双仓 30 小时窗格实际 44 个；若按"会话连续性"外扩则 47 个。偏差不影响结论——圈的是同一段密集期（三支柱 / 卫生批修 / 抽象泄漏根治 / 2048 修复 / 测试超时 / 计划门全链）。

**未覆盖（明确记录，留待后续判断）**：`f4eed9c` 之前的历史（W1 起至 09-26 09:20，含 roadmap Phase 0–7）。本次审计的结论是：**暂不值得单独派一轮**——该段的主体现存债务已被 Phase 收尾 commit 自行清理或已登记在 rule-landing，且本台账 L6/L7 的数条沉积（D-050/051/052/053/055）溯源都在那段，修法已经在 Wave 1 Lane B/C 里，不需要为它们再开审查。

**审查方式**：双仓 diff 全量过（fshine 63 文件 / +7926 −612；17dz 46 文件 / +2340 −180）+ 按五样专找的定向核实（跨仓、保留原文标点、可复现命令）+ 两次实证运行（fshine 全量 vitest 无凭据环境；17dz `node test/test-all.js`）。

**工作区状态提示**：审计期间 fshine 工作区有 7 个 src 文件被其他 Lane 并行修改（未提交，主要是把 `bin/17dz` 字面量替换为 `GATEWAY_INVOCATION`）。本台账的所有计数与结论均以**已提交的 HEAD（`5e011ca`）**为基准快照，并在受影响条目（D-010）注明在飞改动。本文件未 `git add` 任何其他路径。

---

## 附录 B · 已知债对账登记（逐条确认现状）

| 方案条目 | 本台账 | 现状核实结论 |
|---|---|---|
| §17 写路径卫生七项（S2/S3/S4/S5③/S7/S9/S10，17dz 侧） | D-031 | **未修**。S2 已在 `fill.js:45,51` 现场复勘确认仍在；其余六项登记在案，Wave 3 开工时逐条复勘。闭环在 Wave 3，与 D-030 同批 |
| P2 结构化事实欠账（platform_tasks 无账套/期间/calls 字段） | D-065 | **未修**，且比方案描述的更硬：接口层就没有"按会话列举"的入口，不是"缺字段"而是"缺字段 + 缺入口" |
| F4 残留（回合真有过执行时出口校验跳过） | D-020 | **未修**。`runtime.ts:897` 现场确认；794eab2 的 `clarification` 路径绕过了它但没有堵住通用出口 |
| 17dz 六个新错误码未登域文档 | D-064 | **部分不实**：真实欠账 5 个（`INVALID_LIMIT`/`INVALID_COUNT`/`UNKNOWN_DOMAIN`/`PLAN_CALL_MISMATCH`/`NO_SAMPLES`）；方案列的 `ACCOUNT_SET_AMBIGUOUS` 与 `BAD_PERIOD` 其实已登（MECHANISMS.md:39 / lib/README.md:182），且漏了 `PLAN_CALL_MISMATCH` |
| ask.ts 复刻装配层 planConfirmation（双真相） | D-013 | **未修**，逐字复刻已确认（含 `10 * 60_000` / `decision:'confirm'` / `evaluation:{}` 三个字面量） |
| FSHINE_\* 环境变量退役（dz-env 过渡计划） | D-016 + D-017 | **未修**。新发现：写入端（fshine）已切 DZ_\*，仍在双写的是 17dz 自己的 `runner.js:25` 与 `gateway.js:90`；移除条件"稳定一个周期"无定义。另有 3 个 FSHINE_\* 名字不在禁绝集内（D-017） |
| Tier-1 打分器未建（L7） | D-060 | **未建**，无 scores.jsonl / 语料库 / 评委提示词 |
| §17 里"fshine F1 extractChangeProposal 剥围栏" | D-032 | **未修**（读路径同族容忍层已删，写提案侧仍在） |
| §17 里"fshine F4 残留" | D-020 | 同上 |
| L1 三处真违例（persona / 税号 / 借贷合计） | D-001 / D-002 / D-003 | **三处均在**，行号与方案一致（`runtime.ts:1539` / `error-codes.ts:158` / `context.ts:360`） |
| L6 沉积清单（mcp 空壳 / reply.ts 彩蛋 / step-text 死分支 / 465KB 日志 / .env.real / 死技能） | D-050 / D-051 / D-052 / D-053 / D-054 / D-055 | **五项在、一项已关**：`.env.real` 仓库侧已由 `95fbd6b` 的 gitignore 闭环（标接受不修）；其余五项全部现场确认仍在 |
| L2 网关名 33 处/8 文件 | D-010 | **基线数字本身少算 2 处**（`git grep -- 'scripts/**/*.ts'` 匹配不到 `scripts/` 顶层文件）。真实 HEAD：**35 处 / 10 文件**；窗口起点 `f4eed9c`：**20 处 / 8 文件** → 窗口内 **+15（+75%）**，违反"只减不增" |

---

## 附录 C · 查了但没发现（阴性记录）

诚实登记"扫过了、没问题"，避免后人重复扫，也避免把"没查"当成"查过没问题"。

| 检查项 | 方法 | 结果 |
|---|---|---|
| 失效的行号引用（注释里的 `文件:行`） | `grep -rnE "(见\|参照\|详见\|参见\|位于\|定义在)[^ ]*\.(ts\|js\|md):[0-9]+"` 双仓 | **0 命中**——本类债目前在双仓不存在 |
| 双仓错误码表漂移 | 机械比对两侧 TABLE 码集合 | **0 漂移**（两侧有意不相交，见 D-018） |
| `SCOPE_FORMS` 与脚本声明漂移 | 读 `test-plan.js:124-143` 的机械对齐断言 | **有锁且覆盖全部 5 个 operation**——不是债 |
| mock 的 finance flag 集合与真脚本漂移 | 读 `test-mock-responder.js:144-158` | **有锁**（仅 `fill.js` 无锁，已单列 D-015） |
| 信封 schema v2 | `grep -rn '"v":2\|schema v2\|RESULT v2' 17dz/src/` | **0 命中**（但 fshine `platform-contract.ts:29` 注释误写 v2，见下） |
| `.stepcode/plans/` 被误提交 | `git status --porcelain` + `git log -1` | `5e011ca` 已取消跟踪并 gitignore，仓库清洁 |
| 17dz `tmp/` 会话日志 | `git ls-files \| grep tmp/` | 已被 `.gitignore` 的 `tmp/` 覆盖，非仓库债（D-053 只记仓根那个） |

**一处待补的阴性项**：`fshine-agent/packages/agent/src/platform-contract.ts:29` 的注释写「解析 stdout 末行 RESULT 信封（**v2**）」，而同一文件的接口定义是 `v: 1`、校验是 `e.v === 1`、文件头写「schema v1，E2」。该误写源自首个 commit `968ccd9`，平台侧从未有 v2。**这是一条真实的注释与代码不符**，因只有 1 处且极轻，并入 D-022 同批处理（同属"注释与代码不符"类），不单开 ID。

---

## 附录 D · 五样专找命中统计

| 专找项 | 条数 | 条目 |
|---|---|---|
| 1. 半成品迁移（新旧并存、fallback 桥无移除条件） | 5 | D-010、D-015、D-016、D-021、D-055 |
| 2. 双真相复刻（同一事实两处定义） | 6 | D-011、D-012、D-013、D-014、D-017、D-065 |
| 3. 注释与代码不符（含失效引用） | 2 | D-022、D-018 附条（platform-contract.ts:29 的 v2） |
| 4. 测试钉住错误行为 / 误导性 characterization | 3 | D-052、D-006、D-061 |
| 5. 无测试的新路径 | 4 | D-063、D-020、D-021、D-062 |
| （守卫本身的洞，横切五样） | 3 | D-004、D-005、D-064 |
| （沉积/彩蛋/空壳，L6） | 7 | D-050、D-051、D-052、D-053、D-054、D-055、D-056、D-057 |

合计 **38 条目**（D-000 至 D-065 共 37 个 ID + 1 条附条；含 1 条已关、3 条接受不修）。

---

*本台账由 Wave 1 Lane D0 生成。只读审计，未修改任何 src/test/config/脚本。下一动作：Wave 1 Lane B/C 按「建议波次」列认领；Wave 4 收口时逐条过闭环判据。*

---

## Wave 1 关账记录（2026-09-27，主 agent 验收后登记）

| 条目 | 状态 | 关账证据 |
|---|---|---|
| D-061（17dz 测试与共享状态耦合，agent-pipeline RED） | **已关** | `test-all.js` 隔离六类状态文件到 per-run 临时目录（含 TOKEN_CACHE_PATH/RUNTIME_DIR）；`test-serve-e2e.js` 审计读取改认 DZ_AUDIT_PATH。耗桶实验：真实四桶耗零后裸 `npm test` 仍 ALL PASS，同态单跑不隔离即 RATE_LIMITED——绿是隔离给的。连跑两次 + 五个真实状态文件字节级未变 |
| D-062（fshine 无凭据环境 52 例红） | **已关** | e2e harness beforeAll 装确定性假 WECOM_BOT_ID/SECRET（不用 loadEnv——那会让 `env -u` 验证形同虚设）；出向由 tests/vitest.setup.ts unset 六个泄漏变量。正常/无凭据两环境均 60 文件 572 例全绿 |
| D-011（plan 形状 6 处散文且自相矛盾） | **半关** | 平台侧已认领：`src/execution/plan-schema.json` 声明 `calls` 必填 + `requestId?`/`goal?` 可选 + `additionalProperties:false`，`evaluate()` 按它校验（未声明字段 → PLAN_UNKNOWN_FIELD，correctForm 按 schema 动态带合法清单），SKILL 补指向 schema 的引用。**矛盾已仲裁**（goal 收编为合法可选元数据，宿主教学不再与平台冲突）；**残留**：宿主 6 处教学示例尚未从 schema 派生收敛为 1 处——归 Wave 2 Lane D |
| B/C 耦合的 5 例 e2e 红（不在原台账，Wave 1 新生） | **已关** | 根因：平台 not_found 信封补 query 后激活宿主澄清机制，捏造账套名 fixtures 的透传路径断。修法：4 例换 mock seed 真实规范名（幻辰财税/新兴五金/新兴建材，数字对齐 mock 当期真实值）、1 例（7.3 主旨就是"平台说没有"）改断言为宿主组装澄清形态 + 反向断言（无错误码/无捏造文本/指纹为空）；另修 7.2 同根因的假绿（断言被澄清文本里的账套名满足）。澄清机制/计划门/消歧逻辑零改动 |
| L6 沉积清单（mcp 空壳×2、reply.ts 彩蛋+chart.ts+其测试、step-text 退役工具死簇、finance 死技能、.env.real、17dz 465KB 会话日志） | **已关** | 逐项 grep 零引用后删；17dz 侧加 `codex-session-*.md` gitignore 防复发；step-text 死簇连专属死代码（names/rememberAccountSets）整簇删，同步删 lint 白名单 6 条 |
| L2 网关名 35 处字面量 | **已关** | 配置派生（`GATEWAY_INVOCATION` 常量 + `gatewayExecPath(platformRoot)`），残留 1（配置缺省值）；警职解析器正则从配置值构造并挂标签 |
| L1 两处业务词违例（persona/税号） | **已关** | persona 改"面向用户的主 Agent"（亲和力移交 business skill）；税号措辞降级中性，注释标明 Wave 2 由平台 correctForm 作数据加回 |
| L1 守卫升级（词表 6→9 + 四标签归属） | **已关** | leak-lint 断言改"非防御命中=0 + 防御项 100% 挂防御排除"；13 条命中逐条归属；变异双向验证（插词红/删防御标签红） |
| SCOPE_FORMS 覆盖 5→11 条 | **已关** | 从 operations.json args 规格机械派生补全 + "规格即来源"锁；`payroll.fetch-staff`（customerId 非账套名）与 `voucher.smoke`（无范围要素）刻意不登记，测试断言"未登记的只读 operation 必须只有这两个"防漏 |
| operations.json args 规格 + 三方机械锁 / not_found 带 query / 错误信封带 correctForm / orchestrator SKILL 两节 / 17dz 测试出向自封 | **已关** | 均为 Wave 1 Lane B 交付（bb03f03..6ac62e1）：24 operation/45 flag/41 位置参数，三方锁+style↺吃值锁；四种信封 correctForm + not_found query；SKILL 删旧形状教程改引用；裸 `npm test` 不再需手工 unset |

**仍未关（Wave 2+ 认领）**：D-011 残留的宿主教学收敛、D-010/D-015/D-016/D-021/D-055（半成品迁移五条）、D-012~D-014/D-017/D-065（双真相复刻五条）、D-022（注释不符）、D-052/D-006/D-061 之外的测试钉错三条、D-063/D-020/D-062 之外的无测试新路径、D-004/D-005/D-064（守卫洞三条）、P2 结构化事实、F4 残留、ask.ts 复刻、FSHINE_* 退役、§17 七项（归 Wave 3）、Tier-1 打分器（Wave 4）。

---

## Wave 2 关账记录（2026-09-27，主 agent 验收后登记）

**Lane D（fshine，6 commits：9123e63/d0d13f8/09eb696/bf0a6d9/df3a6b7/4e39ec4，62 文件 617 例两环境全绿）**

| 条目 | 状态 | 关账证据 |
|---|---|---|
| D-012（KEY_ARG_FLAGS 镜像） | **已关** | 硬编码表删除，`describeKeyArgs` 查平台 `operation list --json` 的 args 规格（name/code 样式从数据来）；无规格→不发摘要（安全缺省）；grep：KEY_ARG_FLAGS 在 src 零命中 |
| D-011（plan 教学 6 处副本） | **已关** | `planDraftExample()` 唯一教学源（与平台 plan-schema.json 一致：goal 是声明过的可选元数据），error-codes 5 处+worker 提示词全部派生；`plan-teaching.test.ts` 跨仓机械锁（形态合法+解析器认同一形状+源文件零第二种字面量）。判据修订登记：原"grep goal→0"作废（schema 收编 goal 后教学合法含 goal） |
| D-013（ask.ts 复刻装配层） | **已关** | `createPlanConfirmationWiring` 工厂收编 assembly/ask.ts，TTL 单处 |
| D-014（workerTimeoutMs 五处） | **已关** | `turnBudgetMsFor` 收编公式 |
| D-020（F4 残留） | **已关** | `looksLikeProtocolMaterial` 复读检测不依赖 execution（有执行也拦），顺带盖上 `{"recorded":"conversation"}` 回显泄漏；守夜事件 `execution_language_leak`。判据修订登记：未采纳全量指纹硬拦（误伤合法数据答案），用协议 JSON 首字段精确子集 |
| D-021（notice 无声截断） | **已关** | notice 路径换 `truncateReply`（截断带标记）+ 守夜事件 |
| D-022（注释写 2048） | **已关** | 改 20480 实情 |
| D-055（技能复活路径） | **已关** | 模板 skillRoots 改运行态技能面 + config 机械锁 |
| D-063（装配接线无测试） | **已关** | wiring 测试（真工厂+真 SQLite+假平台 CLI，含 superseded 路径）；变异锁随 D-013 迁移 |
| D-004（lint 范围缺 apps/） | **已关** | 业务词预算扩到 apps/（scripts 显式排除），存量命中逐条四标签归类 |
| D-005（伪装形抓不到） | **已关** | 词表 6→15 + 同义改写对照表（时间范围→期间/记录档案→凭证/摸底→域操作）；存量归类；D-006 按闭环判据挂"显式接受的夹具数据"决策 |
| D-017（三 FSHINE_* 名不在禁绝集） | **已关** | 进 lint 登记锁（挂遗留待清） |
| D-065（P2 结构化事实） | **已关（带已知边界）** | platform_tasks +6 字段 + listBySession（SQLite 前向迁移）；填充点全是委派时确定性信息（calls 来自宿主解析的计划命令、accountSet/period 按平台规格声明名机械提取、label 取平台清单）；execution-facts 渲染结构化条目（原文仍附后保数值）。**已知边界**：`--query` 检索词不当 accountSet（finance 账套常留空）、计划模式跨步只保留末次 calls 快照、旧记录降级原文 |
| 宿主错误镜像表 | **已退化为渲染层** | NOT_FOUND_SELECTION 拆为结构+`{hint}`，hint 优先取信封 correctForm（平台数据），宿主兜底挂"遗留待清"；AMBIGUOUS_SELECTION 刻意不消费 correctForm（平台给的是解析方规则不上屏——代码注释与台账均记明此判断） |

**17dz 并行小 lane（4 commits：bc498f8/8f78a7f/824cddd/0da1d29，27 文件 ALL PASS）**

| 条目 | 状态 | 关账证据 |
|---|---|---|
| D-064（错误码登域文档） | **半关** | 五码按消费点归属登记（ voucher MECHANISMS×3 / lib README×2）+ 登记机械锁（两面：码在表里文档无解释→红；文档复述三要素全文→红）。**残留**：TABLE 还有 5 码未登任何域文档（AUTH_REDIRECTED_TO_LOGIN/AUTH_WORKBENCH_NOT_READY/AUTH_UNKNOWN/PLAN_CALLS_NOT_ARRAY/PLAN_FIELD_TYPE）——已在锁注释里写明范围，建议后续 lane 单列 |
| D-015（mock fill flag 手抄） | **已关** | 纳入三方机械锁（mock 集合 == operations.json 规格 == 源码派生），覆盖 respond.js 全部 7 键，按目标脚本归组钉死"别把 voucher flag 安到 finance operation"；4 向变异全红 |
| D-016（FSHINE_* 退役） | **半关（写入侧已拆）** | 全仓+跨仓核查：读点只剩 dz-env 回退、写点只剩平台自己→写入侧安全移除（setServe 只写 DZ_SERVE、gateway 只铸 DZ_INVOCATION），5 条写入面锁；读取侧宽判定保留（旧宿主构建兼容）。退役计划写实进 dz-env 头：条件=两条机器可验事件（宿主 grep 零命中——已被宿主 lint 机械兜住；平台侧只剩回退）+ **时间锚点 2026-10-27 复核，不许无限期续期** |
| plan schema 暴露 | **已关** | `bin/17dz plan --schema` 逐字打印 schema 文件（md5 一致，cwd 无关）；三层测试（进程内两种写法+真实 spawn）；宿主 SKILL 的空头教导（指向宿主读不到的文件路径）已改为指向 CLI 出口 |

**仍未关（Wave 3+ 认领）**：D-010（网关名历史增长，已随 Lane C 收敛关闭其未来面）、D-064 残留 5 码、D-016 读取侧回退（2026-10-27 锚点）、半成品迁移其余四条（D-015/D-016/D-021/D-055 已关，D-010 部分）、双真相复刻其余（D-012/D-013/D-014/D-017 已关，D-065 已关）、D-022 已关、P2 已知边界（ finance 账套留空）、§17 七项（Wave 3）、Tier-1 打分器（Wave 4）。

---

## 补充关账记录（2026-09-28，手机事故对话 e2e 化时发现）

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-069（新）F4 复读守卫不挡平台 RESULT 信封** | **已关**（2026-09-28 小刀关闭） | 写 PHONE-1 e2e 时实测发现：`looksLikeProtocolMaterial` 只匹配 `{"recorded"...}`/`{"step"...}` 两种协议 JSON，**不匹配平台 RESULT 信封**（`{"v":1,"op":...}`）。若模型把平台信封原样当回复，F4 放行、执行语言指纹尺也不在终稿硬闸上（只在 worker 说明准入与探针用）。**今天无真实用户撞见此形态**（真实 worker 自行组织终稿），是写用例时fixture 暴露的理论缺口。关闭方式：`runtime.ts` 的 `looksLikeProtocolMaterial` 增第三种形态——信封固定开头 `^\{\s*"v"\s*:\s*1\s*,\s*"op"\s*:`（字段形状以 platform-contract.ts 的信封解析为准，注释标明"信封复读与协议 JSON 复读同族：都是机器间结构化材料，外发即执行层语言上屏"）；needs/plan 两种前缀的原逻辑一动不动。测试：`runtime.test.ts` F4.1 补信封形状两条 + 近似形状假例三条（`v:2` / `version` / `op` 非首字段均不外溢）；e2e `turn-loop-phone-incident.test.ts` PHONE-2——信封复读型 Main Agent 把计划步骤工具结果里的**真实** RESULT 信封（mock 执行器真跑过一次查询）原样当回复，断言终稿被宿主步骤事实汇总（planFallback 家族）替换、不含 `"v":1`、执行语言指纹零命中；变异验证：删掉新前缀匹配后 PHONE-2 红，泄漏原文正是整段信封（含 operation 名） |
| 手机事故对话回归 | **已关** | `tests/e2e/turn-loop-phone-incident.test.ts`（PHONE-1）：澄清轮完整指纹零命中 + 追问轮事故泄漏形态缺席 + 期间追问不死lock + 三回合各一次真实平台调用。与 session-entities 篇分工：机制 vs 用户那通电话 |

---

## 长会话/复杂任务实测记录（2026-09-28，C1 探针 + X1-X8 真实平台会话）

**测试**：① 探针 C1（20 轮混合会话，mock）；② 真实平台 8 轮复杂任务会话（4 月跨期计划/中途换账套/跨轮召回/歧义/编号/换期间/写尝试/总结）。

**通过的**：4 步计划模式（步号通知+数字链自洽）；中途换账套的诚实失败；写尝试的写关闭话术到达用户（“当前该权限未开放，提案无法生成”）；真实数据全程正确零编造。

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-070（新）召回/总结轮拿不到数字** | **待办** | X3“刚才查到哪几个月，数字是多少”→ 模型承认查过但拒绝给数（“结论仍然有效”）。根因候选：`RECENT_TURN_HISTORY_NOTE`（“旧财务结论不得当成本轮实时结果”）被过度执行——用户明确要求召回时也不给。修法方向：该 note 区分“主动引用旧结论冒充实时”与“应用户要求的召回复述”，后者允许（带“历史查询结果”框定）；execution-facts 注入时机同步 |
| **D-071（新）总结塌缩** | **待办** | C1 第20轮与 X8 的总结都把整个会话塌缩成最后一个账套/期间（C1：20 轮跨三个账套，总结只说幻辰财税）。根因：总结轮无台账注入——“总结/汇总”不是线索词，execution-facts 的 cue 触发不 fire。修法：cue 表加“总结/汇总/回顾”类（机械，一行） |
| **D-072（新）名称类请求被会话实体代解析** | **待办** | X4“查一下幻州的应收账款”（平台 25 候选）→ 模型未搜索未澄清，直接用会话实体幻亨纸业出数。这是会话实体标定的已知代价（“允许≠选中”）第一次以用户可见形态出现：连续性修复让模型宁可信任上下文也不重新解析名称。修法方向：skill 契约加一条“用户给出名称类请求仍须先经平台目录搜索确认；会话实体只用于用户只给参数（期间/范围）的续问” |
| D-069（F4 信封复读） | **已关** | 见上轮记录 |
| meta-talk（“已申报本轮动作”上屏） | **watch** | C1 第10/14/20 轮与 X3 仍出现协议语言；语域契约已禁但模型侧复发，靠探针指纹持续盯 |

---

## 三条实测债的关闭记录（2026-09-28 晚，机械边界修复）

**改动范围**：只改 fshine-agent 一个仓库，三个任务一个 commit。三个任务都是"我们的机制把模型过度泛化/泛化不足"类，修法全部是机械边界（线索表一词、注令一分支、skill 一条），不动 C25/实体门/澄清机制主干。

| 条目 | 状态 | 修法与关账证据 |
|---|---|---|
| **D-070（召回拒绝给数）** | **已关** | `runtime.ts` 的 `RECENT_TURN_HISTORY_NOTE` 从"一律不得引用"改写为按**谁发起引用**分两个分支：禁止面=用户没要求回顾时不得把历史结论当成本轮实时查询结果主动呈现（冒充实时，原事故形态）；放开面=用户明确要求召回时可复述，但必须带框定（"本会话早前查询的结果，不是本轮实时查询"）。测试：`runtime.test.ts` 原"历史资料说明"用例的断言改为钉两个分支语义（含"说明不落入持久化转录"对两个分支各自成立）；变异：删"放开面"句子 → 该测试红。C1 复跑佐证：召回轮（第 6/11/16 轮）给出数字且自带框定语（"以上是本会话早前平台实时查询的结果，不是本轮重新查的"）。**边界**：C1 脚本没有 X3 那个"承认查过但拒绝给数"的精确形状，本条关账依据是机械边界 + 钉住的测试 + 复跑里框定语确实出现，不是 X3 形状的复现 |
| **D-071（总结塌缩）** | **半关（机制已闭，模型侧未收敛）** | 机制面：`reference-evidence.ts` 的 `REFERENCE_CUE_RE` 加"总结/汇总/回顾/梳理"（`looksLikeReferenceCue` 与 `keywordsFrom` 共用，两个消费者 reference-evidence 与 execution-facts 同时生效——总结轮既该有台账也该有证据，注释已写明这是想要的）。测试：reference-evidence 线索词用例加 4 个总结类 true + 2 个新查询 false；execution-facts 加"总结类消息注入台账"与"注入内容只含机械事实（无解释无排名）"两例；runtime.test.ts 加 R10（三账套底账 + "总结一下"消息 → 台账在场三条目一条不落）。变异：删四个线索词 → 4 例红（跨 3 个文件）。C1 复跑（`.runtime/probe-fshine-probe-Mmp6WO.json`）：第 20 轮 `execution_facts_injected count=5`——**台账确实进了总结轮**，塌缩形态（只复述最后一个账套并当作"今天查询情况汇总"）消失。**未收敛**：该轮模型没有输出多账套汇总，而是反问"需要重述一下今天的查询结果吗"。最可能的原因是本会话 10 次委派被 `MAX_EXECUTION_FACTS=5` 截到最近 5 条（`truncated=true`，材料自带"更早的执行不在本材料内"），模型据此判断自己给不出完整清单。**不标已关**：判据是"总结轮引用多账套台账"，本轮只达成"台账在场 + 不塌缩"，没达成"引用多账套台账"。留待办：复核 `MAX_EXECUTION_FACTS` 对长会话总结轮的截断是否过紧（改它属另一条机械边界，不在本波范围） |
| **D-072（名称类请求被会话实体代解析）** | **已关** | `docs/business-skill.md` 与 `context.ts` worker 系统提示词**同步**加同一条契约（与既有语域契约三条同区块）：名称类请求（含具体名称/简称/地名等需要解析的指称）仍必须先经平台检索确认规范名——即使用户本会话用过某个对象；会话已确立实体只用于用户只给参数（期间/范围/科目）的续问，不用于代解析用户新给的名称。理由写进注释：防连续性标定被泛化成"猜用户指的是会话里那个"（猜错=用户收到一次张冠李戴的查询结果，且无搜索痕迹可复盘）。提示词措辞零业务词（leak-lint 守：`BUSINESS_WORD_RE` 扫描 `packages/agent/src`）。**无测试可钉**（提示词类，与语域契约三条同样只靠走查+lint），变异验证即"删掉该条 → 无测试红"，如实登记 |

**验证**：`npx tsc --noEmit -p tsconfig.json` 0 error；`npm test` 全量 65 文件 656 例全绿（基线 65 文件 653 例，新增 3 例）；`npx vitest run packages/agent/platform-leak-lint.test.ts` 4 例 passed（新增/改动的 src 注释与提示词措辞零未归属业务词）。未跑真实平台。

---

## 补充记录（2026-09-29 晚，手机"再看一下"通话链路审计 + 客户问题实测）

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-073 探索型问题的域混淆+已查数据不呈现** | **待办（行为层）** | 问"客户有哪些"→ 模型把 4 个账套当"客户目录"回复（解读可辩但未显式时是混淆），且**已查到的往来单位（--customer 维度）不出现在回复里**，反请用户指定账套重查。单轮 295s/8 调用/3 通知。修法方向：执行层 SKILL 明确"客户"两解读及各自操作；worker 终稿必须呈现已取到的维度数据或明示放弃原因。**已固化为探针 X2-T1 断言**（只建未跑） |
| D-074 占位参数 | **watch** | 手机通话中模型提交 `--customer x`（编的占位值）且未登记进计划 → 计划门拦下（机制正确）。模型侧编参数值行为，打分器"计划保真度"维度盯 |
| 模型端点不稳 | **watch（外部）** | 2026-09-29 三次 ask.ts 跑两次卡死在模型阶段（零平台调用，伤不到 17dz）。闭环日跑需含"端点抖动不计失败"的处理 |

---

## X1 首跑记录（2026-09-29，只建未跑的用例第一次实跑）

**结论：三个当日修复全部实弹验证通过；断言误报已修；抓到一个新的呈现缺口。**

| 项 | 结果 |
|---|---|
| D-070 召回给数 | ✅ 通过——T3 回复“以下为本会话早前查询的结果（不是本轮实时查询）：幻辰财税共查了 4 个月……”带框定给全 4 期数字 |
| D-071 总结不塌缩 | ✅ 通过——T8 总结覆盖 5 项跨 2 个账套（新兴五金/幻辰实业）+ 检索史 + 写准备，全带“早前查询结果”框定 |
| D-072 歧义不代解析 | ✅ 通过——T4“幻辰”列出 2 候选问“你要查哪个”，无静默选定 |
| 防幻觉 | ✅ T7 拒绝编造管理费用科目编码（“我不能凭常规编码自行填写”） |
| 断言误报 | ✅ 已修——科目代码 1122 被 extractAmounts 当金额，旧账套代码出现在新账套回复即误判串台（2 条误报）；MOCK_SUBJECT_CODES 排除 |
| **D-075（新）写关闭 disclosure 不稳定** | **待办** | T7 写尝试：模型走了完整的“录入准备”流程（核实账套/日期/贷方科目/借贷平衡），行为优秀，**但全程未告知用户写权限是关闭的**——真实平台同形态（X7）会 disclosure。根因：WRITE_NOT_ENABLED 靠模型走到提案步骤才触发，模型停在准备阶段用户就永远不知道。修法方向（L3 式机械）：计划里出现 write 类 operation（operations.json 的 access 字段宿主可读）+ capabilities 不含 write → **宿主前置合成关闭消息**，不依赖模型抵达提案步 |
| 调用形态 thrash | watch | T6/T7 模型连试 6 种调用形态（kebab/=号/位置/方括号）全被计划门拦下——门禁全兜住（零错调用执行），但模型形态稳定性差；打分器“计划保真度”维度盯 |
