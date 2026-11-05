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
- 17dz 侧残留确为 **execution-env 过渡期双读/双写**：`src/lib/execution-env.js:12/18/23/27/31/35/39` 六处 `EXECUTION_* ?? FSHINE_*` 回退 + `setServe` 双写；`src/execution/gateway.js:90` 仍写 `env.FSHINE_INVOCATION`（注释标 `E4 双写过渡`）。
- **关键发现**：execution-env.js 注释写的移除条件是「写入端（fshine / 网关铸造）全部切换到 EXECUTION_\* 并稳定一个周期后」。而 fshine（assembly.ts:84 / ask.ts:52 / acceptance.ts:200）**已经只写 `EXECUTION_SERVE='1'`、不写 FSHINE_MODE**；仍在双写 FSHINE_\* 的是 **17dz 自己的 `src/execution/runner.js:25`（`executionEnv.setServe`）与 `gateway.js:90`**。即：退役阻塞在 17dz 自身，且移除条件里没写"稳定一个周期"是多久、谁来判断（见 D-016）。

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
- **已关（2026-10-16，docs-reality 对账守卫落地时核实）**：persona 已改「面向用户的主 Agent」，「财务助手」在宿主 src 零命中（守卫 = `packages/agent/docs-reality.test.ts`）。判据原文的 `grep "财务" packages/*/src apps scripts 零命中` 按字面不可达——history-tools.ts 两处"实时财务查询/历史财务结果"是边界框架文案，leak-lint 已挂"遗留待清"（待改中性措辞），归 L1 词表制度管，不属 persona 违例；本条按精确靶子（persona 领域定语）关账。

### D-002 · 错误码消息文案含"税号"

- **位置**：`fshine-agent/packages/agent/src/error-codes.ts:158`
  `text: '没有找到匹配"{query}"的对象。请确认准确名称（或编号/税号）后我再查。'`
  核实：`grep -rn "税号" --include=*.ts packages apps scripts | grep -v test` → 唯一命中。
- **根因**：选择类澄清模板由宿主持有，宿主不该知道"税号"这个领域概念。中性措辞应由平台 correctForm 作为**数据**加回（Wave 2 依赖 Lane B③ 的错误信封 correctForm）。
- **律法归属**：L1。
- **闭环判据**：模板文案零领域词；「或编号/税号」改由平台信封 correctForm 携带，宿主渲染层零业务词（测试：`clarificationTextFor` 两条模板不匹配 `/应收|凭证|科目|账套|期间|目录|税号|财务/`）。
- **建议波次**：Wave 1 先降级为中性；Wave 2 由平台 correctForm 作为数据加回。
- **状态**：**已关**（2026-09-27 Wave 2 Lane D 关闭）。2026-10-19 对账：worker 系统提示词位置的散文已随注入重写退役——planCommandForm 经参数由 planDraftExample 单源注入，本条关闭状态不受影响。
  关闭方式：`error-codes.ts` 的 NOT_FOUND_SELECTION 退化为纯结构模板
  `没有找到匹配“{query}”的对象。{hint}我再查。`——`{hint}` 槽位优先取平台信封
  `error.correctForm`（platform-contract 的 `selectionClarificationOf` 解析，带控制字符
  清洗 + 200 字截断），宿主表只存"信封没带时的兜底"（`hintFallback: '请确认准确名称后'`，
  挂「遗留待清」）。测试：`error-codes.test.ts` 钉住"带 correctForm 渲染平台措辞 / 不带
  用宿主兜底且不出现空泛占位"；e2e `turn-loop-clarification.test.ts` C3 走真 mock 信封
  （期望值经 harness 的 `platformCorrectForm` 跨仓读平台错误码表，不抄第二份台词）。
  复核条件：平台若给 ACCOUNT_SET_NOT_FOUND 的 correctForm 带上领域词，那是**平台下发**
  数据（宪章四标签之"平台下发"），不算宿主违例；宿主兜底字符串在平台全域携带后删除。
  2026-11-05 W2 镜像层退役追记（关账留痕，非重开口径）：correctForm 教学已零业务命令语法
  （`PLAN_CALL_ARGS_NOT_ARRAY` 只教结构）、信封数据优先（`{hint}` 槽位）、宿主兜底只留结构，
  三把机械锁在场（`error-codes.test.ts` 全表锁：零平台 operation 名 / args 教学零旗标示例 /
  全表零业务词，哑值填充、不扫平台下发数据）。本条仅在既有「hintFallback 挂遗留待清 + 复核
  条件」口径上补两件事：① 补限期 = 波次 5；② 补登记第二处宿主兜底——
  `ASSISTANT_NOT_FOUND_SELECTION` 结构句尾『请确认准确名称后我再查』（终局快路径共用条目）。
  闭环判据不变 = 平台对 ACCOUNT_SET_NOT_FOUND/ASSISTANT_* 全域携带用户向 correctForm 后
  删除宿主兜底。

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
- **已关（2026-10-16 对账核实；代码层 2026-10-14 D 波 `3e5a36c`）**：写路径收敛为唯一形态——借贷合计渲染、`ChangeIntentRecord` 业务字段、legacy `finalizeProposal` 整体删除；闭环判据机械满足（`grep -rn "借贷" packages/*/src` 非测试零命中）。守卫 = `packages/agent/docs-reality.test.ts`（legacy 痕迹零命中断言）。与 D-030 同批关账。

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
- **2026-11-04 对账注记（F4，见文末补充记录 D-146）**：本条主状态仍为待办，但须拆面——未来面已收敛：非测试 src 的 `bin/17dz` 代码字面量只剩 `platform-contract.ts` 的 `GATEWAY_INVOCATION` 常量一处，grep 总量 10 含非代码字面量（第四轮实测，含 plan-runtime.ts:122 新加 1 处），仍 ≤20 的闭环判据；剩余面是 9 处非代码字面量（注释 8 处 + 配置示例注释 1 处）未派生，另立 D-146 跟踪，不再由本条笼统背账。

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

- **位置**：`17dz-platform/src/lib/execution-env.js`（`serve:12`、`setServe:15-19`、`invocation:23`、`commitToken:27`、`gateSecret:31`、`executor:35`、`mockState:39` 六处 `EXECUTION_* ?? FSHINE_*` 回退）+ `src/execution/gateway.js:90`（`env.FSHINE_INVOCATION = invocation; // E4 双写过渡`）+ `src/execution/runner.js:25`（`executionEnv.setServe(env)` 双写）。
  核实（跨仓）：fshine 侧写入端**已全部只写 EXECUTION_\***（`assembly.ts:84` / `ask.ts:52` / `acceptance.ts:200` 均 `EXECUTION_SERVE='1'`，无 `FSHINE_MODE`）；仍在写 FSHINE_\* 的是 17dz 自己的 `runner.js` 与 `gateway.js`。测试侧依赖：`test/test-auth.js:54,59,83,104,105` 与 `test/test-serve-e2e.js:2,29` 直接用 `FSHINE_MODE` 造场景；`test/test-all.js:20` 的 `LEAKY_EXACT` 含 `FSHINE_REAL_COMMIT`/`FSHINE_EXECUTOR`。
- **根因**：execution-env.js 注释写的移除条件是「写入端全部切换到 EXECUTION_\* **并稳定一个周期**后」——"一个周期"没有定义（多少天？多少次发布？谁签字？），所以这条双读会一直"过渡"下去。且写入端已经切换了，真正在双写的是 17dz 自己，条件里却没提。
- **律法归属**：L2（协议名双真相）。
- **闭环判据**：`execution-env.js` 中 `FSHINE_*` 回退分支全部删除（六处 `??` 链变单读）；`runner.js` 的 `setServe` 只写 `EXECUTION_SERVE`；`gateway.js:90` 双写行删除；`test-auth.js`/`test-serve-e2e.js` 的 `FSHINE_MODE` 用例改为 `EXECUTION_SERVE`；`grep -rn "FSHINE_" src/ test/` → 0 命中（`test-all.js` 的 LEAKY_EXACT 同步收缩）。
- **建议波次**：Wave 2（方案已列）。
- **状态**：待办。

### D-017 · 三个 FSHINE_\* 名字不在 lint 禁绝集内，"FSHINE_\* 已禁绝"是半真

- **位置**：`fshine-agent/packages/agent/src/platform-mock.ts:16`（`REAL_COMMIT_ENV = 'FSHINE_REAL_COMMIT'`，:28 读它做写放行总闸）、`packages/agent/src/pi-coding-driver.ts:172`（`FSHINE_PI_AGENT_DIR`）、`packages/agent/src/context.ts:274`（`FSHINE_PLATFORM_CONCURRENCY`）。
  核实：`grep -rn "FSHINE_" packages/*/src apps scripts | grep -v test` → 恰好这 3 个名字、4 处（另 context.ts:151/272 是注释与文档串）。
  禁绝集实际内容（`platform-leak-lint.test.ts` 的 `FORBIDDEN`）：`FSHINE_(MODE|INVOCATION|COMMIT_TOKEN|GATE_SECRET|EXECUTOR|MOCK_STATE)`——恰好不含这三个。
- **根因**：E4 命名统一只覆盖"治理接口"六名；`FSHINE_REAL_COMMIT` 是写放行安全开关（比治理接口更危险——它是真写的总闸），却因为"不是 E4 那一批"而没被纳入禁绝集，也没被改名。命名空间从此分裂：治理接口叫 EXECUTION_\*，安全开关叫 FSHINE_\*。
- **律法归属**：L2。
- **闭环判据**：三者要么统一改名（`EXECUTION_REAL_COMMIT` / `EXECUTION_PI_AGENT_DIR` / `EXECUTION_PLATFORM_CONCURRENCY`，17dz `test-all.js` 的 LEAKY_EXACT 已预留 `EXECUTION_REAL_COMMIT`）并把 `FSHINE_` 整体加入 lint 禁绝集，要么在 lint 里显式登记"这三个是有意保留的 FSHINE_\*"并注明理由。二选一，不许继续处于"没决定"状态。
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
- **已关（2026-10-16 对账核实；代码层 2026-10-14 D 波 `3e5a36c`）**：编排层侧（本条靶子）已清——业务字段/确认摘要渲染删除，fshine 只剩不透明 payload + 通用确认状态机；§10 差距表"写路径"行随 D 波更新。**L4 闭环判据的 §17 七项（D-031，17dz 侧）仍开放，L4 本身保持开放**——本条关的是编排层侧形状。守卫 = `docs-reality.test.ts`。

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
- **已关（2026-10-16 对账核实）**：两个目录已整体删除（packages 下仅剩 agent/channel-wecom/contracts/core）。守卫 = `packages/agent/docs-reality.test.ts`（目录不存在断言）。

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
- **已关（2026-10-16 对账核实）**：`apps/server/reply.ts` 已整体删除；`renderBarChartPng`/"模拟数据"/`DEMO_` 全仓非测试零命中（判据机械满足）。守卫 = `packages/agent/docs-reality.test.ts`（文件不存在 + 零命中断言）。

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

> 机械守卫（已建，2026-10-16）：Tier-1 打分器——`npm run eval`；语料 `scripts/eval/corpus.jsonl`、评委提示词 `scripts/eval/judge-prompt.md`、打分器 `scripts/eval/score.ts`、记分台 `.runtime/scores.jsonl`。

### D-060 · Tier-1 打分器未建

- **位置**：`fshine-agent/scripts/probe-real-agent.ts`（现有探针，含金额越界/串台/落地/执行语言指纹等判定helper）。
  核实：`find . -name "scores.jsonl" -o -name "*scorer*" -o -name "*tier1*" -o -name "*Tier-1*"`（排除 node_modules）→ 0 命中；`grep -rn "评委\|judge\|四维\|groundedness\|实体保真\|失败诚实\|呈现卫生" scripts/probe-real-agent.ts` → 0 命中；`.runtime/` 有 40+ 个 `probe-fshine-probe-*.json` 原始报告但无记分台、无语料库、无评委提示词文件。
- **根因**：探针是"跑一轮、人读报告、人判过不过"的形态——判定逻辑散在 helper 函数里，没有基线分、没有阈值、没有回归对比。四维分数（groundedness/实体保真/失败诚实/呈现卫生）目前只能靠审计轮次人肉挑，正是今日 30 小时里最贵的成本。
- **律法归属**：L7。
- **闭环判据**：`.runtime/scores.jsonl` 记分台存在且每轮探针写入；四维各有可复现的机械分量（探针断言）+ LLM 评委分量；**评委提示词与语料库随仓库版本化**（否则四维分数不可比）；基线分可复现（同语料同提示词重跑分差在阈值内）；回归有阈值；今日全部事故各一条用例（围栏/驼峰/抽象泄漏/2048/复读/实体串台…）。
- **建议波次**：Wave 4。
- **状态**：**已关**（2026-10-16，L7 波：`2d1ca5b`/`2fb60e6`/`5b99272`/`d826d4f`/`970dd84`/`95f0a12`/`bb69066`）。
  落地形态（全部长在既有仪器上，零判定逻辑复制）：① 探针 `CaseResult` 增 `dims`（四维归维表 `scripts/eval/dims.ts` 单一来源，原句表征锁 `dims.test.ts`，note 文案漂移先红）+ 探针每轮向记分台写机械分量；② acceptance 报告 JSON 增 `writeChain` 节（`scripts/eval/write-chain.ts`：`serve_gate:proposal_create` 行数 = 提案尝试、`change_intents` status/result = 落账+读回、6 位码正则 = 确认码——§E 波末尾点名的"手工提取三个指标"自此机械化）；③ 语料 `corpus.jsonl`（六条存量事故→用例映射，默认基线集 = 探针 A1/A2/A3/A4/A5/B1/Y2 + 写链 acc-write-51）+ 评委 `judge-prompt.md`/`judge.ts`（只吃转录不读审计/机械分量——两分量是独立证据，评委看到机械判定会锚定）；④ 打分器 `score.ts`（四类阈值：dims 上限 / judge 下限−容差 / 写链布尔面 / okMode；记分台追加 eval 行带三元组；`--write-baseline` 唯一基线重定入口，strict 用例 ok 翻转拒绝烤入）。
  **基线与验证**：三轮真模型 + mock 执行器实测（`.runtime/eval-baseline-run1/2/3.log`，scores.jsonl 七行），基线 **v3**（探针 7 例 + 写链 1 组），轮③对 v3 **8/8 全绿**。机械分量在稳定用例三轮逐位一致；写链布尔面三轮全同（尝试 1 次 / committed+读回 / 确认码——D-088 链条 3/3）；评委同转录复跑一致（A2 卫生两次 0），**一例超容差分差如实登记**（B1 卫生跨调用 0→2，temperature 0 下评委仍有同转录方差——机械层是可复现骨干，评委层是粗门限+轨迹）。
  **仪器首日产出（本波自己的修法对象）**：① B1 尺子二次标定——旧"全部数字串"口径把选项序号/裸 0/期间码算进签名，五轮全查且一致答"无数据"也判不一致（轮②实证）；且总调用数判据漏掉"复述谎称实查"（轮① calls 总数恰 5 但第 3/5 轮零调用、回复声称"已经过本轮实时查询确认"）——改金额口径（`extractAmounts`）+ 每轮真查直接判据；② `okExpected` 语义错误（要求缺点必须出现 = 惩罚改进，A2 轮②干净轮反被判回归）——改 `okMode`（strict/free）；③ 基线键命名空间错位（`verdict.id` 探针显示 id vs 语料 id，拒绝守卫误判前值）——`970dd84`；④ free 案评委基线规则补齐：取含缺陷转录的实测下限，与机械 cap 的容忍口径对齐。
  **模型侧间歇观察项（不修，不劣化档入基线 v3，频率轨迹看 scores.jsonl）**：A2 范围渗入（rule-landing §6 既有，轮①③）；A2 not_found 轮执行语言泄漏（错误码形态，轮③——D-098 修尺后首次机械命中）；Y2 佐证数字无所属（轮②）；Y2 歧义澄清缺问句（轮③）。呈现卫生是当前模型最不稳的维（三轮各在不同用例冒一次）——若轨迹显示频率上升即是漂移信号。
  **残留（登记不修）**：D1/Y1 未进默认基线（进基线须补项跑值）；评委与被评模型同源；scripts/ 仍不在 typecheck include（D-084 残留 b）；D-064 残留 5 码照旧单列。

### D-061 · 17dz 测试套件与 `.runtime/rate-limit.json` 耦合，`test-agent-pipeline.js` 当前 RED

- **位置**：`17dz-platform/test/test-agent-pipeline.js`（:69 `assert.equal(r.status, 0, …)` 的 `prepare` 调用被限流拒绝）。
  根因定位：该文件 `agentEnv`（:19-24）设了 `EXECUTION_SERVE/EXECUTION_EXECUTOR/EXECUTION_MOCK_STATE/EXECUTION_GATE_SECRET`，**未设 `EXECUTION_RATE_LIMIT_STATE`**，于是用默认 `.runtime/rate-limit.json`——与真实运行、其他测试、上一轮测试共用同一个令牌桶。
  核实（三连，全部可复现）：
  1. `node test/test-all.js` → `FAILED: agent-pipeline`（`SOME FAILED`，其余全绿）；
  2. 失败消息：`GATE_REFUSE: … 实际 RATE_LIMITED 限流：write 类调用超出速率，约 15s 后重试 …`，exit 3 ≠ 期望 0；
  3. `.runtime/rate-limit.json` 的 `write` 桶 `tokens: 0.339`（近乎耗尽）；
  4. `EXECUTION_RATE_LIMIT_STATE=<临时文件> node test/test-agent-pipeline.js` → **passed**。
  范围核实：`grep -rln "EXECUTION_RATE_LIMIT_STATE" test/` → 只有 `test-rate-limit.js`。其余 6 个会 spawn CLI 的测试文件（`test-agent-pipeline` / `test-auth` / `test-gate` / `test-memory` / `test-mock-responder` / `test-serve-e2e`）**都不隔离**。
- **根因**：`test-all.js` 的测试环境自封（出向）只删了 `LEAKY_EXACT` 名单里的 8 个变量（`EXECUTION_EXECUTOR/FSHINE_EXECUTOR/FSHINE_REAL_COMMIT/EXECUTION_REAL_COMMIT/proxy*/LLM_*`），**没有覆盖"不设就会落到共享真实状态文件"这一类泄漏**。限流是有意做成持久化的（跨进程累计），于是测试就继承了真实运行的桶。
- **律法归属**：L7（验收标准不可复现）+ L5（全回路有界——限流本身没问题，是测试前提被污染）。
- **闭环判据**：`test-all.js` 的自封名单扩展为"所有会落到 `.runtime/` 共享状态的 env（`EXECUTION_RATE_LIMIT_STATE` / `EXECUTION_PLAN_STATE` / `EXECUTION_MEMORY_STATE` / `EXECUTION_AUDIT_PATH`）在未显式设置时指向临时目录"；或每个 spawn CLI 的测试文件自行隔离（推荐前者——一处修，六个文件受益）；修后 `node test/test-all.js` 在**连续两次运行**下全绿（第二次不复现第一次的失败）。
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
| FSHINE_\* 环境变量退役（execution-env 过渡计划） | D-016 + D-017 | **未修**。新发现：写入端（fshine）已切 EXECUTION_\*，仍在双写的是 17dz 自己的 `runner.js:25` 与 `gateway.js:90`；移除条件"稳定一个周期"无定义。另有 3 个 FSHINE_\* 名字不在禁绝集内（D-017） |
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
| D-061（17dz 测试与共享状态耦合，agent-pipeline RED） | **已关** | `test-all.js` 隔离六类状态文件到 per-run 临时目录（含 TOKEN_CACHE_PATH/RUNTIME_DIR）；`test-serve-e2e.js` 审计读取改认 EXECUTION_AUDIT_PATH。耗桶实验：真实四桶耗零后裸 `npm test` 仍 ALL PASS，同态单跑不隔离即 RATE_LIMITED——绿是隔离给的。连跑两次 + 五个真实状态文件字节级未变 |
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
| D-016（FSHINE_* 退役） | **半关（写入侧已拆）** | 全仓+跨仓核查：读点只剩 execution-env 回退、写点只剩平台自己→写入侧安全移除（setServe 只写 EXECUTION_SERVE、gateway 只铸 EXECUTION_INVOCATION），5 条写入面锁；读取侧宽判定保留（旧宿主构建兼容）。退役计划写实进 execution-env 头：条件=两条机器可验事件（宿主 grep 零命中——已被宿主 lint 机械兜住；平台侧只剩回退）+ **时间锚点 2026-10-27 复核，不许无限期续期** |
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

---

## 四路并行验收记录（2026-09-29，D-075 + X2/Y1/Y2 + 冒烟集 + 浏览器生命周期）

**总验收：四路全收。fshine 67 文件 676 例全绿，17dz 27 文件 ALL PASS，chromium 262→28。**

| Lane | 交付 | 验收结论 |
|---|---|---|
| A（D-075） | `82431f9` 两层：①机械兜底——driver `beforeToolCall` 在 evaluate 前扫计划调用的 access（`operation list --json` 派生，L2 合规），写类+capabilities 无 write → 宿主合成 WRITE_NOT_ENABLED 终结该轮，零平台调用；②能力信封注入 worker 提示词（软层）。e2e+变异过 | ✅ 收。**残留**：多步计划中单步写关闭不终结整轮（交 Main Agent 转述，机械性弱）；纯只读准备流程+模型不披露组合理论上仍漏（软层无锁，靠 X 系列盯） |
| B（X2/Y1/Y2 首跑+校准） | `c8b3ed3`。X2 两轮（首跑端点抖动吃两轮，重跑 0 note）——L0 探索行为**优于真实平台那次**：诚实声明"平台只开放按客户名反查，没有列出客户档案的接口"并索要名称；Y1 纠错 0 note 全对；Y2 两轮，3 条误报全修（科目不存在可引其他科目真实余额佐证/重试风暴按 (script,args) 计） | ✅ 收。**两个无断言的模型 watch**：X2-T2 假平台状态（"平台只有 1 个账套"，mock 实为 4 个——关键词枚举后过度概括）；X2-T1 轻度失诚（"未查到"实为"未查询"） |
| C（真实平台冒烟集） | `9be96ba` scripts/smoke-real-platform.ts（3 轮三类形态+写安全三闸+审计/限流生产共享核对）。实跑两次：Run1 平台环境故障（6 调用全 exit 1 页面崩溃）模型全程诚实零编造；Run2 T1 真数 1,234,567.89 ✅、T2 25 候选澄清 ✅、T3 实体沿用成功但 202608 查询又撞浏览器崩溃，诚实报告 | ✅ 收。**新 watch：17dz 浏览器环境当前不稳**（两次独立崩溃，疑内存压力——当时可用仅 2.4G，清理后 3G）；建议平台恢复后复跑拿全绿。审计核对：18 条新增全 read/无写/无限流，auth.json 未动 |
| D（17dz 浏览器生命周期） | `2781dec`（17dz 仓）。**根因意外**：262 个堆积不是平台产的——236 个是 StepCode harness 自己的 CDP 工具泄漏（/tmp/cdpX，端口绑定失败仍孤儿长跑，每个拖 ~10 进程+2 crashpad）；平台用 playwright-core，签名完全不同。仍修了平台真缺口（纵深防御）：信号/exit 回收器+crashpad 显式收编（crashpad 会 setsid 出进程组！）+launch() 返回 browser 句柄。实测正常/异常/信号三路径 Δ0；清掉 229 个孤儿（185 chromium+44 crashpad），保护活跃 CDP 实例 | ✅ 收。**未覆盖**：worker 被 SIGKILL（需 PDEATHSIG 或 supervisor）；harness CDP 工具自身泄漏需 harness 侧修——**它还会继续漏** |
| 主 agent 验收修 | lint 夹具行豁免（FIXTURE_TAG）——冒烟脚本两条负面夹具（坏回复含脚本路径/坏审计含 fill.js）触发指纹尺，按业务词预算「防御排除」同族加行级挂签；变异验证摘签即红 | ✅ 已入 676 例 |
| 文档同步（并行期间自主落） | `b0c1674` AGENTS.md 项目约定 + v0-architecture 实体校验来源更新为四来源（含会话实体） | ✅ 内容审过，准确，收 |

---

## 切真实平台 + 基础设施失败行为实测（2026-09-29 16:00 前后）

**切换**：生产服务从 mock 切真实（/tmp/env-real，pid 2564472，无 platform_mock_enabled 声明）。

| 项 | 实测结果 |
|---|---|
| **退避重试** | ✅ 有界：查询失败（exit 1）→ 平台自动重登录 1 次（也失败）→ 停止。切真实后累计平台调用 **1 次**，限流桶 read 仅耗 1 token。无重试风暴；即使模型想重试，限流器（read 5/3s）机械兜底 |
| **抛异常给用户** | ✅ 诚实且可行动：回复明说“平台登录凭据已过期，系统自动重登录失败”“没有取到任何数据”“凭据不通时不会给出任何估算或编造金额”“请稍后重试；持续失败需管理员确认凭据”，来源标注“本次未取得返回结果”。零执行语言泄漏 |
| **归因不准（新）** | ⚠️ 回复说“账号密码校验未通过”，**真因是平台登录页改版**：手机号输入框前多了一道“欢迎使用”页+下拉框（截图 .runtime/screens/login-pwd-fail.png），登录自动化卡在旧选择器。平台登录层把页面结构失败归因为凭据错误，用户被导向“查密码”而真解是“更新登录自动化” |
| **D-076 平台登录页改版** | **已关（2026-09-29，17dz `08f6b6a`）**：登录页是 JS hydrate 渲染，旧脚本显式等待不足即报“元素缺失”（当日 15:52 的“改版”判断含网络抖动成分）；`login-pwd.js` +153 适配，失败分因 `LOGIN_PAGE_CHANGED`/`AUTH_REJECTED` 进 error-codes.js。实证：`LOGIN_STILL_VALID` + 真实查询返回真数（幻亨纸业 202609 应收 1,234,567.89，与冒烟集一致）。**2026-10-14 更正**：本行原写“待办”，与下方「三路并行收尾记录（2026-09-29）」里同一条的“已关”互相矛盾——同一笔债两份状态。已核实 `08f6b6a` 在 17dz 历史里且是 `login-pwd.js` 最后一次改动，故以“已关”为准，本行改写。**为什么要紧**：`change-safety.md` 的上线门第①条引用的就是 D-076，一份过期“待办”会让下一个人把已满足的前置误判成未满足（或反过来）。**仍未 execution-verified 的一点**：`08f6b6a` 之后没有再过真平台（mock-only 纪律下不允许），所以“修好了”目前只有代码与当年的实证，没有本轮复验。 |
| 瞬时崩溃场景参照 | Lane C 冒烟集 Run1（6 次调用全 exit 1 Page crashed）：模型每轮约 2 次尝试、轮轮诚实报告、零编造——瞬时失败有轮内有界重试，持续失败一次即报 |

---

## 三路并行收尾记录（2026-09-29 晚，D-076+平台健康+mock 无数据）

**总验收：三路全收，真实模式端到端打通。**

| 项 | 结果 |
|---|---|
| **D-076 登录适配** | ✅ **已关**。17dz `08f6b6a`：登录页是 JS hydrate 渲染，旧脚本显式等待不足即报“元素缺失”（15:52 的“改版”判断含网络抖动成分）；login-pwd.js +153 适配，失败分因 `LOGIN_PAGE_CHANGED`/`AUTH_REJECTED` 进 error-codes.js（test-auth.js +49）。实证：LOGIN_STILL_VALID + 真实查询返回真数（幻亨纸业 202609 应收 1,234,567.89，与冒烟集一致） |
| **平台健康信号** | ✅ 已关。fshine `11a9a50`：连续 AUTH 类失败（码级判据，PLATFORM_AUTH_ERROR_CODES 七码）≥2 → 会话冷却 10 分钟（`FSHINE_PLATFORM_COOLDOWN_MS`）+ 宿主合成 PLATFORM_UNAVAILABLE 终稿，冷却期零平台调用；18 单测+e2e+双向变异。`fcb68ae` 补纳两个新登录码 |
| **mock 无数据期间** | ✅ 已关。17dz `f7eea14`：键缺失 → `not_found + PERIOD_NO_DATA` + availablePeriods；键在值为零仍 completed（不变性有测试）。fshine `021d706` 校准探针/e2e。X1 复跑：模型改口“202608 无记录，平台未返回该期间数据”，无一处把无数据说成 0 |
| **D-077（新）企微同账号连接即杀** | **watch（平台行为）** | 17:16 并行 lane 期间第二个同 bot 凭据连接建立，生产服务按企微规则被踢下线且**无人重启**（直到我 20 分钟后发现）。杀因看清（日志 `a new connection has been established`），非代码缺陷；但它证明**进程守护不是可选项**——服务死了不会自己回来 |
| 满载 flake | watch | `pi-coding-driver-activation`“超时不补刀”（40ms deadline）满载时偶发红，单独跑/复跑均过，基线本身同样 flake |

**遗留小尾巴**（lane 报告，均不急）：e2e 夹具叙述体还写“余额为 0 元”（约 10 处，与新语义不符但断言不查）；`availablePeriods` 把内部 token `current` 漏到用户面前；`EXECUTION_FACT_CONTENT_LIMIT=300` 对无数据信封偏紧；mock 的 PERIOD_NO_DATA(not_found) 与真脚本 SUBJECT_NOT_FOUND(failed) 码不同族；D-075 多步计划单步写关闭走模型转述；D-073 探索型 SKILL 映射未做。

---

## D 堆 hygiene 收尾记录（2026-09-29 晚，两路并行）

