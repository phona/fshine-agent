/**
 * 暴露面 lint（F1：防线先于改动，落地即红）。
 *
 * 波次 1（现行树全量脱敏）的机械守卫：把 `git ls-files` 的**全部被跟踪文件**逐文件扫
 * 四类敏感串，断言每类零命中。脱敏改动落地前四类都还有命中——此刻这份守卫**必须是红的**，
 * 红着交回是正确状态；谁为了绿灯改断言，谁就是把防线拆了。
 *
 * 四类禁词（只以编号 + sha256 指认，字面不落盘，原因见下一段）：
 *   A 真实企微 UserID 字面量 —— 6 个 scripts/ 验收与探针脚本里的授权用户常量；
 *   B 真实客户名 / 主体名 —— 映射表 C 组：14 个短名（任务书点名 9 + 审读意见 4 按
 *     "完整真实主体名一律虚构化"补收的裸州名与第二个短族 2 支 + 脱敏收口时发现映射表遗漏
 *     的两支账套名 2 支 + `821a3f7` 脱敏时漏收词、本棒按纪律补收的一支账套名 1 支）
 *     + 3 个点名的组合形。长组合本就被短形覆盖，显式登记只为把口径写死，防"查带市缀的
 *     不查裸名"这类不对称；收词纪律见 SENSITIVE_ENTRIES 上方注释——只增不减，遗漏一支
 *     就补一支，不为了少几处命中把禁词拆短；
 *   C 内部绝对路径前缀 —— 开发者主目录下的项目路径；
 *   D 真实财务读数 —— 映射表 E 组（含成对的两种千分位形态）。
 *
 * **为什么禁词一律拆段拼回、字面零落盘**：本文件落地后自己也在 `git ls-files` 里，于是
 * 也在自己的扫描范围内。一旦某条禁词以连续字面写进本文件，"全树零命中"的结论当场被守卫
 * 自己推翻——防线自败，`git grep -F` 的零命中证据同时变成假的。因此每条禁词只以两段以上
 * 的片段持有，运行时 join 回本体，并配 sha256(拼回值) 自校验：改动片段会让拼回值变化、
 * 自校验红，换不成另一个悄悄不同的串。哈希不泄漏字面，无需给守卫开自我豁免。
 *
 * 扫描范围：`git ls-files -z` 的全部被跟踪文件——含 docs、.env.example 等（原 tests/e2e
 * 夹具随 M2 波次 1 退役），没有目录白名单、没有自我豁免。假绿自校验封死"扫了个空集合/砍了范围"这种最便宜的假绿：
 * ls-files 非空 + 锚点文件在册 + 四类顶层目录都有文件 + 文件数下限。
 *
 * 失败信息只报 `相对路径:行号` 与禁词编号，**不打印命中文本**——否则测试输出会把敏感串
 * 再抄一份进 CI 日志，防线清完树又漏给出。
 *
 * 覆盖边界（已知不管的，写在这里而不是留给读者猜）：
 *   · 只扫现行树（被跟踪文件），不扫 git 历史——历史面归波次 2 的历史守卫；
 *   · D 类以映射表 E 组为初始集，纪律是"只增不减"：docs pass 新发现的真实读数要同表登记，
 *     否则"现行树没有、历史里有"的读数没有防复发判据。登记与替换必须同一批——只收词不替换
 *     等于让终态永远转不了绿（F15 即按此纪律连替换一并落地）。**仍未登记的同类读数**：61,000 /
 *     86,000 两支真实读数在 docs 叙述与约 28 个文件的黑夹子里成片出现，收词需连带替换整批夹具
 *     与断言，已登记 debt-ledger D-156，不在本波顺手改；
 *   · 执行层平台名词不在本守卫四类内，归 platform-leak-lint 与门①对账；
 *   · 邮箱 / 作者身份不进本守卫（波次 2 的 mailmap 事项）。
 *
 * **F3 变异留档（2026-11-05 实跑，五项变异均已还原，工作树复核干净）**：方法 = 临时改一处 →
 * 跑本文件 → 确认**对应**断言红 → 立即还原（`git checkout --` / `git reset`）→ 复核
 * `git status --short` 干净并复绿 7 passed，不留变异代码。五项各盯一条不同失败路径，合起来证明
 * 这里的"红"不是恒绿的副产品：
 *
 * | # | 变异（临时） | 转红的断言 | 实测输出 |
 * |---|---|---|---|
 * | ① | 向任意跟踪文件（docs/artifacts.md）追加一条真实客户名 | B 类零命中 | 1 failed / 6 passed，报"1 处命中 / 1 个文件 / 1 条禁词"，失败消息只给位置与禁词编号 |
 * | ② | 把某条禁词的拆段改坏（C11 首段加一字，拼回值随之改变） | 禁词表完整性 | 1 failed，"C11 拆段拼回值与登记 sha256 不一致（拆段被改动 → 禁词已悄悄变成另一个串）" |
 * | ③ | 扫描范围砍窄为只走 packages/ | 扫描范围自校验 | 1 failed，"实际扫到 166 个被跟踪文件（下限 200）" + 缺 7 个锚点 + 缺 apps/scripts/docs 三个顶层目录 |
 * | ④a | stub `git ls-files` 返回空数组 | 扫描范围自校验 | 1 failed，"实际扫到 0 个被跟踪文件"（假绿模式：范围一空，四类零命中会全部恒绿） |
 * | ④b | `git rm --cached README.md` 真删一个锚点文件 | 扫描范围自校验 | 1 failed，缺锚点 README.md；四类零命中**仍全绿**——抓住它的是自校验，不是类别断言 |
 * | ⑤ | 修复轮补收 C17 后复核①：向 `docs/artifacts.md` 追加该支本体一行 | B 类零命中 | 1 failed / 6 passed，报 `C17` 位置（`docs/artifacts.md:149`），失败消息为终态措辞（任何命中即回归） |
 *
 * 留档的意义：③④ 证明"砍窄范围"与"扫空集合"这两种最便宜的假绿各有独立判据；② 证明禁词不能被
 * 悄悄换成另一个串（换了就自校验红）；① 证明类别断言对真实串敏感。改本文件的人请连同这张表一起
 * 复核——表与实现脱节就是防线在退化的信号。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
/** 守卫自身源文件（自审计用：本文件落地后也在扫描范围内，必须自己过得去）。 */
const GUARD_FILE = path.resolve(__dirname, 'exposure-lint.test.ts');

