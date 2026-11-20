# 能力边界：柜台（Main）／后台部门（Worker）／客户（用户）／宿主

> 状态：现行判据档（owner 已定，作为后续所有切片的判据；**§2 能力目录派生、§3 答复五态分类器本切片已落地，逐条挂守卫；未接线处逐条明确标注**）。
> 最后核对：2026-11-20（基线 `123c0b8b` `arch/integration`；Worker 工具面已切每-operation 一个 `op_*` 工具；一切以现行代码为准，冲突就地标 ⚠️）。
> 上游指针：`AGENTS.md`（定位/职责边界/新增机制准入）、`docs/architecture/contract.md`（执行契约语义面）、`docs/product/capability.md`（用户级能力台账与四档状态纪律）；`packages/contracts/src/execution-contract.ts`、`packages/agent/src/execution-runtime.ts`。

owner 的类比（原文）：**「相当于 Main 的工作台里对客户罗列了业务范围，拿到用户提交的资料后给下游部门完成工作，然后再反馈结果给用户」**。本文把它拆成四件事：四个角色各自的权（§1）、单一来源的能力目录（§2）、Worker→Main 的结构化答复契约（§3）、结构化交办格式（§4），末尾三条禁令（§5）与现状/守卫登记（§6、§7）。

**读法约定**：本文是**判据档**，不是实现报告。凡未实现处写「未实现／待办」并给出守卫形状；凡写「已实现」必挂一个能变红的守卫（文件名 + 断言形状，见 §7）。禁止把目标态读成现状。

## 1. 四个角色与各自的权

柜台—后台—客户—宿主的类比落到本仓的真实边界如下（"有什么 / 没有什么"两列即判据，逐条守卫状态见 §7）：

| 角色 | 对谁 | 有什么权 | 没有什么（硬禁） |
| --- | --- | --- | --- |
| **Main（柜台）** | 只对用户 | **承诺权**（能不能办：来自派生目录，见 §2）、澄清（问对象/范围/口径）、汇报（结论+数据）、本地加工（`run_js` / `recalc_xlsx` 这类宿主确定性工具） | **无执行权**：不得调用任何平台 `operation`。现行 Main 工具面 = `task_run` + `task_status` / `task_result`（+ runner 时 `task_cancel` / `task_resume` / `task_confirm`，+ 注入时 `read_skill` / `run_js` / `recalc_xlsx`），**不含** `execute_operation`、也**不含**任何 `op_*`（装配见 `packages/agent/src/execution-runtime.ts:3126-3141`，缺省面断言见 `packages/agent/main-skill.test.ts:332`、Main 面排除 `execute_operation` 见 `packages/agent/main-capability-surface.test.ts:63`）。⚠️ `execute_operation` 只是**内部 exec 路由键**（常量 `packages/agent/src/execution-runtime.ts:411`，路由点 `:2741`、`:4097`），不是任何模型可见工具；原工具工厂 `executeOperationTool()` 已按删除纪律删除（旧 `:3446`，现为删除注）。见 §6 现状第 5 条 |
| **Worker（后台部门）** | 只对宿主/委派方 | **执行权**：调**每 operation 一个 `op_*` 工具**（operation 名安全化：`dummy.query` → `op_dummy_query`，参数用业务字段名、照委派清单填；生成见 `packages/agent/src/execution-runtime.ts:3466`、注册点 `:2966`、`:4305`），取证（真实结果与「缺什么/办到哪一步」） | **无话语权**：不得直接对用户说话；只把事实汇报给 Main，由 Main 转述（`WORKER_SYSTEM_PROMPT` 要求「写成一段能直接转给别人看的事实」：`packages/agent/src/execution-runtime.ts:584`；Worker 工具面快照恰好一个 `op_dummy_query`、明确**不含** `execute_operation`：`packages/agent/task-surface.test.ts:375`） |
| **用户（客户）** | —— | 交办、确认、叫停（`task_confirm` / `task_cancel` 的显式动作）；随时接管（查状态、查结果） | 不需要懂系统结构：看不到 operation 名、参数、句柄、任务编号等内部形态（用户可见面无内部词由 `apps/server/factword-no-internal-terms.test.ts` 与 `packages/agent/user-facing-failure.test.ts:150` 守卫） |
| **宿主** | —— | 身份/时机/事实/凭据/投递与记账（可信 principal、状态变化才唤醒、机械事实、句柄原样透传、用户可见文本投递、执行与投递记账） | 不替双方做决定（不判「用户是不是在确认」、不做业务裁决）、不复制执行层规则（实体授权、口径、有效期归执行层；`docs/architecture/contract.md` §2–§3） |

