# 宿主 ↔ 执行层：契约与禁止面

> 状态：现行。契约只承载最小执行语义；治理、业务与副作用判定归执行层；宿主禁止面由常驻守卫钉住。
> 最后核对：2026-11-18（指针以现行代码为准；文档与代码冲突就地标 ⚠️，以代码为准）。
> 上游指针：`AGENTS.md:22-30`（职责边界）、`:38`（禁止新增）、`:52-53`（跨层协议）；`docs/decisions/index.md`；`packages/contracts/src/execution-contract.ts`。

## 1. 契约的语义面

契约只定义语义、零传输实现：模块零 import，依赖方向「适配器 → 契约 ← 运行时」（`packages/contracts/src/execution-contract.ts:1-6`；守卫 `packages/agent/import-boundary.test.ts:188-191`）；`EXECUTION_CONTRACT_VERSION = 3`（`:37`）。

- **能力快照**：每会话取一次 `CapabilityManifest`，按其装配工具面；`operations[]` 只带执行层自述的 name/label/args/weight/estimatedSeconds（`packages/contracts/src/execution-contract.ts:51-69`），成本提示原样转述，宿主不解释、不裁档。
- **请求**：`requestId`（宿主生成，重试换号，只作追踪）＋ `dispatchKey`（首次创建这笔逻辑操作时生成并持久化，重试/重规划只读回同值）＋ `operation` ＋ 对宿主不透明的 `args`（`:71-85`）；身份一致由 `packages/agent/dispatch-key-identity.test.ts` 钉住。
- **结果五态互斥**：completed / needs_confirmation / needs_input / failed / refused（`packages/contracts/src/execution-contract.ts:96`、`:137-142`）。`refused`＝策略拒绝、`failed`＝执行失败，不得混用（`:16-20`）；`needs_input` 必带非空 `missing`，`needs_confirmation` 必带非空 handle/summary（`:17-20`、`:105-118`）。
- **确认仍走同一次 execute**：执行层先返 `needs_confirmation`，下一回合宿主把 `confirmation{handle, userText}` 原样带回；handle 不透明，宿主不解析、不比较、不判「这是不是在确认」（`:86-92`、`:127-136`；`packages/agent/write-confirmation.test.ts:339`）。
- **取消只带信号**：`ExecutionCallOptions.signal`，不是独立 cancel 协议；适配器可忽略，宿主不依赖执行层配合也能终结任务（`:144-152`）。
- **失败默认不可重试**：`ExecutionFailure.retryable` 缺省 = 不可重试，只有执行层显式 `true`（超时/网关暂不可用等瞬时故障）才放行；`false` 与未声明一律让宿主锁住该 `(operation, 对象)` 本回合不再发起（`packages/contracts/src/execution-contract.ts:121-134`；`packages/agent/src/execution-runtime.ts:1675-1690`、`:1744`）。每次拦截落一条 `execution_retry_blocked` 事件（operation/object/code/declaredRetryable，`apps/server/server.ts:830-840`），告警归部署侧读事件，宿主不自建告警通道。

宿主「允许集合」不在契约里：装配方从执行层 `access` 派生（只读集合，`allowWriteOperations=true` 时并入写集合），发起前确定性拒绝集合外调用（`scripts/ask-runtime.ts:344-354`；`packages/agent/src/execution-runtime.ts:1546-1549`）。它挡的是「宿主没开这个口」，不是业务授权。
## 2. 刻意不放进契约

| 项 | 处置与指针 |
| --- | --- |
| readback | `completed` 只表示执行完成，不代表业务生效（`packages/contracts/src/execution-contract.ts:24`、`:130`） |
| effects / requiresConfirmation | 契约不携带，宿主适配器也不读（`:31-33`；`packages/agent/src/dummy-cli-client.ts:43-54`） |
| 计划治理 / 预算梯子 / 计划门 | 不开第二份裁决面，旧预算梯子不得包装成确认回环；Main 直接委派 Worker（`AGENTS.md:29`；`packages/agent/src/execution-runtime.ts:36-38`） |
| 授权策略 / 业务字段 | 归执行层声明与校验；宿主不建实体门（`AGENTS.md:30`、`:52`） |
| 第二套协议 | 确认是同一 execute 上的最小增量；与官方 A2A 完全独立、不得冒充（`:25-30`） |

宿主只留三类确认职责：按装配开关派生允许集、会话级小表记执行层发放的确认提示、下一回合把句柄与本回合用户原话原样透传（`packages/agent/src/execution-runtime.ts:36-40`）。冻结、操作绑定、有效期、一次性/防重放与业务校验全归执行层（`packages/contracts/src/execution-contract.ts:27-30`）。

> ⚠️ `AGENTS.md:53` 把 `effects` 列为宿主「只识别」的通用字段之一，但现行生产代码无读取点（仅契约注释 `:31` 与 eval sim 计数器）。以代码为准：`effects` 目前不是跨层字段。
## 3. 宿主禁止清单

禁止新增（`AGENTS.md:38`）：Planner、Router、意图分类器、规则引擎、事件总线、通用 Workflow Engine、平台模拟框架、新任务状态框架、第二套协议、Docker/K8s/沙箱。

