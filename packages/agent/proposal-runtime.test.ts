/**
 * 提案创建网关调用的识别层（方案 1 · B 波 B1/B3）——纯函数，不起 harness。
 *
 * 钉住的是**判据的形状**，不是某个执行层的 operation 名：
 *   · operation 名 + protocol 列命中 → 拦截；
 *   · 两种寻址形态都认（`prepare <operation>` 与 `operation run <operation>`，B3 扩）：平台对
 *     两条路都有 protocol-keyed 守卫，少认一条就多一个"平台有提案、宿主无条目"的缺口；
 *   · 按脚本路径寻址 → **不**拦截（A 波实证：平台会把它解析成别的 operation 并报数据错，
 *     宿主无法在不嗅探文件内容的前提下区分，所以一律落回 serve 门由平台拒绝）；
 *   · protocol 表为空 / 该 operation 不在表里 → 不拦截（派生是增强，不是前提）；
 *   · payload 路径原样带回，宿主不解析它；
 *   · 非网关命令 → 不拦截。
 */
import { describe, expect, it } from 'vitest';
import { parseOperationProtocols, type OperationProtocols } from './src/operation-labels';
import { PROPOSAL_CREATE_PROTOCOL, parseProposalCommand } from './src/proposal-runtime';

/** 平台 `operation list --json` 的一行：协议角色列由平台声明，宿主只查表。 */
const OPERATIONS_JSON = JSON.stringify({
  operations: [
    { name: 'voucher.proposal', command: 'proposal', access: 'scratch', protocol: 'proposal.create' },
    { name: 'voucher.commit', command: 'commit', access: 'write', protocol: 'proposal.commit' },
    { name: 'voucher.query-saved', command: 'query-saved', access: 'read' },
  ],
});

function protocolsOf(stdout: string): OperationProtocols {
  return parseOperationProtocols(stdout);
}

describe('parseOperationProtocols', () => {
  it('收 protocol 列：注册名与 command 裸名都进表', () => {
    const protocols = protocolsOf(OPERATIONS_JSON);
    expect(protocols.get('voucher.proposal')).toBe('proposal.create');
    expect(protocols.get('proposal')).toBe('proposal.create');
    expect(protocols.get('voucher.commit')).toBe('proposal.commit');
  });

  it('没有 protocol 列的 operation 不进表（旧版平台 = 空表 = 不拦截）', () => {
    const protocols = protocolsOf(OPERATIONS_JSON);
    expect(protocols.has('voucher.query-saved')).toBe(false);
    expect(protocols.has('query-saved')).toBe(false);
  });

  it('顶层裸数组同样收（与规格/语义两张表同一套形状宽容）', () => {
    const protocols = protocolsOf(JSON.stringify([
      { name: 'voucher.proposal', command: 'proposal', protocol: 'proposal.create' },
    ]));
    expect(protocols.get('voucher.proposal')).toBe('proposal.create');
  });

  it('非 JSON / 对象里没有 operations 数组 / protocol 非字符串 → 空表', () => {
    expect(protocolsOf('not json').size).toBe(0);
    expect(protocolsOf(JSON.stringify({ accessSemantics: {} })).size).toBe(0);
    expect(protocolsOf(JSON.stringify([{ name: 'x', protocol: 7 }])).size).toBe(0);
  });
});

