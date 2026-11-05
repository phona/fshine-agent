#!/bin/sh
# Deterministic CI entry point, run locally and by GitHub Actions (.github/workflows/ci.yml).
# Runs only the deterministic gates: typecheck, unit tests, generic-mock eval.
# It deliberately does NOT run the real-model eval (npm run eval) or e2e:
# - real-model eval needs LLM credentials and has judge variance;
# - e2e needs a gitignored local config/agent.yaml (deployment config).
# Those are Tier B (manual before merge + nightly), not every-push CI.
# e2e ownership (generic vs L4 integration, per-file): docs/e2e-ownership.md.
# CI scope is unchanged by that inventory: no finance e2e is added back here.
# The cross-repo budget-threshold check (npm run check:cross-repo-budget) is also
# NOT in this CI: it needs a sibling 17dz checkout, which single-repo CI does not
# have. Its real comparison runs only when CROSS_REPO_17DZ_ROOT is set explicitly
# (dev/review time); the default green suite covers it with fixtures only.
# Boundary registered as a known limit: docs/debt-ledger.md D-150.
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
echo "CI deterministic gates: PASS"
