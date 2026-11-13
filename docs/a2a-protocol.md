# 宿主 ↔ 执行层 对接协议（历史别名：A2A 私有协议）

> **正名（2026-11-13 裁定）**：本协议的本体是**编排侧（宿主）与执行层之间的对接契约**（能力清单/发现、委派块、许可与计划、执行与回报、提案与写链、信封与退出码）；「A2A（私有）」只是历史别名，**不得读成 agent 之间的互操作协议**（Agent2Agent）。文件路径与标识符（`a2a-protocol` / `A2A_PROTOCOL_VERSION` 等）保留历史名，随「受控执行入口」项目顺路改；协议语义与版本值（1.0）不因正名变动。裁定全文见 `docs/decision-log.md` §十。

状态：**已落地（W5 尾程）**。本协议定义 fshine（宿主）与执行层 agent 之间的私有薄协议：宿主定约与执法，执行层声明与实现，worker 上下文是"协议义务 + 任务实例"的投影。类型定义在 `packages/contracts/src/a2a-protocol.ts`（词汇的唯一权威位置），本文是其叙述。本协议约定目标行为，不声称系统已全部按此实现。**本版新增的两节——「标识词汇：scopeId / callId」与「Pi Durable 约束」——是缺口登记（未落地 / 未采纳），不属于已落地的协议语义；读到它们时按各节状态行理解，不要当既有实现引用。**

**术语层级**：`fshine` 指整体（Pi Agent + Task Runtime + Execution Gateway + Channel Adapter）；本协议里的**宿主**指其中的**胶水层**（Task Runtime + Execution Gateway + Channel Adapter），不含 Pi 基座；**执行层**指当前接入实例及其后续同类实例。三层分工见 `docs/v0-architecture.md` §1.1；定位（2026-11-12 第三版）的完整出处见 `docs/decision-log.md` §0.1，`AGENTS.md` 定位节为面向改动的摘要 + 指针。删除与保留决定的台账见 `docs/decision-log.md`。

---

## 参与方职责

| 参与方 | 持有 | 不持有 |
|---|---|---|
| **宿主（fshine 胶水层）** | 认证、预算档位、确认链状态、审计、对声明的机械复核、结果必达 | 业务实体授权与读写语义 |
| **执行层** | 能力清单（operation、plan 标记、effects、est_seconds、label、serve 矩阵）、实体授权（自设计 RBAC）、操作实现、自己的门 | 协议语义定义权 |
| **契约工件**（contracts + 本文） | 协议词汇、状态集、各方义务 | 网关名、部署实例 |
| **worker** | 按投影执行（协议义务 + 任务实例） | — |

要点：

- 宿主执法的对象是**声明**：执行层在能力清单里声明每个 operation 的计划要求、副作用、估时与许可矩阵，宿主机械复核，不解释业务含义。
- 执行层拥有"自己的门"——业务校验与硬拒绝留在执行层，宿主只识别通用的执行层硬拒绝结果（见失败分类 `HARD_REJECTED`），不复刻其规则。
- 契约工件是协议词汇的唯一来源；任何网关名、脚本路径、业务字段进入契约工件即为违例。

## 六阶段生命周期

### ① 委派

宿主通过 user message 中的**委派块**（`DelegationBlock`）下发任务，载荷 = request + 实体 + 工作区 + 输入清单 + 协议版本（`A2A_PROTOCOL_VERSION`）。worker 的系统提示词保持**纯静态**，并含规则"只执行委派块声明的范围"——逐任务的边界只随载荷走，不进提示词。

### ② 发现

执行层能力清单**预载**进 worker 上下文；worker 按需查询每个 operation 的许可标记（是否需计划、副作用、估时）。发现不走猜测：清单没有的能力视为不存在。

### ③ 许可

仅清单标记为需要计划的 operation 需要向宿主申请许可。宿主裁决返回 `PlanAdjudicationState`，状态机与 worker 的回合义务：

| 状态 | worker 义务 |
|---|---|
| `PLAN_ACTIVE` | 按单执行 |
| `PLAN_DECLINED` | 按原因修正后重提 |
| `PLAN_NEEDS_USER_CONFIRM` | 立即结束回合，不轮询 |
| `PLAN_PAUSED` | 结束回合 |
| `PLAN_STOP` | 停止，报告原因 |

范围变化（执行中发现要做的操作超出已获准范围）时，worker 重提**完整** calls，不做增量补丁。

### ④ 确认

需要真实用户确认的计划，确认状态由**宿主持有**（执行层不感知确认链）。用户裁决后，宿主开新回合让 worker 续跑；worker 不持有、也不猜测确认结果。

### ⑤ 执行

