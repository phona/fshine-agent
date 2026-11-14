# P5 资源强制（单一配置 + ResourcePolicy）：实施报告（2026-11-14）

> 分片依据：`docs/product/r4-slices.md` §三「P5 · 资源强制（单一配置）」、`docs/product/r4-acceptance.md` P5-T01–T06 / P5-E01、`docs/product/r4-decisions-triage.md` #6（host 未消费键删除 + runtime 单一读入口）、#10（时长+调用数先落地，token 采集后置）、#11（depth=1 + 确定性护栏）。
> 冻结契约：`docs/product/r4-joint-interfaces.md` §2（ResourcePolicy 接口与 `runtime` 最小字段）+ §5（拒绝 reason 映射任务 `resource_limited`）+ §6（共享文件唯一负责人：接线归集成 Run）。
> 分支/基线/提交：worktree `fshine-agent-r4-p5`，分支 `arch/r4-p5`；启动基线 `arch/integration @ 9ae895d`（含联合接口约定 v1）。提交链：`c67af5b`（测试先行 RED）→ `500f1e4`（实现 + 测试基础设施诚实更新）→ `9a3979d`（decision-log/environment-variables 登记）→ `d718e1e`（§5 映射用例 RED）→ `501056d`（映射实现）→ 本报告提交。未 push、未合并。
> 证据根：`.runtime/p5/`（gitignored；RED/GREEN/基线对比/反向绊线读数）。
> 声明：**P5 只记录本轨完成状态，不冒充完整 P5 验收**——`execution-runtime` / `server` / runner 接线与 P5-E01 黑盒属集成 Run（联合接口约定 §7）。

## 一、产品要求（为什么做 P5）

- **资源强制（任务书范围）**：`runtime` 配置段；信号量/队列容量/委派深度/共享预算/等待超时/回合超时；`send` 串行化（把审计竞态在新配置下钉死）；`host.*` 处置定案。依赖 P2/P1。
- **验收（v1）**：确定性——容量满拒绝、depth 拒绝、预算耗尽、同会话两条消息串行且转录不互相覆盖、配置优先级；真实模型——顺序行为与现 ask 一致。**回退断言 = 配置缺省 = 现行为（单并发/无限额/无队列），可先接线后开启**。
- **冻结接口（§2）**：单一配置入口 `runtime`；纯对象/纯函数、无 IO；`acquire(kind,'foreground'|'background')` / `release` / `cancelQueued` / `snapshot` / `budgetFor`；拒绝 reason ∈ `queue_full | quota_exceeded | budget_exhausted | depth_exceeded`；**子 Worker 共享父任务预算（父 permit 派生，不复制/不放大）**；**前台与后台配额独立，后台满载不得永久阻塞前台**；强制点由集成负责人接线；初期硬限制=并发/队列/时长/调用数，**token 仅当 Pi `assistant.usage` 可验证时接入（否则记 `tokens: unavailable`，不得伪造硬上限）**。
- **本轨边界**：只新增独立模块（`resource-policy.ts`）与配置段（contracts 类型 + core 解析），不接线 `execution-runtime` / `server` / `ask-runtime` / runner；不实现第二套任务队列；无新依赖；不改 R3 冻结判据与历史证据。

## 二、验收用例覆盖（P5-T01–T06 / E01）

