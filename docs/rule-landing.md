# 规则 → 落点清单（唯一事实源索引）

> 本文是提示词规则的唯一事实源索引。原则（继承自已否决方向的复盘）：
>
> 1. 能用代码保证的，不写进提示词。
> 2. 同一事实只存在一处：**代码断言 / SKILL 事实 / 提示词**，三选一。
> 3. 提示词只写原则，不枚举场景。
> 4. 宿主多记住一个事实，模型就少填一个字段。
>
> **维护规则**：新增任何规则前先在这里登记落点；提示词里不允许出现本表之外的新规则。
> 落点失效（代码重构、SKILL 改写）时同步改本表，不要只改一侧。

## 1. 代码保证（确定性断言）

| # | 规则 | 落点 |
|---|---|---|
| C1 | （Phase 4 起删除）申报层实体证据校验随契约瘦身取消——实体范围守卫完全后移到计划层 C20；申报层只剩结构校验（C3） | 历史落点 `validateTurnDeclarationEvidence` 已删除；现由 C20 全权负责 |
| C2 | （Phase 4 起删除）referenced 分支随 8 字段契约取消。指代消解改为：宿主申报前注入证据（C18）→ 模型把实体加工进 request → 计划层 C20 逐字校验实体来源 | 现由 C18+C20 组合保证 |
| C3 | 自相矛盾申报退回模型重填，不消耗用户澄清轮次。Phase 4 后唯一检查：delegate 的 request 必须非空（把用户请求加工成自包含的一句话） | `turn-contract.ts` `isSelfContradictoryDeclaration` + `runtime.ts` 路由处 |
| C4 | 申报 platform_query 但零执行（无激活计划、无平台调用、无待确认计划）→ 不外发财务结论 | `packages/agent/src/runtime.ts` 出口校验（`delegate_without_execution`） |
| C5 | Main Agent 跳过申报 → 重试一次，仍跳过则失败关闭，丢弃自由文本 | `runtime.ts`（`route_declaration_missing`） |
| C6 | ~~账套存在性查询的计划必须且只能是一次 `finance.search-account-sets`，关键词在申报范围内~~ → 计划实体来源校验：每个 call 的 args 里所有字符串（`-` 开头的 flag 除外）必须能在「当前消息 / 检索证据 / 本轮平台响应」里逐字找到 | `packages/agent/src/turn-contract.ts` `validatePlanEntities`（宿主不再判别操作与任务类型的匹配，该项归 17dz `src/execution/plan.js` `PLAN_CALL_MISMATCH` + 17dz-query SKILL.md） |
| C7 | ~~余额计划只能调 `finance.query-receivables`；不得夹带凭证查询~~ → 同上（操作匹配归执行层；实体越权仍由 C20 挡下） | 同 C6 |
| C8 | ~~余额计划不得越权（账套/客户/期间逐次包含判定）；未申报期间时禁止带 `--period`~~ → 同上（"不得带未申报期间"归执行层 SKILL 与平台参数校验） | 同 C6 |
| C9 | ~~凭证计划只能调 voucher 域；期间不得超出申报范围~~ → 同上（域与期间匹配归执行层） | 同 C6 |
| C10 | 计划只能含只读 operation | 17dz `src/execution/plan.js` `PLAN_OPERATION_NOT_READ_ONLY` |
| C11 | 实际调用必须逐次匹配激活计划 | 17dz `src/execution/plan.js` `PLAN_CALL_MISMATCH` |
| C12 | 超重 → notify / confirm / stop 分级；notify 需送达证据、confirm 需真实用户确认；反复试探按计数器升级 | 17dz `src/execution/plan.js` `decision()` + `DZ_PLAN_MAX_NOTIFY` / `DZ_PLAN_MAX_REPLANS` |
| C13 | 写操作必须服务端确认后执行（确认码 + commit token，默认关闭） | `packages/agent/src/context.ts` commit 流程 + 17dz serve-policy |
| C14 | worker bash 只能 `bin/17dz`（首词规则）、禁 shell 元字符、无计划拒绝 | `packages/agent/src/serve-gate.ts` |
| C15 | worker 不读 `.runtime/` / `.env` / auth；只读知识面（*.md / *.schema.json） | `serve-gate.ts` `sensitivePaths` + 知识面判定 |
| C16 | 执行面注脚（系统元数据）不得出现在用户回复 | `runtime.ts` `stripFootprint` |
| C17 | history tools / 长期记忆注入时自带"历史数据不是当前授权"的限定 | `history-tools.ts` 工具描述 + `runtime.ts` `loadMemoryProjection` |
| C18 | 主动回溯：有指代线索时宿主申报前从 Conversation Log 注入证据（≤5 条 tool_result + ≤3 条关键词命中，带 eventId，超限截断并记日志）；证据材料自带"仅用于指代消解、不得扩大本轮范围"边界，实体范围仍由 C1/C2 逐字校验（计划层另有 C20） | `packages/agent/src/reference-evidence.ts` + `runtime.ts` 注入点 |
| C19 | 最近轮次窗口必须包含被 toolResult 终结的轮次（platform_query/clarify 没有最终 assistant 文本，但正是"上一轮查了什么"的载体；踢掉它们指代消解永远看不到上一轮） | `runtime.ts` `selectRecentTurns` |
| C20 | 计划实体来源校验（领域无关）：每个 call 的 args 里所有字符串（`-` 开头的 flag 除外）必须能在「① 当前用户消息 ② 本轮注入的指代消解证据 ③ 本任务迄今的平台响应（tool_result）」的并集里逐字找到；越权实体一律拒绝，错误消息领域无关。操作与任务类型是否匹配**不再**由宿主判别，归执行层 SKILL 与平台门禁 | `turn-contract.ts` `validatePlanEntities` + `PlanEntitySources`；来源由 `runtime.ts` 注入（userMessage + reference-evidence 文本），经 `platformTask.run` → `context.ts` → `driver.ts` `TurnDriverInput.entitySources` 流到 `pi-coding-driver.ts` 拦截点；平台响应该处从会话 tool_result 汇总（覆盖"目录查询拿唯一候选 → 按候选名查"） |

