/**
 * A5 未声明退化守卫：清单里没有任何 capability 时——目录为空、Main 提示逐字节不变、
 * 无 capabilities() 工具、装配记一次性 capability_catalog_undeclared 事件（不按回合刷）。
 * 声明了 capability 时——摘要与 capabilities() 工具出现，事件不记。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assembleSessionCore } from './ask-runtime';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome, ExecutionRequest } from '@fshine/contracts/execution-contract';
import type { ExecutionEvent } from '../packages/agent/src/execution-runtime';
import type { TurnDriver } from '../packages/agent/src/driver-contract';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function faceClient(manifest: CapabilityManifest): ExecutionClient {
  return {
    async capabilities() { return manifest; },
    async execute(_r: ExecutionRequest): Promise<ExecutionOutcome> { return { status: 'completed' }; },
  };
}
const driver: TurnDriver = {
  async run(input) { return { text: 'ok', messages: [...input.messages] }; },
};

async function assemble(manifest: CapabilityManifest, events: ExecutionEvent[]): Promise<{ tools: string; prompt: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cap-catalog-asm-'));
  dirs.push(dir);
  const probe: string[] = [];
  const prompts: string[] = [];
  const withProbe: TurnDriver = {
    async run(input) {
      probe.push(...input.tools.map((t) => t.name));
      prompts.push(input.systemPrompt);
      return { text: 'ok', messages: [...input.messages] };
    },
  };
  const assembled = await assembleSessionCore({
    env: {}, profile: { root: dir, skillRoots: [], gateway: 'bin/dummy' },
    principalId: 'wecom:p', sessionId: `s_${dirs.length}`, dbPath: path.join(dir, 'state.db'), stateDir: dir,
    emptyOperationsMessage: '空允许集合',
    mainSystemPrompt: 'SERVER_PROMPT_BYTE_FOR_BYTE',
    createDrivers: () => ({ mainDriver: withProbe, workerDriver: driver }),
    createExecutionFace: async () => ({ client: faceClient(manifest), allowedOperations: ['a.query'], readOnlyOperations: ['a.query'] }),
    onExecutionEvent: (event) => events.push(event),
  });
  await assembled.session.send('probe');
  return { tools: probe.join(','), prompt: prompts.join('\n') };
}

const UNDECLARED: CapabilityManifest = {
  contractVersion: 4,
  operations: [{ name: 'a.query', access: 'read', args: [] }, { name: 'a.commit', access: 'write', args: [] }],
};
const DECLARED: CapabilityManifest = {
  contractVersion: 4,
  operations: [
    { name: 'a.query', access: 'read', capability: '记录办理', args: [] },
    { name: 'a.commit', access: 'write', capability: '记录办理', args: [] },
  ],
};

describe('A5 未声明退化 / 已声明派生（装配级）', () => {
  it('① 未声明 capability：记一次性 undeclared 事件，提示逐字节不变，无 capabilities 工具', async () => {
    const events: ExecutionEvent[] = [];
    const { tools, prompt } = await assemble(UNDECLARED, events);
    expect(events).toContainEqual({ event: 'capability_catalog_undeclared', principalId: 'wecom:p', sessionId: expect.any(String) });
    // 一次性：只有一条（不是按回合刷）。
    expect(events.filter((e) => e.event === 'capability_catalog_undeclared')).toHaveLength(1);
    expect(tools).not.toContain('capabilities');
    // 提示逐字节不变：没有追加任何摘要/行为句。
    expect(prompt).toBe('SERVER_PROMPT_BYTE_FOR_BYTE');
  });

  it('② 声明了 capability：不记 undeclared 事件，Main 摘要出现 + capabilities 工具', async () => {
    const events: ExecutionEvent[] = [];
    const { tools, prompt } = await assemble(DECLARED, events);
    expect(events.filter((e) => e.event === 'capability_catalog_undeclared')).toHaveLength(0);
    expect(tools).toContain('capabilities');
    expect(prompt).toContain('可办：记录办理（含写入）');
  });
});
