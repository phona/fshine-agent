# CAP-01 · Main / Worker 通用文件处理能力（v5）

> 状态：**设计稿 v5**。只改文档：不实施、不改生产配置、不合入 integration。
> v4 → v5：按独立复核（verdict = reject）重写机制表述；新增「传输分层」与「执行层接口契约」两节；工具从 5 个收敛到 3 个。

---

## 0. v5 改动（对复核逐条）

| 复核项 | v5 处置 |
|---|---|
| **A1** 工具实例带闭包，现有装配无处安放 | **重写**：工具只产出**静态声明**（`DiscoveredTool[]`）；`fileId → 路径`解析只发生在 **run 级 `exec` 闭包**内（对齐 `resolveTaskId` 形状） |
| **A3/A4** 烘进闭包 → 长活会话工具定义过期 | 同上解决；另**禁止**把文件清单/schema 写进 `systemPrompt`（会触发 `pi-driver.ts:583` 每回合重建会话） |
| **A2** 真正共享状态是 `tmpdir()/fshine-pi-<pid>` + background Worker 单例 | §4.5 明确：**`pi workspaceDir` 不是文件工作区根**；Worker 的 workspace 必须按 Task 注入 |
| **A5** 缺省并发=1，S3 会以「被拒」通过 | §11 加前置条件：验收前显式抬 `backgroundConcurrency`/`queueCapacity` |
| **B1** `file_refs` 缺 path / 派生 / 按任务消费 | §5 补 `path`、`kind`、`parent_file_id`、`(file_id, task_id)` 语义 |
| **B3** active 但字节没了 | §5 加 `file_unavailable` 固定回执 + 状态迁移 |
| **C1** 有损"必须告知"靠模型自觉 | §3 改**机械门**：`excel_write` 必带 `lossyConfirm` 凭证，否则拒绝 |
| **C2** ExcelJS 检测不到图表/透视；`.xlsm` 必坏 | §3 改为**扫 zip 条目**检测；**`.xlsm` 一律拒写** |
| **D1** 无 sha256、复制竞态 | §6 明确 sha256 在**目标字节**上校验 |
| **D2** Worker 产物回不来，四处要改 | §6 列出四处改动（回执 / `TaskRecord` / `tasks` 迁移 / `taskResult`） |
| **E1** 偷偷引入 artifact store，且倒退 D-114 | §7 复用 `file_refs` 一个状态列，**`published` 不过 TTL**（保重发） |
| **E1b** `delivery_failed` 不可观察 | §7 改为**Host 驱动交付**（现有 `sendToConversation` + `DeliveryReceipt`） |
| **E2/E3** 5 个工具可砍；工具间歧义 | §2 **收敛到 3 个**；§2.4 给选择判据 |
| **F1/F2** `customTools` 只吃声明；Worker 两处 exec 门 | §2.2 / §6.3 写明改点 |
| **新增：传输异构** | §8 **传输分层**：`transport: cli \| http`，工厂 switch，不建注册表 |

---

## 1. 能力模型（两条车道 + 一条缝）

```
模型只看到工具
  ├─ 车道 1（业务）：execute_operation({operation,args})
  │     → run 级 exec 闭包：校验 allowed → ExecutionClient.execute()
  │     → 适配器（cli/http）→ 执行层 → 四态结果
  └─ 车道 2（通用文件）：excel_read/write、file_publish
        → 同一个 exec 闭包：fileId → 路径（scope 来自闭包）→ 宿主进程内 ExcelJS
        → 结构化结果
```

**缝只有一个**：`ExecutionClient { capabilities(); execute() }`（`execution-contract.ts:112-116`）。Main/Worker/工具/契约都不随传输变化。

---

## 2. Native Tools（3 个）

### 2.1 清单（v4 的 5 → 3）

| 工具 | 职责 | 相对 v4 的变化 |
|---|---|---|
| `excel_read` | 读 Sheet/范围/分页；**首屏附带** `{sheets, lossy, rowCount, truncated}` | 吸收原 `file_inspect`（省一次整簿建模） |
| `excel_write` | 写工作副本（COW）；有损时需凭证 | 增加 `lossyConfirm` 机械门 |
| `file_publish` | 登记为可交付产物 | 不变 |

**砍掉 `file_list`**：文件清单由 Host 在委派/回合上下文注入，另设工具等于给同一事实两个来源（且中途状态变化会造成"先告知有、下一步被拒"）。

### 2.2 机制：静态声明 + run 级解析（解决 A1/A3/A4）

