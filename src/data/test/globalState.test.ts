// @vitest-environment node
/**
 * Non-hook helpers from `src/data/globalState.ts` — the durable
 * domain-side bits of the per-user "user page", user prefs, and per-panel ui-state
 * subtree. The React hooks defined alongside these helpers are NOT
 * tested here (Phase 2 rewrites them on `useHandle` + Suspense), but
 * the resolvers / mutators stay.
 *
 * Coverage:
 *   - getUserBlock: creates a parent-less user page with the user's
 *     display name as content + name/id aliases; deterministic id per
 *     (workspace, user); idempotent (memoized — second call returns
 *     same promise + Block); falls back to user.id when name is
 *     undefined; restores tombstoned user page
 *   - getUserPrefsBlock: ensures the synced user-prefs child
 *   - getUIStateBlock(repo, ws, user, ctx): with panelId → returns
 *     the panel block; without panelId → ensures a 'ui-state' child
 *     of the user page
 *   - getLayoutSessionBlock: ensures ui-state/layout-sessions/{layoutSessionId}
 *   - getSelectionStateSnapshot: returns peekProperty value, defaults
 *     to the schema default when absent
 *   - resetBlockSelection: no-op when already empty, clears when set
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import {
  ChangeScope,
  codecs,
  defineProperty,
  defineSameTxProcessor,
  seedType,
  type TypeContribution,
  type TypeSeedDeclaration,
  type User,
} from '@/data/api'
import { sameTxProcessorsFacet, typeSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { addedTypes } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { Repo } from '../repo'
import { PAGE_TYPE, USER_TYPE } from '@/data/blockTypes'
import {
  aliasesProp,
  selectionStateProp,
  showPropertiesProp,
  typesProp,
  userIdProp,
} from '@/data/properties'
import {
  getLayoutSessionBlock,
  getPluginPrefsBlock,
  getPluginUIStateBlock,
  getSelectionStateSnapshot,
  getUIStateBlock,
  getUserBlock,
  getUserPrefsBlock,
  layoutSessionBlockIdForKey,
  layoutSessionsContainerBlockId,
  resetBlockSelection,
} from '@/data/stateBlocks'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
}

// Builds a harness on the shared, already-reset DB. Called from beforeEach
// AND mid-test (some tests build a second Repo on the SAME data to bypass the
// per-Repo memoize cache), so it must NOT reset — reset lives in beforeEach.
// `h.cleanup` disposes this harness's sync observer without closing the shared
// DB, so every `*.h.cleanup()` call (main or secondary) stays correct.
const setup = async (types: readonly TypeSeedDeclaration[] = []): Promise<Harness> => {
  // Match the Repo production defaults (uuid ids + a per-Repo monotonic
  // tx-seq) rather than the harness's deterministic counters: several tests
  // build a SECOND Repo over the SAME shared db, and shared-deterministic
  // newId/newTxSeq would collide on command_events.tx_id.
  let txSeq = Date.now()
  const { repo } = createTestRepo({
    db: sharedDb.db,
    user: USER,
    newId: uuidv4,
    newTxSeq: () => ++txSeq,
    extensions: types.length > 0 ? [types.map(type => typeSeedsFacet.of(type, {source: 'test'}))] : undefined,
  })
  repo.setActiveWorkspaceId(WS)
  return {h: {db: sharedDb.db, cleanup: async () => { repo.stopSyncObserver() }}, repo}
}

const registerTypes = (repo: Repo, types: readonly TypeSeedDeclaration[]): void => {
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    types.map(type => typeSeedsFacet.of(type, {source: 'test'})),
  ]))
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db); env = await setup() })
afterEach(async () => { await env.h.cleanup() })

describe('getUserBlock', () => {
  it('creates a parent-less user page with content + name/id aliases from user.name', async () => {
    const userBlock = await getUserBlock(env.repo, WS, USER)
    const data = userBlock.peek()

    expect(data?.parentId).toBeNull()
    expect(data?.workspaceId).toBe(WS)
    expect(data?.content).toBe('Alice')
    // Both the display name and the opaque id are aliases so the page is
    // addressable either way (the id is what `updated_by` stores).
    expect(userBlock.peekProperty(aliasesProp)).toEqual(['Alice', 'user-1'])
    // Navigable as a page, plus the USER_TYPE marker carrying the id.
    expect(userBlock.peekProperty(typesProp)).toEqual([PAGE_TYPE, USER_TYPE])
    expect(userBlock.peekProperty(userIdProp)).toBe('user-1')

    const events = await env.h.db.getAll<{scope: string; source: string}>(
      'SELECT scope, source FROM command_events ORDER BY created_at',
    )
    expect(events.at(-1)).toEqual({scope: ChangeScope.UserPrefs, source: 'user'})
  })

  it('uses a deterministic id stable per (workspace, user)', async () => {
    const a = await getUserBlock(env.repo, WS, USER)
    const b = await getUserBlock(env.repo, WS, USER)
    expect(a.id).toBe(b.id)
    expect(a).toBe(b)  // identity-stable Block + memoized promise
  })

  it('falls back to user.id when user.name is undefined', async () => {
    const otherEnv = await setup()
    try {
      const noNameUser: User = {id: 'user-no-name'}
      const block = await getUserBlock(otherEnv.repo, WS, noNameUser)
      expect(block.peek()?.content).toBe('user-no-name')
      expect(block.peekProperty(aliasesProp)).toEqual(['user-no-name'])
      expect(block.peekProperty(userIdProp)).toBe('user-no-name')
    } finally {
      await otherEnv.h.cleanup()
    }
  })

  it('restores a tombstoned user page', async () => {
    const block = await getUserBlock(env.repo, WS, USER)
    await env.repo.tx(tx => tx.delete(block.id), {scope: ChangeScope.UserPrefs})

    // Re-resolve via a fresh Repo so we bypass the lodash.memoize
    // cached promise (which would short-circuit and never enter the
    // restore branch). New Repo instance = new memoize key.
    const fresh = await setup()
    try {
      const restored = await getUserBlock(fresh.repo, WS, USER)
      expect(restored.id).toBe(block.id)
      // Pull current data from SQL via the fresh repo's cache.
      await fresh.repo.load(restored.id)
      expect(restored.peek()?.deleted).toBe(false)
      expect(restored.peekProperty(aliasesProp)).toEqual(['Alice', 'user-1'])
      expect(restored.peekProperty(typesProp)).toEqual([PAGE_TYPE, USER_TYPE])
      expect(restored.peekProperty(userIdProp)).toBe('user-1')
    } finally {
      await fresh.h.cleanup()
    }
  })
})

describe('getUserPrefsBlock', () => {
  it('ensures the "Preferences" child under the user page', async () => {
    const userBlock = await getUserBlock(env.repo, WS, USER)
    const prefs = await getUserPrefsBlock(env.repo, WS, USER)

    expect(prefs.peek()?.parentId).toBe(userBlock.id)
    expect(prefs.peek()?.content).toBe('Preferences')
    // No type marker on the root Preferences container — it's just a
    // structural parent for per-plugin prefs sub-blocks.
    expect(prefs.peekProperty(typesProp)).toBeUndefined()

    const events = await env.h.db.getAll<{scope: string; source: string; workspace_id: string | null}>(
      'SELECT scope, source, workspace_id FROM command_events ORDER BY created_at',
    )
    expect(events.at(-1)).toEqual({scope: ChangeScope.UserPrefs, source: 'user', workspace_id: WS})
  })

  it('still bootstraps the prefs block in read-only repos (writes queue normally)', async () => {
    // Phase 2: read-only UserPrefs writes are no longer downgraded to a
    // non-uploading source. They tag source='user' and enter ps_crud
    // like any other write; the server's RLS rejection then lands in
    // ps_crud_rejected, which the status surface exposes.
    const h = await createTestDb()
    let txSeq = Date.now()
    const { repo } = createTestRepo({
      db: h.db,
      user: USER,
      isReadOnly: true,
      newId: uuidv4,
      newTxSeq: () => ++txSeq,
    })
    repo.setActiveWorkspaceId(WS)

    try {
      const prefs = await getUserPrefsBlock(repo, WS, USER)
      expect(prefs.peek()?.content).toBe('Preferences')

      const events = await h.db.getAll<{scope: string; source: string}>(
        'SELECT scope, source FROM command_events ORDER BY created_at',
      )
      expect(events.every(event => event.scope === ChangeScope.UserPrefs)).toBe(true)
      expect(events.every(event => event.source === 'user')).toBe(true)
      const crud = await h.db.getAll<{id: number}>('SELECT id FROM ps_crud')
      expect(crud.length).toBeGreaterThan(0)
    } finally {
      await h.cleanup()
    }
  })
})

describe('getPluginPrefsBlock', () => {
  const examplePrefsType = seedType({
    seedKey: 'test/type/example-plugin-prefs',
    revision: 1,
    id: 'example-plugin-prefs',
    label: 'Example plugin prefs',
  })

  it('ensures a sub-block under user-prefs keyed by the type id, titled by the label', async () => {
    registerTypes(env.repo, [examplePrefsType])
    const userPrefs = await getUserPrefsBlock(env.repo, WS, USER)
    const pluginPrefs = await getPluginPrefsBlock(env.repo, WS, USER, examplePrefsType)

    expect(pluginPrefs.peek()?.parentId).toBe(userPrefs.id)
    expect(pluginPrefs.peek()?.content).toBe('Example plugin prefs')
    expect(pluginPrefs.peekProperty(typesProp)).toEqual(['example-plugin-prefs'])
  })

  it('shows the property panel by default when creating plugin prefs blocks', async () => {
    registerTypes(env.repo, [examplePrefsType])

    const pluginPrefs = await getPluginPrefsBlock(env.repo, WS, USER, examplePrefsType)

    expect(pluginPrefs.peekProperty(showPropertiesProp)).toBe(true)
  })

  it('falls back to the type id when the contribution omits a label', async () => {
    // Deliberately a plain, unregistered TypeContribution (not a seedType — a
    // seed always carries a non-empty label): getPluginPrefsBlock/ensureStateChild
    // build their own ad hoc registry snapshot for a type not yet known to the
    // facet system (`snapshotIncludingType`), so this needs no facet registration.
    const unlabeled: TypeContribution = {id: 'unlabeled-plugin-prefs'}
    const otherEnv = await setup()
    try {
      const block = await getPluginPrefsBlock(otherEnv.repo, WS, USER, unlabeled)
      expect(block.peek()?.content).toBe('unlabeled-plugin-prefs')
    } finally {
      await otherEnv.h.cleanup()
    }
  })

  it('is idempotent — same type resolves to the same block', async () => {
    registerTypes(env.repo, [examplePrefsType])
    const a = await getPluginPrefsBlock(env.repo, WS, USER, examplePrefsType)
    const b = await getPluginPrefsBlock(env.repo, WS, USER, examplePrefsType)
    expect(a).toBe(b)
  })

  it('isolates distinct plugin prefs into distinct sub-blocks', async () => {
    const otherType = seedType({seedKey: 'test/type/other-plugin-prefs', revision: 1, id: 'other-plugin-prefs', label: 'Other plugin prefs'})
    registerTypes(env.repo, [examplePrefsType, otherType])
    const a = await getPluginPrefsBlock(env.repo, WS, USER, examplePrefsType)
    const b = await getPluginPrefsBlock(env.repo, WS, USER, otherType)

    expect(a.id).not.toBe(b.id)
    expect(a.peek()?.parentId).toBe(b.peek()?.parentId)
    expect(a.peekProperty(typesProp)).toEqual(['example-plugin-prefs'])
    expect(b.peekProperty(typesProp)).toEqual(['other-plugin-prefs'])
  })

  it('routes its bootstrap write through ChangeScope.UserPrefs', async () => {
    registerTypes(env.repo, [examplePrefsType])
    await getPluginPrefsBlock(env.repo, WS, USER, examplePrefsType)
    const events = await env.h.db.getAll<{scope: string; source: string; workspace_id: string | null}>(
      'SELECT scope, source, workspace_id FROM command_events ORDER BY created_at',
    )
    expect(events.at(-1)).toEqual({scope: ChangeScope.UserPrefs, source: 'user', workspace_id: WS})
  })

  it('runs a registered type-add same-tx processor when bootstrapping a plugin prefs block', async () => {
    const setupRanProp = defineProperty<boolean>('example-plugin-prefs:setup-ran', {
      codec: codecs.boolean,
      defaultValue: false,
      changeScope: ChangeScope.UserPrefs,
    })
    const setupType = seedType({
      seedKey: 'test/type/setup-plugin-prefs',
      revision: 1,
      id: 'setup-plugin-prefs',
      label: 'Setup plugin prefs',
      properties: [setupRanProp],
    })
    const setupProcessor = defineSameTxProcessor({
      name: 'test.setupPluginPrefs',
      watches: {kind: 'field', table: 'blocks', fields: ['properties']},
      apply: async (event, ctx) => {
        for (const row of event.changedRows) {
          if (!addedTypes(row).includes('setup-plugin-prefs')) continue
          await ctx.tx.setProperty(row.id, setupRanProp, true)
        }
      },
    })
    env.repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      typeSeedsFacet.of(setupType, {source: 'test'}),
      sameTxProcessorsFacet.of(setupProcessor, {source: 'test'}),
    ]))

    const pluginPrefs = await getPluginPrefsBlock(env.repo, WS, USER, setupType)

    expect(pluginPrefs.peekProperty(typesProp)).toEqual(['setup-plugin-prefs'])
    expect(pluginPrefs.peekProperty(setupRanProp)).toBe(true)
  })
})

describe('getPluginUIStateBlock', () => {
  const exampleUIStateType = seedType({
    seedKey: 'test/type/example-plugin-ui-state',
    revision: 1,
    id: 'example-plugin-ui-state',
    label: 'Example plugin state',
  })

  it('ensures a sub-block under root ui-state titled by the label', async () => {
    registerTypes(env.repo, [exampleUIStateType])
    const rootUI = await getUIStateBlock(env.repo, WS, USER, {})
    const pluginUI = await getPluginUIStateBlock(env.repo, WS, USER, exampleUIStateType)

    expect(pluginUI.peek()?.parentId).toBe(rootUI.id)
    expect(pluginUI.peek()?.content).toBe('Example plugin state')
    expect(pluginUI.peekProperty(typesProp)).toEqual(['example-plugin-ui-state'])
  })

  it('is idempotent — same type resolves to the same block', async () => {
    registerTypes(env.repo, [exampleUIStateType])
    const a = await getPluginUIStateBlock(env.repo, WS, USER, exampleUIStateType)
    const b = await getPluginUIStateBlock(env.repo, WS, USER, exampleUIStateType)
    expect(a).toBe(b)
  })

  it('routes its bootstrap write through ChangeScope.UiState and uploads', async () => {
    // Phase 2: UI-state writes now upload too. The scope identity still
    // distinguishes them (undo bucketing, requireSchemaScope), but the
    // upload routing no longer special-cases them.
    registerTypes(env.repo, [exampleUIStateType])
    const pluginUI = await getPluginUIStateBlock(env.repo, WS, USER, exampleUIStateType)
    const events = await env.h.db.getAll<{scope: string; source: string}>(
      'SELECT scope, source FROM command_events ORDER BY created_at',
    )
    expect(events.at(-1)).toEqual({scope: ChangeScope.UiState, source: 'user'})
    const crudForBlock = await env.h.db.getAll<{id: string}>(
      "SELECT id FROM ps_crud WHERE data LIKE '%' || ? || '%'",
      [pluginUI.id],
    )
    expect(crudForBlock.length).toBeGreaterThan(0)
  })
})

describe('getUIStateBlock', () => {
  it('with panelId: returns the panel block directly', async () => {
    // Pre-create a "panel block" the test can hand to the resolver.
    const PANEL_ID = 'panel-1'
    await env.repo.tx(tx => tx.create({
      id: PANEL_ID,
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      content: 'main',
    }), {scope: ChangeScope.BlockDefault})

    const block = await getUIStateBlock(env.repo, WS, USER, {panelId: PANEL_ID})
    expect(block.id).toBe(PANEL_ID)
  })

  it('without panelId: ensures a ui-state child of the user page', async () => {
    const userBlock = await getUserBlock(env.repo, WS, USER)
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})

    expect(uiState.peek()?.parentId).toBe(userBlock.id)
    expect(uiState.peek()?.content).toBe('ui-state')

    const events = await env.h.db.getAll<{scope: string; source: string; workspace_id: string | null}>(
      'SELECT scope, source, workspace_id FROM command_events ORDER BY created_at',
    )
    expect(events.at(-1)).toEqual({scope: ChangeScope.UiState, source: 'user', workspace_id: WS})
  })

  it('without panelId: idempotent — second call returns the same Block', async () => {
    const a = await getUIStateBlock(env.repo, WS, USER, {})
    const b = await getUIStateBlock(env.repo, WS, USER, {})
    expect(a).toBe(b)
  })
})

describe('getLayoutSessionBlock', () => {
  it('ensures a layout-session-specific child under ui-state/layout-sessions', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    const layoutSession = await getLayoutSessionBlock(uiState, 'layout-session-a')

    expect(layoutSession.peek()?.content).toBe('layout-session-a')

    const layoutSessionsParent = layoutSession.parent
    expect(layoutSessionsParent?.peek()?.parentId).toBe(uiState.id)
    expect(layoutSessionsParent?.peek()?.content).toBe('layout-sessions')
  })

  it('is idempotent for the same layoutSessionId', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    const a = await getLayoutSessionBlock(uiState, 'layout-session-a')
    const b = await getLayoutSessionBlock(uiState, 'layout-session-a')
    expect(a).toBe(b)
  })

  it('keeps different layoutSessionIds in independent layout session blocks', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    const a = await getLayoutSessionBlock(uiState, 'layout-session-a')
    const b = await getLayoutSessionBlock(uiState, 'layout-session-b')

    expect(a.id).not.toBe(b.id)
    expect(a.peek()?.parentId).toBe(b.peek()?.parentId)
    expect(a.peek()?.content).toBe('layout-session-a')
    expect(b.peek()?.content).toBe('layout-session-b')
  })

  it('materializes EXACTLY the block id the pure derivations predict (LayoutSessionHost mapping pin)', async () => {
    // The keep-alive host never materializes: it derives each warm session's
    // block id synchronously via layoutSessionBlockIdForKey and mounts that.
    // This pins the derivation against the materializer — if either side's
    // uuidv5 chain changes without the other, the host would render
    // nonexistent blocks under the opt-in.
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    const session = await getLayoutSessionBlock(uiState, 'layout-session-a')

    expect(session.id).toBe(layoutSessionBlockIdForKey(WS, USER.id, 'layout-session-a'))
    // …and the container half of the chain agrees too (canRender's id).
    expect(session.peek()?.parentId).toBe(layoutSessionsContainerBlockId(WS, USER.id))
    // The session KEY is not itself a block id — the domains genuinely differ.
    expect(session.id).not.toBe('layout-session-a')
  })
})

describe('getSelectionStateSnapshot', () => {
  it('returns the schema default when no selection is stored', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    expect(getSelectionStateSnapshot(uiState)).toEqual(selectionStateProp.defaultValue)
  })

  it('returns the stored selection state when present', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    await uiState.set(selectionStateProp, {
      selectedBlockIds: ['a', 'b'],
      anchorBlockId: 'a',
    })
    expect(getSelectionStateSnapshot(uiState)).toEqual({
      selectedBlockIds: ['a', 'b'],
      anchorBlockId: 'a',
    })
  })
})

describe('resetBlockSelection', () => {
  it('is a no-op when selection is already empty', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    const before = uiState.peekProperty(selectionStateProp)

    await resetBlockSelection(uiState)
    const after = uiState.peekProperty(selectionStateProp)
    expect(after).toEqual(before)
  })

  it('clears non-empty selection (selected ids + anchor)', async () => {
    const uiState = await getUIStateBlock(env.repo, WS, USER, {})
    await uiState.set(selectionStateProp, {
      selectedBlockIds: ['a', 'b'],
      anchorBlockId: 'a',
    })

    await resetBlockSelection(uiState)
    expect(uiState.peekProperty(selectionStateProp)).toEqual({
      selectedBlockIds: [],
      anchorBlockId: null,
    })
  })
})
