# Receipt-file encryption at rest — instructions for Claude Code

You are working on the `encryption-at-rest` branch of **Swipeback** (SotonShip 2026, FinTech track).
Your job: encrypt **receipt and attachment files at rest** with AES-256-GCM, with no change to any
decision logic, hash, database schema or API. Today they are plain files under `.data/evidence/`.

**Read first:** `README.md` and `docs/HANDOFF.md` (sections 1 and 4). The "Non-negotiable product rules"
in `docs/HANDOFF.md` §1 override anything below. This is an **optional hardening feature**: if it is not
green and agreed by Taran in time, it is dropped and the README simply documents the gap honestly.

---

## Start here: set up the branch (do this first, once)

Never commit to `main`, never push to `main`, never merge anything. Do not touch other branches.

1. `git remote get-url origin` must point to `github.com/36taransingh5-dotcom/swipeback`. If not, stop and ask.
2. `git status --porcelain`: if anything is listed, **stop and ask the user** (do not stash, reset or commit it).
3. ```bash
   git fetch origin
   git ls-remote --heads origin encryption-at-rest
   ```
   - **Exists:** `git switch encryption-at-rest` (or `git switch -c encryption-at-rest --track origin/encryption-at-rest`), then `git pull --rebase`. Skip to step 5.
   - **Does not exist:** `git switch -c encryption-at-rest origin/main`
4. Add this file at `docs/security/CLAUDE.md`, commit and push the branch only:
   ```bash
   mkdir -p docs/security
   cp <path-the-user-gave>/CLAUDE.md docs/security/CLAUDE.md
   git add docs/security/CLAUDE.md
   git commit -m "Receipt-file encryption plan for Claude Code (branch only, not for main yet)"
   git push -u origin encryption-at-rest
   ```
5. Confirm `git branch --show-current` prints `encryption-at-rest`. Tell the user, then continue.

Every later session: `git fetch origin && git rebase origin/main` first; push with `git push`
(`--force-with-lease` only after a rebase, only on this branch).

**Hard cut-off: Sun 18 Oct 09:00 BST.** If it is not green by then, stop and leave the branch unmerged.
Do not merge or open a PR; the user and Taran decide. Never let this delay anything on `main`.

---

## 0. Avoid merge conflicts

Taran keeps working on `main`. This branch must merge later with zero conflicts.

1. **New code goes in new files** (§2).
2. Edits to existing files are limited to the exact lines in §2. Never reformat, reorder or "tidy".
3. **Do not touch:** `README.md` and every existing doc; `docs/slack/**`, `docs/whatsapp/**`; any `**/slack*`
   or `**/whatsapp*` file; `packages/channels/src/evidence-store.ts` (leave it unchanged); `packages/db/**`
   (**no migrations**, no schema change); `packages/extraction/**`; `packages/domain/**`; `apps/web/**`;
   `apps/worker/**`; `tools/cli/**`; `eval/**`; `package.json` / `pnpm-lock.yaml` (**no new dependencies**:
   `node:crypto` only).
4. **Conflict check before every push** (git ≥ 2.38):
   ```bash
   git fetch origin
   git merge-tree --write-tree origin/main HEAD >/dev/null && echo "OK vs main"
   ```
   It must pass. Re-fetch and rebase right before pushing, because `runtime.ts` is a shared file.
5. Commit in small steps, each only after `corepack pnpm verify` is green.

---

## 1. Design

**What is encrypted:** every file written by the evidence store (receipt photos, PDFs, email bodies,
chat media). **What is not:** database columns, outbound emails, the audit log (it is a hash chain, which
is integrity, not secrecy). Do not claim more than this anywhere.

**Why a new store class, not a decorator:** evidence is *content-addressed*. `sha256` and `storageKey` are
computed from the **plaintext**, are stored in `evidence_files`, and are used for duplicate detection,
frozen evaluation manifests and recorded model responses. A random-nonce ciphertext would break all of
that. So the new class computes `sha256Hex(plaintext)` exactly as `LocalEvidenceStore` does, builds the
same `storageKey` (`<tenant>/<2 hex>/<64 hex>`), and writes **sealed bytes** at that path.
`StoredEvidence` (`sha256`, `storageKey`, `sizeBytes`) must keep describing the **plaintext**.

**File format** (binary, one file per evidence item):
`'SBE1'` (4 ASCII bytes) | key id (6 bytes: first 6 bytes of SHA-256 of the key) | IV (12 random bytes) |
GCM tag (16 bytes) | ciphertext. AES-256-GCM via `node:crypto`. **AAD = the storageKey string**, so a
sealed file cannot be moved to another path or tenant and still decrypt.

**Reading (`get`):**
- If the file starts with `SBE1`: check the key id, decrypt (GCM failure throws), return plaintext.
- Otherwise it is a legacy plaintext file: return it as is (so nothing existing breaks).
- In both cases, **verify `sha256Hex(returned bytes)` equals the 64-hex name in the storageKey** and throw
  on mismatch. This is a free integrity check for both formats.

**Writing (`put`):** same `mkdir` modes (`0o700` directory, `0o600` file) and `{ flag: 'wx' }` as
`LocalEvidenceStore`; an `EEXIST` is a no-op because identical content maps to one file. (A previously
stored legacy plaintext file for the same hash stays plaintext; that is acceptable and documented.)

