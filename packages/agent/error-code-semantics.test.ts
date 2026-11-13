/**
 * P4 泛化（E2E 自足化 W1）：码级语义按执行层声明派生——选择类澄清族 / 终局快路径族。
 *
 * 契约面：`operation list --json` 顶层 `errorSemantics`（与 accessSemantics 同一文档、
 * 同一派生 family）。宿主不再把码名单硬编码进编排层；声明缺席 → 宿主默认适配表
 * （既有实例现行为逐字节不变），声明在场 → 两族整体按声明（空 = 声明"无此族码"）。
 *
 * 本文件锁四件事（与 W1 反向绊线登记一一对应，破坏点见各 describe 注释）：
 *   ① 声明选择类码 → 澄清组装（含声明结构句与信封数据）；
 *   ② 声明终局码 → 快路径事实 + 话术（含自定义字段映射）；
 *   ③ 完整性门不放松：声明字段缺/空 → 不分类（故意破坏门 → 本组红）；
 *   ④ 未声明码不误判：形状齐全也不分类；声明在场即替换默认适配表。
 * 另锁：parse/load 的失败语义（缺席 → null 回退默认；在场空表 → 空表）、渲染绑定缺失
 * fail-loud（绝不静默 fallback）、默认适配表的码不传绑定仍可渲染（直接调用方兼容）。
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UNKNOWN_ERROR_CODE, clarificationTextFor, terminalFailureTextFor } from './src/error-codes';
import { loadErrorCodeSemantics, parseErrorCodeSemantics } from './src/operation-labels';
import {
  DEFAULT_ERROR_CODE_SEMANTICS,
  SELECTION_CLARIFICATION_CODES,
  TERMINAL_FAST_PATH_CODES,
  parseEnvelope,
  selectionClarificationFromResponses,
  selectionClarificationOf,
  terminalFastPathOf,
  type ErrorCodeSemantics,
} from './src/platform-contract';

/** 声明 JSON → 派生表（测的就是这条链；解析失败抛，测试夹具自身错误不静默）。 */
function declared(errorSemantics: unknown): ErrorCodeSemantics {
  const parsed = parseErrorCodeSemantics(JSON.stringify({ operations: [], errorSemantics }));
  if (!parsed) throw new Error('测试声明必须可解析（夹具自身错误）');
  return parsed;
}

/** RESULT 信封行（协议形状最小构造）。 */
function envelope(status: string, data: unknown, code: string): string {
  return `RESULT ${JSON.stringify({ v: 1, op: 'probe.query', status, data: data ?? null, error: { code, message: '…' } })}`;
}

/** 一条 tool_result 消息（原生形状的最小构造：role + content 分段）。 */
function toolResult(text: string): { role: string; content: Array<{ type: 'text'; text: string }> } {
  return { role: 'toolResult', content: [{ type: 'text', text }] };
}

/**
 * 合成执行层声明：两族各两码，终局两形状都覆盖，字段名故意**不**等于默认适配表的
 * 字段名（证明取值按声明而不是按宿主既有字段名猜）。
 */
const DECLARED = declared({
  selection: {
    X_AMBIGUOUS: { render: 'candidates' },
    X_NOT_FOUND: { render: 'confirm-name-with-hint' },
  },
  terminal: {
    X_NO_DATA: { render: 'scope-no-data', query: 'name', scope: 'window', available: 'availableWindows' },
    X_NAME_MISSING: { render: 'confirm-name', query: 'subject' },
  },
});