执行层的门对每一次实际调用逐次对单；宿主记录审计。进度帧由宿主从**放行事件**派生，worker 不单独发明进度口径——用户看到的进度与实际获准的执行一一对应。

### ⑥ 报告

worker 报告结果/产物/证据，或按五类失败分类上报（见下表）。宿主保证**终稿必达**：失败也是终稿，用户必须拿到可行动的反馈，不允许静默结束。

**worker 报告义务（被阻塞时）**：
- 终稿第一句陈述"未完成"与原因；管线自检、样本运行等验证性成功不得作为报告开头
- 样本/冒烟数据落盘时，文件名加「样本-」前缀或放入 `smoke/` 目录，**不得使用真实交付物命名**（run5 实测：样本数据曾以真实交付物命名留在工作区，构成污染面）

**共享空间的 bash 输出快照**：bash 输出超限（2000 行/50KB）时，全量输出由宿主搬入本轮工作区 `.outputs/`，截断结果中的路径同步改写——worker 按路径切片读取，数据不进模型上下文搬运。

## 失败分类

五类互斥。判定方与双方义务的权威口径在 `packages/contracts/src/a2a-protocol.ts` 的 `FAILURE_CLASS_POLICIES`，与下表同源。

| 分类 | 判定方 | worker 义务 | 宿主送达义务 |
|---|---|---|---|
| `NEEDS_INPUT` | worker | 报具体缺口（缺哪项输入、为什么必须由用户提供），不臆测、不代用户编造 | 原样送达用户，不改写、不折损 |
| `CAPABILITY_UNAVAILABLE` | worker / 执行层门 | 报清能力边界（做什么不在许可范围），不给绕行方案、不越界试探 | 送达能力边界 |
| `PLATFORM_ERROR` | 执行层 | 如实转告执行层返回的错误，不换口径反复试探、不掩盖原因 | 送达错误说明 + 重试提示 |
| `RESOURCE_EXHAUSTED` | 宿主（预算/时限耗尽） | 先交出已完成部分：产物引用 + 下一步的一句话，保证续跑接得上 | 送达已完成部分与下一步 + 续跑入口 |
| `HARD_REJECTED` | 执行层（硬拒绝） | 立即停止执行，不重试、不变体重提 | 送达拒绝结果 |

## 声明原则

计划要求是 **operation 的属性**（能力清单逐项声明），不是任务的属性；宿主不分类任务。宿主面对的永远是"这个 operation 需不需要计划/确认"的声明事实，而不是"这是个什么任务"的业务判断——换一个执行层，宿主的执法逻辑不变。

## 标识词汇：scopeId / callId（缺口登记，未落地）

状态：**词汇缺口，未落地**。协议契约 `packages/contracts/src/a2a-protocol.ts` 当前不含这两个字段；本节是最小定义与接入约束，不是已实现语义。缺口来源：issue #50 用例 1 的约束写明「范围声明复用现有计划门（执行集合对已确认计划），不新建 scope 机制；a2a 的 scopeId 词汇缺口另案登记」。`callId` 在**评测/探针审计行**已有事实使用（崩溃窗口按 `callId` 去重，见 `docs/debt-ledger.md` 相关条目），但协议未定义其生成方、生命周期与复用规则。

| 词 | 最小定义 | 生成方 / 生命周期 | 用途 |
|---|---|---|---|
| `scopeId` | 一次委派所允许的执行范围的**不透明标识** | 宿主在委派时生成，随委派块下行；范围变化重提完整 calls 时换新 ID | 让"这次调用属于哪个已获准范围"可机械对账。不新建 scope 机制，只给现有计划门一个锚点 |
| `callId` | 单次调用（工具/业务操作）的**稳定标识** | 宿主在受理调用时生成，随调用进入审计与结果回传；同一逻辑调用的重试/续跑复用同一 ID | 崩溃恢复时区分"已执行 / 未执行 / 执行一半"；审计 start/result 行合并；不替代任务级 `dispatchKey` |

**与既有标识的层级（不得混用）**：

- `TaskRunRecord.dispatchKey` 是**源派发事件**的宿主幂等键（`packages/contracts/src/store.ts` 的 `TaskRunRecord.dispatchKey`；注释原话 "Host-generated idempotency key for the source dispatch event/tool call"），任务级。
- `scopeId` 是**已获准执行范围**的锚点，计划级。
- `callId` 是**单次调用**的锚点，调用级。exactly-once 三要素（业务操作 ID / 网关幂等键 / 回读对账）里，**任务级**的「业务操作 ID」已由 `dispatchKey` 承担（`docs/decision-log.md` §3.6）；`callId` 只有将来需要**调用级** exactly-once 时，才是同一位置在调用粒度上的候选载体——它与 `dispatchKey` 不同层，不替代、不重命名 `dispatchKey`，也不等于网关幂等键或回读对账。本节整体未落地，不得当既有语义引用。
- provider 的 `toolCallId` 只是传输层关联，不进入协议词汇；worker 不得自造 `callId` 冒充宿主受理。

