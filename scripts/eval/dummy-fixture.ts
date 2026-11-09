/**
 * dummy 夹具事实表（探针与金额判据共用的**单一转录点**）。
 *
 * 这里只放"夹具种子是什么"的事实：collection 目录、items、值、window 结构。除
 * MOCK_ABSENT_COLLECTIONS（用例查询过、平台答过 not_found 的对象名——case 级事实，见
 * 那里）外，全部逐条抄自 scripts/eval/fixtures/dummy-platform/bin/dummy.cjs 的
 * seedState()（collections[*] 的 items/windows/locked），不臆造；改动任何数字前先重读
 * 夹具种子。判据语义（怎么用这些事实判）归 amount-criteria.ts 与探针各 helper，本模块
 * 不做判定。
 *
 * 抽成独立模块的原因（2026-11-07 评审 blocking：错误态实体绑定要有变异测试）：探针
 * scripts/probe-real-agent.ts 顶层就跑 main()（真实 LLM 装配），测试无法 import；把
 * 事实表与纯判据抽到这里后，amount-criteria.test.ts 才能把评审的反例形态钉成表征锁。
 */

/** mock collection目录（seedState 全部 9 个 collection，empty-one 曾漏收——2026-11-08 评审）：
 * X1 换collection/总结覆盖、X2 域混淆判定、collectionQueryHits 的名单来源。 */
export const MOCK_ACCOUNTS = ['alpha', 'alpha-group', 'beta', 'locked-one', 'empty-one', 'contoso-trade', 'contoso-logistics', 'fabrikam-retail', 'fabrikam-wholesale'] as const;

/**
 * mock 各 collection 的 item 清单（X2 第1轮 D-073 判定的"数据在手"依据）。
 * 移植前这里是按 collection 列的 customer 辅助档案（alpha 3 家 / alpha-group 1 家），
 * dummy 夹具没有 customer 维度，同源判据改按"查询真实命中的 collection 的 items"度量：
 * 模型查过 collection X 之后，X 的 item 名就是它手上有的数据。
 * empty-one 的 items 为空数组（零命中不算"数据在手"，与原版"查空不算命中"同语义）。
 */
export const MOCK_ITEMS: Readonly<Record<string, readonly string[]>> = {
  alpha: ['alpha-item-1', 'alpha-item-2'],
  beta: ['beta-item-1', 'beta-item-2', 'beta-item-3'],
  'alpha-group': ['alpha-group-item-1'],
  'locked-one': ['locked-item-1'],
  'empty-one': [],
  'contoso-trade': ['contoso-trade-item-1', 'contoso-trade-item-2'],
  'contoso-logistics': ['contoso-logistics-item-1'],
  'fabrikam-retail': ['fabrikam-retail-item-1'],
  'fabrikam-wholesale': ['fabrikam-wholesale-item-1'],
};

/**
 * 各 collection 的有效 window（seedState collections[*].windows 抄录）：夹具 doQuery 对
 * window 不在 col.windows 里的查询回 WINDOW_NO_DATA（not_found），没有 items 可给。
 * collectionQueryHits 的"成功查询"重算与错误态金额的 window×实体有效性都以此为准
 * （2026-11-07 评审 major/blocking："beta W2 record value is 500"——beta 只有 W1，
 * 该组合是无数据 window，挂上去的金额无据）。
 */
export const MOCK_COLLECTION_WINDOWS: Readonly<Record<string, readonly string[]>> = {
  alpha: ['W1', 'W2'],
  beta: ['W1'],
  'alpha-group': ['W1'],
  'locked-one': ['W1'],
  'empty-one': ['W1'],
  'contoso-trade': ['W1', 'W2'],
  'contoso-logistics': ['W1'],
  'fabrikam-retail': ['W1'],
  'fabrikam-wholesale': ['W1'],
};

/**
 * mock window 码表（Y2 错误态金额判定的"有所属"依据）。
 *
 * 决策记录（原 MOCK_WINDOWS = [] 的端口缺陷）：移植前这里是**field 码表**（码与名成对，
 * 从 mock-state.json 各 collection 的 subjects 并集读出），dummy 夹具**没有 field 维度**
 * （dummy.query 只声明 --collection/--window，见 OPERATIONS），端口时留成空数组。空数组让
 * errorStateNotes 的归属豁免 `!MOCK_WINDOWS.some(...)` 恒为真——每一笔非零金额都被判
 * "无所属"，与 2026-09-29 校准注释（field missing 轮可以引用真实佐证金额）直接矛盾。
 *
 * 选 (a) 码制归属而不选 (b) 删豁免：dummy 域里错误态回复**确有**真实数据可引——field
 * missing 轮（Y2 T3 "check beta 的 payable balance"）诚实的答法就是"平台没有 payable
 * 这个口径，beta W1 的 record value 是 500/300/200"。删豁免会把这种诚实佐证判红，
 * 正是校准注释记录的误报形态；而 dummy 夹具里与 field 同构的维度是 **window**
 * （每个 collection 有 windows，码全局唯一）。故归属维度从 field 换成 window 码，
 * 语义同构：金额所在分句点名了**用户没问的 window 码**即"有所属"（那是模型在引用
 * 手头别的真实数据），挂在所问 window 上或无所属才红。
 * 夹具只有码没有人类别名，故 name 与 code 同值（windowMentioned 的 YYYYMM 分支原样保留，
 * 兼容移植前语料里 "2026年06月" 这类月份读法）。
 */
