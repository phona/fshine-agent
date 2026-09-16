# 17dz MCP 规范（v0.5 · 供 agent 仓库落地骨架）

> 本文档是 17dz-platform 与上层 agent 仓库之间的**接口契约**。实现细节以 17dz-platform 仓库代码为准，本文只定协议。
> 状态：设计已锁定，V0（read server）未开工。
> v0.5 变更：get_submission_status 的 executionState 补 not_started（与 §8 状态机对齐）；submit_voucher_batch 补完整契约（inputSchema / confirmed 语义 / batchKey 命名 / dry-run 预览结构 / 部分成功返回 / 整批重放=只读快照 + 单张定向重试）。
> v0.4 变更：分页 oneOf 修复、VoucherContract 改 accountSetId、绑定点改「首个持久副作用动作」+ boundStep。
> v0.3 变更：幂等 retryable/bound 状态机、get_submission_status、accountSet 稳定 id、artifact 取回映射。
> v0.2 变更：幂等绑定规则、artifact 引用、错误码细化、返回信封 meta、部署级 ALLOWED_ACCOUNT_SETS（待定）。

## 1. 架构定位

```
上层 Agent（tax-agent 仓库，无 17dz 仓库文件访问权）
  │  MCP（stdio / JSON-RPC 2.0）
  ▼
17dz MCP Server（automation/mcp/，薄适配器，无业务逻辑）
  │  直接调用
  ▼
automation/lib/（只读查询） + automation/<domain>/（契约 + 执行器）
  ▼
幻企赢平台
```

铁律（协议层可见的后果）：

1. **workflow 不是 agent**：tool 暴露的是「契约级业务动作」，永无 DOM/选择器/页面步进原语。
2. **写必带闸**：`confirmed` 默认 false = dry-run；落库必须显式确认。这是人在环红线的协议化，**调用方（agent 仓库）有责任把 dry-run 结果展示给人、拿到点头后再发 confirmed**。
3. **幂等是协议要求**：所有写 tool 必带 `idempotencyKey`，状态机见 §8。**违反规则的重试比不幂等更危险**。
4. **登录态 fail-loud**：server 永不处理凭据。登录失效 → `NEEDS_LOGIN` → 调用方通知人工处理（17dz 侧有独立的登录流程，与 MCP 无关）。

## 2. 权限模型（最小粒度）

每个 server 实例的权限由**部署**决定，协议内无任何鉴权字段、无 principal、无 per-request 身份：

| Server | 启动命令（cwd = 17dz-platform 根） | 能力 |
|---|---|---|
| `17dz-read` | `node automation/mcp/src/server-read.js` | 只读 tool，代码中物理不存在写能力 |
| `17dz-write` | `node automation/mcp/src/server-write.js` | read 全集 + voucher 写（带闸 + 幂等） |

**可选的部署级账套范围**（待定项，见 §12 开放点）：

```
env ALLOWED_ACCOUNT_SETS="as_001,as_002"   # 不设 = 全部账套（用稳定 id）
```

- 设置后：`search_account_sets` 只返回范围内账套；范围外账套 → `ACCOUNT_SET_FORBIDDEN`。
- 粒度仍是「实例 × 配置」，不是用户级 IAM；客户场景 = 给客户 agent 挂只配了自己公司 id 的 read 实例。

agent 仓库的 host 按配置 spawn 对应 server；给某个 agent 连哪个 server（带什么配置）就是给它什么权限。

## 3. 账套定位（稳定 id）

平台自身无稳定账套 id（内部按名称搜索），协议层用 **server 维护的本地注册表 id**：

```
search_account_sets → { accountSets: [{ id: "as_001", name: "幻晟" }] }
后续所有 tool         → accountSetId: "as_001"（读和写统一，包括 VoucherContract）
展示给人              → 用 name
```

- id 由 server 首次解析名称时生成、落盘（`automation/.mcp-account-sets.json`），长期尽力保持稳定。
- **不保证跨改名稳定**：账套改名后旧 id 解析失败 → `ACCOUNT_SET_NOT_FOUND`，host 重新 `search_account_sets` 获取新 id 即可。
- 权限范围（ALLOWED_ACCOUNT_SETS）、缓存键、审计证据一律用 id，不用 name。
- **写路径闭环**：VoucherContract 里也是 `accountSetId`（见 §7）；server 内部从注册表解析出账套名、回填为执行器认识的域契约后，才调用执行器。账套名称是执行器内部细节，不出现在上层写协议中。

