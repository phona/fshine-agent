import assert from 'node:assert/strict'
import test from 'node:test'
import { extractReview } from './extract-review.mjs'

const review = { summary: '好', verdict: 'comment', findings: [] }

test('structuredOutput wins over text', () => {
  const envelope = JSON.stringify({
    text: JSON.stringify({ summary: 'text 版', verdict: 'comment', findings: [] }),
    structuredOutput: review,
  })
  assert.deepEqual(extractReview(envelope), review)
})

test('text fallback parses when structuredOutput is missing', () => {
  const envelope = JSON.stringify({ text: JSON.stringify(review) })
  assert.deepEqual(extractReview(envelope), review)
})

test('no usable review fails loudly instead of inventing one', () => {
  assert.throws(() => extractReview('not json'), /Grok output is not JSON/)
  assert.throws(() => extractReview(JSON.stringify({ text: 'plain prose' })), /no structuredOutput/)
  assert.throws(() => extractReview(JSON.stringify({ structuredOutput: [] })), /no structuredOutput/)
})

test('failure message carries envelope diagnostics for the log', () => {
  const envelope = JSON.stringify({
    text: 'the model wrote prose instead of JSON',
    stopReason: 'end_turn',
    num_turns: 12,
  })
  assert.throws(
    () => extractReview(envelope),
    /stopReason=end_turn.*turns=12.*text=the model wrote prose/,
  )
  assert.throws(
    () => extractReview(JSON.stringify({})),
    /text missing/,
  )
})
