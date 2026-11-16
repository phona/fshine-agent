# CAP-01 · Main / Worker 通用文件处理能力（Native Tools）

> 状态：**设计稿（v4，2026-11-16，按 owner 基线收敛）**。本轮只改文档：不实施、不改生产配置、不合入 integration。
> v3 → v4 方向性变更：**取消 Excel MCP 作为文件入口，改为 fshine 自有的 TypeScript Native Tools，Main 与 Worker 共用**；MCP 保留给外部系统（搜索 / ERP / CRM / SaaS）。

---

## 0. v4 变更摘要

| 维度 | v3 | v4 |
|---|---|---|
| 文件能力来源 | `@negokaz/excel-mcp-server` | **Native Tools（ExcelJS）** |
| 模型拿到的引用 | 受控绝对路径 | **`fileId`**（Host 解析） |
| 安全边界 | `tool_call` 路径钩子 | **fileId 归属校验**（钩子退化为辅助） |
| Worker 文件能力 | 无 | **与 Main 同一套工具** |
| 交付 | 复用 `RichChannelReply.files` | 同样复用，但增加 `file_publish` 显式登记与 `delivery_failed` |
| MCP | Excel 走 MCP | **MCP 只服务外部系统** |

**MCP 路线已实测可用但不采用**：探针（分支 `arch/cap01-probe`，提交 `c64cb3b`）证明 Main 可精确暴露三个 `mcp__excel__*`、Worker 零 MCP 工具零子进程、`hidden` 语义与 `tool_call` 路径钩子均有效。**否决理由**：①绝对路径必须交给第三方进程，安全面大于 `fileId`；②Worker 无法共用；③ExcelJS 更可控。结论留档，避免重复论证。

---

## 1. 目标与不变量

**四件事**
1. Main 能直接完成日常文件工作；
2. 文件太大 / 工作太复杂时，Main 能把文件交给 Worker；
3. Main 与 Worker 共用同一套文件工具，不重复开发；
4. 多用户 / 多 Session / 多 Task 并发时，文件不串线、原件不被破坏。

**不变量**
- 不做 Direct/Delegate Router；不做 File Worker；不做独立文件管理平台；不做 Excel 专属 MCP；不做任意代码执行；不做复杂权限系统；不改 Main/Worker 架构。
- **Agent 负责判断和工作，Host 负责边界和安全。**
- 不修改 Execution Contract（除非实际代码证明现有任务入口无法承载文件引用）。

---

## 2. 架构

```
Channel / Host ── 身份、附件接收、Session、Task、工作区、交付
   ├── Main Agent ── Native Tools（文件/Excel/…） + MCP（搜索/外部平台）
   │                     └─ 直接处理（Session 工作区） 或 run_task(inputFiles) 委派
   └── Worker Agent ── Native Tools（同一实现） + MCP（按需）
                         └─ Task 工作区
   Host 统一收集产物、统一交付、统一失败事实
```

**关键**：Main 与 Worker 没有两套文件实现；差别只在 **Host 注入的执行上下文**。

---

## 3. Native Tools

### 3.1 技术选型

| 层 | 选择 |
|---|---|
| 工具接口 | 现有 `DiscoveredTool` |
| 工具执行 | `TurnDriver.exec` |
| Pi 接入 | 原生 `customTools` |
| Excel | **ExcelJS** |
| 文件系统 | Node `fs` |
| 安全约束 | Host 注入工作区 + `fileId` 归属校验 |

不引入 Tool Framework，不复制 Excel MCP 的整套实现。

### 3.2 第一版五个工具

| 工具 | 职责 |
|---|---|
| `file_list` | 列出当前上下文可访问文件（`fileId` / 名称 / 大小） |
| `file_inspect` | 类型、大小、Sheet、表头、数据规模、**是否含图表/透视/宏** |
| `excel_read` | 按 Sheet / 范围 / 分页读取 |
| `excel_write` | 对工作副本写入（**Copy-on-Write**） |
| `file_publish` | 登记为可交付产物（**不等于已送达**） |

**两条硬设计**

1. **模型永不接触真实路径**：工具只接受/返回 `fileId`；路径由 Host 解析并校验。
2. **写入永不覆盖原件**：`excel_write` 首次写自动 COW 出新副本；后续写入只改副本；`file_publish` 才交给 Host 登记。

### 3.3 上下文注入（防串线的关键）

```ts
// 工具实例按执行上下文构造；workspace 根是闭包参数，工具定义里不出现路径
createFileTools({ workspaceRoot, allowedFileIds }): ToolDefinition[]
```
- 不读环境变量、不读全局单例；
- Main 与 Worker 各自构造，互不可见；
- 工具内所有路径解析基于 `workspaceRoot` + `realpath` containment。

### 3.4 Excel 能力边界

**支持**：`.xlsx` 工作簿/Sheet 读取、单元格与范围、分页、行列增改、去重/排序/分组（由 Agent 组织）、新建工作簿、基础格式。

**不承诺**：公式计算引擎、VBA、`.xls`、加密工作簿、复杂图表/透视/外部链接的完整保留。

