import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo.js'
import { buildLayout, buildLayoutFromSlots, parseLayout, preserveHashQueryParams } from '@/utils/routing.js'
import { rememberWorkspace } from '@/utils/lastWorkspace.js'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks.js'
import { workspaceLandingFacet } from '@/extensions/core.js'
import { resolveAppRuntimeSync } from '@/facets/resolveAppRuntime.js'
import { readOverridesCache } from '@/extensions/overridesCache.js'
import { staticAppExtensions } from '@/extensions/staticAppExtensions.js'
import { getLayoutSessionId } from '@/utils/layoutSessionId.js'
import { applyCurrentLayoutUrl, createPanelRowInTx } from '@/utils/panelLayoutProjection.js'
import { keyAtEnd } from '@/data/orderKey.js'
import { ChangeScope } from '@/data/api'

const replaceHash = (hash: string): void => {
  if (typeof window === 'undefined') return
  const nextHash = preserveHashQueryParams(hash, window.location.hash)
  if (window.location.hash === nextHash) return
  window.history.replaceState(null, '', nextHash)
}

// Resolve the static-extension runtime once per (repo, workspace).
// `workspaceLandingFacet` resolvers only need the kernel + static
// plugin contributions — dynamic plugins haven't loaded yet at this
// point in bootstrap, and we don't want to give them the power to
// redirect a user's first paint.
//
// Resolution goes through `resolveAppRuntimeSync` with the workspace's
// cached toggle overrides — NOT the bare collector — so a togglable
// boundary the user has disabled is honoured here too. Without this, a
// disabled non-essential plugin (e.g. `system:daily-notes`, the sole
// `workspaceLandingFacet` contributor) would still steer first paint.
//
// The cache keeps the cost down across re-entries via getInitialLayout's
// promise cache; entries are keyed by `repo.instanceId` + workspace +
// the override state, so a fresh Repo (new login), a workspace switch,
// or a mid-session toggle change (Settings dispatches
// `refreshAppRuntime`) all build a fresh runtime instead of replaying a
// stale one — otherwise a just-disabled daily-notes could still steer a
// later empty-layout navigation until a full reload.
const landingRuntimeCache = new Map<string, ReturnType<typeof resolveAppRuntimeSync>>()
const getLandingRuntime = (repo: Repo) => {
  const workspaceId = repo.activeWorkspaceId
  const overrides = workspaceId
    ? readOverridesCache(workspaceId)
    : new Map<string, boolean>()
  // Sparse map (only entries diverging from manifest defaults), sorted
  // for a stable key regardless of insertion order.
  const overridesFingerprint = JSON.stringify(
    [...overrides.entries()].sort(([a], [b]) => a.localeCompare(b)),
  )
  const cacheKey = `${repo.instanceId}:${workspaceId ?? ''}:${overridesFingerprint}`
  const cached = landingRuntimeCache.get(cacheKey)
  if (cached) return cached
  const runtime = resolveAppRuntimeSync(staticAppExtensions({repo}), {
    overrides,
    context: {
      repo,
      workspaceId,
      safeMode: false,
    },
  })
  landingRuntimeCache.set(cacheKey, runtime)
  return runtime
}

// Walk landing resolvers in reverse (highest precedence last in the
// array — see `workspaceLandingFacet` docstring). Return the first
// non-null id, or null if every resolver punts. A throwing resolver
// is logged and skipped so a misbehaving plugin can't permanently
// block the user from booting the app.
const resolveLandingBlockId = async (
  repo: Repo,
  workspaceId: string,
  freshlyCreated: boolean,
): Promise<string | null> => {
  const runtime = getLandingRuntime(repo)
  const resolvers = runtime.read(workspaceLandingFacet)
  for (let i = resolvers.length - 1; i >= 0; i -= 1) {
    try {
      const id = await resolvers[i]({repo, workspaceId, freshlyCreated})
      if (id) return id
    } catch (error) {
      console.error('[App] workspace landing resolver threw', error)
    }
  }
  return null
}

export interface WorkspaceBootstrapArgs {
  repo: Repo
  workspaceId: string
  freshlyCreated: boolean
  requestedHash: string
  /** The workspace id parsed from the requested hash (if any) — used to detect
   *  a URL pointing at a different workspace than the one we resolved. */
  requestedWorkspaceId: string | undefined
}

