import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Excludes the performance/benchmark suite from the default test
    // run — those tests need a real Stockfish worker and a built
    // bundle, neither of which exists in the unit-test environment.
    // They're meant to run on demand via `npm run test:perf` (or
    // just `vitest run src/test/benchmarks/`). Default `npm test`
    // and `npm run test:run` therefore stay green.
    exclude: ['node_modules/**', 'e2e/**', 'src/test/benchmarks/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      exclude: [
        'node_modules/**',
        'src/test/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/types/**',
      ],
    },
  },
});