| 项 | 结果 |
|---|---|
| **current token 泄漏** | ✅ 已关。17dz `64e8bf3`：信封三个用户可见期间字段统一走 `periodLabel()`，`current` 映射为“平台当前期间”；completed 信封的 `data.period` 一并收口（宿主零消费方）。实证：无数据信封 current 原文 0 次，`availablePeriods:["202606","平台当前期间"]`；机读判据（status/code/correctForm）一字未动 |
| **台账截断偏紧** | ✅ 已关。fshine `9930e79`：`EXECUTION_FACT_CONTENT_LIMIT` 300→1000（一个无数据信封 ≈760 + 叙述体 + 余量）+ 留头也留结论尾（头 880 + 尾句 120）。有界性未破：最坏 5×(60+1002)≈5.3KB 常数。诊断比预想重：旧 300 窗连一个信封都装不下，10.1/10.2 的 `toContain('61000')` 当时靠信封 JSON 凑巧过 |
| **e2e 夹具叙述体漂移** | ✅ 已关。8 文件 20 处：“…应收余额为 0 元”→“…平台未返回该期间数据”（判定依据=种子键集）。**刻意不改**：合法零余额（1121/2201 current）、真值（61000/86000）、query-saved 的“0 条”（真空列表）、非零负面样本、runtime.test.ts:404 逐字钉的串（留文件 owner） |
| **多账套真实批量** | ✅ 已跑（L3 升“高”信度）。2 步计划：幻亨纸业真数 1,234,567.89 + 幻驰贸易诚实失败（“科目 1122 不存在，**这不代表余额为零**”+补救路径），汇总两者都覆盖、失败步不阻塞、4 次全 read 调用零写零拒 |
| **C2 三十轮用例** | ✅ 已建未跑（`78192fb`）。30 轮/4 账套/4 次话题切换/2 次澄清-选择/5+1 次召回（带框定断言）/跨轮总结/1 次 not_found；静态自检+运行时两层形态断言 |
| **观察1：首步无计划通知** | 确认无异常。2 步计划首步累计 2 次调用= AUTO_CALLS 阈值内直接执行，第 2 步累计 4 次超阈才通知——配置行为非缺陷 |
| **观察2（新）：tsconfig 不含 scripts/** | **待办（小）** | 项目 `tsconfig.json` 的 include 只有 `packages/**`+`apps/**`，探针文件（800+ 行）**不进项目类型检查**——Lane F 靠临时 config 单独检才抓到 4 个真实错误（常量先于声明使用）。修法：tsconfig include 加 scripts/ 或建 scripts/tsconfig（需评估既有 21 个存量 error 的处置，不是加一行就好） |

---

## D-078/D-079 收尾：超时码 + 搜索空态（2026-09-29 晚）

**根因**（用户手机问“幻辰财税”3 分钟失败那条）：mock 夹具名在真实平台不存在（登录主体幻州市幻晟的 37 个账套里没有它）→ 搜索正确返回空 → 但 `waitForSearchResult` 的空态词汇表（从 mock 时代+真实平台匹配分支归纳）**不认识真实平台空态文案“没有找到匹配的内容”** → 把“已搜完就是没有”误判成“还没加载完” → 干等 25s → 包成 `INTERNAL` 兜底码 → 宿主健康冷却不认 → 模型继续跑下一步 → 又超时。**误诊类 bug：不产错数据，但错误码/叙述/补救全歪。**

| 项 | 结果 |
|---|---|
| **D-079 空态识别** | ✅ 已关。17dz `f46c621`：三路并联判据——匹配行（不变）/ 结构 `.mg-manage-empty`（DOM 探针实证）/ 文案族（收实测词干“没有找到匹配”）。**拒绝两个“更稳健”方案**：零行=空（假阴性比超时更糟）/ 等加载态消失（平台上不存在该标记，等它等于猜）。避开实现陷阱：waitForFunction 判定函数序列化后看不见模块作用域常量，判据必须内联 |
| **D-078 超时语义码** | ✅ 已关。同 commit：`PLATFORM_TIMEOUT` 三要素（“平台页面响应超时，属平台侧环境问题；稍后重试”），errorCodeOf 增 isPageTimeout，**顺序在 AUTH 之后**（登录态绝不因超时表象改判） |
| **宿主不可用族** | ✅ 已关。fshine `1155838`：PLATFORM_AUTH_ERROR_CODES 七→八码，语义改为“平台不可用族”。**入族边界**（判据=谁改得动）：输入类（INVALID_PERIOD 等）不入族（改对参数就能成，冷却挡住本该成功的调用）；数据三态不入族（平台答得准）；兜底码不入族（无语义） |
| **闭环验证** | ✅ 亲自复现：搜幻辰财税 **32.1s 超时 → 7.24s `not_found + ACCOUNT_SET_NOT_FOUND`**；对照组幻亨纸业 7.31s completed 不变；变异 A2（删全部判据）复现 32.07s 超时 |
| **测试门** | 17dz ALL PASS（28 套件）；fshine 69 文件 702 例全绿；变异四向全红对 |

**遗留**（subagent 诚实记录）：MECHANISMS.md 未登记新码（无机械锁）；平台 class+文案双改仍会超时（但落语义码+冷却，不再归错因）；按编号/税号搜的假阴性是同一功能面下一个候选坑；fshine 三处注释仍写“登录态”字面（语义已由码集合承载，下轮 hygiene 对齐）。

---

## D-073/D-075 残留收尾（2026-09-29 晚，两路并行）

| 项 | 结果 |
|---|---|
| **D-073 域混淆+数据不呈现** | ✅ **已关**。17dz `2f176aa`（serve SKILL 两 bullet：“客户”两解读映射+已取数据必须呈现）；fshine `5151168`（worker 提示词零业务词呈现纪律）。**X2 复跑实锤**：干净轮回复显式说明能力边界（“平台没有列出全部客户的能力……可反查、不可列举”）、两解读分清、不混淆、不踢回，成本 295s/8 调用 → **107.5s/1 调用** |
| **D-075 残留 多步计划转述** | ✅ **已关**。fshine `cb99115`：根因是 runtime 排序——计划步骤工具结果渲染（原 1081 行）抢在 writeClosed 检查（原 1092 行）之前，把宿主原句降格成工具结果文本。改为同一条机械路径（单步/多步一致）：宿主原句整体在最前+步骤事实汇总兜底（不含业务数据）+**不附“可以回复继续重跑”**（写计划下是假承诺）。新 e2e 两例（多步：第1步真读+第2步写关闭→原句 startsWith 终稿、零 write 调用、平台只发生1次读）先红后绿 |
| 附带修复 | 熔断条件加 `&& !delegated.writeClosed`——写关闭步若恰是连续第 3 个零执行步，会被熔断汇总顶掉原句（且熔断结尾“可以继续重跑”在写计划下是假承诺） |
| **测试门** | 两仓全绿：fshine 69 文件 703 例（唯一红=已知满载 flake，单独跑 9/9 过）；17dz ALL PASS；tsc 0 error；leak-lint 4/4 |

**仍开的**（如实登记）：① D-075 软层依旧无锁——纯只读准备流程+模型不披露+不提写计划的组合，宿主无机可扫（靠 X 系列盯）；② needs/clarification 与 writeClosed 同现时优先级未动（澄清>needs>writeClosed），该组合披露推迟到下次派发；③ 宿主 `AMBIGUOUS_SELECTION` 模板列候选不点明对象类型（X2 首轮误报之源——要修得在用户话术里加“账套”，但那是业务词，需先定归属标签）；④ 写关闭步在计划投影里记 failed 但不特化原因。

---

## 补充记录（2026-09-30，P1 stop 裁决修复顺手核实的四笔债）

P1 修复（`plan evaluate` exit 3 双语义：`runJson` 对非零 exit 一律抛错使 stop 分支成死代码，见 `packages/agent/src/plan-runtime.ts` 的 `runPlanEvaluation`/`tryParseEvaluation`）不改下列各条，仅做文档登记与对账。任务单第 2、3 条与既有条目同债，确认后不重复登记。

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-080（新）确认路径无 capability 复核：收回 write 后确认码仍可触发 commit** | **待办** | **背景**：capability 只在提案步检查一次——`packages/agent/src/context.ts` 的 `finalizeProposal`（context.ts:364-368）对 capability 不含 write 确定性拒绝；而确认码路径 `matchConfirmation`（context.ts:431-495）的 confirm 分支（context.ts:457-479）从码哈希命中到 commit 执行全程不查 capabilities。**现状**：提案成立后将 principal 的 write 收回，「确认 码」仍走完 commit 路径（结局 failed/committed，而非 WRITE_NOT_ENABLED）。tripwire 钉住当前行为：`tests/e2e/turn-loop-security.test.ts` D3 入口③「缺口钉住：确认写码路径无 capability 复核，收回 write 后确认仍走 commit」（:405 起；任务单写的 turn-loop-write-chain.test.ts 经核实不确，实际在该文件，如实更正）。**迁移方向**：confirm 分支复用 finalizeProposal 同一把 capability 尺（按确认时点的 capabilities 复核，不是提案时的快照——提案到确认之间能力被收回正是本条缺口形状）；修缺口时把 tripwire 断言翻转为写关闭话术。注意该确认路径本身是 AGENTS.md 点名的遗留写路径（待迁移，不作新域模板）。 |
| **D-081（新）EXECUTION_REQUIRE_PLAN=1 严格模式会挡住服务端 commit 的 verify-saved 读回** | **待办（部署前置条件）** | **背景**：`apps/server/commit.ts` 的 `runGate`（commit.ts:52-65）以 `env: { ...process.env, ...extraEnv }` 起网关子进程——server 进程的 env 原样继承。平台计划硬闸（17dz `src/execution/gateway.js:118`、`src/execution/runner.js:42`）在 `serve && planEligible && EXECUTION_REQUIRE_PLAN === '1' && !EXECUTION_PLAN_ID` 时拒 `PLAN_REQUIRED`；`voucher.verify-saved` 是 read/effects=[read]，`isPlannableOperation` 判真（17dz `src/execution/plan.js:146-149`）。**现状**：生产当前不带该 env，无碍；但严格模式部署（或 server 进程带 EXECUTION_REQUIRE_PLAN=1）时，commit 前后的读回基线与读回校验被 PLAN_REQUIRED 拒——`before`/`after` 计数拿不到，`verified` 恒假，落账路径整体瘫痪（且这是"已落账但报失败"的最坏形态）。`runGate` 既不剥 EXECUTION_REQUIRE_PLAN 也不注入宿主侧 EXECUTION_PLAN_ID。**迁移方向**：遗留写路径迁移/严格模式上线时一并解决——服务端直调读回显式声明法域（如 runGate 剥 EXECUTION_REQUIRE_PLAN，或平台侧给宿主直调读回一个豁免判据）；上线前补机械锁：e2e 在 server 进程带 EXECUTION_REQUIRE_PLAN=1 的环境下跑 commit 全链仍绿。 |
| 任务单第 2 条（allowlist 读路径仅提示词约束） | 同债不重复 | 即 **D-066**（读路径授权软控制，watch 待办）。tripwire 确认：`tests/e2e/turn-loop-security.test.ts` D2 组（文件头 :10-12 明示"读路径的范围约束只存在于 worker 提示词层——覆盖缺口"）。D-066 条目本身未改动。 |
| 任务单第 3 条（终稿无执行语言指纹硬闸） | 同债不重复，补引用 | 即 **D-069** 关闭记录里登记的残留（"执行语言指纹尺也不在终稿硬闸上，只在 worker 说明准入与探针用"）。补测试引用：除 D-069 已列的 `runtime.test.ts` F4.1 与 `turn-loop-phone-incident.test.ts` PHONE-2 外，**`tests/e2e/turn-loop-security.test.ts` D4 corpus 五条 ★ 污染塑形用例**（:463 起，伪造信封行/网关路径/内部错误码/taskId 注入物原样到达用户）同样是这条缺口的 tripwire，且已在测试注释里反向引用 D-069。生产补终稿指纹硬闸后，这些 ★ 用例的断言应翻转为零命中。 |

## 补充记录（2026-09-30 第二批，长会话不变量设施发现）

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-082（新）commit 成功路径不回写 platform_tasks 终态：写任务终身"无终态"** | **待办** | **背景**：确认闭环成功时 `matchConfirmation` 的 committed 分支（`packages/agent/src/context.ts:471-478`）只 `ci.updateStatus(rec.intentId,'committed',…)` 后返回；产生该提案的委派任务在 platform_tasks 里 outcome 永远为空。对照：任务失败路径（context.ts:688）会 upsert 任务记录写 failed——成功路径缺了对称的一环。**现状**：任何"任务终态无悬挂"类审计（含新落地的 `tests/e2e/invariant-checker.ts` L1）都必须为 commit 任务开例外；执行可观测性（架构 §4：区分调用获准/实际执行/执行成功）在遗留写路径上缺"执行成功"回写。**tripwire**：invariant-checker L1 的 `expectedOpenTasks` 例外即钉住此现状；`tests/e2e/turn-loop-long-session-invariants.test.ts` S1 场景的写链全程依赖该例外。**迁移方向**：committed 与 confirm_failed 两个分支都在 commit 后 upsert originating 任务 outcome（done/failed）并关联 intentId；修复后撤掉检查器例外，转为硬断言。该路径本身是 AGENTS.md 点名的遗留写路径（待迁移，不作新域模板）。 |

## 补充记录（2026-10-07，企微附件链路 + serve 就业能力缺口审计）

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-083（新）serve worker 无法消费二进制附件：缺"任意格式 → 文本"能力，通用解是沙箱执行，本次显式不引入** | **待办（用户明确推迟）** | **背景**：用户经企微上传的附件已能落到平台工作区内（`17dz-platform/tmp/attachments/`，落点 bug 见下方「同批修掉的三笔」第 1 条），路径也已注入 worker 请求文本。但 worker 仍读不到内容——`read` 工具只放行文本知识面（`.md/.schema.json/.agents//docs//mappings/`）且本身是文本读取，二进制 xlsx 读出来是乱码；而 serve 模式唯一执行通道是网关，网关只解析 `operations.json` 注册的脚本。三条路组合起来，二进制内容没有任何一条能进到模型面前。**平台审计实证**：`17dz-platform/.runtime/invocations.jsonl` 里 `prepare dump.py → 脚本未在 operations.json 声明`（skill 级脚本在 serve 下不可执行）。**已验证的事实**：① 平台上已有"吃 xlsx"的同族能力——`voucher.parse-yijieda-bills`（xlsx → VoucherContract，access=local，serve.prepare=true），说明机制现成，工资域只是缺对应物；② worker 已有 `write` 且被机械边界限制在 `tmp/<requestId>/`，即"写脚本"已可行，"跑脚本"不可行（bash 只允许网关调用）。**通用解**：给 worker 一个隔离沙箱执行面（剥环境变量/断网/cwd 限定为仅含输入文件的空临时目录/仅准跑 `tmp/<requestId>/`），让它针对现场格式自己写解析逻辑。这不是"怕它写错代码"——模型看错单元格只是算出错数；问题是**附件内容由任一企微用户提供（攻击者可控）**，而代码执行是唯一能把"模型被引导"升级成"系统沦陷"的权限（进程可读 `.env`/`auth.json`）。压掉该风险的关键不是审代码质量，是让执行体碰不到凭据与平台会话——纯本地解析本来就不需要它们。**用户裁决（2026-10-07）**：暂时不引入沙箱，本条记债后置；当前用「用户粘贴文本」或「平台预注册 operation」两种替代走通业务。**闭环判据**：沙箱执行面落地，且满足 ① 执行子进程 env 已剥 `.env`/auth/token 类变量（grep 断言）；② 无网络出口（机械断言或沙箱配置）；③ cwd 为仅含输入文件的临时目录；④ 仅接受 `tmp/<requestId>/` 下的脚本（复用 serve-gate 的 `scratchDir` 判据）；⑤ 每次执行落审计（脚本路径 + 哈希 + 退出码）；⑥ e2e 覆盖"附件内含诱导指令时不构成代码执行"。**建议波次**：Wave 4（安全设施批）。**备选修法**（不必等沙箱）：按 `TEMPLATES.md` 既有流程沉淀——AI 分析新格式 → 生成 mapping → 人工确认 → 存 `mappings/`，把解析固化为 mapping 驱动、由人 review 的 operation。 |
| **D-083 附条 · 附件-only 消息曾各自启回合，串行堵死会话队列** | **已关（2026-10-07）** | 用户"先发文件、再发指令"时，每个 file 消息都触发一整个 Agent 回合：N 个文件 = N 次 LLM 调用，且串行占住会话队列，真正带指令的那条排在后面出不来。实测形态：3 文件 + 1 指令 → 4 个 ack、0 个最终回复，第一条文件回合卡在 LLM 上（10 分钟预算内不返回）。修法：契约加 `IncomingChannelMessage.attachmentOnly`，宿主据此只暂存附件不启回合（落审计 `attachment_received`），带正文的回合一次性取走并清空缓冲；迟到的文件明确回复"指令请再发一次"而不是静默干等。机械锁：`apps/server/handler.test.ts`「附件-only 消息的暂存与交付」+「附件迟到 + 文字回合在飞(真并发)」+「会话队列的失败留痕」。 |
| **同批修掉的三笔（登记备查，均已关）** | **已关（2026-10-07）** | ① **附件落点在平台工作区外**：最初落在宿主 `fshine-agent/data/attachments/`，而 worker 的 cwd 是 `17dz-platform/`，`workspaceRelPath` 判"工作区外"直接拒——症状是指代不清的"读不到附件"。改为 `<platformRoot>/tmp/attachments/` 并在渠道启动时断言落点必须场內（不等用户发文件才暴露）。锁：`packages/channel-wecom/adapter.test.ts`「附件目录在平台工作区外:启动即拒」+「不配 attachmentDir 时,默认落在平台工作区的 tmp/attachments」。② **`tmp/` 无回收**：`packages/agent/src/scratch-cleanup.ts` 新增，只删 `tmp/req_<uuid>` 形态的位置（平台自己的 tmp/ 产物一律不碰，宁可漏删不可误删），按 24h TTL、启动 + 每 6h 扫；按年龄而非生命周期删，因为任务可跨轮续跑。③ **队列失败被静默吞掉**：`task.catch(() => undefined)` 的语义是"别让失败回合毒化队列"，但也把失败吞得无声无息，导致一个附件回合消失时连"它失败了还是没跑"都无法判断。现打 `wecom_turn_failed`（带 messageId/principal/error）。 |

### D-083 附条 · 用户裁决变更（2026-10-07 晚）：不等沙箱，先让 worker 自己写解析代码

| 项 | 内容 |
|---|---|
| **裁决变更** | 原记录"暂不引沙箱、后置"，业务上用「用户粘贴」或「平台预注册 operation」顶着。实测两条都不成立：粘贴 117 人工资表不现实；预注册 operation 则每种新格式都要人写 parser。**用户最终裁决：让 worker 自己写解析代码并执行。** |
| **落地形态** | ① 平台网关新增 `local` 模式，**只放行 `<platformRoot>/tmp/` 下的脚本**（`src/lib/serve-gate.js` 的 `isScratchScript`，逐字前缀判断，`tmpx/` 不误放）；宿主侧 write 门早已把 worker 可写位置钉死在 `tmp/<requestId>/`，两者叠加后实际可达面 = 本轮自己的草稿目录。② 子进程 **env 剥壳**（`gateway.js` 的 `scrubSecrets`）：只留 PATH/HOME/LANG 等系统变量与 `EXECUTION_*STATE|AUDIT|MOCK|PLAN_ID`，其余一律不给——宿主经 `node --env-file` 灌进来的 `LLM_API_KEY`/`WECOM_BOT_SECRET`/`EXECUTION_GATE_SECRET` 因此不会被子脚本继承。③ **免计划前置**（fshine `serve-gate.ts` 的 `isLocalScratchRun`）：纯本地计算不触平台会话，为它提计划是仪式；shell 元字符仍拦。④ 审计两条：spawn 前记脚本 `sha256`，结束后记 `exitCode`。 |
| **仍未堵住的暴露（如实登记）** | **这不是沙箱。** 脚本以 cwd=平台根运行，仍能读盘上的 `.env`、`.runtime/auth.json`、`.browser-profile/`。env 剥壳只挡住"从环境变量拿凭据"这一条。附件内容由任一企微用户提供（攻击者可控），因此"附件内含诱导指令 → 模型写脚本 → 执行"这条路依然存在，只是多了一层 env 屏障。 |
| **为什么仍接受** | 用户明确知悉上述暴露后选择先要能力（原话："暂时先不需要这么高的安全能力"）。沙箱批次的闭环判据见 D-083 主条目六条，落地后本条附条的"仍未堵住"应清空。 |
| **机械锁** | fshine `packages/agent/serve-gate.test.ts`「local 执行（bin/17dz local <tmp/…>）」四条（计划未激活也放行 tmp/ 下脚本 / 非 tmp/ 一律不放行 / shell 元字符仍拒 / 首 token 非网关不当 local）；平台侧 `tmp/` 判据由 `src/lib/serve-gate.js` 的 `isScratchScript` 直接单测覆盖（`tmpx/`、`src/` 均 false）。 |

## 补充记录（2026-10-13，写路径保险箱 B 波收口 + acceptance 仪器审计）

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-084（新）acceptance 仪器四缺陷：W3 的 mock 全链验收入口自 2026-09-25 起跑不了** | **已关（2026-10-13）** | **背景**：`docs/change-safety.md` W3 把「`smoke:commit:mock` + `acceptance` 5.x 写链路 mock 下全绿」定为波次唯一验收。而 `scripts/acceptance.ts` 自引入 commit `f0f0fe8`（2026-09-25）起有四个各自独立致命的缺陷，从未完整跑成过一次——`data/` 下最后的报告 `202609220353.md` 正处在 f0f0fe8 之前。① `:237` `const platformRoot = assembly.platformRoot` 与 `:218` 活着的那条同一作用域重复声明 → esbuild 编译错，**脚本连入口都没进**（该声明之后全文再无读取，是死代码）。② `:326` 报告里用全文未声明的 `dbPath` → 跑到最后一步 ReferenceError。③ 报告写在 `assembly.close()`/`auditDb.close()` **之后**，而每回合结束都 enqueue 两个 fire-and-forget 队列（`turn-persistence.ts` 的 `enqueueContextStateUpdate`/`scheduleMemoryConsolidation`），写的那下不在回合 await 链上 → `conversation_log_update_failed`（该会话 Context State 整段丢失）+ `long_memory_consolidation_failed`，而报告已落盘、exit 0，丢失无声无息。④ `:350` 调 `handler(message, progress)` **只传两个参数**，生产（`channel-wecom/src/adapter.ts:326`）与 e2e harness（`tests/e2e/harness.ts:636-643`，注释明写"生产保真"）都传三个 → `onNotice` undefined → `plan-runtime.ts:130/147` 的 fail-closed 守卫生效（抛"已暂停执行"），**任何走计划门的写链路都被挂死**。修法：①② `2f29f4e`（删死声明 + 提出 `const dbPath` 单一出处）；③ `4c7d28e`（`drainBackgroundPersistence`，判据取存储自身的可观察终态 `conversation_context_states.through_event_id` 覆盖该会话最后一条事件，再等 `PRAGMA data_version` 静默地平线，超时报 `acceptance_drain_timeout` 不吞；报告改到关库之前落盘）；④ `64f8ea7`（补第三参 `createNoticeRecorder`，照 e2e harness 只外包记录不碰生产链路，notice 原文进报告与 records JSON，送达失败记 `acceptance_notice_fail` 后 rethrow）。**机械锁**：`--only=5.3` 与 5.x 子集实跑，两条丢失写 0 次、`acceptance_drain_timeout` 0 次、3 条计划通知逐字进报告、worker 首次在真模型下产出 `prop_7a458052-…`；`npm test` 1244→1247 全绿。**残留（两条，记在案未修）**：a) `scripts/acceptance-22-supplement.ts:65` 同样只传两个参数（同形状缺口；`scripts/ask.ts:125` 核实后**已有** notice，不在缺口内）；b) `tsconfig.json:23` 的 include 只含 `packages/**` 与 `apps/**`，`scripts/` **不在 `npm run typecheck` 覆盖内**（`--listFilesOnly` 实测 0 个 scripts 文件），该文件有 14 条既有类型错误无人看见——而 leak-lint 反而扫 `scripts/`，两边覆盖不对称。 |
| **D-068 附条 · 实体来源校验把 worker 自产 scratch 路径当越权实体（假拒致写链路建不出提案）** | **已关（2026-10-13，`72f5e09`）** | **背景**：与 D-068 同一个校验器（`packages/agent/src/turn-contract.ts` 的 `validatePlanEntities`），但根因不同——D-068 是"跨轮次实体丢失"，本条是"把不是领域实体的东西当成领域实体"。2026-10-13 真模型 + mock 平台 + 写开放 + 网关路径开，审计库 `tool_calls` 记录：worker 把提案 payload 写进自己的 scratch 目录后，把 `voucher.proposal tmp/<requestId>/proposal.json` 排进计划提交 → `PLAN DECLINED：ENTITY_OUT_OF_SCOPE: 实际 计划包含未在…中出现的参数：tmp/req_31776cfb-…/proposal.json` → 重试 → 6 次后撞 `MAX_DECLINED_PLANS_PER_TASK`（`pi-coding-driver.ts:36`，=5）→ terminal block，worker 放弃。**根因**：`validatePlanEntities` 对每个不以 `-` 开头的字符串参数都要求在 haystack（当前消息/检索证据/平台响应/会话实体）里逐字找到，而 worker 刚落盘的工作区产物路径当然不在里面。**这是意外后果而非设计决定**：现有测试（`context.test.ts:88-96`、`461-470`）钉的全是领域实体语义，没有任何路径类用例。**为什么新网关路径更容易中**：开关关着时 worker 用直接 `bash` 发同一条命令，绕过实体校验所以成功；开关开着时走 `plan_submit` 必须过实体校验。**修法**：新增 `PlanArtifactBoundary({workspaceRoot, scratchDir})` 与 `isOwnArtifactPath()`，`validatePlanEntities` 加第三个**可选**参；不传边界判据时豁免整支不出现（判定与从前一字不差，有测试钉）。豁免复用 `serve-gate.ts` 的 `workspaceRelPath` + `isInsideScratch` 这一把尺（提案 payload 边界检查已在用），没有第二份路径解析；解析后必须落在本轮 `tmp/<requestId>/` 内，`../` 穿越/绝对路径越界/符号链接逃逸/别轮次 scratch 全都过不了。**机械锁**：`context.test.ts` 两条（本轮 scratch 产物放行 + 对抗：别轮次 scratch/词法穿越/`docs/名单.md`/`/etc/passwd`/`../…` 全仍拒，外加"豁免按参数逐个判定，同一 call 里的幻觉实体照样报它"）；`pi-coding-driver.test.ts` 驱动级接线一条。**变异验证（主 agent 本人做的，非转述）**：把 `isOwnArtifactPath` 改成恒 false → 正好这 3 条红、其余 78 条不受影响，还原后 52 绿。`npm test` 1247 全绿、typecheck 0 错误、leak-lint 4/4。 |
| **D-085（新）haystack 的条数窗口与单条截断构成另一种假拒（与 D-068 同族，未修）** | **已关（2026-10-14，`2e2a699`）** | **位置**：`packages/agent/src/turn-contract.ts` 的 `validatePlanEntities` haystack 构造——对平台响应只取 `slice(-PLATFORM_RESPONSE_MAX=20)` 且每条只取 `slice(0, PLATFORM_RESPONSE_LIMIT=20_000)`。**根因**：两条都真实有效。① **条数窗口**：`collectPlatformResponses`（`pi-coding-driver.ts:1177-1185`）把会话里**每一条** toolResult 都收进来，包括被门拦下的（SDK 把 `{block:true,reason}` 转成 error tool result）。扫全部 42 个历史验收库，单 request 的 tool_call 数有 9/11/13/21/26/26/32/34/37/39/40/47/**87**——大量超过窗口 20，"早期平台响应里确立的实体"在后续计划提交时已滑出窗口，而 `turn-contract.ts:179-180` 的注释点名要支持的正是"目录查询拿到唯一候选、再按候选名查"这个场景。② **单条截断比注释说的更狠**：注释说 20_000「与宿主留存 tool_result 的截断一致」，但那个截断在 `turn-persistence.ts:197`，只作用于 `run_17dz_task`/`route_current_turn` 的**落库**流，完全不经过 haystack 读的 `session.agent.state.messages`；真正作用在会话转录上的是 SDK bash 工具的保尾弃头（约 2000 行/50KB），宿主再 `slice(0,20_000)` 只看到其中段。**终局形状与 D-068 附条相同**：假拒 → 重试 → `DECLINED_PLAN_LIMIT` → worker 放弃；且写路径（scratch 产物场景）正是长任务形状，最容易滑窗口。**建议波次**：与 D-068 附条同批（同一函数、同一终局）。**闭环判据建议**：haystack 覆盖判据从"最后 N 条"改为"本任务迄今全部 toolResult 的结构化实体集合"（复用 D-068 的 `sessionEntities` 来源 A 机制，而不是把窗口调大——调大只是把阈值推远，不解决"实体来源应是结构化的"这个根因）。 **闭环（2026-10-14，`2e2a699`）**：条数窗口 `slice(-20)` 与保头 `slice(0,20_000)` 一并删除，改为「本任务迄今**全部**平台响应、单条**保尾**」（新常数 `PLATFORM_RESPONSE_TAIL_CHARS = 50_000` = SDK 自己的单条工具结果上限，对真实转录是恒真 no-op）。**判据据现场核实改写**：原字面「改为结构化实体集合」实现不了——信封 `data` 的每个字符串叶都是它所在响应原文的子串（`RESULT` 在 stdout 末行、SDK 保尾弃头），所以只收叶值是可证的**收窄**，会打破 golden `turn-contract.test.ts:235`（该用例用的就是非信封原文）并新拒「幻电设备」vs 平台返回「幻电设备有限公司」这类缩写/简称形状，方向与修假拒相反。改为「全部原文 + 结构化叶值作为**附加**第二来源（additive，只增覆盖）」，包含判据仍是逐字包含。**新发现的根因（台账原先没有）**：SDK 默认开自动压缩（阈值 = contextWindow − 16384 ≈ 111 616 token），一到阈值 `agent.state.messages` 被换成 `[压缩摘要] + [保留尾段]`（`keepRecentTokens` ≈ 80KB），早期 tool_result 整条消失——单请求 87 次 tool_call 的长任务必然触发，所以覆盖判据物化成两个通道：转录通道 + 宿主在 `afterToolCall` 上的账本通道（压缩免疫）。**机械锁**：`platform-entities.test.ts` 15 条 + `turn-contract.test.ts` +4 + 驱动级 +5（21 条响应实体在第 1 条 / 防幻觉不变 / 60KB 噪声 + 末行信封 / 压缩后账本仍认得早期实体 / 注入路径不变）。**变异验证**：改回 `slice(-20)`、保尾改保头、删 `platformEntities`、删账本记账、删转录通道、调大保尾常数 —— 六项各自对应断言红。 |
| **D-086（新）被拒计划的原因文本回灌 haystack，形成"假放行"方向（安全相邻，未修）** | **已关（2026-10-14，`7281daf`）** | **位置**：`packages/agent/src/turn-contract.ts` 的 `ENTITY_OUT_OF_SCOPE` 消息（截到 80 字符）逐字带 offending token，该消息作为 tool_result 回到会话，而 haystack 的 `platformResponses` 正从会话 toolResult 收集。**根因**：于是**同一 token 原样重提一次就能过**——第一次被拒反而把该 token 送进了 haystack。方向与 D-085 相反（那条是假拒，这条是假放行），但同源：haystack 把"宿主的拒绝理由"当成了"平台返回的实体证据"。**影响**：实体来源校验的防线可被"先故意提一个越权实体、拿到拒绝理由、再原样提一次"绕过；对恶意/失控 worker 是真实的边界弱化。**建议波次**：与 D-085 同批。**闭环判据建议**：haystack 只收平台**成功**响应的结构化产物，不收门拒绝理由（拒绝理由进独立的"上次为什么被拒"通道，供 worker 自纠但不作为实体来源）。 **闭环（2026-10-14，`7281daf`）**：按 `toolCallId` **身份**排除宿主自己拦下的那一跳（`beforeToolCall` 改成 wrapper，`verdict?.block` 与抛异常两处都记），收集处按 id 整条排除。**两处被否决的替代方案及理由**：① 按 `isError` 过滤 —— 不行，SDK bash 工具退出码非零时 throw，平台 CLI exit 3 的真错误信封同样 `isError:true`，按它过滤会把真平台证据一起删掉、制造新假拒（单测钉住）；② 按协议前缀嗅探文案 —— 不行，那是从结果原文猜语义，且名单要跟着每个新裁决增长，平台响应只要引用宿主一句话就能绕过（单测钉住）。**「上次为什么被拒」通道不新建**：被拦的 tool_result 原文本来就是 worker 自己的工具输出（自纠通道）+ `needsClues` 已把理由交给主 Agent + `correctForm` 已带正路径，三件套都在；这里只收回「把它当实体证据」这一项。**机械锁**：`pi-coding-driver-entity-scope.test.ts` 6 条（核心 = 越权 token 被拒后原样重提仍被拒，改前第二次提交确实放行）。**变异验证**：删 block 分支记账、删 catch 分支记账、身份判据换 `isError`、身份判据换 `toolName` —— 四项各自对应断言红。 |
| **D-087（新）acceptance 报告不 surfaced `tool_calls` 表，根因诊断被延迟数小时** | **已关（2026-10-14，`3beb3b5`）** | **位置**：`scripts/acceptance.ts` 的报告只写 `subagentFinalText` 与 `progressSteps`（+ notice），不读审计库的 `tool_calls`。**根因**：计划门的三类拒绝里只有 `plan_write_not_enabled` 有 `console.info` 事件；实体越权、`PLAN_NOT_PLANNABLE`、`DECLINED_PLAN_LIMIT` **在宿主侧全静默**——它们只作为 tool_result 回给 worker 并落进 `tool_calls` 表。2026-10-13 定位 `ENTITY_OUT_OF_SCOPE` 假拒时，报告里只有 worker 终稿说"操作申请已用尽"，真正的拒绝原因一直在库里记着（`safe_arguments` 带完整三要素），但没有任何出口把它带到人眼前。**影响**：每一次这类缺陷的定位成本都从"读报告"变成"手工查 sqlite"。**建议波次**：随 acceptance 仪器批（D-084 同批）。**闭环判据建议**：报告增加一节「计划门拒绝明细」——按 request 列出 `serve_gate:plan_submit` 的 status/error_code/reason；或至少在 `acceptance_case_done` 事件里带 `planRejects` 计数（与已有的 `noticeCount` 同族，0 条通知已是保真缺口复发的信号）。 **闭环（2026-10-14，`3beb3b5`）**：新模块 `scripts/plan-reject-report.ts`（按 request 取该回合全部 `serve_gate:plan_submit` 行，理由/摘要用 `json_extract` 从 `safe_arguments` 取——该表没有独立 reason 列）；`acceptance.ts` 的 `CaseRecord` 加 `planRejects`，报告每节多一行汇总 + 若干行明细（declined 前置，理由截断到 200 字不铺全文），`acceptance_case_done` 事件加 `planRejects` / `planDeclines` 两个计数。查询点在回合返回后立刻：`reportPlanSubmission` 的 insert 函数体没有 await，行在调用时就同步落库，不必等 `drainBackgroundPersistence`。**出口选审计库而不是再加 console.info**：日志解决"这次看得见"，不解决"每次定位都要手工查 sqlite"。分类只认宿主自己的协议前缀且**只做报告、没有任何门读它**（不按错误码名猜语义，D-089 纪律）。`vitest.config.ts` 的 unit include 加 `scripts/**/*.test.ts`，补上 D-084 残留 (b) 的一半不对称（tsconfig 的 include 仍不含 scripts/，那一半不混进本波）。**机械锁**：`scripts/plan-reject-report.test.ts` 9 条，行形状按现有 `data/acceptance-202610131453.db` 与 `…202610131112.db` 里真实的两行钉。**变异验证**：删 SQL 的 `tool_name` 过滤 → 隔离用例红。 |
| **D-088（新）真模型不稳定抵达提案步：写路径端到端未经真模型验证** | **已关（2026-10-14）** | **位置**：实证 = 2026-10-13 三轮真模型 + mock 平台 + 写开放 + 网关路径开（`FSHINE_PROPOSAL_VIA_GATEWAY=1` + `FSHINE_PROPOSAL_COMMIT=1`）：轮① worker 自己跑了 `bin/17dz prepare voucher.proposal tmp/<req>/payload.json`（该轮开关关着）并在平台侧建出提案；轮② 把 7 次查询配额用尽后说"操作申请已用尽"放弃（该配额在 host/平台/SKILL 三处都不存在，见 D-067 附条）；轮③ 反复把 `voucher.proposal` 排进计划，每次被 `PLAN_NOT_PLANNABLE` 拒（消息不点名操作，见 D-089），6 次后撞上限放弃。**根因**：三个可修的宿主/平台侧缺陷叠加（notice 缺失、实体假拒、拒绝不点名）+ 模型在计划门交互上的真实方差。**已排除的误解（重要，勿再犯）**：**mock 全链本身是通的**——`smoke:commit:mock` PASS（提案→确认→落账→读回，mock 状态 0→2）；`tests/e2e/turn-loop-write-chain.test.ts` 16/16（含 create→确认→commit→读回、`EXECUTION_REQUIRE_PLAN=1` 全链、平台拒绝、确认时点能力收回）。W3 指定的 mock 验收门是绿的，未通的只是真模型这一条腿。**建议波次**：D-084/D-085/D-086/D-089/D-090 修完后复跑三轮取稳定率。**闭环判据建议**：连续三轮真模型 + mock 平台，5.1 均能产出 `prop_*` 且 5.2 能取到 6 位确认码完成落账；三轮报告写进 `data/acceptance-report-*` 留档。 **进展（2026-10-14）**：台账原文列的三个可修上游缺陷已全部关闭——notice 缺失（D-084，`64f8ea7`）、实体假拒（D-085，`2e2a699`）、拒绝不点名（D-089，`71757d3`）；`voucher.proposal` 的声明矛盾（D-090，17dz `a683df2`）亦已关。D-086（`7281daf`）额外堵上了"先故意提越权实体、再原样重提"这条绕过路径。**本条因此只剩"连续三轮真模型 + mock 平台"这一件事**，按 architecture-laws 的关账纪律不因"上游都修完了"而标关——字面判据是连续三轮，差一轮都不算达成。  **第二轮（2026-10-14，`data/acceptance-report-202610140749.md`）——为跑写链路把本地主体 `capabilities` 开到 `["read","write"]`（`config/agent.yaml`，gitignored；mock 执行器 + `FSHINE_REAL_COMMIT` 空两道闸未动）。仍未达成，且暴露一个新缺陷：报告里两次 `PLAN STOP 当前未开放写入权限`，而 `plan_write_not_enabled` 事件零次、库里 `principal_scopes.capabilities` 明明是 `["read","write"]`——这句话不来自 D-075 前置扫描，而是 evaluate 失败分支的假归因（已修，登记为 **D-096**，`4aeab16`）。worker 把假归因原样转达给用户，用户被指去找管理员要一个他已经有的权限，这一轮放弃。**第三轮（`data/acceptance-report-202610140830.md`，D-096 修后复跑）**：假归因已除（本轮 `declined` 从 5 降到 1、计划门裁决从 8 降到 2），但 worker **没能产出形状合法的计划**——两次裁决分别是 `PLAN_JSON_PARSE`（方案 JSON 以 `-` 开头）与 `PLAN REFUSE UNKNOWN_OPERATION:operation list`（worker 把 CLI 子命令 `operation list --json` 塞进了计划的 calls 数组；已实测该命令在 serve 法域下直接跑是 exit 0 的，所以这是" CLI 子命令 ≠ operation"的模型侧混淆，属 D-095 实例①），终稿只剩"17dz 子任务执行失败，请稍后再试"。 **连续三轮复跑（2026-10-14，`acceptance-report-202610140902/…0911/…0920.md`，mock 执行器，本地主体临时 `["read","write"]`）——2/3 通过，未达成"连续三轮"**：① 轮① **PASS**：5.1 出 `prop_8ef3fd97-…` + 6 位码 `4R2V98`，5.2 落账且读回校验通过（凭证数 +1）；② 轮② **FAIL**：宿主给出正确的点名指令（`不该放进计划的是：voucher.proposal。请…改为直接调用`——D-096 修复生效），worker 也照办把 `voucher.proposal` 移出计划并跑完了全部只读核实，**然后停在下一次交互**，终稿写"确认后由系统执行录入"；审计库里 `proposal_create` 行 **0 条**——它从未尝试过提案步。这正是 **D-075 记录的 T7 事故形状**（"走完录入准备、承诺即可产出提案却永不抵达提案步"），只是发生在写开放的配置下；③ 轮③ **PASS**：5.1 出 `prop_38603366-…` + 码 `RZE78N`，5.2 落账、读回 +1。**判据未达成的原因不是宿主/平台侧缺陷**：三轮里计划门的拒绝全部可行动、无一次 `ENTITY_OUT_OF_SCOPE`、无一次假归因；唯一失败轮次是模型侧 workflow 缺口（登记 D-097）。按关账纪律仍不标已关。 **结论**：宿主/平台侧可修的障碍已全部清掉（D-084/D-085/D-086/D-089/D-090/D-096），剩下的是模型在计划门交互上的真实方差（D-095），要的是多轮复跑取稳定率，不是再改代码。 **首轮真模型基线（2026-10-14，`data/acceptance-report-202610140425.md`，mock 执行器）——未达成字面判据，原因三层、均可从报告直接归因**：① **部署姿态**：本地 `config/agent.yaml` 的主体 `capabilities: ["read"]`，写未开放。5.1 的计划里出现 `voucher.proposal` 时被 D-075 的计划扫描兜住（`PLAN STOP 当前未开放写入权限`，detail 逐字列出该调用）→ worker 到不了提案步 → 回复不含确认码 → 5.2/5.4 按既有逻辑跳过。这不是本轮引入的缺陷，但它是 **D-090 的一个后果**：17dz `a683df2` 把 `voucher.proposal` 从 `scratch` 改成 `write` 之后，`planWriteClosed` 读的 `confirm` 列为真，计划扫描兜底**首次对提案步生效**（change-safety B 波记的「对提案步不触发」已因此更正）。要跑字面判据必须把该主体 `capabilities` 开到含 `write`。② **模型侧形状问题两例**（新登记 D-095）：worker 发明了不存在的 `operation list` / `operation.list`（平台回 `PLAN_REFUSE UNKNOWN_OPERATION`，两次 `PLAN PAUSED`）；5.3 里两次 `PLAN_JSON_PARSE`（方案 JSON 以 `-` 开头）。③ **D-085/D-086 的修复无可观测负面效应**：本轮 10 次 declined 里 `ENTITY_OUT_OF_SCOPE` 零命中——三类静默拒绝里最相关的那一族本轮没出现（样本仅一轮，不作为结论）。**仪器侧结论**：D-087 落地后报告首次带出「计划门裁决 / 计划门拒绝明细」两节，5.1 的 6 次、5.3 的 4 次裁决全部列明理由与 calls 摘要——换在 E3 之前，这些位置只有 worker 终稿那一句。 **已排除的误解不许再犯**：mock 全链本身是通的（`smoke:commit:mock` PASS、`turn-loop-write-chain` 16/16），要验的只是真模型这一条腿；且三轮稳定率是**统计判据不是证明**，模型在计划门交互上有真实方差，任一轮失败要按报告节里的拒绝码归类（宿主/平台可修 → 登记新债或补进既有条目；模型方差 → 记观察项，与 rule-landing §6/§9 对 A2/F1 同口径）。 **闭环（2026-10-14，D-097 修后连续三轮）**：三轮全部达成字面判据——5.1 均产出 `prop_*` 且 5.2 均取到 6 位确认码完成落账、读回校验凭证数 +1。① `acceptance-report-202610141202.md`：`prop_68c39c11-…` + 码 `GK74HC`，计划门裁决 5（declined 2）；② `…1209.md`：`prop_70535385-…` + 码 `UF6HCA`，裁决 5（declined 1）；③ `…1217.md`：`prop_131f91fd-…` + 码 `WFVSKC`，裁决 4（declined 1）。**前置与边界**：三轮均在 mock 执行器 + 写开放（本地 `config/agent.yaml` 主体临时 `["read","write"]`，`.env` 的 `EXECUTION_EXECUTOR=mock` 与空的 `FSHINE_REAL_COMMIT` 两道闸未动）下取得；真平台仍受上线门把守（`docs/change-safety.md` §4 上线门四条），本条只证明"真模型 + mock 执行器"这一条腿通了。**对比基线**：改造前同一条用例三轮全失败（D-067 附条的"操作申请已用尽"、轮③ 反复 `PLAN_NOT_PLANNABLE` 后撞上限放弃）；本波修掉 D-084/085/086/089/090/096 六项后 3/3。 |
| **D-089（新）`PLAN_NOT_PLANNABLE` 不点名是哪个调用，worker 无法 self-correct** | **已关（2026-10-13，`71757d3`）** | **位置**：`packages/agent/src/pi-coding-driver.ts:176-178` 的 `planNotReadOnlyCode(calls, semantics)` **手里就拿着 `calls`**，却只返回一个错误码；`messageTextFor(code)` 渲染 `error-codes.ts:280` 的固定文案「该调用不需要计划、也不要放进计划，直接调用即可。」。**根因**：worker 的计划里有 3-4 个调用，这句不含操作名的文案让它无法定位该删哪一个 → 原样重提 → 6 次后撞 `MAX_DECLINED_PLANS_PER_TASK` → 放弃（D-088 轮③ 的直接死因）。**修法要求**（已派 subagent）：消息列出具体 operation 名并说清下一步；三要素消息的唯一出处仍是 `error-codes.ts` 的表，用表里既有的参数化机制（`messageFor(code, actual)`），不新造一套；保持两枝分流判据（平台 access 语义表的 confirm 列）不变，**不按错误码名猜语义**；消息是给 worker 的协议文本不上屏。**顺带核查要求**：语义表缺失 / operation 未登记时 `isWriteAccess(semantics?.get(...))` 的降级路径是否真的按注释"宁缺勿猜"成立，有没有可能把要用户确认的写类误判成②。 |
| **D-090（新）17dz `voucher.proposal` 的声明与实现互相矛盾** | **已关（2026-10-13，17dz `a683df2`）** | **位置**：`17dz-platform/src/voucher/operations.json` 的 `voucher.proposal` 声明 `"access": "scratch"` + `"effects": ["local"]`；而 `src/execution/proposal.js:218` 的注释自己写着「mock 只换"触平台"的操作，**dry-run/save/读回三者都触**」，`runDomain` 在非 mock 下确实 `spawnSync(process.execPath, [SCRIPTS.fill, ...])` 起真 `fill.js`。**根因**：`access: scratch` 在语义表里意味着 `mock:false`（联调不能替换）+ `plan:false`（不进计划、网关不 bind）——即"纯本地、不触平台、不需要计划"；而实现起了真域脚本触平台，同一个 `runDomain` 还带着 `touchesPlatform:true` 的真平台执行门（fail-closed），等于实现侧在补偿这个错误声明。这是 A 波 commit `38585d4` 引入的缺陷。**后果**：宿主按表叫 worker"别把 voucher.proposal 放进计划"，而它恰恰是写路径里最该让人签字范围的那一步（D-089 的直接上游）。**修法要求**（已派 subagent）：先读计划门判据与语义表派生处搞清 `access` 四个字面量各自意味着什么再决定改成哪个值，不凭猜；三个维度自洽（dry-run 触平台 → mock 列可替换；写路径提案创建步产物要人签字 → plan 列为真；`effects` 反映真实副作用）；改完 `node test/test-all.js` 必须 ALL PASS。**顺带核查要求**：`operations.json` 里还有没有别的 operation 同类"声明与实现矛盾"。 |
| **D-092（新）D 波开关退役的已知代价：委派中途崩溃失去一行 start 痕迹；`confirm_held` 成真平台专属态** | **接受（已记录代价）** | **位置**：`packages/agent/src/context.ts`（原 `delegation_gateway_state` 结构化日志，D 波 `3e5a36c` 整行删除）与 `proposal-flow.test.ts` / `turn-loop-write-chain.test.ts` 的 confirm_held 覆盖。**背景**：D 波退役 `FSHINE_PROPOSAL_VIA_GATEWAY` / `FSHINE_PROPOSAL_COMMIT` 后，写路径只剩一种形态。删除 `delegation_gateway_state` 的理由是该行唯一 payload `proposalGateway` 布尔退役后恒真、不再回答任何问题。**代价①（可观测性）**：委派**中途崩溃/挂死**的窗口原本有一行 start 痕迹（证明"这一回合确实进了委派、走到哪儿停的"），现在只剩 SQLite 里的 task 记录与回合级 `turn_span`。建成与拒绝两侧的事实面反而更强（拦截处必有 `tool_calls` 一行 `tool:'proposal_create'` 含拒绝原因；建成时有 `proposal_created` 事件 + `delegation_span` 的 `proposal_created` 结局），缺的只是"起了头但什么都没发生"那一窗口。**代价②（测试覆盖形态）**：`confirm_held`（确认收到但不写）从此是**真平台专属态**，mock 下不可达——原先靠"关掉落账开关"在 mock e2e 里造出这一态的用例改写为"mock 之下落账恒放行"；fail-closed 的判据改由 `proposal-flow.test.ts` 的 `proposalCommitEnabled=false` 一支 + `isCommitEnabled` 语义组共同钉住（组成链条：真平台无 `FSHINE_REAL_COMMIT` ⇒ `isCommitEnabled` 假 ⇒ `proposalCommitEnabled` 假 ⇒ `confirm_held` + 零写入）。**为什么接受而不是留开关**：留两个恒开开关的两种"关"形态都是静默半成品——不拦截 = 平台建了提案而用户拿不到确认入口；不接线 = 用户以为确认即录入而实际不写。半成品比没有开关更危险，它让"看起来配好了"和"真的能跑"无法区分。**安全判据未削弱**：`isCommitEnabled` 一字未动且是唯一闸门，真平台无 `FSHINE_REAL_COMMIT` 仍是确定性拒绝 + 零写入；变异验证（恒 false）→ 7 条红。**若将来要补代价①**：给委派入口补一行不带布尔的事实痕迹（如 `delegation_started` + taskId），或从既有 `turn_span`/task 记录派生"起了头无结局"的查询。 |
| **D-067 附条 · 新 confabulation 实例（2026-10-13）：「本轮可向平台发起的操作申请已用尽」** | **待办（watch，归 D-067）** | **实例**：真模型 + mock 平台 + 写开放，worker 终稿说「本轮可向平台发起的**操作申请已用尽**，无法再提交这一步」。核实：host（`pi-coding-driver.ts` 只有 `MAX_DECLINED_PLANS_PER_TASK` 计划拒绝计数）、平台（`operations.json` 无调用配额列）、SKILL（`.agents/skills-serve/17dz-bookkeeping-prepare/SKILL.md` 无次数/上限语）**三处都不存在这种配额**。真实原因是它撞了 `DECLINED_PLAN_LIMIT`，而 `context.ts:1358` 的提示词明令"内部控制不上屏……因内部限制停顿时只说事实与出路，不说机制"——于是它把内部限制译成了一句虚构的资源配额。**意义**：这是 D-067 预言的新形态（换个说法机械防不住），且它与 D-089 是同一事故的两面——D-089 修好（消息点名操作、可 self-correct）后，worker 更可能根本走不到"需要解释为什么停"这一步。**机械锁**：无新增（D-067 本就是 watch 项，不设机械关闭判据）；本条登记真实出处供指纹表/词表复核。 |
| **D-091（新）17dz `voucher.validate` 声明错在反方向：纯离线脚本声明 `read`，mock 换不掉、fail-closed 门误报** | **已关（2026-10-14，17dz `963e088`）** | **位置**：`17dz-platform/src/voucher/operations.json` 的 `voucher.validate` 声明 `access: "read"` + `effects: ["read"]`；而实现 `src/voucher/scripts/validate-contract.js` 头部自述「凭证契约校验（**纯离线，无浏览器**）」，只 `require('node:fs')` + `../contract`（→ `contract.schema.json` + ajv + 算术）。`read` 在 `ACCESS_SEMANTICS`（`src/lib/operations.js:45-49`）里是 `{plan:true, confirm:false, mock:true}`。**根因**：与 D-090 同族但方向相反——D-090 是"宣称纯本地实则触平台"（危险方向），本条是"宣称触平台实则纯本地"。`mock:true` 让联调把它换成应答器，而应答器没有它的罐头回答。**三个后果**（D-090 修覆时顺带核查实证）：① `EXECUTION_EXECUTOR=mock` 下 `prepare src/voucher/scripts/validate-contract.js` → `OPERATION_NOT_MOCKED` exit 3，**`voucher.validate` 在 mock 联调里根本跑不了**（同形状的 `payroll.validate` 声明 scratch，同一环境 exit 0 正常输出）；② 非 mock 且无 `EXECUTION_ALLOW_REAL=1` → `REAL_EXECUTION_NOT_ALLOWED` exit 3，**为一个物理上碰不到平台的脚本要运维授权**（fail-closed 门误报）；③ `plan:true` 使 `EXECUTION_REQUIRE_PLAN=1` 时网关为一个离线校验索要 `EXECUTION_PLAN_ID`。**为什么是已知 bug 类的活实例**：`gateway.js:313-320` 的注释记过同一形态——2026-10-09 实证 worker 发 `prepare transform.py` 拿 exit 3、out/ 为空，根因是 mock 按"是否触平台"判，纯本地脚本也被换成应答器落到 fail-loud。当时修的是判据读语义表 `mock` 列，但**声明本身错了的那一行没被扫出来**。**为什么没顺手修**：这个假声明还被两处钉住——`test/test-gate.js:291-293`（"一个 scratch 纯本地、一个 read 触平台会话，语义正相反"）与 `docs/architecture.md` 同款措辞；改它 = 改计划门范围（scratch 的 plan=false），是**有意决策而非顺手改**。**建议波次**：与 D-090 同批的下一轮（17dz 声明审计批）。**闭环判据建议**：`access` 改 `scratch` + `effects` 改 `["local"]`，同步 `test-gate.js:291-293` 与 `docs/architecture.md` 那两处措辞；改后 mock 下 `prepare voucher.validate` exit 0 有输出、非 mock 无 `EXECUTION_ALLOW_REAL` 也 exit 0（不触平台不该要运维授权）、`EXECUTION_REQUIRE_PLAN=1` 不索要 `EXECUTION_PLAN_ID`。**顺带登记（D-090 核查 B/C 的阴性/轻微项）**：`voucher.fix-summary`/`gen-from-journal`/`create-assistant` 都是 `access:write` 且无 `writeFlag`（读作"总是写"）但各自有 dry-run 缺省 flag——因三者 `serve.prepare` 均为 false，读 `writeFlag` 的分支不可达，今天无行为后果；其余 10 个 read 类 voucher + 2 个 finance operation 的脚本都 require `lib/browser`/`lib/platform`（grep 实证触平台，声明准确）。**全仓扫下来，`voucher.proposal`（D-090，危险方向）与 `voucher.validate`（本条，反方向）是仅有的两处声明/实现矛盾。** **闭环（2026-10-14，17dz `963e088`）**：`access` 改 `scratch` + `effects` 改 `["local"]`（同仓同形状对照就是 `payroll.validate`），`serve` 三列 / `label` / `script` 不动；`test/test-gate.js:291-292` 与 `docs/architecture.md:245` 两处会变成假事实源的 prose 同批重写。三条判据：① `EXECUTION_EXECUTOR=mock` 下 `prepare src/voucher/scripts/validate-contract.js <契约>` exit 0 且信封 `{ok:true,…}`（改前 `OPERATION_NOT_MOCKED` exit 3）；② `EXECUTION_EXECUTOR=mock EXECUTION_SERVE=1 EXECUTION_REQUIRE_PLAN=1` 下同一条命令 exit 0，不再索要 `EXECUTION_PLAN_ID`；③ 「非 mock 无 `EXECUTION_ALLOW_REAL` 也 exit 0」**按类级单测钉住而非真跑**——`change-safety.md` §0 禁止任何不带 `EXECUTION_EXECUTOR=mock` 的 `bin/17dz` 调用，故该条由 `test-real-execution-gate.js` 新增的「从清单读 `voucher.validate` 的声明 → `touchesPlatformOf === false`」断言承担。17dz `npm test` ALL PASS + `lint:operations` passed。**变异验证**：access 改回 `read` → 3 条新断言全红 + mock 下 prepare 复现 `OPERATION_NOT_MOCKED` exit 3。**残留（登记不修）**：`src/execution/executor.js` 与 `proposal.js` 读 mock 时不看 `touchesPlatform` 列，`operation run voucher.validate` 在 mock 下仍会被换掉——非本条引入（`payroll.transform` 同状），属"mock 判据在 compat/proposal 两条路上与 gateway 不一致"的独立条目；`SCOPE_FORMS['voucher.validate']`（`plan.js`）随之不可达，与 `payroll.validate` 同状，无害。 |

## 补充记录（2026-10-14，实体门标定修复 D-085 / D-086 + 验收仪器 D-087 + 17dz 声明 D-091）

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-085 实体门 haystack 的条数窗口与单条截断** | **已关（`2e2a699`）** | 见上方主条目。两个上限一并删除（条数不设、单条保尾），覆盖判据 = 本任务迄今全部平台响应。**闭环判据的改写连同理由记在主条目里**：原字面「改为结构化实体集合」是可证的收窄，方向与修假拒相反。 |
| **D-086 被拒计划的原因文本回灌 haystack** | **已关（`7281daf`）** | 见上方主条目。按 `toolCallId` 身份排除宿主自拦；`isError` 与文案前缀两条替代方案都被单测钉住"不能用"。 |
| **D-087 acceptance 报告不 surfaced `tool_calls` 表** | **已关（`3beb3b5`）** | 见上方主条目。报告新增「计划门裁决 / 计划门拒绝明细」两节，`acceptance_case_done` 带 `planRejects` / `planDeclines`。 |
| **D-091 17dz `voucher.validate` 声明错在反方向** | **已关（17dz `963e088`）** | 见上方主条目。`read` → `scratch` + `effects` → `["local"]`，两条假事实源 prose 同批重写。 |
| **D-088 真模型不稳定抵达提案步** | **待办（前置已全部满足）** | 三个可修上游（D-084 / D-085 / D-089）与平台侧声明矛盾（D-090）均已关，D-086 额外堵上一条绕过路径。只剩"连续三轮真模型 + mock 平台"这一件事，按关账纪律不标已关。 |
| **D-093（新）实体门只管 `plan_submit`：token 经直连网关调用或 `ls` 列名进 haystack；e2e 副本结构上抓不到 D-085/D-086** | **待办** | **位置**：`packages/agent/src/pi-coding-driver.ts:912`（worker 工具面 = `read`/`ls`/`bash`/`write`/`edit`，**无 grep/find**）、`packages/agent/src/serve-gate.ts:780-786`（`read` 限知识面、`ls` 不限）、`tests/e2e/harness.ts:442-452`（实体门副本）。**根因（2026-10-14 现场核实，推翻了初登记时的说法）**：初版写的是「`write` 把 token 写进 `tmp/`，再 `grep`/`find`/`ls` 读回工具结果」——**这个部署里没有 grep/find 工具**，`ls` 也只列名字不列内容，`read` 被知识面白名单挡住读不到 `tmp/`。核实后真正剩下的两条路径是：① **`ls` 列名字**：worker 把 token 放进自己起的文件名（`tmp/<requestId>/<token>.json`），`ls` 一出它就进了 haystack（`ls` 刻意不限知识面，理由见 serve-gate 的 `LS_NOT_KNOWLEDGE_GATED`）；② **直连网关调用回显**（更宽的一条，且**先于本波存在**）：worker 直接发 `bin/17dz query … --query <token>`（不经计划门，serve-gate 不做实体来源校验），平台的响应/错误信封回显该 token，于是它成为"平台返回过的证据"，随后提交的计划就能带上它。**为什么这两条都不由本波堵**：① 要堵它就得给 `ls` 加实体判据，而 `ls` 的输出是文件名清单、不是领域实体，判据写不出来；② 要堵它就得把实体来源校验扩展到直连网关调用——那是"门该管多大范围"的设计问题（今天门只拦 `plan_submit`），不是标定误差，且意味着每次只读查询都要过一次逐字包含判定。**与 D-086 的关系**：同族（"让一个字符串进入 haystack"的不同手法），但 D-086 那条是宿主自己把证据递过去，已修；这两条是"token 先到了平台/文件系统、再被当成证据"，修法完全不同。**附条（e2e 保真缺口）**：`harness.ts:442-452` 的副本只把 `platformOutputs`（真实平台 CLI 输出）喂进 `platformResponses`——它**从来没有** 20 条窗口、也从来不见宿主拦截文本，所以 D-085 与 D-086 它**结构上抓不到**。本波因此没有新增 e2e 用例（新增只会是"看起来在测"的假覆盖）；补法是把副本指向生产收集器（`platform-entities.ts` 的两个通道），独立一件事。**闭环判据建议**：① 要么把实体来源校验扩展到直连网关调用（先回答"门该管多大范围"），要么在台账明确记成"门的已知边界"并接受；② e2e 副本改吃 `transcriptPlatformSources` / `createTaskPlatformRecorder`，补一条"宿主拦截文本不进 haystack"的端到端用例。 |
| **D-097（新）worker 满足 SKILL 第 3 步的**措辞**却跳过第 1–2 步：产出"确认后由系统执行录入"这句话而从未创建提案** | **已关（2026-10-14）** | **位置**：17dz `.agents/skills-serve/17dz-bookkeeping-prepare/SKILL.md` 的「提案输出格式 → 现行形态」第 1–3 步。**实证**：2026-10-14 连续三轮复跑的轮②（`acceptance-report-202610140911.md`）。宿主给出正确的点名指令（`不该放进计划的是：voucher.proposal。请…改为直接调用`，D-096 修复生效），worker 照办把 `voucher.proposal` 移出计划、跑完全部只读核实（账套/科目/辅助核算/历史凭证，行为优秀），**然后停在下一次交互**，终稿写"确认后由系统执行录入"——而审计库里 `proposal_create` 行 **0 条**，`tmp/<requestId>/proposal.json` 从未落盘。**根因（SKILL 措辞的歧义）**：第 3 步「最后一条消息：把平台返回的摘要文本**原样**转给用户，并说明"确认后由系统执行录入"」是一条**独立成句的指令**，没有显式声明它以前两步成功为条件。模型于是满足了它的字面（说出那句话）而跳过了它的前提（真有一个提案）。这句话恰好又是用户可见的承诺，所以 Failure 是静默的：用户以为只差一次确认，实际什么都没有。**与 D-075 的关系**：同一条事故形状（T7："走完录入准备、承诺即可产出提案却永不抵达提案步"），但 D-075 的守门只覆盖"写未开放"（计划扫描兜底），**写开放时没有对应的一道**——宿主不该靠嗅探 worker 文本来补（L4），所以修法落在执行层的 SKILL 与提示词上。**修法建议（未做，需用户裁决是否动 17dz SKILL）**：把第 3 步改成显式条件句——"只有第 1–2 步真的拿到了提案号，才允许在最后一条消息里写'确认后由系统执行录入'；没有提案号时不许写这句话，改为如实说明卡在哪一步"。**闭环判据建议**：SKILL 文案改后连续三轮复跑里，"终稿含该承诺句"与"审计库有 `proposal_create` 行"两条**同时为真**（现在的反例是一真一假）。 **修法已落地（2026-10-14，17dz `6b7ea09`）**：SKILL 第 3 步改成显式条件句——「只有第 2 步真的拿到了提案号，才进入本条…**没有提案号时不许写"确认后由系统执行录入"这句话**——它是一句用户可见的承诺，写了就有人以为只差一次确认，而实际什么都没有（2026-10-14 实测：worker 做完全部核实、说出这句话，却从未调过第 2 步，`proposal_create` 审计行 0 条）。没有提案号时改为如实说明卡在哪一步、缺什么、建议用户提供什么。」**这是修正一段含混的既有文本，不是新增控制**（那句话本来就在 SKILL 里，改的是它的前提）；按 architecture-laws 的纪律**不建宿主侧守门**（"写了意图但没实现"的不变量 + 重试循环会为抓一个 2/3 概率成功的模型行为新增一套机制，且在"worker 合理地先问用户"的回合误触；宿主也不该靠嗅探 worker 文本来补，L4）。**为何仍不标已关**：机械闭环判据是"终稿含该承诺句"与"审计库有 `proposal_create` 行"两条**同时为真**，这需要复跑才能证——现在的证据只有反例（一真一假）和修好的文本，没有正例。17dz `npm test` ALL PASS + `lint:operations` passed（skills-serve canary 对 prepare 技能的三条断言一条未动）。 **闭环（2026-10-14，17dz `6b7ea09` 修后连续三轮）**：机械判据"终稿含该承诺句"与"审计库有 `proposal_create` 行"两条**同时为真**，三轮全部满足——① 承诺句 4 次 / `proposal_create` 1 行；② 7 次 / 1 行；③ 4 次 / 1 行。修法是把 SKILL 第 3 步改成显式条件句（只有第 2 步真的拿到提案号才进入本条；没有提案号时不许写那句话，改为如实说明卡在哪一步）。**定性留档**：这是修正一段含混的既有文本，不是新增控制；按 architecture-laws 的纪律未建宿主侧守门（不靠嗅探 worker 文本补，L4）。 |
| **D-096（新）计划门把"写类进不了计划"假称成"写入权限未开放"：假归因致用户被指去要一个他已经有的权限** | **已关（2026-10-14，`4aeab16`）** | **位置**：`packages/agent/src/pi-coding-driver.ts` 的 `planNotReadOnlyCode` / `nonPlannableOperations` / `planNotReadOnlyReason`，调用点在 evaluate 失败分支的 `PLAN_OPERATION_NOT_READ_ONLY` 兜底。**根因**：平台按"是不是只读"拒计划（写类的放行路径是确认码 + commit token，`planAccessAllows = plan && !confirm` 永远为假，它根本不该进计划）。宿主把这张拒绝映射成"该说哪句话"时只看语义表的 `confirm` 列、**没看部署能力**：`needsConfirm` 为真就说 `WRITE_NOT_ENABLED`，不论 write 开没开；同时点名判据只读 `plan` 一列（`plan === false`），漏掉写类（`write` ⇒ `plan:true, confirm:true`）⇒ 点名名单为空 ⇒ 退回零名单措辞"该调用不需要计划"而不说是哪一个（D-089 的死因形状）。**实证**：2026-10-14 为跑 D-088 把本地主体 `capabilities` 开到 `["read","write"]` 后复跑 5.x，5.1 报告里两次 `PLAN STOP 当前未开放写入权限`，而 `plan_write_not_enabled` 事件一次都没出现（说明不来自 D-075 前置扫描）、库里 `principal_scopes.capabilities` 明明是 `["read","write"]`。worker 把这句话原样转达给用户："平台目前不接受…返回原因是写入权限未开放（建议联系管理员开通写入权限）…未做任何重试或变通"——**用户被指去找管理员要一个他已经有的权限，然后这一轮放弃**。假归因比不点名更糟：不点名只是没法自愈，假归因让用户做出错误动作。**修法**（只改"该说哪句话"，不动任何门禁判定）：① 分流增补 `capabilities` 参数，只有 `needsConfirm && !capabilities.includes('write')` 才说 `WRITE_NOT_ENABLED`；缺省不传按只读判（与 `planWriteClosed` 的"空 capabilities 视为只读"同约定），既有判定一字不变。② 点名判据从 `plan === false` 改成平台真判据 `!(plan && !confirm)`，写类因此点得出名字。**写关闭那条路没变**：capabilities 缺省只读时 D-075 前置扫描在 evaluate 之前就拦下（平台门一次都不咨询），给出的仍是同一句 `WRITE_NOT_ENABLED`——两条路在"没开放写"上收敛。**机械锁**：`pi-coding-driver.test.ts` 三条（写开放点名 / 写关闭仍归权限且走前置扫描 / 混合场景两个都点名）+ `pi-coding-driver-plan-audit.test.ts` 一条（审计要求不变：每个出口仍落一行）+ e2e `turn-loop-plan-gate-boundaries.test.ts` A5 闸③ 一条。**变异验证**：分流不再看 capabilities → 6 条红；点名判据退回只读 plan 列 → 6 条红。 |
| **D-102（新）平台 correctForm 数据含裸 operation 名，经宿主 L2 原样渲染后进用户可见回复；e2e 两条零命中断言因此改为期望命中** | **已关（2026-10-15，17dz `151a6fc` + fshine `e07e1cc`）** | **位置**：17dz `src/lib/error-codes.js:66`（`ACCOUNT_SET_NOT_FOUND.correctForm = "先用 search-account-sets 搜出平台规范名再查，不猜简称"`）、`:36`（同类）；宿主侧渲染点 `error-codes.ts` 的 `correctForm` 槽位；受影响断言 `tests/e2e/turn-loop-clarification.test.ts:129`（C3）与 `tests/e2e/turn-loop-concurrent.test.ts:339`（7.3）。**实证**：D-098 修好尺子后那两条断言转红——回复 = 宿主模板 + 平台 correctForm 原样，而 correctForm 里就有 `search-account-sets`。A4 探针回复「先用 search-account-sets 搜出平台规范名再查，不猜简称」的前半段正是它。**定性**：这段执行语言**不是模型说漏嘴**，是平台数据经宿主按 L2 原样渲染（宿主不镜像措辞，所以改不在宿主）。但**用户是会计，不是工程师**——让终端用户"先用 search-account-sets 搜"是把内部协议文本怼到非技术用户眼前，与 2026-09-27 Stage 3 事故同一族，只是源头从模型换成平台数据。**D-098 关账时的处置（留档）**：那两条断言从 `toEqual([])` 改为 `toEqual(['operation 名'])` 并写清来源与"该改的是平台侧"。**必须说清代价**：改后那两处不再守任何东西——它们从"守卫"退化成了"现状快照"。反向断言一条没删、注释写明清白，所以不是静默放宽，但也不是无事发生。**修法建议（未做，跨仓需裁决）**：17dz 把这两条 correctForm 改成不给用户看 operation 名——例如「请提供账套的规范全称（可与平台目录核对后再试）」；改后宿主侧两条断言可回到 `toEqual([])`。**闭环判据建议**：17dz 侧改完 + 宿主两条断言回到 `toEqual([])` 且全绿 + 探针复跑 A4 回复不再含裸 operation 名。 **闭环（2026-10-15）**：平台侧两条 correctForm 改成不给终端用户看 operation 名但仍可行动（`ACCOUNT_SET_NOT_FOUND` → 「请提供账套的规范全称（可与平台账套目录核对后再试），不要用简称」；`QUERY_REQUIRED` → 「请补充账套名称关键词（如「幻辰」）；账套请用平台规范全称，不要用简称」）；宿主侧两条断言回到 `toEqual([])`，**守卫恢复**——D-098 期间它们从"守卫"退化成"现状快照"，现在重新守"宿主组装出的用户回复里没有执行语言"。尺子本身没动（`runtime.ts` 的 golden 仍钉裸名原文，形态再出现仍会被抓）。worker 侧的账套解析口径没丢——`search-account-sets` 的权威定义本就在 17dz-query/SKILL.md，不靠用户可见消息教学。**查证"是否刻意要让用户看 operation 名"：没有**。17dz 的 test-error-codes 只验三要素结构、`src/lib/README.md` 只说 correctForm 随信封出去且宿主不镜像词表、`docs/architecture.md` 只给一句话含义 + 指针；反而不利于硬改的证据有一条——fshine `error-codes.ts:222-227` 的注释早就指出平台给 AMBIGUOUS_SELECTION 的 correctForm 是"给解析方的行动规则，不是给用户的问句，渲染它只会把内部规则念给用户听"，即宿主侧早已承认这类受众问题。**未做的一部分（另登记 D-103）**：平台错误码表里还有别的 correctForm 带执行层标识（`SUBJECT_NOT_FOUND`/`INVALID_SUBJECT_CODE` 的 `subject-list 可查`、`UNKNOWN_DOMAIN` 的 `以 bin/17dz operation list 输出为准`、plan/proposal 一族的 schema 路径）。它们不走用户可见的澄清槽位，故本次按"只改这两条"没碰。**闭环判据的第三分项未验**：「探针复跑 A4 回复不再含裸 operation 名」需要真模型探针，不在本轮 mock 范围内——已用"两条 e2e 断言回到零命中"这一分项替代证明（同一把尺、同一条渲染路径）。 |
| **D-099（新）`declinedPlans` 数的是"提交次数"不是"连续拒绝次数"：合法方案在实体校验前被终局挡掉，且消息谎报拒绝数** | **已关（2026-10-15，`385e5cd`）** | **位置**：`packages/agent/src/pi-coding-driver.ts:859`（声明）、`:1194`（`declinedPlans += 1`）、`:1200`（消息）。**根因（代码已核实）**：`+=` 位于写关闭前置扫描之后、实体校验之前，对**每一跳通过形状解析与写关闭检查的提交**都 +1——`PLAN ACTIVE`（成功激活）与 `PLAN PAUSED`（CLI 失败）同样计数；全文只有声明/自增/读取三处，**成功后不归零**，只在每次委派时重置。而消息写死「已被连续拒绝 N 次」。**实证（2026-10-15 acceptance `--only=8.1,8.2,9.1,9.2,9.3,9.4`，报告 `acceptance-report-202610150128.md`）**：8.1 的终局 `PLAN STOP：DECLINED_PLAN_LIMIT（已被连续拒绝 6 次）` 落在第 6 次提交上，而那一次是单独的 `voucher.query-saved 幻辰财税 202606`——前 5 次里 3 次是 `active`、1 次 `paused`、1 次 declined。`202606` 此时**已经**由平台 subject-list 响应确立（终稿引用了「202606 期间借方 61,000」），于是一个本来可能合法的方案**没走到实体校验就被终局挡掉**，worker 只能回头向用户要 12 个月码。9.4 委派②同型：STOP 前的 5 次全是 active、零拒绝。**与 D-085 的关系**：同一条终局链（假拒 → 重试 → `DECLINED_PLAN_LIMIT` → worker 放弃）的**第二条入口**。D-085 修的是"实体该放行却被拒"，本条是"根本没走到实体校验就被计数耗光"——所以 D-085 关账后这条族并没有关干净。**修法候选（未做，需裁决）**：① 最小改——成功激活时 `declinedPlans = 0`（恢复"连续"语义，行为只放松不收紧）；② 更准——只在真正返回 decline 的分支上自增（形状类拒绝目前在 `:1026` 提前 return，本就不进计数器，要把实体越权/写关闭两支也纳入）；③ 只修消息不改行为——把「已被连续拒绝 N 次」改成「本回合第 N 次提交方案」（诚实但保留误挡）。**闭环判据建议**：造一个"3 次 active + 1 次合法提交"的用例，断言第 4 次不被终局挡掉；并断言消息里的数字与真实拒绝次数一致。 **闭环（2026-10-15，`385e5cd`）**：① 唯一归零点放在 `PLAN ACTIVE` 那一支内——熔断器只放松在确凿成功上，不放松到"没报错就算"（实体越权 / CLI 失败 / 平台拒绝照旧计数，那一维没放松）；熔断阈值 `> 5` 一字未动。③ 消息经 `messageFor(code, actual)` 参数化改为「连续 N 次提交方案均未激活」，措辞仍收口在 `error-codes.ts` 表内（三要素不变），不在调用点拼句。码名 `DECLINED_PLAN_LIMIT` 沿用（`scripts/plan-reject-report.ts` 的分类与历史 `tool_calls` 行认它，改名会让历史库对不上）。**拒绝做②并留档理由**：②（只在真 decline 分支自增）会把 `PLAN PAUSED`（CLI 失败）与平台 `PLAN STOP` 从计数里摘掉，而那正是熔断器当初要治的那一维（原注释记着"实测 D1 类请求空转 5 分钟后崩溃"）——② 在一个真实存在的空转形状上放松熔断器，与"放松必须有确凿理由"相冲。**机械锁**：`pi-coding-driver.test.ts` 两条新用例（8.1 原形：3 active + 1 paused + 1 declined 之后第 6 跳合法方案仍能激活、`evaluates === 5` 证明真走到平台；混合历史下逐字钉 `messageFor(DECLINED_PLAN_LIMIT, "连续 6 次提交方案均未激活")` 且整条消息**不含"拒绝"**）+ `plan-audit` 那条收紧为逐字 + e2e A4 golden 同步。**变异验证**：全撤 → 恰 3 条红（2 条新用例 + plan-audit 消息断言）、其余 66 条不受影响；只撤消息 → 恰 2 条消息断言红、行为用例仍绿（①③ 各自独立成立）。**如实登记的残余代价**：① 之后，"从不激活但连提 6 次以上"的 worker（例如 CLI 反复失败）仍会被终局挡掉。这是熔断器的设计行为（治 D1 类空转），但确实是 8.1 那条"合法方案没走到实体校验"的最后一处残余——触发条件从"3 次成功 + 1 次暂停"收紧成"连续 6 次都没激活成"。 |
| **D-100（新）验收仪器 `delegated`/`taskId`/`子 Agent 最终输出` 假阳性：取会话最新一行而非本回合** | **待办** | **位置**：`scripts/acceptance.ts` 的 `taskRow` 查询（`WHERE parent_session_id = ? ORDER BY rowid DESC LIMIT 1`）与 `:453` 的 `delegated: steps.includes(PLAN_SUBMIT_STEP) || Boolean(taskRow)`。**根因**：取的是"本会话 `platform_tasks` 最新一行"，不是"本回合新建的任务"。**实证（同一次 acceptance）**：9.3 被路由为 `kind:conversation`（无 `delegation_span`、`planRejects: 0`、进度事件「无」），却报 `delegated: true`，且 `taskId`（`task_f892495b`）与「子 Agent 最终输出」都是上一回合 9.2 的。**为什么是本波的账**：`delegated` / `planRejects` / `planDeclines` 这套计数器是 E3（D-087）刚加的仪器，假阳性会直接污染它要服务的那件事——"这一回合有没有走到计划门、被拒了几次"。**2026-10-15 更正（原登记里有一句错话）**：原写「`platform_tasks` 与 `agent_requests` 的关联已在库里」——**错，没有这个关联**。已核实 schema：`platform_tasks` 只有 `parent_session_id`、**没有 `request_id`**；`agent_requests` 只有 `request_id`、**没有 `task_id`**；`delegation_span` 事件（同时带 requestId 与 taskId）只走 `console.info`、**不落 `conversation_events`**。所以"按本回合反查"这条路今天不存在。**两个候选与各自的代价（需裁决，故未派工）**：① **加 `platform_tasks.request_id` 列**（走本仓既有的"缺列即补"前向迁移模式，`change_intents` 有先例），委派时由 runtime 填（它手里同时有 `ctx.trusted.requestId` 与 `taskId`）——这是**正确**修法，但是为了一个诊断仪器的准确性给核心表加永久 schema 面；② **只用 `steps.includes(PLAN_SUBMIT_STEP)` 判 `delegated`**，无委派就不填 `taskId`/`subagentFinalText`——一行改完、零 schema 代价，且严格优于现状（现状是假阳性；它最多在"委派但零计划提交"的形状上给出假阴性，而那种形状今天本来也只能从 `taskRow` 拿到**上一回合的陈旧任务**）。**我的判断：② 更划算**——诊断报告的信号不该由核心 schema 为它背书；但它确实是用一种不精确换另一种不精确，所以登记待裁决而不是直接改。**闭环判据建议**：造一个"会话内先委派、再闲聊"的用例，断言第二回合 `delegated: false`、`taskId: 无`、`子 Agent 最终输出: 无`。 |
| **D-101（新）会话级实体底账只记最后一版计划的 calls：跨任务实体记忆覆盖缺口** | **待办** | **位置**：`platform_tasks.calls` 的写入处（一个任务只存一份 calls 快照，后者覆盖前者）。**实证（同一次 acceptance）**：9.2 的任务 `task_f892495b` 只存了 `finance.query-receivables --query 幻辰实业有限公司 --subject-code 1122`，而 9.2 实际还激活并执行过 `--query 幻辰财税`（门裁决 #41 为 active、进度事件有「正在查应收账款余额『幻辰财税』·1122」、终稿报了 86,000）。于是 `幻辰财税` 不在 sessionEntities 来源 A 里，9.4 那 5 次对它拒得**符合门的四来源契约**——但用户可见效果是：9.4 终稿说「这次以该名称发起的查询未能确认账套」，而系统一个回合前才亲自查到过它。**与 D-085/D-093 的关系**：D-085 修的是"任务内 haystack 覆盖"，D-093 登记的是"门只管 plan_submit"，本条是第三种——**跨任务的实体记忆被覆盖**。任务内是work的（9.2 的 `幻辰实业有限公司` 方案因名字在平台响应里而通过）。**修法建议（未做）**：`platform_tasks.calls` 改为追加式（一任务多份快照，或单列一张 call 快照表），来源 A 的提取随之改读全量。**闭环判据建议**：造一个"同任务两次激活不同实体、下一回合只用其中一个"的用例，断言两者都在 sessionEntities 里。 |
| **D-104（新）律法/台账的可判主张是散文，随代码演进静默腐烂（2026-10-16 对账实证四起：工具面头注释两度未跟、runtime.ts:1539 指向拆分前文件、runtime.ts:1260 实为 1169、context.ts:360 指向已删违例）** | **部分落地（2026-10-16，`packages/agent/docs-reality.test.ts` + architecture-laws 执行纪律 4）** | **机制**：可判主张只许三形态（grep 谓词 / 测试断言 / 明文软提示）；引用用符号名禁行号；关账与律法「当前违例」节同 commit 更新；docs-reality 双向断言（已关判据保持 + 防御排除在场 + 工具面双写锚点）。**残余（本条保持开放）**：① 存量散文引用清理——laws/ledger 里既有 `.ts:行号` 引用改符号名（量大，机械可做，未做）；② 「当前违例在场性」断言逐条补齐——在册当前违例（D-016/D-031/D-066/D-104 本条等）尚无在场性谓词，登记新违例时逐条加；③ L7 打分器（D-060）落成后，探针分数对台账判据的反向核对 |
| **D-103（新）平台错误码表里还有若干 correctForm 带执行层标识；受众划分未定，故不知哪些该改** | **待办（跨仓）** | **位置**：17dz `src/lib/error-codes.js` 里除已改两条外的若干条目——`SUBJECT_NOT_FOUND` / `INVALID_SUBJECT_CODE`（correctForm 含 `subject-list 可查`）、`UNKNOWN_DOMAIN`（含 `以 bin/17dz operation list 输出为准`）、plan/proposal 一族（含 `src/execution/plan-schema.json`、`src/voucher/proposal.schema.json` 路径）。**为什么不顺手改**：它们不走用户可见的澄清槽位——宿主 `SELECTION_CLARIFICATION_TEMPLATES` 只登记 `ACCOUNT_SET_NOT_FOUND` / `ACCOUNT_SET_AMBIGUOUS` 两个码，这些主要到 worker/调用方手里。给 worker 看 operation 名是**合理的**（它本来就要调那个 operation），所以统一改成"不含 operation 名"会是过度收紧。**真正未解的问题**：**哪些 correctForm 的受众是终端用户、哪些是调用方/worker**，没有一份划分。D-102 是撞到一条（它经澄清槽位上屏）才发现的；在划分存在之前，每一条都只能是"撞到再改"，撞不到的那些会一直带着执行层标识躺在表里。**修法建议**：在 17dz 的错误码表给每条 correctForm 标一个受众列（`user` / `caller`），或至少在表头注释里写清划分原则；宿主侧 `SELECTION_CLARIFICATION_TEMPLATES` 的登记即成为"受众 = user"的机械判据（现在它是隐式的）。**闭环判据建议**：每条 correctForm 都有明确受众标注；宿主渲染用户可见槽位时，若平台数据里出现执行层标识（operation 名 / 脚本路径 / schema 路径），指纹尺报得出——即 D-102 那两条断言从"个别回到零命中"变成"一类有守卫"。 |
| **D-098（新）执行语言指纹尺有两个盲区：漏掉裸 operation 名与小写错误码，"零泄漏"结论只覆盖了两类形态** | **已关（2026-10-15，`4753114`）** **位置**：`packages/agent/src/runtime.ts:119-129` 的 `EXECUTION_LANGUAGE_FINGERPRINTS`。**两个盲区（2026-10-14 真实模型探针实证，正则已逐条核实）**：① `operation 名` 那条的模式要求**至少一个点**（`(?:\.[a-z][a-z0-9-]*)+`），所以裸名 `search-account-sets` 不命中，只有点分的 `finance.search-account-sets` 才命中；② `错误码` 那条要求**全大写 + 下划线**（`\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b`），所以小写 `not_found` 不命中，只有 `PERIOD_NO_DATA` 这类才命中。**实证（本轮探针 `.runtime/probe-fshine-probe-V0O1w9.json`）**：A4 第 1 轮回复「先用 search-account-sets 搜出平台规范名再查，不猜简称」；B1 第 4 轮回复「平台返回 not_found：期间 202609 在账套「新兴五金」科目 1122 下无余额数据」。**两条尺子自己都没报**，所以 A4/B1 的 ⚠ 都不是因为它——泄漏是静默穿过守卫的。**不是本次回归**：独立扫 60 个历史 probe 文件、2174 个字符串节点，两类形态分别出现在 53 / 35 个节点里（分布在 30 / 21 个文件）；subagent 侧口径为 98 条回复含裸名、33 条含小写码（计数方法不同，量级一致）。**后果**：过去所有"执行语言指纹零泄漏"的结论**只覆盖点分 operation 名与全大写错误码这两类**，另外两类形态从未被守过——L3 的机械守卫在这里是半聋的。**修法建议（未做）**：① operation 名那条加一条"含连字符、且不是点分形态"的判据，或直接把 `PLATFORM_OPERATIONS`（platform-contract.ts:41）里的真名集合作为白名单反面用——宿主本来就持这张表，不需要新真相源；② 错误码那条放宽到 `\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b`（大小写都收），平台错误码表里两类大小写形态都有。**闭环判据建议**：用本轮这两条回复做 golden，`executionLanguageFingerprints` 对它们各返回至少一个 label；且历史 60 个 probe 里两类形态的节点数从"静默穿过"变成"被报出"。 **闭环（2026-10-15，`4753114`）**：尺子两类盲区都收了——① operation 名在点分形状之外兼收 `PLATFORM_OPERATIONS` 的真名集合（含去命名空间前缀的裸名），宿主本来就持这张表，**不新立第二份真相源**；② 错误码大小写都收，小写支只收纯字母段（`not_found`/`needs_input`），含数字/连字符的串归泄漏基线的 taskId 判据守（塞进来会误伤 id 家族，e2e 污染塑形 ⑤ 的零命中断言会红）。不削弱现有判据：点分名/全大写码/脚本路径/JSON/内部控制词五类各留一条断言。新增 golden 用探针两条实测原文钉住。`runtime.ts` 行数仍 1221（架构预算只减不增，靠压缩 prose 腾出，没上移常数）；leak-lint 4/4 没碰白名单。`npm test` 1270 全绿（1268→1270）。**变异验证**：错误码改回只认大写 / operation 名改回只读点分 → 各自新 golden 红、旧断言不受影响。 **连带发现并同批处理的（重要，单独登记 D-102）**：尺子修好后 tests/e2e 两条"宿主组装澄清回复指纹零命中"的断言转红——根因不是模型泄漏，而是**平台 correctForm 数据里就含裸 operation 名**，宿主按 L2 原样渲染。那两条断言因此从 `toEqual([])` 改为 `toEqual(['operation 名'])` 并写清来源；**这不是静默放宽**（反向断言一条没删、注释写明清白），但它确实意味着那两处不再守任何东西，故按 D-102 单独登记。 |
| **D-095（新）真模型两例新观察到的失效：worker 发明不存在的 operation；计划 JSON 形状不合法** | **待办（watch）** | **位置**：首轮真模型基线（2026-10-14，`data/acceptance-report-202610140425.md`，`--only=5.1,5.1b,5.2,5.3,5.4`，mock 执行器）。**实例①**：5.1 与 5.3 里 worker 各发了一次 `operation list` / `operation.list`——平台上**没有**这个 operation（`bin/17dz operation list --json` 是宿主侧的清单查询命令，不是 serve 法域里可调的 operation），平台回 `PLAN_REFUSE UNKNOWN_OPERATION`，两次都以 `PLAN PAUSED` 收场，各烧掉一轮。**实例②**：5.3 里两次 `PLAN_JSON_PARSE: No number after minus sign in JSON at position 1`——方案 JSON 形状不合法（以 `-` 开头），被宿主确定性拒。**为什么登记而不当场修**：两例都是模型侧形状问题，不是宿主判据错——拒绝本身正确且可行动（三要素消息点名了正确形态），`MAX_DECLINED_PLANS_PER_TASK` 也已把空转收住。修法候选（都未做）：① worker 提示词 / 业务 skill 里点明「清单查询是宿主侧命令，不是 operation」（提示词层是软控制，且正是本仓要收敛的方向）；② 让平台对 `operation` 这个**命令族名**也给一条可行动的纠正（现在回的是 UNKNOWN_OPERATION，没告诉 worker「你要找的东西不是 operation」）。**与 D-067 附条的关系**：同族（模型在计划门交互上的真实方差），但那一族是「终稿谎报」，这两族是「调用形状错」，自愈路径不同，故单立条目。**复核条件**：连续三轮真模型复跑（D-088）时统计这两族命中率，稳定复现再排修法。 |
| **D-094（新）`change-safety.md` F2 的基线数字是 2026-09-29 的，与现状差 240 例** | **已关（本波 E5）** | F2 写死「`npm test` 987 例 / 78 文件」，而 C/D 波删了 legacy 落账执行器与其单测、又加了提案/写链路用例，实际基线早已漂移。E 波实测：改造前 **1228 例 / 90 文件**，E1/E2/E3 后 **1267 例 / 92 文件**。F2 那一行按实测改写，并在 E 波节里记下"基线随波次实测刷新，不是常数"。 |

## 补充记录（2026-10-16，L7 波：Tier-1 打分器落地 + D-060 关账）

change-safety §E 波末尾"下一处该投的是 L7"的兑现。七个 commit（`2d1ca5b`→`bb69066`）：探针四维归维 → 写链三指标机械提取 → 语料+评委 → 打分器+基线 → 三轮实测+两次标定 → 基线 v3 8/8 全绿。D-060 判据六项全部达成，L7 转为不变量（architecture-laws L7 节已同步改写）。npm test 1313 全绿（波前 1270）。

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-105（新）探针无后台持久化排干：`assembly.close()` 与 Context State 写入竞态，探针每轮 `conversation_log_update_failed`** | **待办（小）** | **位置**：`scripts/probe-real-agent.ts` 的 `boot()`/用例收尾（`await assembly.close()`）。**背景**：D-084④ 给 acceptance.ts 补了 `drainBackgroundPersistence`（判据 = `conversation_context_states.through_event_id` 覆盖最后事件 + `PRAGMA data_version` 静默地平线），探针没有——每回合结束 enqueue 的两个 fire-and-forget 队列（Context State 更新 + 记忆归并）撞上关库连接，L7 三轮每轮可见 `conversation_log_update_failed`（另一条 `context_semantic_extract_failed` 10s 超时是 `context-model.ts` `DEFAULT_TIMEOUT_MS` 的既有降级路径，非缺陷）。**影响**：只丢探针会话的 Context State 持久化（探针本来就不依赖它），**不影响分数**（dims/notes 全部来自内存中的回合结果）；但探针库不是干净的验收面，未来若有人拿探针库做事会被这条噪音绊倒。**修法**：把 `drainBackgroundPersistence` 从 acceptance.ts 提到共享模块，探针收尾调用。 |
| **模型侧观察项（L7 三轮实测沉淀，不劣化档入基线 v3）** | **watch（归 scores.jsonl 轨迹管）** | ① A2 范围渗入（§6 既有，轮①③）；② A2 not_found 轮执行语言泄漏（错误码形态，轮③——D-098 修尺后探针首次机械命中，先例形态见 D-098 的 B1 实证）；③ Y2 错误态佐证数字无所属（轮②，"金额有所属"校准不松）；④ Y2 歧义澄清缺问句（轮③）。呈现卫生是当前模型最不稳的维（三轮各在不同用例冒一次，4 次/21 用例轮）。 |

**本波最终账**：关 1 条（D-060），新登记 1 条（D-105 待办）+ 4 条模型侧观察项（watch，不设机械关闭判据，轨迹看 scores.jsonl）。L7 波结束。（编号注：本节初稿曾把探针排干竞态记为 D-104，与并行落地的 a19be5d「文档对账守卫」抢占的 D-104 撞号，顺延为 D-105。）

## 补充记录（2026-10-19，产物回传波：任务工作区纳入宿主编收集范围）

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-106（新）产物回传漏掉任务工作区：worker 唯一可写位置不在宿主收集范围，整轮回传只有文字，用户拿到的是服务器路径而不是文件** | **已关（2026-10-19，本波）** | **位置**：`apps/server/handler.ts` 的 `collectProducedFiles` 判据⑤（`tmp/task_<taskId>/` 一律跳过）与 `withFileReplies`。**实证（2026-10-19 16:24，幻骥达工资表任务）**：两个交付物 `整理好的2026年08月工资表.xlsx`（16:21:13）与 `幻骥达2026年08月个税申报.xlsx`（16:20:30）都落在 `17dz-platform/tmp/task_d42fffce-ce9a-4ff7-b648-b26e9131d9b1/`，同一时刻 `tmp/` 顶层零办公文件；终稿只有一段文字 + 服务器路径，上传从未发生（无 `wecom_file_fail` 事件——漏传是静默的，最贵的诊断成本在这里）。**根因**：判据⑤ 的前提「交付通道只有 tmp/ 顶层的平台执行器产物」在 serve-worker 架构下不成立——write 门把可写位置钉死在本轮工作区（`serve-gate.ts` 的 scratchDir 机械边界），域执行器的输出目录又由 worker 传参决定，交付物因此必然落进 `tmp/task_<id>/`；17dz payroll MECHANISMS 的旧约定（输出目录缺省＝当前目录、确保工作目录下有 tmp/）是 serve-worker 边界出现之前的遗留，与宿主规则对「产物落在哪」没有同一份权威约定。**修法**：`collectProducedFiles` 增加第三参 `workspaceDirs`（本会话任务工作区白名单，按 principal×会话从 `platform_tasks.listBySession` 取，`normalizeWorkspaceDirs` 只认 `tmp/task_<uuid>` 形态）；**未登记的工作区一律不收**——并发会话各有各的任务目录，认全会话的等于把 A 的文件回传给 B（数据泄漏，比漏传更严重）；其余判据一字未动（mtime ≥ 本轮委派开始、OFFICE_EXT、≤20MB、≤3 份、真实路径去重、解引用后仍在场内）。`platformTasks` 缺库（旧替身/精简部署）或查询抛错 → 退化为只扫 tmp/ 顶层，收集失败不炸回合。新增两个守夜事件：`produced_files_collected`（回传成败从不可观测变为可观测）、`platform_tasks_list_failed`。执行层同批对齐：17dz `src/payroll/MECHANISMS.md` 执行器节改写（输出目录显式传，工作区或 tmp/ 顶层均可、两个位置宿主办回传时都会扫）+ 新增「交付」节（用户可见回复不写服务器路径——用户在企微里，给 `tmp/task_<id>/…` 等于没给）。**为什么不只改 17dz 调用约定**：那会让回传重新依赖「模型记得按文档传参」，而本机制当初从「解析回复里的 `[发送文件]` 标记」改成宿主扫盘，理由正是产物落点不能依赖 worker 声明；扫「worker 唯一能写的位置」是同一哲学的延续，17dz 文档改动只作为第二层（防路径外泄 + 防换域再踩）。**机械锁**：`apps/server/handler.test.ts` 5 条收集用例（在册工作区收 / 未登记不收 / 工作区内老文件不收 / 工作区内非办公扩展名不收 / 白名单形态外入参忽略）+ 3 条端到端（在册即回传 / 缺库退化只回文字 / 别会话工作区不外发）。**变异验证**：删掉白名单判断（工作区一律跳回旧规则）→ 5 条收集用例红；把 `workspaceDirs` 传空数组（等价缺库退化之外的第三种漏收形态）→ 端到端「在册即回传」红。**闭环判据**：端到端三条（在册回传、未登记/别会话不外发、缺库退化不炸回合）+ `npm test` 全绿且用例数只增不减 + typecheck 0 错误 + e2e 无回归。**残余风险（登记，不阻塞关闭）**：办公格式的中间件不在任何黑名单上——worker 若把草稿 xlsx 或 transform 的 fallback 副本（`（自动）`）写进工作区，会一并回传（上限 3 份、mtime 新的在前，终态通常先于副本）。非办公中间件（`final_contract.json` / `*.py` / `*.md`）被 OFFICE_EXT 判据挡着——2026-10-19 事故原目录 16 个文件实证：过滤后恰剩两个交付物。宿主侧没有干净的收紧判据：按文件名黑名单（「（自动）」/draft/verify）是把业务命名知识搬进宿主（跨层泄漏），「让 worker 声明交付物」则是被毙掉的 `[发送文件]` 老路；真被噪音吵到，修法在执行层（中间产物写非办公扩展名）。 |

**本波最终账**：关 1 条（D-106）。基线实测：改造前 `npm test` 1409 全绿 / 111 文件 + typecheck 0 错误（2026-10-19 16:41 冻结）；改造后用例数只增不减（数字见 change-safety §8）。F1–F5 执行记录见 change-safety.md §8。

## 补充记录（2026-10-19，文件收据波：附件消息不再各占一个气泡）

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-107（新）文件消息各占一个气泡：N 个文件 + 1 条指令在会话里产出 N+1 条机器人消息且互相穿插** | **已关（2026-10-19，本波）** | **位置**：`packages/channel-wecom/src/adapter.ts` 的 dispatchMessage 附件分支（原对附件-only 也秒回 ack + 宿主回一条「已收到 X」）与 `apps/server/handler.ts` 的 `describeDeliveredFiles`。**实证（2026-10-19 用户贴出的真实企微会话）**：3 个 Excel + 「帮我做一下幻骥达的工资表给我」→ 4 条机器人气泡（3 条「已收到 <文件名>」+ 指令回合那一串帧），文件回执与回合帧按各自流的状态交错上屏。**根因（接口层，非文案层）**：企微流式回复按入站消息的 `req_id` 走——SDK 的 `reply()` 只转发 `frame.headers.req_id`，`streamId` 每次入站派发新生成（已核 `@wecom/aibot-node-sdk/dist/index.cjs.js:1006`），**一条用户消息就是一个气泡，跨消息合并在接口层不存在**。所以这不是「把文案写短点」能修的：只要每个文件消息都起流，就一定有 N 个气泡。**修法**：不为文件起气泡。① 附件-only 消息零帧（连秒回 ack 都不发——「收到,正在处理…」对只暂存不处理的消息是假承诺，且正常路径没有终帧来改写它，用户会看到一条永远转圈的「正在处理」；不起流就没有 spinner，空回复不再依赖「必须非空才收尾」）；② 收据两处承载、共用 `packages/contracts/src/channel.ts` 的 `formatFileReceipt` 一句（带指令的回合首帧 = 规则二披露帧；只发文件时渠道 2s 并窗到点补一条，同句 + 「，等待你的指令」）；③ 带正文的消息到达即撤并窗（那一回合的首帧会带同样收据，两条说同一件事才是冗余）；④ 附件回合不再发受理帧，心跳锚点从「受理帧」改为「帧流量计数」。**机械锁**：handler 5 条（附件回合首帧即收据 / 心跳不丢 / 心跳不添噪 / 披露走 notice 的通道归属 / notice 帧计流量）+ 5 条改写；adapter 8 条（零帧 / 孤儿收据 / 并窗合成一条 / 带正文取消 / 例外路径不等窗 / 首帧拒收降级 / stop 撤定时器 / 并窗长度）；e2e AT-4 突发形态（2 文件 + 1 指令连发：文件消息零帧、收据只出现一次、不带等待后缀）。**变异验证**：九条 adapter 侧 + 五条 handler 侧逐条确认对应用例转红后回滚复绿；其中两条第一版断言守不住（`stop()` 清定时器被 `this.client = null` 挡住、收据 degrade 因 mock 不拒收而不可观察），分别补 `vi.getTimerCount()` 与 `FakeSdkClient.failNextReply` 后才真变红。**未验项（登记，不阻塞关闭）**：「文件消息零帧」在真企微里的客户端表现（无气泡、无 spinner）与并窗 2s 的上界依据只能真机验，已写入 `docs/manual-test-wecom.md` §8.4。 |

**本波最终账**：关 1 条（D-107）。基线实测：改造前 `npm test` 1416 全绿 / 111 文件 + typecheck 0 错误（2026-10-19 17:16 冻结）；改造后用例数只增不减（1430 / 111，数字见 change-safety §9）。F1–F5 执行记录见 change-safety.md §9。

## 补充记录（2026-10-19，乱序到达波：附件 burst 稳才派单 + 迟到文件静默并窗）

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-108（新）附件 burst 乱序到达：回合可能在文件没到齐时就开跑，迟到文件还各占一个气泡且话术可能为假** | **已关（2026-10-19，本波）** | **位置**：`apps/server/handler.ts` 的入站防抖（固定睡眠）与附件-only 分支的迟到文件话术（`seenTextTurn`）。**触发（用户观察）**：「企业微信很奇怪，是乱序发送的，哪怕是在同一批消息里发送出去的」。同一份会话记录即可读出越界：3 个文件 + 1 条指令，第 1、2 个文件回执 16:10:48、指令回合「仍在处理中」16:10:50、第 3 个文件回执 16:10:51——跨度 3 秒且第三个文件落在回合开跑之后。**根因**：唯一的重排手段是固定 2s 防抖，且只作用于带正文的消息、只在前一条 2s 秒内到达时才等；它覆盖「指令之后 2s 内到达」，治不了「文件落在指令之后」——那时防抖早已睡完、`restoreAttachments` 已拍完快照，**那一轮拿着不完整的文件集算完**（2026-10-08 记录的「4 条消息同一秒内到达、指令那轮只带了 2 个、产出 3 人的不完整工资表」在乱序之下不是边缘而是常态）。`seenTextTurn` 那几句「上一条指令已经处理完了，请把指令再发一次」则在 runtime 之前置位，回合还在飞时就是假的。**修法**：① **R1 burst 稳定器** `waitForBurstSettle`——等的判据从「睡了多久」换成**静默**（一个窗口内没有新到达才算 burst 结束），最多 4 个窗口（`MAX_BURST_SETTLE_WINDOWS`，默认 8s）；安静的 burst 仍只等一个窗口（同旧延迟），冷启动「首条零防抖」不变（`burstInProgress` 门挡着它）。② **R2 迟到文件静默**——附件-only 分支不再回文本，`seenTextTurn` 三处一并删除；文件照原样进暂存池，收据与下一步由渠道并窗（「已收到 N 个文件：…，等待你的指令」）与下一条指令的回合首帧承担，收据永远只有 `contracts.formatFileReceipt` 一句。**为什么不交给 AI 汇报**（用户问过，留档）：收据是首帧，价值就在不等模型（`announceDeliveredFiles` 在所有 `runtime.handleTurn` 之前）；文件名与个数是传输事实，本仓在确认门已把「模型自报字段」当不可信输入；且通知送达是 fshine 通用机制而 AI/runtime 是执行层落地处。AI 的汇报本来就在同一个 req_id 的气泡里（收据是骨架、进度帧与终稿是血肉），迟到文件的汇报发生在下一条指令。**机械锁**：1 条改写（迟到文件不回气泡 + 「下一条指令带上」兜底）+ 3 条新增（稳定器跨固定窗仍赶上 / 上界 4 个窗口 / 静默满一个窗口就收工）+ 1 条加强（附件-only 不等防抖补上 burst 已开情形）。**变异验证**：五条全红——判据退回固定睡眠 / 去掉上界 / 附件-only 也参与等待 / 迟到文件又回气泡 / 新到达附件不进池子；其中「附件-only 不参与防抖」第一版**不红**（只发冷启动第一条时 `burstInProgress` 为假，判据是空的），补上 burst 已开时的第二段才真变红。**残余三项（登记，不阻塞关闭）**：① 冷启动且指令先到时稳定器不介入（修它等于推翻 2026-10-16 的首条零防抖）；② 稳定器是采样判据，文件恰在静默检查之后到达仍会漏，由 R2 兜底；③ 等待期间到达的文件可能被渠道并窗先补一条收据、回合首帧再说一遍（旧行为里就以相反顺序存在，本波未新增；彻底消除要跨层新协议面）。 |

**本波最终账**：关 1 条（D-108）。基线实测：改造前 `npm test` 1430 全绿 / 111 文件 + typecheck 0 错误（2026-10-19 17:16 冻结）；改造后用例数只增不减（1433 / 111，数字见 change-safety §10）。F1–F5 执行记录见 change-safety.md §10。

## 补充记录（2026-10-20，重复请求波：同文重发不再被判成对话 + 编排层不外泄服务器路径）

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-109（新）同文重发被判成对话枝：零执行、零产物，还把 7 小时前的结论重新排版给用户；编排层终稿顺带外泄服务器路径** | **已关（2026-10-20，本波）** | **位置**：`packages/agent/src/runtime.ts` 的 `route_current_turn` 申报分支（判据 → 新模块 `repeat-request.ts`）与出口处（判据 → 新模块 `reply-exit.ts` + `server-paths.ts`）。**触发（用户观察，2026-10-19 23:30 前后）**：「怎么还是没有发文件出来给我」。同一指令「帮我做一下幻骥达的工资表给我」在本会话发了三遍（16:06 带 1 个文件 / 16:10 带 3 个文件 / 23:30），16:10 那一遍真委派、两个交付物真落盘（16:20:30、16:21:13），23:30 那一遍回的是一段完整报告却**没有任何附件**，报告里还带着 `tmp/task_d42fffce-ce9a-4ff7-b648-b26e9131d9b1/`。**根因（两个，都不在 D-106 的回传机制里）**：① **申报层**——那一轮模型申报 `kind: conversation`，零 `delegation_span`、零平台执行，`collectProducedFiles` 按 `mtime ≥ 本轮委派开始` 正确地什么都没收到（23:30 之后 `17dz-platform/tmp` 下零办公文件被改动；两个交付物 7 小时前的 mtime 正是被这条判据挡住的）。转录里模型的 thinking 原话是「The user has re-asked the same question. The Sub Agent previously returned…」——**它明确认出是重复请求，还是选了对话枝**：历史答复在它眼里成了本轮授权的替代品。② **出口层**——终稿里的路径出自**编排模型**（它读转录里的历史结论，把上一轮的路径一起排版出来），而"用户可见回复不写服务器路径"这条约定只写在执行层 skill 里（D-106 配套），管不到编排模型这一侧。**修法**：① `repeat-request.ts`：从转录机械判定"这条同文请求本会话已经委派执行过"（逐轮配对 user 消息 ↔ route_current_turn 调用 ↔ 回执，剥掉宿主追加的附件路径后缀、折叠空白；回执是 `{"recorded":"conversation"}` 或该轮根本没申报 → 不算执行过）。命中则退回重填（与 `reviewRouteDeclaration` 同一族：不消耗用户轮次），**只退一次**后放行——这道尺是增强不是门，拦住不放用户连历史结论都看不到，比给一段可能过期的答复更糟。同时在 `route_current_turn` 的工具说明里写明"同文照样按新请求判 kind，申报 conversation 会被退回重填"。② `reply-exit.ts`（收走原本散在出口处的数值溯源探查）：终稿出口删掉服务器路径 token、保留其余内容。判据只有形状（`/` + POSIX 顶层路径名；`tmp/` 开头——后者是**宿主自己的**暂存命名，`sweepScratchDirs` 只扫这一种，不是执行层的业务字段），两条都锚在宿主持有的名字上，不把任何执行层目录约定搬进通用 runtime。**为什么是删路径而不是整段拦掉**：金额与结论来自 7 小时前那次真跑，整段替换会把有用内容一起扔掉；该丢的只是用户没法用的那一截。**机械锁**：`repeat-request.test.ts` 12 条（后缀剥离 / 空白折叠 / 四种命中与五种不命中 / 边界形状）+ `server-paths.test.ts` 8 条（工作区路径 / 绝对路径保留中文文件名 / 反引号行内代码 / 多条计数 / 零命中同引用 / 五类不误伤 / 形状表钉flag）+ `reply-exit.test.ts` 8 条（新模块：顺序固定、懒取证据、有执行跳过金额探查、两支同时命中）+ `runtime.test.ts` 5 条集成（RR1 退回后真委派且终稿是新文本 / RR2 只退一次后放行 / RR3 早前停在对话枝不退 / SP1 对话枝终稿删路径留内容 / SP2 委派枝终稿同样过尺）。**变异验证**：六条全红后回滚复绿——删退回（RR1/RR2 红）/ 对话枝回执识别不出来（5 条红）/ 不剥附件后缀（2 条红）/ 出口不删路径（3 条红）/ 相对路径支失效（4 条红）/ 去掉"只退一次"有界性（RR2 红）。**F6 探针**：工具说明变更是提示词级改动，改前改后同参数复跑（见 change-safety §11）。**未验项（登记，不阻塞关闭）**：① 模型被退回后仍坚持对话枝时放行，用户拿到的仍是历史结论（已在 RR2 钉住行为，日志留痕）；② 路径判据是形状匹配，未登记的绝对路径形态（如 `~/…`、相对 `./…`、Windows 盘符）漏网——漏报的路径仍在原地，用户至少看到内容，比误删结论字符好；③ 真机上"重复请求现在真的重新委派并回传文件"待用户复跑确认，已写入 `docs/manual-test-wecom.md` §8.6。 |

**本波最终账**：关 1 条（D-109）。基线实测：改造前 `npm test` 1433 全绿 / 111 文件 + typecheck 0 错误（2026-10-19 冻结，即 §10 乱序到达波收口数字）；改造后用例数只增不减（1466 / 114，数字见 change-safety §11）。F1–F7 执行记录见 change-safety.md §11。

## 补充记录（2026-10-20，收据复读波：附件收据只属于"文件刚到"那一轮）

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-110（新）附件收据每轮复读：与附件无关的后续回合也播"已收到 N 个文件：…"** | **已关（2026-10-20，本波）** | **位置**：`apps/server/handler.ts` 的 `announceDeliveredFiles`（收据帧）与 `selectDeliveredAttachments`（规则一交付集）。**触发（用户观察，2026-10-20 贴出的真实企微会话）**：3 个 Excel + 一条指令之后，用户又问「发一下 幻骥达2026年08月个税申报.xlsx 给我」，那一回合的气泡里又冒出「已收到 3 个文件：工资表2026-8月(1).xlsx、幻骥达26年8月社保实际缴费金额模版（幻企赢导入.xls、2026年8月工资（幻骥达）(1).xlsx」。用户原话：「怎么不管怎么样都会显示说收到附件？」**根因**：收据帧挂在「本轮交付集非空」上，而规则一在「没有新附件」时**沿用上次委派的交付集**（纠正/重试流），于是交付集每轮非空、收据每轮播。第 9 波把收据并到回合首帧之后，这条复读路径才浮到面上。**修法**：`selectDeliveredAttachments` 返回 `{files, fresh}`，`restoreAttachments` 透传，`announceDeliveredFiles` 只在本轮真有新到达时出声。**交付行为一个字节不改**（worker 照旧拿到沿用那批文件），`fresh` 与交付集同函数返回、不存在第二份判据。**机械锁**：handler 3 条（用户原话形状：不复读但交付仍带 3 个文件 / 纠正重试流不二次上屏 / 新文件到达照常披露且只列新到的那几个）+ e2e AT-5（全链：收据整个会话只一次、后续回合零收据且受理帧照旧、两个文件名仍在请求文本里、outcome 为 replied）。**变异验证**：去掉 `attachmentsAreNew` 门 → 2 条单测 + AT-5 红；沿用分支 `fresh: false` 改 `true` → 同 2 条红。**未验项（登记，不阻塞关闭）**：真企微客户端上"后续回合不再复读"的观感与受理帧「开始处理你的请求」的出现只能真机确认，e2e 钉的是帧序列不是用户的眼睛。 |

**本波最终账**：关 1 条（D-110）。基线实测：改造前 `npm test` 1466 全绿 / 114 文件 + typecheck 0 错误（2026-10-20 冻结，即 §11 收口数字）；改造后用例数只增不减（1470 / 114，数字见 change-safety §12）。F1–F7 执行记录见 change-safety.md §12。

## 补充记录（2026-10-20，进度帧路径波：「正在…」帧不再带服务器路径）

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-111（新）进度帧外泄服务器路径：「正在…」帧把宿主任务工作区 `tmp/task_<uuid>` 送上用户屏幕** | **已关（2026-10-20，本波）** | **位置**：`packages/agent/src/serve-gate.ts` 的 `describeKeyArgs`（参数摘要）、`pi-coding-driver.ts` 的 `serveGateStepText`（平台操作帧）、`step-text.ts` 的 `clampProgressPhrase`（模型自填短语），判据本体是 `server-paths.ts` 新增的 `hasServerPath` 探针。**触发（用户观察，2026-10-20，重启后第一条真实委派）**：企微弹出 `正在盘点薪酬数据源 + 契约草稿 「tmp/task_f695557e-f9b1-4」…`。用户原话：「怎么还有这种东西」。**根因**：D-109 那道尺挂在**终稿**出口（`sanitizeUserVisibleReply`），而这条文本出自**进度帧**通道——宿主按平台声明的 label + 参数摘要合成帧，摘要按平台 args 规格摘 flag 取值，平台把一堆路径型 flag（`--out-dir`/`--contract`/`--cache`/`--out`/`--decisions`）声明成了 `name` 样式，取值正是宿主自己的任务工作区。终稿那道尺从未被调用：两个出口，之前只盖了一个。**修法**：一个判据三个出口——摘要源头不放路径型取值（帧照发，只是少个参数）；帧里探到路径整帧不发（与"没有 label 就不发帧"同族安全缺省）；模型短语探到路径整条丢弃回落默认帧（与协议材料同族）。**为什么不放渠道适配器**：适配器是传输，内容判据塞进去会让"发什么"取决于"走哪个渠道"；放合成点则任何渠道过同一把尺。**归属**：用户可见状态反馈是 fshine 通用机制，`tmp/task_<uuid>` 是宿主自己的暂存命名（`sweepScratchDirs` 只扫这一种），平台侧只是被消费的 args 规格数据，不新增协议面。**机械锁**：7 条新增（探针 3：命中/不误伤/与 `stripServerPaths` 一致性 + 无状态；摘要 1：三种写法 + 截断后半截路径 + 同命令其他取值照旧；短语 1：三条不带 `task_` 的路径形状——既有协议特征只拦 `task_`，这是补缺口；帧 2：守卫 + 真实事故复现且审计 detail 仍带完整命令）。**变异验证**：四条全红后回滚复绿——删摘要跳过（2 红）/ 删帧守卫（1 红）/ 删短语判据（1 红）/ 探针恒假（6 红，四个文件全红）。**F6**：不需要——不改任何提示词/工具说明/申报契约，帧文本由宿主确定性合成。**未验项（登记，不阻塞关闭）**：① 真企微客户端上"这一帧不再出现、且没有空帧或掉帧"只能真机确认（e2e 钉帧文本与有无，不钉用户眼睛）；② `npm test` 总计数一度记到 1466/1476/1477 三个数并归因为"本机 ±10 抖动"——**该归因已推翻**：真因是工作树被本会话之外的进程并发改写（证据与纠正后的口径见 change-safety §13"计数抖动真因"）；F2 的"只增不减"按新增用例逐条可数核，并已在纯净树上复测一致；③ **计划通知出口（`formatPlanMessage` → `sanitizeSummary`）本波未上尺**——已核平台 `buildNotice`（17dz `src/execution/plan.js`）只拼账套名/期间/客户/科目编号，现无路径；留作下一个出口出现时同批补，不预支防御。 |

**本波最终账**：关 1 条（D-111）。基线实测：改造前 `npm test` 1470 全绿 / 114 文件 + typecheck 0 错误（即 §12 收口数字）；改造后 **1477 全绿 / 114 文件**（+7，全为新增用例）+ typecheck 0 错误 + `tests/e2e` 35 文件 / 144 全绿。两个总数均已在**纯净树**上复测（`git worktree` 检出对应提交单跑，各 114 文件全绿）。F1–F7 执行记录见 change-safety.md §13。

## 补充记录（2026-10-20，交互缝波：收据文案 + 终稿点名 + 三条演进缝 + handler 行数棘轮）

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-112（新）第二客户端接入的三处前置债：企微交互模型渗入宿主、附件状态只在进程内、契约带渠道名** | **部分关（缝已留，债未消；2026-10-20 本波）** | **触发（架构讨论，非事故）**：第二个客户端（web/小程序）明确在路线上，而其输入模型是 composer 式——文件与文字同一条请求，于是 `attachmentOnly`、burst 稳定器、孤儿收据并窗、ack/4 帧硬顶/心跳这批机器在它上面根本不该存在。**三处债**：① **交互模型渗入宿主**——帧会计（`framesEmitted` / `acceptedAnnounced` / `receiptAnnounced`）与受理帧抑制是渠道知识住在 `apps/server/handler.ts`，且"用户看没看到那一帧"只有渠道知道，宿主的近似记账会让心跳在该补的时候静默；② **附件状态只在进程内**——`sessionAttachments` / `sessionDelegations` / `sessionQueues` / `lastArrivalAt` 四个 Map，多实例下规则一失效（账本失记 → 全部未消费 → 上一个任务的文件进这一个任务，即算错钱的 P0 形态回来）、稳定器与队列同时失效；且 `nextArrivalStamp` 是进程内单调钟，跨实例要共享单调源。③ **渠道身份仅部分参数化**——`channel` 已进入 principalId/sessionId 与审计，但授权存储仍以原始 `wecom_user_id` 为键，handler 的队列/附件池等内存态也未包含 channel；当前没有跨渠道授权或附件隔离。**本波修法（留缝不搭桥）**：D1 孤儿收据去掉催命后缀；D2 终稿点名回传文件（企微 file 是独立消息，这一行是宿主补的确定性文字，与收据同族不过模型的手）；缝 a = `channel` 字段 + principalId/sessionId 前缀从消息取 + config 解析接受任意前缀（字段名故意不改，65 处零行为 churn）；`principalScopeRecords` 仍把前缀剥掉写入 legacy raw-ID 主键，因此只是接缝，未实现渠道隔离；缝 b = 到达钟包成 `ArrivalClock` 接口、`deps.arrivalClock` 可注入（不上 Redis）；缝 c = locality 契约成断言（契约只认宿主可见的本地绝对路径，adapter 负责把渠道文件落到那个位置）。**护栏**：`apps/server/handler-shape.test.ts` 的 `HANDLER_LINE_BUDGET`（958 → 1013，只减不增）——handler.ts 是唯一没拆过也没有机械护栏的大文件，附件机器是它增重的主因。**机械锁**：D2 两条、钟三条（严格单调 / 墙钟可读 / 注入缝是真的）、渠道前缀两条（handler + config）、locality 三条断言、shape 一条。**变异验证**：六条全红后回滚复绿（加行→棘轮红 / 去点名→2 红 / 钟退回墙钟→2 红 / 不认注入→注入红 / 前缀写死→handler 红 + config 红）。**未关部分（登记，不阻塞）**：① 帧策略与帧计数权威仍在宿主，"宿主发事实、渠道演呈现"那一波才能消，触发条件 = 第二个客户端确定接入；② 附件状态外置与共享钟要等那个触发器，且接入前先补多实例语义的表征；③ `wecomUserId` 字段名与 `principal_scopes.wecom_user_id` 列名未动（后者改列 = 数据迁移，单独立项）；④ 清单化（引用形态）不动实体门，等实证；⑤ **第二渠道接入阻断门**：先做授权主键迁移并补同原生 ID 的渠道授权隔离测试，再补 handler 队列/附件池跨渠道隔离测试（web 与 wecom 使用相同 user/conversation ID 时，不能继承权限或交付对方附件）。 |

**本波最终账**：关 0 条、留缝 3 处 + 交互修正 2 处 + 护栏 1 根。基线实测：改造前 `npm test` 1477 全绿 / 114 文件 + typecheck 0 错误（2026-10-20 冻结，即 D-111 波收口数字）；改造后用例数只增不减（1484 / 115，数字见 change-safety §14）。F1–F7 执行记录见 change-safety.md §14。

## 补充记录（2026-10-20，D-108/D-109 跨层回归补强）

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-113（新）附件下载、路径出口与重复请求回执的跨层漏测** | **部分关（当前新路径已封；旧转录兼容边界保留）** | **触发**：review 发现 D-108 的静默窗口只看到附件下载完成后进入 handler 的消息；file 事件已到但下载较慢时，正文可能被当作冷启动。D-109 的路径整理只覆盖普通终稿出口，direct 收尾、转录与可检索 toolResult 仍可能留路径；route 回执判据把非 conversation 结果一概当作 delegate。**修法**：① WeCom adapter 在正文到达时立刻 ACK，跟踪附件消息直到 handler 暂存/收据入队；正文等待总上界 8s，超时用“附件尚未准备好”收尾且不进 worker；② `server-paths.ts` 判据覆盖 direct 回复、assistant/toolResult transcript 与可检索 toolResult；审计只在能确认执行事实时写 `executed`；③ 新 toolResult 用 `details.routeReceipt` 区分 `delegate` 与 `precondition`，结构化回执只认 `recorded: delegate`，用户文案不变。**机械锁**：adapter 5 条（延迟下载、收据只一次、超时失败关闭、持续分批总上界、stop 唤醒）；agent 4 个新增回归（SP3 direct、transcript/toolResult 路径、结构化错误/前置拦截回执）；`pi-driver` 1 条 details 不进入用户文本的契约。**变异验证**：去掉等待、提前撤收据、按批续 8s、绕过 direct 路径整理、transcript/toolResult 清理恒等返回、把 precondition 当 delegate，各自对应测试红。**兼容边界**：没有 `routeReceipt` 的旧转录仍走既有纯文本兼容判据；缺少可靠元数据时可能把旧版前置拦截当作 delegate，保留此行为是为了不静默丢失旧版成功委派的重复请求保护。跨渠道授权和附件态隔离不在本条内，接入门见 D-112。 |

## 补充记录（2026-10-20，会话级产物库与引用迁移波：R1–R4 根治，W0–W7）

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-114（新）产物无会话级生命线：交付即蒸发、指针住散文（R1 主根，附 R2/R3/R4）** | **已关（2026-10-20，W0–W7 七波；D5 物化留缝）** | **触发（用户观察 + 库取证）**：2026-10-20 企微会话（`data/agent.db` 只读取证；同一指令在本会话发了 24 次，会话自 09-20 起 153 条事件）。15:05:58 用户说「发一下 幻骥达2026年08月个税申报.xlsx」，委派原文（`platform_tasks.worker_messages` 逐字）写着「文件位于 `/tmp/task_d42fffce-e4b2-4d35-82b6-969f97b12b0a/…`」——**前缀错**（`/tmp` 而非平台 tmp/）、**UUID 是编造变体**（真身 `…ce9a-4ff7…`，该字符串全历史零出现；而正确路径在历史里明明白白出现过两次）。worker 拿假路径 ls 失败后 `find -iname "*个税*"`、翻 `/tmp/`、依次 ls 四个 task 目录（其中两个现已被 scratch 清理）、md5sum、python 逐格比对，最后把 10/19 的副本 cp 进本轮工作区；交还文本「委派中给出的原文件路径已不存在……已放入本轮工作区」被原样转给用户。同族形状：终稿列「交付物（2 份）」却只附 1 个文件（契约 `file` 单数）；DB 存 UTC，模型把 15:05:58（北京）引述成「07:06」；附件 10/19 16:10 上传、10/20 五个回合 5/5 都播「已收到 3 个文件」。**取证结论**：交付文件与 12 分钟前刚重算的那份**逐格一致**（116 行 0 差异，md5 差只是 zip 元数据）——**无数据正确性事故**，问题全部发生在"系统怎么指认、怎么叙述、怎么使用共同历史"。**根因 R1（主根）**：交付曾是"回合末把字节流进渠道消息"的一次性副作用——不停留、不复制、不登记；`conversation_events.artifact_ref` 槽位全代码库只有读方没有写方。"重发一个已交付产物"这个产品上完全自然的请求，系统没有任何机制：Main Agent 只能凭对话散文里提到的路径复述，而复述会损坏。**信息不是不存在，是以"散文中路径"的形态存在：不可校验、不可引用。** **附条 R2**：交付集当会话级持久状态（附件池 + 规则一窗口），"系统手里有什么文件"与"用户这一轮给了什么"混为一谈（收据复读已由 D-110 修；池与窗口模型本身在 D-112 跟踪外置）。**附条 R3**：用户可见层只做形态过滤（`stripServerPaths` 形状匹配）不做语域过滤，"委派/批次/工作区/逐格比对"类流程叙述与 UTC 时间戳复述管不住——注意因果方向：R1 决定了 worker 只能靠 hunt 和自我叙述交差（没有身份可引用），R3 决定这些叙述到达用户。**附条 R4**：长会话无摘要与复用纪律（30 天 153 条事件、greeting 触发状态倾倒、同指令 24 次重发却没有"产物已存在"的产品语义）。**修法（七波，设计全文 `docs/artifacts.md`）**：W1 session = 聊天窗口（`channel:conversationId`，principal 降为消息级）；W2 产物库 per-session（`session_artifacts` 表 + `apps/server/artifact-store.ts`：ingest/manifest/ref 改写/回合收口；溯源从 `platform_tasks.worker_messages` 投影，不建平行登记）；W3 契约 `files[]`（多文件诚实回传）；W4 重发宿主动化（申报 `resend` → runtime 记账零委派 → handler 依库三态确定性回答）+ 委派外来 scratch 路径外科手术式剥离 + 收尾指令去路径；W5 scratch 双年龄清理（终态 1h grace + 抛弃 24h）+ 库显式淘汰（50 个 / 512MB 双闸压可重发集合，最旧优先、新批保护、status=evicted 清单可见）；W6 群语义（队列键 = 会话，arrivalKey/queueKey 分职）。**机械锁**：+44 用例（1494 → 1538，115 → 117 文件），每波新守卫均过变异验证（汇总表 `docs/artifacts.md` §7）：W1 改回复合键 9 红 / W2 ref 恒 '1' 1 红、insert 跳过 4 红、清单恒空 1 红 / W3 只挂首个 2 红 / W4 路由不记账 2 红、解析恒无 2 红、守卫空操作 3 红 / W5 grace 失效 1 红、fresh 守卫删 1 红 / W6 队列键改回 1 红。**结构护栏**：handler.ts 1104 → 839 行（产物机器抽取进 artifact-store.ts，行数棘轮 1017 内）；runtime.ts 棘轮 1290 → 1298 按"功能新增留理由"规矩上移（resend 路由接线，判据本体在 server 侧）。**未关/留缝（登记，不阻塞）**：① **D5 物化未做**——续跑引用产物 ref 时宿主把字节复制进新任务 scratch 需要 driver↔库接缝（跨层），当前替代是委派信封剥离外来路径 + 留痕（worker 不再 hunt，但指代旧产物的续跑请求会确定性找不到文件而非 silent hunt）；② `worker_messages` 保留策略未验证（D3 投影源的寿命未知，现 45 条任务俱在）；③ R4 长会话摘要纪律未收敛（resend 语义已给，转录增长与 greeting 倾销另立账）；④ `artifact_ref` 槽位仍未启用（本轮登记走独立表——该槽位没有 ref 语义（单调/状态/溯源），不复用而非留双写，理由写在该列声明处）。 |

**本波最终账**：关 1 条（D-114）。基线实测：改造前 `npm test` 1494 全绿 / 115 文件 + typecheck 0 错误（2026-10-20 W0 冻结）；改造后 **1538 全绿 / 117 文件**（+44，全为新增用例）+ typecheck 0 错误 + `tests/e2e` 全绿。七波各自的 F1–F7 执行记录见 change-safety.md §16。

## 补充记录（2026-10-23，计划提交空转治理波：--file 通道 + 形状失败收敛 + 元数据自救，C1–C4 + Round 1 review 补强）

| 条目 | 状态 | 说明 |
|---|---|---|
| **计划提交空转（新登记即关：worker 写不对裸 plan JSON，机制不兜底）** | **已关（2026-10-23，C1–C4 + R1/R2 review 补强；跨仓 SKILL 更新与 F6 探针留缝）** | **触发（用户提问 + 库取证）**：2026-10-23 企微会话（`data/agent.db` 只读取证）。`req_368b68b3`「列一下清单看一下先」→ 委派 `task_c7e41c75` 367s / 656,960 tokens，其中 **4 分 11 秒是 11 次 `plan_submit` 连续 `PLAN_JSON_PARSE`**；`req_17790072`「查李华欠款明细」同形态 188.8s / 241k tokens（6 次提交被拒）。**取证结论**：平台侧行为干净——当日 6 次真实平台调用全部单发、一一对应用户意图，零循环零枚举；问题 100% 在宿主侧"提交形态解析 + 无界重试"。**根因（三重）**：① 宿主解析的是**原始命令字符串**（`plan-runtime.ts` 的 payload = `bin/17dz plan` 之后的命令原文），模型本能的 shell 引号（`'{"goal"…}'` / 转义双引号）与命令尾巴（`2>&1` / `; echo "rc=$?"` / `|| true`）原样进 `JSON.parse`——worker 最后靠发 `{"a":1}`、`ZZ{"a":1}` 黑盒探针才逆推出"JSON 必须是整行剩余内容、无引号无后缀"的规则（探针本身证明：没有便宜确定性校验器时，试错是模型唯一路径）；② 熔断器 `MAX_DECLINED_PLANS_PER_TASK=5` 只在解析成功后的 `decidePlanSubmission` 内自增，**形状失败在 `parsePlanCallsCommand` 抛出点提前返回、从不计数**——11 连撞完全绕过熔断；③ `bin/17dz plan --schema`（17dz-query SKILL 教的自救出口）被 driver 的计划解析当坏 JSON 拒掉，serve-gate 里为它写的元数据白名单（`SERVE_METADATA_COMMANDS`）因 driver 先行拦截而不可达——**文档教的是个死命令**（平台 CLI 确实支持该出口，`src/cli/index.js` 逐字打印 plan-schema.json）。**修法（四波）**：C1 表征 golden 先行（4 条：fuzz 3 条 + audit 1 条）；C2 `--file` 提交通道（worker 用 write 把计划 JSON 落本轮工作区 `tmp/task_<taskId>/plan.json` 后以 `bin/17dz plan --file <路径>` 提交；宿主只读不代写，边界尺 = 提案 payload 同一把尺 `workspaceRelPath`+`isInsideScratch`，体积 = write 门同口径 256KB，内容 = inline 同一份 `parsePlanCallsPayload` 校验——文件通道不宽松；lint 是 worker 侧本地命令，属待落的跨仓 SKILL 工作流，宿主体只有读通道）；C3 形状失败计入同一 `declinedPlans`（第 6 次即 `PLAN STOP`+`DECLINED_PLAN_LIMIT`，措辞纪律不变：提交次数不伪装成拒绝次数）；C4 旗标形态 payload 返回 null 交 serve-gate 裁决（元数据放行复活、未知旗标落门的计划教学分支）。**设计红线（遵守未破）**：不做引号/尾巴解包容忍层（`plan-runtime.ts` 注释里钉着事故判据——absorbing 曾把模型误导成把方案 JSON 打印成助手文本、12 步全空转）；宿主不吸收格式波动，只给精确通道。**Round 1 review 补强（五个独立审查员并行后落地 R1/R2）**：R1 三处代码修复——`--file` 守卫补 tab 形态（守卫/取值正则/码表措辞三处归一为 `[=\s]`，修复前 tab 发射静默落 null）、`reportPlanSubmission` detail 补 `AUDIT_DETAIL_MAX_CHARS` 截断（提案路径早有、计划上报是唯一没挂尺子的出口）、读文件前 `isFile()` 守卫（挡 FIFO 无限期阻塞挂住无超时的 `beforeToolCall`）+ 读后 `Buffer.byteLength` 复核（收 TOCTOU 实际窗口）；R2 补 13 条判别性用例（`PLAN_FILE_TOO_LARGE` 零覆盖、`..` 穿越与符号链接逃逸——原有越界用例被任何朴素 startsWith 同样拒掉不判别、工作区内绝对路径自然形态、文件坏内容 6 连撞收敛、混合 3+3 计数、终局后 N 递增、`--schema` 不计收敛、跨通道归零、子目录/目录/user_confirmed/带尾巴元数据）。**三处既有行为审查确认但登记不随波改**（各有权威注释）：写关闭路径不计入计数（与"熔断对该类失效"同形但被 writeClosed latch 部分兜底且属既有语义）；计数器作用域是每次委派而非每任务（常量名与码表文案说 PER_TASK，任务级上界实为乘法）；保留子命令计入提交数（措辞在该历史上虚增、概率低；排除它 lint 并不拦——错误码是标识符形判据，但排除会把这类拒绝重新变成无界空转、正是 C3 抗的向量，故登记不排除）。**机械锁**：+21 用例（1545 → 1566）+ R1/R2 补强 +14（→ **1580**，118 文件不变）；Round 2 复审补 2 条判别用例（→ **1582**）；四个变异全红后回滚复绿（全量范围单测+e2e：C2 边界尺 4 红 / C3 计数 5 红 / C4 旗标放行 8 红 / R1 isFile 守卫 1 红；Round 2 补三个：原始串前缀替边界 3 红 / 终局后重置计数器 1 红 / 停体积双闸 1 红）；泄漏 lint 的字面量 if 预算当场抓住第一版 C2 的 `!== '--schema'` carve-out（症状嗅探），以改设计收场（未知旗标分支移入 C4 的数据判据结构）而非申请白名单——守卫起作用的实证。**未关/留缝（登记，不阻塞）**：① 17dz-platform `17dz-query/SKILL.md` 跨仓更新未落（方案 gate：单独确认后落）——"计划草案形状"节应改教 file+lint 工作流；② `voucher.assistant-map` 能力与 SKILL.md"没有列举客户档案能力"的矛盾未修——09:31 那轮据此给过用户错误结论（实测一次拉回 99 客户 + 759 供应商），修法同属跨仓；③ F6 真实 LLM 探针未跑（静态提示词逐字节未动——`planDraftExample()` 不变，改的是运行时诊断；冻结基线 §16 W4 可用，复跑待用户确认）；④ 长期：结构化调用协议（`docs/a2a-protocol.md`）取代裸命令行 JSON 后本类失败整体消失。 |

**本波最终账**：关 1 条（计划提交空转，新登记即关）。基线实测：改造前 `npm test` 1545 全绿 / 118 文件 + typecheck 0 错误（2026-10-23 C1 冻结）；改造后 **1582 全绿 / 118 文件**（+37：本波 C1–C4 共 21 条 + review 补强 16 条，全为新增/翻转用例）+ typecheck 0 错误 + `tests/e2e` 全绿（新增 A4b 形状连击收敛、A6/A6b/A6c 元数据通道）。四波 + review 补强各自的 F1–F7 执行记录见 change-safety.md §17。


## 补充记录（2026-10-24，原生引用与后台会话首版）

新增通用会话能力：原生企微引用、后台 run 管理、查询/取消、独立文字与文件交付、原任务范围续跑。后台模式默认关闭，未生产验收。实施与回归账见 [change-safety.md](change-safety.md) §18，实际边界见 [interactive-session-plan.md](interactive-session-plan.md) §9。

本波不关闭既有执行凭证充分性、领域规则迁移、分布式可靠调度等债务。新增留缝：真实模型改前/改后探针因自动审批拒绝而未跑，真实企微引用及主动文件验收待授权；运行中 steer、暂停恢复与队列重排未实现；通知去重仅同 run 的已 ACK notice 精确匹配，尚无通用版本化通知身份；失败交付保存可核对状态，暂无任意部分的一键恢复。不承诺进程崩溃后的自动续跑或网络 exactly-once。

本波本地最终验证：完整 mock **1706/1706、129 文件通过**，typecheck 0 错误，diff-check 通过；冻结基线 1582 项 / 118 文件。六条交叉会话 e2e 全绿；没有以本地通过代替真实模型或渠道验收。

## 补充记录（2026-10-25，review 修复波：8 项 P1 修复 + 21 条 P2 登债）

六切片并行深度 review（账目见 [change-safety.md](change-safety.md) §19）后修复 8 项 P1：① 委派外来 scratch 路径剥离覆盖任务正文主拷贝（D-114 留缝①的加固，端到端断言"worker 可见全文无外来路径"）；② 确认码在共享执行闸的等待上界 10s（`platform-execution-gate` 新增 `waitTimeoutMs`，只限排队等待不撤销已授予槽；超时走 confirm_held，提案保持 pending 可重试）；③ task-manager 同 taskId 并发提交同步预留（检查与预留之间不再隔 await）；④ 后台多步计划零执行熔断（计数持久化在计划投影尾部连续 failed 步，与 inline 同阈值，事实与续跑判定同源）；⑤ 后台受理回执落转录（repeat-request 复核在后台模式复明，runtime 棘轮 1298→1311 登记在案）；⑥ `task_runs.result_handling_state` 显式列（弃 `$.resultHandling.state` 魔法 JSON 嗅探，迁移幂等回填，契约声明）；⑦ 启动期清扫终态未决投递（可校验则重投，否则标 failed + 可行动通知）+ 传输失败有界重试（3 次 × 750ms，耗尽发失败通知）+ 认领抢锁失败留痕；⑧ 重发读回 sha256+size 复验。顺手项：signal→runSignal、patchColumns 死条目、serializeMessageReference null 防御、W4 用例同毫秒竞态稳定化、handler 棘轮 1017→907 压余量。

review 遗留 P2 逐条核实仍成立后登记如下（已修的不登）：

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-115 inline/background 输入语义分叉** | 登记不阻塞 | inline 委派不走 `materializeInputs`（冻结只在 background 生效），附件靠消息文本活路径；附件池按最新 N=8 滚动（handler `MAX_PENDING_ATTACHMENTS`），inline worker 晚读时活路径可能已被挤出；模式切换输入行为静默变化。收敛方向：inline 也走 materialize 或部署文档写明分叉 |
| **D-116 工作区快照无界** | 登记不阻塞 | `snapshotWorkspaceFiles`（context.ts）无单文件/总量上限，逐文件整读 sha256；before 快照在 `lease.start()` 之后 worker 启动之前执行——续跑任务已有大工作区时拉长平台槽位占用。建议加阈值，超限降级为只记大小不哈希 |
| **D-117 待确认提案不变量两模式不对称** | 登记不阻塞 | background 建提案只 supersede 同 taskId（`findPendingBySession` 第三参，store 按 task_id 过滤），inline 仍 supersede 全会话 pending——用户可同时持多个有效确认码；紧邻注释仍写"会话里同时只留一个待确认提案"（context.ts:657-660）。不变量需明确定义并写准注释 |
| **D-118 history-tools 引用渲染无截断** | 登记不阻塞 | `reference.text` 上限 16,384 字节（contracts `MAX_QUOTED_TEXT_BYTES`）× limit 20 原样 stringify，单次工具输出可膨胀数百 KB 进模型上下文，与该模块紧凑纪律不匹配 |
| **D-119 dispatchKey 只锚 requestId，渠道重投递不去重** | 登记不阻塞 | 企微对同一消息的重投递会生成新 requestId，可二次建后台任务跑同样工作（repeat-request 拦不住 delegate 形态重投递）。消息级去重需 messageId 进身份 |
| **D-120 task-manager 公共接口内嵌执行层类型** | 登记不阻塞 | 公共接口暴露 `Run17dzTaskArgs` / `ContextTaskRunner`（17dz 执行层类型进通用命名表面积，未登记迁移债）；同族：`TaskRunRecord` 无 `dispatchMode` 字段，方案 §4.3 要求的"创建时派发模式"未落账，取消原因只能挤 `error` |
| **D-121 PlatformExecutionGate 命名与授信门术语相撞** | 登记不阻塞 | 本仓语境"平台执行门/G1"指 serve-gate 的授权裁决；新模块只是并发准入闸（不做授权裁决）。易被误读为"拿到 lease=已获准执行"。建议更名（如 PlatformAdmissionGate）或文件头写明与授信门的关系 |
| **D-122 system-prompt 固化执行层名** | 登记不阻塞 | system-prompt.ts:14 固化"17dz 子 Agent"字样，与文件头 business-neutral 声明矛盾；应像 `planCommandForm` 一样参数化执行层名 |
| **D-123 session_artifacts insert 静默覆盖 upsert + ref TEXT 排序** | 登记不阻塞 | `ON CONFLICT (session_id, ref) DO UPDATE` 整行覆盖无守卫（store.ts:925），正确性依赖"只在 handler 会话队列内调用"的注释纪律，跨进程无防护；`ORDER BY created_at, ref` 的 ref 是 TEXT，同毫秒批内跨 10 位数排序不稳定。建议 INSERT 冲突即错或契约注明前提 |
| **D-124 cancelTask 跨进程 TOCTOU** | 登记不阻塞 | busy 检查（SELECT processing+lease）与 UPDATE 非原子（plan-confirmation-store.ts:203-212）；跨进程另一实例可在两语句间 claim 后被翻成 cancelled——失败方向安全（不伪造同意）但用户确认被静默丢弃。收敛：判定并进单条 UPDATE |
| **D-125 单活跃 run 冲突裸抛 SqliteError** | 登记不阻塞 | `createOrGetByDispatchKey` 撞 `idx_task_runs_one_active_per_task` 时调用方拿到未分类错误；契约只承诺 dispatchKey 幂等，未声明该失败形态。应在 repo 层转可识别错误或契约写明 |
| **D-126 background × 无主动发送渠道未装配期 fail-fast** | 登记不阻塞 | 渠道缺 `sendToConversation`/`sendMediaMessage` 时 background 模式两条交付路（inline 收集已关、后台投递必败）都发不出文件，只在运行中逐次留 failed 记录；该组合应在装配期报错 |
| **D-127 产物清单把"已入库"当"已交付"** | 登记不阻塞 | `artifactManifestText`（artifact-store.ts:212）无投递状态门：产物 staged 即 status=available，交付失败或崩溃后清单仍宣告"本会话已交付产物 #N"，模型可据此声称"已发过"。清单措辞应与 resultHandling/deliveryState 对账 |
| **D-128 「本回合交付」收据措辞两个权威位置** | 登记不阻塞 | artifact-store.ts 与 background-delivery.ts 各有一份（一带 ref 一不带），违反 `formatFileReceipt` 立过的"同一事实一个权威位置" |
| **D-129 adapter 被动回复多文件回传无直接测试** | 登记不阻塞 | adapter.ts 的 `for (const file of rich.files)` 循环零直接覆盖：W3 变异守卫在 handler.test 断言 reply.files 对象（不经 adapter），e2e 的 RecordingSdkClient.replyMedia 是 no-op——回归成只发首个文件全套仍绿。补一条：handler 返回两个 files → 断言 uploads/mediaCalls 各两条、单文件失败不挡后续 |
| **D-130 requestWithFrozenInputs 纯字符串匹配 + 读无上限** | 登记不阻塞 | freeze-task-inputs 的路径替换只认精确拼法（相对路径、`./` 前缀、别名不替换）；`readFileSync(originalPath)` 无体积上限（write 门有 `MAX_WRITE_BYTES`，输入侧无对偶）；两者零测试 |
| **D-131 任务事件通知投递失败即整任务 failed** | 登记不阻塞 | task-manager 的 `onNotice` 直接 await（task-manager.ts:439-441），渠道瞬断 → executionError → run 标 failed，而 Worker 可能已产生平台副作用；通知送达的有界重试是 fshine 通用机制义务（AGENTS.md），background-delivery 侧已补（3×750ms），任务事件侧未补 |
| **D-132 shutdown 窗口竞态** | 登记不阻塞 | `stopping` 只在 submitIdempotently 入口检查，已过检查的提交可在遍历 activeRuns 之后 schedule；main.ts 连续两次 SIGINT 并发跑两遍 shutdown；drain 上限 5s 排不完长队。`recoverInterrupted` 兜底（重启标 interrupted 不自动重跑），危害有界 |
| **D-133 enqueueTaskEvent 旧会话键过渡期错配** | 登记不阻塞 | 对旧 sessionId（`wecom:user:conv` 形态）剥前缀得 `user:conv`，与现行会话队列键（单取 conversationId）不匹配——过渡期数据绕过 W6 串行不变量 |
| **D-134 handleTaskEvent 无 conversationLog 硬 throw** | 登记不阻塞 | 配置错误时所有后台事件交付静默丢失（仅 listener 日志），应启动期校验或降级可观察 |
| **D-135 e2e 断言质量两条** | 登记不阻塞 | turn-loop-interactive.test.ts:69 的 finish 帧断言近恒真（`send()` 本就等到那条 finish 帧才返回）；"引用携带真实确认码不触发"无 e2e（结构性保证在 background-event.test.ts:382 单测钉住），登记为缝 |

**本波最终账**：修 8 条 P1（含 D-114 留缝①加固），新登记 21 条 P2（D-115–D-135），无既有债关账。终态实测：`npx vitest run` **1725/1725、129 文件全绿** + typecheck 0 错误。F1–F7 执行记录见 change-safety.md §19。注：§16 过程数字（handler 1104→839）为波内中间态，当前树 907（棘轮已于本波压到 907），对账以波内日志为准。

## 补充记录（2026-10-26，P2 清偿波：D-115–D-135 中 16 条收口）

对 2026-10-25 登记的 21 条 P2 按"可机械收口"分批清偿（两波 subagent + 限额后协调方亲落地；部分表征测试由并行会话先行写红）。**关账 16 条，留账 5 条**（D-115/D-117/D-119/D-120/D-132，均需设计决策，见下）。终态与证据见 change-safety.md §20。

| 条目 | 状态 | 收口摘要 |
|---|---|---|
| D-116 工作区快照无界 | **已关（缝：快照仍在租约窗口内）** | 三道上限（单文件 32MB/总量 256MB/2 万条），超限降级为记大小不哈希（`hashSkipped` 随快照持久化）+ `workspace_snapshot_limited` 留痕；红→绿含"上限置 MAX_SAFE_INTEGER 复现旧行为"反证。快照移出租约窗口属行为重排，未做（登记缝） |
| D-118 引用渲染无截断 | **已关** | `formatHistory` 每条引用 512 字节 UTF-8 安全截断 + 「（引用已截断，全文走持久历史检索）」注记，对齐压缩 sidecar 预览惯例；16KB 引用红→绿 |
| D-121 门命名术语相撞 | **已关** | platform-execution-gate 文件头 + 接口 doc 澄清块：并发准入闸不做授权裁决、lease 不构成执行授权、授权裁决在 serve-gate.ts；存在性守卫测试（docs-reality 新钉） |
| D-122 提示词固化执行层名 | **已关（缝：常量待装配注入退役）** | `buildSystemPrompt(executorLabel)` 参数化 + `DEFAULT_EXECUTOR_LABEL` 全文件唯一执行层字样（注释标注迁移期待清）；golden 逐字节相等（2650B 冻结）+ 变异验证。runtime deps 全参数化降级原因：无既有配置可取、需新增装配参数且本波 apps 侧无人可传（死配置违仓规）——装配接入路径已留 |
| D-123 insert 静默覆盖 + ref TEXT 排序 | **已关** | insert 改 fail-loud（`SessionArtifactRefConflictError`，PRIMARYKEY/UNIQUE 两种 code 都收口，契约声明）；`ORDER BY created_at, CAST(ref AS INTEGER), ref`；先行红 4 条转绿 |
| D-124 cancelTask 跨进程 TOCTOU | **已关（TOCTOU 结构性闭合）** | UPDATE 自带租约条件（有效租约行不可被取消路径触及；过期/缺省租约仍可取消，与改前等价）；busy 前置保留（同任务多行语义不变）。机械锁=租约语义两态钉（有效→busy 抛、过期→可取消，注入时钟）；跨进程交错无单进程确定性表征，如实记录 |
| D-125 单活跃冲突裸抛 | **已关** | 撞 `idx_task_runs_one_active_per_task` 转可识别错误 `TaskRunActiveConflictError`（contracts 导出，判定=message 列名——SQLite 不报索引名；dispatch_key DO NOTHING 幂等不受影响，测试钉住）；变异验证（去分类→2 红→恢复绿） |
| D-126 background×无主动渠道未 fail-fast | **已关（缝：client 内层能力运行期兜底）** | `assertBackgroundAssemblyReady` 装配期卡渠道契约面（`sendToConversation`）+ conversationLog 缺失（与 D-134 同点）；仅 background 触发（inline 全放行，两态钉住）。SDK client 的 `sendMediaMessage` 在 channel.start 才构造、装配层不可见——留运行期有界重试+失败通知兜底 |
| D-127 清单冒称"已交付" | **已关（缝：条目级投递对账不做）** | 清单标题改登记语义「已保存的产物（可随时要求重发）」；消费该标题的模型指令（turn-contract 三处）同步；e2e 确认路由不受措辞迁移影响 |
| D-128 收据两个权威位置 | **已关** | `fileReturnReceipt(entries)` 单一权威（带/不带 #ref 是参数），两消费点改吃它；扫描锁：`本轮回传` 构造点全 apps/server 只允许出现在 artifact-store.ts |
| D-129 adapter 被动多文件零直测 | **已关** | 被动路径两条直测：逐条 upload→replyMedia 配对（顺序/文件名/media_id 一一对应）+ 中位失败只跳过并留 `wecom_file_fail`（失败注入点 `failUploadIndexes` 落进 FakeSdkClient） |
| D-130 冻结读无上限 + 替换零测试 | **已关（缝：幂等复验路径重读未加上界）** | 输入读前 `lstat().size` 判体积，超 `MAX_WRITE_BYTES`（import serve-gate 同一常量，同一把尺）fail-closed；替换行为 4 条表征钉现状（精确拼法成立；相对/`./` 不替换=已知缝，不擅自扩面） |
| D-131 任务事件通知无重试 | **已关** | 归属判据：渠道语义住 server 层——`createBackgroundNoticeSender`（onBackgroundNotice 唯一生产点）内层走既有 `pushWithBoundedRetry`（3×750ms，仅传输错重试）；task-manager 零改动；三用例：瞬断吸收/持续失败仍 failed（语义不回归）/确定性错误零重试 |
| D-133 旧会话键过渡错配 | **已关** | enqueueTaskEvent 对三段 legacy 形态取末段（=现行裸 conversationId 键，与用户回合同队列）；不可识别形态保守回退旧行为；互斥串行红→绿；handler.ts 907 精确不变（注释压缩抵扣） |
| D-134 handleTaskEvent 无库硬 throw | **已关** | 与 D-126 同点：装配期校验 background 模式下 conversationLog 必须存在，缺失启动即拒；守卫本体+wiring 两级用例 |
| D-135 e2e 断言质量 | **已关（缝：引用×真实确认码 e2e 留缝）** | a：受理 finish 帧=入站流**最后**一帧 + 委派输出不进原流（send 返回瞬间快照，序列形状断言替换恒真断言）；b：反方向单测钉——真实待确认文本在**引用**、正文无关 → 匹配器只见正文（变异：喂引用文本→2 红→恢复绿） |

**留账 5 条（需设计决策，未机械收口）**：D-115（inline/background 输入语义分叉——收敛方向 inline 也走 materialize 或部署文档写明，涉及行为决策）；D-117（待确认提案不变量两模式不对称——不变量需先定义再实现）；D-119（企微消息级重投递去重——需 messageId 进身份，跨层）；D-120（task-manager 公共接口内嵌执行层类型——随 a2a 结构化协议迁移批次）；D-132（shutdown 窗口竞态——drain 语义重排）。

**本波最终账**：关 16 条（其中 4 条留缝已注明）、留 5 条。终态实测见 change-safety §20。

## 补充记录（2026-10-26，第二波：D-132/D-119/D-120 三条收口，留 D-115/D-117）

对上一波留账 5 条中的 3 条机械项收口（D-132 由并行实施、协调方逐处复核；D-119/D-120 由协调方落地，subagent 因用量限额不可用）。**留 2 条待拍板**（D-115 inline 物化统一、D-117 提案不变量定义）。

| 条目 | 状态 | 收口摘要 |
|---|---|---|
| D-132 停机窗口三处竞态 | **已关** | (a) 停机在飞闸（apps/server/main-shutdown.ts 判据本体：闭锁不复位——停机体末尾 process.exit、抛错把重试留给进程监督者；二次信号只打 `shutdown_already_in_progress`）；(b) task-manager 双道闸：落库前复查（入口检查隔着 prepare/materialize 的 await）+ execute 入口末道闸（落库 await 的残余窗口，按 shutdown 同一套 windDownForStop 分类收卷并照常派发终态事件，两路口径一致）；(c) drainMs 可配 `FSHINE_SHUTDOWN_DRAIN_MS`（缺省/非法回退 30000，0 显式合法；排干不强的残留由启动期清扫兜底，注释写明层级关系）。红→绿：迟到提交拒绝、末道闸收卷不起 Worker、闸幂等、drain 解析四组用例；FSHINE 名字与 .env.example 已登记 |
| D-119 企微消息级重投不去重 | **已关** | 受理层按 messageId 幂等（`findByWecomMessageId` 基础设施已在）：查重先于新 requestId 的任何副作用（含附件-only 入池——重投附件不把池翻倍）。回执四层：① 后台 run 终稿优先重放（task_runs 按 originRequestId 关联取 resultText——受理回执只是"已排队"，真正有信息量的交付文本在 run）；② assistant_message 事件兜底（inline/direct 回合）；③ denied 同文案、attachment_received 静默；④ 取不到（极长会话挤出 500 条窗/崩溃中断）→ 诚实回执 + 重发指引，不伪造。信任边界（msgid 来自已验签的渠道适配器）写在判据处。dispatchKey 不动（多形态身份，混入 msgid 会误伤合法续派）。红→绿（变异：短路查重 → 4 红）：文本重投恰一回合恰一记录重放原稿 / 崩溃形状诚实回执 / 附件重投静默不重复入池 / 拒绝重投同文案；e2e：background 模式同 msgid 二次投递 → worker 恰一次、run 恰一条、二次重放 run 终稿（harness 增 messageId 覆盖缝，缺省随机不变）。handler 棘轮 907 → 956（功能新增留理由） |
| D-120 通用接口内嵌执行层类型 | **已关（第二步随 a2a）** | 第一步（命名债）：主名中性化 `ContextTaskRunArgs`（字段本就全通用，只有名字带执行层色彩），task-manager/background-runtime 公共表面积全部换用；旧名 `Run17dzTaskArgs` 保留 deprecated 别名导出（随 a2a 结构化调用协议批次退役，先例 DEFAULT_EXECUTOR_LABEL）；docs-reality 加反方向守卫（两文件再引旧名即红，变异验证红 1 → 恢复绿）。ContextTaskRunner 名字本身已中性未动。第二步（dispatchMode/取消原因入 TaskRunRecord）**不做列**：只有 background 建 run、列值恒定信息量低，诊断信息走 metadata（opaque）随 a2a 批次定形态 |

**留账 2 条（待用户拍板后实施）**：D-115（inline 输入不冻结——统一物化是提示词层变更，须配 F6 真实模型探针）、D-117（待确认提案不变量两模式不对称——需先定义 I1 严格单窗 / I2 同任务单窗，是政策决定）。

**2026-10-26 拍板落地（协调方实施）**：

- **D-117 已关（政策决定 I2：一任务一码）**：用户拍板"应该一个任务一个码"。context.ts 提案创建的 supersede 查询恒传 taskId（改前 inline 枝传 undefined=全会话作废），跨任务 pending 并存——后台长任务中途出的提案不再打断用户前台正要确认的另一任务。已接受代价：同一用户可同时持多个任务的有效确认码，回错码=确认错任务，由确认码三元绑定（principal/session/task）+ TTL 兜底。机械锁：proposal-flow 翻转用例（跨任务并存两 pending + 同任务二次提案作废旧 pending，红→绿）；注释改准为政策决定。
- **D-115 已关（按用户判定维持现状，登记语义）**：用户判定"planner 拥有所有文件；追加附件给在飞的 worker 应由 planner 停掉、总结状态、重新派发"——与现状一致（无追加机制；inline 下新消息在会话队列等当前回合结束由 planner 决策，background 下 planner 即时可用可 cancel+重派）。代码核实修正此前登记的夸大：交付集纪律③"只保留仍在盘上的"已把死路径挡在 worker 之外（文件消失→本轮不带附件→确定性"没收到数据"，而非拿死路径去撞），DB 24h 恢复窗兜底重启失忆。剩余为已登记的窄缝：>24h 后引用旧附件续跑交付集静默缩水（确定性失败可接受）；inline/background 对"慢 worker"输入可用性的模式差异。统一物化不做（收益不抵提示词层变更 + F6 对照成本）。

## 补充记录（2026-10-26，F6 真模型两批后的新立项：D-136/D-137）

F6 重场景批（G1,G2,X1,X2,Y1,Y2）3/6 无异常，三个 ⚠ 经 3b97f51 基线对照全部判为**既有行为非四波回归**（对照细节见 change-safety §21 F6）。其中两项属模型行为调优面（编排层机制无缺陷），立项跟踪：

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-136 回复偶发泄漏执行语言（错误码形态）** | **已关（2026-10-26 出口卫生波，见 §22）** | 收口：reply-exit 出口第三支（删除式）——全大写错误码从终稿删除、留其余文本；**宿主码表词白名单保留**（HOST_ERROR_CODE_NAMES 机械生成，TASK_FORBIDDEN 族上屏是既有产品行为）。红→绿 + 变异（去删除支 → 3 红）；D4④ 基线用例随收口翻转（★缺口标记移除）；真模型 Y1 复验：泄漏警告消失 |
| **D-137 多步计划被打断后模型偶发不续步** | 登记不阻塞（模型行为调优） | F6 双向实测：G1 改后与基线**都**出现逐字相同的"计划未恢复：第5轮后未按第 2 步续跑"（基线 26 次平台调用/285 万 token，改后 18 次/180 万——四波的熔断与转录纪律反而更收敛）。编排层续跑机制本身无缺陷（mock e2e 全绿），是 planner 对"计划还在飞"的时机裁量。收敛方向：计划未完结时的回合首帧/上下文提示强化（提示词层），或计划恢复状态的宿主确定性提示注入 |
| **D-138 出口卫生缺工具调用协议指纹：模型格式错乱时 `<tool_call>` XML 原文上屏** | **已关（2026-10-26 出口卫生波，见 §22）** | 收口：同一删除支的工具调用协议形态——`<tool_call>`/`<function=…>`/`</parameter>` 族标签删除留其余；整段协议（剩余非 ASCII 可读字符 <4）替换为格式异常兜底话术。红→绿 + 变异；Z1 实测的 318 字符 XML 形态即靶子 |
| **D-139 计划暂停终稿的步骤点名串位** | 登记不阻塞（模型行为观察） | Z1 第一跑：4 步扇出在第 4 步（新兴建材）触发预算暂停，终稿末句却说"确认后……汇报**新兴五金**的应收余额"——步骤点名与实际暂停步不符（计划通知四条均正确，仅模型收尾自由文本串名）。第一跑另见 D1 基线自身 ⚠（跨月无先通知，既有行为）。观察项：频次高再立项收敛（暂停终稿话术宿主化是备选修法） |

**本波最终账**：关 3 条（D-120 留第二步缝）。终态实测见 change-safety §21。

## 补充记录（2026-10-30，13 问真平台评测后的新立项：D-140~D-143）

2026-10-30 对 ask.ts 全链路 + 真实 幻账平台跑 13 问评测。发现一个关键失败模式（Q5b 税类机械读：2221 父科目净额直接当税额，判据已结晶进 17dz `src/finance/MECHANISMS.md`「答疑口径」节，评测语料 `scripts/eval/corpus.jsonl` probe-Q5b/probe-Q13b 同批登记）与四项机制缺口。本波只立项不实现：

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-140 任务侧 agent-browser 会话不回收 → SingletonLock 锁死平台共享 profile** | 登记不阻塞（机制缺口） | 2026-10-30 实证：无头会话 task-bf262c9f1d59 开着 17dz 登录页，占锁 25 分钟，平台 Playwright 持久上下文全灭，`agent-browser close --all` 才解除。该会话不经网关、审计全盲（fshine 侧看不到其存在），需要会话回收/看门狗机制 |
| **D-141 多待确认计划并存 = 确认死区** | 登记不阻塞（机制缺口） | 多个待确认计划并存时用户不能选择性确认，连「取消」也过同一个歧义闸，只能等 10 分钟 TTL；2026-10-30 实测被迫干等 5 分钟。确认面需支持按计划选择确认/取消 |
| **D-142 计划门逐字锚定不接受会话内已验证实体/别名** | 登记不阻塞（机制缺口） | 「还是按这12个科目」「去年12月→202512」被拒——会话历史内已验证的实体与别名不进锚定判据；恢复行为不稳定：同日 Q4b 重新检索锚定成功、Q8 直接复用历史名被拒 |
| **D-143 任务内 notify 计数超限后每步新计划都进 confirm 档（粘住不释放）** | **已修（17dz b424b26，2026-10-31：预算容量模型）** | plans.json 复盘更正初版归因（初版误写「累计估时>600s」）：当日 22 个 confirm 计划 21 个是 NOTIFY_REPEAT_LIMIT——任务内第 4 个 notify 族计划起一律升 confirm，且 confirm 被用户激活后 notify 计数不清零，后续每步再停门（CONFIRM_THRESHOLD 20 次/600 秒线当日仅命中 1 次）。设计本意是「试探收口」（防 agent 在 notify 档反复改口径磨大执行面），但 serve-gate 要求每次网关调用都要 active plan，正常多步任务/按对象拆步的扇出必然攒满 3 次 notify：2026-10-30 实测 10 账套扇出 = 每步一次人工确认，巡检类任务不可用。**修法落地**：账本单位换 operation 权重（operations.json weight 列），容量内只通知不停、触边一次确认即扩容（grantLevel，三线阈值同乘）；maxNotify/maxReplans 降级为磨大辅助判据（声明−执行差额 >30 才执法）；判据详见 17dz docs/architecture.md「预算容量模型」 |
**本波最终账**：新立项 4 条（只立项不实现）；评测语料沉淀 probe-Q5b / probe-Q13b（inBaseline=false）；答疑口径判据结晶进 17dz 仓 finance 域 MECHANISMS.md。

## 补充记录（2026-10-31，预算容量模型落地后的复跑验收：D-144 新立项）

17dz b424b26（预算容量模型，D-143 修复）当日复跑验收：今日 34 张计划 **0 个 NOTIFY_REPEAT_LIMIT、0 个 REPLAN_LIMIT**（昨 21+若干），confirm 仅剩 3 个 CONFIRM_THRESHOLD（其中 Q1 批单 73 重触边一次确认后 grantLevel 续跑），HARD_WEIGHT 新硬线拦下一次真实超重路线。Q1 从 6 轮 2238s 降到 5 轮 754s（含 1 次偶发 executor_error 与 1 次 TASK_NOT_FOUND 恢复轮）；Q9 扇出单轮推进 1.9/10 家（昨日 3 轮 1/10 家）。复跑暴露一个新缺陷：

| 条目 | 状态 | 说明 |
|---|---|---|
| **D-144 续跑回合终稿出口泄漏 route_current_turn 工具协议原文** | **已修（2026-11-01 出口收敛波，change-safety §23）** | 2026-10-31 实测：`confirmed_plan_resumed` 回合（多步扇出第 3/10 步申报时）终稿把 `<tool_call><function=route_current_turn>…` 协议原文整段上屏给用户——出口第三支（2accb20，D-136/D-138）未覆盖"续跑回合的下一申报成为终稿"路径。同轮另见 `route_declaration_invalid`（申报 schema 不合法被拒）先兆。**修法落地**：protocol-material 新增整段申报窄判据（XML 标签外一无所有 / JSON 首键 kind 且解析成申报键）；reply-exit 整段替换支（先于删除支，fallback=worker 整理文本）；resume 与确认直达出口全部接终稿一把尺，转录只留用户收到的那一版，`route_declaration_reply_replaced` 留痕 |
| **D-145 b424b26 预算容量模型的 fshine e2e 期望未同步（4 用例）** | **已修（2026-11-01，期望滞后部分——4/4 全部为 fixture 串场，无真回归）** | 2026-11-01 真·main 基线实测（§23 F1）：全量 1783 通过 / 4 失败——`turn-loop-plan-gate-boundaries` A2×2、`turn-loop-confirmation` 2.7、`turn-loop-pingpong` 8.1。**归因实测修正**（旧平台 worktree 对照：pre-b424b26 平台上 2.7/A2·NOTIFY 上沿回绿、A2·AUTO 上沿/8.1 仍红）：只有 2 例是 b424b26 权重线（A2·NOTIFY 上沿 10×6=60 ≥ budgetWeight 60 升 confirm；2.7 见下），另 2 例是**估时秒线**——query-receivables est_seconds 15→60 出自查账换芯 cda6ba9（2026-10-28，PR !2），先于 b424b26：A2·AUTO 上沿 2×60=120 > autoSeconds 60 出通知帧；8.1 续跑计划累计 60+60=120 > 60 出 +2 通知帧。**修法落地**：不重写断言——harness 新增 `neutralizePlanGateNonCallLines()`（权重线 4 键 + 秒线 4 阈值全设 1e6，onTestFinished 恢复防泄漏），4 用例各注入一行，档位判定回到纯次数线，断言原语义继续成立；mock 查询每条 weight 6/est 60s 是串场源。**2.7 判定=期望滞后非真回归**：turn-1 worker run 内同任务先 21 调确认档再 1 调轻量计划，权重线下累计 taskWeight 126+6=132 ≥ budgetWeight 60 把轻量计划也推到 confirm 档（旧语义 1 调 ≤ AUTO=2 直执行并取代旧计划），待确认记录变成在世轻量计划，"确认继续"正常激活它（confirmed_plan_resumed，收到整理台词）——取代/确认语义未被改坏；登记时怀疑的「stop 跳过 supersede 标记」路径被证伪：该计划 decision=confirm 非 stop（132 < hardWeight 180），supersede 循环有执行（旧计划已标 superseded），且该守卫 b424b26 前后逐字相同。**8.1 判定=期望滞后非真回归**：路由/转录断言全过，唯一失败是通知帧数（秒线所致）。17dz 零改动；清偿后全量实测 132 文件 / 1795 通过 0 失败（基线 1783+4 之后 main 又入了 8 个新测试），typecheck 干净 |

**本波最终账**：D-143 已修验收通过；D-144 立项。复跑另两项观察（未立项）：①确认续跑后 worker 偶发 executor_error（task_144c9690，重发即通，原因未定位——频次高再立项）；②逐户反查路线受 maxVariants=3/调用 限制（Q2 9/63 户后登记额度用尽，差额 87,654 如实披露）——逐户扇出天然超变体额度，正解仍是导出文件本地解析路线。

## 补充记录（2026-11-04，纯编排波流程债对账：F4）

本节是 debt/process-debt 分支的补档（只改文档/台账，不改生产代码与测试接线）。核实范围：fshine 仓 `origin/main`（`33c1a31`）→ `91bf841` 的纯编排波；change-safety §24 为本节的波次侧记录。以下编号 D-146–D-149 为本节新立项，D-145 之后顺延。

### 对账：architecture-laws「当前违例」节 × 台账（零同步核查）

| 律法节 | 律法现状 | 台账现状 | 对账结论 |
|---|---|---|---|
| L1 词汇边界 | 真违例均已清，防御排除在册 | D-001/D-002/D-003（D-030）已关；D-004/D-005 在 Wave 2 关账记录中已关（词表 6→15、扫描扩到 apps/） | **无差**（主条目 D-004/D-005 仍写待办是历史条目未翻状态，关账记录为准；本节不改写历史条目，只在此声明口径） |
| L2 网关名 | 代码字面量已收敛至 1（配置缺省值），grep 总量 10 另记 | D-010 主条目仍写待办 | **无差（第四轮）**：见 D-146，闭环判据 (a) 已成立 |
| L4 写路径保险箱 | 编排层侧已清，整体保持开放（D-031 的 17dz §17 七项未闭环） | D-030 已关，D-031 待办 | **无差** |
| L5 失败二分流 | 无违例，转不变量；既有熔断清单未含步数帽 | 步数帽此前无台账条目 | **有差，已补**：L5 清单补步数帽收尾提示（非熔断，见 D-147）；提案复核 fail-closed 标定见 D-148 |
| L6 零沉积 | step-text 死分支、17dz 会话日志、`.env.real` 三项在列 | D-052 待办、D-053 待办、D-054 接受不修（仓库侧已关） | **半差，已补**：律法 `.env.real` 行补 D-054 标签（接受不修，仓库侧已关）；其余两项与台账一致，无差 |
| L7 可信度可量化 | 无违例，转不变量 | D-060 已关 | **无差** |

### D-146 · L2 网关名字面量残留面：注释与配置示例里的 9 处未派生

- **位置**：`grep -rn "bin/17dz" packages/*/src apps/server --include='*.ts' | grep -v '\.test\.ts'`（第四轮实测，10 行）：代码字面量 1 处（`platform-contract.ts` 的 `GATEWAY_INVOCATION` 常量）；非代码 9 处——`serve-gate.ts` 注释 6 处、`plan-runtime.ts:122` 注释 1 处（5426a85 新加，旧记账漏列）、`pi-coding-driver.ts` 注释 1 处、`contracts/config.ts` 配置示例注释 1 处。main 同口径为 8 行，PR 为 10 行，总量"只减不增"不成立，如实记账，不写成已成立。
- **根因**：D-010 的收敛只做了代码派生，注释与示例未跟进。注释字面量不进执行路径，故不是 L2 的执行面违例，但"网关名只剩一处"的律法表述按字面 grep 是不成立的（10 ≠ 1），后人按字面复核会误判律法已破。
- **律法归属**：L2。
- **闭环判据**：二选一——(a) 律法 L2 的表述收窄为"代码字面量只剩一处"（注释/示例除外，并写清 grep 口径）；(b) 9 处注释/示例改由常量名或"网关名见配置"措辞替代，grep 总量回到 1。**本轮选 (a)**：`docs/architecture-laws.md` L2 条目与闭环判据已收窄为代码字面量 ≤1，口径写清注释/示例除外、grep 总量 10 另记；不选 (b)，改 9 处注释凑 1 会扩大 diff 且与"注释不进执行路径"的定性冲突。
- **建议波次**：文档小刀，随下一波顺手做。
- **状态**：已关（闭环判据 (a) 成立；总量 10 与 main 8 的差额是注释面，不再由本条背账为执行面违例）。

### D-147 · 新硬控制标定：步数帽 50（未证实标定依据，登记为待标定）

按 architecture-laws「控制的标定审查」三问作答（该节格式即：硬/软、标定依据、误拦→自愈）：

- **位置**：`packages/agent/src/worker-step-cap.ts`（`DEFAULT_WORKER_STEP_CAP = 50`；`stepCapDecision`：gateCalls > cap 时 windDown；`createStepCapWindDown`：只送一次）；驱动接线 `pi-coding-driver.ts`（`91bf841` 计数分区修复后，计数无条件、收尾只当副作用）。
- **硬还是软？** **硬触发、软后果**：第 51 次放行必然触发一次收尾 steer（代码级确定性，模型绕不过触发本身），但后果只是提示——不拒单、不停轮、不熔断。真正的硬上限仍是 wall-clock 预算与计划权重帽。
- **标定依据是什么？** **答不出数据依据**：代码与接口文档均未给出事故或数据证明"50"该拦这个范围。50 是可配置的默认值（`stepCap` 选项 / `FSHINE_WORKER_STEP_CAP`，非法值回退 50），收尾提示复用 90% 预算收尾同款文案。按律法纪律，答不出的控制登记为待办，不得写成"经实测标定"。
- **它误拦什么正当行为、被拦方的自愈路径是什么？** 误拦：合法长任务（>50 次廉价调用，如多步扇出）会被提前催收尾，可能交付未完成；自愈：提示不拒单，worker 可继续调用，续跑靠交接文件；操作方可调大 cap。**反向缺口（漏拦方向）**：忽略提示的 worker 不会被拦——帽不是硬上限，长空转仍可能发生，须靠 wall-clock 与权重帽兜底。
- **律法归属**：L5（有界回路的收尾提示，非熔断）。
- **闭环判据**：给出 50 的数据依据（历史任务步数分布，或至少一轮"50 误拦率 vs 51+ 空转拦截率"实测），或把 50 明确降格为"未标定默认值"并写进接口文档；二选一。
- **变异留档**：change-safety §24 G1/G2/G3（阈值 `>`→`>=` 2 红；只送一次删 `sent` 1 红；分区 local 计零 4 红，均已还原）。
- **状态**：待办（待标定）。

### D-148 · 新硬控制标定：提案复核 fail-closed（标定已答，死循环面另立 D-149）

按标定三问作答：

- **位置**：`packages/agent/src/context.ts` 创建路径（`92f7ed8`）+ `packages/agent/src/proposal-review.ts`（`mechanicalReview`）+ `packages/agent/src/operation-labels.ts`（`parseProposalSchema`/`loadProposalSchema`）+ `apps/server/assembly.ts`（注入 `reviewProposalWithDriver(contextModelDriver)` 与 schema 取问器）。
- **硬还是软？** **硬**：无复核驱动 / schema 未下发或非法 / 复核不一致 → 一律不发确认码、不落意图（fail-closed），`proposal_review_skipped` 分支已删除。
- **标定依据是什么？** P2 前状态的洞：生产装配当时未注入复核驱动、schema 取问接口缺失，旧分支记一条 skipped 日志就继续——复核名义上存在、实际上可被跳过。`92f7ed8` 关掉该洞是标定修复，不是新增无依据的控制。
- **它误拦什么正当行为、被拦方的自愈路径是什么？** 误拦分两类：(a) 复核模型误判不一致——属模型侧波动，重发可能通过（非确定性）；(b) 平台未下发 schema 或驱动未注入——属确定性部署/平台缺陷，重发必败，且文案只说"请重新发起录入"（见 D-149）。(a) 的自愈是重发；(b) 目前无自愈路径。
- **律法归属**：L4（写路径保险箱的确认门）+ L5（失败有界：不发码即不进入确认态）。
- **闭环判据**：(b) 的自愈路径落地（D-149 的方案之一）或 (b) 的文案改为可行动信息；(a) 保持现状（重发即自愈）。
- **变异留档**：change-safety §24 G5/G6/G13（机械复核 schema 检查失效 1 红；schema 数组放行 1 红；驱动必注入失效 1 红，均已还原）。
- **状态**：待办（仅 (b) 面开放；fail-closed 本身不拆——用户已明确否决"拆安全机制"式修法）。

### D-149 · 提案 schema 缺失分支给用户"请重新发起录入"是死循环（已知限制，登记不修）

- **位置**：`packages/agent/src/context.ts` 创建路径（`92f7ed8` 后的形态，2026-11-04 实测）：无驱动分支（约 863 行）、schema 缺失分支（约 869 行）、复核不一致分支（约 889 行）三处 workerText 均含"请重新发起录入"。本条只针对 schema 缺失分支；另两处见区分。
- **核实（代码路径）**：创建顺序是"平台办调 create 成功（已拿到 proposalId）→ schema 取问（`proposalSchemaLoader`，缺省 `loadProposalSchema`：读 `operation list --json` 的 `proposal.create` 行 `proposalSchema` 列，非空普通对象才算下发）→ 缺失则直接失败"。失败返回点在 `changeIntents` 落意图与同任务旧 pending 作废**之前**，因此：① 平台侧提案已创建且保持 pending，不被宿主作废；② 用户按文案重发时，宿主会重新办调 create，拿到**新的** proposalId，schema 取问仍对同一平台取问同一列——平台未修复则结果同一，循环成立；③ 每次循环都在平台侧多留一个 pending 提案（孤儿累积）。
- **触发条件（精确）**：部署的平台 `operation list --json` 里没有 `proposal.create` 行，或该行无 `proposalSchema` 列，或列值非普通对象/为数组。只要该条件成立，同一部署下的任何提案创建都会走到本分支，与用户输入内容无关——用户侧无法通过"换一种录入方式"自愈。
- **与另两分支的区分**：确认码过期/不可用分支（`expired`/`unreadable`）说重发是合理的——旧提案已过期或不可用，重发是新提案的正当语义；复核不一致分支可能是模型波动，重发可能通过。本条的死循环只属于 schema 缺失这一确定性分支，不得把三处文案混为一谈。
- **自愈路径（方案，未在本分支落地——本分支只改文档/台账，不碰生产逻辑）**：① 区分确定性与偶发：schema 取问失败时把失败原因结构化留痕（无行 / 无列 / 非对象），文案改为可行动信息而非重发指令；② 同提案重试：已拿到 proposalId 时，重试应复用该 proposalId 重跑复核（重取 schema、重跑复核），而不是重新办调 create 造新提案；③ 升级条件：schema 连续缺失时不再让用户循环重发，改为运营介入项（核查平台 emission 与版本，确认修复后再重发）。三条中任一条落地且文案同步改掉，本条即关。
- **Workaround（今日可用）**：运营先在平台侧跑 `operation list --json`，确认 `proposal.create` 行带合法 `proposalSchema`；确认前不要让用户重发。已产生的孤儿 pending 提案须在平台提案状态库里人工核对（宿主侧无意图记录，无法代为作废）。
- **律法归属**：L5（失败二分流：本应是"平台/部署对齐"类失败，却被包装成"用户重发"类）+ L4（确认门文案）。
- **闭环判据**：schema 缺失分支的文案不再是无条件重发指令，且同 proposalId 重试或运营升级二选一落地；或平台 emission 被证明在所有部署下必带 schema（则本分支退化为不可达的防御，文案可保留）。
- **状态**：待办（已知限制，登记不修——本分支的硬约束是不碰生产逻辑，故不以代码修复冒充已修）。

### D-150 · 跨仓预算校验的 CI 边界（已知限制，登记不修接线）

- **位置**：fshine `scripts/cross-repo/check-budget-thresholds.mjs`（`check:cross-repo-budget`）与 `packages/agent/src/budget-policy-cross-repo.test.ts`；`scripts/ci.sh` 三步 gate 与 `.github/workflows/ci.yml`（只调 `ci.sh`）均不跑该校验。
- **已知限制（按 `docs/e2e-ownership.md` 的“已知限制”格式登记，不冒充已接线）**：默认 `npm test` 的绿灯**不含真跨仓比对**——`budget-policy-cross-repo.test.ts` 的真实两仓用例在未设 `CROSS_REPO_17DZ_ROOT` 时 skip，用例名写明 skip 原因；真比对需显式设 `CROSS_REPO_17DZ_ROOT=<17dz 检出根目录>` 后跑（脚本对真实检出实跑 12/12 一致是手动证据，不是 CI 证据）。CI（`ci.sh` + `ci.yml`）目前只跑 typecheck + unit + generic-mock，不跑 `check:cross-repo-budget`，这一点在本条登记前在 debt-ledger/change-safety 里零登记。
- **不改的说法（登记不等于改接线）**：`budget-policy.ts:14-22` 与 17dz `docs/architecture.md:402` 里“漂移由机械校验兜底”的表述**不改**——改表述而不改接线是换一种纸面，改接线（把校验接进 CI）是另开一题；本条只登记边界，不以登记冒充接线已落地。闭环判据二选一：(a) 校验接进 `ci.sh`/CI 并有一次 CI 绿灯证据；(b) 本条登记被后续评审接受为长期已知限制并写进 CI 文档的 scope 说明。任一成立即关。
- **状态**：已关（闭环判据 (b) 成立：2026-11-05 第六轮合并就绪评审接受为长期已知限制，CI 文档 scope 说明已写进 `scripts/ci.sh` 头部；接线仍不做，边界性质不变）。

### D-151 · 跨仓预算校验正则劫持机制（曾存在、第四轮已修）

- **机制**：`scripts/cross-repo/check-budget-thresholds.mjs` 的两个解析器曾在未剥离注释的文本上做首匹配，块内/文件内同名旧值注释行会抢先命中。复核员端到端复现假绿：17dz 真值 autoCalls=7、其上有旧值注释行，脚本仍报 12/12 一致 exit 0。当前两文件干净时该机制不发作，是潜在面，不是已发生的漂移漏报。
- **修复**：解析前用字符串状态跟踪剥离 `//` 行注释与 `/* */` 块注释（不误伤字符串内的 `//`），再做首匹配；测试用 fshine 块内旧值注释 + 17dz 行上旧值注释的夹具钉住真值（断言 `autoCalls: fshine=2 17dz=2`，不剥离时该测试变红）。
- **边界（第五轮补登记，本条原文“跟踪字符串状态”不改写为“已处理正则”）**：`stripComments` 只跟踪字符串状态，**不识别正则字面量**。两个方向都要记清：① 误剥方向——正则里的第二个 `/` 会被当行注释，如 `const r = /a\//;` 会被剥成 `const r = /a\/`，字符类 `/[//]/` 也会被啃；② 欠剥方向——正则内含引号（如 `/'/`）会误开 quote 态，quote 态内的 `//`/`/*` 不再被当注释剥离，后续旧值注释行原样存活、可被首匹配劫持，**欠剥才是潜在假绿方向**。当前两个真实文件不发作：17dz `src/execution/plan.js` 的正则字面量只有 `/^\d{6}$/` 三处（第 316/377/400 行），不含 `//` 或 `/*`，不含引号，且都在 policy 阈值块之后，不在解析路径上；fshine 阈值块内无正则字面量。误剥方向即使发作也是 fail-safe（解析不到→exit 2，不会假绿）。**将来处置**：若真实文件出现含 `//`、`/*` 或引号的正则字面量，不要再靠本剥离器硬撑——届时需重做解析（例如只对阈值块所在行做行内剥离、或把正则行移出解析路径、或换用真正的 JS 词法扫描），不要写一个完整 JS 正则解析器来猜正则与除法的歧义（改动风险大于收益）；在那之前，任何含此类正则的文件改动都应先跑跨仓校验实测，确认不是假绿。
- **与 D-150 的关系**：D-150 只登记 CI 边界，本条只登记正则劫持机制，两条互不冒充；D-150 已按闭环 (b) 关闭（2026-11-05，见其状态行）。
- **状态**：已关（2026-11-05 第六轮合并就绪评审确认：修复与正则边界登记逐点复核属实——不对称块注释旧值钉子使只删 `/* */` 剥离分支时用例转红，D-151 边界段的误剥/欠剥两方向描述与 `stripComments` 实跑行为一致）。

