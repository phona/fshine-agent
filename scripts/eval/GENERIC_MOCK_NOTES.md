# Generic-mock eval, Phase 1 + Phase 2 — working notes (branch eval/generic-mock-v1)

Status: Phase 1 deterministic protocol eval is green, and Phase 2 (host
changes for the four former SKIP cases) is green at the level honestly
testable without a model. This is NOT a Main-agent trustworthiness
baseline. Read the "What this does NOT prove" section before quoting any
number from here.

## Phase 2 — what was built (host changes, all on branch eval/generic-mock-v1)

1. Free-worker step cap — `packages/agent/src/worker-step-cap.ts` (pure
   decision: default 50, configurable via `stepCap` option or
   `FSHINE_WORKER_STEP_CAP` env, invalid values fall back to 50) +
   wiring in `pi-coding-driver.ts`: counting reuses the serve-gate
   audit's `gateCalls`; the (cap+1)th allowed bash sends the same
   `WORKER_WIND_DOWN_NUDGE` as the 90% wall-clock point (deliver done +
   not-done, no new work), latched once. The env name is registered in
   `platform-leak-lint.test.ts` as a host runtime parameter (tag
   警职执法), same precedent as FSHINE_PLATFORM_QUEUE_CAPACITY.
2. Host handover file — `packages/agent/src/task-handover.ts` (fixed
   fields: plan id/version, completed steps + executed calls, unfinished
   steps, next action, last RESULT summary; file
   `<platformRoot>/tmp/<taskId>/handover.json`; resume merge deduplicates
   executed calls by exact key, so a resumed turn never double-counts) +
   wiring in `context.ts`: written at every turn end (ok, pending_plan,
   needs_input, proposal_created, terminal), read on continue
   (`task_handover_resumed` / `task_handover_missing` log events),
   write failure only logs, never fails the turn.
3. Isolated write-path review — `packages/agent/src/proposal-review.ts`
   (same isolated-turn pattern as `context-model.ts`: own message list,
   no tools, 10s timeout, 32KB in / 12KB out, strict-JSON parse,
   fail-closed on unparsable reply / failed dry-run / empty summary /
   turn throw) + wiring in `context.ts`: runs in `createProposalViaGateway`
   after the platform dry-run succeeds and before any confirmation code
   is created; inconsistent blocks the code. Input is schema + dry-run
   envelope + platform summaryText only; output is consistent/
   inconsistent + field names only. Injection point is the
   `proposalReviewTurn` option. UPDATE (Package 2, supersedes the LIMIT
   below as written in Phase 2): the schema slot is no longer null in
   production. The declared interface is `operation list --json`'s
   `proposalSchema` column on the `proposal.create` row
   (`loadProposalSchema` in `operation-labels.ts`, interface doc §5);
   the host shape-checks it (non-empty plain object) and passes the
   real declared value through to the review; a missing/illegal schema
   fails proposal creation (`proposal_review_schema_missing`, no code,
   no downgrade to summary-only comparison). The reviewer prompt still
   compares summaryText against the dry-run envelope — the schema is
   passed through, not field-by-field validated by the host — so
   schema-conformance as a field check is still not claimed. When no
   reviewer is injected, creation now fails closed
   (`proposal_review_required`); the `proposal_review_skipped` event
   has been deleted. Production assembly now injects the driver
   (`apps/server/assembly.ts`: `reviewProposalWithDriver(contextModelDriver)`
   + `proposalSchemaLoader`). Still open, unchanged: a truly
   independent judge model (assembly uses the context-model driver,
   not a separate judge) and real-model tamper detection.
4. committed_unverified terminal state — `packages/agent/src/committed-unverified.ts`
   (mechanical classifier on envelope fields only: error code
   PROPOSAL_VERIFY_SHORT, or readback delta < required; report text
   "已落账、读回不足、需人工核对" + a reconciliation entry, never
   "已完成") + classification in `apps/server/proposal-commit.ts` +
   host terminal in `context.ts`: new `ConfirmationOutcome`
   `confirm_committed_unverified`; intent goes to `committed` (platform
   side is terminal, no second commit), task outcome goes to `failed`
   (human reconciliation still open, task is not done) via
   `task-manager.ts`.
