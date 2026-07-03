/**
 * Durable byte-upload staging store (design §9/§11 — the up-lane's queue).
 *
 * Bytes ride a parallel lane to Supabase Storage (NOT PowerSync), so they need
 * their OWN durable queue — `ps_crud` carries block metadata only. This store is
 * that queue: one record per un-uploaded asset, surviving reload, that the
 * up-lane drains.
 *
 * Lifecycle (one persisted `status` field):
 *   staged  — written BEFORE the block tx, NOT drainable. Closes the orphan-upload
 *             window: if the tx never commits (crash), the boot reconciler reaps a
 *             `staged` record whose block is absent past the settled checkpoint, so
 *             we never upload bytes for a block that doesn't exist.
 *   pending — flipped from `staged` AFTER the tx commits (`promote`). Drainable.
 *   failed  — a permanent upload rejection, or retries exhausted. NOT terminal:
 *             surfaced as the §9 diagnostics warning, and the user's Retry runs the
 *             recovery actor ({@link import('./uploadRecovery.js')}), which probes the
 *             content path and, when it's free, `requeue`s the record back to `pending`
 *             for the drain. A confirmed upload DELETES the record (no terminal "cleared"
 *             value is retained).
 *
 * Keyed by `(user_id, asset_block_id)` — `user_id` is load-bearing: the OPFS byte
 * store and this queue are shared across the browser profile's accounts but drain
 * per-user under the active session, so every op is namespaced by the user.
 *
 * The production backing is IndexedDB (commit-durable — the cached connection +
 * commit fence come from the shared {@link IdbKeyedStore}); tests and the
 * no-IndexedDB fallback use {@link InMemoryByteUploadStore}. Records are plain
 * JSON, so unlike the keyStore the IndexedDB implementation IS exercisable under
 * Node (fake-indexeddb).
 */

import {
  IdbKeyedStore,
  idbKeyPrefix,
  idbRecordId,
  promisifyRequest,
} from '@/utils/idbKeyedStore.js'

export type ByteUploadStatus = 'staged' | 'pending' | 'failed'

/** A queue record. Carries everything the drain needs to encode + upload without
 *  reading the block back (the bytes themselves live in the OPFS byte store,
 *  keyed by `contentKey`). */
export interface ByteUploadRecord {
  readonly userId: string
  /** The deterministic asset block id (a UUIDv5 of workspace + content-key). */
  readonly assetBlockId: string
  readonly workspaceId: string
  /** `sha256:<hex>` of the PLAINTEXT bytes — the encode AAD + read-side verify. */
  readonly contentHash: string
  /** The Storage path segment + OPFS byte-store key (raw sha256 / keyed-HMAC). */
  readonly contentKey: string
  readonly status: ByteUploadStatus
  /** Drain retry counter — bumped on a transient failure, bounds the retries. */
  readonly attempts: number
  /** ms epoch when (re-)staged — `stage` re-stamps it on every re-arm. STRICTLY
   *  increasing per store (see {@link monotonicClock}), so no two stamps from one
   *  store ever collide. Doubles as the age-based retry bound AND the
   *  optimistic-concurrency stamp a drain passes to
   *  {@link ByteUploadStore.markFailed}/{@link ByteUploadStore.recordAttempt} so a
   *  stale terminal decision can't bury a concurrent re-paste (see those methods) —
   *  the strict-increase is what makes that CAS, which keys on stamp inequality,
   *  collision-free by construction rather than by clock luck. */
  readonly stagedAt: number
}

/** What the caller supplies to {@link ByteUploadStore.stage}; the store stamps
 *  `status: 'staged'`, `attempts: 0`, and `stagedAt` from its clock. */
export type StageInput = Pick<
  ByteUploadRecord,
  'userId' | 'assetBlockId' | 'workspaceId' | 'contentHash' | 'contentKey'
>

