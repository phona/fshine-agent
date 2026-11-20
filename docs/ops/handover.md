# 交付交接单（冻结基线快照）

> 状态：现行（交接快照；数字以第三节冻结基线为准，其后仅文档变更不改结论）。
> 最后核对：2026-11-20。
> 上游指针：`docs/decisions/index.md`（决定与状态）、`docs/decisions/debt.md`（未清债务与接受不修项）、`docs/product/capability.md`（用户级能力台账）、`docs/architecture/capability-boundary.md`（能力边界判据档）。

## 一、这一版是什么

Pi Agent（Main）+ 最小宿主 + Execution Contract + Channel Adapter 的产品面：用户用业务语言交办，Main 有承诺权与汇报权但**无执行权**，Worker 按清单拿 `op_*` 工具执行但不直接对用户说话，宿主只做身份/时机/事实/凭据/投递与记账。写事务由执行层裁决（确认是显式动作），状态变化一律唤醒 Main 由它带话给用户。

## 二、这一版交付了什么（八刀，均带守卫）

1. **四项 P0 修复**：底账投影按末次决定性结果、提示词条款冲突、P4 守卫假绿洞、W-43 节拍竞态。
2. **能力边界判据档**：`docs/architecture/capability-boundary.md`（四角色权界、单一来源能力目录、答复五态、结构化交办、三条禁令；未实现处逐条标注）。
3. **泄漏扫描通用断言**：内部词/任务编号单一词表 + AST 静态守卫（注释/删除/改名即红），接入写闭环、场景集、eval:user 三个用户级批次，命中即机械失败。
4. **Worker 动态工具**：每个 operation 一个 `op_*` 工具、参数用业务字段名；`hostOnly` 机制参数（`--apply`/`--confirmation`/`--count` 等）不进模型面；宿主负责句柄注入与计数自算。
5. **能力目录 + 答复五态**：`capability?: string` 派生目录（禁止手写清单）、Main 一句摘要 + 只读 `capabilities()`、`classifyOutcome` 五态机械分类（`packages/agent/src/task-outcome.ts:71`）。
6. **确认回合 = 已确认提案**：确认续跑的任务内容切成提案载荷原文，旧交办 prose 让位；执行层绑定校验保证旧值不可覆盖。
7. **机制参数封死**：`op_*` 工具参数结构化校验，未知字段/`--` 前缀键确定性拒绝且执行层零调用；夹具改走内部 exec 路由。
8. **E11 判据机械化**：删掉 20 词拒绝词表，换成「零执行 + 无成功宣称 + 结构化 outcome ∈ {unsupported, blocked}」+ 非空下限。

## 三、冻结基线与门（怎么复核）

- 分支 `arch/integration`，收尾提交 `1b230ef8`（2026-11-21；此前的 `e0f105e0` 是交接快照，其后为可靠性/对话面整备）。
- 确定性门：`npm run typecheck` exit 0；`npm test` → 269 文件 / 2736 passed（1 skipped / 3 todo）；`node --import tsx scripts/eval/wecom-sim/run.ts` → 48/51、失败 0（3 条 SKIP 有登记理由）；文档守卫 30 passed（docs-guard / product-capability / coverage-matrix）。
- 真模型稳定性读数（冻结 `5105b795`，独立复核逐份核过产物）：写闭环 **5/5 全绿**（C1–C10）；场景集 **24/24、24/24、22/24、24/24、20/24**；`eval:user` **14/15、15/15、13/15+1 INCONCLUSIVE**。9 处红经逐条拆解：模型旅程方差为主，另含 1 条 taskId 泄漏与 2 个判据形状问题（已修，见下）。
- 泄漏扫描（单一入口 `scripts/eval/shared/internal-terms.ts`）：内部词表 + `#N` 编号形态 + **taskId 形态 `task_[A-Za-z0-9-]{8,}`**（2026-11-21 加，源自 live 实测「任务号 task_db2b3ca3」）；接进四个用户级批次与 wecom-sim。
- 判据换形（2026-11-21）：**E11** 的隔离判据从「任何执行行」改为「**零写面执行**」（只读允许——产品会先读后判）；**E14** 的措辞族换成**执行层已知字符串存在性**（华远贸易/明达物流/新程科技 任一）。两处都保留了对象身份/重试上限/零写/无成功宣称等机械硬判。
- 独立复核做法（可复制）：① 复跑四门；② 亲手破坏三个最强守卫（Main 工具面精确集合 / 机制参数拒绝 / 内部词 AST 守卫）必须红、恢复必须绿；③ 故意放宽一条守卫 + 注入回归，看是否被**其它**测试抓住；④ 逐条把文档里的「对现状的陈述与指针」对代码核（`docs-guard` 只校验行号存在与不越界，不校验指对没有）。
- 对话形态门（2026-11-21 起，**已实现为共享断言层** `scripts/eval/shared/conversation-shape.ts`，接进 wecom-sim / 写闭环 / 场景集 / eval:user 四个面）：每条用户消息 ≤1 条回合回复；同一事实 ≤1 次（回合内已交付的终态不再重复唤醒）；非线程推送必须自含话题（降级回复由宿主加原话引用行；**无归属**推送按原话片段/任务名判——有归属的推送不判措辞，宁漏勿误，见模块头「已知边界」）；不错挂（回复不挂到别的消息/别的话题上）。判定用宿主记账里的 `(taskId, factKind)` 归属，不靠措辞。首批守卫 = live 两缺陷与其常跑化：缺陷 A（回合内终态抑制 `1a719936`）、缺陷 B（降级引用行 `e0bad29e`）、要求 C（wecom-sim M 组 L1 常跑用例 `ca2dee09`）、断言层（`cd1276ff`）。

