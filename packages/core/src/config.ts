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
  AppConfig,
  ChannelMode,
  ContextProfileConfig,
  ExecutionConfig,
  HostConfig,
  LlmConfig,
  Permission,
  PrincipalConfig,
  RoleConfig,
  RuntimeConfig,
  StoreConfig,
  WecomConfig,
} from '@fshine/contracts';
import { DEFAULT_PRINCIPAL_ROLE, DEFAULT_ROLES } from '@fshine/contracts';

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
  'maxOperationsPerTurn',
  'maxDelegationDepth',
  'taskBudget',
  'waitUserTimeoutMs',
  // 文件引用可读期（天）：缺省 7 住策略层；最小 1（0 非法——不可读判定不能靠关闭 TTL）。
  'fileRefTtlDays',
  'fileRetentionDays',
  'fileRetentionSweepOnStart',
  'allowWriteOperations',
  'attachmentNudgeAfterMs',
  // 预期契约（2026-11-18）：后台任务超过 10 分钟无动静的提醒阈值（10 分钟；30 分钟「卡住」
  // 档已随 2026-11-19 唤醒切片删除——旧 YAML 里的该键按未知字段拒绝）。
  'longRunningNoticeMs',
  // 前台排队最长等待（缺省 120s，住策略层）；超时即确定性拒绝。
  'queueWaitMs',
  // 大响应文件化（2026-11-19）：Worker 执行结果内联字节上限（缺省 64KiB 住策略层）。
  'oversizeDataBytes',
  // task_run 短等待窗口（ms，缺省 1500 住策略层）：0 = 不等，受理即转后台推进。
  'taskRunWaitMs',
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

/** runtime 段布尔值：只认 YAML 布尔；字符串/数字等显式写错同样 fail-fast。 */
function runtimeBoolean(raw: unknown, key: string): boolean | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'boolean') {
    throw new Error(`配置项 runtime.${key} 必须是布尔值（当前: ${String(raw)}）`);
  }
  return raw;
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
  type RuntimeIntegerKey = Exclude<keyof RuntimeConfig, 'taskBudget' | 'fileRetentionSweepOnStart' | 'allowWriteOperations'>;
  const integers: ReadonlyArray<[RuntimeIntegerKey, number]> = [
    ['mainConcurrency', 1],
    ['backgroundConcurrency', 0],
    ['queueCapacity', 0],
    ['mainTurnMs', 1],
    ['workerTurnMs', 1],
    // 单回合执行 operation 上限（资源边界）；缺省 5 住策略层。
    ['maxOperationsPerTurn', 1],
    ['maxDelegationDepth', 0],
    ['waitUserTimeoutMs', 1],
    // 文件引用可读期（天）：最小 1（缺省 7 由策略层提供）；0 = 配置错误，不当作「关闭 TTL」。
    ['fileRefTtlDays', 1],
    // 0 = 不清理（缺省值 30 由策略层提供）；负数 = 配置错误，不按「非法 = 未配置」回落。
    ['fileRetentionDays', 0],
    // 0 = 关闭主动追问（缺省 30000 由策略层提供）；负数/小数 = 配置错误。
    ['attachmentNudgeAfterMs', 0],
    // 0 = 关闭长时间提醒（缺省 600000 住策略层）；负数/小数 = 配置错误。
    ['longRunningNoticeMs', 0],
    // 0 = 不排队直接拒绝（缺省 120000 住策略层）。
    ['queueWaitMs', 0],
    // 大响应文件化：最小 1 字节（缺省 65536 住策略层）；0/负数 = 配置错误，
    // 不按「关掉阈值」消化——阈值消失等于放弃上下文预算边界。
    ['oversizeDataBytes', 1],
    // task_run 短等待窗口：0 = 不等（受理即回执、后台推进）；缺省 1500 住策略层。
    ['taskRunWaitMs', 0],
  ];
  for (const [key, min] of integers) {
    const value = runtimeInteger(raw[key], key, min);
    if (value !== undefined) config[key] = value;
  }
  const sweepOnStart = runtimeBoolean(raw['fileRetentionSweepOnStart'], 'fileRetentionSweepOnStart');
  if (sweepOnStart !== undefined) config.fileRetentionSweepOnStart = sweepOnStart;
  // 写面开关（缺省 false 住装配层）：显式写错 fail-fast，拼错的旋钮不被缺省吞掉。
  const allowWriteOperations = runtimeBoolean(raw['allowWriteOperations'], 'allowWriteOperations');
  if (allowWriteOperations !== undefined) config.allowWriteOperations = allowWriteOperations;
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

