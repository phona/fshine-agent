/**
 * 流水线审查的模型调用步（2026-11-21：Codex 订阅停用后改走本地 OpenAI 兼容端点，默认 grok）。
 *
 * 与旧 Codex CLI 的接缝完全一样：读 `.github/codex/build-prompt.mjs` 产出的 prompt 文件，
 * 把模型原始回答写到 stdout 文件、错误写 stderr 文件、以退出码表达成败；随后由
 * `.github/codex/render-review.mjs scrub` 做 JSON 校验与脱敏，再 publish 发 PR review。
 *
 * 环境变量（workflow 注入；**密钥不进日志**）：
 *   LLM_API_BASE_URL   OpenAI 兼容端点根（如 http://192.168.100.1:3425/v1）
 *   LLM_API_KEY        端点密钥（GitHub secret）
 *   PR_REVIEW_MODEL    审查模型（repo variable；缺省 grok/grok-4.7）
 *   PR_REVIEW_EFFORT   可选思考档（作为 reasoning_effort 透传；缺省不传）
 *   PR_REVIEW_MAX_TOKENS 可选输出上限（缺省 8000）
 *
 * 用法：node .github/codex/llm-review.mjs <prompt-file> <stdout-file> <stderr-file>
 */
import fs from 'node:fs'

const [, , promptFile, stdoutFile, stderrFile] = process.argv
if (!promptFile || !stdoutFile || !stderrFile) {
  process.stderr.write('usage: llm-review.mjs <prompt-file> <stdout-file> <stderr-file>\n')
  process.exit(2)
}

const base = (process.env.LLM_API_BASE_URL ?? '').trim().replace(/\/+$/, '')
const key = (process.env.LLM_API_KEY ?? '').trim()
const model = (process.env.PR_REVIEW_MODEL ?? '').trim() || 'grok/grok-4.7'
const effort = (process.env.PR_REVIEW_EFFORT ?? '').trim()
const maxTokensRaw = (process.env.PR_REVIEW_MAX_TOKENS ?? '').trim()
const maxTokens = /^\d+$/.test(maxTokensRaw) ? Number(maxTokensRaw) : 8000

const writeErr = (text) => fs.writeFileSync(stderrFile, `${text}\n`)
if (base === '' || key === '') {
  writeErr('missing LLM_API_BASE_URL / LLM_API_KEY（workflow 变量或 secret 未配置）')
  process.exit(1)
}

let prompt
try {
  prompt = fs.readFileSync(promptFile, 'utf8')
} catch (error) {
  writeErr(`读取 prompt 失败：${String(error instanceof Error ? error.message : error).slice(0, 500)}`)
  process.exit(1)
}

const body = {
  model,
  // 工具无关的硬约束（2026-11-21 实测：无工具模型会先"想去读文件/找 schema"然后不输出 JSON）：
  // 本通道**没有**文件系统与工具访问权，只能依据 prompt 里的上下文与 diff 审查；
  // 最终消息必须是 JSON 对象（与 review-schema.json 一致），不要围栏、不要前言。
  messages: [
    {
      role: 'system',
      content: [
        '你没有文件系统、shell 或任何工具的访问权限，也不要去尝试读取文件。',
        '你只能依据用户消息中给出的 PR 上下文与 diff 审查；仓库约束已写在用户消息里。',
        '你的最终回答必须是一个符合给定 schema 的 JSON 对象（summary/verdict/findings），',
        '不要 Markdown 围栏，不要任何前言、解释或追问。',
      ].join(' '),
    },
    { role: 'user', content: prompt },
  ],
  temperature: 0,
  max_tokens: maxTokens,
  ...(effort === '' ? {} : { reasoning_effort: effort }),
}

/** 调一次模型；返回 { ok, content, error }。 */
async function callOnce() {
  let response
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    })
  } catch (error) {
    return { ok: false, error: `请求模型失败：${String(error instanceof Error ? error.message : error).slice(0, 500)}` }
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { ok: false, error: `模型端点返回 HTTP ${response.status}：${text.slice(0, 2000)}` }
  }
  let data
  try {
    data = await response.json()
  } catch (error) {
    return { ok: false, error: `模型响应不是 JSON：${String(error instanceof Error ? error.message : error).slice(0, 500)}` }
  }
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim() === '') return { ok: false, error: '模型返回空内容' }
  return { ok: true, content }
}

/** 是否形如 review JSON（宽松判定；严格校验交给 render-review scrub）。 */
function looksLikeReview(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '')
  if (!trimmed.startsWith('{')) return false
  try {
    const parsed = JSON.parse(trimmed.replace(/\s*```$/, ''))
    return parsed !== null && typeof parsed === 'object' && typeof parsed.summary === 'string'
  } catch {
    return false
  }
}

let result = await callOnce()
if (result.ok && !looksLikeReview(result.content)) {
  // 一次性重试：把"只输出 JSON"再钉一遍（实测无工具模型第一次会给前言）。
  body.messages.push({ role: 'assistant', content: result.content.slice(0, 2000) })
  body.messages.push({
    role: 'user',
    content: '上面那段不是 JSON。请**只输出**符合 schema 的 JSON 对象本身：不要围栏、不要前言、不要解释。',
  })
  result = await callOnce()
}

if (!result.ok) {
  writeErr(result.error)
  process.exit(1)
}
if (!looksLikeReview(result.content)) {
  writeErr('模型没有产出 review JSON（重试一次仍非 JSON）')
  process.exit(1)
}

fs.writeFileSync(stdoutFile, result.content)
