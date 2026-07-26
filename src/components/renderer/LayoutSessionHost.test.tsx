// @vitest-environment happy-dom
/**
 * LayoutSessionHost — the keep-alive host for the layout-sessions
 * container. Pins the PR-2 contract:
 *
 *   - TWO ID DOMAINS: the warm set / ClientContext hold session KEYS;
 *     everything block-shaped the host renders (BlockComponent,
 *     LayoutRootContext.rootBlockId, data-layout-session-id, the
 *     layoutSessionBlockId context override) is the DERIVED session
 *     block id (`layoutSessionBlockIdForKey`) — the raw key never
 *     reaches a block-id consumer;
 *   - N warm sessions stay MOUNTED: active one visible + marked
 *     (`data-layout-session-active`), inactive ones hidden under
 *     `<Activity mode="hidden">` (display:none) and `inert`;
 *   - switching via repo.setActiveLayoutSessionId re-points reactively;
 *   - stable keys: the SAME DOM subtree survives a switch away and back
 *     (node identity — the keep-alive itself);
 *   - LRU eviction: the warm set honors the desktop/mobile caps and
 *     evicting unmounts; a cap SHRINKING mid-session (desktop → mobile)
 *     converges the warm set down without remounting the surviving
 *     (active) subtree;
 *   - container-id recursion guard: a derived session block id equal to
 *     the CONTAINER's own id is skipped rather than rendered (would
 *     recurse into another LayoutSessionHost for the same block via the
 *     ambient layoutBoundary/panelId context). Unreachable through the
 *     real uuidv5 derivation, so the test forces it via a derivation
 *     override;
 *   - default-off: canRender claims exactly the deterministic
 *     layout-sessions container id at a root mount — a SESSION block (or
 *     any other block) still resolves to TopLevelRenderer, so with App
 *     mounting the session block the host never engages;
 *   - single projection liveness: with warm sessions rendering through
 *     `usePanelLayoutProjection`, exactly ONE projection is live, bound
 *     to the ACTIVE session's BLOCK id; a switch disposes the old and
 *     constructs the new (the re-pointed LayoutRootContext + Activity
 *     effect teardown agreeing, per the PR-1 seam), and the incoming
 *     projection reconciles the current URL once (the P2 apply-on-start).
 *
 * The session keys here live in the PRODUCTION domain (ClientContext
 * values fed through repo.setActiveLayoutSessionId) and every expected
 * block id goes through the real layoutSessionBlockIdForKey — the
 * original suite fabricated self-consistent ids in ONE domain, which is
 * exactly how the key-as-block-id bug slipped past it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, type RenderResult } from '@testing-library/react'

const mobileRef = vi.hoisted(() => ({current: false}))
vi.mock('@/utils/react.js', async importOriginal => ({
  ...(await importOriginal<typeof import('@/utils/react.js')>()),
  useIsMobile: () => mobileRef.current,
}))

// Switchable BlockComponent stand-in: a plain stub for the host-shape tests,
// a projection probe for the single-liveness tests. Mirrors the stand-in
// TopLevelRenderer.test.tsx uses — these tests are about the host wiring,
// not deep block rendering.
const blockComponentImpl = vi.hoisted(() => ({
  current: null as null | ((props: {blockId: string}) => React.ReactElement | null),
}))
vi.mock('@/components/BlockComponent.tsx', () => ({
  BlockComponent: (props: {blockId: string}) => blockComponentImpl.current!(props),
}))

// Same fake-projection double as usePanelLayoutProjection.test.tsx /
// TopLevelRenderer.test.tsx (fakePanelLayoutProjection.ts).
// Spread importOriginal: LayoutRenderer (pulled in via defaultRenderers)
// imports other names from this module, which must stay real.
const {instances} = vi.hoisted(() => ({
  instances: [] as FakePanelLayoutProjectionInstance[],
}))
vi.mock('@/utils/panelLayoutProjection.js', async importOriginal => {
  const {createFakePanelLayoutProjectionClass} = await import('@/utils/test/fakePanelLayoutProjection')
  return {
    ...(await importOriginal<typeof import('@/utils/panelLayoutProjection.js')>()),
    PanelLayoutProjection: createFakePanelLayoutProjectionClass(instances),
  }
})

// Passthrough wrapper over the REAL key→block-id derivation with a per-test
// override hook. Only the recursion-guard test sets the override (the
// container-id collision is unreachable through the real uuidv5 formula);
// with the override null, every consumer — the host included — runs the
// production derivation, so the mapping pins below exercise the real thing.
const sessionBlockIdOverride = vi.hoisted(() => ({
  current: null as null | ((workspaceId: string, userId: string, sessionKey: string) => string),
}))
vi.mock('@/data/stateBlocks.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@/data/stateBlocks.js')>()
  return {
    ...actual,
    layoutSessionBlockIdForKey: (workspaceId: string, userId: string, sessionKey: string) =>
      sessionBlockIdOverride.current?.(workspaceId, userId, sessionKey)
      ?? actual.layoutSessionBlockIdForKey(workspaceId, userId, sessionKey),
  }
})

import { ClientContext } from '@/data/clientContext'
import type { Repo } from '@/data/repo'
import type { FakePanelLayoutProjectionInstance } from '@/utils/test/fakePanelLayoutProjection'
import type { Block } from '@/data/block'
import { LayoutRootContext } from './layoutRootContext'
import { usePanelLayoutProjection } from '@/hooks/usePanelLayoutProjection.js'
import {
  DESKTOP_WARM_SESSION_CAP,
  LayoutSessionHost,
  MOBILE_WARM_SESSION_CAP,
} from './LayoutSessionHost'
import { TopLevelRenderer } from './TopLevelRenderer'
import { defaultRendererContributions } from '@/extensions/defaultRenderers'

// The UNWRAPPED derivations, for expected values: expectations must not
// flow through the mocked module (the guard test's override would taint
// them, and a wrapper computing expectations for itself proves nothing).
const {layoutSessionBlockIdForKey, layoutSessionsContainerBlockId} =
  await vi.importActual<typeof import('@/data/stateBlocks.js')>('@/data/stateBlocks.js')

const WS = 'ws-1'
const USER = {id: 'user-1'}
const CONTAINER_ID = layoutSessionsContainerBlockId(WS, USER.id)
/** Expected session BLOCK id for a session KEY — the production mapping. */
const blockIdFor = (sessionKey: string): string =>
  layoutSessionBlockIdForKey(WS, USER.id, sessionKey)