export interface ByteUploadStore {
  /** Upsert a `staged` record. Idempotent: a re-paste of the same content (same
   *  `assetBlockId`) re-arms — status→staged, attempts→0, fresh stagedAt. */
  stage(input: StageInput): Promise<void>
  get(userId: string, assetBlockId: string): Promise<ByteUploadRecord | null>
  /** All of the user's records in the given status (drain reads `pending`, the
   *  reconciler reads `staged`). Scoped to `userId`. */
  listByStatus(userId: string, status: ByteUploadStatus): Promise<ByteUploadRecord[]>
  /** Count the user's records in the given status WITHOUT materializing them — the
   *  health surface only needs the `failed` count, not the records. Scoped to `userId`. */
  countByStatus(userId: string, status: ByteUploadStatus): Promise<number>
  /** staged → pending (the post-commit flip). No-op if the record is absent. */
  promote(userId: string, assetBlockId: string): Promise<void>
  /** attempts += 1, status unchanged. No-op if absent — or, when `expectedStagedAt`
   *  is given and the live record's `stagedAt` has advanced (a re-paste re-armed it
   *  since the drain snapshotted it), a no-op: a stale drain decision must not touch a
   *  freshly re-armed record. */
  recordAttempt(userId: string, assetBlockId: string, expectedStagedAt?: number): Promise<void>
  /** → failed. No-op if absent, or if the record was re-armed since `expectedStagedAt`
   *  (see {@link recordAttempt}) — otherwise a stale drain buries a live re-paste in
   *  `failed`, which nothing re-drains. */
  markFailed(userId: string, assetBlockId: string, expectedStagedAt?: number): Promise<void>
  /** failed → pending — the §9 recovery re-drive: the probe found the content path
   *  FREE, so hand the record back to the drain to re-upload the local bytes. Resets
   *  {@link ByteUploadRecord.attempts} to 0 (a fresh upload shot) and re-stamps
   *  `stagedAt` from the store clock (a fresh age window). No-op if absent, if the record
   *  isn't `failed` (nothing to recover — e.g. a re-paste already re-armed it to
   *  `staged`/`pending`), or if it was re-armed since `expectedStagedAt` (the same CAS the
   *  drain's terminal writes use — a stale recovery decision must not clobber a live
   *  re-paste). */
  requeue(userId: string, assetBlockId: string, expectedStagedAt?: number): Promise<void>
  /** Remove the record (a confirmed upload). */
  delete(userId: string, assetBlockId: string): Promise<void>
  /** Drop every record FOR THIS USER (account isolation — the store is shared
   *  across the profile's accounts). */
  clearForUser(userId: string): Promise<void>
}

/** Record-id prefix for all of a user's records — the shared collision-free
 *  `encodeURIComponent`-delimited prefix ({@link idbKeyPrefix}). */
export const uploadUserPrefix = (userId: string): string => idbKeyPrefix(userId)

/** Composite record id; encoded so a delimiter inside an id can't make two
 *  distinct (user, asset) pairs collide ({@link idbRecordId}). */
export const uploadRecordId = (userId: string, assetBlockId: string): string =>
  idbRecordId(userId, assetBlockId)

const stagedRecord = (input: StageInput, stagedAt: number): ByteUploadRecord => ({
  ...input,
  status: 'staged',
  attempts: 0,
  stagedAt,
})

/** Optimistic-concurrency guard for the drain's terminal/attempt writes. The drain
 *  reads a `pending` snapshot, then does a SLOW upload before deciding to fail/retry
 *  it — but capture is lock-free, so a re-paste of the same content can re-arm that
 *  record (`stage` bumps `stagedAt`) during the upload. A re-arm supersedes the
 *  drain's stale decision; `markFailed`/`recordAttempt` pass the snapshot's
 *  `stagedAt` and skip the write when the live stamp has moved. */
const supersededByReArm = (r: ByteUploadRecord, expectedStagedAt: number | undefined): boolean =>
  expectedStagedAt !== undefined && r.stagedAt !== expectedStagedAt

/** The RMW for {@link ByteUploadStore.requeue} (shared by both store impls, so the
 *  in-memory and IndexedDB paths can't drift). A `failed` record whose CAS stamp still
 *  matches → `pending` for a fresh drain: attempts reset (a clean upload shot) and
 *  `stagedAt` re-stamped from `clock` (a fresh age window + a new CAS stamp). Left
 *  untouched if superseded by a re-paste, or if it isn't `failed` (only `failed` is
 *  recoverable — a `staged`/`pending` record is already on its own path and must not be
 *  yanked to `pending` here). */
const requeued = (
  r: ByteUploadRecord,
  expectedStagedAt: number | undefined,
  clock: () => number,
): ByteUploadRecord =>
  supersededByReArm(r, expectedStagedAt) || r.status !== 'failed'
    ? r
    : { ...r, status: 'pending', attempts: 0, stagedAt: clock() }

