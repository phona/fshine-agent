# CAP-01 · Main / Worker 通用文件处理能力（v6）

> 状态：**设计稿 v6**。只改文档：不实施、不改生产配置、不合入 integration。
> 范围：**S0 + S1 + S2**（主路径、委派、文件到执行层）。S3 是并发硬化门，单列。
> v5 → v6 依据：四路独立复核（可实现性 / 复杂度 / 边界 / 数据流）+ owner 三条裁决（算子词表 / 含 S2 / 路径空间分开）。

---

## 0. 决策摘要

| 项 | 决定 |
|---|---|
| 文件能力 | fshine 自有 TypeScript Native Tools（ExcelJS），**Main 与 Worker 共用** |
| 工具数 | **3 个**：`excel_read` / `excel_transform` / `file_publish` |
| 清洗由谁做 | **工具内算子**（模型只给列名与算子），**数据不进模型上下文** |
| 算子词表 | `dedupe` / `group_sum` / `filter` / `select` / `sort`（不够再补） |
| 模型可见引用 | **只有 `fileId`**；路径永不进模型 |
| 文件到执行层 | 宿主**物化副本**到 `<platformRoot>/tmp/task_<taskId>/`，并在 dispatch 时把 `fileId` 翻译成执行层可见路径 |
| 有损文件 | **一律拒写**（图表/透视/宏/外部链接/`.xlsm`），不做确认凭证 |
| 交付 | Host 驱动：`TurnResult.files` → `RichChannelReply.files` → **catch `WecomChannelDeliveryError`** |
| 删除 | `transport` 字段与工厂、版本握手、方言探测、投影收敛、`lossyConfirm`、六状态机、`file_list` |

**三条 owner 裁决**：①算子五个够用；②范围含 S2（不留尾巴）；③路径空间各自独立，由宿主翻译。

---

## 1. 能力模型

```
模型只看到工具
├─ 车道 A（业务）：execute_operation({operation, args})
│     → run 级 exec 闭包：校验 allowed → 把 args 里的 fileId 翻译成执行层路径（若是文件参数）
│     → ExecutionClient.execute() → 适配器 → 执行层
└─ 车道 B（文件）：excel_read / excel_transform / file_publish
      → 同一个 exec 闭包：fileId → 宿主 workspace 路径 → 进程内 ExcelJS 跑算子
```

**两条车道共用同一个 run 级 `exec` 闭包**——注意：现有代码里其实是**三个**闭包（Main `:918-957`、inline Worker `:687-743`、background `:1111-1152`），其中两份门控逻辑已漂移。v6 要求**先抽成一个共享的 tool-dispatch 函数**，三处只做薄调用（否则三个文件工具要各写三遍）。

---

## 2. 三个工具

### 2.1 `excel_read(fileId, {sheet?, range?, page?, sample?, columns?})`

- **首屏**（不填 `range`）返回：`{sheets, rowCount, columnCount, pageSize, approxTokens, lossyItems, truncated, pageSize}`——**模型在决定"读多少"之前就知道代价**；
- **默认分页**（`PAGE_ROWS`），`sample` 用于探索（前 N / 尾 N / 随机 N），`columns` 只取需要的列；
- `lossyItems` 来自 **zip 条目扫描**（ExcelJS model 里没有图表/透视对象）：`xl/charts/*`、`xl/pivotTables/*`、`xl/vbaProject.bin`、`xl/externalLinks/*`、条件格式/数据验证节点。

**三层防爆（工具强制，不靠模型自觉）**

| 层 | 规则 |
|---|---|
| 调用级 | `range: 'all'` 仅在 `rowCount ≤ FULL_READ_MAX_ROWS` **且** `approxTokens ≤ FULL_READ_MAX_TOKENS` 时允许；否则**拒绝**并给下一步：`{error:'FILE_TOO_LARGE_FOR_FULL_READ', hint:'用 sample 抽样，或直接用 excel_transform 做 dedupe/group_sum'}` |
| 响应级 | 同时限**行数**与**序列化字节**（`MAX_RESPONSE_BYTES`）；超限 → `truncated: true` + `nextPage`，绝不静默少给 |
| 策略级 | 清洗由算子完成，模型**很少需要全量**：判断结构用 `sample`、改数据用 `excel_transform`、解释结论只读结果那一小部分 |

**常量（S0 用真实文件实测后写死）**

