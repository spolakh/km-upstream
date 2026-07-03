/**
 * The object-store seam (design docs/media-attachments/design.html §14).
 *
 * All object-store access goes behind this ~3-method interface so swapping
 * Supabase Storage for R2 / S3 / B2 later is a bytes-copy plus re-pointing one
 * module. The object is addressed by a per-workspace CONTENT KEY
 * (HMAC(K_id, sha256) for E2EE, sha256 for plaintext, §10) the caller computes;
 * BlobStore just routes bytes to `<workspaceId>/<contentKey>`.
 *
 * The mutation split (§10) — every call is a DIRECT, RLS-gated Storage request;
 * there is NO mediating upload service (the §10.1 reversal):
 *   - put    → a direct upload, RLS-gated to workspace writers. First-write-wins:
 *              `upsert: false` plus the bucket's *absent* UPDATE policy make a
 *              re-upload to an existing content path an idempotent no-op (Storage
 *              409 → resolve), never an overwrite (§10/§10.1).
 *   - get    → a direct RLS-gated Storage GET (member). The hot read path.
 *   - delete → a direct RLS-gated Storage delete (writer) — used by §16 GC and
 *              the §10.1 poison-correction, NOT by undo (§9).
 *
 * The E2EE `encb:v1:` byte shape is the CLIENT's invariant — it encodes before
 * upload (§9); the read side (the in-thread resolver, §7.3 — resolver.ts)
 * hash-verifies + AEAD-opens + fail-closes (§5.1), and an off-path audit
 * (scripts/attachments-ciphertext-audit.ts) alerts on a stray plaintext object.
 * No server inspects the body on write (§10.1 reversal, §17): a storage.objects
 * policy can't see body bytes, and a malicious writer holds the key and forges
 * the magic anyway.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { attachmentObjectPath } from './storagePaths.js'

export const ATTACHMENTS_BUCKET = 'attachments'

/**
 * A failed upload. `permanent` tells the §9 up-lane whether to quarantine the
 * record as `failed` (an auth/path/size rejection that won't clear on retry) or
 * keep it `pending` and retry with backoff (network / 5xx / a momentarily-absent
 * or expired session).
 *
 * `permanent` is an ADVISORY fast-path quarantine hint, NOT the sole exit from
 * the retry loop: only the enumerated permanent statuses/codes (403/404/413 and
 * AccessDenied/NoSuchBucket/EntityTooLarge) set it, so a permanent failure
 * outside that set (e.g. a stray 400-family `InvalidKey`) would otherwise retry
 * forever. The §9 up-lane MUST therefore bound retries by attempt count / age
 * regardless of `permanent` (the §9/§17 bounded-correction→`failed` rule) —
 * `permanent` only lets it quarantine sooner.
 */
export class BlobPutError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'BlobPutError'
  }
}

export interface BlobStore {
  /** Upload sealed bytes directly to `<workspaceId>/<contentKey>`, RLS-gated to
   *  workspace writers. Resolves `'written'` (200, freshly stored) or `'exists'`
   *  (409 — the content-addressed path was already occupied, §10.1). `'exists'`
   *  is NOT proof the stored object is OUR content: Storage is untrusted +
   *  immutable, so a stale/buggy/poisoned body may sit there. The caller MUST
   *  hash-verify the existing object before treating the upload as done (§17) —
   *  clearing blind would strand the good local bytes. Throws {@link BlobPutError}.
   *  The bytes come from `encodeBytes` (§5), which is ArrayBuffer-backed. */
  put(workspaceId: string, contentKey: string, bytes: Uint8Array<ArrayBuffer>): Promise<'written' | 'exists'>
  /** Direct RLS-gated GET of the stored object bytes (ArrayBuffer-backed, so it
   *  feeds `decodeBytes` directly). Throws if absent/denied. */
  get(workspaceId: string, contentKey: string): Promise<Uint8Array<ArrayBuffer>>
  /** The §9 recovery actor's presence probe of the content path: the stored object's
   *  bytes when the path is occupied (so the caller can decode + hash-verify — the
   *  §9/§17 3-way), or `null` when the path reads as absent (a 404 — free to re-drive).
   *  Throws on an ambiguous read (offline / 5xx / unknown) so recovery DEFERS rather than
   *  mistaking a transient failure for "path free" and re-uploading against an object it
   *  never actually saw was gone. NOTE this can't distinguish a genuinely-absent object
   *  from an RLS-DENIED one: Supabase Storage hides existence, so an unauthorized download
   *  returns a 404-shape too, which surfaces here as `null` ("path free"). That's benign
   *  for recovery — the resulting re-drive is `isActiveUser`-gated (no PUT under the wrong
   *  session) and self-corrects via the drain's 409-verify. (This is the same direct RLS
   *  GET as {@link get}; the split is purely about turning the 404 into a value instead of
   *  a throw, which recovery branches on.) */
  probe(workspaceId: string, contentKey: string): Promise<Uint8Array<ArrayBuffer> | null>
  /** Direct RLS-gated delete (writer). Idempotent: supabase-js `remove` returns
   *  200 with an EMPTY list (no error) when the object is absent or RLS-denied,
   *  so this resolves on a no-op. Fine for §16 GC; the §10.1 poison-correction
   *  must NOT infer "the path is now free" from this resolving — it GET-verifies
   *  the path is gone before re-uploading (the §9 re-attempt sweep does this). */
  delete(workspaceId: string, contentKey: string): Promise<void>
}

