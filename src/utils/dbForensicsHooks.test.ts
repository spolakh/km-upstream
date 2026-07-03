import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetDbForensicsHooksForTest,
  watchForRuntimeCorruption,
} from './dbForensicsHooks.js'
import type { DbForensics } from './dbForensics.js'
import {
  __resetLocalDbCorruptionSignalForTest,
  getLocalDbCorruptionSnapshot,
} from '@/data/localDbCorruptionSignal.js'

const stubForensics = () =>
  ({ captureCorruptionSnapshot: vi.fn().mockResolvedValue(null) }) as unknown as DbForensics

// A fake watch-db whose disposer actually detaches the listener, so `emit`
// after a dispose is a no-op — modelling PowerSync's registerListener contract.
const makeWatchDb = () => {
  let listener: ((s: unknown) => void) | null = null
  const db = {
    currentStatus: undefined,
    registerListener: (l: { statusChanged?: (s: unknown) => void }) => {
      listener = l.statusChanged ?? null
      return () => { listener = null }
    },
  } as unknown as Parameters<typeof watchForRuntimeCorruption>[0]
  return { db, emit: (s: unknown) => listener?.(s) }
}

afterEach(() => {
  __resetDbForensicsHooksForTest()
  __resetLocalDbCorruptionSignalForTest()
  vi.clearAllMocks()
})

describe('watchForRuntimeCorruption', () => {
  it('captures forensics AND routes to recovery on a runtime CORRUPT downloadError', () => {
    const forensics = stubForensics()
    const db = {
      currentStatus: {
        dataFlowStatus: {
          downloadError: new Error('powersync_control: internal SQLite call returned CORRUPT'),
        },
      },
    }
    watchForRuntimeCorruption(db, 'user-1', 'kmp-v6-user-1.db', forensics)

    expect(forensics.captureCorruptionSnapshot).toHaveBeenCalledOnce()
    expect(getLocalDbCorruptionSnapshot()?.userId).toBe('user-1')
  })

  it('does not route a benign (non-corruption) downloadError to recovery', () => {
    const forensics = stubForensics()
    const db = { currentStatus: { dataFlowStatus: { downloadError: new Error('network request failed') } } }
    watchForRuntimeCorruption(db, 'user-1', 'kmp-v6-user-1.db', forensics)

    expect(forensics.captureCorruptionSnapshot).not.toHaveBeenCalled()
    expect(getLocalDbCorruptionSnapshot()).toBeNull()
  })

  it('routes on a downloadError that arrives via a later statusChanged', () => {
    const forensics = stubForensics()
    type WatchDb = Parameters<typeof watchForRuntimeCorruption>[0]
    let emit: ((s: unknown) => void) | undefined
    const db = {
      currentStatus: undefined,
      registerListener: (l: { statusChanged?: (s: unknown) => void }) => {
        emit = l.statusChanged
        return () => {}
      },
    } as unknown as WatchDb
    watchForRuntimeCorruption(db, 'user-1', 'kmp-v6-user-1.db', forensics)
    expect(getLocalDbCorruptionSnapshot()).toBeNull()

    emit?.({ dataFlowStatus: { downloadError: new Error('database disk image is malformed') } })
    expect(getLocalDbCorruptionSnapshot()?.userId).toBe('user-1')
  })

  it('does not consume the one-shot capture on a benign powersync_control blip', () => {
    // A bare (non-CORRUPT) powersync_control sync failure must NOT capture — else
    // it would consume the one-shot and mask a later real-corruption snapshot.
    const forensics = stubForensics()
    const benign = { currentStatus: { dataFlowStatus: { downloadError: new Error('powersync_control: sync iteration failed') } } }
    watchForRuntimeCorruption(benign, 'user-1', 'kmp-v6-user-1.db', forensics)
    expect(forensics.captureCorruptionSnapshot).not.toHaveBeenCalled()
    expect(getLocalDbCorruptionSnapshot()).toBeNull()
  })

  it('does NOT route a benign HTTP sync error whose plain-object body echoes a corruption phrase', () => {
    // downloadError arrives as a plain object; a server 4xx body can contain
    // "…not a database…" etc. That must not yank a healthy session to reset.
    const forensics = stubForensics()
    const httpErr = { name: 'Error', message: 'HTTP Bad Request: table "x" is not a database table', stack: 'x' }
    const db = { currentStatus: { dataFlowStatus: { downloadError: httpErr } } }
    watchForRuntimeCorruption(db, 'user-1', 'kmp-v6-user-1.db', forensics)
    expect(forensics.captureCorruptionSnapshot).not.toHaveBeenCalled()
    expect(getLocalDbCorruptionSnapshot()).toBeNull()
  })

  it('re-arms for a new user after an in-page account switch (disposes the stale listener)', () => {
    const forensics = stubForensics()
    const a = makeWatchDb()
    const b = makeWatchDb()
    watchForRuntimeCorruption(a.db, 'user-A', 'kmp-v6-user-A.db', forensics)
    // Switch to user B without reload — must dispose A's listener and rebind to B.
    watchForRuntimeCorruption(b.db, 'user-B', 'kmp-v6-user-B.db', forensics)

    // A's listener is disposed, so a stale event from user A's (disconnected) DB
    // never reaches us — user A's corruption can't be routed into user B's session.
    a.emit({ dataFlowStatus: { downloadError: new Error('database disk image is malformed') } })
    expect(getLocalDbCorruptionSnapshot()).toBeNull()

    // User B's corruption routes, tagged to user B.
    b.emit({ dataFlowStatus: { downloadError: new Error('database disk image is malformed') } })
    expect(getLocalDbCorruptionSnapshot()?.userId).toBe('user-B')
  })
})
