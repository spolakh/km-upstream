// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetSpatialNavigationForTesting,
  findRecoveryAnchor,
  firstInstanceIn,
  horizontalNeighborPanel,
  lastInstanceIn,
  locateInstance,
  panelById,
  rememberInstancePosition,
  resolveCurrentAnchor,
  stackSiblingPanel,
  verticalNeighbor,
} from '@/plugins/spatial-navigation/walker.js'
import { activeLayoutSessionElement } from '@/utils/layoutSessionDom.js'

// Make `isElementProperlyVisible` produce sensible answers under jsdom:
// real browser rects come from layout, but jsdom never lays out, so
// every element looks "off-screen" by default. Tests opt instances into
// the viewport by tagging them with data-test-visible="true" and rely
// on this mock to translate that hint into a tall rect that the
// production helper recognises as visible. Without the mock, every
// element would read as not-visible and the viewport-aware branch
// would silently fall back to the positional clamp.
const tallVisibleRect = (top: number) =>
  ({
    top,
    bottom: top + 1000,
    left: 0,
    right: 100,
    width: 100,
    height: 1000,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect

const setTestVisible = (el: HTMLElement, visible: boolean): void => {
  if (visible) {
    el.dataset.testVisible = 'true'
    el.getBoundingClientRect = () => tallVisibleRect(50)
  } else {
    delete el.dataset.testVisible
    el.getBoundingClientRect = () =>
      ({
        top: 2000,
        bottom: 3000,
        left: 0,
        right: 100,
        width: 100,
        height: 1000,
        x: 0,
        y: 2000,
        toJSON: () => ({}),
      }) as DOMRect
  }
}

const addVisibilityTarget = (el: HTMLElement): HTMLElement => {
  const target = document.createElement('div')
  target.setAttribute('data-block-visibility-target', 'true')
  el.appendChild(target)
  return target
}

interface InstanceSpec {
  blockId: string
  instance: string
  surface?: string
  entryId?: string
}

interface PanelSpec {
  panelId: string
  instances: InstanceSpec[]
}

type LayoutSpec = ReadonlyArray<
  | {kind: 'panel'; columnId: string; panel: PanelSpec}
  | {kind: 'stack'; columnId: string; panels: PanelSpec[]}
>

const buildPanel = (spec: PanelSpec): HTMLElement => {
  const el = document.createElement('div')
  el.setAttribute('data-panel-id', spec.panelId)
  for (const inst of spec.instances) {
    const block = document.createElement('div')
    block.setAttribute('data-block-nav-item', 'true')
    block.setAttribute('data-block-id', inst.blockId)
    block.setAttribute('data-render-scope-id', inst.instance)
    if (inst.surface) block.setAttribute('data-block-surface', inst.surface)
    if (inst.entryId) block.setAttribute('data-backlink-entry-id', inst.entryId)
    el.appendChild(block)
  }
  return el
}

const makeColumn = (columnId: string, panel: HTMLElement): HTMLElement => {
  const column = document.createElement('div')
  column.setAttribute('data-layout-column-id', columnId)
  column.appendChild(panel)
  return column
}

const buildLayout = (spec: LayoutSpec): HTMLElement => {
  const root = document.createElement('div')
  for (const entry of spec) {
    const column = document.createElement('div')
    column.setAttribute('data-layout-column-id', entry.columnId)
    if (entry.kind === 'panel') {
      column.appendChild(buildPanel(entry.panel))
    } else {
      for (const p of entry.panels) column.appendChild(buildPanel(p))
    }
    root.appendChild(column)
  }
  document.body.appendChild(root)
  return root
}

const findInstance = (instance: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-render-scope-id="${CSS.escape(instance)}"]`)
  if (!el) throw new Error(`instance ${instance} not in DOM`)
  return el
}

const scopeOf = (el: HTMLElement | null | undefined): string | undefined =>
  el?.dataset.renderScopeId

const p1Location = (blockId: string, renderScopeId = `p1:${blockId}`) => ({
  blockId,
  renderScopeId,
})

beforeEach(() => {
  __resetSpatialNavigationForTesting()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('vertical neighbor (h/k)', () => {
  it('walks DOM order within a panel', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {
        panelId: 'p1',
        instances: [
          {blockId: 'A', instance: 'p1:A'},
          {blockId: 'B', instance: 'p1:B'},
          {blockId: 'C', instance: 'p1:C'},
        ],
      }},
    ])
    expect(scopeOf(verticalNeighbor(findInstance('p1:A'), 'down'))).toBe('p1:B')
    expect(scopeOf(verticalNeighbor(findInstance('p1:B'), 'down'))).toBe('p1:C')
    expect(verticalNeighbor(findInstance('p1:C'), 'down')).toBeNull()
    expect(scopeOf(verticalNeighbor(findInstance('p1:B'), 'up'))).toBe('p1:A')
  })

  it('walks into the backlinks surface as just more in-panel instances', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {
        panelId: 'p1',
        instances: [
          {blockId: 'A', instance: 'p1:A', surface: 'outline'},
          {blockId: 'B', instance: 'p1:B', surface: 'outline'},
          {blockId: 'X', instance: 'p1:backlink:e1:X', surface: 'backlink', entryId: 'e1'},
          {blockId: 'Y', instance: 'p1:backlink:e2:Y', surface: 'backlink', entryId: 'e2'},
        ],
      }},
    ])
    expect(scopeOf(verticalNeighbor(findInstance('p1:B'), 'down'))).toBe('p1:backlink:e1:X')
    expect(scopeOf(verticalNeighbor(findInstance('p1:backlink:e1:X'), 'down'))).toBe('p1:backlink:e2:Y')
  })

  it('skips breadcrumb-surface instances when walking', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {
        panelId: 'p1',
        instances: [
          {blockId: 'crumb', instance: 'p1:crumb:1', surface: 'breadcrumb'},
          {blockId: 'A', instance: 'p1:A', surface: 'outline'},
          {blockId: 'B', instance: 'p1:B', surface: 'outline'},
        ],
      }},
    ])
    expect(verticalNeighbor(findInstance('p1:A'), 'up')).toBeNull()
    expect(scopeOf(verticalNeighbor(findInstance('p1:A'), 'down'))).toBe('p1:B')
  })

  it('does not loop when the same block appears twice in backlinks', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {
        panelId: 'p1',
        instances: [
          {blockId: 'A', instance: 'p1:A', surface: 'outline'},
          {blockId: 'X', instance: 'p1:backlink:e1:X', surface: 'backlink', entryId: 'e1'},
          {blockId: 'X', instance: 'p1:backlink:e2:X', surface: 'backlink', entryId: 'e2'},
        ],
      }},
    ])
    // Same block (X) appears twice; distinct render scopes differentiate them.
    expect(scopeOf(verticalNeighbor(findInstance('p1:backlink:e1:X'), 'down')))
      .toBe('p1:backlink:e2:X')
    expect(verticalNeighbor(findInstance('p1:backlink:e2:X'), 'down')).toBeNull()
  })

  it('falls through to a stack-sibling panel below in the same column', () => {
    buildLayout([
      {kind: 'stack', columnId: 'c1', panels: [
        {panelId: 'p-top', instances: [
          {blockId: 'A', instance: 'p-top:A'},
          {blockId: 'B', instance: 'p-top:B'},
        ]},
        {panelId: 'p-bot', instances: [
          {blockId: 'C', instance: 'p-bot:C'},
          {blockId: 'D', instance: 'p-bot:D'},
        ]},
      ]},
    ])
    // Off the bottom of the top stack panel → first instance of bottom panel.
    expect(scopeOf(verticalNeighbor(findInstance('p-top:B'), 'down'))).toBe('p-bot:C')
    // Off the top of the bottom stack panel → last instance of top panel.
    expect(scopeOf(verticalNeighbor(findInstance('p-bot:C'), 'up'))).toBe('p-top:B')
  })

  it('does NOT fall through into a horizontally-adjacent column for k', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {
        panelId: 'p1',
        instances: [{blockId: 'A', instance: 'p1:A'}],
      }},
      {kind: 'panel', columnId: 'c2', panel: {
        panelId: 'p2',
        instances: [{blockId: 'B', instance: 'p2:B'}],
      }},
    ])
    // p1 has no in-panel down target; p2 is in a different column → null.
    expect(verticalNeighbor(findInstance('p1:A'), 'down')).toBeNull()
  })
})

describe('horizontal neighbor panel (j/l)', () => {
  it('moves to the next/prev column panel', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [{blockId: 'A', instance: 'p1:A'}]}},
      {kind: 'panel', columnId: 'c2', panel: {panelId: 'p2', instances: [{blockId: 'B', instance: 'p2:B'}]}},
      {kind: 'panel', columnId: 'c3', panel: {panelId: 'p3', instances: [{blockId: 'C', instance: 'p3:C'}]}},
    ])
    expect(horizontalNeighborPanel(findInstance('p1:A'), 'right')?.dataset.panelId).toBe('p2')
    expect(horizontalNeighborPanel(findInstance('p2:B'), 'right')?.dataset.panelId).toBe('p3')
    expect(horizontalNeighborPanel(findInstance('p3:C'), 'right')).toBeNull()
    expect(horizontalNeighborPanel(findInstance('p2:B'), 'left')?.dataset.panelId).toBe('p1')
  })

  it('skips past stack-mates and enters the top of an adjacent stack column', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [{blockId: 'A', instance: 'p1:A'}]}},
      {kind: 'stack', columnId: 'c2', panels: [
        {panelId: 'p2-top', instances: [{blockId: 'B', instance: 'p2-top:B'}]},
        {panelId: 'p2-bot', instances: [{blockId: 'C', instance: 'p2-bot:C'}]},
      ]},
      {kind: 'panel', columnId: 'c3', panel: {panelId: 'p3', instances: [{blockId: 'D', instance: 'p3:D'}]}},
    ])
    expect(horizontalNeighborPanel(findInstance('p1:A'), 'right')?.dataset.panelId).toBe('p2-top')
    // From inside the stack's bottom panel, j/l moves to c3 — NOT to p2-top.
    expect(horizontalNeighborPanel(findInstance('p2-bot:C'), 'right')?.dataset.panelId).toBe('p3')
  })

  it('no-op when there is only one column', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [{blockId: 'A', instance: 'p1:A'}]}},
    ])
    expect(horizontalNeighborPanel(findInstance('p1:A'), 'right')).toBeNull()
    expect(horizontalNeighborPanel(findInstance('p1:A'), 'left')).toBeNull()
  })
})

describe('horizontal neighbor panel — layout-session scoping (root param)', () => {
  it('does not spill into a hidden warm session\'s columns at the active session\'s boundary', () => {
    // Two warm layout sessions coexist in the DOM (LayoutSessionHost
    // keep-alive, see layoutSessionDom.ts): the active session has 2
    // columns, the hidden one has its own. An unscoped, document-wide
    // orderedColumns query can't tell them apart — "the column after the
    // active session's last" resolves to the hidden session's first column,
    // which is exactly the bug moveHorizontal (actions.ts) hit.
    const activeSession = document.createElement('div')
    activeSession.setAttribute('data-layout-session-id', 'session-active')
    activeSession.setAttribute('data-layout-session-active', '')
    activeSession.appendChild(makeColumn('a-c1', buildPanel({panelId: 'a-p1', instances: [{blockId: 'A', instance: 'a-p1:A'}]})))
    activeSession.appendChild(makeColumn('a-c2', buildPanel({panelId: 'a-p2', instances: [{blockId: 'B', instance: 'a-p2:B'}]})))
    document.body.appendChild(activeSession)

    const hiddenSession = document.createElement('div')
    hiddenSession.setAttribute('data-layout-session-id', 'session-hidden')
    hiddenSession.appendChild(makeColumn('h-c1', buildPanel({panelId: 'h-p1', instances: [{blockId: 'C', instance: 'h-p1:C'}]})))
    document.body.appendChild(hiddenSession)

    // Unscoped (document-wide, the default `root` param): wrongly resolves
    // past the active session's edge into the hidden session's column.
    expect(horizontalNeighborPanel(findInstance('a-p2:B'), 'right')?.dataset.panelId).toBe('h-p1')

    // Scoped to the active session root (activeLayoutSessionElement() — what
    // moveHorizontal now threads through): correctly bounded, null at the
    // true edge instead of a false destination.
    const root = activeLayoutSessionElement() ?? document
    expect(horizontalNeighborPanel(findInstance('a-p2:B'), 'right', root)).toBeNull()
  })
})

describe('stackSiblingPanel', () => {
  it('returns null for single-panel columns', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [{blockId: 'A', instance: 'p1:A'}]}},
    ])
    expect(stackSiblingPanel(panelById('p1')!, 'down')).toBeNull()
  })

  it('returns the next/prev panel in a stacked column', () => {
    buildLayout([
      {kind: 'stack', columnId: 'c1', panels: [
        {panelId: 'p-top', instances: [{blockId: 'A', instance: 'p-top:A'}]},
        {panelId: 'p-mid', instances: [{blockId: 'B', instance: 'p-mid:B'}]},
        {panelId: 'p-bot', instances: [{blockId: 'C', instance: 'p-bot:C'}]},
      ]},
    ])
    expect(stackSiblingPanel(panelById('p-top')!, 'down')?.dataset.panelId).toBe('p-mid')
    expect(stackSiblingPanel(panelById('p-mid')!, 'down')?.dataset.panelId).toBe('p-bot')
    expect(stackSiblingPanel(panelById('p-bot')!, 'down')).toBeNull()
    expect(stackSiblingPanel(panelById('p-bot')!, 'up')?.dataset.panelId).toBe('p-mid')
  })
})

describe('locateInstance recovery', () => {
  it('tier 1: exact location match', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'A', instance: 'p1:A'},
        {blockId: 'B', instance: 'p1:B'},
      ]}},
    ])
    const result = locateInstance('p1', {focusedLocation: p1Location('B')})
    expect(scopeOf(result)).toBe('p1:B')
  })

  it('tier 1: disambiguates duplicate logical blocks by render scope', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'A', instance: 'p1:outline:A'},
        {blockId: 'A', instance: 'p1:embed:parent:0:A'},
      ]}},
    ])
    const result = locateInstance('p1', {
      focusedLocation: {blockId: 'A', renderScopeId: 'p1:embed:parent:0:A'},
    })
    expect(scopeOf(result)).toBe('p1:embed:parent:0:A')
  })

  it("tier 2: positional clamp picks 'block previously below' after a delete", () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'X', instance: 'p1:X'},
        {blockId: 'Y', instance: 'p1:Y'},
        {blockId: 'Z', instance: 'p1:Z'},
      ]}},
    ])
    // User was sitting on Y at idx 1.
    rememberInstancePosition('p1', findInstance('p1:Y'))
    // Y disappears; the remaining list shifts up.
    findInstance('p1:Y').remove()
    // clamp(1, 0, 1) lands on the block that's now at idx 1 — Z, which
    // was previously immediately below Y.
    const result = locateInstance('p1', {focusedLocation: p1Location('Y')})
    expect(scopeOf(result)).toBe('p1:Z')
  })

  it('tier 2: ignores a stale hint that points to a different rendered location', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'X', instance: 'p1:X'},
        {blockId: 'Y', instance: 'p1:Y'},
        {blockId: 'Z', instance: 'p1:Z'},
      ]}},
    ])
    // Hint records Y, but we're recovering for an unrelated 'A' that
    // never sat in this panel. Falls through to tier 3 (first instance).
    rememberInstancePosition('p1', findInstance('p1:Y'))
    const result = locateInstance('p1', {focusedLocation: {blockId: 'A', renderScopeId: 'gone'}})
    expect(scopeOf(result)).toBe('p1:X')
  })

  it('falls back to the first instance when no hints are stored', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'X', instance: 'p1:X'},
        {blockId: 'Y', instance: 'p1:Y'},
    ]}},
    ])
    const result = locateInstance('p1', {})
    expect(scopeOf(result)).toBe('p1:X')
  })

  it('returns null when the panel has no instances', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: []}},
    ])
    expect(locateInstance('p1', {focusedLocation: p1Location('A')})).toBeNull()
  })

  it('returns null when the panel is not in the DOM', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [{blockId: 'A', instance: 'p1:A'}]}},
    ])
    expect(locateInstance('not-mounted', {})).toBeNull()
  })
})

describe('findRecoveryAnchor (proactive disappear-handler)', () => {
  it('baseline: walks to the block that was previously below', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'X', instance: 'p1:X'},
        {blockId: 'Y', instance: 'p1:Y'},
        {blockId: 'Z', instance: 'p1:Z'},
      ]}},
    ])
    rememberInstancePosition('p1', findInstance('p1:Y'))
    findInstance('p1:Y').remove()
    setTestVisible(findInstance('p1:Z'), true)
    expect(findRecoveryAnchor('p1', p1Location('Y'))?.dataset.blockId).toBe('Z')
  })

  it('falls to "previously above" when the focused block was last in the list', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'A', instance: 'p1:A'},
        {blockId: 'B', instance: 'p1:B'},
      ]}},
    ])
    rememberInstancePosition('p1', findInstance('p1:B'))
    findInstance('p1:B').remove()
    // B was last — no next sibling — so the recovery target is A.
    setTestVisible(findInstance('p1:A'), true)
    expect(findRecoveryAnchor('p1', p1Location('B'))?.dataset.blockId).toBe('A')
  })

  it('walks the ancestor chain when both siblings disappear (collapse case)', () => {
    // Build a nested DOM manually — the panel hosts a parent block,
    // and the parent contains three children (c1, X, c3). When the
    // parent collapses, all three children unmount together; neither
    // sibling survives but the parent itself does.
    const panel = document.createElement('div')
    panel.setAttribute('data-panel-id', 'p1')

    const parent = document.createElement('div')
    parent.setAttribute('data-block-id', 'parent')
    parent.setAttribute('data-block-nav-item', 'true')
    parent.setAttribute('data-render-scope-id', 'p1:parent')
    parent.setAttribute('data-block-surface', 'outline')
    panel.appendChild(parent)

    for (const blockId of ['c1', 'X', 'c3']) {
      const child = document.createElement('div')
      child.setAttribute('data-block-id', blockId)
      child.setAttribute('data-block-nav-item', 'true')
      child.setAttribute('data-render-scope-id', `p1:${blockId}`)
      child.setAttribute('data-block-surface', 'outline')
      parent.appendChild(child)
    }

    document.body.appendChild(panel)

    rememberInstancePosition('p1', findInstance('p1:X'))

    // Collapse: parent stays, every child unmounts.
    for (const c of ['c1', 'X', 'c3']) findInstance(`p1:${c}`).remove()

    setTestVisible(findInstance('p1:parent'), true)
    expect(findRecoveryAnchor('p1', p1Location('X'))?.dataset.blockId).toBe('parent')
  })

  it('returns null when there is no hint about the focused block', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'A', instance: 'p1:A'},
        {blockId: 'B', instance: 'p1:B'},
      ]}},
    ])
    // No prior rememberInstancePosition — proactive recovery should
    // stay quiet rather than steal focus to whatever rendered first.
    expect(findRecoveryAnchor('p1', p1Location('A'))).toBeNull()
  })

  it('returns null when the hint is for a different block', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'A', instance: 'p1:A'},
        {blockId: 'B', instance: 'p1:B'},
      ]}},
    ])
    rememberInstancePosition('p1', findInstance('p1:A'))
    expect(findRecoveryAnchor('p1', p1Location('never-mounted'))).toBeNull()
  })

  it('returns null when the panel has no instances left', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'A', instance: 'p1:A'},
      ]}},
    ])
    rememberInstancePosition('p1', findInstance('p1:A'))
    findInstance('p1:A').remove()
    // Panel is empty after removal — nothing reasonable to recover to.
    expect(findRecoveryAnchor('p1', p1Location('A'))).toBeNull()
  })

  it("deleting a parent block: sibling walk crosses the subtree to the data-tree next sibling", () => {
    // top
    //   above
    //   parent           ← focused, deleted
    //     child
    //     c2
    //   below
    // The previous "DOM-flat next" logic would have picked `child`
    // (the first descendant) which also disappears, falling back to
    // `above` (prev). With same-depth siblings, `parent.next = below`
    // (the next child of `top`), so recovery picks that directly.
    const panel = document.createElement('div')
    panel.setAttribute('data-panel-id', 'p1')

    const mkInstance = (blockId: string): HTMLElement => {
      const el = document.createElement('div')
      el.setAttribute('data-block-id', blockId)
      el.setAttribute('data-block-nav-item', 'true')
      el.setAttribute('data-render-scope-id', `p1:${blockId}`)
      el.setAttribute('data-block-surface', 'outline')
      return el
    }

    const top = mkInstance('top')
    panel.appendChild(top)
    top.appendChild(mkInstance('above'))
    const parent = mkInstance('parent')
    top.appendChild(parent)
    parent.appendChild(mkInstance('child'))
    parent.appendChild(mkInstance('c2'))
    top.appendChild(mkInstance('below'))

    document.body.appendChild(panel)

    rememberInstancePosition('p1', findInstance('p1:parent'))
    findInstance('p1:parent').remove()

    setTestVisible(findInstance('p1:below'), true)
    expect(findRecoveryAnchor('p1', p1Location('parent'))?.dataset.blockId).toBe('below')
  })

  it("only-child collapse: same-depth siblings are empty so the ancestor wins", () => {
    // top
    //   above
    //   parent
    //     X              ← focused (only child)
    //   below
    // Without same-depth sibling semantics, X's DOM-flat next would
    // be `below` (sitting alive even after the collapse), and we'd
    // wrongly land there. With same-depth: X has no siblings inside
    // parent, so we walk up to parent and focus that — matching the
    // multi-child collapse case.
    const panel = document.createElement('div')
    panel.setAttribute('data-panel-id', 'p1')

    const mkInstance = (blockId: string): HTMLElement => {
      const el = document.createElement('div')
      el.setAttribute('data-block-id', blockId)
      el.setAttribute('data-block-nav-item', 'true')
      el.setAttribute('data-render-scope-id', `p1:${blockId}`)
      el.setAttribute('data-block-surface', 'outline')
      return el
    }

    const top = mkInstance('top')
    panel.appendChild(top)
    top.appendChild(mkInstance('above'))
    const parent = mkInstance('parent')
    top.appendChild(parent)
    parent.appendChild(mkInstance('X'))
    top.appendChild(mkInstance('below'))

    document.body.appendChild(panel)

    rememberInstancePosition('p1', findInstance('p1:X'))
    findInstance('p1:X').remove()

    setTestVisible(findInstance('p1:parent'), true)
    expect(findRecoveryAnchor('p1', p1Location('X'))?.dataset.blockId).toBe('parent')
  })

  it('does not recover from a backlink to its enclosing outline DOM ancestor', () => {
    const panel = document.createElement('div')
    panel.setAttribute('data-panel-id', 'p1')

    const top = document.createElement('div')
    top.setAttribute('data-block-id', 'top')
    top.setAttribute('data-block-nav-item', 'true')
    top.setAttribute('data-render-scope-id', 'p1:top')
    top.setAttribute('data-block-surface', 'outline')
    panel.appendChild(top)

    const backlink = document.createElement('div')
    backlink.setAttribute('data-block-id', 'X')
    backlink.setAttribute('data-block-nav-item', 'true')
    backlink.setAttribute('data-render-scope-id', 'p1:backlink:X')
    backlink.setAttribute('data-block-surface', 'backlink')
    top.appendChild(backlink)

    document.body.appendChild(panel)

    rememberInstancePosition('p1', backlink)
    backlink.remove()
    setTestVisible(top, true)

    expect(findRecoveryAnchor('p1', {blockId: 'X', renderScopeId: 'p1:backlink:X'})).toBeNull()
  })

  it('does not treat a visible ancestor shell as recoverable when its own visibility target is off-screen', () => {
    const panel = document.createElement('div')
    panel.setAttribute('data-panel-id', 'p1')

    const parent = document.createElement('div')
    parent.setAttribute('data-block-id', 'parent')
    parent.setAttribute('data-block-nav-item', 'true')
    parent.setAttribute('data-render-scope-id', 'p1:parent')
    parent.setAttribute('data-block-surface', 'outline')
    const parentVisibilityTarget = addVisibilityTarget(parent)
    panel.appendChild(parent)

    const child = document.createElement('div')
    child.setAttribute('data-block-id', 'X')
    child.setAttribute('data-block-nav-item', 'true')
    child.setAttribute('data-render-scope-id', 'p1:X')
    child.setAttribute('data-block-surface', 'outline')
    parent.appendChild(child)

    document.body.appendChild(panel)

    rememberInstancePosition('p1', child)
    child.remove()
    setTestVisible(parent, true)
    setTestVisible(parentVisibilityTarget, false)

    expect(findRecoveryAnchor('p1', p1Location('X'))).toBeNull()
  })

  it('falls back to positional clamp when neighbors and ancestors are all gone', () => {
    // Edge case: build a scenario where prev/next/ancestor are all
    // missing but a positional fallback can still land somewhere.
    // We achieve this by remembering position with one DOM, then
    // swapping the panel to a completely different set of blocks.
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'before', instance: 'p1:before'},
        {blockId: 'X', instance: 'p1:X'},
        {blockId: 'after', instance: 'p1:after'},
      ]}},
    ])
    rememberInstancePosition('p1', findInstance('p1:X'))

    // Replace the panel's contents — none of the original neighbors
    // survive, but the panel itself still has instances.
    document.body.innerHTML = ''
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'fresh-a', instance: 'p1:fresh-a'},
        {blockId: 'fresh-b', instance: 'p1:fresh-b'},
      ]}},
    ])

    // X was at idx 1; clamp(1, 0, 1) = 1 = fresh-b.
    setTestVisible(findInstance('p1:fresh-b'), true)
    expect(findRecoveryAnchor('p1', p1Location('X'))?.dataset.blockId).toBe('fresh-b')
  })
})

describe('findRecoveryAnchor: viewport-aware tier 4', () => {
  it('keeps the positional clamp when its target is already in the viewport', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'before', instance: 'p1:before'},
        {blockId: 'X', instance: 'p1:X'},
        {blockId: 'after', instance: 'p1:after'},
      ]}},
    ])
    rememberInstancePosition('p1', findInstance('p1:X'))

    document.body.innerHTML = ''
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'fresh-a', instance: 'p1:fresh-a'},
        {blockId: 'fresh-b', instance: 'p1:fresh-b'},
      ]}},
    ])
    // Position clamp lands on fresh-b (idx 1 → clamp(1,0,1)=1). Mark
    // it visible so the viewport-aware branch keeps it.
    setTestVisible(findInstance('p1:fresh-b'), true)
    setTestVisible(findInstance('p1:fresh-a'), false)

    expect(findRecoveryAnchor('p1', p1Location('X'))?.dataset.blockId).toBe('fresh-b')
  })

  it('switches to the topmost in-viewport instance when the clamp target is off-screen', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'before', instance: 'p1:before'},
        {blockId: 'X', instance: 'p1:X'},
        {blockId: 'after', instance: 'p1:after'},
      ]}},
    ])
    rememberInstancePosition('p1', findInstance('p1:X'))

    document.body.innerHTML = ''
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'top-offscreen', instance: 'p1:top-offscreen'},
        {blockId: 'middle-visible', instance: 'p1:middle-visible'},
        {blockId: 'bottom-offscreen', instance: 'p1:bottom-offscreen'},
      ]}},
    ])
    // Clamp index 1 = middle-visible, but pretend that one's
    // off-screen and the bottom one is visible. We expect to land on
    // bottom-offscreen (the first visible in DOM order) rather than
    // the clamp target. The point of the fallback: don't pick a
    // recovery target that will trigger scrollIntoView.
    setTestVisible(findInstance('p1:top-offscreen'), false)
    setTestVisible(findInstance('p1:middle-visible'), false)
    setTestVisible(findInstance('p1:bottom-offscreen'), true)

    expect(findRecoveryAnchor('p1', p1Location('X'))?.dataset.blockId).toBe('bottom-offscreen')
  })

  it('returns null when no same-surface instance is in the viewport', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'before', instance: 'p1:before'},
        {blockId: 'X', instance: 'p1:X'},
        {blockId: 'after', instance: 'p1:after'},
      ]}},
    ])
    rememberInstancePosition('p1', findInstance('p1:X'))

    document.body.innerHTML = ''
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'fresh-a', instance: 'p1:fresh-a'},
        {blockId: 'fresh-b', instance: 'p1:fresh-b'},
      ]}},
    ])
    // No element opted into visibility; default jsdom-zero rects keep
    // them all "not visible". Recovery must stay quiet rather than
    // selecting an off-screen target that would trigger scrollIntoView.
    expect(findRecoveryAnchor('p1', p1Location('X'))).toBeNull()
  })
})

describe('resolveCurrentAnchor', () => {
  it('returns the live focused instance when present', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'A', instance: 'p1:A'},
        {blockId: 'B', instance: 'p1:B'},
      ]}},
    ])
    expect(scopeOf(resolveCurrentAnchor('p1', p1Location('A')))).toBe('p1:A')
  })

  it('falls back to the recovery anchor when the focused block is missing', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'A', instance: 'p1:A'},
        {blockId: 'B', instance: 'p1:B'},
        {blockId: 'C', instance: 'p1:C'},
      ]}},
    ])
    // User was on B; B disappears. Recovery should land on C (next
    // sibling), so resolveCurrentAnchor returns C even though B is
    // what was asked for.
    rememberInstancePosition('p1', findInstance('p1:B'))
    findInstance('p1:B').remove()
    setTestVisible(findInstance('p1:C'), true)

    expect(resolveCurrentAnchor('p1', p1Location('B'))?.dataset.blockId).toBe('C')
  })

  it('returns null when no live instance and no hint', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'A', instance: 'p1:A'},
      ]}},
    ])
    // No hint stored; missing block has nothing to recover to.
    expect(resolveCurrentAnchor('p1', p1Location('never-seen'))).toBeNull()
  })

  it('returns null when the panel is not mounted', () => {
    expect(resolveCurrentAnchor('no-such-panel', {blockId: 'whatever', renderScopeId: 'whatever'})).toBeNull()
  })

  it('returns null for an undefined focused block id', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'A', instance: 'p1:A'},
      ]}},
    ])
    expect(resolveCurrentAnchor('p1', undefined)).toBeNull()
  })
})

describe('firstInstanceIn / lastInstanceIn', () => {
  it('returns first and last navigable instances', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'crumb', instance: 'p1:crumb', surface: 'breadcrumb'},
        {blockId: 'A', instance: 'p1:A'},
        {blockId: 'B', instance: 'p1:B'},
      ]}},
    ])
    const panel = panelById('p1')!
    expect(scopeOf(firstInstanceIn(panel))).toBe('p1:A')
    expect(scopeOf(lastInstanceIn(panel))).toBe('p1:B')
  })
})
