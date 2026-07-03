/**
 * The media-block viewer components + the picker over the {@link mediaViewersFacet}
 * registry (design §11).
 *
 * The renderer resolves a block's bytes per-viewer and hands them here:
 *   - EAGER (image; inline PDF later): the bytes are resolved once on mount into a
 *     verified object URL (via {@link useAssetObjectUrl}, §7.3) and the viewer renders
 *     that url. Fail-closed by construction — a `ready` url wraps ONLY hash-verified
 *     bytes (§5.1); a failed resolve is `error` → the broken placeholder, never an
 *     unverified source.
 *   - LAZY-INLINE (audio, {@link AudioViewer}): renders a metadata play affordance and
 *     resolves NOTHING on mount; on the first play it arms the SAME object-URL resolve via
 *     `requestResolve` and then renders a native `<audio>` at the verified url — same
 *     fail-closed guarantee, but the (possibly large) bytes aren't fetched until wanted.
 *   - LAZY (the download fallback): the viewer resolves NOTHING on mount — it renders
 *     from metadata (filename/size/mime) and fetches the verified bytes only when the
 *     user clicks download, then triggers a transient octet-stream download (never a
 *     navigable `blob:` URL — see {@link useMediaDownload}). The bytes are already on local
 *     disk in the common case (the down-lane replicates every media block for offline,
 *     §8), so the click is a fast local read; staying lazy avoids retaining a decrypted
 *     object-URL Blob in memory for media nobody opened.
 */

import { useCallback, useState } from 'react'
import { Download, FileWarning, ImageOff, Loader2, Play, VolumeX } from 'lucide-react'
import { MarkdownImage } from '@/markdown/MarkdownImage.js'
import { downloadBlob } from '@/utils/downloadBlob.js'
import type { AssetResolveResult } from './resolver.js'
import { GENERIC_MIME, isAudioMime, isImageMime } from './mediaBlock.js'
import type { MediaViewerContribution, MediaViewerProps } from './mediaViewersFacet.js'

/** A muted inline chip standing in for the real content: the loading spinner and the
 *  fail-closed broken/unavailable placeholder. `role="img"` + `aria-label` so a
 *  placeholder is announced as the asset it replaces, not read as empty. */
const Placeholder = ({
  testid,
  label,
  icon,
  spin = false,
}: {
  testid: string
  label: string
  icon: React.ReactNode
  spin?: boolean
}) => (
  <div
    data-testid={testid}
    role="img"
    aria-label={label}
    className="flex items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
  >
    <span className={spin ? 'animate-spin' : undefined}>{icon}</span>
    <span>{label}</span>
  </div>
)

/** Format a plaintext byte length for the file affordance (e.g. `1.4 MB`). Sub-KiB is
 *  shown in whole bytes; larger units keep one decimal below 10, whole above. Binary
 *  (1024) units to match how the capture-size cap / byte store think about size. */
export const formatByteSize = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = unit === 0 ? value : value < 10 ? Math.round(value * 10) / 10 : Math.round(value)
  return `${rounded} ${units[unit]}`
}

/** EAGER image viewer — the object URL feeds the existing {@link MarkdownImage} lightbox.
 *  Verified bytes the browser can't decode as an image (an untrusted `media:mime` over
 *  non-image bytes, or a corrupt-but-hash-matching file) fall to the SAME broken
 *  placeholder via onError, not the browser's broken-image glyph. */
const ImageViewer = ({ state, reportDecodeFailure, filename }: MediaViewerProps) => {
  if (state.status === 'ready') {
    return (
      <MarkdownImage
        src={state.url}
        alt={filename || 'Attachment image'}
        className="max-w-full rounded"
        onError={() => reportDecodeFailure(state.url)}
      />
    )
  }
  if (state.status === 'loading') {
    return <Placeholder testid="media-loading" label="Loading image…" icon={<Loader2 className="h-4 w-4" />} spin />
  }
  return <Placeholder testid="media-broken" label="Image unavailable" icon={<ImageOff className="h-4 w-4" />} />
}

type DownloadStatus = 'idle' | 'resolving' | 'error'

/** The download-on-click action shared by the file fallback and the audio player's download
 *  affordance. On invoke it fetches the block's VERIFIED bytes on demand (fail-closed — a
 *  failed resolve serves NOTHING and settles to a retryable `error`), then hands them to
 *  {@link downloadBlob}, which saves them under the original filename via a transient,
 *  immediately-revoked anchor.
 *
 *  Security: the download bytes are wrapped as `application/octet-stream`, NOT the block's
 *  `media:mime`. `media:mime` is attacker-influenceable metadata; a persistent
 *  `<a href="blob:…" download>` typed `text/html` is a same-origin XSS vector when opened in
 *  a new tab (the `download` hint is bypassed, and unreliable on iOS). A neutral content-type
 *  + a non-navigable transient anchor closes that off. */
