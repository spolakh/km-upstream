// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block.js'
import { typesProp } from '@/data/properties.js'
import type { BlockRendererProps } from '@/types.js'

// Control the block's props, the eager URL state, and the lazy resolve without the data layer.
const h = vi.hoisted(() => ({
  props: {} as Record<string, unknown>,
  urlState: { status: 'loading' } as { status: string; url?: string; reason?: string },
  reportDecodeFailure: vi.fn(),
  resolve: vi.fn(),
  downloadBlob: vi.fn(),
  useAssetObjectUrl: vi.fn(),
}))
vi.mock('@/hooks/block.js', () => ({
  usePropertyValue: (_b: unknown, s: { name: string }) => [h.props[s.name], () => {}],
  useWorkspaceId: () => 'ws-A',
}))
// The eager hook returns [state, reportDecodeFailure]; the renderer wires onError → the latter.
// Record the call so a test can assert the renderer passed the right `{ enabled }` (the
// lazy-vs-eager gate) — the spy captures args; the return is the controlled state. The actual
// resolve is exercised in the hook's own test.
vi.mock('./useAssetObjectUrl.js', () => ({
  useAssetObjectUrl: (...args: unknown[]) => {
    h.useAssetObjectUrl(...args)
    return [h.urlState, h.reportDecodeFailure]
  },
}))
vi.mock('./assetResolver.js', () => ({ getAssetResolver: () => ({ resolve: h.resolve }) }))
vi.mock('@/utils/downloadBlob.js', () => ({ downloadBlob: h.downloadBlob }))
// The runtime resolves the media-viewer facet to the (real) image + audio viewers, so an
// image mime dispatches to ImageViewer, an audio mime to AudioViewer, everything else to the
// download fallback.
vi.mock('@/extensions/runtimeContext.js', async () => {
  const { imageMediaViewer, audioMediaViewer } = await import('./mediaViewers.js')
  return { useAppRuntime: () => ({ read: () => [imageMediaViewer, audioMediaViewer] }) }
})

const { MediaBlockRenderer, MediaContentRenderer } = await import('./MediaBlockRenderer.js')

const block = { repo: { activeWorkspaceId: 'ws-A' }, hasType: (t: string) => t === 'media' } as unknown as Block
const renderContent = () => render(<MediaContentRenderer block={block} />)

afterEach(cleanup)
beforeEach(() => {
  h.props = { 'media:hash': 'sha256:ab', 'media:mime': 'image/png', 'media:filename': 'cat.png' }
  h.urlState = { status: 'loading' }
  h.reportDecodeFailure.mockClear()
  h.resolve.mockReset()
  h.resolve.mockResolvedValue({ ok: true, bytes: new Uint8Array([1, 2, 3]) })
  h.downloadBlob.mockReset()
  h.useAssetObjectUrl.mockClear()
})

describe('MediaContentRenderer — image branch', () => {
  it('renders the lightbox <img> at the object URL when resolved', () => {
    h.urlState = { status: 'ready', url: 'blob:fake/1' }
    renderContent()
    const img = screen.getByRole('img', { name: 'cat.png' })
    expect(img).toHaveAttribute('src', 'blob:fake/1')
    // The image viewer is EAGER: the renderer resolves its bytes up front.
    expect(h.useAssetObjectUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), { enabled: true })
  })

  it('shows the loading placeholder while resolving', () => {
    h.urlState = { status: 'loading' }
    renderContent()
    expect(screen.getByTestId('media-loading')).toBeInTheDocument()
  })

  it('shows the broken-asset placeholder (and NO real <img>) on a fail-closed resolve', () => {
    h.urlState = { status: 'error', reason: 'hash-mismatch' }
    const { container } = renderContent()
    expect(screen.getByTestId('media-broken')).toBeInTheDocument()
    // The load-bearing assertion: nothing is ever served for an unverified asset.
    expect(container.querySelector('img')).toBeNull()
  })

  it('reports a decode failure to the hook when verified bytes fail to DECODE', () => {
    // The bytes hash-verified, but the <img> can't decode them — e.g. an untrusted
    // media:mime claiming image/* over non-image bytes. The renderer must report it
    // so the hook REVOKES the object URL (frees the Blob) and goes terminal — the
    // resulting error→placeholder is covered by the fail-closed test above and the
    // hook's own test; here we pin the renderer's onError → reportDecodeFailure wire.
    h.urlState = { status: 'ready', url: 'blob:fake/undecodable' }
    renderContent()
    fireEvent.error(screen.getByRole('img', { name: 'cat.png' }))
    expect(h.reportDecodeFailure).toHaveBeenCalledWith('blob:fake/undecodable')
  })
})

