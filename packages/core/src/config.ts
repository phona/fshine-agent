/**
 * 配置加载:config/agent.yaml(部署配置与秘密的源)+ 非空环境变量(覆盖口)→ AppConfig。
 * 类型契约见 @fshine/contracts(config.ts);部署形状见 config/agent.example.yaml。
 *
 * 覆盖判据（issue #20 切片 C+D）：`node --env-file` 会把模板里的 `KEY=` 设成空串,
 * 空串不是覆盖值——只有非空 env 才压过 yaml。缺段 / 缺键 = 未配置,loadConfig 不拒启
 * （服务启动的必填项校验在各消费点,不在加载层）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import path from 'node:path';
import type {
  AccountSetScope,
  AppConfig,
  ContextProfileConfig,
  ExecutionConfig,
  HostConfig,
  LlmConfig,
  PrincipalCapability,
  PrincipalConfig,
  RuntimeConfig,
  StoreConfig,
  WecomConfig,
} from '@fshine/contracts';

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

/**
 * 非空环境变量值（issue #20 切片 C+D 的覆盖口判据）。
 *
 * `node --env-file` 会把模板里所有 `KEY=` 都设成**空串**——空串代表"模板没填"，不是
 * 覆盖值。部署配置的源是 config/agent.yaml；只有非空 env 才覆盖它。
 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function yamlString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 字符串项：env 非空值 > yaml 值；两边都空 = 未配置。 */
function pickString(env: NodeJS.ProcessEnv, name: string, yamlValue: unknown): string | undefined {
  return envValue(env, name) ?? yamlString(yamlValue);
}

/** 可选映射段：缺段 / 空段（`llm:` 后全是注释 → null）= 空映射，不拒启；非映射 = 配置错误。 */
function optionalSection(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = root[key];
  if (raw === undefined || raw === null) return {};
  return asRecord(raw, key);
}

function parseLlm(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): LlmConfig | undefined {
  const config: LlmConfig = {};
  type StringLlmKey = Exclude<keyof LlmConfig, 'contextWindow'>;
  const fields: ReadonlyArray<[StringLlmKey, string]> = [
    ['apiBaseUrl', 'LLM_API_BASE_URL'],
    ['apiKey', 'LLM_API_KEY'],
    ['model', 'LLM_MODEL'],
    ['mainModel', 'LLM_MAIN_MODEL'],
    ['thinkingLevel', 'LLM_THINKING_LEVEL'],
    ['mainThinkingLevel', 'LLM_MAIN_THINKING_LEVEL'],
  ];
  for (const [key, envName] of fields) {
    const value = pickString(env, envName, raw[key]);
    if (value !== undefined) config[key] = value;
  }
  // 窗口是数值能力声明（token）：显式写错即 fail-fast，不按「非法 = 未配置」回落。
  // 理由：窗口决定压缩阈值，静默回落 128k 会让压缩在真实窗口之外才触发（T7 的原形）；
  // 这与数值项的一般口径（host.* 非法按未配置）刻意不同，报错点名 llm.contextWindow。
  // env 覆盖口（LLM_CONTEXT_WINDOW）由装配点 parseContextWindow 校验，报错点名环境变量。
  const rawContextWindow = raw['contextWindow'];
  if (rawContextWindow !== undefined && rawContextWindow !== null && String(rawContextWindow).trim() !== '') {
    const parsed = Number(rawContextWindow);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`配置项 llm.contextWindow 必须是正整数（当前: ${String(rawContextWindow)}）`);
    }
    config.contextWindow = parsed;
  }
  return Object.keys(config).length === 0 ? undefined : config;
}

function parseWecom(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): WecomConfig | undefined {
  const config: WecomConfig = {};
  const botId = pickString(env, 'WECOM_BOT_ID', raw['botId']);
  const botSecret = pickString(env, 'WECOM_BOT_SECRET', raw['botSecret']);
  if (botId !== undefined) config.botId = botId;
  if (botSecret !== undefined) config.botSecret = botSecret;
  return Object.keys(config).length === 0 ? undefined : config;
}

