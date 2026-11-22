import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeReviews } from './merge-reviews.mjs'

function chunk(overrides = {}) {
  return {
    summary: '块摘要',
    verdict: 'comment',
    findings: [],
    ...overrides,
  }
}

test('all-comment chunks merge to comment and concatenate findings', () => {
  const merged = mergeReviews([
    chunk({ findings: [{ severity: 'major', title: '口径', path: 'a.ts', body: 'x' }] }),
    chunk({ findings: [{ severity: 'nit', title: '措辞', path: 'b.ts', body: 'y' }] }),
  ])
  assert.equal(merged.verdict, 'comment')
  assert.equal(merged.findings.length, 2)
  assert.match(merged.summary, /没有 blocking/)
})

test('any blocking finding forces request_changes even if every chunk said comment', () => {
  const merged = mergeReviews([
    chunk({ verdict: 'comment', findings: [{ severity: 'blocking', title: '口径写错', path: 'config/house.yaml', body: '面积和权威源不一致。' }] }),
    chunk(),
  ])
  assert.equal(merged.verdict, 'request_changes')
  assert.match(merged.summary, /blocking 1 项/)
})

test('a request_changes chunk forces request_changes even with only nits', () => {
  const merged = mergeReviews([
    chunk({ verdict: 'request_changes', findings: [{ severity: 'nit', title: '措辞', path: '', body: '标题可以更短。' }] }),
    chunk(),
  ])
  assert.equal(merged.verdict, 'request_changes')
})

test('findings are deduplicated by file + title, first occurrence wins', () => {
  const merged = mergeReviews([
    chunk({ findings: [{ severity: 'minor', title: '重复项', path: 'a.ts', body: '先出现' }] }),
    chunk({ findings: [{ severity: 'blocking', title: '重复项', path: 'a.ts', body: '后出现' }] }),
  ])
  assert.equal(merged.findings.length, 1)
  assert.equal(merged.findings[0].severity, 'minor')
  assert.equal(merged.findings[0].body, '先出现')
})

test('same title in different files is not a duplicate', () => {
  const merged = mergeReviews([
    chunk({ findings: [{ severity: 'minor', title: '同题', path: 'a.ts', body: 'x' }] }),
    chunk({ findings: [{ severity: 'minor', title: '同题', path: 'b.ts', body: 'y' }] }),
  ])
  assert.equal(merged.findings.length, 2)
})

test('a single chunk merges to itself minus summary rewording', () => {
  const one = chunk({ findings: [{ severity: 'major', title: 't', path: 'p.ts', body: 'b' }] })
  const merged = mergeReviews([one])
  assert.equal(merged.verdict, 'comment')
  assert.equal(merged.findings.length, 1)
  assert.deepEqual(merged.findings[0], one.findings[0])
})