/**
 * 扫描范围自校验的锚点文件：横跨根目录、packages、apps、scripts、docs 五处。
 * 缺任何一个都说明扫描面被砍了（例如把 ls-files 换成只走 packages/ 的遍历）。
 */
const SCOPE_ANCHORS: readonly string[] = [
  'package.json',
  'AGENTS.md',
  'README.md',
  '.env.example',
  'packages/agent/src/runtime.ts',
  'apps/server/main.ts',
  'scripts/ask.ts',
  'docs/change-safety.md',
];

/** 扫描面必须覆盖的顶层目录（锚点之外的结构性判据）。 */
const SCOPE_TOP_DIRS: readonly string[] = ['packages', 'apps', 'scripts', 'docs'];

/**
 * 被跟踪文件数下限（2026-11-05 实测 307：迁移起点 44a84a6 为 306，加本守卫自身 1）。
 * 只作"扫描面被 stub 成一小撮"的绊线：仓库正常只增不减，真要在下降沿调整就显式改这个数并写
 * 理由，不让它静默失效。
 */
const MIN_TRACKED_FILES = 200;

/** 失败信息里最多列几处位置（全量计数照报，位置只抽样，避免把日志刷成敏感串清单）。 */
const MAX_REPORTED_HITS = 30;

type CategoryId = 'userid' | 'customer' | 'path' | 'figure';

const CATEGORY_LABELS: Readonly<Record<CategoryId, string>> = {
  userid: 'A 真实企微 UserID 字面量',
  customer: 'B 真实客户名 / 主体名（映射表 C 组）',
  path: 'C 内部绝对路径前缀',
  figure: 'D 真实财务读数（映射表 E 组）',
};

