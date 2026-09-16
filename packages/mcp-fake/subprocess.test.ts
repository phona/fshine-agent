import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { READ_TOOLS } from '@fshine/contracts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

class FakeServerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly receivedIds: Array<string | number | null> = [];
  exitCode: number | null = null;

  private readonly waiters = new Map<string, (value: Record<string, unknown>) => void>();
  private readonly exitWaiters: Array<(code: number | null) => void> = [];
  private nextId = 0;

  constructor(env: Record<string, string>) {
    this.child = spawn('npx', ['tsx', 'packages/mcp-fake/src/main.ts'], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed === '') return;
      const msg = JSON.parse(trimmed) as Record<string, unknown>;
      const id = msg['id'];
      if (typeof id === 'number' || typeof id === 'string' || id === null) this.receivedIds.push(id);
      const waiter = this.waiters.get(String(id));
      if (waiter) {
        this.waiters.delete(String(id));
        waiter(msg);
      }
    });
    this.child.stderr.on('data', () => {});
    this.child.on('exit', (code) => {
      this.exitCode = code;
      for (const waiter of this.exitWaiters.splice(0)) waiter(code);
    });
  }

  request(method: string, params?: unknown): number {
    const id = ++this.nextId;
    const body: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) body.params = params;
    this.child.stdin.write(`${JSON.stringify(body)}\n`);
    return id;
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  waitResponse(id: number, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待响应 id=${id} 超时`)), timeoutMs);
      this.waiters.set(String(id), (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  waitExit(timeoutMs = 30_000): Promise<number | null> {
    if (this.exitCode !== null) return Promise.resolve(this.exitCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待进程退出超时')), timeoutMs);
      this.exitWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await this.waitExit();
  }
}

describe('stdio 子进程端到端(npx tsx src/main.ts)', () => {
  it('initialize → notifications/initialized(无回包) → tools/list → tools/call 全流程', { timeout: 60_000 }, async () => {
    const proc = new FakeServerProcess({});

    const initId = proc.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'tax-agent', version: '0.1.0' },
    });
    const initResponse = await proc.waitResponse(initId);
    const initResult = initResponse['result'] as Record<string, unknown>;
    expect(initResult['protocolVersion']).toBe('2025-06-18');
    expect(initResult['capabilities']).toEqual({ tools: {} });
    expect(initResult['serverInfo']).toEqual({
      name: '17dz-read',
      version: '0.1.0',
      specVersion: '0.5',
      allowedAccountSets: null,
    });

    proc.notify('notifications/initialized');

    const listId = proc.request('tools/list');
    const listResponse = await proc.waitResponse(listId);
    const tools = (listResponse['result'] as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual([...READ_TOOLS]);

    // 通知不得产生回包:目前收到的响应 id 恰好是两个请求的 id
    expect(proc.receivedIds).toEqual([initId, listId]);

    const callId = proc.request('tools/call', {
      name: 'search_account_sets',
      arguments: { query: '幻晟' },
    });
    const callResponse = await proc.waitResponse(callId);
    const result = callResponse['result'] as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.type).toBe('text');
    const envelope = JSON.parse(result.content[0]!.text) as {
      data: { accountSets: Array<{ id: string; name: string }> };
      meta: Record<string, unknown>;
    };
    expect(envelope.data.accountSets.map((a) => a.id)).toEqual(['as_001', 'as_002']);
    expect(envelope.meta.source).toBe('api_cache');
    expect(String(envelope.meta.traceId)).toMatch(/^trc_/);
    expect(String(envelope.meta.retrievedAt)).toMatch(/\+08:00$/);

    await proc.close();
    expect(proc.exitCode).toBe(0);
  });

  it('FAKE_CRASH_AFTER_N_CALLS=1:第一次 tools/call 回包后进程 exit(1)', { timeout: 60_000 }, async () => {
    const proc = new FakeServerProcess({ FAKE_CRASH_AFTER_N_CALLS: '1' });

    const initId = proc.request('initialize', {});
    await proc.waitResponse(initId);
    proc.notify('notifications/initialized');

    const callId = proc.request('tools/call', { name: 'get_login_status', arguments: {} });
    const callResponse = await proc.waitResponse(callId);
    expect((callResponse['result'] as { isError: boolean }).isError).toBe(false);

    const code = await proc.waitExit();
    expect(code).toBe(1);
  });
});
