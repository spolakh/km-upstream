import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type { BlockData, Tx, Unsubscribe } from '@/data/api'
import { ChangeScope } from '@/data/api'
import { PANEL_STACK_TYPE, PANEL_TYPE } from '@/data/blockTypes'
import {
  activePanelIdProp,
  focusedBlockLocationProp,
  normalizeViewMode,
  panelViewModeProp,
  scrollTopProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { hasBlockType } from '@/data/properties'
import { keyAtEnd, keyBetween, keysBetween } from '@/data/orderKey'
import { keysImmediatelyAfter } from '@/data/orderKeyPlacement'
import {
  buildLayoutFromSlots,
  collectLeafSlots,
  flattenSlots,
  parseLayout,
  preserveHashQueryParams,
  splitHashRouteAndParams,
  type LayoutSlot,
} from '@/utils/routing'
import { isBlockConfirmedDeleted, panelHistory, writePanelContent } from '@/utils/panelHistory'
import { CallbackSet } from '@/utils/callbackSet'
import { panelRenderScopeId } from '@/utils/renderScope'
import { deleteSubtreeInTx as deleteLayoutRowSubtreeInTx } from '@/data/subtreeDelete'
import { visibleChildrenOf } from '@/data/visibleChildren'

export interface ApplyLayoutResult {
  kind: 'applied' | 'empty' | 'ignored' | 'noop' | 'normalized'
}

interface PanelSlot {
  row: BlockData
  blockId: string | undefined
}

interface ReconciliationPlan {
  rowsByTargetIndex: Map<number, PanelSlot>
  rowsToDelete: PanelSlot[]
}

export const isPanelStackRow = (row: Pick<BlockData, 'properties'>): boolean =>
  hasBlockType(row, PANEL_STACK_TYPE)

export const panelBlockId = (row: BlockData): string | undefined => {
  const stored = row.properties[topLevelBlockIdProp.name]
  if (stored === undefined) return undefined
  return topLevelBlockIdProp.codec.decode(stored)
}

const panelViewMode = (row: BlockData): string | undefined => {
  const stored = row.properties[panelViewModeProp.name]
  if (stored === undefined) return undefined
  return normalizeViewMode(panelViewModeProp.codec.decode(stored))
}

const sessionActivePanelId = (row: BlockData | undefined): string | undefined => {
  const stored = row?.properties[activePanelIdProp.name]
  if (stored === undefined) return undefined
  return activePanelIdProp.codec.decode(stored)
}

export const panelBlockIds = (rows: readonly BlockData[]): string[] =>
  rows.map(panelBlockId).filter((id): id is string => Boolean(id))

/** Group rows by `parentId`, preserving row order within each parent.
 *  Rows without a parent are skipped (we never want an `undefined` bucket). */
const buildChildrenByParent = (rows: readonly BlockData[]): Map<string, BlockData[]> => {
  const childrenByParent = new Map<string, BlockData[]>()
  for (const row of rows) {
    if (!row.parentId) continue
    const children = childrenByParent.get(row.parentId) ?? []
    children.push(row)
    childrenByParent.set(row.parentId, children)
  }
  return childrenByParent
}

export const panelRowsInLayoutOrder = (
  rootId: string,
  rows: readonly BlockData[],
): BlockData[] => {
  const childrenByParent = buildChildrenByParent(rows)

  const visit = (row: BlockData): BlockData[] =>
    isPanelStackRow(row)
      ? (childrenByParent.get(row.id) ?? []).flatMap(visit)
      : [row]

  return (childrenByParent.get(rootId) ?? []).flatMap(visit)
}

const firstPanelRowInSlot = (
  row: BlockData,
  childrenByParent: Map<string, BlockData[]>,
): BlockData | undefined => {
  if (!isPanelStackRow(row)) return row
  const children = childrenByParent.get(row.id) ?? []
  for (const child of children) {
    const panel = firstPanelRowInSlot(child, childrenByParent)
    if (panel) return panel
  }
  return undefined
}

const lastPanelRowInSlot = (
  row: BlockData,
  childrenByParent: Map<string, BlockData[]>,
): BlockData | undefined => {
  if (!isPanelStackRow(row)) return row
  const children = childrenByParent.get(row.id) ?? []
  for (let index = children.length - 1; index >= 0; index--) {
    const panel = lastPanelRowInSlot(children[index], childrenByParent)
    if (panel) return panel
  }
  return undefined
}

const adjacentPanelRowInParent = (
  parent: BlockData,
  rowId: string,
  childrenByParent: Map<string, BlockData[]>,
): BlockData | undefined => {
  const siblings = childrenByParent.get(parent.id) ?? []
  const index = siblings.findIndex(sibling => sibling.id === rowId)
  if (index < 0) return undefined

  for (let nextIndex = index + 1; nextIndex < siblings.length; nextIndex++) {
    const panel = firstPanelRowInSlot(siblings[nextIndex], childrenByParent)
    if (panel) return panel
  }

  for (let prevIndex = index - 1; prevIndex >= 0; prevIndex--) {
    const panel = lastPanelRowInSlot(siblings[prevIndex], childrenByParent)
    if (panel) return panel
  }

  return undefined
}

const nextActivePanelAfterClose = (
  row: BlockData,
  parent: BlockData | null,
  rowsBeforeDelete: readonly BlockData[],
): string | undefined => {
  const rowsById = new Map(rowsBeforeDelete.map(row => [row.id, row]))
  const childrenByParent = buildChildrenByParent(rowsBeforeDelete)
  let childId = row.id
  let container = parent

  while (container) {
    const sibling = adjacentPanelRowInParent(container, childId, childrenByParent)
    if (sibling) return sibling.id
    if (!isPanelStackRow(container)) return undefined
    childId = container.id
    container = container.parentId ? rowsById.get(container.parentId) ?? null : null
  }

  return undefined
}

const stackAncestorIdsEmptiedByClose = (
  row: BlockData,
  parent: BlockData | null,
  rowsBeforeDelete: readonly BlockData[],
): string[] => {
  const rowsById = new Map(rowsBeforeDelete.map(row => [row.id, row]))
  const childrenByParent = buildChildrenByParent(rowsBeforeDelete)
  const stackIds: string[] = []
  let removedChildId = row.id
  let container = parent

  while (container && isPanelStackRow(container)) {
    const remainingChildren = (childrenByParent.get(container.id) ?? [])
      .filter(child => child.id !== removedChildId)
    if (remainingChildren.length > 0) break

    stackIds.push(container.id)
    removedChildId = container.id
    container = container.parentId ? rowsById.get(container.parentId) ?? null : null
  }

  return stackIds
}

const activePanelIdAfterReconcile = (
  activePanelId: unknown,
  rootId: string,
  currentRows: readonly BlockData[],
  finalRows: readonly BlockData[],
): string | undefined => {
  if (typeof activePanelId !== 'string') return undefined

  const finalPanels = panelRowsInLayoutOrder(rootId, finalRows)
  const finalPanelIds = new Set(finalPanels.map(row => row.id))
  if (finalPanelIds.has(activePanelId)) return activePanelId

  const currentPanels = panelRowsInLayoutOrder(rootId, currentRows)
  const activeIndex = currentPanels.findIndex(row => row.id === activePanelId)
  if (activeIndex >= 0) {
    for (let index = activeIndex + 1; index < currentPanels.length; index++) {
      const id = currentPanels[index].id
      if (finalPanelIds.has(id)) return id
    }

    for (let index = activeIndex - 1; index >= 0; index--) {
      const id = currentPanels[index].id
      if (finalPanelIds.has(id)) return id
    }
  }

  return undefined
}

// URL-borne sublayout columns (the parenthesized grammar) can't be
// materialized as panel rows yet — not implemented; the grammar parses and
// round-trips them so deeper layouts become a data-model change later. Degrade
// them at the URL boundary to their flattened leaves so an inbound hash
// like `#ws/(a/b)` never crashes bootstrap: a sublayout inside a column
// splices its leaves into that column's stack; a column that IS a
// sublayout becomes a stack of its leaves (or a plain leaf if single).
const hasSublayoutSlots = (slots: readonly LayoutSlot[]): boolean =>
  slots.some(slot =>
    slot.kind === 'sublayout' ||
    (slot.kind === 'stack' && hasSublayoutSlots(slot.children)))

const degradeSublayoutSlots = (slots: readonly LayoutSlot[]): LayoutSlot[] =>
  slots.flatMap((slot): LayoutSlot[] => {
    if (slot.kind === 'leaf') return [slot]
    const leaves = collectLeafSlots([slot])
    if (leaves.length === 0) return []
    if (leaves.length === 1) return [leaves[0]]
    return [{kind: 'stack' as const, children: leaves}]
  })

// Leaves compare blockId + viewMode + active, per `strictness`:
// - 'exact' (default): full context equality.
// - 'ignore-active': everything but the active flag — classifies an
//   active-only diff (replace-not-push in the projection).
// - 'topology': kind + blockId only — routes context-only inbound diffs
//   away from destructive materialization.
// `rest` deliberately never participates: rows have nowhere to store
// unknown context entries, so they live in the URL only and must never
// make two otherwise-identical layouts compare unequal.
type SlotComparisonStrictness = 'exact' | 'ignore-active' | 'topology'

const sameLayoutSlots = (
  left: readonly LayoutSlot[],
  right: readonly LayoutSlot[],
  strictness: SlotComparisonStrictness = 'exact',
): boolean =>
  left.length === right.length && left.every((slot, index) => {
    const other = right[index]
    if (!other || slot.kind !== other.kind) return false
    if (slot.kind === 'leaf' && other.kind === 'leaf') {
      if (slot.blockId !== other.blockId) return false
      if (strictness === 'topology') return true
      return slot.viewMode === other.viewMode &&
        (strictness === 'ignore-active' || (slot.active === true) === (other.active === true))
    }
    if (slot.kind === 'stack' && other.kind === 'stack') return sameLayoutSlots(slot.children, other.children, strictness)
    if (slot.kind === 'sublayout' && other.kind === 'sublayout') return sameLayoutSlots(slot.columns, other.columns, strictness)
    return false
  })

/** How many panes render each block id, for comparing two layouts by
 *  occurrence rather than by leaf position (see `leavingDeletedBlock`). */
const countLeavesByBlockId = (slots: readonly LayoutSlot[]): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const leaf of collectLeafSlots(slots)) {
    counts.set(leaf.blockId, (counts.get(leaf.blockId) ?? 0) + 1)
  }
  return counts
}