**有损重写必须显式**：
- `file_inspect` 检测到图表 / 透视表 / 宏 / 外部链接 → 返回 `lossy: true` 与具体项；
- Main 收到后**必须**告知用户"处理后可能丢失 X"，或选择不处理；
- **禁止静默写坏用户的文件**。

**公式与文本**：以 `=` 开头的**文本**必须按文本写入，不得变成公式；由机械校验兜住。

**规模**：工具内部流式/分页；单次读写范围有上限。**超限拒绝并给出可操作信息**（如"超过 200MB，请拆分"），不靠增加模型调用硬撑。

---

## 4. 工作区与隔离

### 4.1 结构

```
workspaces/
└── <principal-hash>/
    └── <session-hash>/
        ├── in/           原始附件（只读）
        ├── main-work/    Main 工作副本（读写）
        ├── tasks/
        │   └── <taskId>/
        │       ├── in/   （Worker 只读）
        │       └── work/ （Worker 读写）
        └── artifacts/    宿主登记的交付物（Agent 不可直接写）
```

**hash 规则**：`<principal-hash>` / `<session-hash>` 用 HMAC-SHA256（密钥由 Host 持有）截断，**不直接拼 principalId**（含冒号、且泄漏身份）。

### 4.2 权限矩阵

| 目录 | Main | Worker | Host |
|---|---|---|---|
| Session `in/` | 只读 | **不可访问** | 管理 |
| `main-work/` | 读写 | 不可访问 | 管理 |
| Task `in/` | 不可访问 | 只读 | 管理 |
| Task `work/` | 不可访问 | 读写 | 管理 |
| `artifacts/` | 只读（已登记） | 只读（已登记） | **独占写** |

**Worker 只获得当前 Task 的文件，不因同属一个用户而获得整个 Session 权限。**

### 4.3 安全底线

- 原件不可修改、删除；
- **不接受 Agent 提供的任何绝对路径**，只接受 `fileId`；
- `fileId` 必须属于当前执行上下文（principal/session/task）；
- 拒绝跨 principal / session / task 引用；
- 拒绝路径逃逸与符号链接逃逸（`resolve` + `realpath`）；
- **原子写**：同目录临时文件 + `rename`（工作区必须单卷，跨卷会失败）；
- 文件大小、并发数、处理时长有硬上限。

---

## 5. 附件进入 Main

1. 渠道下载到暂存区，记录 principal / session / 文件名 / 大小 / **sha256**；
2. **入站即分配 `fileId`**，状态 `pending`（此时不启动 LLM）；
3. 用户随后交办 → Host 把该会话 `pending` 附件登记到 `in/`，状态转 `active`，把**文件名 / 大小 / 类型 / fileId** 交给 Main（**不给文件内容**）；
4. Main 自行决定：`file_inspect` → 直接处理 或 `run_task(inputFiles)`；
5. 成功消费 → `consumed`；失败保留可重试；TTL 过期 → `expired`。

**持久化**：复用现有 SQLite，新增独立表
`file_refs(file_id PK, principal_id, session_id, task_id NULL, name, sha256, bytes, state, created_at, expires_at)`。
不新建文件服务、不新建第二套存储。
**跨重启**：`pending` 与 `active` 都从库恢复；"先发文件、隔天交办"仍成立。
**多附件**：同会话连续多个附件各自一个 `fileId`，互不覆盖。

---

## 6. Main 把文件交给 Worker

只给 `run_task` 增加一个可选参数：

```jsonc
run_task({ task: "对销售明细去重，并按客户汇总金额", inputFiles: ["file_abc123"] })
```

Host 负责：
1. 校验 fileId 属于当前 principal/session 且状态有效；
2. 创建 Task 工作区；
3. **物理复制**到 Task `in/`，保留 sha256；
4. Worker Session 绑定 Task 工作区；
5. Worker 用同一套 Native Tools 处理，只看到自己的文件清单。

**先物理复制**（简单可靠）；若将来大文件复制成本明显，再优化为不可变引用，**不改 Agent 工具接口**。
**Worker 不获得 Session 的其它文件**。

---

## 7. 产物与交付

```
Agent 工作副本 → file_publish → Host 校验 → 登记 artifact
   → Main 获取产物引用 → RichChannelReply.files[] → 渠道发送
   → delivery_succeeded / delivery_failed
```

**规则**
- Agent **不能**直接写 `artifacts/`；
- `file_publish` 只登记，**不等于交付**；
- Worker 的产物先登记到 **Task 结果**，由 **Main 决定是否交付**（Worker 不得直接触发渠道发送）；
- 同名产物**自动另存**，不覆盖；
- 交付走现有 `RichChannelReply.files[]` 与渠道上传能力；
- **文件发送失败必须产生可观察的 `delivery_failed`**，且**禁止**出现"文本说已发送、实际失败"；
- **每轮交付清单制**：只发本轮晋升的产物，不扫全 `artifacts/`，旧文件不重复发送、草稿不被当结果。

**三种事实分开记录**：产物存在 ≠ 任务成功 ≠ 文件送达。

---

