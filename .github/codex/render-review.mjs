import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const SEVERITIES = ['blocking', 'major', 'minor', 'nit']
const MAX_MARKDOWN = 60_000

export function findCredentialMarker(text) {
  const patterns = [
    ['jwt', /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
    ['private-key', /BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY/],
    ['github-token', /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
    ['auth-json-token', /"(?:refresh_token|access_token|id_token)"\s*:\s*"[^"]{8,}"/],
  ]
  const hit = patterns.find(([, re]) => re.test(text))
  return hit?.[0] ?? null
}

export function parseReview(raw) {
  let text = String(raw ?? '').trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Codex review output is not JSON')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Codex review output is not an object')
  }
  if (typeof data.summary !== 'string' || data.summary.trim() === '') {
    throw new Error('review.summary is missing')
  }
  if (data.verdict !== 'request_changes' && data.verdict !== 'comment') {
    throw new Error('review.verdict is invalid')
  }
  if (!Array.isArray(data.findings)) throw new Error('review.findings is not an array')
  const findings = data.findings.map((finding, index) => {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      throw new Error(`findings[${index}] is not an object`)
    }
    if (!SEVERITIES.includes(finding.severity)) throw new Error(`findings[${index}].severity is invalid`)
    for (const key of ['title', 'path', 'body']) {
      if (typeof finding[key] !== 'string') throw new Error(`findings[${index}].${key} is invalid`)
    }
    return {
      severity: finding.severity,
      title: finding.title.trim(),
      path: finding.path.trim(),
      body: finding.body.trim(),
    }
  })
  return { summary: data.summary.trim(), verdict: data.verdict, findings }
}

export function decideEvent(review) {
  const blocking = review.findings.some((finding) => finding.severity === 'blocking')
  if (blocking || review.verdict === 'request_changes') return 'REQUEST_CHANGES'
  return 'COMMENT'
}

export function renderMarkdown(review, { headSha }) {
  if (!/^[0-9a-f]{40}$/.test(headSha ?? '')) throw new Error('unexpected head sha')
  const event = decideEvent(review)
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [
    severity,
    review.findings.filter((finding) => finding.severity === severity).length,
  ]))
  const lines = [
    '## Codex review',
    '',
    review.summary,
    '',
    `blocking ${counts.blocking} · major ${counts.major} · minor ${counts.minor} · nit ${counts.nit}`,
    '',
  ]
  if (review.findings.length === 0) {
    lines.push('没有发现项。')
    lines.push('')
  } else {
    lines.push('### Findings')
    lines.push('')
    for (const severity of SEVERITIES) {
      for (const finding of review.findings.filter((item) => item.severity === severity)) {
        const where = finding.path ? ` \`${finding.path}\`` : ''
        lines.push(`- **${finding.severity}** ${finding.title}${where}`)
        if (finding.body) {
          lines.push('')
          lines.push(finding.body)
          lines.push('')
        }
      }
    }
  }
  lines.push('---')
  lines.push('')
  lines.push(`审查提交 \`${headSha}\`。GitHub review 事件：\`${event}\`。`)
  lines.push('')
  lines.push('本工作流不提交 APPROVE。没有 blocking 项时用 COMMENT，只表示审查跑完了，不是批准。blocking，或模型给出的 `request_changes`，用 REQUEST_CHANGES，并把本检查标红，便于把它设为 required check。')
  let markdown = `${lines.join('\n').trim()}\n`
  if (markdown.length > MAX_MARKDOWN) {
    const note = '\n\n…（审查正文已截断以符合 GitHub review 长度限制）\n'
    markdown = markdown.slice(0, MAX_MARKDOWN - note.length) + note
  }
  return { event, markdown }
}

export function scrubOutputFiles(files) {
  const hits = []
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    const marker = findCredentialMarker(fs.readFileSync(file, 'utf8'))
    if (marker) hits.push(marker)
  }
  if (hits.length === 0) return
  for (const file of files) {
    if (fs.existsSync(file)) fs.rmSync(file)
  }
  throw new Error(`refusing to keep Codex output: credential marker ${hits[0]}`)
}

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(path.resolve(entry)).href
}

function scrubCommand(statusText, files) {
  const status = Number(statusText)
  if (!Number.isInteger(status)) {
    console.error('scrub expected an exit status')
    process.exit(2)
  }
  try {
    scrubOutputFiles(files)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
  if (status !== 0) {
    const stderrFile = files[1]
    if (stderrFile && fs.existsSync(stderrFile)) {
      const stderr = fs.readFileSync(stderrFile, 'utf8')
      const tail = stderr.split('\n').slice(-80).join('\n')
      process.stderr.write(tail.endsWith('\n') || tail.length === 0 ? tail : `${tail}\n`)
    }
    process.exit(status)
  }
  const reviewFile = files[2]
  if (!reviewFile || !fs.existsSync(reviewFile) || fs.statSync(reviewFile).size === 0) {
    console.error('Codex did not write a review')
    process.exit(1)
  }
  console.log(`codex exec completed bytes=${fs.statSync(reviewFile).size}`)
}

function publishCommand(reviewFile, markdownFile, eventFile, headSha) {
  const raw = fs.readFileSync(reviewFile, 'utf8')
  const marker = findCredentialMarker(raw)
  if (marker) {
    fs.rmSync(reviewFile, { force: true })
    throw new Error(`refusing to publish review: credential marker ${marker}`)
  }
  const rendered = renderMarkdown(parseReview(raw), { headSha })
  const renderedMarker = findCredentialMarker(rendered.markdown)
  if (renderedMarker) throw new Error(`refusing to publish review: credential marker ${renderedMarker}`)
  if (rendered.event !== 'COMMENT' && rendered.event !== 'REQUEST_CHANGES') {
    throw new Error('refusing review event')
  }
  fs.writeFileSync(markdownFile, rendered.markdown)
  fs.writeFileSync(eventFile, `${rendered.event}\n`)
  console.log(rendered.event)
}

if (isMain()) {
  const [command, ...args] = process.argv.slice(2)
  try {
    if (command === 'scrub') scrubCommand(args[0], args.slice(1))
    else if (command === 'publish') publishCommand(args[0], args[1], args[2], args[3])
    else {
      console.error('usage: render-review.mjs scrub|publish ...')
      process.exit(2)
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