// Unknown context entries (`rest`) have no row representation — they live
// only in the URL. When a hash is rebuilt from rows (outbound writes,
// inbound canonicalization), carry the current hash's rest entries onto the
// rebuilt leaves, matched by leaf position; skipped entirely when the leaf
// sequences don't line up (a real layout change owns its own history entry).
const withRestFromUrl = (
  urlSlots: readonly LayoutSlot[],
  rowSlots: readonly LayoutSlot[],
): readonly LayoutSlot[] => {
  const urlLeaves = collectLeafSlots(urlSlots)
  const rowLeaves = collectLeafSlots(rowSlots)
  const aligned = urlLeaves.length === rowLeaves.length && urlLeaves.every((leaf, index) => {
    const other = rowLeaves[index]
    return leaf.kind === 'leaf' && other.kind === 'leaf' && leaf.blockId === other.blockId
  })
  if (!aligned || !urlLeaves.some(leaf => leaf.kind === 'leaf' && leaf.rest !== undefined)) {
    return rowSlots
  }
  let leafIndex = 0
  const walk = (slots: readonly LayoutSlot[]): LayoutSlot[] => slots.map(slot => {
    if (slot.kind === 'stack') return {kind: 'stack', children: walk(slot.children)}
    if (slot.kind === 'sublayout') return {kind: 'sublayout', columns: walk(slot.columns)}
    const source = urlLeaves[leafIndex++]
    return source.kind === 'leaf' && source.rest !== undefined ? {...slot, rest: source.rest} : slot
  })
  return walk(rowSlots)
}