const CHANNEL_MODES: readonly ChannelMode[] = ['offline', 'shadow', 'live'];

/**
 * 渠道装配档位（yaml `channel.mode`）：**值域之外一律 fail-fast**，不按「非法 = 未配置」
 * 回落——档位决定是否连真实平台，静默回落会把部署意图吞掉（offline 掉成 live 是事故，
 * live 掉成 offline 是无声停服）。只认 yaml：无 FSHINE_* 环境变量覆盖口。
 *
 * 缺键 = 未配置（装配层取 DEFAULT_CHANNEL_MODE='offline'）；键存在但无值（YAML null）、
 * 空串、大小写偏差、尾随空格、非字符串都算配置错误。
 */
function parseChannelMode(raw: Record<string, unknown>): ChannelMode | undefined {
  if (!('mode' in raw)) return undefined;
  const value = raw['mode'];
  if (typeof value !== 'string' || !CHANNEL_MODES.includes(value as ChannelMode)) {
    throw new Error(`配置项 channel.mode 必须是 offline、shadow 或 live（当前: ${JSON.stringify(value)}）`);
  }
  return value as ChannelMode;
}

const PERMISSIONS: readonly Permission[] = ['read', 'write'];

/**
 * 角色表（yaml `roles` 段）。缺段 = 内置三档默认（viewer/operator/admin，见
 * `DEFAULT_ROLES`）；显式配置即整表替换——不做逐角色合并，避免「自定义了 viewer 却
 * 静默继承内置 operator」这类双源。
 *
 * 判据：角色名非空；每个角色只认 `permissions` 键；permissions 必须是非空数组、
 * 只允许 read/write、无重复。未知权限值 / 空数组 / 未知键一律 fail-fast（角色是授权
 * 边界，静默吞掉等于授权面不可预期）。
 */
function parseRoles(raw: unknown): Record<string, RoleConfig> {
  if (raw === undefined || raw === null) {
    return Object.fromEntries(
      Object.entries(DEFAULT_ROLES).map(([name, role]) => [name, { permissions: [...role.permissions] }]),
    );
  }
  const entries = asRecord(raw, 'roles');
  const roles: Record<string, RoleConfig> = {};
  for (const [name, value] of Object.entries(entries)) {
    const trimmed = name.trim();
    if (trimmed === '') throw new Error('配置项 roles 的角色名不能为空');
    const item = asRecord(value, `roles.${name}`);
    for (const key of Object.keys(item)) {
      if (key !== 'permissions') {
        throw new Error(`配置项 roles.${name}.${key} 不是已知字段（只接受 permissions）`);
      }
    }
    const rawPermissions = item['permissions'];
    if (!Array.isArray(rawPermissions) || rawPermissions.length === 0) {
      throw new Error(`配置项 roles.${name}.permissions 必须是非空数组（可选: read, write）`);
    }
    const permissions = rawPermissions.map((entry, index) => {
      if (typeof entry !== 'string' || !PERMISSIONS.includes(entry as Permission)) {
        throw new Error(`配置项 roles.${name}.permissions[${index}] 不是有效权限（可选: read, write）`);
      }
      return entry as Permission;
    });
    if (new Set(permissions).size !== permissions.length) {
      throw new Error(`配置项 roles.${name}.permissions 不能包含重复权限`);
    }
    roles[trimmed] = { permissions };
  }
  if (Object.keys(roles).length === 0) {
    throw new Error('配置项 roles 不能为空映射（未配置 roles 时使用内置三档默认）');
  }
  return roles;
}

function parsePrincipals(raw: unknown, roles: Record<string, RoleConfig>): Record<string, PrincipalConfig> {
  const entries = asRecord(raw, 'principals');
  const principals: Record<string, PrincipalConfig> = {};
  for (const [key, value] of Object.entries(entries)) {
    const item = asRecord(value, `principals.${key}`);
    // accountSetScope / capabilities 已从契约删除（实体授权归执行层、角色表取代能力位）：
    // YAML 里的旧键由加载层原样忽略，不解析、不校验、不进 PrincipalConfig。
    const roleRaw = item['role'];
    let role: string | undefined;
    if (roleRaw !== undefined && roleRaw !== null) {
      if (typeof roleRaw !== 'string' || roleRaw.trim() === '') {
        throw new Error(`配置项 principals.${key}.role 必须是非空字符串（可选: ${Object.keys(roles).join(', ')}）`);
      }
      role = roleRaw.trim();
      // 角色名未定义 → 启动失败（不静默降级为 viewer：配置写错必须可见）。
      if (!Object.prototype.hasOwnProperty.call(roles, role)) {
        throw new Error(`配置项 principals.${key}.role 未定义（可选: ${Object.keys(roles).join(', ')}）`);
      }
    }
    principals[key] = {
      enabled: item['enabled'] === true,
      ...(role === undefined ? {} : { role }),
    };
  }
  return principals;
}

