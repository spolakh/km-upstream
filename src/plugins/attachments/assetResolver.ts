/**
 * The app-wired in-thread asset resolver singleton (design §7.3).
 *
 * Wires the pure {@link createAssetResolver} to the real app deps:
 *   - byteStore  — the OPFS byte store (§8), one per origin.
 *   - blobStore  — Supabase Storage, authed by the app's own session.
 *   - sync deps  — the ACTIVE user's §6 resolver (materializability / WK / K_id),
 *                  re-read per call so an account switch is reflected without
 *                  rebuilding the singleton.
 *   - getUserId  — the active account, the byte store's isolation scope (§7).
 *
 * Built once, lazily. When Supabase isn't configured (a local-only / unauthed
 * build) there's no REMOTE object store — but a locally-captured paste still wrote
 * its plaintext to the OPFS byte store, so we still build the NORMAL resolver, just
 * with a blob store whose remote `get` always misses ({@link NO_REMOTE_BLOB_STORE}).
 * The resolver checks the local byte store first (§7.3), so a local-only paste
 * renders from disk; only a genuine remote miss fails closed (placeholder).
 */

import { getActiveSyncResolver, getActiveUserId, isRemoteSyncActive } from '@/data/repoProvider.js'
import { supabase } from '@/services/supabase.js'
import { BlobPutError, createSupabaseBlobStore, type BlobStore } from './blobStore.js'
import { getByteStore } from './byteStore.js'
import { createAssetResolver, type AssetResolver } from './resolver.js'

let singleton: AssetResolver | null = null

/** A blob store for a build with no remote object store (local-only / unauthed):
 *  `get` always misses, so the resolver serves LOCAL byte-store hits and fails
 *  closed (`fetch-failed`) only on a true miss. `put`/`delete` are never reached
 *  via the resolver (the up-lane has its own blob store) but are total for safety. */
export const NO_REMOTE_BLOB_STORE: BlobStore = {
  put: async () => {
    throw new BlobPutError('no remote object store configured', false, undefined, 'no_remote')
  },
  get: async () => {
    throw new Error('no remote object store configured')
  },
  // Throw (not a 404-null) so the §9 recovery probe treats local-only as TRANSIENT and
  // DEFERS — never mistaking "no remote configured" for "path free" and re-driving an
  // upload there's nowhere to send. (Recovery is gated off in local-only anyway; this
  // only covers a mode flip mid-lane.)
  probe: async () => {
    throw new Error('no remote object store configured')
  },
  delete: async () => {},
}

/** Wrap the remote blob store so it's consulted ONLY while the active session has
 *  remote sync on; in local-only mode it behaves as {@link NO_REMOTE_BLOB_STORE} (a
 *  remote miss), so the resolver still serves local OPFS hits but never makes a
 *  Supabase request — the read-side half of the "no remote requests in local-only"
 *  contract (Codex P1). Checked PER CALL, so a re-login mode switch is respected
 *  without rebuilding the singleton. Shared with the up-lane (assetUpload's
 *  getBlobStore) so the WRITE side gets the same per-call gate: an arm-time-only
 *  check can go stale if remote sync is toggled off while a drain lock is held. */
export const remoteSyncGated = (remote: BlobStore): BlobStore => ({
  put: (ws, key, bytes) => (isRemoteSyncActive() ? remote : NO_REMOTE_BLOB_STORE).put(ws, key, bytes),
  get: (ws, key) => (isRemoteSyncActive() ? remote : NO_REMOTE_BLOB_STORE).get(ws, key),
  probe: (ws, key) => (isRemoteSyncActive() ? remote : NO_REMOTE_BLOB_STORE).probe(ws, key),
  delete: (ws, key) => (isRemoteSyncActive() ? remote : NO_REMOTE_BLOB_STORE).delete(ws, key),
})

export const getAssetResolver = (): AssetResolver => {
  if (singleton) return singleton

  let blobStore: BlobStore
  if (supabase) {
    const client = supabase
    blobStore = remoteSyncGated(
      createSupabaseBlobStore({
        // Presence probe only — the upload/download ride the client's own session.
        client,
        getAccessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null,
      }),
    )
  } else {
    blobStore = NO_REMOTE_BLOB_STORE
  }

  singleton = createAssetResolver({
    getUserId: getActiveUserId,
    byteStore: getByteStore(),
    blobStore,
    // Delegate the three-valued decode + key decisions to the active user's §6
    // resolver; signed out → fail closed (defer / no key).
    getMaterializability: (ws) => getActiveSyncResolver()?.getMaterializability(ws) ?? 'defer',
    getCek: (ws) => getActiveSyncResolver()?.getCek(ws) ?? Promise.resolve(null),
    getContentKeyHmac: (ws) => getActiveSyncResolver()?.getContentKeyHmac(ws) ?? Promise.resolve(null),
  })
  return singleton
}
