import { headerItemsFacet, type HeaderItemContribution } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { SystemStatusHeaderItem } from './SystemStatusHeaderItem.tsx'

export const systemStatusHeaderItem: HeaderItemContribution = {
  id: 'system-status.header',
  region: 'end',
  component: SystemStatusHeaderItem,
}

// Formerly "sync-status": the chip started as a sync indicator but now
// aggregates the whole system's health (sync state + diagnostics seam: data
// integrity, storage persistence, app updates), so it's named for that.
//
// The toggle id deliberately KEEPS the old `system:sync-status` string: the
// enable/disable override map is persisted/synced keyed by this id, so renaming
// it would silently re-enable the chip for anyone who turned it off and orphan
// their stored preference. The id is an internal stable key; only the
// user-facing name changed.
export const systemStatusPlugin: AppExtension = systemToggle({
  id: 'system:sync-status',
  name: 'System status',
  description: 'Header status indicator — sync state plus health signals (data integrity, storage, app updates).',
}).of([
  headerItemsFacet.of(systemStatusHeaderItem, {
    source: 'system-status',
    precedence: 40,
  }),
])
