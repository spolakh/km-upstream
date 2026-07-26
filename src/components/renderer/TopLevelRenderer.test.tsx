// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChangeScope, type User } from '@/data/api'
import type { Block } from '@/data/block'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import { actionContextsFacet } from '@/extensions/core'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { LayoutRootContext, type LayoutRootContextValue } from './layoutRootContext'
import type { FakePanelLayoutProjectionInstance } from '@/utils/test/fakePanelLayoutProjection'

const repoRef = vi.hoisted(() => ({
  current: undefined as Repo | undefined,
}))
const uiStateBlockRef = vi.hoisted(() => ({
  current: undefined as Block | undefined,
}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

vi.mock('@/data/globalState.ts', async () => {
  const actual = await vi.importActual<typeof import('@/data/globalState.js')>('@/data/globalState.ts')
  return {
    ...actual,
    useUIStateBlock: () => {
      if (!uiStateBlockRef.current) throw new Error('test UI state block not initialised')
      return uiStateBlockRef.current
    },
  }
})

// Stand in for the recursive renderer-resolution machinery BlockComponent
// pulls in (useRendererRegistry + the full defaultRenderersFacet chain) —
// this test is about the seam wiring above it, not deep rendering. Mirrors
// the same stand-in used by PanelRenderer.test.tsx / LayoutRenderer.test.tsx.
vi.mock('@/components/BlockComponent.tsx', () => ({
  BlockComponent: ({blockId}: {blockId: string}) => (
    <div data-testid="block-content" data-block-id={blockId}/>
  ),
}))

// Same fake-projection double as usePanelLayoutProjection.test.tsx /
// LayoutSessionHost.test.tsx (fakePanelLayoutProjection.ts): swap the real
// PanelLayoutProjection for an instance-tracking double so this test can
// assert one gets constructed for the root block without touching PowerSync.
const {instances} = vi.hoisted(() => ({
  instances: [] as FakePanelLayoutProjectionInstance[],
}))

vi.mock('@/utils/panelLayoutProjection.js', async () => {
  const {createFakePanelLayoutProjectionClass} = await import('@/utils/test/fakePanelLayoutProjection')
  return {PanelLayoutProjection: createFakePanelLayoutProjectionClass(instances)}
})

// Imported after the mocks above so it picks up the mocked collaborators.
import { TopLevelRenderer } from './TopLevelRenderer'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

describe('TopLevelRenderer / usePanelLayoutProjection wiring', () => {
  let sharedDb: TestDb
  let repo: Repo
  let runtime: FacetRuntime

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })

  beforeEach(async () => {
    instances.length = 0
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({db: sharedDb.db, user: USER}).repo
    repo.setActiveWorkspaceId(WS)
    // TopLevelRenderer activates the GLOBAL action context (useActionContext),
    // which ActiveContextsProvider validates against registered configs — so
    // the runtime needs the real GLOBAL config, same as other renderer tests
    // that exercise useActionContext (e.g. BlockProperties.component.test.tsx).
    runtime = resolveFacetRuntimeSync(
      defaultActionContextConfigs.map(config => actionContextsFacet.of(config, {source: 'test'})),
    )

    await repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Root'})
      await tx.create({id: 'ui-state', workspaceId: WS, parentId: null, orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault, description: 'seed TopLevelRenderer fixture'})

    repoRef.current = repo
    uiStateBlockRef.current = repo.block('ui-state')
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  const renderTopLevel = (block: Block, context: LayoutRootContextValue | null) =>
    render(
      <AppRuntimeContextProvider value={runtime}>
        <LayoutRootContext.Provider value={context}>
          <ActiveContextsProvider>
            <TopLevelRenderer block={block}/>
          </ActiveContextsProvider>
        </LayoutRootContext.Provider>
      </AppRuntimeContextProvider>,
    )

  it('constructs a panel layout projection for the root block via the real TopLevelRenderer + LayoutRootContext seam', async () => {
    const rootBlock = repo.block('root')
    const onLayoutHashChanged = vi.fn()

    renderTopLevel(rootBlock, {rootBlockId: rootBlock.id, onLayoutHashChanged})

    // Confirms the REAL TopLevelRenderer rendered (its own content, not a stub).
    const content = await screen.findByTestId('block-content')
    expect(content.dataset.blockId).toBe('root')

    // This is the assertion that fails if `usePanelLayoutProjection(block)` is
    // deleted from TopLevelRenderer, or if the LayoutRootContext.Provider that
    // feeds it is removed upstream: no projection would ever get constructed.
    expect(instances).toHaveLength(1)
    expect(instances[0].options.layoutSessionBlock).toBe(rootBlock)
    expect(instances[0].options.workspaceId).toBe(WS)
  })

  it('does not construct a projection when no LayoutRootContext is provided (stray layoutBoundary mount)', async () => {
    const rootBlock = repo.block('root')

    renderTopLevel(rootBlock, null)

    await screen.findByTestId('block-content')
    expect(instances).toHaveLength(0)
  })
})
