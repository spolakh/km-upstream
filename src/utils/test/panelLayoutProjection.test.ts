// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/** One-shot hook into the liveness read `pruneDeadTop` performs, so a test can
 *  interleave a navigation at exactly that await instead of racing timers.
 *  Null unless a test installs it; consumed on first match. */
const livenessHook = vi.hoisted(() => ({
  onCheck: null as null | ((blockId: string) => Promise<void>),
}))
vi.mock('@/data/blockLiveness', async importOriginal => {
  const actual = await importOriginal<typeof import('@/data/blockLiveness')>()
  return {
    ...actual,
    isBlockTombstoned: async (repo: Parameters<typeof actual.isBlockTombstoned>[0], id: string) => {
      const hook = livenessHook.onCheck
      if (hook) {
        livenessHook.onCheck = null
        await hook(id)
      }
      return actual.isBlockTombstoned(repo, id)
    },
  }
})
import { ChangeScope, type BlockData, type User } from '@/data/api'
import type { Block } from '@/data/block'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { keysBetween } from '@/data/orderKey'
import {
  activePanelIdProp,
  focusedBlockLocationProp,
  panelViewModeProp,
  scrollTopProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { buildLayoutFromSlots } from '@/utils/routing'
import { panelRenderScopeId } from '@/utils/renderScope'
import {
  PanelLayoutProjection,
  activatePanelRow,
  applyCurrentLayoutUrl,
  createPanelRowInTx,
  createPanelStackRowInTx,
  deletePanelRow,
  insertPanelRow,
  layoutBlockIdsFromRows,
  layoutSlotsFromRows,
  panelBlockIds,
  panelBlockId,
  panelRowsInLayoutOrder,
  reconcilePanelRows,
  retargetPanelBlockIds,
} from '@/utils/panelLayoutProjection'
import {
  __resetConfirmedDeletedForTesting,
  goBackInPanel,
  goForwardInPanel,
  navigateInPanel,
  panelHistory,
  recoverPanelOffDeadContent,
} from '@/utils/panelHistory'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
  layoutSessionBlockId: string
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: USER,
  })
  repo.setActiveWorkspaceId(WS)
  const uiState = await getUIStateBlock(repo, WS, USER, {})
  const layoutSessionBlock = await getLayoutSessionBlock(uiState, 'layout-session-a')
  return {h, repo, layoutSessionBlockId: layoutSessionBlock.id}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  env = await setup()
  __resetConfirmedDeletedForTesting()
  livenessHook.onCheck = null
})

const layoutSessionBlock = () => env.repo.block(env.layoutSessionBlockId)

/** Create real content rows for `ids`. Panel history holds blocks the pane
 *  actually displayed, and back/forward now skip entries whose block is gone,
 *  so any test that exercises the chevrons needs its ids to exist. */
const seedBlocks = async (ids: readonly string[]): Promise<void> => {
  await env.repo.tx(async tx => {
    const orderKeys = keysBetween(null, null, ids.length)
    for (let i = 0; i < ids.length; i++) {
      await tx.create({
        id: ids[i], workspaceId: WS, parentId: null, orderKey: orderKeys[i], content: ids[i],
      })
    }
  }, {scope: ChangeScope.BlockDefault, description: 'seed content blocks'})
}

const createPanelRows = async (blockIds: readonly string[]): Promise<void> => {
  const parent = layoutSessionBlock()
  await env.repo.tx(async tx => {
    const parentData = await tx.get(parent.id)
    if (!parentData) throw new Error('missing layout session block')
    const orderKeys = keysBetween(null, null, blockIds.length)
    for (let index = 0; index < blockIds.length; index++) {
      await createPanelRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: parent.id,
        orderKey: orderKeys[index],
        blockId: blockIds[index],
      })
    }
  }, {scope: ChangeScope.UiState, description: 'seed panel rows'})
}

const rows = async () => layoutSessionBlock().children.load()
const layoutRows = async () => env.repo.query.subtree({id: env.layoutSessionBlockId}).load()

const startProjection = (initialHash: string) => {
  let currentHash = initialHash
  const pushes: string[] = []
  const replaces: string[] = []
  const projection = new PanelLayoutProjection({
    repo: env.repo,
    workspaceId: WS,
    layoutSessionBlock: layoutSessionBlock(),
    getHash: () => currentHash,
    pushHash: hash => {
      pushes.push(hash)
      currentHash = hash
    },
    replaceHash: hash => {
      replaces.push(hash)
      currentHash = hash
    },
    subscribeToUrl: () => () => {},
  })
  return {
    projection,
    pushes,
    replaces,
    hash: () => currentHash,
    setHash: (hash: string) => { currentHash = hash },
  }
}

// Deterministic interleaving needs direct delivery of a rows event —
// real subscription timing is not controllable from a test.
const deliverRowsEvent = (projection: PanelLayoutProjection, rows: readonly BlockData[]) => {
  (projection as unknown as {handleRowsChanged(rows: readonly BlockData[]): void}).handleRowsChanged(rows)
}

const applyUrl = (hash: string, replaceHash?: (hash: string) => void) => applyCurrentLayoutUrl({
  repo: env.repo,
  workspaceId: WS,
  layoutSessionBlock: layoutSessionBlock(),
  hash,
  replaceHash,
})

const rowFor = async (blockId: string) => {
  const rowId = (await rowIdsByBlock()).get(blockId)
  if (!rowId) throw new Error(`missing ${blockId} row`)
  return rowId
}

const rowIdsByBlock = async (): Promise<Map<string, string>> =>
  new Map((await layoutRows())
    .map(row => [panelBlockId(row), row.id] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[0])))

