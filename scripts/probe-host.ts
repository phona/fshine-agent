/**
 * 隔离探针:用 fshine McpHost 直接 spawn 真实 17dz profile,不经 Kimi/runtime。
 * 用途:区分 "Page crashed" 是 fshine spawn 侧问题还是模型编排侧问题。
 * 用法:node --env-file=.env --import tsx scripts/probe-host.ts
 */
import { loadConfig } from '@fshine/core';
import { McpHost, type McpToolPolicy } from '@fshine/mcp-host';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fshine-probe-'));
const yamlPath = path.join(tmpDir, 'agent.yaml');
writeFileSync(yamlPath, `
principals: {}
mcpProfiles:
  read-default:
    command: npm
    args: ["run", "mcp"]
    cwd: /home/fictional-user/fictional-projects/fictional-execution-layer
    requestTimeoutMs: 60000
    maxRetries: 2
    env:
      ALLOWED_ACCOUNT_SETS: ""
      DEBUG: ""
`);
const config = loadConfig({ env: process.env, yamlPath });
const toolPolicy: McpToolPolicy = {
  allowedTools: [
    'get_login_status', 'search_account_sets', 'get_current_accounting_period', 'list_vouchers', 'inspect_account_set',
    'search_references',
    'validate_voucher', 'submit_voucher', 'submit_voucher_batch', 'get_submission_status',
  ],
  categories: {
    get_login_status: 'read', search_account_sets: 'read', get_current_accounting_period: 'read',
    list_vouchers: 'read', inspect_account_set: 'read', search_references: 'read', validate_voucher: 'validate',
    submit_voucher: 'write', submit_voucher_batch: 'write', get_submission_status: 'status',
  },
};
const host = new McpHost({ profile: config.mcpProfiles['read-default']!, toolPolicy });
await host.ensureReady();
console.log('[probe] host ready, tools:', host.discoveredTools.length);

const client = host.clientFor('probe_req', ['as_001'], {}, ['read']);
try {
  const login = await client.call('get_login_status', {});
  console.log('[probe] get_login_status →', JSON.stringify(login).slice(0, 200));
  const search = await client.call('search_account_sets', { query: '幻晟' });
  console.log('[probe] search_account_sets →', JSON.stringify(search).slice(0, 200));
  const period = await client.call('get_current_accounting_period', { accountSetId: 'as_001' });
  console.log('[probe] get_current_accounting_period →', JSON.stringify(period).slice(0, 200));
  console.log('[probe] ALL OK');
} catch (error) {
  console.error('[probe] FAILED:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  host.stop();
}
