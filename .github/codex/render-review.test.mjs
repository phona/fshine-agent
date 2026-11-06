import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  decideEvent,
  findCredentialMarker,
  parseReview,
  renderMarkdown,
  scrubOutputFiles,
} from './render-review.mjs'

const HEAD = 'c'.repeat(40)

function review(overrides = {}) {
  return {
    summary: '没有 blocking 项。',
    verdict: 'comment',
    findings: [],
    ...overrides,
  }
}

test('empty findings stay a comment and never approve', () => {
  const event = decideEvent(review())
  assert.equal(event, 'COMMENT')
  const markdown = renderMarkdown(review(), { headSha: HEAD }).markdown
  assert.match(markdown, /不提交 APPROVE/)
  assert.match(markdown, /COMMENT/)
  assert.equal(markdown.includes('APPROVE review'), false)
})

test('blocking findings request changes even if the model said comment', () => {
  const parsed = review({
    verdict: 'comment',
    findings: [{ severity: 'blocking', title: '口径写错', path: 'config/house.yaml', body: '面积和权威源不一致。' }],
  })
  assert.equal(decideEvent(parsed), 'REQUEST_CHANGES')
  const markdown = renderMarkdown(parsed, { headSha: HEAD }).markdown
  assert.match(markdown, /\*\*blocking\*\* 口径写错 `config\/house\.yaml`/)
  assert.match(markdown, /REQUEST_CHANGES/)
})

test('request_changes with only nits is still request changes', () => {
  const parsed = review({
    verdict: 'request_changes',
    summary: '模型要求修改。',
    findings: [{ severity: 'nit', title: '措辞', path: '', body: '标题可以更短。' }],
  })
  assert.equal(decideEvent(parsed), 'REQUEST_CHANGES')
})

test('major and nit findings stay comments', () => {
  for (const severity of ['major', 'minor', 'nit']) {
    const event = decideEvent(review({
      findings: [{ severity, title: '问题', path: 'a.ts', body: '说明' }],
    }))
    assert.equal(event, 'COMMENT')
  }
})

test('parser accepts a fenced json object and rejects approve', () => {
  const parsed = parseReview('```json\n{"summary":"好","verdict":"comment","findings":[]}\n```')
  assert.equal(parsed.summary, '好')
  assert.throws(() => parseReview('{"summary":"好","verdict":"approve","findings":[]}'), /verdict is invalid/)
})

test('credential-shaped output is refused and deleted', () => {
  const jwt = `eyJ${'a'.repeat(24)}.${'b'.repeat(16)}`
  assert.equal(findCredentialMarker('讨论 refresh_token 这个字段名'), null)
  assert.equal(findCredentialMarker(jwt), 'jwt')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-'))
  const file = path.join(dir, 'review.json')
  fs.writeFileSync(file, JSON.stringify({ summary: jwt }))
  assert.throws(() => scrubOutputFiles([file]), (error) => {
    assert.match(error.message, /credential marker jwt/)
    assert.equal(error.message.includes(jwt), false)
    return true
  })
  assert.equal(fs.existsSync(file), false)
})
