# Pi 原生 Session/压缩替换 · A 度量（2026-11-15）

> worktree：`~/projects/fshine-agent-exp-pi-session`（分支 `exp/pi-native-session-compaction`）。
> 版本口径：只读锁 `@earendil-works/pi-agent-core@0.85.1`（不升级）。
> 角色：**只度量 A**（按 owner 步骤 7）。本文件**不做修复决定、不放宽 D1 判据**，只给四组场景的确定性读数与四项 A 指标，并提供 **A/C 对照表与「我的建议」**（建议明确标注、由 owner 裁定）。
> **零真实模型**：仅假 `Models` / 假 `streamFn`，`baseUrl=http://localhost`，`streamDeferred`/`fetchDeferred` 均 `throw 'n/a'`。
> 度量夹具：`scripts/eval/pi-native/a-metrics.mjs`（本 run 新增，独立于既有 `verify-pi-harness.mjs`）；原始输出：`scripts/eval/pi-native/OUTPUT-a-metrics.txt`。
> 复跑：`TMPDIR=/home/tao/.tmp node scripts/eval/pi-native/a-metrics.mjs`（退出码 0 = 全部有界性断言成立；两次连跑输出逐字相同，确定性）。

## 0. A 是什么（本 run 度量的对象）

**A = 接受 Pi 较弱有界失败**，即**放宽**「从不外发必然超窗请求」这条要求：在**新 Pi 路径**上**移除 fshine 的单处请求前预算检查（D1）**，把压缩/溢出恢复全部交给 Pi 原生 Harness，并接受「必然超窗的请求会被真实发出、随后有界失败」。

因此本夹具与 §九十二 的 `verify-pi-harness.mjs` 的关键区别：`verify-pi-harness.mjs` 度量的是**保留 D1 的「最小 B」**（首请求被 host 拒绝、0 外发）；本夹具度量的是**裸 Pi-Harness（无任何 fshine 检查）**——直接 `lane.prompt`，不设 `preRequestBudgetCheck`。

`a-metrics.mjs:1-33` 自述边界：只度量、不做修复决定；`a-metrics.mjs` 内**无任何 host 侧压缩/裁剪/拒绝**，仅装配公开 `AgentHarness` + `CompactionSettings` + `RetryPolicy`（`a-metrics.mjs:150-158`）。

**假 provider 的窗口执法**：与整个实验一致，假 provider 用 `est = ceil(JSON.stringify(messages).length/4)`（`a-metrics.mjs:88`）在**派发前**判定请求是否超窗；`makeProvider` 在 `overWindow` 时返回**真实 overflow 错误**（`stopReason:'error'` + `prompt is too long: … maximum context length`，`a-metrics.mjs:100-110`）——这正是真实 provider 的行为（区别于 §九十一 旁路对照里「照单全收」的假 provider）。该错误信息命中 Pi `isContextOverflow`（`node_modules/@earendil-works/pi-ai/dist/utils/overflow.js:130-156`），从而可触发 Pi 原生溢出恢复。

## 1. 四组场景（窗口 8192 / 40000 / 128000；本 run 实跑）

| 组 | 场景 | 构造 | 是否发出 | 发出次数（总 / 超窗） | 是否最终有界失败 | retry_scheduled |
|---|---|---|---|---|---|---|
| **G1** | **首请求超窗**（裸 Pi-Harness，无 fshine 检查） | 单条巨型 user 消息（`'z'.repeat(W*6)`，≈1.5·W tokens，无可切分） | **是** | 1 / **1** | **是**（`run_end failed`，`assistant_error`） | **0** |
| **G2** | **工具结果导致的续发超窗** | 首请求 `'go'` 过检；assistant 调 `bigtool` 返回 ≈2·W tokens 结果；续发请求带该结果 | **是** | 2 / **1** | **是**（`run_end failed`，`assistant_error`） | **0** |
| **G3** | **可恢复溢出**（压缩后可行） | 首答即 overflow 错误；上下文可压缩，压缩后请求落入窗口 | **是** | 2 / **0** | 否——**成功完成**（`run_end completed`） | **0** |
| **G4** | **不可恢复溢出** | provider 对**每个**请求恒返 overflow 错误（硬上限/持续故障） | **是** | 2 / **0** | **是**（`run_end failed`，`assistant_error`） | **0** |

