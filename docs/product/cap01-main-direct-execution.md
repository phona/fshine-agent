# CAP-01 · Main / Worker 文件处理与交付能力（v7）

> 状态：**设计稿 v7**。只改文档：不实施、不改生产配置、不合入 integration。
> **v7 的唯一依据是 owner 裁决**：Excel 可流式；**接受 Agent 写临时代码解析**；不做沙箱，用简易保护；当前目标是**捋顺架构 + 上线测试**，不是继续堆功能。
> 因此 v6 的大量机制被删除，不是被优化。

---

## 0. 相对 v6 删掉了什么（因为"允许写代码"而不再需要）

| v6 的机制 | 为什么删 |
|---|---|
| 五个算子（`dedupe/group_sum/filter/select/sort`） | 代码想怎么写就怎么写；**同时消除"长成查询 DSL"的风险** |
| 读上限三层 + `approxTokens` 预告 | 数据不进上下文；只有脚本读，且是流式 |
| 有损检测（zip 扫图表/透视/宏）与"一律拒写" | **永远不改原件**：代码读原件、产出新文件，损坏问题从根上消失 |
| `excel_read` / `excel_transform` / `file_publish` 三工具 | 收敛为 **`run_code` 一个工具 + 交付动作** |
| `artifacts/` + `state=published` + publish 幂等 | 交付是"本轮交付集"，不建产物库 |
| `FileStore` 端口 + 内存/SQLite 双实现 | 直接用现有 `task-store` 的同一个库、一张表 |

**保留**：`fileId`（模型唯一引用）、workspace、副本不改原件、交付失败必须可观测、越权同码、原子写。

---

## 1. 架构（三条线）

```
模型
├─ run_code({ code, inputs:[fileId…], deliver?:[文件名…] })
│     → 宿主：物化输入（只读）→ 子进程执行（cwd=会话 work/）→ 登记输出为新 fileId
│     → 返回：{ exitCode, stdout(截断), outputs:[{fileId,name,bytes}] }
└─ execute_operation({ operation, args })      ← 业务能力，仍归执行层
      → 宿主：args 里的 fileId 换成执行层可见路径 → 适配器 → 执行层

宿主：交付本轮 deliver 的文件（RichChannelReply.files）+ 记录送达成功/失败
```

**职责**：Agent 决定"写什么代码"；宿主只给**一张工作区、一组 fileId、一条交付通道**；执行层仍是唯一能碰平台的地方。

---

## 2. `run_code` 契约

```jsonc
{ "code": "const XLSX=require('exceljs'); …",
  "inputs": ["file_a"],            // 只读，宿主物化到 work/_in/
  "deliver": ["汇总.xlsx"],        // 可选：本轮要交付的文件名（相对 work/_out/）
  "timeoutMs": 60000 }             // 可选，受上限约束
```

返回：
```jsonc
{ "exitCode": 0,
  "stdout": "…（截断，上限常量）…",
  "stderr": "…（截断）…",
  "outputs": [ { "fileId": "file_b", "name": "汇总.xlsx", "bytes": 20480 } ],
  "delivered": [ { "name": "汇总.xlsx", "status": "sent" | "failed" } ] }
```

**硬规则**
- 输入只读：`work/_in/<fileId>.<ext>`，脚本改不动原件（`sha256` 前后校验）；
- 输出目录 `work/_out/`：执行完扫描 → 每个文件登记成**新 `fileId`**（copy-on-register，登记即快照字节，避免 path 漂移）；
- 只有 `work/` 内可读写；`in/`、`artifacts/`、宿主目录一律不可达（路径在宿主侧生成，脚本拿到的路径已经限定）；
- `stdout/stderr` 有上限并截断，**不把数据回灌上下文**——脚本应只打印摘要；
- **产物 = 新文件**，永不覆盖用户原件；因此**不需要有损检测**。

**已实测的实现事实（ExcelJS 4.4.0，5000 行 × 8 列 / 253KB）**
- `readFile` 245 ms、retained heap 14.3 MB、RSS +80 MB；**`readFile` 无 timeout/abort**，`load()` 在 Buffer 拼完后同步跑 → **必须靠子进程 kill 来实现超时**（v7 的子进程模型天然满足）；
- **流式读取可用**：`ExcelJS.stream.xlsx.WorkbookReader`（owner 已确认接受流式）；
- 只判结构（sheet 名、`<dimension ref>`）约 105 ms、临时内存 1.6 MB——脚本想快速探查时用这条，而不是 `readFile`。

---

## 3. 简易保护（**明确不是沙箱**）