describe('parseErrorCodeSemantics：执行层声明 → 派生表（失败语义）', () => {
  it('完整声明 → 两族码表 + 结构句 + 字段映射（码与字段都是执行层数据）', () => {
    expect([...DECLARED.selection.entries()]).toEqual([
      ['X_AMBIGUOUS', 'candidates'],
      ['X_NOT_FOUND', 'confirm-name-with-hint'],
    ]);
    expect([...DECLARED.terminal.entries()]).toEqual([
      ['X_NO_DATA', { render: 'scope-no-data', query: 'name', scope: 'window', available: 'availableWindows' }],
      ['X_NAME_MISSING', { render: 'confirm-name', query: 'subject' }],
    ]);
  });

  it('未知结构句 / 缺必填字段名 → 该条目不进表（宁缺勿猜，不补默认字段）', () => {
    const parsed = declared({
      selection: {
        A: { render: 'not-a-host-sentence' },
        B: 'candidates', // 裸字符串不是声明形状
        C: { render: 'candidates' },
      },
      terminal: {
        D: { render: 'scope-no-data', query: 'query', scope: 'period' }, // 缺 available
        E: { render: 'scope-no-data', query: 'query', scope: 'period', available: '  ' }, // 空白字段名
        F: { render: 'confirm-name' }, // 缺 query
        G: { render: 'confirm-name', query: 'query' },
      },
    });
    expect([...parsed.selection.keys()]).toEqual(['C']);
    expect([...parsed.terminal.keys()]).toEqual(['G']);
  });

  it('整表缺席 / 顶层非法 → null（调用方回退宿主默认适配表）', () => {
    expect(parseErrorCodeSemantics('')).toBeNull();
    expect(parseErrorCodeSemantics('not json')).toBeNull();
    expect(parseErrorCodeSemantics('{}')).toBeNull();
    expect(parseErrorCodeSemantics('{"operations":[]}')).toBeNull();
    expect(parseErrorCodeSemantics('[]')).toBeNull();
    expect(parseErrorCodeSemantics(JSON.stringify({ errorSemantics: 42 }))).toBeNull();
    expect(parseErrorCodeSemantics(JSON.stringify({ errorSemantics: [] }))).toBeNull();
  });

  it('表在场但为空对象 → 空表 = 声明"两族均无码"（不回退默认，宁缺勿猜）', () => {
    const parsed = parseErrorCodeSemantics('{"operations":[],"errorSemantics":{}}');
    expect(parsed).not.toBeNull();
    expect(parsed!.selection.size).toBe(0);
    expect(parsed!.terminal.size).toBe(0);
  });

  it('兼容视图：两个集合常量派生自默认适配表（换执行层不再改常量本体的语义）', () => {
    expect([...SELECTION_CLARIFICATION_CODES].sort()).toEqual([...DEFAULT_ERROR_CODE_SEMANTICS.selection.keys()].sort());
    expect([...TERMINAL_FAST_PATH_CODES].sort()).toEqual([...DEFAULT_ERROR_CODE_SEMANTICS.terminal.keys()].sort());
  });
});

// ── loader（经公共 CLI 派生一次；与 operation-labels 同族失败语义）──────────────
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** 假平台根：bin/example-gateway 把预置 JSON 吐到 stdout（可指定退出码或挂住）。 */
async function fakePlatformRoot(json: string, options: { exitCode?: number; hang?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'error-semantics-'));
  roots.push(root);
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await writeFile(path.join(root, 'bin', 'list.json'), json);
  const script = options.hang
    ? '#!/bin/sh\nexec sleep 30\n'
    : `#!/bin/sh\ncat "$(dirname "$0")/list.json"\nexit ${options.exitCode ?? 0}\n`;
  await writeFile(path.join(root, 'bin', 'example-gateway'), script);
  await chmod(path.join(root, 'bin', 'example-gateway'), 0o755);
  return root;
}

const DECLARATION_JSON = JSON.stringify({
  operations: [],
  errorSemantics: {
    selection: { X_AMBIGUOUS: { render: 'candidates' } },
    terminal: { X_NO_DATA: { render: 'scope-no-data', query: 'name', scope: 'window', available: 'availableWindows' } },
  },
});