export const layoutSlotsFromRows = (
  rootId: string,
  rows: readonly BlockData[],
): LayoutSlot[] => {
  const childrenByParent = buildChildrenByParent(rows)
  // Subtree reads include the root (query.subtree is includeRoot,
  // loadSubtreeRowsInTx pushes it), so the session's active-panel pointer
  // is readable right off `rows` — no separate load.
  const activePanelId = sessionActivePanelId(rows.find(row => row.id === rootId))

  const visit = (row: BlockData): LayoutSlot | null => {
    if (isPanelStackRow(row)) {
      const children = (childrenByParent.get(row.id) ?? [])
        .map(visit)
        .filter((slot): slot is LayoutSlot => Boolean(slot))
      // Normalize degenerate stacks: a singleton stack IS its child and an
      // empty stack is nothing. This keeps rows-with-singleton-stack equal
      // to the leaf hash (no destructive un-stack reconcile on reload — the
      // stack row survives silently and insertSidebarStackedPanel can still
      // join it) and keeps `//` empty segments out of the built hash.
      if (children.length === 0) return null
      if (children.length === 1) return children[0]
      return {kind: 'stack', children}
    }
    const blockId = panelBlockId(row)
    if (!blockId) return null
    const viewMode = panelViewMode(row)
    return {
      kind: 'leaf',
      blockId,
      ...(viewMode !== undefined ? {viewMode} : {}),
      ...(row.id === activePanelId ? {active: true} : {}),
    }
  }

  return (childrenByParent.get(rootId) ?? [])
    .map(visit)
    .filter((slot): slot is LayoutSlot => Boolean(slot))
}

export const layoutBlockIdsFromRows = (rootId: string, rows: readonly BlockData[]): string[] =>
  flattenSlots(layoutSlotsFromRows(rootId, rows))

const loadSubtreeRowsInTx = async (
  tx: Tx,
  root: BlockData,
): Promise<BlockData[]> => {
  const rows: BlockData[] = [root]
  const visit = async (parentId: string): Promise<void> => {
    const children = await visibleChildrenOf(tx, parentId, root.workspaceId)
    for (const child of children) {
      rows.push(child)
      await visit(child.id)
    }
  }
  await visit(root.id)
  return rows
}