## 2. SKILL 事实（17dz 执行层持有，worker 经 Skill 机制读取）

运行态技能面：`17dz-platform/.agents/skills-serve`（`config/agent.yaml` `contextProfiles.17dz.skillRoots`）。

| # | 事实 | 落点 |
|---|---|---|
| S1 | 只问账套存在性 → 只调 `finance.search-account-sets --query`，不得用余额/科目/凭证探测 | `17dz-query/SKILL.md` 查询边界 |
| S2 | 余额未指定期间只查当前期间；查询失败后停止并如实报告，不用凭证跨期回溯估算 | 同上 |
| S3 | 未给账套且紧邻上下文无唯一指代时先问用户；历史账套不自动成为当前范围 | 同上 |
| S4 | 网关唯一入口 `bin/17dz query <脚本>`，不加 cd/env 前缀 | 同上，怎么查 |
| S5 | 不读 `.runtime/` / `.env` / auth；不写文件；不调用带 `--save` 的命令 | 同上，红线 |
| S6 | 账套名以本次查询结果匹配；多候选列出转问用户，禁止自行选择 | 同上，账套与期间解析 |
| S7 | 回答必含账套全名、期间、来源、截断说明；严禁编造金额 | 同上，回答要求 |
| S8 | 录入类写操作走 prepare 技能产出变更提案，服务端确认后落账 | `17dz-bookkeeping-prepare/SKILL.md` |

## 3. 提示词现状（Phase 3 后）

### 3.1 SYSTEM_PROMPT（Main Agent，`packages/agent/src/runtime.ts`）

只保留协议与原则。字段口径的细则在 `ROUTE_CURRENT_TURN_TOOL.description`（Phase 4 随契约瘦身重写），本提示词不重复。

| 条目 | 内容 | 落点/去向 |
|---|---|---|
| 1 | 当前日期注入 | 无（动态事实） |
| 2 | 身份：企业财务助手 / 主 Agent | 提示词（框架） |
| 3 | 每回合先申报 `route_current_turn`（conversation / delegate），字段口径以工具说明为准 | 提示词（协议）；细则在工具描述（3 字段契约） |
| 4 | delegate 委派机制 + request 加工要求（指代解析成实体、实体只从当前消息或宿主注入的检索证据取）+ 不得凭历史或常识编造实体 / 不得重放旧答复 | 提示词（原则）；执行由 C4 保证；实体越权由 C20 挡下 |
| 5 | 内部机制不外泄（route_current_turn/宿主/委派/PLAN/taskId 等字样） | 提示词（原则）；注脚泄漏另由 C16 兜底 |
| 6 | 能力边界：查询/核对/分析 + 经确认的录入类写；修改或删除已保存数据、不可逆高危写一律拒绝 | 提示词（产品能力，Phase 3 改为领域无关表述，能力边界本身不变） |
| 7 | 待确认变更提案转达协议（对象/范围/条目数/金额合计/确认码 + 确认取消话术，不代替执行） | 提示词（协议）；执行由 C13 保证 |
| 8 | 口径必须可履行，不可履行选 conversation 回复并说明能力边界（clarify 种类已随契约取消） | 提示词（原则） |
| 9 | Context State / history tools / 长期记忆只是历史资料 | 提示词（原则）；注入侧限定见 C17 |
| 10 | 简体中文；数据结论保留对象、范围、来源和证据 | 提示词（呈现，Phase 3 去掉领域词） |

