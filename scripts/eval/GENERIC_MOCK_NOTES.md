# Generic-mock eval, Phase 1 — working notes (branch eval/generic-mock-v1)

Status: Phase 1 deterministic protocol eval is green. This is NOT a Main-agent
trustworthiness baseline. Read the "What this does NOT prove" section before
quoting any number from here.

## What was built

- `scripts/eval/fixtures/dummy-platform/bin/dummy` (shell shim) +
  `bin/dummy.cjs` (Node implementation, CommonJS — the repo is
  `"type": "module"`, so an extensionless Node file loads as ESM and fails;
  the shim is the workaround, documented here so nobody "simplifies" it away).
- `bin/17dz` inside the fixture is a symlink to `dummy`. That is the
  compatibility point that lets fshine code stay unchanged: fshine's
  `gatewayExecPath(platformRoot)` always resolves to `<root>/bin/17dz`.
  The dummy's primary entry is still `bin/dummy`; the symlink is not a
  second implementation.
- `scripts/lint-operations.js` in the fixture, for fshine's assembly health
  gate (`<platformRoot>/scripts/lint-operations.js` must exit 0).
- `scripts/eval/generic-mock.ts` — deterministic eval, no model, no network,
  no 17dz checkout. Command: `npm run eval:generic-mock` (full) or
  `node --import tsx scripts/eval/generic-mock.ts --only=<id>` (single case;
  note: `npm run … -- --only=…` is swallowed by npm, use the direct node
  form for --only).
- `scripts/eval/generic-mock.test.ts` — vitest integration: fshine's
  operation-list consumers (labels / arg specs / semantics / protocols)
  derived from dummy, plus lint + query/not-found/zero distinctions.
- `scripts/eval/generic-mock-baseline.json` — v1 deterministic baseline.
- `package.json` — one new script: `eval:generic-mock`. No production
  config changed, no `packages/` or `apps/` file changed.

## Commands and actual results (this session, branch eval/generic-mock-v1)

- `npm run eval:generic-mock -- --write-baseline` → exit 0 after the two
  first-run bugs below were fixed. 16 cases PASS, 4 SKIP.
- `npm run eval:generic-mock` (compare against baseline) → exit 0.
  16 cases PASS, 4 SKIP (skipped cases are listed, never counted as passes).
- `npm run typecheck` → exit 0. Note: repo tsconfig does not include
  `scripts/`, so typecheck does not cover generic-mock.ts; it was
  additionally checked with `npx tsc --noEmit` on that file alone → exit 0.
- `npm run test -- scripts/eval/generic-mock.test.ts` → 4/4 pass, after
  the label fix below.
- `npm run test -- --project unit` → 96 files, 1641 tests, ALL PASS
  (including the 4 new generic-mock tests).
- `npm run test` (full, unit + e2e) → 36 files failed / 97 passed,
  148 tests failed / 1651 passed. Root cause checked, NOT this branch:
  e2e harness boots `createServerAssembly`, which loads
  `config/agent.yaml` — a gitignored local deployment config that does
  not exist in this clone (error: ENOENT, e.g.
  turn-loop-write-closure.test.ts). The first full run also showed
  better-sqlite3 native-binding failures because dependencies were
  installed with `--ignore-scripts`; after `npm rebuild better-sqlite3`
  that class disappeared and the remaining failures are the config
  class. Do NOT create a fake agent.yaml to force e2e green — that file
  holds local deployment identity and is gitignored for a reason.
  The correct pre-PR check on a machine with a real deployment config
  is to re-run the full suite there; in this sandbox, unit + generic
  mock eval are the honest green gates.
- Existing Tier-1 (`scripts/eval/baseline.json`, `corpus.jsonl`) untouched.
  Old-domain cases stay as L4 integration, not in this core baseline.
- No LLM was available in this environment (no `.env`, no LLM_* env), so
  `npm run eval` (real-model probe) was NOT run here and must NOT be
  reported as run. See "Pending" below.

## First-run bugs fixed (not hidden)

1. Plan confirm expectation: 61 query calls hit hardCalls 50 → stop
   (HARD_LIMIT), not confirm. The weight line never got a chance. Fixed by
   giving dummy.query weight 2 and using 40 calls (weight 80 >= budget 60,
   calls 40 <= 50, seconds 400 <= 1800), so the weight line is what
   confirms. Lesson recorded: a read-only op with weight 1 can never reach
   budget weight 60 within hardCalls 50.
