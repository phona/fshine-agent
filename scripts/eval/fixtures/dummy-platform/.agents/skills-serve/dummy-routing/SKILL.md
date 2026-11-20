---
name: dummy-routing-examples
description: Dummy domain routing examples (generic execution-layer proof domain). Only gives worker routing examples, does not replace the capability list, schema or gateway gates.
---

# Dummy domain routing examples

Attribution: this file only contains dummy-domain examples. Generic routing
principles (single step first, split only across independent objects, ask the
user for what is missing) stay in fshine's neutral routing documentation;
this file does not rewrite host plan, confirmation or audit flows.
Which operation exists and what inputs it takes is stated in the operation
list you are given; permission and validation belong to the platform.

## 写一件事怎么走（调用语义，不是命令语法）

写操作分两步：**先准备一个提案，等用户点头，再提交**。不要指望凭空直接写入。

- 准备（`dummy.prepare`）：给出要操作的对象（collection），以及涉及的窗口（window）、
  条数上限（count）等口径；这一步只生成一份待确认提案（摘要 + 过期时间），**不真正落账**。
- 提交（`dummy.commit`）：凭准备时的提案提交；这份提案绑定 collection/window/count/records（与提案完全一致）——提交必须携带与提案一致的 records，否则会被确定性拒绝。
  提案一次性、15 分钟内过期；别自己编造这份确认信息，确认流程会替你带上。
- 另一条提交路径（`dummy.proposal` → `dummy.proposal-commit`）：先建提案，再按提案提交；
  两者都要先取得用户确认。

无论哪条路径，都不能跳过「准备 + 用户确认 + 提交」直接落笔；查询是只读，不要为了
「核对」走写面。需许可的操作先按清单申请，具体能不能做、怎么校验以平台为准。

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

下面列出本夹具**全部**集合（查询操作的 collection 参数取值）。表外名称一律 `not_found`
（回 `candidates: []`）；子串命中多个会回 `ambiguous`（回候选名）。窗口必须在该集合声明的
`windows` 里，否则回 `WINDOW_NO_DATA` 并带 `availableWindows`。`query` 返回该集合的 **items
清单**（与窗口无关）与 `count = items.length`；`records` 是各窗口的记录计数，二者不是同一回事。

| 集合 | 窗口 | 条目（名称 / 值） | 备注 |
|---|---|---|---|
| documents | W202610, W202611 | document-1 / 1200；document-2 / 800；document-2 / **900** | 「单据」场景域；同名 document-2 出现两次、金额 800/900 = 可机械检查的异常（列表第 2、3 条） |
| alpha | W1, W2 | alpha-item-1 / 1200；alpha-item-2 / 800 | |
| beta | W1 | beta-item-1 / 500；beta-item-2 / 300；beta-item-3 / 200 | |
| alpha-group | W1 | alpha-group-item-1 / 700 | |
| locked-one | W1 | locked-item-1 / 900 | 锁定集合：写面（prepare/commit）被拒；只读查询正常返回条目 |
| empty-one | W1 | （空） | 零条目 |
| faulty-one | W1 | faulty-item-1 / 100 | 行为以平台返回为准 |
| denied-one | W1 | denied-item-1 / 700 | 行为以平台返回为准 |
| contoso-trade | W1, W2 | contoso-trade-item-1 / 1500；contoso-trade-item-2 / 600 | 「contoso」是前缀 → 与 contoso-logistics 歧义 |
| contoso-logistics | W1 | contoso-logistics-item-1 / 450 | |
| fabrikam-retail | W1 | fabrikam-retail-item-1 / 880 | 「fabrikam」是前缀 → 与 fabrikam-wholesale 歧义 |
| fabrikam-wholesale | W1 | fabrikam-wholesale-item-1 / 1320 | |

**业务词映射（口语 → 本夹具；只是本域说明，不是通用规则）**：单据/记录 → `documents`；
本月 → `W202611`；上个月 → `W202610`。用户给了别的对象名就按上表解析；解析不出时，
**先把这个标识本身交给平台裁决**——对歧义前缀它会回「还差信息」并给出候选清单；把平台
给的候选作为**一次**澄清交给用户，不要要求用户背集合名。**不要自行猜测具体候选集合逐个查询**
（用户未确认前对候选集合的查询 = 越权猜测），也**不要凭本表数字作答**。

**数字边界（2026-11-13 R2 技能对齐）**：上表的条目与数值只用于理解夹具域与路由判断；
**一切查询结果以平台返回为准，不得引用本表数字作答**（引用即编造）。

**核对口径**：本域「核对」= 读该集合的 items 并检查可机械判定的异常——**同名不同值**
（`document-2` 出现两次，金额 800 与 900）就是"核对发现的问题"，报出第几条、名称、值即可；
没有异常就如实说没发现。
改已保存数据（写面）只能按上面「准备 → 用户确认 → 提交」两步走，确认信息由确认流程按会话带上，
不要自己拼。查询是只读，不要为了"核对"走写面。