export interface SupabaseBlobStoreDeps {
  client: SupabaseClient
  /** Probes for an active session. A momentarily-absent session is TRANSIENT
   *  (the §9 up-lane refreshes + retries rather than burning the record to
   *  `failed`); a present session that isn't a workspace writer is the permanent
   *  403 the upload itself returns. It is ONLY a presence-probe — the upload
   *  rides `client`'s own session, so this MUST read the same `SupabaseClient`'s
   *  auth store or it gives false confidence. (A present-but-expired token sails
   *  past the probe and is handled as a transient '400' by the classifier.) */
  getAccessToken: () => Promise<string | null>
}

// Storage error shapes vary by storage-api version. supabase-js surfaces
// `statusCode = body.statusCode ?? body.code ?? String(httpStatus)` alongside a
// numeric `.status`. So the same logical error reaches us as EITHER a numeric code
// (statusCode '403') OR a symbolic one (statusCode 'AccessDenied'), and which of
// `.status` / `statusCode` carries the usable HTTP status isn't guaranteed stable
// across versions. We therefore classify on BOTH the HTTP status AND the symbolic
// code, so we're correct under either shape — keying on only one misclassifies the
// other.

/** Permanent HTTP statuses — won't clear on retry → the §9 record goes to
 *  `failed`: 403 not-a-writer / removed member, 404 bucket missing (misconfig),
 *  413 over the bucket's file_size_limit. */
const PERMANENT_HTTP_STATUSES = new Set([403, 404, 413])
/** The symbolic siblings of those statuses (the word-code shape). */
const PERMANENT_STORAGE_CODES = new Set(['AccessDenied', 'NoSuchBucket', 'EntityTooLarge'])
/** Duplicate-object codes (the symbolic shape's 409). */
const ALREADY_EXISTS_CODES = new Set(['ResourceAlreadyExists', 'KeyAlreadyExists', 'Duplicate'])

/** The real HTTP status of a Storage error: a numeric `statusCode` when present
 *  (the shape that puts the code there), else `.status` (the shape that puts a
 *  word in `statusCode`). */
const httpStatusOf = (err: { status?: number; statusCode?: string | number }): number | undefined => {
  const sc = err.statusCode != null ? String(err.statusCode) : undefined
  if (sc != null && /^\d+$/.test(sc)) return Number(sc)
  return err.status
}

/** Storage "object already exists" — a first-write-wins SUCCESS, not an error
 *  (§10.1): HTTP 409, or the symbolic `ResourceAlreadyExists` / `KeyAlreadyExists`.
 *  Detect it so an unrelated error can't be mis-read as an idempotent success
 *  (which would clear the §9 queue against an object that was never written).
 *  Exported so the RLS verifier (scripts/attachments-rls-verify.ts) classifies the
 *  first-write-wins re-upload through the SAME predicate it's meant to validate,
 *  instead of a drifting copy of the code set. */
export const isAlreadyExists = (err: { status?: number; statusCode?: string | number }): boolean => {
  const sc = err.statusCode != null ? String(err.statusCode) : ''
  return sc === '409' || err.status === 409 || ALREADY_EXISTS_CODES.has(sc)
}

/** Object-not-found codes (a download's symbolic 404). */
const NOT_FOUND_STORAGE_CODES = new Set(['NoSuchKey', 'NotFound', 'KeyNotFound'])

/** Storage "object not found" — a DEFINITIVE 404 on a GET/download, i.e. the content
 *  path is FREE (the §9 recovery probe re-drives on it). Detected on BOTH the real HTTP
 *  status (via {@link httpStatusOf}, so a numeric `statusCode: '404'` flattened onto
 *  `.status: 400` is still caught) AND the symbolic word-code shape — the same
 *  dual-shape robustness {@link isAlreadyExists} needs. Anything NOT matched here stays
 *  a throw the probe treats as transient (offline / 5xx / unknown) — recovery must not
 *  read an ambiguous error as "path free". (A genuinely RLS-DENIED read is NOT such an
 *  error: Storage hides existence, so it returns a 404-shape that DOES match here → null;
 *  see {@link BlobStore.probe}.) Module-private — only `probe` consumes it
 *  (unlike `isAlreadyExists`, which the off-path RLS verifier also uses). */
