# 能力边界：柜台（Main）／后台部门（Worker）／客户（用户）／宿主

> 状态：现行判据档（owner 已定，作为后续所有切片的判据；**本文描述的机制多为目标态，未实现处逐条明确标注**）。
> 最后核对：2026-11-20（基线 `966da5b4`；一切以现行代码为准，冲突就地标 ⚠️）。
> 上游指针：`AGENTS.md`（定位/职责边界/新增机制准入）、`docs/architecture/contract.md`（执行契约语义面）、`docs/product/capability.md`（用户级能力台账与四档状态纪律）；`packages/contracts/src/execution-contract.ts`、`packages/agent/src/execution-runtime.ts`。

owner 的类比（原文）：**「相当于 Main 的工作台里对客户罗列了业务范围，拿到用户提交的资料后给下游部门完成工作，然后再反馈结果给用户」**。本文把它拆成四件事：四个角色各自的权（§1）、单一来源的能力目录（§2）、Worker→Main 的结构化答复契约（§3）、结构化交办格式（§4），末尾三条禁令（§5）与现状/守卫登记（§6、§7）。

**读法约定**：本文是**判据档**，不是实现报告。凡未实现处写「未实现／待办」并给出守卫形状；凡写「已实现」必挂一个能变红的守卫（文件名 + 断言形状，见 §7）。禁止把目标态读成现状。

## 1. 四个角色与各自的权

柜台—后台—客户—宿主的类比落到本仓的真实边界如下（"有什么 / 没有什么"两列即判据，逐条守卫状态见 §7）：

| 角色 | 对谁 | 有什么权 | 没有什么（硬禁） |
| --- | --- | --- | --- |
| **Main（柜台）** | 只对用户 | **承诺权**（能不能办：来自派生目录，见 §2）、澄清（问对象/范围/口径）、汇报（结论+数据）、本地加工（`run_js` / `recalc_xlsx` 这类宿主确定性工具） | **无执行权**：不得调用任何平台 `operation`。现行 Main 工具面 = `task_run` + `task_status` / `task_result`（+ runner 时 `task_cancel` / `task_resume` / `task_confirm`，+ 注入时 `read_skill` / `run_js` / `recalc_xlsx`），**不含** `execute_operation`（装配见 `packages/agent/src/execution-runtime.ts:3040-3055`，缺省面断言见 `packages/agent/main-skill.test.ts:332`、Worker-only 面见 `packages/agent/task-surface.test.ts:371`）。⚠️ `execute_operation` 工具本身仍在代码里（`:386`、`:3344`）但只注册给 Worker（`:2879`、`:3998`）——见 §6 现状第 4 条 |
| **Worker（后台部门）** | 只对宿主/委派方 | **执行权**：调动态工具（`execute_operation`，操作名与参数照委派清单填）、取证（真实结果与「缺什么/办到哪一步」） | **无话语权**：不得直接对用户说话；只把事实汇报给 Main，由 Main 转述（`WORKER_SYSTEM_PROMPT` 要求「写成一段能直接转给别人看的事实」：`packages/agent/src/execution-runtime.ts:540-549`；Worker 工具面快照只有 `execute_operation`：`packages/agent/task-surface.test.ts:394`） |
| **用户（客户）** | —— | 交办、确认、叫停（`task_confirm` / `task_cancel` 的显式动作）；随时接管（查状态、查结果） | 不需要懂系统结构：看不到 operation 名、参数、句柄、任务编号等内部形态（用户可见面无内部词由 `apps/server/factword-no-internal-terms.test.ts` 与 `packages/agent/user-facing-failure.test.ts:150` 守卫） |
| **宿主** | —— | 身份/时机/事实/凭据/投递与记账（可信 principal、状态变化才唤醒、机械事实、句柄原样透传、用户可见文本投递、执行与投递记账） | 不替双方做决定（不判「用户是不是在确认」、不做业务裁决）、不复制执行层规则（实体授权、口径、有效期归执行层；`docs/architecture/contract.md` §2–§3） |

**柜台类比的两处修正**（避免把类比读歪）：
- 「罗列业务范围」不是 Main 背一份清单，而是宿主按执行层声明**派生**目录后按需注入（§2）——Main 自身不持有、不记忆业务范围。
- 「拿到用户提交的资料」在写确认路径上以**已确认的提案**为准，不是原始交办 prose（§4）。

## 2. 能力目录：单一来源 + 派生，禁止第二套

柜台能向客户罗列的范围**必须只有一个事实源 = 执行层的 operation 声明**，宿主派生、不另立清单。理由：两处声明必然漂移，且漂移时用户会被承诺一件执行层办不到的事。

