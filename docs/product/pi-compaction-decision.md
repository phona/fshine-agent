# Pi 压缩复用评估 · 决策摘要（可机检定稿）

> 目的：把四文档（`pi-compaction-api-audit.md` / `pi-compaction-options.md` / `pi-compaction-poc.md` / `pi-compaction-migration-plan.md`）的结论收敛成**单一、可 grep 的决策工件**，修正复核缺口⑦「有结论但无落仓工件」。
> 边界：**文档零实施、产品代码零修改、不升级 Pi、未动 `docs/decision-log.md`**。行号对应锁版本 Pi 0.85.1 与当前 `packages/agent/src/pi-driver.ts`。
> 权威关系：本文件是**汇总摘要**；冲突时以四文档与 `docs/decision-log.md` 为准。

## 1. 决策行（机检锚点）

```
RECOMMENDED_OPTION=A（条件式）
```

```yaml
RECOMMENDED_OPTION: A            # 删重收敛 D1+D2+D3
CONDITIONAL: true                # 条件式：owner 批准 + 先跑反向绊线
NOT_RECOMMENDED: [S, T]          # 整套迁 Session / 内存 Session 只借上下文管理
COPY_PI_SOURCE: false            # 复用靠 import，不复制 Pi 源码（判据否决）
PRODUCT_CODE_CHANGES: 0          # 本轮零修改
```

## 2. 一句话结论

**推荐方案 A（条件式）**：删除 fshine 压缩编排里的三处重复（D1 `run()` 请求前 INV 复核臂、D2 失实注释、D3 emergency/INV 二源同值合一），净删约 26 行、单一来源、行为等价可证（D3 代数恒等；D1 的 `transformContext` 覆盖已实测，PoC ③b）。**直接复用整套 Pi 编排（S）与其中间形态（T）均判为不建议**——代价高于现有编排的最小修复，且仍删不掉 INV/窗口缩放/产物裁剪/确定性降解四处。

## 3. 各方案判定

| 方案 | 内容 | 判定 | 依据 |
|---|---|---|---|
| **A** | 删重收敛 D1+D2+D3（自研编排保留） | **推荐（条件式）** | options §2/§3；migration-plan §1–§5；D3 代数恒等、D1 覆盖实测（PoC ③b） |
| **B** | A + 压缩前无状态预判（`compactTranscriptWithPi` 纯函数，NOT_WORTH ⇒ 不发摘要调用） | 待证（证据前置 C 未完成） | options §2；decision-log §七十 |
| **C** | 现状 + 观测落盘（不改编排） | 可行（纯观测） | options §2 |
| **S** | 迁 Pi Session/Entry，直接复用 `prepareCompaction`/`compact` | **不建议** | options §4、§4.1–§4.6 |
| **T** | fshine 保留自管会话，仅挂 Pi 内存 Session 作转录镜像供压缩入口 | **不建议**（登记为中间形态） | options §4.5 |

## 4. 复核缺口逐条关闭

- **缺口③「direct-reuse vs copy-source」**：已明确——**复用靠 `import` 不靠复制**；复制 `structural.js` 等内部管线源码属「把复制包装成复用」，被 AGENTS.md 判据**否决**（options §4 第1点）。公开 API 本可 `import`（api-audit §1.1/§3）。
- **缺口④「impact surface / in-memory-session」**：已补——多 principal（options §4 第4点：fshine `Session.principalId` vs Pi `SessionMetadata` 无 principal 概念）、异步取消通知（§4 第5点：取消走 `runner.cancel`、通知走独立 outbox，均不依赖会话转录）、装配同源（§4 第6点：PoC 假 runtime ≠ `ask-runtime.ts:305/475` 真实装配，结论降级）、**「内存 Session 只借上下文管理」新选项 T**（options §4.T：可行但需镜像+适配层，不建议）。
- **缺口⑦「decision summary」**：由本文件落仓（`grep -rln RECOMMENDED_OPTION docs` 可见）。

## 5. 未验证项（不默认通过）

- A 的**行为等价**仅在 D3 恒等（代数）与 D1 覆盖（PoC ③b）两处有证据；**A 实施后的反向绊线未跑**（migration-plan §4 矩阵第 6/7 项为实施前置）。
- B 的机制准入（五条）与 128k 复测**未完成**。
- S/T **无迁移原型**；对多 principal / 请求取消通知的影响为**源码静态分析**（`execution-runtime.ts` + Pi `types.d.ts`），未在真实多 principal 会话跑通。
- PoC（`scripts/eval/piopt/piopt-phase3.test.ts`）与**生产装配不同源**；其结论只在生产函数层成立，**未在 `ask`/`eval` 真实装配下复验**。
- 零收益摘要循环在**生产 128k** 的命中率**无读数**（PoC 几何取自 W=8192，不外推）。

## 6. 指针

- 四文档：`docs/product/pi-compaction-api-audit.md`、`pi-compaction-options.md`、`pi-compaction-poc.md`、`pi-compaction-migration-plan.md`。
- PoC 测试：`scripts/eval/piopt/piopt-phase3.test.ts`。
- 生产代码：`packages/agent/src/pi-driver.ts`（`compactTranscriptWithPi:532-618`、`createPiTurnDriver:621-`）。
- 台账：`docs/decision-log.md` §六十九（归属审计）、§七十（precheck 设计）——本文件不改动该文件。
