# P0 装配同源：实施报告（2026-11-14）

> 分片依据：`docs/product/r4-slices.md` §三「P0 · 装配同源（重构，零行为变化）」；验收契约：`docs/product/r4-acceptance.md` P0-T01–T06（v1 预注册基线）。
> 授权：owner 2026-11-14「R4 下一阶段授权」§二（仅 P0）。边界：不接企微真实环境、不触真实 SaaS、不开新写操作、不新增依赖；不改 R3 冻结判据（criteria/cases/judge/lock 与 exploration）与历史评测证据。
> 分支/基线/提交：worktree `fshine-agent-p0`，分支 `arch/p0-assembly`；基线 `arch/integration` 启动时 HEAD `845bd27`；本片提交 `68e327c`（测试先行）→ `4823cc4`（refactor）→ `1e42bbb`（docs 注记）。未 push、未合并。
> 证据根：`.runtime/p0/`（gitignored，命令索引见其 `commands.txt`）。真实模型 smoke 使用本地 `.env`（gitignored，未入库；工作树原无 `.env`，为 smoke 从主工作树只读复制）。

## 一、产品要求（为什么做 P0）

- 目标（r4-slices §P0）：消除 ask/redo、server、eval runner 三份各自维护的装配链——`assembleAskRuntime` 增加注入 seam，server/runner 复用它（或抽出共享 core assembly）；资源策略读入口收敛到单点。
- 用户可观察面 = **零变化**：ask 单轮输出与五门拒绝话术字节金样、tasks 查看/redo 调用面、server 假渠道行为、runner 默认路径与证据 schema、Dummy 执行契约、任务底账全部保持；P0 是后续 P1–P8 与 P7「同一 Runtime」可验证的前提，不引入新生命周期/队列/调度器/事件总线/额外抽象。
- 硬纪律：测试先行（红）→ 最小实现（绿）→ 反向绊线；实施与独立复核分离。

## 二、验收用例（P0-T01–T06，全部确定性；逐条命令与结果）

| 用例 | 层级 | 命令（工作树内） | 结果 | 证据 |
|---|---|---|---|---|
| P0-T01 五门话术字节金样 | 确定性 | `TMPDIR=<tmp> npx vitest run --project unit scripts/p0-gates-cli.test.ts` | **passed（5/5）**：ask 与 `tasks --redo` 两入口五门逐字节（门 4 见边界登记） | `.runtime/p0/green-t01-gates.log` |
| P0-T02 runner 默认路径与 criteria.lock | 确定性 | `TMPDIR=<tmp> npx vitest run --project unit scripts/p0-runner-lock.test.ts`；另干跑 `LLM_API_KEY= npm run eval:user -- --case E01 --trials 1 --out-dir .runtime/p0/lock-dryrun` | **passed（2/2）**；干跑 exit 2（无 key 的既有 infra 归类），无 `[freeze]`/无「拒绝运行」；manifest 的 criteriaSha256/casesSha256 与冻结锁逐字一致，criteria/cases 冻结副本哈希一致 | `.runtime/p0/green-t02-runner-lock.log`、`.runtime/p0/regression-lock-dryrun.log` |
| P0-T03 单一装配点守卫 | 确定性（静态） | `TMPDIR=<tmp> npx vitest run --project unit scripts/p0-assembly-single-point.test.ts` | **passed（3/3）**：`createSession`/`createDummyCliClient`/`readOnlyOperationNames` 调用各唯一命中 `scripts/ask-runtime.ts`；四入口沿导入图可达；五门话术字面量唯一。实现前为红（各命中 3 文件），已在 `.runtime/p0/red-single-assembly.log` 留档 | `.runtime/p0/green-single-assembly.log` |
| P0-T04 确定性门 | 确定性 | `TMPDIR=<tmp> npm run typecheck`；`TMPDIR=<tmp> npm run test -- --project unit` | **exit 0**；unit **37 文件 / 320 例全过**（基线 33/305；只增不减：+4 文件/+15 例） | `.runtime/p0/regression-typecheck.log`、`.runtime/p0/regression-unit-final.log` |
| P0-T05 S3 文档口径 | 确定性（文档扫描） | `TMPDIR=<tmp> npx vitest run --project unit scripts/p0-redo-doc-scan.test.ts` | **passed（4/4）**：README 边界句 / decision-log §二十「名称说明」/ P3 报告首部注记 / tasks USAGE 一致 | `.runtime/p0/green-doc-scan.log` |
| P0-T06 凭据白名单不变 | 确定性（安全不变量） | `TMPDIR=<tmp> npx vitest run --project unit packages/agent/worker-env.test.ts` | **passed（3/3）**：仅 `PATH`/`HOME`/`TMPDIR` 进子进程；`LLM_*`/`WECOM_*`/`EXECUTION_*`/`FSHINE_*`/内部指针/测试桥键负例一律剔除 | `.runtime/p0/t06-worker-env.log`；在 `regression-unit-final.log` 中同跑 |

