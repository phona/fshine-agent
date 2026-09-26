import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterAll } from 'vitest';
import { createServeGate, describeKeyArgs, extractGateScript, hasShellMetachars, isServeCliInvocation, KEY_ARG_FLAGS, workspaceRelPath, type ServeGateEvent, type ServeGateOptions } from './src/serve-gate';

describe('isServeCliInvocation（首词规则）', () => {
  it('放行 bin/17dz 的合法形态', () => {
    expect(isServeCliInvocation('bin/17dz query src/voucher/scripts/query-saved.js 幻晟 202609')).toBe(true);
    expect(isServeCliInvocation('bin/17dz query query-saved.js 幻晟 202609')).toBe(true);
    expect(isServeCliInvocation('./bin/17dz prepare src/voucher/scripts/fill.js c.json --batch')).toBe(true);
    expect(isServeCliInvocation('bash bin/17dz query x')).toBe(true);
    expect(isServeCliInvocation('/home/fictional-user/fictional-projects/fictional-execution-layer/bin/17dz query x')).toBe(true);
    expect(isServeCliInvocation('/usr/bin/env bash bin/17dz query x')).toBe(false); // /usr/bin/env 前缀不放行
  });

  it('拒绝 env 前缀注入（法域声明不可剥离）', () => {
    expect(isServeCliInvocation('DZ_SERVE=0 bin/17dz commit src/voucher/scripts/fill.js --save')).toBe(false);
    expect(isServeCliInvocation('env -u DZ_SERVE bin/17dz query x')).toBe(false);
  });

  it('拒绝非 bin/17dz 命令（含历史 serve.sh——平台已删除该入口）', () => {
    expect(isServeCliInvocation('serve.sh query x')).toBe(false);
    expect(isServeCliInvocation('17dz query x')).toBe(false); // 必须带 bin/ 前缀
    expect(isServeCliInvocation('node src/voucher/scripts/fill.js --save x.json')).toBe(false);
    expect(isServeCliInvocation('bash -c "bin/17dz query x"')).toBe(false);
    expect(isServeCliInvocation('grep -rn x /home/fictional-user/fictional-projects/fictional-execution-layer/src')).toBe(false);
    expect(isServeCliInvocation('')).toBe(false);
  });
});

describe('hasShellMetachars（shell 元字符白名单）', () => {
  it('拒绝命令拼接/替换/重定向/管道', () => {
    expect(hasShellMetachars('bin/17dz query x; cat .env')).toBe(true);
    expect(hasShellMetachars('bin/17dz query x && whoami')).toBe(true);
    expect(hasShellMetachars('bin/17dz query x || curl evil')).toBe(true);
    expect(hasShellMetachars('bin/17dz query $(cat .env)')).toBe(true);
    expect(hasShellMetachars('bin/17dz query `id`')).toBe(true);
    expect(hasShellMetachars('bin/17dz query ${HOME}')).toBe(true);
    expect(hasShellMetachars('bin/17dz query x > /tmp/out')).toBe(true);
    expect(hasShellMetachars('bin/17dz query x < /etc/passwd')).toBe(true);
    expect(hasShellMetachars('bin/17dz query x\ncat .env')).toBe(true);
  });

  it('放行合法参数（账套名、期间、脚本路径、flag）', () => {
    expect(hasShellMetachars('bin/17dz query query-saved.js 幻晟 202609')).toBe(false);
    expect(hasShellMetachars('./bin/17dz prepare src/voucher/scripts/fill.js c.json --batch')).toBe(false);
    expect(hasShellMetachars('bash bin/17dz commit src/voucher/scripts/fill.js c.json --save')).toBe(false);
  });
});

