# 会话级产物库与引用迁移（2026-10-20）

> 状态：**已落地**（W0–W7 七波，`npm test` 1494 → 1538 全绿 / 115 → 117 文件 + typecheck 0 错误）。
> 执行记录见 `change-safety.md` §16；根因登记见 `debt-ledger.md` D-114。
> 本文是设计账：问题、决策、生命周期、边界。代码是权威，本文解释"为什么这样建"。

## 1. 问题（一次真机事故的形状）

2026-10-20 企微会话（`data/agent.db` 只读取证）：同一指令「帮我做一下幻骥达的工资表给我」
在一个会话里发了 24 次（会话自 09-20 起 153 条事件）。15:05:58 用户说「发一下
幻骥达2026年08月个税申报.xlsx」，随后发生的事：

1. Main Agent 申报委派。委派原文（`platform_tasks.worker_messages` 逐字）写着
   「文件位于 `/tmp/task_d42fffce-e4b2-4d35-82b6-969f97b12b0a/幻骥达2026年08月个税申报.xlsx`」
   ——**前缀错**（`/tmp` 而非平台 tmp/）、**UUID 错**（真身 `…ce9a-4ff7…`，文中是编造的
   `e4b2-4d35` 变体）。正确路径在历史里明明白白出现过两次。
2. worker 拿假路径 ls，失败；随后 `find -iname "*个税*"`、翻 `/tmp/`、依次 ls 四个 task
   目录（其中两个现已被 scratch 清理）、md5sum、python 逐格比对，最后把 **10/19 的副本**
   cp 进本轮工作区。
3. worker 的交还文本「委派中给出的原文件路径已不存在……已放入本轮工作区」被 Main Agent
   原样转给用户。

取证结论（都已逐格复核）：交付文件与 12 分钟前刚重算的那份**逐格一致**（116 行 0 差异，
md5 差只是 zip 元数据）——**没有数据正确性事故**；问题全部发生在"系统怎么指认、怎么叙述、
怎么使用共同历史"。

同一次会话还暴露三个同族形状：15:03 终稿列「交付物（2 份）」却只附 1 个文件（契约 `file`
单数）；DB 存 UTC，模型把 15:05:58（北京）的消息引述成「07:06」；附件是 10/19 16:10 上传的，
10/20 五个回合 5/5 都播「已收到 3 个文件」（D-110  territory）。

## 2. 根因（R1–R4，一次设计讨论的收敛）

- **R1 产物无身份、无请求绑定（主根）**。交付曾是"回合末把字节流进渠道消息"的一次性
  副作用——不停留、不复制、不登记。`conversation_events.artifact_ref` 槽位全代码库只有
  读方、没有写方。"重发一个已交付产物"这个产品上完全自然的请求，系统没有任何机制：
  Main Agent 只能凭对话散文里提到的路径复述，而复述会损坏。**信息不是不存在，是以"散文中
  路径"的形态存在：不可校验、不可引用。**
- **R2 交付集当会话级持久状态（R1 的输入侧镜像）**。附件池按会话存、规则一窗口按委派
  划界——"系统手里有什么文件"与"用户这一轮给了什么"被混为一谈。
- **R3 用户可见层只做形态过滤，不做语域过滤**。`stripServerPaths` 是形状匹配；语域契约
  枚举了几类内部语言。都管不了"委派/批次/工作区/逐格比对"这类流程叙述，也管不了 UTC
  时间戳复述。注意因果方向：R1 决定了 worker 只能靠 hunt 和自我叙述交差（没有身份可
  引用），R3 决定这些叙述到达用户。
- **R4 长会话无摘要与复用纪律**。30 天 153 条事件无收敛；greeting 触发状态倾倒；同指令
  24 次重发，没有"产物已存在"的产品语义。