## 4. 传输

- **stdio**（v0 唯一传输）：host spawn 进程，stdin/stdout 走 JSON-RPC 2.0，stderr 留给人看日志。
- env 原式继承（BROWSER_PROFILE_DIR、ALLOWED_ACCOUNT_SETS 等），host 不应传任何凭据类 env。
- HTTP 传输是 v2 可选项，core 与传输分离，协议不变。

## 5. 生命周期消息

### 5.1 initialize

请求：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "tax-agent", "version": "0.1.0" }
  }
}
```

响应（capabilities 是**运行时发现的唯一依据**，host 不得硬编码 tool 清单）：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": { "tools": {} },
    "serverInfo": {
      "name": "17dz-read",
      "version": "0.1.0",
      "specVersion": "0.5",
      "allowedAccountSets": null
    }
  }
}
```

- `specVersion`：本规范版本，协议演进兼容判断用。
- `allowedAccountSets`：部署配置回显（`null` = 未设限）；host 可据此提前拦截，最终以 server 返回 `ACCOUNT_SET_FORBIDDEN` 为准。

随后 host 发 `notifications/initialized`。

### 5.2 tools/list

host 每次连接后必须 `tools/list` 并以返回为准。**返回的 inputSchema 是完整、自包含的 JSON Schema**（全部 `additionalProperties: false`，传错字段在 schema 层即失败）——client 零依赖 17dz 仓库源码；server 启动时从域契约生成只是 server 内部实现。

## 6. Tool 规范

### 6.1 调用与返回格式

请求：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "list_vouchers",
    "arguments": { "accountSetId": "as_001", "period": "202607" }
  }
}
```

成功（`content[0].text` 永远是 JSON 字符串）：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [{ "type": "text", "text": "<JSON 字符串>" }],
    "isError": false
  }
}
```

text 内解析结果统一为**信封格式**：

```json
{
  "data": { /* tool 特有结果 */ },
  "meta": {
    "traceId": "trc_…",
    "accountSetId": "as_001",
    "accountSetName": "幻晟",
    "retrievedAt": "2026-09-15T10:00:00+08:00",
    "source": "api_cache | api_live | browser | cache"
  }
}
```

- `meta.source` 标明数据来源（缓存命中 / 纯 API / 起了浏览器），host 据此判断结果新鲜度。
- 失败时 `data` 换成 `error` 对象，meta 同带。

### 6.2 V0 tool 清单（read server）

#### get_login_status

```json
{
  "name": "get_login_status",
  "description": "检查 幻账平台登录态。返回 { loggedIn: bool }。loggedIn=false 时尽快通知人工处理登录（本系统不处理凭据，没有自动登录）。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```

返回：`{ "data": { "loggedIn": true } }`

#### search_account_sets

```json
{
  "name": "search_account_sets",
  "description": "在工作台按名称模糊搜索账套，返回 [{id, name}]（受部署的 ALLOWED_ACCOUNT_SETS 约束）。id 是稳定定位标识，后续所有 tool（含 VoucherContract）都用 id；name 仅供展示。这是定位 accountSetId 的第一步——不确定时先搜，不要猜。",
  "inputSchema": {
    "type": "object",
    "required": ["query"],
    "additionalProperties": false,
    "properties": {
      "query": { "type": "string", "minLength": 1 }
    }
  }
}
```

返回：`{ "data": { "accountSets": [ { "id": "as_001", "name": "幻晟" } ] } }`

#### get_current_accounting_period

```json
{
  "name": "get_current_accounting_period",
  "description": "查询账套当前会计期间（如 202607，格式 YYYYMM）。期间参数一律以本工具返回为准，不要自行推算。",
  "inputSchema": {
    "type": "object",
    "required": ["accountSetId"],
    "additionalProperties": false,
    "properties": {
      "accountSetId": { "type": "string", "minLength": 1 }
    }
  }
}
```

