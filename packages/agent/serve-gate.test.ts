import { describe, expect, it } from 'vitest';
import { createServeGate, extractGateScript, isServeCliInvocation, type ServeGateEvent, type ServeGateOptions } from './src/serve-gate';

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

describe('createServeGate（G1 工具门 + 执行方案）', () => {
  it('方案提交前的一切 bash 拒绝', () => {
    const { gate } = makeGate();
    const v = gate({ name: 'bash', arguments: { command: 'bin/17dz query query-saved.js 幻晟 202609' } });
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain('尚未提交执行方案');
  });

  it('方案提交被拦截并批准（不消耗预算），批准后 bash 放行', () => {
    const { gate } = makeGate();
    const planVerdict = gate({ name: 'bash', arguments: { command: PLAN } });
    expect(planVerdict?.block).toBe(true);
    expect(planVerdict?.reason).toContain('PLAN APPROVED');
    expect(planVerdict?.reason).toContain('预算 3/30');
    expect(planVerdict?.reason).toContain('预估平台调用 1 次');

    const ok = gate({ name: 'bash', arguments: { command: 'bin/17dz query src/voucher/scripts/query-saved.js 幻辰财税 202607' } });
    expect(ok?.block).toBeUndefined();
  });

  it('方案缺失必填项 → PLAN DECLINED 带原因与标准格式模板', () => {
    const { gate } = makeGate();
    const v = gate({ name: 'bash', arguments: { command: 'bin/17dz plan\ngoal: 只有一个目标' } });
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain('PLAN DECLINED');
    expect(v?.reason).toContain('authority.read 为空');
    expect(v?.reason).toContain('max_gate_calls');
    expect(v?.reason).toContain('标准格式');
    expect(v?.reason).toContain('bin/17dz plan {');
  });

  it('调用未申报脚本 → 拒绝；申报脚本正常计预算', () => {
    const { gate } = makeGate();
    gate({ name: 'bash', arguments: { command: PLAN } });
    const bad = gate({ name: 'bash', arguments: { command: 'bin/17dz query subject-list.js 幻辰财税' } });
    expect(bad?.block).toBe(true);
    expect(bad?.reason).toContain('不在方案 authority 内');
    const good = gate({ name: 'bash', arguments: { command: 'bin/17dz query query-saved.js 幻辰财税 202607' } });
    expect(good?.block).toBeUndefined();
  });

  it('预算耗尽 → 剪断并提示收尾', () => {
    const { gate } = makeGate();
    gate({ name: 'bash', arguments: { command: PLAN } }); // max_gate_calls: 3
    const cmd = 'bin/17dz query query-saved.js 幻辰财税 202607';
    expect(gate({ name: 'bash', arguments: { command: cmd } })?.block).toBeUndefined();
    expect(gate({ name: 'bash', arguments: { command: cmd } })?.block).toBeUndefined();
    const third = gate({ name: 'bash', arguments: { command: cmd } });
    expect(third?.block).toBeUndefined(); // 第 3 次 = 预算内
    const fourth = gate({ name: 'bash', arguments: { command: cmd } });
    expect(fourth?.block).toBe(true);
    expect(fourth?.reason).toContain('执行预算已用尽（4/3）');
  });

  it('重报方案超限 → 判定任务过大', () => {
    const { gate } = makeGate();
    gate({ name: 'bash', arguments: { command: PLAN } });
    for (let i = 0; i < 3; i += 1) {
      const v = gate({ name: 'bash', arguments: { command: PLAN } });
      if (i < 2) expect(v?.reason).toContain('PLAN APPROVED');
      else {
        expect(v?.reason).toContain('PLAN DECLINED');
        expect(v?.reason).toContain('任务超出单轮合理执行面');
      }
    }
  });

  it('期间数超限且无 justification → 拒绝', () => {
    const { gate } = makeGate();
    const sweep = [
      'bin/17dz plan',
      'goal: 扫全年',
      'authority:',
      '  read: [query-history.js]',
      'constraints:',
      '  max_gate_calls: 12',
      '  periods: [202601, 202602, 202603, 202604]',
    ].join('\n');
    const v = gate({ name: 'bash', arguments: { command: sweep } });
    expect(v?.reason).toContain('PLAN DECLINED');
    expect(v?.reason).toContain('跨期回溯');
  });

  it('非 bin/17dz bash 照旧拒绝（env 前缀/裸 node）', () => {
    const { gate } = makeGate();
    gate({ name: 'bash', arguments: { command: PLAN } });
    expect(gate({ name: 'bash', arguments: { command: 'node fill.js --save x.json' } })?.block).toBe(true);
    expect(gate({ name: 'bash', arguments: { command: 'DZ_SERVE=0 bin/17dz commit fill.js --save' } })?.block).toBe(true);
  });

  it('read 知识面白名单：MECHANISMS/schema 可读，实现源码与运行产物不可读', () => {
    const { gate } = makeGate();
    const ok = [
      '/home/fictional-user/fictional-projects/fictional-execution-layer/src/voucher/MECHANISMS.md',
      '/home/fictional-user/fictional-projects/fictional-execution-layer/src/voucher/contract.schema.json',
      '/home/fictional-user/fictional-projects/fictional-execution-layer/docs/proposal.schema.json',
      '/home/fictional-user/fictional-projects/fictional-execution-layer/.agents/skills-serve/17dz-query/SKILL.md',
    ];
    for (const p of ok) expect(gate({ name: 'read', arguments: { file_path: p } })?.block, p).toBeUndefined();
    const blocked = [
      '/home/fictional-user/fictional-projects/fictional-execution-layer/src/lib/platform.js',
      '/home/fictional-user/fictional-projects/fictional-execution-layer/src/finance/scripts/query-receivables.js',
      '/home/fictional-user/fictional-projects/fictional-execution-layer/package.json',
      '/home/fictional-user/fictional-projects/fictional-orchestrator/.env',
      '/home/fictional-user/fictional-projects/fictional-execution-layer/.runtime/token-cache.json',
    ];
    for (const p of blocked) expect(gate({ name: 'read', arguments: { file_path: p } })?.block, p).toBe(true);
  });

  it('ls 带 path 受知识面约束，不带 path 仅见根目录放行', () => {
    const { gate } = makeGate();
    expect(gate({ name: 'ls', arguments: { path: '/home/fictional-user/fictional-projects/fictional-execution-layer/src/finance/scripts' } })?.block).toBe(true);
    expect(gate({ name: 'ls', arguments: { path: '/home/fictional-user/fictional-projects/fictional-execution-layer/.agents/skills-serve' } })?.block).toBeUndefined();
    expect(gate({ name: 'ls', arguments: {} })?.block).toBeUndefined();
  });

  it('重方案触发 NEEDS_USER_CONFIRM：不建预算、bash 阻断；user_confirmed 后放行', () => {
    const { gate } = makeGate();
    const big = [
      'bin/17dz plan',
      JSON.stringify({
        goal: '幻辰财税全年逐月凭证',
        account_sets: ['幻辰财税'],
        periods: ['202601', '202602', '202603', '202604', '202605', '202606',
          '202607', '202608', '202609', '202610', '202611', '202612'],
        read: ['query-saved'],
        max_gate_calls: 20,
        justification: '用户要求全年逐月',
        completion: ['list_reported'],
      }),
    ].join('\n');
    const v = gate({ name: 'bash', arguments: { command: big } });
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain('PLAN NEEDS_USER_CONFIRM');
    expect(v?.reason).toContain('user_confirmed');

    // 待确认期间一切 bash 拒绝
    const q = gate({ name: 'bash', arguments: { command: 'bin/17dz query query-saved.js 幻辰财税 202601' } });
    expect(q?.block).toBe(true);
    expect(q?.reason).toContain('方案待用户确认');

    // 用户确认后重报（user_confirmed=true）→ 批准并放行
    const acked = gate({ name: 'bash', arguments: { command: big.replace('}', ',"user_confirmed":true}') } });
    expect(acked?.reason).toContain('PLAN APPROVED');
    expect(acked?.reason).toContain('按用户已确认的执行重量放行');
    const ok = gate({ name: 'bash', arguments: { command: 'bin/17dz query query-saved.js 幻辰财税 202601' } });
    expect(ok?.block).toBeUndefined();
  });

  it('bash 审计事件携带预算快照（供执行面回执）', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ onEvent: (e) => events.push(e) });
    gate({ name: 'bash', arguments: { command: PLAN } });
    gate({ name: 'bash', arguments: { command: 'bin/17dz query query-saved.js 幻辰财税 202607' } });
    const planEvent = events.find((e) => e.detail?.startsWith('bin/17dz plan'));
    expect(planEvent?.budget).toEqual({ used: 0, limit: 3 });
    const allowedBash = events.filter((e) => e.allowed && e.tool === 'bash');
    expect(allowedBash).toHaveLength(1);
    expect(allowedBash[0]?.budget).toEqual({ used: 1, limit: 3 });
  });

  it('拦截事件留痕', () => {
    const { gate, events } = makeGate();
    gate({ name: 'bash', arguments: { command: 'ls' } });
    expect(events[0]?.tool).toBe('bash');
    expect(events[0]?.allowed).toBe(false);
  });

  it('audit 回调异常不影响门裁决', () => {
    const gate = createServeGate({ onEvent: () => { throw new Error('audit down'); } });
    expect(gate({ name: 'bash', arguments: { command: 'node x' } })?.block).toBe(true);
  });
});