## 3. 设计决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | **session = 聊天窗口**（`channel:conversationId`），principal = 消息级演员 | adapter 早已正确计算 conversationId（单聊=userid、群=chatid）；旧的 `user:conversation` 复合键把群切成 per-user，A 交付的产物窗口内全员可见、B 却指代不了。授权/确认门/审计逐消息钉在 principalId 上 |
| D2 | **产物库 per-session**：字节落 `data/sessions/<encodeURIComponent(sessionId)>/artifacts/`，DB 表 `session_artifacts`（ref 会话内单调、sha256、size、sourceTaskId、requestId、createdAt、status、path） | 给"这个文件是哪来的"一个家。ref 单调可读（清单与"第 N 个产物"的用户语言之间的桥）；内容哈希不做 ref——同一文件两轮交付是两条记录 |
| D3 | **溯源从 worker 工作史投影，不建平行登记** | 宿主只拥有"ref ↔ 交付回合 ↔ 产生任务"映射（交付是宿主动作，worker 史里没有这一条）；输入、时间、worker 摘要从 `platform_tasks.worker_messages` 投影。一个事实一个权威位置 |
| D4 | **引用是 ref 不是路径** | 入库即改写：worker 交还文本与出口文本里的产物引用从路径改写为 ref。此后任何 agent 可见文本零 scratch 路径——这是"任务终态即删 scratch 真的隐形"的前提 |
| D5 | 委派 setup 按 ref 物化（续跑引用产物 → 宿主复制进新任务 scratch） | **本轮未做**（见 §6 边界） |
| D6 | **重发是宿主动作**：申报 `resend` + ref → runtime 记账零委派 → handler 依库确定性回答 | 消灭事故的主路径：模型不再需要（也不再能够）凭记忆写路径 |
| D7 | **契约 `files[]`** | 单数是"说 3 个发 1 个"的根源——一次任务多个交付物是常态，数组才是诚实形状 |
| D8 | **GC 按任务终态 + 显式淘汰** | scratch：终态（done/failed）过 1h grace 即删，非终态闲置 24h 抛弃兜底；库：50 个 / 512MB 双闸压"可重发"集合，最旧优先淘汰，status=evicted + 删字节 + 留痕，清单每回合反映状态 |
| D9 | **群聊共享会话**：转录/附件池/委派账本/产物库/回合队列全部按窗口 | 队列键曾遗漏（W1 改了会话键没改队列键），W6 补：arrivalKey（发送者×会话）管 burst 防抖，queueKey（会话）管回合串行 |

## 4. 生命周期（一条产物的路）

```
worker 写 scratch ──回合末 collectProducedFiles──► ingest（复制字节 + 分配 ref + 落库）
                                                      │
                                               bySourcePath 映射 ──► ref 改写（出口文本）
                                                      │
                                               files[] 挂到回复 ──► 渠道逐条发送
                                                      │
                                        下一轮输入注入产物清单（ref/文件名/时间/来源任务/状态）
                                                      │
              用户"再发一次" ──申报 resend+ref──► runtime 零委派 ──► handler 依库取字节 + 合成文本
                                                      │
                          任务终态 + 1h grace ──► scratch 删除（无引用指向它，删除隐形）
                                                      │
                    超容量 ──► 最旧优先淘汰（evicted + 删字节 + 清单标注，重发答"已淘汰需重算"）
```

关键不变量：

1. **交付即入库**——ingest 失败不挡交付（用户拿不到文件比库里少一行更糟），留痕即可；
   repo 缺失（旧替身）静默退化为纯流式交付。
2. **ref 之前 scratch 不准死，ref 之后必须死**——中间那堵墙就是"交付即入库"一个动作。
3. **删除显式**——任何淘汰对 planner/worker 可见（清单状态），不产生悬空引用；重发不存在
   的/已淘汰的/字节丢失的 ref，各有确定回答，不委派、不编。
4. **重发不重新入库**——它们已经在库里；重复入库会产生重复 ref。
5. **新批永不淘汰**——刚交付/重发过的文件不能蒸发（用户手里的回复不能指向空气）。

## 5. 群聊语义（W6 过堂结论）

- **窗口共享**：session = 聊天窗口。群里 A 上传的文件、A 交付的产物，对同窗口其他人可见、
  可指代（产品决策：文件在窗口里就是共享输入）。授权仍是逐消息的——B 不能借 A 的写权限，
  但重发 A 已交付给整个窗口的东西按构造安全。
- **回合串行**：同一会话的所有回合（不论发送者）排队串行——共享状态禁并发写。burst 防抖
  仍按发送者计窗口：群里别人的闲聊不重置"我这个人的一批消息"的沉降判据。
- **交付集窗口规则**：附件池 + "自上次委派开始以来新到达"的划界按会话走（D-110 修了收据
  复读；池与窗口模型本身不变，多实例外置见 D-112）。群场景的语义 = 窗口内共享输入。

## 6. 边界与未做（登记，不阻塞）

1. **D5 物化未做**：续跑/纠正请求引用产物 ref 时，宿主把字节复制进新任务 scratch——需要
   driver 能访问产物库的接缝（跨层），本轮未搭。当前替代：委派信封里的外来 scratch 路径
   被 `stripForeignScratchPaths` 外科手术式剥掉（本任务工作区与附件输入不碰）+ 留痕——
   worker 不会再 hunt，但指代旧产物的续跑请求会确定性地找不到文件，而非 silent hunt。
2. **`worker_messages` 保留策略未验证**：D3 投影源的寿命未知（现 45 条任务俱在），需要确认
   长期清理规则；投影源被剪则溯源断。
3. **R4 的长会话摘要纪律未收敛**：resend 语义已给（复用有了产品形态），但 30 天会话的转录
   增长与 greeting 状态倾销仍在，属会话治理范畴，另立账。
