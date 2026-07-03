import { beforeEach, describe, expect, it } from 'vitest'
import { encodeBytes } from '@/sync/byteTransform.js'
import { computeContentHash } from '@/sync/crypto/contentHash.js'
import type { GetCek, GetMaterializability, Materializability } from '@/sync/transform.js'
import type { BlobStore } from './blobStore.js'
import { recoverFailedUploads } from './uploadRecovery.js'
import { InMemoryByteUploadStore, type StageInput } from './uploadStore.js'

const USER = 'u1'
const WS = 'ws1'
const KEY = 'ck-deadbeef'
const BLOCK = 'media:ck-deadbeef'

const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i & 0xff)) as Uint8Array<ArrayBuffer>

const stageInput = (over: Partial<StageInput> = {}): StageInput => ({
  userId: USER,
  assetBlockId: BLOCK,
  workspaceId: WS,
  contentHash: 'sha256:placeholder',
  contentKey: KEY,
  ...over,
})

/** Stage → promote → markFailed, so the store holds a `failed` record for `hash`. */
const stageFailed = async (store: InMemoryByteUploadStore, over: Partial<StageInput> = {}) => {
  await store.stage(stageInput(over))
  await store.promote(over.userId ?? USER, over.assetBlockId ?? BLOCK)
  await store.markFailed(over.userId ?? USER, over.assetBlockId ?? BLOCK)
}

/** A BlobStore whose only real method is `probe`: returns `probeResult` (or throws
 *  `probeThrows`). put/get/delete are unused by the recovery pass and assert if hit. */
class FakeBlobStore implements BlobStore {
  probeResult: Uint8Array<ArrayBuffer> | null = null
  probeThrows: (() => never) | null = null
  /** Runs DURING the (slow) probe, before it resolves — used to simulate a re-paste
   *  landing mid-probe (the interleaving the un-CAS'd `delete` must tolerate). */
  onProbe: (() => Promise<void>) | null = null
  probes = 0
  async probe(): Promise<Uint8Array<ArrayBuffer> | null> {
    this.probes += 1
    if (this.probeThrows) this.probeThrows()
    if (this.onProbe) await this.onProbe()
    return this.probeResult
  }
  async put(): Promise<'written' | 'exists'> {
    throw new Error('recovery must never PUT — it re-drives only via the drain')
  }
  async get(): Promise<Uint8Array<ArrayBuffer>> {
    throw new Error('recovery uses probe(), not get()')
  }
  async delete(): Promise<void> {
    throw new Error('recovery never deletes the remote object')
  }
}

const mat = (m: Materializability): GetMaterializability => async () => m

