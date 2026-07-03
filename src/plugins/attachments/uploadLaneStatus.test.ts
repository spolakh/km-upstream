import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryByteUploadStore } from './uploadStore.js'
import { RETRY_UPLOADS_ACTION_ID, refreshUploadLaneStatus, uploadLaneDiagnosticSource } from './uploadLaneStatus.js'

const storeWithFailures = async (n: number): Promise<InMemoryByteUploadStore> => {
  const store = new InMemoryByteUploadStore()
  for (let i = 0; i < n; i++) {
    const assetBlockId = `media:${i}`
    await store.stage({ userId: 'u1', assetBlockId, workspaceId: 'ws', contentHash: `sha256:${i}`, contentKey: `ck${i}` })
    await store.promote('u1', assetBlockId)
    await store.markFailed('u1', assetBlockId)
  }
  return store
}

describe('uploadLaneDiagnosticSource', () => {
  // The source is a module singleton; reset its count to 0 before each test.
  beforeEach(() => refreshUploadLaneStatus(new InMemoryByteUploadStore(), 'u1'))

  it('reports nothing (null snapshot) when there are no failed uploads', async () => {
    await refreshUploadLaneStatus(await storeWithFailures(0), 'u1')
    expect(uploadLaneDiagnosticSource.getSnapshot()).toBeNull()
  })

  it('surfaces a warning with the failed count, notifies on change, and is ref-stable while unchanged', async () => {
    let fired = 0
    const unsub = uploadLaneDiagnosticSource.subscribe(() => (fired += 1))

    await refreshUploadLaneStatus(await storeWithFailures(2), 'u1')
    expect(fired).toBe(1)
    const snap = uploadLaneDiagnosticSource.getSnapshot()
    expect(snap).toMatchObject({ severity: 'warning', nudge: true })
    expect(snap?.summary).toBe('2 media uploads failed')
    // The §9 explicit-user-retry affordance: a "Retry" button wired to the recovery action.
    expect(snap).toMatchObject({ actionId: RETRY_UPLOADS_ACTION_ID, actionLabel: 'Retry' })

    // No change → same reference (the useSyncExternalStore contract) and no extra notify.
    await refreshUploadLaneStatus(await storeWithFailures(2), 'u1')
    expect(uploadLaneDiagnosticSource.getSnapshot()).toBe(snap)
    expect(fired).toBe(1)
    unsub()
  })

  it('a signed-out (null user) refresh clears the count', async () => {
    await refreshUploadLaneStatus(await storeWithFailures(3), 'u1')
    expect(uploadLaneDiagnosticSource.getSnapshot()?.summary).toBe('3 media uploads failed')
    await refreshUploadLaneStatus(new InMemoryByteUploadStore(), null)
    expect(uploadLaneDiagnosticSource.getSnapshot()).toBeNull()
  })
})