describe('MediaContentRenderer — non-image (file) branch', () => {
  const fileProps = (extra: Record<string, unknown> = {}) => {
    h.props = { 'media:hash': 'sha256:ab', 'media:mime': 'application/pdf', 'media:filename': 'doc.pdf', ...extra }
  }

  it('renders a METADATA-ONLY download button — no eager resolve — for a non-image MIME', () => {
    fileProps({ 'media:size': 2_100_000 })
    h.urlState = { status: 'ready', url: 'blob:should-not-be-used' } // eager state is ignored here
    renderContent()
    const btn = screen.getByTestId('media-file')
    expect(btn.tagName).toBe('BUTTON')
    expect(btn).toHaveTextContent('doc.pdf')
    expect(btn).toHaveTextContent('2 MB')
    expect(screen.queryByRole('img')).toBeNull() // not the image lightbox
    // The download fallback is LAZY: the renderer must gate the eager resolve OFF for it,
    // so no object-URL Blob is held for a download nobody clicked (guards the viewer.eager wiring).
    expect(h.useAssetObjectUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), { enabled: false })
    expect(h.resolve).not.toHaveBeenCalled() // and nothing is fetched until a download click
  })

  it('resolves the VERIFIED bytes on click and downloads them as a NEUTRAL octet-stream blob', async () => {
    fileProps()
    renderContent()
    fireEvent.click(screen.getByTestId('media-file'))
    await waitFor(() => expect(h.downloadBlob).toHaveBeenCalledTimes(1))
    const [blob, name] = h.downloadBlob.mock.calls[0]
    expect(name).toBe('doc.pdf')
    // NEVER the attacker-influenceable media:mime — a neutral type so a navigated blob URL
    // downloads instead of rendering (no same-origin XSS via media:mime = text/html).
    expect(blob.type).toBe('application/octet-stream')
  })

  it('fails closed on a failed resolve — nothing downloaded, retryable error affordance', async () => {
    fileProps()
    h.resolve.mockResolvedValue({ ok: false, reason: 'hash-mismatch' })
    renderContent()
    const btn = screen.getByTestId('media-file')
    fireEvent.click(btn)
    await waitFor(() => expect(btn).toHaveTextContent('unavailable'))
    // The load-bearing assertion: nothing is ever served for an unverified/failed asset.
    expect(h.downloadBlob).not.toHaveBeenCalled()
    expect(btn).toBeEnabled() // still clickable to retry a transient failure
  })

  it('names the download from the filename, else a generic name; omits size when unknown', async () => {
    h.props = { 'media:hash': 'sha256:ab', 'media:mime': 'application/zip', 'media:size': 0 }
    renderContent()
    const btn = screen.getByTestId('media-file')
    expect(btn).toHaveTextContent('application/zip') // mime is the label fallback
    expect(btn).not.toHaveTextContent('B') // size 0/unknown → no size shown (guards the `> 0` check)
    fireEvent.click(btn)
    await waitFor(() => expect(h.downloadBlob).toHaveBeenCalled())
    expect(h.downloadBlob.mock.calls[0][1]).toBe('attachment') // generic download name
  })
})

