import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const workflow = fs.readFileSync('.github/workflows/codex-pr-review.yml', 'utf8')

test('workflow is a same-repo ChatGPT OAuth review on ubuntu-latest', () => {
  assert.match(workflow, /runs-on: ubuntu-latest/)
  assert.doesNotMatch(workflow, /self-hosted/)
  assert.match(workflow, /contents: read/)
  assert.match(workflow, /pull-requests: write/)
  assert.match(workflow, /fetch-depth: 0/)
  assert.match(workflow, /types: \[opened, synchronize, reopened\]/)
  assert.match(workflow, /branches: \[main\]/)
  assert.match(workflow, /codex-pr-review:/)
  assert.match(workflow, /chmod 700 "\$CODEX_HOME"/)
  assert.match(workflow, /chmod 600 "\$CODEX_HOME\/auth\.json"/)
  assert.match(workflow, /cli_auth_credentials_store = "file"/)
  assert.equal(workflow.split('secrets.CODEX_AUTH_JSON').length - 1, 1)
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|CODEX_API_KEY/)
  assert.doesNotMatch(workflow, /--approve|event: APPROVE|APPROVE'/)
})

test('secret use is guarded by the same-repo condition', () => {
  const secretAt = workflow.indexOf('secrets.CODEX_AUTH_JSON')
  assert.ok(secretAt > 0)
  const stepStart = workflow.lastIndexOf('\n      - name:', secretAt)
  const next = workflow.indexOf('\n      - name:', secretAt)
  const step = workflow.slice(stepStart, next === -1 ? workflow.length : next)
  assert.match(step, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/)
  assert.match(step, /success\(\)/)
  assert.match(workflow, /HEAD_REPO" != "\$THIS_REPO"/)
  assert.match(workflow, /unset CODEX_AUTH_JSON/)
  assert.match(workflow, /unset GITHUB_TOKEN GH_TOKEN/)
})

test('CODEX_MODEL and CODEX_EFFORT are optional and use the 0.166 flags', () => {
  assert.match(workflow, /CODEX_MODEL: \$\{\{ vars\.CODEX_MODEL \}\}/)
  assert.match(workflow, /CODEX_EFFORT: \$\{\{ vars\.CODEX_EFFORT \}\}/)
  assert.match(workflow, /if \[ -n "\$\{CODEX_MODEL:-}" \]; then\s+cmd\+=\(-m "\$CODEX_MODEL"\)/)
  assert.match(workflow, /if \[ -n "\$\{CODEX_EFFORT:-}" \]; then/)
  assert.match(workflow, /model_reasoning_effort=\\"\$\{CODEX_EFFORT\}\\"/)
  assert.doesNotMatch(workflow, /--effort\b/)
})