/** 角色的有效权限（未写 role 的 principal 按 viewer；未知角色名加载期已拒绝）。 */
export function permissionsOfRole(config: AppConfig, role: string | undefined): Permission[] {
  const roles = config.roles ?? DEFAULT_ROLES;
  const name = role ?? DEFAULT_PRINCIPAL_ROLE;
  const definition = roles[name];
  if (definition === undefined) {
    // 运行期兜底：加载层已校验；这里仍 fail-closed 为只读，绝不放宽。
    return ['read'];
  }
  return [...definition.permissions];
}

/** principal 的有效角色名（未写 role = viewer）。 */
export function effectiveRoleOf(config: AppConfig, principalId: string): string {
  return config.principals[principalId]?.role ?? DEFAULT_PRINCIPAL_ROLE;
}

/** principal 的有效权限集合（角色 → permissions；未写 role = viewer = 只读）。 */
export function permissionsOfPrincipal(config: AppConfig, principalId: string): Permission[] {
  return permissionsOfRole(config, config.principals[principalId]?.role);
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

/**
 * 执行层单文件参数声明（`contextProfiles.*.fileParams`）：键不存在 = 不启用；出现即
 * 必须是映射，input/output 若出现必须是非空、无空白的字符串参数名。未知键拒绝——
 * 拼错的参数名若被静默忽略，附件会再次到不了执行层（正是本次缺陷的故障类）。
 */
function parseFileParams(value: unknown, label: string): { input?: string; output?: string } | undefined {
  if (value === undefined) return undefined;
  const item = asRecord(value, label);
  for (const key of Object.keys(item)) {
    if (key !== 'input' && key !== 'output') {
      throw new Error(`配置项 ${label}.${key} 不是支持的参数位（只接受 input / output）`);
    }
  }
  const parsed: { input?: string; output?: string } = {};
  for (const key of ['input', 'output'] as const) {
    const raw = item[key];
    if (raw === undefined) continue;
    const param = typeof raw === 'string' ? raw.trim() : '';
    if (!param || /[\s\u0000-\u001f\u007f]/.test(param)) {
      throw new Error(`配置项 ${label}.${key} 必须是非空参数名字符串`);
    }
    parsed[key] = param;
  }
  return parsed;
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
    // Main 技能面不是部署配置：固定从 <repo>/.agents/skills 发现（无配置键、无模式开关）。
    // 旧 YAML 里的实验键（Main 技能根/投递臂）由加载层原样忽略：不解析、不校验、不进 profile。
    const workerTimeoutMs = item['workerTimeoutMs'] === undefined ? undefined : Number(item['workerTimeoutMs']);
    if (workerTimeoutMs !== undefined && (!Number.isFinite(workerTimeoutMs) || workerTimeoutMs <= 0)) {
      throw new Error(`配置项 contextProfiles.${name}.workerTimeoutMs 必须大于 0`);
    }
    const knowledgePaths = parseStringArray(item['knowledgePaths']);
    const sensitivePaths = parseStringArray(item['sensitivePaths']);
    // 执行层声明的单文件参数名（CAP-01）：缺键 = 未声明 = 不启用单文件翻译。
    const fileParams = parseFileParams(item['fileParams'], `contextProfiles.${name}.fileParams`);
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
    // 中性缺省（task_run），实例已发布协议名由该实例 profile 声明保持连续。
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
      ...(fileParams === undefined ? {} : { fileParams }),
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

  // 角色表先于 principals 解析：principal.role 必须命中已定义角色（未定义 = 启动失败）。
  const roles = parseRoles(root['roles']);
  const principals = parsePrincipals(root['principals'], roles);
  const contextProfiles = parseContextProfiles(root['contextProfiles']);

  const channelRaw: Record<string, unknown> = isRecord(root['channel']) ? root['channel'] : {};
  // 渠道装配档位：值域 fail-fast、只认 yaml（无 env 覆盖口）；缺键 = 未配置，缺省住装配层。
  const channelMode = parseChannelMode(channelRaw);

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
    roles,
    contextProfiles,
    channel: {
      ...(channelMode === undefined ? {} : { mode: channelMode }),
      port,
      publicUrl,
      callbackPath,
    },
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
