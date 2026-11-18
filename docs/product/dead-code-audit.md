# 死代码与未使用导出审计（2026-11-17）

> 基线：`arch/integration` @ `23ae585a28a42bdee61497e7569db3e48558f84a`（worktree `arch/debt-deadcode`）。
> 产出：本文件 + 独立删除提交 `9ee0888`（9 files, +1/−28）。
> 范围：`packages/**`、`apps/**`、`scripts/**` 的 TypeScript 代码面；测试文件参与反查分类，但**不作为删除对象**。
> 不碰：`.runtime/**`、历史评测报告、`docs/architecture-laws.md` 引用的机制、守卫/失败注入测试、`scripts/eval/convergence-r1/**` 冻结件。

## 〇、结论摘要

| 项 | 结果 |
|---|---|
| 扫描文件 / 命名导出（删除前） | 374 个 `.ts` / 1439 个命名导出 |
| 严格零引用导出（全仓无 import、无同文件引用） | 9 |
| 其中删除 | 5（`RunnerClass`、`casesOfKind`、`stateDirFor`、`A_RESTART_BEFORE_TURN`、`SIM_DEFAULT_LIMITS`） |
| 其中保留 | 4（2 个动态 import、1 个冻结件、1 个未接线守卫） |
| 仅测试引用 | 25（生产面 3 + 评测/影子面 22），全部保留 |
| 仅自身文件引用 | 471（生产面 156），保留；不是死代码 |
| `tsc` 未使用检测（删除前） | 75 条（TS6133 68 / TS6196 7；生产面 4 / eval 40 / 测试 31） |
| 已删除的生产面未使用符号 | 4（含 2 个类型 import） |
| 已删机制残留引用 | 0 处活代码引用；命中均为注释、守卫测试或 dummy 夹具兼容面 |
| 重复实现 | 生产/脚本面 6 组逐字重复 + 2 组语义重复，本轮登记不合并 |
| 门 | `npx tsc --noEmit` exit 0；`npm test` 156 files / 1651 passed / 1 skipped，exit 0（删除前与删除后各跑一次，例数不变） |

---

## 一、方法与复现口径

### 1.1 `tsc` 未使用检测

只加命令行参数，**未改 `tsconfig.json`**：

```bash
cd <repo>
npx tsc --noEmit --noUnusedLocals --noUnusedParameters
```

删除前输出 75 行 `error TS6133/TS6196`；按文件路径分为生产面 4、`scripts/eval/**` 40、测试 31。删除后复跑为 71 行（40 / 31），生产面清零。

### 1.2 导出反查脚本

一次性脚本（审计工具，未入库）遍历 374 个 `.ts`（排除 `node_modules`、`out`、`.runtime`、`tmp`、`.git`），对每个 `export` 名字做全仓静态 import 反查：

- 提取 `export function/class/const/let/var/interface/type/enum`、`export { … }`、`export * from`、`export type`；
- 解析相对路径与 `@fshine/contracts`、`@fshine/contracts/execution-contract`、`@fshine/core`、`@fshine/agent`、`@fshine/channel-wecom` 别名；
- 沿 barrel 的 `export *` / `export { x } from` 传播导出归属，把经 barrel 的消费记回原始定义文件；
- 按文件域分类：`prod`（`packages/*/src`、`apps`、顶层 `scripts`）、`eval`（`scripts/eval`、`scripts/stab`、`scripts/shadow`、`packages/agent/testing`、`fixtures`）、`test`（`*.test.ts`、`tests/`）；
- 统计 `prod/eval/test/reexport/同文件` 五类引用；**动态 `import()` 不计入引用**，单独列出后再人工核对。

复跑核心命令（单个候选）：

```bash
grep -rnw --include='*.ts' '<Symbol>' packages apps scripts tests
grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.runtime '<Symbol>' .
```

### 1.3 判断口径

- **可删**：静态 import 反查 0 处、同文件 0 处，且动态 import / 字符串加载 / 文档契约均无指向；删除后 `tsc` 与全量测试绿。
- **疑似保留**：只在测试、评测、自身文件、barrel 出现，或属于类型/配置面；本轮不删。
- **勿动**：守卫、失败注入、安全不变量、冻结件、历史证据、夹具兼容面。
- “仅自身文件引用”不等于“无人引用”——符号仍被定义文件使用，只是 `export` 关键字多余；本轮不逐个去 `export`，避免扩大 diff 与公共类型面。

---

## 二、导出但无人引用

### 2.1 严格零引用（9 条）

行号为删除前基线 `23ae585` 的位置；5 条已删项当前已不存在。

