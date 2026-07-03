// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAssetObjectUrl } from './useAssetObjectUrl.js'
import type { AssetFailReason, AssetResolveResult, AssetResolver } from './resolver.js'

// jsdom has no object-URL API; stub it and track create/revoke.
let nextId = 0
const createObjectURL = vi.fn((blob: Blob): string => {
  void blob // captured in mock.calls for assertions; not needed in the fake body
  return `blob:fake/${nextId++}`
})
const revokeObjectURL = vi.fn()

beforeEach(() => {
  nextId = 0
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL
})
afterEach(() => vi.restoreAllMocks())

const bytes = new Uint8Array([1, 2, 3, 4])
const args = { workspaceId: 'ws', contentHash: 'sha256:ab', mime: 'image/png' }

const okResolver = (b = bytes): Pick<AssetResolver, 'resolve'> => ({
  resolve: vi.fn(async (): Promise<AssetResolveResult> => ({ ok: true, bytes: b })),
})
const failResolver = (reason: AssetFailReason): Pick<AssetResolver, 'resolve'> => ({
  resolve: vi.fn(async (): Promise<AssetResolveResult> => ({ ok: false, reason })),
})

const flush = () => act(async () => {})

describe('useAssetObjectUrl', () => {
  it('starts loading, then resolves to a blob object URL of the block MIME', async () => {
    const resolver = okResolver()
    const { result } = renderHook(() => useAssetObjectUrl(args, resolver))
    expect(result.current[0].status).toBe('loading')

    await flush()
    expect(result.current[0]).toEqual({ status: 'ready', url: expect.stringMatching(/^blob:/) })
    expect(createObjectURL).toHaveBeenCalledOnce()
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(bytes.length) // the verified bytes, wrapped
  })

  it('does NOT resolve when disabled (the lazy download path) — no fetch, no URL', async () => {
    const resolver = okResolver()
    const { result } = renderHook(() => useAssetObjectUrl(args, resolver, { enabled: false }))
    await flush()
    expect(result.current[0].status).toBe('loading') // stays loading; a lazy viewer ignores it
    expect(resolver.resolve).not.toHaveBeenCalled() // no eager fetch/decrypt of the bytes
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('starts resolving once enabled flips true (a viewer became eager)', async () => {
    const resolver = okResolver()
    const { result, rerender } = renderHook(
      (p: { enabled: boolean }) => useAssetObjectUrl(args, resolver, { enabled: p.enabled }),
      { initialProps: { enabled: false } },
    )
    await flush()
    expect(resolver.resolve).not.toHaveBeenCalled()

    rerender({ enabled: true })
    await flush()
    expect(result.current[0]).toEqual({ status: 'ready', url: expect.stringMatching(/^blob:/) })
    expect(resolver.resolve).toHaveBeenCalledTimes(1)
  })

  it('surfaces a fail-closed resolve as error and NEVER creates an object URL', async () => {
    const resolver = failResolver('hash-mismatch')
    const { result } = renderHook(() => useAssetObjectUrl(args, resolver))
    await flush()
    expect(result.current[0]).toEqual({ status: 'error', reason: 'hash-mismatch' })
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('revokes the object URL on unmount (no leak)', async () => {
    const resolver = okResolver()
    const { result, unmount } = renderHook(() => useAssetObjectUrl(args, resolver))
    await flush()
    const url = result.current[0].status === 'ready' ? result.current[0].url : ''
    expect(url).toMatch(/^blob:/)

    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith(url)
  })

  it('revokes the previous URL and re-resolves when the inputs change', async () => {
    const resolver = okResolver()
    const { result, rerender } = renderHook((p: { hash: string }) =>
      useAssetObjectUrl({ ...args, contentHash: p.hash }, resolver), { initialProps: { hash: 'sha256:aa' } },
    )
    await flush()
    const firstUrl = result.current[0].status === 'ready' ? result.current[0].url : ''

    rerender({ hash: 'sha256:bb' })
    await flush()
    expect(revokeObjectURL).toHaveBeenCalledWith(firstUrl) // old URL freed on the dep change
    expect(resolver.resolve).toHaveBeenCalledTimes(2)
  })

  it('drops a resolve that lands after unmount — no URL created, no setState', async () => {
    let settle!: (r: AssetResolveResult) => void
    const resolver: Pick<AssetResolver, 'resolve'> = { resolve: () => new Promise((r) => (settle = r)) }
    const { unmount } = renderHook(() => useAssetObjectUrl(args, resolver))

    unmount()
    await act(async () => {
      settle({ ok: true, bytes })
      await Promise.resolve()
    })
    expect(createObjectURL).not.toHaveBeenCalled() // cancelled before the late resolve
  })

  it('retries a TRANSIENT failure (fetch-failed) on reconnect and recovers', async () => {
    // First resolve misses (object not replicated yet), the next succeeds.
    let calls = 0
    const resolver: Pick<AssetResolver, 'resolve'> = {
      resolve: vi.fn(async (): Promise<AssetResolveResult> =>
        ++calls === 1 ? { ok: false, reason: 'fetch-failed' } : { ok: true, bytes },
      ),
    }
    const { result } = renderHook(() => useAssetObjectUrl(args, resolver))
    await flush()
    expect(result.current[0]).toEqual({ status: 'error', reason: 'fetch-failed' })

    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    await flush()
    expect(result.current[0]).toEqual({ status: 'ready', url: expect.stringMatching(/^blob:/) })
    expect(resolver.resolve).toHaveBeenCalledTimes(2)
  })

  it('on a DECODE failure, revokes the URL NOW (frees the Blob) and settles to a terminal media-undecodable error', async () => {
    const resolver = okResolver()
    const { result } = renderHook(() => useAssetObjectUrl(args, resolver))
    await flush()
    const url = result.current[0].status === 'ready' ? result.current[0].url : ''
    expect(url).toMatch(/^blob:/)
    expect(revokeObjectURL).not.toHaveBeenCalled() // still alive while ready/rendered

    // The renderer's <img>/<audio> couldn't decode the verified bytes → report it.
    act(() => result.current[1](url))
    // The load-bearing fix: the Blob is freed immediately, NOT held until unmount.
    expect(revokeObjectURL).toHaveBeenCalledWith(url)
    expect(result.current[0]).toEqual({ status: 'error', reason: 'media-undecodable' })

    // Terminal: a reconnect must NOT re-resolve (the bytes won't become decodable).
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    await flush()
    expect(result.current[0]).toEqual({ status: 'error', reason: 'media-undecodable' })
    expect(resolver.resolve).toHaveBeenCalledTimes(1)
  })

  it('ignores a STALE decode-failure report (a URL that is no longer the ready one)', async () => {
    const resolver = okResolver()
    const { result } = renderHook(() => useAssetObjectUrl(args, resolver))
    await flush()
    // A report for some other/old URL must not knock out the live ready state.
    act(() => result.current[1]('blob:fake/stale'))
    expect(result.current[0].status).toBe('ready')
  })

  it('does NOT retry a TERMINAL failure (hash-mismatch) on reconnect', async () => {
    const resolver = failResolver('hash-mismatch')
    const { result } = renderHook(() => useAssetObjectUrl(args, resolver))
    await flush()

    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    await flush()
    expect(result.current[0]).toEqual({ status: 'error', reason: 'hash-mismatch' })
    expect(resolver.resolve).toHaveBeenCalledTimes(1) // terminal — no re-resolve
  })
})
