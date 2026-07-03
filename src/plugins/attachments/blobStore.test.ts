import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { ATTACHMENTS_BUCKET, BlobPutError, createSupabaseBlobStore } from './blobStore.js'

/** A StorageApiError-shaped result error, as supabase-js surfaces it. */
type UploadResult = { error: { status?: number; statusCode?: string; message?: string } | null }
type UploadFn = (path: string, body: unknown, opts: unknown) => Promise<UploadResult>

/** Minimal client exposing just `storage.from(bucket).upload(...)` — put() never
 *  touches anything else. Returns the captured upload spy for assertions. */
const makeStore = (upload: UploadFn, token: string | null = 'tok-123') => {
  const from = vi.fn(() => ({ upload }))
  const client = { storage: { from } } as unknown as SupabaseClient
  const store = createSupabaseBlobStore({ client, getAccessToken: async () => token })
  return { store, from }
}

const ok = async (): Promise<UploadResult> => ({ error: null })
// Mirror the supabase-js StorageApiError: `.statusCode` is the body `statusCode`
// (numeric string) OR the body `code` (a word), and `.status` is the HTTP status.
// `fail(code)` models the NUMERIC shape (statusCode '403', .status flattened to
// 400; 500 stays 500). `fail(code, httpStatus)` models the SYMBOLIC shape
// (statusCode 'AccessDenied', .status the real code). A statusless error models
// an offline StorageUnknownError.
const fail = (statusCode?: string, httpStatus?: number): UploadFn => async () => ({
  error: {
    status: httpStatus ?? (statusCode == null ? undefined : statusCode === '500' ? 500 : 400),
    statusCode,
    message: `code ${statusCode ?? 'network'}`,
  },
})

/** Await a put expected to reject, returning the typed BlobPutError. */
const putError = async (p: Promise<'written' | 'exists'>): Promise<BlobPutError> => {
  try {
    await p
  } catch (e) {
    if (e instanceof BlobPutError) return e
    throw e
  }
  throw new Error('expected put to reject with a BlobPutError, but it resolved')
}

