# P7a ask-first 前置能力：实施报告（2026-11-14）

> 分片依据：`docs/product/r4-slices.md` §三「P7 · ask-first 扩展」与 `docs/product/r4-acceptance.md` §3/§3.1（脚本格式与断言最小集）、P7-T01–T05/E01（v1 预注册基线）。
> owner 拆分口径（2026-11-14 排程裁定）：**P7a 只做前置能力——交互式 ask、脚本回放、轨迹采集**；资源限制/异步执行/故障场景属 **P7b**（依赖 P5/P6，未授权）。P7-T06（故障注入）与依赖 P4/P5/P6 的断言/注入/证据种类一律 `blocked`（引擎 fail-closed 报 blocked，不静默通过、不跳过宣称完成）。
> 分支/基线/提交：worktree `fshine-agent-r4-p7a`，分支 `arch/r4-p7a-askfirst`；启动基线 `arch/integration` HEAD `46f757e`（含 P0 合入 `578b351`；R4-P1 当时未合入）。P1 合入后（集成 HEAD `54a02c1`）按 owner 排程 rebase，rebase 后提交链：`7764e13`（测试先行）→ `a62a533`（测试自身缺陷修正）→ `8c82313`（最小实现）→ `fdf5da7`（docs 报告）→ 本收口提交（「rebase 收口 ask.ts」，interactive 证据行复用 P1 渲染）。冲突仅在 `scripts/ask.ts`：P1 的 `renderAskEvidenceLines`/`taskLabel`/`import.meta.main` 守卫 vs P7a 的 flag 解析与 dispatch —— 双方语义都保留（单轮走 P1 渲染；interactive/script 走 P7a dispatch 与新模块）。未 push、未合并。
> 证据根：`.runtime/p7a/`（gitignored）。真实模型 smoke 的密钥来自主工作树 `.env`（gitignored，`node --env-file=` 只读加载，未写入本工作树任何文件）。
> 声明：**P7a 单独记录完成状态，不冒充完整 P7 验收**——P7b 与 P7-T06 未实施；黑盒层仅有 P7-E01 smoke（N=3，标 INSUFFICIENT_EVIDENCE）。

## 一、产品要求（为什么做 P7a）

任务书 §7 要求 ask 具备七项扩展（连续交互、脚本回放、后台运行中发消息、主动通知模拟、多用户多会话、故障注入、结构化轨迹+自动断言），并保留单轮 `ask` 兼容、与生产同一 Runtime。owner 把可直接落地的前置面拆为 P7a：

- **交互式**：单进程一个 Session 循环 send，逐回合给出回复 + 机械证据（用户可连续追问、模型可跨回合理解省略/指代）。
- **脚本回放**：§3.1 格式的确定性回放——同一脚本重复执行逐字可复现（假 driver、零模型、零网络），坏脚本 fail-closed；多 session / 多 principal 按可信身份隔离。
- **轨迹**：复用 convergence-r1 runner 证据 schema 的**适用子集**（11 类），缺失类显式声明；自动断言给出 pass/fail/blocked 定位。
- **同一 Runtime**：交互与回放都经 `scripts/ask-runtime.ts` 的共享装配（P0 唯一装配点）+ 记录包装器；不建第二套 Runtime、不建影子任务系统。
- 硬纪律：测试先行（红）→ 最小实现（绿）→ 反向绊线；不新增依赖；不触真实 SaaS/企微、eval 锁/cases、其他工作树。

## 二、验收用例覆盖（P7-T01–T05 / E01）

