# CAP-01 · Main 直接执行通用工作 + 宿主工作区

> 状态：**设计稿（v3，按 2026-11-16 评审 + 最小接入验证修订）**。本轮只改文档：不实施代码、不改生产配置、不合入 integration。
> 与财务切片 S0–S5 解耦：两者不共享代码改动。

---

## 0. 修订摘要（对评审逐条）

| 评审项 | 处置 | 与原稿的差异 |
|---|---|---|
| **P1-01** 复用现有出站文件能力 | **采纳，且更正原稿错误** | 原稿称「adapter 没有 upload/sendFile」——**错**。仓库已有 `OutgoingFileReply`（`packages/contracts/src/channel.ts:124`）、`RichChannelReply.files`（`:150`）、`client.uploadMedia/replyMedia`（`adapter.ts:88-89`）与两条发送路径（`adapter.ts:378-381`、`:681-684`）。**不新增 uploadFile** |
| **P1-02** Excel MCP 不能创建新工作簿 | 采纳 | 流程改为「原件 → `in/`（只读）→ 宿主复制到 `work/` → Main 改工作副本 → 宿主校验 → 晋升 `out/`」 |
| **P1-03** 附件进 Main 的链路缺失 | 采纳 | 新增「附件-only 暂存 → 下一条指令时注入 `in/`」完整生命周期 |
| **P1-04** 只改 `mcp.json` 不够 | 采纳 | 现状 `createFshineResourceLoader().getExtensions()` 返回**空数组**（`pi-driver.ts:252`），必须显式加载 MCP extension + 白名单 + 钩子 |
| **P1-05** 路径权限自相矛盾 | 采纳 | **允许 Main 拿受控绝对路径**；安全由宿主钩子保证，不靠"相对路径"这种伪边界 |
| **P1-06** `out/` 宿主独占 | 采纳 | Main 只写 `work/`；`out/` 只能由宿主写入；本轮交付清单，不扫全目录 |
| **P1-07** 依赖策略 | 采纳 | Excel MCP 进 `dependencies`（固定版本 + lockfile），不用运行时 `npx` |
| **P2-01** Main/Worker 不共享可写工作区 | 采纳 | 本轮 Worker **不开放**文件访问；将来由宿主复制到 Worker 自己的目录 |
| **P2-02** 不持久化隐式思考 | 采纳 | 只允许存中间计算数据/结构化摘要/字段映射/处理结果 |
| **P2-03** 公式注入与规模边界 | 采纳 | `=` 开头的普通文本必须按文本写入；明确规模与超时上限 |

---

## 1. 目标与不变量

**目标**：让 Main 直接完成一件真实的小工作并交付文件；证明「Main 直接做事 + MCP 提供能力 + 宿主守边界」可行。

**不变量**
1. Pi First：文件能力通过 **Pi 原生 MCP 扩展**接入，不自建执行框架。
2. Skills First：Skills 只提供知识，不承担工具执行权。
3. Runtime Minimal：宿主只多三件事——**路径约束钩子、工作区生命周期、交付事实**。
4. 不新增 Direct/Delegate Router、File Worker、MCP 管理中心、插件权限系统。
5. **不改 Execution Contract**（产物通过现有 `RichChannelReply.files` 交付，不进契约）。
6. 工作区**不是**任务事实源：任务成败仍只来自 Task Registry。

---

## 2. 代码现状 vs 目标状态

