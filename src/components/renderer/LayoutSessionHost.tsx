import { Activity, useContext, useMemo, useState } from 'react'
import { BlockComponent } from '@/components/BlockComponent.js'
import type { BlockRendererProps } from '@/types.js'
import { NestedBlockContextProvider } from '@/context/block.js'
import { LayoutRootContext } from '@/components/renderer/layoutRootContext.js'
import { useActiveLayoutSessionId } from '@/hooks/useActiveLayoutSessionId.js'
import { useIsMobile } from '@/utils/react.js'
import { layoutSessionBlockIdForKey, layoutSessionsContainerBlockId } from '@/data/stateBlocks.js'

/**
 * Renderer for the layout-sessions CONTAINER block (`user page → ui-state →
 * layout-sessions`, the parent of every layout-session block — see
 * `getLayoutSessionBlock`). Keeps an LRU warm set of recently-active
 * sessions MOUNTED across switches: the active one visible, the rest under
 * `<Activity mode="hidden">` — state and DOM preserved, effects unmounted —
 * so switching perspectives doesn't cold-remount the outgoing layout (a
 * playing video keeps playing; scroll, edit and focus state survive).
 *
 * TWO ID DOMAINS. `repo.client.activeLayoutSessionId` (and therefore the
 * warm set) holds session KEYS — the per-device base id / perspective key,
 * ClientContext's domain, NOT block ids. The block a key's session lives in
 * is the deterministic child `getLayoutSessionBlock` materializes under
 * this container; the host derives it at render via
 * `layoutSessionBlockIdForKey(workspaceId, userId, key)` and uses the
 * BLOCK id everywhere a block id is meant: `<BlockComponent blockId>`,
 * `LayoutRootContext.rootBlockId`, the wrapper's `data-layout-session-id`
 * (spatial-nav feeds that attribute into `activatePanelRowInTx`), and the
 * `layoutSessionBlockId` block-context override.
 *
 * DEFAULT-OFF. App still mounts the SESSION block as the root, so this
 * renderer never matches and nothing changes. The opt-in (an extension /
 * future App setting) is to mount the CONTAINER as the layout root instead:
 * `canRender` recognizes it by its deterministic id and outbids
 * TopLevelRenderer, sessions then render as children. Callers switching
 * sessions must materialize the session block first (`getLayoutSessionBlock`)
 * and then call `repo.setActiveLayoutSessionId(key)` — the session KEY, and
 * the host's one reactive input (`useActiveLayoutSessionId`). Switch
 * protocol: the caller must also push the slot-less `#ws;persp=x` hash (no
 * panel slots) BEFORE or together with the key switch — the URL wins
 * inbound (the incoming projection applies the current URL right after
 * start, see `usePanelLayoutProjection`), so a switch that leaves the OLD
 * session's slots in the hash would destructively reconcile the NEW
 * session's rows to the OLD layout; a slot-less hash instead takes the
 * empty-target normalization path (one hash REPLACE materialized from the
 * session's own persisted rows).
 *
 * Single active projection: the host RE-PROVIDES LayoutRootContext with
 * `rootBlockId` re-pointed at the ACTIVE session's BLOCK id (keeping App's
 * `onLayoutHashChanged`). Every warm session renders via TopLevelRenderer,
 * whose `usePanelLayoutProjection` no-ops unless its block IS the named
 * root — so exactly one URL⇄layout projection is live, bound to the active
 * session. Belt-and-braces on top: Activity unmounts hidden sessions'
 * effects, which tears their projections down independently. On a switch
 * the old projection disposes and the new one constructs via normal effect
 * re-keying (hide/reveal + the rootBlockId flip agree on the outcome).
 *
 * Input isolation: the active wrapper carries `data-layout-session-active`;
 * hidden wrappers are `inert` (belt-and-braces — Activity already
 * display:none's them). DOM consumers resolve the active session via
 * `activeLayoutSessionElement()` (utils/layoutSessionDom) instead of a
 * first-match `[data-layout-session-id]` query. Reveal-time DOM focus needs
 * no machinery here: hiding drops DOM focus to body, and on reveal the
 * re-mounted `BlockFocusShellDecorator` layout effect re-asserts focus from
 * the session's persisted `focusedBlockLocation` (its "nothing else holds
 * DOM focus" branch).
 *
 * Known N-instances residue (accepted for v1): each warm session renders
 * its own Header under TopLevelRenderer — hidden ones are display:none'd
 * with effects unmounted, and core header items are plain buttons/status
 * chips, so N instances are inert; but PORTALED content escapes Activity's
 * display:none, so a portal left OPEN at switch time (e.g. an account
 * dropdown) can outlive its session's hide until dismissed. Eviction also
 * deliberately does NOT clear `panelHistory` for the evicted session's
 * panel rows: the store is keyed by panel ROW id and enumerating a
 * session's rows here would need an async subtree read; the entries are
 * small, page-lifetime-bounded — and re-warming the same session remounts
 * the same rows, which then still have their back/forward stacks (a
 * feature, not just an accepted leak).
 */

/** Warm-set caps: how many recently-active sessions stay mounted. Hidden
 *  sessions cost memory + hidden DOM, not layout/effect work — 3 covers the
 *  switch-back-and-forth working set on desktop; mobile keeps only the
 *  active one (memory-constrained, and its layout renders one pane anyway). */
