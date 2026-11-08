import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { createServeGate, describeKeyArgs, describePlanCalls, extractGateScript, gateInvocationKind, hasShellMetachars, isServeCliInvocation, serveMetadataCommand, structuredPlanGateVerdict, workspaceRelPath, AUDIT_DETAIL_MAX_CHARS, KEY_ARG_MAX_CHARS, type ServeGateEvent, type ServeGateOptions } from './src/serve-gate';
import { messageTextFor } from './src/error-codes';
import type { AccessSemantics, KeyArgStyles, OperationArgsSpecs, OperationSemantics } from './src/operation-labels';
import type { PlanCall } from './src/plan-runtime';

describe('isServeCliInvocation（首词规则）', () => {
  it('放行 bin/example-gateway 的合法形态', () => {
    expect(isServeCliInvocation('bin/example-gateway query src/voucher/scripts/query-saved.js 幻晟 202609', 'bin/example-gateway')).toBe(true);
    expect(isServeCliInvocation('bin/example-gateway query query-saved.js 幻晟 202609', 'bin/example-gateway')).toBe(true);
    expect(isServeCliInvocation('./bin/example-gateway prepare src/voucher/scripts/fill.js c.json --batch', 'bin/example-gateway')).toBe(true);
    expect(isServeCliInvocation('bash bin/example-gateway query x', 'bin/example-gateway')).toBe(true);
    expect(isServeCliInvocation('/home/fictional-user/fictional-projects/fictional-execution-layer/bin/example-gateway query x', 'bin/example-gateway')).toBe(true);
    expect(isServeCliInvocation('/usr/bin/env bash bin/example-gateway query x', 'bin/example-gateway')).toBe(false); // /usr/bin/env 前缀不放行
  });

  it('拒绝 env 前缀注入（法域声明不可剥离）', () => {
    expect(isServeCliInvocation('EXECUTION_SERVE=0 bin/example-gateway commit src/voucher/scripts/fill.js --save', 'bin/example-gateway')).toBe(false);
    expect(isServeCliInvocation('env -u EXECUTION_SERVE bin/example-gateway query x', 'bin/example-gateway')).toBe(false);
  });

  it('拒绝非 bin/example-gateway 命令（含历史 serve.sh——平台已删除该入口）', () => {
    expect(isServeCliInvocation('serve.sh query x', 'bin/example-gateway')).toBe(false);
    expect(isServeCliInvocation('example-gateway query x', 'bin/example-gateway')).toBe(false); // 必须带 bin/ 前缀
    expect(isServeCliInvocation('node src/voucher/scripts/fill.js --save x.json', 'bin/example-gateway')).toBe(false);
    expect(isServeCliInvocation('bash -c "bin/example-gateway query x"', 'bin/example-gateway')).toBe(false);
    expect(isServeCliInvocation('grep -rn x /home/fictional-user/fictional-projects/fictional-execution-layer/src', 'bin/example-gateway')).toBe(false);
    expect(isServeCliInvocation('', 'bin/example-gateway')).toBe(false);
  });
});

describe('hasShellMetachars（shell 元字符白名单）', () => {
  it('拒绝命令拼接/替换/重定向/管道', () => {
    expect(hasShellMetachars('bin/example-gateway query x; cat .env')).toBe(true);
    expect(hasShellMetachars('bin/example-gateway query x && whoami')).toBe(true);
    expect(hasShellMetachars('bin/example-gateway query x || curl evil')).toBe(true);
    expect(hasShellMetachars('bin/example-gateway query $(cat .env)')).toBe(true);
    expect(hasShellMetachars('bin/example-gateway query `id`')).toBe(true);
    expect(hasShellMetachars('bin/example-gateway query ${HOME}')).toBe(true);
    expect(hasShellMetachars('bin/example-gateway query x > /tmp/out')).toBe(true);
    expect(hasShellMetachars('bin/example-gateway query x < /etc/passwd')).toBe(true);
    expect(hasShellMetachars('bin/example-gateway query x\ncat .env')).toBe(true);
  });

  it('放行合法参数（账套名、期间、脚本路径、flag）', () => {
    expect(hasShellMetachars('bin/example-gateway query query-saved.js 幻晟 202609')).toBe(false);
    expect(hasShellMetachars('./bin/example-gateway prepare src/voucher/scripts/fill.js c.json --batch')).toBe(false);
    expect(hasShellMetachars('bash bin/example-gateway commit src/voucher/scripts/fill.js c.json --save')).toBe(false);
  });
});

describe('extractGateScript', () => {
  it('提取 query/prepare/commit 的脚本参数', () => {
    expect(extractGateScript('bin/example-gateway query src/voucher/scripts/query-saved.js A 202607')).toBe('src/voucher/scripts/query-saved.js');
    expect(extractGateScript('bin/example-gateway commit src/voucher/scripts/fill.js c.json --batch --save')).toBe('src/voucher/scripts/fill.js');
    expect(extractGateScript('bin/example-gateway operation run voucher.query-saved x')).toBe('voucher.query-saved');
  });
  it('plan/未知形态返回 null', () => {
    expect(extractGateScript('bin/example-gateway plan\ngoal: x')).toBeNull();
    expect(extractGateScript('bin/example-gateway')).toBeNull();
  });
});

const PLAN = [
  'bin/example-gateway plan',
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
  const gate = createServeGate({ onEvent: (e) => events.push(e), ...extra , gateway: 'bin/example-gateway' });
  return { gate, events };
}

// ── E1：计划前置豁免的元数据子命令白名单（A1）───────────────────────────────────
// 为什么要豁免：planActive 前置要求"先有计划才准调网关"，而平台的 `operation list` /
// `plan --schema` 是能力面与计划草案形状的机器可读出口——它们在平台 CLI 里 return 在
// plan 评估、限流、mode×access 矩阵之前，不触平台会话、不耗令牌。不豁免就是死锁：
// **写计划要先知道 operation 名，知道 operation 名要先有计划。**
// 不豁免的已实测后果：worker 的能力视野只剩 serve skill 手写表（5 行 vs registry 25 个
// operation），工资域 payroll.* 在册却 0 次被 serve 调用触达，worker 如实报"平台没有
// 这个能力"。
describe('serveMetadataCommand（元数据白名单）', () => {
  it('认得出能力面与计划形状两个元数据出口', () => {
    expect(serveMetadataCommand('bin/example-gateway operation list', 'bin/example-gateway')).toBe('operation list');
    expect(serveMetadataCommand('bin/example-gateway operation list --json', 'bin/example-gateway')).toBe('operation list');
    expect(serveMetadataCommand('bin/example-gateway operation list payroll', 'bin/example-gateway')).toBe('operation list');
    expect(serveMetadataCommand('bin/example-gateway plan --schema', 'bin/example-gateway')).toBe('plan --schema');
    expect(serveMetadataCommand('bin/example-gateway plan schema', 'bin/example-gateway')).toBe('plan --schema');
  });
  it('operation run / plan evaluate 等真执行与提方案不在白名单', () => {
    // 这两个一放，计划门等于拆了：run 是真执行（要计划要记账），evaluate 是提交方案
    expect(serveMetadataCommand('bin/example-gateway operation run payroll.transform x', 'bin/example-gateway')).toBeNull();
    expect(serveMetadataCommand('bin/example-gateway operation run voucher.query-saved A 202609', 'bin/example-gateway')).toBeNull();
    expect(serveMetadataCommand('bin/example-gateway plan evaluate --task-id t --stdin', 'bin/example-gateway')).toBeNull();
    expect(serveMetadataCommand('bin/example-gateway plan current --task-id t', 'bin/example-gateway')).toBeNull();
    expect(serveMetadataCommand('bin/example-gateway plan activate --stdin', 'bin/example-gateway')).toBeNull();
    expect(serveMetadataCommand('bin/example-gateway query src/voucher/scripts/query-saved.js A 202609', 'bin/example-gateway')).toBeNull();
    expect(serveMetadataCommand('bin/example-gateway prepare src/payroll/scripts/transform.py c.json out', 'bin/example-gateway')).toBeNull();
    expect(serveMetadataCommand('bin/example-gateway', 'bin/example-gateway')).toBeNull();
    expect(serveMetadataCommand('', 'bin/example-gateway')).toBeNull();
  });
  it('首 token 必须是网关：普通命令里拼上元数据字样不得绕过计划前置', () => {
    // 否则 `echo operation list` 之类就能骗过豁免
    expect(serveMetadataCommand('echo operation list', 'bin/example-gateway')).toBeNull();
    expect(serveMetadataCommand('cat operation list', 'bin/example-gateway')).toBeNull();
    expect(serveMetadataCommand('env FOO=1 bin/example-gateway operation list', 'bin/example-gateway')).toBeNull();
  });
});

