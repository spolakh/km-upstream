// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { cleanup, render } from '@testing-library/react'
import type { Block } from '@/data/block'
import type { FakePanelLayoutProjectionInstance } from '@/utils/test/fakePanelLayoutProjection'

interface FakeProjectionOptions {
  repo: unknown
  workspaceId: string
  layoutSessionBlock: Block
}

// Self-contained (no imports referenced) — see fakePanelLayoutProjection.ts's
// call-site doc comment for why the class itself is wired up separately,
// through a dynamic import in the vi.mock factory below.
const {instances, callOrder} = vi.hoisted(() => ({
  instances: [] as FakePanelLayoutProjectionInstance[],
  callOrder: [] as string[],
}))

vi.mock('@/utils/panelLayoutProjection.js', async () => {
  const {createFakePanelLayoutProjectionClass} = await import('@/utils/test/fakePanelLayoutProjection')
  return {PanelLayoutProjection: createFakePanelLayoutProjectionClass(instances, callOrder)}
})

import { usePanelLayoutProjection } from '@/hooks/usePanelLayoutProjection.js'
import { LayoutRootContext, type LayoutRootContextValue } from '@/components/renderer/layoutRootContext.js'

const ROOT_ID = 'layout-session-1'
const fakeRepo = {activeWorkspaceId: 'ws-1' as string | null}
const rootBlock = {id: ROOT_ID, repo: fakeRepo} as unknown as Block
const otherBlock = {id: 'other-block', repo: fakeRepo} as unknown as Block

const Probe = ({block}: {block: Block}) => {
  usePanelLayoutProjection(block)
  return null
}

const renderProbe = (
  block: Block,
  context: LayoutRootContextValue | null,
  {strict = false}: {strict?: boolean} = {},
) => {
  const tree = (
    <LayoutRootContext.Provider value={context}>
      <Probe block={block}/>
    </LayoutRootContext.Provider>
  )
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree)
}

beforeEach(() => {
  instances.length = 0
  callOrder.length = 0
  fakeRepo.activeWorkspaceId = 'ws-1'
})

afterEach(() => cleanup())

describe('usePanelLayoutProjection', () => {
  it('no-ops without a LayoutRootContext', () => {
    renderProbe(rootBlock, null)
    expect(instances).toHaveLength(0)
  })

  it('no-ops for a block that is not the layout root (stray layoutBoundary mounts)', () => {
    renderProbe(otherBlock, {rootBlockId: ROOT_ID, onLayoutHashChanged: vi.fn()})
    expect(instances).toHaveLength(0)
  })

  it('no-ops when no workspace is active yet', () => {
    fakeRepo.activeWorkspaceId = null
    renderProbe(rootBlock, {rootBlockId: ROOT_ID, onLayoutHashChanged: vi.fn()})
    expect(instances).toHaveLength(0)
  })

  it('constructs, subscribes, starts, and calls onLayoutHashChanged for the root block', async () => {
    const onLayoutHashChanged = vi.fn()
    const view = renderProbe(rootBlock, {rootBlockId: ROOT_ID, onLayoutHashChanged})

    expect(instances).toHaveLength(1)
    const projection = instances[0]
    expect(projection.options as FakeProjectionOptions).toEqual({
      repo: fakeRepo,
      workspaceId: 'ws-1',
      layoutSessionBlock: rootBlock,
    })
    expect(projection.started).toBe(true)
    // subscribe() MUST precede start(): start() can resolve as early as the
    // same microtask, and any change it observes before a listener is
    // attached is lost — so subscribing after starting would silently drop
    // the earliest projection notifications. applyCurrentUrl() follows
    // start(): pushState fires no hash event, so the just-started projection
    // reconciles the current URL exactly once, explicitly (a no-op on the
    // boot path — pinned in panelLayoutProjection.test.ts).
    await vi.waitFor(() => expect(callOrder).toEqual(['subscribe', 'start', 'applyCurrentUrl']))
    expect(projection.applyCurrentUrlCalls).toBe(1)
    // the initial hash sync fires AFTER the URL reconcile resolved.
    await vi.waitFor(() => expect(onLayoutHashChanged).toHaveBeenCalledTimes(1))

    // Projection change notifications flow to the same callback.
    projection.subscribers.forEach(cb => cb())
    expect(onLayoutHashChanged).toHaveBeenCalledTimes(2)

    view.unmount()
    expect(projection.unsubscribed).toBe(true)
    expect(projection.disposed).toBe(true)
  })

  it('survives a StrictMode double-mount without leaking the first projection', async () => {
    const onLayoutHashChanged = vi.fn()
    const view = renderProbe(
      rootBlock,
      {rootBlockId: ROOT_ID, onLayoutHashChanged},
      {strict: true},
    )

    // mount → cleanup → mount: two instances, only the second stays live.
    expect(instances).toHaveLength(2)
    const [first, second] = instances
    expect(first.disposed).toBe(true)
    expect(second.disposed).toBe(false)

    // The torn-down first instance's late start() resolution must NOT fire
    // the callback — only the live one syncs the hash. It must not apply
    // the URL either (a dead projection reconciling rows would race the
    // live one).
    await vi.waitFor(() => expect(onLayoutHashChanged).toHaveBeenCalled())
    expect(onLayoutHashChanged).toHaveBeenCalledTimes(1)
    expect(first.applyCurrentUrlCalls).toBe(0)
    expect(second.applyCurrentUrlCalls).toBe(1)

    view.unmount()
    expect(second.disposed).toBe(true)
  })
})
