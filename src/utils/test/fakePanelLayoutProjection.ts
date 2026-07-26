/**
 * Shared `PanelLayoutProjection` test double for
 * `vi.mock('@/utils/panelLayoutProjection.js', ...)` — swaps the real
 * projection (PowerSync-backed) for an instance-tracking stub so a test can
 * assert construction/subscription/disposal without touching sync.
 *
 * Used by usePanelLayoutProjection.test.tsx, TopLevelRenderer.test.tsx, and
 * LayoutSessionHost.test.tsx — each previously carried its own copy.
 *
 * Call-site shape: create the `instances` (+ optional `callOrder`) arrays
 * via a self-contained `vi.hoisted()` (no imports referenced there — vi.mock
 * / vi.hoisted are hoisted above this module's own import statement, so a
 * hoisted factory can't reference it directly), then hand them to
 * `createFakePanelLayoutProjectionClass` from an ASYNC `vi.mock` factory via
 * a dynamic `import()` — dynamic import isn't subject to the hoisting
 * restriction, unlike a static one:
 *
 *   const {instances} = vi.hoisted(() => ({instances: [] as FakePanelLayoutProjectionInstance[]}))
 *   vi.mock('@/utils/panelLayoutProjection.js', async () => {
 *     const {createFakePanelLayoutProjectionClass} = await import('@/utils/test/fakePanelLayoutProjection')
 *     return {PanelLayoutProjection: createFakePanelLayoutProjectionClass(instances)}
 *   })
 *
 * `callOrder`, when passed, additionally records 'subscribe'/'start' in call
 * order into the caller-owned array — only the ordering-sensitive suite
 * (usePanelLayoutProjection.test.tsx) needs this; the others omit it.
 */

export interface FakePanelLayoutProjectionOptions {
  repo: unknown
  workspaceId: string
  layoutSessionBlock: {id: string}
}

export interface FakePanelLayoutProjectionInstance {
  readonly options: FakePanelLayoutProjectionOptions
  readonly subscribers: Array<() => void>
  started: boolean
  disposed: boolean
  unsubscribed: boolean
  /** How many times the hook asked this instance to reconcile the current
   *  URL (the post-start apply). */
  applyCurrentUrlCalls: number
  subscribe(cb: () => void): () => void
  start(): Promise<void>
  applyCurrentUrl(): Promise<void>
  dispose(): void
}

export const createFakePanelLayoutProjectionClass = (
  instances: FakePanelLayoutProjectionInstance[],
  callOrder?: string[],
): new (options: FakePanelLayoutProjectionOptions) => FakePanelLayoutProjectionInstance => {
  class FakeProjection implements FakePanelLayoutProjectionInstance {
    readonly options: FakePanelLayoutProjectionOptions
    readonly subscribers: Array<() => void> = []
    started = false
    disposed = false
    unsubscribed = false
    applyCurrentUrlCalls = 0

    constructor(options: FakePanelLayoutProjectionOptions) {
      this.options = options
      instances.push(this)
    }

    subscribe(cb: () => void): () => void {
      // Shared (not per-instance) so an ordering assertion pins the ACTUAL
      // call order the hook issues them in, not just each method's own timing.
      callOrder?.push('subscribe')
      this.subscribers.push(cb)
      return () => { this.unsubscribed = true }
    }

    start(): Promise<void> {
      callOrder?.push('start')
      this.started = true
      return Promise.resolve()
    }

    // Like the real one, resolves without notifying subscribers (the real
    // apply notifies only on applied/normalized/ignored; the boot-path
    // no-op is 'noop').
    applyCurrentUrl(): Promise<void> {
      callOrder?.push('applyCurrentUrl')
      this.applyCurrentUrlCalls++
      return Promise.resolve()
    }

    dispose(): void {
      this.disposed = true
    }
  }

  return FakeProjection
}