| 用例 | 层级 | 覆盖方式（测试/证据） | 状态 |
|---|---|---|---|
| P7-T01 连续交互会话 | 确定性 | `scripts/ask-interactive.test.ts`：进程内经共享装配 + 假 driver，同 Session 两回合（空行跳过、回合 3 不出现、任务同 scope）；CLI 走同一五门（缺密钥金样逐字节、`--interactive` 拒消息参数） | 已实现/已测试（绿） |
| P7-T02 脚本化回放 | 确定性 | `scripts/ask-replay.test.ts`：合法脚本 exit 0；**同脚本两跑 stdout 与全部证据文件逐字一致**；多 session/多 principal scope 各归各；坏脚本 14 类 fail-closed exit 2；`--script` 空格形态不要求密钥 | 已实现/已测试（绿） |
| P7-T03 结构化轨迹 + 自动断言 | 确定性 | `scripts/ask-trace.test.ts` + `ask-replay.test.ts`：固定证据文件集（11 类适用子集 + `assertions.json` + `evidence.manifest.json`）；`validateTraceDir` 缺类/坏 schema 判错；断言引擎最小集单测（parse/evaluate） | 已实现/已测试（绿） |
| P7-T04 单轮兼容 | 确定性 | `scripts/p7a-single-turn-compat.test.ts` + `scripts/p0-gates-cli.test.ts`（五门字节金样）+ 本次人工字节比对（见 §四） | 已实现/已测试（绿，逐字节） |
| P7-T05 同一 Runtime 守卫 | 确定性（静态） | `scripts/p7a-same-runtime.test.ts`（新模块存在/导入图可达/ask.ts 挂钩/链符号零调用）+ `scripts/p0-assembly-single-point.test.ts`（ENTRY_FILES 扩展 ask-replay/ask-interactive） | 已实现/已测试（绿） |
| P7-T06 故障注入 | 确定性 | **blocked**：owner 划 P7b（依赖 P4/P5/P6）；引擎把已知注入事件（restart/池满/资源等）与未就绪断言/证据/threshold 一律判 blocked（exit 3），不模拟 | 未实施（blocked 路径已测） |
| P7-E01 交互式 3 回合（黑盒） | 黑盒 smoke | 本次实跑：真实模型 `LLM_MODEL=step-3.7-flash`，3 回合交互，逐回合证据留档；**N=3，标 INSUFFICIENT_EVIDENCE，不作稳定性结论** | 已留证（smoke） |

**blocked 清单（引擎内固化，fail-closed；见 `scripts/ask-assert.ts` / `scripts/ask-replay.ts`）**：

- 断言：`notification_delivered`（P4）、`resource_released`（P5）、`not_blocked` / `main_not_blocked`（P5/P6）。
- 注入事件：`task_completed`/`task_failed`/`task_cancelled`/`task_timeout`（P2/P4）、`notification_*`（P4）、`restart`（P6）、`pool_full`/`queue_full`/`resource_shortage`/`resource_released`（P5）、`wait_user_timeout`（P2/P5）。
- 证据类：`notifications`（P4）、`resources`/`resource_usage`（P5）、`judgment`（convergence-r1 判定不在本片范围）。
- `threshold: blackbox`（真实模型层未授权落地）。
- blocked 语义：exit 3；blocked 之后的回合不执行；未到断言时点的不判定（也标 blocked）；绝不 exit 0。

## 三、实施改动（文件级）

| 文件 | 性质 | 内容 |
|---|---|---|
| `scripts/ask-assert.ts`（新增 241 行） | 新增 | 断言引擎最小集：`parseAssertionSpec`/`evaluateAssertion`/`SUPPORTED_ASSERTIONS`/`BLOCKED_ASSERTIONS`；`no_fabricated` 取严格可溯源口径（回复数值须在回合用户消息、该回合审计行、任务汇报中溯源；比 R1「弱告警」更严，声明于文件头） |
| `scripts/ask-trace.ts`（新增 461 行） | 新增 | `createTraceRecorder`：script 模式证据确定性归一（`task@n`/`req@n`、剔 `ts`/`createdAt` 等时钟与耗时、transcript 投影）；interactive 模式原样记录。`validateTraceDir`：schema/11 类覆盖/文件存在可解析/blocked·not_applicable 须带 reason |
| `scripts/ask-replay.ts`（新增 746 行） | 新增 | §3.1 的 P7a 子集（`scenario`/`session`/`sessions`/`config`/`threshold`/`turns[message+model 计划｜inject]`/`expect`/`evidence`）；共享装配核心 `assembleSessionCore` + 脚本计划假 driver + 记录包装器；退出码 0/1/2/3；`--trace` 落盘（`runtime/` 为运行态） |
| `scripts/ask-interactive.ts`（新增 185 行） | 新增 | `runInteractiveLoop`（单 Session 循环 send、逐回合回复+机械证据、空行跳过、空回复/send 异常如实 exit 1）；`runInteractiveCli`（经 `assembleAskRuntimeCli` 同一五门；`--trace` 走交互记录器）；逐回合证据行**复用 ask.ts 的 `renderAskEvidenceLines`**（rebase 收口后，与单轮同一渲染函数：`任务=#编号 名称`） |
| `scripts/ask-runtime.ts`（+24） | 最小改 | 增 `assembleAskRuntimeCli`：单轮/交互共用的 `rm+mkdir` 仪式 + 同一 `assembleAskRuntime`（五门话术仍在单点，守卫不破） |
| `scripts/ask.ts`（+127） | 最小 hook | flag 解析扩展（`--interactive`/`--script`/`--trace`，`=` 与空格两形态；与消息参数互斥、`--script` 拒 `--principal/--session` 覆盖、`--trace` 需配引擎、缺值 fail-closed，全部 exit 2）+ script/interactive 两个 dispatch 分支；单轮执行体与五门 catch/输出**逐字未动** |