- **加一个字段**：在执行层既有 operation 声明上加 `capability: string`（业务名，如「录入凭证」）。同一件业务的多个阶段（`query` / `prepare` / `commit`）**共享同一个 `capability` 值**——它们是同一能力的阶段，不是多件能力。**未实现**：`ExecutionOperationDeclaration` 当前字段为 `name/label/args/weight/estimatedSeconds/long_running/model_visible`，**无 `capability`**（`packages/contracts/src/execution-contract.ts:71-98`）。
- **group by 派生**：宿主按 `capability` 对操作声明分组，派生给 Main 的目录 = （业务名 + 只读/可写）。只读/可写的既有派生源是执行层 `access=read`/`access=write`（`scripts/ask-runtime.ts:436`、`:450-451`；`packages/contracts/src/config.ts:221-222`）——不要在能力目录里重造第二套读写判据。**未实现**：无按 `capability` 分组的代码。
- **不单独声明清单**：能力目录不得手写一份业务名常量表（禁令 3，§5）。**未实现**：派生链路尚无守卫，待办守卫形状见 §7。
- **Main 侧形态**：一句极短摘要常驻 + 一个只读工具 `capabilities()` 按需查；**不含 operation 名、不含参数**。摘要常驻沿用 catalog 模式（`renderSkillCatalog`：`packages/agent/src/skills.ts:153-159`）。**未实现**：Main 工具面无 `capabilities()`（缺省面 `packages/agent/main-skill.test.ts:332-335`，注入面 `packages/agent/task-surface.test.ts:363`）。
- **未声明即退化为现状**：执行层未声明 `capability` 时退化为现状（Main 不知道边界；交办后由 Worker 判定能否执行），且宿主/装配必须**显式登记为「能力边界未声明」**，不许假装知道、不许承诺范围。现状即「未声明」态，该登记**未实现**；守卫形状见 §7。

## 3. Worker → Main 的答复契约（结构化 outcome，当前未实现）

Worker 的汇报必须是**结构化 outcome**，Main 据此套用统一话术——这样「办不了」和「没办成」不会被说成同一句、也不会被加一句「再试一次」。**整节未实现**：`ExecutionOutcome` 现行六态为 `completed / needs_confirmation / needs_input / failed / refused / accepted`（`packages/contracts/src/execution-contract.ts:131`、`:200-206`）；搜索代码中**无** `unsupported` / `blocked` outcome（本轮 `grep` 于 `packages/contracts/src`、`packages/agent/src` 零命中）。下表是目标态判据（owner 已定），逐条标现状：

| outcome | 机械判据 | Main 对用户说 | 现状 |
| --- | --- | --- | --- |
| `completed` | 全部项成功 | 结论 + 数据 | 六态之一（已有，`:201`）；`completed.items` 逐条结果已实现（`packages/agent/batch-write-items.test.ts:93`） |
| `partial` | 部分项成功 | 逐项说，**不得说成单纯成功** | 无独立 `partial` 态；现行用 `completed.items` 携带逐条 ok/failed/unknown，任务结局仍 completed（`:170-183`；守卫 `packages/agent/batch-write-items.test.ts:116`）。话术纪律已有 |
| **`unsupported`** | 零执行 + 无对应能力 | 「这件事我这边办不了」+ 能办的（**来自 §2 派生目录**）。**绝不提「再试一次」** | **未实现** |
| **`blocked`** | 有能力但缺条件（权限/口径/字段） | 「缺 X」+ 补的方式 | **未实现**；现行近似是 `needs_input`（缺输入，必带 `missing` 非空，`:150-153`、`:203`）与 `refused`（策略拒绝，`:205`），无「能力存在但条件不足」的独立态 |
| `failed` | 有能力、执行失败 | 「没办成」+ **该重试才说重试**（执行层 `retryable:true`；缺省/未声明按不可重试，`packages/contracts/src/execution-contract.ts:156-166`） | 六态之一（已有，`:204`）；「该重试才说重试」已有守卫（`packages/agent/deterministic-failure-guard.test.ts:222`、`:179`；话术 `packages/agent/user-facing-failure.test.ts:117`） |

**三处缺口的共性**：`unsupported` / `blocked` / `partial` 要判「零执行」「有能力」「部分项」都依赖 §2 的 `capability` 派生目录与 §4 的结构化交办——这三处是一组切片，不宜单独上一态（否则又造第二套判据）。守卫形状见 §7。

## 4. 交办格式：结构化意图，不是一段 prose

