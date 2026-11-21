/**
 * PR 审查流水线的形态契约（2026-11-21：Codex 订阅停用，审查改本地端点 grok + self-hosted runner）。
 *
 * 这份测试守的是"流水线还能审"的硬条件——不是审查看起来像不像，而是：
 *   ① 只在同仓 PR 上跑、fork 不读 secret；
 *   ② 模型端点与密钥只经 env 注入，且**审查步骤之前 unset GitHub 令牌**（审查者拿不到仓库凭证）；
 *   ③ 输出必须过既有 schema 校验与 render（不允许自由格式评论）；
 *   ④ 有 blocking 才 REQUEST_CHANGES，永不 APPROVE；
 *   ⑤ 未装 runner/未启用时 job 关闭（vars.PR_REVIEW_ENABLED），不让 check 永远排队或永远红。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const workflow = fs.readFileSync('.github/workflows/pr-review.yml', 'utf8')

test('workflow 在 self-hosted runner 上跑，且由 PR_REVIEW_ENABLED 显式开启', () => {
  // runner 默认 ubuntu-latest（secrets 是云通道）；需要局域网端点时用 vars.PR_REVIEW_RUNNER 切 self-hosted。
  assert.match(workflow, /runs-on: \$\{\{ fromJSON\(vars\.PR_REVIEW_RUNNER \|\| '\["ubuntu-latest"\]'\) \}\}/)
  assert.match(workflow, /if: vars\.PR_REVIEW_ENABLED == 'true'/)
  assert.match(workflow, /types: \[opened, synchronize, reopened\]/)
  assert.match(workflow, /branches: \[main\]/)
  assert.match(workflow, /pr-review:/)
  assert.match(workflow, /contents: read/)
  assert.match(workflow, /pull-requests: write/)
  assert.match(workflow, /fetch-depth: 0/)
})

test('模型调用走本地端点（env 注入），密钥与 GitHub 令牌在审查前隔离', () => {
  assert.match(workflow, /LLM_API_BASE_URL: \$\{\{ secrets\.LLM_API_BASE_URL \}\}/)
  assert.match(workflow, /LLM_API_KEY: \$\{\{ secrets\.LLM_API_KEY \}\}/)
  assert.match(workflow, /PR_REVIEW_MODEL: \$\{\{ vars\.PR_REVIEW_MODEL \|\| secrets\.LLM_MODEL \}\}/)
  assert.match(workflow, /node \.github\/codex\/llm-review\.mjs/)
  // 审查步骤里先 unset 仓库令牌，再调模型（顺序断言，不只看是否出现）。
  const unsetAt = workflow.indexOf('unset GITHUB_TOKEN GH_TOKEN')
  const callAt = workflow.indexOf('node .github/codex/llm-review.mjs')
  assert.ok(unsetAt > 0 && callAt > unsetAt, 'must unset GH tokens before the model call')
  // 不再有 Codex 的 OAuth/auth.json 面。
  assert.doesNotMatch(workflow, /CODEX_AUTH_JSON|codex login|CODEX_HOME/)
})

test('secret 只在同仓 PR 的步骤里出现，fork 走显式拒绝', () => {
  const secretAt = workflow.indexOf('secrets.LLM_API_KEY')
  assert.ok(secretAt > 0)
  const stepStart = workflow.lastIndexOf('\n      - name:', secretAt)
  const next = workflow.indexOf('\n      - name:', secretAt)
  const step = workflow.slice(stepStart, next === -1 ? workflow.length : next)
  assert.match(step, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/)
  assert.match(step, /success\(\)/)
  assert.match(workflow, /HEAD_REPO" != "\$THIS_REPO"/)
})

test('输出必须过 schema 校验与 render，且永不 APPROVE', () => {
  assert.match(workflow, /render-review\.mjs scrub/)
  assert.match(workflow, /render-review\.mjs publish/)
  assert.match(workflow, /build-prompt\.mjs/)
  assert.match(workflow, /COMMENT\|REQUEST_CHANGES/)
  assert.doesNotMatch(workflow, /event: APPROVE|APPROVE'/)
  assert.doesNotMatch(workflow, /--approve/)
})

test('审查内容文件写入端与消费端接线一致（llm-review → scrub → publish）', () => {
  // 2026-11-21 实测事故：llm-review 把回答写进 review-stdout.txt，scrub 却检查 review.json，
  // 模型明明给出了 review，流水线仍报「Codex did not write a review」且不暴露原因。
  // 三个脚本各自的单测都绿——断的是它们之间的文件路径接线，所以在这里按路径钉死。
  const llm = workflow.match(/node \.github\/codex\/llm-review\.mjs\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]+)"/)
  assert.ok(llm, 'llm-review invocation found')
  const [, promptPath, reviewPath, errPath] = llm
  assert.notEqual(reviewPath, promptPath, 'review file must not overwrite the prompt')
  assert.notEqual(reviewPath, errPath, 'review file must not collide with stderr file')
  const scrub = workflow.match(/render-review\.mjs scrub "\$status" \\\n\s*"([^"]+)" \\\n\s*"([^"]+)" \\\n\s*"([^"]+)"/)
  assert.ok(scrub, 'scrub invocation found')
  assert.equal(scrub[1], reviewPath, 'scrub stdout slot must be the file llm-review writes')
  assert.equal(scrub[2], errPath, 'scrub stderr slot must be llm-review stderr file')
  assert.equal(scrub[3], reviewPath, 'scrub review slot must be the file llm-review writes')
  const publish = workflow.match(/render-review\.mjs publish \\\n\s*"([^"]+)"/)
  assert.ok(publish, 'publish invocation found')
  assert.equal(publish[1], reviewPath, 'publish must read the file llm-review writes')
})
