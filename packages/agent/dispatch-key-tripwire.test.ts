/**
 * U3 反向绊线（源码级 + 文案层）：故意破坏任一条都必须变红。
 *
 * 判据：
 *   G1 认领接口结构上不接受参数：OperationClaimInput 无 args 字段，决策函数不引用参数；
 *      禁止按参数文本/哈希绑定（源码里调 claim 的地方不拼 args）。
 *   G2 身份只在首次创建时铸造：`dk_` 键格式只出现在两处持久化实现（core store / 内存账），
 *      重试/恢复路径不得出现 randomUUID 造身份。
 *   G3 operations 表无内容唯一约束（args/参数哈希）——迁移测试另证 schema。
 *   G4 驱动把原生重放事件转述给宿主：pi-driver 订阅 compaction_end.willRetry 并调用
 *      onRuntimeEvent；runtime 在 Main/Worker/后台三处都接上它。
 *   G5 通知文案黑名单覆盖 dispatchKey / dk_ 身份形态。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotificationLanguageError, assertUserLanguage } from './src/notification-render';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('U3 反向绊线（源码级）', () => {
  it('G1 认领接口不含参数：OperationClaimInput 无 args，决策函数不读参数', () => {
    const registry = stripComments(read('packages/agent/src/task-registry.ts'));
    const interfaceBody = registry.slice(
      registry.indexOf('export interface OperationClaimInput'),
      registry.indexOf('}', registry.indexOf('export interface OperationClaimInput')),
    );
    expect(interfaceBody).not.toMatch(/\bargs\b/);
    const decideBody = registry.slice(
      registry.indexOf('export function decideOperationClaim'),
      registry.indexOf('export function operationStatusOf'),
    );
    expect(decideBody).not.toMatch(/\bargs\b/);
  });

  it('G2 身份键只在两处持久化实现里派生；重试路径不出现 randomUUID 造身份', () => {
    const store = stripComments(read('packages/core/src/task-store.ts'));
    const memory = stripComments(read('packages/agent/src/task-registry.ts'));
    expect(store).toMatch(/return `dk_\$\{scopeKey\}:\$\{opSeq\}`/);
    expect(memory).toMatch(/`dk_\$\{scopeKey\}:\$\{opSeq\}`/);
    // 身份铸造/绑定路径不掷新 UUID（requestId 的 randomUUID 在 runtime，不在账里）。
    expect(memory).not.toMatch(/randomUUID/);
    expect(store).not.toMatch(/randomUUID/);
  });

  it('G3 账表唯一约束只表达身份（dispatch_key 主键 + scope/op_seq），无参数内容列', () => {
    const store = stripComments(read('packages/core/src/task-store.ts'));
    const operationsSchema = store.slice(
      store.indexOf('CREATE TABLE IF NOT EXISTS operations'),
      store.indexOf(');', store.indexOf('CREATE TABLE IF NOT EXISTS operations')),
    );
    expect(operationsSchema).toMatch(/dispatch_key TEXT PRIMARY KEY/);
    expect(operationsSchema).toMatch(/UNIQUE \(scope_key, op_seq\)/);
    expect(operationsSchema).not.toMatch(/\bargs\b/);
    expect(operationsSchema).not.toMatch(/hash/i);
  });

  it('G4 驱动转述原生重放事件，runtime 三处执行面都接线 onRuntimeEvent', () => {
    const driver = stripComments(read('packages/agent/src/pi-driver.ts'));
    expect(driver).toMatch(/event\.type === 'compaction_end'/);
    expect(driver).toMatch(/willRetry/);
    expect(driver).toMatch(/onRuntimeEvent\?\.\(\{ kind: 'recovery', reason: 'compaction' \}\)/);
    // P0：529 自动重试路径也必须是窗口信号——auto_retry_start 与失败 assistant message_end。
    expect(driver).toMatch(/event\.type === 'auto_retry_start'/);
    const autoRetryBlock = driver.slice(
      driver.indexOf("event.type === 'auto_retry_start'"),
      driver.indexOf("event.type === 'message_end'"),
    );
    expect(autoRetryBlock).toMatch(/onRuntimeEvent\?\.\(\{ kind: 'recovery', reason: 'auto_retry' \}\)/);
    expect(driver).toMatch(/stopReason === 'error'[\s\S]{0,400}reason: 'auto_retry'/);
    const runtime = stripComments(read('packages/agent/src/execution-runtime.ts'));
    const wired = [...runtime.matchAll(/onRuntimeEvent: \(event\) => noteRuntimeEvent\(/g)];
    // Main 回合 + inline Worker 回合 + 后台 TaskExecutor 回合。
    expect(wired.length).toBe(3);
  });

  it('G6 装配层显式传执行面派生的只读集合，不用 allowedOperations 冒充', () => {
    const askRuntime = stripComments(read('scripts/ask-runtime.ts'));
    // createSession 与 createTaskExecutor 两处都必须是显式字段。
    expect(askRuntime.match(/readOnlyOperations: face\.readOnlyOperations/g)?.length).toBe(2);
    expect(askRuntime).not.toMatch(/readOnlyOperations: face\.allowedOperations/);
  });
});

describe('G5 通知文案不得泄露内部身份形态', () => {
  it('dispatchKey / dk_ 形态被黑名单拒绝', () => {
    expect(() => assertUserLanguage('任务用了 dispatchKey 去重。')).toThrow(NotificationLanguageError);
    expect(() => assertUserLanguage('身份是 dk_task:abc:1。')).toThrow(NotificationLanguageError);
    expect(() => assertUserLanguage('办完了：整理周报。')).not.toThrow();
  });
});
