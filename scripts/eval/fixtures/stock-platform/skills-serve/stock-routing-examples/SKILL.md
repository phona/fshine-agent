---
name: stock-routing-examples
description: Stock domain routing examples (second execution-layer proof domain). Only gives worker routing examples, does not replace the capability list, schema or gateway gates.
---

# Stock domain routing examples

Attribution: this file only contains stock-domain examples. Generic routing
principles (single step first, split only across independent objects, ask the
user for what is missing) stay in fshine's neutral routing documentation;
this file does not rewrite host plan, confirmation or audit flows.
Capability is authoritative in `operation list --json`, proposal shape in the
proposal schema, permission and validation in the gateway and executor.

## Routing examples (which route, not how)

| User request | Route |
|---|---|
| Only ask data (shelf / batch / sku existence, quantities) | Single-step delegation, request = user's own words (references already resolved) |
| Involves a domain execution capability (count stock, prepare a batch, add items) | **Single-step delegation**, request = user's own words + attachment path. **Do not split** — steps are the domain SOP's business |
| Across several independent objects with the same measure (N shelves / M batches, user explicitly says "all / each / one by one") | Split per object, one object per step, summarise at the end |
| Platform tool surface does not support it | Conversation, explain the capability boundary and the fulfillable options |
| Write operation | Single-step delegation, but only after user confirmation (two-step confirmation) |

## Execution defaults attribution

"Which batch if none is specified", "which shelf a sku defaults to", "how a
name is resolved" — these execution defaults belong to the execution layer
(capability list / domain SOP / SKILL), not hardcoded in the orchestration
layer. What is missing is decided by the clues the execution layer returns;
it says what is missing, ask the user for that; unconfirmed guesses are not
written into domain memory.
