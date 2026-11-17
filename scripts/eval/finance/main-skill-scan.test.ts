/**
 * S3 · Main Skill 静态扫描（fail-closed）。
 *
 * 约束（v5 §1 / 任务口径）：Main Skill 只讲业务口径，**不得**出现平台专属标识——
 * 工具名、参数名、API、命令、平台 SOP。业务术语（`amount` / `customer` / `period` /
 * `dueOn` / 未结清 / 逾期）**明确不禁**。
 *
 * 词表来源（不手抄一份会漂移的平台词表）：
 *   · 运行现有 dummy 的能力声明 `operation list --json`，取 operation 名（含域名/命令名
 *     与点号分段）、flag 名（去 `--`）与 positional 名；
 *   · 再加一小组平台面固有标识（网关/二进制路径/服务模式/宿主 Main 工具名）——这些词
 *     即使当前 dummy 声明里没有，也仍属于平台专属词汇。
 *
 * fail-closed：能力声明读不到、不是合法 JSON、没有 operations，或解析结果缺基础标识
 * （`dummy` / `query` / `collection`），一律让测试红——空词表不得静默通过。
 *
 * 另有两条反向绊线：
 *   · 正向控制：把词表拼成探针文本，每个标识都必须被扫描器抓到（扫描器不得空转）；
 *   · 反例控制：`amount customer period dueOn 未结清 逾期` 必须零命中（不误伤业务术语）。
 *
 * 最后一条守住「Oracle 真值只进 Oracle」：技能正文不得出现客户名、单据标识、数据集金额
 * 或真值表数字；这些值全部从 `./dataset` 与 `./truth` 机械推导，不在这里手写。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { CUSTOMERS, FINANCE_DATASET, INVOICES, RECEIPTS, WRITEOFFS } from './dataset';
import { computeTruth } from './truth';

/** 本文件位于 `scripts/eval/finance/`，上溯三级即仓库根。 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SKILL_PATH = path.join(REPO_ROOT, '.agents', 'skills', 'finance-business-basics', 'SKILL.md');
const DUMMY_BIN = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform', 'bin', 'dummy.cjs');

/**
 * 平台面固有标识：命令语法（gateway / bin / operation / flag / mode）、目录约定
 * （bin/、serve）、宿主 Main 工具名（read_skill / task_run）、查询过滤词（where）。
 * 只收标识，不收业务术语。
 */
const PLATFORM_SURFACE_TOKENS = [
  'gateway',
  'bin/',
  'operation',
  'flag',
  'mode',
  'serve',
  'schema',
  'where',
  'read_skill',
  'task_run',
] as const;

interface DummyOperation {
  readonly name?: string;
  readonly domain?: string;
  readonly command?: string;
  readonly args?: {
    readonly positional?: ReadonlyArray<{ readonly name?: string }>;
    readonly flags?: ReadonlyArray<{ readonly flag?: string }>;
  };
}