describe('createServeGate（通用执行安全门）', () => {
  it('平台计划已激活时仍拒绝模型直调 evaluate/activate 子命令', () => {
    const gate = createServeGate({ platformRoot: process.cwd(), planActive: () => true , gateway: 'bin/example-gateway' });
    for (const command of [
      'bin/example-gateway plan evaluate --task-id forged --stdin',
      '/home/fictional-user/fictional-projects/fictional-execution-layer/bin/example-gateway plan activate --stdin',
    ]) {
      const result = gate({ name: 'bash', arguments: { command } });
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain('宿主');
    }
  });

  it('plan 拒绝消息教正确提交形式：单行原始命令，不要代码块/外层引号/多行', () => {
    const gate = createServeGate({ planActive: () => true , gateway: 'bin/example-gateway' });
    // 围栏版计划命令（真实平台实测的误导来源）与裸 evaluate 都拿到同一条教学消息
    for (const command of [
      '```json\nbin/example-gateway plan {"calls":[{"operation":"probe.query","args":[]}]}\n```',
      'bin/example-gateway plan evaluate --task-id forged --stdin',
    ]) {
      const reason = gate({ name: 'bash', arguments: { command } })?.reason ?? '';
      // 可行动的方向：唯一合法形式 + 三种常见错误包装
      expect(reason).toContain('单行');
      expect(reason).toContain('bin/example-gateway plan');
      expect(reason).toContain('不要');
      expect(reason).toContain('宿主');
      // 措辞纪律：不出现业务词（platform-leak-lint 同款预算），不出现平台脚本文件名
      for (const word of ['应收', '凭证', '科目', '账套', '期间', '目录']) expect(reason).not.toContain(word);
      expect(reason).not.toMatch(/[\w-]+\.js/);
    }
  });

  it('计划未激活时拒绝平台调用，宿主激活后允许网关调用', () => {
    const inactive = createServeGate({ planActive: () => false , gateway: 'bin/example-gateway' });
    expect(inactive({ name: 'bash', arguments: { command: 'bin/example-gateway query query-saved.js A 202609' } })?.reason).toContain('宿主激活');
    const active = createServeGate({ planActive: () => true , gateway: 'bin/example-gateway' });
    expect(active({ name: 'bash', arguments: { command: 'bin/example-gateway query query-saved.js A 202609' } })?.block).toBeUndefined();
  });

  it('E1：元数据查询在计划未激活时放行，且留审计痕', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => false, onEvent: (e) => events.push(e) , gateway: 'bin/example-gateway' });
    for (const cmd of ['bin/example-gateway operation list', 'bin/example-gateway operation list --json', 'bin/example-gateway plan --schema', 'bin/example-gateway plan schema']) {
      expect(gate({ name: 'bash', arguments: { command: cmd } })?.block, cmd).toBeUndefined();
    }
    // 留痕："宿主放行了什么"必须可复盘，否则能力面在审计里没有痕迹
    expect(events.map((e) => e.detail)).toEqual([
      'bin/example-gateway operation list', 'bin/example-gateway operation list --json', 'bin/example-gateway plan --schema', 'bin/example-gateway plan schema',
    ]);
    expect(events.every((e) => e.allowed)).toBe(true);
  });
  it('E1：已解析的 read/prepare 操作在计划未激活时仍要计划；未知子命令/裸命令放行（形态合法性归执行层）', () => {
    const gate = createServeGate({ planActive: () => false , gateway: 'bin/example-gateway' });
    // 已解析出 operation 且 plan 语义非 false → 计划前置照旧（编排层执法执行层声明）
    for (const cmd of [
      'bin/example-gateway query src/voucher/scripts/query-saved.js A 202609',
      'bin/example-gateway prepare src/payroll/scripts/transform.py c.json out',
    ]) {
      expect(gate({ name: 'bash', arguments: { command: cmd } })?.block, cmd).toBe(true);
    }
    // 未知子命令带脚本 → fail-closed 也要计划（既有防线：未知 op 可能写平台数据）
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway operation run payroll.transform x' } })?.block).toBe(true);
    // 裸 'bin/example-gateway operation'（无脚本 → 非网关调用形态）→ 放行，执行层原生处理
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway operation' } })?.block).toBeUndefined();
    // 裸 'bin/example-gateway plan' → 计划提交形状教学（宿主协议职责，保留）
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway plan' } })?.block).toBe(true);
  });
  it('E1：后缀污染的元数据命令放行（形态合法性归执行层，编排层不再拦）', () => {
    const gate = createServeGate({ planActive: () => false , gateway: 'bin/example-gateway' });
    // 分号后缀使命令不再是干净的元数据形态——编排层放行，bin/example-gateway 原生拒绝未知形态
    const v = gate({ name: 'bash', arguments: { command: 'bin/example-gateway operation list; rm -rf /' } });
    expect(v?.block).toBeUndefined();
  });
  it('E1：计划已激活后元数据查询照常放行（豁免不改变已激活时的行为）', () => {
    const gate = createServeGate({ planActive: () => true , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway operation list' } })?.block).toBeUndefined();
  });
  it('bash：元字符软放行（审计留痕），非网关命令照拦', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => true, onEvent: (e) => events.push(e) , gateway: 'bin/example-gateway' });
    // 2026-10-18 软约束：元字符硬拦曾把附件名里的 ASCII 括号 (1) 当注入拦死，worker 的
    // 合法路径参数两度被拒（run5 实测）。此刻放行 + detail 软标记；硬拦随沙箱阶段重建。
    for (const command of ['bin/example-gateway query x; cat .env', 'bin/example-gateway query $(cat .env)']) {
      expect(gate({ name: 'bash', arguments: { command } })?.block, command).toBeUndefined();
    }
    const metacharEvents = events.filter((e) => e.detail?.includes('软放行'));
    expect(metacharEvents.length).toBe(2);
    // 非网关命令放行（首词规则降级为分类判据），审计 events 里可复盘
    for (const command of ['EXECUTION_SERVE=0 bin/example-gateway query x', 'node script.js']) {
      expect(gate({ name: 'bash', arguments: { command } })?.block, command).toBeUndefined();
    }
  });

  // ── 计划前置读平台语义表的 plan 列（同一处病根的第四处，也是最后一处）────────────
  //
  // 病根：宿主在计划拒绝分流处说"该调用不需要计划、也不要放进计划，直接调用即可"
  // （planNotReadOnlyCode 读语义表 plan=false → PLAN_NOT_PLANNABLE），转身在本书门前
  // 说"尚无宿主激活的平台计划"——自相矛盾。而平台侧对 plan=false 的 operation，
  // planEligible 为假、reserveInvocation 根本不调，**平台本来就不要求计划**；这道
  // 要求是宿主单方面加的。计划门的三样价值（预算硬闸 / 范围摘要给人签字 / 写操作确认门）
  // 对纯本地计算全部不成立，为它提计划纯属仪式。
  //
  // 判据因此只有一列：平台语义表的 plan。宿主不另立 operation 名单（L2），也不认
  // access 类名——表和驱动侧计划拒绝分流同一份，测试替身直接注入，绝不 spawn 平台 CLI。
  describe('计划前置豁免：读平台语义表的 plan 列', () => {
    /** 与平台 `operation list --json` 同形的替身表（注册名 + command 裸名双键）。 */
    const SEMANTICS: OperationSemantics = new Map<string, AccessSemantics>([
      // 纯本地计算：不触平台会话、不耗令牌、不写平台数据 → 不要计划
      ['payroll.validate', { plan: false, confirm: false }],
      ['validate', { plan: false, confirm: false }],
      ['payroll.transform', { plan: false, confirm: false }],
      ['transform', { plan: false, confirm: false }],
      // 只读平台数据 / 写：受过计划门管辖 → 要计划
      ['finance.search-account-sets', { plan: true, confirm: false }],
      ['search-account-sets', { plan: true, confirm: false }],
      ['voucher.query-saved', { plan: true, confirm: false }],
      ['query-saved', { plan: true, confirm: false }],
      ['voucher.commit', { plan: true, confirm: true }],
      ['commit', { plan: true, confirm: true }],
      // 同名脚本登记在两个域、语义不同：域内解析的分界线
      ['voucher.validate', { plan: true, confirm: false }],
    ]);
    const bash = (command: string) => ({ name: 'bash', arguments: { command } });

    it('plan:false 的 operation 在计划未激活时放行（不再自相矛盾）', () => {
      const gate = createServeGate({ planActive: () => false, operationSemantics: SEMANTICS , gateway: 'bin/example-gateway' });
      for (const cmd of [
        'bin/example-gateway operation run payroll.validate tmp/x.json',
        'bin/example-gateway operation run payroll.transform tmp/x.json tmp/out',
        'bin/example-gateway query src/payroll/scripts/validate-contract.js tmp/x.json',
        'bin/example-gateway prepare src/payroll/scripts/transform.py tmp/x.json tmp/out',
      ]) {
        expect(gate(bash(cmd))?.block, cmd).toBeUndefined();
      }
    });

    it('plan:true 的 operation 在计划未激活时照旧拒 SERVE_PLAN_NOT_ACTIVE', () => {
      const gate = createServeGate({ planActive: () => false, operationSemantics: SEMANTICS , gateway: 'bin/example-gateway' });
      for (const cmd of [
        'bin/example-gateway query src/finance/scripts/search-account-sets.js --query x',
        'bin/example-gateway query src/voucher/scripts/query-saved.js A 202609',
        'bin/example-gateway operation run finance.search-account-sets --query x',
        'bin/example-gateway commit src/voucher/scripts/fill.js c.json --save',
      ]) {
        const v = gate(bash(cmd));
        expect(v?.block, cmd).toBe(true);
        expect(v?.reason, cmd).toContain('宿主激活');
      }
    });

    it('同名脚本按域解析：payroll 域纯本地放行，voucher 域只读仍要计划', () => {
      // 平台侧同一份脚本名登记在两个域而语义不同（一个纯本地、一个只读平台数据）。
      // 跨域猜就会把"要计划"的判成"不要计划"——那是放松方向，绝不允许。
      const gate = createServeGate({ planActive: () => false, operationSemantics: SEMANTICS , gateway: 'bin/example-gateway' });
      expect(gate(bash('bin/example-gateway query src/payroll/scripts/validate-contract.js tmp/x.json'))?.block).toBeUndefined();
      expect(gate(bash('bin/example-gateway query src/voucher/scripts/validate-contract.js tmp/x.json'))?.block).toBe(true);
    });

    it('fail-closed：语义表缺失 / 空表 / operation 不在表里 → 照旧要求计划', () => {
      const inactive = createServeGate({ planActive: () => false , gateway: 'bin/example-gateway' });
      const empty = createServeGate({ planActive: () => false, operationSemantics: new Map() , gateway: 'bin/example-gateway' });
      const missing = createServeGate({
        planActive: () => false,
        // 表里只有只读域：payroll 的两个 operation 查不到
        operationSemantics: new Map<string, AccessSemantics>([
          ['voucher.query-saved', { plan: true, confirm: false }],
          ['query-saved', { plan: true, confirm: false }],
        ]),
        gateway: 'bin/example-gateway',
      });
      for (const gate of [inactive, empty, missing]) {
        for (const cmd of [
          'bin/example-gateway query src/payroll/scripts/validate-contract.js tmp/x.json',
          'bin/example-gateway prepare src/payroll/scripts/transform.py tmp/x.json tmp/out',
          'bin/example-gateway operation run payroll.validate tmp/x.json',
          'bin/example-gateway query src/unknown/scripts/whatever.js x',
        ]) {
          expect(gate(bash(cmd))?.block, cmd).toBe(true);
        }
      }
    });

    it('已有激活计划时一切照旧（豁免不改变已激活时的行为）', () => {
      const gate = createServeGate({ planActive: () => true, operationSemantics: SEMANTICS , gateway: 'bin/example-gateway' });
      for (const cmd of [
        'bin/example-gateway query src/payroll/scripts/validate-contract.js tmp/x.json',
        'bin/example-gateway query src/finance/scripts/search-account-sets.js --query x',
        'bin/example-gateway query src/voucher/scripts/query-saved.js A 202609',
      ]) {
        expect(gate(bash(cmd))?.block, cmd).toBeUndefined();
      }
    });

    it('放行的 plan:false 调用仍受其余门约束：非网关 / 敏感路径照拦（元字符已软放行）', () => {
      const gate = createServeGate({ platformRoot: process.cwd(), planActive: () => false, operationSemantics: SEMANTICS , gateway: 'bin/example-gateway' });
      // 元字符 2026-10-18 起软放行（硬拦误伤文件名里的 ASCII 括号），硬拦随沙箱重建
      expect(gate(bash('bin/example-gateway query src/payroll/scripts/validate-contract.js tmp/x.json; rm -rf /'))?.block).toBeUndefined();
      // 非网关调用放行（首词规则降级为分类；执行层自治）
      expect(gate(bash('cat x'))?.block).toBeUndefined();
      // 敏感路径照拦（read 门与计划分支无关，但同一门内不得因豁免松动）
      expect(gate({ name: 'read', arguments: { file_path: '.env' } })?.block).toBe(true);
      // local 打到工作区外：编排层放行，执行层网关原生拒（自治）
      expect(gate(bash('bin/example-gateway local src/payroll/scripts/transform.py'))?.block).toBeUndefined();
    });

    it('放行的 plan:false 调用照常留审计痕（宿主放行了什么必须可复盘）', () => {
      const events: ServeGateEvent[] = [];
      const gate = createServeGate({ planActive: () => false, operationSemantics: SEMANTICS, onEvent: (e) => events.push(e) , gateway: 'bin/example-gateway' });
      gate(bash('bin/example-gateway query src/payroll/scripts/validate-contract.js tmp/x.json'));
      expect(events.at(-1)).toMatchObject({ tool: 'bash', allowed: true });
      expect(events.at(-1)?.detail).toContain('validate-contract.js');
    });
  });

  // ── 计划前置三级判据：scratch 免计划 / read 要激活计划 / write 要被某一步覆盖 ──────
  //
  // 病根（2026-11-08 修）：旧判据 `!planActive() && !planExempt(...)` 只查"有没有激活
  // 计划"，不查"这份计划覆不覆盖这次调用"。实测后果：激活的计划全是 dummy.query（读），
  // 4 次 plan_submit 全被拒，而 dummy.proposal / dummy.proposal-commit（写）照样调通——
  // 数据落地，用户从未确认。门自己的注释写着"未知 op 可能写平台数据，宁拦勿猜"，实现
  // 却没做到。
  //
  // 分级依据只有平台语义表（`operation list --json` 的 access 列 × 顶层 accessSemantics
  // 表），宿主不认 access 词表、不另立 operation 名单。这里守四件事，外加三条边界
  // （读不锁死、未登记形态不回退、跨域同名不算覆盖）。
  describe('计划前置三级判据：scratch 免计划 / read 要计划 / write 要覆盖', () => {
    /** 与 dummy 夹具 `operation list --json` 同形的替身语义表（access 三族各一条）。 */
    const DUMMY: OperationSemantics = new Map<string, AccessSemantics>([
      ['dummy.query', { plan: true, confirm: false }],           // access=read
      ['dummy.scratch', { plan: false, confirm: false }],        // access=scratch（纯本地计算）
      ['dummy.commit', { plan: true, confirm: true }],           // access=write
      ['dummy.proposal', { plan: true, confirm: true }],         // access=write
      ['dummy.proposal-commit', { plan: true, confirm: true }],  // access=write
      ['ballot.proposal', { plan: true, confirm: true }],        // 另一域的同一个脚本名
    ]);
    const bash = (command: string) => ({ name: 'bash', arguments: { command } });
    /** 带激活计划（calls 由调用方给）的门。 */
    const withPlan = (calls: readonly PlanCall[], extra: Partial<ServeGateOptions> = {}) => createServeGate({
      planActive: () => true,
      operationSemantics: DUMMY,
      activePlanCalls: () => calls,
      ...extra,
      gateway: 'bin/example-gateway',
    });

    it('① 激活计划只有读（dummy.query）→ 写类调用被拒，理由点名是哪个 operation 不在计划里', () => {
      const gate = withPlan([{ operation: 'dummy.query', args: ['--collection', 'alpha'] }]);
      for (const command of [
        'bin/example-gateway prepare dummy.proposal tmp/task_x/payload.json',
        'bin/example-gateway commit dummy.proposal-commit --proposal-id P-1',
      ]) {
        const verdict = gate(bash(command));
        expect(verdict?.block, command).toBe(true);
        // 措辞收口在 error-codes.ts：既有消息一字不差，只追加"哪个 operation 不在计划里"
        expect(verdict?.reason, command).toContain(messageTextFor('SERVE_PLAN_NOT_ACTIVE'));
        expect(verdict?.reason, command).toContain('dummy.proposal');
      }
    });

    it('② 激活计划只有读 → 另一个读（不同 collection）放行：探索性查询不锁死', () => {
      const gate = withPlan([{ operation: 'dummy.query', args: ['--collection', 'alpha'] }]);
      // 计划里写查 alpha，worker 看了结果想查 beta——正当探索，不能拦死
      expect(gate(bash('bin/example-gateway query dummy.query --collection beta'))?.block).toBeUndefined();
      // 计划里那一步本身（含计划没带的 --window）照旧放行
      expect(gate(bash('bin/example-gateway query dummy.query --collection alpha --window W1'))?.block).toBeUndefined();
    });

    it('③ 计划含该写声明的关键参数 → 放行；同 operation 不同参数 → 拒', () => {
      const covered = withPlan([{ operation: 'dummy.commit', args: ['--collection', 'alpha'] }]);
      expect(covered(bash('bin/example-gateway commit dummy.commit --collection alpha'))?.block).toBeUndefined();
      // 关键参数一致 ≠ 全等：调用比计划多带 --window/--count 仍算覆盖（全等会误判）
      expect(covered(bash('bin/example-gateway commit dummy.commit --collection alpha --window W1 --count 3'))?.block).toBeUndefined();
      // 同 operation 不同值 → 不覆盖
      const other = covered(bash('bin/example-gateway commit dummy.commit --collection beta'));
      expect(other?.block).toBe(true);
      expect(other?.reason).toContain('dummy.commit');
      // 反方向不放松：计划声明了 --window 而这次调用没带，目标就不一定是那一个
      const windowed = withPlan([{ operation: 'dummy.commit', args: ['--collection', 'alpha', '--window', 'W1'] }]);
      expect(windowed(bash('bin/example-gateway commit dummy.commit --collection alpha'))?.block).toBe(true);
      // 编号类关键参数：proposal id 运行时才产生，计划步骤不带它即覆盖任意 id；带了就只覆盖那一个
      const anyId = withPlan([{ operation: 'dummy.proposal-commit', args: [] }]);
      expect(anyId(bash('bin/example-gateway commit dummy.proposal-commit --proposal-id P-9'))?.block).toBeUndefined();
      const pinned = withPlan([{ operation: 'dummy.proposal-commit', args: ['--proposal-id', 'P-1'] }]);
      expect(pinned(bash('bin/example-gateway commit dummy.proposal-commit --proposal-id P-1'))?.block).toBeUndefined();
      const wrongId = pinned(bash('bin/example-gateway commit dummy.proposal-commit --proposal-id P-2'));
      expect(wrongId?.block).toBe(true);
      expect(wrongId?.reason).toContain('dummy.proposal-commit');
    });

    it('④ scratch（plan=false）无计划也放行：既有豁免口径一字不回退', () => {
      const gate = createServeGate({ planActive: () => false, operationSemantics: DUMMY, gateway: 'bin/example-gateway' });
      expect(gate(bash('bin/example-gateway query dummy.scratch --input tmp/x.json'))?.block).toBeUndefined();
      expect(gate(bash('bin/example-gateway operation run dummy.scratch --input tmp/x.json'))?.block).toBeUndefined();
    });

    it('边界：写类在没有激活计划时照旧拒（存在性判据先于覆盖判据）', () => {
      const gate = createServeGate({
        planActive: () => false,
        operationSemantics: DUMMY,
        activePlanCalls: () => [{ operation: 'dummy.commit', args: ['--collection', 'alpha'] }],
        gateway: 'bin/example-gateway',
      });
      // 没有计划：只有既有消息，不带覆盖后缀（覆盖判据轮不到它说话）
      expect(gate(bash('bin/example-gateway commit dummy.commit --collection alpha'))?.reason)
        .toBe(messageTextFor('SERVE_PLAN_NOT_ACTIVE'));
    });

    it('边界：恢复的会话拿不到计划内容（calls 空）→ 写类拒、读类照旧放行', () => {
      const gate = createServeGate({ planActive: () => true, operationSemantics: DUMMY, activePlanCalls: () => [], gateway: 'bin/example-gateway' });
      // 读不锁死
      expect(gate(bash('bin/example-gateway query dummy.query --collection alpha'))?.block).toBeUndefined();
      // 写 fail-closed：不知道这份计划覆盖什么就不写，直到本会话重新激活一份计划
      expect(gate(bash('bin/example-gateway commit dummy.commit --collection alpha'))?.block).toBe(true);
    });

    it('边界：语义表缺失 / operation 未登记 → 只要求激活计划（2026-10-09 起的既有防线）', () => {
      const unknownOp = createServeGate({ planActive: () => true, operationSemantics: DUMMY, activePlanCalls: () => [], gateway: 'bin/example-gateway' });
      expect(unknownOp(bash('bin/example-gateway commit src/unknown/scripts/whatever.js c.json'))?.block).toBeUndefined();
      const emptyTable = createServeGate({ planActive: () => true, operationSemantics: new Map(), activePlanCalls: () => [], gateway: 'bin/example-gateway' });
      expect(emptyTable(bash('bin/example-gateway commit dummy.commit --collection alpha'))?.block).toBeUndefined();
    });

    // ── 结构化调用（structured_call）与 bash 共用同一份覆盖判据 ──────────────────────
    // 2026-11-09 四审 blocking：structured_call 分支原先只查 requiresPlan 的存在性，于是一份
    // 纯读计划激活后，清单里已登记的写 operation 仍能经结构化通道进网关——bash 侧新加的覆盖
    // 检查在这条路上原样不存在。现在两条路都走 planCoverageVerdict，这里钉住结构化这一侧。
    it('结构化写调用：纯读计划激活后被拒，理由点名 operation（与 bash 同措辞）', () => {
      const ctx = { planActive: () => true, operationSemantics: DUMMY, activePlanCalls: () => [{ operation: 'dummy.query', args: ['--collection', 'alpha'] }] as readonly PlanCall[] };
      for (const operation of ['dummy.proposal', 'dummy.proposal-commit', 'dummy.commit']) {
        const verdict = structuredPlanGateVerdict(operation, { '--collection': 'alpha' }, ctx);
        expect(verdict?.block, operation).toBe(true);
        expect(verdict?.reason, operation).toContain(messageTextFor('SERVE_PLAN_NOT_ACTIVE'));
        expect(verdict?.reason, operation).toContain('dummy.');
      }
    });

    it('结构化读调用：纯读计划下另一个 collection 放行（探索性查询不锁死，同 bash）', () => {
      const ctx = { planActive: () => true, operationSemantics: DUMMY, activePlanCalls: () => [{ operation: 'dummy.query', args: ['--collection', 'alpha'] }] as readonly PlanCall[] };
      expect(structuredPlanGateVerdict('dummy.query', { '--collection': 'beta' }, ctx)?.block).toBeUndefined();
    });

    it('结构化 scratch 调用：免计划前置（与 bash 同一列同一判据）', () => {
      const ctx = { planActive: () => true, operationSemantics: DUMMY, activePlanCalls: () => [] as readonly PlanCall[] };
      expect(structuredPlanGateVerdict('dummy.scratch', {}, ctx)?.block).toBeUndefined();
    });

    it('结构化写调用：计划含同 operation 同关键参数 → 放行；参数不同 → 拒', () => {
      const covered = { planActive: () => true, operationSemantics: DUMMY, activePlanCalls: () => [{ operation: 'dummy.proposal', args: ['--collection', 'alpha'] }] as readonly PlanCall[] };
      expect(structuredPlanGateVerdict('dummy.proposal', { '--collection': 'alpha' }, covered)?.block).toBeUndefined();
      // 计划声明了 --collection alpha，这次调 beta → 目标不一定同一个，拒
      expect(structuredPlanGateVerdict('dummy.proposal', { '--collection': 'beta' }, covered)?.block).toBe(true);
      // 计划没声明关键参数 → 覆盖该 operation 的任何调用
      const bare = { planActive: () => true, operationSemantics: DUMMY, activePlanCalls: () => [{ operation: 'dummy.proposal', args: [] }] as readonly PlanCall[] };
      expect(structuredPlanGateVerdict('dummy.proposal', { '--collection': 'whatever' }, bare)?.block).toBeUndefined();
    });

    it('结构化调用：无激活计划 → 读写都要先有计划；未登记 operation 同判据', () => {
      const noPlan = { planActive: () => false, operationSemantics: DUMMY, activePlanCalls: () => [] as readonly PlanCall[] };
      expect(structuredPlanGateVerdict('dummy.query', {}, noPlan)?.block).toBe(true);
      expect(structuredPlanGateVerdict('dummy.proposal', {}, noPlan)?.block).toBe(true);
      // 语义表里没有 → unknown 档：按既有防线只要求有计划（不因未登记就放行）
      const unknown = { planActive: () => true, operationSemantics: DUMMY, activePlanCalls: () => [] as readonly PlanCall[] };
      expect(structuredPlanGateVerdict('not.registered', {}, unknown)?.block).toBeUndefined();
    });

    it('位置参数声明的执行层：计划与调用位置参数不同 ⇒ 不覆盖（五审 blocking）', () => {
      // 复现缺陷：某执行层以位置参数声明目标（args=['alpha','W1'] 而不是
      // --collection alpha）。旧判据只提取 flag，位置参数整批丢弃 ⇒ wanted 为空 ⇒
      // 直接 return true，于是计划查 alpha、实际写 beta 也判"已覆盖"。
      const SPECS: OperationArgsSpecs = new Map([
        ['ledger.query', { positionalNames: ['account', 'period'], flagStyles: new Map() }],
        ['ledger.write', { positionalNames: ['account', 'period'], flagStyles: new Map() }],
      ]);
      const writeTier: OperationSemantics = new Map([['ledger.write', { plan: true, confirm: true }]]);
      const ctx = {
        planActive: () => true,
        operationSemantics: writeTier,
        activePlanCalls: () => [{ operation: 'ledger.write', args: ['alpha', 'W1'] }] as readonly PlanCall[],
        operationArgsSpecs: SPECS,
      };
      // 同名同位置参数 → 覆盖
      expect(structuredPlanGateVerdict('ledger.write', { account: 'alpha', period: 'W1' }, ctx)?.block).toBeUndefined();
      // 位置参数不同 → 不覆盖（旧代码这里放行）
      expect(structuredPlanGateVerdict('ledger.write', { account: 'beta', period: 'W2' }, ctx)?.block).toBe(true);
      // 少给一个位置参数 → 也不覆盖（范围说不清）
      expect(structuredPlanGateVerdict('ledger.write', { account: 'alpha' }, ctx)?.block).toBe(true);
    });

    it('confirm:true 优先于 plan:false——要确认的操作不当成免计划（九审 blocking）', () => {
      // 复现缺陷：解析器明确产出 {plan:false, confirm:true}（operation-labels.test.ts 的
      // partial 用例）。旧分级先看 plan===false 判 scratch ⇒ 免激活计划、免写覆盖，
      // 于是"要用户确认却没有任何计划"的操作被放行。免计划档是整个门里最松的一档。
      const PARTIAL: OperationSemantics = new Map([
        ['ledger.partial', { plan: false, confirm: true }],
        ['ledger.plain', { plan: false, confirm: false }],
      ]);
      const ctx = {
        planActive: () => true,
        operationSemantics: PARTIAL,
        activePlanCalls: () => [{ operation: 'ledger.query', args: [] }] as readonly PlanCall[],
      };
      // confirm:true ⇒ 写类 ⇒ 不被任何计划步骤覆盖 ⇒ 拒
      expect(structuredPlanGateVerdict('ledger.partial', {}, ctx)?.block).toBe(true);
      // 对照：真的 scratch（plan:false, confirm:false）仍免计划
      expect(structuredPlanGateVerdict('ledger.plain', {}, ctx)?.block).toBeUndefined();
      // bash 侧同规（同一分级函数）
      const gate = createServeGate({
        planActive: () => true,
        operationSemantics: PARTIAL,
        activePlanCalls: () => [{ operation: 'ledger.query', args: [] }],
        gateway: 'bin/example-gateway',
      });
      expect(gate(bash('bin/example-gateway prepare ledger.partial x'))?.block).toBe(true);
      expect(gate(bash('bin/example-gateway prepare ledger.plain x'))?.block).toBeUndefined();
    });

    it('位置参数按声明顺序取值，对象键序不影响判定（六审 blocking）', () => {
      // 复现缺陷：声明 [account, period]、计划 ['alpha','W1']。调用方把键序换成
      // {period:'alpha', account:'W1'}——按插入顺序收集会得到 ['alpha','W1'] 从而放行，
      // 但 account 实际拿到的是 'W1'、period 拿到 'alpha'，目标已经互换。
      const SPECS: OperationArgsSpecs = new Map([
        ['ledger.write', { positionalNames: ['account', 'period'], flagStyles: new Map() }],
      ]);
      const ctx = {
        planActive: () => true,
        operationSemantics: new Map([['ledger.write', { plan: true, confirm: true }]]) as OperationSemantics,
        activePlanCalls: () => [{ operation: 'ledger.write', args: ['alpha', 'W1'] }] as readonly PlanCall[],
        operationArgsSpecs: SPECS,
      };
      // 正确键序 → 放行
      expect(structuredPlanGateVerdict('ledger.write', { account: 'alpha', period: 'W1' }, ctx)?.block).toBeUndefined();
      // 键序换过但名值对应关系不变 → 仍放行（键序是调用方自由）
      expect(structuredPlanGateVerdict('ledger.write', { period: 'W1', account: 'alpha' }, ctx)?.block).toBeUndefined();
      // 键序换且名值互换 → 必须拒（旧代码这里放行）
      expect(structuredPlanGateVerdict('ledger.write', { period: 'alpha', account: 'W1' }, ctx)?.block).toBe(true);
      // 缺一个位置参数 → 拒
      expect(structuredPlanGateVerdict('ledger.write', { account: 'alpha' }, ctx)?.block).toBe(true);
    });

    it('位置参数：执行层没声明 positionalNames 而计划步带了位置参数 ⇒ 不覆盖（fail-closed）', () => {
      // 拿不到声明就无法证明范围一致——不能把"没解析出 flag"解释成"授权任意目标"。
      const ctx = {
        planActive: () => true,
        operationSemantics: new Map([['ledger.write', { plan: true, confirm: true }]]) as OperationSemantics,
        activePlanCalls: () => [{ operation: 'ledger.write', args: ['alpha', 'W1'] }] as readonly PlanCall[],
        // 故意不给 operationArgsSpecs
      };
      expect(structuredPlanGateVerdict('ledger.write', { account: 'alpha', period: 'W1' }, ctx)?.block).toBe(true);
    });

    it('bash 侧位置参数判据同规（去掉了网关词/子命令/operation 引用再比）', () => {
      const SPECS: OperationArgsSpecs = new Map([
        ['ledger.write', { positionalNames: ['account', 'period'], flagStyles: new Map() }],
      ]);
      const gate = createServeGate({
        planActive: () => true,
        operationSemantics: new Map([['ledger.write', { plan: true, confirm: true }]]),
        operationArgsSpecs: SPECS,
        activePlanCalls: () => [{ operation: 'ledger.write', args: ['alpha', 'W1'] }],
        gateway: 'bin/example-gateway',
      });
      // 位置参数一致 → 放行
      expect(gate(bash('bin/example-gateway prepare ledger.write alpha W1'))?.block).toBeUndefined();
      // 位置参数不同 → 拒（旧代码只看 flag，这里 wanted 为空直接放行）
      expect(gate(bash('bin/example-gateway prepare ledger.write beta W2'))?.block).toBe(true);
    });

    it('结构化与 bash 对同一场景给同一结论（防两条路漂移）', () => {
      const calls = [{ operation: 'dummy.query', args: ['--collection', 'alpha'] }] as readonly PlanCall[];
      const ctx = { planActive: () => true, operationSemantics: DUMMY, activePlanCalls: () => calls };
      const viaStructured = structuredPlanGateVerdict('dummy.proposal', { '--collection': 'alpha' }, ctx);
      const viaBash = withPlan(calls)(bash('bin/example-gateway prepare dummy.proposal tmp/task_x/payload.json'));
      expect(viaStructured?.block).toBe(true);
      expect(viaBash?.block).toBe(true);
      expect(viaStructured?.reason).toContain('未被已激活计划覆盖');
      expect(viaBash?.reason).toContain('未被已激活计划覆盖');
    });

    it('覆盖匹配按 operation 认：脚本路径与注册名两种引用都认，跨域同名不算覆盖', () => {
      // 计划里是 ballot 域的 proposal；调用的是 dummy 域的同一个脚本名 → 不是同一步
      const crossDomain = withPlan([{ operation: 'ballot.proposal', args: [] }]);
      expect(crossDomain(bash('bin/example-gateway prepare src/dummy/scripts/proposal.js tmp/p.json'))?.block).toBe(true);
      // 同域：脚本路径形态与注册名直呼都算同一步
      const same = withPlan([{ operation: 'dummy.proposal', args: [] }]);
      expect(same(bash('bin/example-gateway prepare src/dummy/scripts/proposal.js tmp/p.json'))?.block).toBeUndefined();
      expect(same(bash('bin/example-gateway operation run dummy.proposal tmp/p.json'))?.block).toBeUndefined();
    });
  });

  it('read 按知识面裁决，ls 只受 workspace 边界与敏感路径约束', () => {
    const gate = createServeGate({ platformRoot: process.cwd() , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'read', arguments: { file_path: 'docs/guide.md' } })?.block).toBeUndefined();
    expect(gate({ name: 'read', arguments: { file_path: 'src/private.ts' } })?.block).toBe(true);
    expect(gate({ name: 'read', arguments: { file_path: '.env' } })?.block).toBe(true);
    expect(gate({ name: 'read', arguments: { file_path: '../outside/docs.md' } })?.block).toBe(true);
    expect(gate({ name: 'ls', arguments: {} })?.block).toBeUndefined();
  });

  it('放行与拦截均审计，审计故障不影响裁决', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => true, onEvent: (event) => events.push(event) , gateway: 'bin/example-gateway' });
    gate({ name: 'bash', arguments: { command: 'bin/example-gateway query q A 202609' } });
    gate({ name: 'bash', arguments: { command: 'cat .env' } });
    expect(events.map((event) => event.allowed)).toEqual([true, true]);
    const brokenAudit = createServeGate({ planActive: () => true, onEvent: () => { throw new Error('audit down'); }, gateway: 'bin/example-gateway' });
    expect(brokenAudit({ name: 'bash', arguments: { command: 'bin/example-gateway query q A 202609' } })?.block).toBeUndefined();
  });
});

