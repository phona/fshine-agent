/**
 * 执行层声明义务守卫（owner 2026-11-19）：**结构化入参必须声明 payload**。
 *
 * 为什么是义务而不是风格：宿主只有读到 `payload` 声明才会 lint → 物化文件 → 把路径交给
 * 执行层。没声明 = 宿主无法 lint，模型只能自己手拼 JSON 字符串——实测单个回合 34 次工具
 * 调用、大半是 `--records` 传成 JSON 字符串被拒。宿主判断不出某个字符串参数「其实是结构化
 * 数据」（按名字/描述猜语义是判据红线），所以只能由执行层在声明里写明。
 *
 * 判据不用关键词扫 desc（那样改个词就绕过，也会误伤）：
 *   ① 白名单：仓内已知的结构化参数逐条断言带 `payload` + `schema`；
 *   ② 机械形状：协议型 operation（`proposal.create`，对端要读契约文件）必须有 payload 位置参数；
 *   ③ 退役形态：`records` 不得退回普通 flag（回退即红，提示"这个参数是结构化入参，再去声明 payload"）。
 *
 * 反向绊线（人工实测后还原）：把 `dummy.prepare` 的 records 改回普通 flag → ①/③ 红。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface ArgDeclaration {
  name?: string;
  flag?: string;
  required?: boolean;
  payload?: { schema?: unknown };
  desc?: string;
}

interface OperationDeclaration {
  name?: string;
  protocol?: string | null;
  args?: { positional?: ArgDeclaration[]; flags?: ArgDeclaration[] };
}

interface Capabilities {
  operations?: OperationDeclaration[];
}

const FIXTURE_ROOT = path.resolve(__dirname, 'eval', 'fixtures', 'dummy-platform');
const BIN = path.join(FIXTURE_ROOT, 'bin', 'dummy');

/**
 * 仓内已知的结构化入参白名单（数组 / 对象 / 多字段契约文件）。
 * **新增这类参数时必须登记在这里**——守卫逐条断言其带 `payload` 声明；漏登记不会
 * 自动发现（宿主也无法自动发现），所以登记本身就是声明义务的可见面。
 */
const STRUCTURED_ARGS = [
  { operation: 'dummy.prepare', param: 'records' },
  { operation: 'dummy.commit', param: 'records' },
  { operation: 'dummy.proposal', param: 'payload' },
  { operation: 'ballot.proposal', param: 'payload' },
] as const;

/** 有效声明面 = 宿主实际看到的那份（`operation list --json`）：fixture 的 `payload:true`
 *  标记在这里已展开成 `{schema}`，守卫断言的就是宿主能否 lint。 */
function loadOperations(): OperationDeclaration[] {
  const run = spawnSync(BIN, ['operation', 'list', '--json'], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`operation list 失败（exit ${String(run.status)}）：${run.stderr}`);
  const parsed = JSON.parse(run.stdout) as Capabilities;
  return parsed.operations ?? [];
}

/** 参数声明在位置参数或 flag 里的命中形态（结构化入参必须是位置参数路径，不给 flag 形态留口子）。 */
function declaredArgOf(operation: OperationDeclaration | undefined, param: string): ArgDeclaration | undefined {
  const positional = operation?.args?.positional ?? [];
  const hit = positional.find((entry) => entry.name === param);
  if (hit !== undefined) return hit;
  return (operation?.args?.flags ?? []).find((entry) => entry.flag === param || entry.flag === `--${param}`);
}

const MISSING_HINT = '这个参数是结构化入参，再去声明 payload（宿主无法 lint，模型只能手写 JSON 字符串）';

describe('执行层声明义务：结构化入参必须声明 payload', () => {
  it('① 白名单里的结构化入参都存在且带 payload + schema', () => {
    const operations = loadOperations();
    for (const entry of STRUCTURED_ARGS) {
      const operation = operations.find((candidate) => candidate.name === entry.operation);
      expect(operation, `缺少 operation ${entry.operation}`).toBeDefined();
      const declared = declaredArgOf(operation, entry.param);
      expect(declared, `${entry.operation} 缺少结构化参数 ${entry.param}：${MISSING_HINT}`).toBeDefined();
      expect(declared?.payload, `${entry.operation} 的 ${entry.param} 没有 payload 声明：${MISSING_HINT}`).toBeDefined();
      expect(
        declared?.payload?.schema,
        `${entry.operation} 的 ${entry.param} 的 payload 必须带 schema（否则宿主无法 lint）`,
      ).toBeDefined();
    }
  });

  it('② 协议型 operation（proposal.create）必须有 payload 位置参数（契约文件归执行层读，形状必须可 lint）', () => {
    const operations = loadOperations();
    const protocolOperations = operations.filter((operation) => operation.protocol === 'proposal.create');
    expect(protocolOperations.length).toBeGreaterThan(0);
    for (const operation of protocolOperations) {
      const payloads = (operation.args?.positional ?? []).filter((entry) => entry.payload !== undefined);
      expect(
        payloads.length,
        `${operation.name} 是对端读契约文件的协议型 operation，必须声明 payload 位置参数：${MISSING_HINT}`,
      ).toBeGreaterThan(0);
    }
  });

  it('③ records 不得退回普通 flag（--records 会把结构化值降级成模型手写字符串）', () => {
    const operations = loadOperations();
    for (const name of ['dummy.prepare', 'dummy.commit']) {
      const operation = operations.find((candidate) => candidate.name === name);
      expect(operation, `缺少 operation ${name}`).toBeDefined();
      const legacyFlag = (operation?.args?.flags ?? []).find((entry) => entry.flag === '--records');
      expect(
        legacyFlag,
        `${name} 的 --records 已退役：records 是结构化入参，必须声明为 payload 位置参数（宿主 lint 后物化文件）`,
      ).toBeUndefined();
    }
  });

  it('④ 每一条 payload 声明都必须带 schema，且顶层类型是 array/object（宿主只物化结构化值）', () => {
    for (const operation of loadOperations()) {
      const declared = [
        ...(operation.args?.positional ?? []),
        ...(operation.args?.flags ?? []),
      ].filter((entry) => entry.payload !== undefined);
      for (const entry of declared) {
        const name = entry.name ?? entry.flag ?? '(unnamed)';
        const schema = entry.payload?.schema as { type?: unknown } | undefined;
        expect(schema, `${operation.name} 的 ${name}：payload 必须带 schema`).toBeDefined();
        expect(
          ['array', 'object'].includes(String(schema?.type)),
          `${operation.name} 的 ${name}：payload schema 顶层类型必须是 array/object（当前 ${String(schema?.type)}）`,
        ).toBe(true);
      }
    }
  });
});