### D-152 · 第四轮低危项（登记未做，随合并或登账，不冒充已修）

以下清单原样取自第四轮评审，本轮未逐条核实、未修复，留待后续主题分流；其中任何一条都不因本 PR 合入而视为已关：

- **测试卫生**：`runWithThrow` 与 `runWithStepCap` 助手逐字重复、`METADATA_BASH` 同文件二次声明、给旧助手加的 `steerThrowCount` 是死参数；`plan-budget-overlay.test.ts:120-125` 第 5 个 `it` 自称"非可跑用例"却登记成可跑用例、只重复已断言内容、永不可能红；`budget-policy-cross-repo.test.ts:114-119` 与既有两条用例合起来零增量判别力。
- **代码文案**：第二道防线抛错文案把档位归因给"plan evaluate 返回了"，但唯一可能的触发输入是宿主自己的 `decideBudgetTier`；`--fshine-root` 后跟旗标名会被吞成路径；decision 四档枚举全仓仍有 8 处副本，两张排序表逐字相同却无测试断言一致。
- **文档笔误**：change-safety 补充节只有 G15/G16 两行变异表，缺 F2 要求的逐 commit 用例数行、也没留守卫落地时的"现在红"证据；§24 两处既有笔误（`27cc43a` 解析不到、真名 `e27cc43`；波次规模写 35 实为 34）；`285fed1` 的五个跨仓钉子没有对应 F3 留档行；NOTES:253 与 :296 两条陈旧；`interface.md:241` "见收尾报告"悬空。
- **流程形态（2026-11-05 第六轮补记）**：`62d579a`（planDecisionRank 原型链修复）单独落地时 typecheck 红（`noUncheckedIndexedAccess` 下索引访问不收窄，`git archive` 抽树实跑 `tsc --noEmit` exit 2），由同 PR 的 fixup `646c8d9` 就地补齐而非 F5「红先 revert」——终态绿、未叠行为补丁，按 F2/F5 字面记一笔。教训：推 PR 前发现中间 commit 红，优先 rebase 消掉而不是留 fixup 让评审再抓一次。
- **状态**：待办（登记）。

