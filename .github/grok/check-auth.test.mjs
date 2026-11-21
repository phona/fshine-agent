import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { inspectAuthFile } from './check-auth.mjs'

const SECRET = 'super-secret-refresh-token-value'
const ENTRY_KEY = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828'

function entry(overrides = {}) {
  return {
    auth_mode: 'oidc',
    key: 'eyJnotprinted',
    refresh_token: SECRET,
    expires_at: '2026-11-19T20:14:39.383267700Z',
    ...overrides,
  }
}

function writeAuth(obj, { fileMode = 0o600, dirMode = 0o700 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-auth-'))
  fs.chmodSync(dir, dirMode)
  const file = path.join(dir, 'auth.json')
  fs.writeFileSync(file, JSON.stringify(obj))
  fs.chmodSync(file, fileMode)
  return file
}

test('accepts oidc auth with access and refresh tokens and private modes', () => {
  const file = writeAuth({ [ENTRY_KEY]: entry() })
  const result = inspectAuthFile(file)
  assert.equal(result.ok, true)
  assert.equal(result.reason.includes(SECRET), false)
  assert.equal(result.reason.includes('eyJ'), false)
})

test('rejects bad json, wrong mode, missing tokens, and loose permissions without echoing the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-auth-'))
  fs.chmodSync(dir, 0o700)
  const broken = path.join(dir, 'auth.json')
  fs.writeFileSync(broken, `{${SECRET}`)
  fs.chmodSync(broken, 0o600)
  assert.equal(inspectAuthFile(broken).reason, 'auth.json is not valid JSON')

  const apiKey = writeAuth({ [ENTRY_KEY]: entry({ auth_mode: 'apikey' }) })
  const rejected = inspectAuthFile(apiKey)
  assert.equal(rejected.ok, false)
  assert.match(rejected.reason, /auth_mode_is_oidc=false/)
  assert.equal(rejected.reason.includes(SECRET), false)

  const noRefresh = writeAuth({ [ENTRY_KEY]: entry({ refresh_token: '' }) })
  assert.match(inspectAuthFile(noRefresh).reason, /has_refresh_token=false/)

  const loose = writeAuth({ [ENTRY_KEY]: entry() }, { fileMode: 0o644 })
  assert.match(inspectAuthFile(loose).reason, /expected 600/)
})

test('cli failure output does not contain the token', () => {
  const file = writeAuth({ [ENTRY_KEY]: entry({ refresh_token: '' }) })
  const child = spawnSync(process.execPath, [path.resolve('.github/grok/check-auth.mjs'), file], { encoding: 'utf8' })
  assert.notEqual(child.status, 0)
  assert.equal(`${child.stdout}${child.stderr}`.includes(SECRET), false)
  assert.match(child.stderr, /has_refresh_token=false/)
})