返回：`{ "data": { "period": "202607" } }`

#### list_vouchers

```json
{
  "name": "list_vouchers",
  "description": "查询指定账套某期间的记账凭证列表（只读）。分页四模式互斥（schema 的 oneOf 强制，违反直接校验失败）：①不传任何分页参数=默认首页 20 张；②pageNo(+pageSize) 手动翻页；③allPages=true 一次拉全（服务端上限 1000 张=10 页）；④cursor 用上一页响应的 nextCursor 续翻。返回的 docs 为平台 docDto：{ id, type(凭证字), number(凭证号), journalDate(记账日期 YYYY-MM-DD), haveAnnex(附件数), entryDtoList:[{ summary, accountTitleCode, debitAmount, creditAmount, assistantName }] }。凭证显示号 = type + '-' + number（如 记-001）。",
  "inputSchema": {
    "type": "object",
    "required": ["accountSetId", "period"],
    "additionalProperties": false,
    "properties": {
      "accountSetId": { "type": "string", "minLength": 1 },
      "period": { "type": "string", "pattern": "^\\d{6}$" },
      "pageNo": { "type": "integer", "minimum": 0 },
      "pageSize": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
      "allPages": { "type": "boolean", "description": "仅 true 有意义：拉全期间（服务端上限 1000 张）" },
      "cursor": { "type": "string", "description": "分页游标（上一页响应的 nextCursor）" }
    },
    "oneOf": [
      {
        "comment": "默认模式：不传任何分页参数 = 首页 20 张",
        "not": {
          "anyOf": [
            { "required": ["pageNo"] },
            { "required": ["allPages"] },
            { "required": ["cursor"] }
          ]
        }
      },
      {
        "comment": "手动翻页",
        "required": ["pageNo"],
        "not": { "anyOf": [ { "required": ["allPages"] }, { "required": ["cursor"] } ] }
      },
      {
        "comment": "拉全（allPages 仅 const true 命中，false 不算数）",
        "required": ["allPages"],
        "properties": { "allPages": { "const": true } },
        "not": { "anyOf": [ { "required": ["pageNo"] }, { "required": ["cursor"] } ] }
      },
      {
        "comment": "游标续翻",
        "required": ["cursor"],
        "not": { "anyOf": [ { "required": ["pageNo"] }, { "required": ["allPages"] } ] }
      }
    ]
  }
}
```

说明：`pageSize` 不进 oneOf——可搭配默认/pageNo/cursor 模式；allPages 模式忽略 pageSize（恒拉 100/页）。

返回：

```json
{
  "data": {
    "total": 87,
    "docs": [ /* docDto */ ],
    "nextCursor": "eyJwYWdlTm8iOjF9"
  }
}
```

`nextCursor` 仅在还有后续页时返回（allPages 模式不返回，因为已拉完上限内全部）。

#### inspect_account_set

```json
{
  "name": "inspect_account_set",
  "description": "账套摸底：科目表 + 辅助核算档案 + 近期历史凭证。用于『这家账套的科目/对手方怎么记』这类只能现查的问题。meta.source=cache 表示命中缓存未重新抓取。数据是平台当前现状，会随时间变化，不要长期留存当作不变事实。",
  "inputSchema": {
    "type": "object",
    "required": ["accountSetId"],
    "additionalProperties": false,
    "properties": {
      "accountSetId": { "type": "string", "minLength": 1 },
      "task": { "type": "string", "description": "可选，摸底侧重点提示（如 bills）" }
    }
  }
}
```

返回：

```json
{
  "data": {
    "subjects": [ { "code": "1121", "name": "应收票据" } ],
    "assistants": [ { "type": "客户", "name": "易晟汽车", "id": "c00089" } ],
    "recentVouchers": [ /* 近期凭证摘要列表 */ ]
  }
}
```

### 6.3 V1 tool 清单（write server 增量）

#### validate_voucher

