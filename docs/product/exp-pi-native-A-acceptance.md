# Pi 原生 Session/压缩替换 · A 验收口径（已冻结，真实模型前，2026-11-15）

> **状态：已冻结（真实模型前）。** 本文件冻结「A 口径」的验收面与适用范围限制，**冻结时点 = 真实模型运行之前**；真实 Pi 生命周期跑完后须按 §2 复核并（如必要）重新冻结。
> worktree：`~/projects/fshine-agent-exp-pi-session`（分支 `exp/pi-native-session-compaction`）。
> 版本口径：只读锁 **`@earendil-works/pi-agent-core@0.85.1`（不升级）**。
> **零真实模型**：本文件全部读数为**假模型/夹具**确定性输出，仅假 `Models` / 假 `streamFn`，`baseUrl=http://localhost`，`streamDeferred`/`fetchDeferred` 均 `throw 'n/a'`。**不得外推**为真实模型行为。
> 角色：A 验收口径冻结员（本 run 只写本文件 + 提交；不改产品码、不改 `docs/decision-log.md`）。
> 依据：owner 裁决 A（2026-11-15，已生效）＋ `docs/decision-log.md` §八十 / §八十一 / §八十二 ＋ `docs/product/exp-pi-native-A-metrics.md`。

---

## 0. 冻结声明与 owner 裁决

- **owner 裁决 A（2026-11-15，已生效）**：**接受 Pi「请求 → Overflow Recovery → 有界恢复/失败」**这条生命周期；**撤销**「新架构必须不发送任何必然超窗请求」的约束。
- **旧 D1 绊线保留 FAIL 记录、不得事后修改**（见 §4）。
- 本文件为 **A 口径的验收面**，在**真实模型前**冻结。冻结内容为：§1 验收口径、§2 适用范围限制、§3 七项可靠性判据（验收面）、§4 D1 FAIL 记录保留。**冻结后不得反向放宽**；如需调整走新版本、历史不覆盖。

---

## 1. A 验收口径（已冻结）

**A ＝ 接受「请求 → Overflow Recovery → 有界恢复/失败」**：把压缩/溢出恢复交给 Pi 原生 Harness，接受「必然超窗的请求会被真实外发、随后**有界**恢复或**有界**失败」。

A 之下，**每次超窗事件须同时满足**（这就是本口径的合格线）：

| 序号 | 判据 | 定义 |
|---|---|---|
| **A-1** | **每事件至多 1 次 over-window 发射** | 单次超窗事故中，被外发的**必然超窗**请求次数 **≤ 1** |
| **A-2** | **有界收敛** | 单次 run **总发出次数有上界**（本口径下 ≤ 2）、**必定收束**（出现 `run_end`，`completed` 或有界 `failed`），**无挂死、无无限循环** |
| **A-3** | **`retry_scheduled = 0`** | Pi 的重试调度计数为 **0**；不因超窗进入重试 |

> A-1/A-2/A-3 是**三件必须同时成立**的事，缺一不判合格。

### 1.1 本口径下的原始读数（**本会话实跑**）

复跑命令（**本会话实跑**，退出码 `0`）：

```
cd ~/projects/fshine-agent-exp-pi-session
TMPDIR=/home/tao/.tmp node scripts/eval/pi-native/a-metrics.mjs   # exit 0，failures=0，33 [PASS] / 0 [FAIL]
```

四组场景 × 三窗口（8192 / 40000 / 128000）读数（与本会话实跑输出、与归档 `scripts/eval/pi-native/OUTPUT-a-metrics.txt` 一致）：

| 组 | 场景 | 发出（总 / 超窗） | 收敛 | `retry_scheduled` |
|---|---|---|---|---|
| **G1** | 首请求超窗（裸 Harness，无 fshine 检查） | 1 / **1** | `run_end failed`（`assistant_error`） | **0** |
| **G2** | 工具结果续发超窗 | 2 / **1** | `run_end failed`（`assistant_error`） | **0** |
| **G3** | 可恢复溢出（压缩后可行） | 2 / **0** | `run_end completed`（**成功**） | **0** |
| **G4** | 不可恢复溢出（持续故障） | 2 / **0** | `run_end failed`（`assistant_error`） | **0** |

**对上口径**：G1 每事件超窗外发 = 1（**A-1 成立**）；全部四组**收束**、总发出 ≤ 2（**A-2 成立**）；全部四组 `retry_scheduled = 0`、摘要调用 `completeCalls ≤ 1`（**A-3 成立**）。

> 本会话实跑关键行（逐字）：`G1@8192 ... sends=1 over=1 ... retry_scheduled=0 [...]`、`[PASS] W=8192: bare path DID emit an over-window request (no fshine check)  -> over=1`、`[PASS] W=8192: bounded (no unbounded retry; retry_scheduled=0)`、`[PASS] W=8192: run terminated (run_end present)`、`==== failures=0 ====`。

