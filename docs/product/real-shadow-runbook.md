# 真实接入 Shadow 演练 Runbook（Dummy 路线就绪件）

> **硬声明：真实连接需 owner 授权，本 Run 不连接。** 本档是「接真后一条命令跑对照」的就绪件与评审材料，
> 不构成已授权接入。当前可执行面 = 仓内 dummy 源 × 测试用 fake-real 源（Dummy 路线）；真实企微/真实执行层、
> 真实凭据、真实数据一律不触（授权门见 `docs/product/real-read-readiness.md`、`docs/product/r3-open-decisions.md`）。
>
> **double 边界**：`fake-real` 是**测试夹具层级**的进程内 `ExecutionClient`（可配四态/错误信封/能力快照形状），
> 不是平台模拟框架——不模拟平台实现、网络、限流或凭据；若后续有人要求它模拟真实平台行为，停止并上报。
>
> 依据：`docs/product/real-read-readiness.md`（三步接入：fake-adapter dry-run → shadow 只读 → 受限真实只读）；
> harness/测试：`scripts/shadow/double-source.test.ts` + `scripts/shadow/double-source-harness.ts`；
> dry-run 读数与未能验证项：`docs/product/r4-shadow-dryrun.md`。

## 1. 接真前置检查（评审通过前不得进入任何真实连接步骤）

逐项勾选；任一项不满足即停（fail-closed），不得以「先跑起来再补」越门。

- [ ] **owner 授权**：真实接入的逐项授权（平台/范围/凭据/数据边界）；本 Run 未获取、不连接。
- [ ] **凭据边界**：平台凭据归执行层持有，宿主不落平台密钥（宿主配置面仅模型/渠道接入秘密，
      `packages/core/src/config.ts` 无执行层凭据键）；本机秘密只住 gitignored `.env`/`config/agent.yaml`，提交物零密钥。
- [ ] **worker env 白名单**：执行子进程 env 按 `packages/agent/src/worker-env.ts:25` 的精确白名单
      （PATH/HOME/TMPDIR）重建，未登记键默认不进；真实适配器若走子进程必须复用同一白名单与
      `--state-dir` 式显式参数，**不得**用环境变量注入凭据或改道状态。
- [ ] **前置硬条件（decision-log §七）**：worker 同 OS 用户可读 `.env`/config 的文件层缺口闭环前，
      真实凭据不得落在 worker 可读路径。
- [ ] **只读范围**：凭据仅具只读范围、可轮换/可吊销；能力快照的只读性声明（access/effects 等价物）
      由执行层自述，装配方派生允许集合（`scripts/ask-runtime.ts` 的 `resolveExecutionFace` 链）；
      集合必须非空且 ⊆ 快照，否则构造即失败。
- [ ] **env 注入面**：宿主只注入装配派生值（如 `EXECUTION_AUDIT_PATH` 指向本次运行审计文件）；
      不向执行层注入宿主模型/渠道秘密；真实平台相关配置（限流/审计）以执行层为准，不在宿主开第二份名单。
- [ ] **渠道隔离**：shadow 阶段不接渠道、不产用户可见结果（WeCom sink 不实现、不连接）。
- [ ] **回退就绪**：§5 的源开关/配置/提交级回退已确认可用。

## 2. 双源对照运行（当前可执行，零平台、零网络、零凭据）

```sh
# 目标套件：源 A（仓内 dummy fixture，真实 spawn/审计）× 源 B（进程内 fake-real）
TMPDIR=/home/tao/.tmp npx vitest run scripts/shadow/double-source.test.ts
# 期望：Test Files 1 passed；Tests 12 passed（含四态等价、只读哈希、fail-closed、回退开关、证据复跑、3 类绊线）
```

- **全量回归**：`TMPDIR=/home/tao/.tmp npx tsc --noEmit` → exit 0；
  `TMPDIR=/home/tao/.tmp npx vitest run` → 56 files / 606 tests passed（只增不减）。
- **证据落盘**：`runShadowComparison({ label, scenario, evidenceDir, fakeReal })` 写
  `evidenceDir/<label>/{summary,dummy,fake-real}.json`；`summary.digest` 不含时间戳/随机 id，
  同场景复跑必须同 digest；`summary.realConnection=false` 明示未接真实。Runbook 约定目录 = `.runtime/shadow/`（gitignored）。
- **持久化复跑（当前版本）**：从一次性 tsx 脚本调用 `runShadowComparison`（本 Run 的四态复跑读数见
  `docs/product/r4-shadow-dryrun.md` §3；scratch 入口 `.runtime/shadow/rerun-four-states.ts` 属 gitignored 证据，不入库）。
- **接真后（owner 授权后）**：在 `scripts/shadow/double-source.test.ts` 增补 `real` 源并把 §3 断言清单原样套用；
  `parseShadowSourceName` 对未登记源（含 `real`）当前 fail-closed，接入时必须显式登记 + 独立评审。

## 3. 断言清单（与 harness 测试同源；跑一条读一条）