| # | 符号 | 文件:行 | 反查结果 | 判断 | 理由 / 证据 |
|---|---|---|---|---|---|
| 1 | `RunnerClass` | `scripts/ask-trace.ts:29` | 0 import、0 同文件引用；`RUNNER_CLASSES` 仍被 `ask-trace.ts` 内部循环使用 | **已删** | 纯派生类型；全仓 `grep -rnw RunnerClass` 仅命中定义行；提交 `9ee0888` |
| 2 | `casesOfKind` | `scripts/eval/business-e2e/experiments/cases.ts:221` | 0 import、0 同文件引用 | **已删** | `expCases` 的实际消费方直接 `filter`，该包装无消费者；提交 `9ee0888` |
| 3 | `stateDirFor` | `scripts/eval/pi152-stageD/client.ts:124` | 0 import、0 同文件引用 | **已删** | 单行路径拼接 helper；删除后其唯一 `path` import 也变为未使用，一并删除；提交 `9ee0888` |
| 4 | `A_RESTART_BEFORE_TURN` | `scripts/eval/pi152-stageD/scenarios.ts:88` | 0 import、0 同文件引用 | **已删** | 注释称“重启点”，但无任何消费者；提交 `9ee0888` |
| 5 | `SIM_DEFAULT_LIMITS` | `scripts/eval/sim/case.ts:63` | 0 import、0 同文件引用 | **已删** | 冻结默认值常量，无消费者；同文件 `SIM_DEFAULT_CONCURRENCY` 保留；提交 `9ee0888` |
| 6 | `isAssemblyRefusal` | `scripts/ask-runtime.ts:90` | 静态 0；**动态 import 1 处**：`scripts/tasks.ts:524-525` `const { isAssemblyRefusal } = await import('./ask-runtime')` | **勿动** | 动态 import 是真实调用链；删除会令 `tasks` 的前置拒绝判定失效 |
| 7 | `validateTraceDir` | `scripts/ask-trace.ts:399`（基线 :400） | 静态 0；**测试动态 import**：`scripts/ask-trace.test.ts:116` 经变量路径 `import(modulePath)` 载入，:169/:207/:229 实调 | **勿动** | 测试缝；`docs/product/p7a-ask-first.md:25,44,60` 也把它登记为已测试行为 |
| 8 | `FailureCode` | `scripts/eval/convergence-r1/criteria.ts:24` | 0 import、0 同文件引用 | **勿动** | `convergence-r1` 是决策日志 §六十三登记的冻结评测件；按范围不修改 |
| 9 | `missingSimKinds` | `scripts/eval/sim/accounting.ts:123` | 0 import、0 同文件引用 | **勿动（待接线）** | 函数注释自称“反向绊线：任一必需类别缺失即返回其名”；属守卫 helper，但当前无调用者。删掉会掩盖“守卫未接线”的事实，登记给 owner |

**删除后复扫**：1434 个命名导出、严格零引用 4 条，即上表 #6–#9，全部有保留理由；无新增零引用项。

### 2.2 仅测试引用（25 条，全部保留）

这些导出在全仓只被 `*.test.ts` import，生产/eval 运行时均无消费者。保留理由：它们是测试缝或评测自检入口；删掉会让测试无法验证内部行为，属于“删测试凑绿”的反面。