| 用例 | 层级 | 覆盖方式（测试/证据） | 状态 |
|---|---|---|---|
| P5-T01 单一配置 | 确定性 | `packages/core/config.test.ts`：runtime 合法解析、非法值 fail-fast 点名 `runtime.<key>`（0/负数/小数/非数）、未知键拒绝（拼错旋钮不得被缺省吞掉）、taskBudget 子键 ms/calls 必填与 tokens 校验、缺段/空段=未配置、旧 host 死键残留被忽略且不再派生 env；`packages/agent/resource-policy-single-source.test.ts` grep 守卫：六死键 + `FSHINE_*` 覆盖口生产代码零引用，资源旋钮只允许登记所有者（contracts 类型 / core 解析 / resource-policy / execution-runtime 回合时限入参）解释，所有者表双向闭合 | 已实现/已测试（绿）；端到端「配置加载输出」留集成 Run 复跑 |
| P5-T02 同会话串行 | 确定性 | 本轨提供原语：前台单并发准入 + 有界队列 + FIFO 晋升（`resource-policy.test.ts` 矩阵，含 release 幂等与晋升截止重算）；缺省 `mainConcurrency=1` / `queueCapacity=0`。**「两回合顺序处理 + transcript 无覆盖」的断言依赖 server 接线后的串行化调用序** | 原语已测试（绿）；用例本体 blocked-by-集成 |
| P5-T03 队列与配额 | 确定性 | 满=确定性 `queue_full`（不进入执行）；前后台配额与队列各自独立（后台队列满不阻塞前台；前台满载不占后台槽）；有界（容量+队列，拒绝而非无限积压）；`cancelQueued` 出队、释放排队=放弃等待 | 已实现/已测试（绿） |
| P5-T04 委派深度 | 确定性 | `depth_exceeded` 确定性拒绝、不产生半成品（无许可、无预算——`budgetFor` 对未准入任务抛错）；depth 0/1/2 三档与「父许可非 active 拒绝派生」 | 已实现/已测试（绿） |
| P5-T05 父预算共享 | 确定性 | 子许可 `budgetFor(child) === budgetFor(parent)`（同一对象，不复制/不放大）；子消费父可见；耗尽→`budget_exhausted`（子委派拒绝、等待恢复拒绝）；ms / calls / tokens 三口径 | 已实现/已测试（绿） |
| P5-T06 等待超时 | 确定性 | waiting_user 释放语义：`release` 立即释放槽位、任务预算保留（恢复同一对象、用量不重置）、恢复不保留槽/队列特权（先到先得，满即确定性拒绝）；`waitUserTimeoutMs` 配置缺省 24h。「到期关闭活跃等待 + 历史与原因落库」归 P2 registry | 释放语义已测试（绿）；超时关闭 blocked-by-P2 接线 |
| P5-E01 顺序行为不回归 | 黑盒 | 真实模型 + 仓内 dummy 执行层；须联合集成后运行（本轨未运行） | blocked-by-联合集成 |

**覆盖读数**：P5 目标 3 文件 **63 例**全绿（`resource-policy.test.ts` 34 + `resource-policy-single-source.test.ts` 2 + `config.test.ts` 27）。

## 三、实施改动（文件级）

| 文件 | 性质 | 内容 |
|---|---|---|
| `packages/agent/src/resource-policy.ts` | 新增（501 行） | 纯逻辑策略：`AcquireKind`/`Rejection`/`Permit`/`TaskBudget`/`ResourceSnapshot`/`ResolvedRuntimeConfig` 类型；`DEFAULT_RUNTIME_CONFIG`（缺省=现行为：main/background 各 1、queue 0、无任务级预算、300s/180s、depth 1、等待 24h）；`resolveRuntimeConfig`（缺省补齐 + 非法值 fail-fast + taskBudget 子键拒绝）；`createResourcePolicy`（注入时钟，缺省 `Date.now`；`acquire`/`release`/`cancelQueued`/`snapshot`/`budgetFor`）；`RESOURCE_LIMITED_REASON` + `taskFailureReasonFor`（§5 四拒绝 → `resource_limited`）。无 IO/无定时器/无持久化 |
| `packages/contracts/src/config.ts` | 修改 | 新增 `TaskBudgetConfig` / `RuntimeConfig` / `AppConfig.runtime`；`HostConfig` 仅保留 `attachmentDir`，删除六未消费键与 `WorkerDispatchMode` 类型 |
| `packages/core/src/config.ts` | 修改 | 新增 `parseRuntime`（单一入口、无 env 覆盖口；非法值 fail-fast、未知键拒绝、taskBudget 子键校验）；host 段只解析 `attachmentDir`；`deploymentEnvOf` 不再派生六死键；`loadConfig` 输出 `AppConfig.runtime` |
| `packages/agent/resource-policy.test.ts` | 新增（34 例） | 契约矩阵：许可/释放/拒绝、前后台独立、队列容量与 FIFO 晋升、预算共享与耗尽、深度护栏、waiting_user 释放、token 诚实（unavailable 不伪造硬上限）、snapshot、§5 映射 |
| `packages/agent/resource-policy-single-source.test.ts` | 新增（2 例） | P5-T01 静态守卫（AST 标识符/字符串字面量；注释不计） |
| `packages/core/config.test.ts` | 修改（23→27 例，净 +4） | runtime 解析/fail-fast/未知键/子键用例；host 死键的诚实更新（兼容旧 YAML + 不再派生 env）；原「非法数值/非法派发模式」1 例由 4 例后继承接（死键兼容、runtime fail-fast、未知键、子键）；「yaml 段解析」同例改名扩展（+runtime）；无覆盖丢失 |
| `tests/vitest.setup.ts`、`scripts/p0-gates-cli.test.ts`、`scripts/ask-replay.test.ts`、`packages/agent/worker-env.test.ts` | 最小改 | 死键从密封/剔除清单退役（加注）；worker-env 负例哨兵改用仍有读取点的 `FSHINE_ATTACHMENT_DIR`（白名单精确键集合断言不变） |
| `docs/decision-log.md` §三十二、`docs/environment-variables.md` §1 | 登记 | 死键删除依据/保留面/加回判据；runtime 段无 env 覆盖口与 fail-fast 口径；读数与绊线 |