/** Wrap a wall clock so successive reads STRICTLY increase, even within one
 *  millisecond. The `stagedAt` CAS ({@link supersededByReArm}) keys on stamp
 *  inequality, so two re-arms of the same record that land in the same `Date.now()`
 *  ms must still get distinct stamps — otherwise a stale drain's `markFailed` would
 *  match (`expectedStagedAt === r.stagedAt`) the live re-paste and bury it in
 *  `failed`, which nothing re-drains. Each store instance owns one counter (one per
 *  page in production), so same-page re-arms are collision-free by construction, not
 *  by clock luck. `stagedAt` stays a usable epoch ms (the age-based retry bound): it
 *  drifts above wall-clock by at most the same-ms collision count, i.e. negligibly. */
const monotonicClock = (now: () => number): (() => number) => {
  let last = 0
  return () => {
    last = Math.max(now(), last + 1)
    return last
  }
}

/** In-memory store. Tests + the fallback when IndexedDB is unavailable (the queue
 *  then lives only for the page's lifetime — a reload loses un-uploaded intents,
 *  the same failure class IndexedDB eviction already allows, recovered by re-paste). */
export class InMemoryByteUploadStore implements ByteUploadStore {
  private readonly records = new Map<string, ByteUploadRecord>()
  private readonly clock: () => number

  constructor(now: () => number = () => Date.now()) {
    this.clock = monotonicClock(now)
  }

  async stage(input: StageInput): Promise<void> {
    this.records.set(uploadRecordId(input.userId, input.assetBlockId), stagedRecord(input, this.clock()))
  }

  async get(userId: string, assetBlockId: string): Promise<ByteUploadRecord | null> {
    return this.records.get(uploadRecordId(userId, assetBlockId)) ?? null
  }

  async listByStatus(userId: string, status: ByteUploadStatus): Promise<ByteUploadRecord[]> {
    const prefix = uploadUserPrefix(userId)
    return [...this.records.entries()]
      .filter(([id, r]) => id.startsWith(prefix) && r.status === status)
      .map(([, r]) => r)
  }

  async countByStatus(userId: string, status: ByteUploadStatus): Promise<number> {
    const prefix = uploadUserPrefix(userId)
    let count = 0
    for (const [id, r] of this.records) if (id.startsWith(prefix) && r.status === status) count += 1
    return count
  }

  private mutate(
    userId: string,
    assetBlockId: string,
    fn: (r: ByteUploadRecord) => ByteUploadRecord,
  ): void {
    const id = uploadRecordId(userId, assetBlockId)
    const existing = this.records.get(id)
    if (existing) this.records.set(id, fn(existing))
  }

  async promote(userId: string, assetBlockId: string): Promise<void> {
    this.mutate(userId, assetBlockId, r => ({ ...r, status: 'pending' }))
  }

  async recordAttempt(userId: string, assetBlockId: string, expectedStagedAt?: number): Promise<void> {
    this.mutate(userId, assetBlockId, r =>
      supersededByReArm(r, expectedStagedAt) ? r : { ...r, attempts: r.attempts + 1 },
    )
  }

  async markFailed(userId: string, assetBlockId: string, expectedStagedAt?: number): Promise<void> {
    this.mutate(userId, assetBlockId, r =>
      supersededByReArm(r, expectedStagedAt) ? r : { ...r, status: 'failed' },
    )
  }

  async requeue(userId: string, assetBlockId: string, expectedStagedAt?: number): Promise<void> {
    this.mutate(userId, assetBlockId, r => requeued(r, expectedStagedAt, this.clock))
  }

  async delete(userId: string, assetBlockId: string): Promise<void> {
    this.records.delete(uploadRecordId(userId, assetBlockId))
  }

  async clearForUser(userId: string): Promise<void> {
    const prefix = uploadUserPrefix(userId)
    for (const id of [...this.records.keys()]) {
      if (id.startsWith(prefix)) this.records.delete(id)
    }
  }
}

export const UPLOAD_STORE_DB_NAME = 'km-byte-uploads'
const STORE_NAME = 'uploads'