**Key:** `SB_EVIDENCE_ENCRYPTION_KEY`, 32 random bytes, base64 (`openssl rand -base64 32`).
- **Unset:** use the existing `LocalEvidenceStore`; behaviour is exactly as today.
- **Set but not 32 bytes of base64:** throw at startup with a clear message (never print the key).
- It is a **separate key** from `SB_TOKEN_ENCRYPTION_KEY`. Do not derive one from the other.
- Losing the key makes sealed receipts unreadable. Say so in the docs. `demo:reset` already deletes
  `.data/evidence`, so a demo can always start clean.

---

## 2. Files

**New files:**

| File | Purpose |
|---|---|
| `packages/channels/src/encrypted-evidence-store.ts` | `EncryptedLocalEvidenceStore implements EvidenceStore` and `evidenceStoreFromEnv(env, rootDir): EvidenceStore` |
| `packages/channels/test/encrypted-evidence-store.test.ts` | Unit tests (§3) |
| `packages/engine/test/evidence-encryption.test.ts` | Integration test (§3) |
| `docs/security/ENCRYPTION.md` | What is and is not encrypted, format, key handling, how to verify, limits |

**Existing files: exact edits only.** Re-fetch `origin/main` and confirm each line still exists first.

| File | Edit |
|---|---|
| `packages/channels/src/index.ts` | After the line `export * from './slack/web-api.ts';` add `export * from './encrypted-evidence-store.ts';` |
| `packages/engine/src/runtime.ts` | In the first import line, replace `LocalEvidenceStore` with `evidenceStoreFromEnv` (keep the other names and their order). Replace the line `  const evidence = new LocalEvidenceStore(path.join(dataDir, 'evidence'));` with `  const evidence = evidenceStoreFromEnv(env, path.join(dataDir, 'evidence'));` |
| `.env.example` | After the line `SB_TOKEN_ENCRYPTION_KEY=` add a blank line, then `# Receipt files at rest: AES-256-GCM key (32 random bytes, base64). Unset = receipt files are stored unencrypted.` and `SB_EVIDENCE_ENCRYPTION_KEY=` |

If removing `LocalEvidenceStore` from the import makes lint complain because it is still used elsewhere in
`runtime.ts`, keep it imported. Do not change any other line.

---

## 3. Tests (no network)

**Unit (`packages/channels/test/encrypted-evidence-store.test.ts`, temp dir):**
1. Round trip: `put` then `get` returns the exact bytes; `sha256`, `storageKey` and `sizeBytes` equal what `LocalEvidenceStore` returns for the same input.
2. The file on disk starts with `SBE1` and contains **no** plaintext marker (put a unique string in the input and assert the raw file does not include it).
3. Same bytes twice → one file, same `storageKey`, second `put` is a no-op.
4. Two different IVs: two different tenants storing the same bytes give different ciphertext.
5. Wrong key → `get` throws. Flip one ciphertext byte → throws. Flip one tag byte → throws.
6. Move a sealed file to another storage path → `get` throws (AAD binding).
7. Legacy plaintext file written by `LocalEvidenceStore` is still readable through the encrypted store.
8. A file whose content does not match its hash name (plaintext tampered) → `get` throws.
9. `evidenceStoreFromEnv`: unset → `LocalEvidenceStore`; valid key → encrypted store; invalid key (wrong length, not base64) → throws without echoing the key.
10. Path-safety rules of the existing store still hold (bad tenant id, bad storage key).

**Integration (`packages/engine/test/evidence-encryption.test.ts`, real Postgres via `test/support`):**
ingest a fixture email with an attachment through the engine using the encrypted store; assert the
`evidence_files` row's `sha256` equals the sha256 of the original bytes, `deps.evidence.get` returns the
original bytes, and the file on disk is sealed. Also run the existing pipeline/extraction path once with
the encrypted store to prove extraction can still read evidence.

Run `corepack pnpm verify` **twice**: with no key set (all existing tests unchanged) and with
`SB_EVIDENCE_ENCRYPTION_KEY` set to a freshly generated key. Both must be green.

---

## 4. `docs/security/ENCRYPTION.md` (honest, short)

Cover: what is encrypted (receipt files, AES-256-GCM, per-file random IV, AAD-bound to the path, key in the
environment not the database, key id in the header for future rotation) and what is **not** (database
contents, outbound emails, the audit log, backups, data in transit inside this app). Include the three
verification commands for a demo:
```bash
ls -l .data/evidence/*/*/                 # files exist, size slightly larger than the receipt
xxd <one file> | head                     # starts with 53 42 45 31 ('SBE1'), then unreadable bytes
corepack pnpm web                         # the reviewer app still shows the receipt image
```
Add "Limits": single static key (no vault, no rotation tool, no re-encryption of old files), a lost key
means lost receipts, anyone who can read both the key and the disk can read the receipts, and encryption
at rest does not protect against a compromised running application.

---

## 5. Definition of done
- `corepack pnpm verify` green with and without the key; only the files in §2 changed; branch rebased on
  `origin/main`; the §0 conflict check passes.
- A live check with the key set: send a receipt, confirm the file on disk is sealed, and the reviewer app
  still shows it. Record the output in `docs/security/ENCRYPTION.md` under "Verification", with date and time.
- Do not claim end-to-end encryption, database encryption, or compliance anywhere.