const useMediaDownload = (
  resolveBytes: () => Promise<AssetResolveResult>,
  filename: string | undefined,
): { status: DownloadStatus; download: () => void } => {
  const [status, setStatus] = useState<DownloadStatus>('idle')
  const download = useCallback(() => {
    setStatus('resolving')
    void resolveBytes()
      .then((result) => {
        if (!result.ok) {
          setStatus('error')
          return
        }
        downloadBlob(new Blob([result.bytes], { type: GENERIC_MIME }), filename || 'attachment')
        setStatus('idle')
      })
      .catch(() => setStatus('error')) // resolve() is fail-closed, but never leave it hanging
  }, [resolveBytes, filename])
  return { status, download }
}

/** LAZY fallback viewer for any non-image (or as-yet-unhandled) mime: a download button
 *  rendered from METADATA — it resolves NO bytes until clicked, then downloads them via the
 *  fail-closed, octet-stream {@link useMediaDownload} path (see there for the security
 *  rationale). A failed resolve leaves the button in a retryable error state. */
const FileViewer = ({ resolveBytes, mime, filename, size }: MediaViewerProps) => {
  const { status, download } = useMediaDownload(resolveBytes, filename)
  const label = filename || mime || 'Attachment'

  return (
    <button
      type="button"
      data-testid="media-file"
      onClick={download}
      disabled={status === 'resolving'}
      aria-label={status === 'error' ? `${label} — download failed, click to retry` : `Download ${label}`}
      className="inline-flex max-w-full items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-70"
    >
      {status === 'resolving' ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
      ) : status === 'error' ? (
        <FileWarning className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{label}</span>
      {size > 0 && <span className="shrink-0 text-muted-foreground">{formatByteSize(size)}</span>}
      {status === 'error' && <span className="shrink-0 text-muted-foreground">· unavailable</span>}
    </button>
  )
}

/** A compact download icon-button (VERIFIED bytes → octet-stream, via {@link useMediaDownload})
 *  — the secondary "save the file" affordance beside the inline audio player. */
const DownloadIconButton = ({
  resolveBytes,
  filename,
  label,
  className,
}: {
  resolveBytes: () => Promise<AssetResolveResult>
  filename: string | undefined
  label: string
  className?: string
}) => {
  const { status, download } = useMediaDownload(resolveBytes, filename)
  return (
    <button
      type="button"
      data-testid="media-audio-download"
      onClick={download}
      disabled={status === 'resolving'}
      aria-label={status === 'error' ? `${label} — download failed, click to retry` : `Download ${label}`}
      className={`shrink-0 rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-70 ${className ?? ''}`}
    >
      {status === 'resolving' ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : status === 'error' ? (
        <FileWarning className="h-4 w-4" />
      ) : (
        <Download className="h-4 w-4" />
      )}
    </button>
  )
}

/** LAZY-INLINE audio viewer for `audio/*` (§11). Renders from METADATA as a play affordance
 *  and resolves NOTHING on mount — audio files can be large, so the object-URL resolve
 *  (fetch → decrypt/passthrough → HASH-VERIFY → Blob → object URL) is deferred until the
 *  first play intent, when it arms the SAME eager path via `requestResolve`. Once armed,
 *  `state` transitions loading → ready|error just like the image viewer:
 *   - `ready` ⇒ a native `<audio controls>` at the VERIFIED object URL (a `blob:` of the
 *     decrypted-at-rest plaintext — it plays offline once the down-lane has replicated it,
 *     §8; the Blob is typed the block's `audio/*` mime, which is safe to render, and revoked
 *     on unmount by {@link useAssetObjectUrl}). Bytes that hash-verify but aren't decodable
 *     audio (an untrusted `media:mime` over other bytes) fall to the SAME broken placeholder
 *     via `onError → reportDecodeFailure`, never a dead player.
 *   - `error` ⇒ fail-closed broken indicator (§5.1/§7.3), NEVER an unverified source.
 *  A filename + a download affordance ({@link DownloadIconButton}, octet-stream) sit alongside
 *  EVERY state (poster, player, broken) — because `audio/*` no longer falls through to the
 *  file download fallback, the viewer itself must hold the "every attachment is at least
 *  downloadable" floor (§11), including when playback fails or before the user ever plays. */
const AudioViewer = ({
  state,
  reportDecodeFailure,
  resolveBytes,
  requestResolve,
  armed,
  filename,
  size,
}: MediaViewerProps) => {
  const label = filename || 'Audio attachment'

  // `armed` is renderer-owned (it gates the resolve) and content-scoped, so it doubles as
  // this viewer's poster gate: while false the resolve hasn't been requested for this
  // content (state is loading only because it's gated) → show the metadata poster; a click
  // arms it, and once true `state` drives the spinner → player just like the image viewer.
  // Nothing is fetched/decrypted until the click. The poster carries a DOWNLOAD affordance
  // too: audio/* no longer falls through to the download fallback, so this viewer must keep
  // the "every attachment is at least downloadable" floor (§11) — savable without playing.
  if (!armed) {
    return (
      <div className="inline-flex max-w-full items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
        <button
          type="button"
          data-testid="media-audio-play"
          onClick={requestResolve}
          aria-label={`Play ${label}`}
          className="inline-flex min-w-0 items-center gap-2 hover:opacity-80"
        >
          <Play className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{label}</span>
          {size > 0 && <span className="shrink-0 text-muted-foreground">{formatByteSize(size)}</span>}
        </button>
        <DownloadIconButton resolveBytes={resolveBytes} filename={filename} label={label} className="ml-auto" />
      </div>
    )
  }
  // Fail-closed: bytes that don't resolve/verify — or verify but the browser can't DECODE as
  // audio (an untrusted media:mime over other bytes) — render a broken indicator, NEVER an
  // <audio> at an unverified source (§5.1/§7.3). The download stays reachable: resolveBytes
  // re-verifies independently of the (now-terminal) playback resolve, so a mislabeled/
  // undecodable-but-verified file is still savable and a transient failure can still recover
  // — keeping the downloadable floor the file fallback used to provide for audio.
  if (state.status === 'error') {
    return (
      <div
        data-testid="media-audio-broken"
        className="inline-flex max-w-full items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
      >
        <VolumeX className="h-4 w-4 shrink-0" />
        <span className="truncate">{label} — unavailable</span>
        {size > 0 && <span className="shrink-0">{formatByteSize(size)}</span>}
        <DownloadIconButton resolveBytes={resolveBytes} filename={filename} label={label} className="ml-auto" />
      </div>
    )
  }
  if (state.status === 'loading') {
    return <Placeholder testid="media-audio-loading" label="Loading audio…" icon={<Loader2 className="h-4 w-4" />} spin />
  }
  return (
    <div
      data-testid="media-audio"
      className="flex max-w-full flex-col gap-1 rounded border border-border bg-muted/40 p-2"
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="truncate">{label}</span>
        {size > 0 && <span className="shrink-0">{formatByteSize(size)}</span>}
        <DownloadIconButton resolveBytes={resolveBytes} filename={filename} label={label} className="ml-auto" />
      </div>
      {/* autoPlay: the user already clicked play, so start once the (now verified) src is set;
          if the browser's autoplay policy blocks it, the ready controls let them click play. */}
      <audio
        controls
        autoPlay
        src={state.url}
        onError={() => reportDecodeFailure(state.url)}
        className="w-full"
        aria-label={label}
      />
    </div>
  )
}

/** The image mime-family viewer — the attachments plugin's contribution to
 *  {@link mediaViewersFacet}. */
export const imageMediaViewer: MediaViewerContribution = {
  id: 'image',
  match: isImageMime,
  Component: ImageViewer,
  eager: true,
}

/** The audio mime-family viewer. `eager: false` — the (possibly large) bytes resolve only
 *  on the first play, not on mount (see {@link AudioViewer}); the renderer therefore skips
 *  the mount-time resolve and the viewer arms it via `requestResolve`. */
export const audioMediaViewer: MediaViewerContribution = {
  id: 'audio',
  match: isAudioMime,
  Component: AudioViewer,
  eager: false,
}

/** The built-in floor: every attachment is at least downloadable. Returned by
 *  {@link pickMediaViewer} when no registered viewer claims the mime — NOT itself a
 *  facet contribution, so it can't be dropped and a page always has a working affordance
 *  even if the viewer facet is empty. A plugin CAN still override it with a match-all
 *  contribution (which `find` reaches first). */
export const FILE_VIEWER_FALLBACK: MediaViewerContribution = {
  id: 'file',
  match: () => true,
  Component: FileViewer,
  eager: false,
}

/** Pick the viewer for `mime` from the facet-resolved list — first match (the list is
 *  precedence-ordered), else the download fallback. Total: always returns a viewer, so
 *  the renderer never branches on mime itself. */
export const pickMediaViewer = (
  viewers: readonly MediaViewerContribution[],
  mime: string,
): MediaViewerContribution => viewers.find((viewer) => viewer.match(mime)) ?? FILE_VIEWER_FALLBACK
