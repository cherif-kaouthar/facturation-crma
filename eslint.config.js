import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist', 'release', 'node_modules', 'server/default.db'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // shared/money.js and repo.js deliberately embed narrow-no-break-space /
    // no-break-space characters (French currency grouping); don't flag them.
    rules: {
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipRegExps: true, skipComments: true }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // This codebase relies on the "reset local state when a prop/modal
      // opens" pattern throughout (ClientModal, UnitModal, InvoiceDetail,
      // SettingsPage, ...) — flagging every instance would mean a large,
      // separate refactor rather than an eslint-adoption change.
      'react-hooks/set-state-in-effect': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['server/**/*.js', 'electron/**/*.js', 'scripts/**/*.{js,mjs}', 'shared/**/*.js', '*.config.{js,ts}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.test.{js,ts,tsx}'],
    languageOptions: {
      globals: globals.node,
    },
  }
);
