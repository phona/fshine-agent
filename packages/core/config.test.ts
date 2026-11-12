import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { deploymentEnvOf, effectiveDeploymentEnv, loadConfig, principalScopeRecords, firstEnabledPrincipalId } from './src/index';

const PUBLIC_URL_ENV = { APP_PUBLIC_URL: 'https://tax.example.com' };

const VALID_YAML = `
principals:
  "wecom:user_a":
    accountSetIds: ["as_001", "as_002"]
    enabled: true
  "wecom:user_b":
    accountSetIds: []
    enabled: false
`;
// YAML 里的 accountSetIds 键在契约删除后（⑥）由加载层忽略：宿主不再持实体授权，
// config/agent.yaml 的旧键原样保留、不再进 PrincipalConfig。上面夹具刻意保留旧键，
// 正是为钉住"旧 YAML 照常加载"这一兼容行为。

describe('loadConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fshine-core-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFixture(content: string): string {
    const path = join(dir, 'agent.yaml');
    writeFileSync(path, content, 'utf8');
    return path;
  }

  it('happy path:yaml 结构 + env 合并 + 默认值', () => {
    const config = loadConfig({ yamlPath: writeFixture(VALID_YAML), env: PUBLIC_URL_ENV });

    expect(config.channel).toEqual({
      port: 3000,
      publicUrl: 'https://tax.example.com',
      callbackPath: '/wecom/callback',
    });
    expect(config.sessionTtlMs).toBe(86_400_000); // 默认 24h:TTL 过期走软着陆,不再分钟级清零失忆

    const userA = config.principals['wecom:user_a'];
    // accountSetIds 不再进契约（⑥）：YAML 里的旧键被加载层忽略
    expect('accountSetIds' in (userA ?? {})).toBe(false);
    expect(userA?.enabled).toBe(true);
    expect(userA?.capabilities).toEqual(['read']);
  });

  it('env 覆盖:APP_PORT / APP_CALLBACK_PATH', () => {
    const config = loadConfig({
      yamlPath: writeFixture(VALID_YAML),
      env: { APP_PUBLIC_URL: 'https://tax.example.com', APP_PORT: '8080', APP_CALLBACK_PATH: '/custom/callback' },
    });
    expect(config.channel.port).toBe(8080);
    expect(config.channel.callbackPath).toBe('/custom/callback');
  });

  it('sessionTtlMs 可由 yaml 提供,否则缺省 24h', () => {
    const withTtl = loadConfig({
      yamlPath: writeFixture(`${VALID_YAML}\nsessionTtlMs: 60000\n`),
      env: PUBLIC_URL_ENV,
    });
    expect(withTtl.sessionTtlMs).toBe(60000);
    expect(loadConfig({ yamlPath: writeFixture(VALID_YAML), env: PUBLIC_URL_ENV }).sessionTtlMs).toBe(86_400_000);
  });

  it('context profile 解析 Worker 预算', () => {
    const yaml = `${VALID_YAML}
contextProfiles:
  example-gateway:
    root: /opt/fictional-execution-layer
    skillRoots: [".agents/skills"]
    workerTimeoutMs: 600000
`;
    const config = loadConfig({ yamlPath: writeFixture(yaml), env: PUBLIC_URL_ENV });
    expect(config.contextProfiles['example-gateway']).toMatchObject({
      root: '/opt/fictional-execution-layer',
      skillRoots: ['.agents/skills'],
      workerTimeoutMs: 600000,
    });
  });

  it('context profile 声明 gateway 且拒绝父级逃逸 gateway', () => {
    const yaml = `${VALID_YAML}
contextProfiles:
  example-gateway:
    root: /opt/fictional-execution-layer
    gateway: bin/example-gateway
    skillRoots: [".agents/skills"]
`;
    const config = loadConfig({ yamlPath: writeFixture(yaml), env: PUBLIC_URL_ENV });
    expect(config.contextProfiles['example-gateway']).toMatchObject({ gateway: 'bin/example-gateway' });
    const bad = `${VALID_YAML}
contextProfiles:
  example-gateway:
    root: /opt/fictional-execution-layer
    gateway: ../escape
    skillRoots: [".agents/skills"]
`;
    expect(() => loadConfig({ yamlPath: writeFixture(bad), env: PUBLIC_URL_ENV })).toThrowError(/gateway/);
  });

  it('context profile 声明 executorLabel 且拒绝空值/超长/控制字符（C2）', () => {
    const yaml = `${VALID_YAML}
contextProfiles:
  example-gateway:
    root: /opt/fictional-execution-layer
    executorLabel: 执行层子 Agent
    skillRoots: [".agents/skills"]
`;
    const config = loadConfig({ yamlPath: writeFixture(yaml), env: PUBLIC_URL_ENV });
    expect(config.contextProfiles['example-gateway']).toMatchObject({ executorLabel: '执行层子 Agent' });

    // 空串（trim 后为空）
    const empty = `${VALID_YAML}
contextProfiles:
  example-gateway:
    root: /opt/fictional-execution-layer
    executorLabel: "   "
    skillRoots: [".agents/skills"]
`;
    expect(() => loadConfig({ yamlPath: writeFixture(empty), env: PUBLIC_URL_ENV })).toThrowError(/executorLabel/);
    // 超过 32 字符（它是模型可见文本，加载期挡住畸形值）
    const tooLong = `${VALID_YAML}
contextProfiles:
  example-gateway:
    root: /opt/fictional-execution-layer
    executorLabel: ${'x'.repeat(33)}
    skillRoots: [".agents/skills"]
`;
    expect(() => loadConfig({ yamlPath: writeFixture(tooLong), env: PUBLIC_URL_ENV })).toThrowError(/executorLabel/);
    // 控制字符（换行会污染提示词渲染）
    const control = `${VALID_YAML}
contextProfiles:
  example-gateway:
    root: /opt/fictional-execution-layer
    executorLabel: "label\\nline2"
    skillRoots: [".agents/skills"]
`;
    expect(() => loadConfig({ yamlPath: writeFixture(control), env: PUBLIC_URL_ENV })).toThrowError(/executorLabel/);
  });

  it('context profile 声明 toolName 且拒绝非法形状（C3）', () => {
    const yaml = `${VALID_YAML}
contextProfiles:
  example-gateway:
    root: /opt/fictional-execution-layer
    toolName: run_example_gateway_task
    skillRoots: [".agents/skills"]
`;
    const config = loadConfig({ yamlPath: writeFixture(yaml), env: PUBLIC_URL_ENV });
    expect(config.contextProfiles['example-gateway']).toMatchObject({ toolName: 'run_example_gateway_task' });

    // 大写/连字符/数字开头都不是合法工具名（模型可见协议面，形状必须像标识符）
    for (const bad of ['Run_Task', 'run-task', '1run_task', 'run task']) {
      const badYaml = `${VALID_YAML}
contextProfiles:
  example-gateway:
    root: /opt/fictional-execution-layer
    toolName: "${bad}"
    skillRoots: [".agents/skills"]
`;
      expect(() => loadConfig({ yamlPath: writeFixture(badYaml), env: PUBLIC_URL_ENV }), bad).toThrowError(/toolName/);
    }
    // 超过 48 字符
    const tooLong = `${VALID_YAML}
contextProfiles:
  example-gateway:
    root: /opt/fictional-execution-layer
    toolName: ${'a'.repeat(49)}
    skillRoots: [".agents/skills"]
`;
    expect(() => loadConfig({ yamlPath: writeFixture(tooLong), env: PUBLIC_URL_ENV })).toThrowError(/toolName/);
  });

  it('context profile 拒绝非正 Worker 预算', () => {
    const yaml = `${VALID_YAML}
contextProfiles:
  example-gateway:
    root: /opt/fictional-execution-layer
    skillRoots: [".agents/skills"]
    workerTimeoutMs: 0
`;
    expect(() => loadConfig({ yamlPath: writeFixture(yaml), env: PUBLIC_URL_ENV })).toThrowError(/workerTimeoutMs/);
  });

  it('principalScopeRecords:去掉 wecom: 前缀映射为授权记录（账套列保留不读，写空）', () => {
    const config = loadConfig({ yamlPath: writeFixture(VALID_YAML), env: PUBLIC_URL_ENV });
    const records = principalScopeRecords(config);

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      wecomUserId: 'user_a',
      accountSetIds: [],
      enabled: true,
      capabilities: ['read'],
    });
    const disabled = records.find((record) => record.wecomUserId === 'user_b');
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.capabilities).toEqual(['read']);
  });

  it('principalScopeRecords:键的前缀段是渠道身份，不写死 wecom（第二个客户端接入不改判据）', () => {
    // 2026-10-20 前这里写死 startsWith('wecom:')：web/小程序客户端接入时，它的授权键会被
    // 这个判据拒掉，而前缀本来就从消息上来（适配器报"哪个渠道 + 渠道里的谁"）。
    const yaml = VALID_YAML + `  "web:user_c":\n    accountSetIds: []\n    enabled: true\n`;
    const config = loadConfig({ yamlPath: writeFixture(yaml), env: PUBLIC_URL_ENV });
    const records = principalScopeRecords(config);

    expect(records.find((r) => r.wecomUserId === 'user_c')?.enabled).toBe(true);
    // 没有冒号的键整体当 userid（存量配置不破）
    const bare = loadConfig({
      yamlPath: writeFixture(`principals:\n  "user_d":\n    enabled: true\n`),
      env: PUBLIC_URL_ENV,
    });
    expect(principalScopeRecords(bare)[0]?.wecomUserId).toBe('user_d');
  });

  it('V1 capabilities:解析 read/validate/write 并默认旧 principal 为 read', () => {
    const yaml = VALID_YAML.replace('enabled: true', 'enabled: true\n    capabilities: [read, validate, write]');
    const config = loadConfig({ yamlPath: writeFixture(yaml), env: PUBLIC_URL_ENV });
    expect(config.principals['wecom:user_a']?.capabilities).toEqual(['read', 'validate', 'write']);
    expect(config.principals['wecom:user_b']?.capabilities).toEqual(['read']);
  });

  it('V1 capabilities:拒绝未知值、重复值和空数组', () => {
    for (const capabilities of ['[admin]', '[read, read]', '[]']) {
      const yaml = VALID_YAML.replace('enabled: true', `enabled: true\n    capabilities: ${capabilities}`);
      expect(() => loadConfig({ yamlPath: writeFixture(yaml), env: PUBLIC_URL_ENV }))
        .toThrowError(/capabilities/);
    }
  });

  it('enabled 的 principal 无账套不再报错（⑥：宿主不持实体授权，账套校验随之退役）', () => {
    const yaml = VALID_YAML.replace(
      `accountSetIds: ["as_001", "as_002"]\n    enabled: true`,
      `enabled: true`,
    );
    expect(() => loadConfig({ yamlPath: writeFixture(yaml), env: PUBLIC_URL_ENV })).not.toThrow();
  });

  it('APP_PUBLIC_URL 未设:得到空字符串且不抛(WebSocket 长连接无需公网 URL)', () => {
    const config = loadConfig({ yamlPath: writeFixture(VALID_YAML), env: {} });
    expect(config.channel.publicUrl).toBe('');
    expect(config.channel.port).toBe(3000);
    expect(config.channel.callbackPath).toBe('/wecom/callback');
  });

  it('principal 键含占位符:报错(自造夹具,不依赖仓库模板的当前状态)', () => {
    const yaml = VALID_YAML.replace('wecom:user_a', 'wecom:REPLACE_WITH_USERID');
    expect(() => loadConfig({ yamlPath: writeFixture(yaml), env: PUBLIC_URL_ENV }))
      .toThrowError(/REPLACE_WITH/);
  });

  // ── firstEnabledPrincipalId：验收/探针脚本的授权用户派生（UserID 不落代码） ──
  //
  // 6 个 scripts/ 验收与探针脚本曾把真实企微 UserID 写死在常量里。principal 的既定家在
  // config/agent.yaml（gitignore），脚本改为消费本助手；scripts/ 不在 typecheck 与 unit
  // 覆盖内，所以派生判据（含 fail-closed 的 null 分支）必须在这里先有表征。
  it('firstEnabledPrincipalId:取首个 enabled principal 的裸 userid（剥渠道前缀）', () => {
    const config = loadConfig({ yamlPath: writeFixture(VALID_YAML), env: PUBLIC_URL_ENV });
    expect(firstEnabledPrincipalId(config)).toBe('user_a');
  });

  it('firstEnabledPrincipalId:enabled=false 的 principal 被跳过', () => {
    const yaml = `principals:\n  "wecom:user_off":\n    enabled: false\n  "wecom:user_on":\n    enabled: true\n`;
    const config = loadConfig({ yamlPath: writeFixture(yaml), env: PUBLIC_URL_ENV });
    expect(firstEnabledPrincipalId(config)).toBe('user_on');
  });

  it('firstEnabledPrincipalId: principals 全 disabled / 空表 → null（调用方 fail-closed）', () => {
    const allOff = loadConfig({
      yamlPath: writeFixture(`principals:\n  "wecom:user_a":\n    enabled: false\n`),
      env: PUBLIC_URL_ENV,
    });
    expect(firstEnabledPrincipalId(allOff)).toBeNull();
    const empty = loadConfig({ yamlPath: writeFixture(`principals: {}\n`), env: PUBLIC_URL_ENV });
    expect(firstEnabledPrincipalId(empty)).toBeNull();
  });

  it('firstEnabledPrincipalId:无冒号的旧键整体当 userid（与 principalScopeRecords 同取舍）', () => {
    const config = loadConfig({
      yamlPath: writeFixture(`principals:\n  "user_d":\n    enabled: true\n`),
      env: PUBLIC_URL_ENV,
    });
    expect(firstEnabledPrincipalId(config)).toBe('user_d');
  });

  it('firstEnabledPrincipalId:第二个客户端前缀同样只剥第一段（不写死 wecom）', () => {
    const yaml = VALID_YAML + `  "web:user_c":\n    accountSetIds: []\n    enabled: true\n`;
    const config = loadConfig({ yamlPath: writeFixture(yaml), env: PUBLIC_URL_ENV });
    // VALID_YAML 里 user_a 已 enabled——首个即它；web: 前缀的判据由下一行单独钉。
    expect(firstEnabledPrincipalId(config)).toBe('user_a');
    const webOnly = loadConfig({
      yamlPath: writeFixture(`principals:\n  "web:user_c":\n    enabled: true\n`),
      env: PUBLIC_URL_ENV,
    });
    expect(firstEnabledPrincipalId(webOnly)).toBe('user_c');
  });

  // ── D-055：配置模板不许指向会"静默失效"的技能面 ──────────────────────────
  //
  // 模板 agent.example.yaml 是新部署者的复制源。它曾写着建造期技能面 .agents/skills——
  // 而 worker 驱动 noSkills:true 只加载显式 skillRoots（.agents/skills-serve），照模板
  // 配出来的部署"技能注入静默失效"：不报错、只是规则没进去。这里把模板值与运行态合法
  // 集合对上，防止"生产改了、模板没改"的新旧并存复发。
  it('D-055 模板 skillRoots 必须是运行态技能面(.agents/skills-serve),不许指建造面', () => {
    const templatePath = fileURLToPath(new URL('../../config/agent.example.yaml', import.meta.url));
    const template = parseYaml(readFileSync(templatePath, 'utf8')) as {
      contextProfiles?: Record<string, { skillRoots?: unknown }>;
    };
    const profiles = template.contextProfiles || {};
    const skillRoots = Object.values(profiles).find(p => p.skillRoots)?.skillRoots;
    expect(skillRoots, '模板必须显式声明至少一个 profile 的 skillRoots').toEqual(['.agents/skills-serve']);
  });
});