> 「是否最终有界失败」= 双向定义：G1/G2/G4「有界失败」（`run_end` 出现、无死循环）；G3「有界成功」（`run_end completed`）。四组**全部收束**（`run_end` 均出现），**无一组无限重试**。

### 逐组原始读数（`OUTPUT-a-metrics.txt`）

| 组 @ 窗口 | sends | over | completeCalls | wastedOverTokens | totalPromptTokens | run_end | compaction_start→end |
|---|---|---|---|---|---|---|---|
| G1 @ 8192 | 1 | 1 | 1 | 12359 | 12359 | failed | threshold→completed |
| G1 @ 40000 | 1 | 1 | 1 | 60071 | 60071 | failed | threshold→completed |
| G1 @ 128000 | 1 | 1 | 1 | 192071 | 192071 | failed | threshold→completed |
| G2 @ 8192 | 2 | 1 | 1 | 16581 | 16602 | failed | threshold→completed |
| G2 @ 40000 | 2 | 1 | 1 | 80197 | 80218 | failed | threshold→completed |
| G2 @ 128000 | 2 | 1 | 1 | 256197 | 256218 | failed | threshold→completed |
| G3 @ 8192 | 2 | 0 | 1 | 0 | 99 | completed | overflow→completed |
| G3 @ 40000 | 2 | 0 | 1 | 0 | 99 | completed | overflow→completed |
| G3 @ 128000 | 2 | 0 | 1 | 0 | 99 | completed | overflow→completed |
| G4 @ 8192 | 2 | 0 | 1 | 0 | 8284 | failed | overflow→completed |
| G4 @ 40000 | 2 | 0 | 1 | 0 | 40092 | failed | overflow→completed |
| G4 @ 128000 | 2 | 0 | 1 | 0 | 128092 | failed | overflow→completed |

- `wastedOverTokens` = 被发出的**超窗**请求的 prompt token 之和（纯浪费）；`completeCalls` = Pi 摘要模型调用次数。
- G1/G2 的 `run_end` 均为 `failed/assistant_error`，且 `retry_scheduled=0`——**在一次超窗外发后 Pi 未进入无界重试**（次数上界见 §3）。
- G1/G2 出现的是 `threshold` 压缩（在 checkpoint 触发，非 `overflow`）：单条巨型消息在 checkpoint 被判定超阈值而压缩；但**当前待发 prompt 无法被该压缩消解**，请求仍超窗外发→ provider 报 overflow → 无可用恢复边界 → 有界失败。（本 run 只报告观察到的动作序列 `threshold→completed` 与最终 `failed`，不对 Pi 内部 `prepareOverflowCompaction` 分支下断言；见 §6 局限。）

## 2. 指标①：实际恢复成功率

**定义**：可恢复场景（③可恢复溢出）中，Pi 成功恢复并完成交办的比例。

- **G3（可恢复溢出）：3/3 = 100%**——8192/40000/128000 三窗口均 `compaction_start reason=overflow` → `compaction_end completed` → `run_end completed`；恢复后请求 `over=0`。
- G1/G2/G4 按场景定义**不属于「可恢复」**（G1/G2 的当前 prompt 不可被压缩消解；G4 为持续故障），故不计入恢复成功率分母。

## 3. 指标②：失败上界

**定义**：不可恢复场景（G1/G2/G4）的最大发出次数 / 是否收束 / `retry_scheduled` 计数。

| 场景 | 最大总发出次数 | 最大超窗发出次数 | 是否收束 | `retry_scheduled` |
|---|---|---|---|---|
| G1（首请求超窗，裸） | **1**（全窗口） | **1** | 是（`run_end failed`） | **0** |
| G2（工具结果续发超窗） | **2**（全窗口；1 过检 + 1 超窗） | **1** | 是（`run_end failed`） | **0** |
| G4（持续不可恢复溢出） | **2**（全窗口） | **0** | 是（`run_end failed`） | **0** |

