/**
 * User-local state plumbing — per-user "user page", synced user prefs,
 * per-plugin sub-blocks, and per-panel ui-state child tree. Pure
 * (non-React) helpers live here; React hooks that consume them live in
 * `globalState.ts`. Splitting along this fault line keeps module-init
 * import graphs out of `react`/`@/context/repo`, which is what lets
 * `pluginStateExtensions.ts` import these helpers statically without
 * cycling through `repoProvider → staticDataExtensions → plugin/*`.
 *
 * Deterministic ids derived from (workspace, user, ...) keep two
 * offline clients converging on the same row when they later sync.
 */

import {memoize} from '@/utils/memoize'
import { v5 as uuidv5 } from 'uuid'
import {
  ChangeScope,
  type PropertySchema,
  type TypeContribution,
  type TypeRegistrySnapshot,
  type User,
} from '@/data/api'
import { Block } from './block'
import type { Repo } from './repo'
import type { BlockContextType } from '@/types'
import {
  aliasesProp,
  hasBlockType,
  selectionStateProp,
  showPropertiesProp,
  userIdProp,
  type BlockSelectionState,
} from '@/data/properties'
import { USER_PREFS_PATH_PART } from '@/data/userPrefs.js'
import { PAGE_TYPE, USER_TYPE } from '@/data/blockTypes.js'

// ──── Deterministic-id namespaces ────

// Per-user "user page" — parent-less alias-bearing block hosting the
// user's prefs + UI-state subtree for a given workspace. This namespace
// intentionally differs from the pre-UserPrefs UI-state namespace whose
// rows predate uniform upload routing and may not exist on the server.
const USER_PAGE_NS = '99b1b4e5-6f58-4fd2-9089-dc3b358dd4df'
// Per-(parent, content) state child — used by the bootstrap below
// (user-prefs, ui-state, panels, panel/main, etc.) so each name resolves
// to the same block id across clients.
const STATE_CHILD_NS = '8f6c2c84-1c12-4e4a-8b9e-9b0f87a7e1d2'

/** Deterministic id of a user's "user page" block. Exported so display
 *  surfaces can resolve an arbitrary `userId` (e.g. a row's `updatedBy`)
 *  back to its page — and thus its display name — without knowing the
 *  namespace. Two offline clients derive the same id, so a user's page
 *  authored on one device resolves the same on every other. */
export const userPageBlockId = (workspaceId: string, userId: string): string =>
  uuidv5(`${workspaceId}:${userId}`, USER_PAGE_NS)

const stateChildBlockId = (parentId: string, content: string): string =>
  uuidv5(`${parentId}:${content}`, STATE_CHILD_NS)

const snapshotIncludingType = (repo: Repo, type: TypeContribution): TypeRegistrySnapshot => {
  const snapshot = repo.snapshotTypeRegistries()
  if (snapshot.types.has(type.id)) return snapshot

  const types = new Map(snapshot.types)
  types.set(type.id, type)
  const propertySchemas = new Map(snapshot.propertySchemas)
  for (const schema of type.properties ?? []) {
    if (!propertySchemas.has(schema.name)) propertySchemas.set(schema.name, schema)
  }
  return {types, propertySchemas}
}

// ──── Helpers ────

export const requireWorkspaceId = (repo: Repo, caller: string): string => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) {
    throw new Error(`${caller} requires an active workspace; call repo.setActiveWorkspaceId() first`)
  }
  return workspaceId
}

export const requireSchemaScope = <T>(
  schema: PropertySchema<T>,
  scope: ChangeScope,
  caller: string,
): PropertySchema<T> => {
  if (schema.changeScope !== scope) {
    throw new Error(`${caller} expected ${scope} property ${schema.name}, got ${schema.changeScope}`)
  }
  return schema
}

/** Idempotent state child creation. Returns the Block facade for
 *  the child whose content equals `content` under `parent`. The id
 *  comes from `stateChildBlockId(parentId, content)` so repeat calls hit
 *  the same row deterministically. Restores soft-deleted rows in the
 *  same scope.
 *
 *  Cold-start fast path: if the child is already live in cache or in
 *  SQL (the common case after the first launch), skip the
 *  writeTransaction entirely. The bootstrap path through this helper
 *  is called from at least four memoized parents (user-prefs,
 *  ui-state, panels, plus per-plugin children); a no-op tx still
 *  costs ~100 ms each because of trigger overhead, so amortizing
 *  those across cold start has been a measurable cost. The slow
 *  path is identical to before — `tx.get` re-checks under the lock
 *  to handle the (rare) tombstone case that `repo.load` filters out
 *  with its `deleted = 0` predicate. */