```json
{
  "name": "validate_voucher",
  "description": "离线校验记账凭证契约（不起浏览器，秒回）。跑两层校验：结构（schema：字段类型/必填/禁止多余字段）+ 业务规则（借贷平衡、借贷互斥、非零）。accountSetId 会同时做注册表解析与 ALLOWED_ACCOUNT_SETS 检查。契约怎么改、改完对不对，用这个工具迭代，不要直接 submit。",
  "inputSchema": {
    "type": "object",
    "required": ["contract"],
    "additionalProperties": false,
    "properties": {
      "contract": { /* VoucherContract 完整内联，见 §7 */ }
    }
  }
}
```

返回：`{ "data": { "ok": false, "errors": ["entries[1]: 借贷不能同时为零", "..."] } }`

#### submit_voucher

```json
{
  "name": "submit_voucher",
  "description": "录入一张记账凭证。confirmed=false（默认）= dry-run：离线校验 + 世界状态预检，返回预览，不落库、不写数据、不写幂等台账。confirmed=true = 真正执行（须用户已看过 dry-run 结果并点头）。执行后有读回校验。幂等状态机见 §8。",
  "inputSchema": {
    "type": "object",
    "required": ["contract", "idempotencyKey"],
    "additionalProperties": false,
    "properties": {
      "contract": { /* VoucherContract 完整内联，见 §7 */ },
      "idempotencyKey": { "type": "string", "minLength": 1, "description": "调用方生成的 UUID，自行留存" },
      "confirmed": { "type": "boolean", "default": false }
    }
  }
}
```

dry-run 返回：

```json
{
  "data": {
    "dryRun": true,
    "preview": { /* 凭证预览：账套/日期/分录明细/自动凭证号 */ },
    "precheckFlags": [ { "level": "warn", "message": "对手方易晟存在双档案" } ]
  }
}
```

执行返回：

```json
{
  "data": {
    "dryRun": false,
    "voucherNo": "记-001",
    "docId": "88213",
    "verified": true
  }
}
```

#### submit_voucher_batch

```json
{
  "name": "submit_voucher_batch",
  "description": "批量录入凭证（1~100 张）。一次拿锁、一次启动浏览器、逐张顺序执行。confirmed=false（默认）= dry-run：逐张离线校验 + 预检，返回每张的预览/错误，不写数据、不写台账。confirmed=true = 真正执行（须用户已看过全部预览并点头）；任一张校验不过则整批拒绝（CONTRACT_INVALID，不执行任何一张）。执行不中断：单张失败记录后继续后续张。幂等：idempotencyKey 即 batchKey，批内每张的台账键为 `${batchKey}:${index}`，单张可用 submit_voucher + 该键定向重试。整批重放 = 返回已记录快照，不重执行任何张。",
  "inputSchema": {
    "type": "object",
    "required": ["contracts", "idempotencyKey"],
    "additionalProperties": false,
    "properties": {
      "contracts": {
        "type": "array",
        "minItems": 1,
        "maxItems": 100,
        "description": "VoucherContract 数组，index 即结果里的 index / 台账键的 :index",
        "items": { /* VoucherContract 完整内联，见 §7 */ }
      },
      "idempotencyKey": { "type": "string", "minLength": 1, "description": "batchKey：调用方生成的 UUID，自行留存" },
      "confirmed": { "type": "boolean", "default": false }
    }
  }
}
```

dry-run 返回（逐张，index 稳定对应输入顺序）：

```json
{
  "data": {
    "dryRun": true,
    "previews": [
      { "index": 0, "ok": true, "preview": { /* 凭证预览 */ }, "precheckFlags": [] },
      { "index": 1, "ok": false, "errors": ["entries[0]: 借贷不平衡"] }
    ]
  }
}
```

执行返回（部分成功结构）：

```json
{
  "data": {
    "dryRun": false,
    "batchKey": "6f1c…",
    "summary": { "total": 3, "succeeded": 2, "failed": 1 },
    "results": [
      { "index": 0, "ok": true,  "voucherNo": "记-001", "docId": "88213", "verified": true },
      { "index": 1, "ok": false, "error": { "code": "EXECUTION_FAILED", "details": { "executionState": "failed", "boundStep": "save_click", "step": "save", "diff": "…" } } },
      { "index": 2, "ok": true,  "voucherNo": "记-002", "docId": "88214", "verified": true }
    ]
  }
}
```

