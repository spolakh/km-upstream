/**
 * Resolve a media block's bytes to an `<img>`-usable object URL (design §7.3/§11).
 *
 * Bridges the in-thread {@link AssetResolver} (which yields verified BYTES, never
 * a URL — the security core stays DOM-free, §7.3) to the renderer: it resolves,
 * wraps the verified bytes as a `Blob` of the block's MIME, and hands back a
 * `blob:` object URL — owning the createObjectURL / revokeObjectURL lifecycle so
 * the renderer never leaks one.
 *
 * Fail-closed surfaces as `status: 'error'` (the resolver already discarded any
 * unverified bytes, §5.1) — the renderer shows the broken-asset placeholder; we
 * never createObjectURL for a failed resolve. A resolve that finishes after the
 * inputs change (or the component unmounts) is dropped and its URL never created,
 * so there's no stale-URL race and no leak.
 *
 * A TRANSIENT failure (the Storage object hasn't replicated to this device yet,
 * the browser is offline, or the workspace is locked) can clear without any of the
 * hook's inputs changing — so caching it as a settled result would leave the image
 * broken until a remount/reload. For those reasons we re-resolve on reconnect
 * (`online`) and tab refocus (`visibilitychange`). Terminal failures (hash
 * mismatch, decode failure, malformed hash) won't change without a block edit, so
 * they stay put.
 */

import { useCallback, useEffect, useState } from 'react'
import type { AssetFailReason, AssetResolver } from './resolver.js'

/** Why an asset URL is unavailable: any resolver fail reason, OR the verified bytes
 *  decoded fine but the browser couldn't render them as the claimed MEDIA (an untrusted
 *  `media:mime` over bytes of a different kind — non-image bytes typed `image/*`, or
 *  non-audio bytes typed `audio/*` — or a corrupt-but-hash-matching file). The latter is
 *  a RENDER-level, terminal outcome reported by the renderer (the `<img>`/`<audio>`
 *  onError) — it has no place in the resolver's {@link AssetFailReason}. */
export type AssetUrlFailReason = AssetFailReason | 'media-undecodable'

/** Failures that may clear on their own (object arrives / network recovers /
 *  workspace unlocks / re-paste the WK), so a refocus/reconnect should retry.
 *  `media-undecodable` is deliberately ABSENT — the bytes won't become decodable
 *  without a block edit, so it's terminal. */
const TRANSIENT_FAILURES: ReadonlySet<AssetUrlFailReason> = new Set([
  'fetch-failed',
  'deferred',
  'no-content-key',
  'error',
])

export interface AssetUrlArgs {
  readonly workspaceId: string
  /** The block's `media:hash` (`sha256:<hex>`, §5.1). */
  readonly contentHash: string
  /** The block's `media:mime` — the Blob type for the object URL. */
  readonly mime: string
}

export type AssetUrlState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly url: string }
  | { readonly status: 'error'; readonly reason: AssetUrlFailReason }

/** The renderer calls this when the verified bytes at `url` couldn't be DECODED as the
 *  claimed media (the `<img>`/`<audio>` onError) — the hook frees the Blob, revokes the
 *  URL, and goes terminal. */
export type ReportDecodeFailure = (url: string) => void

export function useAssetObjectUrl(
  args: AssetUrlArgs,
  // The DEMAND lane — only ever `resolve` (the backlog `replicate` is the down-lane's).
  resolver: Pick<AssetResolver, 'resolve'>,
  // `enabled: false` skips the eager resolve entirely (no fetch/decrypt, no object URL,
  // no retry listeners) — for a viewer that fetches LAZILY on demand (the download
  // fallback) rather than showing the bytes inline. The returned state stays `loading`
  // and is simply ignored by such a viewer. Defaults to true (the inline/image path).
  options: { readonly enabled?: boolean } = {},
): readonly [AssetUrlState, ReportDecodeFailure] {
  const { workspaceId, contentHash, mime } = args
  const enabled = options.enabled ?? true
  // A settled result is tagged with the inputs it was resolved FOR. The derived
  // return (below) treats a result for STALE inputs as `loading`, so we never
  // have to setState('loading') synchronously inside the effect on a re-run.
  const key = `${workspaceId} ${contentHash} ${mime}`
  const [settled, setSettled] = useState<{ key: string; state: AssetUrlState } | null>(null)
  // Bumped on a reconnect/refocus while in a transient-error state to re-resolve.
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    if (!enabled) return // lazy viewer — the eager resolve/object-URL is skipped
    let cancelled = false
    let objectUrl: string | null = null

    void resolver
      .resolve({ workspaceId, contentHash })
      .then((result) => {
        if (cancelled) return // inputs changed / unmounted — never create a URL we'd orphan
        if (!result.ok) {
          setSettled({ key, state: { status: 'error', reason: result.reason } })
          return
        }
        objectUrl = URL.createObjectURL(new Blob([result.bytes], { type: mime }))
        setSettled({ key, state: { status: 'ready', url: objectUrl } })
      })
      .catch(() => {
        // resolve() is contractually fail-closed (never throws), but guard so a
        // breach degrades to the placeholder rather than an unhandled rejection.
        if (!cancelled) setSettled({ key, state: { status: 'error', reason: 'error' } })
      })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [enabled, resolver, workspaceId, contentHash, mime, key, retryTick])

  const state: AssetUrlState = settled?.key === key ? settled.state : { status: 'loading' }

  // Retry a transient failure when the network/tab comes back — the object may
  // have replicated, the workspace unlocked, or connectivity returned. Listeners
  // are registered ONLY while in a transient-error state, so a ready/loading/
  // terminal result has no listeners and never re-resolves spuriously.
  const retryable = state.status === 'error' && TRANSIENT_FAILURES.has(state.reason)
  useEffect(() => {
    if (!retryable) return
    const retry = () => setRetryTick((t) => t + 1)
    const onVisible = () => {
      if (document.visibilityState === 'visible') retry()
    }
    window.addEventListener('online', retry)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', retry)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [retryable])

  // Reported by the renderer when the <img>/<audio> can't DECODE the verified bytes.
  // Free the Blob NOW — it can be tens of MiB and would otherwise stay alive until the
  // block unmounts (a page of bad/hostile media attachments would retain them all
  // while showing only placeholders). Revoke the dead URL and settle to a terminal
  // error; the effect cleanup revoking the same URL later is a harmless no-op. The
  // guard ignores a stale report (the URL already moved on).
  const reportDecodeFailure = useCallback<ReportDecodeFailure>((failedUrl) => {
    URL.revokeObjectURL(failedUrl)
    setSettled((prev) =>
      prev?.state.status === 'ready' && prev.state.url === failedUrl
        ? { key: prev.key, state: { status: 'error', reason: 'media-undecodable' } }
        : prev,
    )
  }, [])

  return [state, reportDecodeFailure] as const
}
