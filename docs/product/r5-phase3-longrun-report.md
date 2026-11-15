# R5 Phase 3 长稳报告（S1–S3 见 decision-log §六十三登记；本文件为 P3 追加调查章节）

> 本文件由 R5 P3 追加调查（分支 `arch/r5-p3s45`，基线 = arch/integration @d5fe7d4）新增。
> S1–S3 既有读数登记于 `docs/decision-log.md` §六十三（本批不改、不复述不改写）。
> 本批只定位、不修：产品代码 0 修改；不重写 Worker 系统提示；不新增宿主语义治理；
> 复用 `scripts/eval/p3/*` 既有设施，未造平行框架。

## §追加（P3s45）：S4 定向对照 + S5 机制定位（2026-11-15）

**预算执行**：恰好 2 个真实模型会话（S4 1 + S5 1），均 step-3.7-flash、LLM_CONTEXT_WINDOW=8192、一次采样、硬停未触发。
- S4：`scripts/eval/p3/p3s4-session.ts`（提交 211ade3），22 轮，29 calls / 124,157 tok / 411.5s；P3S4_DRY=1 干跑 0 模型调用验证装配。
- S5：`scripts/eval/p3/p3s5-session.ts`（提交 6ad7e8f，复制 p3s4 骨架仅换探针轮次），22 轮，31 calls / 164,162 tok / 635.8s（evidence.json `manifest.budgetUsed`）；P3S5_DRY=1 干跑 0 模型调用、首轮前硬停。
- 证据：`.runtime/r5p3s45/s4`、`.runtime/r5p3s45/s5`（gitignored）。driverEvents 嵌在 evidence.json 内。

### ① 三类退化逐项复现结果

| 退化 | S4 | S5 | 判定 |
|---|---|---|---|
| 空答 / 上下文丢失 | **复现**（turn8/11/19/21：四轮回合前压缩均塌缩到 tokensAfter=15 的近空摘要，回复全为通用问候/「未加载到摘要」；tokensAfter>200 的轮全部正常，无反例） | **复现**（turn6 tokensAfter=15→「此前会话摘要没有实际内容」反问澄清；turn19 tokensAfter=15→对「1 号结果再给我」回通用问候、0 工具调用；turn13 tokensAfter=15→「重新查 contoso-trade」**未创建任务**，仅调 task_status 复述历史） | 两会话一致指向 tokensAfter≈15 的近空摘要 |
| 原始 JSON 泄漏 | **不复现**（P1c/P2c 交替读回复述干净，全文无裸信封） | 不复现（22 轮回复均无裸信封） | 如实记：不复现 |
| 无谓澄清致取消悬空 | 前段不复现（turn6 立即建任务 #3、turn7 task_cancel ref=#3 路由正确、outcome=terminal/completed 为任务已在 turn6 轮内完成的终态、取消后 0 次派发）；**后段变体复现**（turn19 同一交办原文未创建任务→turn20 取消请求无对象：模型未调 task_cancel 也未如实说明「未创建」而反问；turn20 后 0 次执行） | 前段明确取消全落地（turn4 ref#2、turn15 ref#5、turn22 ref#10 均调用且路由正确）；turn6 指代取消失败（近空摘要→澄清，未调 task_cancel；目标 #3 已终态）；turn18 模型声称「本次会话中并未执行任何取消操作」——**与 turn15 已执行 task_cancel #5 的事实相悖**（虚答，见②） | 取消悬空按 owner ①独立判定见④ |

### ② 压缩与退化的关联证据 + 局限

**生命周期（owner ③）**：36 emergency / 49 compacted（S1）与 S5 的 19/32 为同一模式三连：`transformContext` 检测超阈（`packages/agent/src/pi-driver.ts:701-711`）emit `context_emergency_compact` → 强制 `compactTranscriptWithPi` → 内部 emit `context_compact_trimmed` + `context_compacted`。三连发生在同一 turn 工具循环迭代之间（每条模型请求前复核）。

- S1：49 compacted = 36 无效（emergency 产物，tokensAfter==tokensBefore 精确相等）+ 13 有效；turn13 单轮 10 次三连。
- S4：首次真实压缩 turn4 回合前（2782→497）；context_compacted=18（生效 13 / 应急无效 5）、emergency=5；「未压缩前段」实际仅 turn1-3。
- S5：首个 compacted 在 turn5 回合前（2602→416）；随后 14 次「生效压缩」（keptMessages=0）；全程 compacted=32 / emergency=19 / trimmed=18；**19 次 emergency 全部无效**（trimmed removedMessages=0，随后 compacted tokensBefore==tokensAfter、keptMessages=2~8）＝纯额外模型调用/token 开销，0 条 compact_failed / no_cut / invariant_violated——摘要未失败，是产物零缩减后再次过阈再触发。
- emergency 在 ~2.5k-3.5k tok（W=8192）即触发的原因是机械可解释的：headroom = max(1024, fixedOverhead+1024)，而 fixedOverhead（Δ_worst = sys+tools 实测）在 8192 窗口下占比很大（`pi-driver.ts:657,703`），不是误报。
- **关联证据**：两会话所有塌缩回复（S4 turn8/11/19/21；S5 turn6/13/19）对应的回合前压缩产物均为 tokensAfter=15 的近空摘要；tokensAfter>200 的轮全部正常（S4 无反例、S5 无反例）。S5 turn8 同为「结果找回」探针且压缩产物 478 tok，靠 `task_result` 读回答对（1200+800=2000）——即结果找回的可行路径是工具读回而非摘要。
- **局限**：N=2 会话、每退化形态 3–4 个实例；tokensAfter=15 与退化共变但未做摘要内容逐 token 比对（摘要文本未单独落盘），不能断言必然因果；S4 turn4 压缩后首对比轮 alpha 总额答 500（真值 2000）而同轮 beta 正确（走 task_result）——单例，不单独归因。