2. Readback-short marker in the proposal payload: `__readbackShort` was
   correctly refused as an undeclared field (additionalProperties is
   false). Fixed by moving the marker to a test-only env var,
   `DUMMY_READBACK_SHORT=1`, for that one commit call only. The payload
   schema stays strict.
3. Label table empty: fshine's label parser only accepts TSV rows with a
   non-empty 5th column (safe default). Dummy TSV initially left it blank,
   so labels were empty — correct behaviour, wrong fixture. Fixed by
   giving each dummy operation a neutral label (query records, etc.).
4. ESM/CJS: see "What was built" above.

## Baseline v1 (generic-mock-baseline.json, 16 cases)

- smoke-query, smoke-prepare-commit, smoke-not-found
- g-a1-requery, g-a2-cross-contamination, g-a3-ambiguity-mechanical,
  g-a4-not-found-zero-leak, g-a5-idle-zero-calls, g-b1-stability,
  g-y2-error-honesty
- g-plan-gate, g-serve-matrix, g-readback-short, g-proposal-expired,
  g-proposal-token-untrusted, g-state-isolation
- Each case records its checks as pass/fail. `--write-baseline` refuses
  to write if any non-skipped case fails. Baseline comparison: a check
  recorded pass must stay pass; mismatch → exit 2; case failure → exit 1.
- There is no judge score in this baseline, by design: no model runs here.

## What this does NOT prove

- It does not prove Main-agent trustworthiness (A1/A2/A3/A4/A5/B1/Y2 with
  a real model). The g-a*/g-b*/g-y* cases are protocol analogues with the
  same names on purpose, but they test the dummy's answers, not a model's
  replies. Do not present them as the L1 baseline.
- It does not prove real-platform compatibility, domain correctness, or
  browser behaviour. Dummy payloads are simplified and neutral.
- It does not prove the host-side changes that do not exist yet (see
  skipped cases). Skipped ≠ passed.

## Skipped cases (TODO, not done)

- g-step-cap-50-51: free-worker step cap does not exist in fshine yet
  (only 600s time + plan weight 180). Needs a host code change + a test
  at call 50 and call 51, with the same wind-down as the 90% budget point.
- g-handover-file: host-written mandatory handover file on task resume
  does not exist yet. Needs the host change + a scripted turn.
- g-tool-definition-removed: needs a real or scripted model turn with
  tool definitions removed.
- g-tampered-summary-review: isolated write-path review turn does not
  exist yet in production. Needs the host review turn + a tampered
  summary case (must block the confirmation code) and a consistent case
  (must pass).

## Other TODO (not in Phase 1)

- memory / breaker / cache auxiliary groups in dummy (not implemented;
  dummy returns usage exit 2 for them).
- Plan grind / variant guards (maxNotify, maxReplans, maxVariants) in
  dummy — simplified decision only (weight + calls/seconds, stricter wins).
- Rate-limit token bucket in dummy.
- `committed_unverified` as a distinct host terminal state: dummy already
  returns failed + verified=false + committed status for readback-short,
  and the eval script classifies it as committed_unverified. The host
  reporting change (never say "completed" for it) is still a host change.
- Moving session/sensitive state out of the worker-readable workspace
  (dummy has no browser profile or platform session, so this gap is
  17dz-side, not dummy-side).
- Real-model L1 migration: run the 7 L1 cases against the dummy domain
  with a real model, 3 rounds, then set a separate Main-agent baseline.
  That run needs LLM credentials and must be done by the parent agent,
  not by faking a model here.
- CI: Tier B job for `npm run eval:generic-mock` (manual before merge +
  nightly, scores as artifact only, baseline never auto-written by CI).
  Not added in Phase 1 — the command exists, the workflow does not.

## Design-doc note

The parent design doc (`~/workspace/code-review/fshine-eval-design.md`)
was not edited in this branch (it lives outside the fshine repo). The
new command to record there is `npm run eval:generic-mock`, and the
correction to record is: `--only` must be used via the direct node form,
not via `npm run … -- --only=…`.
