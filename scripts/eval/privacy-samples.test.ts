/**
 * 隐私样本守卫：金额判据面（`amount-criteria.ts` 判据 + `amount-criteria.test.ts` 表征锁）
 * 的样本串与注释里，**旧域报告片段与非夹具业务词零命中**。
 *
 * 为什么立这道守卫（2026-11-10 独立评审 8 + 仲裁 1）：上一轮把隐私样本里的公司名换成了
 * 夹具名（某客户名（已脱敏）→ contoso-trade），旧域报告片段（科目余额查询 / 应付账款 /
 * 编码 2202 / 该账套科目表）与非夹具业务词原样留下，注释仍写着"20 场历史真实 Y2 跑的全量
 * 复核里唯一的原句"——**换名不换内容等于没中性化**：读者仍然无法分辨这条用例在"考什么
 * 形态"还是在"抄哪次真实回复"，而那份真实回复带着旧域科目口径。中立化后的样本只允许
 * 两样东西：
 *   ① 夹具词表内的词（collection / window / record / item / rec-* / 记录号 / 数值，
 *      以及夹具刻意登记的缺失口径词 payable / bank / debt **及其中文形**——2026-11-10
 *      Y2 t2 修复把「应付余额」这类写法收进 MISSING_CALIBERS，作为同一缺失口径的别名；
 *      它因此是夹具口径词的写法，不是旧域报告片段）；
 *   ② 自造句式（状态码 SUBJECT_NOT_FOUND 与句式是**形态**，不是数据，保留）。
 *
 * 为什么用机械守卫而不是靠注释自律：注释会被下一次改动覆盖，禁词表不会。命中即红，且
 * 失败信息只报 `相对路径:行号` 与禁词编号、**不打印命中文本**——与
 * `packages/agent/exposure-lint.test.ts` 同一条纪律（否则测试日志把敏感串再抄一份）。
 *
 * 覆盖边界（写在这里，不留给读者猜）：
 *   · 只扫判据面这两个文件。`scripts/eval/expectations.test.ts` 持有逐字转录的语料原文
 *     （该文件头部记录了"不用合成 spec 自说自话"的裁定），不在本守卫范围。**客户名归
 *     exposure-lint 的 B 类，但 B 类只覆盖映射表 C 组登记过的名字**——本波回填的那个
 *     客户名（已脱敏）不在词表内，B 类拦不到它，不能把 B 类写成所有客户名的回归锁；
 *     它靠人工补扫发现（评审 9）。本守卫只收旧域**片段**，不收客户名。两张表口径不同，
 *     不合并——合并只会为了少几处命中把任一张拆短。
 *   · `凭证` 刻意**不在**禁词表：它是 `ACCOUNT_RESULT_PHRASING` 里有意的旧词映射
 *     （`凭证\s*\d` 分支，见 amount-criteria.ts 的中性域分支注释），其表征锁的标题就要
 *     点名它。收它进来会让判据的兼容分支与守卫互相打架。
 *   · 本守卫文件自身不是扫描目标（禁词字面就住在表里）。防假绿的不是自我豁免，而是下方
 *     的**范围自校验**（目标清单非空、逐个存在、逐个非空、数量与登记数一致——把扫描面
 *     砍空 / 砍窄都会红）与**合成红例**（把片段放进被扫描形状的内容，走与文件扫描同一条
 *     `scanContents` 路径——扫描器恒空会红，红例不是只构造 Hit）。合成红例的断言接收方
 *     只能是 `projectHits` 的投影（位置 + 禁词编号）：原始 Hit 只查键名——投影一旦漏词，
 *     Vitest 的 diff 就会把片段字面抄进日志，而那正是最需要不抄词的时候（评审 9）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** 扫描目标（判据 + 其表征锁）。改动这张表 = 改扫描面，范围自校验会盯住数量。 */
const SCAN_TARGETS: readonly string[] = [
  'scripts/eval/amount-criteria.ts',
  'scripts/eval/amount-criteria.test.ts',
];

/**
 * 旧域报告片段与非夹具业务词。收词纪律与 exposure-lint 同族：**只增不减**——发现新的
 * 旧域词往表里加，不从表里删；删一条等于给那一类 reopen 一个无人看守的门。
 *
 * 例外（2026-11-10 Y2 t2 修复，有据可查）：`应付余额` 从本表移出。它已是 dummy 夹具
 * 缺失口径 payable 的**中文别名**（`MISSING_CALIBERS` / `CALIBER_CANONICAL`），判据与
 * 表征锁必须原样保留该写法（真模型实测回复原文的标题与合计行都用它）；它不是旧域报告
 * 片段，看守它的职责归 amount-criteria 的口径词表（`MISSING_CALIBERS` 的增删有
 * amount-criteria.test.ts 的双语词表用例钉住）。旧域口径的其余片段（应付账款 / 科目余额 /
 * 账套…）仍在表，扫描面不变。
 */
