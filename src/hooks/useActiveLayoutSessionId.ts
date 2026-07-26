import { useCallback, useSyncExternalStore } from 'react'
import type { Repo } from '@/data/repo.js'

/**
 * Reactive read of the client's active layout-session id
 * (`repo.client.activeLayoutSessionId`, base-id fallback included). Thin
 * sugar over `ClientContext.onActingAsChange` — the one channel for both
 * acting-as fields (see `src/data/clientContext.ts`) — narrowed to just
 * the layout-session id via `useSyncExternalStore`'s snapshot; a
 * `useClientContext()` + manual pick would work too, but this reads
 * better at call sites that only care about the session id.
 *
 * `onActingAsChange` also fires on `activeWorkspaceId` changes, so this
 * hook's subscription re-runs its snapshot read on those too — but
 * `useSyncExternalStore` only re-renders the consumer when the snapshot
 * value itself changes, so a workspace-only change is a silent no-op
 * here. Genuine layout-session no-ops (`null`⇄base folding) are already
 * filtered upstream: `onActingAsChange` never fires for those.
 *
 * The primary consumer is `LayoutSessionHost`, which re-points the
 * mounted session tree on every switch; imperative code keeps reading
 * `repo.activeLayoutSessionId` directly.
 */
export const useActiveLayoutSessionId = (repo: Repo): string => {
  const subscribe = useCallback(
    (listener: () => void) => repo.client.onActingAsChange(listener),
    [repo],
  )
  const getSnapshot = useCallback(() => repo.client.activeLayoutSessionId, [repo])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