describe('recoverFailedUploads (§9 failed-upload recovery actor)', () => {
  let store: InMemoryByteUploadStore
  let blobStore: FakeBlobStore
  const matCopy = mat('copy')
  const noCek: GetCek = async () => null

  beforeEach(() => {
    store = new InMemoryByteUploadStore(() => 1000)
    blobStore = new FakeBlobStore()
  })

  const deps = (over: Partial<Parameters<typeof recoverFailedUploads>[1]> = {}) => ({
    store,
    blobStore,
    getMaterializability: matCopy,
    getCek: noCek,
    ...over,
  })

  it('ABSENT path (404) → requeues failed → pending so the drain re-uploads', async () => {
    await stageFailed(store)
    blobStore.probeResult = null // the content path is free

    const summary = await recoverFailedUploads(USER, deps())

    expect(summary).toMatchObject({ requeued: 1, cleared: 0, poisoned: 0 })
    const rec = await store.get(USER, BLOCK)
    expect(rec).toMatchObject({ status: 'pending', attempts: 0 })
    expect(blobStore.probes).toBe(1)
  })

  it('PRESENT + hash-VERIFIES → deletes the record (already uploaded elsewhere), no re-upload', async () => {
    const plain = bytes(24)
    const realHash = await computeContentHash(plain)
    await stageFailed(store, { contentHash: realHash })
    blobStore.probeResult = plain // the path holds OUR exact (plaintext) content

    const summary = await recoverFailedUploads(USER, deps())

    expect(summary).toMatchObject({ cleared: 1, requeued: 0, poisoned: 0 })
    expect(await store.get(USER, BLOCK)).toBeNull() // cleared — the content is safely on the server
  })

  it('PRESENT + verifies CLEARS even a record RE-PASTED mid-probe (the un-CAS’d delete is content-safe)', async () => {
    // The cleared branch deletes WITHOUT the `stagedAt` CAS the requeue/markFailed writes use.
    // Prove that's safe under the worst interleaving: a re-paste re-arms the record (→ `staged`,
    // fresh stamp) WHILE the slow probe runs. It's correct to delete anyway — assetBlockId =
    // uuidv5(workspace:contentKey) derives from the content hash, so the re-armed record carries
    // the SAME content, which we just hash-verified is durably on the server (nothing left to
    // upload; a later promote no-ops). A CAS on delete here would WRONGLY leave the re-armed
    // record behind, so this also guards against reintroducing one.
    const plain = bytes(32)
    const realHash = await computeContentHash(plain)
    await stageFailed(store, { contentHash: realHash })
    blobStore.probeResult = plain
    blobStore.onProbe = async () => {
      // the re-paste lands during the probe: re-arm the SAME record to `staged`, fresh stagedAt
      await store.stage(stageInput({ contentHash: realHash }))
    }

    const summary = await recoverFailedUploads(USER, deps())

    expect(summary).toMatchObject({ cleared: 1 })
    expect(await store.get(USER, BLOCK)).toBeNull() // deleted despite the mid-probe re-arm — safe
  })

  it('PRESENT + hash-MISMATCHES → stays failed (poisoned path, §17), never requeues or clears', async () => {
    const realHash = await computeContentHash(bytes(24))
    await stageFailed(store, { contentHash: realHash })
    blobStore.probeResult = bytes(99) // a DIFFERENT body occupies the content path

    const summary = await recoverFailedUploads(USER, deps())

    expect(summary).toMatchObject({ poisoned: 1, requeued: 0, cleared: 0 })
    expect((await store.get(USER, BLOCK))?.status).toBe('failed') // still surfaced for discard
  })

  it('PRESENT but UNDECODABLE (e2ee, wrong/absent key) → poisoned, stays failed', async () => {
    // e2ee mode with no CEK: decodeBytes throws → treated as poisoned (§17), like the drain.
    await stageFailed(store, { contentHash: await computeContentHash(bytes(8)) })
    blobStore.probeResult = bytes(50) // not a valid encb envelope for this key

    const summary = await recoverFailedUploads(USER, deps({ getMaterializability: mat('decrypt') }))

    expect(summary).toMatchObject({ poisoned: 1 })
    expect((await store.get(USER, BLOCK))?.status).toBe('failed')
  })

  it('e2ee PRESENT + verifies (sealed round-trip) → cleared', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const getCek: GetCek = async () => key
    const plain = bytes(40)
    const hash = await computeContentHash(plain)
    await stageFailed(store, { contentHash: hash })
    // The remote object is the SEALED ciphertext the drain would have uploaded.
    blobStore.probeResult = await encodeBytes(plain, 'e2ee', getCek, { contentHash: hash, workspaceId: WS })

    const summary = await recoverFailedUploads(USER, deps({ getMaterializability: mat('decrypt'), getCek }))

    expect(summary).toMatchObject({ cleared: 1 })
    expect(await store.get(USER, BLOCK)).toBeNull()
  })

  it('a TRANSIENT probe error (offline / 5xx / denied) → defers, no state change, no PUT', async () => {
    await stageFailed(store)
    blobStore.probeThrows = () => {
      throw new Error('offline')
    }

    const summary = await recoverFailedUploads(USER, deps())

    expect(summary).toMatchObject({ deferred: 1, requeued: 0, cleared: 0 })
    expect((await store.get(USER, BLOCK))?.status).toBe('failed') // untouched, re-probed next trigger
  })

  it('DEFERS (no probe at all) when the workspace is not materializable (locked / unpinned)', async () => {
    await stageFailed(store)

    const summary = await recoverFailedUploads(USER, deps({ getMaterializability: mat('defer') }))

    expect(summary).toMatchObject({ deferred: 1 })
    expect(blobStore.probes).toBe(0) // never even hit the network — can't verify while locked
    expect((await store.get(USER, BLOCK))?.status).toBe('failed')
  })

  it('DEFERS (no probe) when the queued user is no longer the active account', async () => {
    await stageFailed(store)

    const summary = await recoverFailedUploads(USER, deps({ isActiveUser: () => false }))

    expect(summary).toMatchObject({ deferred: 1 })
    expect(blobStore.probes).toBe(0)
    expect((await store.get(USER, BLOCK))?.status).toBe('failed')
  })

  it('only touches FAILED records — pending / staged are left for the drain / reconciler', async () => {
    await store.stage(stageInput({ assetBlockId: 'media:staged', contentKey: 'ks' })) // staged
    await store.stage(stageInput({ assetBlockId: 'media:pending', contentKey: 'kp' }))
    await store.promote(USER, 'media:pending') // pending
    blobStore.probeResult = null

    const summary = await recoverFailedUploads(USER, deps())

    expect(summary).toEqual({ requeued: 0, cleared: 0, poisoned: 0, deferred: 0 })
    expect(blobStore.probes).toBe(0) // no failed records → nothing probed
    expect((await store.get(USER, 'media:staged'))?.status).toBe('staged')
    expect((await store.get(USER, 'media:pending'))?.status).toBe('pending')
  })

  it('re-drives an ABSENT path every time (user-triggered — no automatic re-drive bound)', async () => {
    // The user is the rate limiter: a record that came back failed after prior retries is
    // re-driven again on the next Retry, not quarantined by an attempt counter. (A poisoned
    // path never re-drives regardless — it's present+mismatch, a GET + hash-check, never a PUT.)
    await stageFailed(store)
    for (let i = 0; i < 5; i++) {
      await store.requeue(USER, BLOCK)
      await store.markFailed(USER, BLOCK) // each prior re-drive came back failed
    }
    blobStore.probeResult = null // path is free

    const summary = await recoverFailedUploads(USER, deps())

    expect(summary).toMatchObject({ requeued: 1 })
    expect((await store.get(USER, BLOCK))?.status).toBe('pending')
  })

  it('is scoped to the user — another account’s failed record is not probed or touched', async () => {
    await stageFailed(store, { userId: 'u1', assetBlockId: 'media:mine', contentKey: 'k1' })
    await stageFailed(store, { userId: 'u2', assetBlockId: 'media:theirs', contentKey: 'k2' })
    blobStore.probeResult = null

    const summary = await recoverFailedUploads('u1', deps())

    expect(summary).toMatchObject({ requeued: 1 })
    expect(blobStore.probes).toBe(1) // only u1's one failed record
    expect((await store.get('u2', 'media:theirs'))?.status).toBe('failed') // untouched
  })
})
