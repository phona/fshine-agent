/**
 * P1-T02 跨进程并发分配测试夹具（非产品代码）：以真实注册表向同一底账库写入 N 条任务。
 *
 * 用法：node --import tsx tests/p1-concurrent-writer.ts <dbPath> <count> <prefix>
 * 退出码：0 = 全部写入成功；2 = 参数缺失。
 */
import { createSqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';

const [dbPath, countRaw, prefix] = process.argv.slice(2);
if (dbPath === undefined || countRaw === undefined || prefix === undefined) {
  console.error('用法：node --import tsx tests/p1-concurrent-writer.ts <dbPath> <count> <prefix>');
  process.exit(2);
}
const count = Number(countRaw);
if (!Number.isInteger(count) || count <= 0) {
  console.error(`数量无效：${countRaw}`);
  process.exit(2);
}

const registry = createSqliteTaskRegistry(dbPath);
for (let index = 0; index < count; index += 1) {
  registry.begin({
    taskId: `${prefix}_${index}`,
    principalId: 'wecom:concurrent',
    sessionId: 'p1-t02',
    request: `并发任务 ${prefix}-${index}`,
  });
}
registry.close();