/**
 * 宿主运行参数（yaml `host` 段）。
 *
 * 2026-11-14 P5（分诊 #6）：未消费键（platformQueueCapacity / shutdownDrainMs /
 * workerDispatchMode / workerStepCap / inboundDebounceMs / piAgentDir）删除后，仅
 * attachmentDir 仍有真实读取点（渠道适配器经 FSHINE_ATTACHMENT_DIR 消费）。旧 YAML
 * 里的已删键由本函数忽略（不拒启、不再派生 env）。
 */
function parseHost(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): HostConfig | undefined {
  const config: HostConfig = {};
  const attachmentDir = pickString(env, 'FSHINE_ATTACHMENT_DIR', raw['attachmentDir']);
  if (attachmentDir !== undefined) config.attachmentDir = attachmentDir;
  return Object.keys(config).length === 0 ? undefined : config;
}

const RUNTIME_KEYS = [
  'mainConcurrency',
  'backgroundConcurrency',
  'queueCapacity',
  'mainTurnMs',
  'workerTurnMs',
  'maxDelegationDepth',
  'taskBudget',
  'waitUserTimeoutMs',
] as const;

/** runtime 段整数值：显式写错即 fail-fast（与 host.* 的「非法 = 未配置」刻意不同）。 */
function runtimeInteger(raw: unknown, key: string, min: number): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(`配置项 runtime.${key} 必须是 ≥${min} 的整数（当前: ${String(raw)}）`);
  }
  return parsed;
}

/**
 * 资源强制配置（yaml `runtime` 段；P5 单一配置入口，联合接口约定 §2）。
 *
 * 判据刻意严于其它部署段：非法值 fail-fast、未知键拒绝——资源限额静默回落等于限额
 * 失效（P5-T01 的失败判据「静默回落/双源」），拼错的旋钮不允许被默认值吞掉。
 * 缺省值不住这里：由 `packages/agent/src/resource-policy.ts` 按「缺省 = 现行为」补齐。
 */
function parseRuntime(raw: Record<string, unknown>): RuntimeConfig | undefined {
  for (const key of Object.keys(raw)) {
    if (!(RUNTIME_KEYS as readonly string[]).includes(key)) {
      throw new Error(`配置项 runtime.${key} 不是已知字段（可选: ${RUNTIME_KEYS.join(', ')}）`);
    }
  }
  const config: RuntimeConfig = {};
  type RuntimeIntegerKey = Exclude<keyof RuntimeConfig, 'taskBudget'>;
  const integers: ReadonlyArray<[RuntimeIntegerKey, number]> = [
    ['mainConcurrency', 1],
    ['backgroundConcurrency', 0],
    ['queueCapacity', 0],
    ['mainTurnMs', 1],
    ['workerTurnMs', 1],
    ['maxDelegationDepth', 0],
    ['waitUserTimeoutMs', 1],
  ];
  for (const [key, min] of integers) {
    const value = runtimeInteger(raw[key], key, min);
    if (value !== undefined) config[key] = value;
  }
  const taskBudgetRaw = raw['taskBudget'];
  if (taskBudgetRaw !== undefined && taskBudgetRaw !== null) {
    const budget = asRecord(taskBudgetRaw, 'runtime.taskBudget');
    for (const key of Object.keys(budget)) {
      if (key !== 'ms' && key !== 'calls' && key !== 'tokens') {
        throw new Error(`配置项 runtime.taskBudget.${key} 不是已知字段（可选: ms, calls, tokens）`);
      }
    }
    const ms = runtimeInteger(budget['ms'], 'taskBudget.ms', 1);
    if (ms === undefined) throw new Error('配置项 runtime.taskBudget.ms 必填（taskBudget 必须同时声明 ms 与 calls）');
    const calls = runtimeInteger(budget['calls'], 'taskBudget.calls', 1);
    if (calls === undefined) throw new Error('配置项 runtime.taskBudget.calls 必填（taskBudget 必须同时声明 ms 与 calls）');
    const tokens = runtimeInteger(budget['tokens'], 'taskBudget.tokens', 1);
    config.taskBudget = { ms, calls, ...(tokens === undefined ? {} : { tokens }) };
  }
  return Object.keys(config).length === 0 ? undefined : config;
}

