/**
 * 配置加载:config/agent.yaml(结构)+ 环境变量(秘密与本地参数)→ AppConfig。
 * 类型契约见 @fshine/contracts(config.ts);部署形状见 config/agent.yaml。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import path from 'node:path';
import type { AccountSetScope, AppConfig, ContextProfileConfig, PrincipalCapability, PrincipalConfig } from '@fshine/contracts';
import type { PrincipalScopeRecord } from '@fshine/contracts';

export interface LoadConfigOptions {
  yamlPath?: string;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_YAML_PATH = fileURLToPath(new URL('../../../config/agent.yaml', import.meta.url));
const DEFAULT_PORT = 3000;
const DEFAULT_CALLBACK_PATH = '/wecom/callback';
// 24h:用户"上午查账、下午接着问"是常态,分钟级 TTL 会造成静默失忆。
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

function parsePrincipals(raw: unknown): Record<string, PrincipalConfig> {
  const entries = asRecord(raw, 'principals');
  const principals: Record<string, PrincipalConfig> = {};
  for (const [key, value] of Object.entries(entries)) {
    const item = asRecord(value, `principals.${key}`);
    principals[key] = {
      // accountSetIds 不再进契约：实体授权归执行层，宿主不读 YAML 里的这个键
      // （config/agent.yaml 里的旧键原样保留，加载层直接忽略）。
      accountSetScope: parseAccountSetScope(item['accountSetScope'], `principals.${key}.accountSetScope`),
      enabled: item['enabled'] === true,
      capabilities: parseCapabilities(item['capabilities'], `principals.${key}.capabilities`),
    };
  }
  return principals;
}

function parseContextProfiles(raw: unknown): Record<string, ContextProfileConfig> {
  if (raw === undefined) return {};
  const entries = asRecord(raw, 'contextProfiles');
  const profiles: Record<string, ContextProfileConfig> = {};
  for (const [name, value] of Object.entries(entries)) {
    const item = asRecord(value, `contextProfiles.${name}`);
    const root = asString(item['root']).trim();
    if (!root) throw new Error(`配置项 contextProfiles.${name}.root 不能为空`);
    if (!path.isAbsolute(root)) throw new Error(`配置项 contextProfiles.${name}.root 必须是绝对路径`);
    const skillRootsRaw = item['skillRoots'];
    if (!Array.isArray(skillRootsRaw) || skillRootsRaw.length === 0) {
      throw new Error(`配置项 contextProfiles.${name}.skillRoots 必须是非空数组`);
    }
    const skillRoots = skillRootsRaw.map(String).map((entry) => entry.trim()).filter(Boolean);
    if (skillRoots.length !== skillRootsRaw.length) throw new Error(`配置项 contextProfiles.${name}.skillRoots 不能包含空值`);
    const workerTimeoutMs = item['workerTimeoutMs'] === undefined ? undefined : Number(item['workerTimeoutMs']);
    if (workerTimeoutMs !== undefined && (!Number.isFinite(workerTimeoutMs) || workerTimeoutMs <= 0)) {
      throw new Error(`配置项 contextProfiles.${name}.workerTimeoutMs 必须大于 0`);
    }
    const knowledgePaths = parseStringArray(item['knowledgePaths']);
    const sensitivePaths = parseStringArray(item['sensitivePaths']);
    const gatewayRaw = item['gateway'];
    const gateway = gatewayRaw === undefined ? undefined : String(gatewayRaw).trim();
    if (gateway !== undefined) {
      // Relative invocation only: no absolute path, no parent escape, no
      // shell metacharacters. A bad gateway here is a config error at
      // load time, not a spawn-time surprise.
      if (!gateway || path.isAbsolute(gateway) || gateway.split('/').includes('..') || /[\\'"`$;|&<>*?(){}[\]!#~]/.test(gateway)) {
        throw new Error(`配置项 contextProfiles.${name}.gateway 必须是相对 root 的网关调用形式`);
      }
    }
    profiles[name] = {
      root,
      skillRoots,
      ...(workerTimeoutMs === undefined ? {} : { workerTimeoutMs }),
      ...(knowledgePaths ? { knowledgePaths } : {}),
      ...(sensitivePaths ? { sensitivePaths } : {}),
      ...(gateway === undefined ? {} : { gateway }),
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
  // principals 是授权边界,占位符一律启动失败。
  assertNoPlaceholders(root['principals'], 'principals');

  const principals = parsePrincipals(root['principals']);
  const contextProfiles = parseContextProfiles(root['contextProfiles']);

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
    contextProfiles,
    channel: { port, publicUrl, callbackPath },
    sessionTtlMs,
  };
}

/**
 * principals(`<channel>:<userid>` 键)→ 旧版 `wecomUserId` 授权记录。
 *
 * 取第一个冒号之后的部分写入 legacy `wecom_user_id` 列；无冒号的旧键整体当 userid。
 * 这只让配置解析接受其他前缀，**不会**形成渠道隔离：`web:abc` 与 `wecom:abc` 仍落到
 * 同一存储键。第二渠道接入前须迁移授权主键并补 handler 会话/附件态隔离（D-112）。
 */
export function principalScopeRecords(config: AppConfig): PrincipalScopeRecord[] {
  return Object.entries(config.principals).map(([key, principal]) => {
    const colon = key.indexOf(':');
    return {
      wecomUserId: colon === -1 ? key : key.slice(colon + 1),
      // 实体授权归执行层：宿主不再持账套名单，列保留不读（写空串形式的历史兼容值）。
      accountSetIds: [],
      ...(principal.accountSetScope === 'all' ? { accountSetScope: 'all' as const } : {}),
      enabled: principal.enabled,
      capabilities: [...(principal.capabilities ?? ['read'])],
    };
  });
}

/**
 * 首个 enabled principal 的**裸 userid**（`<channel>:<userid>` 键剥掉渠道前缀；
 * 无冒号的旧键整体当 userid，与 principalScopeRecords 同一取舍）。
 *
 * 用途：验收/探针脚本派生"授权用户"。UserID 是身份暴露，不落代码——principal 的
 * 既定家在 config/agent.yaml（gitignore），脚本从这里取。无 enabled principal →
 * 返回 null，调用方必须 fail-closed 报错退出，**不回落任何写死的值**。
 *
 * 只取首个：这些脚本本就只用一个授权用户跑单会话，多 principal 的选取是部署决策，
 * 不是脚本该发明的第二套判据。
 */
export function firstEnabledPrincipalId(config: AppConfig): string | null {
  for (const [key, principal] of Object.entries(config.principals)) {
    if (principal.enabled !== true) continue;
    const colon = key.indexOf(':');
    return colon === -1 ? key : key.slice(colon + 1);
  }
  return null;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error('路径规则必须是字符串数组');
  }
  return value as string[];
}