```ts
// 声明是静态的，不含任何上下文
export const FILE_TOOLS: DiscoveredTool[] = [ ... ];   // name/description/inputSchema

// 上下文只在 exec 闭包里出现
exec(tool, args) {
  if (tool === 'excel_read') {
    const ref = resolveFileRef(args.fileId, scope);     // scope = 闭包变量（principal/session/task）
    ...
  }
}
```
- 工具定义**永不含** `fileId` 集合、workspace 根、清单；
- `resolveFileRef` 与 `resolveTaskId`（`execution-runtime.ts:543-548`）同形：**越权与不存在同一错误，不泄漏存在性**；
- 因此不需要改 `driver-contract.ts`，也不需要第二个工具通道。

### 2.3 接入点（F1/F2）

- Main：`execution-runtime.ts:910-914` 的工具数组加三个；`exec` 分支链加三条（当前以 `throw` 收尾）。
- Worker：**两处** exec 门都要加 —— inline `:739-742`、background `:1111-1112`；工具数组 `:859`、`:1159`。
- Worker 工具集**不含** `file_publish`（产物只能由 Main/Host 交付）。

### 2.4 工具间选择判据

- 看结构（几个 sheet、多少行、有没有图表）→ `excel_read` 首屏就够，**不要**先 inspect 再 read；
- 要改内容 → `excel_write`；
- 要交付 → `file_publish`。
- 三个工具名登记进进度帧文案（`step-text.ts:51-53`），避免把英文内部名播给业务用户。

---

## 3. Excel 边界（机械保证，不靠模型自觉）

**支持**：`.xlsx` 读/写、单元格与范围、分页、行列增改、新建工作簿、基础格式。

**不承诺**：公式计算、VBA、`.xls`、加密工作簿。

**有损检测（扫 zip 条目，不依赖 ExcelJS model）**：

| 检出物 | zip 路径 |
|---|---|
| 图表 | `xl/charts/*` |
| 透视表 | `xl/pivotTables/*` |
| 宏 | `xl/vbaProject.bin` |
| 外部链接 | `xl/externalLinks/*` |
| 条件格式 / 数据验证 | `xl/worksheets/*.xml` 中的相应节点（ExcelJS 只支持子集） |

**机械门**：
- `excel_read` 首屏返回 `lossy: true` + `lossyItems[]`；
- `excel_write` 若目标含 `lossyItems`，**必须**带 `lossyConfirm`（= `sha256(fileId + lossyDigest + 用户原话摘要)`，一次性、绑 sha256、TTL 10 分钟）；**缺失即拒绝**；
- **`.xlsm` 一律拒写**（ExcelJS 产出的是 xlsx 内容类型，套 `.xlsm` 会「格式与扩展名不符」并丢宏）。

**规模**：单次读写范围上限；`excel_read` 默认分页。**超限拒绝并给可操作信息**（如"该表 32MB / 8 万行，请分 sheet 或缩小范围"）。注意渠道入站上限是 32MB（`adapter.ts:73`）——不要写一个永远触发不到的 200MB 阈值。

---

## 4. 工作区与隔离

### 4.1 结构

```
workspaces/<principal-hash>/<session-hash>/
├── in/           原始附件（只读）
├── main-work/    Main 工作副本（读写）
├── tasks/<taskId>/{in,work}
└── artifacts/    宿主登记（Agent 不可写）
```
**hash**：HMAC-SHA256（密钥持久化在宿主数据目录的密钥文件里，**进程重启不变**——否则重启后所有 `active` 行指向不存在的路径）。

### 4.2 权限矩阵

| 目录 | Main | Worker | Host |
|---|---|---|---|
| Session `in/` | 只读 | 不可访问 | 管理 |
| `main-work/` | 读写 | 不可访问 | 管理 |
| Task `in/` | 不可访问 | 只读 | 管理 |
| Task `work/` | 不可访问 | 读写 | 管理 |
| `artifacts/` | 只读（已登记） | 只读（已登记） | **独占写** |

### 4.3 安全底线

- 原件不可修改/删除；只接受 `fileId`，**不接受 Agent 给的任何路径**；
- `fileId` 必须属于当前 run 的 `(principal, session, task?)`；
- 拒绝路径逃逸与符号链接逃逸（`resolve` + `realpath`）；
- **原子写**：同目录临时文件 + `rename`（工作区单卷）；
- 文件大小 / 并发 / 时长有硬上限。

### 4.4 越权回执形状

越权、不存在、过期**同一个错误码**（`FILE_REF_UNAVAILABLE`），不区分——避免成为跨用户枚举 oracle。

### 4.5 两个必须写死的实现前提（复核 A2/A5）