/**
 * The bootstrap *write* phase (§6 gate already cleared by the caller). Performs
 * the workspace-scoped writes — remember-as-default, one-shot backfills, the
 * starter tutorial, the Properties/Types/Recents pages, the ui-state block — and
 * applies the URL→layout projection (landing on a plugin-resolved block when the
 * layout is empty). Returns the layout-session block the app renders.
 *
 * Testable without rendering: it takes a repo and plain args and returns a Block.
 */
export const bootstrapWorkspace = async ({
  repo,
  workspaceId,
  freshlyCreated,
  requestedHash,
  requestedWorkspaceId,
}: WorkspaceBootstrapArgs): Promise<Block> => {
  // A workspace pin starts the property-schema projector asynchronously. Until
  // its first complete result, declaration synthesis cannot know whether a
  // stored definition shadows or renames a seed. Keep bootstrap's writes behind
  // that completeness boundary; the shared Repo tx path queues other callers.
  await repo.whenPropertyDefinitionsReady(workspaceId)

  // Only NOW remember it as the default. Remembering a locked/waiting workspace
  // would make the next empty-hash visit re-select it and render only the key
  // gate (no switcher), trapping the user away from accessible spaces.
  rememberWorkspace(workspaceId)

  // Workspace-scoped one-shot data backfills (workspaceBackfillsFacet) — e.g.
  // daily-notes deriving daily-note:date for pre-existing rows. Fire-and-forget:
  // the repo defers it off this critical path and gates it to run once per
  // workspace. Placed AFTER the access gate (in the caller) so we never write
  // into a locked / read-only workspace; routed through repo.tx so the derived
  // rows upload — a raw write would stay local, which is exactly how the
  // original daily-note:date backfill silently never synced.
  repo.scheduleWorkspaceBackfills(workspaceId)

  // Backfill derived references for this workspace's pre-existing rows. The
  // facet bridge only reprojects names whose ref-ness CHANGED on a rebuild, so a
  // workspace sharing a ref-typed name (e.g. a static seed like next-review-date)
  // with the previously-active one produces an empty diff and never scans its
  // own rows. Marker-gated once per workspace, deferred off this critical path.
  repo.scheduleWorkspaceRefBackfill(workspaceId)

  // One-time catch-up derive of the LOCAL `reference_target_id` column for
  // rows that predate it (PR #288 slice A). Marker-gated per workspace,
  // deferred off this critical path; placed after `whenPropertyDefinitionsReady`
  // above so the `[[name]]` tier resolves against the primed name-winner map.
  repo.scheduleReferenceTargetDerivePass(workspaceId)

  // One-time post-upgrade recovery for the deterministic-id shadow: clients that
  // skip-staled the server's authoritative row under the old reconcile gate
  // consumed its change-queue entry, so a normal startup never re-evaluates it.
  // Re-scan the workspace's staged rows once (marker-gated, deferred) so those
  // shadows heal on disk; visible on the next reload (the live cache LWW still
  // holds the default this session).
  repo.scheduleReconcileRescan(workspaceId)

  // The built-in data-integrity self-audit (L3) is now scheduled by the
  // data-integrity plugin's AppEffect (cadenced, read-only, deferred to idle),
  // which runs on workspace open and surfaces health via the diagnostics seam.

  // First-run starter content (the Tutorial pages + the [[Tutorial]]
  // discoverability bullet) is no longer seeded here: it's owned by the
  // onboarding plugin, which contributes a `workspaceLandingFacet` resolver
  // that seeds on `freshlyCreated` and then defers the landing target to
  // daily-notes (see src/plugins/onboarding). That keeps first-run content
  // out of the kernel and lets disabling the plugin remove it cleanly. The
  // tutorial's typed demos seed against `repo.snapshotTypeRegistries()`,
  // which is populated from `staticDataExtensions` at repo construction.

  // Resolve the layout-session block the app paints — the warm-start critical
  // path. This chain is genuinely serial: each ui-state child's deterministic id
  // derives from its parent (user-page → ui-state → layout-sessions → session),
  // so it can't be collapsed, and the URL→layout projection + landing decision
  // depend on the session block. Runs concurrently with the kernel pages below.
  const resolveLayoutSession = async (): Promise<Block> => {
    const uiState = await getUIStateBlock(repo, workspaceId, repo.user, {})
    const layoutSessionBlock = await getLayoutSessionBlock(uiState, getLayoutSessionId())
    const hashForResolvedWorkspace = requestedWorkspaceId && requestedWorkspaceId !== workspaceId
      ? buildLayout(workspaceId)
      : requestedHash

    const applyResult = await applyCurrentLayoutUrl({
      repo,
      workspaceId,
      layoutSessionBlock,
      hash: hashForResolvedWorkspace,
      replaceHash,
    })

    if (applyResult.kind === 'empty') {
      // Empty layout — ask plugins via `workspaceLandingFacet` what block
      // to land on. The daily-notes plugin contributes the historical
      // "open today's note (and seed a [[Tutorial]] bullet on first
      // run)" behavior; other plugins (or none) can override. We resolve
      // the static-extension runtime here SYNCHRONOUSLY rather than
      // waiting for AppRuntimeProvider's full async resolution because
      // the landing decision blocks the first paint — dynamic
      // user-defined plugins shouldn't be able to redirect the bootstrap
      // before we've even built a layout, and the sync runtime carries
      // the same kernel + static plugin contributions
      // AppRuntimeProvider's initial render uses.
      const landingId = await resolveLandingBlockId(repo, workspaceId, freshlyCreated)
      if (landingId) {
        // Carry the inbound hash's ws-context (`;persp=` etc.) onto the
        // landing hash: an empty layout is exactly how a fresh perspective
        // session boots, and dropping the context here would strip the
        // extension-side lane marker on its very first paint.
        replaceHash(buildLayoutFromSlots(
          workspaceId,
          [{kind: 'leaf', blockId: landingId}],
          parseLayout(hashForResolvedWorkspace).wsContext,
        ))
        await repo.tx(async tx => {
          const parent = await tx.get(layoutSessionBlock.id)
          if (!parent) throw new Error(`getInitialLayout: layout session block ${layoutSessionBlock.id} not found`)
          await createPanelRowInTx(repo, tx, {
            workspaceId,
            parentId: layoutSessionBlock.id,
            orderKey: keyAtEnd(null),
            blockId: landingId,
          })
        }, {scope: ChangeScope.UiState, description: 'bootstrap landing panel'})
      }
    }

    return layoutSessionBlock
  }

  // Materialise the workspace's singleton system pages (Properties/Types/
  // Recents/Journal/Locations + any other `systemPagesFacet` contribution)
  // BEFORE resolving the layout. The landing resolver may seed content with
  // `[[reserved alias]]` wiki-links, and those must resolve to the canonical
  // page rather than auto-create a rival (alias.collision) — so the pages have
  // to exist first. That's why this is serialized ahead of the layout chain
  // rather than racing it the way these kernel pages used to (each is
  // idempotent + deterministic-id, so on a warm start it's just a cached read).
  await repo.ensureSystemPages(workspaceId)

  // Materialize the code-declared property seeds into block-backed definitions
  // for this workspace (schema-unification §4.3). At bootstrap the installed
  // runtime is the static-data one, so only its seeds land here; the post-paint
  // app-runtime install (and dynamic-extension loads) re-fire the pass from the
  // registry-apply path as plugin seeds appear. Deferred + create/restore-only;
  // `freshlyCreated` lets a fresh workspace skip the membership-row wait its
  // access gate otherwise performs.
  //
  // Kept after `ensureSystemPages` so the pages already exist when the pass runs:
  // the materializer parents each definition block to `propertiesPageBlockId` /
  // `typesPageBlockId`, and `tx.create` enforces `requireParentInWorkspace`. The
  // pass now ensures its own parent (`config.ensureParent`), so an earlier fire —
  // e.g. the `setActiveWorkspaceId` reschedule, which for type seeds has no priming
  // gate and can precede this — no longer throws on a missing parent; scheduling
  // here just means that ensure is a cheap no-op rather than the page-creating path.
  repo.scheduleWorkspaceSeedMaterialization(workspaceId, freshlyCreated)

  const layoutSessionBlock = await resolveLayoutSession()
  return layoutSessionBlock
}
