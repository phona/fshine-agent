import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { inspectAuthFile } from './check-auth.mjs'

const SECRET = 'super-secret-refresh-token-value'

function writeAuth(obj, { fileMode = 0o600, dirMode = 0o700 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-'))
  fs.chmodSync(dir, dirMode)
  const file = path.join(dir, 'auth.json')
  fs.writeFileSync(file, JSON.stringify(obj))
  fs.chmodSync(file, fileMode)
  return file
}

test('accepts chatgpt auth with a refresh token and private modes', () => {
  const file = writeAuth({ auth_mode: 'chatgpt', tokens: { refresh_token: SECRET, access_token: 'eyJnotprinted' } })
  const result = inspectAuthFile(file)
  assert.equal(result.ok, true)
  assert.equal(result.reason.includes(SECRET), false)
  assert.equal(result.reason.includes('eyJ'), false)
})

test('rejects bad json, wrong mode, missing refresh, and loose permissions without echoing the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-'))
  fs.chmodSync(dir, 0o700)
  const broken = path.join(dir, 'auth.json')
  fs.writeFileSync(broken, `{${SECRET}`)
  fs.chmodSync(broken, 0o600)
  assert.equal(inspectAuthFile(broken).reason, 'auth.json is not valid JSON')

  const apiKey = writeAuth({ auth_mode: 'apikey', tokens: { refresh_token: SECRET } })
  const rejected = inspectAuthFile(apiKey)
  assert.equal(rejected.ok, false)
  assert.match(rejected.reason, /auth_mode_is_chatgpt=false/)
  assert.equal(rejected.reason.includes(SECRET), false)

  const loose = writeAuth({ auth_mode: 'chatgpt', tokens: { refresh_token: SECRET } }, { fileMode: 0o644 })
  assert.match(inspectAuthFile(loose).reason, /expected 600/)
})

test('cli failure output does not contain the token', () => {
  const file = writeAuth({ auth_mode: 'chatgpt', tokens: {} })
  const child = spawnSync(process.execPath, [path.resolve('.github/codex/check-auth.mjs'), file], { encoding: 'utf8' })
  assert.notEqual(child.status, 0)
  assert.equal(`${child.stdout}${child.stderr}`.includes(SECRET), false)
  assert.match(child.stderr, /has_refresh_token=false/)
})