4. **R2 的附件池模型未动**：规则一窗口 + 池按会话走的形状保留（D-112 跟踪进程内状态外置）。
5. **`artifact_ref` 槽位仍未启用**：`conversation_events.artifact_ref` 是声明未用的列，本轮的
   产物登记走独立的 `session_artifacts` 表；两套并存的理由 = 事件表的槽位没有 ref 语义
   （单调/状态/溯源），不复用而不是留双写。

## 7. 机械锁与变异验证（汇总）

每波的新守卫都过"改错就红"（F3），逐波明细见 `change-safety.md` §16。汇总：

| 波次 | 守卫 | 变异（改错）→ 红 |
|---|---|---|
| W0 | 3 条表征（群 per-user 现状、两份交付物只发一份、重发无宿主动路） | W1/W3/W4 各自翻转时红 |
| W1 | session = conversationId（渠道前缀/群共享/信封/e2e 父会话 9 处） | 改回复合键 → 9 红 |
| W2 | ref 单调（跨批）、ingest 落库、清单注入 | ref 恒 '1' → 1 红；insert 跳过 → 4 红；清单恒空 → 1 红 |
| W3 | files[] 全量挂载 + 点名列全 | 只挂第 1 个 → 2 红 |
| W4 | resend 路由（申报→零委派→artifactRefs）、库解析三态、委派外来路径剥离 | 路由不记账 → 2 红；解析恒无 → 2 红；守卫空操作 → 3 红 |
| W5 | 终态 grace 双年龄、淘汰（最旧优先/新批保护/evicted 不占名额/字节闸） | grace 失效 → 1 红；fresh 守卫删 → 1 红（结构性场景） |
| W6 | 群回合串行（队列键 = 会话） | 队列键改回复合 → 1 红 |

## 8. 文件地图

| 位置 | 职责 |
|---|---|
| `packages/contracts/src/store.ts` | `SessionArtifactRecord` / `SessionArtifactRepo` / `AuditStore.sessionArtifacts`（可选挂载） |
| `packages/contracts/src/runtime.ts` | `AgentReply.artifactRefs`（runtime → handler 的 ref 通道） |
| `packages/contracts/src/channel.ts` | `RichChannelReply.files[]`（W3 多文件契约） |
| `packages/core/src/store.ts` | `session_artifacts` 表 + repo 实现；`task_runs` 表（§18 波：dispatchKey 幂等 / 每任务单活跃部分索引 / CAS transition / `result_handling_state` 投递状态列，2026-10-25 修复波） |
| `apps/server/artifact-store.ts` | 产物机器全集：ingest（`sourceRunId` 溯源）/ manifest / rewrite / resolve（重发读回 sha256+size 复验，坏文件不发出并留 `artifact_resend_corrupt`）/ evict（含 taskRuns pin 判据）/ 回合收口 `finalizeWithArtifacts` / 收集器 `collectProducedFiles`（W2 自 handler 抽取）/ `collectTaskRunOutputFiles`（后台 run 输出按宿主快照 manifest 逐文件复验）与 `loadTaskArtifactFiles`（投递读回） |
| `apps/server/background-delivery.ts` | 后台结果交付机器（§18 波 + 2026-10-25 修复波）：认领 → 产物 ingest → 文字/文件逐件投递（acknowledgedParts 记账）→ resultHandling 状态机（写 `result_handling_state`）→ 启动期清扫 `sweepUndeliveredTaskRuns` → 传输失败有界重试（3 次 × 750ms）+ 失败通知 |
| `apps/server/handler.ts` | 接入点：manifest 注入输入、finishWithFiles 透传 artifactRefs、队列/防抖双键（W6） |
| `packages/agent/src/turn-contract.ts` | resend 申报枝（schema + review + 描述） |
| `packages/agent/src/runtime.ts` | resend 路由（记账 + 打点 + ToolUserError 终止）+ 主路径挂 artifactRefs |
| `packages/agent/src/turn-state.ts` | `resendRefs` 回合状态 |
| `packages/agent/src/server-paths.ts` | `stripForeignScratchPaths`（委派范围的外来 scratch 路径守卫） |
| `packages/agent/src/context.ts` | 委派信封接入守卫 + 留痕（范围行与任务正文主拷贝同尺剥离外来 scratch 路径，2026-10-25 修复波） |
| `packages/agent/src/pi-coding-driver.ts` | 收尾指令不再要求交还文件路径 |
| `packages/agent/src/scratch-cleanup.ts` | 双年龄清理策略（终态 grace + 抛弃 TTL + 判据注入） |
| `apps/server/main.ts` | 终态判据快照 + 策略形态 sweep |
| `apps/server/assembly.ts` | `dataRoot`（= 库同目录）注入 handler |