回退断言（r4-acceptance）：回退后 ask/runner 金样与单测仍全过——见「八、回退方式」。

## 三、装配收敛前后对照（三份装配 → 一份共享 + 注入清单）

**收敛前（基线 `845bd27`）**：三份并行装配链，各自 `createSession`：

| 入口 | 装配位置（基线） | 链 |
|---|---|---|
| ask / tasks --redo | `scripts/ask-runtime.ts:83-155` | 配置物化→loadConfig→生效环境→五门→隔离门→dummy 客户端+只读集→SQLite 底账→技能/角色→createSession |
| server | `apps/server/server.ts:65-119`（内联） | 门（单一 profile/gateway）→启动时装载底账/技能/角色→每会话面+驱动→createSession |
| eval runner | `scripts/eval/convergence-r1/runner.ts:346-408`（内联） | 门（key/profile/gateway/principal）→隔离门→dummy 客户端+只读集→per-case 底账→技能/角色→createSession（记录包装器） |

**收敛后（本片）**：门与方言留在各入口，门之后只有一条链 `assembleSessionCore`（`scripts/ask-runtime.ts:186`）：

```
stateDir/审计路径(setAuditPath?) → assertIsolation? → 执行面（defaultExecutionFace 或缺省 dummy+只读集非空）
→ 底账（taskRegistry 注入，或自建并由 close 关闭）→ 技能/角色/提示词（可注入）→ 驱动（可注入，缺省 pi×2）
→ createSession → { session, auditPath, taskRegistry, close }
```

**注入清单（各入口差异，全部经输入面注入；零行为变化）**：

| 维度 | ask / tasks --redo | server | eval runner |
|---|---|---|---|
| 渠道装配 | 无（CLI 单进程单会话） | 每 `(principal, session)` 惰性缓存（`server.ts:80-99`）；身份取渠道事实 | 无（每 trial 一个会话） |
| 回合驱动 | 缺省 pi×2 | `deps.createDrivers`（测试替身）；缺省 pi×2 | `recordingDriver(createPiTurnDriver)`×2（`runner.ts:249`，唯一允许插桩） |
| 执行面 | 缺省 dummy（仓内夹具） | `deps.createExecutionFace`；缺省 dummy | 缺省 dummy |
| 空只读集合话术 | `最小切片拒绝以空允许集合运行。`（AssemblyRefusedError） | `server 拒绝以空允许集合运行。`（普通 Error） | `拒绝以空允许集合运行`（普通 Error） |
| 底账 | 缺省按配置链/DB_PATH，自建自关 | 启动时建共享库（注入核心，server.close 关） | per-case 库（核心建；trial 内取回快照） |
| 配置/库 | 缺省物化 fixture；`--config`/`AGENT_CONFIG_PATH` | main.ts 显式部署配置（不物化） | per-case 配置副本（store.dbPath→case 库） |
| 审计路径 | `setAuditPath`（runtimeDir/state/audit.jsonl） | 不设（不建目录、不设 env） | `setAuditPath`（trial/state/audit.jsonl） |
| 隔离门 | `assertIsolation`（purpose 串） | 不设（部署面） | `assertIsolation`（case 标签） |
| 技能/角色/提示词 | 每次装配装载 | 启动时装载一次（注入核心） | 每次装配装载（core 缺省） |
| 门与方言 | 五门（purpose 参数化，话术字节不变） | 单一 profile/含 gateway 门（原文不变）；无 key 门、无隔离门 | key/profile/gateway/principal 门（原文不变）+ 隔离门 |

守门口径（P0-T03，`scripts/p0-assembly-single-point.test.ts`）：① 三个装配链符号的调用点在**生产面唯一文件**；② 四入口（ask/tasks/server/runner）沿相对导入图都到达该文件（动态 `import('./ask-runtime')` 计入）；③ 五门话术完整短语只在**字面量**层唯一（注释不计）。