- 单张失败**不中断**批内后续张；`results` 的 `index` 与输入 `contracts` 一一对应。
- 批内每张独立走 §8 状态机：未达绑定点的失败记 `retryable`，越绑定点的记 `bound` + `executionState` + `boundStep`。
- 批级快照条目 = `(submit_voucher_batch, batchKey, 规范化contracts[])`；批内条目 = `(submit_voucher, ${batchKey}:${index}, 规范化单张contract)`。两者都由 get_submission_status 查询（batch 单张查询用后者）。

#### get_submission_status

```json
{
  "name": "get_submission_status",
  "description": "查询写操作幂等台账（只读，不进执行队列）。用于崩溃恢复/超时后探结果，不要靠猜。batch 单张查询用 `${batchKey}:${index}` 作为 idempotencyKey、tool 用 submit_voucher；整批查询 tool 用 submit_voucher_batch、idempotencyKey 用 batchKey。",
  "inputSchema": {
    "type": "object",
    "required": ["tool", "idempotencyKey"],
    "additionalProperties": false,
    "properties": {
      "tool": { "enum": ["submit_voucher", "submit_voucher_batch"] },
      "idempotencyKey": { "type": "string", "minLength": 1 }
    }
  }
}
```

返回（executionState 完整状态机，含 not_started）：

```json
{
  "data": {
    "status": "not_found | retryable | bound",
    "executionState": "not_started | succeeded | failed | unknown | may_have_succeeded",
    "boundStep": "save_click",
    "result": { "voucherNo": "记-001", "docId": "88213", "verified": true },
    "error": { /* bound+failed 时记录的历史错误对象 */ },
    "batch": { "batchKey": "…", "index": 3, "total": 50 }
  }
}
```

- `status=retryable`（executionState=not_started）：执行从未到绑定点，host 可用同 key 重发（会真正执行）。
- `status=bound`：executionState 为终态或待核验态；`boundStep` 记录触发绑定的动作；待核验时 `result`/`error` 可能同时缺失（server 也只知道一半）。
- `status=not_found` + tool/参数确认无误 → 上次确实没到过 server（如 host 自己崩溃在发送前），可安全重发。

## 7. VoucherContract 结构（client 以此为准）

> tools/list 返回的 inputSchema 中此 schema **完整内联**，client 不需访问 17dz 仓库。
> **协议契约用 `accountSetId`**；server 内部解析注册表、回填账套名，转成执行器认识的域契约后才调用执行器（名称是执行器内部细节，不出现在上层协议）。

```json
{
  "type": "object",
  "required": ["accountSetId", "entries"],
  "additionalProperties": false,
  "properties": {
    "accountSetId": { "type": "string", "minLength": 1, "description": "账套稳定 id（search_account_sets 获取）" },
    "date": { "type": "string", "format": "date", "description": "凭证日期 YYYY-MM-DD（可选）" },
    "template": { "type": "string", "description": "模板标注（可选），执行器不依赖" },
    "voucherNo": { "type": "string", "description": "记字第（可选）。不填用页面自动号" },
    "entries": {
      "type": "array", "minItems": 1,
      "items": {
        "type": "object",
        "required": ["summary", "subjectCode"],
        "additionalProperties": false,
        "properties": {
          "summary": { "type": "string", "minLength": 1 },
          "subjectCode": { "type": "string", "minLength": 1, "description": "科目编码，如 1121" },
          "assistantName": { "type": "string", "minLength": 1, "description": "辅助核算名称（客户/供应商），可选" },
          "debit": { "type": "number", "minimum": 0 },
          "credit": { "type": "number", "minimum": 0 }
        }
      }
    }
  }
}
```

schema 演进以 `serverInfo.specVersion` + `tools/list` 实际返回为准。

## 8. 幂等规则（协议级，双方共同遵守）

**台账条目 = `(tool, idempotencyKey, 规范化contract)`**。规范化 = JSON 规范化序列化（key 排序、无空白）。

```
同 (tool, key) + 同规范化 contract  → 按条目状态处理（见状态机）
同 (tool, key) + 不同 contract      → IDEMPOTENCY_CONFLICT，不执行
```