| 符号 | 文件:行 | 引用测试 | 判断 |
|---|---|---|---|
| `KIMI_THINKING_LEVEL_MAP` | `packages/agent/src/pi-driver.ts:118` | `pi-driver.test.ts` | 疑似保留（模型能力映射的测试缝） |
| `stripForeignScratchPaths` | `packages/agent/src/server-paths.ts:120` | `server-paths.test.ts` | 疑似保留（路径清洗测试缝） |
| `listSkills` | `packages/agent/src/skills.ts:141` | `skills.test.ts` | 疑似保留（registry 便利包装的测试缝） |
| `compareBizprobeSerialParallel` | `scripts/eval/business-e2e/assembly.ts:161` | `bizprobe.test.ts` | 保留（评测对账） |
| `compareExpSerialParallel` | `scripts/eval/business-e2e/experiments/harness.ts:140` | `experiments.test.ts` | 保留（评测对账） |
| `outcomeBehavior` | `scripts/eval/business-e2e/shared-instance.ts:269` | `shared-instance.test.ts` | 保留（评测断言 helper） |
| `pendingCancelableBehavior` | `scripts/eval/business-e2e/shared-instance.ts:274` | `shared-instance.test.ts` | 保留（评测断言 helper） |
| `computeTruth` | `scripts/eval/finance/truth.ts:97` | `main-skill-scan.test.ts`、`truth.test.ts`、`sim/cases/finance.test.ts` | 保留（真值计算，被多个测试引用） |
| `runP2Scenario` | `scripts/eval/p2/p2-scenarios.ts:674` | `p2-scenarios.test.ts` | 保留（评测入口） |
| `UNSAFE_STATUS_QUO_CONFIG` | `scripts/eval/pi-native/safe-config.ts:72` | `safe-config.test.ts` | 保留（对照配置） |
| `assessCompactionConfig` | `scripts/eval/pi-native/safe-config.ts:136` | `safe-config.test.ts` | 保留（压缩配置判定） |
| `compactionSettingsOf` | `scripts/eval/pi-native/safe-config.ts:166` | `safe-config.test.ts` | 保留（压缩设置投影） |
| `safeConfigEnv` | `scripts/eval/pi-native/safe-config.ts:171` | `safe-config.test.ts` | 保留（配置 env 投影） |
| `missingCallKinds` | `scripts/eval/r6/accounting.ts:139` | `accounting.test.ts` | 保留（与 `missingSimKinds` 同族的反向绊线） |
| `FakeHarnessSession` | `scripts/eval/r6/fake-session.ts:47` | `accounting.test.ts`、`pipeline.test.ts` | 保留（评测假会话） |
| `noTasks` | `scripts/eval/r6/fake-session.ts:106` | `accounting.test.ts`、`pipeline.test.ts` | 保留（评测假数据） |
| `asAttempt` | `scripts/eval/r6/fake-session.ts:109` | `pipeline.test.ts` | 保留（评测假数据） |
| `runG3Checks` | `scripts/eval/r6/g3-readiness.ts:147` | `g3-readiness.test.ts` | 保留（就绪检查入口） |
| `buildPumpTurns` | `scripts/eval/r6/load-generator.ts:90` | `load-generator.test.ts` | 保留（负载生成） |
| `buildTrackPlan` | `scripts/eval/r6/load-generator.ts:111` | `load-generator.test.ts`、`pipeline.test.ts` | 保留（负载生成） |
| `factTurns` | `scripts/eval/r6/load-generator.ts:127` | `load-generator.test.ts` | 保留（负载生成） |
| `statesCovered` | `scripts/eval/r6/oracle.ts:267` | `oracle.test.ts` | 保留（覆盖判定） |
| `SIM_ALL_CASES` | `scripts/eval/sim/cases/index.ts:355` | `cases.test.ts` | 保留（用例全集） |
| `createWriteSystem` | `scripts/eval/sim/write-system.ts:52` | `cases.test.ts` | 保留（写系统夹具） |
| `runShadowComparison` | `scripts/shadow/double-source-harness.ts:462` | `double-source.test.ts` | 保留（影子对照入口） |

### 2.3 仅自身文件引用（471 条，生产面 156）

这些符号有 `export` 关键字，但没有任何外部 import；反查命中全部来自定义文件自身（类型注解、同文件调用）。它们**不是死代码**，只是导出面偏大。本轮不去 `export`，理由：类型面可能是跨层契约的预留读取口；去关键字会制造大量无行为 diff，且不影响可达性。

生产面按文件计数（符号明细可由 §七 的复跑命令得到）：

| 文件 | 仅自身引用导出数 |
|---|---|
| `apps/server/channel-mode.ts` | 2 |
| `apps/server/server.ts` | 2 |
| `packages/agent/src/agent-profile.ts` | 5 |
| `packages/agent/src/driver-contract.ts` | 1 |
| `packages/agent/src/dummy-cli-client.ts` | 2 |
| `packages/agent/src/execution-runtime.ts` | 10 |
| `packages/agent/src/file-store.ts` | 3 |
| `packages/agent/src/notifications.ts` | 6 |
| `packages/agent/src/pi-driver.ts` | 8 |
| `packages/agent/src/repo-root.ts` | 3 |
| `packages/agent/src/resource-policy.ts` | 12 |
| `packages/agent/src/run-dir-cleanup.ts` | 6 |
| `packages/agent/src/run-js-executor.ts` | 7 |
| `packages/agent/src/run-js-layout.ts` | 1 |
| `packages/agent/src/server-paths.ts` | 1 |
| `packages/agent/src/session-persistence.ts` | 2 |
| `packages/agent/src/skills.ts` | 2 |
| `packages/agent/src/task-file-bridge.ts` | 3 |
| `packages/agent/src/task-registry-sqlite.ts` | 1 |
| `packages/agent/src/task-registry.ts` | 5 |
| `packages/agent/src/task-runner.ts` | 5 |
| `packages/channel-wecom/src/adapter.ts` | 1 |
| `packages/channel-wecom/src/silent-shadow-gate.ts` | 3 |
| `packages/contracts/src/channel.ts` | 3 |
| `packages/contracts/src/config.ts` | 3 |
| `packages/contracts/src/execution-contract.ts` | 1 |
| `packages/core/src/config.ts` | 1 |
| `packages/core/src/task-store.ts` | 5 |
| `scripts/ask-assert.ts` | 4 |
| `scripts/ask-interactive.ts` | 4 |
| `scripts/ask-replay.ts` | 1 |
| `scripts/ask-runtime.ts` | 7 |
| `scripts/ask-trace.ts` | 9 |
| `scripts/ask.ts` | 1 |
| `scripts/cleanup-runs.ts` | 3 |
| `scripts/ops.ts` | 5 |
| `scripts/tasks.ts` | 18 |

