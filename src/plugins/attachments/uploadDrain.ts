/**
 * The up-lane drain (design §9/§11) — uploads `pending` byte records to Storage.
 *
 * For each pending record: read the PLAINTEXT bytes from the OPFS byte store,
 * encode them AT DRAIN TIME (passthrough for plaintext, AES-GCM seal for e2ee —
 * the key is only needed here, not at capture), and upload the result directly to
 * `<ws>/<contentKey>` (§10.1, RLS-gated, first-write-wins). A confirmed upload
 * DELETES the record; the bytes stay in OPFS as the local render replica.
 *
 * A 200 write clears the record. A 409 (the content-addressed path was already
 * occupied) is NOT taken as success blind: Storage is untrusted + immutable, so the
 * existing object may be a stale / buggy / POISONED body, not our content (§17).
 * We fetch + decode + hash-verify it first — a match is a genuine cross-device
 * dedup and clears the record; a mismatch leaves the record `failed` so the §9/§17
 * opportunistic correction (writer-delete + re-upload) can act, rather than
 * silently clearing the only entry that could ever fix the path.
 *
 * Failure handling (the §9/§17 bounded-correction rule):
 *   - `defer` materializability (locked / unpinned / signed out) → leave `pending`,
 *     no attempt burn; the next sweep retries once the workspace is materializable.
 *   - PERMANENT BlobPutError (403/404/413, the advisory hint) → `failed` at once.
 *   - TRANSIENT BlobPutError (offline / no-session / 401 / 5xx / network — EVERY
 *     non-permanent upload error) → leave `pending`, NO attempt burn; it clears on
 *     reconnect / token refresh / server recovery, so only the AGE backstop ever
 *     quarantines it. (Crucial: the reconciler re-arms the drain on every
 *     `online`/`visible` event, so a flaky-network paste must NOT exhaust the small
 *     attempt budget in a few refocuses and land in `failed`, which nothing re-drains.)
 *   - an ENCODE error or a local OPFS read THROW (a non-connectivity failure that a
 *     refocus can't fix) → bump attempts and retry, bounded by attempt count AND age
 *     so a persistent bug can't retry on every refocus forever.
 *   - 409 + the existing object hash-MISMATCHES (poisoned path, §17) → `failed`;
 *     a transient verify-GET failure → retry (the object exists, just unreadable now).
 *   - local bytes missing (OPFS eviction before the upload drained) → `failed`:
 *     unrecoverable from the queue; §9 recovery / a re-paste re-stages with bytes.
 *
 * SINGLE-OWNER: this is a background lane. The caller (Phase 5d) serializes it
 * under a `navigator.locks` lock so two tabs never drain concurrently; the upload
 * is idempotent (upsert:false, first-write-wins) so even a racing drain is safe.
 *
 * SCOPE — undo-before-upload: this drain does NOT check whether the asset block is
 * still live before uploading. A paste-then-undo can leave a `pending` record
 * whose block is soft-deleted; this drain uploads its bytes anyway. That is
 * harmless and deliberate — objects are immutable, content-addressed, and
 * reference-permanent (§16 GC reclaims an unreferenced object). Adding an inline
 * block-presence check here would couple the lane to the DB and reintroduce a
 * hydration race (absent-because-unsynced vs absent-because-undone). Orphan
 * cleanup is the boot reconciler's (5d) + §16 GC's job, gated on the settled
 * checkpoint — not this hot path. (Divergence from design.html's "drain
 * block-exists-before-PUT" note; correctness-equivalent given immutable objects.)
 */

import { decodeBytes, encodeBytes } from '@/sync/byteTransform.js'
import { verifyContentHash } from '@/sync/crypto/contentHash.js'
import { materializabilityToMode, type GetCek, type GetMaterializability, type SyncMode } from '@/sync/transform.js'
import { BlobPutError, type BlobStore } from './blobStore.js'
import type { ByteStore } from './byteStore.js'
import type { ByteUploadRecord, ByteUploadStore } from './uploadStore.js'

/** Default retry bounds. Generous enough to ride out a long offline stretch, but
 *  finite so a non-enumerated permanent failure can't retry forever (§9/§17). */
