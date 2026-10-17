import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestEvaluationReport } from '@swipeback/web';

describe('latest evaluation report', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sb-reports-'));
    for (const f of [
      'benchmark-2026-10-17T07-25-08-510Z.json',
      'pipeline-heldout-2026-10-17T13-12-24-213Z.json',
      'pipeline-heldout-2026-10-17T13-16-08-930Z.json',
      'pipeline-heldout-2026-10-17T13-16-08-930Z.md',
      'pipeline-tune-2026-10-17T13-20-00-000Z.json',
    ]) await writeFile(path.join(dir, f), '{}');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('picks the newest report of the requested split, never a newer report of another split', async () => {
    expect(path.basename((await latestEvaluationReport(dir, 'heldout'))!)).toBe('pipeline-heldout-2026-10-17T13-16-08-930Z.json');
    expect(path.basename((await latestEvaluationReport(dir, 'tune'))!)).toBe('pipeline-tune-2026-10-17T13-20-00-000Z.json');
    expect(await latestEvaluationReport(dir, 'all')).toBeNull();
    expect(await latestEvaluationReport(path.join(dir, 'missing'), 'heldout')).toBeNull();
  });
});
