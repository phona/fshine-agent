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