### F3 未留档项（本补档未做变异，登记）

- gatedWorker 光标不重跑最后一段（`tests/e2e/harness-cursor.test.ts`，`c1b5967`）：测试存在，本补档未做变异（e2e harness 接缝，单进程变异成本与 flaky 风险另计）。补变异或登记为"测试存在、变异未做"，二选一留给后续主题。
- profile.gateway 的 spawn 路径 fail-closed（`gateway-profile.test.ts`「未声明 gateway 不回退旧值」）：测试存在，本补档未做变异，同上。
- 以上两项不计入 change-safety §24 的 G1–G14 已留档表，不得合并宣称"新守卫全部已变异"。

---

## 公开迁移 · 脱敏波（波次 1）新账

### D-153 · 脱敏波改写 eval 语料：corpusVersion 变，脱敏前的 eval 分数全部不可比

- **位置**：`scripts/eval/corpus.jsonl`（脱敏波 `bfa3a31` 把 incidents/expect 里的真实客户名与财务读数换成虚构值，id/kind/case/inBaseline 等判别结构一字未动）；`scripts/eval/score.ts:138` `corpusVersion()`（= sha256(语料内容) 前 8 位）、`:16` 三元组注释（corpusVersion / judgePromptVersion / judgeModel 任一变了分数即不可比，须重定基线）、报告落点 `score.ts:349`。
- **根因**：脱敏是内容级替换——语料字节变即哈希变。三元组里的 corpusVersion 已随本波改变，脱敏前跑分与脱敏后跑分不同基；重定基线前引用旧分数即造假。
- **影响面核实（不扩大）**：CI 三门不受影响——`scripts/ci.sh` 的 generic-mock 门用自持 fixtures（`scripts/eval/fixtures/dummy-platform`）与自带 baseline（`scripts/eval/generic-mock-baseline.json`），全文不读 corpus.jsonl（2026-11-05 实测 `grep -n corpus scripts/eval/generic-mock.ts` 仅命中注释行）；`scripts/eval/baseline.json` 实测无 corpusVersion 字段、无客户名与金额。
- **闭环判据**：重跑 `npm run eval:baseline`，且新报告携带的 corpusVersion 与脱敏后语料的 sha256 前 8 位一致；闭环前不得引用脱敏前的 eval 分数作任何结论。
- **律法归属**：L7（可信度可量化：eval 基线跑漂移，不靠审计轮次）。
- **归属波次 / 限期**：波次 5 前（公开库定稿前必须闭环，否则公开渠道无可比分数）。
- **状态**：待办。