/**
 * 禁词表。`parts` 是拆段（≥2 段、无空段、任何一段都不含另一条禁词的本体——由下方
 * "禁词表完整性"断言机械把守），运行时 join 回本体；`sha256` 是拼回值的摘要。
 *
 * 收词纪律（与 platform-leak-lint 的"词表只增不减"同族）：新增敏感串往表里加，
 * 不从表里删——删一条等于给那一类 reopen 一个无人看守的门。新读数/新名称按同一形态
 * 追加并配 sha256，不要为了少几处命中把禁词拆短。
 */
const SENSITIVE_ENTRIES: ReadonlyArray<{
  id: string;
  category: CategoryId;
  parts: readonly string[];
  sha256: string;
}> = [
  // ── A 真实企微 UserID 字面量 ──
  { id: 'U1', category: 'userid', parts: ['woyEfzFgAAs', 'vvU1fI8e_', 'AztWjOU4qnlw'], sha256: '77af19e224226844283085397ec3bf1dbde7bb76dd649c66cb000e8538349660' },
  // ── B 真实客户名 / 主体名 ──
  { id: 'C1', category: 'customer', parts: ['黔', '隆'], sha256: 'd19f706f9244836d2ae10de1e9843fb4e01868d58615d6b1e8c4c53e1308ffff' },
  { id: 'C2', category: 'customer', parts: ['益', '捷达'], sha256: 'c223df930d6d54ad209be7d54e648e3be132d0a1dbba307d35ea2295e716c354' },
  { id: 'C3', category: 'customer', parts: ['芳', '晟'], sha256: '7d3c505c6e41f848a043d431bfea7e5fd3e2bd9a4e55042297c23019c9035c69' },
  { id: 'C4', category: 'customer', parts: ['机电', '设备'], sha256: '777ca26ee534ae384946260870160774dce72515bc2c496238323588758dca6d' },
  { id: 'C5', category: 'customer', parts: ['亿', '企赢'], sha256: 'ce52611f5535e43ceaf61b08922fe2dbacd31c9bf41ef4681ee3e701a75f5082' },
  { id: 'C6', category: 'customer', parts: ['柳', '州市'], sha256: 'a7dbbe0352a56cd86eeebc4b04a4e8af792c00498bf5219f8eeab1a29f49bf07' },
  { id: 'C7', category: 'customer', parts: ['柳', '州'], sha256: '01ee06680b9a80a62a7dc5b573b365def1469b050a370d3f0eca22d17094ce4a' },
  { id: 'C8', category: 'customer', parts: ['天', '仁'], sha256: '3a3a655663774c08f6c23beb1531a24e599d01abad6725582313399f8b82aa74' },
  { id: 'C9', category: 'customer', parts: ['元', '亨'], sha256: '8d02acaa7f78f804733e733f3857f3922f155e4218cfbdb4e9f64c9eeb4a8437' },
  { id: 'C10', category: 'customer', parts: ['昌', '瑞'], sha256: '074458a441d4d6f853f98211992eb3fa923e9048e00b6e5bf8621979c9c56945' },
  { id: 'C11', category: 'customer', parts: ['瑞', '东'], sha256: 'e6027df50009d88c909eb89739b926d8732231def563eb97a6a5472227b3f1ed' },
  { id: 'C12', category: 'customer', parts: ['黔', '隆财税'], sha256: '954dbddc34c56a4c8e6b263df2a9af83de3a66f661744a69b70478940407bcc2' },
  { id: 'C13', category: 'customer', parts: ['柳', '州市芳', '晟'], sha256: '851557f3dc1fda283c58dcdb8d3e29fb0940b96de1b75d339b7a64e5cbc23a31' },
  { id: 'C14', category: 'customer', parts: ['柳', '州市元', '亨纸业有限公司'], sha256: '2fa61d7cc57a04a3f7b29f572b8a6b1643baf4a939570c82611cd44822f8c7bf' },
  { id: 'C15', category: 'customer', parts: ['腾', '海升'], sha256: '1cea7f4143e75ebe1abd192ebf511e7ab355c26e09f9f411395cf11a8a6059f5' },
  { id: 'C16', category: 'customer', parts: ['鑫', '跃'], sha256: 'd369773e0df8460b8be3701ee03528381907d1a6852acbc1ec97ff78735c7dfc' },
  // 821a3f7 把这支映射表外的账套名脱敏时漏了收词（只替换、未进表），本棒按"遗漏一支就补
  // 一支"补收——短形即覆盖带贸易后缀的长组合，长形不单独列（与 C6/C7 同口径）。
  { id: 'C17', category: 'customer', parts: ['创', '驰'], sha256: '44e687955acf65c75b3aa13b50830675b847050866c53348fd5ff6528111532e' },
  // ── C 内部绝对路径前缀 ──
  { id: 'P1', category: 'path', parts: ['/home/', 'tao/'], sha256: 'eb9b4cbfa962191df858fe58a10605e1227185f2b91fa8cf1615cd0bca0c3620' },
  // ── D 真实财务读数 ──
  { id: 'F1', category: 'figure', parts: ['7,430,', '345.84'], sha256: 'cee24e119d2635915f6deba37db66ddd4ca436ff56759973f5df52aa09c43194' },
  { id: 'F2', category: 'figure', parts: ['522,', '396.77'], sha256: '2cc63842a7cea7b3a8ca48c5ee9a79baaac08fe7a7ac09ba9756249dfb9310a7' },
  { id: 'F3', category: 'figure', parts: ['470,', '592.56'], sha256: 'c5e77ee80034cc85850d9e4042f54e0b3cf9ea76c46595e5072dd2c330549e9a' },
  { id: 'F4', category: 'figure', parts: ['470', '592.56'], sha256: '2016d9a76072c6536319c354d72768d17937e7803356728ff4da24d5a8d9ac47' },
  { id: 'F5', category: 'figure', parts: ['47,', '920.92'], sha256: '7fbd3b20e4fc13759e57398e97aad42375fcc077e642d3c903a4b2606094504d' },
  { id: 'F6', category: 'figure', parts: ['77,', '083.76'], sha256: '689e4c54fd059b5e623c2f7cb7f3db6e173863a244bc868d42e77b6fe4f42d20' },
  { id: 'F7', category: 'figure', parts: ['6,674,', '827.00'], sha256: 'ea10b0cbc9d7ffb946c0c097b8ced7af2d215982b29bf0545576c4761224f626' },
  { id: 'F8', category: 'figure', parts: ['1,830,', '935.22'], sha256: '742678d0d8f8f34e0d07584d0534fc0a5ca29392d0faf1e86fdb8fcb9aaaac6c' },
  { id: 'F9', category: 'figure', parts: ['18,737,', '717.52'], sha256: '6f6f384de793460fc11474bf8a2850cce2581f393834a91694b3b723c0ddad5a' },
  { id: 'F10', category: 'figure', parts: ['2,961', ' 万'], sha256: '1293cd7b35122cf58c5d879871f7c5c4375d2c1b157a9085639fac58d0aca9a4' },
  { id: 'F11', category: 'figure', parts: ['216', ' 个账套'], sha256: '32edbaa4ed2851e24e32d17466a4d222e143ea7871ca2bd50a457f3f35ffeeeb' },
  { id: 'F12', category: 'figure', parts: ['118', ' 人'], sha256: 'a493a2b68010dc780801df5a8d913b62e6a2808bb6c8ec2f59037418baf6292c' },
  { id: 'F13', category: 'figure', parts: ['19', ' 人'], sha256: '3c0ca8fe1d3fe72d099cc2f95005c8c2585731143599b436ff058519054a12a0' },
  { id: 'F14', category: 'figure', parts: ['1500', '.00'], sha256: 'd7be848b5b54c92d04ca4c9336044311591e32bf71218f647931b44d540492c4' },
  { id: 'F15', category: 'figure', parts: ['96,', '805'], sha256: '873a625932c651b49307d59dbc133488926f1c420b9b78f840c13b8ed7392c08' },
];