**条目状态机**：

```
retryable（executionState = not_started）
  执行从未产生持久副作用：入参校验不过、未拿到锁、队列超时，
  或执行中但只做了导航/读取/填表（未到绑定点）。
  → 不绑定终态。同 key 调用重新进入执行。

bound（executionState = succeeded | failed | unknown | may_have_succeeded）
  已到达绑定点：第一个可能产生持久副作用的动作已发生，或无法证明未发生。
  → 绑定终态或待核验态，台账记 boundStep（触发绑定的动作）。
  → 同 key 永不再次执行，只返回记录供核验。
```

**绑定点（副作用边界）**：

> 绑定点 = 第一个可能产生持久化外部副作用的动作之前一刻。**「无法证明未写入」一律按已写入处理（bound）**——假 bound 的成本是人工看一眼，假 retryable 的成本是重复入账。

- voucher 域当前行为：填表走前端 store，点「保存」才落库 → 绑定点 = 保存动作。
- 若平台存在草稿自动保存等隐式写入且无法证明未触发 → 该动作即绑定点。
- 各域绑定点由 17dz 侧按平台真实行为确认，并在台账 boundStep 中记录具体动作（如 `save_click`），作为恢复判断依据。

**生命周期**：

1. `confirmed=false`（dry-run）**不写台账**——key 在 dry-run 阶段零占用。
2. `confirmed=true`：执行前的任何失败 → 记 `retryable`，不占终态；越过绑定点后无论成功、失败还是中断（超时/掉线）→ 记 `bound` + executionState + boundStep。`unknown`/`may_have_succeeded` = server 也只知道一半的诚实记录。
3. host 重试/续跑**必须复用同一 key**；想用新 key = host 明确判定上次从未到达绑定点（`retryable`、`CONTRACT_INVALID`、`PROFILE_BUSY`、队列超时，或 `get_submission_status` 返回 `not_found`/`retryable`）。

**executionState = `unknown` / `may_have_succeeded` 时 host 的铁律：禁止换新 key 重试**。只能用同 key 重放或 `get_submission_status` 探结果；探到真实结果（成功含 voucherNo / 失败含差异）转人工确认。

**batch 双层幂等**：

- 批级条目 = `(submit_voucher_batch, batchKey, 规范化contracts[])`：整批重放（同 batchKey 重发）= **返回已记录快照，不重执行任何张**。快照的 `results` 里每张带自己的 executionState；其中 `retryable`（not_started）的张是可补跑的。
- 批内条目 = `(submit_voucher, ${batchKey}:${index}, 规范化单张contract)`：**单张补跑走标准单张状态机**——host 用 `submit_voucher` + key `${batchKey}:${index}` + 该张契约（规范化后必须与台账一致，否则 `IDEMPOTENCY_CONFLICT`）。同 key 重发：retryable → 真正执行；bound → 返回记录。
- 这样整张/单张只有一套幂等语义，batch 没有第二种重试机制。

## 9. 错误协议

所有 tool 业务失败统一返回（`isError: true`，`content[0].text` 内）：

```json
{
  "error": {
    "code": "NEEDS_LOGIN",
    "message": "人类可读，fail-loud",
    "retryable": false,
    "details": {},
    "artifact": { "id": "art_01H…", "kind": "screenshot", "contentType": "image/png" }
  },
  "meta": { "traceId": "trc_…", "retrievedAt": "…", "source": "browser" }
}
```

- **artifact**：失败现场材料的引用（不是 17dz 本地路径——上层无仓库访问权）。**V0 取回映射**：artifact.id = 文件名（时间戳-短码），17dz 存于 `automation/screens/<id>.png`，host 经部署约定的共享卷读取。契约只承诺 `id + kind + contentType`，取回机制是部署关注点；V2 可转 MCP resource / 受控下载 URL，错误协议不改。
- `retryable=true` 的响应带 `retryAfterMs`（`PROFILE_BUSY` 必带），由 server 建议退避时间。

