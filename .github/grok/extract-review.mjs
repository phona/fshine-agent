import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Grok CLI 的 --output-format plain 仍把单轮回答包进一个 JSON 信封：
// { text, structuredOutput, usage, ... }。review-schema.json 的输出在
// structuredOutput（已解析的对象），text 里是同一份 JSON 的字符串。
// 本脚本只抽那份对象出来，不把信封其他字段（thought、usage、sessionId）
// 写进审查文件。两个来源都没有可用 JSON 时直接失败，不编一个空审查。
export function extractReview(raw) {
  let envelope
  try {
    envelope = JSON.parse(String(raw ?? ''))
  } catch {
    throw new Error('Grok output is not JSON')
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Grok output is not an object')
  }
  const structured = envelope.structuredOutput
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    return structured
  }
  if (typeof envelope.text === 'string' && envelope.text.trim() !== '') {
    try {
      const parsed = JSON.parse(envelope.text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // fall through to the error below
    }
  }
  // 失败时把诊断写进错误本身：只凭「没有 structuredOutput」查不出是模型
  // 没按 schema 回、还是中途异常结束。2026-11-19 首跑就是后一种的表象
  // （8 分钟调用正常结束，信封里却无可用 JSON），当时只能靠贴日志定位。
  throw new Error(
    `Grok output has no structuredOutput or parsable text (${describeEnvelope(envelope)})`,
  )
}

// 失败诊断：只取信封自带的结束原因、轮数与 text 开头，不读其他字段。
function describeEnvelope(envelope) {
  const parts = []
  if (typeof envelope.stopReason === 'string' && envelope.stopReason !== '') {
    parts.push(`stopReason=${envelope.stopReason}`)
  }
  if (typeof envelope.num_turns === 'number') {
    parts.push(`turns=${envelope.num_turns}`)
  }
  if (typeof envelope.text === 'string') {
    const excerpt = envelope.text.replace(/\s+/g, ' ').trim().slice(0, 500)
    parts.push(excerpt === '' ? 'text empty' : `text=${excerpt}`)
  } else {
    parts.push('text missing')
  }
  return parts.join(', ')
}

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(path.resolve(entry)).href
}

if (isMain()) {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) {
    console.error('usage: extract-review.mjs <grok-stdout.json> <review.json>')
    process.exit(2)
  }
  try {
    const review = extractReview(fs.readFileSync(input, 'utf8'))
    fs.writeFileSync(output, `${JSON.stringify(review, null, 2)}\n`)
    console.log(`extracted review bytes=${fs.statSync(output).size}`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
