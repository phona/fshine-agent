# Stock platform fixture (second execution-layer proof, Package 4)

A compact, deterministic, non-finance execution layer that speaks the same
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
- Auxiliary groups (admission A11–A12, deterministic):
  `memory set|get|list`, `breaker status|trip|reset`
  (open breaker rejects queries with `BREAKER_OPEN`),
  `cache put|get|clear` (hit/miss, clear resets).
- State root (per case, delete = reset): the test-only `--state-dir <path>` flag
  (dummy test surface, NOT a consumption protocol). The fixture derives
  `stock-state.json` / `plans.json` / `proposals.json` / `audit.jsonl` (and the
  auxiliary `memory.json` / `breaker.json` / `cache.json`) from that root.
  The four state-path env names (`EXECUTION_MOCK_STATE`, `EXECUTION_PLAN_STATE`,
  `EXECUTION_PROPOSAL_STATE`, `EXECUTION_AUDIT_PATH`) and their `STOCK_*` debug
  fallbacks are retired from this fixture (ambient state paths cannot redirect
  it). Auxiliary/token env2 entries remain as manual debug overrides; see
  `docs/environment-variables.md` §4a.
- Skill routing examples: `skills-serve/stock-routing-examples/SKILL.md`
  (routing only, never a gate).
- Assembly health gate: `scripts/lint-operations.js` must exit 0 with
  `stock operations ok: 6 operations`.

This fixture is a test double, not a production domain: it must never be
imported by `packages/` or `apps/`, and it must never be named after any
real execution-layer instance.