### D-154 · e2e/探针/验收/smoke:commit:mock 耦合兄弟仓 mock seed 目录——脱敏改名后 Tier B 转红

- **位置**：`tests/e2e/harness.ts:38-39`（`PLATFORM_ROOT` 缺省指向 `../../../17dz-platform`，`CLI = <root>/bin/17dz`，真 spawn 兄弟仓 CLI）；兄弟仓 `src/execution/mocks/respond.js:50`（把 `fixtures/seed.json` 拷为 mock 状态文件）；该 seed 的账套键现行仍是脱敏前的真实名（fshine 侧夹具已按映射表改为 幻辰财税 / 幻辰实业有限公司 两支，seed 未动；真实→虚构对照只住映射表 `.sensitive-strings.replace.txt`，不在本文件重述），另两支 新兴五金 / 新兴建材 不在映射表内、两仓天然一致。
- **根因**：脱敏波只改了 fshine 一侧夹具名，兄弟仓 seed 未同批改名——两套名字对不上，经 mock 目录的 Tier B 链（tests/e2e、probe-real-agent、acceptance、smoke-real-platform、mock-commit-smoke）预期与实测失配。实例：`tests/e2e/turn-loop-disambiguation.test.ts:107` 期望「幻辰财税 202609 平台未返回该期间数据」，而 mock 应答仍按 seed 里的脱敏前键名组织返回。失配面只在被改名的两支。
- **处置边界（不冒充绿）**：本波不把 Tier B 写成绿，也不在本波重定任何基线；CI 三门（ci.sh：typecheck + unit + generic-mock）不 spawn 兄弟仓、自洽不受影响（实测）。seed 同步改名是 mock-only 机械替换，合 D-076 纪律。
- **闭环判据**：兄弟仓 seed 与 respond 夹具按同一张映射表同步机械改名后，`FSHINE_PLATFORM_ROOT=<17dz 检出> npx vitest run tests/e2e` 全绿；同步前 Tier B 红是已知状态，任何报告不得写成绿。
- **律法归属**：L2（跨仓面：mock seed 住兄弟仓、fshine Tier B 链消费它，两仓夹具改名未同批——与 D-015「17dz mock 夹具手抄、无机械锁」同族）。
- **归属波次 / 限期**：W5 前（结构化调用协议波次要以 Tier B 全绿作证据）。
- **状态**：待办。