### ③ 发生层级（逐条）

| 失败 | 层级 | 依据 |
|---|---|---|
| 塌缩空答（S4 t8/11/19/21；S5 t6/19） | **Pi 压缩层**（摘要产物近空） | driverEvents 显示对应回合前 compacted tokensAfter=15；同轮请求照常发出（非工具/渲染问题）；tokensAfter>200 无一塌缩 |
| 压缩后交办丢失（S5 t13 未建任务；S4 t19 同型） | **Pi 压缩层为主 + Main 次之**（近空摘要下模型未调 run_task 也未如实说做不到） | t13 toolCalls 仅 task_status，tasks.json 中无对应新任务；回合前压缩 3850→15 |
| 压缩后虚答「未执行过取消」（S5 t18） | **状态恢复/摘要面**（事实已不在上下文，且未走工具核对取消历史） | t15 toolCalls 有 task_cancel ref#5；t18 回合前压缩 4404→232 |
| 无对象取消反问（S4 t20） | **Main**（任务未创建是压缩所致，但「未如实说明未创建」是模型行为） | 交代原文与 S4 前段相同，前段正确建任务 |
| emergency 三连零缩减循环 | **Pi 压缩层机制开销**（非失败：INV 守卫按设计触发，产物无缩减即再触发） | 19/19 removedMessages=0 且 tokensBefore==tokensAfter；`pi-driver.ts:701-711` 每条模型请求前复核 |
| 明确取消路由 / 结果找回（t8, t22） | **工具路由 / 状态恢复均正常** | task_cancel ref 路由正确、task_result 读回数值正确 |
| 原始 JSON 泄漏 | 未复现，层级判定不适用 | 两会话 44 轮回复扫描无裸信封 |

### ④ 取消悬空独立判断（owner ①）

- **底层取消工具正确**：S5 三次明确取消（ref#2/#5/#10）全部正确路由；S4 turn7 ref#3 同。task_cancel 对已终态任务返回 outcome=terminal 属预期。
- **任务是否仍在执行**：否。所有被取消/被指代目标在取消请求时均已 terminal/completed（轮内即时完成）；取消后 0 次重复执行、0 次派发（S4 turn20 后 0 执行；S5 全程 tasks.json #1–#10 无重复 requestIds 增长）。
- **是否发生后续派发**：未发生。S5 t20 连续交办 #10 因 resource_limited 未受理，t22 取消 #10 返回 terminal/failed，回复如实说明——控制闭环正确。
- **结论**：本批观察到的取消悬空**不是执行层或取消工具失败**，而是 (a) 压缩致上下文丢失后模型无对象可取消且不如实说明（S4 t20，Main）；(b) 指代取消在近空摘要下退化为澄清（S5 t6）；(c) 取消事实被压缩抹掉后虚答「没取消过」（S5 t18）。安全面无失控（无任务仍在跑、无重复派发），**功能面控制意图的「如实回执」失败**。

### ⑤ 最小修复建议（不实施）

1. **近空摘要（首要）**：最小复现＝S5/S4 任意 tokensAfter=15 的回合；根因假设＝W=8192 下 `compactionSettingsFor` 的摘要预算/结构在极小窗口产出空壳摘要（摘要文本本身未落盘，需先加可观测性）；建议位置＝`packages/agent/src/pi-driver.ts:529-560`（compactTranscriptWithPi 设置）或其上游 pi-agent-core 常数；**值得改**（两批两会话一致、且直接产用户级空答），但先以 B 类最小可观测性（落盘摘要产物）定位，不新增宿主语义层。
2. **emergency 零缩减循环**：19 次纯开销模型调用；根因＝force 压缩在 keptMessages 保留下产物不缩减仍反复过阈；建议＝同一回合内产物零缩减时停止再次 emergency（幂等短路）；**值得改**（纯成本，无行为面风险），位置 `pi-driver.ts:701-711`。
3. **取消回执诚实性**：根因在模型行为（Main 面），按 AGENTS.md 纪律不靠提示词补丁、不新增宿主机制；登记为可观测性缺口（取消历史是否需机械可查由 owner 裁定），**不建议本批改产品代码**。

### 证据指针

- `.runtime/r5p3s45/s4/evidence.json`、`.runtime/r5p3s45/s5/evidence.json`（turns / replies / driverEvents / toolCalls / budgetUsed）；`s5/tasks.json`（10 任务终态）。
- 执行器：`scripts/eval/p3/p3s4-session.ts`（211ade3）、`scripts/eval/p3/p3s5-session.ts`（6ad7e8f）。
- 代码依据：`packages/agent/src/pi-driver.ts:657`（headroom）、`:701-711`（transformContext/emergency）、`:663-671`（回合前 INV 压缩）。
