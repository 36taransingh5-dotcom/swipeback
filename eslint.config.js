// @ts-check
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Node built-ins the pure domain may use (hashing is deterministic, not IO). */
const DOMAIN_ALLOWED_BUILTINS = new Set(['crypto']);
const forbiddenBuiltins = builtinModules
  .filter((m) => !m.startsWith('_') && !DOMAIN_ALLOWED_BUILTINS.has(m.replace(/^node:/, '').split('/')[0] ?? ''))
  .flatMap((m) => [m, `node:${m}`]);

/**
 * packages/domain is the safety boundary: policy, matching and payout eligibility must be pure,
 * deterministic functions of their inputs. No IO, no clock, no randomness, no other packages.
 */
export const domainPurityRules = {
  'no-restricted-imports': [
    'error',
    {
      paths: forbiddenBuiltins.map((name) => ({ name, message: 'packages/domain must not perform IO.' })),
      patterns: [
        { group: ['@swipeback/*', '!@swipeback/domain'], message: 'packages/domain must not depend on other packages.' },
        { group: ['pg', 'embedded-postgres', '@anthropic-ai/*', 'googleapis', 'next', 'next/*'], message: 'packages/domain must not perform IO.' },
      ],
    },
  ],
  'no-restricted-globals': [
    'error',
    { name: 'fetch', message: 'packages/domain must not perform IO.' },
    { name: 'process', message: 'packages/domain must not read the environment.' },
    { name: 'setTimeout', message: 'packages/domain must not schedule work.' },
    { name: 'setInterval', message: 'packages/domain must not schedule work.' },
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Date', property: 'now', message: 'Pass time in explicitly (deterministic decisions).' },
    { object: 'Math', property: 'random', message: 'Pass randomness in explicitly (deterministic decisions).' },
  ],
  'no-restricted-syntax': [
    'error',
    { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'Pass time in explicitly (deterministic decisions).' },
  ],
};

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '.data/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['packages/domain/src/**/*.ts'],
    rules: domainPurityRules,
  },
);