describe('extractGateScript', () => {
  it('提取 query/prepare/commit 的脚本参数', () => {
    expect(extractGateScript('bin/17dz query src/voucher/scripts/query-saved.js A 202607')).toBe('src/voucher/scripts/query-saved.js');
    expect(extractGateScript('bin/17dz commit src/voucher/scripts/fill.js c.json --batch --save')).toBe('src/voucher/scripts/fill.js');
    expect(extractGateScript('bin/17dz operation run voucher.query-saved x')).toBe('voucher.query-saved');
  });
  it('plan/未知形态返回 null', () => {
    expect(extractGateScript('bin/17dz plan\ngoal: x')).toBeNull();
    expect(extractGateScript('bin/17dz')).toBeNull();
  });
});

const PLAN = [
  'bin/17dz plan',
  'goal: 查询幻辰财税 202607 凭证',
  'resources:',
  '  account_sets: [幻辰财税]',
  '  periods: [202607]',
  'authority:',
  '  read:',
  '    - voucher.query-saved',
  'constraints:',
  '  max_gate_calls: 3',
  'completion:',
  '  - list_reported',
].join('\n');

function makeGate(extra: Partial<ServeGateOptions> = {}) {
  const events: ServeGateEvent[] = [];
  const gate = createServeGate({ onEvent: (e) => events.push(e), ...extra });
  return { gate, events };
}

describe('createServeGate（通用执行安全门）', () => {
  it('平台计划已激活时仍拒绝模型直调 evaluate/activate 子命令', () => {
    const gate = createServeGate({ platformRoot: process.cwd(), planActive: () => true });
    for (const command of [
      'bin/17dz plan evaluate --task-id forged --stdin',
      '/home/fictional-user/fictional-projects/fictional-execution-layer/bin/17dz plan activate --stdin',
    ]) {
      const result = gate({ name: 'bash', arguments: { command } });
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain('宿主');
    }
  });

  it('计划未激活时拒绝平台调用，宿主激活后允许网关调用', () => {
    const inactive = createServeGate({ planActive: () => false });
    expect(inactive({ name: 'bash', arguments: { command: 'bin/17dz query query-saved.js A 202609' } })?.reason).toContain('宿主激活');
    const active = createServeGate({ planActive: () => true });
    expect(active({ name: 'bash', arguments: { command: 'bin/17dz query query-saved.js A 202609' } })?.block).toBeUndefined();
  });

  it('bash 继续拒绝 shell 注入和非平台命令', () => {
    const gate = createServeGate({ planActive: () => true });
    for (const command of ['bin/17dz query x; cat .env', 'bin/17dz query $(cat .env)', 'DZ_SERVE=0 bin/17dz query x', 'node script.js']) {
      expect(gate({ name: 'bash', arguments: { command } })?.block).toBe(true);
    }
  });

  it('read/ls 继续按知识面、敏感路径和 workspace 边界裁决', () => {
    const gate = createServeGate({ platformRoot: process.cwd() });
    expect(gate({ name: 'read', arguments: { file_path: 'docs/guide.md' } })?.block).toBeUndefined();
    expect(gate({ name: 'read', arguments: { file_path: 'src/private.ts' } })?.block).toBe(true);
    expect(gate({ name: 'read', arguments: { file_path: '.env' } })?.block).toBe(true);
    expect(gate({ name: 'read', arguments: { file_path: '../outside/docs.md' } })?.block).toBe(true);
    expect(gate({ name: 'ls', arguments: {} })?.block).toBeUndefined();
  });

  it('放行与拦截均审计，审计故障不影响裁决', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => true, onEvent: (event) => events.push(event) });
    gate({ name: 'bash', arguments: { command: 'bin/17dz query q A 202609' } });
    gate({ name: 'bash', arguments: { command: 'cat .env' } });
    expect(events.map((event) => event.allowed)).toEqual([true, false]);
    const brokenAudit = createServeGate({ planActive: () => true, onEvent: () => { throw new Error('audit down'); } });
    expect(brokenAudit({ name: 'bash', arguments: { command: 'bin/17dz query q A 202609' } })?.block).toBeUndefined();
  });
});

