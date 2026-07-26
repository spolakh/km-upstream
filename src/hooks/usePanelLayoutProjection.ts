import { useContext, useEffect } from 'react'
import type { Block } from '@/data/block.js'
import { PanelLayoutProjection } from '@/utils/panelLayoutProjection.js'
import { LayoutRootContext } from '@/components/renderer/layoutRootContext.js'

/**
 * Owns the URL⇄layout projection for the layout root block. The default
 * layout-root renderer (TopLevelRenderer) calls this; an extension that
 * overrides the root renderer calls it too, keeping the projection alive
 * under its own shell.
 *
 * No-ops unless a LayoutRootContext is provided AND `block` is the root
 * block it names — this guards stray `layoutBoundary` mounts (e.g. dialog
 * previews rendering with a fresh block context) from spawning duplicate
 * projections.
 *
 * workspaceId comes from `block.repo.activeWorkspaceId` rather than a prop:
 * App sets it in phase 1 of resolveInitialLayout, BEFORE the
 * layoutSessionBlock exists, so by the time this effect runs it is identical
 * to what App used to pass. The only later setters are user-initiated
 * workspace switches (WorkspaceSwitcher, ConsistencyAuditDialog), which also
 * rewrite the hash → re-resolution → a new layoutSessionBlock → this effect
 * re-keys and tears down anyway.
 */
export const usePanelLayoutProjection = (block: Block): void => {
  const context = useContext(LayoutRootContext)
  const isLayoutRoot = context !== null && block.id === context.rootBlockId
  const onLayoutHashChanged = context?.onLayoutHashChanged

  useEffect(() => {
    if (!isLayoutRoot || !onLayoutHashChanged) return
    const workspaceId = block.repo.activeWorkspaceId
    if (!workspaceId) return
    const projection = new PanelLayoutProjection({
      repo: block.repo,
      workspaceId,
      layoutSessionBlock: block,
    })
    const unsubscribe = projection.subscribe(onLayoutHashChanged)
    // `start()` is async; under StrictMode the effect mounts/unmounts/mounts,
    // so cleanup can run BEFORE start resolves. The flag routes that late
    // resolution into dispose() instead of leaving a live projection behind.
    let disposed = false
    void projection.start()
      .then(async () => {
        if (disposed) {
          projection.dispose()
          return
        }
        // Reconcile the CURRENT URL once, explicitly: start() only loads rows
        // and subscribes, and pushState fires neither hashchange nor popstate
        // — so a projection constructed AFTER boot (LayoutSessionHost
        // switching to a warm session behind a freshly pushed slot-less
        // `#ws;persp=…` hash) would otherwise never normalize its session's
        // rows into the hash, and its first row mutation would push a
        // spurious extra history entry over the stale one. For the BOOT
        // session this re-applies what bootstrapWorkspace just applied and
        // canonicalized — a provable no-op (topology-equal reconcile writes
        // nothing; the canonical hash compares equal so nothing is replaced
        // or pushed; kind 'noop' doesn't notify), pinned in
        // panelLayoutProjection.test.ts — which is why there is ONE behavior
        // here rather than a host-only mode flag.
        await projection.applyCurrentUrl()
        if (!disposed) onLayoutHashChanged()
      })
      .catch(error => {
        console.error('[usePanelLayoutProjection] Failed to start panel layout projection', error)
      })
    return () => {
      disposed = true
      unsubscribe()
      projection.dispose()
    }
  }, [isLayoutRoot, block, onLayoutHashChanged])
}
