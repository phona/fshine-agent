# CAP-01 · Main / Worker 文件处理与交付能力（v8）

> 状态：**设计稿 v8**。只改文档：不实施、不改生产配置、不合入 integration。
> v7 → v8 依据：四路独立复核（执行器安全 / 交付链 / 复杂度 / 边界）+ 本机实测。
> **核心变化**：用 **Node 24 权限模型**（`--permission`）把代码执行约束成"只能读写 run 目录"——不再靠"最小 env"这种假保护。

---

## 0. 一句话

给 Main 和 Worker 一个**受限的 `run_js` 工具**加一张宿主管理的工作区：Agent 写代码处理用户上传的文件，产物经宿主登记、用现有渠道交付；**不建沙箱、不建文件平台、不改 Execution Contract**。

---

## 1. 架构：四个实名

| 实名 | 落点 | 只负责 |
|---|---|---|
| **装配层** assemble | `scripts/ask-runtime.ts`、`apps/server/server.ts`、`apps/server/main.ts` | 构造 fileStore 与 `runJsExecutor` 并注入；持有投递端口；不写业务 |
| **会话运行时** runtime | `packages/agent/src/execution-runtime.ts` | exec 闭包、`fileId` 解析、`run_task`/任务工具；不 import 渠道类型、不直接 spawn |
| **文件区监管** fileStore | `file_refs` + workspace 布局 + 物化/登记/清理 | **唯一**写文件事实的地方 |
| **渠道适配** channel | `packages/channel-wecom/src/adapter.ts` | 只收发字节与回执；不做裁决 |

**`run_js` 的 spawn 归谁**：runtime **不 spawn**（`import-boundary.test.ts:189` 禁止 runtime 值闭包出现 `node:child_process`）。用**注入端口**：

```ts
// RuntimeOptions / TaskExecutorOptions 增加
runJsExecutor: (input: RunJsInput) => Promise<RunJsOutput>
// 实现在 packages/agent/src/run-js-executor.ts（可 import worker-env），
// 只在 assemble 构造并注入；把该文件加入 import-boundary 的 ENTRIES 审查面，
// 并更新 worker-env.ts:17「唯一的执行层子进程面」注释（现在有两个子进程面）。
```

---

## 2. `run_js` 契约

```jsonc
{ "code": "const XLSX = require('exceljs'); …",   // CommonJS，写进 run 目录的 run.cjs
  "inputs": ["file_a"] }                          // 只读，宿主物化到 <run>/in/
```

返回：
```jsonc
{ "exitCode": 0,
  "stdout": "…（流式截断）…", "stderr": "…（流式截断）…",
  "outputs": [ { "fileId": "file_b", "name": "汇总.xlsx", "bytes": 20480 } ] }
```

**没有 `deliver` 参数、没有 `timeoutMs`、没有 `delivered` 返回**：
- **`<run>/out/` 就是交付箱**——里面每个文件都登记并**本轮交付**；中间文件写 `<run>/scratch/`；
- 超时/上限是宿主常量，模型只能把请求调小；
- 交付发生在回合末（§7），工具返回时不可知。

**目录（每次调用独立，不共享）**
```
<workspace>/<h>/<s>/runs/<runId>/in      只读输入（fileId 物化）
                              /out       交付箱（写；宿主扫这里）
                              /scratch   中间文件（写；永不当产物）
```

---

## 3. 简易保护：Node 权限模型（**实测有效，不是沙箱**）

```
node --permission \
     --allow-fs-read=<runDir> \
     --allow-fs-read=<repo>/node_modules \
     --allow-fs-write=<runDir>/out \
     --allow-fs-write=<runDir>/scratch \
     <runDir>/run.cjs
```

| 实测项（Node v24.20.0） | 结果 |
|---|---|
| 读宿主 `.env` | **ERR_ACCESS_DENIED**（无权限模型时可读 1594 字节） |
| 调 `child_process` | **ERR_ACCESS_DENIED**（连 spawn 执行层网关都被拦） |
| 写未授权目录 | ERR_ACCESS_DENIED；授权 `out`/`scratch` 后可写 |
| `require('yaml')`（NODE_PATH + 授权 node_modules） | **正常** |
| `fetch` | **未被拦**（网络仍是洞） |

**env**：只给 `PATH` + `NODE_PATH=<repo>/node_modules`；`HOME`/`TMPDIR` 指向 `runDir` 下的空目录，**不给真实 HOME**，不带任何 `LLM_*`/`WECOM_*`/`NODE_OPTIONS`。
**进程管理**：`detached:true` + `spawn`；超时/中止 `kill(-pid,'SIGKILL')` 杀**进程组**（`SIGTERM` 在同步 CPU 循环不可靠，孙进程会逃逸）。
**输出**：`stdout/stderr` 在 `data` 回调里计数，超限即丢弃并标 `truncated`（不要先全读再截）。
**产物登记**：`lstat` 只收普通文件、拒 symlink/hardlink（`nlink===1`）、uid 校验、大小与份数上限；从**同一个 fd** 流式读字节做 copy-on-register。