describe('applyCurrentLayoutUrl', () => {
  it('creates panel rows for an explicit layout URL', async () => {
    const result = await applyUrl('#ws-1/a/b')

    expect(result.kind).toBe('applied')
    expect(panelBlockIds(await rows())).toEqual(['a', 'b'])
  })

  it('creates a sidebar stack for stack layout URLs', async () => {
    const result = await applyUrl('#ws-1/a/x,b/c')

    expect(result.kind).toBe('applied')
    const treeRows = await layoutRows()
    expect(layoutBlockIdsFromRows(env.layoutSessionBlockId, treeRows)).toEqual(['a', 'x', 'b', 'c'])
    expect(layoutSlotsFromRows(env.layoutSessionBlockId, treeRows)).toEqual([
      {kind: 'leaf', blockId: 'a'},
      {
        kind: 'stack',
        children: [
          {kind: 'leaf', blockId: 'x'},
          {kind: 'leaf', blockId: 'b'},
        ],
      },
      {kind: 'leaf', blockId: 'c'},
    ])
  })

  it('accepts a persp-bearing hash for the SAME workspace (clean-id compare, not the garbage token)', async () => {
    // Pre-fix, `#ws-1;persp=lane/a` parsed to workspaceId `ws-1;persp=lane`,
    // mismatching `ws-1` → kind 'ignored' → the URL never applied (and the
    // App-level layoutWorkspaceChanged spuriously full-remounted).
    const result = await applyUrl('#ws-1;persp=lane/a')
    expect(result.kind).toBe('applied')
    expect(panelBlockIds(await rows())).toEqual(['a'])
  })

  it('still ignores a hash whose CLEAN workspace id differs, persp or not', async () => {
    expect((await applyUrl('#ws-2;persp=lane/a')).kind).toBe('ignored')
    expect(panelBlockIds(await rows())).toEqual([])
  })

  it('preserves the ws-context when normalizing an empty-target hash against live rows', async () => {
    await createPanelRows(['a'])
    const replaces: string[] = []
    const result = await applyUrl('#ws-1;persp=lane', hash => replaces.push(hash))
    expect(result.kind).toBe('normalized')
    expect(replaces).toEqual(['#ws-1;persp=lane/a'])
  })

  it('preserves the ws-context through inbound canonicalization (sublayout degrade)', async () => {
    const replaces: string[] = []
    const result = await applyUrl('#ws-1;persp=lane/(a/b)', hash => replaces.push(hash))
    expect(result.kind).toBe('normalized')
    expect(replaces).toEqual(['#ws-1;persp=lane/a,b'])
  })

  it('repairs active panel when URL reconciliation deletes the active row', async () => {
    await applyUrl('#ws-1/a/b/c')
    const beforeByBlock = await rowIdsByBlock()
    const rowB = beforeByBlock.get('b')
    if (!rowB) throw new Error('missing panel row b')
    await layoutSessionBlock().set(activePanelIdProp, rowB)

    await applyUrl('#ws-1/a/c')

    const afterRows = await layoutRows()
    const activePanelId = layoutSessionBlock().peekProperty(activePanelIdProp)
    const activeRow = afterRows.find(row => row.id === activePanelId)
    expect(activeRow ? panelBlockId(activeRow) : undefined).toBe('c')
    expect(activePanelId).not.toBe(rowB)
  })

  it('clears stale active panel when the URL already matches the layout', async () => {
    await applyUrl('#ws-1/a/c')
    await layoutSessionBlock().set(activePanelIdProp, 'deleted-panel-b')

    const result = await applyUrl('#ws-1/a/c')

    expect(result.kind).toBe('noop')
    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBeUndefined()
  })

  it('inserts in the middle while preserving surviving row ids', async () => {
    await createPanelRows(['a', 'c'])
    const before = await rowIdsByBlock()

    await applyUrl('#ws-1/a/b/c')

    const afterRows = await rows()
    const after = await rowIdsByBlock()
    expect(panelBlockIds(afterRows)).toEqual(['a', 'b', 'c'])
    expect(after.get('a')).toBe(before.get('a'))
    expect(after.get('c')).toBe(before.get('c'))
    expect(after.get('b')).toBeTruthy()
  })

  it('reuses the changed slot and reconciles panel-local history on URL back', async () => {
    await createPanelRows(['a', 'b'])
    const before = await rowIdsByBlock()
    const rowB = before.get('b')
    if (!rowB) throw new Error('missing b row')

    panelHistory.push(rowB, {
      blockId: 'x',
      state: {
        focusedLocation: {blockId: 'x-child', renderScopeId: panelRenderScopeId(rowB, 'x')},
        scrollTop: 42,
      },
    })

    await applyUrl('#ws-1/a/x')

    const after = await rowIdsByBlock()
    expect(after.get('x')).toBe(rowB)
    expect(env.repo.block(rowB).peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'x-child',
      renderScopeId: panelRenderScopeId(rowB, 'x'),
    })
    expect(panelHistory.consumeRestore(rowB)).toEqual({
      focusedLocation: {blockId: 'x-child', renderScopeId: panelRenderScopeId(rowB, 'x')},
      scrollTop: 42,
    })
    expect(panelHistory.getSnapshot(rowB).forward.map(entry => entry.blockId)).toEqual(['b'])
  })

  it('preserves row ids when the URL reorders existing panels', async () => {
    await createPanelRows(['a', 'b', 'c'])
    const before = await rowIdsByBlock()

    await applyUrl('#ws-1/c/a/b')

    const after = await rowIdsByBlock()
    expect(panelBlockIds(await rows())).toEqual(['c', 'a', 'b'])
    expect(after.get('a')).toBe(before.get('a'))
    expect(after.get('b')).toBe(before.get('b'))
    expect(after.get('c')).toBe(before.get('c'))
  })

  it('normalizes a bare workspace URL to existing layout session rows without writing rows', async () => {
    await createPanelRows(['a', 'b'])
    let replaced = ''

    const result = await applyUrl('#ws-1', hash => { replaced = hash })

    expect(result.kind).toBe('normalized')
    expect(replaced).toBe('#ws-1/a/b')
    expect(panelBlockIds(await rows())).toEqual(['a', 'b'])
  })

  it('preserves hash query params when normalizing a bare workspace URL', async () => {
    await createPanelRows(['a', 'b'])
    let replaced = ''

    const result = await applyUrl('#ws-1?agent-runtime-secret=secret&agent-runtime-open-tokens=1', hash => { replaced = hash })

    expect(result.kind).toBe('normalized')
    expect(replaced).toBe('#ws-1/a/b?agent-runtime-secret=secret&agent-runtime-open-tokens=1')
    expect(panelBlockIds(await rows())).toEqual(['a', 'b'])
  })

  it('degrades a URL-borne sublayout column to a stack and normalizes the hash', async () => {
    let replaced = ''
    const result = await applyUrl('#ws-1/(a/b)/c', hash => { replaced = hash })

    expect(result.kind).toBe('normalized')
    expect(replaced).toBe('#ws-1/a,b/c')
    const treeRows = await layoutRows()
    expect(layoutSlotsFromRows(env.layoutSessionBlockId, treeRows)).toEqual([
      {
        kind: 'stack',
        children: [
          {kind: 'leaf', blockId: 'a'},
          {kind: 'leaf', blockId: 'b'},
        ],
      },
      {kind: 'leaf', blockId: 'c'},
    ])
  })

  it('degrades a single-leaf sublayout column to a plain leaf', async () => {
    let replaced = ''
    const result = await applyUrl('#ws-1/(a)/c', hash => { replaced = hash })

    expect(result.kind).toBe('normalized')
    expect(replaced).toBe('#ws-1/a/c')
    expect(panelBlockIds(await rows())).toEqual(['a', 'c'])
  })

  it('ignores URLs for another workspace', async () => {
    const result = await applyUrl('#other/a')

    expect(result.kind).toBe('ignored')
    expect(panelBlockIds(await rows())).toEqual([])
  })
})

describe('reconcilePanelRows failure safety', () => {
  it('keeps panel history for rows whose delete is rolled back by a mid-tx throw', async () => {
    await createPanelRows(['a', 'b'])
    const rowB = (await rowIdsByBlock()).get('b')
    if (!rowB) throw new Error('missing b row')
    panelHistory.push(rowB, {
      blockId: 'prev',
      state: {scrollTop: 7},
    })

    // A sublayout slot reaching reconcilePanelRows directly is an internal
    // error (the URL boundary degrades them) — it throws mid-tx AFTER the
    // delete of row b was staged. The tx rolls back; row b's in-memory
    // history must survive with it.
    await expect(reconcilePanelRows(env.repo, layoutSessionBlock(), [
      {kind: 'sublayout', columns: [{kind: 'leaf', blockId: 'x'}]},
    ])).rejects.toThrow()

    expect(panelBlockIds(await rows())).toEqual(['a', 'b'])
    expect(panelHistory.getSnapshot(rowB).back.map(entry => entry.blockId)).toEqual(['prev'])
  })
})

describe('panel history clears run after the tx commits', () => {
  // Pin the ORDER by making clear itself throw: if clear ran before (or
  // inside) the tx, the row write would never commit; committed rows +
  // a rejected call prove clear happened strictly after the commit.
  it('deletePanelRow: the row is already deleted when clear runs', async () => {
    await createPanelRows(['a', 'b'])
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    const clearSpy = vi.spyOn(panelHistory, 'clear').mockImplementation(() => {
      throw new Error('boom: clear after commit probe')
    })
    try {
      await expect(deletePanelRow(env.repo, rowA)).rejects.toThrow('clear after commit probe')
      expect(clearSpy).toHaveBeenCalledWith(rowA)
    } finally {
      clearSpy.mockRestore()
    }
    expect(panelBlockIds(await rows())).toEqual(['b']) // delete committed before clear ran
  })

  it('reconcilePanelRows: deletes are already committed when clear runs', async () => {
    await createPanelRows(['a', 'b'])
    const clearSpy = vi.spyOn(panelHistory, 'clear').mockImplementation(() => {
      throw new Error('boom: clear after commit probe')
    })
    try {
      await expect(reconcilePanelRows(env.repo, layoutSessionBlock(), ['a']))
        .rejects.toThrow('clear after commit probe')
    } finally {
      clearSpy.mockRestore()
    }
    expect(panelBlockIds(await rows())).toEqual(['a']) // reconcile committed before clear ran
  })
})

describe('layoutSlotsFromRows normalization', () => {
  const seedStack = async (childBlockIds: readonly string[]): Promise<string> => {
    const parent = layoutSessionBlock()
    let stackId = ''
    await env.repo.tx(async tx => {
      const parentData = await tx.get(parent.id)
      if (!parentData) throw new Error('missing layout session block')
      const [keyLeaf, keyStack] = keysBetween(null, null, 2)
      await createPanelRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: parent.id,
        orderKey: keyLeaf,
        blockId: 'a',
      })
      stackId = await createPanelStackRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: parent.id,
        orderKey: keyStack,
      })
      const childKeys = keysBetween(null, null, Math.max(childBlockIds.length, 1))
      for (let index = 0; index < childBlockIds.length; index++) {
        await createPanelRowInTx(env.repo, tx, {
          workspaceId: parentData.workspaceId,
          parentId: stackId,
          orderKey: childKeys[index],
          blockId: childBlockIds[index],
        })
      }
    }, {scope: ChangeScope.UiState, description: 'seed stack rows'})
    return stackId
  }

  it('collapses a singleton stack to its leaf', async () => {
    await seedStack(['x'])
    expect(layoutSlotsFromRows(env.layoutSessionBlockId, await layoutRows())).toEqual([
      {kind: 'leaf', blockId: 'a'},
      {kind: 'leaf', blockId: 'x'},
    ])
  })

  it('drops an empty stack entirely', async () => {
    await seedStack([])
    expect(layoutSlotsFromRows(env.layoutSessionBlockId, await layoutRows())).toEqual([
      {kind: 'leaf', blockId: 'a'},
    ])
  })

  it('makes a reload round with a singleton stack a noop that keeps all row ids', async () => {
    const stackId = await seedStack(['x'])
    const rowsBefore = await layoutRows()
    const idsBefore = rowsBefore.map(row => row.id).sort()
    expect(idsBefore).toContain(stackId)

    // '#ws-1/a/x' is what buildLayoutFromSlots emits for the collapsed slots
    const result = await applyUrl('#ws-1/a/x')

    expect(result.kind).toBe('noop')
    const idsAfter = (await layoutRows()).map(row => row.id).sort()
    expect(idsAfter).toEqual(idsBefore) // the stack row silently survives
  })
})