### D-155 · config/agent.example.yaml 的 5 处 17dz 名词无任何守卫覆盖（含 contextProfiles 结构键）

- **位置**：`config/agent.example.yaml`（部署模板，5 处 17dz：注释里的授权账套 id 说明、`17dz:` profile 段、`root: /path/to/17dz-platform`、`gateway: bin/17dz`、自动登录凭据说明行）；`config/` 目录整体在 `packages/agent/platform-leak-lint.test.ts`（SCAN_DIRS = packages/apps/scripts）与 `packages/agent/docs-reality.test.ts`（只扫 `packages/*/src` + `apps/server`）两把尺的扫描范围之外。
- **根因**：两把尺的扫描范围都按"编排层源码"划定，`config/` 是部署模板、不在其内；于是模板里的执行层实例名词既没有词预算约束，也没有对账判据。exposure-lint 扫 `git ls-files` 全量，该模板的暴露三类（UserID 占位符 / 内部路径 / 客户名）实际已被覆盖——**缺口仅在 17dz 名词这一类**。
- **影响面核实（不扩大）**：模板是示例文件、不进运行态（真实 `config/agent.yaml` gitignored）；本波不为它单开守卫，收进 gate① 对账一次清。
- **闭环判据**：gate①（产品面 `git grep -i 17dz` = 0，例外 = debt-ledger/change-safety/AGENTS.md）对账时该文件零 17dz，且 `contextProfiles` 的结构键随 W1 完成参数化（profile id 是结构键而非注释，不能靠文本替换糊过去）。
- **律法归属**：L1（词汇边界：业务/实例词汇只住执行层 + 夹具 + 文档，模板不在词预算扫描范围内）。
- **归属波次 / 限期**：W1 / 波次 4；限期 = 波次 4（门面按终局写时一并处理）。
- **状态**：待办。