// ── A1 任务一：形态解析不出 operation 时，拒绝理由指向数据源 ────────────────────
//
// 实测根因：平台清单不吐 script 字段，而清单里的 command 与真实脚本名不一致，worker 无从
// 机械构造命令，只能猜一个形状（缺 mode、缺脚本路径）。旧理由只说"形状不合法 / 尚无激活
// 计划"——没告诉它正确形状从哪来，于是它猜第二次、第三次，最后绕开平台自己包 wrapper
// （平台审计里 validate/transform 一次没经网关，而足迹只写着"1 次网关调用"）。
//
// 这里守四件事：
//   ① 猜的形状拿不到放行（计划已激活也拒）——堵住"猜一个形状让平台去拒"的空转；
//   ② 理由不含网关名字面量（唯一真相在平台契约常量与技能文档，刚花了一轮才清出去）；
//   ③ 理由不复述完整调用形状（第二份真相会随平台演进漂移）；
//   ④ 理由指出数据源：每个 operation 的脚本路径与开放 mode 见清单机器可读面的 script / serve。
describe('形态解析不出 operation：拒绝只指路，不复述形状（A1 任务一）', () => {
  /** A1 实测形态：worker 猜出来的调用（缺 mode、缺脚本路径）。 */
  const GUESSED = [
    'bin/example-gateway payroll.validate tmp/req_x/contract.json',
    'bin/example-gateway payroll.transform tmp/req_x/contract.json out.xlsx',
    'bin/example-gateway validate tmp/req_x/contract.json',
    'bin/example-gateway operation',
    'bin/example-gateway operation run',
    'bin/example-gateway query',
    'bin/example-gateway',
    'bash bin/example-gateway payroll.validate tmp/req_x/contract.json',
  ];

  it('猜的形状放行：形态合法性归执行层网关原生裁决（编排层只对认得出的 operation 执法）', () => {
    const gate = createServeGate({ planActive: () => true , gateway: 'bin/example-gateway' });
    for (const command of GUESSED) {
      expect(gate({ name: 'bash', arguments: { command } })?.block, command).toBeUndefined();
    }
  });

  it('既有拒绝理由语义不变：新码只收"解析不出 operation"这一种', () => {
    const gate = createServeGate({ planActive: () => true, scratchDir: 'tmp/req_x' , gateway: 'bin/example-gateway' });
    // 根本不是网关调用 → 放行（首词拦截退役，审计留痕）
    expect(gate({ name: 'bash', arguments: { command: 'python src/payroll/scripts/transform.py a b' } })?.block).toBeUndefined();
    // shell 元字符（2026-10-18 软放行）：三条旧 METACHAR 拒绝退役，命令放行仅留审计
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway query a b; cat .env' } })).toBeUndefined();
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway operation list\nrm -rf /' } })).toBeUndefined();
    // tmp/req_x 是本测试声明的 scratchDir：区内 local + 元字符 → 软放行
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway local tmp/req_x/x.py && whoami' } })).toBeUndefined();
    // local 打到放行根之外：编排层放行，执行层网关原生拒（自治）
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway local src/payroll/scripts/transform.py' } })?.block).toBeUndefined();
    // 计划提交形状教学（worker 直达 evaluate/activate）
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway plan activate --stdin' } })?.reason)
      .toBe(messageTextFor('PLAN_SHAPE_GATE_TEACHING', undefined, 'bin/example-gateway'));
    // 计划未激活（形态合法、只是还没计划）
    const inactive = createServeGate({ planActive: () => false , gateway: 'bin/example-gateway' });
    expect(inactive({ name: 'bash', arguments: { command: 'bin/example-gateway query q.js A 202609' } })?.reason)
      .toBe(messageTextFor('SERVE_PLAN_NOT_ACTIVE'));
    // 元数据查询与合法 local 照旧放行（新码没有把豁免开成拒绝）
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway operation list --json' } })?.block).toBeUndefined();
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway local tmp/req_x/run.py' } })?.block).toBeUndefined();
  });

  it('领域记忆组的计划门行为一字不改（形态认得出来，但今天仍要激活的计划）', () => {
    // 回归锁：memory 是平台技能文档写明给 worker 的出口。新码只堵"猜形状"，不许顺手把它
    // 关掉，也不许为了让它过而放松计划门——两侧现状都必须原样。
    const active = createServeGate({ planActive: () => true , gateway: 'bin/example-gateway' });
    expect(active({ name: 'bash', arguments: { command: 'bin/example-gateway memory list --scope customer --id 甲' } })?.block).toBeUndefined();
    const inactive = createServeGate({ planActive: () => false , gateway: 'bin/example-gateway' });
    expect(inactive({ name: 'bash', arguments: { command: 'bin/example-gateway memory list --scope customer --id 甲' } })?.reason)
      .toBe(messageTextFor('SERVE_PLAN_NOT_ACTIVE'));
  });

  it('形态合法时照旧放行且不因新码变严（query/prepare/commit/operation run 四种）', () => {
    const gate = createServeGate({ planActive: () => true , gateway: 'bin/example-gateway' });
    for (const command of [
      'bin/example-gateway query src/voucher/scripts/query-saved.js A 202609',
      'bin/example-gateway prepare src/payroll/scripts/transform.py c.json out',
      'bin/example-gateway commit src/voucher/scripts/fill.js c.json --save',
      'bin/example-gateway operation run payroll.transform c.json',
    ]) {
      expect(gate({ name: 'bash', arguments: { command } })?.block, command).toBeUndefined();
    }
  });

});