/** 拼回禁词本体。禁词只以拆段形式存在于本文件，运行时才成为连续串。 */
function materialize(parts: readonly string[]): string {
  return parts.join('');
}

function sha256Of(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 被跟踪文件清单（worktree 相对路径）。-z 走 NUL 分隔，避开 git 对含空格/引号路径的
 * 默认转义；显式传 cwd，不依赖 vitest 的进程目录。取不到清单就抛——守卫不做无范围扫描。
 */
function trackedFiles(): string[] {
  let raw: string;
  try {
    raw = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `暴露面 lint 取不到被跟踪文件清单（git ls-files 失败：${String(error)}）。` +
        '范围取不到即红，不静默放过——修好 git 可用性再跑，不要把扫描范围写窄。',
    );
  }
  return raw
    .split('\0')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** 文件内容缓存：一次运行内每文件只读一遍（四类禁词共用）。 */
const CONTENT_CACHE = new Map<string, string>();

function readTracked(rel: string): string {
  const cached = CONTENT_CACHE.get(rel);
  if (cached !== undefined) return cached;
  // 被跟踪但工作树里已删除（例如 checkout 到旧 ref）按空内容处理：不是命中，也不抛。
  let content = '';
  const abs = path.join(REPO_ROOT, rel);
  if (existsSync(abs)) content = readFileSync(abs, 'utf8');
  CONTENT_CACHE.set(rel, content);
  return content;
}

interface Hit {
  entryId: string;
  rel: string;
  line: number;
}

/** 扫一类禁词：先按整文件 includes 粗筛，命中文件才做行级定位（报位置用）。 */
function scanCategory(category: CategoryId): Hit[] {
  const entries = SENSITIVE_ENTRIES.filter((entry) => entry.category === category);
  const hits: Hit[] = [];
  for (const rel of trackedFiles()) {
    const content = readTracked(rel);
    const matched = entries.filter((entry) => content.includes(materialize(entry.parts)));
    if (matched.length === 0) continue;
    const lines = content.split('\n');
    for (const entry of matched) {
      const needle = materialize(entry.parts);
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index]!.includes(needle)) hits.push({ entryId: entry.id, rel, line: index + 1 });
      }
    }
  }
  return hits;
}

