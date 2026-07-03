/**
 * The `media`-block renderer (design §11). Mirrors the video-player plugin's
 * wiring: a {@link BlockRenderer} that renders blocks carrying the `media` type
 * (gated on a loaded snapshot, see canRender) at a priority above the default.
 *
 * It reads the block's metadata and dispatches to a viewer chosen from the
 * {@link mediaViewersFacet} registry ({@link pickMediaViewer}). Byte access is
 * per-viewer (§7.3):
 *  - an EAGER viewer (image; inline PDF later) gets the bytes resolved once on mount
 *    into a verified object URL ({@link useAssetObjectUrl}: fetch → decrypt/passthrough →
 *    HASH-VERIFY → Blob of the block's `media:mime` → object URL, revoked on unmount). A
 *    fail-closed resolve (§5.1) surfaces as `error` → the broken-asset placeholder, NEVER
 *    a raw/unverified source.
 *  - a LAZY-INLINE viewer (audio) renders from metadata and resolves NOTHING on mount; it
 *    arms the SAME object-URL resolve via `requestResolve` on the first play intent, then
 *    reads the resulting `state` exactly like an eager viewer (same fail-closed guarantee).
 *  - the LAZY download fallback resolves NOTHING on mount either; it gets a `resolveBytes`
 *    thunk and fetches the verified bytes only when the user clicks download.
 * The mount-time resolve is gated on `viewer.eager || armed` (armed = a lazy-inline viewer
 * called requestResolve). The down-lane already replicates every media block (incl.
 * non-image) to local disk for offline (§8), so deferring the resolve isn't about saving
 * egress — it avoids holding a decrypted object-URL Blob in memory for media nobody opened
 * (a page of large audio files), and avoids un-throttled demand-fetching ahead of that
 * budgeted background lane.
 */

import { useCallback, useState } from 'react'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { usePropertyValue, useWorkspaceId } from '@/hooks/block.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'
import { getAssetResolver } from './assetResolver.js'
import {
  MEDIA_TYPE,
  mediaFilenameProp,
  mediaHashProp,
  mediaMimeProp,
  mediaSizeProp,
} from './mediaBlock.js'
import { pickMediaViewer } from './mediaViewers.js'
import { mediaViewersFacet } from './mediaViewersFacet.js'
import { useAssetObjectUrl } from './useAssetObjectUrl.js'

export const MediaContentRenderer = ({ block }: BlockRendererProps) => {
  const [hash] = usePropertyValue(block, mediaHashProp)
  const [mime] = usePropertyValue(block, mediaMimeProp)
  const [filename] = usePropertyValue(block, mediaFilenameProp)
  const [size] = usePropertyValue(block, mediaSizeProp)

  // The asset block's OWN workspace (reactive) — bytes are workspace-scoped (§10),
  // so a foreign-workspace embed must resolve against the block's workspace, not
  // the UI's active one. '' (while loading / missing) fails closed (deferred).
  const workspaceId = useWorkspaceId(block, '')
  const resolver = getAssetResolver()
  // The viewer registry is a facet — plugins contribute a viewer per mime family; the
  // renderer never special-cases a mime (design §11).
  const viewer = pickMediaViewer(useAppRuntime().read(mediaViewersFacet), mime)

  // A LAZY-INLINE viewer (audio) arms the eager resolve on demand via requestResolve. The
  // latch is owned HERE (single source of truth — it also gates the resolve hook, and the
  // viewer reads it back via the `armed` prop) and is SCOPED TO THE CURRENT CONTENT: `armed`
  // is CLEARED whenever the content key transitions (re-capture / synced edit / undo — all
  // mutate the row in place WITHOUT remounting), so a replaced attachment returns to its
  // play-gated poster instead of surprise-resolving/autoplaying the new bytes, and never
  // eager-fetches behind an un-played poster after a mime flip. It re-arms ONLY on a fresh
  // play gesture — crucially NOT a derived `armedFor === contentKey`, which would spuriously
  // re-arm when the key RETURNS to a previously-armed value (undo a re-capture: A→B→A).
  // `contentKey` mirrors the resolve hook's key so the latch and the resolve re-gate
  // together. (setState-during-render is the React-blessed "reset on prop change" idiom.)
  const contentKey = `${workspaceId} ${hash} ${mime}`
  const [armed, setArmed] = useState(false)
  const [armedFor, setArmedFor] = useState(contentKey)
  if (armedFor !== contentKey) {
    setArmedFor(contentKey)
    if (armed) setArmed(false)
  }
  const requestResolve = useCallback(() => setArmed(true), [])

  // Resolve on mount for an EAGER inline viewer (image); for a LAZY-INLINE viewer (audio)
  // only once armed; never for the pure download fallback (it uses resolveBytes on click).
  const [state, reportDecodeFailure] = useAssetObjectUrl(
    { workspaceId, contentHash: hash, mime },
    resolver,
    { enabled: viewer.eager || armed },
  )

  // The lazy path: a bound "give me the VERIFIED bytes" thunk for the download affordance
  // (file fallback + audio) — fail-closed like the eager path (resolve() discards unverified).
  const resolveBytes = useCallback(
    () => resolver.resolve({ workspaceId, contentHash: hash }),
    [resolver, workspaceId, hash],
  )

  const { Component } = viewer
  return (
    <Component
      state={state}
      reportDecodeFailure={reportDecodeFailure}
      resolveBytes={resolveBytes}
      requestResolve={requestResolve}
      armed={armed}
      mime={mime}
      filename={filename}
      size={size}
    />
  )
}

export const MediaBlockRenderer: BlockRenderer = (props: BlockRendererProps) => (
  <DefaultBlockRenderer {...props} ContentRenderer={MediaContentRenderer} />
)

// Gate on a LOADED snapshot, read THROW-FREE — exactly as the other peek()-based
// renderers do (PropertySchema / BlockType / TypesPage). `useRenderer` runs every
// renderer's canRender for every block during its loading window, ABOVE the
// BlockComponent ErrorBoundary, so canRender must never throw: `block.hasType()`
// throws on a not-yet-loaded / missing row, and even `getBlockTypes` throws a
// CodecError on a malformed `types` value (a non-array, or a non-string element)
// that the cache boundary doesn't validate. Reading `properties.types` raw +
// `Array.isArray` is total: undefined / wrong-shape → false, never a throw.
MediaBlockRenderer.canRender = ({ block }: BlockRendererProps) => {
  const types = block.peek()?.properties.types
  return Array.isArray(types) && types.includes(MEDIA_TYPE)
}
MediaBlockRenderer.priority = () => 5