describe('parseProposalCommand', () => {
  const protocols = protocolsOf(OPERATIONS_JSON);

  it('operation 名 + protocol 命中 proposal.create → 拦截，带回 operation 与 payload 路径', () => {
    expect(parseProposalCommand('bin/17dz prepare voucher.proposal tmp/req_1/proposal.json', protocols, 'bin/17dz'))
      .toEqual({ operation: 'voucher.proposal', payloadPath: 'tmp/req_1/proposal.json' });
  });

  it('command 裸名寻址同样命中（命令里两种写法都合法）', () => {
    expect(parseProposalCommand('bin/17dz prepare proposal tmp/req_1/proposal.json', protocols, 'bin/17dz'))
      .toEqual({ operation: 'proposal', payloadPath: 'tmp/req_1/proposal.json' });
  });

  it('bash/sh 前缀与网关路径前缀都认得（复用 serve 门首词规则）', () => {
    expect(parseProposalCommand('bash bin/17dz prepare voucher.proposal p.json', protocols, 'bin/17dz')?.payloadPath).toBe('p.json');
    expect(parseProposalCommand('sh ./bin/17dz prepare voucher.proposal p.json', protocols, 'bin/17dz')?.operation).toBe('voucher.proposal');
  });

  it('payload 位置参数前的 flag 串跳过（一次创建多个提案的开关）', () => {
    expect(parseProposalCommand('bin/17dz prepare voucher.proposal --batch tmp/req_1/list.json', protocols, 'bin/17dz'))
      .toEqual({ operation: 'voucher.proposal', payloadPath: 'tmp/req_1/list.json' });
    expect(parseProposalCommand('bin/17dz prepare voucher.proposal tmp/req_1/list.json --batch', protocols, 'bin/17dz')?.payloadPath)
      .toBe('tmp/req_1/list.json');
  });

  it('payload 路径原样带回：宿主不解析、不改写、不补全（不剥后缀、不规范化）', () => {
    const opaque = 'tmp/req_1/proposal.final.json';
    expect(parseProposalCommand(`bin/17dz prepare voucher.proposal ${opaque}`, protocols, 'bin/17dz')?.payloadPath).toBe(opaque);
  });

  it('按脚本路径寻址 → 不拦截（A 波实证：平台会解析成别的 operation 并报数据错）', () => {
    expect(parseProposalCommand('bin/17dz prepare src/voucher/scripts/fill.js tmp/req_1/proposal.json', protocols, 'bin/17dz')).toBeNull();
    expect(parseProposalCommand('bin/17dz prepare fill.js tmp/req_1/proposal.json', protocols, 'bin/17dz')).toBeNull();
    expect(parseProposalCommand('bin/17dz prepare ./voucher/fill.py tmp/req_1/proposal.json', protocols, 'bin/17dz')).toBeNull();
  });

  it('operation run <operation> 形态同样拦截（A 波对寻址加了 protocol-keyed 守卫，那条路也能建提案）', () => {
    expect(parseProposalCommand('bin/17dz operation run voucher.proposal tmp/req_1/proposal.json', protocols, 'bin/17dz'))
      .toEqual({ operation: 'voucher.proposal', payloadPath: 'tmp/req_1/proposal.json' });
    // 裸名寻址 + flag 串跳过与 prepare 形态同一套判据
    expect(parseProposalCommand('bash bin/17dz operation run proposal --batch tmp/req_1/list.json', protocols, 'bin/17dz'))
      .toEqual({ operation: 'proposal', payloadPath: 'tmp/req_1/list.json' });
  });

  it('operation run 寻址到别的角色 / 脚本路径 / 缺 mode → 不拦截', () => {
    expect(parseProposalCommand('bin/17dz operation run voucher.commit tmp/req_1/proposal.json', protocols, 'bin/17dz')).toBeNull();
    expect(parseProposalCommand('bin/17dz operation run src/voucher/scripts/fill.js tmp/req_1/proposal.json', protocols, 'bin/17dz')).toBeNull();
    expect(parseProposalCommand('bin/17dz operation tmp/req_1/proposal.json', protocols, 'bin/17dz')).toBeNull();
    expect(parseProposalCommand('bin/17dz operation run', protocols, 'bin/17dz')).toBeNull();
  });

  it('prepare 之外的模式 → 不拦截（commit 角色不是创建提案）', () => {
    expect(parseProposalCommand('bin/17dz commit voucher.proposal tmp/req_1/proposal.json', protocols, 'bin/17dz')).toBeNull();
    expect(parseProposalCommand('bin/17dz query voucher.proposal tmp/req_1/proposal.json', protocols, 'bin/17dz')).toBeNull();
  });

  it('protocol 表里该 operation 映到别的角色 → 不拦截', () => {
    expect(parseProposalCommand('bin/17dz prepare voucher.commit tmp/req_1/proposal.json', protocols, 'bin/17dz')).toBeNull();
  });

  it('protocol 表为空 / 未配 / 该 operation 不在表里 → 不拦截', () => {
    expect(parseProposalCommand('bin/17dz prepare voucher.proposal p.json', new Map())).toBeNull();
    expect(parseProposalCommand('bin/17dz prepare voucher.proposal p.json', undefined)).toBeNull();
    expect(parseProposalCommand('bin/17dz prepare voucher.query-saved p.json', protocols, 'bin/17dz')).toBeNull();
  });

  it('非网关命令 / 没有 payload 位置参数 → 不拦截', () => {
    expect(parseProposalCommand('echo bin/17dz prepare voucher.proposal p.json', protocols, 'bin/17dz')).toBeNull();
    expect(parseProposalCommand('env EXECUTION_EXECUTOR=mock bin/17dz prepare voucher.proposal p.json', protocols, 'bin/17dz')).toBeNull();
    expect(parseProposalCommand('bin/17dz prepare voucher.proposal', protocols, 'bin/17dz')).toBeNull();
    expect(parseProposalCommand('bin/17dz prepare voucher.proposal --batch', protocols, 'bin/17dz')).toBeNull();
  });

  it('角色名是跨层协议常量：与平台声明的取值一致', () => {
    expect(PROPOSAL_CREATE_PROTOCOL).toBe('proposal.create');
  });
});