/** The host touches exactly `block.repo.client` / `activeWorkspaceId` /
 *  `block()` — a real ClientContext behind a minimal fake repo keeps this
 *  a unit test of the host, not a Repo construction exercise. `block()`
 *  memoizes facades so effect deps keyed on block identity stay stable. */
const makeRepo = (): Repo => {
  const client = new ClientContext({user: USER})
  const blocks = new Map<string, Block>()
  const repo = {
    client,
    activeWorkspaceId: WS,
    block(id: string): Block {
      let block = blocks.get(id)
      if (!block) {
        block = {id, repo} as unknown as Block
        blocks.set(id, block)
      }
      return block
    },
    setActiveLayoutSessionId(id: string | null): void {
      client.setActiveLayoutSessionId(id)
    },
  }
  return repo as unknown as Repo
}

const onLayoutHashChanged = vi.fn()

const renderHost = (repo: Repo): RenderResult =>
  render(
    <LayoutRootContext.Provider value={{rootBlockId: CONTAINER_ID, onLayoutHashChanged}}>
      <LayoutSessionHost block={repo.block(CONTAINER_ID)}/>
    </LayoutRootContext.Provider>,
  )

/** Look up a warm session's wrapper by its KEY — resolved through the
 *  production key→block-id mapping (the DOM carries block ids). */
const wrapperFor = (view: RenderResult, sessionKey: string): HTMLElement | null =>
  view.container.querySelector<HTMLElement>(`[data-layout-session-id="${blockIdFor(sessionKey)}"]`)

const contentFor = (wrapper: HTMLElement, sessionKey: string): Element | null =>
  wrapper.querySelector(`[data-block-id="${blockIdFor(sessionKey)}"]`)

