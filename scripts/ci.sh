#!/bin/sh
# Deterministic CI entry point, run locally and by GitHub Actions (.github/workflows/ci.yml).
# Runs only the deterministic gates: typecheck, unit tests, generic-mock eval.
#
# Real-model eval lives in a separate workflow: .github/workflows/eval-real.yml.
# It is separate for three reasons:
#   1. Cost profile: real-model calls consume LLM tokens; per-push CI would
#      burn through the monthly budget on every branch and draft PR.
#   2. Secrets: the eval workflow needs LLM_API_* secrets, which are not
#      available to the deterministic ci.yml (contents: read only).
#   3. Judge variance: the judge component is advisory-only and must never
#      become a per-push blocking gate; the mechanical component is the
#      exit-code carrier for the real-model job.
# Finance-domain eval (probe-real-agent / acceptance / score.ts) needs a real
# execution layer + local config/agent.yaml and stays Tier B (manual before
# merge + nightly), not every-push CI.
# e2e ownership (generic vs L4 integration, per-file): docs/e2e-ownership.md.
# CI scope is unchanged by that inventory: no finance e2e is added back here.
# CI runs only the deterministic gates; consistency between this repo's generic
# budget-protocol defaults and any execution layer's own policy is owned by the
# execution layer's repository, not by this single-repo CI (the check moved there
# in wave W4). Boundary registered as a known limit: docs/debt-ledger.md D-150.
set -eu
cd "$(dirname "$0")/.."
echo "== node =="
node --version
echo "== typecheck =="
npm run typecheck
echo "== unit tests =="
npm run test -- --project unit
echo "== generic-mock eval =="
npm run eval:generic-mock
echo "== fallback retirement counter =="
node --import tsx scripts/eval/count-a2a-fallback.ts --threshold 20
echo "CI deterministic gates: PASS"