**最小性**：无新增依赖、未改 `package.json`；未建第二套 Runtime/影子任务系统；交互与回放都经 `scripts/ask-runtime.ts`（P0 唯一装配点），由 import 守卫常驻钉住；不触 eval 锁/cases、历史证据、其他工作树。

## 四、执行证据（本次复跑读数）

**统一回归（P1 合入 + rebase 收口后；集成 HEAD `54a02c1`）**——`.runtime/p7a/rebase/`：

- `npm run typecheck` → `TSC_EXIT=0`。
- `npm test`（全量 unit）→ `Test Files 45 passed (45)`；`Tests 425 passed (425)`；`VITEST_EXIT=0`（基线 37 文件/320 例 → 只增不减；P1+P7a 合入后与 owner 预期 45/425 一致）。证据 `rebase/unified-full.txt`。
- P7a 目标批次（回放确定性/trace schema/守卫/blocked/单轮兼容 + P0 五门）：7 文件 **57 passed**。P1 目标批次（迁移/存档/显示/tasks/ops/redo）：6 文件 **87 passed**。证据 `rebase/unified-targets.txt`。
- 单轮金样逐字节复核（最终代码）：缺密钥门 stderr 与金样 `diff` 空（`STDERR_BYTE_IDENTICAL`）、exit 2、stdout 0 字节。证据 `rebase/single-turn-golden.txt`。
- P7-E01 复核（rebase 后最终代码）：同 3 回合真实模型命令 → `E01_EXIT=0`；逐回合证据行已是 P1 渲染（`任务=#编号 名称`）；`validateTraceDir` 对 `rebase/e01-trace` `ok: true`；N=3 仍标 INSUFFICIENT_EVIDENCE。证据 `rebase/e01-interactive-smoke.txt`。

**确定性门（P7a 阶段读数）**——`.runtime/p7a/regression/p7a-regression.txt`：

- `npm run typecheck` → `TSC_EXIT=0`。
- `npm test`（全量 unit）→ `Test Files 42 passed (42)`；`Tests 369 passed (369)`；`VITEST_EXIT=0`。基线（P7a 前）37 文件/320 例 → **只增不减：+5 文件/+49 例**（全过）。

**ask 单轮金样逐字不变**——`.runtime/p7a/regression/single-turn-golden.txt`：

- `env -i PATH/HOME/TMPDIR node --import tsx scripts/ask.ts "你好"` → exit 2、stdout 0 字节、stderr 与金样 `diff` 为空（**STDERR_BYTE_IDENTICAL**）。
- 补充：`--interactive` 同门拒绝亦逐字节一致（**INTERACTIVE_STDERR_BYTE_IDENTICAL**）。
- 既有 `scripts/p0-gates-cli.test.ts`（ask 与 `tasks --redo` 五门金样）在全量门内同跑通过。

**trace 干跑 + schema 子集校验 + 回放确定性复跑**——`.runtime/p7a/regression/trace-dryrun-determinism.txt`：

- `node --import tsx scripts/ask.ts --script <脚本> --trace <目录>` 两跑均 exit 0；`cmp` 两跑 stdout **逐字节一致**；第 1 跑全部 12 个证据文件与第 2 跑逐一 `cmp` **逐字节一致**（`ALL_EVIDENCE_IDENTICAL`）。
- `validateTraceDir` → `ok: true`，`errors: []`；类别状态：`inputs/model/toolcalls/transcript_main/transcript_worker/audit/audit_index/executions/reply/meta/assertions=present`，`judgment=not_applicable`，`notifications/resources=blocked`。

**P7-E01 交互式 3 回合真实模型 smoke（N=3；INSUFFICIENT_EVIDENCE）**——`.runtime/p7a/e01-interactive-smoke.txt`、`.runtime/p7a/e01-trace/`：

- 命令：`printf '帮我查一下 beta 集合、窗口 W1 的数据\n再确认一下刚才那个任务的结果\n谢谢你\n' | LLM_MODEL=step-3.7-flash node --env-file=<主工作树 .env，只读> --import tsx scripts/ask.ts --interactive --trace .runtime/p7a/e01-trace`。
- 结果：`E01_EXIT=0`。回合 1 委派 1 任务/2 次结构化执行（13.5s）；回合 2 指代接续成功（「刚才那个任务」→ 再次查询并核对，1 任务/1 执行，8.1s）；回合 3 无委派（1.1s）。逐回合 reply 与 sha256 见 `e01-trace/reply.jsonl`；`validateTraceDir` 对交互轨迹 `ok: true`（`toolcalls/transcript_worker=not_applicable`、`judgment=not_applicable`、`notifications/resources=blocked`）。
- 口径：**N=3 仅作 smoke 证据**（按验收 §五：标 INSUFFICIENT_EVIDENCE，不作稳定性结论、不重采样至绿）；模型身份由命令行 `LLM_MODEL=step-3.7-flash` 注入；交互轨迹 `model.json` 记 `source=进程 env`、`modelId=null`（记录面未接线，见 §八 登记）。

