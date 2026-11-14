# 缺口 3 设计：压缩窗口调小接线（装配层一处）

> 状态：**批准细化，未实施**（owner 裁决 2026-11-14）。本文档只做设计与最小 diff 文本，产品代码零改动。
> 基线核验修正：能力参数测试在 `packages/agent/pi-model-capability.test.ts:44-46`（给能力读）与 `:48-63`（阈值跟能力走 + 缺省 128k 金样），非基线所写 52-53。

## 0. 一句话

`LLM_CONTEXT_WINDOW` 由配置层写进 env（`packages/core/src/config.ts:442`，:103 注释明说「由装配点 parseContextWindow 校验」），但装配点从未校验、驱动也从不读该 env——生产装配两处 `createPiTurnDriver({ env: input.env })`（`scripts/ask-runtime.ts:288,385`）都不传 `contextWindow` 参数，压缩阈值永远按写死的 `DEFAULT_CONTEXT_WINDOW = 128_000`（`packages/agent/src/pi-driver.ts:78`）。窗口比 128k 小的真实模型会在超出真实窗口后才尝试压缩（T7 贴边空回复的成因类别）。修法=装配层一处把 env 值经既有 `parseContextWindow` 传入。

## 1. 最小复现

```
# 配置 config/agent.yaml: llm.contextWindow: "40000"（或 .env LLM_CONTEXT_WINDOW=40000）
npm run ask -- "<一段长对话触发多轮>"
```

- 路径：`loadConfig` → `effectiveDeploymentEnv` 把值 put 进 env（config.ts:442）→ ask-runtime 装配 `createPiTurnDriver({ env: input.env })`（ask-runtime.ts:288，server 经同源 ask-runtime）→ pi-driver `PiTurnDriverOptions` 无 contextWindow → `parseContextWindow(capabilities.contextWindow, ...)` 收到 undefined（pi-driver.ts:240）→ `?? DEFAULT_CONTEXT_WINDOW` = 128k。
- 现行可证伪点：单测已钉死「40k 能力触发压缩尝试、缺省 128k 原样返回」（pi-model-capability.test.ts:48-63）——把该测试的 `createPiTurnDriver({ env: ENV, contextWindow: 40_000 })` 换成 `{ env: { ...ENV, LLM_CONTEXT_WINDOW: '40000' } }`（模拟装配层现状的真实输入），断言**必须红**（不触发压缩尝试）：红即缺口复现。此为测试草稿文本，不落仓。

## 2. 代码证据

| # | 证据 | 位置 |
|---|------|------|
| 1 | 写死缺省 | `packages/agent/src/pi-driver.ts:78` `DEFAULT_CONTEXT_WINDOW = 128_000` |
| 2 | 校验器（fail-fast，中文报错点名 env 变量） | `pi-driver.ts:134-143` `parseContextWindow` |
| 3 | 参数消费点（缺省逐字节一致承诺） | `pi-driver.ts:240` `?? DEFAULT_CONTEXT_WINDOW`；参数声明注释 :150s（「缺省 = 128_000，与提供能力前的行为逐字节一致」） |
| 4 | 压缩阈值随窗口缩放（已实现） | `pi-driver.ts:269-281`（128k/40k 等档位的缩放规则） |
| 5 | env 注入点 | `packages/core/src/config.ts:442` `put('LLM_CONTEXT_WINDOW', config.llm?.contextWindow)`；:103 注释指认装配点责任 |
| 6 | 生产装配不传参数（缺口本体） | `scripts/ask-runtime.ts:288`、`:385` 两处 `createPiTurnDriver({ env: input.env })` |
| 7 | 参数已实现有测试（金样） | `packages/agent/pi-model-capability.test.ts:44-46,48-63` |
| 8 | grep 全仓：`LLM_CONTEXT_WINDOW` 生产代码仅 config.ts 写入，零读取（本 worktree `grep -rn 'LLM_CONTEXT_WINDOW' packages apps scripts --include='*.ts' | grep -v test` 输出仅 config.ts 两行） | 已运行 |

## 3. 最小 diff（装配层一处函数，两调用点共享）

```diff
--- a/scripts/ask-runtime.ts
@@ 顶部 import 区
-import { createPiTurnDriver } from '../../packages/agent/src/pi-driver';
+import { createPiTurnDriver, parseContextWindow } from '../../packages/agent/src/pi-driver';
@@ 新增装配期小函数（模块内，createPiTurnDriver 调用旁）
+function contextWindowFrom(env: NodeJS.ProcessEnv): { contextWindow?: number } {
+  const parsed = parseContextWindow(env.LLM_CONTEXT_WINDOW, 'LLM_CONTEXT_WINDOW');
+  return parsed === undefined ? {} : { contextWindow: parsed };
+}
@@ :288
-      : createPiTurnDriver({ env: input.env }));
+      : createPiTurnDriver({ env: input.env, ...contextWindowFrom(input.env) }));
@@ :385
-      : { mainDriver: createPiTurnDriver({ env: input.env }), workerDriver: createPiTurnDriver({ env: input.env }) };
+      : {
+          mainDriver: createPiTurnDriver({ env: input.env, ...contextWindowFrom(input.env) }),
+          workerDriver: createPiTurnDriver({ env: input.env, ...contextWindowFrom(input.env) }),
+        };
```