| 常量 | 建议初值 | 依据 |
|---|---|---|
| `PAGE_ROWS` | 100 | 一页够判断趋势 |
| `SAMPLE_ROWS` | 20 | 探索 |
| `FULL_READ_MAX_ROWS` | 300 | 300×8 列 ≈ 15–20k tokens |
| `FULL_READ_MAX_TOKENS` | 20_000 | 与行数**双闸**，两者同时判 |
| `MAX_RESPONSE_BYTES` | 64 KB | 兜住"12 行但每格 5000 字" |

判据：一次全读不得吃掉窗口 1/3 以上——否则下一次调用就触发压缩，等于拿 Pi 的压缩当缓冲垫。

### 2.2 `excel_transform(fileId, ops[], {outName?, deliver?})`

**这是 v6 的核心变化**：清洗由算子完成，模型不转录数据。

```jsonc
{ "fileId": "file_a",
  "ops": [
    { "op": "dedupe",    "by": ["客户","单据号","金额","日期"] },   // 或 by: "row"
    { "op": "filter",    "column": "金额", "cmp": "gt", "value": 0 },
    { "op": "group_sum", "by": ["客户"], "sum": "金额", "as": "合计" },
    { "op": "select",    "columns": ["客户","合计"] },
    { "op": "sort",      "by": ["合计"], "dir": "desc" }
  ],
  "outName": "汇总.xlsx",
  "deliver": true }
```

**约束（防 DSL）**：
- 只有上述五个算子，参数只能是**列名 / 字面量 / 比较符**，**不允许表达式、不允许嵌套、不允许自定义函数**；
- 算子按数组顺序执行，**前一个的输出是后一个的输入**；
- 输入永远是 `in/` 或上一个副本（COW），**原件只读**；
- 返回：`{fileId: <新副本>, name, rowCount, bytes, lossyItems, published?: <artifact fileId>}` ——**不返回数据内容**。

### 2.3 `file_publish(fileId, {name?})`

- 只登记，**不直接交付**；Host 校验（可打开 / 大小 / 份数）后写 `artifacts/`；
- 同名自动加后缀；**本轮内以 `sourceFileId + 逻辑名` 幂等**（重复 publish 不产生第二份）；
- 返回 `{artifactId, name}`，**不返回路径**。

### 2.4 选择判据

看结构 → `excel_read`（`sample` 够用，不要整表）；要改数据 → `excel_transform`；要交付 → `deliver: true` 或 `file_publish`。
**不再有 `file_list`**：文件清单由 Host 每回合从 `file_refs` 重新生成并注入（只读投影，不消费缓冲）。

---

## 3. 文件分区与"文件怎么到执行层"

```
宿主数据目录/
└── workspaces/<h>/<s>/           # h=sha256(principalId\0sessionId) 截断；不含明文
    ├── in/        原始附件（只读，sha256 记录）
    ├── work/      工作副本（读写；算子输出落这里）
    ├── tasks/<taskId>/{in,work}
    └── artifacts/ 已发布产物（Agent 不可写，Host 独占）

<platformRoot>/
└── tmp/task_<taskId>/            # 执行层可见区（cwd=platformRoot；唯一名；TTL 清理）
```

**这两处路径空间互不重叠，也不需要重叠。** 桥只有一条：

1. 操作参数在 `operations.json` 里声明 `type: "file"`；
2. 模型传 `fileId`；
3. **宿主在 dispatch 时**：把 `fileId` 复制到 `<platformRoot>/tmp/task_<taskId>/<唯一名>`，把 args 里的 `fileId` 换成**相对平台根的路径**，再调 `client.execute()`；
4. 反向：执行层产出文件落在同一目录，宿主在任务收口时收集 → 登记 → 可交付。

结果：**模型永不见路径；执行层不改代码；跨用户隔离由宿主按任务生成路径保证。**

**这条是 v6 唯一需要执行层配合的改动**：给 args 加一个 `type: "file"` 声明（纯声明，不是机制）。

### 3.1 执行层返回文件（入站桥，与出站对称）

执行层必然会把文件交回来（ERP 导出、报表下载）。**它不得返回文件内容**，只返回结构化句柄：

```jsonc
// ExecutionOutcome.data 里（约定字段，不改契约）
{ "status": "completed",
  "files": [ { "name": "对账单.xlsx", "path": "tmp/task_<id>/对账单.xlsx", "bytes": 20480, "sha256": "…" } ],
  "summary": "已导出" }
```

**宿主在适配器出口做三件事**（**唯一翻译点，Main 与 Worker 同样生效**）：
1. 句柄 → 登记 `file_refs` 新行（`state=active`，`parent_task_id` 指向当前任务）→ 得到 `fileId`；
2. 把返回给模型的 `files[]` **替换成** `[{fileId, name, bytes}]`——**剥掉 `path`**；
3. 结果里若出现 base64 / 大字节数组 → **剥离并记 `executor_inline_bytes_stripped`**，不塞进转录。