---

## 2. 适用范围限制（硬，必须随 §1 一起引用）

> **本节是 owner 明示的缺口，冻结时必须写清，不得省略、不得弱化。**

1. **`≤ 1 次/事件` 仅为当前假模型场景的观测值，不是所有真实业务回合的普适上界。** 该数字来自 `a-metrics.mjs` 的四组夹具 × 8192/40000/128000 三窗口的确定性读数，**只在「假 provider 派发前按窗口执法 + 假 tokenizer（`ceil(串长/4)`）」这一夹具口径下成立**。
2. **须按真实 Pi 生命周期复核、冻结适用范围。** 真实模型下，下列因素**均未验证**，可能改变「每事件至多 1 次外发」这一上界：
   - 真实 provider 错误串的 `isContextOverflow` 分类率（假 provider 用真实 overflow 错误串触发，真实 provider 未必同形）；
   - 真实 tokenizer 计数（与 `串长/4` 估算的偏差，可能使「必然超窗」判成「未超窗」或反之）；
   - 真实业务回合内的**多次工具调用 / 续发 / steering** 交错形态（本夹具仅 G2 覆盖了单次续发）；
   - 真实 Pi 版本/配置下的压缩触发与溢出恢复分支（本口径**不对 Pi 内部分支下断言**）。
3. **因此：本文件冻结的是「A 口径的判定形状」（接受请求→溢出恢复→有界恢复/失败；有界收敛；`retry_scheduled=0`），而「`≤1 次/事件` 这一具体上界」的适用范围尚未冻结——待真实 Pi 生命周期复核后再冻结/收窄/修订。**

---

## 3. 七项可靠性判据（A 验收面）

以下七项为 **A 口径的验收面**（全部逐项验证，A 口径）。每项标注**当前证据状态**：`已证（假模型夹具）` / `部分覆盖` / `本夹具未测（留待 T1–T12 / 真实模型）`。**不得把「未测」读成「已证无」**。

| # | 判据 | 当前证据 | 状态 |
|---|---|---|---|
| **①** | **溢出恢复/失败有界** | `a-metrics.mjs` G1–G4：全部收束（`run_end` 均出现），总发出 ≤ 2，超窗外发 ≤ 1 | **已证（假模型夹具）** |
| **②** | **无无限重试、无零收益摘要循环** | `a-metrics.mjs`：全组 `retry_scheduled=0`，摘要调用 `completeCalls ≤ 1`（G3/G4）；§八十一 摘要失败场景 `completeSimple calls=3`（≤ maxAttempts，有界） | **部分覆盖**（「无零收益摘要循环」未单独构造专测） |
| **③** | **无未经授权的工具执行** | `a-metrics.mjs` **未触及授权路径**（仅仓内假工具，无 host 权限/实体门/执行层授权面被激活） | **本夹具未测**（留待 T 系列 + 真实装配） |
| **④** | **不因模型重试重复执行业务操作** | `a-metrics.mjs` G2：`toolExecutions=1`（全窗口）——超窗事故前后工具未重复执行 | **已证（假模型夹具）** |
| **⑤** | **无虚假完成/取消回执** | `a-metrics.mjs`：失败路径返回**显式错误**（`run_end failed/assistant_error`），**未观察到静默降级/空答**；但**取消回执**未构造 | **部分覆盖**（取消语义未测） |
| **⑥** | **无跨 principal、跨 Session 信息泄漏** | `a-metrics.mjs` 为单 session 夹具，**未构造多 principal / 多 session** | **本夹具未测**（留待 T9/T10） |
| **⑦** | **压缩不破坏工具调用与结果对应** | `a-metrics.mjs` G2 中工具结果参与续发、`toolExecutions=1`，未见配对破坏；但**未对 tool_call/result 配对做显式断言** | **部分覆盖**（留待 T4 显式断言） |

> 验收纪律：⑦（工具调用与结果配对）与 ③⑤⑥ 属**安全/确定性不变量**，须由**确定性夹具/测试**给出证据，**不得用黑盒模型评估冒充**。

---

## 4. D1 FAIL 记录保留（不改）

> **owner 裁决 A 撤销的是「新架构必须不发送任何必然超窗请求」这条约束；§八十 的 D1 绊线 FAIL 记录属于历史证据，保留、不得事后修改。**