**上界结论**：每次超窗事故**至多 1 次必然超窗请求被外发**；单次 run **总发出次数 ≤ 2**；**全部收束**；**`retry_scheduled` 恒为 0**，Pi 摘要调用 `completeCalls ≤ 1`（G3/G4），**无无界重试**。即 Pi 的失败是**有界**的。

## 4. 指标③：额外调用成本（因外发必然超窗请求而多花）

| 场景 | 额外 stream 调用 | 额外 prompt token（`wastedOverTokens`） | 额外摘要调用 |
|---|---|---|---|
| G1 @8192 / 40k / 128k | **+1** | 12359 / 60071 / 192071（≈**1.5·W**） | +1（completeCalls=1） |
| G2 @8192 / 40k / 128k | **+1** | 16581 / 80197 / 256197（≈**2·W**） | +1 |
| G3 / G4 | 0 超窗外发 | 0 | 恢复/失败各 +1 摘要调用 |

**结论**：接受 A 后，**每次超窗事故的额外成本 = 1 次必然超窗请求（≈1.5·W–2·W prompt tokens）+ 1 次 Pi 摘要调用**。窗口越大，单次浪费的 token 绝对量越大（与窗口线性）。可恢复场景（G3）无额外超窗成本。

## 5. 指标④：业务副作用

| 维度 | 观察 |
|---|---|
| **回合是否完成** | G1/G2/G4 = **否**（`run_end failed`）；G3 = **是**（`completed`）。超窗回合**不完成**且以失败结束。 |
| **回复是否降级 / 空答** | **否**——失败路径返回**显式错误**（`run_end failed/assistant_error`），**未观察到静默降级或空答复**（未把失败伪装成成功交付）。 |
| **是否重复执行任务** | **否**——G2 中 `toolExecutions=1`（全窗口），工具在超窗事故前后**未重复执行**。 |
| **是否越权** | **本夹具未触及授权路径**——只装配一个仓内假工具，无 host 权限/实体门/执行层授权面被激活。故「越权」在 A 路径上**本 run 未观测到，也未构造测量**（不适用/未测，非「已证明无」）。 |

## 6. 局限（必须随读数一起引用）

- **窗口**：仅报 **8192 / 40000 / 128000**。其他窗口未测。
- **零真实模型**：全过程假 `Models` + 假 `streamFn`；**真实模型、真实 provider 未跑**，Pi 对真实 provider 错误串的 `isContextOverflow` 分类、真实 tokenizer 计数、真实成本均**未验证**。
- **不外推**：以上数字是**确定性夹具读数**，**不得外推**为真实模型行为、真实成本或真实 provider 的错误分类率。
- **未做修复决定、未放宽 D1 判据**：本文件不改变 `docs/decision-log.md` 的任何判据；§九十二 `bHolds=false`（工具结果续发维度不成立）与 §九十一（D1 不可删）的结论**未被本 run 触碰**。
- **内部机制不越界**：本 run 只报告公开面可观察的动作序列与事件（`run_end` / `compaction_*` / `retry_scheduled` / provider 调用日志），**不复制 Pi 源码、不依赖未导出实现、不对 Pi 内部分支下断言**（G1 的 `threshold→completed→failed` 序列为观察所得，未断言其内部归因）。
- **夹具差异**：本夹具（裸 Harness、provider 执法窗口）与 §九十二 `verify-pi-harness.mjs`（保留 D1、旁路对照用「照单全收」假 provider）**刻意不同**；两者读数不可互相替代。

## 7. A / C 对照表（供 owner 裁定；本文件不替 owner 裁）