### D-156 · 两支真实读数（61,000 / 86,000）未替换也未收词——守卫 D 类缺口

- **位置**：`docs/debt-ledger.md`、`docs/rule-landing.md`、`docs/change-safety.md` 的叙述（把 86,000 / 61,000 当真实验收结果引用，如 rule-landing.md「真实数据（86,000）旁边编造了…61,000」）+ 约 28 个文件的夹具与断言（`tests/e2e` 各 turn-loop、`packages/agent` 多个测试、`scripts/probe-real-agent.ts` 等，含无千分位形 61000/86000）。
- **根因**：这两支是真实平台查询读数，先作为 e2e 夹具"真值"落进 mock 数据，再被 docs 叙述引用；脱敏波映射表 E 组未收它们，`exposure-lint` D 类因此也没有防复发判据。同族的另一处差额读数（守卫条目 F15）已按"登记与替换必须同一批"的纪律在 `fbab7d7` 补掉（收词 + 替换同批），本条是剩下的两支。
- **影响面核实（不扩大）**：现行树客户名已虚构化，夹具里这两个数与虚构主体配对，单独看不构成"真实主体 + 真实读数"的完整暴露；但 docs 叙述把它们当真实验收结果引用，属真实读数引用。**不得**因为"夹具里是 mock 数据"就整条不登记——那样 docs 侧的引用永远没有判据。
- **闭环判据**：两支读数在全树（docs 叙述 + 夹具 + 成对断言）机械替换为虚构值（同一 commit 内成对输入/期望同步换，判别力保留），且 `exposure-lint` D 类收词后零命中；替换后 `npm run test -- --project unit` 与 Tier B 的失败集合不得相对替换前扩大（Tier B 按 D-154 已知红者除外）。
- **律法归属**：L6（零沉积：陈旧/沉积数据进主干且无守卫，与"17dz 仓根 465KB 会话日志被跟踪"同族）。
- **归属波次 / 限期**：波次 5 前（公开库定稿前必须闭环；执行波次随脱敏补批或并入波次 4 门面对账，届时两仓夹具同批）。
- **状态**：待办。