// ── A1 任务二：形态族分类（绕开平台执行器的披露判据输入）───────────────────────
describe('gateInvocationKind（形态族：本地执行 / 平台执行 / 辅助出口）', () => {
  it('三种族各认得出，判据只来自命令词法', () => {
    expect(gateInvocationKind('bin/example-gateway local tmp/req_x/run.py', 'bin/example-gateway')).toBe('local');
    expect(gateInvocationKind('bin/example-gateway query src/voucher/scripts/query-saved.js A 202609', 'bin/example-gateway')).toBe('executor');
    expect(gateInvocationKind('bin/example-gateway prepare src/payroll/scripts/transform.py c.json out', 'bin/example-gateway')).toBe('executor');
    expect(gateInvocationKind('bin/example-gateway commit src/voucher/scripts/fill.js c.json --save', 'bin/example-gateway')).toBe('executor');
    expect(gateInvocationKind('bin/example-gateway operation run payroll.transform c.json', 'bin/example-gateway')).toBe('executor');
    expect(gateInvocationKind('bin/example-gateway operation list --json', 'bin/example-gateway')).toBe('auxiliary');
    expect(gateInvocationKind('bin/example-gateway plan --schema', 'bin/example-gateway')).toBe('auxiliary');
  });

  it('领域记忆组也是认得的平台形态（形态分支不得把合法出口关掉）', () => {
    // 平台技能文档写明：serve worker 的领域记忆读写只经 memory 组。认不出它就会被
    // SERVE_INVOCATION_FORM_UNKNOWN 拒掉——那是把一条合法能力关掉，不是堵"猜形状"。
    expect(gateInvocationKind('bin/example-gateway memory list --scope customer --id 甲', 'bin/example-gateway')).toBe('auxiliary');
    expect(gateInvocationKind('bin/example-gateway memory get --key entry-format --scope customer --id 甲', 'bin/example-gateway')).toBe('auxiliary');
  });

  it('认不出的形态返回 null（缺 mode / 缺脚本路径 / 未注册形式 / 根本不是网关调用）', () => {
    expect(gateInvocationKind('bin/example-gateway payroll.validate tmp/x.json', 'bin/example-gateway')).toBeNull();
    expect(gateInvocationKind('bin/example-gateway operation run', 'bin/example-gateway')).toBeNull();
    expect(gateInvocationKind('bin/example-gateway query', 'bin/example-gateway')).toBeNull();
    expect(gateInvocationKind('bin/example-gateway', 'bin/example-gateway')).toBeNull();
    expect(gateInvocationKind('python src/payroll/scripts/transform.py a b', 'bin/example-gateway')).toBeNull();
  });

  it('bash 前缀与路径前缀走同一套词法（命令解析只此一份）', () => {
    expect(gateInvocationKind('bash bin/example-gateway local tmp/req_x/run.py', 'bin/example-gateway')).toBe('local');
    expect(gateInvocationKind('/opt/example-gateway/bin/example-gateway query q.js A', 'bin/example-gateway')).toBe('executor');
  });

  it('放行的调用把形态族挂进审计事件（执行面据此把"所有被放行的 bash"拆族）', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => true, scratchDir: 'tmp/req_x', onEvent: (e) => events.push(e) , gateway: 'bin/example-gateway' });
    gate({ name: 'bash', arguments: { command: 'bin/example-gateway query q.js A 202609' } });
    gate({ name: 'bash', arguments: { command: 'bin/example-gateway local tmp/req_x/run.py' } });
    gate({ name: 'bash', arguments: { command: 'bin/example-gateway operation list --json' } });
    gate({ name: 'write', arguments: { path: 'tmp/req_x/out.txt', content: 'x' } });
    expect(events.map((e) => e.invocation)).toEqual(['executor', 'local', 'auxiliary', undefined]);
  });
});