1. **`PiTurnDriverOptions.workspaceDir` 不是文件工作区根**。它目前缺省为 `tmpdir()/fshine-pi-<pid>`（`pi-driver.ts:405-406`），是 Pi 的 cwd，**不得**拿来做 CAP-01 的 workspace；
2. **background 模式下 Worker 驱动是进程级单例**（`server.ts:133-146`）——所以 Task workspace **必须按 taskId 注入**，不能靠驱动实例区分。

---

## 5. fileId 与 file_refs

```sql
file_refs(
  file_id       TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  task_id       TEXT NULL,          -- NULL = 会话级；非 NULL = 某 Task 私有副本
  kind          TEXT NOT NULL,      -- input | copy | output | published
  parent_file_id TEXT NULL,         -- COW 血缘：副本指向原件
  name          TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  path          TEXT NOT NULL,      -- 宿主持有；永不进模型
  state         TEXT NOT NULL,      -- pending | active | consumed | published | expired | unavailable
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NULL
)
```

**语义**
- `pending`：入站未消费；`active`：已进 `in/`；
- `consumed`：**只影响"是否可作为任务输入"**，`excel_read` 仍可读（否则用户"再算一遍"就没法做）；
- `published`：**不过 TTL**（保住"把昨天那份再发我"）；
- 按 `(file_id, task_id)` 消费：同一文件可给多个 Task 各复制一份，互不影响；
- `unavailable`：库里有、盘上没了 → `excel_read` 返回固定话术（比照 `RESULT_UNKNOWN_MESSAGE`），不是 ENOENT 透传。

---

## 6. 入站与委派

### 6.1 入站