| code | 含义 | retryable | host 应做什么 |
|---|---|---|---|
| `NEEDS_LOGIN` | 平台登录态失效 | false | 通知人工处理登录，暂停该 server 上的任务 |
| `PROFILE_BUSY` | profile 被占（含非 MCP 仓库脚本在跑），带 retryAfterMs | true（退避） | 按 retryAfterMs 退避重试；持续出现则报告 |
| `ACCOUNT_SET_NOT_FOUND` | 账套 id 解析失败（可能改名），details.nameHint | false | 重新 search_account_sets 定位新 id |
| `ACCOUNT_SET_AMBIGUOUS` | 名称解析命中多个，details.candidates 列候选 | false | 候选交给人/LLM 消歧 |
| `ACCOUNT_SET_FORBIDDEN` | 超出部署的 ALLOWED_ACCOUNT_SETS 范围 | false | 拒绝并报告，不要重试 |
| `CONTRACT_INVALID` | 契约校验失败，details.errors 逐条（batch 时含失败 index） | false | errors 转给 LLM 改契约，回 validate_voucher 循环 |
| `NEEDS_USER_INPUT` | 缺数据/口径未定，details.needs 缺口清单 | false | **停下找人**，不要重试、不要编 |
| `NEEDS_APPROVAL` | 需更高级别人工批准（未来审批流） | false | 走 host 审批流程 |
| `NEEDS_HUMAN_TAKEOVER` | 需人工接管浏览器现场（验证码/弹窗/UI 改版） | false | 通知人工，任务挂起等接管 |
| `IDEMPOTENCY_CONFLICT` | 同 key 不同 contract | false | host 侧 key 管理 bug，报告并人工核对 |
| `EXECUTION_FAILED` | 执行/读回校验失败 | 见 executionState | 展示 artifact 与 details 差异，转人工判断 |
| `TIMEOUT` | 队列等待或执行超时（未过绑定点 → retryable） | true | 退避重试，多次则报告 |
| `INTERNAL` | 未预期错误 | false | 报告，附 message |

`EXECUTION_FAILED` 的 `details` 必带：

```json
{
  "executionState": "not_started | succeeded | failed | unknown | may_have_succeeded",
  "boundStep": "save_click",
  "step": "fill_entries | save | verify_readback",
  "diff": "读回差异描述（verify 失败时）"
}
```

- `not_started`：未达绑定点，台账记 `retryable`，host 可用**同 key 重试**（重新执行）。
- `unknown` / `may_have_succeeded`：已过绑定点，台账记 `bound`，**禁止换新 key**，见 §8 铁律。

## 10. 调用流程样例（host 侧模式）

### 10.1 查询模式

```
search_account_sets("幻晟")                       ← 不猜账套名，拿到 id
get_current_accounting_period("as_001")            ← 期间以平台为准
list_vouchers("as_001", "202607")                  ← 默认首页 20 张
```

### 10.2 录入模式（红线：confirm 前必须过人）

```
validate_voucher(contract)                         ← LLM 迭代契约直到 ok
submit_voucher(contract, key, confirmed=false)     ← dry-run，拿预览 + precheckFlags
  ↓ host 把 preview 展示给用户，拿到明确同意
submit_voucher(contract, key, confirmed=true)      ← 同一 idempotencyKey
  ↓ 成功 → 回报 voucherNo；失败 → 按 executionState 走 §10.3
```

### 10.3 崩溃恢复模式

```
超时/掉线/进程崩 → 不猜
get_submission_status(tool, key)
  ├─ not_found / retryable(not_started) → 同 key 重发（真正执行）
  └─ bound → 拿 executionState + boundStep + result/error → 转人工确认
```

### 10.4 批量模式（部分失败的恢复）

```
submit_voucher_batch(contracts, batchKey, confirmed=true)
  → summary 显示 48/50 成功
get_submission_status("submit_voucher", "${batchKey}:17")   ← 看第 17 张状态
  ├─ retryable → submit_voucher(contract[17], "${batchKey}:17", confirmed=true)
  └─ bound     → 转人工
```

### 10.5 错误决策树