**如实登记的残余风险**
1. **网络未阻断**：脚本可外传它能读到的内容（已限制在 runDir + node_modules + 注入输入）；
2. 无 OS 级隔离（Node 权限模型不是容器）；
3. 提示注入仍可驱动模型写恶意代码——但它读不到 `.env`，最坏是写坏产物；
4. 文件类型检查不是机密性边界。

---

## 4. 文件事实（8 列）

```sql
file_refs(
  file_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, session_id TEXT NOT NULL,
  name TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
  activated_at INTEGER NULL,        -- NULL = pending；非 NULL = 可读（同时是 TTL 起点）
  created_at INTEGER NOT NULL
)
-- S2 追加：task_id TEXT NULL（Worker 只解析当前任务；Main 只解析 task_id IS NULL）
```

- **没有 `state` 枚举**：`activated_at IS NULL` 即 pending。
- **不存 `path`**：按 `(principal, session, task, file_id)` 派生；文件名用 `file_id`（扩展名取自 `name`）。
- **暂缓** `source_message_id` / `attachment_index`：当前企微文件消息一条一个文件；跨重启重投靠 TTL 清孤儿。
- **暂不升 schema 版本**：纯新增表走 `CREATE TABLE IF NOT EXISTS`；若坚持升版本，只改 `backupBeforeMigration` 谓词。
- **越权/不存在/过期同码** `FILE_REF_UNAVAILABLE`（防存在性 oracle）；内部另记机械 `reason` 只进日志，不进用户话术。

**激活语义**：**带文字的消息激活本会话全部 pending 文件**（TTL 内），**不按 messageId**——指令消息本身不带附件，按 messageId 永远找不到。

---

## 5. 幂等：进程内 Map，不建表

`run_js` 不在 U3 `dispatchKey` 窗口内。用**进程内 Map**：

```
key = (principalId, sessionId, turnNo, sha256(code), sorted(inputFileIds))
value = { exitCode, outputs }
```

- `turnNo` 是进程内回合号（`execution-runtime.ts:526`）；**Pi 原生重试不产生新 `send()`**，重试同键 → 命中不重跑；
- **不要用 `attempt`**（`:363-377` 每个 recovery +1）——那会让每次重试换键、脚本跑两遍；
- `send()` 的 `finally` 清空 Map；
- **跨重启不保证**：重启后渠道重投是新回合，重新执行是正确行为。文档明确写"S1 只保证进程内、同一回合的交付"。

---

## 6. 与执行层：不进契约

- 文件交给执行层：assemble 把本任务输入物化到 `<platformRoot>/tmp/task_<id>/`，**执行层声明一个目录参数**（如 `--input-dir`），宿主替换该值。
  **不引入 `kind:"file"`**——`execution-contract.ts:41-43` 写着 type 只作展示、`:61` 写着 args 对宿主不透明；按 kind 遍历 args 会让宿主"看懂"args，是契约蔓延的起点。
- 翻译位置：**assemble 装饰器**（持有 `platformRoot`），不是 runtime 出口。
- 执行层返回文件：`data.files[...]` → **runtime 出口**登记成新 `fileId`、剥 `path`、剥离内联 base64。**不能在适配器登记**（适配器拿不到 scope，且会依赖 core 的 sqlite）。
- **background 会解析执行面两次**（`server.ts:134-150`、`:175-190`）→ fileStore 与装饰器必须**同一实例**注入两处。

**Native vs MCP 判据（补回）**：本地数据文件 → `run_js`；平台/SaaS 副作用 → `execute_operation`；MCP = 未来外部协议客户端，**未准入**。

---

## 7. 交付：主动投递（B），失败必须可见

```
run_js 产出 → fileStore 登记 → 回合末 TurnResult.files（中性类型）
   → handler 只返回 text；文件由 assemble 注入的 fileDelivery.sendToConversation() 发出
   → 成功/失败事实 + 用户可见话术
```

```ts
// execution-runtime.ts 内定义，不 import 渠道类型
export interface TurnFileRef { fileId: string; name: string; bytes: number }
// TurnResult 增加可选 files?: readonly TurnFileRef[]
```

