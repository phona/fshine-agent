# 宿主 ↔ 执行层：契约与禁止面

> 状态：现行。契约只承载最小执行语义；治理、业务与副作用判定归执行层；宿主侧禁止面由常驻守卫钉住。
> 最后核对日期：2026-11-18（本 worktree `fshine-agent-docs` @ `32a331c`，分支 `docs/restructure`；实跑 `npx vitest run --project unit` 三守卫 → 3 files / 7 tests passed）。
> 上游指针：`AGENTS.md:22-30`（职责边界）、`:38`（禁止新增）、`:52-53`（跨层协议）；`docs/decisions/index.md`（现行决定索引）+ `docs/history/decision-log-part01-2026-11_undated.md:642` §十三（契约收口）；本节 §6 为现行变更安全不变量的唯一提炼面（原 history 骨架已删）；`packages/contracts/src/execution-contract.ts`。

## 1. 执行契约的语义面

契约只定义语义、零传输实现：模块内零 import，依赖方向「适配器 → 契约 ← 运行时」（`packages/contracts/src/execution-contract.ts:1-6`；守卫断言 `packages/agent/import-boundary.test.ts:188-191`）。语义版本 `EXECUTION_CONTRACT_VERSION = 3`（`packages/contracts/src/execution-contract.ts:37`）。

- **能力快照**：`CapabilityManifest` 每会话取一次，按它装配工具面；`operations[]` 只带执行层自述的 name/label/args/weight/estimatedSeconds（`packages/contracts/src/execution-contract.ts:51-63`、`:66-69`）。成本提示原样转述，宿主不解释、不裁档（`:57-60`；投影 `packages/agent/src/dummy-cli-client.ts:183-190`）。
- **请求**：`requestId`（宿主生成，重试换号）＋ `dispatchKey`（宿主首次创建这笔逻辑操作时生成并持久化，重试/重规划只读回同值）＋ `operation` ＋ 对宿主不透明的 `args`（`packages/contracts/src/execution-contract.ts:71-85`）；身份一致由 `packages/agent/dispatch-key-identity.test.ts` 钉住。
- **结果五态互斥**：completed / needs_confirmation / needs_input / failed / refused（`:96`、`:137-142`）。`refused`＝执行层策略拒绝、`failed`＝执行失败，不得混用（`:16-20`、`:135`）；`needs_input` 必带非空 `missing`，`needs_confirmation` 必带非空 handle/summary（`:17-20`、`:105-118`）。
- **确认仍走同一次 execute**：执行层先返 `needs_confirmation`，下一回合宿主把 `confirmation{handle, userText}` 原样带回；handle 不透明，宿主不解析、不比较、不判「这是不是在确认」（`:86-92`、`:127-136`）。证据：`packages/agent/write-confirmation.test.ts:339`「宿主侧的 confirmation（句柄 + 用户原话）原样到达执行层调用体」；端到端 `scripts/host-write-confirmation.test.ts:357/407/449`。
- **取消只带信号**：`ExecutionCallOptions.signal`，不是独立 cancel 协议；不支持中止的适配器可忽略，宿主不依赖执行层配合也能终结任务（`:144-152`）。

宿主「允许集合」不在契约里：哪一轮开放哪些 operation 由装配方从执行层 `access` 声明派生（只读集合，`allowWriteOperations=true` 时并入写集合），发起前确定性拒绝集合外调用（`scripts/ask-runtime.ts:344-354`；`packages/agent/src/execution-runtime.ts:1540-1542`）。它挡的是「宿主没开这个口」，不是业务授权。

## 2. 刻意不放进契约的清单

清单本体在 `packages/contracts/src/execution-contract.ts:23-33`，按「缺了会怎样」读：

| 不放进契约的项 | 现行处置 | 指针 |
| --- | --- | --- |
| readback（副作用已验证） | `completed` 只表示执行完成，不代表业务生效；写切片再定 | `packages/contracts/src/execution-contract.ts:24`、`:130` |
| effects / requiresConfirmation | 契约不携带；宿主适配器也不读清单里的 `effects` | `packages/contracts/src/execution-contract.ts:31-33`；`packages/agent/src/dummy-cli-client.ts:43-54` |
| 计划治理 / 预算梯子 | 不开第二份裁决面；旧预算梯子不得包装成确认回环 | `packages/contracts/src/execution-contract.ts:31-33`；`AGENTS.md:29` |
| 授权策略 / 业务字段 | 归执行层声明与校验；宿主不建实体门 | `AGENTS.md:30`、`:52` |
| 计划门 | Main 直接委派 Worker，Worker 结构化调用执行层；宿主不设计划门 | `AGENTS.md:69`；`packages/agent/src/execution-runtime.ts:36-38` |
| 第二套协议 | 确认是同一 execute 上的最小增量；与官方 A2A 完全独立、不得冒充 | `packages/contracts/src/execution-contract.ts:25-30`；`AGENTS.md:24-26` |