const DEFAULT_MAX_ATTEMPTS = 8
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface UploadDrainDeps {
  readonly store: ByteUploadStore
  readonly byteStore: ByteStore
  readonly blobStore: BlobStore
  /** The three-valued materializability (same source the read lane uses): decrypt
   *  → seal e2ee, copy → passthrough, defer → not uploadable yet. */
  readonly getMaterializability: GetMaterializability
  /** The workspace key for the e2ee seal. */
  readonly getCek: GetCek
  /** Is `userId` (the QUEUED user whose records we're draining) still the active
   *  account? The mode/key deps and the BlobStore session resolve against the
   *  ACTIVE user, so if an account switch lands between the drain being armed and
   *  this body running, draining userA's records under userB's session can hit a
   *  permanent 403 (B isn't a writer for A's workspace) and wrongly mark A's record
   *  `failed`. So a record is processed only while its user is active; otherwise it
   *  defers (no attempt burn) and re-drains when that user is active again.
   *  Defaults to always-active for the source-based unit path. */
  readonly isActiveUser?: () => boolean
  readonly now?: () => number
  readonly maxAttempts?: number
  readonly maxAgeMs?: number
}

export interface DrainSummary {
  readonly uploaded: number
  readonly failed: number
  readonly deferred: number
  readonly retried: number
}

type DrainOutcome = 'uploaded' | 'failed' | 'deferred' | 'retried'

interface DrainOneCtx {
  readonly store: ByteUploadStore
  readonly byteStore: ByteStore
  readonly blobStore: BlobStore
  readonly getMaterializability: GetMaterializability
  readonly getCek: GetCek
  readonly isActiveUser: () => boolean
  readonly now: () => number
  readonly maxAttempts: number
  readonly maxAgeMs: number
}

/** Bounded-retry decision for a non-permanent failure: bump the attempt unless a
 *  bound (attempt count OR age) is reached, in which case quarantine. */
const retryOrFail = async (
  userId: string,
  rec: ByteUploadRecord,
  ctx: DrainOneCtx,
): Promise<DrainOutcome> => {
  const exhausted = rec.attempts + 1 >= ctx.maxAttempts || ctx.now() - rec.stagedAt > ctx.maxAgeMs
  if (exhausted) {
    await ctx.store.markFailed(userId, rec.assetBlockId, rec.stagedAt)
    return 'failed'
  }
  await ctx.store.recordAttempt(userId, rec.assetBlockId, rec.stagedAt)
  return 'retried'
}

/** A CLEARLY-transient failure (offline, token absent, Storage 5xx — anything that
 *  clears on reconnect / token refresh / server recovery): leave the record PENDING
 *  WITHOUT burning the bounded attempt budget. The reconciler re-arms the drain on
 *  every `online`/`visible` event, so a flaky-network paste retried a handful of
 *  times would otherwise exhaust `maxAttempts` and quarantine a perfectly good upload
 *  in seconds — `failed` leaves the drain's automatic path (only an explicit user Retry
 *  re-drives it, §9). Only the AGE backstop applies here; past it, give up (an upload
 *  transient for ~7 days lands in `failed`, surfaced with Retry like any other). */
const deferTransientOrFail = async (
  userId: string,
  rec: ByteUploadRecord,
  ctx: DrainOneCtx,
): Promise<DrainOutcome> => {
  if (ctx.now() - rec.stagedAt > ctx.maxAgeMs) {
    await ctx.store.markFailed(userId, rec.assetBlockId, rec.stagedAt)
    return 'failed'
  }
  return 'deferred'
}

