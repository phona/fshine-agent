/**
 * 计划确认门装配接线的测试（D-063：`loadPlanStatus` → `verifyActivatable` 曾无任何测试）。
 *
 * 安全语义：用户说"确认继续"时，宿主必须先问平台这条待确认计划**还活着吗**——被新计划
 * 取代了就给确定性解释（handler 的 superseded 分支），而不是把失败吞成一句"处理失败"。
 * 这条链此前只有底层单测（替身 stub），没有任何测试断言 assembly/ask.ts 真的把
 * `loadPlanStatus` 接进了 `verifyActivatable`——删掉那三行接线，全库依旧全绿。
 *
 * 本测试因此走**真工厂 + 真仓库 + 假平台 CLI**（临时目录里的网关壳脚本，不触网、
 * 不开浏览器），并带一条变异锁：接线必须真的向平台发起 `plan status` 查询（把注入删掉
 * 即红），被取代的计划不得进入 `plan activate`。
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqlitePendingPlanConfirmationRepo } from '@fshine/core';
import { createPlanConfirmationWiring } from './plan-confirmation-route';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 假平台根：网关可执行文件按预置文件应答 plan status / plan activate，并把每次调用记进 calls.log。 */
function fakePlatformRoot(): { root: string; calls: () => string[]; setStatus: (status: string) => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'plan-confirm-wiring-'));
  roots.push(root);
  mkdirSync(path.join(root, 'bin'));
  const bin = path.join(root, 'bin');
  writeFileSync(path.join(bin, 'status.json'), JSON.stringify({ planId: 'plan_1', version: 3, status: 'pending' }));
  const script = [
    '#!/bin/sh',
    'echo "$@" >> "$(dirname "$0")/calls.log"',
    'if [ "$1" = "plan" ] && [ "$2" = "status" ]; then cat "$(dirname "$0")/status.json"; exit 0; fi',
    'if [ "$1" = "plan" ] && [ "$2" = "activate" ]; then cat > /dev/null; echo \'{"ok":true}\'; exit 0; fi',
    'echo "unexpected: $@" >&2; exit 2',
  ].join('\n');
  writeFileSync(path.join(root, 'bin', '17dz'), script);
  chmodSync(path.join(root, 'bin', '17dz'), 0o755);
  return {
    root,
    calls: () => {
      try { return readFileSync(path.join(root, 'bin', 'calls.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; }
    },
    setStatus: (status: string) => writeFileSync(path.join(bin, 'status.json'), JSON.stringify({ planId: 'plan_1', version: 3, status })),
  };
}

const PRINCIPAL = 'wecom:user_a';
const SESSION = 'wecom:wecom:user_a:conv_1';

function confirmText(messageId: string, text = '确认继续') {
  return { origin: 'wecom_user' as const, messageId, principalId: PRINCIPAL, sessionId: SESSION, text, receivedAt: new Date().toISOString() };
}

describe('计划确认门装配接线（D-063：verifyActivatable 真的接上了）', () => {
  it('平台说计划已被取代（status 非 pending）→ superseded 解释分支，且不激活', async () => {
    const platform = fakePlatformRoot();
    const dbPath = path.join(platform.root, 'agent.db');
    const wiring = createPlanConfirmationWiring({ dbPath, platformRoot: platform.root, planActivationSecret: 'test-secret' });

    await wiring.savePending({
      planId: 'plan_1', version: 3, taskId: 'task_1', principalId: PRINCIPAL, sessionId: SESSION,
      requestId: 'req_1', userText: '计划通知：查询范围扩大到 202601–202609。',
    });
    platform.setStatus('activated'); // 平台侧这条计划已经被新计划取代（不再是 pending）

    const result = await wiring.handle(confirmText('msg_superseded'));

    expect(result.status).toBe('superseded');
    expect(result).toMatchObject({ planId: 'plan_1', version: 3, taskId: 'task_1' });
    // 变异锁①：接线必须真的问过平台——删掉 verifyActivatable 注入即红
    expect(platform.calls().some((line) => line === 'plan status --plan-id plan_1')).toBe(true);
    // 变异锁②：被取代的计划不得进入激活（verify 不过就不该 activate）
    expect(platform.calls().some((line) => line.startsWith('plan activate'))).toBe(false);
    wiring.close();
  });

  it('平台说计划还活着（pending）→ 校验放行，确认后真激活', async () => {
    const platform = fakePlatformRoot();
    const dbPath = path.join(platform.root, 'agent.db');
    const wiring = createPlanConfirmationWiring({ dbPath, platformRoot: platform.root, planActivationSecret: 'test-secret' });

    await wiring.savePending({
      planId: 'plan_1', version: 3, taskId: 'task_1', principalId: PRINCIPAL, sessionId: SESSION,
      requestId: 'req_2', userText: '计划通知：查询范围扩大到 202601–202609。',
    });

    const result = await wiring.handle(confirmText('msg_confirmed'));

    expect(result.status).toBe('activated');
    expect(platform.calls().some((line) => line === 'plan status --plan-id plan_1')).toBe(true);
    expect(platform.calls().some((line) => line.startsWith('plan activate'))).toBe(true);
    wiring.close();
  });

  it('savePending 的落库形状：决策固定 confirm + TTL 单一来源（D-013）', async () => {
    const platform = fakePlatformRoot();
    const dbPath = path.join(platform.root, 'agent.db');
    const wiring = createPlanConfirmationWiring({ dbPath, platformRoot: platform.root, planActivationSecret: 'test-secret' });

    const before = Date.now();
    await wiring.savePending({
      planId: 'plan_1', version: 3, taskId: 'task_1', principalId: PRINCIPAL, sessionId: SESSION,
      requestId: 'req_3', userText: '计划通知：…',
    });
    // 同一库文件直接读回：TTL 必须是 10 分钟（PLAN_CONFIRMATION_TTL_MS），决策固定 confirm
    const rows = createSqlitePendingPlanConfirmationRepo(dbPath);
    const pending = await rows.listPending(PRINCIPAL, SESSION);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ planId: 'plan_1', version: 3, decision: 'confirm', evaluation: {} });
    const ttlMs = Date.parse(pending[0]!.expiresAt) - before;
    expect(ttlMs).toBeGreaterThan(9 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60_000);
    rows.close();
    wiring.close();
  });
});
