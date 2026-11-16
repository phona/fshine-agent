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
]);

export function resolveFixtureDeclaration(id: string): SimFixtureDeclaration {
  const fixture = SIM_FIXTURES.find((entry) => entry.id === id);
  if (fixture === undefined) throw new Error(`未知 fixtureId：${id}（不回落任何缺省夹具）`);
  return fixture;
}
