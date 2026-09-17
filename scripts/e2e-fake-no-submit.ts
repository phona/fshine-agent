/**
 * In-process Fake MCP E2E.
 * Exercises the agent-facing protocol without spawning a child process or
 * touching a browser. It deliberately never calls submit_* or workflow.confirm.
 */
import { strict as assert } from 'node:assert';
import { createFakeServerTransport, type FakeServerTransport } from '@fshine/mcp-fake';

let rpcId = 0;
const calledTools: string[] = [];

async function rpc(transport: FakeServerTransport, method: string, params?: unknown): Promise<Record<string, unknown>> {
  const request: Record<string, unknown> = { jsonrpc: '2.0', id: ++rpcId, method };
  if (params !== undefined) request.params = params;
  const lines = await transport.handleLine(JSON.stringify(request));
  assert.equal(lines.length, 1, `${method} should return one response`);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

async function notify(transport: FakeServerTransport, method: string, params?: unknown): Promise<void> {
  const request: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (params !== undefined) request.params = params;
  const lines = await transport.handleLine(JSON.stringify(request));
  assert.equal(lines.length, 0, `${method} notification should not return a response`);
}

async function callTool(transport: FakeServerTransport, name: string, args: Record<string, unknown> = {}) {
  calledTools.push(name);
  const response = await rpc(transport, 'tools/call', { name, arguments: args });
  const result = response['result'] as { content?: Array<{ text?: unknown }>; isError?: boolean } | undefined;
  assert.ok(result?.content?.[0] && typeof result.content[0].text === 'string', `${name} missing content`);
  return { isError: result.isError === true, envelope: JSON.parse(result.content[0].text as string) as Record<string, any> };
}

async function main(): Promise<void> {
  const transport = createFakeServerTransport({ env: { FAKE_ENABLE_WRITE: '1', FAKE_ENABLE_RESOURCES: '1' } });
  const init = await rpc(transport, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: { resources: {} }, clientInfo: { name: 'e2e-fake', version: '1' },
  });
  assert.equal((init.result as any).serverInfo.specVersion, '0.5');
  await notify(transport, 'notifications/initialized');

  const tools = (await rpc(transport, 'tools/list')).result as { tools: Array<{ name: string }> };
  assert.ok(tools.tools.some(tool => tool.name === 'submit_voucher'));
  assert.ok(tools.tools.some(tool => tool.name === 'submit_voucher_batch'));

  const resources = (await rpc(transport, 'resources/list')).result as { resources: Array<{ uri: string }> };
  assert.ok(resources.resources.some(resource => resource.uri === '17dz://domains/voucher/templates'));
  const resource = (await rpc(transport, 'resources/read', { uri: '17dz://domains/voucher/templates' })).result as { contents: Array<{ text?: string }> };
  assert.match(resource.contents[0]?.text ?? '', /voucher templates/);

  const accounts = await callTool(transport, 'search_account_sets', { query: '幻晟' });
  assert.deepEqual(accounts.envelope.data.accountSets[0], { id: 'as_001', name: '幻晟' });
  const period = await callTool(transport, 'get_current_accounting_period', { accountSetId: 'as_001' });
  assert.equal(period.envelope.data.period, '202607');

  const firstPage = await callTool(transport, 'list_vouchers', { accountSetId: 'as_001', period: '202607', pageSize: 4 });
  assert.equal(firstPage.envelope.data.docs.length, 4);
  assert.ok(firstPage.envelope.data.nextCursor);
  const secondPage = await callTool(transport, 'list_vouchers', { accountSetId: 'as_001', period: '202607', cursor: firstPage.envelope.data.nextCursor });
  assert.equal(secondPage.envelope.data.offset, 4);
  const inspect = await callTool(transport, 'inspect_account_set', { accountSetId: 'as_001' });
  assert.ok(inspect.envelope.data.subjects.some((subject: { code: string }) => subject.code === '1122'));
  assert.ok(inspect.envelope.data.assistants.some((assistant: { id: string }) => assistant.id === 'c00089'));

  const contract = {
    accountSetId: 'as_001', date: '2026-07-31', template: 'bill.receive',
    entries: [
      { summary: 'E2E 收票', subjectCode: '1121', debit: 100 },
      { summary: 'E2E 收票', subjectCode: '1122', assistantName: '客户甲', credit: 100 },
    ],
  };
  const valid = await callTool(transport, 'validate_voucher', { contract });
  assert.equal(valid.envelope.data.ok, true);
  const invalid = await callTool(transport, 'validate_voucher', { contract: { ...contract, entries: [contract.entries[0]] } });
  assert.equal(invalid.envelope.data.ok, false);

  // The write tools are advertised and schema-tested, but deliberately never called.
  const forbiddenCalls = new Set(['submit_voucher', 'submit_voucher_batch', 'workflow.confirm']);
  assert.deepEqual(calledTools.filter(name => forbiddenCalls.has(name)), []);
  console.log('E2E PASS: in-process Fake MCP reads/resources/pagination/inspect/validate; submit untouched');
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