宿主只留三类确认职责：按装配开关派生允许集、会话级小表记执行层发放的确认提示、下一回合把句柄与本回合用户原话原样透传（`packages/agent/src/execution-runtime.ts:36-40`）。冻结、操作绑定、有效期、一次性/防重放与业务校验全归执行层（`packages/contracts/src/execution-contract.ts:27-30`）。

> ⚠️ 文档与代码不一致：`AGENTS.md:53` 把 `effects` 列为宿主「只识别」的通用字段之一；现行生产代码无 `effects` 读取点（全仓 grep 仅命中契约注释 `:31` 与 eval sim 计数器 `scripts/eval/sim/write-system.ts:39`），适配器清单形状也无该字段（`packages/agent/src/dummy-cli-client.ts:43-54`）。以代码为准：`effects` 目前不是跨层字段。

## 3. 宿主禁止清单

禁止新增（`AGENTS.md:38`）：**Planner、Router、意图分类器、规则引擎、事件总线、通用 Workflow Engine、平台模拟框架、新任务状态框架、第二套协议、Docker/K8s/沙箱**。四条常驻守卫把「回潮」变成测试红：

1. **旧治理模块不得经值边复活**：`packages/agent/import-boundary.test.ts:47-104` 为 FORBIDDEN 墓碑清单（plan-runtime / budget-policy / proposal-review / task-handover 等），断言 `:185-186`，入口范围 `:22-36`。
2. **过渡命名不得回流**：`packages/agent/transition-naming.test.ts:40` 禁 minimal/legacy/deprecated/m2/m3/v2，路径与标识符双扫（`:121-148`）。
3. **契约不得长出实现**：零 import 断言 `packages/agent/import-boundary.test.ts:188-191`；运行时值闭包不含 CLI 适配器、不含 `node:child_process`（`:193-196`）。
4. **装配不得旁路**：见 §5 单一装配点守卫。

按条目落地的边界：

- **Planner / Router / 意图分类器**：理解、规划、工具选择、多轮交互归 Pi（`AGENTS.md:15`）；宿主不另建记忆、检索、语义投影（`packages/agent/src/execution-runtime.ts:40`）。
- **规则引擎 / 新任务状态框架**：预算梯子、计划裁决归执行层，不重建宿主裁决面（`packages/contracts/src/execution-contract.ts:31-33`；`AGENTS.md:29`）。
- **事件总线**：任务事实只做单回调注入 `onTaskFact`，无订阅体系、无持久化事件流（`packages/agent/src/task-registry.ts:23`、`:569`；`packages/agent/src/task-runner.ts:15`「本模块不建事件总线/订阅体系」）。
- **第二套协议**：内部执行协议不得冒充 A2A；无真实跨进程互操作需求就不引入 A2A SDK/Agent Card/网络服务（`AGENTS.md:24-26`）。
- **沙箱**：`run_js` 是受限子进程而**不是沙箱**，残余风险如实登记——网络未阻断、无 OS 级隔离、提示注入仍可驱动模型写代码（`packages/agent/src/run-js-executor.ts:14`、`:36-38`）；新增 Docker/K8s/沙箱属本轮范围外（`AGENTS.md:38`）。

## 4. 资源旋钮：单一配置源

唯一配置入口是 YAML `runtime` 段（无同名 env 覆盖口），三类角色严格分开（`packages/contracts/src/config.ts:145-153`）：

| 角色 | 落点 | 指针 |
| --- | --- | --- |
| 类型面：有哪些旋钮 | `RuntimeConfig` / `TaskBudgetConfig` | `packages/contracts/src/config.ts:133`、`:155` |
| 解析与 fail-fast：YAML 只认白名单 | 未知键拒绝、非法值 throw（不按「非法＝未配置」回落） | `packages/core/src/config.ts:140-155`、`:183-187` |
| 缺省与解释：唯一一处 | `DEFAULT_RUNTIME_CONFIG` + `resolveRuntimeConfig` + `createResourcePolicy` | `packages/agent/src/resource-policy.ts:175-197`、`:286-330`、`:393-397` |

只读解析值的消费点（不得重读 `config.runtime.*`、不得自带第二份缺省）：装配 `scripts/ask-runtime.ts:600-601`、`:725-728`；server `apps/server/server.ts:260-264`、`apps/server/startup-sweep.ts:53`；执行侧 `packages/agent/src/execution-runtime.ts:1085-1086` 只读 `policy.snapshot().config.maxOperationsPerTurn`，`:694-695` 是未注入策略时的同值缺省（已在所有者表登记，非第二配置源）。

守卫 `packages/agent/resource-policy-single-source.test.ts`：① 已删 `host.*` 六键与 `FSHINE_*` 覆盖口生产零引用（`:58-76`、`:162-179`）；② 旋钮名只允许出现在登记的所有者文件，所有者表双向闭合（`:94-109`、`:181-204`）。本轮实跑：`p5_deleted_host_keys files=233 hits=0`，所有者表断言全绿。