const drainOne = async (
  userId: string,
  rec: ByteUploadRecord,
  ctx: DrainOneCtx,
): Promise<DrainOutcome> => {
  // (0) Bind to the queued user. The mode/key deps + BlobStore session resolve
  //     against the ACTIVE account; if it changed since this drain was armed,
  //     skip (no attempt burn) rather than touch userId's record under the wrong
  //     identity — re-drains when userId is active again.
  if (!ctx.isActiveUser()) return 'deferred'

  // (1) Can we encode for this workspace right now? defer/unexpected → leave pending.
  const mode = materializabilityToMode(await ctx.getMaterializability(rec.workspaceId))
  if (mode === null) return 'deferred' // defer / unexpected — leave pending, never an attempt burn

  // (2) The plaintext bytes (capture wrote them before staging). A read THROW is
  //     transient (retry); a clean MISS means the bytes were evicted → quarantine.
  let plaintext: Uint8Array<ArrayBuffer> | null
  try {
    plaintext = await ctx.byteStore.get(userId, rec.workspaceId, rec.contentKey)
  } catch {
    return retryOrFail(userId, rec, ctx)
  }
  if (!plaintext) {
    // A clean OPFS miss is terminal — BUT a concurrent re-paste writes fresh bytes to
    // OPFS *before* it re-arms (bumps stagedAt), so the stamp guard turns this into a
    // no-op when superseded, and the next drain finds the re-pasted bytes.
    await ctx.store.markFailed(userId, rec.assetBlockId, rec.stagedAt)
    return 'failed'
  }

  // (3) Encode at drain + direct upload. A fresh 200 write → delete the record;
  //     a 409 (path already occupied) → verify the existing object before clearing.
  try {
    const sealed = await encodeBytes(plaintext, mode, ctx.getCek, {
      contentHash: rec.contentHash,
      workspaceId: rec.workspaceId,
    })
    const result = await ctx.blobStore.put(rec.workspaceId, rec.contentKey, sealed)
    if (result === 'exists') return verifyExistingOrQuarantine(userId, rec, mode, ctx)
    await ctx.store.delete(userId, rec.assetBlockId)
    return 'uploaded'
  } catch (err) {
    if (err instanceof BlobPutError) {
      if (err.permanent) {
        await ctx.store.markFailed(userId, rec.assetBlockId, rec.stagedAt)
        return 'failed'
      }
      // A non-permanent BlobPutError is TRANSIENT (offline / no-session / 401 / 5xx /
      // network — the blobStore's classification): it clears on its own, so don't burn
      // the attempt budget on a refocus-driven retry. Age-bounded only.
      return deferTransientOrFail(userId, rec, ctx)
    }
    // A non-BlobPutError throw is an ENCODE error — a persistent bug, not connectivity:
    // attempt-bound it so it can't retry on every refocus indefinitely.
    return retryOrFail(userId, rec, ctx)
  }
}

/** A 409 means the content-addressed path was already occupied — but Storage is
 *  untrusted + immutable, so the existing object may be a stale / buggy / poisoned
 *  body rather than our content (§17). Fetch + decode + hash-verify it:
 *    - matches our hash → genuine cross-device dedup → delete the record (done).
 *    - present but mismatches / can't decode → POISONED path → `failed`, so the
 *      §9/§17 opportunistic correction (writer-delete + re-upload) can act. We must
 *      NOT clear: that strands our good local bytes with no entry to fix the path.
 *    - the verify-GET fails transiently → retry (the object exists, just unreadable
 *      right now); never clear or quarantine on a transient read. */
const verifyExistingOrQuarantine = async (
  userId: string,
  rec: ByteUploadRecord,
  mode: SyncMode,
  ctx: DrainOneCtx,
): Promise<DrainOutcome> => {
  let stored: Uint8Array<ArrayBuffer>
  try {
    stored = await ctx.blobStore.get(rec.workspaceId, rec.contentKey)
  } catch {
    return retryOrFail(userId, rec, ctx) // exists, but the verify read failed — transient
  }
  let decoded: Uint8Array<ArrayBuffer>
  try {
    decoded = await decodeBytes(stored, mode, ctx.getCek, {
      contentHash: rec.contentHash,
      workspaceId: rec.workspaceId,
    })
  } catch {
    await ctx.store.markFailed(userId, rec.assetBlockId, rec.stagedAt) // undecodable existing object — poisoned
    return 'failed'
  }
  if (await verifyContentHash(decoded, rec.contentHash)) {
    await ctx.store.delete(userId, rec.assetBlockId) // genuine dedup — the path holds our content
    return 'uploaded'
  }
  await ctx.store.markFailed(userId, rec.assetBlockId, rec.stagedAt) // present but wrong content — poisoned (§17)
  return 'failed'
}

/** Drain every `pending` byte record for `userId`. Sequential — the queue is
 *  small and this avoids hammering Storage; the caller runs it single-owner. */
export const drainUploads = async (userId: string, deps: UploadDrainDeps): Promise<DrainSummary> => {
  const ctx: DrainOneCtx = {
    store: deps.store,
    byteStore: deps.byteStore,
    blobStore: deps.blobStore,
    getMaterializability: deps.getMaterializability,
    getCek: deps.getCek,
    isActiveUser: deps.isActiveUser ?? (() => true),
    now: deps.now ?? (() => Date.now()),
    maxAttempts: deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    maxAgeMs: deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
  }

  const pending = await deps.store.listByStatus(userId, 'pending')
  const tally: Record<DrainOutcome, number> = { uploaded: 0, failed: 0, deferred: 0, retried: 0 }
  for (const rec of pending) {
    tally[await drainOne(userId, rec, ctx)] += 1
  }
  return tally
}
