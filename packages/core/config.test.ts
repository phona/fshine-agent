import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, principalScopeRecords } from './src/index';

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
    expect(userA?.accountSetIds).toEqual(['as_001', 'as_002']);
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
  17dz:
    root: /opt/17dz-platform
    skillRoots: [".agents/skills"]
    workerTimeoutMs: 600000
`;
    const config = loadConfig({ yamlPath: writeFixture(yaml), env: PUBLIC_URL_ENV });
    expect(config.contextProfiles['17dz']).toMatchObject({
      root: '/opt/17dz-platform',
      skillRoots: ['.agents/skills'],
      workerTimeoutMs: 600000,
    });
  });

  it('context profile 拒绝非正 Worker 预算', () => {
    const yaml = `${VALID_YAML}
contextProfiles:
  17dz:
    root: /opt/17dz-platform
    skillRoots: [".agents/skills"]
    workerTimeoutMs: 0
`;
    expect(() => loadConfig({ yamlPath: writeFixture(yaml), env: PUBLIC_URL_ENV })).toThrowError(/workerTimeoutMs/);
  });

  it('principalScopeRecords:去掉 wecom: 前缀映射为授权记录', () => {
    const config = loadConfig({ yamlPath: writeFixture(VALID_YAML), env: PUBLIC_URL_ENV });
    const records = principalScopeRecords(config);

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      wecomUserId: 'user_a',
      accountSetIds: ['as_001', 'as_002'],
      enabled: true,
      capabilities: ['read'],
    });
    const disabled = records.find((record) => record.wecomUserId === 'user_b');
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.accountSetIds).toEqual([]);
    expect(disabled?.capabilities).toEqual(['read']);
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

  it('enabled 的 principal 无账套:报错并指出 principal key', () => {
    const yaml = VALID_YAML.replace(
      `accountSetIds: ["as_001", "as_002"]\n    enabled: true`,
      `accountSetIds: []\n    enabled: true`,
    );
    expect(() => loadConfig({ yamlPath: writeFixture(yaml), env: PUBLIC_URL_ENV }))
      .toThrowError(/wecom:user_a/);
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
});