## 四、明确未覆盖（不许当已验）

| 面 | 现状 |
| --- | --- |
| 真实执行层 17dz | 确认句柄未实现 → **真实写不可用**；只读接入=准备档、未授权；`capability` 未声明（走退化路径，行为同今日） |
| 真机企微 live | 只有假 SDK + dummy 的渠道级 sim；真网络时序、气泡观感、真实文件上传下载未验（debt #74） |
| 其它模型 | 全部证据只覆盖 `workbuddy/deepseek-v4.1-flash`（Main=high / Worker=medium）；换模型即新基线 |
| CI nightly | 配置就绪但当前工作线未合 `main`，首次真实运行未留档（见 `README.md` 测试与评测一节） |

## 五、必须先知道的风险

1. **长连接断连窗口的消息会丢**（已实测）：停服 `12:02:15Z` → 重连 `12:03:43Z` 期间用户发 2 条，重连后底账零新增、`aibot_msg_callback` 帧 0 → 平台不补投、产品无补拉。缓解已落地：`systemd Restart=always`（窗口秒级）、心跳 15s、`message_still_processing` 接进程内告警（规则 `message_stuck`）；销账条件=切 Webhook（平台最多 3 次重试）+ 既有 messageId 幂等底账接重投。详见 `docs/decisions/debt.md` §十一。
2. **答复五态只走了一半**：`completed`/`partial` 目前送不到 Main（outcome 只写进失败唤醒出口，底账 `ExecutionRecord` 无 `items`）——文档已如实标「未接线」。
3. 其它未清债务见 `docs/decisions/debt.md`（含 §五「接受不修 / 登记不修」）。

## 六、上线前建议（按收益排序）

1. ~~进程守护~~ **已落地（2026-11-21）**：systemd user unit `fshine-live.service`（`Restart=always` + 开机自启），重启演练 20 秒内恢复在线；unit 属部署形态、不在仓库内，见 `docs/ops/README.md` §4。
2. ~~心跳 30s → 15s~~ **已落地**（`52eaa0b2`，随 `fix/reliability-small` 并入）：适配器以 `heartbeatInterval=15000` 建 WSClient。
3. ~~`message_still_processing` 接进行内告警~~ **已落地（2026-11-21）**：进程内告警新增规则 `message_stuck`（含 messageId 与 principal/session，不含消息正文；冷却去重与双出口沿用既有）。
4. 若要「消息不丢」作为硬指标：评估 **Webhook 模式**（平台自带最多 3 次重试，我方幂等底账可接住重投），需公网回调地址 + 签名校验 + AES 解密。

## 七、接手第一小时

```
export TMPDIR=/home/tao/.tmp          # 本机约定：不设会踩 /tmp 容量
npm run ci                            # = typecheck + unit 单 project
npm start                             # 起渠道服务（单实例锁：apps/server/main.ts:53）
node --import tsx scripts/eval/wecom-sim/run.ts   # 渠道级不变量，约 2 分钟
npm run eval:user                     # 真模型用户级黑盒（需 .env 里的 LLM 配置）
```
排障从 `docs/ops/README.md` 起；告警看 `docs/ops/alerts.md`；写闭环与 live 重放见 `docs/ops/real-write-loop.md`、`docs/ops/live-replay.md`。