describe('slot context on panel rows', () => {
  const seedContext = async (viewModeRowId: string, activeRowId: string) => {
    await env.repo.tx(async tx => {
      await tx.setProperty(viewModeRowId, panelViewModeProp, 'video-notes')
      await tx.setProperty(env.layoutSessionBlockId, activePanelIdProp, activeRowId)
    }, {scope: ChangeScope.UiState, description: 'seed slot context'})
  }

  it('layoutSlotsFromRows emits viewMode and active from the row/session props', async () => {
    await createPanelRows(['a', 'b'])
    const byBlock = await rowIdsByBlock()
    await seedContext(byBlock.get('a')!, byBlock.get('b')!)

    const slots = layoutSlotsFromRows(env.layoutSessionBlockId, await layoutRows())
    expect(slots).toEqual([
      {kind: 'leaf', blockId: 'a', viewMode: 'video-notes'},
      {kind: 'leaf', blockId: 'b', active: true},
    ])
    // Single slots→hash integration checkpoint (encoding itself is pinned
    // in the routing tests).
    expect(buildLayoutFromSlots(WS, slots)).toBe('#ws-1/a;view=video-notes/b;active')
  })

  it('inbound ;view sets panelViewMode on the SAME row; inbound without it clears', async () => {
    await applyUrl('#ws-1/a/b')
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')

    await applyUrl('#ws-1/a;view=m/b')
    expect((await rowIdsByBlock()).get('a')).toBe(rowA)
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('m')

    await applyUrl('#ws-1/a/b')
    expect((await rowIdsByBlock()).get('a')).toBe(rowA)
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBeUndefined()
  })

  it('an unknown mode value round-trips opaquely through the prop', async () => {
    await applyUrl('#ws-1/a;view=some%20unknown%2Fmode')
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('some unknown/mode')
  })

  it('inbound ;active coerces activePanelIdProp to that slot row', async () => {
    await applyUrl('#ws-1/a/b;active')
    const byBlock = await rowIdsByBlock()
    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(byBlock.get('b'))
  })

  it('inbound with two ;active — first wins', async () => {
    await applyUrl('#ws-1/a;active/b;active')
    const byBlock = await rowIdsByBlock()
    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(byBlock.get('a'))
  })

  it('inbound without ;active leaves activePanelIdProp untouched', async () => {
    await applyUrl('#ws-1/a/b')
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    await layoutSessionBlock().set(activePanelIdProp, rowA)

    await applyUrl('#ws-1/a;view=m/b') // real diff (mode), but no active entry
    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(rowA)
  })

  it('an empty-string viewMode prop reads as absent', async () => {
    await createPanelRows(['a'])
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    await env.repo.tx(async tx => {
      await tx.setProperty(rowA, panelViewModeProp, '')
    }, {scope: ChangeScope.UiState, description: 'write empty mode'})

    expect(layoutSlotsFromRows(env.layoutSessionBlockId, await layoutRows())).toEqual([
      {kind: 'leaf', blockId: 'a'},
    ])
  })

  it('a mode-only inbound diff updates the prop in place: row id, focus, scroll untouched', async () => {
    await applyUrl('#ws-1/a/b')
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    const focusedLocation = {blockId: 'a-child', renderScopeId: panelRenderScopeId(rowA, 'a')}
    await env.repo.tx(async tx => {
      await tx.setProperty(rowA, focusedBlockLocationProp, focusedLocation)
      await tx.setProperty(rowA, scrollTopProp, 42)
    }, {scope: ChangeScope.UiState, description: 'seed panel state'})

    await applyUrl('#ws-1/a;view=m/b')

    expect((await rowIdsByBlock()).get('a')).toBe(rowA)
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('m')
    expect(env.repo.block(rowA).peekProperty(focusedBlockLocationProp)).toEqual(focusedLocation)
    expect(env.repo.block(rowA).peekProperty(scrollTopProp)).toBe(42)
  })
})

describe('per-pane render scopes', () => {
  it('two panes showing the SAME block get distinct per-pane focus scopes', async () => {
    await applyUrl('#ws-1/same/same')

    const panelRows = panelRowsInLayoutOrder(env.layoutSessionBlockId, await layoutRows())
    expect(panelRows.map(row => panelBlockId(row))).toEqual(['same', 'same'])
    const [first, second] = panelRows
    const firstLocation = env.repo.block(first.id).peekProperty(focusedBlockLocationProp)
    const secondLocation = env.repo.block(second.id).peekProperty(focusedBlockLocationProp)

    expect(firstLocation?.renderScopeId).toBe(panelRenderScopeId(first.id, 'same'))
    expect(secondLocation?.renderScopeId).toBe(panelRenderScopeId(second.id, 'same'))
    expect(firstLocation?.renderScopeId).not.toBe(secondLocation?.renderScopeId)
  })

  it('in-panel navigation writes the per-pane scope', async () => {
    await applyUrl('#ws-1/a')
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')

    await navigateInPanel(env.repo.block(rowA), 'b')
    panelHistory.clear(rowA) // before assertions: generated row ids repeat across tests

    expect(env.repo.block(rowA).peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'b',
      renderScopeId: panelRenderScopeId(rowA, 'b'),
    })
  })
})