## 8. Main 的能力判断（极简）

不新增 Router，不写死 `Excel → Worker` / `大文件 → Worker`。

| 场景 | 推荐行为 |
|---|---|
| 12 行 Excel 去重汇总 | Main 直接做 |
| 简单 Word 整理（后续） | Main 直接做 |
| 多个 Excel 联合分析 | Main 自行判断 |
| 大型 Excel 清洗 | Main 委派 Worker |
| Excel + ERP 联合分析 | Worker 取数、Main 整合 |
| 复杂 / 耗时 / 需独立恢复 | Main 委派 Worker |

**软边界**：工具描述与能力说明，让模型知道何时该委派。
**硬边界**：文件大小、资源、权限、超时，让模型**无法突破**。

判断失误时工具返回明确限制信息，Main 重新规划或委派；**Host 不替模型判断任务类型**。

---

## 9. MCP 的位置

MCP 完全保留，只取消它作为**文件处理入口**。

| 能力 | 方式 |
|---|---|
| Excel / CSV / PDF / Word | **Native Tools**（PDF/Word 后续） |
| 网络搜索 / ERP / CRM / 财务 SaaS / 外部数据库 | **MCP** |

约定：**文件类一律 Native Tools，外部系统一律 MCP**——避免将来两个工具都能"读文件"造成选择歧义。

---

## 10. 实施阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **S0** Native Tools 最小验证 | ExcelJS 读写；五个工具；接入 `TurnDriver`；Main/Worker 分别注册；上下文隔离 | Main 能读写工作副本；Worker 能调用同一工具；**原件 sha256 不变**；Main 的 fileId 在 Worker 上下文被拒 |
| **S1** Main 直接处理 | 附件暂存与消费；Session 工作区；Main 工具接入；产物登记与交付 | 上传 12 行 Excel → Main **不建 Task** → 去重 + 客户汇总 → 用户收到可打开文件 |
| **S2** Worker 委派 | `run_task.inputFiles`；Task 工作区；Worker 接入同套工具；Task 结果带产物引用 | 大文件由 Worker 处理，**Main 不承载全量数据**，产物回到 Main |
| **S3** 多用户并发与长稳 | 多 principal 同名文件；多 Session；多 Task；路径逃逸/伪造 fileId/过期引用；发送失败与进程中断 | 无串户/串 Session/串 Task/原件破坏/虚假交付 |

### 验收用例

| ID | 用例 | 核心判据 |
|---|---|---|
| CAP-01A | Main 直接处理 Excel | 去重、汇总正确，不创建 Task |
| CAP-01B | Worker 处理大型 Excel | Main 不承载全部数据 |
| CAP-01C | Main/Worker 工具一致 | 同一实现、不同上下文 |
| CAP-01D | Worker 越权访问 | 必须拒绝 |
| CAP-01E | 两用户同名文件 | 互不可见 |
| CAP-01F | 同用户不同 Session | 互不可见 |
| CAP-01G | 同 Session 多 Task | 文件互不串线 |
| CAP-01H | 文件回传 | 产物正确、用户实际收到（`delivery_succeeded`） |
| CAP-01I | MCP 并存 | 不影响原有 MCP 能力 |

### 判据分层

- **Runtime 机械校验**：文件能打开、大小/份数上限、`=` 开头未被写成公式、原件 sha256 不变、`fileId` 属于本上下文、路径在工作区内。
- **Eval 业务 Oracle**：去重后行集合、逐客户汇总金额、原始数据未误删——**一律重新解析输出文件**，不依赖模型回复文本（依据：S5 A/B 证明文本判据误报 10/24）。

---

## 11. 明确不做

自研 Excel 解析器 ｜ Excel MCP 专项接入 ｜ 独立 File Worker ｜ Direct/Delegate Router ｜ 独立文件权限平台 ｜ 通用文件工作流引擎 ｜ 任意脚本执行工具 ｜ 文件共享协作 ｜ PDF/Word 全格式 ｜ 公式计算引擎 ｜ File Service / Workspace Manager 之类的新框架。

---

## 12. 待定与风险（实施前必须收敛）

1. **ExcelJS 有损重写的处置**：检测到图表/透视/宏后是"拒绝"还是"告知后继续"？v4 定为**告知 + 由 Main 决定**，需确认。
2. **硬上限的具体数字**：单文件大小、总行数、内存峰值、单次范围、超时——在 S0 用真实文件测出，不预先虚构。
3. **fileId 的 TTL 与容量**：pending 保留多久、每会话最多几个、超限如何提示。
4. **并发上限**：同会话并发 Task 数、全局并发文件操作数。
5. **Worker 产物交付权**：v4 定为"Worker 只能 publish、由 Main 交付"；若将来需要 Worker 直发，必须单独评审（会绕过 Main 的整合与话术）。
6. **单卷约束**：原子写依赖同卷 `rename`，部署时工作区目录必须与临时文件同卷。
7. **与财务切片的关系**：CAP-01 不改 S0–S5；财务 Skill 仍是"业务知识"，Excel 工具是"通用能力"，两者不交叉。
