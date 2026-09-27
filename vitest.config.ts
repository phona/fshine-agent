import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@fshine\/([\w-]+)$/,
        replacement: fileURLToPath(new URL('./packages', import.meta.url)) + '/$1/src/index.ts',
      },
    ],
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    environment: 'node',
    // e2e 全链用例要真 spawn CLI 进程（mock 网关/计划 CLI），单例 0.8-2.6s 是正常速度；
    // 共享机器高负载时劣化 3-4 倍（实测 7.9s），默认 5s 超时会把负载抖动变成假失败
    // （2026-09-27 复现：计划门确认路径两例在 load 10+ 时间歇性红，低负载三连全绿）。
    testTimeout: 30_000,
  },
});