const lcsMatches = (
  current: readonly PanelSlot[],
  targetBlockIds: readonly string[],
): Array<{currentIndex: number; targetIndex: number}> => {
  const table: number[][] = Array.from(
    {length: current.length + 1},
    () => Array.from({length: targetBlockIds.length + 1}, () => 0),
  )

  for (let i = current.length - 1; i >= 0; i--) {
    for (let j = targetBlockIds.length - 1; j >= 0; j--) {
      table[i][j] = current[i].blockId === targetBlockIds[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const matches: Array<{currentIndex: number; targetIndex: number}> = []
  let i = 0
  let j = 0
  while (i < current.length && j < targetBlockIds.length) {
    if (current[i].blockId === targetBlockIds[j]) {
      matches.push({currentIndex: i, targetIndex: j})
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  return matches
}

const planReconciliation = (
  current: readonly PanelSlot[],
  targetBlockIds: readonly string[],
): ReconciliationPlan => {
  const rowsByTargetIndex = new Map<number, PanelSlot>()
  const matches = lcsMatches(current, targetBlockIds)
  const usedCurrent = new Set<number>()

  for (const match of matches) {
    rowsByTargetIndex.set(match.targetIndex, current[match.currentIndex])
    usedCurrent.add(match.currentIndex)
  }

  for (let targetIndex = 0; targetIndex < targetBlockIds.length; targetIndex++) {
    if (rowsByTargetIndex.has(targetIndex)) continue
    const exactIndex = current.findIndex((slot, currentIndex) =>
      !usedCurrent.has(currentIndex) && slot.blockId === targetBlockIds[targetIndex])
    if (exactIndex >= 0) {
      rowsByTargetIndex.set(targetIndex, current[exactIndex])
      usedCurrent.add(exactIndex)
    }
  }

  for (let targetIndex = 0; targetIndex < targetBlockIds.length; targetIndex++) {
    if (rowsByTargetIndex.has(targetIndex)) continue
    const reusableIndex = current.findIndex((_, currentIndex) => !usedCurrent.has(currentIndex))
    if (reusableIndex >= 0) {
      rowsByTargetIndex.set(targetIndex, current[reusableIndex])
      usedCurrent.add(reusableIndex)
    }
  }

  const rowsToDelete = current.filter((_, currentIndex) => !usedCurrent.has(currentIndex))
  return {rowsByTargetIndex, rowsToDelete}
}

export const createPanelRowInTx = async (
  repo: Repo,
  tx: Tx,
  args: {
    workspaceId: string
    parentId: string
    orderKey: string
    blockId: string
    viewMode?: string
  },
): Promise<string> => {
  const id = await tx.create({
    workspaceId: args.workspaceId,
    parentId: args.parentId,
    orderKey: args.orderKey,
    content: args.blockId,
    properties: {
      [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode(args.blockId),
      [scrollTopProp.name]: scrollTopProp.codec.encode(0),
      ...(args.viewMode !== undefined
        ? {[panelViewModeProp.name]: panelViewModeProp.codec.encode(args.viewMode)}
        : {}),
    },
  })
  // The focus seed needs the per-pane scope, which needs the row id `create`
  // just minted — written as a second op in the SAME tx.
  await tx.setProperty(id, focusedBlockLocationProp, {
    blockId: args.blockId,
    renderScopeId: panelRenderScopeId(id, args.blockId),
  })
  await repo.addTypeInTx(tx, id, PANEL_TYPE)
  return id
}

export const createPanelStackRowInTx = async (
  repo: Repo,
  tx: Tx,
  args: {
    workspaceId: string
    parentId: string
    orderKey: string
  },
): Promise<string> => {
  const id = await tx.create({
    workspaceId: args.workspaceId,
    parentId: args.parentId,
    orderKey: args.orderKey,
    content: 'sidebar-stack',
    properties: {},
  })
  await repo.addTypeInTx(tx, id, PANEL_STACK_TYPE)
  return id
}

export const insertPanelRow = async (
  repo: Repo,
  layoutSessionBlock: Block,
  blockId: string,
  options: {afterPanelId?: string} = {},
): Promise<string> =>
  repo.tx(async tx => {
    const parent = await tx.get(layoutSessionBlock.id)
    if (!parent) throw new Error(`insertPanelRow: layout session block ${layoutSessionBlock.id} not found`)

    const siblings = await visibleChildrenOf(tx, layoutSessionBlock.id, parent.workspaceId)
    const sourceIndex = options.afterPanelId
      ? siblings.findIndex(row => row.id === options.afterPanelId)
      : -1
    // Insert the new panel EXACTLY after the source panel (between it and its
    // next sibling), breaking a tie by re-keying the run when the source panel
    // shares an order_key with its next sibling (#198/#182). Non-tie inputs
    // reduce to the previous keyBetween bounds.
    const orderKey = sourceIndex >= 0
      ? (await keysImmediatelyAfter(tx, layoutSessionBlock.id, siblings, sourceIndex, 1))[0]
      : keyAtEnd(siblings.at(-1)?.orderKey ?? null)

    const panelId = await createPanelRowInTx(repo, tx, {
      workspaceId: parent.workspaceId,
      parentId: layoutSessionBlock.id,
      orderKey,
      blockId,
    })
    await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, panelId)
    return panelId
  }, {scope: ChangeScope.UiState, description: 'insert panel row'})

const insertPanelAtStartOfStackInTx = async (
  repo: Repo,
  tx: Tx,
  args: {
    workspaceId: string
    stackId: string
    blockId: string
  },
): Promise<string> => {
  const children = await visibleChildrenOf(tx, args.stackId, args.workspaceId)
  const orderKey = keyBetween(null, children[0]?.orderKey ?? null)
  return createPanelRowInTx(repo, tx, {
    workspaceId: args.workspaceId,
    parentId: args.stackId,
    orderKey,
    blockId: args.blockId,
  })
}

export const insertSidebarStackedPanel = async (
  repo: Repo,
  layoutSessionBlock: Block,
  blockId: string,
  options: {sourcePanelId?: string} = {},
): Promise<string> =>
  repo.tx(async tx => {
    const parent = await tx.get(layoutSessionBlock.id)
    if (!parent) throw new Error(`insertSidebarStackedPanel: layout session block ${layoutSessionBlock.id} not found`)

    if (options.sourcePanelId) {
      const source = await tx.get(options.sourcePanelId)
      const sourceParent = source?.parentId ? await tx.get(source.parentId) : null
      if (source && sourceParent && isPanelStackRow(sourceParent)) {
        const panelId = await insertPanelAtStartOfStackInTx(repo, tx, {
          workspaceId: parent.workspaceId,
          stackId: sourceParent.id,
          blockId,
        })
        await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, panelId)
        return panelId
      }

      if (source?.parentId === layoutSessionBlock.id) {
        const topLevelSiblings = await visibleChildrenOf(tx, layoutSessionBlock.id, parent.workspaceId)
        const sourceIndex = topLevelSiblings.findIndex(row => row.id === source.id)
        const rightSibling = sourceIndex >= 0 ? topLevelSiblings[sourceIndex + 1] : undefined
        if (rightSibling && isPanelStackRow(rightSibling)) {
          const panelId = await insertPanelAtStartOfStackInTx(repo, tx, {
            workspaceId: parent.workspaceId,
            stackId: rightSibling.id,
            blockId,
          })
          await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, panelId)
          return panelId
        }

        const stackOrderKey = rightSibling
          ? rightSibling.orderKey
          : keyAtEnd(source.orderKey)
        const stackId = await createPanelStackRowInTx(repo, tx, {
          workspaceId: parent.workspaceId,
          parentId: layoutSessionBlock.id,
          orderKey: stackOrderKey,
        })
        if (rightSibling) {
          const [, rightOrderKey] = keysBetween(null, null, 2)
          await tx.move(rightSibling.id, {parentId: stackId, orderKey: rightOrderKey})
        }
        const panelId = await insertPanelAtStartOfStackInTx(repo, tx, {
          workspaceId: parent.workspaceId,
          stackId,
          blockId,
        })
        await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, panelId)
        return panelId
      }
    }

    const siblings = await visibleChildrenOf(tx, layoutSessionBlock.id, parent.workspaceId)
    const previous = siblings.at(-1)
    const stackId = await createPanelStackRowInTx(repo, tx, {
      workspaceId: parent.workspaceId,
      parentId: layoutSessionBlock.id,
      orderKey: keyAtEnd(previous?.orderKey ?? null),
    })
    const panelId = await insertPanelAtStartOfStackInTx(repo, tx, {
      workspaceId: parent.workspaceId,
      stackId,
      blockId,
    })
    await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, panelId)
    return panelId
  }, {scope: ChangeScope.UiState, description: 'insert sidebar stack panel'})

export const activatePanelRowInTx = async (
  tx: Tx,
  layoutSessionBlockId: string,
  panelId: string,
): Promise<boolean> => {
  const layoutSession = await tx.get(layoutSessionBlockId)
  const row = await tx.get(panelId)
  if (!layoutSession || layoutSession.deleted || !row || row.deleted) return false
  const alreadyActive = layoutSession.properties[activePanelIdProp.name] === panelId

  let parentId = row.parentId
  while (parentId) {
    if (parentId === layoutSessionBlockId) {
      if (!alreadyActive) {
        await tx.setProperty(layoutSessionBlockId, activePanelIdProp, panelId)
      }
      return true
    }

    const parent = await tx.get(parentId)
    if (!parent || parent.deleted || !isPanelStackRow(parent)) return false
    parentId = parent.parentId
  }

  return false
}

export const activatePanelRow = async (
  repo: Repo,
  layoutSessionBlockId: string,
  panelId: string,
): Promise<boolean> => {
  let activated = false
  await repo.tx(async tx => {
    activated = await activatePanelRowInTx(tx, layoutSessionBlockId, panelId)
  }, {scope: ChangeScope.UiState, description: 'activate panel'})
  return activated
}

export const deletePanelRow = async (
  repo: Repo,
  panelId: string,
): Promise<void> => {
  await repo.tx(async tx => {
    const row = await tx.get(panelId)
    if (!row) return
    const parent = row.parentId ? await tx.get(row.parentId) : null
    let layoutSession = parent
    while (layoutSession && isPanelStackRow(layoutSession)) {
      layoutSession = layoutSession.parentId ? await tx.get(layoutSession.parentId) : null
    }
    const rowsBeforeDelete = layoutSession
      ? await loadSubtreeRowsInTx(tx, layoutSession)
      : []
    const stackIdsToDelete = stackAncestorIdsEmptiedByClose(row, parent, rowsBeforeDelete)
    const deletingActivePanel = layoutSession?.properties[activePanelIdProp.name] === panelId
    const nextActivePanelId = deletingActivePanel
      ? nextActivePanelAfterClose(row, parent, rowsBeforeDelete)
      : undefined
    // Subtree deletes (PR #288 §9): panel rows are UiState property hosts —
    // in a flipped workspace their bags materialize as hidden field/value
    // children, and a bare tx.delete would strand those live under the
    // tombstone (still indexed/uploaded).
    await deleteLayoutRowSubtreeInTx(tx, panelId)
    for (const stackId of stackIdsToDelete) {
      await deleteLayoutRowSubtreeInTx(tx, stackId)
    }
    if (deletingActivePanel && layoutSession) {
      await tx.setProperty(layoutSession.id, activePanelIdProp, nextActivePanelId)
    }
  }, {scope: ChangeScope.UiState, description: 'close panel'})
  // Clear in-memory history only after the tx committed — a rollback must
  // leave the row's history intact with the row.
  panelHistory.clear(panelId)
}

export const reconcilePanelRows = async (
  repo: Repo,
  layoutSessionBlock: Block,
  targetSlotsOrBlockIds: readonly (LayoutSlot | string)[],
): Promise<{changed: boolean}> => {
  const targetSlots: LayoutSlot[] = targetSlotsOrBlockIds.map(slot =>
    typeof slot === 'string' ? {kind: 'leaf', blockId: slot} : slot,
  )
  const targetBlockIds = flattenSlots(targetSlots)
  const deletedPanelRowIds: string[] = []

  const changed = await repo.tx(async tx => {
    const parent = await tx.get(layoutSessionBlock.id)
    if (!parent) throw new Error(`reconcilePanelRows: layout session block ${layoutSessionBlock.id} not found`)

    const currentRows = await loadSubtreeRowsInTx(tx, parent)
    const activePanelId = sessionActivePanelId(parent)
    const currentLayoutSlots = layoutSlotsFromRows(layoutSessionBlock.id, currentRows)

    // ── Targeted context pass ──
    // Topology-equal targets (same kinds + block ids) must NEVER take the
    // destructive materialization below: real sessions always have an
    // active panel, so any inbound hash without `;active` (old bookmark,
    // shared link) would otherwise delete+recreate stack rows (React
    // remounts), re-key rows via tx.move (junk UiState uploads), and
    // un-stack singleton stacks. Context diffs are applied surgically.
    const targetLeaves = collectLeafSlots(targetSlots)
    const currentLeafRows = panelRowsInLayoutOrder(layoutSessionBlock.id, currentRows)
      .filter(row => panelBlockId(row) !== undefined)
    if (
      sameLayoutSlots(currentLayoutSlots, targetSlots, 'topology') &&
      currentLeafRows.length === targetLeaves.length
    ) {
      let wrote = false
      let urlActiveRowId: string | undefined
      for (let index = 0; index < currentLeafRows.length; index++) {
        const row = currentLeafRows[index]
        const leaf = targetLeaves[index]
        if (leaf.kind !== 'leaf') continue
        if (panelViewMode(row) !== leaf.viewMode) {
          await tx.setProperty(row.id, panelViewModeProp, leaf.viewMode)
          wrote = true
        }
        if (leaf.active && urlActiveRowId === undefined) urlActiveRowId = row.id
      }
      if (urlActiveRowId !== undefined) {
        if (urlActiveRowId !== activePanelId) {
          await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, urlActiveRowId)
          wrote = true
        }
      } else if (activePanelId !== undefined && !currentRows.some(row => row.id === activePanelId)) {
        // Stale-pointer hygiene (kept from the old equal-path repair): a
        // dangling active id is cleared. Not counted as a layout change.
        await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, undefined)
      }
      return wrote
    }

    const repairActivePanelId = async (finalRows: readonly BlockData[]) => {
      if (activePanelId === undefined) return
      const nextActivePanelId = activePanelIdAfterReconcile(
        activePanelId,
        layoutSessionBlock.id,
        currentRows,
        finalRows,
      )
      if (nextActivePanelId !== activePanelId) {
        await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, nextActivePanelId)
      }
    }

    const currentSlots = currentRows
      .filter(row => row.id !== layoutSessionBlock.id && !isPanelStackRow(row))
      .map(row => ({row, blockId: panelBlockId(row)}))
    const stackRowsToDelete = currentRows
      .filter(row => row.id !== layoutSessionBlock.id && isPanelStackRow(row))

    const {rowsByTargetIndex, rowsToDelete} = planReconciliation(currentSlots, targetBlockIds)

    // Removed layout rows are deleted WITH their whole subtree
    // (`deleteLayoutRowSubtreeInTx`), same as `deletePanelRow`. Hierarchical
    // editing: anything meant to survive a reconcile is moved out of the doomed
    // subtree FIRST — the reused panels are relocated into the freshly-built
    // stacks by `materializeSlots` (`tx.move`), and unmatched panels are leaves
    // with nothing to preserve. So by delete time each doomed row's subtree
    // holds only what should go: its hidden property-field machinery (a flipped
    // workspace's materialized UiState props) and husk stacks that are their own
    // `stackRowsToDelete` entries (idempotent re-delete). A bare `tx.delete`
    // would instead strand that machinery live under the tombstone (#8).
    for (const slot of rowsToDelete) {
      await deleteLayoutRowSubtreeInTx(tx, slot.row.id)
      deletedPanelRowIds.push(slot.row.id)
    }

    let targetLeafIndex = 0
    // Inbound `;active`: the first leaf carrying the flag wins (URL order).
    let urlActiveRowId: string | undefined
    const materializeSlots = async (slots: readonly LayoutSlot[], parentId: string): Promise<void> => {
      const orderKeys = keysBetween(null, null, slots.length)
      for (let index = 0; index < slots.length; index++) {
        const target = slots[index]
        const orderKey = orderKeys[index]
        if (target.kind === 'stack') {
          const stackId = await createPanelStackRowInTx(repo, tx, {
            workspaceId: parent.workspaceId,
            parentId,
            orderKey,
          })
          await materializeSlots(target.children, stackId)
          continue
        }
        if (target.kind === 'sublayout') {
          // Unreachable internal assertion: applyCurrentLayoutUrl degrades
          // URL-borne sublayouts before reconciling, and layoutSlotsFromRows
          // never produces them. Reaching here means a caller handed
          // reconcilePanelRows a sublayout directly — a bug, not user input.
          throw new Error('reconcilePanelRows: sublayout slots are not materializable yet')
        }

        const blockId = target.blockId
        const slot = rowsByTargetIndex.get(targetLeafIndex)
        targetLeafIndex++
        if (!slot) {
          const createdId = await createPanelRowInTx(repo, tx, {
            workspaceId: parent.workspaceId,
            parentId,
            orderKey,
            blockId,
            viewMode: target.viewMode,
          })
          if (target.active && urlActiveRowId === undefined) urlActiveRowId = createdId
          continue
        }

        if (target.active && urlActiveRowId === undefined) urlActiveRowId = slot.row.id
        if (slot.row.orderKey !== orderKey || slot.row.parentId !== parentId) {
          await tx.move(slot.row.id, {parentId, orderKey})
        }
        if (slot.blockId !== blockId) {
          const restored = slot.blockId
            ? panelHistory.reconcileUrlNavigation(slot.row.id, {
              blockId: slot.blockId,
              state: panelHistory.snapshot(slot.row.id),
            }, blockId)
            : null
          panelHistory.enqueueRestore(slot.row.id, restored?.state)
          // The URL's slot context is authoritative for the mode here — the
          // restored VisitState's remembered viewMode is deliberately NOT
          // applied (that happens only on chevron back/forward).
          await writePanelContent(tx, slot.row.id, blockId, restored?.state, {viewMode: target.viewMode})
        } else if (panelViewMode(slot.row) !== target.viewMode) {
          // Same content, different mode — sync the URL's mode onto the row.
          await tx.setProperty(slot.row.id, panelViewModeProp, target.viewMode)
        }
      }
    }

    await materializeSlots(targetSlots, layoutSessionBlock.id)

    for (const stackRow of stackRowsToDelete) {
      await deleteLayoutRowSubtreeInTx(tx, stackRow.id)
    }

    // Either/or: an inbound `;active` names a row THIS reconcile just
    // materialized (never a deleted one), so it fully supersedes the
    // repair remap; without it, repair handles a deleted active row.
    if (urlActiveRowId !== undefined) {
      if (urlActiveRowId !== activePanelId) {
        await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, urlActiveRowId)
      }
    } else {
      await repairActivePanelId(await loadSubtreeRowsInTx(tx, parent))
    }
    return true
  }, {scope: ChangeScope.UiState, description: 'reconcile panel layout from URL'})

  // Clear in-memory history only after the tx committed: ANY in-tx throw
  // (materialization, stack cleanup, active-panel repair) rolls the row
  // deletes back, and the non-transactional history must survive with them.
  // (clear is a plain Map delete and cannot throw in production; a throw here
  // would leak the remaining ids' history, which only the probe test does.)
  for (const id of deletedPanelRowIds) {
    panelHistory.clear(id)
  }
  return {changed}
}

