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
# 真实模型 eval（旧 probe / acceptance / score.ts / generic-model-eval.py 仪器）已随
# Minimal Reset（0b97227）删除不再恢复；当前真实模型面 = 用户级黑盒入口
# `npm run eval:user`，跑在 eval-real.yml（per-push 1 轮）与 eval-nightly.yml（12×3），
# 不进这些确定性门。
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
echo "CI deterministic gates: PASS"