| 能力 | 现状（证据） | 目标 |
|---|---|---|
| MCP 客户端 | Pi 原生：`createMcpExtension`、`mcp.json`、`mcp__<server>__<tool>`、`exposure` 四档（`pi-coding-agent@1.5.2` `dist/extensions/mcp/*`） | 复用，不自研 |
| 扩展加载 | **空**：`getExtensions: () => ({ extensions: [] })`（`pi-driver.ts:252`） | Main 的 ResourceLoader 返回 MCP extension；Worker 不返回 |
| 工具白名单 | `tools: toolDefinitions.map(name)`（`pi-driver.ts:457`）；`noTools:'all'` 会连 MCP 一起关（`core/sdk.d.ts` 注释） | Main 白名单加 `mcp__excel__*`；只暴露三个工具 |
| 工具拦截 | 有钩子：`on("tool_call", handler)`（`core/extensions/types.d.ts:1266`） | 新增路径约束钩子（唯一新增宿主逻辑） |
| Excel 能力 | **无**（运行时无表格库；Main 工具面只有 `run_task`/四任务/`read_skill`，`execution-runtime.ts:912-913`） | 由 MCP server 提供 |
| 附件接收 | 有：`IncomingChannelMessage.attachments`（`contracts/channel.ts:101`）；adapter 下载到 `<platformRoot>/tmp/attachments` | 改为落会话 `in/`；原件不动 |
| 附件进 Main | **无**：`attachmentOnly` 直接返回空串（`server.ts:257-263`） | 暂存 → 下一条指令时进 `in/` 并告知 Main |
| 产物收集 | **无**（`apps/server/handler.ts` 已随 Minimal Rewrite 删除；历史见 `debt-ledger.md` D-106） | 本轮清单式收集 `work/` → 校验 → 晋升 `out/` |
| 出站文件 | **有**：`OutgoingFileReply` + `RichChannelReply.files` + `uploadMedia/replyMedia`（`adapter.ts:378-381`、`:681-684`） | 直接复用；**补交付失败事实** |
| 出站失败语义 | 两条路径不一致：一条抛 `WecomChannelDeliveryError`（`:381-390`），一条只记 `wecom_file_fail` 并吞掉（`:681-690`） | **统一为可观察的交付失败事实**，不得当成功 |
| 工作区清理 | **无**（`scratch-cleanup.ts` 已删；`server-paths.ts:15` 注释仍在引用已删的 `sweepScratchDirs`） | TTL 清理，只删宿主命名形态 |
| 依赖 | — | Excel MCP 进 `dependencies`，固定版本 + lockfile |

---

## 3. MCP 接入（具体到可实施）

**服务器**：`@negokaz/excel-mcp-server@0.12.0`（Node，零运行时依赖，固定版本）。

**暴露工具（仅三个）**：`excel_describe_sheets`、`excel_read_sheet`、`excel_write_to_sheet`。
其余（`excel_create_table`、`excel_screen_capture`）通过 `toolExposure: "hidden"` 关闭——**截图工具不需要，也不该开放**。

**接入三件事（缺一不可，均已实测）**
1. **配置来源不是 `createAgentSession({ agentDir })`**：Pi 的 MCP extension 只从 `getAgentDir()` 读 `mcp.json`，即 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`（`dist/config.js:495,510-516`；`dist/extensions/mcp/config.js:103-106`；`dist/core/sdk.js:71-74`）。实测反证：session `agentDir` 有配置但 env 目录无 → **不注册**；env 目录有配置但 session `agentDir` 无 → **注册**。
   - 推荐做法（避免污染同机其它 Pi 进程）：用公开的 `createMcpExtension({ loadConfig })` 注入**宿主自有目录**的 `LoadedMcpConfig`，不设全局 env；把 env 方案作为备选并标注其副作用。
2. **必须显式 bind extensions**：`createAgentSession` 后要调用 `session.bindExtensions(...)`，否则 MCP 的 `session_start` 不触发、**不会连接**（当前生产 `extensions` 为空，所以从未需要这一步）。
3. **白名单与曝光**（实测）：`tools` 里的 `mcp__` 条目过滤 MCP 工具（`agent-session.js:1197`）；`exposure: hidden` **压过**白名单，hidden 工具即使被列进 `tools` 也不可调用（`agent-session.js:1242`）；`toolExposure` 精确名优先于 `*` 与 server 级（`mcp-servers.js:75-85`）。

**实测工具面**：Main = 7 个业务工具 + 3 个 `mcp__excel__*`（无任何额外 MCP 工具）；Worker = 仅 `execute_operation`，**零 MCP 工具、零 Excel MCP 子进程**。
Excel MCP 0.12.0 在 Linux 的 `tools/list` 实为 6 个（`excel_copy_sheet`/`create_table`/`describe_sheets`/`format_range`/`read_sheet`/`write_to_sheet`，**无** `screen_capture`）；我们只放 3 个，其余用 `hidden` 关掉。

---

## 4. MCP 的真实能力边界（必须写进实施假设）

- `excel_write_to_sheet` 内部是 **`OpenFile(fileAbsolutePath)` 打开已有工作簿**；`newSheet` 只建**工作表**，**不建文件**。
- 因此**不能**让 Main 直接"生成一个 xlsx 文件"，必须走「工作副本」：宿主把原件复制成 `work/<name>`，Main 在该副本上改/加 sheet。
- **公式注入**：以 `=` 开头的字符串会被写成公式。用户数据里以 `=` 开头的普通文本，Main 必须按文本写入（或加前导 `'`），并由 Oracle 校验「未被写成公式」。