export const retargetPanelBlockIds = async (
  repo: Repo,
  layoutSessionBlock: Block,
  fromId: string,
  toId: string,
): Promise<void> => {
  if (fromId === toId) return

  await repo.tx(async tx => {
    const parent = await tx.get(layoutSessionBlock.id)
    if (!parent) {
      throw new Error(`retargetPanelBlockIds: layout session block ${layoutSessionBlock.id} not found`)
    }

    const currentRows = await loadSubtreeRowsInTx(tx, parent)
    const panelRows = currentRows
      .filter(row => row.id !== layoutSessionBlock.id && !isPanelStackRow(row))
      .filter(row => panelBlockId(row) === fromId)

    for (const row of panelRows) {
      const restored = panelHistory.reconcileUrlNavigation(row.id, {
        blockId: fromId,
        state: panelHistory.snapshot(row.id),
      }, toId)
      panelHistory.enqueueRestore(row.id, restored?.state)
      // No viewMode option: a merge retarget clears the mode (it belonged
      // to the (pane, source-block) pair, and the source block is gone).
      await writePanelContent(tx, row.id, toId, restored?.state)
    }
  }, {scope: ChangeScope.UiState, description: 'retarget merged panels'})
}

export interface ApplyCurrentLayoutUrlArgs {
  repo: Repo
  workspaceId: string
  layoutSessionBlock: Block
  hash?: string
  replaceHash?: (hash: string) => void
}