其余 315 条位于 `scripts/eval/**`、`scripts/stab/**`、`scripts/shadow/**`、测试辅助与 fixtures；同属“自身文件使用”，不逐个展开。

---

## 三、定义了但无调用（`tsc` 未使用检测）

### 3.1 生产面：已删 4 条

`--noUnusedLocals --noUnusedParameters` 在删除前报告的生产面未使用符号：

| 符号 | 文件:行 | 类型 | 证据 | 判断 |
|---|---|---|---|---|
| `TurnDriver` | `apps/server/server.ts:37` | 未使用 type import | TS6133；文件内无 `TurnDriver` 引用 | **已删**（`9ee0888`） |
| `TaskExecutionInput` | `packages/agent/src/execution-runtime.ts:74` | 未使用 type import | TS6196；`TaskExecutionOutcome/TaskExecutor/TaskRunner` 仍在使用 | **已删**（`9ee0888`） |
| `TERMINAL_STATUSES` | `packages/agent/src/task-registry.ts:259` | 未使用模块常量 | TS6133；状态机出口由 `LEGAL_TRANSITIONS` 表达，该集合零读取 | **已删**（`9ee0888`） |
| `DEFAULT_DB_PATH` | `scripts/tasks.ts:46` | 未使用模块常量 | TS6133；实际存储路径由 `explicitConfigFrom`/运行时解析 | **已删**（`9ee0888`） |

删除 `stateDirFor` 后，`scripts/eval/pi152-stageD/client.ts:8` 的 `path` import 变为未使用；已在同一提交删除。当前生产面 `tsc` 未使用项为 0。

### 3.2 评测脚本：40 条（登记，不动）

全部位于 `scripts/eval/**`。它们不进入 `npm run ask` / `npm start` 的产品闭包；本轮不删，避免把“死代码审计”扩大成评测 harness 重构。判断统一为“可删但本轮未删；触碰评测/复现面需单独评审”。

| 文件:行 | 符号 | 类型 |
|---|---|---|
| `scripts/eval/business-e2e/assembly.ts:59` | `item` | 未使用参数 |
| `scripts/eval/business-e2e/batch.ts:73` | `T` | 未使用泛型参数 |
| `scripts/eval/business-e2e/batch.ts:98` | `T` | 未使用泛型参数 |
| `scripts/eval/business-e2e/experiments/executor.ts:310` | `rec` | 未使用局部 |
| `scripts/eval/business-e2e/model-executor.ts:101` | `item` | 未使用参数 |
| `scripts/eval/business-e2e/shared-instance.ts:91` | `streamOf` | 未使用局部函数 |
| `scripts/eval/business-e2e/spread-axis/grade.ts:13` | `ExecutionFact` | 未使用 type import |
| `scripts/eval/business-e2e/spread-axis/grade.ts:101` | `caseDef` | 未使用参数 |
| `scripts/eval/business-e2e/spread-axis/run.ts:22` | `wilson95` | 未使用 import |
| `scripts/eval/cap01/r2-functional.ts:55` | `rmSync` | 未使用 import |
| `scripts/eval/cap01/r2-functional.ts:62` | `openTaskStore` | 未使用 import |
| `scripts/eval/cap01/r2-functional.ts:892` | `findCopySource` | 未使用函数 |
| `scripts/eval/cap01/r2b-formats.ts:84` | `OUTPUT_NAME` | 未使用常量 |
| `scripts/eval/cap01/r2b-formats.ts:1318` | `failed` | 未使用局部 |
| `scripts/eval/cap01/r2c-artifacts.ts:627` | `result` | 未使用局部 |
| `scripts/eval/cap01/r3-core.ts:335` | `nlinkOfBase` | 未使用局部 |
| `scripts/eval/cap01/r5-resources.ts:66` | `NODE_MODULES` | 未使用常量 |
| `scripts/eval/cap01/r7-faults.ts:505` | `logger` | 未使用局部 |
| `scripts/eval/convergence-r1/judge.ts:270` | `LoadedEvidence` | 未使用 type（冻结件） |
| `scripts/eval/convergence-r1/judge.ts:370` | `callRefusalRows` | 未使用局部（冻结件） |
| `scripts/eval/convergence-r1/runner.ts:20` | `os` | 未使用 import（冻结件） |
| `scripts/eval/exploration/freeze.ts:18` | `HERE` | 未使用常量 |
| `scripts/eval/p2/p2-harness.ts:48` | `textAssistant` | 未使用参数 |
| `scripts/eval/p2/p2-harness.ts:48` | `toolCallAssistant` | 未使用参数 |
| `scripts/eval/p2/p2-harness.ts:382` | `calls` | 未使用局部 |
| `scripts/eval/p2/p2-scenarios.ts:102` | `taskOf` | 未使用函数 |
| `scripts/eval/p3/p3a-session.ts:39` | `P3BudgetEvent` | 未使用 type |
| `scripts/eval/p3/p3a-session.ts:117` | `scope` | 未使用参数 |
| `scripts/eval/p3/p3a-session.ts:133` | `startedMs` | 未使用局部 |
| `scripts/eval/p3/p3b-session.ts:139` | `scope` | 未使用参数 |
| `scripts/eval/p3/p3s4-session.ts:160` | `scope` | 未使用参数 |
| `scripts/eval/p3/p3s5-session.ts:157` | `scope` | 未使用参数 |
| `scripts/eval/pi-native/r5p4-real.ts:103` | `receiver` | 未使用参数 |
| `scripts/eval/pi-native/r5p4-real.ts:263` | `originalError` | 未使用局部 |
| `scripts/eval/pi152-stageD/harness.ts:18` | `ExecutionClient` | 未使用 type import |
| `scripts/eval/pi152-stageD/harness.ts:19` | `ExecutionOutcome` | 未使用 type import |
| `scripts/eval/r6/harness.ts:26` | `accountCalls` | 未使用局部 |
| `scripts/eval/r6/multiuser/mu-cases.ts:54` | `plans` | 未使用参数 |
| `scripts/eval/sim/cases/scenario-oracles.ts:23` | `SimOracleContext` | 未使用 type |
| `scripts/eval/sim/run.ts:176` | `tokensOf` | 未使用函数 |

