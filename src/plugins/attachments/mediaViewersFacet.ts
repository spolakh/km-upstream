/**
 * The media-viewer extension point (design §11).
 *
 * A `media` block renders through a viewer chosen by its `media:mime`. Rather than
 * hard-code the branch, viewers are FACET CONTRIBUTIONS — one per mime family (image,
 * and later PDF / audio / video). A plugin adds a viewer by contributing to
 * {@link mediaViewersFacet}; {@link MediaBlockRenderer} reads the facet and dispatches,
 * never special-casing a mime. First registered `match` (precedence-ordered) wins, and a
 * built-in download fallback ({@link FILE_VIEWER_FALLBACK}) catches anything unclaimed.
 */

import type { ComponentType } from 'react'
import { defineFacet, dedupById } from '@/facets/facet.js'
import type { AssetResolveResult } from './resolver.js'
import type { AssetUrlState, ReportDecodeFailure } from './useAssetObjectUrl.js'

/** What every viewer receives. An EAGER viewer reads `state`/`reportDecodeFailure`; a
 *  LAZY one reads `resolveBytes`; a LAZY-INLINE one (audio) reads `state` too but drives
 *  it with `requestResolve` — each ignores the props it doesn't use, so the renderer stays
 *  a pure dispatch and never special-cases a mime. */
export interface MediaViewerProps {
  /** The resolve of the block's bytes to a verified object URL (§7.3). `ready` ⇒ the url
   *  wraps hash-verified bytes; `error` ⇒ fail-closed placeholder. Live from mount for an
   *  EAGER viewer; for a LAZY-INLINE viewer it stays `loading` until the viewer calls
   *  {@link requestResolve} (then transitions loading → ready|error like the eager path);
   *  for a pure download (LAZY) viewer it stays `loading` and is ignored. */
  readonly state: AssetUrlState
  /** Report that the verified bytes at `state.url` couldn't be DECODED as the claimed
   *  media (the `<img>`/`<audio>` onError) — frees the Blob + goes terminal. Used by
   *  inline viewers (image/audio); ignored by the pure download viewer. */
  readonly reportDecodeFailure: ReportDecodeFailure
  /** Fetch the block's VERIFIED bytes on demand (fail-closed — discards unverified bytes,
   *  §5.1). Resolves the same content as the eager path, on click — used by the download
   *  affordance of the file fallback and the audio player. */
  readonly resolveBytes: () => Promise<AssetResolveResult>
  /** LAZY-INLINE path: request that the (otherwise-gated) eager resolve of `state` BEGIN —
   *  for an inline viewer that shows the bytes but defers the fetch/decrypt until the user
   *  intends to consume them (audio: on first play). An EAGER viewer (image) never calls it
   *  (its resolve is already live); a pure download viewer (file) doesn't either (it uses
   *  {@link resolveBytes}). */
  readonly requestResolve: () => void
  /** LAZY-INLINE path (the read-half of {@link requestResolve}): whether the resolve is
   *  armed for the CURRENT content. A lazy-inline viewer shows its metadata affordance while
   *  `false` and defers to `state` once `true`. The renderer OWNS this (single source of
   *  truth — it also gates the resolve) and RESETS it when the block's content changes, so a
   *  replaced/synced attachment returns to the un-armed affordance instead of auto-resolving
   *  (or autoplaying) the new bytes. Ignored by eager/download viewers. */
  readonly armed: boolean
  readonly mime: string
  readonly filename: string | undefined
  /** Plaintext byte length (`media:size`); `0` = unknown, then the size is omitted. */
  readonly size: number
}

/** One mime-family viewer. `match` is tried in precedence order (first hit wins), so a
 *  specific viewer (e.g. `application/pdf`) can sit ABOVE a broader one via precedence. */
export interface MediaViewerContribution {
  /** Stable id — the dedup key (a later same-id contribution replaces the earlier,
   *  the §6 registry convention) and a diagnostics label. */
  readonly id: string
  /** Does this viewer handle `mime`? */
  readonly match: (mime: string) => boolean
  readonly Component: ComponentType<MediaViewerProps>
  /** Resolve the object URL EAGERLY on mount (image), vs NOT (the renderer leaves `state`
   *  loading until the viewer either uses {@link MediaViewerProps.resolveBytes} on click —
   *  the download fallback — or arms it via {@link MediaViewerProps.requestResolve} — the
   *  play-gated audio player). The renderer gates the mount-time resolve on this. */
  readonly eager: boolean
}

export const isMediaViewerContribution = (value: unknown): value is MediaViewerContribution => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as MediaViewerContribution
  return (
    typeof v.id === 'string' &&
    typeof v.match === 'function' &&
    typeof v.Component === 'function' &&
    typeof v.eager === 'boolean'
  )
}

export const MEDIA_VIEWERS_FACET_ID = 'attachments.media-viewers'

/** The media-viewer registry facet. Contributions fold into a precedence-ordered list
 *  (dedup by id, last-wins per §6); {@link pickMediaViewer} finds the first match. */
export const mediaViewersFacet = defineFacet<MediaViewerContribution, readonly MediaViewerContribution[]>({
  id: MEDIA_VIEWERS_FACET_ID,
  combine: dedupById(MEDIA_VIEWERS_FACET_ID),
  validate: isMediaViewerContribution,
})
