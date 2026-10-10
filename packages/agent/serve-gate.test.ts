import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { createServeGate, describeKeyArgs, describePlanCalls, extractGateScript, hasShellMetachars, isServeCliInvocation, serveMetadataCommand, workspaceRelPath, AUDIT_DETAIL_MAX_CHARS, KEY_ARG_MAX_CHARS, type ServeGateEvent, type ServeGateOptions } from './src/serve-gate';
import type { AccessSemantics, KeyArgStyles, OperationSemantics } from './src/operation-labels';

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
    expect(serveMetadataCommand('bin/17dz operation list')).toBe('operation list');
    expect(serveMetadataCommand('bin/17dz operation list --json')).toBe('operation list');
    expect(serveMetadataCommand('bin/17dz operation list payroll')).toBe('operation list');
    expect(serveMetadataCommand('bin/17dz plan --schema')).toBe('plan --schema');
    expect(serveMetadataCommand('bin/17dz plan schema')).toBe('plan --schema');
  });
  it('operation run / plan evaluate 等真执行与提方案不在白名单', () => {
    // 这两个一放，计划门等于拆了：run 是真执行（要计划要记账），evaluate 是提交方案
    expect(serveMetadataCommand('bin/17dz operation run payroll.transform x')).toBeNull();
    expect(serveMetadataCommand('bin/17dz operation run voucher.query-saved A 202609')).toBeNull();
    expect(serveMetadataCommand('bin/17dz plan evaluate --task-id t --stdin')).toBeNull();
    expect(serveMetadataCommand('bin/17dz plan current --task-id t')).toBeNull();
    expect(serveMetadataCommand('bin/17dz plan activate --stdin')).toBeNull();
    expect(serveMetadataCommand('bin/17dz query src/voucher/scripts/query-saved.js A 202609')).toBeNull();
    expect(serveMetadataCommand('bin/17dz prepare src/payroll/scripts/transform.py c.json out')).toBeNull();
    expect(serveMetadataCommand('bin/17dz')).toBeNull();
    expect(serveMetadataCommand('')).toBeNull();
  });
  it('首 token 必须是网关：普通命令里拼上元数据字样不得绕过计划前置', () => {
    // 否则 `echo operation list` 之类就能骗过豁免
    expect(serveMetadataCommand('echo operation list')).toBeNull();
    expect(serveMetadataCommand('cat operation list')).toBeNull();
    expect(serveMetadataCommand('env FOO=1 bin/17dz operation list')).toBeNull();
  });
});

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

  it('plan 拒绝消息教正确提交形式：单行原始命令，不要代码块/外层引号/多行', () => {
    const gate = createServeGate({ planActive: () => true });
    // 围栏版计划命令（真实平台实测的误导来源）与裸 evaluate 都拿到同一条教学消息
    for (const command of [
      '```json\nbin/17dz plan {"calls":[{"operation":"probe.query","args":[]}]}\n```',
      'bin/17dz plan evaluate --task-id forged --stdin',
    ]) {
      const reason = gate({ name: 'bash', arguments: { command } })?.reason ?? '';
      // 可行动的方向：唯一合法形式 + 三种常见错误包装
      expect(reason).toContain('单行');
      expect(reason).toContain('bin/17dz plan');
      expect(reason).toContain('不要');
      expect(reason).toContain('宿主');
      // 措辞纪律：不出现业务词（platform-leak-lint 同款预算），不出现平台脚本文件名
      for (const word of ['应收', '凭证', '科目', '账套', '期间', '目录']) expect(reason).not.toContain(word);
      expect(reason).not.toMatch(/[\w-]+\.js/);
    }
  });

  it('计划未激活时拒绝平台调用，宿主激活后允许网关调用', () => {
    const inactive = createServeGate({ planActive: () => false });
    expect(inactive({ name: 'bash', arguments: { command: 'bin/17dz query query-saved.js A 202609' } })?.reason).toContain('宿主激活');
    const active = createServeGate({ planActive: () => true });
    expect(active({ name: 'bash', arguments: { command: 'bin/17dz query query-saved.js A 202609' } })?.block).toBeUndefined();
  });

  it('E1：元数据查询在计划未激活时放行，且留审计痕', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => false, onEvent: (e) => events.push(e) });
    for (const cmd of ['bin/17dz operation list', 'bin/17dz operation list --json', 'bin/17dz plan --schema', 'bin/17dz plan schema']) {
      expect(gate({ name: 'bash', arguments: { command: cmd } })?.block, cmd).toBeUndefined();
    }
    // 留痕："宿主放行了什么"必须可复盘，否则能力面在审计里没有痕迹
    expect(events.map((e) => e.detail)).toEqual([
      'bin/17dz operation list', 'bin/17dz operation list --json', 'bin/17dz plan --schema', 'bin/17dz plan schema',
    ]);
    expect(events.every((e) => e.allowed)).toBe(true);
  });
  it('E1：非白名单网关子命令在计划未激活时仍被拦（白名单没被开成任意豁免）', () => {
    const gate = createServeGate({ planActive: () => false });
    for (const cmd of [
      'bin/17dz operation run payroll.transform x',
      'bin/17dz query src/voucher/scripts/query-saved.js A 202609',
      'bin/17dz prepare src/payroll/scripts/transform.py c.json out',
      'bin/17dz operation',
      'bin/17dz plan',
    ]) {
      expect(gate({ name: 'bash', arguments: { command: cmd } })?.block, cmd).toBe(true);
    }
  });
  it('E1：元数据查询仍拒 shell 元字符（豁免不放松注入防线）', () => {
    const gate = createServeGate({ planActive: () => false });
    const v = gate({ name: 'bash', arguments: { command: 'bin/17dz operation list; rm -rf /' } });
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain('shell 元字符');
  });
  it('E1：计划已激活后元数据查询照常放行（豁免不改变已激活时的行为）', () => {
    const gate = createServeGate({ planActive: () => true });
    expect(gate({ name: 'bash', arguments: { command: 'bin/17dz operation list' } })?.block).toBeUndefined();
  });
  it('bash 继续拒绝 shell 注入和非平台命令', () => {
    const gate = createServeGate({ planActive: () => true });
    for (const command of ['bin/17dz query x; cat .env', 'bin/17dz query $(cat .env)', 'DZ_SERVE=0 bin/17dz query x', 'node script.js']) {
      expect(gate({ name: 'bash', arguments: { command } })?.block).toBe(true);
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
      ['payroll.validate', { plan: false, confirm: false, mock: false }],
      ['validate', { plan: false, confirm: false, mock: false }],
      ['payroll.transform', { plan: false, confirm: false, mock: false }],
      ['transform', { plan: false, confirm: false, mock: false }],
      // 只读平台数据 / 写：受过计划门管辖 → 要计划
      ['finance.search-account-sets', { plan: true, confirm: false, mock: true }],
      ['search-account-sets', { plan: true, confirm: false, mock: true }],
      ['voucher.query-saved', { plan: true, confirm: false, mock: true }],
      ['query-saved', { plan: true, confirm: false, mock: true }],
      ['voucher.commit', { plan: true, confirm: true, mock: true }],
      ['commit', { plan: true, confirm: true, mock: true }],
      // 同名脚本登记在两个域、语义不同：域内解析的分界线
      ['voucher.validate', { plan: true, confirm: false, mock: true }],
    ]);
    const bash = (command: string) => ({ name: 'bash', arguments: { command } });

    it('plan:false 的 operation 在计划未激活时放行（不再自相矛盾）', () => {
      const gate = createServeGate({ planActive: () => false, operationSemantics: SEMANTICS });
      for (const cmd of [
        'bin/17dz operation run payroll.validate tmp/x.json',
        'bin/17dz operation run payroll.transform tmp/x.json tmp/out',
        'bin/17dz query src/payroll/scripts/validate-contract.js tmp/x.json',
        'bin/17dz prepare src/payroll/scripts/transform.py tmp/x.json tmp/out',
      ]) {
        expect(gate(bash(cmd))?.block, cmd).toBeUndefined();
      }
    });

    it('plan:true 的 operation 在计划未激活时照旧拒 SERVE_PLAN_NOT_ACTIVE', () => {
      const gate = createServeGate({ planActive: () => false, operationSemantics: SEMANTICS });
      for (const cmd of [
        'bin/17dz query src/finance/scripts/search-account-sets.js --query x',
        'bin/17dz query src/voucher/scripts/query-saved.js A 202609',
        'bin/17dz operation run finance.search-account-sets --query x',
        'bin/17dz commit src/voucher/scripts/fill.js c.json --save',
      ]) {
        const v = gate(bash(cmd));
        expect(v?.block, cmd).toBe(true);
        expect(v?.reason, cmd).toContain('宿主激活');
      }
    });

    it('同名脚本按域解析：payroll 域纯本地放行，voucher 域只读仍要计划', () => {
      // 平台侧同一份脚本名登记在两个域而语义不同（一个纯本地、一个只读平台数据）。
      // 跨域猜就会把"要计划"的判成"不要计划"——那是放松方向，绝不允许。
      const gate = createServeGate({ planActive: () => false, operationSemantics: SEMANTICS });
      expect(gate(bash('bin/17dz query src/payroll/scripts/validate-contract.js tmp/x.json'))?.block).toBeUndefined();
      expect(gate(bash('bin/17dz query src/voucher/scripts/validate-contract.js tmp/x.json'))?.block).toBe(true);
    });

    it('fail-closed：语义表缺失 / 空表 / operation 不在表里 → 照旧要求计划', () => {
      const inactive = createServeGate({ planActive: () => false });
      const empty = createServeGate({ planActive: () => false, operationSemantics: new Map() });
      const missing = createServeGate({
        planActive: () => false,
        // 表里只有只读域：payroll 的两个 operation 查不到
        operationSemantics: new Map<string, AccessSemantics>([
          ['voucher.query-saved', { plan: true, confirm: false, mock: true }],
          ['query-saved', { plan: true, confirm: false, mock: true }],
        ]),
      });
      for (const gate of [inactive, empty, missing]) {
        for (const cmd of [
          'bin/17dz query src/payroll/scripts/validate-contract.js tmp/x.json',
          'bin/17dz prepare src/payroll/scripts/transform.py tmp/x.json tmp/out',
          'bin/17dz operation run payroll.validate tmp/x.json',
          'bin/17dz query src/unknown/scripts/whatever.js x',
        ]) {
          expect(gate(bash(cmd))?.block, cmd).toBe(true);
        }
      }
    });

    it('已有激活计划时一切照旧（豁免不改变已激活时的行为）', () => {
      const gate = createServeGate({ planActive: () => true, operationSemantics: SEMANTICS });
      for (const cmd of [
        'bin/17dz query src/payroll/scripts/validate-contract.js tmp/x.json',
        'bin/17dz query src/finance/scripts/search-account-sets.js --query x',
        'bin/17dz query src/voucher/scripts/query-saved.js A 202609',
      ]) {
        expect(gate(bash(cmd))?.block, cmd).toBeUndefined();
      }
    });

    it('放行的 plan:false 调用仍受其余门约束：shell 元字符 / 非网关 / 敏感路径照拦', () => {
      const gate = createServeGate({ platformRoot: process.cwd(), planActive: () => false, operationSemantics: SEMANTICS });
      // 元字符排在计划分支之前：注入防线不因豁免放松
      expect(gate(bash('bin/17dz query src/payroll/scripts/validate-contract.js tmp/x.json; rm -rf /'))?.reason).toContain('shell 元字符');
      expect(gate(bash('bin/17dz query $(cat .env)'))?.block).toBe(true);
      // 非网关调用照拦
      expect(gate(bash('cat x'))?.reason).toContain('统一入口');
      // 敏感路径照拦（read 门与计划分支无关，但同一门内不得因豁免松动）
      expect(gate({ name: 'read', arguments: { file_path: '.env' } })?.block).toBe(true);
      // local 打到放行根之外仍被单独拦死（不落穿到本分支）
      expect(gate(bash('bin/17dz local src/payroll/scripts/transform.py'))?.block).toBe(true);
    });

    it('放行的 plan:false 调用照常留审计痕（宿主放行了什么必须可复盘）', () => {
      const events: ServeGateEvent[] = [];
      const gate = createServeGate({ planActive: () => false, operationSemantics: SEMANTICS, onEvent: (e) => events.push(e) });
      gate(bash('bin/17dz query src/payroll/scripts/validate-contract.js tmp/x.json'));
      expect(events.at(-1)).toMatchObject({ tool: 'bash', allowed: true });
      expect(events.at(-1)?.detail).toContain('validate-contract.js');
    });
  });

  it('read 按知识面裁决，ls 只受 workspace 边界与敏感路径约束', () => {
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
    expect(describeKeyArgs('bin/17dz commit fill.js c.json --batch --save', styles)).toEqual([]);
  });

  it('只摘规格内的 flag：名称类加书名号，编号/时间类原样，按命令出现顺序', () => {
    expect(describeKeyArgs('bin/17dz query query-saved.js 幻晟 202609', styles)).toEqual([]);
    expect(describeKeyArgs('bin/17dz query query-receivables.js --query 猫一杯 --period 202609', styles)).toEqual(['「猫一杯」', '202609']);
    expect(describeKeyArgs('bin/17dz query query-receivables.js --subject-code 1122 --query 猫一杯', styles)).toEqual(['1122', '「猫一杯」']);
    expect(describeKeyArgs('bin/17dz operation run finance.query-receivables --query 猫一杯 --customer 狗二', styles)).toEqual(['「猫一杯」', '「狗二」']);
  });

  it('等号写法同样认（--flag=值），样式照样从规格读', () => {
    expect(describeKeyArgs('bin/17dz query x.js --query=猫一杯 --period=202609', styles)).toEqual(['「猫一杯」', '202609']);
  });

  it('规格缺失 / 查不到这个 flag → 不进摘要（安全缺省，不回退硬编码名单）', () => {
    expect(describeKeyArgs('bin/17dz query query-receivables.js --query 猫一杯 --period 202609')).toEqual([]);
    expect(describeKeyArgs('bin/17dz query query-receivables.js --query 猫一杯 --period 202609', new Map())).toEqual([]);
    // 布尔开关（平台样式 none，不入表）与后随 flag 的取值都不进摘要
    expect(describeKeyArgs('bin/17dz query x.js --query --period 202609', styles)).toEqual(['202609']);
  });

  it('超长取值截断到 24 字符（进度帧不是长文）', () => {
    expect(describeKeyArgs(`bin/17dz query x.js --query ${'名'.repeat(40)}`, styles)).toEqual([`「${'名'.repeat(24)}」`]);
  });

  it('bash 前缀与空命令同样走同一套词法', () => {
    expect(describeKeyArgs('bash bin/17dz query x.js --query 甲', styles)).toEqual(['「甲」']);
    expect(describeKeyArgs('')).toEqual([]);
  });
});