function failureMessage(category: CategoryId, hits: Hit[]): string {
  const perEntry = new Map<string, number>();
  const perFile = new Set<string>();
  for (const hit of hits) {
    perEntry.set(hit.entryId, (perEntry.get(hit.entryId) ?? 0) + 1);
    perFile.add(hit.rel);
  }
  const shown = hits.slice(0, MAX_REPORTED_HITS);
  const digestOf = (id: string): string =>
    sha256Of(materialize(SENSITIVE_ENTRIES.find((entry) => entry.id === id)!.parts)).slice(0, 12);
  return [
    `${CATEGORY_LABELS[category]}：${hits.length} 处命中 / ${perFile.size} 个文件 / ${perEntry.size} 条禁词。`,
    '当前态 = 终态：脱敏波已收口，四类应零命中——出现任何命中即回归（新引入 / 回潮 / 收词遗漏）。',
    '按禁词编号汇总（编号 → sha256 前 12 位；字面不落盘，按编号回表核对）：',
    ...[...perEntry.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([id, count]) => `  ${id} ${digestOf(id)}  ${count} 处`),
    shown.length < hits.length
      ? `前 ${shown.length} 处位置（其余 ${hits.length - shown.length} 处未列）：`
      : '位置（相对路径:行号）：',
    ...shown.map((hit) => `  ${hit.rel}:${hit.line}  [${hit.entryId}]`),
    '命中文本刻意不打印——那会把敏感串再抄一份进 CI 日志。',
    '出路：查该串为何再现（哪个 commit / 文件带回来的），并按收词纪律把该条补进禁词表',
    '      （只增不减；需要替换的连替换同批落地——只收词不替换 = 终态永远转不了绿）。',
    '      不要改本文件的断言——为绿灯改断言等于拆防线。',
  ].join('\n');
}

