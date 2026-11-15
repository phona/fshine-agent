# R5 前置批 · P0-B 实测核实（审计员·P0-B）

基线：worktree `~/projects/fshine-agent-r5-preaudit`（分支 `arch/r5-preaudit`，基线 `502d98d` = arch/integration HEAD）。
方式：**零真实模型额度**。全部用假模型运行时（`streamSimple`/`completeSimple` 假件，baseUrl=127.0.0.1:9，零网络）+ 生产代码实测；临时测试文件 `packages/agent/p0b-preaudit-verify.test.ts` 跑完即删，产品代码零改动。

## 审计对象（读到的代码）

- `packages/agent/src/pi-driver.ts:289-307`：`CONTEXT_REQUEST_FRAMING_TOKENS=4096`、`MIN_OUTPUT_BUDGET_TOKENS=1024`、`fixedRequestOverheadTokens`（Δ_worst = 4096 + ceil(sys/4) + ceil(tools/4)）。
- `packages/agent/src/pi-driver.ts:324-344`：`compactionSettingsFor`——默认臂 `reserve = max(16384, Δ+1024)`，缩放臂 `reserve ≥ Δ+1024`。
- `packages/agent/src/pi-driver.ts:532-618`：`compactTranscriptWithPi`——no_cut 且超 LIMIT 抛错（:553-566）；产物 trim 到 `target = W − reserve`（:598-608）。
- `packages/agent/src/pi-driver.ts:644-712`：`run()` 请求前 INV 复核（:661-686）、emergency 线（:657,701-711）。

## 实测结果（命令：`npx vitest run packages/agent/p0b-preaudit-verify.test.ts`，夹具与既有单测不同：W=40 000、sys≈1.2k 字符、2 个真实工具 schema、8 轮 15k 字符 user/assistant + 当前回合）

### ① 强制压缩前的实际取值（非复述公式）

```
P0B_FACTS {"W":40000,"T":66403,"deltaWorst":4483,"MIN_OUTPUT":1024,"LIMIT":34493,"reserveTokens":16384,"target":23616}
```

- T=66 403（`estimateContextTokens` 实际输出）> LIMIT=34 493 → 夹具确实违反 INV；
- Δ_worst=4 483（=4 096 + sys + tools 实际计算），MIN_OUTPUT=1 024；
- `reserveTokens`=16 384 ≥ Δ+1 024=5 507；压缩 `target`=23 616 ≤ LIMIT=34 493（证明①的机械关系成立）。**PASS**

### ② 强制压缩后估算满足 INV

```
P0B_AFTER {"after":20648,"LIMIT":34493,"messages":7,"head":"【此前会话摘要】…"}
```

`compactTranscriptWithPi(force:true, fixedOverheadTokens:4483)` 产物实际估算 20 648 ≤ LIMIT 34 493，且 < 压缩前 66 403；产物首条为摘要 user 消息 + 保留尾段。**PASS**

### ③ 首条请求路径（run() 请求前复核是否真的拦截）

- **③-a 不可救**（单条 220k 字符当前回合消息 + `completeSimple` 必败）：`driver.run()` → **`streamSimple` calls=0**（请求计数器实测），`result.text=''`，发出 `pi_driver_context_invariant_rejected`。**PASS**（与既有单测同结论但独立夹具/尺寸）。
- **③-b 可救**（①的 66k token 转录）：`driver.run()` → 请求前复核触发 `pi_driver_pre_request_compacted`，随后**捕获第一条 `streamSimple` 实际收到的 llmContext**（systemPrompt+tools+messages 全量序列化）：

```
P0B_FIRST_REQUEST {"actualRequestTokens":21239,"window":40000,"minOutput":1024,"messages":7}
```

实际首请求 21 239 ≤ W − MIN_OUTPUT = 38 976 → INV 在真实请求面上成立；正常回复文本送达。**PASS**

### 附带核实（transformContext 时序的事实更正，登记不改码）

`packages/agent/src/pi-driver.ts:658` 注释称「pi-agent-core 的 transformContext 只在回合内兜底，首条请求前不经过它」。实测依赖源码 `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:178-180`（v0.85.1）：`streamAssistantResponse` 对**每条**请求（含首条）先执行 `config.transformContext` 再 `convertToLlm`。即注释的前提不成立；run() 的请求前复核实际是**纵深防御**（且把 no_cut 异常转为有界空文本失败），不是唯一闸门。行为无缺陷、INV 双闸均实测有效，故按「只审计、真缺陷才修」不改动代码，仅在此登记注释失实。

## 回归

- 删除临时测试后 `npx tsc --noEmit` → 0 错误；`npx vitest run` 全量 → **794 passed / 0 failed**（中途一次 8 failed 为同 worktree 并行 P0-C 修改未完成时的瞬态，复跑即绿；非本审计引入）。
- 产品代码与测试零改动（`git status` 中 `execution-runtime.ts` 修改与 `r5preaudit-p0c.test.ts` 属并行 P0-C 成员，非本审计产物）。

## 结论

P0-B 三项实测全部成立：①压缩前 T/Δ/W/MIN_OUTPUT/LIMIT 实际取值与不变式机械关系一致；②强制压缩产物实际估算 ≤ LIMIT；③首条请求路径在不经过 run() 前置复核兜底失效的场景下，请求前复核确实拦截（不可救 calls=0，可救时实际首请求满足 INV）。未发现行为缺陷；一处注释与依赖事实不符已登记（pi-driver.ts:658）。
