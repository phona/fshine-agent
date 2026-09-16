import { createInterface } from 'node:readline';
import { createFakeServerTransport } from './server';

const transport = createFakeServerTransport();
const rl = createInterface({ input: process.stdin });

console.error('[fake-17dz] 17dz-read fake MCP server ready (stdio)');

let queue: Promise<void> = Promise.resolve();
rl.on('line', (line) => {
  queue = queue
    .then(async () => {
      const lines = await transport.handleLine(line);
      for (const out of lines) process.stdout.write(`${out}\n`);
      if (transport.takeCrashSignal()) process.exit(1);
    })
    .catch((err: unknown) => {
      console.error('[fake-17dz] 行处理失败', err);
    });
});

rl.on('close', () => {
  console.error('[fake-17dz] stdin 关闭,退出');
});
