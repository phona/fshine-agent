#!/bin/sh
# Deterministic CI entry point, run locally and by GitHub Actions (.github/workflows/ci.yml).
# Runs only the deterministic gates: typecheck + unit tests (含 Execution Contract 行为测试、
# 安全不变量指定测试；单位测试即契约行为测试的运行面).
#
# 评测口径（M4 收口，详见 docs/decision-log.md §十三）：
#   · 确定性门 = typecheck + unit（含契约行为测试）；
#   · 用户级评测 = eval:user（并行分支交付，合并后生效）——本仓当前无真实模型评测入口。
# generic-mock 夹具评测与真实模型 eval 工作流（eval-real/eval-nightly/eval-measure）已随
# M2 波次 1 删除的 harness 一并退役（无后继脚本可指）；恢复真实模型评测面须先有可运行且被
# 测试钉住的 harness 与 owner 裁定，禁止再指向已删脚本。
set -eu
cd "$(dirname "$0")/.."
echo "== node =="
node --version
echo "== typecheck =="
npm run typecheck
echo "== unit tests =="
npm run test -- --project unit
echo "CI deterministic gates: PASS"