const activate = (repo: Repo, sessionKey: string): Promise<void> =>
  act(async () => repo.setActiveLayoutSessionId(sessionKey))

beforeEach(() => {
  mobileRef.current = false
  instances.length = 0
  sessionBlockIdOverride.current = null
  onLayoutHashChanged.mockClear()
  blockComponentImpl.current = ({blockId}) => (
    <div data-testid="session-content" data-block-id={blockId}/>
  )
})

afterEach(() => cleanup())

describe('key → session-block-id mapping', () => {
  it('renders the DERIVED session block id everywhere — the raw session key reaches no block-id consumer', async () => {
    const repo = makeRepo()
    repo.setActiveLayoutSessionId('session-a')
    const view = renderHost(repo)

    const derived = blockIdFor('session-a')
    expect(derived).not.toBe('session-a') // the domains genuinely differ

    // Wrapper + BlockComponent both carry the derived BLOCK id…
    const wrapper = wrapperFor(view, 'session-a')!
    expect(wrapper).toBeTruthy()
    expect(contentFor(wrapper, 'session-a')).toBeTruthy()
    // …and the raw KEY appears nowhere a block id is expected.
    expect(view.container.querySelector('[data-layout-session-id="session-a"]')).toBeNull()
    expect(view.container.querySelector('[data-block-id="session-a"]')).toBeNull()
  })
})