**柜台类比的两处修正**（避免把类比读歪）：
- 「罗列业务范围」不是 Main 背一份清单，而是宿主按执行层声明**派生**目录后按需注入（§2）——Main 自身不持有、不记忆业务范围。
- 「拿到用户提交的资料」在写确认路径上以**已确认的提案**为准，不是原始交办 prose（§4）。

## 2. 能力目录：单一来源 + 派生，禁止第二套

柜台能向客户罗列的范围**必须只有一个事实源 = 执行层的 operation 声明**，宿主派生、不另立清单。理由：两处声明必然漂移，且漂移时用户会被承诺一件执行层办不到的事。

- **加一个字段**：在执行层既有 operation 声明上加 `capability: string`（业务名，如「录入凭证」）。同一件业务的多个阶段（`query` / `prepare` / `commit`）**共享同一个 `capability` 值**——它们是同一能力的阶段，不是多件能力。**已实现**：`ExecutionOperationDeclaration.capability?: string`（`packages/contracts/src/execution-contract.ts:92`）；守卫 `packages/agent/capability-catalog.test.ts:28`（同 capability 的 query/prepare/commit 合并为一项、read/write 取并集）。
- **group by 派生**：宿主按 `capability` 对操作声明分组，派生给 Main 的目录 = （业务名 + 只读/可写）。只读/可写的既有派生源是执行层 `access=read`/`access=write`（`scripts/ask-runtime.ts:437-440`；`packages/contracts/src/config.ts:221-222`）——不要在能力目录里重造第二套读写判据。**已实现**：`deriveCapabilityCatalog`（`packages/agent/src/capability-catalog.ts:45`），在 `scripts/ask-runtime.ts:1068` 装配；守卫 `packages/agent/capability-catalog.test.ts:28`、`:37`、`:46`（加声明即多一条、读写复用 access 派生）。
- **不单独声明清单**：能力目录不得手写一份业务名常量表（禁令 3，§5）。**已实现**：目录完全派生，无业务名常量表；守卫 `packages/agent/capability-catalog.test.ts:18`（空清单 → 空目录，无硬编码业务名漏出）、`:22`（全部未声明 → 空目录）。
- **Main 侧形态**：一句极短摘要常驻 + 一个只读工具 `capabilities()` 按需查；**不含 operation 名、不含参数**。摘要常驻沿用 catalog 模式（`renderSkillCatalog`：`packages/agent/src/skills.ts:153`）。**已实现**：`renderCapabilitySummary`（`packages/agent/src/capability-catalog.ts:67`）+ `CAPABILITIES_TOOL`（`packages/agent/src/execution-runtime.ts:260`，装配 `:3138`）；装配见 `scripts/ask-runtime.ts:1072`；守卫 `packages/agent/main-capability-surface.test.ts:59`、`:66`（工具面有 capabilities、输出不含 operation 名/--/参数名）、`packages/agent/capability-catalog.test.ts:60`（摘要无内部形态）。
- **未声明即退化为现状**：执行层未声明 `capability` 时退化为现状（Main 不知道边界；交办后由 Worker 判定能否执行），且宿主/装配必须**显式登记为「能力边界未声明」**，不许假装知道、不许承诺范围。**已实现**：目录为空时不追加摘要/行为句（提示逐字节不变），记一次性事件 `capability_catalog_undeclared`（`scripts/ask-runtime.ts:1070`；事件定义 `packages/agent/src/execution-runtime.ts:703`）；守卫 `scripts/capability-catalog-assembly.test.ts:66`（未声明 → 事件 + 提示不变 + 无 capabilities 工具）、`:77`（已声明 → 派生 + 工具出现）。

