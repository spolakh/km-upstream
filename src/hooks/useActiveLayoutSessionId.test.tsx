// @vitest-environment happy-dom
/**
 * useActiveLayoutSessionId — the reactive read LayoutSessionHost re-points
 * the mounted session tree off. Pins that a `setActiveLayoutSessionId`
 * call re-renders subscribed consumers with the new effective id, that
 * effective no-ops stay silent, and that the subscription re-binds when
 * the consumer switches Repo instances (the useCallback [repo] key).
 */
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { ClientContext, type ClientContextReader } from '@/data/clientContext'
import type { Repo } from '@/data/repo'
import { useActiveLayoutSessionId } from './useActiveLayoutSessionId'

// The hook touches exactly `repo.client` — a real ClientContext behind a
// minimal fake keeps this a unit test of the subscription wiring rather
// than a Repo construction exercise.
const makeRepo = (): Repo =>
  ({client: new ClientContext({user: {id: 'user-1'}})}) as unknown as Repo

// `repo.client` is publicly typed as `ClientContextReader` (no set methods
// — see clientContext.ts / repoLifecycle.test.ts's own asConcrete). This
// test drives the underlying concrete ClientContext directly to simulate
// what `repo.setActiveLayoutSessionId` would do; never cast like this
// outside a test.
const asConcrete = (client: ClientContextReader): ClientContext => client as ClientContext

describe('useActiveLayoutSessionId', () => {
  it('re-renders with the new effective id on set, and null restores the base id', () => {
    const repo = makeRepo()
    const base = repo.client.activeLayoutSessionId
    const {result} = renderHook(() => useActiveLayoutSessionId(repo))
    expect(result.current).toBe(base)

    act(() => asConcrete(repo.client).setActiveLayoutSessionId('perspective-1'))
    expect(result.current).toBe('perspective-1')

    act(() => asConcrete(repo.client).setActiveLayoutSessionId(null))
    expect(result.current).toBe(base)
  })

  it('rebinds the subscription when the repo prop changes', () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    asConcrete(repoB.client).setActiveLayoutSessionId('b-session')
    const {result, rerender} = renderHook(
      ({repo}: {repo: Repo}) => useActiveLayoutSessionId(repo),
      {initialProps: {repo: repoA}},
    )
    expect(result.current).toBe(repoA.client.activeLayoutSessionId)

    rerender({repo: repoB})
    expect(result.current).toBe('b-session')

    // The old repo's channel no longer reaches the consumer…
    act(() => asConcrete(repoA.client).setActiveLayoutSessionId('a-late'))
    expect(result.current).toBe('b-session')
    // …and the new one does.
    act(() => asConcrete(repoB.client).setActiveLayoutSessionId('b-next'))
    expect(result.current).toBe('b-next')
  })
})