const ensureStateChild = async (
  repo: Repo,
  parent: Block,
  /** Stable internal key for the deterministic child id. Two clients
   *  bootstrapping the same logical state row must pass the same string
   *  here so the rows converge on sync. */
  namespace: string,
  scope: ChangeScope,
  initialProperties: Record<string, unknown> = {},
  /** Human-readable row content (the block's page title / navigation
   *  label). Defaults to `namespace` for state children whose title is
   *  intentionally internal (`ui-state`, `layout-sessions`, …). */
  displayContent: string = namespace,
  type?: TypeContribution,
): Promise<Block> => {
  const parentData = parent.peek() ?? await parent.load()
  if (!parentData) throw new Error(`ensureStateChild: parent ${parent.id} not loaded`)
  const childId = stateChildBlockId(parent.id, namespace)

  const live = await repo.load(childId)
  if (live) {
    if (type && !hasBlockType(live, type.id)) {
      const typeSnapshot = snapshotIncludingType(repo, type)
      await repo.tx(async tx => {
        const current = await tx.get(childId)
        if (!current || current.deleted || hasBlockType(current, type.id)) return
        await repo.addTypeInTx(tx, childId, type.id, {}, typeSnapshot)
      }, {scope, description: `ensureStateChild ${namespace}`})
    }
    return repo.block(childId)
  }

  const typeSnapshot = type ? snapshotIncludingType(repo, type) : undefined
  await repo.tx(async tx => {
    const existing = await tx.get(childId)
    if (existing && !existing.deleted) {
      if (type && !hasBlockType(existing, type.id)) {
        await repo.addTypeInTx(tx, childId, type.id, {}, typeSnapshot)
      }
      return
    }
    if (existing && existing.deleted) {
      await tx.restore(childId, {content: displayContent})
      if (type) {
        await repo.addTypeInTx(tx, childId, type.id, {}, typeSnapshot)
      }
      return
    }
    // Fresh insert. Use 'a0' as a starter order key — fine because
    // state children don't compete for ordering with user-authored
    // siblings beyond the bootstrap bucket; if we ever add multiple
    // ordered state children, swap to keyAtEnd.
    await tx.create({
      id: childId,
      workspaceId: parentData.workspaceId,
      parentId: parent.id,
      orderKey: 'a0',
      content: displayContent,
      properties: initialProperties,
    }, {systemMint: true})
    if (type) {
      await repo.addTypeInTx(tx, childId, type.id, {}, typeSnapshot)
    }
  }, {scope, description: `ensureStateChild ${namespace}`})

  const child = repo.block(childId)
  await child.load()
  return child
}

const ensureUiChild = (
  repo: Repo,
  parent: Block,
  namespace: string,
  /** Optional display title; defaults to `namespace` (the internal key). Lets a
   *  caller key a child by an opaque id but title it legibly. */
  content?: string,
): Promise<Block> =>
  ensureStateChild(repo, parent, namespace, ChangeScope.UiState, {}, content)

const ensureUserPrefsChild = (repo: Repo, parent: Block): Promise<Block> =>
  ensureStateChild(
    repo,
    parent,
    USER_PREFS_PATH_PART,
    ChangeScope.UserPrefs,
    {},
    'Preferences',
  )

// ──── Bootstrap blocks ────

const dedupe = (values: readonly string[]): string[] => [...new Set(values)]

/** Repair an existing user page to the current shape: the user id as an
 *  alias, the `USER_TYPE` marker, and the `user:id` property. Pages
 *  created before any of these existed (or restored by an older client)
 *  are upgraded in place on first access. Idempotent and additive —
 *  never rewrites the display-name alias or content, so a user who
 *  renamed their own page keeps that. Runs at most once per memoized
 *  (repo, workspace, user) since the caller is itself memoized; the peek
 *  skips the tx entirely once the page is up to date. Best-effort: an
 *  alias-collision rejection (the id already claimed elsewhere — not
 *  expected for opaque ids) is swallowed so it can't break user-page
 *  resolution. */
