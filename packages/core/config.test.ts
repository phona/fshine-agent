import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { deploymentEnvOf, effectiveDeploymentEnv, loadConfig } from './src/index';

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
  attachmentDir: /srv/attachments
execution:
  planActivationSecret: yaml-plan-secret
runtime:
  mainConcurrency: 2
  backgroundConcurrency: 1
  queueCapacity: 4
  mainTurnMs: 300000
  workerTurnMs: 180000
  maxDelegationDepth: 1
  waitUserTimeoutMs: 86400000
  taskBudget:
    ms: 60000
    calls: 5
    tokens: 2000
`;

  it('yaml 段解析：llm / wecom / host / execution / runtime', () => {
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
    expect(config.host).toEqual({ attachmentDir: '/srv/attachments' });
    expect(config.execution).toEqual({ planActivationSecret: 'yaml-plan-secret' });
    expect(config.runtime).toEqual({
      mainConcurrency: 2,
      backgroundConcurrency: 1,
      queueCapacity: 4,
      mainTurnMs: 300000,
      workerTurnMs: 180000,
      maxDelegationDepth: 1,
      waitUserTimeoutMs: 86400000,
      taskBudget: { ms: 60000, calls: 5, tokens: 2000 },
    });
  });

  it('非空 env 覆盖 yaml；空串 env 不覆盖（--env-file 的 KEY= 形态）', () => {
    const overridden = loadConfig({
      yamlPath: writeFixture(DEPLOYMENT_YAML),
      env: {
        LLM_MODEL: 'env-model',
        WECOM_BOT_ID: 'env-bot-id',
        FSHINE_ATTACHMENT_DIR: '/srv/env-attachments',
        EXECUTION_PLAN_ACTIVATION_SECRET: 'env-plan-secret',
        APP_PORT: '8080',
      },
    });
    expect(overridden.llm?.model).toBe('env-model');
    expect(overridden.llm?.apiKey).toBe('yaml-key');
    expect(overridden.wecom?.botId).toBe('env-bot-id');
    expect(overridden.host?.attachmentDir).toBe('/srv/env-attachments');
    expect(overridden.execution?.planActivationSecret).toBe('env-plan-secret');
    expect(overridden.channel.port).toBe(8080);

    const blank = loadConfig({
      yamlPath: writeFixture(DEPLOYMENT_YAML.replace('principals:', 'channel:\n  port: 3100\nprincipals:')),
      env: {
        LLM_MODEL: '',
        WECOM_BOT_ID: '',
        FSHINE_ATTACHMENT_DIR: '   ',
        EXECUTION_PLAN_ACTIVATION_SECRET: '',
        APP_PORT: '',
      },
    });
    expect(blank.llm?.model).toBe('yaml-model');
    expect(blank.wecom?.botId).toBe('yaml-bot-id');
    expect(blank.host?.attachmentDir).toBe('/srv/attachments');
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
        'runtime:',
      ].join('\n')),
      env: {},
    });
    expect(config.llm).toBeUndefined();
    expect(config.wecom).toBeUndefined();
    expect(config.host).toBeUndefined();
    expect(config.execution).toBeUndefined();
    expect(config.runtime).toBeUndefined();
    expect(deploymentEnvOf(config)).toEqual({});
  });

  it('已删 host.* 死键（分诊 #6）：旧 YAML 残留被忽略，不再进 AppConfig、不再派生覆盖口', () => {
    const staleHostYaml = `principals:
  "wecom:user_a":
    enabled: true
host:
  platformQueueCapacity: 7
  shutdownDrainMs: 0
  workerDispatchMode: background
  workerStepCap: 12
  inboundDebounceMs: 0
  piAgentDir: /srv/pi-agent