| 措施 | 做法 |
|---|---|
| 进程隔离 | 子进程执行，cwd = 会话 `work/`；不带宿主进程内的任何对象 |
| 凭据隔离 | 最小 env：`PATH/HOME/TMPDIR`（复用既有 worker env 白名单），**不含任何 API key / token** |
| 资源上限 | `--max-old-space-size`、墙钟超时、输出字节上限、单次输出文件数上限 |
| 路径限定 | 只给 `work/_in`、`work/_out` 的路径；宿主侧生成，模型与脚本都拿不到别处 |
| 能力限定 | 工具是**数据处理原语**，脚本不得调执行层（执行层仍走 `execute_operation`）；Pi 内置 bash 仍关闭 |
| 审计 | 每次调用记录：脚本 sha256、输入 fileId、输出 fileId、exitCode、耗时、超限原因 |

**明确登记为残余风险**：无 OS 级隔离、无网络阻断（仅靠不传凭据与最小 env）。这是本阶段的取舍，不宣称安全边界。

---

## 4. 文件与事实

- **`fileId`**：模型唯一引用；路径永不进模型。
- **表**（放现有 `task-store`，一张表，不建第二套持久化栈）：

```sql
file_refs(
  file_id TEXT PRIMARY KEY, principal_id TEXT, session_id TEXT,
  task_id TEXT NULL,          -- Task 私有副本
  source_message_id TEXT NULL, attachment_index INTEGER NULL,
  name TEXT, sha256 TEXT, bytes INTEGER,
  state TEXT,                 -- pending | active   （交付不落状态）
  created_at INTEGER,
  UNIQUE(principal_id, session_id, source_message_id, attachment_index)
)
```
- `path` **不落库**：按 `(principal, session, task, file_id)` 布局派生；磁盘文件名用 `file_id`（扩展名取自 `name`）。
- 副本（Task 输入、脚本输出、执行层回程）**一律新 `file_id`**；唯一键只约束"入站原始附件"（`source_message_id` 非空的行），副本行 `source_message_id = NULL`，不冲突。
  **实测确认**：SQLite 的 UNIQUE 把 NULL 视为互不相同（`(p,s,NULL,NULL)` 插两次=2 行），所以副本行不冲突；但**入站幂等只有在 `source_message_id` 与 `attachment_index` 都非 NULL 时才生效**（单附件写 `0`）。
- **迁移口径**：`TASK_STORE_SCHEMA_VERSION` 必须 **4 → 5**；`backupBeforeMigration` 的谓词要扩到"新表缺失"，否则只加表不会备份，且不升版本会因同名 `.backup-v4` 已存在而静默跳过备份。
- **作用域规则（必须写进代码，S0 验收依赖它）**：Main 只解析 `task_id IS NULL` 的行；Worker 只解析 `task_id = 当前任务` 的行。否则 Main 的文件在 Worker 里是可读的，"越权被拒"这条根本测不出。
- 越权 / 不存在 / 过期：**同一错误码 `FILE_REF_UNAVAILABLE`**，不泄漏存在性。

---

## 5. 入站与交付

**入站**：下载 → 算 sha256 → **在 `attachmentOnly` 早退之前**分配 `fileId`（修 `server.ts:257-261` 的现有顺序）→ `state=pending`；用户交办时按 **该消息的 `messageId`** 提升为 `active`（不是"全会话所有 pending 一起激活"）。

**交付**：
- `run_code` 的 `deliver` 名单 → 本轮交付集（内存 Set）→ `TurnResult.files` → handler 返回 `RichChannelReply.files` → adapter；
- **失败必须可观测**：正常回复路径的文件失败当前只 `log wecom_file_fail`（`adapter.ts:681-693`）——**必须改成向 Host 返回失败事实**（catch 或返回值，二选一，S1 内定），用户得到"文件未送达"话术；
- 三种事实分开：**产物存在 ≠ 任务成功 ≠ 文件送达**；
- 文本只给文件名，不给路径。

---

## 6. 与执行层的关系

- 文件要交给执行层（例如浏览器上传）：宿主把 `fileId` **物化**到 `<platformRoot>/tmp/task_<id>/`，在 dispatch 时把 args 里的 `fileId` 换成**相对平台根的路径**。
- **翻译位置（实测约束）**：
  1. 只有两处 `client.execute`——inline `execution-runtime.ts:711`、background `:1132`；Main 没有 execute 路径；
  2. `request.args` 是 `Readonly<Record<string, unknown>>` → **不能原地改**，构造新对象 `{...request, args: {...request.args, [key]: relPath}}`；
  3. **翻译必须在 `claimAndRunOperation` 之前**（`:703`/`:1122`），否则复制失败会被记成 `call_interrupted` → 任务落 `result_unknown`（错误分类）；文件桥的失败应是普通 `UserError`。
  4. `RuntimeOptions` / `TaskExecutorOptions` 目前**没有 `platformRoot`**（只有 `workerWorkspaceRoot`，语义不同）→ 必须显式新增，不要复用。
