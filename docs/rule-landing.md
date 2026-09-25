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
| C1 | 申报的实体（账套/客户/期间/搜索词）必须逐字来自当前消息；explicit 账套不在当前消息里 → 降级澄清 | `packages/agent/src/turn-contract.ts` `validateTurnDeclarationEvidence` |
| C2 | referenced 指代必须绑定紧邻上一轮（单账套 + 指代原词在上一轮出现） | 同上，`referenced` 分支 |
| C3 | 自相矛盾申报（explicit 却不填账套、account_search 无关键词）退回模型重填，不消耗用户澄清轮次 | `turn-contract.ts` `isSelfContradictoryDeclaration` + `runtime.ts` 路由处 |
| C4 | 申报 platform_query 但零执行（无激活计划、无平台调用、无待确认计划）→ 不外发财务结论 | `packages/agent/src/runtime.ts` 出口校验（`platform_query_without_execution`） |
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
| 3 | 每回合先申报 `route_current_turn`，字段口径以工具说明为准 | 提示词（协议）；细则在工具描述 |
| 4 | 委派机制 + 不得凭历史编造 / 不得重放旧答复 | 提示词（原则）；执行由 C1/C4 保证 |
| 5 | 内部机制不外泄（route_current_turn/宿主/委派/PLAN/taskId 等字样） | 提示词（原则）；注脚泄漏另由 C16 兜底 |
| 6 | 能力边界：查询/核对/分析 + 经确认的录入类写；修改或删除已保存数据、不可逆高危写一律拒绝 | 提示词（产品能力，Phase 3 改为领域无关表述，能力边界本身不变） |
| 7 | 待确认变更提案转达协议（对象/范围/条目数/金额合计/确认码 + 确认取消话术，不代替执行） | 提示词（协议）；执行由 C13 保证 |
| 8 | 口径必须可履行，不可履行选 clarify | 提示词（原则） |
| 9 | Context State / history tools / 长期记忆只是历史资料 | 提示词（原则）；注入侧限定见 C17 |
| 10 | 简体中文；数据结论保留对象、范围、来源和证据 | 提示词（呈现，Phase 3 去掉领域词） |

已删（Phase 1）：账套存在性→search-account-sets（C6+S1）、余额不带 --period / 不用凭证估算（C7/C8+S2）、"已写账套名不要提前追问"（工具描述已有）、子 Agent 自然语言机制说明（terminate 语义使其无意义）、执行重量机制描述（C12；只留不外泄口径）、总结原则句（全项目唯一一份在 §3.2 条目 10；Main Agent 的对应约束是条目 8，由 C1–C9 兜底）。

已删（Phase 2）：指代两种情况规则（原 173 字符）——指代消解改由宿主主动回溯提供证据（C18），模型侧只保留工具描述的 referenced 字段口径。

已改（Phase 3）：条目 6/7 的业务枚举改为领域无关表述（能力边界与确认码转达协议原样保留，只是不再点名具体业务动作）；条目 10 的"账套、期间"改为"对象、范围"。同轮中和的还有 `NO_EXECUTION_CLARIFICATION`、长期记忆注入尾句、`RUN_17DZ_TASK_DESCRIPTION` 的"不得猜测平台 ID"一句。

### 3.2 workerSystemPrompt（17dz 子 Agent，`packages/agent/src/context.ts`）

| 条目 | 内容 | 落点/去向 |
|---|---|---|
| 1 | 身份 + 回复直接展示给用户 + 不输出内部协议文案 | 提示词（框架） |
| 2 | 平台工作目录 | 部署配置注入 |
| 3 | 先读 SKILL/MECHANISMS 再调脚本；数据必须来自脚本结果 | 提示词（机制） |
| 4 | 按平台 SKILL 与 operation 文档声明的能力边界执行；超边界直接如实报告 | 提示词（能力边界，Phase 3 下沉：细则归 17dz SKILL.md）；执行由 C13 保证 |
| 5 | 计划协议：先提交 plan JSON，PLAN ACTIVE 后才能查询；DECLINED 重提 / NEEDS_USER_CONFIRM 收手 / STOP 说明原因 | 提示词（协议）；门禁裁决由 C10–C12 保证 |
| 6 | 宿主已核验的申报范围（turnDeclaration 注入） | 宿主可信上下文 |
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
- **Phase 4**：`ROUTE_CURRENT_TURN_TOOL` 8 字段 → 3 字段，字段口径细则随契约重写；C1/C2/C3 与申报契约一并收缩，范围守卫完全靠 C20。

## 5. Phase 3 验收 grep 的剩余命中（为什么允许）

`grep -rn "应收\|凭证\|科目\|账套\|期间" packages/agent/src/` 剩余 4 处，全部是**执行机制本身的字面量**，不是规则文案：

| 位置 | 内容 | 为什么允许 |
|---|---|---|
| `memory-candidate-extractor.ts` `ACCOUNT_SET_RE` / `BALANCE_RE` / `FINANCIAL_RESULT_RE` | 防止财务数据进长期记忆的过滤正则 | 代码断言（`isEphemeralFinance` 的匹配器），不是给模型的指令 |
| `context-extractor.ts` `hasContradiction` 的 oppositeTerms | "更多期间 / 当前期间"等反义词表 | 代码断言（短期上下文矛盾检测的词表） |

申报契约（C1）explicit 分支的澄清话术原也含领域词且被 `tests/e2e` 1.6/5.4 逐字断言，验收时已一并中和为"请直接告诉我要查询的对象；我不能从旧对话补入范围"，e2e 断言同步改为 `toContain('对象')`（测试名保留手工用例编号）——规则文案现已清零。