describe('暴露面 lint：四类敏感串在全部被跟踪文件里零命中', () => {
  it('A 真实企微 UserID 字面量零命中', () => {
    const hits = scanCategory('userid');
    expect(hits, failureMessage('userid', hits)).toEqual([]);
  });

  it('B 真实客户名 / 主体名零命中', () => {
    const hits = scanCategory('customer');
    expect(hits, failureMessage('customer', hits)).toEqual([]);
  });

  it('C 内部绝对路径前缀零命中', () => {
    const hits = scanCategory('path');
    expect(hits, failureMessage('path', hits)).toEqual([]);
  });

  it('D 真实财务读数零命中', () => {
    const hits = scanCategory('figure');
    expect(hits, failureMessage('figure', hits)).toEqual([]);
  });

  it('扫描范围自校验：ls-files 非空、锚点在册、顶层目录齐全、文件数不低于下限（防假绿）', () => {
    const files = trackedFiles();
    const missingAnchors = SCOPE_ANCHORS.filter((anchor) => !files.includes(anchor));
    const missingDirs = SCOPE_TOP_DIRS.filter((dir) => !files.some((file) => file.startsWith(`${dir}/`)));
    expect(files.length, [
      '扫描范围不对——这是假绿模式，比漏扫更危险：',
      `  实际扫到 ${files.length} 个被跟踪文件（下限 ${MIN_TRACKED_FILES}）`,
      `  缺锚点：${missingAnchors.join(', ') || '无'}`,
      `  缺顶层目录：${missingDirs.join(', ') || '无'}`,
      '常见成因：把 git ls-files 换成了只走 packages/ 的目录遍历、stub 掉了 git、',
      '或在非仓库根目录跑。修扫描范围，不要动禁词表。',
    ].join('\n')).toBeGreaterThanOrEqual(MIN_TRACKED_FILES);
    expect(missingAnchors, `锚点文件不在被跟踪清单里：${missingAnchors.join(', ')}`).toEqual([]);
    expect(missingDirs, `这些顶层目录下一个文件都没扫到：${missingDirs.join(', ')}`).toEqual([]);
  });

  it('禁词表完整性：拼回值 = 登记 sha256，且无单段 / 空段 / 段内嵌他条本体', () => {
    const problems: string[] = [];
    for (const entry of SENSITIVE_ENTRIES) {
      if (entry.parts.length < 2) problems.push(`${entry.id} 只有一段（等于字面直书）`);
      if (entry.parts.some((part) => part.length === 0)) problems.push(`${entry.id} 有空段`);
      if (sha256Of(materialize(entry.parts)) !== entry.sha256) {
        problems.push(`${entry.id} 拆段拼回值与登记 sha256 不一致（拆段被改动 → 禁词已悄悄变成另一个串）`);
      }
      for (const part of entry.parts) {
        for (const other of SENSITIVE_ENTRIES) {
          if (part.includes(materialize(other.parts))) {
            problems.push(`${entry.id} 的一段包含 ${other.id} 的本体（拆段本身即泄密）`);
          }
        }
      }
    }
    expect(problems, [
      '禁词表结构被破坏：',
      ...problems,
      '修法：恢复拆段与 sha256 的对应关系，不要删除断言。',
    ].join('\n')).toEqual([]);
  });

  it('守卫自身不含任何敏感串字面量（拆段持有，字面零落盘）', () => {
    const source = readFileSync(GUARD_FILE, 'utf8');
    const leaked = SENSITIVE_ENTRIES.filter((entry) => source.includes(materialize(entry.parts)));
    expect(
      leaked.map((entry) => entry.id),
      [
        '守卫自身源码里出现了敏感串字面量——本文件落地后也在 git ls-files 里，',
        '于是也在自己的扫描范围内，字面一落盘"全树零命中"就被守卫自己推翻：',
        ...leaked.map((entry) => `  ${entry.id}`),
        '修法：把该条改回两段以上拆段 + 重算 sha256，不要给守卫开自我豁免。',
      ].join('\n'),
    ).toEqual([]);
  });
});
