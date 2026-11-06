# 测试强化波次（T1–T5）

状态：**已落地**（2026-10-16）。五波全部离线 mock 法域，`npm run typecheck` 0 错误、`npm test` 102 文件 / 1335 用例全绿（用例数只增不减）。本文是 `change-safety.md` 通用防线在测试侧的延伸：只加测试与 harness 夹具，不改生产代码；表征先行，钉现状而不是钉愿望。

背景：e2e 丰富度评估（106 用例 / 28 文件）发现的核心缺口——worker 超时零测试、长期记忆零 e2e、附件没进全链、两个自认假绿风险、输入形状单一。逐项对应 T1–T5。

## 交付总览

| 波次 | 新文件 | 用例 | 钉住的行为 |
|---|---|---|---|
| T1 worker 超时全链 | `tests/e2e/turn-loop-worker-timeout.test.ts` | 3 | 超时话术一字不差（`DELEGATION_TIMEOUT_FAILURE`）；`delegation_span` 记 `failureClass=timeout`；workerMessages 断点留痕；同 taskId 续跑从断点续；取消优先于超时（signal 中止 + 超时同刻，收取消话术） |
| T2 长期记忆全链 | `tests/e2e/turn-loop-long-memory.test.ts` | 3 | cue 命中即整理；候选溯源到真实 user_message 事件（reduceLongMemory 全链）；投影头注入模型输入（含"不代表授权"框架）；principal 级跨会话延续；记忆数字上屏现状（见"真发现"②） |
| T3 附件全链 | `tests/e2e/turn-loop-attachments.test.ts` | 5 | 附件-only 暂存（`已收到 <文件名>` + `attachment_received` 留痕 + 真实落盘）；先文件后指令 → 路径注入过实体门 → 计划激活真实执行；下载失败降级不吞消息；突发形态文件消息零帧、收据只由指令回合带一次；文件到过之后与附件无关的后续回合不再复读收据（D-110）；locality 契约：路径是宿主可见的本地绝对路径而非 URL/存储 key（2026-10-20） |
| T4 替身保真护栏 | `tests/e2e/harness-fidelity.test.ts` | 2 | 语义表必须平台派生、非空、锚点在场（HF-1）；平台 RESULT 信封真实形状仍被 `withoutPlatformEnvelope` 剥净（HF-2，真 spawn 一次 CLI） |
| T5 输入形状多样化 | `tests/e2e/input-shape-variants.test.ts` | 11 | 口语/全角标点/首尾空白/超长铺垫/语气词 emoji/非实体词错字六类变体过追问、重查、澄清三个锚：零翻车——确定性机器（实体门逐字 includes、澄清机械组装、编号绑定）对输入形状免疫 |

## harness 地基（`tests/e2e/harness.ts`，全部缺省安全、既有用例零感知）

- `boot()` 新增可选项：`memoryCandidateExtractor` / `contextModelDriver` 透传（T2）；`patchProfile`（复制 config/agent.yaml 打补丁 + `AGENT_CONFIG_PATH`，T1 的 workerTimeoutMs）。
- `RecordingSdkClient` 补 `downloadFile`（`fileToServe` 可编程，含失败模拟）；`boot().sendFile()` 发生产同形状 message.file 帧（T3）。
- 每 boot 独立 `FSHINE_ATTACHMENT_DIR`（位于平台 `tmp/attachments/e2e-<boot>-<uuid>`，被产物扫描的输入区排除规则覆盖，close 清走）。
- **语义表翻回平台派生**（见"真发现"①）：18 条手注替身退役，换 `loadOperationSemantics(PLATFORM_ROOT)`，空表即抛。

## 落地中的真发现

1. **平台已下发 accessSemantics，替身缺口已修**。HF-1 实测派生表 53 条、与替身 18 条逐条一致——harness 注释里"尚未下发"已过时，按其自写的翻回条件换回平台派生。替身政权时代的真实缺口（5 个 confirm=true operation——`voucher.proposal` / `fix-summary` / `gen-from-journal` / `create-assistant` / `upload-all`——不在替身表，写关闭扫描对它们不生效）随之消除，并在 HF-1 用锚点钉死不许回退。
2. **对话类回复的数字不受出口校验拦（T2-LM-2 表征）**：delegate/needs/计划回合的"数字必须本轮执行凭证"未覆盖纯 conversation 回复，记忆里的数字经对话上屏无机械拦截，唯一防线是投影头提示词框架。已按现状钉死并标注疑似缺陷方向——是否收口属架构判断，待决策。
3. **失败回合的工具结果不带 taskId（T1 表征）**：超时/失败后 Main Agent 拿不到 continueTaskId，"断点续跑"目前只有宿主侧契约（测试从 platform_tasks 底账接线）。模型侧取编号的路是否缺口，待确认。
4. **"完成但零执行"的任务终态是 failed（T1 表征）**：`context.ts` 以执行有无定终态，标签语义易误读，非断言缺陷。

## 变异验证（F3，实测有牙）

- T2：`loadMemoryProjection` 恒空 → 3 用例全红（已还原）。
- T3：剥掉 handler 附件路径注入 → AT-2 被实体门拒、当场红（已还原）。
- T4：平台 `RESULT ` 标记改 `RESULTX ` → HF-2 红（平台仓已 git 还原）；harness 替身表改错一条 → HF-1 红（翻回前实测）。
- 其余变异操作已写入各文件注释（如 T1：摘 deadline 传参 → WT-1/2 红）。

## 已知边界（显式不做）

- 传输层（HTTP/签名/加密/重连/截断）维持人工 + adapter 单测（manual-test-wecom §8.3）。
- 长对话（20/30 轮）离线化不做——探针层（C1/C2/H1）+ 冻结基线承接，分工是设计。
- 真实限流/真实 auth 码：mock 证不到，不写假验证（change-safety §0 表）。
- 输入形状网不覆盖申报方向听错（模型能力，脚本化 mainDriver 钉死方向）。
- ASSISTANT_AMBIGUOUS 的终局快路径 e2e 在 mock 下走不到（2026-10-16 评审登记）：平台 mock 信封缺 `data.customer`，`terminalFastPathOf` 的完整性门 fail-safe 不挂（按设计回到既有重规划循环，不出假话术）；真平台信封带该字段。该码的宿主话术渲染只有 unit 链覆盖；补齐 mock 信封属执行层仓。
- 思考档与 DeepSeek 契约的落地情况（2026-10-17 研究修正早前"适配器不可控"的误判）：pi-ai 的 openai-completions 适配器**已实现** DeepSeek 思考模式契约——响应侧解析 `reasoning_content` 进 thinking 块（`thinkingSignature` 记字段名），重放侧按签名回发（DeepSeek 带 tools 的多轮要求完整回传 reasoning_content 否则 400，官方 harness 的解法是整条 message 对象回填，"让模型继续之前的思考"）；`reasoning_effort` 亦随 `LLM_THINKING_LEVEL` 透传（medium/high/xhigh→high 服务端映射）。已知边界：① deepseek-flash 服务端默认即思考开 + effort high，故 `=high` 与缺省无行为差异（low/max 可真降/真升，未测）；② 重放的 reasoning 前缀滚入输入是 token 膨胀的机制根源，靠 DeepSeek 上下文缓存折价对冲（实测 cacheRead 为大头）；③ 依赖 pi-ai 持续正确实现该契约——其回归（如重放漏 reasoning_content）会以 DeepSeek 400 的形式炸穿 worker，离线 mock 闸不拦，属对上游的隐式依赖。