```
isError?
 ├─ NEEDS_LOGIN                → 通知人工登录，该 server 任务挂起
 ├─ NEEDS_USER_INPUT           → details.needs 展示给人，等答复
 ├─ NEEDS_APPROVAL             → host 审批流
 ├─ NEEDS_HUMAN_TAKEOVER       → 通知人工接管，任务挂起
 ├─ ACCOUNT_SET_NOT_FOUND      → 重新 search_account_sets
 ├─ ACCOUNT_SET_AMBIGUOUS      → 候选交给人/LLM 消歧
 ├─ ACCOUNT_SET_FORBIDDEN      → 拒绝并报告
 ├─ CONTRACT_INVALID           → errors 给 LLM 改契约
 ├─ IDEMPOTENCY_CONFLICT       → 报告，人工核对 key 管理
 ├─ EXECUTION_FAILED           → 看 executionState：
 │    ├─ not_started           → 同 key 重试（重新执行）
 │    └─ 其余                  → get_submission_status / 同 key 重放 → 转人工
 ├─ PROFILE_BUSY / TIMEOUT     → 按 retryAfterMs 退避（上限 N 次）
 └─ 其余                       → 展示 message(+artifact)，转人工
```

## 11. host 骨架要点（agent 仓库侧）

1. **连接管理**：每个 server 一个 stdio 连接，进程级复用；server 崩溃 → 重连 + `tools/list` 重新发现。
2. **tool 发现**：以 `tools/list` 为准，不写死清单（capabilities 是运行时契约）。
3. **idempotencyKey 生成与留存**：host 生成 UUID，与业务任务绑定落库；LLM 不经手 key 生成规则，只引用任务 id。重试/续跑必须复用同一 key（§8）。batch 场景：batchKey 与 `${batchKey}:${index}` 的对应关系由 host 记录。
4. **accountSetId 管理**：host 侧缓存 `name → id` 映射；`ACCOUNT_SET_NOT_FOUND` 时使缓存失效并重搜。
5. **confirm 闸门在 host**：`confirmed=true` 的发起条件 = 用户已看过对应 dry-run 的预览（batch：全部 previews）。host 侧要能把 (key → dry-run 预览 → 用户确认记录) 串起来。
6. **超时**：读 tool 短超时（60s）；写 tool 长超时（batch 给 30min）；`PROFILE_BUSY` 退避不占用超时预算。
7. **结果裁剪**：`list_vouchers` 等大结果，host 解析后按场景摘要再进 LLM，原始 JSON 落日志。
8. **Fake server 先行（推荐）**：agent 仓库照本 spec 实现 `Fake17dzMcpServer`（stdio + 完整 tools/list + 成功/错误码 + confirm 流程 + 幂等状态机语义 + batch 语义），核心流程开发与 17dz 侧 V0 实现并行；真 server 接上时核心流程零返工。

## 12. 版本、演进与开放点

| 版本 | 内容 |
|---|---|
| V0 | read server：§6.2 五个 tool + 错误协议 + stdio + 部署级 ALLOWED_ACCOUNT_SETS（若开放点 ① 拍板） |
| V1 | write server：validate_voucher / submit_voucher / submit_voucher_batch / get_submission_status + 幂等台账 + confirmed 闸门 |
| V2 | resources（`17dz://domains/{domain}/{mechanisms,templates,contract-schema}`）、HTTP 传输、artifact 转 resource/下载 URL |
| 未来 | worker 池（多 profile 并发写，路由对调用方透明）、park/resume（人工接管） |

兼容性判断依据：`serverInfo.specVersion` + `tools/list` 实际返回，两者以运行时为准。

**开放点（均不阻塞 Fake server 与 V0）**：

1. **ALLOWED_ACCOUNT_SETS 是否进 V0**：部署级配置（非用户级 IAM），已写入 §2。认可则保留，不认可则删除该节（`ACCOUNT_SET_FORBIDDEN` 码保留备用）。
2. **spec 文档归处**：本文档长期归属 agent 仓库（消费方），17dz 侧届时只在 ARCHITECTURE.md 留一节机制说明，避免两份真相。
3. **voucher 域绑定点确认**：§8 假定「填表 store 不落库、点保存才落库」，V1 实现时须按幻企赢真实行为核对（有无草稿自动保存）；若有隐式写入，绑定点相应前移并更新 boundStep 取值表。