**最小性**：无新增依赖、未改 `package.json`；未改 `execution-runtime.ts` / `server.ts` / `ask-runtime.ts` / `scripts/tasks.ts` / `ops.ts`（P2 独占热点与共享接线面）；不建第二套任务队列（队列语义只做准入等待，持久排队归 P6 的底账 `queued` 行）。

## 四、执行证据（本分支读数）

**确定性门（HEAD `e96ec5b`）**——`.runtime/p5/report-full.txt`：

- `TMPDIR=/home/tao/.tmp npx tsc --noEmit` → **exit 0**。
- `TMPDIR=/home/tao/.tmp npm test` → **exit 0**；`Test Files 47 passed (47)`；`Tests 465 passed (465)`。
- 基线对照（同命令、临时 worktree @ 基线 `9ae895d`，跑完即移除）→ `Test Files 45 passed (45)`；`Tests 425 passed (425)`；**只增不减：+2 文件 / +40 例**（`.runtime/p5/baseline-full.txt`）。
- 目标批次：`npx vitest run packages/agent/resource-policy.test.ts packages/agent/resource-policy-single-source.test.ts packages/core/config.test.ts` → `3 passed (3)` / `63 passed (63)`。

**RED（TDD 先红，提交 `c67af5b` 状态）**——`.runtime/p5/red-*.txt`：

- `resource-policy.test.ts` → `Cannot find module './src/resource-policy'`（模块缺失）。
- 守卫 → 2 failed：18 处死键命中（contracts/core 各 6 键 + 6 环境名）+ 旋钮所有者表未命中。
- `config.test.ts` → 6 failed | 21 passed（runtime 未解析/未 fail-fast/未知键未拒；host 死键仍进 AppConfig 并派生 env）。
- §5 映射用例 → 1 failed | 33 passed（常量/helper 未导出）。

**反向绊线（破坏未提交、随即还原；两轮）**——`.runtime/p5/tripwire-*.txt`：

- ① 预算复制而非共享（`budget: parent.budget` → 新预算对象）→ 共享预算用例红（1 failed | 33 passed）。
- ② 队列容量失效（判据改 `>= Number.POSITIVE_INFINITY`，无界积压）→ 8 failed | 26 passed（queue_full 相关用例全红：前台单并发、前台满载、后台队列满不阻塞前台、足量队列、派生不放大、等待恢复无特权、§5 映射构造例）。
- ③ 为 token 编造默认硬上限（`tokens` 恒 `enforced` + 耗尽判据用 `limits.tokens ?? 100_000`）→ usage 不可用用例红（1 failed | 33 passed）。
- （轮一另含）release 不晋升 → 2 red；死键回流 contracts → 守卫 1 red。
- 还原后：`git diff --exit-code` 无差异、`git status` clean、无 TRIPWIRE 残留；目标 63 例、全量 47/465、tsc 0。

## 五、接线需求（集成 Run；联合接口约定 §6 唯一负责人）