export const applyCurrentLayoutUrl = async ({
  repo,
  workspaceId,
  layoutSessionBlock,
  hash = typeof window === 'undefined' ? '' : window.location.hash,
  replaceHash,
}: ApplyCurrentLayoutUrlArgs): Promise<ApplyLayoutResult> => {
  const route = parseLayout(hash)
  if (route.workspaceId && route.workspaceId !== workspaceId) {
    return {kind: 'ignored'}
  }
  // Degrade sublayout columns BEFORE they can reach row materialization
  // (which would throw); the canonicalization below rewrites the URL.
  const targetSlots = hasSublayoutSlots(route.slots)
    ? degradeSublayoutSlots(route.slots)
    : route.slots

  const currentRows = await layoutSessionBlock.repo.query.subtree({id: layoutSessionBlock.id, hidePropertyChildren: true}).load()
  const currentSlots = layoutSlotsFromRows(layoutSessionBlock.id, currentRows)

  if (targetSlots.length === 0) {
    if (currentSlots.length > 0) {
      // Ws-context (e.g. `;persp=`) has no row representation — like slot
      // `rest`, it lives in the URL only, so every rebuilt hash re-attaches
      // the incoming route's entries or a normalization would eat them.
      replaceHash?.(preserveHashQueryParams(
        buildLayoutFromSlots(workspaceId, currentSlots, route.wsContext), hash))
      return {kind: 'normalized'}
    }
    return {kind: 'empty'}
  }

  const {changed} = await reconcilePanelRows(repo, layoutSessionBlock, targetSlots)

  // Canonicalize the URL against what the rows actually hold (adds `;active`,
  // canonical entry order, un-parenthesizes degraded sublayouts) in ONE
  // replace. `rest` entries and the ws-context the hash carried are
  // re-attached (rows can't store either). Cannot loop: replaceState fires
  // no event, and a second pass over the replaced hash compares equal.
  const finalRows = changed
    ? await layoutSessionBlock.repo.query.subtree({id: layoutSessionBlock.id, hidePropertyChildren: true}).load()
    : currentRows
  const finalSlots = layoutSlotsFromRows(layoutSessionBlock.id, finalRows)
  const canonical = buildLayoutFromSlots(workspaceId, withRestFromUrl(route.slots, finalSlots), route.wsContext)
  if (canonical !== `#${splitHashRouteAndParams(hash).route}`) {
    replaceHash?.(preserveHashQueryParams(canonical, hash))
    return {kind: 'normalized'}
  }
  return {kind: changed ? 'applied' : 'noop'}
}

