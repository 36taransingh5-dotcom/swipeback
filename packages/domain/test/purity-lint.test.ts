import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/** The boundary rule must actually fire: packages/domain may not perform IO or read clocks. */
const eslint = new ESLint({ cwd: new URL('../../../', import.meta.url).pathname });

async function errorsFor(code: string, filePath = 'packages/domain/src/__probe__.ts'): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.severity === 2).map((m) => m.ruleId ?? 'fatal');
}

describe('domain purity lint boundary', () => {
  it.each([
    ["import { readFile } from 'node:fs/promises';", 'no-restricted-imports'],
    ["import http from 'http';", 'no-restricted-imports'],
    ["import pg from 'pg';", 'no-restricted-imports'],
    ["import { createPool } from '@swipeback/db';", 'no-restricted-imports'],
    ['export const t = Date.now();', 'no-restricted-properties'],
    ['export const r = Math.random();', 'no-restricted-properties'],
    ['export const d = new Date();', 'no-restricted-syntax'],
    ['export const e = process.env.X;', 'no-restricted-globals'],
    ["export const f = () => fetch('https://example.com');", 'no-restricted-globals'],
  ])('rejects %s', async (code, rule) => {
    expect(await errorsFor(code)).toContain(rule);
  });

  it('allows pure code, deterministic hashing and explicit dates', async () => {
    const code = [
      "import { createHash } from 'node:crypto';",
      "export const h = createHash('sha256').update('x').digest('hex');",
      "export const d = new Date('2026-10-17T00:00:00Z');",
    ].join('\n');
    expect(await errorsFor(code)).toEqual([]);
  });

  it('does not restrict other packages', async () => {
    expect(await errorsFor("import pg from 'pg';\nexport default pg;", 'packages/db/src/__probe__.ts')).toEqual([]);
  });
});