describe('describeKeyArgs（平台 args 规格消费，无宿主 flag 名单）', () => {
  // 规格即数据：与 parseOperationArgStyles 从 `operation list --json` 派生出来的表同形
  // （真实派生见 operation-labels.test.ts）。宿主零 flag 名单——平台加 flag 这边自动看得见。
  const styles: KeyArgStyles = new Map([
    ['--query', 'name'],
    ['--period', 'code'],
    ['--subject-code', 'code'],
    ['--customer', 'name'],
  ]);

  it('规格是唯一口径：名单外的 flag 不进摘要，宿主不另立第二份名单', () => {
    // D-012：KEY_ARG_FLAGS 硬编码表已删——这里钉住"规格里没有就不渲染"，防止回退。
    expect([...styles.keys()].sort()).not.toContain('--batch');
    expect(describeKeyArgs('bin/example-gateway commit fill.js c.json --batch --save', styles)).toEqual([]);
  });

  it('只摘规格内的 flag：名称类加书名号，编号/时间类原样，按命令出现顺序', () => {
    expect(describeKeyArgs('bin/example-gateway query query-saved.js 幻晟 202609', styles)).toEqual([]);
    expect(describeKeyArgs('bin/example-gateway query query-receivables.js --query 猫一杯 --period 202609', styles)).toEqual(['「猫一杯」', '202609']);
    expect(describeKeyArgs('bin/example-gateway query query-receivables.js --subject-code 1122 --query 猫一杯', styles)).toEqual(['1122', '「猫一杯」']);
    expect(describeKeyArgs('bin/example-gateway operation run finance.query-receivables --query 猫一杯 --customer 狗二', styles)).toEqual(['「猫一杯」', '「狗二」']);
  });

  it('等号写法同样认（--flag=值），样式照样从规格读', () => {
    expect(describeKeyArgs('bin/example-gateway query x.js --query=猫一杯 --period=202609', styles)).toEqual(['「猫一杯」', '202609']);
  });

  it('规格缺失 / 查不到这个 flag → 不进摘要（安全缺省，不回退硬编码名单）', () => {
    expect(describeKeyArgs('bin/example-gateway query query-receivables.js --query 猫一杯 --period 202609')).toEqual([]);
    expect(describeKeyArgs('bin/example-gateway query query-receivables.js --query 猫一杯 --period 202609', new Map())).toEqual([]);
    // 布尔开关（平台样式 none，不入表）与后随 flag 的取值都不进摘要
    expect(describeKeyArgs('bin/example-gateway query x.js --query --period 202609', styles)).toEqual(['202609']);
  });

  it('超长取值截断到 24 字符（进度帧不是长文）', () => {
    expect(describeKeyArgs(`bin/example-gateway query x.js --query ${'名'.repeat(40)}`, styles)).toEqual([`「${'名'.repeat(24)}」`]);
  });

  it('服务器路径不进摘要：参数摘要的唯一去处是用户可见进度帧', () => {
    // 2026-10-20 真机实测：payroll.detect 的 --out-dir 取的是宿主自己的任务工作区
    // （tmp/task_<uuid>），被渲染成「正在盘点薪酬数据源 + 契约草稿 「tmp/task_f695557e-…」…」。
    // 路径对企微里的用户零可行动性，同族 flag 还有 --contract / --cache / --out / --decisions。
    const pathStyles: KeyArgStyles = new Map([
      ['--query', 'name'],
      ['--out-dir', 'name'],
      ['--contract', 'name'],
      ['--cache', 'name'],
      ['--period', 'code'],
    ]);
    expect(describeKeyArgs('bin/example-gateway operation run payroll.detect 工资表.xlsx --out-dir tmp/task_f695557e-f9b1-4c7-9d2e-8a1b3c4d5e6f', pathStyles)).toEqual([]);
    expect(describeKeyArgs('bin/example-gateway operation run payroll.validate --contract /home/fictional-user/fictional-projects/fictional-execution-layer/tmp/task_x/c.json', pathStyles)).toEqual([]);
    // 等号写法同样拦
    expect(describeKeyArgs('bin/example-gateway operation run payroll.validate --contract=/home/fictional-user/fictional-projects/fictional-execution-layer/tmp/task_x/c.json', pathStyles)).toEqual([]);
    // 截断到 24 字符的半截路径也拦（前缀没被截掉）
    expect(describeKeyArgs('bin/example-gateway query x.js --cache tmp/task_f695557e-f9b1-4c7-9d2e', pathStyles)).toEqual([]);
    // 拦的是路径，不是这个 flag：同一条命令里的非路径取值照旧进摘要
    expect(describeKeyArgs('bin/example-gateway operation run payroll.detect --out-dir tmp/task_f695557e-f9b1-4c7 --query 幻骥达 --period 202609', pathStyles))
      .toEqual(['「幻骥达」', '202609']);
  });

  it('bash 前缀与空命令同样走同一套词法', () => {
    expect(describeKeyArgs('bash bin/example-gateway query x.js --query 甲', styles)).toEqual(['「甲」']);
    expect(describeKeyArgs('')).toEqual([]);
  });
});

