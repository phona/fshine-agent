import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseReview } from './render-review.mjs'

// 把 N 块分块审查合并成一份 review。判定语义不变：
// - verdict：任一块有 request_changes，或任一 finding 是 blocking，就 request_changes；否则 comment。
// - findings：全部串联，按「文件 + 主题」（path + title）去重，保留先出现的。
// 返回 { summary, verdict, findings }，可直接交给 render-review.mjs。
export function mergeReviews(reviews) {
  const findings = []
  const seen = new Set()
  for (const review of reviews) {
    for (const finding of review.findings ?? []) {
      const key = `${finding.path}\u0000${finding.title}`
      if (seen.has(key)) continue
      seen.add(key)
      findings.push(finding)
    }
  }
  const requestChanges = reviews.some((review) => review.verdict === 'request_changes')
  const blocking = findings.some((finding) => finding.severity === 'blocking')
  const verdict = requestChanges || blocking ? 'request_changes' : 'comment'
  const blockingCount = findings.filter((finding) => finding.severity === 'blocking').length
  const summary = requestChanges || blocking
    ? `合并 ${reviews.length} 块分块审查，有需要修改的项（blocking ${blockingCount} 项）。`
    : `合并 ${reviews.length} 块分块审查，没有 blocking 项。`
  return { summary, verdict, findings }
}

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(path.resolve(entry)).href
}

if (isMain()) {
  const [output, ...inputs] = process.argv.slice(2)
  if (!output || inputs.length === 0) {
    console.error('usage: merge-reviews.mjs <out> <chunk-review-1.json> [<chunk-review-2.json> ...]')
    process.exit(2)
  }
  // 排序保证合并顺序确定，与 chunk 编号无关的输入顺序。
  const sorted = [...inputs].sort()
  try {
    const reviews = sorted.map((file) => parseReview(fs.readFileSync(file, 'utf8')))
    const merged = mergeReviews(reviews)
    fs.writeFileSync(output, `${JSON.stringify(merged, null, 2)}\n`)
    console.log(`merged ${sorted.length} chunk reviews bytes=${fs.statSync(output).size}`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
