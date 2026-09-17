/**
 * 配置加载:config/agent.yaml(结构)+ 环境变量(秘密与本地参数)→ AppConfig。
 * 类型契约见 @fshine/contracts(config.ts);部署形状见 config/agent.yaml。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { AccountSetScope, AppConfig, McpProfileConfig, PrincipalCapability, PrincipalConfig } from '@fshine/contracts';
import type { PrincipalScopeRecord } from '@fshine/contracts';

export interface LoadConfigOptions {
  yamlPath?: string;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_YAML_PATH = fileURLToPath(new URL('../../../config/agent.yaml', import.meta.url));
const DEFAULT_PORT = 3000;
const DEFAULT_CALLBACK_PATH = '/wecom/callback';
// 24h:财务助手"上午查账、下午接着问"是常态,分钟级 TTL 会造成静默失忆。
// 过期本身不做清零(agent 层软着陆:压缩成摘要种子续会话),TTL 只决定"多久进入软着陆"。
const DEFAULT_SESSION_TTL_MS = 86_400_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`配置项 ${label} 缺失或格式不正确(应为映射)`);
  }
  return value;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

const CAPABILITIES: readonly PrincipalCapability[] = ['read', 'validate', 'write'];
const ACCOUNT_SET_SCOPES: readonly AccountSetScope[] = ['all', 'allowlist'];

function parseAccountSetScope(value: unknown, label: string): AccountSetScope {
  if (value === undefined) return 'allowlist';
  if (typeof value !== 'string' || !ACCOUNT_SET_SCOPES.includes(value as AccountSetScope)) {
    throw new Error(`配置项 ${label} 不是有效账套范围(可选: all, allowlist)`);
  }
  return value as AccountSetScope;
}

function parseCapabilities(value: unknown, label: string): PrincipalCapability[] {
  if (value === undefined) return ['read'];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`配置项 ${label} 必须是非空 capabilities 数组`);
  }
  const capabilities = value.map((item, index) => {
    if (typeof item !== 'string' || !CAPABILITIES.includes(item as PrincipalCapability)) {
      throw new Error(`配置项 ${label}[${index}] 不是有效能力(可选: read, validate, write)`);
    }
    return item as PrincipalCapability;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error(`配置项 ${label} 不能包含重复能力`);
  }
  return capabilities;
}

function assertNoPlaceholders(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (value.includes('REPLACE_WITH')) {
      throw new Error(`配置项 ${path} 仍包含占位符 REPLACE_WITH,请先填写真实值`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPlaceholders(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (key.includes('REPLACE_WITH')) {
        throw new Error(`配置项 ${childPath} 的键名仍包含占位符 REPLACE_WITH,请先填写真实值`);
      }
      assertNoPlaceholders(item, childPath);
    }
  }
}

/** mcpProfiles 的占位符只警告不阻断启动:17dz 未就绪时允许 D17Z_USE_FAKE=1 全链路演示。 */
function warnMcpProfilePlaceholders(profiles: Record<string, McpProfileConfig>): void {
  for (const [name, profile] of Object.entries(profiles)) {
    const offending = [profile.command, profile.cwd, ...(profile.args ?? [])].find((value) =>
      value.includes('REPLACE_WITH'),
    );
    if (offending !== undefined) {
      console.warn(JSON.stringify({
        event: 'config_placeholder_warning',
        profile: name,
        hint: 'mcpProfile 的 command/args/cwd 含占位符,真实调用会失败;演示可设 D17Z_USE_FAKE=1',
      }));
    }
  }
}

function parsePrincipals(raw: unknown): Record<string, PrincipalConfig> {
  const entries = asRecord(raw, 'principals');
  const principals: Record<string, PrincipalConfig> = {};
  for (const [key, value] of Object.entries(entries)) {
    const item = asRecord(value, `principals.${key}`);
    const accountSetIds = item['accountSetIds'];
    principals[key] = {
      mcpProfile: asString(item['mcpProfile']),
      accountSetIds: Array.isArray(accountSetIds) ? accountSetIds.map(String) : [],
      accountSetScope: parseAccountSetScope(item['accountSetScope'], `principals.${key}.accountSetScope`),
      enabled: item['enabled'] === true,
      capabilities: parseCapabilities(item['capabilities'], `principals.${key}.capabilities`),
    };
  }
  return principals;
}