describe('createServeGate（平台调用的人类可读投影）', () => {
  const labels = new Map([['query-saved', '查询已存档记录'], ['query-receivables', '读取应收余额']]);
  // 平台 args 规格（flag → 样式）：与 label 表一样由调用方注入，门只查表不持名单。
  const argStyles: KeyArgStyles = new Map([['--query', 'name'], ['--period', 'code']]);

  it('放行的平台调用挂上 label 与参数摘要（数据查表，无分支）', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => true, operationLabels: labels, operationArgStyles: argStyles, onEvent: (event) => events.push(event) , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway query query-receivables.js --query 猫一杯 --period 202609' } })?.block).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      tool: 'bash',
      allowed: true,
      label: '读取应收余额',
      keyArgs: ['「猫一杯」', '202609'],
    });
  });

  it('脚本路径/裸名/操作名三种写法命中同一条 label', () => {
    for (const command of [
      'bin/example-gateway query query-saved.js A 202609',
      'bin/example-gateway query src/voucher/scripts/query-saved.js A 202609',
      'bin/example-gateway operation run voucher.query-saved A 202609',
    ]) {
      const events: ServeGateEvent[] = [];
      const gate = createServeGate({ planActive: () => true, operationLabels: labels, onEvent: (event) => events.push(event) , gateway: 'bin/example-gateway' });
      expect(gate({ name: 'bash', arguments: { command } })?.block).toBeUndefined();
      expect(events.at(-1)?.label).toBe('查询已存档记录');
    }
  });

  it('label 表缺省/查不到 → 不挂字段（绝不回退脚本名或操作名）', () => {
    for (const extra of [{}, { operationLabels: labels }, { operationLabels: new Map() }]) {
      const events: ServeGateEvent[] = [];
      const gate = createServeGate({ planActive: () => true, onEvent: (event) => events.push(event), ...extra , gateway: 'bin/example-gateway' });
      expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway query smoke.js A 202609' } })?.block).toBeUndefined();
      expect(events.at(-1)?.label).toBeUndefined();
      expect(events.at(-1)?.keyArgs).toBeUndefined();
      expect(Object.keys(events.at(-1) ?? {}).sort()).toEqual(['allowed', 'detail', 'invocation', 'reason', 'tool']);
    }
  });

  it('args 规格缺省/查不到 flag → 参数摘要为空数组（有 label 也不硬编码名单）', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => true, operationLabels: labels, onEvent: (event) => events.push(event) , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway query query-receivables.js --query 猫一杯' } })?.block).toBeUndefined();
    expect(events.at(-1)?.label).toBe('读取应收余额');
    expect(events.at(-1)?.keyArgs).toEqual([]);
  });

  it('label 帧：真实发生的平台调用照发（元字符软放行不改变进度帧语义）', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => true, operationLabels: labels, describeArgs: () => ['替身'], onEvent: (event) => events.push(event) , gateway: 'bin/example-gateway' });
    gate({ name: 'bash', arguments: { command: 'bin/example-gateway query query-saved.js A 202609' } });
    gate({ name: 'bash', arguments: { command: 'bin/example-gateway query query-saved.js; cat .env' } });
    gate({ name: 'bash', arguments: { command: 'cat .env' } });
    gate({ name: 'read', arguments: { file_path: 'src/private.ts' } });
    // ① 干净网关调用：allowed + label + 参数摘要
    expect(events[0]).toMatchObject({ allowed: true, label: '查询已存档记录', keyArgs: ['替身'] });
    // ② 软放行的元字符调用同样是真实平台调用 → allowed；label 有无不钉（script token 是否被后缀污染而定）
    expect(events[1]?.allowed).toBe(true);
    // ③ 非网关命令放行：allowed、无 label（进度帧只属于平台调用）
    expect(events[2]).toMatchObject({ allowed: true });
    expect(events[2]?.label).toBeUndefined();
    // ④ 敏感路径 read 照拦
    expect(events[3]).toMatchObject({ allowed: false });
    expect(events[3]?.label).toBeUndefined();
  });

  it('describeArgs 替身可注入（测试不需要真平台词表）', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({
      planActive: () => true,
      operationLabels: labels,
      describeArgs: () => ['替身'],
      onEvent: (event) => events.push(event),
      gateway: 'bin/example-gateway',
    });
    gate({ name: 'bash', arguments: { command: 'bin/example-gateway query query-saved.js A 202609' } });
    expect(events.at(-1)).toMatchObject({ label: '查询已存档记录', keyArgs: ['替身'] });
  });

  it('既有审计字段与 tool_calls 消费者不受新字段影响', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => true, operationLabels: labels, onEvent: (event) => events.push(event) , gateway: 'bin/example-gateway' });
    gate({ name: 'bash', arguments: { command: 'bin/example-gateway query query-saved.js A 202609' } });
    gate({ name: 'bash', arguments: { command: 'cat .env' } });
    // assembly.ts 的 serveGateAudit 只读这四个字段
    expect(events.map((event) => [event.requestId, event.tool, event.allowed, event.detail])).toEqual([
      [undefined, 'bash', true, 'bin/example-gateway query query-saved.js A 202609'],
      [undefined, 'bash', true, 'cat .env'],
    ]);
  });
});

// ── 计划提交的审计摘要（审计缺口补齐：detail 是摘要，不是计划 JSON 全文）──────────