describe('MediaContentRenderer — audio branch', () => {
  const audioProps = (extra: Record<string, unknown> = {}) => {
    h.props = { 'media:hash': 'sha256:ab', 'media:mime': 'audio/mpeg', 'media:filename': 'song.mp3', ...extra }
  }

  it('renders a metadata-only PLAY affordance — no eager resolve — for an audio MIME', () => {
    audioProps({ 'media:size': 2_100_000 })
    h.urlState = { status: 'ready', url: 'blob:should-not-be-used-yet' } // eager state ignored until armed
    const { container } = renderContent()
    const play = screen.getByTestId('media-audio-play')
    expect(play).toHaveTextContent('song.mp3')
    expect(play).toHaveTextContent('2 MB')
    // The <audio> element is NOT mounted, and the renderer did NOT arm the eager resolve —
    // the (possibly large) bytes aren't fetched/decrypted until the user intends to play.
    expect(container.querySelector('audio')).toBeNull()
    expect(h.useAssetObjectUrl).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { enabled: false })
  })

  it('arms the resolve and mounts <audio src=objectURL> on the first play click', () => {
    audioProps()
    h.urlState = { status: 'ready', url: 'blob:audio/1' } // what the hook resolves to once armed
    const { container } = renderContent()
    expect(container.querySelector('audio')).toBeNull() // gated until play

    fireEvent.click(screen.getByTestId('media-audio-play'))
    // The renderer flipped the eager gate on (play-gated resolve, §8/§11)…
    expect(h.useAssetObjectUrl).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { enabled: true })
    // …and once resolved the native player renders at the VERIFIED object URL.
    const audio = container.querySelector('audio')
    expect(audio).toHaveAttribute('src', 'blob:audio/1')
    expect(audio).toHaveAttribute('controls')
  })

  it('shows the loading placeholder while the armed resolve is in flight', () => {
    audioProps()
    h.urlState = { status: 'loading' }
    renderContent()
    fireEvent.click(screen.getByTestId('media-audio-play'))
    expect(screen.getByTestId('media-audio-loading')).toBeInTheDocument()
  })

  it('fails closed to the broken placeholder (NO <audio>) on a failed resolve after play', () => {
    audioProps()
    h.urlState = { status: 'error', reason: 'hash-mismatch' }
    const { container } = renderContent()
    fireEvent.click(screen.getByTestId('media-audio-play'))
    expect(screen.getByTestId('media-audio-broken')).toBeInTheDocument()
    // The load-bearing assertion: nothing is ever served for an unverified asset.
    expect(container.querySelector('audio')).toBeNull()
  })

  it('reports a decode failure to the hook when the verified bytes are not decodable audio', async () => {
    // media:mime is attacker-influenceable — bytes that hash-verify but aren't real audio
    // make <audio> fire onError; the renderer must report it so the hook frees the Blob and
    // goes terminal (→ broken placeholder), never leaving a dead player.
    audioProps()
    h.urlState = { status: 'ready', url: 'blob:audio/undecodable' }
    const { container } = renderContent()
    fireEvent.click(screen.getByTestId('media-audio-play'))
    // Wait for the armed <audio> to mount before firing on it (guards a cold-start race).
    const audio = await waitFor(() => {
      const el = container.querySelector('audio')
      if (!el) throw new Error('audio not mounted yet')
      return el
    })
    fireEvent.error(audio)
    await waitFor(() => expect(h.reportDecodeFailure).toHaveBeenCalledWith('blob:audio/undecodable'))
  })

  it('downloads the VERIFIED bytes as a NEUTRAL octet-stream blob via the play-view download affordance', async () => {
    audioProps()
    h.urlState = { status: 'ready', url: 'blob:audio/1' }
    renderContent()
    fireEvent.click(screen.getByTestId('media-audio-play'))
    fireEvent.click(screen.getByTestId('media-audio-download'))
    await waitFor(() => expect(h.downloadBlob).toHaveBeenCalledTimes(1))
    const [blob, name] = h.downloadBlob.mock.calls[0]
    expect(name).toBe('song.mp3')
    // Same security invariant as the file fallback: never the attacker-influenceable media:mime.
    expect(blob.type).toBe('application/octet-stream')
  })

  it('DISARMS on a content change under a live mount — no surprise autoplay/refetch of replaced bytes', () => {
    // The block's media:hash can mutate in place (re-capture / synced edit / undo) WITHOUT a
    // remount. A stale arm would auto-resolve + autoplay the new content behind the user's
    // back; the arm is content-scoped, so it must fall back to the play-gated poster.
    audioProps()
    h.urlState = { status: 'ready', url: 'blob:audio/1' }
    const { container, rerender } = renderContent()
    fireEvent.click(screen.getByTestId('media-audio-play'))
    expect(container.querySelector('audio')).not.toBeNull() // armed + playing the original bytes
    expect(h.useAssetObjectUrl).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { enabled: true })

    // Mutate the block's content hash and re-render the SAME mounted instance (an in-place
    // row change, not a remount) — this is what a synced re-capture / undo looks like.
    h.props = { ...h.props, 'media:hash': 'sha256:cd' }
    rerender(<MediaContentRenderer block={block} />)

    expect(screen.getByTestId('media-audio-play')).toBeInTheDocument() // back to the poster…
    expect(container.querySelector('audio')).toBeNull() // …NOT an auto-playing <audio> of new bytes
    // The eager resolve is disarmed again — nothing fetched/decrypted until the user replays.
    expect(h.useAssetObjectUrl).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { enabled: false })
  })

  it('stays disarmed when the content RETURNS to a previously-played key (A→B→A, e.g. undo a re-capture)', () => {
    // Regression guard: a content-keyed latch must clear on any change, NOT re-arm just
    // because the key equals one it was armed for before (an `armed = armedFor === key`
    // derivation would surprise-autoplay the restored content).
    audioProps() // hash sha256:ab  (content A)
    h.urlState = { status: 'ready', url: 'blob:audio/1' }
    const { container, rerender } = renderContent()
    fireEvent.click(screen.getByTestId('media-audio-play')) // arm + play A
    expect(container.querySelector('audio')).not.toBeNull()

    h.props = { ...h.props, 'media:hash': 'sha256:cd' } // → content B
    rerender(<MediaContentRenderer block={block} />)
    expect(screen.getByTestId('media-audio-play')).toBeInTheDocument() // disarmed

    h.props = { ...h.props, 'media:hash': 'sha256:ab' } // undo → back to content A
    rerender(<MediaContentRenderer block={block} />)
    // Must NOT re-arm/autoplay the restored content without a fresh play gesture.
    expect(screen.getByTestId('media-audio-play')).toBeInTheDocument()
    expect(container.querySelector('audio')).toBeNull()
    expect(h.useAssetObjectUrl).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { enabled: false })
  })

  it('keeps the verified bytes downloadable when playback fails (undecodable audio → the floor holds)', async () => {
    // audio/* no longer falls through to the file download fallback, so a verify-but-can't-
    // decode file (mislabeled/unsupported codec) must STILL be downloadable from the broken
    // state — not stranded behind a dead player.
    audioProps()
    h.urlState = { status: 'error', reason: 'media-undecodable' }
    renderContent()
    fireEvent.click(screen.getByTestId('media-audio-play')) // arm → error branch
    expect(screen.getByTestId('media-audio-broken')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('media-audio-download'))
    await waitFor(() => expect(h.downloadBlob).toHaveBeenCalledTimes(1))
    expect(h.downloadBlob.mock.calls[0][0].type).toBe('application/octet-stream')
  })

  it('offers download from the poster WITHOUT playing (savable without arming the inline resolve)', async () => {
    audioProps()
    renderContent()
    fireEvent.click(screen.getByTestId('media-audio-download')) // no play click
    await waitFor(() => expect(h.downloadBlob).toHaveBeenCalledTimes(1))
    expect(h.downloadBlob.mock.calls[0][0].type).toBe('application/octet-stream')
    // download did not arm the (large-file) inline resolve
    expect(h.useAssetObjectUrl).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { enabled: false })
  })
})