四条常驻守卫：旧治理模块不得经值边复活（`packages/agent/import-boundary.test.ts:47-104`，断言 `:185-186`）；过渡命名不得回流（`packages/agent/transition-naming.test.ts:40`）；契约不得长出实现（`packages/agent/import-boundary.test.ts:188-196`）；装配不得旁路（§5）。逐条边界：

- **Planner / Router / 意图分类器 / 规则引擎**：理解、规划、工具选择、多轮交互归 Pi（`AGENTS.md:15`）；预算梯子与计划裁决归执行层（`packages/contracts/src/execution-contract.ts:31-33`）；宿主不另建记忆、检索、语义投影（`packages/agent/src/execution-runtime.ts:40`）。
- **事件总线 / 新任务状态框架**：任务事实只做单回调 `onTaskFact`，无订阅体系、无持久化事件流（`packages/agent/src/task-registry.ts:23`、`:569`；`packages/agent/src/task-runner.ts:15`）。
- **沙箱**：`run_js` 是受限子进程而**不是沙箱**——网络未阻断、无 OS 级隔离、提示注入仍可驱动模型写代码（`packages/agent/src/run-js-executor.ts:14`、`:36-38`）；新增 Docker/K8s/沙箱属本轮范围外。
## 4. 资源旋钮：单一配置源

唯一配置入口是 YAML `runtime` 段（无同名 env 覆盖口）。类型面 `TaskBudgetConfig` / `RuntimeConfig`（`packages/contracts/src/config.ts:133`、`:155`）；解析 fail-fast，未知键拒绝、非法值 throw（`packages/core/src/config.ts:140-155`、`:183-187`）；缺省与解释只一处（`packages/agent/src/resource-policy.ts:175-197`、`:286-330`）。消费点只读解析值，不得重读 `config.runtime.*`、不得自带第二份缺省（`scripts/ask-runtime.ts:600-601`；`packages/agent/src/execution-runtime.ts:1091-1092`）。

守卫 `packages/agent/resource-policy-single-source.test.ts`：已删 `host.*` 六键与 `FSHINE_*` 覆盖口生产零引用（`:58-76`）；旋钮名只允许出现在登记的所有者文件，所有者表双向闭合（`:94-109`）。已知缺口：`runtime.taskRunWaitMs` 在类型面与策略缺省存在，但 YAML 白名单 `RUNTIME_KEYS` 未收（`packages/core/src/config.ts:140-155`），写它是「未知字段」，只有程序内注入可达。
## 5. 单一装配点

生产面只有一条装配链 `assembleSessionCore`（`scripts/ask-runtime.ts:598`），顺序固定：stateDir/审计路径 → 隔离断言 → 执行面 → 底账 → 技能/角色 → 驱动 → `createSession`（`:600-620`）。入口差异全经输入面注入：`apps/server/server.ts:363`、`scripts/eval/convergence-r1/runner.ts:383`、`scripts/ask-replay.ts:588`、`scripts/ask.ts:212`。第二份装配会让允许集合派生、资源策略解析、拒绝话术各漂各的，产生「写着不生效」的假配置/假拒绝。

守卫 `scripts/p0-assembly-single-point.test.ts`：装配符号各只命中一个生产文件（`:171-184`）；六个入口沿相对导入图都到达该文件（`:186-193`）；五门拒绝话术各只一个生产文件（`:195-200`）。
## 6. 现行变更安全不变量（唯一提炼面）

| 不变量 | 机械判据 / 指针 |
| --- | --- |
| 可信身份 / 任务归属越权读取被拒 | 子进程 env 白名单重建（`packages/agent/src/run-js-executor.ts:17-18`）；单写路径 + `onTaskFact`（`packages/agent/src/task-registry.ts:23`、`:569`）；`packages/agent/task-registry-sqlite.test.ts` |
| 完成状态如实 / 允许集合外调用发起前拒绝 | `judgeReportedTask`（`docs/history/decision-log-part01-2026-11_undated.md:646-662`）；`scripts/ask-runtime.ts:344-354`；`packages/agent/src/execution-runtime.ts:1546-1549` |
| 确认回环只透传、宿主不裁决 | `packages/agent/write-confirmation.test.ts:339`；`scripts/host-write-confirmation.test.ts:357` |
| 结构性守卫：契约零 import / 旧治理不复活 / 命名不回流 | `packages/agent/import-boundary.test.ts:185-191`；`packages/agent/transition-naming.test.ts:40` |
| 单一配置源 / 单一装配点 / 非沙箱风险如实登记 | `packages/agent/resource-policy-single-source.test.ts:161-204`；`scripts/p0-assembly-single-point.test.ts:170-201`；`packages/agent/src/run-js-executor.ts:36-38` |

A 类（模型能力补丁）不变量一律看消融/模型 Eval，不因「有代码、有守卫」固化（`AGENTS.md:43-45`）；历史判据档案 `docs/architecture-laws.md:11` 已注明多数守卫引用随 M4 退役。