逐行说明：
- `parseContextWindow` 直接复用（pi-driver.ts:134）：未设置/空串 → undefined → `{}` 展开 → 驱动 options 不含 contextWindow → 走 `?? DEFAULT_CONTEXT_WINDOW`，**缺省路径逐字节不变**；非法值（`abc`/`0`/`1.5`）→ 装配期抛中文错误点名 `LLM_CONTEXT_WINDOW`，fail-fast 不静默回落（:130-133 的设计理由原文）。
- 只改装配层，pi-driver 零改动；Main/Worker 共用同一窗口值（同一 env），与现行两驱动同源装配一致。
- eval harness（scripts/eval/convergence-r1/runner.ts:385-386 也是 `createPiTurnDriver({ env: driverEnv })`）是否同步接线由实施切片决定——建议同步，保证 eval 与生产同窗口（P5 单一配置源纪律，见 §四十一合入登记的先例）；本 diff 先覆盖生产两处。

## 4. 缺省零变化的金样证明方案

1. **既有金样**：pi-model-capability.test.ts:48-63 已断言「缺省 128k 原样返回、零压缩尝试」——不动，作为驱动层金样。
2. **装配层新金样**：新增用例——`env` 不含 `LLM_CONTEXT_WINDOW`（或为空串）时，装配产物驱动的 `model.contextWindow === 128_000` 且 `compact` 行为与改动前基准逐字节一致（同一长转录、原样返回、零 warn）。
3. **环境隔离绊线**：仓内既有测试族已把 `LLM_CONTEXT_WINDOW` 列入环境白名单（scripts/ask-replay.test.ts:45 等，防宿主环境污染测试）——新用例必须显式清掉该变量再断言缺省，反向绊线=故意注入 `LLM_CONTEXT_WINDOW=40000` 到无配置路径，装配产物必须变成 40k（证明接线真的生效，防止「参数没人传」的死代码回潮）。
4. **非法值**：`LLM_CONTEXT_WINDOW=abc` → 装配抛错且报错文案含变量名（parseContextWindow 语义，pi-model-capability/worker-env.test.ts:67 先例）。

## 5. 压缩触发读数如何进证据

- pi-driver 压缩尝试/失败已走 `console.warn`（`context_compact_failed`，pi-model-capability.test.ts:56-58 断言的既有通道）。
- 装配层读数：`ask.ts` 机械证据（:248）追加一行纯机械事实 `context_window: <解析后的值或缺省 128000>`（装配期常量，非模型行为）；压缩触发次数在回合级由驱动 warn 计数汇入 eval 报告（eval runner 已录 driver 事件）。不进对话历史、不进系统提示。
- 目的：eval 能按窗口档位分层看「压缩尝试率 / 贴边空回复率」，验证「调小窗口」是否真改善 T7 类失败——这是本缺口验收的读数面。

## 6. 边界安全分析

- **越权/重放**：无面——纯装配期配置解析，无模型可动参数（模型不在工具面接触窗口值）。
- **资源**：窗口调小使压缩更早触发 → 每回合 token 下降、压缩调用次数上升；极端小值（如 1）会频繁压缩。是否设下限：parseContextWindow 现行只验正整数；建议**不加新下限机制**（加机制需过准入），由配置评审把关 + eval 读数观察，登记为已知开放点。
- **失败面**：非法 env 值从「静默按 128k」变为「启动失败」——行为变化点，需在配置示例（config/agent.example.yaml）与部署说明标注；这正是 :130-133 注释声明的既定设计意图（把写错的值静默当缺省会让压缩在真实窗口之外触发），不是新风险，是修复。

## 7. 回归测试清单（含反向绊线）

1. 缺省金样（§4.2）：无 env 值 → 128k、compact 原样返回。
2. 接线生效绊线（§4.3）：`LLM_CONTEXT_WINDOW=40000` → 装配产物 contextWindow=40000、长转录触发压缩尝试。
3. 非法值：`abc`/`0` → 装配抛错点名变量。
4. 空串 = 未设置（parseContextWindow 语义，pi-driver.ts:137）→ 缺省。
5. server 同源：apps/server 装配路径同样吃到该值（server 经 ask-runtime，断言一处即可由同源保证；加一条装配产物冒烟）。
6. 反向绊线：删掉装配点 `...contextWindowFrom(...)`（故意破坏）→ 用例 2 必须红（这正是复现 §1 的红测试形态，作为永久守卫保留）。
7. 既有套件零回归：`npm test`（本切片只新增用例文件/用例，不改任何既有断言）。

---
未实施；diff 为文本形式。eval harness 同步接线点已标注，由实施切片裁决。