**反向绊线（3 类；破坏未提交、随即还原）**——`.runtime/p7a/tripwire-01-nondeterminism.txt`、`tripwire-02-schema-silent.txt`、`tripwire-03-bypass-assembly.txt`、还原复跑 `.runtime/p7a/restore-verify.txt`：

- ① 回放非确定性（`inputs.json` 注入 `new Date().toISOString()`）→ 确定性用例红（`1 failed | 28 skipped`）。
- ② trace 缺类静默通过（`validateTraceDir` 缺文件分支改 `continue`）→ schema 校验用例红（`1 failed | 4 skipped`）。
- ③ 新入口旁路装配（`ask-replay.ts` 加 `createDummyCliClient` 调用）→ P7a 守卫与 P0-T03 守卫同时红（`2 failed | 6 passed`）。
- 还原后：两文件与备份逐字节一致、`git status` clean、HEAD 未变；`npm run typecheck` 0；全量 unit 42/369 全过。

## 五、独立复核（占位）

> 待独立复核员（实施/复核分离）裁决，本节暂为占位。建议复核清单：
> 1）读取测试是否放宽/弱化判据；blocked 是否存在任何 exit 0 路径；2）守卫是否真能拦住第二套装配（含动态 import 与旁路调用）；3）trace 归一（剔 ts/耗时、标识别名）是否吞掉证据或掩盖失败；4）单轮金样与五门话术是否逐字节；5）P7a 声明是否越界（是否声称完整 P7/P7-T06）；6）断言引擎边界（`no_fabricated` 严格口径、`task_no` 的 P1 依赖登记）。

## 六、回退方式

CLI-only：整片 revert 本片提交即回到旧 CLI（`ask` 单轮行为不变；无 schema/底账变化；新增四文件可整片删除；`ask-runtime.ts`/`ask.ts` 的增量可单独回退）。回退后 `npm run typecheck` 与既有单测仍应全过（P0 五门金样与单轮兼容钉不依赖本片）。

## 七、与 P1 的 ask.ts 接线口径（owner 裁定）

- **唯一负责人制（已执行）**：合并顺序 P1 先合、P7a rebase 后由 **P7a 实施员统一收口 `ask.ts`** 并做统一回归。实际冲突面仅在 `ask.ts` 的 import 区（P1 的 `TaskRecord`/`taskLabel`/`renderAskEvidenceLines`/`import.meta.main` 守卫 vs P7a 的 `readline`/`runInteractiveCli`/`runReplayCli`），已两全保留；单轮路径沿用 P1 渲染，interactive/script 走 P7a dispatch，交互逐回合证据行复用同一 `renderAskEvidenceLines`（本收口提交）。
- **依赖登记**：R4-P1（数字 ID/业务名称/回复存档）已合入集成（`54a02c1`）并完成 rebase；`task_no` 断言当前仍以**底账标识**承担「非空/互异/跨回合稳定」不变量（收口不扩范围），P1 展示面的 `#<no>` 升级留待后续切片按准入办理（实现处已留注释与设计说明）。
- P4/P5/P6 未合入 → 对应断言/注入/证据/threshold 种类保持 `blocked`，不得为过绿放开。

## 八、已知边界（登记）

1. 交互轨迹的 `toolcalls`/`transcript_worker` 未接线（`not_applicable`）：交互模式只记录 Main 面；P7b 需要时补记录包装器。
2. 交互轨迹 `model.json` 未写模型 id（`modelId=null`，`source=进程 env`）：模型身份目前由运行命令注入；如需逐 run 固化模型名，随 P7b 记录面一并接线。
3. 脚本回放的 `hash_unchanged` 基线在脚本载入时采集（脚本目录相对路径）——运行中目标被外部改动会如实判 fail，属预期语义。
4. 多会话回放的证据标识归一（`task@n`/`req@n`）为回放确定性服务；原始标识/时钟面保留在 `runtime/`（SQLite 底账与原始审计）。
5. P7-E01 为 N=3 smoke（INSUFFICIENT_EVIDENCE）；完整 P7 黑盒验收（含 P7-E01 的预注册口径）与 P7-T06 均未执行。