describe('describePlanCalls（计划提交审计摘要）', () => {
  it('operation 名 + args 摘要：多个 calls 可辨，绝不做计划 JSON 全文', () => {
    expect(describePlanCalls([
      { operation: 'voucher.query-saved', args: ['甲', '202609'] },
      { operation: 'voucher.prepare', args: ['甲', '202609'] },
    ])).toBe('voucher.query-saved 甲 202609 ; voucher.prepare 甲 202609');
    // 无参数 call 只记 operation 名；非字符串取值照常渲染（审计要可辨）
    expect(describePlanCalls([{ operation: 'payroll.transform', args: [] }])).toBe('payroll.transform');
    expect(describePlanCalls([{ operation: 'voucher.query-saved', args: ['甲', 202609, true, null] }]))
      .toBe('voucher.query-saved 甲 202609 true null');
  });

  it('单个取值与整体都有上限（与 describeKeyArgs 同一套截断预算）', () => {
    const long = 'x'.repeat(80);
    const detail = describePlanCalls([{ operation: 'voucher.query-saved', args: [long, long] }]);
    // 单值截到 KEY_ARG_MAX_CHARS
    expect(detail).toBe(`voucher.query-saved ${'x'.repeat(24)} ${'x'.repeat(24)}`);
    // 整体不超过 AUDIT_DETAIL_MAX_CHARS：再多 calls 也不会把 tool_calls 撑爆
    const many = Array.from({ length: 40 }, () => ({ operation: 'voucher.query-saved', args: ['甲', '202609'] }));
    expect(describePlanCalls(many).length).toBeLessThanOrEqual(AUDIT_DETAIL_MAX_CHARS);
  });

  it('空 calls → 空摘要（没有方案就没有可记的内容）', () => {
    expect(describePlanCalls([])).toBe('');
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
  const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });

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

// ── ls：只列名字，不限知识面（2026-10-08）────────────────────────────────────
// 为什么拆开：read 是内容层，ls 是发现层。绑同一条白名单会造出"允许读某文件却禁止发现
// 它存在"的矛盾组合——knowledgePaths 含 mappings/，worker 能 read
// src/payroll/mappings/<映射>.json，却 ls 不了 src/payroll/mappings/，于是知道该用现成
// 映射却不知道有哪些可用。实测代价：同一回合 5 次 GATE_BLOCKED 后它转为自己 dump 三遍
// 上游、从原始数据重推仓里已写下的口径，10 分钟预算超时，产物没回到用户手上。
describe('ls 放行后仍守住的边界', () => {
  const KNOWLEDGE = ['.md', '.schema.json', '.agents/', 'docs/', 'mappings/'];
  const root = mkdtempSync(path.join(tmpdir(), 'serve-ls-'));

  beforeAll(() => {
    mkdirSync(path.join(root, 'src/payroll/mappings'), { recursive: true });
    mkdirSync(path.join(root, 'tmp/attachments'), { recursive: true });
    mkdirSync(path.join(root, '.runtime'), { recursive: true });
    mkdirSync(path.join(root, '.browser-profile'), { recursive: true });
    writeFileSync(path.join(root, '.env'), 'SECRET=1');
    writeFileSync(path.join(root, 'auth.json'), '{}');
    writeFileSync(path.join(root, 'src/payroll/mappings/幻骥达-2026-05.json'), '{}');
    writeFileSync(path.join(root, 'src/payroll/contract.schema.json'), '{}');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const gate = () => createServeGate({ platformRoot: root, knowledgePaths: KNOWLEDGE , gateway: 'bin/example-gateway' });

  it('列目录不再被知识面拦：worker 能发现 mapping 与附件', () => {
    for (const p of ['src/payroll', 'src/payroll/mappings', 'tmp/attachments', 'src', 'docs', '.']) {
      expect(gate()({ name: 'ls', arguments: { path: p } })?.block, `ls ${p} 应放行`).toBeUndefined();
    }
    expect(gate()({ name: 'ls', arguments: {} })?.block).toBeUndefined();
  });

  it('read 仍限知识面：ls 放行不扩大读取面', () => {
    expect(gate()({ name: 'read', arguments: { file_path: 'src/payroll/mappings/幻骥达-2026-05.json' } })?.block).toBeUndefined();
    expect(gate()({ name: 'read', arguments: { file_path: 'src/payroll/contract.schema.json' } })?.block).toBeUndefined();
    expect(gate()({ name: 'read', arguments: { file_path: 'src/payroll/gateway.js' } })?.block).toBe(true);
  });

  it('ls 仍被敏感路径拦，且目录本身也算（.runtime 不能只靠知识面顺带挡）', () => {
    for (const p of ['.env', 'auth.json', '.runtime', '.runtime/', '.browser-profile']) {
      const v = gate()({ name: 'ls', arguments: { path: p } });
      expect(v?.block, `ls ${p} 应被拦`).toBe(true);
      expect(v?.reason).toContain('敏感路径');
    }
  });

  it('ls 仍被 workspace 边界拦', () => {
    expect(gate()({ name: 'ls', arguments: { path: '../outside' } })?.block).toBe(true);
    expect(gate()({ name: 'ls', arguments: { path: '/etc' } })?.block).toBe(true);
  });
});

// ── write：只准写 tmp/（2026-10-07）───────────────────────────────────────────
// 为什么给 write：worker 与 coding agent 的差别是"审计更多、权限更窄"，不是"更笨"。
// 此前只有 read/ls/bash 且 bash 禁重定向，它产出的中间产物（契约、mapping、为某张表临时
// 写的抽取脚本）只能塞进回复文本让宿主持盘——那等于逼宿主为每种产物写一条 protocol。
// 边界：只准 <platformRoot>/tmp/、禁敏感路径、有体积上限；执行层与配置仍不可写。
describe('createServeGate 的 write 分支', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'serve-write-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('tmp/ 下放行并留审计痕', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ platformRoot: root, onEvent: (e) => events.push(e) , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'write', arguments: { path: 'tmp/contract.json', content: '{"a":1}' } })?.block).toBeUndefined();
    expect(events.at(-1)?.detail).toBe('tmp/contract.json');
    expect(events.at(-1)?.allowed).toBe(true);
  });

  it('tmp/ 多级子目录同样放行', () => {
    const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'write', arguments: { path: 'tmp/202608/pay.json', content: '{}' } })?.block).toBeUndefined();
  });

  it('越出 tmp/ 一律拒：src/.env/配置/工作区根', () => {
    const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });
    for (const p of ['src/payroll/scripts/x.py', '.env', 'config/agent.yaml', 'package.json', 'todo.txt', 'tmp', 'tmpx/x']) {
      expect(gate({ name: 'write', arguments: { path: p, content: 'x' } })?.block, p).toBe(true);
    }
  });

  it('路径穿越与工作区外一律拒', () => {
    const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });
    for (const p of ['../etc/passwd', 'tmp/../../escape.txt', '/etc/passwd', 'tmp/../.env']) {
      expect(gate({ name: 'write', arguments: { path: p, content: 'x' } })?.block, p).toBe(true);
    }
  });

  it('敏感路径即使在 tmp/ 命名也拒', () => {
    const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'write', arguments: { path: 'tmp/auth.json', content: 'x' } })?.block).toBe(true);
  });

  it('体积上限', () => {
    const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'write', arguments: { path: 'tmp/ok.json', content: 'x'.repeat(1024) } })?.block).toBeUndefined();
    expect(gate({ name: 'write', arguments: { path: 'tmp/big.json', content: 'x'.repeat(257 * 1024) } })?.block).toBe(true);
  });

  it('缺 path 或没有 platformRoot 都拒（无根就无从判断在不在 tmp 下）', () => {
    const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'write', arguments: { content: 'x' } })?.block).toBe(true);
    expect(gate({ name: 'write', arguments: { path: 'tmp/a', content: '' } })?.block).toBeUndefined();
    const noRoot = createServeGate({ gateway: 'bin/example-gateway' });
    expect(noRoot({ name: 'write', arguments: { path: 'tmp/a', content: 'x' } })?.block).toBe(true);
  });
});

// ── scratchDir：每请求独立草稿目录(机械隔离,非约定)────────────────────────────
// 共享 tmp/ 下多个会话同时写 tmp/contract.json 会互相覆盖,而覆盖后的产物看不出被谁污染。
// 宿主已有随机源(requestId),由它派生子目录;worker 不必自己随机(它也没有随机手段)。
describe('write 的 scratchDir 隔离', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'serve-scratch-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const mine = 'tmp/req_abc123';

  it('本请求目录内放行(含多级子目录)', () => {
    const gate = createServeGate({ platformRoot: root, scratchDir: mine , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'write', arguments: { path: 'tmp/req_abc123/c.json', content: '{}' } })?.block).toBeUndefined();
    expect(gate({ name: 'write', arguments: { path: 'tmp/req_abc123/sub/x.py', content: 'print()' } })?.block).toBeUndefined();
  });

  it('别人的请求目录拒(前缀相似也不算)', () => {
    const gate = createServeGate({ platformRoot: root, scratchDir: mine , gateway: 'bin/example-gateway' });
    for (const p of ['tmp/req_abc124/c.json', 'tmp/req_abc1234/c.json', 'tmp/other/c.json', 'tmp/c.json']) {
      expect(gate({ name: 'write', arguments: { path: p, content: '{}' } })?.block, p).toBe(true);
    }
  });

  it('没配 scratchDir 时退回"只允许 tmp/ 下"(向后兼容)', () => {
    const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'write', arguments: { path: 'tmp/anything/c.json', content: '{}' } })?.block).toBeUndefined();
    expect(gate({ name: 'write', arguments: { path: 'src/x.py', content: 'x' } })?.block).toBe(true);
  });
});