## 3. Worker → Main 的答复契约（结构化 outcome，分类器已实现）

Worker 的汇报必须是**结构化 outcome**，Main 据此套用统一话术——这样「办不了」和「没办成」不会被说成同一句、也不会被加一句「再试一次」。**已实现（宿主侧机械分类器）**：`classifyOutcome`（`packages/agent/src/task-outcome.ts:71`）把任务底账的机械事实归成五值之一；`unsupported` / `blocked` 走零执行分支（`:75-85`），结构化原因码 `not_permitted` / `unsupported` 已接上（`:122-123`、`:77-78`）；出口 `renderOutcomeFact`（`:135`）经 `taskFailureFactText`（`apps/server/task-completion-delivery.ts:299`）作为事实喂给 Main。Main 行为句 `OUTCOME_BEHAVIOR_NOTE`（`packages/agent/src/execution-runtime.ts:569`）在目录非空时随摘要常驻（`scripts/ask-runtime.ts:1072`）。下表逐条标现状：

> ⚠️ **未接线（如实登记）**：outcome 的 `completed` / `partial` 目前**只写进失败唤醒出口**（`apps/server/server.ts` 的 `taskFailureFactText` 调用点）；底账 `ExecutionRecord`（`packages/agent/src/task-registry.ts:148-156`）**无 `items` 字段**——执行层信封里的 `completed.items`（`packages/contracts/src/execution-contract.ts:200`）没有落到底账，分类器拿不到逐项 ok/failed/unknown 事实，`partial` 无法从底账投影判出（`apps/server/server.ts:699` 的 `execution.items` 读取恒为空）。这条标「未实现/待接线」，不写成已实现。

| outcome | 机械判据 | Main 对用户说 | 现状 |
| --- | --- | --- | --- |
| `completed` | 全部项成功 | 结论 + 数据 | 分类器五值之一（`packages/agent/src/task-outcome.ts:53`、`:107`）；出口见上「未接线」注 |
| `partial` | 部分项成功 | 逐项说，**不得说成单纯成功** | 分类器已实现（`:102-109`：`completed` 且 items 有 failed/unknown → partial），但**底账 ExecutionRecord 无 items、未接线**（见上「未接线」注）；这条标「未实现/待接线」，不写成已实现 |
| **`unsupported`** | 零执行 + 无对应能力 | 「这件事我这边办不了」+ 能办的（**来自 §2 派生目录**）。**绝不提「再试一次」** | **已实现**：零执行且非权限拒绝/非等待 → unsupported（`task-outcome.ts:75-85`）；结构化码 `unsupported` 接上（`:122-123`、`:78`）；守卫 `packages/agent/task-outcome.test.ts:48`、`:55`、`:177`；G4 不提「再试」守卫 `packages/agent/task-outcome.test.ts:156` |
| **`blocked`** | 有能力但缺条件（权限/口径/字段） | 「缺 X」+ 补的方式 | **已实现**：零执行 + 权限拒绝码 `not_permitted` / `zeroReason=permission_denied` / 等待 → blocked（`task-outcome.ts:75-83`）；判据只用结构化码、不扫文案（`apps/server/task-outcome-reason.ts`；反向绊线 `apps/server/task-outcome-reason.test.ts:14`）；缺失条件非空守卫 `packages/agent/task-outcome.test.ts:162` |
| `failed` | 有能力、执行失败 | 「没办成」+ **该重试才说重试**（执行层 `retryable:true`；缺省/未声明按不可重试，`packages/contracts/src/execution-contract.ts:156-166`） | 六态之一（已有，`:222`）；「该重试才说重试」已有守卫（`packages/agent/deterministic-failure-guard.test.ts:222`、`:179`；话术 `packages/agent/user-facing-failure.test.ts:117`） |

**收口说明**：`unsupported` / `blocked` 的分类器与结构化原因码（B2/B3）已随本切片落地（守卫见上表与 §7）；`partial` 的分类器逻辑虽在，但因底账无 `items` 字段仍待接线（见 §3「未接线」注）。§4 的结构化交办尚未实现，不影响 B2/B3 分类器对零执行/权限拒绝的判据。

## 4. 交办格式：结构化意图，不是一段 prose