**规则**
- 单次结果的文件数上限（常量，超出拒绝而不是截断）；
- 同一 `path` 在同一个 Task 内重复出现 → 幂等（同 `sha256` → 同 `fileId`），避免重复登记；
- 文件字节的取用永远经 `excel_read`/`excel_transform`，**模型拿不到内容本身**；
- Worker 收到的执行层结果同样经过这一步——否则路径会进 Worker 转录。

**为什么放在适配器出口**：`driver-contract.ts:50` 写明「返回 data 原样进入转录」，`pi-driver.ts:321` 是无截断 `JSON.stringify`。**上游不翻译，就一定会进上下文**——这是唯一能机械保证的位置。

---

## 4. `file_refs`（3 状态）

```sql
file_refs(
  file_id       TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  task_id       TEXT NULL,              -- 副本行：属于哪个 Task
  parent_file_id TEXT NULL,             -- 副本/产物血缘（无消费者则留空，不做查询）
  source_message_id TEXT NULL,          -- 入站幂等
  attachment_index  INTEGER NULL,       -- 同一消息多附件
  name TEXT, sha256 TEXT, bytes INTEGER, path TEXT,
  state TEXT NOT NULL,                  -- pending | active | published
  created_at INTEGER NOT NULL,
  expires_at INTEGER NULL,
  UNIQUE(principal_id, session_id, source_message_id, attachment_index)
)
```

- **只有三个状态**：`pending`（入站未消费）→ `active`（可读可算）→ `published`（已登记产物）。
  `expired` 不做状态：清理**直接删行**；`unavailable` 不做状态：访问时 `stat` 失败即派生，返回固定话术 `FILE_REF_UNAVAILABLE`。
- **每次派生副本（算子输出、Task 输入副本）都是新 `file_id`**——这样"同一文件给多个 Task"天然成立，不需要 per-task 消费状态。
- `published` 不设 TTL（保住"再发一份"），但受容量上限约束。
- **写点唯一**：与 `task-registry` 同构——`FileStore` 端口 + 内存/SQLite 两实现，装配注入。

---

## 5. 入站

1. 渠道下载 → 暂存 → **先算 sha256**；
2. **在 `attachmentOnly` 早退之前**完成分配与幂等检查（现有 `server.ts:257-261` 在去重之前 return，重投会重复分配——必须修）；
3. 分配 `fileId`（`state=pending`），按 `UNIQUE(principal, session, source_message_id, attachment_index)` 幂等；
4. 用户交办 → 复制进 `in/` → `state=active` → 清单注入（文件名/大小/fileId，每回合重算）；
5. 失败：`pending` 保留可重试；下载失败必须给用户可见话术（不再空返）。

**已知约束**：渠道附件等待 8s、入站上限 32MB——大文件下载可能超 8s，用户后续指令会被拒；这条先在文档登记，不改渠道行为。

---

## 6. S2 委派

```jsonc
run_task({ task: "...", inputFiles: ["file_a"] })
```
- Host：校验归属 → 建 Task 副本（**新 file_id**，sha256 在**目标字节**上校验）→ 注入 Task workspace → Worker 用同一套工具；
- Worker **没有** `file_publish`（产物由 Host 在收口时收集）；
- 待执行层操作时，按 §3 的桥物化到 `platformRoot/tmp/task_<id>/`。

**改动清单（7 处，不是 4 处）**
1. `RUN_TASK_TOOL_SCHEMA`（`execution-runtime.ts:57-74`，`additionalProperties:false`，不改直接拒）；
2. inline 回执（`:877`）与 background 受理回执（`:804-811`）；
3. `TaskRecord` + `TaskRecordView`（`task-registry.ts:173-200`）；
4. `tasks` 表迁移（`packages/core/src/task-store.ts:405-425`，版本推进 + `backup` 谓词要覆盖新表）；
5. `taskResult`（`execution-runtime.ts:577`）+ `statusView`；
6. `TaskExecutionInput` / `TaskExecutionOutcome`（`task-runner.ts:183-192, 211-221`）——background 的产物回程；
7. `renderWorkerDelegation`（`:330-362`）——把副本 fileId 交给 Worker。

**任务判据（划线）**：零 `execute_operation` 的任务仍判 `unexecuted`/`failed`，**不扩 `judgeReportedTask`**。
因此：**纯文件任务（不碰平台）由 Main 直接做；委派给 Worker 的任务必须包含执行层动作。** 这是 S2 的准入条件，不是缺陷。

