---
name: dummy-routing-examples
description: Dummy domain routing examples (generic execution-layer proof domain). Only gives worker routing examples, does not replace the capability list, schema or gateway gates.
---

# Dummy domain routing examples

Attribution: this file only contains dummy-domain examples. Generic routing
principles (single step first, split only across independent objects, ask the
user for what is missing) stay in fshine's neutral routing documentation;
this file does not rewrite host plan, confirmation or audit flows.
Capability is authoritative in `operation list --json`, proposal shape in the
proposal schema, permission and validation in the gateway and executor.

## serve 运行态的调用形态

调用形态是 `<gateway> <mode> <operation> [flags]`：mode ∈ query / prepare / commit
（另有 local / call 等辅助出口），**第一个位置参数必须是 `operation list` 里登记的
operation 名**——flag（`--collection` 之类）不是 operation 名，它填在后面的参数位。
把 flag 填在 operation 名那一格会被门拒（script not registered）。

写面（access=write）的四个 operation 与到达它们的 mode：

| mode | operation | 形态（`<gateway>` = 平台入口，本夹具是 `bin/dummy`） |
|---|---|---|
| prepare | `dummy.prepare`（干跑，不落账） | `<gateway> prepare dummy.prepare --collection <name> [--count <code>]` |
| prepare | `dummy.proposal`（建提案，payload 是位置参数） | `<gateway> prepare dummy.proposal <payload-file>` |
| commit | `dummy.commit`（直提） | `<gateway> commit dummy.commit --collection <name> [--count <code>]` |
| commit | `dummy.proposal-commit`（按提案提交） | `<gateway> commit dummy.proposal-commit --proposal-id <id>` |

`prepare` 带 `--apply` 会被门拒（写必须走 commit）。名、参数与可用 mode 的权威是
`<gateway> operation list --json`；同一条注册表的可读形态在 `<gateway> --help` 与
`<gateway> <mode> --help`。需许可的操作按能力清单声明先申请计划，形态与门禁以平台为准。

## Routing examples (which route, not how)

| User request | Route |
|---|---|
| Only ask data (collection / window / record existence, values) | Single-step delegation, request = user's own words (references already resolved) |
| Involves a domain execution capability (add records, prepare a proposal, commit records) | **Single-step delegation**, request = user's own words + attachment path. **Do not split** — steps are the domain SOP's business |
| Across several independent objects with the same measure (N collections / M windows, user explicitly says "all / each / one by one") | Split per object, one object per step, summarise at the end |
| Platform tool surface does not support it | Conversation, explain the capability boundary and the fulfillable options |
| Write operation | Single-step delegation, but only after user confirmation (two-step confirmation) |

## Execution defaults attribution

"Which window if none is specified", "which collection a record defaults to", "how a name is resolved" — these execution defaults belong to the execution layer (capability list / domain SOP / SKILL), not hardcoded in the orchestration layer. What is missing is decided by the clues the execution layer returns; it says what is missing, ask the user for that; unconfirmed guesses are not written into domain memory.

## 本夹具的确定性数据面（2026-11-12 补：让「核对是否完成」有可检查的事实基础）

下面列出本夹具**全部**集合（`dummy.query` 的 `--collection` 取值）。表外名称一律 `not_found`
（回 `candidates: []`）；子串命中多个会回 `ambiguous`（回候选名）。窗口必须在该集合声明的
`windows` 里，否则回 `WINDOW_NO_DATA` 并带 `availableWindows`。`query` 返回该集合的 **items
清单**（与窗口无关）与 `count = items.length`；`records` 是各窗口的记录计数，二者不是同一回事。

| 集合 | 窗口 | 条目（名称 / 值） | 备注 |
|---|---|---|---|
| documents | W202610, W202611 | document-1 / 1200；document-2 / 800；document-2 / **900** | 「单据」场景域；同名 document-2 出现两次、金额 800/900 = 可机械检查的异常（列表第 2、3 条） |
| alpha | W1, W2 | alpha-item-1 / 1200；alpha-item-2 / 800 | |
| beta | W1 | beta-item-1 / 500；beta-item-2 / 300；beta-item-3 / 200 | |
| alpha-group | W1 | alpha-group-item-1 / 700 | |
| locked-one | W1 | locked-item-1 / 900 | 锁定集合：query 直接 failed(COLLECTION_LOCKED)，不要重试 |
| empty-one | W1 | （空） | 零条目 |
| contoso-trade | W1, W2 | contoso-trade-item-1 / 1500；contoso-trade-item-2 / 600 | 「contoso」是前缀 → 与 contoso-logistics 歧义 |
| contoso-logistics | W1 | contoso-logistics-item-1 / 450 | |
| fabrikam-retail | W1 | fabrikam-retail-item-1 / 880 | 「fabrikam」是前缀 → 与 fabrikam-wholesale 歧义 |
| fabrikam-wholesale | W1 | fabrikam-wholesale-item-1 / 1320 | |

**业务词映射（口语 → 本夹具；只是本域说明，不是宿主规则）**：单据/记录 → `documents`；
本月 → `W202611`；上个月 → `W202610`。用户给了别的对象名就按上表解析；解析不出时，把这几个
候选（集合名 + 条目数 + 合计值）作为**一次**澄清交给用户，不要要求用户背集合名。

**核对口径**：本域「核对」= 读该集合的 items 并检查可机械判定的异常——**同名不同值**
（`document-2` 出现两次，金额 800 与 900）就是"核对发现的问题"，报出第几条、名称、值即可；
没有异常就如实说没发现。
写面（改已保存数据）只能走 `prepare dummy.proposal` → `commit dummy.proposal-commit`，
且必须先取得用户确认；查询是只读，不要为了"核对"走写面。