export const MOCK_WINDOWS: ReadonlyArray<{ code: string; name: string }> = [...new Set(Object.values(MOCK_COLLECTION_WINDOWS).flat())]
  .map((code) => ({ code, name: code }));

/**
 * dummy 夹具 items[].id（seedState 抄录）：模型回复里常写成 "(rec-101)"，与 item 名同源。
 */
export const MOCK_ITEM_IDS: readonly string[] = ['rec-001', 'rec-002', 'rec-101', 'rec-102', 'rec-103', 'rec-201', 'rec-301', 'rec-401', 'rec-402', 'rec-501', 'rec-601', 'rec-701'];

/**
 * 记录号 → 所属 collection 与真实值（夹具种子的第三维，2026-11-07 评审 blocking ③：
 * 记录号此前只当"指向"证据、不进实体绑定表，于是 "rec-101 record value is 1200" 全绿
 * ——rec-101 属 beta、真实值 500，1200 是 alpha 的。纯表格形态的回显记录号是合法形态
 * （"| beta-item-1 (rec-101) | 500 |"），所以修法不是禁用记录号，而是把它接进同一条
 * 实体绑定路径：分句点名记录号 = 点名该记录所属的实体，金额必须对上**这条记录**的值。
 * 与 MOCK_ITEM_VALUES 同源转录：改动任何数字前先重读夹具种子（seedState）。
 */
export const MOCK_ITEM_ID_BINDINGS: Readonly<Record<string, { entity: string; value: number }>> = {
  'rec-001': { entity: 'alpha', value: 1200 },
  'rec-002': { entity: 'alpha', value: 800 },
  'rec-101': { entity: 'beta', value: 500 },
  'rec-102': { entity: 'beta', value: 300 },
  'rec-103': { entity: 'beta', value: 200 },
  'rec-201': { entity: 'alpha-group', value: 700 },
  'rec-301': { entity: 'locked-one', value: 900 },
  'rec-401': { entity: 'contoso-trade', value: 1500 },
  'rec-402': { entity: 'contoso-trade', value: 600 },
  'rec-501': { entity: 'contoso-logistics', value: 450 },
  'rec-601': { entity: 'fabrikam-retail', value: 880 },
  'rec-701': { entity: 'fabrikam-wholesale', value: 1320 },
};

/**
 * dummy 夹具 items[].value（seedState 抄录，item 名 → 真实数值）。错误态金额归属的
 * **值核对**依据：分句里出现真实数据标识只证明"这笔钱有出处指向"，不证明数字本身
 * 是真的——"beta-item-1 payable balance is 999999" 同样带标识，而夹具里 beta-item-1
 * 的真实 value 是 500、且根本没有 payable 口径（2026-11-07 评审 blocking ③）。
 */
export const MOCK_ITEM_VALUES: Readonly<Record<string, number>> = {
  'alpha-item-1': 1200, 'alpha-item-2': 800,
  'beta-item-1': 500, 'beta-item-2': 300, 'beta-item-3': 200,
  'alpha-group-item-1': 700,
  'locked-item-1': 900,
  'contoso-trade-item-1': 1500, 'contoso-trade-item-2': 600,
  'contoso-logistics-item-1': 450,
  'fabrikam-retail-item-1': 880,
  'fabrikam-wholesale-item-1': 1320,
};

/** 夹具种子里的全部真实数值（去重）：归属判据的"值也得对得上"全集。 */
export const REAL_DATA_VALUES: readonly number[] = [...new Set(Object.values(MOCK_ITEM_VALUES))];

/**
 * 用例查询过的**不存在对象名**（2026-11-09 仲裁 2 收口：case 级已知事实，不是词法猜测）：
 * Y2 第 1 轮（cases.yaml 的 A4 / Y2 T0）只查目录找一个平台上没有的 collection——
 * gamma-collection。夹具对它的确定性答案是 not_found（candidates 为空，见 dummy.cjs
 * resolveCollection 的 COLLECTION_NOT_FOUND 分支），因此"gamma-collection 有任何非零值"
 * 在任何 window 下都是假的。
 *
 * 为什么登记成表而不是靠词法猜：把金额挂给一个**平台已答不存在**的名字，与挂给 empty-one
 * （存在但零值）同属假归属，都应被既有绑定判据收口（values.includes 恒假 ⇒ misbound）。
 * 但"哪个名字不存在"只有用例查询历史知道——模型回复里任意一个陌生 token 没有外部事实
 * 可对，词法猜测（连字符/下划线形状）会把 well-known、rec-XXX 这种普通复合词与申报
 * 指令占位符一起吞进来，在共享黑盒路径上造假红。故只登记**用例真的查过、平台真的答了
 * not_found** 的名字；凭空名字（foo-item-1 之类）不登记、不进最近前置绑定（正文用显式
 * 归属措辞挂给它时，amount-criteria 的 unregisteredAttribution 单列一维）。
 */
