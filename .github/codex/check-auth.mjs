import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function inspectAuthFile(file) {
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { ok: false, reason: 'auth.json is not valid JSON' }
  }
  const chatgpt = data?.auth_mode === 'chatgpt'
  const refresh = data?.tokens?.refresh_token
  const hasRefresh = typeof refresh === 'string' && refresh.length > 0
  const fileMode = fs.statSync(file).mode & 0o777
  const directoryMode = fs.statSync(path.dirname(file)).mode & 0o777
  if (!chatgpt || !hasRefresh) {
    return {
      ok: false,
      reason: `auth.json rejected: auth_mode_is_chatgpt=${chatgpt} has_refresh_token=${hasRefresh}`,
    }
  }
  if (fileMode !== 0o600) {
    return { ok: false, reason: `auth.json mode is ${fileMode.toString(8)}, expected 600` }
  }
  if (directoryMode !== 0o700) {
    return { ok: false, reason: `CODEX_HOME mode is ${directoryMode.toString(8)}, expected 700` }
  }
  return { ok: true, reason: 'auth.json ok: auth_mode=chatgpt has_refresh_token=true' }
}

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(path.resolve(entry)).href
}

if (isMain()) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: check-auth.mjs <auth.json>')
    process.exit(2)
  }
  const result = inspectAuthFile(file)
  if (!result.ok) {
    console.error(result.reason)
    process.exit(1)
  }
  console.log(result.reason)
}