5. Tool-definition-removed scripted turn — `packages/agent/src/tool-definition-guard.ts`
   (pure: tools removed + zero execution blocks, regardless of how
   formatted the model text looks) + a scripted turn-exit proof in
   `packages/agent/src/phase2.test.ts`: a fixed formatted fake answer
   with zero execution is not passed through by `decideTurnExit`.
   Scripted, not a real model — stated as such in the test and here.
6. Eval cases — the four former SKIP cases are now real cases in
   `scripts/eval/generic-mock.ts` (21 cases, 0 skipped), plus a new
   `g-committed-unverified-report` case for the host report. Baseline is
   now v2 (`generic-mock-baseline.json`, version 2).
   `scripts/eval/generic-mock.ts` imports the host pure modules by
   relative path (tsx does not resolve the `@fshine/agent` alias);
   the script typechecks under the repo tsconfig settings via a
   temporary tsconfig (repo tsconfig excludes `scripts/`).

## Phase 2 — commands and actual results (this session, same branch)

- `npm run eval:generic-mock -- --write-baseline` → exit 0.
  21 cases PASS, 0 SKIP (16 Phase 1 + 4 converted + 1 new report case).
- `npm run eval:generic-mock` (compare against v2 baseline) → exit 0.
  21 cases pass, 0 skipped.
- `npm run typecheck` → exit 0 (repo tsconfig, excludes `scripts/`).
- Script typecheck: `npx tsc --noEmit` on generic-mock.ts under the repo
  tsconfig settings (temporary tsconfig in /tmp, not committed) → exit 0.
  One pre-existing null-narrowing spot in g-readback-short was fixed
  (`commitEnv.data` → `commitEnv?.data`); it was not a Phase 2 behaviour
  change.
- `npm run test -- --project unit` → 97 files, 1655 tests, ALL PASS
  (including the 14 new phase2 tests and the 4 generic-mock tests).
  Two lint failures appeared on the first full run and were fixed by
  the repo's own mechanisms, not by weakening the lint: the word 记录
  in a new context.ts comment was reworded to 打一条日志, and
  FSHINE_WORKER_STEP_CAP was registered in the FSHINE_NAME_REGISTRY
  (see item 1 above).
- `npm run test` (full, unit + e2e) was NOT re-run in Phase 2; the
  Phase 1 e2e caveat stands (missing gitignored `config/agent.yaml`
  in this clone). Re-run the full suite on a machine with a real
  deployment config before merging.
- No LLM was available in this environment, so `npm run eval`
  (real-model probe) was NOT run and must NOT be reported as run.

## What was built

- `scripts/eval/fixtures/dummy-platform/bin/dummy` (shell shim) +
  `bin/dummy.cjs` (Node implementation, CommonJS — the repo is
  `"type": "module"`, so an extensionless Node file loads as ESM and fails;
  the shim is the workaround, documented here so nobody "simplifies" it away).
- `bin/generic` inside the fixture is a symlink to `dummy`. That is the
  generic gateway name (see docs/execution-layer-interface.md §0):
  fshine's `gatewayExecPath(platformRoot, 'bin/generic')` resolves to
  `<root>/bin/generic`. The finance instance's own gateway name
  (`bin/17dz`) lives only in that instance's profile, not here.
  The dummy's primary entry is still `bin/dummy`; the symlink is not a
  second implementation.
- `scripts/lint-operations.js` in the fixture, for fshine's assembly health
  gate (`<platformRoot>/scripts/lint-operations.js` must exit 0).
- `scripts/eval/generic-mock.ts` — deterministic eval, no model, no network,
  no finance execution-layer checkout. Command: `npm run eval:generic-mock` (full) or
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

## Phase 2 — what the converted cases do NOT prove (read before quoting)

- g-step-cap-50-51 proves the decision boundary (50 no wind-down, 51
  wind-down, configurable, invalid falls back). It does NOT prove the
  live worker driver fires the steer at the 51st allowed bash in a real
  worker session — that wiring is code-reviewed, not live-run. A
  scripted worker-session test for the steer is still open.