const OLD_DOMAIN_FRAGMENTS: readonly string[] = [
  '科目余额',
  '应付账款',
  '账套',
  '科目表',
  '应收',
  '预付',
  '应交税',
  '总账',
  '明细账',
  '损益',
];

interface Hit {
  rel: string;
  line: number;
  /**
   * 禁词编号（OLD_DOMAIN_FRAGMENTS 的下标，从 1 起）。**刻意不存命中文本**：
   * 失败信息与 Vitest 的 toEqual diff 都会打印接收对象——把 fragment 原串放在 Hit 里，
   * 等于把旧域片段再抄一份进 CI 日志（2026-11-10 独立评审 medium）。断言只看投影
   * （编号 + 位置），命中词本身只存在于本文件内的禁词表。
   */
  fragment: number;
}

/** 读一个被扫描文件；读不到就抛——守卫不做"扫了个空集合"式的假绿。 */
function readTarget(rel: string): string {
  try {
    return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  } catch (error) {
    throw new Error(
      `隐私样本守卫读不到被扫描文件 ${rel}（${String(error)}）。` +
        '目标消失即红，不静默放过——修文件位置或更新 SCAN_TARGETS，不要把扫描面砍空。',
    );
  }
}

/**
 * 扫描一份（相对路径, 内容）集合——纯函数。文件扫描与下方合成红例共用同一条路径，
 * 防止"红例只构造 Hit、真正的 scan 恒空"式假绿（2026-11-10 第三轮收口）。
 */
function scanContents(targets: ReadonlyArray<{ rel: string; text: string }>): Hit[] {
  const hits: Hit[] = [];
  for (const { rel, text } of targets) {
    const lines = text.split('\n');
    for (const [index, fragment] of OLD_DOMAIN_FRAGMENTS.entries()) {
      for (let line = 0; line < lines.length; line += 1) {
        if (lines[line]!.includes(fragment)) hits.push({ rel, line: line + 1, fragment: index + 1 });
      }
    }
  }
  return hits;
}

function scan(): Hit[] {
  return scanContents(SCAN_TARGETS.map((rel) => ({ rel, text: readTarget(rel) })));
}

/**
 * 命中对象的**唯一可输出投影**：只留位置与禁词编号。所有断言、失败消息与 Vitest diff
 * 都只许序列化这个投影——`Hit` 将来若带上命中文本（最容易的"调试时加一列"），原始对象
 * 一进 `toEqual` / `toMatchObject` / 快照就会把片段抄进 CI 日志，而那正是最需要不抄词的
 * 时刻（2026-11-10 评审 9）。原始 `Hit` 只查键名，不查值。
 */
function projectHits(hits: ReadonlyArray<Hit>): Array<{ rel: string; line: number; fragment: number }> {
  return hits.map((hit) => ({ rel: hit.rel, line: hit.line, fragment: hit.fragment }));
}

function failureMessage(hits: Hit[]): string {
  const perFragment = new Map<number, number>();
  for (const hit of hits) perFragment.set(hit.fragment, (perFragment.get(hit.fragment) ?? 0) + 1);
  return [
    `金额判据面的样本/注释里出现旧域报告片段或非夹具业务词：${hits.length} 处命中 / ` +
      `${new Set(hits.map((h) => h.rel)).size} 个文件 / ${perFragment.size} 个词。`,
    '位置（相对路径:行号 [禁词编号] —— 命中文本刻意不打印，那会把旧域片段再抄一份进 CI 日志）：',
    ...hits.map((hit) => `  ${hit.rel}:${hit.line}  [#${hit.fragment}]`),
    '出路：把该片段换成夹具词表内的词或自造句式（状态码 SUBJECT_NOT_FOUND 与句式是形态，',
    '      可保留）；确需兼容的旧词按 amount-criteria.ts 的中性域分支注释登记为映射，',
    '      并在本文件头部把理由写进覆盖边界。不要改断言——为绿灯改断言等于拆防线。',
  ].join('\n');
}