describe('warm set rendering', () => {
  it('keeps switched-away sessions mounted: active visible + marked, inactive hidden + inert', async () => {
    const repo = makeRepo()
    repo.setActiveLayoutSessionId('session-a')
    const view = renderHost(repo)

    const wrapperA = wrapperFor(view, 'session-a')!
    expect(wrapperA.hasAttribute('data-layout-session-active')).toBe(true)
    expect(wrapperA.hasAttribute('inert')).toBe(false)
    expect(contentFor(wrapperA, 'session-a')).toBeTruthy()

    await activate(repo, 'session-b')

    // Both sessions are in the DOM — the switch did not unmount A…
    const wrapperB = wrapperFor(view, 'session-b')!
    expect(wrapperFor(view, 'session-a')).toBe(wrapperA)
    expect(contentFor(wrapperA, 'session-a')).toBeTruthy()
    // …but only B is active/visible; A is Activity-hidden and inert.
    expect(wrapperB.hasAttribute('data-layout-session-active')).toBe(true)
    expect(wrapperB.hasAttribute('inert')).toBe(false)
    expect(wrapperA.hasAttribute('data-layout-session-active')).toBe(false)
    expect(wrapperA.hasAttribute('inert')).toBe(true)
    expect(wrapperA.style.display).toBe('none')
    expect(wrapperB.style.display).not.toBe('none')
    // Exactly one active marker exists (the activeLayoutSessionElement contract).
    expect(view.container.querySelectorAll('[data-layout-session-active]')).toHaveLength(1)
  })

  it('preserves DOM node identity across switch away and back (stable keys)', async () => {
    const repo = makeRepo()
    repo.setActiveLayoutSessionId('session-a')
    const view = renderHost(repo)
    const wrapperA = wrapperFor(view, 'session-a')!
    const contentA = contentFor(wrapperA, 'session-a')!

    await activate(repo, 'session-b')
    await activate(repo, 'session-a')

    // Same elements — the subtree was hidden and revealed, never remounted.
    expect(wrapperFor(view, 'session-a')).toBe(wrapperA)
    expect(contentFor(wrapperA, 'session-a')).toBe(contentA)
    expect(wrapperA.hasAttribute('data-layout-session-active')).toBe(true)
    expect(wrapperA.style.display).not.toBe('none')
  })

  it('evicts least-recently-active sessions past the desktop cap (unmount)', async () => {
    expect(DESKTOP_WARM_SESSION_CAP).toBe(3)
    const repo = makeRepo()
    repo.setActiveLayoutSessionId('s1')
    const view = renderHost(repo)
    await activate(repo, 's2')
    await activate(repo, 's3')
    const wrapper2 = wrapperFor(view, 's2')!

    await activate(repo, 's4')

    // s1 (least recently active) is evicted — genuinely unmounted.
    expect(wrapperFor(view, 's1')).toBeNull()
    expect(view.container.querySelectorAll('[data-layout-session-id]')).toHaveLength(3)
    // Re-activating a still-warm session reorders without remounting it.
    await activate(repo, 's2')
    expect(wrapperFor(view, 's2')).toBe(wrapper2)
    expect(wrapper2.hasAttribute('data-layout-session-active')).toBe(true)
    expect(view.container.querySelectorAll('[data-layout-session-id]')).toHaveLength(3)
  })

  it('mobile keeps only the active session mounted', async () => {
    expect(MOBILE_WARM_SESSION_CAP).toBe(1)
    mobileRef.current = true
    const repo = makeRepo()
    repo.setActiveLayoutSessionId('session-a')
    const view = renderHost(repo)

    await activate(repo, 'session-b')

    expect(wrapperFor(view, 'session-a')).toBeNull()
    expect(wrapperFor(view, 'session-b')).toBeTruthy()
    expect(view.container.querySelectorAll('[data-layout-session-id]')).toHaveLength(1)
  })

  it('converges the warm set when the cap shrinks mid-session (desktop -> mobile), preserving the active subtree', async () => {
    const repo = makeRepo()
    repo.setActiveLayoutSessionId('s1')
    const view = renderHost(repo)
    await activate(repo, 's2')
    await activate(repo, 's3')
    expect(view.container.querySelectorAll('[data-layout-session-id]')).toHaveLength(3)
    const wrapper3 = wrapperFor(view, 's3')!
    const content3 = contentFor(wrapper3, 's3')!

    // Flip the mobile mock and force a re-render — mobileRef isn't itself
    // reactive (a plain ref, not React state), so nothing re-renders the
    // host until something does; rerender() with the identical tree stands
    // in for a real viewport-width transition.
    mobileRef.current = true
    view.rerender(
      <LayoutRootContext.Provider value={{rootBlockId: CONTAINER_ID, onLayoutHashChanged}}>
        <LayoutSessionHost block={repo.block(CONTAINER_ID)}/>
      </LayoutRootContext.Provider>,
    )

    // s1/s2 evicted down to the new mobile cap; s3 (active) survives.
    expect(view.container.querySelectorAll('[data-layout-session-id]')).toHaveLength(1)
    expect(wrapperFor(view, 's1')).toBeNull()
    expect(wrapperFor(view, 's2')).toBeNull()
    // Same elements — convergence re-renders, it doesn't remount the
    // surviving active subtree.
    expect(wrapperFor(view, 's3')).toBe(wrapper3)
    expect(contentFor(wrapper3, 's3')).toBe(content3)
    expect(wrapper3.hasAttribute('data-layout-session-active')).toBe(true)
  })

  it('guards against a DERIVED session block id equal to the container id (recursion guard)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const repo = makeRepo()
    repo.setActiveLayoutSessionId('session-a')
    const view = renderHost(repo)

    // The collision is unreachable through the real derivation (uuidv5 over
    // `${containerId}:${key}` never equals the container id), so force it
    // for one sentinel key — the guard exists against a future derivation
    // change, and must skip the one bogus entry rather than recurse into
    // another LayoutSessionHost for the same container block.
    sessionBlockIdOverride.current = (workspaceId, userId, sessionKey) =>
      sessionKey === 'evil'
        ? CONTAINER_ID
        : layoutSessionBlockIdForKey(workspaceId, userId, sessionKey)
    await activate(repo, 'evil')

    expect(view.container.querySelector(`[data-layout-session-id="${CONTAINER_ID}"]`)).toBeNull()
    // The other warm entry still renders — the guard only skips the one
    // bogus entry, not the whole warm set.
    expect(wrapperFor(view, 'session-a')).toBeTruthy()
    expect(view.container.querySelectorAll('[data-layout-session-id]')).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})

describe('default-off: renderer resolution', () => {
  const rootContext = {layoutBoundary: true as const}

  it('claims exactly the layout-sessions container at a root mount', () => {
    const repo = makeRepo()
    expect(LayoutSessionHost.canRender({block: repo.block(CONTAINER_ID), context: rootContext})).toBe(true)
    // A SESSION block — what App mounts today, here the real derived block
    // id of a session key — is NOT claimed: the host never engages in the
    // default single-session app.
    expect(LayoutSessionHost.canRender({block: repo.block(blockIdFor('session-a')), context: rootContext})).toBe(false)
    // Outside a root mount the container itself is not claimed either.
    expect(LayoutSessionHost.canRender({
      block: repo.block(CONTAINER_ID),
      context: {layoutBoundary: true, panelId: 'panel-1'},
    })).toBe(false)
    expect(LayoutSessionHost.canRender({block: repo.block(CONTAINER_ID), context: {}})).toBe(false)
    // No active workspace (boot edge): decline rather than derive a bogus id.
    const noWsRepo = {...makeRepo(), activeWorkspaceId: null} as unknown as Repo
    expect(LayoutSessionHost.canRender({
      block: {id: CONTAINER_ID, repo: noWsRepo} as unknown as Block,
      context: rootContext,
    })).toBe(false)
  })

  it('outbids TopLevelRenderer for the container (both match; priority decides)', () => {
    const repo = makeRepo()
    const props = {block: repo.block(CONTAINER_ID), context: rootContext}
    expect(TopLevelRenderer.canRender(props)).toBe(true)
    expect(LayoutSessionHost.canRender(props)).toBe(true)
    expect(LayoutSessionHost.priority()).toBeGreaterThan(TopLevelRenderer.priority())
  })

  it('is registered in the default renderer registry', () => {
    expect(defaultRendererContributions.some(
      contribution => contribution.renderer === LayoutSessionHost,
    )).toBe(true)
  })
})

describe('single projection liveness through the re-pointed LayoutRootContext', () => {
  const repoRef: {current: Repo | null} = {current: null}

  const Probe = ({blockId}: {blockId: string}) => {
    usePanelLayoutProjection(repoRef.current!.block(blockId))
    return <div data-testid="probe" data-block-id={blockId}/>
  }

  const liveInstances = () => instances.filter(instance => !instance.disposed)

  beforeEach(() => {
    blockComponentImpl.current = ({blockId}) => <Probe blockId={blockId}/>
  })

  it('exactly one projection lives, bound to the ACTIVE session BLOCK id; a switch disposes old + constructs new', async () => {
    const repo = makeRepo()
    repoRef.current = repo
    repo.setActiveLayoutSessionId('session-a')
    renderHost(repo)

    expect(instances).toHaveLength(1)
    // The projection is keyed to the DERIVED block id — the KEY would point
    // it at a nonexistent block (the projection loads/writes that subtree).
    expect(instances[0].options.layoutSessionBlock.id).toBe(blockIdFor('session-a'))
    expect(instances[0].options.workspaceId).toBe(WS)

    await activate(repo, 'session-b')
    // Old disposed (Activity unmounted its effects AND the re-pointed
    // rootBlockId no longer names it), new constructed for the new active.
    expect(instances[0].disposed).toBe(true)
    expect(liveInstances().map(i => i.options.layoutSessionBlock.id)).toEqual([blockIdFor('session-b')])
    // The incoming projection reconciled the current URL exactly once
    // (post-start apply — pushState fired no event to deliver it).
    await vi.waitFor(() => expect(liveInstances()[0].applyCurrentUrlCalls).toBe(1))

    // Switching BACK re-keys a fresh projection for the revealed session —
    // the warm subtree survived, the projection deliberately did not.
    await activate(repo, 'session-a')
    expect(liveInstances().map(i => i.options.layoutSessionBlock.id)).toEqual([blockIdFor('session-a')])
  })

  it('keeps the outer onLayoutHashChanged wired through the re-provided context', async () => {
    const repo = makeRepo()
    repoRef.current = repo
    repo.setActiveLayoutSessionId('session-a')
    renderHost(repo)

    // start() resolving fires the initial hash sync via App's callback —
    // proof the host re-provided the OUTER seam value, not a fresh one.
    await vi.waitFor(() => expect(onLayoutHashChanged).toHaveBeenCalled())
  })
})