describe('view-mode navigation semantics', () => {
  const panelBlock = (rowId: string) => env.repo.block(rowId)
  // Mirrors PanelRenderer's snapshotter: capture the live mode at push time.
  const registerLiveSnapshotter = (rowId: string) =>
    panelHistory.registerSnapshotter(rowId, () => ({
      viewMode: env.repo.block(rowId).peekProperty(panelViewModeProp),
      scrollTop: 7,
    }))

  // Pushing a replacement on top of a dead entry traps the user: browser Back
  // lands on the dead page, the watcher retargets and pushes again, and the
  // dead entry can never be stepped past. But "dead" has to mean *known*
  // deleted — a row that merely hasn't replicated is a valid deep link.
  describe('leaving an entry that shows a deleted block', () => {
    it('REPLACES when the block is a cached tombstone', async () => {
      await seedBlocks(['a', 'b'])
      await applyUrl('#ws-1/a')
      const rowA = await rowFor('a')
      const {projection, pushes, replaces} = startProjection('#ws-1/a')
      await projection.start()

      await env.repo.block('a').delete()
      await navigateInPanel(panelBlock(rowA), 'b')

      await vi.waitFor(() => expect(replaces).toEqual(['#ws-1/b']))
      expect(pushes).toEqual([])
      panelHistory.clear(rowA)
      projection.dispose()
    })

    it('REPLACES after recovery confirmed the delete, even once the tombstone is gone', async () => {
      // The real sequence: PanelContentRecovery loads the dead block before
      // retargeting, and `repo.load` markMissing's it — which DELETES the
      // cached tombstone. Recovery records the confirmed delete so the
      // projection can still tell; without that this guard was inert on the
      // exact path it exists for.
      await seedBlocks(['a', 'b', 'landing'])
      await applyUrl('#ws-1/a')
      const rowA = await rowFor('a')
      const panel = env.repo.block(rowA)
      panelHistory.clear(rowA)
      const {projection, pushes, replaces} = startProjection('#ws-1/a')
      await projection.start()

      await env.repo.block('a').delete()
      await env.repo.block('a').load() // wipes the tombstone, leaves a missing marker
      await recoverPanelOffDeadContent(panel, 'a', async () => 'landing')

      // Recovery's own retarget is the write that must not push — that's the
      // entry the user would otherwise be sent back to.
      await vi.waitFor(() => expect(replaces).toEqual(['#ws-1/landing']))
      expect(pushes).toEqual([])
      panelHistory.clear(rowA)
      projection.dispose()
    })

    it('PUSHES for a block that is merely missing locally — it may still be syncing', async () => {
      // A valid shared-link target that hasn't replicated yet is confirmed-
      // missing in cache, exactly like a delete. Treating that as dead would
      // replace the deep link's history entry, so Back could never return to it
      // once the row arrived.
      await seedBlocks(['b'])
      await applyUrl('#ws-1/not-yet-synced')
      const row = await rowFor('not-yet-synced')
      await env.repo.block('not-yet-synced').load() // records the missing marker
      const {projection, pushes, replaces} = startProjection('#ws-1/not-yet-synced')
      await projection.start()

      await navigateInPanel(panelBlock(row), 'b')

      await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/b']))
      expect(replaces).toEqual([])
      panelHistory.clear(row)
      projection.dispose()
    })

    it('REPLACES when the same dead block is in two panes and only one recovers', async () => {
      // Panes recover independently (each debounced separately), so this is the
      // routine multi-pane sequence, not an exotic one. Comparing block-id SETS
      // saw 'dup' still present in the new layout and concluded nothing was
      // left — pushing a history entry where pane 2 still renders a tombstone.
      await seedBlocks(['dup', 'landing'])
      await applyUrl('#ws-1/dup/dup')
      const rowA = (await rows())[0]
      const {projection, pushes, replaces} = startProjection('#ws-1/dup/dup')
      await projection.start()

      await env.repo.block('dup').delete()
      await navigateInPanel(env.repo.block(rowA.id), 'landing')

      await vi.waitFor(() => expect(replaces).toEqual(['#ws-1/landing/dup']))
      expect(pushes).toEqual([])
      panelHistory.clear(rowA.id)
      projection.dispose()
    })

    it('PUSHES when the dead block is in a pane we are NOT leaving', async () => {
      // Scoped to the panes actually being navigated away from. Scanning the
      // whole layout meant one pane stuck on a tombstone downgraded EVERY
      // navigation in EVERY pane to a replace for the rest of the session.
      await seedBlocks(['a', 'b', 'stuck'])
      await applyUrl('#ws-1/a/stuck')
      const rowA = (await rowIdsByBlock()).get('a')!
      const {projection, pushes, replaces} = startProjection('#ws-1/a/stuck')
      await projection.start()

      await env.repo.block('stuck').delete() // pane 2 is stranded
      await navigateInPanel(panelBlock(rowA), 'b') // pane 1 navigates normally

      await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/b/stuck']))
      expect(replaces).toEqual([])
      panelHistory.clear(rowA)
      projection.dispose()
    })

    it('PUSHES when closing a pane shifts a stranded pane down an index', async () => {
      // Same shape as above, but the navigation is a pane CLOSE. Comparing the
      // two layouts leaf-by-INDEX made every leaf after the closed pane read as
      // "left" — so the stranded pane's tombstone was attributed to a
      // navigation that never touched it, and Back skipped the whole layout.
      await seedBlocks(['a', 'stuck'])
      await applyUrl('#ws-1/a/stuck')
      const rowA = (await rowIdsByBlock()).get('a')!
      const {projection, pushes, replaces} = startProjection('#ws-1/a/stuck')
      await projection.start()

      await env.repo.block('stuck').delete() // pane 2 is stranded
      await deletePanelRow(env.repo, rowA) // pane 1 closes; 'stuck' shifts 1 → 0

      await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/stuck']))
      expect(replaces).toEqual([])
      projection.dispose()
    })
  })

  it('navigateInPanel with viewMode: one viewModeEnter-stamped entry, ONE push carrying both changes', async () => {
    await applyUrl('#ws-1/a')
    const rowA = await rowFor('a')
    const {projection, pushes, replaces} = startProjection('#ws-1/a')
    await projection.start()

    await navigateInPanel(panelBlock(rowA), 'video-block', {viewMode: 'video-notes'})

    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/video-block;view=video-notes']))
    expect(replaces).toEqual([])
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('video-notes')
    expect(panelHistory.getSnapshot(rowA).back).toEqual([
      {blockId: 'a', viewModeEnter: 'video-notes'},
    ])
    panelHistory.clear(rowA)
    projection.dispose()
  })

  it('plain navigateInPanel away from a moded pane clears the mode: ONE push without ;view, no viewModeEnter', async () => {
    await applyUrl('#ws-1/a;view=m')
    const rowA = await rowFor('a')
    const {projection, pushes, replaces} = startProjection('#ws-1/a;view=m')
    await projection.start()

    await navigateInPanel(panelBlock(rowA), 'b')

    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/b']))
    expect(replaces).toEqual([])
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBeUndefined()
    // strict: the entry must not even carry a viewModeEnter KEY
    expect(panelHistory.getSnapshot(rowA).back).toStrictEqual([
      {blockId: 'a', state: undefined},
    ])
    panelHistory.clear(rowA)
    projection.dispose()
  })

  it('same-block enter: mode-only tx, ONE push with ;view, no history entry', async () => {
    await applyUrl('#ws-1/a')
    const rowA = await rowFor('a')
    const {projection, pushes, replaces} = startProjection('#ws-1/a')
    await projection.start()

    await navigateInPanel(panelBlock(rowA), 'a', {viewMode: 'm'})

    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/a;view=m']))
    expect(replaces).toEqual([])
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('m')
    expect(env.repo.block(rowA).peekProperty(topLevelBlockIdProp)).toBe('a')
    // not a navigation: no entry, no viewModeEnter stamp anywhere
    expect(panelHistory.getSnapshot(rowA)).toStrictEqual({back: [], forward: []})
    projection.dispose()
  })

  it('same-block re-enter with the same mode is a true no-op (no push)', async () => {
    await applyUrl('#ws-1/a;view=m')
    const rowA = await rowFor('a')
    const {projection, pushes, replaces} = startProjection('#ws-1/a;view=m')
    await projection.start()

    await navigateInPanel(panelBlock(rowA), 'a', {viewMode: 'm'})

    // fence: a real change must still push, and it must be the ONLY push
    await navigateInPanel(panelBlock(rowA), 'b')
    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/b']))
    expect(replaces).toEqual([])
    panelHistory.clear(rowA)
    projection.dispose()
  })

  it('same-block plain navigate preserves the mode; explicit undefined clears it', async () => {
    await applyUrl('#ws-1/a;view=m')
    const rowA = await rowFor('a')
    const {projection, pushes} = startProjection('#ws-1/a;view=m')
    await projection.start()

    // Plain re-navigation to the open block (zoom-in, re-click) is a pure
    // no-op: the mode belongs to the (pane, block) pair and neither changed.
    await navigateInPanel(panelBlock(rowA), 'a')
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('m')
    expect(pushes).toEqual([])

    // The explicit clear-only form (slice-5 close) removes the mode without
    // a panelHistory entry; the browser-level entry comes from the push.
    await navigateInPanel(panelBlock(rowA), 'a', {viewMode: undefined})
    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/a']))
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBeUndefined()
    expect(panelHistory.getSnapshot(rowA)).toStrictEqual({back: [], forward: []})
    projection.dispose()
  })

  it('chevron forward across the enter boundary re-applies the mode', async () => {
    await seedBlocks(['plain', 'video'])
    await applyUrl('#ws-1/plain')
    const row = await rowFor('plain')
    const unregister = registerLiveSnapshotter(row)

    await navigateInPanel(panelBlock(row), 'video', {viewMode: 'm'}) // enter
    await goBackInPanel(panelBlock(row))
    expect(env.repo.block(row).peekProperty(topLevelBlockIdProp)).toBe('plain')
    expect(env.repo.block(row).peekProperty(panelViewModeProp)).toBeUndefined()

    await goForwardInPanel(panelBlock(row))
    expect(env.repo.block(row).peekProperty(topLevelBlockIdProp)).toBe('video')
    expect(env.repo.block(row).peekProperty(panelViewModeProp)).toBe('m')
    // the enter marker survived the round trip (back-stack top re-stamped)
    expect(panelHistory.getSnapshot(row).back.at(-1)?.viewModeEnter).toBe('m')

    unregister()
    panelHistory.clear(row)
  })

  it('one URL applies a blockId+mode change to pane 1 and a mode-only change to pane 2', async () => {
    await applyUrl('#ws-1/a/b')
    const byBlock = await rowIdsByBlock()
    const rowA = byBlock.get('a')
    const rowB = byBlock.get('b')
    if (!rowA || !rowB) throw new Error('missing rows')

    await applyUrl('#ws-1/x;view=k/b;view=m')

    expect((await rowIdsByBlock()).get('x')).toBe(rowA) // reused across the content swap
    expect(env.repo.block(rowA).peekProperty(panelViewModeProp)).toBe('k')
    expect(env.repo.block(rowB).peekProperty(panelViewModeProp)).toBe('m')
  })

  it('chevron back restores the moded visit, forward re-clears — one push per step', async () => {
    await seedBlocks(['plain', 'video'])
    await applyUrl('#ws-1/video;view=m')
    const row = await rowFor('video')
    const unregister = registerLiveSnapshotter(row)
    const {projection, pushes} = startProjection('#ws-1/video;view=m')
    await projection.start()

    await navigateInPanel(panelBlock(row), 'plain')
    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/plain']))
    expect(env.repo.block(row).peekProperty(panelViewModeProp)).toBeUndefined()

    await goBackInPanel(panelBlock(row))
    expect(env.repo.block(row).peekProperty(topLevelBlockIdProp)).toBe('video')
    expect(env.repo.block(row).peekProperty(panelViewModeProp)).toBe('m')
    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/plain', '#ws-1/video;view=m']))

    await goForwardInPanel(panelBlock(row))
    expect(env.repo.block(row).peekProperty(topLevelBlockIdProp)).toBe('plain')
    expect(env.repo.block(row).peekProperty(panelViewModeProp)).toBeUndefined()
    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/plain', '#ws-1/video;view=m', '#ws-1/plain']))

    unregister()
    panelHistory.clear(row)
    projection.dispose()
  })

  it('URL-driven back ignores a conflicting VisitState viewMode — the hash is authoritative', async () => {
    await applyUrl('#ws-1/video;view=m')
    const row = await rowFor('video')
    const unregister = registerLiveSnapshotter(row)
    await navigateInPanel(panelBlock(row), 'plain')
    // history now holds {video, state:{viewMode:'m'}} — but the browser-Back
    // hash carries NO mode, and the URL wins over the remembered VisitState.
    await applyUrl('#ws-1/video')

    expect(env.repo.block(row).peekProperty(topLevelBlockIdProp)).toBe('video')
    expect(env.repo.block(row).peekProperty(panelViewModeProp)).toBeUndefined()
    // reconciled as a back-step, not a fresh visit:
    expect(panelHistory.getSnapshot(row).forward.map(entry => entry.blockId)).toEqual(['plain'])

    unregister()
    panelHistory.clear(row)
  })
})

