/**
 * 历史敏感面守卫（HG1）——波次 2「L0 全历史敏感物清零」的机械防线，F1 表征先行。
 *
 * 与波次 1 的 `exposure-lint.test.ts`（扫**现行树**的被跟踪文件）分工：本文件扫
 * **全部 ref 的历史**（`git log --all -p`，含提交信息与 diff 的增删两行）。波次 1 清完
 * 现行树之后，敏感串仍整条活在历史里——没有这道守卫，「重写已生效」与「守卫根本没在看」
 * 在测试输出上完全一样。
 *
 * 四类靶子（形态一律拆段拼回、字面零落盘，理由同 exposure-lint：本文件自己也在扫描范围里）：
 *   ① 企微 UserID 的**带前缀**形态；
 *   ② 开发者主目录下的内部绝对路径前缀形态；
 *   ③ 数字 QQ 邮箱形态；
 *   ④ `config/agent.yaml` 与 `.runtime/` 两个路径涉史的 commit。
 *
 * **本文件落地即红（2026-11-05 实跑，HEAD = `598e4c6`、全 ref）**：四类分别
 * **4 / 129 / 377 / 12**（净命中，口径见各类失败消息）。红着交回是正确状态——重写
 * （波次 2 C2）落地前它就该红；谁为了绿灯改断言，谁就是把防线拆了。
 *
 * 覆盖边界（已知不管的，写在这里而不是留给读者猜）：
 *   · ① 只覆盖带前缀形态。UserID 字面在历史里共 22 行，其中 4 行带前缀、18 行是裸常量
 *     （PRINCIPAL_USER / AUTHORIZED_USER / REAL_USER 的赋值形态）。字面级清零由 owner 侧
 *     逐串扫描 `scripts/history-sensitive-scan.sh` 兜底（G1b），**两者缺一不可**——只跑本
 *     守卫会把「还有 18 行」读成「已干净」。
 *   · ③ 的 377 行**全部**落在 `Author:` / `Commit:` 元数据行，diff 里 0 行——字面替换
 *     （--replace-text）抓不到元数据，只能靠 mailmap（波次 2 C2 配方的一项）。
 *   · 客户名 / 真实读数 / 执行层平台名词不在四类内：前者走 G1b 逐串扫描（表由波次 1 映射表
 *     v2 生成），后者是波次 2 openDecisions 3 的未拍板项。
 *   · 本守卫**不读**替换表文件——表缺失不会成为红的原因，C1→C2 之间的红必须且只能由四类
 *     命中与两条正向锚点造成（F1 可归因）。
 *
 * **替换值扣减（为什么必须有）**：重写的替换值本身就长得像敏感形态——路径形占位符会命中 ②、
 * UserID 占位符会命中 ①。不扣掉的话，重写落地的瞬间这两类反而变红、且永远转不了绿，
 * 守卫把自己的出路堵死。扣减只认 `REGISTERED_REPLACEMENTS` 登记表（拆段 + sha256，与
 * exposure-lint 禁词表同纪律：改一段 → 拼回值变 → 自校验红），且每条都必须**真的命中**
 * 某个形态（下方自校验）——登记表不许变成死配置。
 *
 * **正向锚点（为什么必须有）**：四类清零只证明"敏感串没了"，不证明"重写真发生过"——
 * 把扫描范围砍空同样四类全绿。因此钉两条替换值锚点：它们在历史里各 ≥1 次，才说明重写
 * 的产物真的落了盘。锚点字面同样只以拆段持有（自身源码一旦含连续锚点串，锚点计数会被
 * 守卫自己的提交顶起来，判别力当场归零——这条也由自校验机械把守）。
 *
 * **假绿自校验（比漏扫更危险的是扫了个空）**：patch 字节数、`--all` 的 commit 数、patch 里
 * 实际出现的 commit 头数、diff 覆盖的去重文件数，四道下限。浅克隆（CI 默认 depth=1）下
 * `git log --all -p` 只看得到 1 个 commit，四类会全部恒绿——那种环境下本文件**显式 skip**
 * 并写明原因，不装绿；真判据是全量 clone（波次 2 G4）。
 *
 * F3 变异留档（四项：扫描目标改错 → 计数掉零 → 守卫转绿）见文件头表格，随 C1 之后的
 * 留档 commit 落地——改动本文件的人请连同那张表一起复核。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
/** 守卫自身源文件（自审计用：本文件落地后也在扫描范围内，必须自己过得去）。 */
const GUARD_FILE = path.resolve(__dirname, 'history-hygiene.test.ts');