交办（Main → Worker）是**结构化意图 = 能力 + 业务输入**，不是把用户原文当一段 prose 交下去。理由：prose 在交办那一刻就冻结，会和后续改口径冲突。

- **live 实证**：真机重放脚本里用户原话是「往 empty-one 的 W1 加 3 条，a=1/**b=2**/c=3」（`scripts/eval/real/live-replay.ts:66`），但已确认并写进库的是 **b=9**（读回 `a=1/b=9/c=3`，`docs/ops/live-replay.md:55`；判据 `scripts/eval/real/live-replay.ts:211`、`:225`）。若 Worker 拿冻结的原文当任务内容重跑 prepare，会照旧值 b=2 再提一次，与已确认的 b=9 提案冲突、被执行层绑定校验拒掉——真模型验收里这一现象实测为「13/14 个续跑回合先重跑 prepare 而不是 commit」（`packages/agent/src/execution-runtime.ts:1132-1134`）。
- **现行缓解（已实现，临时）**：不把操作名写进续跑事实，且明确指令「下一步是提交」（`renderConfirmationResumeFact`，`packages/agent/src/execution-runtime.ts:1142-1160`；守卫 `packages/agent/background-write-confirmation.test.ts:505`）。这解决的是「别误重跑 prepare」，**不等于**交办已结构化。
- **确认回合以「已确认的提案」为任务内容，原有意图让位**：写确认后继续时，任务内容切成已确认提案的载荷原文（宿主机械持有、`args` 逐字交回；`docs/architecture/contract.md` §1 确认面、`packages/agent/src/execution-runtime.ts:1142-1160`）。
- **结构化交办本身未实现**：现行 `TASK_RUN_TOOL_SCHEMA` 只收一个自然语言 `task` 字符串（`packages/agent/src/execution-runtime.ts:119`），委派块 = 任务原文 + 能力快照 + 文件清单（`renderWorkerDelegation`，`packages/agent/src/execution-runtime.ts:1201`），**无**「能力 + 业务输入」的结构化字段。待办守卫形状见 §7。

## 5. 三条禁令（每条配守卫，或明确标未实现）

1. **Main 不得拥有执行权（不得调 `operation`）**。现状：Main 工具面不含 `execute_operation`、也不含任何 `op_*`（装配 `packages/agent/src/execution-runtime.ts:3126-3141`）；执行权只下放给 Worker 的每-operation `op_*` 工具（注册 `:2966`、`:4305`，生成 `:3466`），`execute_operation` 仅是内部 exec 路由键（`:2741`、`:4097`），不是模型可见工具、原工具工厂已删。Main exec 对集合外工具抛「Main 工具面之外的调用」（`:3220`、`:3266`）。守卫：`packages/agent/main-skill.test.ts:332`（缺省面精确等于 `[task_run, task_status, task_result]`）、`packages/agent/main-capability-surface.test.ts:63`（Main 面排除 `execute_operation`）、`packages/agent/task-surface.test.ts:375`（Worker 面恰好 `op_dummy_query`、明确不含 `execute_operation`）、`packages/agent/pi-driver-wake.test.ts:435`（唤醒回合不含 `execute_operation`）。**能红**：任一测试把 `execute_operation` 或 `op_*` 加进 Main 面即失败。**但**缺一条「Main 硬发执行工具被执行层零调用」的直接绊线（现有最贴近的是唤醒回合 `packages/agent/pi-driver-wake.test.ts:470`）——**待补**，形状见 §7。
2. **Worker 不得直接对用户说话**。现状：Worker 只产出事实汇报，用户可见文本取 Main 最终回复（`packages/agent/src/execution-runtime.ts:22-24`、出口 `:3276-3283`）；Worker 提示要求写成可转述的事实、不带内部形态（`WORKER_SYSTEM_PROMPT`，`:584`）。守卫：`apps/server/factword-no-internal-terms.test.ts`（Worker 提示/委派文本无内部词）、`packages/agent/worker-prompt.test.ts:84`（提示形状锁定）。**能红**：Worker 提示或委派文本出现「对用户说/执行层/内部编号」即失败。注：这是「Worker 输出不直接进用户可见面」的结构性保证，不是「模型不会自己编话」的模型行为保证——后者属 Pi 原生与评测，见 §6。
3. **能力目录不得手写常量表（必须由 operation 声明派生）**。**已实现（有守卫）**：目录完全由 `deriveCapabilityCatalog` 从执行层声明派生，无业务名常量表（`packages/agent/src/capability-catalog.ts:45`）；守卫 `packages/agent/capability-catalog.test.ts:18`（空清单 → 空目录）、`:22`（全部未声明 → 空目录）、`:37`（加一条声明即多一条目录，证明派生）。任一守卫红即视为禁令破。

