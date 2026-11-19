/**
 * SimCase 用例套件 · 夹具声明（只给 Harness；不得进入模拟用户 prompt）。
 *
 * 三个用例共用仓内 dummy 执行层的**缺省种子**（`bin/dummy.cjs` 的 `seedState()`）：
 * 首次以 `--state-dir <trial>/state` 调用时自建数据，不需要预置文件，也不触网。
 *
 * SIM-05 的「已知失败」不是宿主注入接缝，而是夹具数据字段：
 * `faulty-one.readFault = true` → 任何窗口的 `dummy.query` 都返回
 * `failed / COLLECTION_FAULT`（exit 2、无载荷）。它绑在**数据**上，每次调用确定性复现，
 * 不挂墙钟、不依赖 ask 装配暴露注入接缝（ask 装配当前不暴露，见 `../ask-adapter`）。
 */

export interface SimFixtureDeclaration {
  readonly id: string;
  readonly kind: 'dummy-cli-default-seed';
  /** 仓内相对路径（提交信息禁绝对路径；这里只是声明，不参与 prompt）。 */
  readonly fixtureRoot: string;
  /** 声明式 S1 fixture 的 scenario id（`scenarios/<id>/scenario.json`）；缺省 = 平台固定 scenario。 */
  readonly scenario?: string;
  readonly collections: readonly string[];
  /** 数据驱动的确定性故障（不是注入接缝）。 */
  readonly deterministicFaults: readonly {
    readonly collection: string;
    readonly field: string;
    readonly effect: string;
  }[];
  readonly note: string;
}

export const SIM_FIXTURES: readonly SimFixtureDeclaration[] = Object.freeze([
  {
    id: 'dummy-platform:default',
    kind: 'dummy-cli-default-seed',
    fixtureRoot: 'scripts/eval/fixtures/dummy-platform',
    collections: ['alpha', 'faulty-one'],
    deterministicFaults: [
      {
        collection: 'faulty-one',
        field: 'readFault',
        effect: 'dummy.query 返回 failed / COLLECTION_FAULT（exit 2，无载荷）',
      },
    ],
    note: 'dummy 首次在任何 state-dir 调用时按 seedState() 自建；每 trial 的 state-dir 独立，互不共享。',
  },
  {
    id: 'dummy-platform:finance',
    kind: 'dummy-cli-default-seed',
    fixtureRoot: 'scripts/eval/fixtures/dummy-platform',
    scenario: 'dummy-finance',
    collections: ['finance-invoices', 'finance-receipts', 'finance-writeoffs', 'finance-mingda-receipts'],
    deterministicFaults: [
      {
        collection: 'finance-mingda-receipts',
        field: 'scenario.faults[kind=read_fault]',
        effect: 'dummy.query 返回 failed / COLLECTION_FAULT（exit 2，无载荷），由声明式 loader 按声明短路',
      },
    ],
    note: [
      '数据 = scripts/eval/fixtures/scenarios/dummy-finance/datasets/finance-*.json；',
      'finance-invoices 声明 dimension customer（--where customer=<客户> 过滤），',
      'finance-mingda-receipts 是场景 5 的「未同步」集合（数据驱动故障，不是注入接缝）。',
      'Oracle 真值（scripts/eval/finance/dataset.ts）与本夹具读同一份 JSON，不存在第二份镜像。',
    ].join(''),
  },
  {
    id: 'dummy-platform:write',
    kind: 'dummy-cli-default-seed',
    fixtureRoot: 'scripts/eval/fixtures/dummy-platform',
    collections: ['alpha'],
    deterministicFaults: [
      {
        collection: 'alpha',
        field: 'receiptLoss',
        effect: '写入已生效但宿主拿不到回执（SIM-10；由 ../write-system 确定性注入，不是产品行为）',
      },
    ],
    note: [
      '写场景（SIM-09/10）用 ../write-system 的确定性假系统：ask 装配当前只开放读切片',
      '（scripts/ask-runtime.ts 的 allowedOperations = 只读集合），真实跑批到不了 dummy.commit。',
      '因此写场景单列在 SIM_WRITE_CASES，不冒充「产品已支持写」。',
    ].join(''),
  },
  {
    id: 'dummy-platform:interaction',
    kind: 'dummy-cli-default-seed',
    fixtureRoot: 'scripts/eval/fixtures/dummy-platform',
    scenario: 'dummy-finance',
    collections: ['documents', 'denied-one'],
    deterministicFaults: [
      {
        collection: 'denied-one',
        field: 'scenario.faults[kind=restricted]',
        effect: 'dummy.query 返回 GATE_REFUSE（exit 3，无载荷）：集合对当前调用方受限，任何查询都确定性被拒',
      },
      {
        collection: 'documents',
        field: '（无故障）',
        effect: '两个窗口 W202610/W202611 返回同一批 items（document-1/1200、document-2/800、document-2/900）',
      },
    ],
    note: [
      '交互用例（SIM-INT-01/02）用缺省平台场景 dummy-finance（capabilities.json 的 scenario）：',
      'documents 提供带窗口只读数据；denied-one 提供确定性「无权限」失败（GATE_REFUSE）。',
      '本夹具只声明可达性，不进模拟用户 prompt。',
    ].join(''),
  },
]);

export function resolveFixtureDeclaration(id: string): SimFixtureDeclaration {
  const fixture = SIM_FIXTURES.find((entry) => entry.id === id);
  if (fixture === undefined) throw new Error(`未知 fixtureId：${id}（不回落任何缺省夹具）`);
  return fixture;
}
