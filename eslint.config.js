import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'ios',
      'android',
      'node_modules',
      'capacitor.config.ts',
      'tailwind.config.js',
      'vite.config.ts',
      'vitest.config.ts',
      'e2e',
      'playwright.config.ts',
      'api',
      'scripts',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        // Use tsconfig.eslint.json which extends tsconfig.app.json but
        // also includes test files. tsc still skips test files via
        // tsconfig.app.json's `exclude` (test files would fail
        // typecheck due to vitest mock typing — they're checked at
        // test-run time by vitest's own type pipeline). Without this
        // separate eslint tsconfig, the typed lint parser emitted a
        // Parsing error for every `src/utils/*.test.ts` file.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // Only require return types on named function declarations, not every expression/callback
      '@typescript-eslint/explicit-function-return-type': ['warn', {
        allowExpressions: true,
        allowHigherOrderFunctions: true,
        allowDirectConstAssertionInArrowFunctions: true,
        allowTypedFunctionExpressions: true,
      }],
      // Numbers are valid in template literals — no need to call .toString()
      '@typescript-eslint/restrict-template-expressions': ['error', {
        allowNumber: true,
      }],
      // Arrow shorthand void returns are fine: () => voidFn() is common in React callbacks
      '@typescript-eslint/no-confusing-void-expression': ['error', {
        ignoreArrowShorthand: true,
      }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  // Test utilities — fast-refresh rule doesn't apply to test helpers
  {
    files: ['src/test/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  // Test files — relax rules that are impractical in testing contexts.
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      // Test mocks frequently need to satisfy a `Promise<T>`-returning
      // interface without doing real async work (e.g.
      // `vi.fn(async (env) => responseFixture)`). Forcing
      // `() => Promise.resolve(x)` everywhere adds noise without
      // catching real bugs in test code.
      '@typescript-eslint/require-await': 'off',
    },
  },
);