describe('loadErrorCodeSemantics（经公共 CLI 派生一次）', () => {
  it('platformRoot/gateway 缺省 → null（不 spawn，回退默认适配表由调用方决定）', async () => {
    expect(await loadErrorCodeSemantics()).toBeNull();
    expect(await loadErrorCodeSemantics('')).toBeNull();
    expect(await loadErrorCodeSemantics('/tmp/whatever')).toBeNull();
  });

  it('CLI 成功 → 与 parse 同表；退出非零 / 挂起 → null（派生是增强不是前提）', async () => {
    expect(await loadErrorCodeSemantics(await fakePlatformRoot(DECLARATION_JSON), 'bin/example-gateway'))
      .toEqual(parseErrorCodeSemantics(DECLARATION_JSON));
    expect(await loadErrorCodeSemantics(await fakePlatformRoot(DECLARATION_JSON, { exitCode: 3 }), 'bin/example-gateway')).toBeNull();
    expect(await loadErrorCodeSemantics(await fakePlatformRoot('', { hang: true }), 'bin/example-gateway')).toBeNull();
  });
});

// ── ① 声明选择类码 → 澄清组装 ─────────────────────────────────────────────────
// 反向绊线：把分类来源改回硬编码默认集合（无视 semantics 参数）→ 本组红。
describe('① 声明选择类码 → 澄清组装（结构句 + 信封数据）', () => {
  it('candidates 形状：候选清单句按声明渲染，候选名只取平台返回的', () => {
    const fact = selectionClarificationFromResponses([
      toolResult(envelope('needs_input', { query: '某词', candidates: [{ name: '甲' }, { name: '乙' }] }, 'X_AMBIGUOUS')),
    ], DECLARED);
    expect(fact).toEqual({ code: 'X_AMBIGUOUS', query: '某词', candidates: ['甲', '乙'], render: 'candidates' });
    expect(clarificationTextFor(fact!.code, fact!))
      .toBe('没有找到唯一匹配“某词”的对象。平台上有 2 个名字相近的：1. 甲 2. 乙。你要查哪个？告诉我名称或序号即可。');
  });

  it('confirm-name-with-hint 形状：信封 correctForm 作为 hint 数据渲染；没带则宿主兜底', () => {
    const withHint = selectionClarificationOf(parseEnvelope('RESULT {"v":1,"op":"probe.query","status":"not_found","data":{"query":"某词","candidates":[]},"error":{"code":"X_NOT_FOUND","message":"…","correctForm":"由执行层声明的改法"}}'), DECLARED);
    expect(withHint).toEqual({ code: 'X_NOT_FOUND', query: '某词', candidates: [], render: 'confirm-name-with-hint', correctForm: '由执行层声明的改法' });
    expect(clarificationTextFor(withHint!.code, withHint!)).toBe('没有找到匹配“某词”的对象。由执行层声明的改法我再查。');
    const withoutHint = selectionClarificationOf(parseEnvelope(envelope('not_found', { query: '某词', candidates: [] }, 'X_NOT_FOUND')), DECLARED);
    expect(clarificationTextFor(withoutHint!.code, withoutHint!)).toBe('没有找到匹配“某词”的对象。请确认准确名称后我再查。');
  });

  it('未声明的选择类码不误判：形状与声明码完全同形也走既有路径', () => {
    expect(selectionClarificationFromResponses([
      toolResult(envelope('needs_input', { query: '某词', candidates: [{ name: '甲' }] }, 'X_OTHER_AMBIGUOUS')),
    ], DECLARED)).toBeUndefined();
  });
});