---

## 5. 文件生命周期

```
① 用户发附件（可能不带指令）
      ↓
② 渠道下载 → 宿主按 principal×session 暂存（pending，不启动 LLM）
      ↓
③ 用户发送指令 → 宿主把该会话 pending 附件复制进 in/（原件 sha256 记录，原件不动）
      ↓
④ 宿主**先**把 `in/<file>` 复制为 `work/<file>`（工作副本），**然后**把 **`in/` 与 `work/` 两个路径一起**告诉 Main（顺序不可换：副本必须先存在，否则 Main 会在不存在的路径上写）
      ↓
⑤ Main 自主决定：describe/read（in 或 work）→ 计算 → write（只允许 work/）
      ↓
⑦ 宿主校验 work/ 中的候选产物（可打开、规模、公式注入、业务 Oracle）
      ↓
⑧ 校验通过 → 宿主以唯一文件名写入 out/（同名自动加后缀，不覆盖）
      ↓
⑨ 宿主把 out/ 文件构造成 OutgoingFileReply（本轮清单，只发本轮晋升的）
      ↓
⑩ 渠道 uploadMedia → replyMedia → 交付成功/失败事实
      ↓
⑪ 清理：pending 状态清除；work/ 按 TTL 清；失败时保留 pending 允许重试
```

**关键点**
- **⑨ 只发本轮清单**，不扫全 `out/`（防旧文件重复发送、防草稿混入）；
- **⑩ 失败必须成为事实**：`wecom_file_fail` 之外，要有结构化的「本轮交付失败」记录；**不得**因为文本已发出就当作交付成功；
- **⑪ 失败保留**：附件处理失败不清 pending，用户可重发指令重试；TTL 兜底。

---

## 6. 权限矩阵

| 操作 | `in/` | `work/` | `out/` |
|---|---|---|---|
| **Main 读** | ✅ | ✅ | ❌ |
| **Main 写** | ❌ | ✅ | ❌ |
| **宿主 读写** | ✅ | ✅ | ✅（独占写） |
| **Worker** | 本轮不开放 | 本轮不开放 | 本轮不开放 |

- **Main 拿得到本会话工作区的绝对路径**（MCP 需要 `fileAbsolutePath`）；路径不是安全边界，宿主才是。
- Worker 本轮**不加载** Excel MCP extension、**不获得**任何 `mcp__` 工具（工具面为空扩展 + 白名单不含 `mcp__`）。

---

## 7. 安全边界（CAP-C）

**钩子约束（`on("tool_call")`，只对 `mcp__excel__*` 生效）**
1. 参数里所有路径先 `path.resolve()` 规范化，再用 `realpath` 解析真实路径（父目录符号链接也算）；
2. 读：必须落在本会话 `in/` 或 `work/` 内；
3. 写：必须落在本会话 `work/` 内（`out/` 由宿主独占，写 `out/` 直接拒绝）；
4. 拒绝 `../` 逃逸、绝对路径逃逸、符号链接逃逸、以及**跨会话/跨 principal** 的路径；
5. 拒绝写/删 `in/` 原件；
6. 不做字符串前缀判断——用规范化 + 真实路径 containment。

**明确的能力限制**
- 不开放 shell、任意代码执行、通用文件系统工具；
- 不把凭据、宿主敏感目录暴露给 Main；
- 单文件大小、单次处理规模、工具超时、输出大小都要有上限（见 §9）；
- **MCP 子进程视为可信组件**：钩子约束的是 Agent 发起的工具调用，**不是 OS 级隔离**；因此固定版本 + 最小工具面是必要条件，不宣称沙箱。

---

## 8. 依赖与部署

- `@negokaz/excel-mcp-server` 固定版本进 **`dependencies`**（不是 `devDependencies`），lockfile 提交；
- **不用**运行时 `npx` 现拉；
- 启动方式：`node <node_modules>/@negokaz/excel-mcp-server/dist/launcher.js`（绝对路径由宿主解析，不依赖 cwd）；
- 版本升级 = 一次显式改动 + 重跑 CAP-01，不允许浮动。

---

## 9. CAP-01 验收清单

### 9.1 正向（原有 9 条）

用固定 fixture：完全重复行 / 同客户不同单据 / 不同客户 / 不同金额（4 客户，约 12 行）。