// ── edit 与 write 同一组边界（2026-10-08）───────────────────────────────────
// 洞的来历：SDK edit 的入参键是 `path`，与 read/ls 相同。不给它单开分支，它就落进
// read/ls 那个 else——那里只有知识面与敏感路径检查，**没有任何写入约束**。已实证：
//     write src/payroll/contract.js  → 拦
//     edit  src/payroll/contract.js  → 放   ← 洞
// 而 edit 是精确文本替换，改一行就能动执行层、配置、乃至这个门自己的源码
// （serve-gate.ts 本身不在 tmp/ 下），比整份 write 更隐蔽。
// 修法：判据抽成 decideFileWrite 一份，write/edit 两条分支都调它——两份逐字相同的
// 判据必然分叉（补边界只补一处，另一侧静默腐烂）。下面第 9 条正是钉住"同一份"。
describe('edit 与 write 同一组边界', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'serve-edit-'));
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const LEGAL = [{ oldText: 'a = 1', newText: 'a = 2' }];

  it('① tmp/ 下合法 edits 放行', () => {
    const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'edit', arguments: { path: 'tmp/req_x/a.py', edits: LEGAL } })?.block).toBeUndefined();
  });

  it('② 回归锁：edit 不能改 src/ 下的实现（那个洞）', () => {
    const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });
    const v = gate({ name: 'edit', arguments: { path: 'src/payroll/contract.js', edits: LEGAL } });
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain('tmp/');
  });

  it('③ 敏感路径拒，理由点名敏感路径', () => {
    const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });
    const v = gate({ name: 'edit', arguments: { path: '.env', edits: LEGAL } });
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain('敏感路径');
  });

  it('④ 工作区外穿越拒', () => {
    const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'edit', arguments: { path: '../outside.py', edits: LEGAL } })?.block).toBe(true);
    expect(gate({ name: 'edit', arguments: { path: '/etc/passwd', edits: LEGAL } })?.block).toBe(true);
  });

  it('⑤ scratchDir 隔离：别人的请求目录拒', () => {
    const gate = createServeGate({ platformRoot: root, scratchDir: 'tmp/req_mine' , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'edit', arguments: { path: 'tmp/req_mine/a.py', edits: LEGAL } })?.block).toBeUndefined();
    for (const p of ['tmp/req_other/a.py', 'tmp/req_minex/a.py', 'tmp/a.py']) {
      expect(gate({ name: 'edit', arguments: { path: p, edits: LEGAL } })?.block, p).toBe(true);
    }
  });

  // ── local 执行根收紧：必须"有条件也拒"，不能只在无计划时被顺带拦下 ───────────────
  // 病根：isLocalScratchRun 为假时，命令形状仍是合法网关调用，会一路落到通用分支——那儿
  // 只问"是不是网关 + 有没有计划"。于是 planActive=true 时别人的 req_ 目录、tmp/ 散脚本、
  // ../ 穿越**全部放行**。2026-10-09 验收实证：只在无计划时被拒是假象，有条件拒绝等于没拒绝。
  describe('bash local 的目标根（2026-10-18 起：编排层全放行，越界由执行层网关原生拒）', () => {
    // GATE_REFUSE 实测（2026-10-18）：`bin/example-gateway local` 只放行平台 tmp/ 与 .agents/skills-serve/
    // 下的脚本，其余一律原生拒——执行层自治，编排层不再重复执法（首词拦截/LOCAL_OUTSIDE 退役）。
    const MINE = 'tmp/req_mine', OTHER = 'tmp/req_other';
    const gate = () => createServeGate({ platformRoot: '/p', scratchDir: MINE, planActive: () => true , gateway: 'bin/example-gateway' });
    const local = (target: string) => gate()({ name: 'bash', arguments: { command: `bin/example-gateway local ${target}` } });

    it('自己的 scratchDir（含子路径）放行', () => {
      expect(local(`${MINE}/x.py`)?.block).toBeUndefined();
      expect(local(`${MINE}/sub/dir/x.py`)?.block).toBeUndefined();
    });

    it('辅助技能面放行', () => {
      expect(local('.agents/skills-serve/doc-parse/ocr.py')?.block).toBeUndefined();
    });

    it('别人的请求目录：编排层放行（执行层原生拒）', () => {
      expect(local(`${OTHER}/x.py`)?.block).toBeUndefined();
      expect(local(`${MINE}x/x.py`)?.block).toBeUndefined();
    });

    it('tmp/ 根散脚本与平台实现：编排层放行（执行层原生拒）', () => {
      expect(local('tmp/loose.py')?.block).toBeUndefined();
      expect(local('src/payroll/scripts/transform.py')?.block).toBeUndefined();
    });

    it('路径穿越：编排层放行（执行层原生拒）', () => {
      expect(local(`${OTHER}/../mine/x.py`)?.block).toBeUndefined();
      expect(local('../../etc/passwd')?.block).toBeUndefined();
    });
  });

  it('⑥ 体积上限：newText 累计超过 256KB 拒', () => {
    const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });
    const ok = [{ oldText: 'a', newText: 'x'.repeat(1024) }];
    expect(gate({ name: 'edit', arguments: { path: 'tmp/a.py', edits: ok } })?.block).toBeUndefined();
    const v = gate({ name: 'edit', arguments: { path: 'tmp/a.py', edits: [{ oldText: 'a', newText: 'x'.repeat(257 * 1024) }] } });
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain('256KB');
    // 多处替换累计，不是只取最大一处
    const many = [{ oldText: 'a', newText: 'x'.repeat(200 * 1024) }, { oldText: 'b', newText: 'y'.repeat(100 * 1024) }];
    expect(gate({ name: 'edit', arguments: { path: 'tmp/a.py', edits: many } })?.block).toBe(true);
  });

  it('⑦ 缺 path 拒', () => {
    const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'edit', arguments: { edits: LEGAL } })?.block).toBe(true);
    expect(gate({ name: 'edit', arguments: { path: '', edits: LEGAL } })?.block).toBe(true);
  });

  it('⑧ edits 缺失/空数组/元素形状不对都拒', () => {
    const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'edit', arguments: { path: 'tmp/a.py' } })?.block).toBe(true);
    expect(gate({ name: 'edit', arguments: { path: 'tmp/a.py', edits: [] } })?.block).toBe(true);
    expect(gate({ name: 'edit', arguments: { path: 'tmp/a.py', edits: 'a=1' } })?.block).toBe(true);
    // 形状不对：oldText/newText 缺失或非字符串 → 由体积判据拒（不为它单开错误路径）
    for (const edits of [
      [{ oldText: 'a' }],
      [{ newText: 'b' }],
      [{ oldText: 1, newText: 2 }],
      [null],
      ['a=1'],
    ]) {
      expect(gate({ name: 'edit', arguments: { path: 'tmp/a.py', edits } })?.block, JSON.stringify(edits)).toBe(true);
    }
  });

  it('⑨ 对照：同一个目标 write 与 edit 都拦（证明两边界真的是同一份）', () => {
    const gate = createServeGate({ platformRoot: root , gateway: 'bin/example-gateway' });
    for (const p of ['src/payroll/contract.js', '.env', 'package.json', '../escape.py', 'operations.json']) {
      const w = gate({ name: 'write', arguments: { path: p, content: 'x' } });
      const e = gate({ name: 'edit', arguments: { path: p, edits: LEGAL } });
      expect(w?.block, `write ${p}`).toBe(true);
      expect(e?.block, `edit ${p}`).toBe(true);
    }
    // 反向对照：合法落点两者都放
    expect(gate({ name: 'write', arguments: { path: 'tmp/a.py', content: 'x' } })?.block).toBeUndefined();
    expect(gate({ name: 'edit', arguments: { path: 'tmp/a.py', edits: LEGAL } })?.block).toBeUndefined();
  });

  it('edit 放行同样留审计痕（detail = 目标路径），被拦不留', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ platformRoot: root, onEvent: (e) => events.push(e) , gateway: 'bin/example-gateway' });
    gate({ name: 'edit', arguments: { path: 'tmp/a.py', edits: LEGAL } });
    gate({ name: 'edit', arguments: { path: 'src/x.js', edits: LEGAL } });
    // detail 只在放行时设为路径，与 write 一致：被拦的调用没有落点痕迹可留
    expect(events.map((e) => [e.tool, e.allowed, e.detail])).toEqual([
      ['edit', true, 'tmp/a.py'],
      ['edit', false, ''],
    ]);
  });
});

// ── local 执行：本地脚本（2026-10-07，2026-10-08 增技能面）──────────────────
// serve worker 读不了二进制附件（read 只放行文本知识面），平台也没有"任意格式 → 文本"的
// 能力。用户裁决：让它自己写解析代码，不引沙箱（风险记 D-083）。它已有 write 且被钉在
// tmp/<requestId>/，缺的只是"能跑"；2026-10-08 又开了第二条：辅助技能面的脚本原地跑
// （抄到 tmp/ 会丢它旁边的配置，只能原地跑）。这里放行 local 子命令、且免计划前置（纯本地
// 计算，不触平台会话）；真正的边界在平台侧——网关只放行本地根目录下、且满足完整判据的
// 脚本，并剥掉凭据类 env。宿主只判"是本地执行"，不持平台路径名单。
describe('local 执行（bin/example-gateway local <本地脚本>）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'serve-local-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('计划未激活时也放行 tmp/ 下的脚本', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ platformRoot: root, planActive: () => false, onEvent: (e) => events.push(e) , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway local tmp/req_1/p.py --x /tmp/a.xlsx' } })?.block).toBeUndefined();
    expect(events.at(-1)?.detail).toContain('local tmp/req_1/p.py');
  });

  it('非工作区路径软放行（执行层网关原生拒，GATE_REFUSE 实测）', () => {
    const gate = createServeGate({ platformRoot: root, planActive: () => false , gateway: 'bin/example-gateway' });
    for (const c of ['bin/example-gateway local src/payroll/scripts/x.py', 'bin/example-gateway local ../escape.py', 'bin/example-gateway local /etc/x.py']) {
      expect(gate({ name: 'bash', arguments: { command: c } })?.block, c).toBeUndefined();
    }
    // 裸 local（无目标）也是网关形态 → 放行，执行层原生处理
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway local' } })?.block).toBeUndefined();
  });

  it('shell 元字符软放行(2026-10-18)，绝对路径解析在工作区内也放行(⑨回执一致性)', () => {
    const gate = createServeGate({ platformRoot: root, planActive: () => false , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway local tmp/a.py; rm -rf /' } })?.block).toBeUndefined();
    // write 回执是绝对路径：解析后落在工作区内 → 放行（此前一刀切拒，worker 吸收脚本被误伤）
    expect(gate({ name: 'bash', arguments: { command: `bin/example-gateway local ${path.join(root, 'tmp', 'a.py')}` } })?.block).toBeUndefined();
  });

  it('首 token 不是网关 → 普通命令放行（审计留痕）', () => {
    const gate = createServeGate({ platformRoot: root, planActive: () => false , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'bash', arguments: { command: 'python3 tmp/a.py' } })?.block).toBeUndefined();
  });

  // ── 辅助技能面脚本（2026-10-08）────────────────────────────────────────────
  // 平台把"原地跑辅助面技能脚本"开成 local 的第二类目标：抄到 tmp/ 会丢脚本旁边的配置
  // （它从自己真身旁边的配置文件读凭据），只能原地跑。宿主这里只判"是本地执行"，
  // 哪个技能真能跑由平台裁决（软链即选择性暴露）——所以下面这条只证明宿主不拦。
  it('辅助技能面下的脚本判为本地执行（计划未激活也放行）', () => {
    const gate = createServeGate({ platformRoot: root, planActive: () => false , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway local .agents/skills-serve/doc-parse/scripts/parse.py --x /tmp/a.pdf' } })?.block).toBeUndefined();
    // 技能面根本身与嵌套子目录都算本地执行
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway local .agents/skills-serve/doc-parse/scripts/sub/x.py' } })?.block).toBeUndefined();
  });

  it('建造本尊路径软放行（暴露控制归执行层：非 skills-serve 脚本由网关原生拒）', () => {
    const gate = createServeGate({ platformRoot: root, planActive: () => false , gateway: 'bin/example-gateway' });
    for (const c of [
      'bin/example-gateway local .agents/skills/doc-parse/scripts/parse.py',
      'bin/example-gateway local .agents/skills-servex/doc-parse/scripts/parse.py', // 前缀相似不算
      'bin/example-gateway local .agents/skillsserve/doc-parse/scripts/parse.py',
    ]) {
      expect(gate({ name: 'bash', arguments: { command: c } })?.block, c).toBeUndefined();
    }
  });

  // 职责分界的正面证据：技能面根目录下、但不在可执行子目录里的路径，宿主**不拦**（它只做
  // 前缀判断），拒绝发生在平台侧——那里才认"软链 + scripts/"这条完整判据。宿主若在这里
  // 补一份平台路径名单，就变成了镜像即分叉的第二份真相。
  it('技能面根下的非脚本路径宿主不拦（拒绝在平台侧）', () => {
    const gate = createServeGate({ platformRoot: root, planActive: () => false , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway local .agents/skills-serve/doc-parse/parse.py' } })?.block).toBeUndefined();
  });

  it('辅助技能面与越界 local 均编排层放行（越界由执行层网关原生拒，GATE_REFUSE 实测）', () => {
    const gate = createServeGate({ platformRoot: root, planActive: () => false , gateway: 'bin/example-gateway' });
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway local .agents/skills-serve/doc-parse/scripts/parse.py; cat .env' } })?.block).toBeUndefined();
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway local ../escape.py' } })?.block).toBeUndefined();
    expect(gate({ name: 'bash', arguments: { command: 'bin/example-gateway local /etc/passwd' } })?.block).toBeUndefined();
  });
});