## 6. 现状登记（2026-11-20，基于 `123c0b8b` `arch/integration`）

逐条如实，禁止把目标态读成现状：

1. **能力目录已派生、已接 Main 面**：`capability` 字段（`execution-contract.ts:92`）+ `deriveCapabilityCatalog`（`capability-catalog.ts:45`）+ `capabilities()` 工具（`execution-runtime.ts:260`）+ 装配（`ask-runtime.ts:1068`、`:1072`）；守卫 `capability-catalog.test.ts`、`main-capability-surface.test.ts`、`capability-catalog-assembly.test.ts`（§2）。
2. **动态工具已合入（现行）**：Worker 工具面按模型可见 operation 生成每-operation `op_*` 工具（生成 `execution-runtime.ts:3466`、注册 `:2966` / `:4305`），hostOnly 参数不漏进 schema；守卫 `packages/agent/dynamic-worker-tools.test.ts`、`packages/agent/task-surface.test.ts:375`（面快照恰好 `op_dummy_query`、不含 `execute_operation`）。`execute_operation` 已从工具面退场，不再是 Worker 工具（旧叙述「Worker 仍持 execute_operation」已作废）。
3. **答复五态分类器已实现**：`classifyOutcome`（`task-outcome.ts:71`）归五值；`unsupported`/`blocked` 零执行分支与结构化原因码 `not_permitted`/`unsupported` 已接（B2/B3）；出口 `renderOutcomeFact`（`:135`）。守卫 `packages/agent/task-outcome.test.ts`、`apps/server/task-outcome-reason.test.ts`。
4. **outcome `partial` 待接线**：分类器逻辑在（`task-outcome.ts:102-109`），但底账 `ExecutionRecord` 无 `items`（`task-registry.ts:148-156`），无法从底账投影判 partial（§3「未接线」注）。
5. **`execute_operation` 工具工厂已删，只剩内部路由键**：2026-11-20 按删除纪律删去零调用点的 `executeOperationTool()` 工厂（旧 `:3446`，现为删除注）；保留 `EXECUTE_OPERATION_TOOL` 常量仅作内部 exec 路由键（`:2741`、`:4097`）与夹具直调入口（`packages/agent/testing/internal-exec-fixture.ts`）——**不是任何模型可见工具**。Main 面不含它、硬调被拒（禁令 1；`packages/agent/main-skill.test.ts:332`、`packages/agent/main-capability-surface.test.ts:63`）；Worker 面只有 `op_*`（`packages/agent/task-surface.test.ts:375`）。
6. **结构化交办未实现**：`task_run` 仍收自然语言 `task`（§4）；不影响 B2/B3 分类器对零执行/权限拒绝的判据。

## 7. 约束—守卫状态表

四档：`已有守卫` / `部分守卫` / `待实现（守卫待补）` / `未实现（无守卫）`。「能红」= 故意破坏约束时该测试必失败。本轮逐条区分：结构化判据类守卫已就地核对断言形状；B3/F3-1 的 blocked 反向绊线（`apps/server/task-outcome-reason.test.ts`）亲自反向执行过（见该文件末注），其余未逐条反向执行，如实标「已有/待补」。

