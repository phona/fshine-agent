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
| C6 | 账套存在性查询的计划必须且只能是一次 `finance.search-account-sets`，关键词在申报范围内 | `turn-contract.ts` `validatePlanAgainstTurnDeclaration` account_search 分支 |
| C7 | 余额计划只能调 `finance.query-receivables`；不得夹带凭证查询 | 同上，balance 分支 |
| C8 | 余额计划不得越权（账套/客户/期间逐次包含判定）；未申报期间时禁止带 `--period` | 同上，balance 分支 + `inScope` |
| C9 | 凭证计划只能调 voucher 域；期间不得超出申报范围 | 同上，`validateVoucherPlan` |
| C10 | 计划只能含只读 operation | 17dz `src/execution/plan.js` `PLAN_OPERATION_NOT_READ_ONLY` |
| C11 | 实际调用必须逐次匹配激活计划 | 17dz `src/execution/plan.js` `PLAN_CALL_MISMATCH` |
| C12 | 超重 → notify / confirm / stop 分级；notify 需送达证据、confirm 需真实用户确认；反复试探按计数器升级 | 17dz `src/execution/plan.js` `decision()` + `DZ_PLAN_MAX_NOTIFY` / `DZ_PLAN_MAX_REPLANS` |
| C13 | 写操作必须服务端确认后执行（确认码 + commit token，默认关闭） | `packages/agent/src/context.ts` commit 流程 + 17dz serve-policy |
| C14 | worker bash 只能 `bin/17dz`（首词规则）、禁 shell 元字符、无计划拒绝 | `packages/agent/src/serve-gate.ts` |
| C15 | worker 不读 `.runtime/` / `.env` / auth；只读知识面（*.md / *.schema.json） | `serve-gate.ts` `sensitivePaths` + 知识面判定 |
| C16 | 执行面注脚（系统元数据）不得出现在用户回复 | `runtime.ts` `stripFootprint` |
| C17 | history tools / 长期记忆注入时自带"历史数据不是当前授权"的限定 | `history-tools.ts` 工具描述 + `runtime.ts` `loadMemoryProjection` |

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

## 3. 提示词现状（Phase 1 后）

### 3.1 SYSTEM_PROMPT（Main Agent，`packages/agent/src/runtime.ts`）

只保留协议与原则。字段口径的细则在 `ROUTE_CURRENT_TURN_TOOL.description`（Phase 4 随契约瘦身重写），本提示词不重复。

| 条目 | 内容 | 落点/去向 |
|---|---|---|
| 1 | 当前日期注入 | 无（动态事实） |
| 2 | 身份：企业财务助手 / 主 Agent | 提示词（框架） |
| 3 | 每回合先申报 `route_current_turn`，字段口径以工具说明为准 | 提示词（协议）；细则在工具描述 |
| 4 | 委派机制 + 不得凭历史编造 / 不得重放旧答复 | 提示词（原则）；执行由 C1/C4 保证 |
| 5 | 内部机制不外泄（route_current_turn/宿主/委派/PLAN/taskId 等字样） | 提示词（原则）；注脚泄漏另由 C16 兜底 |
| 6 | 能力边界（查询/核对/分析/录入类写；高危写直接拒绝） | 提示词（产品能力） |
| 7 | 变更提案转达协议（确认码话术，不代替执行） | 提示词（协议）；执行由 C13 保证 |
| 8 | 口径必须可履行，不可履行选 clarify | 提示词（原则） |
| 9 | 指代两种情况（新话题不带入历史 / 指代按上一轮解析 referenced） | 提示词；**Phase 2 主动回溯落地后整条删除** |
| 10 | Context State / history tools / 长期记忆只是历史资料 | 提示词（原则）；注入侧限定见 C17 |
| 11 | 简体中文；数据结论保留账套/期间/来源/证据 | 提示词（呈现） |

已删（Phase 1）：账套存在性→search-account-sets（C6+S1）、余额不带 --period / 不用凭证估算（C7/C8+S2）、"已写账套名不要提前追问"（工具描述已有）、子 Agent 自然语言机制说明（terminate 语义使其无意义）、执行重量机制描述（C12；只留不外泄口径）、总结原则句（全项目唯一一份在 §3.2 条目 10；Main Agent 的对应约束是条目 8，由 C1–C9 兜底）。

### 3.2 workerSystemPrompt（17dz 子 Agent，`packages/agent/src/context.ts`）

| 条目 | 内容 | 落点/去向 |
|---|---|---|
| 1 | 身份 + 回复直接展示给用户 + 不输出内部协议文案 | 提示词（框架） |
| 2 | 平台工作目录 | 部署配置注入 |
| 3 | 先读 SKILL/MECHANISMS 再调脚本；数据必须来自脚本结果 | 提示词（机制） |
| 4 | 只读查询与录入类准备；高危写报告能力边界 | 提示词（能力边界）；执行由 C13 保证 |
| 5 | 计划协议：先提交 plan JSON，PLAN ACTIVE 后才能查询；DECLINED 重提 / NEEDS_USER_CONFIRM 收手 / STOP 说明原因 | 提示词（协议）；门禁裁决由 C10–C12 保证 |
| 6 | 宿主已核验的申报范围（turnDeclaration 注入） | 宿主可信上下文 |
| 7 | 知识只经 read 读固定知识面 | 提示词（机制）；阻断由 C15 保证 |
| 8 | 账套 allowlist | 宿主可信上下文 |
| 9 | 缺信息直接问用户；完成给结论/数据/来源 | 提示词（原则） |
| 10 | 总结原则：只执行宿主批准的计划内的调用；能力不足/不确定/被拒时如实说明并停止，不换口径试探，不代替用户做选择 | 提示词（原则）——**全项目只此一处** |

已删（Phase 1）：网关调用形式（S4+C14）、账套存在性→search-account-sets（C6+S1）、未指定账套先问/不带入历史（S3+C1）、余额期间与失败停止（C8+S2）、实现源码不可读的展开说明（C15 阻断时自带原因）。

**字符数（Phase 1 验收）**：SYSTEM_PROMPT 1491→908，workerSystemPrompt 1545→885，合计 3036→1793（**−40.9%**，要求 ≥40%）。两个提示词的每一条都能在上表找到落点；无清单外新规则。

## 4. Phase 2/3/4 预告（避免重复登记）

- **Phase 2**：§3.1 条目 9（指代规则）整条删除，改由宿主申报前注入检索证据；`route_reference_hint` 整套删除。
- **Phase 3**：workerSystemPrompt 剩余业务条目与 SKILL 去重；编排层领域判别全部下沉，宿主只做包含校验。
- **Phase 4**：`ROUTE_CURRENT_TURN_TOOL` 8 字段 → 3 字段，字段口径细则随契约重写。
