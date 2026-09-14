import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // E2E 并行时多个 chromium 实例同时启动，10s 默认钩子超时不够用
    hookTimeout: 120_000,
    testTimeout: 300_000,
  },
});