1. Main 能读取用户上传的文件；
2. 正确去除**完全重复**行，**不误删同客户的不同单据**；
3. 按客户汇总金额，精确（容差 0）；
4. 输出**真实可打开**的 xlsx；
5. 输入文件 **sha256 始终不变**；
6. 记录数与金额经**独立 Oracle** 校验；
7. 用户能从原渠道收到文件（假渠道断言 `OutgoingFileReply` 已发出）；
8. **不调用 `run_task`**、Task Registry 零新增；
9. **不强制读 Skill**（`read_skill` 调用可为 0）。

### 9.2 新增场景（评审补充）

| 场景 | 预期 |
|---|---|
| 先发附件、再发指令 | Main 能正确获得附件 |
| 同会话连续多个附件 | 不丢失、不互相覆盖 |
| 不同 principal 同名文件 | 完全隔离 |
| `../` / 绝对路径 / 符号链接（含父目录）逃逸 | 拒绝 |
| 写 `in/` | 拒绝 |
| 写 `out/` | 拒绝（宿主独占） |
| Worker 调 Excel MCP | 不可见、不可调用 |
| Excel MCP 返回错误 | 不得假称完成 |
| 文件上传失败 | **记录交付失败事实**，不得假称已交付 |
| 同名输出 | 自动另存，不覆盖 |
| 旧输出文件 | 后续回合不得重复发送 |
| 普通文本以 `=` 开头 | 不得意外写成公式 |
| 原件 SHA256 | 始终不变 |

### 9.3 Oracle（解析文件，不判文本）

- 重新解析**最终交付文件**：去重后明细行集合与期望集合逐行相等；
- 逐客户汇总金额相等（容差 0）；
- 原始数据未被误删（原始工作表仍存在）；
- 输出文件可正常打开；
- 单元格式抽样：`=` 开头文本未被写成公式。

> 依据：S5 A/B 已证明**基于回复文本的 Oracle 误报率极高**（24 条里 10 条误判）。CAP-01 一律以**文件内容**判定。

---

## 10. 非目标

任意代码执行平台 / File Worker / MCP 市场与管理中心 / 插件权限系统 / 自动安装第三方 MCP / Office 全格式 / 多用户共享协作 / 长任务恢复与文件工作流编排 / 自动财务处理 / 跨系统对账 / PDF·Word（后续按需）。

---

## 11. 未解决问题与后续边界

1. **规模边界未定**：单文件多大、多少行、多少 sheet 算"支持"？本轮只验"小规模 `.xlsx` 完整闭环"，**不宣称任意规模**。上限在实施时写成常量并进测试。
2. **公式注入的通用判定**：本轮只覆盖"以 `=` 开头"这一种形态；不声称覆盖所有注入变体。
3. **附件暂存的归属**：pending 附件按 principal×session 暂存，**TTL 与容量的具体值**待实施时定，且必须能在重启后恢复（否则用户隔天发指令会丢附件）。
4. **旧出站路径的失败吞掉问题**（`adapter.ts:681-690`）需要统一：是改成抛错、还是补一条结构化交付失败事实并让上层决定——**本轮只登记，不改**。
5. **Worker 文件访问（CAP-B）**：本轮不做；将来由宿主复制到 Worker 独立目录，**不共享可写工作区**。
6. **`in/spec.md` 的设想（原稿）已撤回**：`in/` 只读，Main 与 Worker 不共享可写目录（P2-01）。

---

## 12. 与既有发现的关系（避免误会）

- 本设计**不修** S5 归因出的「Main 委派口径写错」（那是业务理解问题）；
- 本设计**不修** R6 的 40k 窗口空回复（`output` 恰好 1024 = U1 floor）；
- 本设计**不修** Oracle/污染误报（那是 eval 资产）。
- 三条都是独立问题，不在 CAP-01 范围内。

---

## 13. 最小接入验证结论（2026-11-16，分支 `arch/cap01-probe`，探针提交 `c64cb3b`）

> 只验机制，不实施 CAP-01。产物只在 `$TMPDIR/cap01-probe/*`；未改 `packages/`、未改生产配置、未合并。

### 13.1 六项验证（全部实测通过）