其中 `convergence-r1` 三处属冻结件，明确不动；其余 37 处若 owner 批准清理，可按文件单独做无行为 diff。

### 3.3 测试文件：31 条（勿动）

测试内的未使用局部/导入多数是夹具字段、断言输入或调试痕迹。删除它们**可能掩盖“断言漏写/夹具没用上”**，与“不删守卫、不弱化断言”的纪律冲突，本轮一律不动。

| 文件:行 | 符号 |
|---|---|
| `apps/server/server-cap01-inbound.test.ts:23` | `createSqliteTaskRegistry` |
| `apps/server/server-cap01-memory-wall.test.ts:20` | `DriverMessage` |
| `apps/server/server.test.ts:132` | `frame` |
| `packages/agent/file-store-task-returned.test.ts:247` | `root` |
| `packages/agent/pi-152-stage-e-failure-surface.test.ts:76` | `overThresholdReply` |
| `packages/agent/pi-native-compaction.test.ts:58` | `streamOf` |
| `packages/agent/pi-native-compaction.test.ts:143` | `historyWithUsage` |
| `packages/agent/pi-native-tripwire.test.ts:78` | `contextWindow` |
| `packages/agent/r5preaudit-p0c.test.ts:35` | `seq` |
| `packages/agent/r5preaudit-p0c.test.ts:270` | `runner` |
| `packages/agent/worker-env.test.ts:5` | `vi` |
| `packages/channel-wecom/adapter.degrade.test.ts:87` | `channel` |
| `packages/channel-wecom/adapter.silent-shadow.test.ts:18` | `IncomingChannelMessage` |
| `packages/channel-wecom/adapter.test.ts:941` | `dir` |
| `packages/channel-wecom/adapter.test.ts:956` | `dir` |
| `packages/core/file-refs.test.ts:34` | `mkdirSync` |
| `scripts/ask-replay.test.ts:22` | `mkdirSync` |
| `scripts/eval/business-e2e/d6-metrics.test.ts:6` | `createHash` |
| `scripts/eval/business-e2e/d6-metrics.test.ts:7` | `readFileSync` |
| `scripts/eval/business-e2e/experiments/experiments.test.ts:20` | `vi` |
| `scripts/eval/business-e2e/experiments/experiments.test.ts:25` | `createPiTurnDriver` |
| `scripts/eval/business-e2e/experiments/experiments.test.ts:26` | `contextWindowFrom` |
| `scripts/eval/business-e2e/experiments/experiments.test.ts:27` | `C04` |
| `scripts/eval/business-e2e/experiments/experiments.test.ts:124` | `longTranscript` |
| `scripts/eval/business-e2e/shared-instance.test.ts:113` | `bobCreate` |
| `scripts/eval/p2/p2-scenarios.test.ts:125` | `truth` |
| `scripts/eval/pi-native/safe-config.test.ts:26` | `HEADROOM_MARGIN_TOKENS` |
| `scripts/ops.test.ts:17` | `createTaskRegistry` |
| `scripts/p7b-fault-injection.test.ts:641` | `second` |
| `scripts/p7b-fault-injection.test.ts:651` | `third` |
| `scripts/shadow/double-source.test.ts:50` | `FIXTURE_ROOT` |

---

## 四、已删机制的残留引用

### 4.1 结论

全仓代码面**没有**对已删机制（旧 a2a 协议、plan-runtime/proposal-runtime、serve-gate、task-manager、pi-coding-driver、Phase 2 宿主五模块、generic-mock、旧 eval 仪器、`readSkill`/`discoverSkills`/`resolveActiveProfileId`、契约 `cancel`/`artifacts`/`confirmation_required`）的活 import 或调用。命中的都是以下三类：