export interface PanelLayoutProjectionOptions {
  repo: Repo
  workspaceId: string
  layoutSessionBlock: Block
  getHash?: () => string
  pushHash?: (hash: string) => void
  replaceHash?: (hash: string) => void
  subscribeToUrl?: (listener: () => void) => Unsubscribe
}

const defaultGetHash = (): string => window.location.hash
const defaultPushHash = (hash: string): void => {
  window.history.pushState(null, '', preserveHashQueryParams(hash, window.location.hash))
}
const defaultReplaceHash = (hash: string): void => {
  window.history.replaceState(null, '', preserveHashQueryParams(hash, window.location.hash))
}
const defaultSubscribeToUrl = (listener: () => void): Unsubscribe => {
  window.addEventListener('hashchange', listener)
  window.addEventListener('popstate', listener)
  return () => {
    window.removeEventListener('hashchange', listener)
    window.removeEventListener('popstate', listener)
  }
}

export class PanelLayoutProjection {
  private readonly repo: Repo
  private readonly workspaceId: string
  private readonly layoutSessionBlock: Block
  private readonly getHash: () => string
  private readonly pushHash: (hash: string) => void
  private readonly replaceHash: (hash: string) => void
  private readonly subscribeToUrl: (listener: () => void) => Unsubscribe
  private readonly listeners = new CallbackSet<[]>('PanelLayoutProjection')
  private unsubscribeRows: Unsubscribe | null = null
  private unsubscribeUrl: Unsubscribe | null = null
  private inboundQueue: Promise<void> = Promise.resolve()
  private lastSlots: readonly LayoutSlot[] = []
  private pendingInbound = 0
  private outboundSuppressed = false
  private outboundGeneration = 0
  /** Terminal: set by dispose(), never cleared (projections are one-shot
   *  per effect — nothing restarts a disposed one). Guards the QUEUED work
   *  `applyCurrentUrl` schedules: dispose() can't cancel an in-flight apply,
   *  and with the hook now applying post-start (see usePanelLayoutProjection)
   *  a rapid session switch could otherwise have a dead session's late apply
   *  rewrite the hash from ITS rows after the next session took over. */
  private disposed = false

  constructor(options: PanelLayoutProjectionOptions) {
    this.repo = options.repo
    this.workspaceId = options.workspaceId
    this.layoutSessionBlock = options.layoutSessionBlock
    this.getHash = options.getHash ?? defaultGetHash
    this.pushHash = options.pushHash ?? defaultPushHash
    this.replaceHash = options.replaceHash ?? defaultReplaceHash
    this.subscribeToUrl = options.subscribeToUrl ?? defaultSubscribeToUrl
  }

  async start(): Promise<void> {
    if (this.unsubscribeRows || this.unsubscribeUrl) return
    const rowsHandle = this.layoutSessionBlock.repo.query.subtree({id: this.layoutSessionBlock.id, hidePropertyChildren: true})
    const initialRows = await rowsHandle.load()
    this.lastSlots = layoutSlotsFromRows(this.layoutSessionBlock.id, initialRows)
    this.unsubscribeRows = rowsHandle.subscribe(rows => {
      this.handleRowsChanged(rows)
    })
    this.unsubscribeUrl = this.subscribeToUrl(() => {
      // Never let an inbound-URL failure escape as an unhandled rejection —
      // the queue itself already swallows prior failures, but the returned
      // promise from THIS application can still reject.
      this.applyCurrentUrl().catch(error => {
        console.error('PanelLayoutProjection: applying URL change failed', error)
      })
    })
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribeRows?.()
    this.unsubscribeRows = null
    this.unsubscribeUrl?.()
    this.unsubscribeUrl = null
    this.listeners.clear()
  }

  subscribe(listener: () => void): Unsubscribe {
    return this.listeners.add(listener)
  }