function parseMcpProfiles(raw: unknown): Record<string, McpProfileConfig> {
  const entries = asRecord(raw, 'mcpProfiles');
  const profiles: Record<string, McpProfileConfig> = {};
  for (const [name, value] of Object.entries(entries)) {
    const item = asRecord(value, `mcpProfiles.${name}`);
    const args = Array.isArray(item['args']) ? item['args'].map(String) : undefined;
    const envRaw = item['env'];
    const profileEnv: Record<string, string> | undefined = isRecord(envRaw)
      ? Object.fromEntries(Object.entries(envRaw).map(([k, v]) => [k, asString(v)]))
      : undefined;
    const allowedResourceUris = Array.isArray(item['allowedResourceUris'])
      ? item['allowedResourceUris'].map(String)
      : undefined;
    profiles[name] = {
      command: asString(item['command']),
      ...(args ? { args } : {}),
      cwd: asString(item['cwd']),
      requestTimeoutMs: Number(item['requestTimeoutMs']),
      maxRetries: Number(item['maxRetries']),
      ...(profileEnv ? { env: profileEnv } : {}),
      ...(allowedResourceUris ? { allowedResourceUris } : {}),
    };
  }
  return profiles;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const yamlPath = options.yamlPath ?? DEFAULT_YAML_PATH;
  const env = options.env ?? process.env;

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(yamlPath, 'utf8'));
  } catch (err) {
    throw new Error(`无法读取配置文件 ${yamlPath}:${err instanceof Error ? err.message : String(err)}`);
  }
  const root = asRecord(raw, 'config');
  // principals 是授权边界,占位符一律启动失败;mcpProfiles 允许带占位符启动(仅警告)。
  assertNoPlaceholders(root['principals'], 'principals');

  const principals = parsePrincipals(root['principals']);
  const mcpProfiles = parseMcpProfiles(root['mcpProfiles']);
  warnMcpProfilePlaceholders(mcpProfiles);

  for (const [key, principal] of Object.entries(principals)) {
    if (!(principal.mcpProfile in mcpProfiles)) {
      throw new Error(`principal ${key} 引用的 mcpProfile "${principal.mcpProfile}" 未在 mcpProfiles 中定义`);
    }
    if (principal.enabled && principal.accountSetScope !== 'all' && principal.accountSetIds.length < 1) {
      throw new Error(`principal ${key} 已启用但未配置任何 accountSetIds,至少需要 1 个账套`);
    }
  }

  for (const [name, profile] of Object.entries(mcpProfiles)) {
    if (!(profile.requestTimeoutMs > 0)) {
      throw new Error(`mcpProfile ${name} 的 requestTimeoutMs 必须大于 0(当前:${asString(profile.requestTimeoutMs)})`);
    }
    if (!(profile.maxRetries >= 0)) {
      throw new Error(`mcpProfile ${name} 的 maxRetries 不能为负数(当前:${asString(profile.maxRetries)})`);
    }
  }

  const channelRaw: Record<string, unknown> = isRecord(root['channel']) ? root['channel'] : {};

  const portRaw = env['APP_PORT'] ?? channelRaw['port'];
  const port = Number(portRaw === undefined || portRaw === null || portRaw === '' ? DEFAULT_PORT : portRaw);
  if (!Number.isFinite(port)) {
    throw new Error(`环境变量 APP_PORT 不是有效的端口号:${asString(portRaw)}`);
  }

  // V0 渠道为智能机器人 WebSocket 长连接,无需公网 URL;publicUrl 仅作可选信息保留。
  const publicUrl = String(env['APP_PUBLIC_URL'] ?? '').trim() || asString(channelRaw['publicUrl']).trim();

  const callbackPath = String(env['APP_CALLBACK_PATH'] ?? '').trim()
    || asString(channelRaw['callbackPath']).trim()
    || DEFAULT_CALLBACK_PATH;

  const sessionTtlRaw = root['sessionTtlMs'];
  const sessionTtlMs = typeof sessionTtlRaw === 'number' && Number.isFinite(sessionTtlRaw) && sessionTtlRaw > 0
    ? sessionTtlRaw
    : DEFAULT_SESSION_TTL_MS;

  return {
    principals,
    mcpProfiles,
    channel: { port, publicUrl, callbackPath },
    sessionTtlMs,
  };
}

/** principals(wecom:<userid> 键)→ 渠道无关的授权记录。 */
export function principalScopeRecords(config: AppConfig): PrincipalScopeRecord[] {
  return Object.entries(config.principals).map(([key, principal]) => ({
    wecomUserId: key.startsWith('wecom:') ? key.slice('wecom:'.length) : key,
    accountSetIds: [...principal.accountSetIds],
    ...(principal.accountSetScope === 'all' ? { accountSetScope: 'all' as const } : {}),
    mcpProfile: principal.mcpProfile,
    enabled: principal.enabled,
    capabilities: [...(principal.capabilities ?? ['read'])],
  }));
}