**为什么选 B**：回复路径的文件失败**只 log 不抛**（`adapter.ts:681-693`，有测试钉住），拿不到失败信号；主动投递同步抛 `WecomChannelDeliveryError`（带 `receipt.parts`，逐文件可知）。改动量 2 个生产文件 + 1 个测试（A 是 3–4 个 + 契约 + 2 个测试）。

**必守四条**
1. handler **只返回 text**，主动投递**只传 files**——否则文本发两遍；
2. **"只有文件、正文为空"不能判回合失败**（改 `server.ts:279-281`），否则走不到投递；
3. **`deliveryMode` 非 `live` 记 `suppressed`，不许记 `sent`**（silent 闸让上传返回成功但用户看不到）；S1 验收跑 `live`；
4. 无投递端口时 **fail-closed**（"文件未送达（当前渠道不支持文件投递）" + `delivery_unavailable`）。

**失败事实**：结构化事件 + 用户话术；**S1 不建表**——没有"重发"消费者，建表就是没有消费者的状态。跨重启查询若将来需要，再加 `delivery_facts`。

**出口清理**：`stripServerPaths` 在 `execution-runtime.ts` 返回前调用一次（覆盖 `ask`/server/`task_result`）；剥完为空且有文件 → 宿主话术"文件已生成（见附件）"。

---

## 8. 阶段（重切）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **S0** | `exceljs` 依赖；`file_refs` 一表；workspace/run 目录；`run-js-executor`（权限模型 + 进程组 kill + 输出截断 + 产物扫描 + 审计）；**不接 Main、不接渠道** | 直接插一行 `file_refs` → 脚本读 `in/`、写 `out/` → 产物登记成新 `fileId`、**原件 sha256 不变**；读 `.env` 被拒；`child_process` 被拒；超时被进程组 kill |
| **S1** | Main 接 `run_js`；入站登记（**修 `attachmentOnly` 早退在查重之前**）；清单注入；交付（B）+ 失败可观测 | 用户传 12 行 Excel + 一句话 → **不建 Task** → 收到文件且内容正确（Oracle 重解析）；**故意让投递失败 → 用户看到"未送达"、系统记失败、不记 sent** |
| **S2** | `run_task.inputFiles`；Task 副本（新 `file_id`）；Worker 接 `run_js`；执行层目录参数桥；回程登记 | Worker 处理 → **数据不进任何模型上下文**（工具参数里无行数据）→ 产物回 Main → 交付 |

**S0 的"Worker 越权被拒"挪到 S2**（v7 写错了：Worker 工具面到 S2 才加）。
**并发**：缺省 `mainConcurrency=1`/`queueCapacity=0`，一个 60s 脚本期间其它会话会被 `queue_full` 拒；`timeoutMs` 按这个成本定（S3 再谈并发）。

---

## 9. 不做

自研 Excel 解析器 ｜ 算子词表 / 查询 DSL ｜ 有损检测 ｜ 沙箱 / 容器 / 网络命名空间 ｜ 文件 Worker ｜ Router ｜ 文件权限平台 ｜ 产物库与跨天重发 ｜ `transport` 分层 ｜ `kind:"file"` 契约字段 ｜ `run_code_runs` 第二张表 ｜ PDF/Word ｜ 真实 SaaS 写入。

---

## 10. 复核后仍开放的四条（已给处置，不需再讨论）

1. **`_in` 可写**：脚本能改输入再改回（`sha256` 只能发现）。处置：`in/` 与 `out/` 分目录，写权限只给 `out`/`scratch`（Node 权限模型支持）。
2. **宿主同步登记会阻塞**（50MB 哈希 30ms）：处置：copy-on-register 走流式 + 异步。
3. **`unexecuted` 会丢产物**：处置：Host 对 `unexecuted`/`failed` 也扫 `out/`（S2）。
4. **background 交付链**：处置：S2 若含 background，`TaskExecutionInput/Outcome` + 受理回执一并改；否则 S2 明确只做 inline。

---

## 11. Owner 裁决（2026-11-17）

| 事项 | 裁决 |
|---|---|
| **网络未阻断** | **接受**。不做 `fetch`/`net` 的 preload patch（可绕过、属极限防护）；如实写进残余风险即可 |
| **防护强度** | **有基础防护就够**：Node 权限模型 + 进程组 kill + 输出截断 + 产物类型校验 + 最小 env；不追求 OS 级隔离/网络命名空间 |
| **`run_js` 开放范围** | 对业务用户开放；残余风险按 §3 登记，不额外降级 |
| **交付失败事实** | **只留结构化事件 + 用户话术，不建表**；将来需要"哪次没送达"可查时再加 `delivery_facts` |
| 超时/内存/份数/字节数值 | 由 S0 实测后写死，不再单独裁决 |