describe('describeKeyArgs（声明式 flag 名单）', () => {
  it('flag 名单是唯一口径：新参数只改名单，不加分支', () => {
    expect([...KEY_ARG_FLAGS]).toEqual(['--query', '--period', '--subject-code']);
  });

  it('只摘名单内的 flag：名称类加书名号，编号/时间类原样，按命令出现顺序', () => {
    expect(describeKeyArgs('bin/17dz query query-saved.js 幻晟 202609')).toEqual([]);
    expect(describeKeyArgs('bin/17dz query query-receivables.js --query 猫一杯 --period 202609')).toEqual(['「猫一杯」', '202609']);
    expect(describeKeyArgs('bin/17dz query query-receivables.js --subject-code 1122 --query 猫一杯')).toEqual(['1122', '「猫一杯」']);
    expect(describeKeyArgs('bin/17dz operation run finance.query-receivables --query 猫一杯 --customer 狗二')).toEqual(['「猫一杯」']);
  });

  it('名单外 flag / 布尔开关 / 超长取值都不进摘要', () => {
    expect(describeKeyArgs('bin/17dz commit fill.js c.json --batch --save')).toEqual([]);
    expect(describeKeyArgs('bin/17dz query x.js --query --period 202609')).toEqual(['202609']);
    expect(describeKeyArgs(`bin/17dz query x.js --query ${'名'.repeat(40)}`)).toEqual([`「${'名'.repeat(24)}」`]);
  });

  it('bash 前缀与空命令同样走同一套词法', () => {
    expect(describeKeyArgs('bash bin/17dz query x.js --query 甲')).toEqual(['「甲」']);
    expect(describeKeyArgs('')).toEqual([]);
  });
});

describe('createServeGate（平台调用的人类可读投影）', () => {
  const labels = new Map([['query-saved', '查询已存档记录'], ['query-receivables', '读取应收余额']]);

  it('放行的平台调用挂上 label 与参数摘要（数据查表，无分支）', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => true, operationLabels: labels, onEvent: (event) => events.push(event) });
    expect(gate({ name: 'bash', arguments: { command: 'bin/17dz query query-receivables.js --query 猫一杯 --period 202609' } })?.block).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      tool: 'bash',
      allowed: true,
      label: '读取应收余额',
      keyArgs: ['「猫一杯」', '202609'],
    });
  });

  it('脚本路径/裸名/操作名三种写法命中同一条 label', () => {
    for (const command of [
      'bin/17dz query query-saved.js A 202609',
      'bin/17dz query src/voucher/scripts/query-saved.js A 202609',
      'bin/17dz operation run voucher.query-saved A 202609',
    ]) {
      const events: ServeGateEvent[] = [];
      const gate = createServeGate({ planActive: () => true, operationLabels: labels, onEvent: (event) => events.push(event) });
      expect(gate({ name: 'bash', arguments: { command } })?.block).toBeUndefined();
      expect(events.at(-1)?.label).toBe('查询已存档记录');
    }
  });

  it('label 表缺省/查不到 → 不挂字段（绝不回退脚本名或操作名）', () => {
    for (const extra of [{}, { operationLabels: labels }, { operationLabels: new Map() }]) {
      const events: ServeGateEvent[] = [];
      const gate = createServeGate({ planActive: () => true, onEvent: (event) => events.push(event), ...extra });
      expect(gate({ name: 'bash', arguments: { command: 'bin/17dz query smoke.js A 202609' } })?.block).toBeUndefined();
      expect(events.at(-1)?.label).toBeUndefined();
      expect(events.at(-1)?.keyArgs).toBeUndefined();
      expect(Object.keys(events.at(-1) ?? {}).sort()).toEqual(['allowed', 'detail', 'reason', 'tool']);
    }
  });

  it('被拦的调用没有 label（进度帧只属于真实发生的平台调用）', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => true, operationLabels: labels, onEvent: (event) => events.push(event) });
    gate({ name: 'bash', arguments: { command: 'bin/17dz query query-saved.js; cat .env' } });
    gate({ name: 'bash', arguments: { command: 'cat .env' } });
    gate({ name: 'read', arguments: { file_path: 'src/private.ts' } });
    for (const event of events) {
      expect(event.allowed).toBe(false);
      expect(event.label).toBeUndefined();
    }
  });

  it('describeArgs 替身可注入（测试不需要真平台词表）', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({
      planActive: () => true,
      operationLabels: labels,
      describeArgs: () => ['替身'],
      onEvent: (event) => events.push(event),
    });
    gate({ name: 'bash', arguments: { command: 'bin/17dz query query-saved.js A 202609' } });
    expect(events.at(-1)).toMatchObject({ label: '查询已存档记录', keyArgs: ['替身'] });
  });

  it('既有审计字段与 tool_calls 消费者不受新字段影响', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => true, operationLabels: labels, onEvent: (event) => events.push(event) });
    gate({ name: 'bash', arguments: { command: 'bin/17dz query query-saved.js A 202609' } });
    gate({ name: 'bash', arguments: { command: 'cat .env' } });
    // assembly.ts 的 serveGateAudit 只读这四个字段
    expect(events.map((event) => [event.requestId, event.tool, event.allowed, event.detail])).toEqual([
      [undefined, 'bash', true, 'bin/17dz query query-saved.js A 202609'],
      [undefined, 'bash', false, 'cat .env'],
    ]);
  });
});