const reconcileUserPage = async (repo: Repo, id: string, userId: string): Promise<void> => {
  const block = repo.block(id)
  const data = block.peek()
  if (!data) return
  const aliases = block.peekProperty(aliasesProp) ?? []
  const upToDate =
    aliases.includes(userId) &&
    hasBlockType(data, USER_TYPE) &&
    (block.peekProperty(userIdProp) ?? '') === userId
  if (upToDate) return

  const typeSnapshot = repo.snapshotTypeRegistries()
  try {
    await repo.tx(async tx => {
      const row = await tx.get(id)
      if (!row || row.deleted) return
      const txAliases = await tx.getProperty(id, aliasesProp)
      if (!txAliases.includes(userId)) {
        await tx.setProperty(id, aliasesProp, [...txAliases, userId])
      }
      if ((await tx.getProperty(id, userIdProp)) !== userId) {
        await tx.setProperty(id, userIdProp, userId)
      }
      await repo.addTypeInTx(tx, id, USER_TYPE, {}, typeSnapshot)
    }, {scope: ChangeScope.UserPrefs, description: 'user-page reconcile'})
  } catch (err) {
    console.warn(`[stateBlocks] could not reconcile user page ${id}:`, err)
  }
}

/** Per-user "user page" block — created (or restored) on first access.
 *  The aliases match the user's display name *and* opaque id so
 *  alias-based lookup surfaces can target it either way. Memoized per
 *  (repo, workspaceId, userId) — `use()` requires a stable promise per
 *  render.
 *
 *  The fast path uses `repo.load` to skip the tx entirely when the row
 *  is already live in cache or in SQL. Tombstone branch lives INSIDE
 *  the tx because `repo.load` filters `deleted = 0` (so tombstones
 *  always come back as `null`); we have to use `tx.get` to see them. */
export const getUserBlock = memoize(
  async (repo: Repo, workspaceId: string, user: User): Promise<Block> => {
    const id = userPageBlockId(workspaceId, user.id)
    const live = await repo.load(id)
    if (live) {
      await reconcileUserPage(repo, id, user.id)
      return repo.block(id)
    }

    // User.name is optional in the data-layer User shape; fall back
    // to the id so the user-page block always has *some* content
    // and an addressable alias.
    const displayName = user.name ?? user.id
    // The id rides alongside the display name as an alias so the
    // user-page is addressable both ways — by name (`[[Alice]]`) and by
    // the opaque id stored in `created_by`/`updated_by`. Deduped for the
    // no-name case where displayName === user.id.
    const aliases = dedupe([displayName, user.id])
    const typeSnapshot = repo.snapshotTypeRegistries()

    await repo.tx(async tx => {
      // Re-read inside the tx with the unfiltered `tx.get` so we see
      // tombstones. (`repo.load` returned null in that case, so the
      // outer `live` is no signal here.) Three outcomes:
      //   1. live row appeared between load and tx open  → no-op
      //   2. tombstoned row                              → restore
      //   3. truly missing                               → create
      const existing = await tx.get(id)
      if (existing && !existing.deleted) return
      if (existing && existing.deleted) {
        await tx.restore(id, {content: displayName})
        await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: aliases}, typeSnapshot)
        await repo.addTypeInTx(tx, id, USER_TYPE, {[userIdProp.name]: user.id}, typeSnapshot)
        return
      }
      await tx.create({
        id,
        workspaceId,
        parentId: null,
        orderKey: 'a0',
        content: displayName,
      }, {systemMint: true})
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: aliases}, typeSnapshot)
      await repo.addTypeInTx(tx, id, USER_TYPE, {[userIdProp.name]: user.id}, typeSnapshot)
    }, {scope: ChangeScope.UserPrefs})

    return repo.block(id)
  },
  (repo, workspaceId, user) => instanceKey(repo, workspaceId, user.id),
)

export const getUserPrefsBlock = memoize(
  async (repo: Repo, workspaceId: string, user: User): Promise<Block> => {
    const userBlock = await getUserBlock(repo, workspaceId, user)
    return ensureUserPrefsChild(repo, userBlock)
  },
  (repo, workspaceId, user) => instanceKey(repo, workspaceId, user.id, '__user_prefs__'),
)