describe('context-only inbound diffs take the targeted pass', () => {
  const rowShapes = async () =>
    (await layoutRows()).map(row => ({id: row.id, parentId: row.parentId, orderKey: row.orderKey}))

  it('inbound without ;active over a stacked layout: all rows untouched, one replace adds ;active', async () => {
    await applyUrl('#ws-1/a/b,c')
    const byBlock = await rowIdsByBlock()
    await layoutSessionBlock().set(activePanelIdProp, byBlock.get('b')!)
    const before = await rowShapes()

    let replaced = ''
    const result = await applyUrl('#ws-1/a/b,c', h => { replaced = h })

    expect(result.kind).toBe('normalized')
    expect(replaced).toBe('#ws-1/a/b;active,c')
    expect(await rowShapes()).toEqual(before) // ids, parents, order keys — stack row intact
  })

  it('flat layout, inbound without ;active: no moves, one replace', async () => {
    await applyUrl('#ws-1/a/b')
    const byBlock = await rowIdsByBlock()
    await layoutSessionBlock().set(activePanelIdProp, byBlock.get('b')!)
    const before = await rowShapes()

    let replaced = ''
    const result = await applyUrl('#ws-1/a/b', h => { replaced = h })

    expect(result.kind).toBe('normalized')
    expect(replaced).toBe('#ws-1/a/b;active')
    expect(await rowShapes()).toEqual(before)
  })

  it('inbound ;active coerces onto the REUSED row when topology matches', async () => {
    await applyUrl('#ws-1/a/b')
    const byBlock = await rowIdsByBlock()
    await layoutSessionBlock().set(activePanelIdProp, byBlock.get('a')!)

    await applyUrl('#ws-1/a/b;active')

    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(byBlock.get('b'))
    expect((await rowIdsByBlock()).get('b')).toBe(byBlock.get('b')) // reused, not recreated
  })

  it('URL-active wins outright over repair when the old active row is deleted', async () => {
    await applyUrl('#ws-1/a/b/c')
    const byBlock = await rowIdsByBlock()
    await layoutSessionBlock().set(activePanelIdProp, byBlock.get('b')!)

    await applyUrl('#ws-1/a;active/c') // deletes b; repair would remap b→c, the URL says a

    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(byBlock.get('a'))
  })
})

describe('retargetPanelBlockIds', () => {
  it('retargets every panel currently showing the merged source block', async () => {
    await applyUrl('#ws-1/source/other,source')

    const beforeRows = await layoutRows()
    const sourceRows = beforeRows.filter(row => panelBlockId(row) === 'source')
    expect(sourceRows).toHaveLength(2)

    await retargetPanelBlockIds(env.repo, layoutSessionBlock(), 'source', 'target')

    const afterRows = await layoutRows()
    expect(layoutBlockIdsFromRows(env.layoutSessionBlockId, afterRows)).toEqual([
      'target',
      'other',
      'target',
    ])
    expect(layoutSlotsFromRows(env.layoutSessionBlockId, afterRows)).toEqual([
      {kind: 'leaf', blockId: 'target'},
      {
        kind: 'stack',
        children: [
          {kind: 'leaf', blockId: 'other'},
          {kind: 'leaf', blockId: 'target'},
        ],
      },
    ])
    for (const row of sourceRows) {
      expect(env.repo.block(row.id).peekProperty(focusedBlockLocationProp)).toEqual({
        blockId: 'target',
        renderScopeId: panelRenderScopeId(row.id, 'target'),
      })
      expect(env.repo.block(row.id).peekProperty(scrollTopProp)).toBe(0)
    }
  })

  it('uses panel-history restore state when the target is adjacent in history', async () => {
    await createPanelRows(['source'])
    const [row] = await rows()
    panelHistory.push(row.id, {
      blockId: 'target',
      state: {
        focusedLocation: {
          blockId: 'target-child',
          renderScopeId: panelRenderScopeId(row.id, 'target'),
        },
        scrollTop: 42,
      },
    })

    await retargetPanelBlockIds(env.repo, layoutSessionBlock(), 'source', 'target')

    expect(env.repo.block(row.id).peekProperty(topLevelBlockIdProp)).toBe('target')
    expect(env.repo.block(row.id).peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'target-child',
      renderScopeId: panelRenderScopeId(row.id, 'target'),
    })
    expect(env.repo.block(row.id).peekProperty(scrollTopProp)).toBe(42)
    expect(panelHistory.consumeRestore(row.id)).toEqual({
      focusedLocation: {
        blockId: 'target-child',
        renderScopeId: panelRenderScopeId(row.id, 'target'),
      },
      scrollTop: 42,
    })
    expect(panelHistory.getSnapshot(row.id).forward.map(entry => entry.blockId)).toEqual(['source'])
  })
})

describe('insertPanelRow', () => {
  it('inserts after a panel tied with its next sibling without throwing (#198)', async () => {
    // Two panels share an order_key ('a1'); a third sits after at 'a2'. Inserting
    // after the first tied panel used keyBetween(equal, equal), which threw
    // "<key> >= <key>" and rolled back the insert. Precise placement opens a slot
    // between the tied pair instead (re-keying the second panel).
    const parent = layoutSessionBlock()
    await env.repo.tx(async tx => {
      await createPanelRowInTx(env.repo, tx, {workspaceId: WS, parentId: parent.id, orderKey: 'a1', blockId: 'b1'})
      await createPanelRowInTx(env.repo, tx, {workspaceId: WS, parentId: parent.id, orderKey: 'a1', blockId: 'b2'})
      await createPanelRowInTx(env.repo, tx, {workspaceId: WS, parentId: parent.id, orderKey: 'a2', blockId: 'b3'})
    }, {scope: ChangeScope.UiState, description: 'seed tied panels'})

    // The two tied panels render first (by id tiebreak); pick whichever sorts
    // first so its NEXT sibling is the tied one — that's the equal-bounds case.
    const seeded = (await rows()).map(row => row.id)
    const newId = await insertPanelRow(env.repo, parent, 'b4', {afterPanelId: seeded[0]})

    // Lands EXACTLY after the source panel — between the two tied panels
    // (re-keys the second), not past the whole run. Nothing rolled back.
    expect((await rows()).map(row => row.id)).toEqual([seeded[0], newId, seeded[1], seeded[2]])
  })
})

describe('deletePanelRow', () => {
  it('activates the next sibling in a stack when closing the active stacked panel', async () => {
    await applyUrl('#ws-1/a/x,b,y/c')
    const byBlock = await rowIdsByBlock()
    const rowB = byBlock.get('b')
    const rowY = byBlock.get('y')
    if (!rowB || !rowY) throw new Error('missing stacked rows')

    await layoutSessionBlock().set(activePanelIdProp, rowB)
    await deletePanelRow(env.repo, rowB)

    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(rowY)
    expect(layoutBlockIdsFromRows(env.layoutSessionBlockId, await layoutRows())).toEqual([
      'a',
      'x',
      'y',
      'c',
    ])
  })

  it('falls back to the previous sibling before leaving the stack', async () => {
    await applyUrl('#ws-1/a/x,b,y/c')
    const byBlock = await rowIdsByBlock()
    const rowB = byBlock.get('b')
    const rowY = byBlock.get('y')
    if (!rowB || !rowY) throw new Error('missing stacked rows')

    await layoutSessionBlock().set(activePanelIdProp, rowY)
    await deletePanelRow(env.repo, rowY)

    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(rowB)
    expect(layoutBlockIdsFromRows(env.layoutSessionBlockId, await layoutRows())).toEqual([
      'a',
      'x',
      'b',
      'c',
    ])
  })

  it('keeps climbing out of nested stacks to find the next panel', async () => {
    // A stack nested inside a stack can no longer be expressed via a URL hash
    // under the comma grammar (stacks don't nest directly — see routing.ts);
    // seed the row structure directly to exercise deletePanelRow's climb-out
    // behavior through two stack levels.
    const parent = layoutSessionBlock()
    await env.repo.tx(async tx => {
      const parentData = await tx.get(parent.id)
      if (!parentData) throw new Error('missing layout session block')
      const [keyA, keyOuter, keyC] = keysBetween(null, null, 3)
      await createPanelRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: parent.id,
        orderKey: keyA,
        blockId: 'a',
      })
      const outerStackId = await createPanelStackRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: parent.id,
        orderKey: keyOuter,
      })
      const [innerKey] = keysBetween(null, null, 1)
      const innerStackId = await createPanelStackRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: outerStackId,
        orderKey: innerKey,
      })
      const [leafKey] = keysBetween(null, null, 1)
      await createPanelRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: innerStackId,
        orderKey: leafKey,
        blockId: 'b',
      })
      await createPanelRowInTx(env.repo, tx, {
        workspaceId: parentData.workspaceId,
        parentId: parent.id,
        orderKey: keyC,
        blockId: 'c',
      })
    }, {scope: ChangeScope.UiState, description: 'seed nested stack rows'})

    const byBlock = await rowIdsByBlock()
    const rowB = byBlock.get('b')
    if (!rowB) throw new Error('missing nested stack row')

    await layoutSessionBlock().set(activePanelIdProp, rowB)
    await deletePanelRow(env.repo, rowB)

    const afterRows = await layoutRows()
    const activePanelId = layoutSessionBlock().peekProperty(activePanelIdProp)
    const activeRow = afterRows.find(row => row.id === activePanelId)
    expect(activeRow ? panelBlockId(activeRow) : undefined).toBe('c')
    expect(layoutBlockIdsFromRows(env.layoutSessionBlockId, afterRows)).toEqual([
      'a',
      'c',
    ])
  })
})