| 约束 | 状态 | 守卫/出处（文件 + 断言形状） |
| --- | --- | --- |
| 四角色分工（Main 无执行权） | 部分守卫（见禁令 1） | 已有：`packages/agent/main-skill.test.ts:332`（缺省 Main 面）、`packages/agent/task-surface.test.ts:375`（Worker 面 `op_*`、无 `execute_operation`）、`packages/agent/main-capability-surface.test.ts:63`、`packages/agent/pi-driver-wake.test.ts:435`（唤醒面排除）；待补：Main 硬发执行工具零执行绊线 |
| Main 对用户的承诺权来自派生目录 | 已有守卫 | `scripts/capability-catalog-assembly.test.ts:77`（声明 capability → Main 摘要 + capabilities 工具）；`packages/agent/main-capability-surface.test.ts:59` |
| Worker 无话语权、不直接对用户说话 | 部分守卫 | 已有：`factword-no-internal-terms.test.ts`、`worker-prompt.test.ts:84`（输出不含内部形态）；结构性保证已有，模型行为归评测 |
| 用户不需懂内部形态 | 已有守卫 | `factword-no-internal-terms.test.ts`、`packages/agent/user-facing-failure.test.ts:150`、`packages/agent/main-capability-surface.test.ts:66` |
| 宿主不替双方做决定/不复制执行层规则 | 已有守卫（既有责任面） | `packages/agent/import-boundary.test.ts`（旧治理模块不复活）、`docs/architecture/contract.md` §2–§3；本档未新增守卫 |
| `capability` 单字段 + 多阶段共享值 | 已有守卫 | `packages/agent/capability-catalog.test.ts:28`（同 capability 的 query/prepare/commit 分组为一项、read/write 并集） |
| 按 `capability` group by 派生、不手写第二套（禁令 3 重点） | 已有守卫 | `capability-catalog.test.ts:18`（空清单 → 空目录）、`:22`、`:37`（加声明即多一条，篡改/写死常量表 → 红） |
| Main 侧摘要 + `capabilities()` 只读、无 operation 名/参数 | 已有守卫 | `main-capability-surface.test.ts:59`、`:66`、`capability-catalog.test.ts:60`；`capability-catalog-assembly.test.ts:66` |
| 未声明 `capability` 退化为现状 + 显式登记 | 已有守卫 | `capability-catalog-assembly.test.ts:66`（undeclared 事件 + 提示不变 + 无工具）、`:77` |
| outcome `completed` 逐项如实 | 部分守卫 | 分类器 `task-outcome.ts:107`、测试 `task-outcome.test.ts:24`、`:30`；出口接线见下行 |
| outcome `partial` 逐项如实（底账 items 接线） | **未实现/待接线（无守卫）** | 分类器逻辑在（`task-outcome.ts:102-109`），但底账 `ExecutionRecord` 无 items（`task-registry.ts:148-156`），无法从底账投影判 partial（§3 注）。待补守卫：底账 items 落账 + partial 不说成成功 |
| outcome `unsupported` 零执行、绝不提「再试一次」 | 已有守卫 | `task-outcome.test.ts:48`、`:55`、`:156`（G4 无「再试/重试/retry」）、`:177`（结构化码接上） |
| outcome `blocked` 缺条件说「缺 X」+补法（只用结构化码，不扫文案） | 已有守卫（反向绊线亲自反向执行过） | `apps/server/task-outcome-reason.test.ts:14`（reason 含「权限」但码非 not_permitted → 不得 blocked）、`:25`、`:30`；缺失条件非空 `task-outcome.test.ts:162`；B3 码接上 `:177` |
| `failed` 该重试才说重试 | 已有守卫 | `packages/agent/deterministic-failure-guard.test.ts:222`、`:179`；`packages/agent/user-facing-failure.test.ts:117` |
| 交办 = 结构化意图（能力 + 输入） | 未实现（无守卫） | 待办守卫（schema 含能力与结构化输入，不再仅 `task` 字符串） |
| 确认回合以已确认提案为任务内容 | 已有守卫 | `packages/agent/background-write-confirmation.test.ts:505`；持久化 `packages/agent/src/execution-runtime.ts:1132-1160` |

**守卫缺口不能冒充通过**：上表标「已有守卫」的项已就地核对断言形状，B3/F3-1 的反向绊线亲自反向执行过；其余未逐条反向执行，不冒充全绿。标「部分守卫」「未实现/待接线」「未实现（无守卫）」的项（Main 硬发零执行绊线、partial 底账 items 接线、结构化交办）如实登记，不写成已实现。