/** 从现有 dummy 的能力声明生成平台标识词表；任何读取/解析失败都向上抛（fail-closed）。 */
function readDeclaredSurfaceTokens(): string[] {
  let raw: string;
  try {
    raw = execFileSync(process.execPath, [DUMMY_BIN, 'operation', 'list', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
  } catch (error) {
    throw new Error(
      `无法读取能力声明（fail-closed，不允许空词表通过）：${path.relative(REPO_ROOT, DUMMY_BIN)} operation list --json 失败：${String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`能力声明不是合法 JSON（fail-closed）：${String(error)}`);
  }

  const operations = (parsed as { operations?: unknown }).operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error('能力声明没有 operations（fail-closed，不允许空词表通过）');
  }

  const tokens = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed === '') return;
    tokens.add(trimmed);
    // flag 以 `--` 开头：去掉前缀后同样命中（正文不会带 `--`，但 `--collection` 与
    // `collection` 是同一个平台标识）。
    const withoutDashes = trimmed.replace(/^-+/, '');
    if (withoutDashes !== '') tokens.add(withoutDashes);
    // operation 名形如 `dummy.query`：整名与各分段都算平台标识。
    if (trimmed.includes('.')) {
      for (const segment of trimmed.split('.')) {
        if (segment !== '') tokens.add(segment);
      }
    }
  };

  for (const operation of operations as DummyOperation[]) {
    add(operation.name);
    add(operation.domain);
    add(operation.command);
    for (const positional of operation.args?.positional ?? []) add(positional.name);
    for (const flag of operation.args?.flags ?? []) add(flag.flag);
  }

  return [...tokens].sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 单个标识的匹配式：纯字母数字标识加词边界，避免把 `count` 命中到 `account` 内部；
 * 含非字母数字的标识（如 `bin/`）按字面子串匹配。
 */
function tokenMatcher(token: string): RegExp {
  const escaped = escapeRegExp(token);
  return /^[A-Za-z0-9_]+$/.test(token)
    ? new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i')
    : new RegExp(escaped, 'i');
}

interface Finding {
  readonly token: string;
  readonly line: number;
  readonly text: string;
}

function scan(text: string, tokens: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (const token of tokens) {
    const matcher = tokenMatcher(token);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (matcher.test(line)) findings.push({ token, line: index + 1, text: line.trim() });
    }
  }
  return findings;
}

function readSkill(): string {
  return readFileSync(SKILL_PATH, 'utf8');
}

let platformTokens: string[] = [];

beforeAll(() => {
  platformTokens = [...new Set([...readDeclaredSurfaceTokens(), ...PLATFORM_SURFACE_TOKENS])].sort();
});

describe('Main Skill 文本（finance-business-basics）', () => {
  it('存在、frontmatter 完整、未超过读取上限', () => {
    const content = readSkill();
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toMatch(/^name: finance-business-basics$/m);
    expect(content).toMatch(/^description: .+$/m);
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(32 * 1024);
  });

  it('覆盖 v5 §1 的六个主题', () => {
    const content = readSkill();
    for (const heading of [
      '财务基本概念',
      '应收与收款的关系',
      '核销与未结清',
      '快照与逾期判断原则',
      '事实、推断与待确认',
      '差异分析与交付方法',
    ]) {
      expect(content).toContain(heading);
    }
  });
});

describe('平台专属标识扫描（fail-closed）', () => {
  it('词表覆盖基础标识（声明解析漂移不得静默弱化）', () => {
    expect(platformTokens).toEqual(expect.arrayContaining(['dummy', 'query', 'collection']));
  });

  it('技能正文不出现能力声明或平台面标识', () => {
    const findings = scan(readSkill(), platformTokens);
    const detail = findings.map((finding) => `第 ${finding.line} 行命中「${finding.token}」：${finding.text}`).join('\n');
    expect(findings, detail).toEqual([]);
  });

  it('反向绊线：每个平台标识出现在文本里都必须被抓到', () => {
    const probe = platformTokens.join('\n');
    const hits = new Set(scan(probe, platformTokens).map((finding) => finding.token));
    expect([...hits].sort()).toEqual([...platformTokens].sort());
  });

  it('反例：业务术语 amount/customer/period/dueOn/未结清/逾期 不触发', () => {
    const businessText = 'amount customer period dueOn 未结清 逾期';
    expect(scan(businessText, platformTokens)).toEqual([]);
  });
});

describe('不泄露测试数据与 Oracle 真值', () => {
  it('技能正文不含客户名、单据标识、数据集金额或真值表数字', () => {
    const content = readSkill();

    for (const customer of CUSTOMERS) {
      expect(content).not.toContain(customer);
    }
    expect(content).not.toMatch(/\b(?:INV|RCP)-[A-Z0-9-]+/);

    const truth = computeTruth(FINANCE_DATASET);
    const sensitiveAmounts = new Set<number>();
    for (const invoice of INVOICES) sensitiveAmounts.add(invoice.amount);
    for (const receipt of RECEIPTS) sensitiveAmounts.add(receipt.amount);
    for (const writeoff of WRITEOFFS) sensitiveAmounts.add(writeoff.amount);
    for (const row of [...truth.byCustomer, truth.total]) {
      for (const value of [row.receivable, row.writtenOff, row.outstanding, row.overdueAmount]) {
        sensitiveAmounts.add(value);
      }
    }

    // 只查 1000 以上的金额：正文里的章节序号/小数不构成测试数据泄露。
    const leaked = [...sensitiveAmounts]
      .filter((value) => value >= 1000)
      .filter((value) => new RegExp(`(?<!\\d)${value}(?!\\d)`).test(content))
      .sort((a, b) => a - b);
    expect(leaked).toEqual([]);
  });
});