export const DESKTOP_WARM_SESSION_CAP = 3
export const MOBILE_WARM_SESSION_CAP = 1

// Stable fallback so a host mounted without an outer LayoutRootContext
// (tests, stray mounts) still runs its projection wiring deterministically.
// A production mount is expected to sit under App's LayoutRootContext (which
// wires the real hash sync) — this fallback exists for tests/strays only,
// never the shipped opt-in path.
const noopLayoutHashChanged = (): void => {}

export function LayoutSessionHost({block}: BlockRendererProps) {
  const repo = block.repo
  const activeSessionKey = useActiveLayoutSessionId(repo)
  const outer = useContext(LayoutRootContext)
  const isMobile = useIsMobile()
  const cap = isMobile ? MOBILE_WARM_SESSION_CAP : DESKTOP_WARM_SESSION_CAP

  // LRU warm set of session KEYS (the ClientContext domain — block ids are
  // derived per entry at render, below), most-recently-active first.
  // Maintained with the "adjust state during render" pattern (not an
  // effect) so the frame that observes a switch already renders the
  // incoming session — an effect would flash one frame of the outgoing
  // layout. Rendering from `warm` (the adjusted value) keeps both render
  // passes identical.
  const [stored, setStored] = useState<readonly string[]>(() => [activeSessionKey])
  const warm = stored[0] === activeSessionKey && stored.length <= cap
    ? stored
    : [activeSessionKey, ...stored.filter(key => key !== activeSessionKey)].slice(0, cap)
  if (warm !== stored) setStored(warm)

  // KEY → session BLOCK id (the deterministic child getLayoutSessionBlock
  // materializes under this container). canRender declined without an
  // active workspace, so a mounted host always has one; the null fallback
  // below only covers a workspace being UNSET mid-flight (render nothing —
  // a bogus derived id would point every consumer at a phantom block).
  const workspaceId = repo.activeWorkspaceId
  const userId = repo.client.user.id
  const activeSessionBlockId = workspaceId
    ? layoutSessionBlockIdForKey(workspaceId, userId, activeSessionKey)
    : null

  const onLayoutHashChanged = outer?.onLayoutHashChanged ?? noopLayoutHashChanged
  const layoutRootValue = useMemo(
    () => ({rootBlockId: activeSessionBlockId ?? '', onLayoutHashChanged}),
    [activeSessionBlockId, onLayoutHashChanged],
  )

  if (!workspaceId) return null

  return (
    <LayoutRootContext.Provider value={layoutRootValue}>
      {warm.map(sessionKey => {
        const sessionBlockId = layoutSessionBlockIdForKey(workspaceId, userId, sessionKey)
        // Recursion guard, in the BLOCK-ID domain: a derived id equal to the
        // CONTAINER's own id would render a <BlockComponent> for the
        // container inside the SAME ambient (layoutBoundary && !panelId)
        // context that got this host resolved in the first place — canRender
        // would match again, and another LayoutSessionHost would mount
        // recursively without bound. Unreachable by construction (the
        // derived id is uuidv5 over `${containerId}:${key}`, which cannot
        // equal the container id for any key) but cheap to guard against a
        // future derivation change.
        if (sessionBlockId === block.id) {
          if (import.meta.env.DEV) {
            console.warn(
              `[LayoutSessionHost] session key ${sessionKey} derived the container's own id (${block.id}) — skipping`,
            )
          }
          return null
        }
        const isActive = sessionKey === activeSessionKey
        return (
          // key={sessionKey} is the keep-alive: a stable identity per session
          // so a switch flips Activity modes instead of remounting subtrees.
          <Activity key={sessionKey} mode={isActive ? 'visible' : 'hidden'}>
            <div
              data-layout-session-id={sessionBlockId}
              data-layout-session-active={isActive ? '' : undefined}
              inert={isActive ? undefined : true}
            >
              {/* layoutSessionBlockId is the per-subtree POSITIONAL session
                  BLOCK id (block context) — the PR-2 channel render-tree
                  consumers read instead of the ambient module global.
                  LayoutRenderer re-provides the same value per panel;
                  providing it at the session root extends it to non-panel
                  descendants (Header). */}
              <NestedBlockContextProvider overrides={{layoutSessionBlockId: sessionBlockId}}>
                <BlockComponent blockId={sessionBlockId}/>
              </NestedBlockContextProvider>
            </div>
          </Activity>
        )
      })}
    </LayoutRootContext.Provider>
  )
}

// Claims EXACTLY the layout-sessions container at a root mount
// (layoutBoundary && !panelId — TopLevelRenderer's own predicate), recognized
// by its deterministic id: the same (workspace, user) uuidv5 chain that
// mints the block, so the check is synchronous, needs no loaded data, and
// cannot false-positive (nothing else can hold that id).
LayoutSessionHost.canRender = ({block, context}: BlockRendererProps): boolean => {
  if (!context?.layoutBoundary || context.panelId) return false
  const workspaceId = block.repo.activeWorkspaceId
  if (!workspaceId) return false
  return block.id === layoutSessionsContainerBlockId(workspaceId, block.repo.client.user.id)
}
// Must EXCEED TopLevelRenderer's 20: TopLevelRenderer matches EVERY
// layoutBoundary && !panelId block (the container included), and useRenderer
// breaks the overlap purely by priority — 30 lets the host win for the one
// block it claims while every other root block keeps TopLevelRenderer.
LayoutSessionHost.priority = (): number => 30