/**
 * git 子进程出口缓冲区。实测 `git log --all -p`（2026-11-05，`598e4c6`，全 ref）
 * = **13,041,595 字节**；Node `spawnSync` 默认 maxBuffer 1MB 会 ENOBUFS——守卫一上工
 * 就红，且红因与"历史有敏感串"混在一起。取 64MB 留足重写后仍不触顶的余量。
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** 扫描面下限（2026-11-05 实测：13.0MB / 377 commit / 364 文件；重写后仍远高于此）。 */
const MIN_PATCH_BYTES = 2 * 1024 * 1024;
const MIN_ALL_COMMITS = 300;
const MIN_PATCH_COMMITS = 100;
const MIN_PATCH_FILES = 100;

/** 历史路径类的两个靶子（本地部署配置与本地运行产物，随 C2 的 --invert-paths 整体移出历史）。 */
const RETIRED_PATHS: readonly string[] = ['config/agent.yaml', '.runtime'];

/** 失败消息里最多列几处归因（全量计数照报，位置只抽样，避免把日志刷成敏感串清单）。 */
const MAX_SAMPLES = 20;

// ── 形态（拆段拼回，字面零落盘） ────────────────────────────────────────────
const SHAPES = {
  /** 企微 UserID 的带前缀形态：前缀 + 20 位以上 base62/下划线/连字符。 */
  userid: 'wecom:' + '[A-Za-z0-9_-]{20,}',
  /** 内部绝对路径前缀形态：开发者主目录下的任一层级。 */
  home: '/home/' + '[A-Za-z0-9_.-]+/',
  /** 数字 QQ 邮箱形态（QQ 号 ≥5 位，排除 0 开头）。 */
  mail: '[1-9][0-9]{4,}' + '@qq.com',
} as const;

type ShapeId = keyof typeof SHAPES;
const SHAPE_IDS: readonly ShapeId[] = ['userid', 'home', 'mail'];

const SHAPE_LABELS: Readonly<Record<ShapeId, string>> = {
  userid: '① 企微 UserID（带前缀形态）',
  home: '② 内部绝对路径前缀（开发者主目录形态）',
  mail: '③ 数字 QQ 邮箱',
};

interface SplitEntry {
  id: string;
  /** 拆段（≥2 段、无空段），运行时 join 回本体。 */
  parts: readonly string[];
  /** 拼回值的 sha256——改一段就变，自校验红，换不成另一个悄悄不同的串。 */
  sha256: string;
}

/**
 * 已登记替换值（重写的**替换侧**，来自波次 1 映射表 v2 与波次 2 替换表）。
 * 它们按设计就长得像敏感形态，故在各类计数里被扣减；理由见文件头「替换值扣减」。
 */
const REGISTERED_REPLACEMENTS: readonly SplitEntry[] = [
  { id: 'X1', parts: ['wecom:', 'REPLACE_WITH_YOUR_WECOM_USERID'], sha256: '03c6be330253344375b63c7cece387ad1a8d127c775a0d52e93ee689c38e5cc7' },
  { id: 'X2', parts: ['/home/fictional-', 'user/'], sha256: '0097b0fdb7264c8f8f21ccf540096a480d5ee2fcae578cc35a05ab42bb30dd1e' },
];

/**
 * 正向锚点（重写产物）：历史里各 ≥1 次才算"重写真发生过"。
 * Y1 = 映射表 B 组给执行层根目录的占位符；Y2 = 映射表 C 组给账套族的替换值。
 */
const ANCHORS: readonly SplitEntry[] = [
  { id: 'Y1', parts: ['<platform-', 'root>'], sha256: '05c3d3742e170a61f9f6fc9486f644aa8cd48f66ac2ef63e65ec90207f2d4c17' },
  { id: 'Y2', parts: ['账', '套甲'], sha256: 'f687f7e6bd3bcbc2442990eccb23464bb75bcfc06517a3319e4ef17f4d10fcfe' },
];

function materialize(parts: readonly string[]): string {
  return parts.join('');
}