function parseExecution(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): ExecutionConfig | undefined {
  const planActivationSecret = pickString(env, 'EXECUTION_PLAN_ACTIVATION_SECRET', raw['planActivationSecret']);
  return planActivationSecret === undefined ? undefined : { planActivationSecret };
}

/** 宿主存储（yaml `store` 段）：dbPath 走同一覆盖判据——非空 DB_PATH > yaml > 未配置。 */
function parseStore(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): StoreConfig | undefined {
  const dbPath = pickString(env, 'DB_PATH', raw['dbPath']);
  return dbPath === undefined ? undefined : { dbPath };
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
    // 执行层称谓（C2）：非空、≤32 字符、无控制字符——它进 Main Agent 系统提示词，
    // 是模型可见文本，加载时挡住畸形值好过运行时渲染出脏提示词。缺省 = 宿主中性
    // 缺省（DEFAULT_EXECUTOR_LABEL），不静默取实例名。
    const executorLabelRaw = item['executorLabel'];
    const executorLabel = executorLabelRaw === undefined ? undefined : String(executorLabelRaw).trim();
    if (executorLabel !== undefined) {
      if (!executorLabel || executorLabel.length > 32 || /[\u0000-\u001f\u007f]/.test(executorLabel)) {
        throw new Error(`配置项 contextProfiles.${name}.executorLabel 必须是非空且不超过 32 字符的可见文本`);
      }
    }
    // 委派工具名（C3）：工具名是模型可见协议面（进工具 schema 与调用分发），形状必须
    // 是合法标识符（小写字母开头，仅小写字母/数字/下划线）且 ≤48 字符。缺省 = 宿主
    // 中性缺省（run_task），实例已发布协议名由该实例 profile 声明保持连续。
    const toolNameRaw = item['toolName'];
    const toolName = toolNameRaw === undefined ? undefined : String(toolNameRaw).trim();
    if (toolName !== undefined) {
      if (!/^[a-z][a-z0-9_]*$/.test(toolName) || toolName.length > 48) {
        throw new Error(`配置项 contextProfiles.${name}.toolName 必须是 ≤48 字符的工具名（小写字母开头，仅小写字母/数字/下划线）`);
      }
    }
    profiles[name] = {
      root,
      skillRoots,
      ...(workerTimeoutMs === undefined ? {} : { workerTimeoutMs }),
      ...(knowledgePaths ? { knowledgePaths } : {}),
      ...(sensitivePaths ? { sensitivePaths } : {}),
      ...(gateway === undefined ? {} : { gateway }),
      ...(executorLabel === undefined ? {} : { executorLabel }),
      ...(toolName === undefined ? {} : { toolName }),
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

  // 空串 env 不算覆盖：`--env-file` 会把未填的 APP_PORT= 设成空串，此时仍应落到 yaml。
  const portRaw = envValue(env, 'APP_PORT') ?? channelRaw['port'];
  const port = Number(portRaw === undefined || portRaw === null || String(portRaw).trim() === '' ? DEFAULT_PORT : portRaw);
  if (!Number.isFinite(port)) {
    throw new Error(`环境变量 APP_PORT 不是有效的端口号:${asString(portRaw)}`);
  }

  // V0 渠道为智能机器人 WebSocket 长连接,无需公网 URL;publicUrl 仅作可选信息保留。
  const publicUrl = pickString(env, 'APP_PUBLIC_URL', channelRaw['publicUrl']) ?? '';

  const callbackPath = pickString(env, 'APP_CALLBACK_PATH', channelRaw['callbackPath']) ?? DEFAULT_CALLBACK_PATH;

  const sessionTtlRaw = root['sessionTtlMs'];
  const sessionTtlMs = typeof sessionTtlRaw === 'number' && Number.isFinite(sessionTtlRaw) && sessionTtlRaw > 0
    ? sessionTtlRaw
    : DEFAULT_SESSION_TTL_MS;

  // 部署配置（issue #20 切片 C+D）：yaml 是源，非空 env 覆盖。缺段 / 缺键 = 未配置，
  // loadConfig 不拒启——各消费点按既有缺省处理。注意服务启动仍会校验必填项：Main 驱动
  // 在装配时即校验 LLM_API_BASE_URL / LLM_API_KEY / LLM_MODEL（pi-driver.ts），渠道凭据
  // 在 channel.start 校验（channel-wecom/adapter.ts）；与切片前一致。store.dbPath 的
  // 缺省落点（data/agent.db）由装配点兜底，不在加载层复制。
  const llm = parseLlm(optionalSection(root, 'llm'), env);
  const wecom = parseWecom(optionalSection(root, 'wecom'), env);
  const host = parseHost(optionalSection(root, 'host'), env);
  const execution = parseExecution(optionalSection(root, 'execution'), env);
  const store = parseStore(optionalSection(root, 'store'), env);
  // P5 资源段：唯一入口、无 env 覆盖口；非法值 / 未知键在这里 fail-fast。
  const runtime = parseRuntime(optionalSection(root, 'runtime'));

  return {
    principals,
    contextProfiles,
    channel: { port, publicUrl, callbackPath },
    sessionTtlMs,
    ...(llm ? { llm } : {}),
    ...(wecom ? { wecom } : {}),
    ...(host ? { host } : {}),
    ...(runtime ? { runtime } : {}),
    ...(execution ? { execution } : {}),
    ...(store ? { store } : {}),
  };
}

/**
 * AppConfig 的部署值 → 同名环境变量（issue #20 切片 C+D 的唯一派生点）。
 *
 * 驱动 / 渠道 / handler 等既有消费面继续按 env 读取；装配在这里把 yaml 源翻译成 env
 * 名，再让非空环境变量覆盖（合并规则唯一实现是本文件的 effectiveDeploymentEnv）。
 * 未配置的值不出现——不伪造 env，也不在这里复制任何缺省值。
 *
 * `channel.*` 不在此列：它由 loadConfig 直接产出 AppConfig.channel，没有 env 消费方。
 */
export function deploymentEnvOf(config: AppConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const put = (name: string, value: string | number | undefined): void => {
    if (value === undefined) return;
    const text = String(value);
    if (text === '') return;
    env[name] = text;
  };
  put('LLM_API_BASE_URL', config.llm?.apiBaseUrl);
  put('LLM_API_KEY', config.llm?.apiKey);
  put('LLM_MODEL', config.llm?.model);
  put('LLM_MAIN_MODEL', config.llm?.mainModel);
  put('LLM_THINKING_LEVEL', config.llm?.thinkingLevel);
  put('LLM_MAIN_THINKING_LEVEL', config.llm?.mainThinkingLevel);
  put('LLM_CONTEXT_WINDOW', config.llm?.contextWindow);
  put('WECOM_BOT_ID', config.wecom?.botId);
  put('WECOM_BOT_SECRET', config.wecom?.botSecret);
  // host 段仅剩有真实读取点的 attachmentDir（渠道适配器读 FSHINE_ATTACHMENT_DIR）；
  // runtime 段无 env 消费方，不进本映射（消费方直接读 AppConfig.runtime）。
  put('FSHINE_ATTACHMENT_DIR', config.host?.attachmentDir);
  put('DB_PATH', config.store?.dbPath);
  put('EXECUTION_PLAN_ACTIVATION_SECRET', config.execution?.planActivationSecret);
  return env;
}

/**
 * 部署配置生效环境（唯一合并实现）：env 原样透传（未建模键也保留，子进程继承面
 * 不变），yaml 派生值只在同名 env 为空/空白时补位。`node --env-file` 会把模板里的
 * `KEY=` 设成空串，空串因此按未配置处理。
 *
 * 消费方：apps/server/assembly.ts（生产装配）与 scripts/smoke-wecom.ts（渠道冒烟）。
 * 新入口一律复用本函数——优先级规则不允许出现第二份实现。
 */
export function effectiveDeploymentEnv(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const effective: NodeJS.ProcessEnv = { ...env };
  for (const [name, value] of Object.entries(deploymentEnvOf(config))) {
    if ((effective[name] ?? '').trim() === '') effective[name] = value;
  }
  return effective;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error('路径规则必须是字符串数组');
  }
  return value as string[];
}