// ── ② 声明终局码 → 快路径话术 ─────────────────────────────────────────────────
// 反向绊线：把分类来源改回硬编码默认集合 → 本组红。
describe('② 声明终局码 → 快路径事实 + 话术（字段按声明取值）', () => {
  it('scope-no-data 形状：自定义字段名（name/window/availableWindows）机械取值 + 结构句', () => {
    const fact = terminalFastPathOf(
      parseEnvelope(envelope('not_found', { name: '对象甲', window: 'W2', availableWindows: ['W1'] }, 'X_NO_DATA')),
      DECLARED,
    );
    expect(fact).toEqual({ code: 'X_NO_DATA', query: '对象甲', period: 'W2', availablePeriods: ['W1'], render: 'scope-no-data' });
    expect(terminalFailureTextFor(fact!.code, fact!))
      .toBe('没有查到“对象甲”在 W2 的数据。平台上有数据的是：W1。要改查的话，告诉我查哪一项即可。');
  });

  it('confirm-name 形状：对象名字段按声明取值（不是默认字段名），结构句无平台措辞', () => {
    const fact = terminalFastPathOf(
      parseEnvelope('RESULT {"v":1,"op":"probe.query","status":"not_found","data":{"subject":"某对象","query":"别的词"},"error":{"code":"X_NAME_MISSING","message":"…","correctForm":"给解析方的规则，不渲染"}}'),
      DECLARED,
    );
    expect(fact).toEqual({ code: 'X_NAME_MISSING', query: '某对象', render: 'confirm-name' });
    expect(terminalFailureTextFor(fact!.code, fact!)).toBe('没有找到匹配“某对象”的对象。请确认准确名称后我再查。');
  });

  it('声明终局码以整份答案到达驱动级替换后的集合里也照常（见 pi-coding-driver-fast-path 的注入用例）', () => {
    // 本用例只锁：声明表整体替换后，默认表与其不重叠（分类只看声明表，不看码名）。
    expect([...DECLARED.terminal.keys()].sort()).toEqual(['X_NAME_MISSING', 'X_NO_DATA']);
    expect(terminalFastPathOf(parseEnvelope(envelope('not_found', { query: 'q', period: '202609', availablePeriods: ['202606'] }, 'PERIOD_NO_DATA')), DECLARED))
      .toBeUndefined();
  });
});

// ── ③ 完整性门不放松（缺字段仍不快转）────────────────────────────────────────
// 反向绊线：拿掉 terminalFastPathOf 完整性门的任一条件（如空清单不挂那一项）→ 本组红。
describe('③ 完整性门不放松：声明字段缺/空 → 行为不变（不分类，走既有路径）', () => {
  it('scope-no-data：查询词 / 取数范围 / 非空清单三者缺一不挂', () => {
    const full = { name: '对象甲', window: 'W2', availableWindows: ['W1'] };
    expect(terminalFastPathOf(parseEnvelope(envelope('not_found', { window: 'W2', availableWindows: ['W1'] }, 'X_NO_DATA')), DECLARED)).toBeUndefined();
    expect(terminalFastPathOf(parseEnvelope(envelope('not_found', { name: '对象甲', availableWindows: ['W1'] }, 'X_NO_DATA')), DECLARED)).toBeUndefined();
    expect(terminalFastPathOf(parseEnvelope(envelope('not_found', { name: '对象甲', window: 'W2' }, 'X_NO_DATA')), DECLARED)).toBeUndefined();
    // 清单为空同样不挂：可改查清单是这句话的行动部分（清单里的空串也不算条目）
    expect(terminalFastPathOf(parseEnvelope(envelope('not_found', { ...full, availableWindows: [] }, 'X_NO_DATA')), DECLARED)).toBeUndefined();
    expect(terminalFastPathOf(parseEnvelope(envelope('not_found', { ...full, availableWindows: [''] }, 'X_NO_DATA')), DECLARED)).toBeUndefined();
    // 空白串 = 缺（trim 后空）；非字符串 = 缺
    expect(terminalFastPathOf(parseEnvelope(envelope('not_found', { ...full, name: '  ' }, 'X_NO_DATA')), DECLARED)).toBeUndefined();
    expect(terminalFastPathOf(parseEnvelope(envelope('not_found', { ...full, window: 42 }, 'X_NO_DATA')), DECLARED)).toBeUndefined();
  });

  it('confirm-name：对象名缺失/空白不挂；status=completed 的同码信封也不挂（码与 status 打架）', () => {
    expect(terminalFastPathOf(parseEnvelope(envelope('not_found', { query: '别的词' }, 'X_NAME_MISSING')), DECLARED)).toBeUndefined();
    expect(terminalFastPathOf(parseEnvelope('RESULT {"v":1,"op":"probe.query","status":"not_found","data":{"subject":"  "},"error":{"code":"X_NAME_MISSING","message":"…"}}'), DECLARED)).toBeUndefined();
    expect(terminalFastPathOf(parseEnvelope(envelope('completed', { subject: '某对象' }, 'X_NAME_MISSING')), DECLARED)).toBeUndefined();
  });

  it('选择类：查询词缺失不挂；status 不是选择类不挂（同一把完整性/状态尺）', () => {
    expect(selectionClarificationOf(parseEnvelope(envelope('needs_input', { candidates: [{ name: '甲' }] }, 'X_AMBIGUOUS')), DECLARED)).toBeUndefined();
    expect(selectionClarificationOf(parseEnvelope(envelope('failed', { query: '某词', candidates: [{ name: '甲' }] }, 'X_AMBIGUOUS')), DECLARED)).toBeUndefined();
  });

  it('渲染出口同样 fail-loud：绑定缺失且码不在默认适配表 → 抛 UNKNOWN_ERROR_CODE（绝不静默 fallback）', () => {
    expect(() => clarificationTextFor('X_AMBIGUOUS', { query: 'x', candidates: [] })).toThrow(UNKNOWN_ERROR_CODE);
    expect(() => terminalFailureTextFor('X_NO_DATA', { query: 'x', period: 'W2', availablePeriods: ['W1'] })).toThrow(UNKNOWN_ERROR_CODE);
    // 默认适配表的码不传绑定仍渲染（直接调用方兼容路径，兼容视图派生自同一张默认表）
    expect(clarificationTextFor('ACCOUNT_SET_AMBIGUOUS', { query: 'q', candidates: ['a'] })).toContain('你要查哪个');
    expect(terminalFailureTextFor('PERIOD_NO_DATA', { query: 'q', period: '202609', availablePeriods: ['202606'] })).toContain('202609');
  });
});