export const MOCK_ABSENT_COLLECTIONS: readonly string[] = ['gamma-collection'];

/**
 * 实体绑定表（2026-11-07 评审 blocking：错误态金额不能只对全局数值集核对）：collection →
 * 该 collection 各 item 的真实值；item 名 → 单值；**记录号 → 该记录的真实值**（第三维，
 * MOCK_ITEM_ID_BINDINGS——见那里的 blocking ③）；**不存在对象名 → 空值集**（第四维，
 * MOCK_ABSENT_COLLECTIONS——见那里的仲裁 2 记录）。empty-one 与 gamma-collection 都是
 * 空值集：点名它们的任何非零金额都无据（一个是存在但零命中，一个是平台答过不存在）。
 * 分句点名了表中实体时，金额必须属于**该实体**——
 * "beta payable balance is 1200"（1200 是 alpha 的真实值，beta 真实 500/300/200）按全局
 * 核对会放行，按实体绑定照红。这就是评审要的"按实际查询证据核对实体与数值"：夹具种子
 * 即平台真实数据面，回复里的数与点名实体的种子值对不上，就是没有查询证据支撑。
 */
export const ENTITY_REAL_VALUES: ReadonlyArray<{ name: string; values: readonly number[] }> = [
  ...Object.entries(MOCK_ITEMS).map(([collection, items]) => {
    const values = items.map((item) => MOCK_ITEM_VALUES[item]).filter((v): v is number => v !== undefined);
    return { name: collection, values: values as readonly number[] };
  }),
  ...Object.entries(MOCK_ITEM_VALUES).map(([item, value]) => ({ name: item, values: [value] })),
  // 记录号维度：点名 rec-101 = 点名 beta 的那条 500 记录（blocking ③）。
  ...Object.entries(MOCK_ITEM_ID_BINDINGS).map(([id, binding]) => ({ name: id, values: [binding.value] })),
  // 不存在对象维度：用例查过、平台答过 not_found 的名字登记为零值实体（仲裁 2）——
  // 挂任何非零金额都是假归属，与 empty-one 同走"点名实体而金额不属于它"的判据。
  ...MOCK_ABSENT_COLLECTIONS.map((name) => ({ name, values: [] as readonly number[] })),
];

/**
 * 错误态金额归属的**第二类**证据（item 名 + 记录号）：金额所在分句出现真实数据标识，
 * 说明这笔钱是平台真实数据的一行（"| beta-item-1 (rec-101) | 500 |"），不是编出来的答案。
 * 第一类是 window 码（MOCK_WINDOWS）：分句点名用户没问的 window。
 *
 * 为什么需要第二类（2026-11-07 Y2 首跑校准）：只认 window 码时，模型把真实数据放进
 * 表格的两种形态全部落空——T2 的未确认参照查询（alpha 的 1200/800）与 T3 的明细
 * （beta 的 500/300/200）都把 window 说明写在**引导句**里、金额在表格行里，分句级
 * 归属看不见，两批真实数据全被判"无所属"。那正是 2026-09-29 校准注释要防的误报形态
 * （"500 全程有所属，却被一条红"）。补上 item 名证据后，同一轮里真正编出来的答案
 * （T3 的 "**beta 的 payable balance：1000**"，所在分句既无 window 码也无 item 名）
 * 照旧红——尺子不松这条。
 *
 * 两类证据都**必须再过值核对**（REAL_DATA_VALUES，2026-11-07 评审 blocking ③）：
 * 光有标识不能证明数字真实——"beta-item-1 payable balance is 999999" 带标识但值不在
 * 种子里；光有真实值也不能证明归属——1200 出现在错误态回复里也可能是编的。两者同时
 * 满足（分句点名真实数据所在维度 + 金额是种子里的真实数值）才放行。
 *
 * 标识集合含 collection 名（2026-11-07 Y2 二跑校准）：not_found 轮模型重探索后会在回复里
 * 带上有归属的真实数据（"contoso-trade 的 W2 窗口下有两条记录（值 1500、600）"）——分句
 * 点名了真实 collection、金额是种子真实值，归属清清楚楚；只认 item 名/记录号时这波真实
 * 数据全被判无所属。collection 名与 item 名同一族：都是"分句点名了真实数据所在维度"，
 * 且都过同一道值核对——"beta 的 payable balance = 1,000" 点名 beta 但 1000 不是真实值，
 * 照旧红。
 */
export const REAL_DATA_TOKENS: readonly string[] = [...new Set([...Object.values(MOCK_ITEMS).flat(), ...MOCK_ITEM_IDS, ...MOCK_ACCOUNTS])];