已删（Phase 1）：账套存在性→search-account-sets（C6+S1）、余额不带 --period / 不用凭证估算（C7/C8+S2）、"已写账套名不要提前追问"（工具描述已有）、子 Agent 自然语言机制说明（terminate 语义使其无意义）、执行重量机制描述（C12；只留不外泄口径）、总结原则句（全项目唯一一份在 §3.2 条目 10；Main Agent 的对应约束是条目 8，由 C1–C9 兜底）。

已删（Phase 2）：指代两种情况规则（原 173 字符）——指代消解改由宿主主动回溯提供证据（C18），模型侧只保留工具描述的 referenced 字段口径。

已改（Phase 3）：条目 6/7 的业务枚举改为领域无关表述（能力边界与确认码转达协议原样保留，只是不再点名具体业务动作）；条目 10 的"账套、期间"改为"对象、范围"。同轮中和的还有 `NO_EXECUTION_CLARIFICATION`、长期记忆注入尾句、`RUN_17DZ_TASK_DESCRIPTION` 的"不得猜测平台 ID"一句。

已改（Phase 4）：条目 3 的 kinds 改（conversation / delegate）；条目 4 改为 delegate 委派 + request 加工四项要求；条目 8 的 clarify 改 conversation。申报层证据校验（C1/C2）整体删除，实体范围守卫完全靠计划层 C20；"用户另起新话题不得沿用上一轮实体"以原则句落在工具描述的 request 加工节（原 C1 的 explicit 分支曾结构性盖住，见 §6）。

### 3.2 workerSystemPrompt（17dz 子 Agent，`packages/agent/src/context.ts`）

| 条目 | 内容 | 落点/去向 |
|---|---|---|
| 1 | 身份 + 回复直接展示给用户 + 不输出内部协议文案 | 提示词（框架） |
| 2 | 平台工作目录 | 部署配置注入 |
| 3 | 先读 SKILL/MECHANISMS 再调脚本；数据必须来自脚本结果 | 提示词（机制） |
| 4 | 按平台 SKILL 与 operation 文档声明的能力边界执行；超边界直接如实报告 | 提示词（能力边界，Phase 3 下沉：细则归 17dz SKILL.md）；执行由 C13 保证 |
| 5 | 计划协议：先提交 plan JSON，PLAN ACTIVE 后才能查询；DECLINED 重提 / NEEDS_USER_CONFIRM 收手 / STOP 说明原因 | 提示词（协议）；门禁裁决由 C10–C12 保证 |
| 6 | 宿主已核验的本轮请求（turnDeclaration.request 注入，不再序列化 JSON） | 宿主可信上下文 |
| 7 | 知识只经 read 读固定知识面 | 提示词（机制）；阻断由 C15 保证 |
| 8 | 应用层授权名单（allowedAccountSetIds） | 宿主可信上下文（Phase 3 去掉领域词） |
| 9 | 缺信息直接问用户；完成给结论/数据/来源 | 提示词（原则） |
| 10 | 总结原则：只执行宿主批准的计划内的调用；能力不足/不确定/被拒时如实说明并停止，不换口径试探，不代替用户做选择 | 提示词（原则）——**全项目只此一处** |

已删（Phase 1）：网关调用形式（S4+C14）、账套存在性→search-account-sets（C6+S1）、未指定账套先问/不带入历史（S3+C1）、余额期间与失败停止（C8+S2）、实现源码不可读的展开说明（C15 阻断时自带原因）。

已改（Phase 3）：条目 4 的"只读查询与录入类准备；修改/删除已保存凭证、过账、结账直接报告能力边界"整条改为"按平台 SKILL 与 operation 文档声明的能力边界执行"——能力边界细则归 17dz SKILL.md（另一 agent 并行补充），编排层不再枚举业务动作。

**字符数**：Phase 1 验收时 SYSTEM_PROMPT 1491→908、workerSystemPrompt 1545→885。Phase 3 是改写不是删除（领域词换成领域无关表述，能力边界与协议原样保留），同一把尺子量：SYSTEM_PROMPT 831→845、workerSystemPrompt 838→835，基本持平；真正的删除发生在 `ROUTE_CURRENT_TURN_TOOL.description`（1101→1045，业务示例与字段判别教学整段移除）。