  applyCurrentUrl(): Promise<void> {
    this.pendingInbound++
    this.inboundQueue = this.inboundQueue
      .catch(() => {})
      .then(async () => {
        try {
          // Queued after dispose (or disposed while waiting in the queue):
          // don't touch rows or the hash on behalf of a dead projection.
          if (this.disposed) return
          const result = await applyCurrentLayoutUrl({
            repo: this.repo,
            workspaceId: this.workspaceId,
            layoutSessionBlock: this.layoutSessionBlock,
            hash: this.getHash(),
            replaceHash: hash => {
              this.replaceHash(hash)
              this.listeners.notify()
            },
          })
          if (result.kind === 'applied' || result.kind === 'normalized' || result.kind === 'ignored') {
            this.listeners.notify()
          }
        } finally {
          this.pendingInbound--
          if (this.pendingInbound === 0 && this.outboundSuppressed && !this.disposed) {
            // One deferred outbound pass with FRESH rows: a rows state that
            // legitimately diverged while inbound was in flight still
            // projects; an echo of the inbound's own writes compares equal
            // and stays silent. The suppressed flag is cleared only after a
            // successful load (a throw keeps the divergence pending), and
            // the generation check skips the pass when a live subscription
            // event was processed after drain (its rows are newer).
            const generationAtDrain = this.outboundGeneration
            const rows = await this.layoutSessionBlock.repo.query.subtree({id: this.layoutSessionBlock.id, hidePropertyChildren: true}).load()
            // Re-check after the await: a NEW inbound may have queued during
            // the load (and rows events suppressed under it re-set the flag),
            // or the projection may have been disposed mid-load. Bail WITHOUT
            // clearing — a new inbound's own drain owns the flag now
            // (clearing here would strand its suppressed divergence), and a
            // disposed projection must not write the hash at all.
            if (this.pendingInbound === 0 && !this.disposed) {
              this.outboundSuppressed = false
              if (this.outboundGeneration === generationAtDrain) {
                this.handleRowsChanged(rows)
              }
            }
          }
        }
      })
    return this.inboundQueue
  }

  /**
   * Is the hash entry we're LEAVING unreturnable — i.e. does a pane we're
   * navigating away from render a block known to be deleted?
   *
   * Scoped to the blocks actually being left (`current` minus `next`), not
   * every leaf in the layout. Scanning the whole layout meant one pane stuck on
   * a tombstone downgraded *every* navigation in *every* pane to a replace for
   * the rest of the session, silently killing browser Back.
   *
   * "Known deleted" is a tombstone in cache, or an id recovery has positively
   * confirmed dead — NOT merely a confirmed-missing cache marker. `repo.load`
   * markMissing's any row it can't find, including one that simply hasn't
   * replicated yet, and `PanelContentRecovery` calls `load()` on exactly those.
   * Inferring death from that marker would replace the hash entry for a valid
   * deep link, so Back could never return to it once the row arrived.
   */
  private leavingDeletedBlock(
    current: readonly LayoutSlot[],
    next: readonly LayoutSlot[],
  ): boolean {
    // Compared by OCCURRENCE COUNT, not as a set of ids and not positionally.
    //
    // A set difference is too weak: with the same page open in two panes and
    // only one recovering, the id is still present in `next`, so it concludes
    // nothing was left and pushes a history entry in which a pane still renders
    // a dead block.
    //
    // A positional (index-by-index) compare is too strong: closing a pane
    // shifts every later leaf down an index, so a pane that kept its block
    // reads as "left". With another pane stranded on a tombstone, closing an
    // unrelated pane then replaced instead of pushed, and Back skipped the
    // whole layout.
    //
    // Counts get both right: a block is being left iff strictly fewer panes
    // render it after the navigation than before.
    const nextCounts = countLeavesByBlockId(next)
    for (const [blockId, count] of countLeavesByBlockId(current)) {
      if (count <= (nextCounts.get(blockId) ?? 0)) continue
      if (this.repo.block(blockId).peekRaw()?.deleted === true
        || isBlockConfirmedDeleted(blockId)) return true
    }
    return false
  }

  private handleRowsChanged(rows: readonly BlockData[]): void {
    // While an inbound apply is in flight, a rows event necessarily compares
    // OLD rows against the NEW hash — writing that back would clobber the
    // just-navigated hash (Back silently undone) and the queued reconcile
    // would then apply the clobbered URL. Defer to one pass after the queue
    // drains (see applyCurrentUrl); lastSlots stays put so that pass still
    // sees the divergence.
    if (this.pendingInbound > 0) {
      this.outboundSuppressed = true
      return
    }
    this.outboundGeneration++

    const slots = layoutSlotsFromRows(this.layoutSessionBlock.id, rows)
    if (sameLayoutSlots(this.lastSlots, slots)) return
    this.lastSlots = slots

    // Echo guard by ROUTE EQUIVALENCE, not raw string compare: the current
    // hash may carry `?query` params or unknown slot-context entries that
    // rows can't represent — a raw compare would push over them, erasing
    // them and double-pushing history entries. (viewMode and active DO
    // round-trip through rows now, so they participate in the comparison;
    // `rest` entries never do.)
    const current = parseLayout(this.getHash())
    const sameWorkspace = current.workspaceId === this.workspaceId
    if (sameWorkspace && sameLayoutSlots(current.slots, slots)) return

    // Same carry rule as slot `rest`: the current hash's ws-context (e.g.
    // `;persp=`) has no row representation, so every outbound hash rebuilt
    // from rows must re-attach it — dropping it on a row change would strip
    // the perspective lane off every history entry the projection writes
    // (breaking Back's lane attribution). Skipped on a workspace mismatch:
    // the context belongs to the other workspace's token.
    const outboundSlots = sameWorkspace ? withRestFromUrl(current.slots, slots) : slots
    const nextHash = buildLayoutFromSlots(
      this.workspaceId, outboundSlots, sameWorkspace ? current.wsContext : undefined)
    if (sameWorkspace && sameLayoutSlots(current.slots, slots, 'ignore-active')) {
      // Active-only diff: which pane is focused is not a history entry —
      // rewrite the current one instead of pushing.
      this.replaceHash(nextHash)
    } else if (sameWorkspace && this.leavingDeletedBlock(current.slots, slots)) {
      // The entry we'd be leaving renders a DELETED block, so it is not
      // somewhere the user can meaningfully return to. Pushing would trap
      // them: browser Back lands on the dead page, `PanelContentRecovery`
      // retargets the pane and pushes the replacement again, and the dead
      // entry can never be stepped past. Rewrite it instead.
      this.replaceHash(nextHash)
    } else {
      this.pushHash(nextHash)
    }
    this.listeners.notify()
  }
}