1. **防回潮守卫的墓碑清单**——必须保留；
2. **安全不变量测试**——故意构造已删机制的 env/路径，证明宿主不再泄漏或转发；
3. **注释与 dummy 夹具的兼容面**——不参与产品可达路径，dummy 的计划/提案分支仍被现有测试作为对照使用。

### 4.2 逐条登记

| # | 文件:行 | 内容 | 判断 | 理由 |
|---|---|---|---|---|
| 1 | `packages/agent/import-boundary.test.ts:44-93` | `FORBIDDEN` 清单含 49 个已删治理模块路径（plan-runtime、serve-gate、task-manager、pi-coding-driver、task-handover、committed-unverified、tool-definition-guard、worker-step-cap、proposal-review 等） | **勿动** | 防回潮守卫；决策日志 §十三 13.4 明确保留 |
| 2 | `packages/agent/src/worker-env.ts:19-20` | 注释：“没有计划门，因此不注入 `EXECUTION_REQUIRE_PLAN`/`EXECUTION_PLAN_ID`” | 勿动 | 现行边界说明，不是对机制的调用 |
| 3 | `packages/agent/worker-env.test.ts:28,37,77` | 以 `EXECUTION_REQUIRE_PLAN`/`EXECUTION_PLAN_ID` 作为 sentinel，断言它们不出现在子进程 env | **勿动** | 凭据/旋钮隔离的失败注入测试 |
| 4 | `packages/agent/dummy-client.test.ts:180-209` | 适配器路径丢掉 `EXECUTION_REQUIRE_PLAN`；对照组直接 spawn 同一网关被 `PLAN_REQUIRED` 拒 | **勿动** | 安全不变量负向对照；删除会让“白名单真实生效”失去证明 |
| 5 | `scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:40-41,746-747,829-832` | dummy 仍实现可选计划门：读 `EXECUTION_REQUIRE_PLAN`，无 plan id 时 `PLAN_REQUIRED` 拒 | **勿动** | 宿主不注入，仅作为第 4 条对照组的执行层行为；删除会改变 fixture 契约 |
| 6 | `scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:27-29,503-511,653-674,862` | fixture 仍持 `plans.json`/`proposals.json` 与 `plan`/`proposal` 操作 | **疑似保留** | `dummy.proposal`/`dummy.prepare`/`dummy.commit` 仍被 `dummy-client.test.ts:114-117,237` 使用；host 侧提案机制已删，但夹具兼容面不能凭“看起来旧”删除 |
| 7 | `packages/agent/src/driver-contract.ts:5` | 注释提到旧 driver 的 plan-runtime/proposal-runtime 内容已移出 | 可改文字（未动） | 历史说明；不是运行引用 |
| 8 | `packages/agent/src/task-registry-sqlite.ts:13` | 注释“最小切片没有计划门，也不迁移旧 TaskRunRecord” | 勿动 | 现行语义说明 |
| 9 | `packages/agent/src/execution-runtime.ts:36` | 注释“计划门与预算梯子归执行层” | 勿动 | 现行职责边界声明 |
| 10 | `packages/contracts/src/execution-contract.ts:28,32` | 注释“计划门与预算梯子归执行层”“不是 A2A” | 勿动 | 契约语义的否定式说明 |
| 11 | `config/agent.fixture.yaml:7` | 注释提到旧 `scripts/eval/eval.agent.yaml` | 勿动 | 历史注记；文件本身是 `ask` 缺省配置 |
| 12 | `packages/core/src/index.ts:3` | 注释提到随旧 hub 删除的 `store.ts`/`plan-confirmation-store.ts` | 勿动 | 历史注记 |
| 13 | `scripts/ci.sh:14-16` | 注释说明旧 probe/acceptance/`generic-model-eval.py` 仪器已退役 | 勿动 | 退役口径说明；CI 已改挂 `eval:user` |
| 14 | `scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:48` | 注释提到已退役的 generic-mock eval 与决策日志 §十三 | 勿动 | 历史注记 |
| 15 | `packages/agent/resource-policy-single-source.test.ts:58-66`、`packages/core/config.test.ts:424-430` | 断言 `FSHINE_WORKER_STEP_CAP` 等已删配置键不再派生 | **勿动** | 已删配置键的守卫测试 |
| 16 | `tests/vitest.setup.ts:18-19` | 注释记录 `FSHINE_WORKER_STEP_CAP` 与 stock 六键已随 M4 删除 | 勿动 | 测试基线说明 |

### 4.3 未发现项