describe('activatePanelRow', () => {
  it('ignores activation for deleted panel rows', async () => {
    await applyUrl('#ws-1/a/b')
    const byBlock = await rowIdsByBlock()
    const rowA = byBlock.get('a')
    const rowB = byBlock.get('b')
    if (!rowA || !rowB) throw new Error('missing panel rows')
    await layoutSessionBlock().set(activePanelIdProp, rowA)
    await env.repo.tx(tx => tx.delete(rowB), {
      scope: ChangeScope.UiState,
      description: 'delete panel row for activation guard',
    })

    await activatePanelRow(env.repo, env.layoutSessionBlockId, rowB)

    expect(layoutSessionBlock().peekProperty(activePanelIdProp)).toBe(rowA)
  })

  it('rejects already-active rows moved out of the layout session', async () => {
    await applyUrl('#ws-1/a/b')
    const byBlock = await rowIdsByBlock()
    const rowB = byBlock.get('b')
    if (!rowB) throw new Error('missing panel row b')
    await layoutSessionBlock().set(activePanelIdProp, rowB)
    await env.repo.tx(tx => tx.move(rowB, {parentId: null, orderKey: 'z0'}), {
      scope: ChangeScope.UiState,
      description: 'move panel row out of layout session',
    })

    await expect(activatePanelRow(env.repo, env.layoutSessionBlockId, rowB))
      .resolves.toBe(false)
  })
})