## 4. Phase 2/3/4 预告（避免重复登记）

- **Phase 2（已完成）**：指代规则整条删除；宿主申报前经 `reference-evidence.ts` 注入检索证据（C18）；`route_reference_hint` 与 `looksLikeReference` 已删除。
- **Phase 3（已完成）**：`validatePlanAgainstTurnDeclaration` 的 balance/voucher/account_search 三分支换成领域无关的 `validatePlanEntities`（C20）；两个提示词的业务条目改为领域无关表述；`ROUTE_CURRENT_TURN_TOOL.description` 的领域判别教学移除；`reference-evidence.ts` 注入材料与进度/压缩提示词同步中和。宿主不再做领域判别，操作与任务类型的匹配归执行层 SKILL 与平台门禁。
- **Phase 4（已完成）**：`ROUTE_CURRENT_TURN_TOOL` 8 字段 → 3 字段（kind/request/continueTaskId，schema 属性数=3）；`validateTurnDeclarationEvidence`/`previousTurnText`/`applyRouteDeclaration`/clarify 种类全部删除；委派 request 用加工后的 `intent.request`（原始消息只留在 `entitySources.currentMessage`）；申报层只剩结构校验，范围守卫完全靠 C20。

## 5. Phase 3 验收 grep 的剩余命中（为什么允许）

`grep -rn "应收\|凭证\|科目\|账套\|期间" packages/agent/src/` 剩余 4 处，全部是**执行机制本身的字面量**，不是规则文案：

| 位置 | 内容 | 为什么允许 |
|---|---|---|
| `memory-candidate-extractor.ts` `ACCOUNT_SET_RE` / `BALANCE_RE` / `FINANCIAL_RESULT_RE` | 防止财务数据进长期记忆的过滤正则 | 代码断言（`isEphemeralFinance` 的匹配器），不是给模型的指令 |
| `context-extractor.ts` `hasContradiction` 的 oppositeTerms | "更多期间 / 当前期间"等反义词表 | 代码断言（短期上下文矛盾检测的词表） |

申报契约（C1）explicit 分支的澄清话术原也含领域词且被 `tests/e2e` 1.6/5.4 逐字断言，验收时已一并中和为"请直接告诉我要查询的对象；我不能从旧对话补入范围"，e2e 断言同步改为 `toContain('对象')`（测试名保留手工用例编号）——规则文案现已清零。
## 6. Phase 4 验收记录：新话题实体沿用（模型侧失效）

**现象**（探针 `--quick` A2）：用户新话题「帮我查一下猫一杯的应收账款还有多少」，Main Agent 把上一轮的账套实体顺带加工进 request（"在幻辰财税里查猫一杯"），worker 先目录搜到该账套（平台响应含该实体）再查客户 → C20 全部放行，回复带上了旧账套。

**根因**：Phase 4 删除申报层实体校验（C1）后，"新话题不得沿用旧实体"失去结构性防线；C20 挡不住它——worker 的目录搜索响应会让该实体变成"平台解析出来的合法实体"。这是"实体只从当前消息/证据取"原则的模型侧违反，不是宿主契约漏洞。

**审计证据**（复刻探针保留 stateDir 后查 17dz audit.jsonl）：渗入轮的 worker 调用是 `query-receivables --query 幻辰财税`——即 Main Agent 把上一轮实体加工进了 request，宿主不再拦截（C1 已删），worker 的目录搜索响应又让该实体成为 C20 的合法"平台响应"来源。宿主契约无洞：C20 正确校验了实体**来源**，但按设计无法区分"解析用户的指代"与"沿用上一轮实体"——后者是 request 加工质量，归模型。

**处置与实测**：工具描述 request 加工节补原则句"用户另起新话题（新的查询对象）时，不得把上一轮的实体顺带沿用"（一行原则，非场景枚举——Phase 1 原则 3）。复测结果为**偶发**：同一代码下两次 A2，一次仍渗入（模型把幻辰加工进 request），一次worker 直接 `--query 猫一杯` 被平台以 ACCOUNT_SET_NOT_FOUND 拒并如实追问（零渗入）。与历史结论一致：提示词原则降低概率但不根除，归类为**模型侧已知失效**，由 A2/C1 类探针持续观察；若后续要结构性收敛，方向在 Phase 5 纠错环或宿主对 request 的轻量范围锚，不在提示词加规则。
