import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Grok Build CLI 的 ~/.grok/auth.json：顶层对象以 `https://auth.x.ai::<client-id>`
// 为键，每项是 OIDC 会话：auth_mode "oidc"、key（access token）、refresh_token，
// expires_at 是 access token 的过期时间（可缺省；缺省时 CLI 按 30 天算）。
// access token 过期不判失败——CLI 会用 refresh token 自己换；这里只拦
// 「形状不对、缺 refresh token、权限太松」这三种跑起来必失败的情况。
export function inspectAuthFile(file) {
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { ok: false, reason: 'auth.json is not valid JSON' }
  }
  const entries = data && typeof data === 'object' && !Array.isArray(data) ? Object.values(data) : []
  const oidc = entries.length > 0 && entries.every((entry) => entry?.auth_mode === 'oidc')
  const hasKey = entries.length > 0 && entries.every((entry) => typeof entry?.key === 'string' && entry.key.length > 0)
  const hasRefresh = entries.length > 0 && entries.every((entry) => typeof entry?.refresh_token === 'string' && entry.refresh_token.length > 0)
  const expiresOk = entries.every((entry) => entry?.expires_at === undefined || !Number.isNaN(Date.parse(entry.expires_at)))
  if (!oidc || !hasKey || !hasRefresh || !expiresOk) {
    return {
      ok: false,
      reason: `auth.json rejected: entries=${entries.length} auth_mode_is_oidc=${oidc} has_access_token=${hasKey} has_refresh_token=${hasRefresh} expires_at_parses=${expiresOk}`,
    }
  }
  const fileMode = fs.statSync(file).mode & 0o777
  const directoryMode = fs.statSync(path.dirname(file)).mode & 0o777
  if (fileMode !== 0o600) {
    return { ok: false, reason: `auth.json mode is ${fileMode.toString(8)}, expected 600` }
  }
  if (directoryMode !== 0o700) {
    return { ok: false, reason: `GROK_HOME mode is ${directoryMode.toString(8)}, expected 700` }
  }
  return { ok: true, reason: `auth.json ok: entries=${entries.length} auth_mode=oidc has_access_token=true has_refresh_token=true` }
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