describe('PanelLayoutProjection', () => {
  it('pushes a URL when subscribed panel rows change', async () => {
    await createPanelRows(['a'])
    let currentHash = '#ws-1/a'
    let pushed = ''
    let notified = 0
    const projection = new PanelLayoutProjection({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      getHash: () => currentHash,
      pushHash: hash => {
        pushed = hash
        currentHash = hash
      },
      replaceHash: hash => { currentHash = hash },
      subscribeToUrl: () => () => {},
    })
    const unsubscribe = projection.subscribe(() => { notified += 1 })
    await projection.start()

    const [row] = await rows()
    await env.repo.tx(async tx => {
      await tx.setProperty(row.id, topLevelBlockIdProp, 'b')
    }, {scope: ChangeScope.UiState, description: 'navigate panel'})

    await vi.waitFor(() => expect(pushed).toBe('#ws-1/b'))
    expect(notified).toBeGreaterThan(0)
    unsubscribe()
    projection.dispose()
  })

  it('outbound pushes PRESERVE the current hash ws-context (persp lane attribution)', async () => {
    // Ws-context has no row representation, so a hash rebuilt from rows must
    // re-attach the current hash's entries — otherwise every row change would
    // strip `;persp=` from the history entry being pushed and Back would lose
    // its lane attribution.
    await createPanelRows(['a'])
    const {projection, pushes} = startProjection('#ws-1;persp=lane/a')
    await projection.start()

    const [row] = await rows()
    await env.repo.tx(async tx => {
      await tx.setProperty(row.id, topLevelBlockIdProp, 'b')
    }, {scope: ChangeScope.UiState, description: 'navigate panel'})

    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1;persp=lane/b']))
    projection.dispose()
  })

  it('pushes a stack URL when nested panel rows change', async () => {
    await applyUrl('#ws-1/a/x,b')
    let currentHash = '#ws-1/a/x,b'
    let pushed = ''
    const projection = new PanelLayoutProjection({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      getHash: () => currentHash,
      pushHash: hash => {
        pushed = hash
        currentHash = hash
      },
      replaceHash: hash => { currentHash = hash },
      subscribeToUrl: () => () => {},
    })
    await projection.start()

    const rowB = (await rowIdsByBlock()).get('b')
    if (!rowB) throw new Error('missing b row')
    await env.repo.tx(async tx => {
      await tx.setProperty(rowB, topLevelBlockIdProp, 'y')
    }, {scope: ChangeScope.UiState, description: 'navigate nested panel'})

    await vi.waitFor(() => expect(pushed).toBe('#ws-1/a/x,y'))
    projection.dispose()
  })

  // Await the rows event on OUR OWN subscription to the same handle: the
  // projection subscribed first, so once we observe the intermediate rows
  // state the projection's handler has seen it too.
  const observeRows = () => {
    const seen: string[][] = []
    const unsubscribe = env.repo.query.subtree({id: env.layoutSessionBlockId}).subscribe(rows => {
      seen.push(layoutBlockIdsFromRows(env.layoutSessionBlockId, rows))
    })
    return {
      waitFor: (ids: readonly string[]) => vi.waitFor(() => {
        expect(seen.some(entry => entry.join('/') === ids.join('/'))).toBe(true)
      }),
      unsubscribe,
    }
  }

  const navigatePanel = async (panelRowId: string, blockId: string) => {
    await env.repo.tx(async tx => {
      await tx.setProperty(panelRowId, topLevelBlockIdProp, blockId)
    }, {scope: ChangeScope.UiState, description: 'navigate panel'})
  }

  it('URL slot context round-trips through rows and the echo stays quiescent', async () => {
    // Slice-2 semantics: `;view=m` is no longer merely PRESERVED in the
    // hash — inbound it lands on the panel row, so the rows event that
    // follows carries the same context and the echo guard sees equality.
    await createPanelRows(['a'])
    const {projection, pushes, replaces, hash} = startProjection('#ws-1/b;view=m')
    await projection.start()
    const observer = observeRows()

    await projection.applyCurrentUrl() // inbound: row reused a→b, prop set
    const rowB = (await rowIdsByBlock()).get('b')
    if (!rowB) throw new Error('missing b row')
    expect(env.repo.block(rowB).peekProperty(panelViewModeProp)).toBe('m')

    await observer.waitFor(['b']) // the reconcile's rows event was delivered
    expect(pushes).toEqual([])
    expect(replaces).toEqual([])
    expect(hash()).toBe('#ws-1/b;view=m') // context retained via rows, not merely skipped

    // Fence: a REAL layout change must push. (Whether viewMode survives
    // in-panel navigation is slice-3's semantic — only pin the block id.)
    await navigatePanel(rowB, 'c')
    await vi.waitFor(() => expect(pushes.length).toBe(1))
    expect(pushes[0]).toMatch(/^#ws-1\/c/)
    observer.unsubscribe()
    projection.dispose()
  })

  it('an active-only diff replaces the hash exactly once and stabilizes', async () => {
    await applyUrl('#ws-1/a/b')
    const rowB = (await rowIdsByBlock()).get('b')
    if (!rowB) throw new Error('missing b row')
    const {projection, pushes, replaces} = startProjection('#ws-1/a/b')
    await projection.start()

    await env.repo.tx(async tx => {
      await tx.setProperty(env.layoutSessionBlockId, activePanelIdProp, rowB)
    }, {scope: ChangeScope.UiState, description: 'activate pane b'})

    await vi.waitFor(() => expect(replaces).toEqual(['#ws-1/a/b;active']))
    expect(pushes).toEqual([])

    // Full-cycle stabilization: inbound the corrected hash is a noop —
    // no row writes, no further outbound replaces/pushes.
    await projection.applyCurrentUrl()
    expect(replaces).toEqual(['#ws-1/a/b;active'])
    expect(pushes).toEqual([])
    projection.dispose()
  })

  it('a viewMode change pushes (history entry by design)', async () => {
    await applyUrl('#ws-1/a/b')
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    const {projection, pushes, replaces} = startProjection('#ws-1/a/b')
    await projection.start()

    await env.repo.tx(async tx => {
      await tx.setProperty(rowA, panelViewModeProp, 'm')
    }, {scope: ChangeScope.UiState, description: 'switch view mode'})

    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/a;view=m/b']))
    expect(replaces).toEqual([])
    projection.dispose()
  })

  it('a combined active+viewMode change pushes', async () => {
    await applyUrl('#ws-1/a/b')
    const byBlock = await rowIdsByBlock()
    const rowA = byBlock.get('a')
    const rowB = byBlock.get('b')
    if (!rowA || !rowB) throw new Error('missing rows')
    const {projection, pushes, replaces} = startProjection('#ws-1/a/b')
    await projection.start()

    await env.repo.tx(async tx => {
      await tx.setProperty(rowA, panelViewModeProp, 'm')
      await tx.setProperty(env.layoutSessionBlockId, activePanelIdProp, rowB)
    }, {scope: ChangeScope.UiState, description: 'switch mode and activate'})

    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/a;view=m/b;active']))
    expect(replaces).toEqual([])
    projection.dispose()
  })

  it('pushes exactly once for a real layout change under a context-bearing hash', async () => {
    await createPanelRows(['a'])
    const {projection, pushes} = startProjection('#ws-1/a;view=m')
    await projection.start()
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')

    await navigatePanel(rowA, 'b')
    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/b']))
    projection.dispose()
  })

  it('does not double-push when the hash carries query params and rows echo the layout', async () => {
    await createPanelRows(['a'])
    const {projection, pushes} = startProjection('#ws-1/b?agent-runtime-secret=s')
    await projection.start()
    const observer = observeRows()
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')

    await navigatePanel(rowA, 'b') // echoes the hash's route despite the ?param
    await observer.waitFor(['b'])
    expect(pushes).toEqual([])

    await navigatePanel(rowA, 'c') // fence
    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/c']))
    observer.unsubscribe()
    projection.dispose()
  })

  it('outbound writes preserve rest entries from the current hash', async () => {
    await applyUrl('#ws-1/a/b')
    const rowB = (await rowIdsByBlock()).get('b')
    if (!rowB) throw new Error('missing b row')
    const {projection, pushes, replaces} = startProjection('#ws-1/a;foo=1/b')
    await projection.start()

    await env.repo.tx(async tx => {
      await tx.setProperty(env.layoutSessionBlockId, activePanelIdProp, rowB)
    }, {scope: ChangeScope.UiState, description: 'activate pane b'})

    await vi.waitFor(() => expect(replaces).toEqual(['#ws-1/a;foo=1/b;active']))
    expect(pushes).toEqual([])
    projection.dispose()
  })

  it('suppresses outbound writes while an inbound apply is pending (Back is not clobbered)', async () => {
    await createPanelRows(['a'])
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    const {projection, pushes, replaces, hash, setHash} = startProjection('#ws-1/a')
    await projection.start()

    // A pane-activation rows event exists but hasn't reached the projection.
    // Synthesize it (no DB write — keeps the interleaving deterministic).
    const staleRows = (await layoutRows()).map(row => row.id === env.layoutSessionBlockId
      ? {...row, properties: {...row.properties, [activePanelIdProp.name]: activePanelIdProp.codec.encode(rowA)}}
      : row)

    setHash('#ws-1/b') // Back landed on b
    const pending = projection.applyCurrentUrl()
    deliverRowsEvent(projection, staleRows) // the stale event arrives mid-flight

    // Without suppression this replaces/pushes '#ws-1/a;active', clobbering
    // the Back target before its reconcile runs.
    expect(pushes).toEqual([])
    expect(replaces).toEqual([])

    await pending
    expect(pushes).toEqual([])
    expect(replaces).toEqual([])
    expect(hash()).toBe('#ws-1/b') // Back target survived…
    expect(panelBlockIds(await rows())).toEqual(['b']) // …and was applied

    // Outbound still lives after the drain (the suppression is not sticky).
    await navigatePanel(rowA, 'c')
    await vi.waitFor(() => expect(pushes.length).toBe(1))
    expect(pushes[0]).toMatch(/^#ws-1\/c/)
    projection.dispose()
  })

  it('a divergence suppressed during a SECOND inbound (queued mid-drain) still projects', async () => {
    // The lost-divergence interleaving: inbound A's deferred drain awaits its
    // subtree load; while it is held, a live rows event bumps the outbound
    // generation, inbound B queues, and a suppressed divergence re-sets the
    // flag. A's drain must NOT clear the flag then (B's own drain owns it) —
    // clearing loses the divergence until some unrelated later rows event.
    await createPanelRows(['a'])
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')

    // Facade over the layout-session block whose subtree loads can be held.
    const real = layoutSessionBlock()
    let loadCalls = 0
    let holdAt = Number.POSITIVE_INFINITY
    let heldResolve: (() => void) | undefined
    const held = new Promise<void>(resolve => { heldResolve = resolve })
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseGate = resolve })
    const facade = {
      id: real.id,
      repo: {
        query: {
          subtree: (args: {id: string}) => {
            const handle = env.repo.query.subtree(args)
            return {
              load: async () => {
                loadCalls++
                if (loadCalls === holdAt) {
                  heldResolve?.()
                  await gate
                }
                return handle.load()
              },
              subscribe: (listener: (rows: readonly BlockData[]) => void) => handle.subscribe(listener),
            }
          },
        },
      },
    } as unknown as Block

    let currentHash = '#ws-1/a'
    const pushes: string[] = []
    const projection = new PanelLayoutProjection({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: facade,
      getHash: () => currentHash,
      pushHash: hash => {
        pushes.push(hash)
        currentHash = hash
      },
      replaceHash: hash => { currentHash = hash },
      subscribeToUrl: () => () => {},
    })
    await projection.start()
    const preNavigateRows = await layoutRows()

    // Inbound A (noop apply: hash matches rows): 1 apply load, then the
    // drain load — hold the drain load (call #2 from here).
    holdAt = loadCalls + 2
    const inboundA = projection.applyCurrentUrl()
    deliverRowsEvent(projection, preNavigateRows) // pending>0 → suppressed
    await held // A is now inside its drain, load held

    // Live event while nothing is pending: bumps the outbound generation.
    deliverRowsEvent(projection, preNavigateRows)
    // Inbound B queues (foreign hash → applies nothing, holds the queue)…
    currentHash = '#other-ws/z'
    const inboundB = projection.applyCurrentUrl()
    // …and a REAL divergence commits; its events land suppressed (pending>0).
    await navigatePanel(rowA, 'c')

    releaseGate?.()
    await inboundA
    await inboundB

    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/c']))
    projection.dispose()
  })

  it('a rows divergence during a pending inbound still projects after the drain', async () => {
    await createPanelRows(['a'])
    const rowA = (await rowIdsByBlock()).get('a')
    if (!rowA) throw new Error('missing a row')
    const {projection, pushes, setHash} = startProjection('#ws-1/a')
    await projection.start()

    // Inbound for a foreign-workspace hash applies nothing but holds the
    // queue; the concurrent navigate's rows event lands either during the
    // pending window (suppressed → deferred flush) or after it (normal
    // outbound) — both must end in exactly one push of the diverged layout.
    setHash('#other-ws/z')
    const pending = projection.applyCurrentUrl()
    await navigatePanel(rowA, 'c')
    await pending

    await vi.waitFor(() => expect(pushes).toEqual(['#ws-1/c']))
    projection.dispose()
  })

  it('applies a sublayout hash arriving via the URL subscription without rejecting', async () => {
    await createPanelRows(['a'])
    let currentHash = '#ws-1/a'
    let listener: (() => void) | null = null
    const projection = new PanelLayoutProjection({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      getHash: () => currentHash,
      pushHash: hash => { currentHash = hash },
      replaceHash: hash => { currentHash = hash },
      subscribeToUrl: l => {
        listener = l
        return () => {}
      },
    })
    await projection.start()

    currentHash = '#ws-1/(x/y)'
    listener!() // must not produce an unhandled rejection

    await vi.waitFor(async () => {
      expect(layoutBlockIdsFromRows(env.layoutSessionBlockId, await layoutRows())).toEqual(['x', 'y'])
    })
    await vi.waitFor(() => expect(currentHash).toBe('#ws-1/x,y'))
    projection.dispose()
  })

  it('notifies subscribers when the URL moves to another workspace', async () => {
    await createPanelRows(['a'])
    let currentHash = '#other/a'
    let notified = 0
    const projection = new PanelLayoutProjection({
      repo: env.repo,
      workspaceId: WS,
      layoutSessionBlock: layoutSessionBlock(),
      getHash: () => currentHash,
      pushHash: hash => { currentHash = hash },
      replaceHash: hash => { currentHash = hash },
      subscribeToUrl: () => () => {},
    })
    const unsubscribe = projection.subscribe(() => { notified += 1 })
    await projection.start()

    await projection.applyCurrentUrl()

    expect(notified).toBe(1)
    unsubscribe()
    projection.dispose()
  })

  // usePanelLayoutProjection now calls applyCurrentUrl() once after start()
  // (pushState fires neither hashchange nor popstate, so a projection
  // constructed after boot — the session-host switch — would otherwise
  // never see the current URL). These pin the two ends of that contract.
  describe('post-start applyCurrentUrl (the hook contract)', () => {
    it('boot path: re-applying the already-canonical hash is a COMPLETE no-op — zero row writes, zero history mutations, no notify', async () => {
      // Stand-in for bootstrapWorkspace's own apply + canonicalization:
      // after it, rows and hash agree (';active' included).
      await applyUrl('#ws-1/a/b;active')
      const rowsBefore = await layoutRows()

      const {projection, pushes, replaces, hash} = startProjection('#ws-1/a/b;active')
      let notified = 0
      const unsubscribe = projection.subscribe(() => { notified += 1 })
      await projection.start()

      await projection.applyCurrentUrl()
      // StrictMode runs the effect (and thus the apply) twice — the second
      // pass must be equally silent.
      await projection.applyCurrentUrl()

      // BlockData carries updatedAt, so even a same-value property rewrite
      // inside the reconcile would fail this deep equality.
      expect(await layoutRows()).toEqual(rowsBefore)
      expect(pushes).toEqual([])
      expect(replaces).toEqual([])
      expect(hash()).toBe('#ws-1/a/b;active')
      expect(notified).toBe(0) // kind 'noop' — the hook's explicit initial sync stays the only one
      unsubscribe()
      projection.dispose()
    })

    it('switch path: a slot-less persp hash over persisted rows normalizes with ONE replace; the next row mutation pushes ONE entry', async () => {
      // The session-host switch protocol: the caller pushed `#ws;persp=…`
      // (slot-less) and flipped the active session; the incoming session has
      // persisted rows. Without the post-start apply the rows never entered
      // the hash and the first mutation pushed a spurious extra entry.
      await createPanelRows(['a', 'b'])
      const {projection, pushes, replaces} = startProjection('#ws-1;persp=lane')
      await projection.start()

      await projection.applyCurrentUrl()

      expect(replaces).toEqual(['#ws-1;persp=lane/a/b']) // replace, not push
      expect(pushes).toEqual([])

      const rowA = (await rowIdsByBlock()).get('a')
      if (!rowA) throw new Error('missing a row')
      await navigatePanel(rowA, 'c')

      await vi.waitFor(() => expect(pushes).toEqual(['#ws-1;persp=lane/c/b'])) // ONE entry, no double
      expect(replaces).toEqual(['#ws-1;persp=lane/a/b']) // still just the one normalization
      projection.dispose()
    })

    it('an apply still queued when dispose() runs is inert (rapid switch-away)', async () => {
      // The apply is queued on a microtask; a same-tick dispose (session
      // switched away again before the apply ran) must keep the dead
      // projection from normalizing ITS rows over the next session's hash.
      await createPanelRows(['a'])
      const {projection, pushes, replaces, hash} = startProjection('#ws-1;persp=lane')
      await projection.start()

      const pending = projection.applyCurrentUrl()
      projection.dispose()
      await pending

      expect(pushes).toEqual([])
      expect(replaces).toEqual([])
      expect(hash()).toBe('#ws-1;persp=lane')
    })
  })
})

