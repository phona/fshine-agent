#!/bin/sh
# Deterministic CI entry point, used by Gitee Go and locally.
# Runs only the deterministic gates: typecheck, unit tests, generic-mock eval.
# It deliberately does NOT run the real-model eval (npm run eval) or e2e:
# - real-model eval needs LLM credentials and has judge variance;
# - e2e needs a gitignored local config/agent.yaml (deployment config).
# Those are Tier B (manual before merge + nightly), not every-push CI.
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