## 四、实施改动（文件级）

| 文件 | 改动 | 说明 |
|---|---|---|
| `scripts/ask-runtime.ts` | +246/-123 主体 | 新增 `SessionAssemblyInput`（:117）、`defaultExecutionFace`（:160）、`assembleSessionCore`（:186）；`assembleAskRuntime`（:242）改调核心（五门/话术/exit2 归类/purpose 不变；空集合注入 AssemblyRefusedError） |
| `apps/server/server.ts` | 装配段改调核心（:88） | 门（:66-69）与启动时装载（:71-82）保留；惰性会话缓存保留（:80-99）；不设审计 env、不做隔离门；测试注入点签名不变；`ExecutionFace` 类型改由共享模块导出并保持再导出 |
| `scripts/eval/convergence-r1/runner.ts` | 装配段改调核心（:371） | 门（:357-374）、per-case 配置/库、记录包装器、隔离门、证据 schema/判据/锁全部保留；`assembled.taskRegistry` 供快照、`assembled.close()` 收尾 |
| `docs/decision-log.md`、`docs/product/p3-human-redo.md` | +2/+1 行注记 | S3 语义正名：`--redo` 是重新交办，不是人工接管、也不是会话续跑（历史标题/正文不改） |
| `docs/product/r4-acceptance.md`、`docs/product/r4-slices.md` | +1/+1 行注记 | P0-T01 门 4 口径注记；P0 实施注记（配置读入口/资源策略；只加注不改判据） |
| 测试（`68e327c`） | 4 新文件 + worker-env 扩展 | `scripts/p0-gates-cli.test.ts`、`p0-assembly-single-point.test.ts`、`p0-runner-lock.test.ts`、`p0-redo-doc-scan.test.ts`；`packages/agent/worker-env.test.ts` 负例扩展 |

**为何不能更小**：① 只改 server 或只改 runner，另一条独立链仍在，P0-T03 守卫必红，两处都必须走同一核心；② 直接让 server/runner 原样复用 `assembleAskRuntime` 会把 ask 的五门/隔离门/配置物化语义强加给它们，改变 server 启动行为与 runner 方言归类，违反零行为变化——故差异必须做成注入点；③ 核心留在 `scripts/ask-runtime.ts`（不新建模块、不进 `packages/agent`）：装配属入口/评测面，packages/agent 是运行时语义面，现状收敛点已在此，守卫也钉该层；④ 资源策略读入口：P0 时点不存在 runtime 配置段，无可收敛对象，不空建（见边界登记）。

## 五、执行证据（命令 + 结果 + 路径）

确定性门与目标测试（本轮实跑，证据在 `.runtime/p0/`）：

- `npm run typecheck` → exit 0（`regression-typecheck.log`）。
- `npm run test -- --project unit` → exit 0；**37 文件 / 320 例全过**（`regression-unit-final.log`；基线 33 文件/305 例，只增不减）。
- P0-T01/T02/T03/T05/T06 逐用例命令与结果见 §二表格；测试先行 RED 留档：`red-single-assembly.log`（P0-T03 2 failed/1 passed）、`red-doc-scan.log`（P0-T05 2 failed/2 passed）。
- 反向绊线（故意破坏→必红→恢复；本轮独立复跑）：A. server 重分叉装配调用 → P0-T03 **2 failed/1 passed（exit 1）**（`tripwire-round3/A-fork-guard.log`）；B. 门 2 话术删一个 ASCII 空格 → P0-T01 **1 failed/4 passed（exit 1）**（`tripwire-round3/B-byte-gates.log`）；恢复后复跑：目标测试 8/8、全量 unit 37 文件/320 例全过（`tripwire-round3/after-restore-green.log`、`after-restore-unit.log`），`git status --porcelain` 0 行。冻结面（criteria/cases/judge/lock）未做破坏实验（边界：不触）。

真实模型 smoke（`LLM_MODEL=step-3.7-flash` + 仓内 dummy 执行层；N=1，仅 smoke，**不作稳定性结论**）：