> 现行缺口（待 issue）：`runtime.taskRunWaitMs` 已在类型面（`config.ts:210`）和策略缺省（`packages/agent/src/resource-policy.ts:196`、`:326-328`）存在，但 YAML 白名单 `RUNTIME_KEYS` 未收（`packages/core/src/config.ts:140-155`），部署 YAML 写它会报「未知字段」，只有程序内注入可达；守卫所有者表也未登记（`packages/agent/resource-policy-single-source.test.ts:94-109`）。守卫闭合的是表内键，不是 `ResolvedRuntimeConfig` 全集。
>
> ⚠️ 文档与代码不一致：`packages/contracts/src/config.ts:151-153` 注释称「文件保留期 0 = 不清理」，现行缺省是 `fileRetentionDays: 30`（`packages/agent/src/resource-policy.ts:189`）。以代码为准。

## 5. 单一装配点

生产面只有一条装配链 `assembleSessionCore`（`scripts/ask-runtime.ts:598`）。顺序固定：stateDir/审计路径 → 隔离断言（可选）→ 执行面 → 底账 → 技能/角色 → 驱动 → `createSession`（`:592-597`、`:600-620`）。

- 入口差异全部经输入面注入，门之后无第二条链：`apps/server/server.ts:363`、`scripts/eval/convergence-r1/runner.ts:383`、`scripts/ask-replay.ts:588` 直接调它；`scripts/ask.ts:212` 经 `assembleAskRuntime` 进入。
- **为什么只能一处**：第二份装配会让五门拒绝话术、允许集合派生、资源策略解析各漂各的，产生「写着不生效」的假配置或假拒绝；守卫把「同源」变成常驻测试，不靠人工审查。
- 守卫 `scripts/p0-assembly-single-point.test.ts`（P0-T03）三条判据：① 装配链符号 `createSession`/`createDummyCliClient`/`readOnlyOperationNames` 在生产面各只命中一个文件（`:171-184`；本轮实跑三符号均只命中 `scripts/ask-runtime.ts`）；② 六个入口沿相对导入图（含动态 import）都到达该文件（`:38-45`、`:186-193`）；③ 五门拒绝话术短语各只在一个生产文件出现（`:195-200`）。
- 依赖方向再钉一次：入口值闭包同时到达 runtime 与适配器（`packages/agent/import-boundary.test.ts:198-201`）。

## 6. 现行变更安全不变量（本节为唯一提炼面）

**来源现状（如实）**：2026-11-18 曾建 `docs/architecture/contract.md` 作提炼骨架，但只有 4 行 / 262 字节、**零条已提炼不变量**（`git log` 仅 `32a331c` 一次写入），同日删除（已删，git 历史可考）。故本节不声称「逐条搬自该文件」，而是逐条列出**今天由代码/守卫机械强制**的确定性（B 类）不变量，条目均可核对：

| 现行不变量 | 机械判据 / 指针 |
| --- | --- |
| 可信身份 / 凭据隔离 | 子进程 env 白名单重建（`packages/agent/src/run-js-executor.ts:17-18`）；`packages/agent/worker-env.test.ts` |
| 任务归属越权读取被拒 | 单写路径 + `onTaskFact` 事实钩子（`packages/agent/src/task-registry.ts:23`、`:569`）；`packages/agent/task-registry-sqlite.test.ts` |
| 完成状态如实（不把 failed/refused/零执行记成功） | §十三 13.1 `judgeReportedTask`（`docs/history/decision-log-part01-2026-11_undated.md:646-662`）；`packages/agent/runtime.test.ts` |
| 允许集合外调用发起前确定性拒绝 | `scripts/ask-runtime.ts:344-354`；`packages/agent/src/execution-runtime.ts:1540-1542` |
| 确认回环只透传、宿主不裁决 | `packages/agent/write-confirmation.test.ts:339`；`scripts/host-write-confirmation.test.ts:357/407/449` |
| 契约零 import / 旧治理模块不得值边复活 / 过渡命名不回流 | `packages/agent/import-boundary.test.ts:185-191`；`packages/agent/transition-naming.test.ts:40`、`:121-148` |
| 单一配置源 / 单一装配点 | `packages/agent/resource-policy-single-source.test.ts:161-204`；`scripts/p0-assembly-single-point.test.ts:170-201` |
| 非沙箱残余风险如实登记（不冒充安全边界） | `packages/agent/src/run-js-executor.ts:36-38` |

> 全部 A 类（模型能力补丁）不变量一律看消融/模型 Eval，不因「有代码、有守卫」固化；判据见 `AGENTS.md:43-45` 与 `docs/architecture-laws.md:34-53`。历史判据档案 `docs/architecture-laws.md` 文首 `:11` 已注明其多数守卫引用随 M4 退役，现行可执行守卫以本节指针为准。