describe('隐私样本守卫：金额判据面的旧域报告片段零命中', () => {
  it('样本与注释里没有旧域报告片段 / 非夹具业务词', () => {
    const hits = scan();
    // 断言的是 Hit 的投影（位置 + 禁词编号），且只比**长度**这个标量：Hit 里没有命中
    // 文本，Vitest 的 diff 也不会把禁词抄进 CI 日志（2026-11-10 评审 9）。命中详情由
    // failureMessage 给（rel:line [#编号]），它同样不序列化命中文本。
    const projected = projectHits(hits);
    expect(projected.length, failureMessage(hits)).toBe(0);
  });

  it('失败信息与命中投影都不含命中文本（只报位置与编号）', () => {
    // 自校验：把命中文本放进 Hit 的旧写法会让失败消息与 toEqual diff 都打印它。这里
    // 用一条构造命中钉住投影面——消息里出现的是 [#2]，不是 fragment 字面。
    const fake: Hit = { rel: 'scripts/eval/amount-criteria.ts', line: 1, fragment: 2 };
    const message = failureMessage([fake]);
    expect(message).toContain('scripts/eval/amount-criteria.ts:1  [#2]');
    for (const fragment of OLD_DOMAIN_FRAGMENTS) {
      // 布尔断言而不是 `.not.toContain(fragment)`：后者失败时 Vitest 的 diff 会把片段
      // 字面抄进日志（投影漏词的瞬间正好是最需要不抄词的时候，2026-11-10 评审 low）。
      expect(message.includes(fragment), '失败信息不得包含禁词文本').toBe(false);
      expect(JSON.stringify(projectHits([fake])).includes(fragment), 'toEqual diff 不得包含禁词文本').toBe(false);
    }
    expect(Object.keys(fake).sort()).toEqual(['fragment', 'line', 'rel']);
    expect(typeof fake.fragment).toBe('number');
  });

  it('红：真实 scan 路径检出合成违规，且失败信息 / toEqual 投影都不抄禁词', () => {
    // 2026-11-10 第三轮收口：上一条只构造 Hit，绕过 scan()——扫描器恒空也能过。
    // 这里把一条旧域片段放进被扫描形状的合成内容：守卫必须报 hit（把 scan 改坏成
    // 恒空 ⇒ 违规"转绿"，本测试红），同时失败消息与投影序列化不得出现片段字面
    // （把命中文本塞进 Hit ⇒ 序列化会把片段抄进 CI 日志，本测试红）。
    const planted = `beta 的 record value 是 500。\n${OLD_DOMAIN_FRAGMENTS[1]}\n`;
    const hits = scanContents([{ rel: 'synthetic/planted.ts', text: planted }]);
    // 断言接收方一律是投影，且逐字段比**标量**：`toEqual(projected[0], {…})` 在投影
    // 万一带上命中文本时会把 text 字段打进 diff（评审 9 的原形态）；标量断言只打印
    // 字符串/数字，漏词与否都抄不出片段。原始 Hit 只查键名。
    const projected = projectHits(hits);
    expect(projected.length).toBe(1);
    expect(projected[0]!.rel).toBe('synthetic/planted.ts');
    expect(projected[0]!.line).toBe(2);
    expect(projected[0]!.fragment).toBe(2);
    const message = failureMessage(hits);
    expect(message).toContain('synthetic/planted.ts:2  [#2]');
    // 投影的**序列化**不含片段：这条才是"投影漏词"的判据（不是只比字段形状）。
    const serialized = JSON.stringify(projected);
    for (const fragment of OLD_DOMAIN_FRAGMENTS) {
      // 布尔断言：投影真的漏词时，失败输出只报 "expected true to be false"，不打印片段本身。
      expect(message.includes(fragment), '失败信息不得包含禁词文本').toBe(false);
      expect(serialized.includes(fragment), 'toEqual diff 不得包含禁词文本').toBe(false);
    }
    // 投影的形状也只查**键名**（失败只打印键名，不打印值）：投影只许有这三列。
    expect(Object.keys(projected[0]!).sort()).toEqual(['fragment', 'line', 'rel']);
    expect(Object.keys(hits[0]!).sort()).toEqual(['fragment', 'line', 'rel']);
    // 孪生：同一扫描器对干净内容零命中（证明红例不是扫描器恒命中）。
    expect(scanContents([{ rel: 'synthetic/clean.ts', text: 'beta 的 record value 是 500。\n' }])).toEqual([]);
  });

  it('扫描范围自校验：目标清单非空、逐个存在且非空、数量与登记数一致（防假绿）', () => {
    // 与 exposure-lint 的范围自校验同族：砍空 / 砍窄扫描面是最便宜的假绿，必须有独立判据。
    expect(SCAN_TARGETS.length, '扫描目标清单被砍空').toBeGreaterThan(0);
    const problems: string[] = [];
    for (const rel of SCAN_TARGETS) {
      const content = readTarget(rel);
      if (content.trim().length === 0) problems.push(`${rel} 内容为空（扫了空文件）`);
    }
    // 判据与表征锁必须**同时**在册：只扫其中一个，另一半的样本就没人看守。
    for (const required of ['scripts/eval/amount-criteria.ts', 'scripts/eval/amount-criteria.test.ts']) {
      if (!SCAN_TARGETS.includes(required)) problems.push(`缺扫描目标 ${required}`);
    }
    expect(SCAN_TARGETS.length, `扫描目标数量与登记数不一致：${SCAN_TARGETS.join(', ')}`).toBe(2);
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