function sha256Of(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 形态是否命中给定文本（用于登记表自校验：锚点不许命中形态、替换值必须命中形态）。 */
function shapeMatches(shapeSource: string, text: string): boolean {
  return new RegExp(shapeSource).test(text);
}

/** git 统一出口：失败即抛（fail-closed），不做"取不到就跳过"的静默降级。 */
function runGit(args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (result.error) {
    throw new Error(
      `历史守卫执行 git ${args.join(' ')} 失败：${String(result.error)}。` +
        '实测 git log --all -p 约 13MB，maxBuffer 小于它就会 ENOBUFS——' +
        '这是实现缺陷，不是历史干净；修缓冲区，不要把扫描范围写窄。',
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `历史守卫执行 git ${args.join(' ')} 退出码 ${result.status}：${(result.stderr ?? '').trim()}`,
    );
  }
  return result.stdout;
}

function isShallowRepository(): boolean {
  return runGit(['rev-parse', '--is-shallow-repository']).trim() === 'true';
}

/** 浅克隆（CI 默认 depth=1）下 `--all` 只剩 1 个 commit，四类会全部恒绿 → 显式 skip，不装绿。 */
const SHALLOW = isShallowRepository();
const SKIP_REASON = SHALLOW
  ? [
      '浅克隆（git rev-parse --is-shallow-repository = true）：git log --all -p 只能看到',
      '截断深度内的少量 commit，四类零命中在这里是**假绿**，不是通过。',
      '本文件在这种环境下跳过而不是装绿；真判据是全量 clone 后重跑',
      '（波次 2 G4：普通 clone + mirror clone 两级），或 CI 改 fetch-depth: 0（归波次 4）。',
    ].join('\n')
  : '';

interface Hit {
  readonly commit: string;
  readonly file: string;
}

interface ShapeTally {
  /** 形态原始命中行数（未扣替换值）。 */
  raw: number;
  /** 扣掉已登记替换值后的净命中行数——判定用这个。 */
  net: number;
  /** 其中被认定为已登记替换值的行数。 */
  excluded: number;
  hits: Hit[];
}

interface HistoryScan {
  patchBytes: number;
  patchCommits: number;
  allCommits: number;
  patchFiles: number;
  tallies: Record<ShapeId, ShapeTally>;
  /** 涉史的两路径 commit（第四类靶子）。 */
  retiredPathCommits: string[];
  /** 曾以新增形态进入历史的两路径下文件。 */
  retiredAddedFiles: string[];
  /** 正向锚点计数。 */
  anchors: Record<string, number>;
}

/** 去掉 git 对含空格/引号路径的默认转义（只用于归因展示）。 */
function unquotePath(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return raw;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

let cachedScan: HistoryScan | undefined;

/** 一次运行只扫一遍历史（13MB，三类形态共用）；失败即抛，不做降级。 */
function scanHistory(): HistoryScan {
  if (cachedScan) return cachedScan;
  const patch = runGit(['log', '--all', '-p']);
  const exclusions = REGISTERED_REPLACEMENTS.map((entry) => materialize(entry.parts));
  const tallies: Record<ShapeId, ShapeTally> = {
    userid: { raw: 0, net: 0, excluded: 0, hits: [] },
    home: { raw: 0, net: 0, excluded: 0, hits: [] },
    mail: { raw: 0, net: 0, excluded: 0, hits: [] },
  };
  const patterns = SHAPE_IDS.map((id) => ({ id, pattern: new RegExp(SHAPES[id], 'g') }));
  const seenFiles = new Set<string>();
  let patchCommits = 0;
  let commit = '(提交头之前)';
  let file = '(提交元数据)';

  for (const line of patch.split('\n')) {
    const commitHead = /^commit ([0-9a-f]{7,40})(?: \(.*\))?$/.exec(line);
    if (commitHead) {
      commit = commitHead[1]!;
      file = '(提交元数据)';
      patchCommits += 1;
      continue;
    }
    const diffHead = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diffHead) {
      file = unquotePath(diffHead[2]!);
      seenFiles.add(file);
      continue;
    }
    for (const { id, pattern } of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const text = match[0];
        const tally = tallies[id];
        tally.raw += 1;
        if (exclusions.some((value) => text.includes(value))) {
          tally.excluded += 1;
          continue;
        }
        tally.net += 1;
        if (tally.hits.length < MAX_SAMPLES) tally.hits.push({ commit, file });
      }
    }
  }

  const retiredPathCommits = runGit(['log', '--all', '--format=%H', '--', ...RETIRED_PATHS])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{7,40}$/.test(line));
  const retiredAddedFiles = runGit([
    'log',
    '--all',
    '--diff-filter=A',
    '--name-only',
    '--format=',
    '--',
    ...RETIRED_PATHS,
  ])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const anchors: Record<string, number> = {};
  for (const anchor of ANCHORS) anchors[anchor.id] = countOccurrences(patch, materialize(anchor.parts));
  const allCommits = Number(runGit(['rev-list', '--count', '--all']).trim());

  cachedScan = {
    patchBytes: Buffer.byteLength(patch, 'utf8'),
    patchCommits,
    allCommits,
    patchFiles: seenFiles.size,
    tallies,
    retiredPathCommits,
    retiredAddedFiles,
    anchors,
  };
  return cachedScan;
}

