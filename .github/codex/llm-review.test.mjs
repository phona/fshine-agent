/**
 * llm-review.mjs 的行为测试（2026-11-21：流水线审查从 Codex CLI 换成"可插拔 OpenAI 兼容端点"）。
 *
 * 用本地 stub 服务（零外网、零真实模型）守三件事：
 *   ① 模型正常返回 review JSON → 退出 0、stdout 文件就是 JSON；
 *   ② 模型先给一段前言（实测无工具模型会这样）→ 自动重试一次、第二次给 JSON → 仍退出 0，且**恰好两次请求**；
 *   ③ 模型两次都不给 JSON / 端点 4xx → 退出非 0、stderr 有原因、**不写 review 文件**。
 * 另守"密钥不进输出"：断言 stdout/stderr 不出现测试用 key。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const SCRIPT = path.join('.github', 'codex', 'llm-review.mjs')
const FAKE_KEY = 'test-key-not-a-real-secret'

/** 起一个 stub 端点：按 responses 顺序返回；响应体为完成对象。 */
async function startStub(responses) {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      seen.push({ url: req.url, body })
      const next = responses[Math.min(seen.length - 1, responses.length - 1)]
      if (next.status !== 200) {
        res.writeHead(next.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'stub failure' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: next.content } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { base: `http://127.0.0.1:${port}/v1`, seen, close: () => new Promise((r) => server.close(r)) }
}

/** 在临时目录里跑脚本，返回 { code, stdout, stderr }。 */
async function runScript(base) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-review-'))
  const promptFile = path.join(dir, 'prompt.md')
  const outFile = path.join(dir, 'out.txt')
  const errFile = path.join(dir, 'err.txt')
  fs.writeFileSync(promptFile, '审查这个 PR。')
  const child = spawn(process.execPath, [SCRIPT, promptFile, outFile, errFile], {
    env: { ...process.env, LLM_API_BASE_URL: base, LLM_API_KEY: FAKE_KEY, PR_REVIEW_MODEL: 'stub-model' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (c) => { stdout += c })
  child.stderr.on('data', (c) => { stderr += c })
  const code = await new Promise((resolve) => child.on('close', resolve))
  return {
    code,
    stdout,
    stderr,
    out: fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : undefined,
    err: fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : undefined,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

const REVIEW_JSON = JSON.stringify({
  summary: '没有 blocking。',
  verdict: 'comment',
  findings: [],
  notReviewed: ['未跑测试'],
})

test('模型直接给 JSON：退出 0，输出就是 JSON，一次请求', async () => {
  const stub = await startStub([{ status: 200, content: REVIEW_JSON }])
  try {
    const run = await runScript(stub.base)
    assert.equal(run.code, 0)
    assert.equal(JSON.parse(run.out).verdict, 'comment')
    assert.equal(stub.seen.length, 1)
    assert.doesNotMatch(run.stdout + run.stderr + String(run.out) + String(run.err), new RegExp(FAKE_KEY))
    run.cleanup()
  } finally {
    await stub.close()
  }
})

test('先给前言再给 JSON：自动重试恰好一次，退出 0', async () => {
  const stub = await startStub([
    { status: 200, content: '我先按仓库约束读文档，再核对 diff。' },
    { status: 200, content: REVIEW_JSON },
  ])
  try {
    const run = await runScript(stub.base)
    assert.equal(run.code, 0)
    assert.equal(JSON.parse(run.out).verdict, 'comment')
    assert.equal(stub.seen.length, 2)
    assert.match(stub.seen[1].body, /只输出/)
    run.cleanup()
  } finally {
    await stub.close()
  }
})

test('两次都不是 JSON：退出非 0，stderr 有原因，不产出 review', async () => {
  const stub = await startStub([{ status: 200, content: '我先读文档。' }])
  try {
    const run = await runScript(stub.base)
    assert.notEqual(run.code, 0)
    assert.equal(run.out, undefined)
    assert.match(String(run.err), /不是 review JSON|没有产出 review JSON/)
    assert.equal(stub.seen.length, 2)
    run.cleanup()
  } finally {
    await stub.close()
  }
})

test('提示词超预算：按字节截断并留标记（云通道上下文保护）', async () => {
  const stub = await startStub([{ status: 200, content: REVIEW_JSON }])
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-review-big-'))
    const promptFile = path.join(dir, 'prompt.md')
    const outFile = path.join(dir, 'out.txt')
    const errFile = path.join(dir, 'err.txt')
    fs.writeFileSync(promptFile, 'x'.repeat(200_000))
    const child = spawn(process.execPath, [SCRIPT, promptFile, outFile, errFile], {
      env: { ...process.env, LLM_API_BASE_URL: stub.base, LLM_API_KEY: FAKE_KEY, PR_REVIEW_MODEL: 'stub-model' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c) => { stderr += c })
    const code = await new Promise((resolve) => child.on('close', resolve))
    assert.equal(code, 0)
    const sent = stub.seen[0].body
    assert.ok(Buffer.byteLength(sent) < 160_000, 'request body must be truncated')
    assert.match(sent, /提示词超出预算/)
    assert.match(stderr, /prompt truncated/)
    fs.rmSync(dir, { recursive: true, force: true })
  } finally {
    await stub.close()
  }
})

test('端点 4xx：退出非 0，stderr 带状态码，不产出 review', async () => {
  const stub = await startStub([{ status: 401, content: '' }])
  try {
    const run = await runScript(stub.base)
    assert.notEqual(run.code, 0)
    assert.equal(run.out, undefined)
    assert.match(String(run.err), /HTTP 401/)
    run.cleanup()
  } finally {
    await stub.close()
  }
})