describe('部署配置（issue #20 切片 C+D）：yaml 是源，非空 env 覆盖', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fshine-deployment-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFixture(content: string): string {
    const path = join(dir, 'agent.yaml');
    writeFileSync(path, content, 'utf8');
    return path;
  }

  const DEPLOYMENT_YAML = `principals:
  "wecom:user_a":
    enabled: true
llm:
  apiBaseUrl: https://llm.example/v1
  apiKey: yaml-key
  model: yaml-model
  mainModel: yaml-main-model
  thinkingLevel: high
  mainThinkingLevel: low
wecom:
  botId: yaml-bot-id
  botSecret: yaml-bot-secret
host:
  platformQueueCapacity: 7
  shutdownDrainMs: 0
  workerDispatchMode: background
  workerStepCap: 12
  inboundDebounceMs: 0
  attachmentDir: /srv/attachments
  piAgentDir: /srv/pi-agent
execution:
  planActivationSecret: yaml-plan-secret
`;

  it('yaml 段解析：llm / wecom / host / execution', () => {
    const config = loadConfig({ yamlPath: writeFixture(DEPLOYMENT_YAML), env: {} });

    expect(config.llm).toEqual({
      apiBaseUrl: 'https://llm.example/v1',
      apiKey: 'yaml-key',
      model: 'yaml-model',
      mainModel: 'yaml-main-model',
      thinkingLevel: 'high',
      mainThinkingLevel: 'low',
    });
    expect(config.wecom).toEqual({ botId: 'yaml-bot-id', botSecret: 'yaml-bot-secret' });
    expect(config.host).toEqual({
      platformQueueCapacity: 7,
      shutdownDrainMs: 0,
      workerDispatchMode: 'background',
      workerStepCap: 12,
      inboundDebounceMs: 0,
      attachmentDir: '/srv/attachments',
      piAgentDir: '/srv/pi-agent',
    });
    expect(config.execution).toEqual({ planActivationSecret: 'yaml-plan-secret' });
  });

  it('非空 env 覆盖 yaml；空串 env 不覆盖（--env-file 的 KEY= 形态）', () => {
    const overridden = loadConfig({
      yamlPath: writeFixture(DEPLOYMENT_YAML),
      env: {
        LLM_MODEL: 'env-model',
        WECOM_BOT_ID: 'env-bot-id',
        FSHINE_PLATFORM_QUEUE_CAPACITY: '9',
        EXECUTION_PLAN_ACTIVATION_SECRET: 'env-plan-secret',
        APP_PORT: '8080',
      },
    });
    expect(overridden.llm?.model).toBe('env-model');
    expect(overridden.llm?.apiKey).toBe('yaml-key');
    expect(overridden.wecom?.botId).toBe('env-bot-id');
    expect(overridden.host?.platformQueueCapacity).toBe(9);
    expect(overridden.execution?.planActivationSecret).toBe('env-plan-secret');
    expect(overridden.channel.port).toBe(8080);

    const blank = loadConfig({
      yamlPath: writeFixture(DEPLOYMENT_YAML.replace('principals:', 'channel:\n  port: 3100\nprincipals:')),
      env: {
        LLM_MODEL: '',
        WECOM_BOT_ID: '',
        FSHINE_PLATFORM_QUEUE_CAPACITY: '   ',
        EXECUTION_PLAN_ACTIVATION_SECRET: '',
        APP_PORT: '',
      },
    });
    expect(blank.llm?.model).toBe('yaml-model');
    expect(blank.wecom?.botId).toBe('yaml-bot-id');
    expect(blank.host?.platformQueueCapacity).toBe(7);
    expect(blank.execution?.planActivationSecret).toBe('yaml-plan-secret');
    // 空串 APP_PORT 也回落到 yaml 的 channel.port（旧行为会退回默认 3000）。
    expect(blank.channel.port).toBe(3100);
  });

  it('store.dbPath:yaml 是源，非空 DB_PATH 覆盖、空串不覆盖，并派生到 deploymentEnvOf', () => {
    const yaml = `${VALID_YAML}store:\n  dbPath: /srv/agent.db\n`;
    const fromYaml = loadConfig({ yamlPath: writeFixture(yaml), env: {} });
    expect(fromYaml.store).toEqual({ dbPath: '/srv/agent.db' });
    expect(deploymentEnvOf(fromYaml)['DB_PATH']).toBe('/srv/agent.db');

    const overridden = loadConfig({ yamlPath: writeFixture(yaml), env: { DB_PATH: '/srv/env-agent.db' } });
    expect(overridden.store).toEqual({ dbPath: '/srv/env-agent.db' });
    expect(deploymentEnvOf(overridden)['DB_PATH']).toBe('/srv/env-agent.db');

    // node --env-file 的 `DB_PATH=` 形态：空串按未配置，yaml 值仍生效。
    const blank = loadConfig({ yamlPath: writeFixture(yaml), env: { DB_PATH: '' } });
    expect(blank.store).toEqual({ dbPath: '/srv/agent.db' });
    expect(deploymentEnvOf(blank)['DB_PATH']).toBe('/srv/agent.db');
  });

  it('store 缺段 / 空段 = 未配置（不拒启、不伪造默认值）', () => {
    const absent = loadConfig({ yamlPath: writeFixture(VALID_YAML), env: {} });
    expect(absent.store).toBeUndefined();
    expect(deploymentEnvOf(absent)['DB_PATH']).toBeUndefined();

    const emptySection = loadConfig({ yamlPath: writeFixture(`${VALID_YAML}store:\n# 只有注释 → null\n`), env: {} });
    expect(emptySection.store).toBeUndefined();
  });

  it('缺段 / 空段 / 缺键 = 未配置（不拒启），不给 AppConfig 造空段', () => {
    const config = loadConfig({
      yamlPath: writeFixture([
        'principals:',
        '  "wecom:user_a":',
        '    enabled: true',
        'llm:',
        '# 段里只有注释 → YAML 解析为 null，也按未配置处理',
        'wecom:',
        'host:',
        'execution:',
      ].join('\n')),
      env: {},
    });
    expect(config.llm).toBeUndefined();
    expect(config.wecom).toBeUndefined();
    expect(config.host).toBeUndefined();
    expect(config.execution).toBeUndefined();
    expect(deploymentEnvOf(config)).toEqual({});
  });

  it('非法数值 / 非法派发模式：数值按未配置回缺省，派发模式 fail-fast 点名键', () => {
    const invalidNumbers = `principals:
  "wecom:user_a":
    enabled: true
host:
  platformQueueCapacity: -1
  workerStepCap: nope
  inboundDebounceMs: -5
`;
    const config = loadConfig({ yamlPath: writeFixture(invalidNumbers), env: {} });
    // 非法值不落进 AppConfig（缺省住各消费点，加载层不复制第二份）。
    expect(config.host).toBeUndefined();

    expect(() => loadConfig({
      yamlPath: writeFixture(DEPLOYMENT_YAML.replace('workerDispatchMode: background', 'workerDispatchMode: yolo')),
      env: {},
    })).toThrowError(/FSHINE_WORKER_DISPATCH_MODE/);
    expect(() => loadConfig({
      yamlPath: writeFixture(DEPLOYMENT_YAML),
      env: { FSHINE_WORKER_DISPATCH_MODE: 'yolo' },
    })).toThrowError(/FSHINE_WORKER_DISPATCH_MODE/);
  });

  it('deploymentEnvOf：只映射已配置值，env 覆盖后的生效值进入映射', () => {
    const config = loadConfig({
      yamlPath: writeFixture(DEPLOYMENT_YAML),
      env: { LLM_MODEL: 'env-model' },
    });
    expect(deploymentEnvOf(config)).toEqual({
      LLM_API_BASE_URL: 'https://llm.example/v1',
      LLM_API_KEY: 'yaml-key',
      LLM_MODEL: 'env-model',
      LLM_MAIN_MODEL: 'yaml-main-model',
      LLM_THINKING_LEVEL: 'high',
      LLM_MAIN_THINKING_LEVEL: 'low',
      WECOM_BOT_ID: 'yaml-bot-id',
      WECOM_BOT_SECRET: 'yaml-bot-secret',
      FSHINE_PLATFORM_QUEUE_CAPACITY: '7',
      FSHINE_SHUTDOWN_DRAIN_MS: '0',
      FSHINE_WORKER_DISPATCH_MODE: 'background',
      FSHINE_WORKER_STEP_CAP: '12',
      FSHINE_INBOUND_DEBOUNCE_MS: '0',
      FSHINE_ATTACHMENT_DIR: '/srv/attachments',
      FSHINE_PI_AGENT_DIR: '/srv/pi-agent',
      EXECUTION_PLAN_ACTIVATION_SECRET: 'yaml-plan-secret',
    });
  });

  it('effectiveDeploymentEnv：yaml 派生值打底，非空 env 覆盖、空串不覆盖、未建模键透传', () => {
    const config = loadConfig({ yamlPath: writeFixture(DEPLOYMENT_YAML), env: {} });
    const effective = effectiveDeploymentEnv(config, {
      // node --env-file 的 `KEY=` 形态：空串按未配置，yaml 值补位。
      LLM_API_KEY: '',
      // 非空 env 覆盖 yaml。
      LLM_MODEL: 'env-model',
      // 未建模键原样透传（子进程继承面不变）。
      UNMODELED_FLAG: 'kept',
    });
    expect(effective['LLM_API_KEY']).toBe('yaml-key');
    expect(effective['LLM_MODEL']).toBe('env-model');
    expect(effective['WECOM_BOT_SECRET']).toBe('yaml-bot-secret');
    expect(effective['UNMODELED_FLAG']).toBe('kept');
  });

  it('fresh clone：config/agent.example.yaml 复制到临时路径后可直接加载', () => {
    const templatePath = fileURLToPath(new URL('../../config/agent.example.yaml', import.meta.url));
    const copied = join(dir, 'copied-agent.yaml');
    copyFileSync(templatePath, copied);

    const config = loadConfig({ yamlPath: copied, env: {} });
    expect(Object.keys(config.contextProfiles)).toEqual(['<profileId>']);
    expect(config.contextProfiles['<profileId>']?.root).toBe('/path/to/execution-layer');
    expect(config.contextProfiles['<profileId>']?.gateway).toBe('bin/your-gateway');
    expect(config.contextProfiles['<profileId>']?.skillRoots).toEqual(['.agents/skills-serve']);
    expect(config.llm?.model).toBe('kimi-for-coding');
    // 模板不填真值：空 secret 不进入 AppConfig，也不伪造 env。
    expect(config.wecom).toBeUndefined();
    expect(deploymentEnvOf(config)['WECOM_BOT_SECRET']).toBeUndefined();
  });
});