function shapeFailureMessage(id: ShapeId, tally: ShapeTally): string {
  const metadataOnly = tally.hits.length > 0 && tally.hits.every((hit) => hit.file === '(提交元数据)');
  return [
    `${SHAPE_LABELS[id]}：净命中 ${tally.net} 行（形态原始命中 ${tally.raw} 行，` +
      `其中 ${tally.excluded} 行是已登记替换值，扣减后 ${tally.net}）。`,
    '当前态 = 终态：波次 2 C2 重写落地后四类应零命中。出现净命中 = 历史里仍有敏感串',
    '（重写未覆盖该形态 / 新 commit 又带回来）。',
    metadataOnly
      ? '命中全部落在提交元数据行（Author/Commit）——字面替换抓不到，只能靠 mailmap 清。'
      : '',
    '归因（commit + 文件；命中文本刻意不打印——那会把敏感串再抄一份进 CI 日志）：',
    ...tally.hits.map((hit) => `  ${hit.commit}  ${hit.file}`),
    tally.hits.length < tally.net ? `  …其余 ${tally.net - tally.hits.length} 处未列。` : '',
    '出路：查该串为何还在（哪个 ref / commit 带回来的），补进替换表后重跑重写；',
    '      不要改本文件的断言——为绿灯改断言等于拆防线。',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

describe('历史敏感面守卫（HG1）：四类敏感物在全部 ref 历史里零命中', () => {
  it('① 企微 UserID（带前缀形态）零命中', (ctx) => {
    if (SHALLOW) return ctx.skip(SKIP_REASON);
    const tally = scanHistory().tallies.userid;
    expect(tally.net, shapeFailureMessage('userid', tally)).toBe(0);
  });

  it('② 内部绝对路径前缀零命中（已登记替换值扣减后）', (ctx) => {
    if (SHALLOW) return ctx.skip(SKIP_REASON);
    const tally = scanHistory().tallies.home;
    expect(tally.net, shapeFailureMessage('home', tally)).toBe(0);
  });

  it('③ 数字 QQ 邮箱零命中', (ctx) => {
    if (SHALLOW) return ctx.skip(SKIP_REASON);
    const tally = scanHistory().tallies.mail;
    expect(tally.net, shapeFailureMessage('mail', tally)).toBe(0);
  });

  it('④ config/agent.yaml 与 .runtime/ 两个路径在历史里零 commit', (ctx) => {
    if (SHALLOW) return ctx.skip(SKIP_REASON);
    const scan = scanHistory();
    expect(
      scan.retiredPathCommits,
      [
        `两个本地部署/运行路径在历史里还有 ${scan.retiredPathCommits.length} 个 commit 触碰。`,
        '它们是本地配置（含企微 UserID）与本地运行产物（探针报告、平台 mock 状态），',
        '随波次 2 C2 的 --invert-paths 整体移出历史。当前态 = 移出前，红是预期。',
        '曾以新增形态进入历史的文件：',
        ...scan.retiredAddedFiles.map((rel) => `  ${rel}`),
        '出路：跑 C2 配方（--invert-paths --path config/agent.yaml --path .runtime/），',
        '      不要改本文件的断言。',
      ].join('\n'),
    ).toEqual([]);
  });

  it('正向锚点：重写的替换值必须在历史里出现过（证明重写发生过，不是扫描变空）', (ctx) => {
    if (SHALLOW) return ctx.skip(SKIP_REASON);
    const scan = scanHistory();
    const missing = ANCHORS.filter((anchor) => (scan.anchors[anchor.id] ?? 0) < 1);
    expect(
      missing.map((anchor) => anchor.id),
      [
        `正向锚点缺席：${missing.map((anchor) => anchor.id).join(', ') || '无'}。`,
        '四类清零只证明"敏感串没了"，不证明"重写真发生过"——把扫描范围砍空同样四类全绿。',
        '这两条锚点是重写产物（替换值）在历史里的落点，各 ≥1 次才说明重写真的执行过。',
        '重写未落地时它们本来就是 0——这正是 C1 状态下的预期红，归因写在这里而不是猜。',
        '当前锚点计数：',
        ...ANCHORS.map((anchor) => `  ${anchor.id} → ${scan.anchors[anchor.id] ?? 0}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('守卫自匹配与登记表完整性：自身源码零形态命中、拆段拼回值 = 登记 sha256、替换值/锚点各有判别力', () => {
    const source = readFileSync(GUARD_FILE, 'utf8');
    const problems: string[] = [];

    for (const id of SHAPE_IDS) {
      if (shapeMatches(SHAPES[id], source)) {
        problems.push(`${SHAPE_LABELS[id]}：守卫自身源码被自己的形态命中（本文件也在 git log --all -p 里）`);
      }
    }
    for (const [group, entries] of [
      ['替换值', REGISTERED_REPLACEMENTS],
      ['锚点', ANCHORS],
    ] as const) {
      for (const entry of entries) {
        if (entry.parts.length < 2) problems.push(`${group} ${entry.id} 只有一段（等于字面直书）`);
        if (entry.parts.some((part) => part.length === 0)) problems.push(`${group} ${entry.id} 有空段`);
        if (sha256Of(materialize(entry.parts)) !== entry.sha256) {
          problems.push(`${group} ${entry.id} 拆段拼回值与登记 sha256 不一致（拆段被改动 → 已悄悄变成另一个串）`);
        }
      }
    }
    for (const entry of REGISTERED_REPLACEMENTS) {
      const value = materialize(entry.parts);
      if (!SHAPE_IDS.some((id) => shapeMatches(SHAPES[id], value))) {
        problems.push(`${entry.id} 不命中任何形态——登记表变成死配置，扣减等于没扣`);
      }
    }
    for (const entry of ANCHORS) {
      const value = materialize(entry.parts);
      if (countOccurrences(source, value) !== 0) {
        problems.push(`${entry.id} 的连续串出现在守卫自身源码里——守卫自己的提交会把锚点计数顶起来，判别力归零`);
      }
      if (SHAPE_IDS.some((id) => shapeMatches(SHAPES[id], value))) {
        problems.push(`${entry.id} 命中某个形态——它会跟四类靶子互相干扰，不能当锚点`);
      }
    }
    expect(
      problems,
      ['守卫自身或登记表结构被破坏：', ...problems, '修法：恢复拆段与 sha256 的对应关系，不要删除断言。'].join('\n'),
    ).toEqual([]);
  });

  it('扫描范围自校验：patch 体量、--all commit 数、diff 文件数不低于下限（防假绿）', (ctx) => {
    if (SHALLOW) return ctx.skip(SKIP_REASON);
    const scan = scanHistory();
    const scopeFailure = [
      '扫描范围不对——这是假绿模式，比漏扫更危险：',
      `  patch 字节 ${scan.patchBytes}（下限 ${MIN_PATCH_BYTES}）`,
      `  --all commit 数 ${scan.allCommits}（下限 ${MIN_ALL_COMMITS}）`,
      `  patch 内 commit 头 ${scan.patchCommits}（下限 ${MIN_PATCH_COMMITS}）`,
      `  diff 覆盖去重文件 ${scan.patchFiles}（下限 ${MIN_PATCH_FILES}）`,
      '常见成因：浅克隆（那种环境应显式 skip 而不是走到这里）、把 --all 换成单分支/单文件、',
      '或在非仓库根目录跑。修扫描范围，不要动形态与登记表。',
    ].join('\n');
    expect(scan.patchBytes, scopeFailure).toBeGreaterThanOrEqual(MIN_PATCH_BYTES);
    expect(scan.allCommits, scopeFailure).toBeGreaterThanOrEqual(MIN_ALL_COMMITS);
    expect(scan.patchCommits, scopeFailure).toBeGreaterThanOrEqual(MIN_PATCH_COMMITS);
    expect(scan.patchFiles, scopeFailure).toBeGreaterThanOrEqual(MIN_PATCH_FILES);
  });
});