/** Per-plugin preferences sub-block under the root user-prefs block.
 *  Each plugin gets its own child keyed by the type contribution's `id`,
 *  carrying that id as its block type marker. Splitting preferences across
 *  per-plugin rows (rather than packing them all into the root block's
 *  `properties_json`) bounds the blast radius of any single PATCH upload
 *  to one plugin's settings — the row-level UPDATE trigger writes the full
 *  `properties_json` column on any property change, so unrelated plugins'
 *  values are no longer at risk of being clobbered by a peer's edit. */
export const getPluginPrefsBlock = memoize(
  async (
    repo: Repo,
    workspaceId: string,
    user: User,
    type: TypeContribution,
  ): Promise<Block> => {
    const userPrefsBlock = await getUserPrefsBlock(repo, workspaceId, user)
    return ensureStateChild(
      repo,
      userPrefsBlock,
      type.id,
      ChangeScope.UserPrefs,
      {[showPropertiesProp.name]: showPropertiesProp.codec.encode(true)},
      type.label ?? type.id,
      type,
    )
  },
  (repo, workspaceId, user, type) =>
    instanceKey(repo, workspaceId, user.id, 'plugin-prefs', type.id),
)

const UI_STATE_PATH_PART = 'ui-state'

/** Resolve the UI-state block scoped to the current panel context.
 *  In a panel context (`context.panelId`), returns the panel's own
 *  block — per-panel UI state lives directly on it. Outside a panel,
 *  returns the user-level `ui-state` child of the user page. */
export const getUIStateBlock = memoize(
  async (
    repo: Repo,
    workspaceId: string,
    user: User,
    context: BlockContextType,
  ): Promise<Block> => {
    if (context.panelId) {
      await repo.load(context.panelId)
      return repo.block(context.panelId)
    }

    const userBlock = await getUserBlock(repo, workspaceId, user)
    return ensureUiChild(repo, userBlock, UI_STATE_PATH_PART)
  },
  (repo, workspaceId, user, context) =>
    instanceKey(repo, workspaceId, user.id, context.panelId ?? '__root__'),
)

const LAYOUT_SESSIONS_PATH_PART = 'layout-sessions'

/** Deterministic id of the root ui-state block — same uuidv5 chain
 *  `ensureUiChild(userBlock, UI_STATE_PATH_PART)` resolves to at runtime.
 *  Pure intermediate so `layoutSessionsContainerBlockId` below reads one
 *  step per path segment (user page -> ui-state -> layout-sessions) instead
 *  of nesting both `stateChildBlockId` calls inline. */
const uiStateBlockId = (workspaceId: string, userId: string): string =>
  stateChildBlockId(userPageBlockId(workspaceId, userId), UI_STATE_PATH_PART)

/** Deterministic id of the layout-sessions CONTAINER block — the parent
 *  every per-device / per-perspective layout-session block lives under
 *  (user page → ui-state → layout-sessions; `getLayoutSessionBlock`
 *  materializes children of exactly this row). Pure derivation over the
 *  same uuidv5 chain `ensureStateChild` uses, so it needs NO block loaded —
 *  which is what lets a renderer's synchronous `canRender` recognize the
 *  container (`LayoutSessionHost`). Memoized because canRender runs per
 *  candidate resolution. */
export const layoutSessionsContainerBlockId = memoize(
  (workspaceId: string, userId: string): string =>
    stateChildBlockId(uiStateBlockId(workspaceId, userId), LAYOUT_SESSIONS_PATH_PART),
  (workspaceId, userId) => `${workspaceId}:${userId}`,
)

/** Deterministic id of the layout-session block for a session KEY — the
 *  `repo.client.activeLayoutSessionId` domain (per-device base id /
 *  perspective key), which is NOT itself a block id. Same pure-derivation
 *  rationale as `layoutSessionsContainerBlockId` above: needs no block
 *  loaded, so `LayoutSessionHost` can map its warm session keys to block
 *  ids synchronously at render.
 *
 *  MUST return exactly the id `getLayoutSessionBlock(rootUiState, key)`
 *  below materializes. Both compose the one formula
 *  (`stateChildBlockId(parentId, namespace)` — `ensureStateChild` keys its
 *  row the same way), so they cannot drift unless the container chain
 *  itself changes; the mapping is pinned against the materializer in
 *  `src/data/test/globalState.test.ts`. */