describe('MediaBlockRenderer.canRender', () => {
  // canRender must gate on a LOADED snapshot via peek() — `block.hasType()` reads
  // block.data, which THROWS for a not-yet-loaded / missing row, and useRenderer
  // runs canRender for every block during its load window.
  const peeking = (value: unknown) => ({ peek: () => value }) as unknown as Block
  const typed = (types: string[]) => ({ properties: { [typesProp.name]: typesProp.codec.encode(types) } })

  it('returns true only for a loaded media-typed block', () => {
    expect(MediaBlockRenderer.canRender?.({ block: peeking(typed(['media'])) } as BlockRendererProps)).toBe(true)
    expect(MediaBlockRenderer.canRender?.({ block: peeking(typed(['note'])) } as BlockRendererProps)).toBe(false)
  })

  it('never throws on a not-yet-loaded (undefined) or confirmed-missing (null) block', () => {
    expect(MediaBlockRenderer.canRender?.({ block: peeking(undefined) } as BlockRendererProps)).toBe(false)
    expect(MediaBlockRenderer.canRender?.({ block: peeking(null) } as BlockRendererProps)).toBe(false)
  })

  it('never throws on a malformed types value (raw read, not the throwing codec)', () => {
    // The cache boundary validates JSON syntax, not shape — a corrupt/legacy row
    // could carry types: "media" (string) or [1] (non-string). canRender must
    // read it total (Array.isArray), never route through the throwing codec.
    const malformed = (types: unknown) => peeking({ properties: { types } })
    expect(MediaBlockRenderer.canRender?.({ block: malformed('media') } as BlockRendererProps)).toBe(false)
    expect(MediaBlockRenderer.canRender?.({ block: malformed([1, 2]) } as BlockRendererProps)).toBe(false)
    expect(MediaBlockRenderer.canRender?.({ block: malformed(undefined) } as BlockRendererProps)).toBe(false)
  })
})
