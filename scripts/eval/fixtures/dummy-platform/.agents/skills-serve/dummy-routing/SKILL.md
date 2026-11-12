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