**未落地部分（缺口登记，未排期）**：契约字段、委派块投影、审计行落账、重试/续跑复用规则均未实现（本节只做缺口登记，不构成实施承诺）；在契约加入前，任何文档或代码不得把这两个词当既有语义引用。落地时至少需要：① 同一 `callId` 的重复提交返回原结果而非再执行；② `scopeId` 不匹配的 calls 在受理处拒绝；③ 崩溃后未返回结果的 `callId` 标记为 `interrupted`，不盲目重跑（与下节 replay 判据同源）。

## Pi Durable 约束（候选底座，未采纳）

状态：**候选底座，未采纳；2026-11-11 裁定现在不采纳、也不做 PoC**。本节记录采纳前必须满足的约束与引入判据，不是已实现设计，也不改变上文协议。决定台账见 `docs/decision-log.md` §0.6。

**证据分档**：`pi-durable` **本仓未安装**（`node_modules/@earendil-works/` 实测只有 `chord` / `pi-agent-core` / `pi-ai` / `pi-coding-agent` / `pi-telemetry` 五项）。涉及该包内部 API 与上游文档行为的条目**未验（包未安装）**——下面标注的条目来自 registry 元数据与上游 issue 文本的阅读，本仓没有运行验证；「本仓已复核」只覆盖版本号、安装清单与本仓现状。

### 候选事实

- registry 上有 `@earendil-works/pi-durable` **1.5.2**（`npm view @earendil-works/pi-durable version` 实测），但本仓**没装**。当前安装的基座是 `@earendil-works/pi-agent-core` **0.85.1** + `pi-coding-agent` + `pi-ai` + `chord` + `pi-telemetry`（`package.json` 声明前三项；`node_modules/@earendil-works/` 实测含五项，均 0.85.1）。**以上本仓已复核。**
- 已知 issue `earendil-works/pi#10386`（OPEN）：Durable 与 `pi-coding-agent` 扩展系统不完全兼容——`beforeCompact` 只支持 decline/summary，`afterResponse` / `afterTools` 无对应，工具注册缺 exposure tier / `prepareLoadout`，`AgentSession` 的同步 `SessionManager` 与 Durable 的异步提交 transcript 不同源。本仓正用 `pi-coding-agent`，采用即正撞该缺口。**未验（包未安装）：读的是上游 issue 文本，本仓未复现。**
- **两个同时活动的 Harness 共用一个数据库不受支持**（2026-11-11 裁定；官方模型是一个驱动进程写、另一个进程以 `readOnly: true` 观察）。多实例部署的所有权与调度要自己设计。**（裁定在案；官方模型描述未验——包未安装，来自上游文档阅读。）**
- 它**不解决外部业务操作的 exactly-once**：工具意图在 `execute()` 前提交，但"工具写入成功 → 回执未持久化 → 崩溃"的窗口无法判定是否生效；上游文档称 replay-safe 的外部副作用仍需自己的幂等。**未验（包未安装）。** 这一层只能 fshine 做（业务操作 ID / 网关幂等键 / 回读对账三要素；任务级第一样已由 `dispatchKey` 承担，调用级载体见上节、未落地）。网关返回成功只代表任务被接受，不代表业务已处理完。

### 唯一值得抄的判据

按工具声明 **replay 安全性**：声明 `replay: "safe"` 的调用崩后可重跑；未声明或不安全者返回 `interrupted`，不盲目再执行。fshine 的调用契约应采用同一判据（与上节 `callId` 的崩溃语义同源），而不是把"重跑整任务"当默认恢复策略。**（判据适用性本仓未验；`callId` / `interrupted` 均属上节未落地的缺口登记。）**

### 与 fshine 现状的距离