| # | 验证 | 结果 |
|---|---|---|
| 1 | Main 工具面精确 | 7 业务 + `mcp__excel__excel_describe_sheets` / `..._read_sheet` / `..._write_to_sheet`，**无额外 MCP 工具** |
| 2 | Worker 隔离 | 空 extensions → 仅 `execute_operation`；**零 MCP 工具**；**无 Excel MCP 子进程**（进程内 PID 集合对比：Main 有 launcher + binary，Worker 无） |
| 3 | 配置读取位置 | 只认 `getAgentDir()`（`PI_CODING_AGENT_DIR` 或 `~/.pi/agent`），**`createAgentSession({ agentDir })` 不生效**（双向反证） |
| 4 | `hidden` + `toolExposure` | 精确名优先；`hidden` **压过** `tools` 白名单；hidden 工具调用返回 `not found` |
| 5 | 真实调用 | describe（2 sheet）/ read（A1:D4）/ write（新 sheet `汇总`）均成功；`exceljs` 重开可见新内容；**原件 sha256 前后一致** |
| 6 | 路径钩子 | `on("tool_call")` **对 MCP 工具真实生效**：读工作区外 / 写 `in/` / 写 `out/` / 符号链接逃逸 → 全部 block；写 `work/` → 放行 |

### 13.2 两个新发现（改变实施计划）

1. **配置注入方式**：不要依赖全局 `PI_CODING_AGENT_DIR`（同机其它 Pi 进程会共享）。改用 `createMcpExtension({ loadConfig })` 注入宿主自有目录的 `LoadedMcpConfig`；env 方案作为备选并注明副作用。
2. **必须显式 `session.bindExtensions(...)`**：否则 MCP 的 `session_start` 不触发、不会连接。当前生产 `extensions` 为空，从未踩到这一步。

### 13.3 按评审补齐的五条设计

**A. 入站文件回复的交付失败语义**
- 现有两条出站路径不一致：一条抛 `WecomChannelDeliveryError`（`adapter.ts:381-390`），一条只记 `wecom_file_fail` 并吞掉（`:681-690`）。
- v3 规定：**文本先发、文件后发**时，文件失败必须产出**用户可见的交付失败**（明确"文件未送达"），并落一条结构化事实（`delivery_failed`）；**禁止**出现"文本宣称已交付、实际未发出"。
- 落地方式不改动现有 `RichChannelReply.files` 契约，只补失败事实与上层处理。

**B. pending 附件跨重启持久化（复用现有 SQLite）**
- 复用 Task Registry 同一个库，**新增独立表**（不放任务表）：`pending_attachments(principal_id, session_id, message_id, file_id, filename, sha256, bytes, received_at, state)`。
- `state`：`pending` → `consumed` / `expired`；TTL 与容量上限为常量，超限拒绝并告知用户。
- 重启后按 `(principal, session)` 恢复 pending 列表；**不新建文件服务、不新建第二套存储**。

**C. 工作副本先于路径（已改 §5 顺序）**
- `in/` 落盘 → **宿主先复制出 `work/` 副本** → 再把 **`in/` 与 `work/` 两个路径一起**给 Main。
- 目的：避免 Main 在副本不存在时写入、并把失败归因搞混。

**D. 机械校验（Runtime）与业务 Oracle（Eval）分开**
- **Runtime 只做机械校验**：文件能打开、大小/份数上限、`=` 开头未被写成公式、原件 sha256 不变、路径在工作区内。
- **业务正确性只归 Eval Oracle**：去重后行集合、逐客户汇总金额、原始数据未误删。
- **红线**：Runtime 不得出现任何"业务规则"（去重口径、金额公式、客户分组）。机械校验失败 → 交付失败事实；业务不符 → 只是 Oracle 判负，不影响交付。

**E. Main / Worker 使用不同 ResourceLoader**
- 现状共用 `createFshineResourceLoader`（`pi-driver.ts:250-264`，返回空 extensions），靠白名单隐式区分。
- v3 改为**显式两个**：`createMainResourceLoader()`（含 MCP extension + catalog 技能）与 `createWorkerResourceLoader()`（空 extensions）。
- **不依赖白名单兜底**：Worker 即使白名单写错也拿不到 MCP 工具，因为 extensions 里没有。

### 13.4 仍未解决（保留）

1. 规模边界（单文件/行数/sheet 数/超时/输出大小）——实施时写成常量并进测试；
2. 公式注入只覆盖"以 `=` 开头"这一形态，不声称覆盖全部变体；
3. pending TTL/容量具体值待定；
4. 旧出站吞错路径（`adapter.ts:681-690`）本轮只登记，不改；
5. Worker 文件访问（CAP-B）本轮不做。