交办（Main → Worker）是**结构化意图 = 能力 + 业务输入**，不是把用户原文当一段 prose 交下去。理由：prose 在交办那一刻就冻结，会和后续改口径冲突。

- **live 实证**：真机重放脚本里用户原话是「往 empty-one 的 W1 加 3 条，a=1/**b=2**/c=3」（`scripts/eval/real/live-replay.ts:62`），但已确认并写进库的是 **b=9**（读回 `a=1/b=9/c=3`，`docs/ops/live-replay.md:55`；判据 `scripts/eval/real/live-replay.ts:211`、`:225`）。若 Worker 拿冻结的原文当任务内容重跑 prepare，会照旧值 b=2 再提一次，与已确认的 b=9 提案冲突、被执行层绑定校验拒掉——真模型验收里这一现象实测为「13/14 个续跑回合先重跑 prepare 而不是 commit」（`packages/agent/src/execution-runtime.ts:1076-1080`）。
- **现行缓解（已实现，临时）**：不把操作名写进续跑事实，且明确指令「下一步是提交，不是重新准备」（`renderConfirmationResumeFact`，`packages/agent/src/execution-runtime.ts:1083-1099`；守卫 `packages/agent/background-write-confirmation.test.ts:504`）。这解决的是「别误重跑 prepare」，**不等于**交办已结构化。
- **确认回合以「已确认的提案」为任务内容，原有意图让位**：写确认后继续时，任务内容切成已确认提案的载荷原文（宿主机械持有、`args` 逐字交回；`docs/architecture/contract.md` §1 确认面、`packages/agent/src/execution-runtime.ts:1065-1082`）。
- **结构化交办本身未实现**：现行 `TASK_RUN_TOOL_SCHEMA` 只收一个自然语言 `task` 字符串（`:113-124`），委派块 = 任务原文 + 能力快照 + 文件清单（`renderWorkerDelegation`，`:1134-1209`），**无**「能力 + 业务输入」的结构化字段。待办守卫形状见 §7。

## 5. 三条禁令（每条配守卫，或明确标未实现）

1. **Main 不得拥有执行权（不得调 `operation`）**。现状：Main 工具面不含 `execute_operation`，`execute_operation` 只注册给 Worker（`packages/agent/src/execution-runtime.ts:3040-3055` vs `:2879`、`:3998`）；Main exec 对集合外工具抛「Main 工具面之外的调用」（`:3169`）。守卫：`packages/agent/main-skill.test.ts:332`（缺省面精确等于 `[task_run, task_status, task_result]`）、`packages/agent/task-surface.test.ts:371`（Worker 面只有 `execute_operation`）、`packages/agent/pi-driver-wake.test.ts:435`（唤醒回合不含 `execute_operation`）。**能红**：任一测试把 `execute_operation` 加进 Main 面即失败。**但**缺一条「Main 硬发 `execute_operation` 被执行层零调用」的直接绊线（现有最贴近的是唤醒回合 `packages/agent/pi-driver-wake.test.ts:470`）——**待补**，形状见 §7。
2. **Worker 不得直接对用户说话**。现状：Worker 只产出事实汇报，用户可见文本取 Main 最终回复（`packages/agent/src/execution-runtime.ts:22-24`、`:3179-3180`）；Worker 提示要求写成可转述的事实、不带内部形态（`:540-549`）。守卫：`apps/server/factword-no-internal-terms.test.ts`（Worker 提示/委派文本无内部词）、`packages/agent/worker-prompt.test.ts:84`（提示形状锁定）。**能红**：Worker 提示或委派文本出现「对用户说/执行层/内部编号」即失败。注：这是「Worker 输出不直接进用户可见面」的结构性保证，不是「模型不会自己编话」的模型行为保证——后者属 Pi 原生与评测，见 §6。
3. **能力目录不得手写常量表（必须由 operation 声明派生）**。**未实现（无守卫）**：`capability` 字段和派生链路都还不存在，当前没有能力目录，也没有手写常量表可禁——待 `capability` 切片落地时**必须同时**加一条能红的守卫，否则不新增。守卫形状见 §7（本条是本档要求「能红守卫」的重点，未补前禁止把目录写成已实现）。

## 6. 现状登记（2026-11-20，基于 `966da5b4`）

逐条如实，禁止把目标态读成现状：