const isObjectNotFound = (err: { status?: number; statusCode?: string | number }): boolean => {
  const sc = err.statusCode != null ? String(err.statusCode) : undefined
  return httpStatusOf(err) === 404 || (sc != null && NOT_FOUND_STORAGE_CODES.has(sc))
}

export const createSupabaseBlobStore = (deps: SupabaseBlobStoreDeps): BlobStore => {
  // The flat `<ws>/<contentKey>` shape, shared with the off-path audit (§10).
  const objectPath = attachmentObjectPath
  const { client, getAccessToken } = deps

  return {
    async put(workspaceId, contentKey, bytes) {
      // No session → transient: the caller refreshes and retries (don't burn the
      // §9 record to `failed` over a momentarily-absent token). The upload rides
      // the client's own session, which the RLS insert policy authorizes.
      const token = await getAccessToken()
      if (!token) throw new BlobPutError('no active session', false, 401, 'no_session')

      // `statusCode` is `string | number`: supabase-js sets it from `body.statusCode
      // ?? body.code ?? String(httpStatus)`, so a numeric body `code` arrives as a
      // number. The classifier helpers `String()`-coerce it; type it honestly.
      let error: { status?: number; statusCode?: string | number; message?: string } | null
      try {
        ;({ error } = await client.storage
          .from(ATTACHMENTS_BUCKET)
          .upload(objectPath(workspaceId, contentKey), bytes, {
            contentType: 'application/octet-stream',
            upsert: false, // never overwrite — the path is content-addressed (§10); first-write-wins
          }))
      } catch (cause) {
        // supabase-js returns errors in the result, but classify an unexpected
        // throw as a transient network failure rather than crashing the drain.
        throw new BlobPutError(`upload network error: ${String(cause)}`, false, undefined, 'network')
      }

      if (!error) return 'written' // 200 — the object was written
      // Idempotent dedup: the path is already present (§10.1). Report it distinctly
      // so the drain hash-verifies the stored object before clearing the §9 queue —
      // a poisoned path must surface, not silently clear (§17).
      if (isAlreadyExists(error)) return 'exists'

      // Permanent if EITHER the real HTTP status OR the symbolic code says so —
      // correct whether Storage gives us a numeric code (with a maybe-flattened
      // .status) or a word code (with the real .status). Anything else (an
      // expired JWT, 401, 5xx, network) is transient. `.permanent` is advisory:
      // a permanent error outside both sets falls through to transient, so the
      // §9 up-lane must still bound retries by attempt/age (see BlobPutError).
      const sc = error.statusCode != null ? String(error.statusCode) : undefined
      const status = httpStatusOf(error)
      const permanent =
        (status != null && PERMANENT_HTTP_STATUSES.has(status)) ||
        (sc != null && PERMANENT_STORAGE_CODES.has(sc))
      throw new BlobPutError(
        `upload failed${sc != null ? ` (${sc})` : status != null ? ` (${status})` : ''}: ${error.message ?? 'unknown error'}`,
        permanent,
        status,
      )
    },

    async get(workspaceId, contentKey) {
      const { data, error } = await client.storage
        .from(ATTACHMENTS_BUCKET)
        .download(objectPath(workspaceId, contentKey))
      if (error) throw error
      if (!data) throw new Error(`blob get: empty body for ${objectPath(workspaceId, contentKey)}`)
      return new Uint8Array(await data.arrayBuffer())
    },

    async probe(workspaceId, contentKey) {
      const { data, error } = await client.storage
        .from(ATTACHMENTS_BUCKET)
        .download(objectPath(workspaceId, contentKey))
      if (error) {
        // Only a DEFINITIVE 404 means "path free" → null (re-drive). Everything else
        // (offline / 5xx / unknown) is ambiguous — rethrow so recovery defers rather than
        // re-uploading over an object it never confirmed was gone. (A denied read isn't
        // ambiguous here — Storage hides existence, so it 404s → null; handled above.)
        if (isObjectNotFound(error as { status?: number; statusCode?: string | number })) return null
        throw error
      }
      // No error + no body: treat as absent (nothing there to verify). A subsequent
      // re-drive PUT is first-write-wins idempotent, so if an object DID materialize
      // between this probe and the PUT, the drain's 409-verify path self-corrects.
      if (!data) return null
      return new Uint8Array(await data.arrayBuffer())
    },

    async delete(workspaceId, contentKey) {
      const { error } = await client.storage
        .from(ATTACHMENTS_BUCKET)
        .remove([objectPath(workspaceId, contentKey)])
      if (error) throw error
    },
  }
}
