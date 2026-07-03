import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { isMediaViewerContribution, mediaViewersFacet } from './mediaViewersFacet.js'
import type { MediaViewerContribution } from './mediaViewersFacet.js'
import { FILE_VIEWER_FALLBACK, imageMediaViewer, pickMediaViewer } from './mediaViewers.js'

const fakePdf: MediaViewerContribution = {
  id: 'pdf',
  match: (m) => m === 'application/pdf',
  Component: () => null,
  eager: true,
}

describe('mediaViewersFacet', () => {
  it('collects viewer contributions from multiple sources into a pickable list', () => {
    // Simulates the attachments plugin + a future PDF plugin each contributing a viewer.
    const runtime = resolveFacetRuntimeSync([
      mediaViewersFacet.of(imageMediaViewer, { source: 'attachments' }),
      mediaViewersFacet.of(fakePdf, { source: 'pdf-plugin' }),
    ])
    const viewers = runtime.read(mediaViewersFacet)
    expect(viewers).toHaveLength(2)
    expect(pickMediaViewer(viewers, 'application/pdf')).toBe(fakePdf)
    expect(pickMediaViewer(viewers, 'image/png')).toBe(imageMediaViewer)
    expect(pickMediaViewer(viewers, 'text/plain')).toBe(FILE_VIEWER_FALLBACK)
  })

  it('resolves to an empty list when nothing contributes — the renderer still has the download floor', () => {
    const viewers = resolveFacetRuntimeSync([]).read(mediaViewersFacet)
    expect(viewers).toEqual([])
    expect(pickMediaViewer(viewers, 'image/png')).toBe(FILE_VIEWER_FALLBACK)
  })

  it('drops a malformed contribution via the validate guard', () => {
    expect(isMediaViewerContribution(imageMediaViewer)).toBe(true)
    expect(isMediaViewerContribution({ id: 'x', match: () => true, Component: () => null })).toBe(false) // no `eager`
    expect(isMediaViewerContribution({ id: 'x', match: 'nope', Component: () => null, eager: true })).toBe(false)
    expect(isMediaViewerContribution(null)).toBe(false)
  })
})