- 代码面（`.ts/.js/.cjs/.mjs/.json/.yaml/.yml`）中 `a2a`/`A2A` 仅剩 `execution-contract.ts:32` 的否定式注释；`CancelResult`、`confirmation_required`、`resend_artifact`、`task_control`、`measure-summary`、`generic-model-eval`（除退役说明）零命中。
- `.github/workflows/eval-real.yml:10` 明确写旧 harness 已删除且不恢复；当前入口为 `npm run eval:user`（`package.json:19`）。
- 文档面 `docs/a2a-protocol.md`、`docs/execution-layer-interface.md`（均已 2026-11-18 docs 清理删除，git 历史可考）、`docs/decision-log.md` 的历史章节按维护规则保留历史文本（不作为现行代码指针，也不改写），不计入代码面残留。
- 因此本节**没有执行任何删除**；任何“清理注释”都属于文字修正，需与历史文档口径一起评审。

---

## 五、重复实现

对生产/脚本面做“同名函数 + 归一化函数体”比对；以下为逐字或语义重复，均**登记不合并**。合并属于重构，不是死代码删除；本轮保持最小 diff。

| # | 实现 | 位置 | 证据 | 判断 |
|---|---|---|---|---|
| 1 | `errorText` ×4 | `packages/agent/src/run-dir-cleanup.ts:102`、`scripts/cleanup-runs.ts:97`、`scripts/ops.ts:354`、`scripts/tasks.ts:527` | 四份函数体归一化后逐字相同（`error instanceof Error ? error.message : String(error)`） | 可收敛；本轮不动 |
| 2 | `isInside` ×2 | `packages/agent/src/file-store.ts:328`（嵌套）、`packages/agent/src/skills.ts:233` | 逐字相同；`file-store.ts:327` 注释自述“与 skills.ts 的 isInside 同语义” | 可收敛；本轮不动 |
| 3 | `isRecord` ×2 | `packages/agent/src/session-persistence.ts:117`、`packages/core/src/config.ts:40` | 逐字相同 | 跨包重复；抽取需先定归属（core/contracts），本轮不动 |
| 4 | `sha256Hex` ×2 | `scripts/ask-replay.ts:129`、`scripts/ask-trace.ts:123` | 逐字相同；`scripts/eval/convergence-r1/hash.ts:20` 为冻结件第三份 | 可收敛到脚本公共 helper；冻结件不动 |
| 5 | `jsonSafe` ×2 | `scripts/ask-replay.ts:137`、`scripts/ask-trace.ts:127` | 逐字相同 | 可收敛；本轮不动 |
| 6 | `isAbortErrorLike` / `isAbortError` | `packages/agent/src/execution-runtime.ts:1696`、`packages/agent/src/task-runner.ts:297` | 语义与归一化函数体相同，仅命名不同 | 可收敛；两模块各自封装，抽取会增加依赖，暂缓 |
| 7 | `stripQuotes` ×2 | `packages/agent/src/agent-profile.ts:98`、`packages/agent/src/skills.ts:213` | 语义相同、实现不同（正则 vs 首尾判断） | 疑似重复；保留（YAML 解析口径不同，合并需先统一边界） |
| 8 | `compareSkillNames` ×2 | `packages/agent/src/worker-skills.ts:61`、`scripts/eval/sim/skill-telemetry.ts:88` | 逐字相同；eval 侧注释明确“生产排序口径（worker-skills.ts 的 compareSkillNames）” | **勿动**（有意镜像，评测与生产口径对照） |

未列入：测试辅助函数之间的重复（`incoming`、`testConfig`、`scriptedDriver` 等）。它们属于各测试文件的独立夹具，合并会制造测试间耦合，不按死代码处理。

---

## 六、删除提交与门

### 6.1 提交

`9ee0888` `chore(dead-code): 删除 5 个零引用导出与 4 个未使用符号`

```
9 files changed, 1 insertion(+), 28 deletions(-)
apps/server/server.ts
packages/agent/src/execution-runtime.ts
packages/agent/src/task-registry.ts
scripts/ask-trace.ts
scripts/eval/business-e2e/experiments/cases.ts
scripts/eval/pi152-stageD/client.ts
scripts/eval/pi152-stageD/scenarios.ts
scripts/eval/sim/case.ts
scripts/tasks.ts
```

未包含 `.runtime/**`、docs 历史文件、测试文件、冻结评测件。

### 6.2 实跑门

| 检查 | 命令 | 删除前 | 删除后 |
|---|---|---|---|
| 类型检查 | `npx tsc --noEmit` | exit 0 | **exit 0** |
| 未使用检测 | `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` | 75 条（68 TS6133 / 7 TS6196；生产 4 / eval 40 / 测试 31） | 71 条（65 / 6；生产 0 / eval 40 / 测试 31） |
| 全量测试 | `npm test` | 156 files / 1651 passed / 1 skipped，exit 0 | **156 files / 1651 passed / 1 skipped，exit 0** |

删除前后测试文件数与用例数不变（1651 passed / 1 skipped），说明没有删测试、没有弱化断言。