`;
    const config = loadConfig({ yamlPath: writeFixture(staleHostYaml), env: {} });
    // 旧 YAML 照常加载（不拒启），但未消费键不再进 AppConfig——不再有「写着不生效」的假配置。
    expect(config.host).toBeUndefined();
    for (const env of [
      'FSHINE_PLATFORM_QUEUE_CAPACITY',
      'FSHINE_SHUTDOWN_DRAIN_MS',
      'FSHINE_WORKER_DISPATCH_MODE',
      'FSHINE_WORKER_STEP_CAP',
      'FSHINE_INBOUND_DEBOUNCE_MS',
      'FSHINE_PI_AGENT_DIR',
    ]) {
      expect(deploymentEnvOf(config)[env], `${env} 不应再派生`).toBeUndefined();
    }
  });

  it('runtime 段：缺段 / 空段 = 未配置（缺省住策略模块，加载层不复制）；非映射拒启', () => {
    expect(loadConfig({ yamlPath: writeFixture(VALID_YAML), env: {} }).runtime).toBeUndefined();
    expect(loadConfig({ yamlPath: writeFixture(`${VALID_YAML}runtime:\n# 只有注释 → null\n`), env: {} }).runtime).toBeUndefined();
    expect(() => loadConfig({ yamlPath: writeFixture(`${VALID_YAML}runtime: 3\n`), env: {} })).toThrowError(/runtime/);
  });

  it('runtime 段：非法值 fail-fast 点名 runtime.<key>（资源限额静默回落 = 限额失效，必须拒绝）', () => {
    const cases: ReadonlyArray<[string, RegExp]> = [
      ['mainConcurrency: 0', /runtime\.mainConcurrency/],
      ['mainConcurrency: -2', /runtime\.mainConcurrency/],
      ['mainConcurrency: 1.5', /runtime\.mainConcurrency/],
      ['backgroundConcurrency: -1', /runtime\.backgroundConcurrency/],
      ['queueCapacity: -1', /runtime\.queueCapacity/],
      ['mainTurnMs: 0', /runtime\.mainTurnMs/],
      ['workerTurnMs: 0', /runtime\.workerTurnMs/],
      ['maxDelegationDepth: -1', /runtime\.maxDelegationDepth/],
      ['waitUserTimeoutMs: 0', /runtime\.waitUserTimeoutMs/],
      ['mainTurnMs: nope', /runtime\.mainTurnMs/],
    ];
    for (const [line, expected] of cases) {
      const yaml = `${VALID_YAML}runtime:\n  ${line}\n`;
      expect(() => loadConfig({ yamlPath: writeFixture(yaml), env: {} }), line).toThrowError(expected);
    }
  });

  it('runtime 段：未知键拒绝（拼错的旋钮不得被缺省静默吞掉）', () => {
    const yaml = `${VALID_YAML}runtime:\n  mainConcurency: 2\n`;
    expect(() => loadConfig({ yamlPath: writeFixture(yaml), env: {} })).toThrowError(/runtime\.mainConcurency/);
  });

  it('runtime.taskBudget 子键：ms/calls 必填、非法值点名、未知子键拒绝', () => {
    const cases: ReadonlyArray<[string, RegExp]> = [
      ['taskBudget:\n    ms: 60000\n', /runtime\.taskBudget\.calls/],
      ['taskBudget:\n    calls: 5\n', /runtime\.taskBudget\.ms/],
      ['taskBudget:\n    ms: 0\n    calls: 5\n', /runtime\.taskBudget\.ms/],
      ['taskBudget:\n    ms: 60000\n    calls: 0\n', /runtime\.taskBudget\.calls/],
      ['taskBudget:\n    ms: 60000\n    calls: 5\n    tokens: -1\n', /runtime\.taskBudget\.tokens/],
      ['taskBudget:\n    ms: 60000\n    calls: 5\n    tps: 1\n', /runtime\.taskBudget\.tps/],
    ];
    for (const [block, expected] of cases) {
      const yaml = `${VALID_YAML}runtime:\n  ${block}`;
      expect(() => loadConfig({ yamlPath: writeFixture(yaml), env: {} }), block).toThrowError(expected);
    }
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
      FSHINE_ATTACHMENT_DIR: '/srv/attachments',
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
    expect(config.llm?.model).toBe('your-model');
    // 模板不填真值：空 secret 不进入 AppConfig，也不伪造 env。
    expect(config.wecom).toBeUndefined();
    expect(deploymentEnvOf(config)['WECOM_BOT_SECRET']).toBeUndefined();
  });
});