1. **任务链语义等价**（受理/执行/终态/存档/通知意图）：两源同一条委派与同一次 operation 调用 →
   `compareChains` 投影逐键相等；四态各自成立（completed / needs_input / failed / refused）。
2. **双源机械事实非空（防单源冒充）**：源 A 必须有真实 spawn + 执行层 `audit.jsonl` 行且零进程内 calls；
   源 B 必须零 spawn + 有进程内 calls + 零审计行；两源 execution 记录 ≥1。任一缺失即判不等价。
3. **只读路径哈希不变**：数据面指纹读前=读后（源 A=state 数据文件、源 B=store 摘要）；
   同一只读调用复读两次结果摘要同哈希；只读允许集合由同一 `readOnlyOperationNames` 规则派生（双源一致）。
4. **失败 fail-closed**：failed/refused/needs_input 绝不投影为 completed；跨场景对照不得判等；
   空只读面装配拒绝（不以空集合运行）。
5. **回退开关生效**：源解析缺省 `dummy`、`dummy | fake-real` 确定、未知值 fail-closed 抛错点名「真实连接需 owner 授权」。
6. **证据落盘可复跑**：两次同场景 `digest` 相同；证据文件可解析；`realConnection=false`。
7. **反向绊线（≥3 类）**：单源事实冒充双源成功 / 只读哈希漂移 / fail-closed 破坏——故意破坏必须红
   （读数见 dry-run 报告 §4）。

## 4. 停止条件（命中任一：立即停跑、保留证据、登记 blocked、上报 owner）

| # | 条件 | 机械信号（harness） | 处置 |
|---|---|---|---|
| 1 | **错误率异常**：四态分布与预期不符、failed/refused 非预期集中 | `compareChains(...).equivalent=false` 或某场景 `diffs` 非空 | 停跑；保留 `summary.json`；按 `diffs` 键定位（terminal/executions/notifications） |
| 2 | **越权**：允许集合外调用、未发起执行即拒、能力快照/只读派生漂移 | `allowedOperations` 与基线不一致；provenance 违例（spawn/audit/calls 标记不符）；装配 fail-closed 拒绝 | 停跑；不得放行；按 §1 重审只读声明与派生规则 |
| 3 | **哈希漂移**：只读数据面指纹变化或复读结果不一致 | `verifyReadOnlyStable(...).ok=false`（violations 非空） | 停跑；视为写路径泄漏/状态污染；保全现场证据后复查执行层 |
| 4 | **单源证据缺失**：任一源无执行记录/无审计行/无调用记录 | `compareChains` provenance/`executions` diffs | 停跑；不得以单源事实宣称双源成功 |
| 5 | **任何真实连接迹象**（凭据/网络/渠道/真实数据） | 非本 harness 面（评审/人工观察） | 立即停止并上报（超出本 Run 授权边界） |

判读纪律：确定性读数不得读作稳定性结论；只在同口径（同 harness/同场景/同源开关）下比较；不筛绿、不重采样至绿。

## 5. 回退步骤（按代价从低到高）

1. **源开关**：`parseShadowSourceName` 缺省 = `dummy`（现状基线）；未知源（含 `real`）fail-closed；
   接真后的回退 = 把运行源切回 `dummy`（`fake-real`/`real` 不参与），断言清单不变。
2. **配置级**：`runtime.dispatchMode: inline`（或移除 `runtime` 段）即回现行同步路径，后台 runner/通知 outbox 不创建
   （见 `docs/product/r4-integration.md` §五）。
3. **提交级**：`git revert 35ea254`（harness 实现）与 `git revert 845cba3`（测试先行）互不依赖；
   本 runbook + dry-run 报告的 docs 提交可单独 revert。无 schema 迁移、无新增依赖。
4. **证据级**：`.runtime/shadow/` 整体 gitignored，可删除/重跑；重跑即新读数，须重新标注口径（不得冒充本次）。

## 6. 结果记录要求

- 每次对照运行保留：`summary.json`（digest/等价判定/只读判定/realConnection=false）、`dummy.json`、`fake-real.json`。
- 报告模板：范围 → 读数（逐场景）→ 未能验证项（真实形状/权限/延迟/错误码）→ blocked 审计 → 回退。
- 真实连接尝试（未来、owner 授权后）另立新 Run：本档只定义纪律与判据，不预授任何连接行为。

## 7. 指针

- 准备档：`docs/product/real-read-readiness.md`（§2 凭据边界 / §3 只读保障 / §4 评审清单 / §6 未知项）。
- 演练读数：`docs/product/r4-shadow-dryrun.md`；设计与证据索引：`.runtime/shadow/design.md`、`green-summary.md`、`tripwire-summary-r2.md`。
- 集成对照：`docs/product/r4-integration.md`（§五 默认行为与回退）、`docs/product/r4-p7b-acceptance.md`（blocked 台账）。
- 契约与运行时：`packages/contracts/src/execution-contract.ts`、`packages/agent/src/execution-runtime.ts`、`packages/agent/src/dummy-cli-client.ts`。