describe('recoverPanelOffDeadContent', () => {
  /** A panel row pointed at `blockId`, with panelHistory reset for the row. */
  const panelShowing = async (blockId: string): Promise<Block> => {
    await createPanelRows([blockId])
    const row = (await rows())[0]
    panelHistory.clear(row.id)
    return env.repo.block(row.id)
  }

  it('skips forward entries killed as part of a deleted subtree', async () => {
    // navigate page -> child, Back to page, then delete page. `child` dies with
    // the subtree while sitting on the FORWARD stack, where an exact-id purge
    // of `page` can't see it. Forward must not land the pane on that tombstone.
    await seedBlocks(['landing', 'page'])
    await env.repo.mutate.createChild({parentId: 'page', id: 'child', content: 'child'})
    const panel = await panelShowing('page')

    await navigateInPanel(panel, 'child')
    await goBackInPanel(panel)
    expect(panel.peekProperty(topLevelBlockIdProp)).toBe('page')

    await env.repo.block('page').delete()
    await recoverPanelOffDeadContent(panel, 'page', async () => 'landing')
    expect(panel.peekProperty(topLevelBlockIdProp)).toBe('landing')

    // 'child' is still on the forward stack, and it is now dead.
    expect(await goForwardInPanel(panel)).toBe(false)
    expect(panel.peekProperty(topLevelBlockIdProp)).toBe('landing')
  })

  it('leaves the dead page in the stacks, so undo makes it reachable again', async () => {
    // Recovery used to purge every entry pointing at the deleted page. That
    // made undo a one-way door: the page came back but neither chevron could
    // reach it. Entries are validated at CONSUMPTION time instead, so a dead
    // one costs nothing while it sits there and is simply alive again after
    // undo.
    await seedBlocks(['landing', 'page', 'elsewhere'])
    const panel = await panelShowing('page')
    panelHistory.push(panel.id, {blockId: 'page'})
    panelHistory.push(panel.id, {blockId: 'elsewhere'})

    await env.repo.block('page').delete()
    await recoverPanelOffDeadContent(panel, 'page', async () => 'landing')
    expect(panel.peekProperty(topLevelBlockIdProp)).toBe('elsewhere')
    expect(panelHistory.getSnapshot(panel.id).back.map(e => e.blockId)).toEqual(['page'])

    expect(await env.repo.undo()).toBe(true)
    expect(await goBackInPanel(panel)).toBe(true)
    expect(panel.peekProperty(topLevelBlockIdProp)).toBe('page')
  })

  it('abandons a chevron press if the pane navigated during the prune', async () => {
    // pruneDeadTop awaits row loads. A navigation landing in that window makes
    // the press stale — consuming the stack would yank the pane off the user's
    // new destination and park the wrong page on Forward.
    await seedBlocks(['alive', 'gone', 'page', 'elsewhere'])
    const panel = await panelShowing('page')
    panelHistory.push(panel.id, {blockId: 'alive'})
    panelHistory.push(panel.id, {blockId: 'gone'})
    await env.repo.block('gone').delete()

    // Drive the navigation from inside the prune's liveness read so the
    // interleaving is deterministic rather than timing-dependent. The prune
    // asks `isBlockTombstoned`, which is one `getOptional` against `blocks`.
    livenessHook.onCheck = async id => {
      if (id === 'gone') await navigateInPanel(panel, 'elsewhere')
    }

    expect(await goBackInPanel(panel)).toBe(false)
    expect(panel.peekProperty(topLevelBlockIdProp)).toBe('elsewhere')
    // The whole stack survives, INCLUDING the entry the interleaved navigation
    // pushed ('page'). Asserting only that 'alive' survived passed even with a
    // blind (non-compare-and-swap) dropTop, because the entry a blind drop
    // destroys is the newly-pushed one — i.e. the user's way back to the page
    // they just left. Mutation-tested: reverting the CAS fails this.
    expect(panelHistory.getSnapshot(panel.id).back.map(e => e.blockId))
      .toEqual(['alive', 'gone', 'page'])
  })

  it('skips back entries that died since they were pushed', async () => {
    await seedBlocks(['alive', 'gone', 'page'])
    const panel = await panelShowing('page')
    panelHistory.push(panel.id, {blockId: 'alive'})
    panelHistory.push(panel.id, {blockId: 'gone'})

    await env.repo.block('gone').delete()

    expect(await goBackInPanel(panel)).toBe(true)
    expect(panel.peekProperty(topLevelBlockIdProp)).toBe('alive')
  })

  it('abandons recovery if the pane moved on while it was resolving', async () => {
    // The watcher debounces, so the pane can navigate (or the delete be undone)
    // while the fallback resolution is in flight. Recovery must not then yank
    // the pane off wherever the user actually is.
    await seedBlocks(['landing', 'page', 'elsewhere'])
    const panel = await panelShowing('page')

    await env.repo.block('page').delete()
    await recoverPanelOffDeadContent(panel, 'page', async () => {
      // Simulate the user navigating during the async fallback resolution.
      await navigateInPanel(panel, 'elsewhere')
      return 'landing'
    })

    expect(panel.peekProperty(topLevelBlockIdProp)).toBe('elsewhere')
  })

  it('steps back to the nearest LIVE history entry, skipping tombstones', async () => {
    await seedBlocks(['alive', 'doomed-child', 'page'])
    const panel = await panelShowing('page')
    // Back stack (oldest → newest): alive, then a block that dies with the page.
    panelHistory.push(panel.id, {blockId: 'alive'})
    panelHistory.push(panel.id, {blockId: 'doomed-child'})

    await env.repo.block('doomed-child').delete()
    await env.repo.block('page').delete()
    await recoverPanelOffDeadContent(panel, 'page', async () => null)

    // 'doomed-child' is dead, so recovery skipped it and landed on 'alive'.
    expect(panel.peekProperty(topLevelBlockIdProp)).toBe('alive')
    const snap = panelHistory.getSnapshot(panel.id)
    expect(snap.forward).toEqual([])
    expect(snap.back.some(e => e.blockId === 'page')).toBe(false)
  })

  it('falls back to the landing block when no history entry is live', async () => {
    await seedBlocks(['landing', 'page'])
    const panel = await panelShowing('page')

    await env.repo.block('page').delete()
    await recoverPanelOffDeadContent(panel, 'page', async () => 'landing')

    expect(panel.peekProperty(topLevelBlockIdProp)).toBe('landing')
  })

  it('leaves the pane alone when neither history nor the landing block is live', async () => {
    await seedBlocks(['page'])
    const panel = await panelShowing('page')

    await env.repo.block('page').delete()
    await recoverPanelOffDeadContent(panel, 'page', async () => 'never-existed')

    // No live destination: don't close or blank the pane, just leave it.
    expect(panel.peekProperty(topLevelBlockIdProp)).toBe('page')
  })

  it('recovers every pane showing the deleted page (multi-panel)', async () => {
    await seedBlocks(['landing', 'page'])
    await createPanelRows(['page', 'page'])
    const [rowA, rowB] = await rows()
    panelHistory.clear(rowA.id)
    panelHistory.clear(rowB.id)
    const panelA = env.repo.block(rowA.id)
    const panelB = env.repo.block(rowB.id)

    await env.repo.block('page').delete()
    // Each pane runs its own recovery (one watcher instance per panel).
    await recoverPanelOffDeadContent(panelA, 'page', async () => 'landing')
    await recoverPanelOffDeadContent(panelB, 'page', async () => 'landing')

    expect(panelA.peekProperty(topLevelBlockIdProp)).toBe('landing')
    expect(panelB.peekProperty(topLevelBlockIdProp)).toBe('landing')
  })
})