### D-157 · 历史敏感面守卫（HG1）的覆盖边界 + 替换表 v2 的收词缺口（波次 2 C1 实跑发现）

- **位置**：`packages/agent/history-hygiene.test.ts`（HG1，形态守卫）+ `scripts/history-sensitive-scan.sh`（G1b，逐串扫描）+ gitignored `.sensitive-strings.replace.txt`（`git filter-repo --replace-text` 输入，由波次 1 映射表 v2 生成）。
- **根因**：两侧都是"按形态 / 按表"判定的机械守卫，判定面由形态定义与收词范围决定，天然有边界。C1 实跑（2026-11-05，HEAD = `598e4c6`——重写前 SHA、切割后不可解析，以位置与 subject 为准——全 ref）把边界量了出来：
  1. **HG1 只认形态**：UserID 字面共 22 行，带前缀形态只覆盖 4 行，另 18 行是裸常量（赋值形态）；客户名 / 真实读数 / 事故附件名没有任何共同形态。缺口由 G1b 逐串扫描兜底，两者缺一不可。
  2. **替换表 v2 未收、但别处已登记为敏感的串**（重写后逐串扫描仍会红，需 owner 拍板后按"只增不减"补收）：守卫条目 F15 的那支差额读数（现行树已替换，历史 6 行）；D-156 的两支读数（历史 79 / 129 行）；change-safety §25「未做/已知项」点名的通用测试人名与兄弟仓 mock seed 自造样本名三支（历史 617 / 261 / 161 行）；真实事故附件名（历史 66 行）。对应波次 2 openDecisions 4 / 5 / 7。
  3. **执行层平台名词**：历史 3550 行（其中带仓根形 396 行、提交信息 144 行），既不在 HG1 四类内也不在表内——对应 openDecisions 3，未拍板前不得自行补进表。
- **影响面核实（不扩大）**：以上都是"判定面没覆盖"，不是"守卫失效"。HG1 的四类与 G1b 的表内 34 条在各自判定面内都实测有效——红态计数与 change-safety §25 留档的历史计数表逐条对上（同口径 `git log --all -p | grep -Fc`，HEAD = `598e4c6`（重写前 SHA、不可解析）：U1 = 22 行、C1 = 2822 行、C11 = 498 行、C3 = 416 行、F12 = 60 行，与 §25 表同值；该表测于 `2c41d48`（同为重写前 SHA），其后每个 commit 只让计数增、不让它减）。**不得**因为"还有没覆盖的"就把四类断言放宽——那会连已覆盖的部分一起废掉。
- **闭环判据**：owner 对 openDecisions 4 / 5 / 7 / 3 拍板 → 替换表按"只增不减"补收（每条配 sha256 前缀，与 `exposure-lint` 禁词表交叉核对）→ 重跑 filter-repo → `scripts/history-sensitive-scan.sh .sensitive-strings.replace.txt` 退出码 0 且 `npx vitest run packages/agent/history-hygiene.test.ts` 绿（含两条正向锚点）。
- **律法归属**：L6（零沉积）+ L2（同一事实只存在一处：替换表不得有第二份）。
- **归属波次 / 限期**：波次 2 C2 实做前（重写落地即把缺口固化成"公开库已知残留"，越晚拍板越贵）。
- **状态**：待办。

## 公开迁移 · 历史重写波（波次 2）新账

### D-158 · gitee 上 26 个 refs/pull/* 残留（指向重写前提交，用户决定不删 PR）

- **位置**：gitee 私有仓 `git@gitee.com:phona/fshine-agent.git`（本仓 origin）的 26 个 `refs/pull/{1..13}/{head,MERGE}`，完整清单（全部指向重写前提交）：`refs/pull/1/head=2accb20a`、`refs/pull/1/MERGE=bf602a44`、`refs/pull/2/MERGE=8d8542f1`、`refs/pull/2/head=c1b5967f`、`refs/pull/3/head=10874385`、`refs/pull/3/MERGE=307da988`、`refs/pull/4/MERGE=61bb7dea`、`refs/pull/4/head=7db31cbe`、`refs/pull/5/head=5426a85a`、`refs/pull/5/MERGE=631375c5`、`refs/pull/6/head=085a26fd`、`refs/pull/6/MERGE=bb9e15f9`、`refs/pull/7/head=1734dd5e`、`refs/pull/7/MERGE=8d14afce`、`refs/pull/8/head=29b78f0d`、`refs/pull/8/MERGE=823209ce`、`refs/pull/9/MERGE=3835735b`、`refs/pull/9/head=d7c6ed65`、`refs/pull/10/MERGE=70b45f3f`、`refs/pull/10/head=87ca65f4`、`refs/pull/11/MERGE=1aad24d2`、`refs/pull/11/head=646c8d93`、`refs/pull/12/head=10874385`、`refs/pull/12/MERGE=9955c354`、`refs/pull/13/MERGE=098c8b8a`、`refs/pull/13/head=89e605ec`。2026-11-05 实测 `git ls-remote origin 'refs/pull/*'` 返回 26 条、与清单逐条一致（其中 `refs/pull/3/head` 与 `refs/pull/12/head` 同为 `10874385`）；本仓本地无 `refs/pull/*` ref，残留只在 gitee 侧。
- **已知限制（登记不修，不冒充已清）**：force-push 重写 main/分支不会移除 `refs/pull/*`——PR 记录与其 ref 在 gitee 侧独立存活，C2 重写后这 26 个 ref 仍指向重写前（含敏感串）的提交对象，旧历史在 gitee 侧继续可达。删这些 ref = 删 gitee 上对应的 13 个 PR 记录（不可逆）。用户 2026-11-05 决定不删、登记残留。
- **风险边界**：gitee 是私有仓，残留仅对有仓访问权者可见；公开 GitHub 库永远只收干净历史。normal clone 的干净判据 = fresh clone 逐串零命中 + `npm run ci` 全绿：change-safety §26 定本地 fresh clone（G4）为真判据，`npm run ci` 三门全绿已实测留档于 §25；fresh clone 两级逐串零命中属波次 2 C2 的 S7/G4 验收门（迁移基线 `out/parts/07-wave2-b.md`）——**重写已于 2026-11-05 20:14 落地，S7/G4 已在切割段实跑通过**（34 串逐串 TOTAL=0 + fresh clone `npm run ci` 全绿，留档于 §26「fresh clone 判据」段），本条初版「重写未做故该门尚未跑」的表述作废。
- **闭环判据**：gitee 仓库删除/归档，或用户改主意删 PR——任一发生即关。
- **状态**：登记不修（用户 2026-11-05 决定不删 PR，残留登记在案）。

### D-159 · 波次 2 第二轮验收的文档精确性残留（2 中危已修 + 9 低危登记）

- **位置**：`docs/change-safety.md` §25/§26、`docs/debt-ledger.md` D-157/D-158、`packages/agent/history-hygiene.test.ts`、`scripts/history-sensitive-scan.sh`、`~/fshine-agent-pre-rewrite-2.bundle`、mirror `.rewrite-rehearsal/`。
- **本 entry 落盘前已直接修掉的（2026-11-05， dwfrun-5d0c895d 收口轮之后的补充处置）**：① `fshine-agent-wave1` worktree 的 7 个 staged 陈旧文件（与 wave2 同族、方向相反地把虚构平台名改回真名）已 `reset --hard` 丢弃——两个 worktree 现均干净；② 提交数分解已补写进 §26（380→379、main 352→351、merge 7→7、现行 --all=382），计划书验收 [8] 原口径（358/352/352−N）作废；③ 守卫头字节数Claim 改口径（12MB 量级 + 指向 §26 实测节），不再钉某个会过时的精确值；④ §25 与 D-157 的重写前 SHA（`44a84a6`/`2c41d48`/`598e4c6`）全部加「不可解析」标注，`b4f4668` 提交信息里「删掉全部悬空 SHA 引用」的Claim 自此为真；⑤ D-158 初版「重写未做故该门尚未跑」已订正（S7/G4 已实测通过）。
- **登记不修（9 项低危，逐条评估如下，不冒充已清）**：
  - **a) 验收 [5] 字面主义**：守卫红输出除四类计数外还含两条正向锚点计数，条目字面要求「只能包含四类命中计数」未满足。评估：意图（无基础设施故障混入）已实证——守卫不读表文件、cwd 从 `__dirname` 解析、maxBuffer 64MB 不触 ENOBUFS、变异①失败输出只有类别计数与归因。锚点计数是「证明重写发生过」的判据，删它等于删一个正向证据。§26 已自行登记该偏离。
  - **b) 验收 [0]/[1] 交付态不可执行**：替换表按设计已从磁盘清除（它本身就是泄密面），实跑 `history-sensitive-scan.sh` 得 exit 2 是契约正确行为（缺表=扫不了，不当通过）。表内 34 串的 exhaustive 实证留在演练门（34/34 TOTAL=0）与切割段 S7；交付态只剩字面抽查代验。
  - **c) 验收 [11]/G4 前提未写在条目里**：普通 clone 检出的是 main，HG1 只在 `wave2-history-prep` 分支——plain clone 跑守卫必 exit 1（No test files found），须先 `git checkout wave2-history-prep`。条目文字缺这个前提，不是仓库缺陷。
  - **d) `~/fshine-agent-pre-rewrite-2.bundle` 存着弃用的 `5395b798`**（QQ 邮箱署名的 D-158 初版，mailmap 之后、身份切换之前留下）：现行历史已全部 noreply、该对象不在本地 ODB，仅本地 bundle 内有，无门禁影响；§26 未记这次弃用重提的动线。
  - **e) `.rewrite-rehearsal/tree-before.txt` 未产出**（S1 配方声称有）：`old-main.txt` 与 `refs-before.txt` 在案，tree 快照缺失不影响任何判据（判据用的是 ref 快照与逐串扫描）。
  - **f) 「工资表2026-8月」分类表述不一致**：守卫头把它列入「通用测试名/seed 自造」，但 §25 已知项名单里没有它——它是 D-111 真实事故的用户附件名，走 openDecisions 7 / D-157 另一条决策路径。机械断言不受影响（HG1 四类本就不覆盖它），不一致只在散文。
  - **g) §25 名单里的胜利/宏大贸易/机电贸易有限公司未进守卫头那四条通用名**：同 (f)——不覆盖即不误伤，清单与守卫头的列举范围本就有不同职责。
  - **h) 波次 1 遗留三条**（见本轮 findings）：§25「全树约百处」实为 1233 处/136 文件；D-154「位置」字段指向的 `.replace.txt` 已按设计删除（权威来源实为 exposure-lint 的 SENSITIVE_ENTRIES + 生成口径）；D 类 15 条读数只登记千分位形（无千分位形历史零出现，潜在不对称非现存漏网）。
  - **i) §26 与 D-157 的个别计数为时点值**（12.06–12.11MB / 380–382 commit 随提交增长）：各节已写明「引用前按当时 HEAD 复跑」，本条再统一提醒——这些数只能当量级与「不少于」读。
- **闭环判据**：波次 4 门面文档统一关账时连同 (a)–(i) 逐条关闭，或 owner 接受为长期已知限制并在此条写明接受理由。
- **律法归属**：L7（可信度可量化——登记项也必须有可判据的关闭条件）+ 执行纪律 4（文档主张与代码现实对账）。
- **归属波次 / 限期**：波次 4（门面对账波）前。
- **状态**：登记（2 中危已修；9 低危待波次 4 文档关账或 owner 接受）。

## 公开迁移 · 身份参数化波（W1）新账（2026-11-06 关账）

### D-160 · W1 provenance 移入（源码注释的史料原文，C8 移出后唯一留存处）

W1 C8 把源码注释里有史料价值的出处注记改为中性指向（「出处见 debt-ledger」），原文唯一留存处 = 本条。改写前逐字原文按文件归档：

- **packages/agent/src/budget-policy.ts（5 处）**：
  ①「阈值缺省值逐字对齐 17dz `src/execution/plan.js` 的 policy() 缺省（calls 2/10/20/50，seconds 60/180/600/1800，weight 6/18/60/180），目的是让宿主裁档与执行层裁档在缺省配置下同口径」；
  ②「漂移由跨仓机械校验兜底：`scripts/cross-repo/check-budget-thresholds.mjs <17dz 检出路径>`（或环境变量 `CROSS_REPO_17DZ_ROOT`）逐键比对，不一致即 exit 1、解析不到即 exit 2；改任一仓阈值必须同批改另一仓」（该行现挂 `// identity-defer: W4` 签，变量名未改）；
  ③「17dz policy() 另有 4 个平台门专属项（grindGap 30、maxNotify 3、maxReplans 8、maxVariants 3），宿主叠加档不实现磨大守卫与变体预算，故有意不镜像」；
  ④「与 17dz decision() 的 tie-break 一致，旧调用方认的词汇不因权重线改口」；
  ⑤「operation 权重缺省换算（与 17dz weightOf 同口径，业务无关）」。
- **packages/agent/src/error-codes.ts（5 处）**：
  ①「fshine 侧错误码表（镜像 17dz `src/lib/error-codes.js` 的结构与纪律：错误即数据）」；
  ②「必须说清差在哪，绝不让参数问题长得像权限问题（17dz 同款事故形态）」；
  ③「纪律（与 17dz 表相同）」；
  ④「内容与平台 `17dz-platform/src/execution/plan-schema.json` 的声明一致」；
  ⑤「统一入口（镜像 17dz 的 messageFor）」。
- **packages/agent/src/platform-contract.ts（12 处）**：文件头「17dz-platform 公共契约适配层」、网关名与 `contextProfiles['17dz']` profile id 的对应、Package 1 收窄口径（17dz 执行代码不动、执行端门先留）、信封静态列（17dz `lib/envelope.js` emit 出口）、AUTH 四档出处（17dz 错误码表登录态组 + `src/lib/error-codes.js`）、不可用族集合出处、playwright 超时语义（17dz 对 playwright 的行为约定）、errorFor 挂码载体、`CODE:` 前缀渲染格式（17dz 错误码表格式）、语义已对照 17dz-platform 源码核实的声明、「未声明静默等同于 17dz」的回退风险描述（C7b 后风险已消除，措辞改「某个实例的网关名」）。
- **packages/agent/src/platform-mock.ts（1 处）**：「对接 17dz-platform 的 executor 开关，commit 376ea0d」（commit 引用指向 17dz-platform 仓历史）。

- **闭环判据**：无关闭条件——本条是长期史料归档（上述机制仍然在线，出处名不再住源码）。
- **律法归属**：L2（协议单一来源的注释面收尾）。
- **归属波次 / 状态**：W1 C8/C9；已归档。

### D-161 · 中性缺省值拍板项：run_task / 「执行层子 Agent」按方案推荐值落地，待 run owner 确认

W1 draftsForApproval #1/#2（中性委派工具名与称谓缺省）属模型可见协议面选择，未经 run owner 拍板。本波按方案推荐值落地：`RUN_EXECUTION_TASK_TOOL = 'run_task'`（备选 delegate_task / run_execution_task）、`DEFAULT_EXECUTOR_LABEL = '执行层子 Agent'`（备选「子 Agent」）。改值面已收敛为单常量 + 少量 golden 断言：工具名 = `packages/agent/src/context.ts` 一常量 + golden C3 两断言；称谓 = `packages/agent/src/system-prompt.ts` 一常量 + golden C2/D-122 块。实例部署经 `contextProfiles.<id>.toolName / executorLabel` 声明（`bin/17dz` / `run_17dz_task` / `17dz 子 Agent`）保持已发布协议连续，改缺省值不影响部署行为。

- **闭环判据**：run owner 在任一 W1 关账物上确认推荐值，或改值（改值时同步 golden 两个 describe 块与 example.yaml 注释）。
- **律法归属**：跨层协议（模型可见面选择须有人负责）。
- **归属波次 / 状态**：W1 落地、确认开放；不阻塞后续波次（改值面已收敛）。

### D-162 · W1 验收 grep 与守卫签机制的判定张力：挂 `identity-defer: W4` 签的 2 行

W1 验收条要求 `git grep -il 17dz -- <W1 scope>` 输出为空，但方案 C8 同时要求 `CROSS_REPO_17DZ_ROOT` 变量名保留并挂 `identity-defer: W4` 签（openDecisions #7 改名归 W4）。变量名含 "17DZ"，裸 grep（大小写不敏感、无签感知）必然命中：终态实测恰 2 行——`packages/agent/src/budget-policy.ts:19` 与 `scripts/ci.sh:12`（行号订正 2026-11-06 修复轮：C8 同 commit 改注释致 +1，`:18` 为旧引用；另有两预算测试文件被验收命令自身的 `:!` 排除）。守卫 `execution-identity-surface.test.ts` 按签机制判绿。两套判据的张力是方案内部遗留，按守卫判据执行（签即待办，W4 清空）并在此登记差异。

**裁决（run owner，2026-11-06）**：两条挂 `identity-defer: W4` 签的行**正确保留，门禁按签排除，不是放水**——签是显式待办标记（W4 清空），不是对 17dz 字样的豁免。复核口径 = ①验收 grep 的签排除后零命中（修复轮实测：`budget-policy.ts`/`ci.sh` 命中行全部带签，排除挂签行后零残留）+ ②身份守卫 3/3 绿（execution-identity-surface 修复轮实跑通过）。口径已写实进 change-safety §27 验收对账，防后人误读。

- **闭环判据**：W4 改名落地（D-165）→ 2 行签清空 → 验收 grep 与守卫判定一致（输出为空 = 守卫绿）。
- **律法归属**：L7（判定口径必须唯一且可机械复现）。
- **归属波次 / 状态**：W4；已裁决（签保留），余 W4 清签。

### D-163 · e2e 失败集合稳定但根因未完全归因（方案 risk #3 的正式登记）

W1 波前基线（C1 期实测）：`npx vitest run --project e2e` = 26 文件失败 / 93 用例失败，签名分布 AssertionError 78 / RATE_LIMITED 10 / REAL_EXECUTION_NOT_ALLOWED 6 / GATE_REFUSE 1，失败集合运行间稳定。环境漂移（sibling 17dz-platform 已迁 DZ_EXECUTOR/DZ_ALLOW_REAL 而 `tests/e2e/harness.ts` 仍传 `EXECUTION_EXECUTOR: 'mock'`）最多解释个位数失败，主因未定位。W1 终态复跑数字见 change-safety §27 e2e 实测行（判据 = 失败文件集合与波前 26/26 逐一相同且用例数 ≤93；e2e 不作 W1 绿灯门槛）。

- **闭环判据**：根因归因报告（AssertionError 78 的具体断言分布）+ harness env 对齐单独立项落地后 e2e 全绿，或 owner 接受为长期已知红并写明理由。
- **律法归属**：L4（可观察性——预存红必须有主人，不能变成「反正红着就没人看」）。
- **归属波次 / 状态**：独立立项（不混入 W1；harness env 对齐超出 W1 列范围）；登记。

### D-164 · 迁移门④三道守卫之一 exposure-lint 在本仓不存在

方案 openDecisions #8：迁移门④（exposure 面）应有三道守卫，其中 exposure-lint 在全仓无命中（不存在）。W1 新建的 `execution-identity-surface.test.ts` 只是其身份面子集（17dz 字样零容忍），不等于 exposure-lint 整体。exposure-lint 的完整职责（哪些字段/信封/日志允许出宿主边界）与归属波次未定。

- **闭环判据**：run owner 指定 exposure-lint 的职责边界与归属波次；或明确由 execution-identity-surface 演进承担并在守卫头注释写明。
- **律法归属**：L2 + 迁移门④。
- **归属波次 / 状态**：待拍板（不阻塞后续波次——身份面子集已在线）。

### D-165 · CROSS_REPO_17DZ_ROOT 改名/例外决策（openDecisions #7）

环境变量名含 "17DZ"，横跨 `scripts/ci.sh:12`、`packages/agent/src/budget-policy.ts:19`（行号订正 2026-11-06 修复轮：C8 同 commit 改注释致 +1，`:18` 为旧引用；两处均挂 `// identity-defer: W4` 签）、`budget-policy-cross-repo.test.ts`（4 处，整文件挂 W4 排除签）、`scripts/cross-repo/check-budget-thresholds.mjs`、`docs/environment-variables.md §4c`。推荐 W4 改名（如 `CROSS_REPO_PLATFORM_ROOT`）并同步 D-150 关账文本；备选设永久例外（则 W1 守卫的两级排除机制转为永久豁免，须在守卫头注释改写理由）。不决策则 W3/波次 4 清 scripts 时注释与代码必脱钩一个。

- **闭环判据**：改名落地并同步 D-150/D-162/守卫签清空；或 owner 拍板永久例外并更新守卫语义。
- **律法归属**：L2 + L7。
- **归属波次 / 状态**：W4；登记。

### D-166 · ask 范围实况与实测差异（openDecisions #1）：两套数字并记

ask 称「产品面零 17dz 引用、src+apps 非测试 4 文件/82 行」；本会话实测：门①路径集 362 行（命令 `git grep -i 17dz -- packages apps scripts config README.md .github docs .env.example package.json`，排除档案例外；审读员同范围 356，差异为 docs 128 vs 129 等口径）；src+apps 非测试 23 文件/88 行。W1 边界按实测划定（翻转 160 行 lint scope + harness 1 行），剩余约 202 行（docs 129、scripts 38、README 8、config/agent.example.yaml 5、.env.example 4、package.json 1、两 W4 预算测试文件 17）按 openDecisions #6 归 W3 与波次 4。波次记录如实写两套数字，规划以实测为准。

- **闭环判据**：W3/波次 4 清完剩余 202 行后，本条与 openDecisions #6 一并关闭。
- **律法归属**：执行纪律 4（文档主张与代码现实对账）。
- **归属波次 / 状态**：W3/波次 4；登记。

### D-167 · F6 探针待跑（真实 LLM 授权后补）+ 波前树红输出未留档

两项如实登记：① F6 探针（`node --env-file=.env --import tsx scripts/probe-real-agent.ts --only A1,A2,A4,A5,B1`，mock 执行器）需真实 LLM 授权，本波未获授权未跑；字节同一性 golden 已落地（D-122 base64、工具描述/schema 注入逐字节、工具名注入还原），授权后复跑逐轮 diff 即闭环（判定标准预写在 change-safety §27 F6 行）。② 方案守卫 w1-identity-surface-lint 要求「守卫在波前树实测红并留档红输出」，实际守卫与清理同 commit 落地（C8），C8 期波前 160 行数字沿方案口径登记未重放；守卫有效性以变异⑥两半（漏 apps 注入不红 / 完整路径注入即红）+ 排除非空转断言实证。**波前红已于 2026-11-06 修复轮实跑复现（订正 C8 期口径）**：对 7ba775d 按守卫 scope 重放，零排除（无文件排除、波前树无签行）计红 **173 处**，守卫执行形态（FILE_EXCLUSIONS_W4 整文件排除两预算测试文件，恰 17 处）计红 **156 处**——方案口径 160 与两实测均不符，波前红数字以本次重放为准（此前「波前树已不存在可检出的红状态」的说法不实，7ba775d 一直可检出）。两条都不影响 W1 判定成立性，但与方案守卫判据的字面要求有偏差，如实入账。

- **闭环判据**：① 授权后探针跑毕留档 json；② 已补齐——波前红实测复现（零排除 173 / 守卫排除形态 156，命令与口径见上），不再以「树不存在」为由免留档。
- **律法归属**：F6 一致性 + L7。
- **归属波次 / 状态**：①条件项待授权；②已实测留档（160 系方案口径误计，以 173/156 为准）。

### D-168 · 门①「产品面」口径未定义：src 测试夹具与 scripts/ 验收夹具的归属

- **位置**：`packages/agent/*.test.ts`（包根测试）与 `packages/agent/src/*.test.ts` 内的 17dz 夹具字面——2026-11-05 实测：`packages/agent/plan-shape-fuzz.test.ts` 34 行、`packages/agent/context.test.ts` 35 行等；`scripts/` 验收夹具（acceptance/ask 等）同类。
- **根因**：迁移门①字面口径是「产品面 `git grep -i 17dz` = 0（例外：debt-ledger/change-safety/AGENTS.md）」，但「产品面」未定义测试夹具（failing-path 断言里的错误码/命令示例、验收脚本的演示参数）算不算。夹具 17dz 多是「宿主在拒绝路径上引用执行层语义」的测试数据，与产品文案不同类。
- **律法归属**：L7（口径可判据化）。
- **闭环判据**：迁移 owner 拍板「产品面」是否含测试夹具与 scripts/；拍板后本条拆入对应波次验收（含 → 夹具清单计数进门①基线；不含 → 门① grep 命令加 `:!*test.ts` 类排除并写进门①复现命令）。
- **归属波次 / 限期**：波次 4/5 决策（W2+W3 只报告实测计数）。
- **状态**：待办（口径决策）。

### D-169 · rule-landing.md 残留 30 处 17dz 的清洗归属（含 W3-B 保留的历史叙述段）

- **位置**：`docs/rule-landing.md`——2026-11-05 W2+W3 波后实测 30 处（波前 32，W3-B 刷新 §3.1/§3.2 现状表清 2 处；剩余为 §2 serve 门明细 S1–S8、§3.2「已删/已改/字符数」历史叙述段等）。
- **根因**：历史叙述段（Phase 1–6 过程记录）原样保留是 W3-B 的刻意取舍（过程史不重写，只保证现状表与现实一致）；S1–S8 是 serve 门的历史明细，是否算「规格与说明」待门面波判定。
- **律法归属**：L2 / 门①。
- **闭环判据**：门①达标时该文件计数 = 0，或 owner 明确给 rule-landing 挂档案例外并写明理由（二选一，不许默认悬置）。
- **归属波次 / 限期**：波次 4/5（门面重写时处置）。
- **状态**：待办（归属决策）。

### D-170 · exposure-lint 门④状态对账：波次 1 已落地并进 CI unit，残留 = 波次 4 按需扩展类别

- **位置**：`packages/agent/exposure-lint.test.ts`（波次 1 交付：四类零命中断言 + ls-files 假绿自校验，7 例）。W2+W3 方案撰写时（波次 1 之前）实测「仓内不存在」，该前提**已被波次 1 落地推翻**——2026-11-05 实测该测试带 `|unit|` 标记进全量 unit（107 文件内），`.github/workflows/ci.yml` 经 `npm run ci`（typecheck + unit + generic-mock）覆盖它，迁移门④「三道守卫进 CI」的 exposure-lint 份额已满足。
- **残留欠账**：① 门④三道守卫清单的完整性核对（exposure-lint / 身份面守卫 / HG1 是否全部实际在 CI unit 内——2026-11-05 抽测 exposure-lint 为是，其余两道未逐一道具核对）；② 波次 4 按需扩展类别（凭据/token/主机名，汇总裁定 CF-3：波次 4 不新建 exposure-lint，只扩展类别）。
- **律法归属**：门④ / L7。
- **闭环判据**：三道守卫逐一道具核对在 CI 内运行（证据 = CI 日志含各测试文件）；波次 4 若扩展类别，新类别有变异验证。
- **归属波次 / 限期**：波次 4。
- **状态**：登记（主体已闭环，剩核对与扩展项，不冒充全闭环）。

### D-171 · 门①产品面 17dz 存量基线（2026-11-05 W2+W3 波终态实测，只减不增判据的锚点）

- **位置/读数**（`git grep -c -i 17dz` 逐文件，本波终态；括号内为波前读数）：README.md 7（7）、config/agent.example.yaml 5（5）、docs/v0-architecture.md 5（9，本波 −4）、docs/architecture-laws.md 10（10，本波零增减）、docs/rule-landing.md 30（32，本波 −2）、docs/environment-variables.md 18（18）、scripts/ci.sh 2（2）、.github/workflows/ci.yml 1（1）、package.json 1（1）、packages/agent/src/error-codes.ts 2（7，本波 −5，剩余两行为 W1 的 DELEGATION_* 用户可见文案）、packages/agent/src/context.ts 16（16）、docs/business-skill.md 0（2，本波清零）。src 测试夹具与 scripts/ 归 D-168 口径另计。
- **根因**：门①「只减不增」需要逐文件锚点，否则后续波的回归（或顺手新增）不可见。
- **律法归属**：门①。
- **闭环判据**：波次 4/5 逐文件 `git grep -c` 与本表比对——只减不增；清零目标 = 门①达标（例外档：debt-ledger/change-safety/AGENTS.md 及 D-169 拍板的例外）。
- **归属波次 / 限期**：波次 4/5 门前复核；本波（W2+W3）份额已清（error-codes −5、business-skill −2、v0-architecture −4、rule-landing −2）。
- **状态**：登记（基线锚点，非待修项）。

### D-172 · 门⑦存量盘点未做：debt-ledger 待办条目逐条核对归属/判据/限期

- **位置**：`docs/debt-ledger.md`——2026-11-05 实测：`grep -c '状态.*待办'` = 35 行（含格式说明与对账注记行），精确匹配 `**状态**：待办` = 31 条待办条目；逐条核对「归属标签 + 闭环判据 + 限期」三件套齐备性的工作未做（W2+W3 只做了计数，不冒充盘点）。
- **根因**：迁移门⑦要求「debt-ledger 每条有归属标签+闭环判据+限期」，历史条目（D-001 起）格式随时间演化，齐备性未逐条审计。
- **律法归属**：门⑦ / L7。
- **闭环判据**：逐条核对全部待办条目三件套；缺项者补齐或按「接受为长期已知限制」口径写明（同 D-159 关账形态）；产出核对清单附波次记录。
- **归属波次 / 限期**：波次 4 执行盘点、波次 5 门⑦检查前完成。
- **状态**：待办。