- g-handover-file proves the file round-trip, the resume merge
  (no double count), and fail-closed parsing. It does NOT prove a
  resumed real task reads the handover before re-delegation in
  production — the wiring exists in context.ts, but no end-to-end
  resumed-task run was done here (no model, no deployment config).
- g-tool-definition-removed proves the guard and the turn-exit block
  for a fixed fake answer. It does NOT prove a real model, with tools
  removed, would be blocked in a live turn — that needs a real-model
  (or scripted-driver) worker run, not a dummy CLI call.
- g-tampered-summary-review proves the host gate contract with a
  scripted reviewer (inconsistent => no code, consistent => code) and
  the mechanical pre-checks. It does NOT prove a real model reviewer
  would catch a tampered summary. Real-model tamper detection is
  still open, and a truly independent judge model is still open —
  but the production reviewer driver IS now wired (Package 2:
  `apps/server/assembly.ts` injects
  `reviewProposalWithDriver(contextModelDriver)`; un-injected runs
  no longer log `proposal_review_skipped` and proceed, they fail
  closed with `proposal_review_required`).
- g-committed-unverified-report proves the classifier and the report
  text. The platform side (proposal becomes committed, partial count)
  is already proven by g-readback-short on the dummy.

## Baseline v2 (generic-mock-baseline.json, 21 cases)

- Phase 1 cases (16, unchanged):
  smoke-query, smoke-prepare-commit, smoke-not-found,
  g-a1-requery, g-a2-cross-contamination, g-a3-ambiguity-mechanical,
  g-a4-not-found-zero-leak, g-a5-idle-zero-calls, g-b1-stability,
  g-y2-error-honesty, g-plan-gate, g-serve-matrix, g-readback-short,
  g-proposal-expired, g-proposal-token-untrusted, g-state-isolation
- Phase 2 cases (5):
  g-step-cap-50-51, g-handover-file, g-tool-definition-removed,
  g-tampered-summary-review, g-committed-unverified-report

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
- It does not prove the live behaviours listed under "what the
  converted cases do NOT prove" (live worker steer, resumed-task
  end-to-end, real-model tamper detection, production reviewer wiring).
  Those are unproven, not skipped — and not passed either.

## Skipped cases (none in Phase 2)

- No skipped cases remain in generic-mock eval: 21 cases, 0 skipped.
  The residual open items are listed under "what the converted cases
  do NOT prove" above — they are unproven live behaviours, not hidden
  skips, and must be quoted that way.

## Other TODO (not in Phase 1, not in Phase 2)

- memory / breaker / cache auxiliary groups in dummy (not implemented;
  dummy returns usage exit 2 for them).
- Plan grind / variant guards (maxNotify, maxReplans, maxVariants) in
  dummy — simplified decision only (weight + calls/seconds, stricter wins).
- Rate-limit token bucket in dummy.
- Production wiring of the proposal reviewer driver into assembly
  (`proposalReviewTurn`): LANDED in Package 2
  (`apps/server/assembly.ts`: `reviewProposalWithDriver(contextModelDriver)`
  + `proposalSchemaLoader: loadProposalSchema`); un-injected runs fail
  closed (`proposal_review_required`), `proposal_review_skipped` is
  deleted. What is still open is a truly independent judge model
  (assembly reuses the context-model driver) and real-model tamper
  detection — do not present either as done.
- Platform proposal-schema endpoint: LANDED in Package 2 as the
  `proposalSchema` column on the `proposal.create` row of
  `operation list --json` (interface doc §5, `loadProposalSchema`);
  the review's schema slot now carries the real declared value and a
  missing/illegal schema fails creation. Field-by-field
  schema-conformance checking by the host is still not claimed: the
  host only shape-checks and passes the schema through, and the
  reviewer prompt compares summaryText against the dry-run envelope.
- Scripted worker-session test for the step-cap steer firing at the
  51st allowed bash (decision boundary is proven, live steer is not).
- Moving session/sensitive state out of the worker-readable workspace
  (dummy has no browser profile or platform session, so this gap is
  execution-layer-instance side, not dummy-side).
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