- `npm run ask -- "帮我查一下 beta 集合、窗口 W1 的数据"` → exit 0；回复含 beta/W1 真实查询结果；机械证据 `委派=是`、`结构化执行=1 次（完成 1）`、dummy 审计 1 行、15.0s（`regression-ask-smoke.log`）。输出形态与 P0 前一致（回复 + 机械证据 + 审计行）。
- `npm run eval:user -- --case E06 --trials 1` → exit 0，`[judge] E06 trial-1: PASS`（零委派零执行、如实问回；`regression-e06.log`，证据 run-dir `.runtime/eval-r1/runs/E06/trial-1/`）。
- `npm run eval:user -- --case E12 --trials 1` → exit 0，`[judge] E12 trial-1: PASS`（纯聊天零执行；`regression-e12.log`，证据 run-dir `.runtime/eval-r1/runs/E12/trial-1/`）。
- runner 锁校验干跑：`LLM_API_KEY= npm run eval:user -- --case E01 --trials 1 --out-dir .runtime/p0/lock-dryrun` → exit 2（无 key 的既有 infra 归类），无冻结拒绝；manifest criteria/cases 哈希与 `criteria.lock` 一致（`regression-lock-dryrun.log`）。

未运行/不宣称：runner 的**模型回合**无模型无关的端到端触发点（key 门在装配前，假造模型需新框架，超出 P0 边界），故未实跑 runner trial 的完整模型回合；runner 装配差异注入面由类型检查、静态守卫与共享核心在 ask/server/tasks 侧的真实装配用例覆盖。

## 六、边界登记

1. **P0-T01 门 4 结构口径**（已注记于 `docs/product/r4-acceptance.md` P0-T01 行）：门 4（无 enabled principal）在 `tasks --redo` 入口结构性不可达——redo 身份取存储事实（`tasks.ts:444` 的 `principalId: task.principalId`；`ask-runtime.ts:255-258` 的 `input.principalId ?? 配置回落`），有效任务行必有 principal。门 4 字节金样由 `npm run ask` 覆盖；redo 侧以「不误报门 4、继续到门 5」的等价断言钉住（`scripts/p0-gates-cli.test.ts`）。
2. **资源策略读入口**（已注记于 `docs/product/r4-slices.md` P0 范围行）：共享装配即**唯一配置读入口**（配置加载/生效环境/门后装配链收口）；`runtime` 资源配额段与单点策略**归 P5 落地**——P0 时点不存在该配置段，不空建（不引入额外抽象/预期外行为）。
3. **测试侧口径**：工作树无 `.env` 时 `node --env-file-if-exists=.env` 会向 stderr 打固定噪声行，会破坏字节金样；P0 测试 spawn 省略该 flag（与 npm 脚本同一入口文件与参数、env 显式控制），已登记于测试文件头。
4. **外部边界（沿用）**：真实企微未连、真实 SaaS 未触；`.env` 仅本地存在（gitignored，未提交）；E06/E12 为 N=1 smoke，不作稳定性结论。

## 七、独立复核（待复核占位）

- 复核范围建议：① 三入口确实同源且无旁路（跑 P0-T03 守卫 + 抽查 `assembleSessionCore` 调用点）；② 零行为变化证据链（P0-T01/T02 金样、server 假渠道回归、tasks/ask 回归、typecheck+unit）；③ R3 冻结面零改动（`git diff 845bd27..1e42bbb --name-only` 不含 criteria/cases/judge/lock/exploration）；④ 反向绊线真实性（可复跑 tripwire 轮）；⑤ 回退可执行（§八）。
- 复核人：**待定**；复核日期：**待定**；复核结论：**待填**（本节由独立复核者补写，实施者不代填）。

## 八、回退方式（整片 revert）

- 本片无 schema/数据迁移、无行为变化，回退 = 丢弃/撤回两个实现提交：
  - `git revert --no-commit 1e42bbb 4823cc4`（或分支未合并时直接不合并）——恢复 `scripts/ask-runtime.ts` / `apps/server/server.ts` / `scripts/eval/convergence-r1/runner.ts` 与 docs 注记到基线 `845bd27` 形态。
  - `68e327c`（测试）建议保留为回归钉；注意：回退 refactor 后 **P0-T03 守卫按设计变红**（它钉的正是「已收敛」状态），P0-T05 文档扫描同理依赖注记提交。
- 回退断言：ask/runner 金样（P0-T01/P0-T02）与全量单测在回退后的基线上全过（零行为变化）；本片未触 schema、底账与历史证据，回退不涉及数据处置。
