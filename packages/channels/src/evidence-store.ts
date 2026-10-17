import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from './sanitise.ts';

/**
 * Immutable, content-addressed evidence storage. Files are written once and never modified;
 * access goes through authenticated application routes only.
 */
export interface StoredEvidence {
  sha256: string;
  storageKey: string;
  sizeBytes: number;
}

export interface EvidenceStore {
  put(tenantId: string, bytes: Uint8Array): Promise<StoredEvidence>;
  get(storageKey: string): Promise<Buffer>;
}

const TENANT_RE = /^[0-9a-f-]{36}$/;

export class LocalEvidenceStore implements EvidenceStore {
  constructor(private readonly rootDir: string) {}

  async put(tenantId: string, bytes: Uint8Array): Promise<StoredEvidence> {
    if (!TENANT_RE.test(tenantId)) throw new Error('invalid tenant id');
    const sha256 = sha256Hex(bytes);
    const storageKey = `${tenantId}/${sha256.slice(0, 2)}/${sha256}`;
    const file = this.resolve(storageKey);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      // Same content already stored: content addressing makes this a no-op.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return { sha256, storageKey, sizeBytes: bytes.byteLength };
  }

  async get(storageKey: string): Promise<Buffer> {
    return readFile(this.resolve(storageKey));
  }

  private resolve(storageKey: string): string {
    if (!/^[0-9a-f-]{36}\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(storageKey)) throw new Error('invalid storage key');
    return path.join(this.rootDir, storageKey);
  }
}

/** In-memory store for tests. */
export class MemoryEvidenceStore implements EvidenceStore {
  readonly files = new Map<string, Buffer>();
  async put(tenantId: string, bytes: Uint8Array): Promise<StoredEvidence> {
    const sha256 = sha256Hex(bytes);
    const storageKey = `${tenantId}/${sha256.slice(0, 2)}/${sha256}`;
    if (!this.files.has(storageKey)) this.files.set(storageKey, Buffer.from(bytes));
    return { sha256, storageKey, sizeBytes: bytes.byteLength };
  }
  async get(storageKey: string): Promise<Buffer> {
    const f = this.files.get(storageKey);
    if (!f) throw new Error(`no evidence ${storageKey}`);
    return f;
  }
}
