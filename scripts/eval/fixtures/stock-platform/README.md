# Stock platform fixture (second execution-layer proof, Package 4)

A minimal, deterministic, non-finance execution layer that speaks the same
protocol as any fshine execution layer (see
`docs/execution-layer-interface.md` and `docs/execution-layer-admission.md`).

- Gateway: `bin/stock` (shell shim -> `bin/stock.cjs`, CommonJS).
- Operations: `stock.query`, `stock.scratch`, `stock.prepare`,
  `stock.commit`, `stock.proposal` (`proposal.create`),
  `stock.proposal-commit` (`proposal.commit`).
- Seed shelves: `north` (B1: 2 items, B2: 1), `south` (B1: 3),
  `north-wing` (B1: 1), `locked-shelf` (locked, B1: 1),
  `empty-shelf` (B1: 0 — zero is a real completed answer, never not_found).
- Flags: `--shelf` (exact preferred, substring may be ambiguous),
  `--batch` (B1/B2, must exist for the shelf).
- Proposal payload: `{ shelf, batch, items: [{ sku, qty }] }`,
  max 50 items, `additionalProperties: false`, TTL 30 minutes (default).
- Auxiliary groups (admission A11–A12, minimal deterministic):
  `memory set|get|list`, `breaker status|trip|reset`
  (open breaker rejects queries with `BREAKER_OPEN`),
  `cache put|get|clear` (hit/miss, clear resets).
- State files (per case, delete = reset): `STOCK_STATE`,
  `STOCK_PLAN_STATE`, `STOCK_PROPOSAL_STATE`, `STOCK_AUDIT_PATH`,
  `STOCK_MEMORY_STATE`, `STOCK_BREAKER_STATE`, `STOCK_CACHE_STATE`;
  each also accepts the `EXECUTION_*` alias, so fshine code needs no change.
- Skill routing examples: `skills-serve/stock-routing-examples/SKILL.md`
  (routing only, never a gate).
- Assembly health gate: `scripts/lint-operations.js` must exit 0 with
  `stock operations ok: 6 operations`.

This fixture is a test double, not a production domain: it must never be
imported by `packages/` or `apps/`, and it must never be named after any
real execution-layer instance.