// ── ④ 声明在场即替换：未声明码一律不分类（宁缺勿猜）──────────────────────────
// 反向绊线：让提取器对表外码也分类（例如对未命中条目给默认形状）→ 本组红。
describe('④ 声明在场即替换：默认适配表的码也不分类；无声明（缺省）时默认表照旧', () => {
  it('声明表下：默认表的码不分类（哪怕信封形状与默认实例完全一致）', () => {
    expect(selectionClarificationFromResponses([
      toolResult(envelope('needs_input', { query: '幻辰', candidates: [{ name: '幻辰财税' }] }, 'ACCOUNT_SET_AMBIGUOUS')),
    ], DECLARED)).toBeUndefined();
    expect(terminalFastPathOf(parseEnvelope(envelope('not_found', { query: 'q', period: '202609', availablePeriods: ['202606'] }, 'PERIOD_NO_DATA')), DECLARED))
      .toBeUndefined();
    // 空声明表同理：任何码都不分类
    expect(terminalFastPathOf(parseEnvelope(envelope('not_found', { query: 'q', period: '202609', availablePeriods: ['202606'] }, 'PERIOD_NO_DATA')), declared({})))
      .toBeUndefined();
  });

  it('不传声明（宿主默认适配表）：既有实例码照旧分类（兼容基线，逐字段不变）', () => {
    const ambiguous = selectionClarificationFromResponses([
      toolResult(envelope('needs_input', { query: '幻辰', candidates: [{ name: '幻辰财税' }] }, 'ACCOUNT_SET_AMBIGUOUS')),
    ]);
    expect(ambiguous).toEqual({ code: 'ACCOUNT_SET_AMBIGUOUS', query: '幻辰', candidates: ['幻辰财税'], render: 'candidates' });
    const terminal = terminalFastPathOf(parseEnvelope(envelope('not_found', { query: 'q', period: '202609', availablePeriods: ['202606'] }, 'PERIOD_NO_DATA')));
    expect(terminal).toEqual({ code: 'PERIOD_NO_DATA', query: 'q', period: '202609', availablePeriods: ['202606'], render: 'scope-no-data' });
  });

  it('形状齐全但码不在任何表 → 两个提取器都 undefined（不猜族别）', () => {
    expect(selectionClarificationOf(parseEnvelope(envelope('needs_input', { query: '某词', candidates: [{ name: '甲' }] }, 'X_UNKNOWN')), DECLARED)).toBeUndefined();
    expect(terminalFastPathOf(parseEnvelope(envelope('not_found', { name: '对象甲', window: 'W2', availableWindows: ['W1'] }, 'X_UNKNOWN')), DECLARED)).toBeUndefined();
  });
});