- **A = 接受 Pi 较弱有界失败**：移除 fshine 单处请求前检查（D1），接受「必然超窗请求会被真实外发、随后有界失败」。
- **C = 判 Pi 原生在安全责任上不满足、停实验分支保住现状**：保留 D1 host 请求前检查，从不外发必然超窗请求。

| 维度 | A（接受较弱有界失败） | C（停实验分支、保现状） |
|---|---|---|
| **安全姿态** | **放宽**「从不外发必然超窗请求」：每次事故允许 **1 次**必然超窗请求被发出 | **不放松**：发送前在 host 侧有界拒绝，**0** 外发必然超窗请求 |
| **恢复行为** | Pi 原生阈值压缩 + 溢出恢复；**可压缩场景可恢复完成（G3 3/3）** | 现状 fshine 压缩编排 + Pi；恢复路径不变 |
| **失败上界** | **有界**：总发出 ≤2、超窗外发 ≤1、`retry_scheduled=0`、必收束 | 更严：发送前拒绝（0 外发） |
| **额外成本** | 每次事故 **+1 超窗请求（≈1.5·W–2·W prompt tokens）+1 摘要调用** | **0** 超窗浪费；一次拒绝（无 provider 调用） |
| **删除可行性** | D1 host 请求前检查臂**可删**，删除面自包含于 `packages/agent/src/pi-driver.ts`（§九十二 §7 清单） | D1 **不可删**；替换 blocked（§九十一/§九十二） |
| **业务副作用** | 超窗回合**失败**（非静默降级/空答）；**任务不重复执行**；可恢复回合正常完成 | 无超窗外发；拒绝即失败 |

## 8. 我的建议（**建议**，由 owner 裁定）

> 以下**仅为建议**，明确标注为建议；本 run **不做修复决定、不放宽 D1 判据**，裁定权归 owner。

**度量支持的事实**：在裸 Pi 路径上，Pi 的失败**确实有界**——每次超窗事故至多 1 次超窗外发、单 run 总发出 ≤2、`retry_scheduled=0`、必收束；**无静默降级、无空答、无任务重复执行**；接受 A 的**代价是确定且可量化的**（每次事故 1 次 ≈1.5·W–2·W token 的浪费请求 + 1 次摘要调用）。

**我的建议（择一，供裁）**：
- 若 owner 的风险容忍度接受「每次超窗事故浪费 1 次必然超窗请求、但失败有界且不重复执行任务」——则 **A 在本夹具口径下是可行选项**；A 把「必然超窗请求永不外发」这条安全要求，换成「至多 1 次外发 + 有界失败」。
- 若「必然超窗请求一发都不可外发」被列为**不可放宽的安全责任**（§九十一/§九十二 的 D1 立场）——则 **C 保现状**仍是唯一满足该责任者，A 的安全姿态与之**直接冲突**。

**决定性的、只能由 owner 回答的问题**：**「允许 1 次必然超窗请求被外发」是否可接受为安全责任？** 这是风险取向裁定，超出本度量夹具可达的范围——本文件不做此裁定。

（附：度量还提示一处**必须与 A 绑定处理**的既有事实——§九十二 已证**工具结果续发维度**在公开面无发送前防线；A 之下该缺口同样存在，G2 已在裸路径上复现「续发超窗被外发」且**无公开 seam 可中止**。此点不改变 E 组读数，仅作 owner 裁定 A 时的关联事实。）

## 9. 指针

- 度量夹具：`scripts/eval/pi-native/a-metrics.mjs`；原始输出：`scripts/eval/pi-native/OUTPUT-a-metrics.txt`。
- 关联夹具/结论：`scripts/eval/pi-native/pi-harness-driver.mjs`、`verify-pi-harness.mjs`（最小 B）、`tripwire-b.mjs`、`tripwire-d1*.mjs`；`docs/decision-log.md` §九十一、§九十二；`docs/product/exp-pi-native-session-phase1.md`。
- 公开面（0.85.1）：`node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts:485-604`、`dist/harness/runtime/drive/response.js:109-160`、`node_modules/@earendil-works/pi-ai/dist/utils/overflow.js:130-156`。