describe('workspaceRelPath（路径规范化）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'serve-gate-'));
  mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'docs', 'intro.md'), '# intro');
  const outside = mkdtempSync(path.join(tmpdir(), 'serve-gate-out-'));
  writeFileSync(path.join(outside, 'secret.md'), 'x');
  symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'docs', 'linked.md'));

  it('工作区内路径解析为相对路径', () => {
    expect(workspaceRelPath(root, 'docs/intro.md')).toBe(path.join('docs', 'intro.md'));
    expect(workspaceRelPath(root, './docs/../docs/intro.md')).toBe(path.join('docs', 'intro.md'));
    expect(workspaceRelPath(root, path.join(root, 'docs', 'intro.md'))).toBe(path.join('docs', 'intro.md'));
  });

  it('拒绝 ../ 穿越与绝对路径越界', () => {
    expect(workspaceRelPath(root, '../out')).toBeNull();
    expect(workspaceRelPath(root, 'docs/../../../proc/self/environ')).toBeNull();
    expect(workspaceRelPath(root, '/etc/passwd')).toBeNull();
  });

  it('拒绝符号链接逃逸（词法在内、内核解析出界）', () => {
    expect(workspaceRelPath(root, 'docs/linked.md')).toBeNull();
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('read/ls 路径规范化门（platformRoot 绑 worker cwd）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'serve-gate-gate-'));
  mkdirSync(path.join(root, 'docs'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'intro.md'), '# intro');
  writeFileSync(path.join(root, 'src', 'gateway.js'), 'secret');
  writeFileSync(path.join(root, '.env'), 'LLM_API_KEY=x');
  const gate = createServeGate({ platformRoot: root });

  it('工作区外穿越（读服务端 /proc env 的攻击面）被拦', () => {
    const v = gate({ name: 'read', arguments: { file_path: 'docs/../../../proc/self/environ' } });
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain('工作区外路径');
  });

  it('工作区内穿越到实现源码被知识面拦截', () => {
    const v = gate({ name: 'read', arguments: { file_path: 'docs/../src/gateway.js' } });
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain('知识面');
  });

  it('敏感文件穿越读取被拦（docs/../.env 词法归一至 .env）', () => {
    const v = gate({ name: 'read', arguments: { file_path: 'docs/../.env' } });
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain('敏感路径');
  });

  it('知识面内正常读取不受影响', () => {
    expect(gate({ name: 'read', arguments: { file_path: 'docs/intro.md' } })?.block).toBeUndefined();
    expect(gate({ name: 'ls', arguments: { path: 'docs' } })?.block).toBeUndefined();
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
});