- **§八十（`docs/decision-log.md:2452-2505`）**：D1 反向绊线独立复核，三夹具（`tripwire-d1.mjs` / `tripwire-d1-recheck.mjs` / `tripwire-d1-tao.mjs`）一致证明「一个已知必然超窗的请求被实际发出」且 **Pi 公开面无「发送前尺寸预判/拒绝」seam**。
- **原始 FAIL 行保留（逐字，`docs/decision-log.md:2470`）**：`tripwire-d1.mjs` 输出 `assistant stream calls = 1  (over-window = 1)`、`run_end = [{"status":"failed","error":"assistant_error"}]`、`retry_scheduled count = 0`、`[FAIL] (a) knowably over-window requests sent == 0  -> overWindowCalls=1`，**退出码 `1`**。
- **处置**：该 FAIL **不被删除、不被改写、不被「通过」**。A 口径下它被**登记为已接受的风险姿态**（接受 1 次必然超窗外发 + 有界失败），而非被抹除；§八十 §5 原结论「D1 不可删/T5 Pi 不提供」作为**历史判据保留**，与 A 的取舍并存、互不篡改。
- **§八十一 `bHolds=false`（`docs/decision-log.md:2578-2580`）**：工具结果续发维度在公开面无发送前防线——此事实**未被 A 口径触及**，保留；A 之下该缺口同样存在（G2 已在裸路径复现）。

---

## 5. 证据来源与指针

- 判定形状依据：owner 裁决 A（2026-11-15，已生效）。
- 读数来源（**本会话实跑**）：`scripts/eval/pi-native/a-metrics.mjs`（退出码 `0`，`failures=0`，33 PASS）；归档输出 `scripts/eval/pi-native/OUTPUT-a-metrics.txt`。
- 完整度量：`docs/product/exp-pi-native-A-metrics.md`（四组场景 + 四项 A 指标 + A/C 对照 + 局限）。
- 台账：`docs/decision-log.md` §八十（D1 反向绊线三段）、§八十一（最小 B，`bHolds=false`）、§八十二（A 度量与 A/C 对照）。
- 公开面（0.85.1）：`node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts:485-604`（11 hook，无发送尺寸门）、`node_modules/@earendil-works/pi-ai/dist/utils/overflow.js:130-156`（`isContextOverflow`）。

---

## 6. 局限与未验证声明（必须随本口径一起引用）

- **零真实模型**：本文件全部读数来自假 `Models` + 假 `streamFn`；**真实模型、真实 provider 未跑**。
- **窗口**：仅报 **8192 / 40000 / 128000**；其他窗口未测。
- **不外推**：读数**不得外推**为真实模型行为、真实成本或真实 provider 的错误分类率。
- **适用范围未冻结**（§2）：`≤1 次/事件` 的普适性待真实 Pi 生命周期复核；真实模型前做不到该上界的定论。
- **内部机制不越界**：只报告公开面可观察的动作序列与事件（`run_end` / `compaction_*` / `retry_scheduled` / provider 调用日志），**不复制 Pi 源码、不对 Pi 内部分支下断言**。
- **本节未改产品码**：`packages/**`、`apps/**` 未动；未升级 Pi；`.runtime` 未 `git add`；未改 `docs/decision-log.md`。

---

**状态：已冻结（真实模型前）。** 待真实 Pi 生命周期复核后，按 §2 复核并冻结「`≤1 次/事件`」的适用范围。

---

## 7. 实施期裁定补充（Integration，2026-11-15，owner 裁决）

> 本补充由 owner 裁定授权追加；§1–§6 冻结内容不变。

- **fshine 仅提供 Pi 要求的 `CompactionSettings`（按窗口派生）**：属 **Pi API 契约**，**不构成第二套压缩/阈值机制**。
- 依据：Pi 0.85.1 的 `shouldCompact(tokens, W, settings)` 要求调用方提供**绝对** `CompactionSettings`（仅 `enabled/reserveTokens/keepRecentTokens` 三个绝对字段，**无窗口相对字段、无缩放助手**，见 `@earendil-works/pi-agent-core` `harness/compaction/compaction.d.ts:31-40`）。Pi 缺省按 128k 设计（reserve=16384、keepRecent=20000），在 `W=8192` 下 reserve 超过窗口本身——**不缩放则 Pi 自身行为已失效**（本会话黑盒实测，零真实模型：短回合被压、`compaction_end=["completed","completed"]`）。
- 边界：该派生**只由 `contextWindow` 推导 `reserveTokens`/`keepRecentTokens`**（窗口 ≥ Pi 缺省和 → 用 Pi 缺省；否则按比例缩放），**纯配置、无副作用**；**不含任何 fshine 压缩决策/安全闸 math**（无 INV 下界臂、无 Δ、无 emergency 线、无 `shouldCompact` 复刻、无 split/summarize/trim/degrade）。触发/执行/摘要/尾段/溢出恢复**全部由 Pi 决定与执行**（`AgentHarness`）。
- 生产实现：`packages/agent/src/pi-driver.ts` 的 `piCompactionSettings`；反向绊线 `packages/agent/pi-native-tripwire.test.ts`（守卫「不得回潮」的自研压缩符号/事件）。
