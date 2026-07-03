import { describe, expect, it } from 'vitest'
import {
  FILE_VIEWER_FALLBACK,
  audioMediaViewer,
  formatByteSize,
  imageMediaViewer,
  pickMediaViewer,
} from './mediaViewers.js'
import type { MediaViewerContribution } from './mediaViewersFacet.js'

const fakePdf: MediaViewerContribution = {
  id: 'pdf',
  match: (m) => m === 'application/pdf',
  Component: () => null,
  eager: true,
}

describe('pickMediaViewer', () => {
  it('returns the first viewer whose match() accepts the mime (list is precedence-ordered)', () => {
    const viewers = [imageMediaViewer, audioMediaViewer, fakePdf]
    expect(pickMediaViewer(viewers, 'image/png')).toBe(imageMediaViewer)
    expect(pickMediaViewer(viewers, 'IMAGE/PNG')).toBe(imageMediaViewer) // MIME is case-insensitive (RFC 2045)
    expect(pickMediaViewer(viewers, 'audio/mpeg')).toBe(audioMediaViewer)
    expect(pickMediaViewer(viewers, 'AUDIO/OGG')).toBe(audioMediaViewer)
    expect(pickMediaViewer(viewers, 'application/pdf')).toBe(fakePdf)
  })

  it('falls back to the download viewer when no registered viewer claims the mime', () => {
    expect(pickMediaViewer([imageMediaViewer], 'audio/mpeg')).toBe(FILE_VIEWER_FALLBACK)
    // Empty facet → still downloadable (the fallback is a hardcoded floor, not a contribution).
    expect(pickMediaViewer([], 'application/pdf')).toBe(FILE_VIEWER_FALLBACK)
  })
})

describe('audioMediaViewer', () => {
  it('claims audio/* and resolves LAZILY (eager: false) — bytes are fetched on first play, not on mount', () => {
    expect(audioMediaViewer.match('audio/mpeg')).toBe(true)
    expect(audioMediaViewer.match('image/png')).toBe(false)
    // Not eager: the renderer must NOT resolve the (possibly large) bytes on mount — the
    // AudioViewer arms the resolve itself on the first play intent (§8/§11).
    expect(audioMediaViewer.eager).toBe(false)
  })
})

describe('formatByteSize', () => {
  it('scales to binary units, one decimal below 10, whole above', () => {
    expect(formatByteSize(0)).toBe('0 B')
    expect(formatByteSize(512)).toBe('512 B')
    expect(formatByteSize(1024)).toBe('1 KB')
    expect(formatByteSize(1536)).toBe('1.5 KB')
    expect(formatByteSize(1024 * 1024)).toBe('1 MB')
    expect(formatByteSize(2_100_000)).toBe('2 MB')
    expect(formatByteSize(15 * 1024 * 1024)).toBe('15 MB')
    expect(formatByteSize(1024 ** 3)).toBe('1 GB')
  })
})