describe('createServeGate（平台调用的人类可读投影）', () => {
  const labels = new Map([['query-saved', '查询已存档记录'], ['query-receivables', '读取应收余额']]);
  // 平台 args 规格（flag → 样式）：与 label 表一样由调用方注入，门只查表不持名单。
  const argStyles: KeyArgStyles = new Map([['--query', 'name'], ['--period', 'code']]);

  it('放行的平台调用挂上 label 与参数摘要（数据查表，无分支）', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => true, operationLabels: labels, operationArgStyles: argStyles, onEvent: (event) => events.push(event) });
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

  it('args 规格缺省/查不到 flag → 参数摘要为空数组（有 label 也不硬编码名单）', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ planActive: () => true, operationLabels: labels, onEvent: (event) => events.push(event) });
    expect(gate({ name: 'bash', arguments: { command: 'bin/17dz query query-receivables.js --query 猫一杯' } })?.block).toBeUndefined();
    expect(events.at(-1)?.label).toBe('读取应收余额');
    expect(events.at(-1)?.keyArgs).toEqual([]);
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

  const gate = () => createServeGate({ platformRoot: root, knowledgePaths: KNOWLEDGE });

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
    const gate = createServeGate({ platformRoot: root, onEvent: (e) => events.push(e) });
    expect(gate({ name: 'write', arguments: { path: 'tmp/contract.json', content: '{"a":1}' } })?.block).toBeUndefined();
    expect(events.at(-1)?.detail).toBe('tmp/contract.json');
    expect(events.at(-1)?.allowed).toBe(true);
  });

  it('tmp/ 多级子目录同样放行', () => {
    const gate = createServeGate({ platformRoot: root });
    expect(gate({ name: 'write', arguments: { path: 'tmp/202608/pay.json', content: '{}' } })?.block).toBeUndefined();
  });

  it('越出 tmp/ 一律拒：src/.env/配置/工作区根', () => {
    const gate = createServeGate({ platformRoot: root });
    for (const p of ['src/payroll/scripts/x.py', '.env', 'config/agent.yaml', 'package.json', 'todo.txt', 'tmp', 'tmpx/x']) {
      expect(gate({ name: 'write', arguments: { path: p, content: 'x' } })?.block, p).toBe(true);
    }
  });

  it('路径穿越与工作区外一律拒', () => {
    const gate = createServeGate({ platformRoot: root });
    for (const p of ['../etc/passwd', 'tmp/../../escape.txt', '/etc/passwd', 'tmp/../.env']) {
      expect(gate({ name: 'write', arguments: { path: p, content: 'x' } })?.block, p).toBe(true);
    }
  });

  it('敏感路径即使在 tmp/ 命名也拒', () => {
    const gate = createServeGate({ platformRoot: root });
    expect(gate({ name: 'write', arguments: { path: 'tmp/auth.json', content: 'x' } })?.block).toBe(true);
  });

  it('体积上限', () => {
    const gate = createServeGate({ platformRoot: root });
    expect(gate({ name: 'write', arguments: { path: 'tmp/ok.json', content: 'x'.repeat(1024) } })?.block).toBeUndefined();
    expect(gate({ name: 'write', arguments: { path: 'tmp/big.json', content: 'x'.repeat(257 * 1024) } })?.block).toBe(true);
  });

  it('缺 path 或没有 platformRoot 都拒（无根就无从判断在不在 tmp 下）', () => {
    const gate = createServeGate({ platformRoot: root });
    expect(gate({ name: 'write', arguments: { content: 'x' } })?.block).toBe(true);
    expect(gate({ name: 'write', arguments: { path: 'tmp/a', content: '' } })?.block).toBeUndefined();
    const noRoot = createServeGate({});
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
    const gate = createServeGate({ platformRoot: root, scratchDir: mine });
    expect(gate({ name: 'write', arguments: { path: 'tmp/req_abc123/c.json', content: '{}' } })?.block).toBeUndefined();
    expect(gate({ name: 'write', arguments: { path: 'tmp/req_abc123/sub/x.py', content: 'print()' } })?.block).toBeUndefined();
  });

  it('别人的请求目录拒(前缀相似也不算)', () => {
    const gate = createServeGate({ platformRoot: root, scratchDir: mine });
    for (const p of ['tmp/req_abc124/c.json', 'tmp/req_abc1234/c.json', 'tmp/other/c.json', 'tmp/c.json']) {
      expect(gate({ name: 'write', arguments: { path: p, content: '{}' } })?.block, p).toBe(true);
    }
  });

  it('没配 scratchDir 时退回"只允许 tmp/ 下"(向后兼容)', () => {
    const gate = createServeGate({ platformRoot: root });
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
    const gate = createServeGate({ platformRoot: root });
    expect(gate({ name: 'edit', arguments: { path: 'tmp/req_x/a.py', edits: LEGAL } })?.block).toBeUndefined();
  });

  it('② 回归锁：edit 不能改 src/ 下的实现（那个洞）', () => {
    const gate = createServeGate({ platformRoot: root });
    const v = gate({ name: 'edit', arguments: { path: 'src/payroll/contract.js', edits: LEGAL } });
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain('tmp/');
  });

  it('③ 敏感路径拒，理由点名敏感路径', () => {
    const gate = createServeGate({ platformRoot: root });
    const v = gate({ name: 'edit', arguments: { path: '.env', edits: LEGAL } });
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain('敏感路径');
  });

  it('④ 工作区外穿越拒', () => {
    const gate = createServeGate({ platformRoot: root });
    expect(gate({ name: 'edit', arguments: { path: '../outside.py', edits: LEGAL } })?.block).toBe(true);
    expect(gate({ name: 'edit', arguments: { path: '/etc/passwd', edits: LEGAL } })?.block).toBe(true);
  });

  it('⑤ scratchDir 隔离：别人的请求目录拒', () => {
    const gate = createServeGate({ platformRoot: root, scratchDir: 'tmp/req_mine' });
    expect(gate({ name: 'edit', arguments: { path: 'tmp/req_mine/a.py', edits: LEGAL } })?.block).toBeUndefined();
    for (const p of ['tmp/req_other/a.py', 'tmp/req_minex/a.py', 'tmp/a.py']) {
      expect(gate({ name: 'edit', arguments: { path: p, edits: LEGAL } })?.block, p).toBe(true);
    }
  });

  // ── local 执行根收紧：必须"有条件也拒"，不能只在无计划时被顺带拦下 ───────────────
  // 病根：isLocalScratchRun 为假时，命令形状仍是合法网关调用，会一路落到通用分支——那儿
  // 只问"是不是网关 + 有没有计划"。于是 planActive=true 时别人的 req_ 目录、tmp/ 散脚本、
  // ../ 穿越**全部放行**。2026-10-09 验收实证：只在无计划时被拒是假象，有条件拒绝等于没拒绝。
  describe('bash local 的目标根（planActive=true 下也要拒）', () => {
    const MINE = 'tmp/req_mine', OTHER = 'tmp/req_other';
    const gate = () => createServeGate({ platformRoot: '/p', scratchDir: MINE, planActive: () => true });
    const local = (target: string) => gate()({ name: 'bash', arguments: { command: `bin/17dz local ${target}` } });

    it('自己的 scratchDir（含子路径）放行', () => {
      expect(local(`${MINE}/x.py`)?.block).toBeUndefined();
      expect(local(`${MINE}/sub/dir/x.py`)?.block).toBeUndefined();
    });

    it('辅助技能面放行', () => {
      expect(local('.agents/skills-serve/doc-parse/ocr.py')?.block).toBeUndefined();
    });

    it('别人的请求目录拒', () => {
      expect(local(`${OTHER}/x.py`)?.block).toBe(true);
      expect(local(`${MINE}x/x.py`)?.block).toBe(true);
    });

    it('tmp/ 根散脚本与平台实现拒', () => {
      expect(local('tmp/loose.py')?.block).toBe(true);
      expect(local('src/payroll/scripts/transform.py')?.block).toBe(true);
    });

    it('路径穿越拒', () => {
      expect(local(`${OTHER}/../mine/x.py`)?.block).toBe(true);
      expect(local('../../etc/passwd')?.block).toBe(true);
    });

    it('拒绝理由不含平台实现形状（形态的唯一真相在技能文档）', () => {
      const v = local(`${OTHER}/x.py`);
      expect(v?.reason, v?.reason).not.toMatch(/17dz/);
    });
  });

  it('⑥ 体积上限：newText 累计超过 256KB 拒', () => {
    const gate = createServeGate({ platformRoot: root });
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
    const gate = createServeGate({ platformRoot: root });
    expect(gate({ name: 'edit', arguments: { edits: LEGAL } })?.block).toBe(true);
    expect(gate({ name: 'edit', arguments: { path: '', edits: LEGAL } })?.block).toBe(true);
  });

  it('⑧ edits 缺失/空数组/元素形状不对都拒', () => {
    const gate = createServeGate({ platformRoot: root });
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
    const gate = createServeGate({ platformRoot: root });
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
    const gate = createServeGate({ platformRoot: root, onEvent: (e) => events.push(e) });
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
describe('local 执行（bin/17dz local <本地脚本>）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'serve-local-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('计划未激活时也放行 tmp/ 下的脚本', () => {
    const events: ServeGateEvent[] = [];
    const gate = createServeGate({ platformRoot: root, planActive: () => false, onEvent: (e) => events.push(e) });
    expect(gate({ name: 'bash', arguments: { command: 'bin/17dz local tmp/req_1/p.py --x /tmp/a.xlsx' } })?.block).toBeUndefined();
    expect(events.at(-1)?.detail).toContain('local tmp/req_1/p.py');
  });

  it('非 tmp/ 路径不放行(交由通用分支按需拒绝)', () => {
    const gate = createServeGate({ platformRoot: root, planActive: () => false });
    for (const c of ['bin/17dz local src/payroll/scripts/x.py', 'bin/17dz local ../escape.py', 'bin/17dz local /etc/x.py', 'bin/17dz local']) {
      expect(gate({ name: 'bash', arguments: { command: c } })?.block, c).toBe(true);
    }
  });

  it('shell 元字符仍拒(参数是路径/flag,不该有拼接替换)', () => {
    const gate = createServeGate({ platformRoot: root, planActive: () => false });
    expect(gate({ name: 'bash', arguments: { command: 'bin/17dz local tmp/a.py; rm -rf /' } })?.block).toBe(true);
  });

  it('首 token 不是网关时不当 local 执行', () => {
    const gate = createServeGate({ platformRoot: root, planActive: () => false });
    expect(gate({ name: 'bash', arguments: { command: 'python3 tmp/a.py' } })?.block).toBe(true);
  });

  // ── 辅助技能面脚本（2026-10-08）────────────────────────────────────────────
  // 平台把"原地跑辅助面技能脚本"开成 local 的第二类目标：抄到 tmp/ 会丢脚本旁边的配置
  // （它从自己真身旁边的配置文件读凭据），只能原地跑。宿主这里只判"是本地执行"，
  // 哪个技能真能跑由平台裁决（软链即选择性暴露）——所以下面这条只证明宿主不拦。
  it('辅助技能面下的脚本判为本地执行（计划未激活也放行）', () => {
    const gate = createServeGate({ platformRoot: root, planActive: () => false });
    expect(gate({ name: 'bash', arguments: { command: 'bin/17dz local .agents/skills-serve/doc-parse/scripts/parse.py --x /tmp/a.pdf' } })?.block).toBeUndefined();
    // 技能面根本身与嵌套子目录都算本地执行
    expect(gate({ name: 'bash', arguments: { command: 'bin/17dz local .agents/skills-serve/doc-parse/scripts/sub/x.py' } })?.block).toBeUndefined();
  });

  it('建造本尊路径（未暴露给 serve 的能力库）不当本地执行', () => {
    const gate = createServeGate({ platformRoot: root, planActive: () => false });
    for (const c of [
      'bin/17dz local .agents/skills/doc-parse/scripts/parse.py',
      'bin/17dz local .agents/skills-servex/doc-parse/scripts/parse.py', // 前缀相似不算
      'bin/17dz local .agents/skillsserve/doc-parse/scripts/parse.py',
    ]) {
      expect(gate({ name: 'bash', arguments: { command: c } })?.block, c).toBe(true);
    }
  });

  // 职责分界的正面证据：技能面根目录下、但不在可执行子目录里的路径，宿主**不拦**（它只做
  // 前缀判断），拒绝发生在平台侧——那里才认"软链 + scripts/"这条完整判据。宿主若在这里
  // 补一份平台路径名单，就变成了镜像即分叉的第二份真相。
  it('技能面根下的非脚本路径宿主不拦（拒绝在平台侧）', () => {
    const gate = createServeGate({ platformRoot: root, planActive: () => false });
    expect(gate({ name: 'bash', arguments: { command: 'bin/17dz local .agents/skills-serve/doc-parse/parse.py' } })?.block).toBeUndefined();
  });

  it('辅助技能面的 local 调用仍拒 shell 元字符', () => {
    const gate = createServeGate({ platformRoot: root, planActive: () => false });
    expect(gate({ name: 'bash', arguments: { command: 'bin/17dz local .agents/skills-serve/doc-parse/scripts/parse.py; cat .env' } })?.block).toBe(true);
  });
});