> 环境说明：一次与 `npx tsc` 并发执行的复跑中，`scripts/ops.test.ts > 缺库空态：exit 0、生成页面、绝不创建库文件` 子进程用例 30s 超时（该次 `ops.test.ts` 整体 62.8s）。同一文件单跑 29/29 通过（1.35s），随后串行全量复跑 156 files / 1651 passed / 1 skipped 通过。判定为并发负载下的环境超时；本批未改 `ops` 及其依赖链路。

### 6.3 反查证据（逐项）

```bash
# 5 个已删导出：删除前仅命中定义行
grep -rnw --include='*.ts' -E 'RunnerClass|casesOfKind|stateDirFor|A_RESTART_BEFORE_TURN|SIM_DEFAULT_LIMITS' \
  packages apps scripts tests
# 结果：仅 5 个定义行

# 4 个生产面未使用符号：删除前只被 tsc 报告，无运行引用
grep -rnw --include='*.ts' -E 'TERMINAL_STATUSES|DEFAULT_DB_PATH' packages apps scripts
# 结果：仅定义行；TurnDriver / TaskExecutionInput 为 type import，tsc TS6133/6196 报告

# 动态 import 保留项
grep -n 'await import' scripts/tasks.ts scripts/ask-trace.test.ts
# scripts/tasks.ts:519,524 -> './ask-runtime'（assembleAskRuntime / isAssemblyRefusal）
# scripts/ask-trace.test.ts:116 -> 变量 modulePath='./ask-trace'（validateTraceDir）

# 删除后复扫：严格零引用只剩 4 条保留项
node /tmp/deadcode-audit/scan-exports.mjs <repo>
# files=374 exports=1434 dead=4
# isAssemblyRefusal / validateTraceDir / FailureCode / missingSimKinds
```

### 6.4 反向绊线（删除可被编译器发现）

临时新增 `scripts/__tripwire-deadcode.ts`，同时引用 5 个已删导出：

```bash
npx tsc --noEmit
# exit 2，5 条：
#   ask-trace.ts: TS2724 no exported member 'RunnerClass'（提示 RUNNER_CLASSES）
#   cases.ts:   TS2305 no exported member 'casesOfKind'
#   client.ts:  TS2305 no exported member 'stateDirFor'
#   scenarios.ts: TS2305 no exported member 'A_RESTART_BEFORE_TURN'
#   case.ts:    TS2305 no exported member 'SIM_DEFAULT_LIMITS'

rm scripts/__tripwire-deadcode.ts
npx tsc --noEmit   # exit 0
```

证明：被删符号没有经 barrel、别名或声明合并残留；若未来代码重新引用，`typecheck` 会立即红。临时文件已删除，工作树干净。

---

## 七、复核命令清单

```bash
cd <repo>
# 1) tsc 未使用检测（不改 tsconfig）
npx tsc --noEmit --noUnusedLocals --noUnusedParameters

# 2) 已删导出零引用复核（删除前基线用 git show 23ae585:<path> 取回）
grep -rnw --include='*.ts' -E 'RunnerClass|casesOfKind|stateDirFor|A_RESTART_BEFORE_TURN|SIM_DEFAULT_LIMITS' \
  packages apps scripts tests

# 3) 动态 import 保留项
grep -n 'await import' scripts/tasks.ts scripts/ask-trace.test.ts

# 4) 冻结件不动
git diff 23ae585..HEAD -- scripts/eval/convergence-r1

# 5) 守卫/失败注入测试不动
git diff 23ae585..HEAD -- packages/agent/import-boundary.test.ts \
  packages/agent/worker-env.test.ts packages/agent/dummy-client.test.ts \
  packages/agent/resource-policy-single-source.test.ts

# 6) 门
npx tsc --noEmit
npm test
```

---

## 八、未决与建议（不在本轮删除）

1. **`missingSimKinds` 未接线**：`scripts/eval/sim/accounting.ts:123` 自称反向绊线但零调用。建议 owner 决定：接入 `run.ts` 的记账覆盖检查，或按“未使用守卫”登记删除；本轮不删，避免掩盖缺口。
2. **评测脚本 40 条未使用符号**：全在 `scripts/eval/**`，其中 `convergence-r1` 三处为冻结件。若要做无行为清理，按文件单独提交，不与产品面混在一起。
3. **测试文件 31 条未使用局部**：先判断是否为“断言漏写”的线索（如 `overThresholdReply`、`contextWindow`），再决定删或补断言；本轮不动。
4. **重复实现 6 组**：优先收敛 `errorText`、`sha256Hex`、`jsonSafe` 这三组纯函数；`isRecord`/`isInside` 涉及包边界，`isAbortError` 涉及模块依赖，另案评估。
5. **dummy 夹具的计划/提案兼容面**：与真实执行层契约无关，但当前测试依赖；若执行层确认不再需要 `PLAN_REQUIRED` 对照，可连同 `dummy-client.test.ts` 的对照组一起重设计，不能只删 fixture 分支。