---

## 7. 交付（Host 驱动）

```
算子/发布 → work 或 artifacts → 本轮晋升集合（内存 Set，不落 manifest）
  → TurnResult.files → server handler 返回 RichChannelReply.files[]
  → adapter 发送；失败抛 WecomChannelDeliveryError → Host catch → delivery_failed（用户可见）
```
- **`DeliveryReceipt` 只有成功态**，失败必须 `catch`；另有同名 `DeliveryReceipt`（`notifications.ts`）**不要混用**；
- `main.ts` 是"先建 server 后建 channel"——需要注入**投递端口**（或把 channel 构造提前），不能直接调 adapter；
- 文本只给**文件名**，不给路径；`stripServerPaths` 在终稿出口统一调用一次；
- **产物存在 ≠ 任务成功 ≠ 文件送达**，三者分别记录，不互相推断。

---

## 8. 执行层接口（从本切片移出）

v5 的三条（投影收敛 / 版本握手 / 方言探测）**移出 CAP-01**，登记为「接真实执行层前置条件」：
宿主适配器已只投影 `name/label/args`（`declaredArgsOf`），**无真实泄漏**；握手要执行层先声明版本，属另一个仓库的事；方言探测只有一个 adapter，等于自测。

**本切片只需一条声明扩展**：`operations.json` 的 args 支持 `type: "file"`（§3）。

---

## 9. 有损与安全

- **有损一律拒写**：zip 条目检出 `xl/charts/*`、`xl/pivotTables/*`、`xl/vbaProject.bin`、`xl/externalLinks/*` → `excel_transform` 拒绝并说明；**`.xlsm` 一律拒写**；
- **不做 `lossyConfirm` 凭证**（模型算不出 sha256；Worker 拿不到用户原话）；
- 上限常量：单文件字节、解压后字节、单页行数、单次算子输入行数、超时——**S0 用真实文件测出并写死**；渠道入站 32MB，不要写永远触发不到的阈值；
- ExcelJS 在宿主进程解析用户文件（zip/内存炸弹面）：解压后大小上限 + 解析超时是**必须**的；
- 只接受 `fileId`；`resolve + realpath` 拒逃逸与符号链接；原子写（临时文件 + `rename`，单卷）。

---

## 10. 不做

自研 Excel 解析器 ｜ Excel MCP ｜ 独立 File Worker ｜ Direct/Delegate Router ｜ 文件权限平台 ｜ 通用工作流引擎 ｜ 任意 shell/代码执行 ｜ 文件共享协作 ｜ PDF/Word ｜ 公式计算引擎 ｜ `transport` 分层（本轮）｜ 表达式查询 DSL。

---

## 11. 阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **S0** | 依赖（ExcelJS + zip reader）、`FileStore` 端口 + 内存/SQLite、workspace 根与 hash、sha256、三个工具的**静态声明**、共享 tool-dispatch 抽取 | Main/Worker 各自可读写；原件 sha256 不变；**Main 的 fileId 在 Worker 上下文被拒**；工具定义**不随回合变化**（会话重建计数 = 0）；解压炸弹被拒 |
| **S1** | 入站（含 `attachmentOnly` 去重修复）、Session workspace、算子、产物登记、Host 驱动交付 | 12 行 Excel：**不建 Task** → 去重+按客户汇总 → 用户收到文件且 `delivery_succeeded`；原件 sha256 不变 |
| **S2** | `run_task.inputFiles`、Task 副本、Worker 同工具、`type:"file"` 桥、产物回程 | Worker 用算子处理 → **数据不进任何模型上下文**（证据：工具调用参数里无行数据）→ 调执行层 → 产物回 Main → 交付 |

**S3（单列硬化门，不在本切片的"完成"定义内）**：多 principal / 多 Session / 多 Task 并发、伪造/过期 fileId、交付失败、进程中断。**前置：显式抬 `backgroundConcurrency`/`queueCapacity`**，否则并发用例会以 `resource_limited` 假绿。

**判据分层**：Runtime 机械（可打开 / 上限 / 公式形态 / sha256 / 归属 / 路径）｜Eval 业务 Oracle（去重集合、客户汇总——**重新解析输出文件**，不判回复文本）。

---

## 12. 待定

1. 算子词表是否只这五个（owner：够，不够再补）→ 已定。
2. S3 是否并入本切片（现按单列硬化门处理）。
3. `type: "file"` 声明扩展的执行层落地时间（影响 S2，不影响 S0/S1）。
4. 具体上限数值（S0 实测后写死）。