- **参数声明**：实际声明位置是 `fixtures/platforms/<p>/capabilities.json` 的 `args.flags[].style`（不是 `operations.json`）；`declaredArgsOf` 已把 `style` 投影成 `type`，`style:"file"` 能通过现有 `lint-operations.js` 与 loader 校验。但**借用 CLI 的 `style` 表达行为语义不对**——建议改用专用字段（如 `kind:"file"`），并**同步修改** `execution-contract.ts` 里"type 只作展示、不参与业务判断"的注释，否则后来者会照注释删掉它。
- 执行层返回文件：`data.files[{name,path,…}]` → 宿主登记成新 `fileId`、剥掉 `path`；出现内联 base64 一律剥离并记事件。
  **翻译点不能放适配器**（`dummy-cli-client.ts` 自述"只翻译不裁决"，且依赖 core 会把 better-sqlite3 拖进适配器值闭包）→ 放在**装配层装饰器**（`defaultExecutionFace` 处包一层 `ExecutionClient`）或 **runtime 出口**（`:711`/`:1132` 拿到 outcome 后、返回给驱动前）。
  **background 模式要注意**：server 解析执行面两次（`:134-150` 与 `:175-190`，后者未传 face）→ 是两个 client；`FileStore` 与装饰器必须是**同一个实例**注入两处，否则入站登记与出站查找分叉。

---

## 7. 阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **S0** | 依赖 `exceljs`；`file_refs` 一张表 + 派生路径；workspace；`run_code` 子进程执行器（三条上限 + 最小 env + 审计）；Main/Worker 双侧接入 | 12 行 Excel：脚本读原件、产出新文件、**原件 sha256 不变**；超时/超内存被拒且有可读原因；Worker 拿到 Main 的 `fileId` 被拒 |
| **S1** | 入站（含 `attachmentOnly` 顺序修复 + 按 `messageId` 提升）、清单注入、交付链路 + **失败可观测** | 用户上传 → "去重后按客户汇总" → **不建 Task** → 收到文件；**故意让文件发送失败 → 用户看到"未送达"，系统记录失败** |
| **S2** | `run_task.inputFiles`、Task 副本（新 `file_id`）、Worker 同工具、`type:"file"` 桥、执行层回程登记 | Worker 用 `run_code` 处理 → 脚本内不调执行层 → 产物回 Main → 交付；5000 行文件**流式处理**（内存峰值可测、上下文不增长） |

**判据分层**：Runtime 只判机械项（exitCode、超时、字节/份数、原件 sha256、归属）｜Eval Oracle **重新解析输出文件**判业务正确性（去重集合、客户汇总）。

---

## 8. 不做

自研 Excel 解析器 ｜ 算子词表 / 查询 DSL ｜ 有损检测与 zip 扫描 ｜ 沙箱 / 容器 / 网络命名空间 ｜ 文件 Worker ｜ Direct/Delegate Router ｜ 文件权限平台 ｜ 产物库与跨天重发 ｜ `transport` 分层 ｜ 版本握手 ｜ PDF/Word ｜ 真实 SaaS 写入。

---

## 9. 残余风险（登记，不宣称已解决）

1. 代码**无 OS 级隔离、无网络阻断**——只靠最小 env + 工作区路径 + 资源上限；
2. 脚本是模型生成的 → **不保证确定性**，Eval 必须判输出文件、不判脚本；
3. `run_code` 与"任意代码执行"只差一层措辞，边界靠**能力描述 + 不传凭据 + 不通过它编排执行层**维持；
4. 大文件仍受宿主内存与超时限制；"流式"能压低峰值，不消除时限；
5. 交付失败的可观测依赖 adapter 改造（回复路径当前吞错），S1 内必须落地。

---

## 10. 复核后补充的实现约束（v7，来自可实现性实测）

1. **`unexecuted` 是终态**：Worker 只做文件、没碰平台 → 任务判 `unexecuted`。**Host 必须对 `unexecuted`/`failed` 也做一次产物收集**，否则"纯文件误委派"会丢产物。
2. **共享 dispatch 不能合成一个函数**：Main 是**路由器**（`run_task`/`task_*`/`read_skill`），两个 Worker 是**执行器**（差异仅 `runOperation` vs `claimAndRunOperation`、`onUnresolved`、是否记 `executed`、scope 来源）。拆成 `createToolDispatcher(handlers)` + `runDeclaredOperation({...})`；同时扩 Worker 工具面（`:859`、`:1159`）与 exec 路由（`:740`、`:1112`）——这两处文档原来没列。
3. **`exceljs` 的 `readFile` 没有超时/中止**：v7 的子进程模型用 kill 兜住；但要接受"解析是 CPU-bound 同步"，单用户可接受，S3 并发门再谈 worker thread。
4. **`stripServerPaths` 生产路径零消费**：终稿出口必须调一次，否则 `tmp/task_<id>/…` 会随回复发给用户。
5. **交付链要落的具体文件**：`TurnResult`（`execution-runtime.ts:301-307`）加 `files`；handler（`server.ts:274-297`）返回 `RichChannelReply`；`main.ts:42-47` 先建 server 后建 channel → 需要注入投递端口或调整构造顺序；失败要能在**回复路径**上被捕获（当前 `adapter.ts:681-693` 只 log）。