/** IndexedDB-backed store. Writes resolve on the TRANSACTION commit (`oncomplete`),
 *  not the request's `onsuccess`, so a capture's `stage` is genuinely durable
 *  before we proceed to the block tx (the whole point of staging-before-commit) —
 *  the cached connection + commit fence come from the shared {@link IdbKeyedStore}. */
export class IndexedDbByteUploadStore implements ByteUploadStore {
  private readonly idb = new IdbKeyedStore(UPLOAD_STORE_DB_NAME, STORE_NAME)
  private readonly clock: () => number

  constructor(now: () => number = () => Date.now()) {
    this.clock = monotonicClock(now)
  }

  async stage(input: StageInput): Promise<void> {
    const record = stagedRecord(input, this.clock())
    await this.idb.tx('readwrite', store =>
      store.put(record, uploadRecordId(input.userId, input.assetBlockId)),
    )
  }

  async get(userId: string, assetBlockId: string): Promise<ByteUploadRecord | null> {
    const result = await this.idb.tx<ByteUploadRecord | undefined>('readonly', store =>
      store.get(uploadRecordId(userId, assetBlockId)),
    )
    return result ?? null
  }

  async listByStatus(userId: string, status: ByteUploadStatus): Promise<ByteUploadRecord[]> {
    const out: ByteUploadRecord[] = []
    await this.idb.scanByPrefix('readonly', uploadUserPrefix(userId), cursor => {
      const record = cursor.value as ByteUploadRecord
      if (record.status === status) out.push(record)
    })
    return out
  }

  async countByStatus(userId: string, status: ByteUploadStatus): Promise<number> {
    let n = 0
    await this.idb.scanByPrefix('readonly', uploadUserPrefix(userId), cursor => {
      if ((cursor.value as ByteUploadRecord).status === status) n += 1
    })
    return n
  }

  /** Read-modify-write a single record inside one readwrite tx. A missing record
   *  is a no-op (a reaped/never-staged id mustn't crash the post-commit flip). */
  private async mutate(
    userId: string,
    assetBlockId: string,
    fn: (r: ByteUploadRecord) => ByteUploadRecord,
  ): Promise<void> {
    const id = uploadRecordId(userId, assetBlockId)
    await this.idb.runTransaction('readwrite', async store => {
      const existing = await promisifyRequest(store.get(id) as IDBRequest<ByteUploadRecord | undefined>)
      if (existing) await promisifyRequest(store.put(fn(existing), id))
    })
  }

  async promote(userId: string, assetBlockId: string): Promise<void> {
    await this.mutate(userId, assetBlockId, r => ({ ...r, status: 'pending' }))
  }

  async recordAttempt(userId: string, assetBlockId: string, expectedStagedAt?: number): Promise<void> {
    await this.mutate(userId, assetBlockId, r =>
      supersededByReArm(r, expectedStagedAt) ? r : { ...r, attempts: r.attempts + 1 },
    )
  }

  async markFailed(userId: string, assetBlockId: string, expectedStagedAt?: number): Promise<void> {
    await this.mutate(userId, assetBlockId, r =>
      supersededByReArm(r, expectedStagedAt) ? r : { ...r, status: 'failed' },
    )
  }

  async requeue(userId: string, assetBlockId: string, expectedStagedAt?: number): Promise<void> {
    await this.mutate(userId, assetBlockId, r => requeued(r, expectedStagedAt, this.clock))
  }

  async delete(userId: string, assetBlockId: string): Promise<void> {
    await this.idb.tx('readwrite', store => store.delete(uploadRecordId(userId, assetBlockId)))
  }

  async clearForUser(userId: string): Promise<void> {
    await this.idb.deleteByPrefix(uploadUserPrefix(userId))
  }
}

/** Pick the production store when IndexedDB exists, else the in-memory fallback. */
export const createByteUploadStore = (): ByteUploadStore => {
  try {
    if (typeof indexedDB !== 'undefined') return new IndexedDbByteUploadStore()
  } catch {
    // fall through
  }
  return new InMemoryByteUploadStore()
}

// Process-wide singleton — the capture path, the up-lane drain, and the boot
// reconciler must share ONE store (an IndexedDB instance is shared storage, but a
// single instance also keeps the in-memory fallback coherent within a session).
// Tests inject their own store and never touch this.
let sharedStore: ByteUploadStore | null = null
export const getByteUploadStore = (): ByteUploadStore => (sharedStore ??= createByteUploadStore())