1. **execution-runtime 委派前 acquire**：Main 回合开始 `acquire('foreground', { taskId: 会话/回合标识 })`，回合结束 `release`；`run_task` 委派 Worker 时 `acquire('background', { taskId, parentPermit: 主回合许可 })`——共享父预算、深度 +1、不占新并发槽；拒绝时用 `taskFailureReasonFor(rejection)` 落任务原因 `resource_limited`（`timed_out` 走 P2 超时链）。
2. **runner 背景调度（P6）**：每个后台任务 `acquire('background', { taskId })` 后执行；终态/取消 `release`；取消排队中任务用 `cancelQueued(taskId)`；`waiting_user` 进入时 `release` 释放资源、答复后按同一 taskId 重新 `acquire`（预算保留）；队列满 → 任务留在底账 queued 或确定性拒绝，不得无限积压。
3. **server 串行化（P5-T02）**：同会话两条消息在 `acquire('foreground')` **之前**按会话串行（await 前序 send），保证两回合都处理、transcript 不覆盖；缺省 `mainConcurrency=1` / `queueCapacity=0`——如要「排队而非先串行」，需在 `runtime` 段显式提升 `queueCapacity`（缺省语义 = 现行为，可先接线后开启）。
4. **配置读取唯一化**：装配处 `resolveRuntimeConfig(config.runtime)` → `createResourcePolicy`，再把解析值注入 execution-runtime（`mainTurnMs`/`workerTurnMs`）等消费点；不得在别处自行解释旋钮（`resource-policy-single-source.test.ts` 会红，需走登记）。
5. **token 接线**：仅当 Pi `assistant.usage` 可验证时配置 `taskBudget.tokens` 并由接线方 `consume({ tokens })`；未配置保持 `tokens: unavailable`，不得伪造硬上限。

## 六、blocked 清单

| 项 | 依赖 | 解除条件 |
|---|---|---|
| P5-E01 顺序行为不回归（黑盒，预注册 N） | 联合集成（真实 Pi + dummy 执行层 + 接线后 Runtime） | 集成 Run 合入并按预注册口径跑批 |
| P5-T02 完整验收（两回合顺序 + 转录快照 + 回复可追溯） | server 串行化接线 | 集成 Run 接线后以假渠道回归 + 黑盒 |
| P5-T01 端到端「配置加载输出」证据 | 装配接线（server/ask 读取 runtime 段） | 集成 Run 在真实入口跑 fail-fast/加载日志 |
| P5-T06 超时关闭活跃等待（状态与原因落库） | P2 registry 的 `waiting_user` 超时实现 | P2 合入后由 P2/P6 接线，P5 侧只提供 `waitUserTimeoutMs` 与释放语义 |
| execution-runtime / server / runner 强制点接线与联合验收 | 集成 Run（顺序 P2 → P5 → P6 → P4 → P7b） | 按 §8 集成顺序合入并按 P5-T01–T06 全量复跑 |

## 七、回退方式

- **接线前零行为变化**：`resource-policy.ts` 未被消费；`runtime` 缺段 = `AppConfig.runtime === undefined`；旧 YAML 里的已删 host 键被加载层忽略（不拒启、不再派生 env）。
- **接线后回退**：`runtime` 段缺省/清空 = 现行为（单并发/无队列/无任务级预算；回合时限 300s/180s 与执行侧现行缺省一致），可先接线后开启；整片回退 = revert 本片提交（`500f1e4`/`501056d` 代码 + `c67af5b`/`d718e1e` 测试），无需 schema/数据迁移；恢复 host 旧键不是回退前提（删除已登记，加回须走新登记）。
- 回退后 `npm run typecheck` 与既有单测应仍全过（P5 未改共享接线的运行语义）。

## 八、已知边界（登记）

1. **单实例内存账本**（分诊 #7）：许可/队列/预算表为进程内最小状态；预算按任务保留（含已完成与等待中的任务，供等待恢复与 ops 读取），生命周期与进程一致，量级为任务数的小对象。
2. **晋升由 release 触发**：无定时器/回调；消费方用 `permit.state` / `snapshot()` 观察（P6 调度循环）。
3. **派生许可不占并发槽**：在父回合内执行；父释放不级联子许可——结构化并发（子先释放）由消费方保证；越限/父非 active 一律拒绝且不产生半成品。
4. **token 强制状态**：仅显式声明 `taskBudget.tokens` 时 `enforced`；用量可验证性由接线方保证（未声明恒 `unavailable`，观测用量照实记录但不作为上限）。
5. **守卫的所有者表**：`execution-runtime.ts` 的 `mainTurnMs`/`workerTurnMs` 入参登记为现行消费面（缺省 300s/180s 与策略一致）；接线应改由解析值注入，直接读 `config.runtime.*` 会触发守卫，需登记后放行。
6. **部署模板**：`config/agent.example.yaml` 未添加 `runtime` 示例（字段接线前不预置）——接线后按需补充并同步 `docs/environment-variables.md`。
7. 本报告不宣称 P5-E01 或任何端到端验收通过；`docs/product/r4-acceptance.md` 的 53 项判据未改、不筛绿。
