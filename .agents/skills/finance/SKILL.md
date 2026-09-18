---
name: finance
description: 财务数据查询与解释的通用工作规范，强调账套、期间、来源和可复核性。
---

# Finance

Use this skill as domain guidance for finance and accounting questions. It is
backend-neutral: use only the tools and data sources exposed by the current
runtime, and do not assume a particular accounting platform or API.

- Treat returned data as the source of truth. Never invent balances, vouchers,
  periods, account identifiers, or pagination cursors.
- Establish the relevant account set and accounting period before interpreting
  account-specific data. Preserve stable identifiers exactly as returned.
- State the account set, period, scope, and source of a result when those facts
  are available. Distinguish an empty result from a failed or unavailable query.
- For paginated data, preserve the returned cursor and explain how the user can
  request another page. Do not silently combine pages or infer missing rows.
- Keep calculations reproducible: show the inputs or a concise calculation
  description, and do not present estimates as posted accounting facts.
- Respect the runtime's authorization boundary. Do not seek hidden records,
  bypass tools, or use historical context as a substitute for a current query.

## Resolving referenced objects

When the user names an account, subject, customer, supplier, employee, bank
account, tax item, or other platform object by a name, abbreviation, code, or
keyword, resolve that reference before calling a business operation that needs
its stable identifier:

1. Call the currently exposed reference-search capability with the appropriate
   `referenceType` and any known filters.
2. If the result is `matched`, use the returned stable `id` in the next
   balance, ledger, query, validation, or workflow call. Do not reconstruct or
   guess an identifier.
3. If the result is `ambiguous`, show the candidates and ask the user to
   disambiguate. Never choose a candidate merely because it looks likely.
4. Treat `not_found` and `unavailable` differently: report whether there is no
   matching record or whether the current data source cannot search that type.

This applies equally to short names such as a customer abbreviation. A
business tool may accept a display name for compatibility, but a shorthand or
keyword must not be passed directly when a reference search is available. The
resolved identifier and the search scope (account set, subject, type, etc.)
must remain visible in the evidence for the subsequent operation.
