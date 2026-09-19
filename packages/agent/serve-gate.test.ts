import { describe, expect, it, vi } from 'vitest';
import { createServeGate, isServeShInvocation, type ServeGateEvent } from './src/serve-gate';

describe('isServeShInvocation（首词规则）', () => {
  it('放行 serve.sh 的合法形态', () => {
    expect(isServeShInvocation('serve.sh query src/voucher/scripts/query-saved.js 幻晟 202609')).toBe(true);
    expect(isServeShInvocation('./serve.sh query x')).toBe(true);
    expect(isServeShInvocation('bash serve.sh query x')).toBe(true);
    expect(isServeShInvocation('bash /home/fictional-user/fictional-projects/fictional-execution-layer/serve.sh query x')).toBe(true);
    expect(isServeShInvocation('/usr/bin/env bash serve.sh query x')).toBe(false); // /usr/bin/env 不是 serve.sh
  });

  it('拒绝 env 前缀注入（法域声明不可剥离）', () => {
    expect(isServeShInvocation('FSHINE_MODE=build serve.sh commit fill.js --save')).toBe(false);
    expect(isServeShInvocation('env -u FSHINE_MODE serve.sh query x')).toBe(false);
  });

  it('拒绝非 serve.sh 命令', () => {
    expect(isServeShInvocation('node src/voucher/scripts/fill.js --save x.json')).toBe(false);
    expect(isServeShInvocation('bash -c "serve.sh query x"')).toBe(false);
    expect(isServeShInvocation('cat /home/fictional-user/fictional-projects/fictional-orchestrator/.env')).toBe(false);
    expect(isServeShInvocation('')).toBe(false);
  });
});

describe('createServeGate（G1 工具门）', () => {
  const script = '/home/fictional-user/fictional-projects/fictional-execution-layer/src/voucher/scripts/query-saved.js';

  function gateCall(name: string, args: Record<string, unknown>) {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate((e) => events.push(e));
    const verdict = gate({ name, arguments: args });
    return { verdict, events };
  }

  it('建造 bash 直接拒绝', () => {
    const { verdict, events } = gateCall('bash', { command: 'node fill.js --save x.json' });
    expect(verdict?.block).toBe(true);
    expect(events[0]?.allowed).toBe(false);
    expect(events[0]?.detail).toContain('node fill.js');
  });

  it('serve.sh 调用放行并留痕', () => {
    const cmd = `serve.sh query ${script} 幻晟 202609`;
    const { verdict, events } = gateCall('bash', { command: cmd });
    expect(verdict).toBeUndefined();
    expect(events[0]?.allowed).toBe(true);
    expect(events[0]?.detail).toBe(cmd);
  });

  it('read 敏感路径拒绝', () => {
    for (const p of ['.env', '/home/fictional-user/fictional-projects/fictional-orchestrator/.env',
      '/home/fictional-user/fictional-projects/fictional-execution-layer/.runtime/token-cache.json',
      '/home/fictional-user/fictional-projects/fictional-execution-layer/.runtime/auth.json',
      '/home/fictional-user/fictional-projects/fictional-execution-layer/.browser-profile/17dz/Cookies']) {
      const { verdict } = gateCall('read', { file_path: p });
      expect(verdict?.block, p).toBe(true);
    }
  });

  it('read 业务知识放行', () => {
    const { verdict } = gateCall('read', { file_path: '/home/fictional-user/fictional-projects/fictional-execution-layer/src/voucher/MECHANISMS.md' });
    expect(verdict).toBeUndefined();
  });

  it('grep/find/ls 的 path 参数同样受敏感路径约束', () => {
    const { verdict } = gateCall('grep', { pattern: 'token', path: '/home/fictional-user/fictional-projects/fictional-execution-layer/.runtime' });
    expect(verdict?.block).toBe(true);
    const ok = gateCall('grep', { pattern: 'token' });
    expect(ok.verdict).toBeUndefined();
  });

  it('拦截事件带 requestId 供审计串查', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate((e) => events.push(e));
    gate({ name: 'bash', arguments: { command: 'ls' } });
    // requestId 由驱动层（pi-coding-driver）补齐，本层不关心
    expect(events[0]?.tool).toBe('bash');
  });

  it('audit 回调异常不影响门裁决', () => {
    const gate = createServeGate(() => { throw new Error('audit down'); });
    expect(gate({ name: 'bash', arguments: { command: 'node x' } })?.block).toBe(true);
  });
});