describe('SupabaseBlobStore.put', () => {
  it('uploads directly to <ws>/<contentKey> in the attachments bucket, first-write-wins', async () => {
    const upload = vi.fn<UploadFn>(ok)
    const bytes = new Uint8Array([1, 2, 3])
    const { store, from } = makeStore(upload)
    await store.put('ws-A', 'deadbeef', bytes)

    expect(from).toHaveBeenCalledWith(ATTACHMENTS_BUCKET)
    expect(upload).toHaveBeenCalledOnce()
    const [path, body, opts] = upload.mock.calls[0]
    expect(path).toBe('ws-A/deadbeef')
    expect(body).toBe(bytes)
    expect(opts).toMatchObject({ upsert: false, contentType: 'application/octet-stream' })
  })

  it('resolves "written" on a fresh 200 upload', async () => {
    await expect(makeStore(ok).store.put('ws', 'k', new Uint8Array())).resolves.toBe('written')
  })

  it('resolves "exists" on a 409 (existing path) as idempotent first-write-wins dedup', async () => {
    // The duplicate's HTTP line is the flattened 400; the '409' is in the body
    // statusCode — so detection must key on statusCode, not the numeric status.
    // 'exists' (not 'written') is what tells the drain to hash-verify before clearing.
    await expect(makeStore(fail('409')).store.put('ws', 'k', new Uint8Array())).resolves.toBe('exists')
  })

  it('treats 403 (not a writer), 404 (no bucket), 413 (too large) as PERMANENT', async () => {
    for (const code of ['403', '404', '413']) {
      const err = await putError(makeStore(fail(code)).store.put('ws', 'k', new Uint8Array()))
      expect(err.permanent, `code ${code} should be permanent`).toBe(true)
      expect(err.status).toBe(Number(code)) // the semantic code, not the flattened 400
    }
  })

  it('treats an expired/invalid JWT (body code 400) as TRANSIENT, not quarantined', async () => {
    // Storage surfaces an expired token as statusCode '400'; it must retry after
    // a session refresh, NOT burn the §9 record to `failed`.
    const err = await putError(makeStore(fail('400')).store.put('ws', 'k', new Uint8Array()))
    expect(err.permanent).toBe(false)
  })

  // The SYMBOLIC error shape (newer storage-api): statusCode is a word, .status
  // is the real HTTP code. Classification must stay correct under it too.
  it('treats symbolic permanent codes (AccessDenied/NoSuchBucket/EntityTooLarge) as PERMANENT', async () => {
    for (const [code, http] of [
      ['AccessDenied', 403],
      ['NoSuchBucket', 404],
      ['EntityTooLarge', 413],
    ] as const) {
      const err = await putError(makeStore(fail(code, http)).store.put('ws', 'k', new Uint8Array()))
      expect(err.permanent, `${code} should be permanent`).toBe(true)
      expect(err.status).toBe(http)
    }
  })

  it('still classifies a symbolic permanent code PERMANENT even if .status is flattened to 400', async () => {
    // Worst case: the word is in statusCode AND the HTTP line is flattened, so
    // only the symbolic-code set can catch it.
    const err = await putError(makeStore(fail('AccessDenied', 400)).store.put('ws', 'k', new Uint8Array()))
    expect(err.permanent).toBe(true)
  })

  it('resolves "exists" on a symbolic duplicate code (ResourceAlreadyExists / KeyAlreadyExists)', async () => {
    for (const code of ['ResourceAlreadyExists', 'KeyAlreadyExists']) {
      await expect(makeStore(fail(code, 409)).store.put('ws', 'k', new Uint8Array())).resolves.toBe('exists')
    }
  })

  it('treats a symbolic auth error (InvalidJWT, real 401) as TRANSIENT', async () => {
    const err = await putError(makeStore(fail('InvalidJWT', 401)).store.put('ws', 'k', new Uint8Array()))
    expect(err.permanent).toBe(false)
  })

  it('treats 401, 5xx, and an unknown/network error as TRANSIENT (retryable)', async () => {
    for (const code of ['401', '500', '503']) {
      const err = await putError(makeStore(fail(code)).store.put('ws', 'k', new Uint8Array()))
      expect(err.permanent, `code ${code} should be transient`).toBe(false)
    }
    // A statusless error (e.g. an offline StorageUnknownError) is transient.
    const networkErr = await putError(makeStore(fail()).store.put('ws', 'k', new Uint8Array()))
    expect(networkErr.permanent).toBe(false)
    expect(networkErr.status).toBeUndefined()
  })

  it('treats an unexpected throw from upload as a transient network error', async () => {
    const upload = vi.fn<UploadFn>(async () => {
      throw new Error('offline')
    })
    const err = await putError(makeStore(upload).store.put('ws', 'k', new Uint8Array()))
    expect(err.permanent).toBe(false)
    expect(err.code).toBe('network')
  })

  it('treats a missing session as transient and never attempts the upload', async () => {
    const upload = vi.fn<UploadFn>(ok)
    const err = await putError(makeStore(upload, null).store.put('ws', 'k', new Uint8Array()))
    expect(err.permanent).toBe(false)
    expect(err.code).toBe('no_session')
    expect(upload).not.toHaveBeenCalled()
  })
})

type DownloadResult = { data: { arrayBuffer(): Promise<ArrayBuffer> } | null; error: unknown }
type RemoveResult = { data: unknown; error: unknown }

/** A client exposing `storage.from(bucket).{download,remove}` — get()/delete()
 *  ride the client session directly (no token probe), so getAccessToken is moot. */
const makeRwStore = (impl: {
  download?: (path: string) => Promise<DownloadResult>
  remove?: (paths: string[]) => Promise<RemoveResult>
}) => {
  const download = vi.fn(impl.download ?? (async () => ({ data: null, error: null })))
  const remove = vi.fn(impl.remove ?? (async () => ({ data: [], error: null })))
  const from = vi.fn(() => ({ download, remove }))
  const client = { storage: { from } } as unknown as SupabaseClient
  const store = createSupabaseBlobStore({ client, getAccessToken: async () => 'tok' })
  return { store, from, download, remove }
}