export const layoutSessionBlockIdForKey = memoize(
  (workspaceId: string, userId: string, sessionKey: string): string =>
    stateChildBlockId(layoutSessionsContainerBlockId(workspaceId, userId), sessionKey),
  (workspaceId, userId, sessionKey) => `${workspaceId}:${userId}:${sessionKey}`,
)

/** Materializes (and returns) the session block for `layoutSessionId` —
 *  the session KEY, not a block id. For the ROOT ui-state block this
 *  resolves to `layoutSessionBlockIdForKey(workspaceId, userId, key)`
 *  (the pure derivation above) — keep the two in lockstep. */
export const getLayoutSessionBlock = memoize(
  async (uiStateBlock: Block, layoutSessionId: string): Promise<Block> => {
    const layoutSessionsBlock = await ensureUiChild(uiStateBlock.repo, uiStateBlock, LAYOUT_SESSIONS_PATH_PART)
    return ensureUiChild(uiStateBlock.repo, layoutSessionsBlock, layoutSessionId)
  },
  (uiBlock, layoutSessionId) => instanceKey(uiBlock.repo, uiBlock.id, layoutSessionId),
)

/** Per-plugin ui-state sub-block under the root ui-state block. The
 *  mirror of `getPluginPrefsBlock` for persistent UI state — e.g.
 *  "what blocks did the user open recently". Writes flow through
 *  `ChangeScope.UiState`: not undoable, but they upload and sync
 *  across devices like any other write. */
export const getPluginUIStateBlock = memoize(
  async (
    repo: Repo,
    workspaceId: string,
    user: User,
    type: TypeContribution,
  ): Promise<Block> => {
    const rootUIStateBlock = await getUIStateBlock(repo, workspaceId, user, {})
    return ensureStateChild(
      repo,
      rootUIStateBlock,
      type.id,
      ChangeScope.UiState,
      {},
      type.label ?? type.id,
      type,
    )
  },
  (repo, workspaceId, user, type) =>
    instanceKey(repo, workspaceId, user.id, 'plugin-ui-state', type.id),
)

/** A per-key child under a plugin's ui-state sub-block, so a plugin can
 *  partition its ui-state (e.g. one frozen review session per deck)
 *  instead of overloading a single block and discriminating by hand.
 *  Inherits the parent's `ChangeScope.UiState` (undo-segregated from
 *  document edits). Mirrors `getLayoutSessionBlock`. */
export const getPluginUIStateChild = memoize(
  async (pluginUIStateBlock: Block, key: string, content?: string): Promise<Block> =>
    ensureUiChild(pluginUIStateBlock.repo, pluginUIStateBlock, key, content),
  // Memo key ignores `content`: the child is identified by `key`, and `content`
  // is a display title set only on first creation (ensureStateChild never
  // rewrites a live row's content), so a later call with a different title still
  // returns the existing block.
  (pluginUIStateBlock, key) =>
    instanceKey(pluginUIStateBlock.repo, pluginUIStateBlock.id, key),
)

// ──── Selection-state helpers (pure operations on a Block) ────

/** Sync selection-state read; doesn't subscribe — for use in
 *  imperative shortcut handlers. Returns the schema default when
 *  nothing's stored. */
export const getSelectionStateSnapshot = (uiStateBlock: Block): BlockSelectionState =>
  uiStateBlock.peekProperty(selectionStateProp) ?? selectionStateProp.defaultValue

export const resetBlockSelection = async (uiStateBlock: Block): Promise<void> => {
  const current = uiStateBlock.peekProperty(selectionStateProp)
  if (!current?.selectedBlockIds.length && !current?.anchorBlockId) return
  await uiStateBlock.set(selectionStateProp, {selectedBlockIds: [], anchorBlockId: null})
}

// ──── Internal: shorthand for instance-scoped memo keys ────
/** Build a memo key scoped to a Repo instance: the repo's `instanceId`
 *  followed by the caller's discriminating parts, ':'-joined. Every
 *  cache below shares this convention (a stale/unscoped key would hand a
 *  `use()` consumer a promise from a disposed repo), so single-sourcing
 *  it here keeps a new cache from silently picking a colliding or
 *  unscoped key. */
const instanceKey = (repo: Repo, ...parts: (string | number)[]): string =>
  [repo.instanceId, ...parts].join(':')