- **已有**：`TaskRunRecord` 的 `dispatchKey` 幂等键、`state` 状态机、`planId` / `stepIndex` / `totalSteps` / `lastProgress` 进度、`deadline`、`originMessage` 锚点（`packages/contracts/src/store.ts` 的 `TaskRunRecord`）；confirm 档返回 pending 而非阻塞进程（`plan-runtime.ts` 的 `evaluateAndActivatePlan` 在 confirm 裁决下返回 `{ status: 'confirm', pending }`）。
- **缺口**：恢复粒度是**任务级**，不是**工具执行级**——崩溃后无法判定某个外部调用是否已生效。Pi Durable 有工具级 replay/checkpoint（未验），但对上述外部副作用仍要求业务幂等，所以它也不自动堵这条缝。
- **引入判据（当前不可执行）**：原定判据「T10 的崩溃恢复用例」**目前不存在**。PR #55（draft，未合）的正文与 diff 只有结果对账 / 停滞检测 / 冻结续跑 / 挂死留痕，`gh pr diff 55 | grep -in "崩溃\|crash\|interrupted"` 零命中；main 的 `tests/e2e` 同样零命中（`git grep -in "崩溃\|crash" origin/main -- tests/e2e` 计数 0）。因此今天无法用「任务级恢复覆盖不了实测崩溃形态」来评估引入：先补一个以真实崩溃窗口为输入的用例（含操作级「已执行 / 未执行 / 执行一半」的判定），再评估引入；在判据建立前不引入、不做 PoC。

## 文件交换（缺口登记，未落地）

本协议今天只定义了「操作与控制」的语义，**没有定义文件/产物的交换语义**——文件在宿主与执行层之间仍以**共享文件系统路径**为传输。这是对接面里最深的一处上下文耦合：任何「远端执行层」都会在这一点断裂。**本轮不实现网络模式**，只登记缺口并把耦合关进接缝（见 `docs/decision-log.md` §十）。

**今天的载体（按方向；生产面与测试桥分开）**：

- **入站附件**：渠道落盘到 `host.attachmentDir`（须在平台根下）→ 宿主把路径注入请求文本（`withAttachmentPaths`）→ worker 直接读（生产面）。
- **输入冻结**：`freeze-task-inputs.ts` 冻结的是**路径集合**；排队任务不重读可变池（生产面）。
- **出站产物**：worker 在平台根产出文件 → 宿主收集为 `artifactRefs` → 渠道发出（生产面）；重发走宿主产物库的 **ref + sha256 + 归属/存在/有效期校验**——已是句柄化骨架，不依赖执行层。
- **载荷通道**：计划提交（`plan --file`）、提案载荷（`prepare <operation> <payloadPath>`）、结构化调用临时文件（`scratchDir/structured_call_<id>.json`）——全部经文件系统（生产面；但 `plan evaluate` 已支持 `--stdin/--json`，文件只是 CLI 绑定）。
- **写边界**：`scratchDir` 路径检查 + `MAX_WRITE_BYTES`（生产面执法）。
- **审计/状态与启动自检**：`audit.jsonl` / `EXECUTION_*_STATE` 读取以**测试桥**为主（生产证据在宿主审计与信封）；平台 `lint-operations.js` 启动自检是「判据归平台、宿主只负责不过就不起」（生产面）。

**目标语义（未落地；只为未来传输形态定契约，不作为本轮的实现要求）**：

1. 文件以**内容寻址句柄**交换：`{name, size, sha256, mime, handle}`；附件与输入冻结存**句柄清单**，不存路径；
2. 产出在 RESULT 信封里带**产物描述符**，宿主落库后由渠道发出——远端不需要「本地路径可收集」；
3. plan / payload / 结构化调用一律走**请求体**（`--json` / `--stdin` 是雏形），临时文件降为 CLI 绑定细节；
4. scratch / 写帽从「路径检查」改为**载荷体量上限 + 上传配额**的协议条款；
5. 自检与证据以**调用/查询**返回（健康检查、审计读取接口），不依赖读对方磁盘。

**本轮边界**：不实现网络模式、不改上述生产载体；只做两件事——(a) 把 `operation list` / 网关 spawn 的耦合收进单一 `CapabilitySource` / `Transport` 接缝（「关进笼子」），(b) 本节登记缺口。判据仍是一条：**换传输只改接缝一处**。

## 迁移期边界

网关名与 plan 命令解析按仓库 AGENTS.md 属**迁移期适配**，圈定在执行层适配边界（`packages/agent/src/platform-contract.ts`，泄漏 lint 白名单唯一入口）；本协议的语义定义不依赖它们——协议词汇只认 operation、委派块、裁决状态与失败分类这些通用概念。

协议不关心实现（owner 2026-11-10）：CLI 出口（`operation list --json` / `call --file`）是执行层的**适配器绑定**，不是协议要求。执行层可用任何传输实现（CLI/网络），协议只要求能力语义。

---

本协议已落地（W5 尾程）；本版新增的「标识词汇：scopeId / callId」「Pi Durable 约束」「文件交换」三节是缺口登记（未落地 / 未采纳 / 未实现网络传输），按各节状态行理解。迁移期边界见仓库 AGENTS.md。