describe('SupabaseBlobStore.get', () => {
  it('downloads <ws>/<key> from the attachments bucket and returns the bytes', async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const { store, from, download } = makeRwStore({
      download: async () => ({ data: new Blob([bytes]), error: null }),
    })
    expect(await store.get('ws-A', 'deadbeef')).toEqual(bytes)
    expect(from).toHaveBeenCalledWith(ATTACHMENTS_BUCKET)
    expect(download).toHaveBeenCalledWith('ws-A/deadbeef')
  })

  it('throws the storage error when the download is denied/absent', async () => {
    const boom = new Error('denied')
    const { store } = makeRwStore({ download: async () => ({ data: null, error: boom }) })
    await expect(store.get('ws', 'k')).rejects.toBe(boom)
  })

  it('throws on an empty body (no error, no data)', async () => {
    const { store } = makeRwStore({ download: async () => ({ data: null, error: null }) })
    await expect(store.get('ws', 'k')).rejects.toThrow(/empty body/)
  })
})

describe('SupabaseBlobStore.probe (the §9 recovery presence probe)', () => {
  it('returns the bytes when the content path is occupied (→ decode + hash-verify)', async () => {
    const bytes = new Uint8Array([4, 5, 6])
    const { store, download } = makeRwStore({ download: async () => ({ data: new Blob([bytes]), error: null }) })
    expect(await store.probe('ws', 'ck')).toEqual(bytes)
    expect(download).toHaveBeenCalledWith('ws/ck')
  })

  it('returns null on a DEFINITIVE 404 (numeric statusCode shape) — the path is free to re-drive', async () => {
    // supabase flattens the HTTP line to 400 and puts the semantic code in statusCode.
    const { store } = makeRwStore({
      download: async () => ({ data: null, error: { status: 400, statusCode: '404', message: 'Object not found' } }),
    })
    expect(await store.probe('ws', 'ck')).toBeNull()
  })

  it('returns null on a symbolic not-found code (NoSuchKey / real 404)', async () => {
    for (const [statusCode, status] of [['NoSuchKey', 404], ['NotFound', 404]] as const) {
      const { store } = makeRwStore({ download: async () => ({ data: null, error: { status, statusCode } }) })
      expect(await store.probe('ws', 'ck')).toBeNull()
    }
  })

  it('THROWS on an ambiguous error (offline / 5xx / denied) so recovery defers, never re-drives', async () => {
    for (const error of [
      { status: 503, statusCode: '503', message: '5xx' }, // server down
      { status: 403, statusCode: 'AccessDenied' }, // a genuine 403 defers (a denied READ is 404-shaped — see probe doc)
      { message: 'network' }, // statusless offline error
    ]) {
      const { store } = makeRwStore({ download: async () => ({ data: null, error }) })
      await expect(store.probe('ws', 'ck')).rejects.toBe(error)
    }
  })

  it('treats no-error + no-body as absent (null), not a throw', async () => {
    const { store } = makeRwStore({ download: async () => ({ data: null, error: null }) })
    expect(await store.probe('ws', 'ck')).toBeNull()
  })
})

describe('SupabaseBlobStore.delete', () => {
  it('removes <ws>/<key> from the attachments bucket', async () => {
    const { store, from, remove } = makeRwStore({ remove: async () => ({ data: [{}], error: null }) })
    await expect(store.delete('ws-A', 'deadbeef')).resolves.toBeUndefined()
    expect(from).toHaveBeenCalledWith(ATTACHMENTS_BUCKET)
    expect(remove).toHaveBeenCalledWith(['ws-A/deadbeef'])
  })

  it('resolves on a no-op (remove returns an empty list, no error — RLS-denied or absent)', async () => {
    // The documented contract: supabase-js `remove` 200s with an EMPTY list (no
    // error) when the object is absent or RLS-denied. delete() must NOT throw —
    // §16 GC is best-effort; the §10.1 poison-correction GET-verifies separately.
    const { store } = makeRwStore({ remove: async () => ({ data: [], error: null }) })
    await expect(store.delete('ws', 'k')).resolves.toBeUndefined()
  })

  it('throws when remove returns an error', async () => {
    const boom = new Error('storage down')
    const { store } = makeRwStore({ remove: async () => ({ data: null, error: boom }) })
    await expect(store.delete('ws', 'k')).rejects.toBe(boom)
  })
})