1. 渠道下载到暂存区，记录 principal/session/文件名/大小/**sha256**（当前代码未算，需补）；
2. **入站即分配 `fileId`**，`state=pending`；
3. 用户交办 → 复制进 `in/`，`state=active`，把 **文件名/大小/类型/fileId** 给 Main（不给内容、不给路径）；
4. 附件先发、指令后发：pending 从 SQLite 恢复，跨重启有效。

### 6.2 委派

```jsonc
run_task({ task: "...", inputFiles: ["file_abc123"] })
```
Host：校验归属 → 建 Task 工作区 → **物理复制** → **在目标字节上校验 sha256** → Worker 绑定 Task workspace。

### 6.3 四处改动（复核 D2，不能只改入参）

1. `run_task` 回执（`execution-runtime.ts:877`）加产物引用；
2. `TaskRecord`（`task-registry.ts:173-200`）加字段；
3. `tasks` 表迁移（`task-store.ts:238-257`，前向、幂等、带 backup）；
4. `taskResult` 视图（`execution-runtime.ts:577`）返回产物。

**Execution Contract 不动**（`execution-contract.ts` 无文件概念）。

---

## 7. 产物与交付（Host 驱动）

```
excel_write → work/<name> → file_publish → Host 校验（可打开/大小/公式形态/sha256）
  → 写 artifacts/（唯一名，同名加后缀）→ file_refs(state=published)
  → Host 用 sendToConversation 发文件 → DeliveryReceipt → delivery_succeeded / delivery_failed
  → 文本回复里只说文件名，不说路径
```

**为什么改成 Host 驱动交付**：交付发生在 handler return **之后**的 adapter 内部（`server.ts:274-297` → `adapter.ts:326-400`），当前失败要么抛 `WecomChannelDeliveryError`、要么被 `wecom_file_fail` 吞掉——**宿主没有观测点**。改成 Host 自己调 `sendToConversation` 并收 `DeliveryReceipt`，"文本说已发送、实际失败"从结构上不可能。

**规则**
- Agent 不能写 `artifacts/`；
- `file_publish` ≠ 交付；
- 同名自动加后缀；
- **每轮清单制**：只发本轮晋升的；但 `published` 不过 TTL，用户要求重发时可从库里再发；
- 三种事实分开：**产物存在 ≠ 任务成功 ≠ 文件送达**。

---

## 8. 传输分层（新增）

```yaml
contextProfiles:
  dummy:
    transport: cli          # 缺省 cli
    root: scripts/eval/fixtures/dummy-platform
    gateway: bin/dummy
  erp-prod:
    transport: http
    baseUrl: https://erp.internal/api
    credentialRef: erp-prod-key     # 只放引用
```

- 工厂里写死 `switch`，**不建 adapter registry / 插件系统**；
- **不做方言配置语言**：CLI 之间 argv/信封不一致 → **每个执行层一个 adapter**（几十行），不发明 YAML 描述 argv；
- 配置**只放连接参数**，永不放实现（`script`/`command`/路径映射）。

**换执行层的判据**：只应改 ① profile 配置 ② 新增一个 adapter 文件；**不得**改 Main / Worker / 三个工具 / Execution Contract / Eval。

### 8.1 执行层接口契约（实现前必须钉住）

1. **投影收敛**：`operation list --json` 只出 `name/access/args/effects/est_seconds/weight/serve/protocol/label`，**不出 `script`/`command`/路径**（现状注释自述"原样吐给宿主"，`17dz-platform/src/lib/operations.js:21-22`）；
2. **版本握手**：宿主读执行层声明的 `contractVersion` 并比对，不符 **fail-closed**（现状 `dummy-cli-client.ts:151` 是自盖章）；
3. **方言探测**：适配器假设的 CLI 形状（`operation list --json`、`call --file`、RESULT 信封、退出码 0/1/2/3）在启动时探测一次，不符报「执行层不兼容」。

---

## 9. 能力判断（软/硬边界）

| 场景 | 建议 |
|---|---|
| 十几行 Excel 去重汇总 | Main 直接做 |
| 多个 Excel 联合分析 | Main 自行判断 |
| 大型 Excel 清洗 | Main 委派 Worker |
| Excel + ERP 联合 | Worker 取数、Main 整合 |

**软边界**：工具描述与能力说明；**硬边界**：大小/资源/权限/超时（模型无法突破）。
**不新增 Router**，不写死"Excel → Worker"；判断失误时工具返回明确限制，Main 重新规划。

---

## 10. MCP 位置

- 文件类（Excel/CSV/PDF/Word）→ **Native Tools**；
- 外部系统（搜索/ERP/CRM/SaaS/外部库）→ **MCP**。
- 约定写死：**不要出现两个都能"读文件"的工具**。

---

## 11. 阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **S0** 工具最小验证 | ExcelJS 读写；3 个工具；Main/Worker 分别接入；run 级 fileId 解析 | Main 读写工作副本；Worker 同工具；原件 sha256 不变；**Main 的 fileId 在 Worker 上下文被拒**；工具定义**不随回合变化**（会话重建计数=0） |
| **S1** Main 直接处理 | 附件 pending；Session 工作区；产物登记；Host 驱动交付 | 12 行 Excel → **不建 Task** → 去重+汇总 → 用户收到文件且 `delivery_succeeded` |
| **S2** Worker 委派 | `run_task.inputFiles`；Task 工作区；四处改动；产物回 Main | 大文件由 Worker 处理；Main 不承载全量；产物回传可交付 |
| **S3** 并发与长稳 | 多 principal/Session/Task；伪造/过期 fileId；交付失败；进程中断 | 无串户/串 Session/串 Task/原件破坏/虚假交付 |

**S3 前置条件（复核 A5）**：必须显式抬 `backgroundConcurrency`/`queueCapacity`（`resource-policy.ts:151-159`），否则并发用例会以 `resource_limited` "通过"。

| ID | 用例 | 判据 |
|---|---|---|
| CAP-01A | Main 直接处理 | 去重/汇总正确，不建 Task |
| CAP-01B | Worker 处理大文件 | Main 不承载全量 |
| CAP-01C | 工具一致 | 同一实现不同上下文 |
| CAP-01D/E/F/G | 越权 / 跨用户 / 跨 Session / 跨 Task | 全部拒绝，同一错误码 |
| CAP-01H | 交付 | `delivery_succeeded` 且文件可打开 |
| CAP-01I | MCP 并存 | 原 MCP 能力不受影响 |
| **CAP-01J** | 有损文件 | 无 `lossyConfirm` 写必被拒；`.xlsm` 拒写 |
| **CAP-01K** | 重发 | 隔天"再发一份"可从 `published` 取回 |
| **CAP-01L** | 传输异构 | `transport: http` 的假实现接上后，Main/Worker/工具零改动 |

**判据分层**：Runtime 机械项（能打开/大小/公式形态/sha256/归属/路径）vs Eval 业务 Oracle（去重集合、客户汇总，**重新解析输出文件**）。

---

## 12. 不做

自研 Excel 解析器 ｜ Excel MCP 专项 ｜ 独立 File Worker ｜ Direct/Delegate Router ｜ 文件权限平台 ｜ 通用文件工作流引擎 ｜ 任意脚本/shell ｜ 文件共享协作 ｜ PDF/Word 全格式 ｜ 公式计算引擎 ｜ File Service / Workspace Manager / adapter registry。

---

## 13. 待确认

1. **工具数 3 个**（砍 `file_list`、inspect 并入 read）——同意？
2. **`.xlsm` 拒写**（而不是"写成 xlsx 再告知宏丢失"）——同意？
3. **有损凭证 `lossyConfirm`** 的形态（一次一次性 digest）——同意？
4. **`transport` 字段**本轮只实现 `cli` 分支，HTTP 等第二个执行层——同意？