1. **动态工具在 `feat/dynamic-tools` 分支未合入**：该分支 HEAD = `966da5b4`（与本档基线同一提交），`git log 966da5b4..feat/dynamic-tools` 为空——分支无额外提交，动态工具能力不在本基线代码中。
2. **`capability` 字段未加**：`ExecutionOperationDeclaration` 无该字段（`packages/contracts/src/execution-contract.ts:71-98`）。
3. **outcome 契约未实现**：无 `unsupported` / `blocked` 独立态；`partial` 借 `completed.items` 表达（§3）。
4. **Main 的 `execute_operation` 仍在**：工具常量与工厂仍在代码里（`packages/agent/src/execution-runtime.ts:386`、`:3344`），并在 Worker 两处注册（`:2879`、`:3998`）；Main 面不含它（`:3040-3055`）。「仍在」指**代码/工具存在**，**不等于** Main 能调用——Main 面没有它、硬调被拒（`:3169`；缺省面断言 `packages/agent/main-skill.test.ts:332`）。真正删除该工具是后续切片（禁令 1 的完全体），本档不宣称已删。
5. **能力目录未派生**：Main 无 `capabilities()` 工具、无 group-by 目录、无「能力边界未声明」登记（§2）。
6. **结构化交办未实现**：`task_run` 仍收自然语言 `task`（§4）。

## 7. 约束—守卫状态表

四档：`已有守卫` / `部分守卫` / `待实现（守卫待补）` / `未实现（无守卫）`。「能红」= 故意破坏约束时该测试必失败（本轮未逐条反向执行，只在表内如实标「已有/待补」）。

| 约束 | 状态 | 守卫/出处（文件 + 断言形状） |
| --- | --- | --- |
| 四角色分工（Main 无执行权） | 部分守卫（见禁令 1） | 已有：缺省 Main 面精确断言、Worker 面快照、唤醒面排除；待补：Main 硬发 `execute_operation` 零执行绊线 |
| Main 对用户的承诺权来自派生目录 | 未实现（无守卫） | 待 `capability` 切片与 §2 一起补 |
| Worker 无话语权、不直接对用户说话 | 部分守卫 | 已有：`factword-no-internal-terms.test.ts`、`worker-prompt.test.ts:84`（输出不含内部形态）；结构性保证已有，模型行为归评测 |
| 用户不需懂内部形态 | 已有守卫 | `factword-no-internal-terms.test.ts`、`packages/agent/user-facing-failure.test.ts:150` |
| 宿主不替双方做决定/不复制执行层规则 | 已有守卫（既有责任面） | `packages/agent/import-boundary.test.ts`（旧治理模块不复活）、`docs/architecture/contract.md` §2–§3；本档未新增守卫 |
| `capability` 单字段 + 多阶段共享值 | 未实现（无守卫） | 待办守卫（字段名存在 + 同 `capability` 的 query/prepare/commit 分组为一项） |
| 按 `capability` group by 派生、不手写第二套 | 未实现（无守卫，**禁令 3 重点**） | 待办守卫（能红）：篡改/写死业务名常量表 → 红；派生结果与执行层声明不一致 → 红 |
| Main 侧摘要 + `capabilities()` 只读、无 operation 名/参数 | 未实现（无守卫） | 待办守卫（`capabilities()` 工具面存在且输出不含 operation 名/参数） |
| 未声明 `capability` 退化为现状 + 显式登记 | 未实现（无守卫） | 待办守卫（缺声明时登记「能力边界未声明」、不伪造目录） |
| outcome `completed` / `partial` 逐项如实 | 部分守卫 | 已有：`packages/agent/batch-write-items.test.ts:116`（partial 不说成成功）；`unsupported`/`blocked` 另见下 |
| outcome `unsupported` 零执行、绝不提「再试一次」 | 未实现（无守卫） | 待办守卫（判据 + 话术断言） |
| outcome `blocked` 缺条件说「缺 X」+补法 | 未实现（无守卫） | 待办守卫 |
| `failed` 该重试才说重试 | 已有守卫 | `packages/agent/deterministic-failure-guard.test.ts:222`、`:179`；`packages/agent/user-facing-failure.test.ts:117` |
| 交办 = 结构化意图（能力 + 输入） | 未实现（无守卫） | 待办守卫（schema 含能力与结构化输入，不再仅 `task` 字符串） |
| 确认回合以已确认提案为任务内容 | 已有守卫 | `packages/agent/background-write-confirmation.test.ts:504`；持久化 `packages/agent/src/execution-runtime.ts:1065-1099` |

**守卫缺口不能冒充通过**：本轮跑通的是文档守卫（索引/指针）与全量 vitest，它们只证明「本文没写坏索引/引用、没碰坏现有测试」，不证明上表标「未实现/待办」的约束已生效。
