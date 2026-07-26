// @vitest-environment node
/**
 * Repo lifecycle tests — small but durable contracts on the Repo
 * surface that aren't pinned by the engine / mutator / query test
 * suites:
 *
 *   - block(id) identity stability (memoized facade per id)
 *   - block(id) — different ids yield different facades
 *   - block(id) — different Repo instances yield different facades
 *     even for the same id
 *   - setReadOnly toggles isReadOnly visibly to subsequent reads
 *   - activeWorkspaceId getter/setter round-trip; null is allowed
 *   - activeLayoutSessionId getter/setter round-trip; falls back to the
 *     per-device base id when unset (replaces the old module-global
 *     `activeLayoutSessionId` store's own unit tests)
 *   - repo.client (ClientContext): user exposure, per-instance
 *     independence, and shim ⇄ client state sharing — the acting-as
 *     state has one home on ClientContext and Repo's public
 *     user/activeWorkspaceId/activeLayoutSessionId API delegates to it
 *   - instanceId is unique across Repo constructions (memoize-key
 *     contract used by globalState.ts)
 *
 * Spec §5.2 / §3 / §8. These behaviors persist through Phase 2-3
 * (the spec keeps `block(id)` as a sync facade getter, replacing
 * its return type with a Handle later but keeping the identity
 * contract).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Pin the per-device base id so the activeLayoutSessionId fallback
// assertions are deterministic (the real getLayoutSessionId touches
// window/sessionStorage, and is a random uuid in this @vitest-environment
// node file's window-less default path).
vi.mock('@/utils/layoutSessionId', () => ({
  getLayoutSessionId: () => 'base-session-id',
}))

import {
  ChangeScope,
  defineProperty,
  codecs,
  type BlockData,
} from '@/data/api'
import {
  definitionBlockProjectorFacet,
  definitionSeedsFacet,
  projectedPropertyDefinitionsFacet,
} from '@/data/facets'
import type {DefinitionBlockProjector} from '@/data/projectorRuntime'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import {seedProperty} from '@/data/propertySeeds'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {kernelDataExtension} from '@/data/kernelDataExtension'
import {defineFacet, resolveFacetRuntimeSync} from '@/facets/facet'
import { Repo } from '../repo'
import { ClientContext, type ClientContextReader } from '../clientContext'

interface Harness {
  h: TestDb
  repo: Repo
}

// Builds a harness on the shared, already-reset DB. Called from beforeEach
// AND mid-test (some tests build a second Repo to prove per-Repo identity), so
// it must NOT reset — reset lives in beforeEach. `h.cleanup` disposes this
// harness's observer without closing the shared DB.
const setup = async (): Promise<Harness> => {
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
  })
  return {h: {db: sharedDb.db, cleanup: async () => {}}, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db); env = await setup() })
afterEach(async () => { await env.h.cleanup() })

describe('repo.block(id) identity stability', () => {
  it('returns the same Block instance on repeated calls for the same id', () => {
    const a = env.repo.block('id-1')
    const b = env.repo.block('id-1')
    expect(a).toBe(b)
  })

  it('returns a different Block instance for different ids', () => {
    const a = env.repo.block('id-1')
    const b = env.repo.block('id-2')
    expect(a).not.toBe(b)
    expect(a.id).toBe('id-1')
    expect(b.id).toBe('id-2')
  })

  it('returns a different Block across Repo instances even for the same id', async () => {
    const otherEnv = await setup()
    try {
      const a = env.repo.block('shared')
      const b = otherEnv.repo.block('shared')
      expect(a).not.toBe(b)
      // Each Block is bound to its constructing Repo.
      expect(a.repo).toBe(env.repo)
      expect(b.repo).toBe(otherEnv.repo)
    } finally {
      await otherEnv.h.cleanup()
    }
  })
})

describe('repo.setReadOnly', () => {
  it('starts non-read-only by default and flips both ways', () => {
    expect(env.repo.isReadOnly).toBe(false)
    env.repo.setReadOnly(true)
    expect(env.repo.isReadOnly).toBe(true)
    env.repo.setReadOnly(false)
    expect(env.repo.isReadOnly).toBe(false)
  })

  it('respects opts.isReadOnly at construction', () => {
    // Construction-only assertion — no DB I/O — so it rides the shared DB
    // with the observer off rather than opening its own harness.
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'u'},
      isReadOnly: true,
      startSyncObserver: false,
    })
    expect(repo.isReadOnly).toBe(true)
  })
})

describe('repo.activeWorkspaceId', () => {
  it('starts null and round-trips through the setter', () => {
    expect(env.repo.activeWorkspaceId).toBeNull()
    env.repo.setActiveWorkspaceId('ws-1')
    expect(env.repo.activeWorkspaceId).toBe('ws-1')
    env.repo.setActiveWorkspaceId('ws-2')
    expect(env.repo.activeWorkspaceId).toBe('ws-2')
    env.repo.setActiveWorkspaceId(null)
    expect(env.repo.activeWorkspaceId).toBeNull()
  })

  it('owns projector lifecycle at the workspace pin in production mode', () => {
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'u'},
    })
    const pin = vi.spyOn(repo.projectors, 'pinWorkspace')

    repo.setActiveWorkspaceId('ws-1')
    repo.setActiveWorkspaceId('ws-1')
    repo.setActiveWorkspaceId('ws-2')
    repo.setActiveWorkspaceId(null)

    expect(pin.mock.calls).toEqual([['ws-1'], ['ws-2'], [null]])
  })

  it('rolls back the Repo pin when projector startup fails and permits retry', () => {
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'u'}})
    repo.setActiveWorkspaceId('ws-1')
    const originalPin = repo.projectors.pinWorkspace.bind(repo.projectors)
    const pin = vi.spyOn(repo.projectors, 'pinWorkspace').mockImplementation(workspaceId => {
      if (workspaceId === 'ws-2') throw new Error('injected projector failure')
      originalPin(workspaceId)
    })

    expect(() => repo.setActiveWorkspaceId('ws-2')).toThrow('injected projector failure')
    expect(repo.activeWorkspaceId).toBe('ws-1')

    pin.mockRestore()
    expect(() => repo.setActiveWorkspaceId('ws-2')).not.toThrow()
    expect(repo.activeWorkspaceId).toBe('ws-2')
    repo.setActiveWorkspaceId(null)
  })

  it('starts descriptors that arrive in a replacement runtime for an already-active workspace', async () => {
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'u'},
      installKernelRuntime: false,
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([]))
    repo.setActiveWorkspaceId('ws-late-runtime')
    expect(repo.projectors.isPrimed('ws-late-runtime')).toBe(true)

    repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
    await expect(repo.projectors.whenPrimed('ws-late-runtime')).resolves.toBeUndefined()
    expect(repo.projectors.isPrimed('ws-late-runtime')).toBe(true)
    repo.setActiveWorkspaceId(null)
  })

  it('resolves the seed per workspace, unshadowed by a same-name stored definition', async () => {
    const declaration = seedProperty({
      seedKey: 'system:kernel-data/property/test-synthesized',
      revision: 1,
      name: 'test:synthesized',
      preset: 'string',
      changeScope: ChangeScope.BlockDefault,
    })
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'u'},
      installKernelRuntime: false,
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      definitionSeedsFacet.of(declaration),
    ]))

    expect(repo.propertySchemas.get(declaration.name)).toBe(declaration)
    expect(repo.propertyDefinitions).toBeNull()

    await repo.tx(
      tx => tx.create({
        id: 'synthesis-target-a',
        workspaceId: 'ws-synthesis-a',
        parentId: null,
        orderKey: 'a0',
      }),
      {scope: ChangeScope.BlockDefault},
    )
    // A same-name USER definition (a stored winner) in ws-synthesis-a.
    await repo.tx(
      tx => tx.create({
        id: 'stored-winner-a',
        workspaceId: 'ws-synthesis-a',
        parentId: null,
        orderKey: 'a1',
        properties: {
          types: ['property-schema'],
          'property-schema:name': declaration.name,
          'property-schema:preset': 'string',
        },
      }),
      {scope: ChangeScope.BlockDefault},
    )

    repo.setActiveWorkspaceId('ws-synthesis-a')
    expect(repo.propertyDefinitions).toBeNull()
    await repo.whenPropertyDefinitionsReady('ws-synthesis-a')
    // The stored winner exists by field id, but v1 makes a code-owned seed
    // unshadowable, so it resolves to its own per-workspace field.
    expect(repo.propertyDefinitions?.definitionsByFieldId.has('stored-winner-a')).toBe(true)
    expect(repo.propertySchemaResolverFor('ws-synthesis-a').resolve(declaration)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({
        fieldId: propertyDefinitionBlockId('ws-synthesis-a', declaration.seedKey),
        workspaceId: 'ws-synthesis-a',
      }),
    })

    // A different workspace (no stored winner) resolves the seed to ITS field.
    repo.setActiveWorkspaceId('ws-synthesis-b')
    expect(repo.propertyDefinitions).toBeNull()
    await repo.whenPropertyDefinitionsReady('ws-synthesis-b')
    expect(repo.propertyDefinitions).toMatchObject({workspaceId: 'ws-synthesis-b'})
    expect(repo.propertySchemaResolverFor('ws-synthesis-b').resolve(declaration)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({
        fieldId: propertyDefinitionBlockId('ws-synthesis-b', declaration.seedKey),
        workspaceId: 'ws-synthesis-b',
      }),
    })
    repo.setActiveWorkspaceId(null)
  })

  it('cancels a queued transaction when the active projector generation changes', async () => {
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'u'}})
    repo.setActiveWorkspaceId('ws-queued-a')
    await repo.whenPropertyDefinitionsReady('ws-queued-a')
    let release!: () => void
    const readiness = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(repo, 'whenPropertyDefinitionsReady').mockReturnValueOnce(readiness)
    const body = vi.fn()

    const pending = repo.tx(body, {scope: ChangeScope.BlockDefault})
    repo.setActiveWorkspaceId('ws-queued-b')
    release()

    await expect(pending).rejects.toThrow(
      'active workspace generation changed while waiting for ws-queued-a',
    )
    expect(body).not.toHaveBeenCalled()
    repo.setActiveWorkspaceId(null)
  })

  it('recomputes synthesis when a seed contribution arrives after projector priming', async () => {
    const declaration = seedProperty({
      seedKey: 'system:test-plugin/property/late-seed',
      revision: 1,
      name: 'test:late-seed',
      preset: 'string',
      changeScope: ChangeScope.BlockDefault,
    })
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'u'}})
    repo.setActiveWorkspaceId('ws-late-seed')
    await repo.whenPropertyDefinitionsReady('ws-late-seed')
    expect(repo.propertySchemas.has(declaration.name)).toBe(false)

    repo.setRuntimeContributions(definitionSeedsFacet, 'test-late-seed', [declaration])

    expect(repo.propertySchemas.get(declaration.name)).toBe(declaration)
    expect(repo.propertySchemaResolverFor('ws-late-seed').resolve(declaration)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({
        fieldId: propertyDefinitionBlockId('ws-late-seed', declaration.seedKey),
        origin: 'plugin:system:test-plugin',
      }),
    })
    repo.setActiveWorkspaceId(null)
  })

  it('rebuilds workspace-scoped schema state once per pin transition', () => {
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'u'},
      installKernelRuntime: false,
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([]))
    const schema = defineProperty('test:scoped', {
      codec: codecs.string,
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-scoped',
      [{
        metadata: {
          fieldId: 'field-scoped',
          workspaceId: 'ws-scoped',
          createdAt: 1,
          name: schema.name,
          changeScope: schema.changeScope,
          hidden: false,
          origin: 'user',
        },
        schema,
      }],
      {workspaceId: 'ws-scoped'},
    )
    let rebuilds = 0
    const dispose = repo.onPropertySchemasChange(() => { rebuilds += 1 })

    repo.setActiveWorkspaceId('ws-scoped')
    expect(rebuilds).toBe(1)
    expect(repo.propertySchemas.get(schema.name)).toBe(schema)

    dispose()
    repo.setActiveWorkspaceId(null)
  })

  it('mirrors a failed runtime-replacement reconcile and permits an explicit retry', () => {
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'u'},
      installKernelRuntime: false,
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([]))
    repo.setActiveWorkspaceId('ws-runtime-failure')

    let failStart = true
    const targetFacet = defineFacet<{readonly id: string}>({id: 'test.runtime-failure-target'})
    const throwingDescriptor: DefinitionBlockProjector<BlockData, {readonly id: string}> = {
      id: 'test-runtime-failure',
      metaType: 'test-runtime-failure',
      targetFacet,
      sourceId: 'test-runtime-failure',
      project: block => ({id: block.id}),
      keyOf: contribution => contribution.id,
      secondarySignal: () => {
        if (failStart) throw new Error('replacement projector failed')
        return vi.fn()
      },
    }
    const replacement = resolveFacetRuntimeSync([
      kernelDataExtension,
      definitionBlockProjectorFacet.of(throwingDescriptor),
    ])

    expect(() => repo.setFacetRuntime(replacement)).toThrow(
      'failed to pin ws-runtime-failure and restore ws-runtime-failure',
    )
    expect(repo.activeWorkspaceId).toBeNull()
    expect(repo.projectors.workspaceId).toBeNull()

    failStart = false
    expect(() => repo.setActiveWorkspaceId('ws-runtime-failure')).not.toThrow()
    expect(repo.activeWorkspaceId).toBe('ws-runtime-failure')
    expect(repo.projectors.workspaceId).toBe('ws-runtime-failure')
    repo.setActiveWorkspaceId(null)
  })

  it('falls back to a null pin when incoming start and outgoing restoration both fail', () => {
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'u'}})
    repo.setActiveWorkspaceId('ws-1')
    const originalPin = repo.projectors.pinWorkspace.bind(repo.projectors)
    const pin = vi.spyOn(repo.projectors, 'pinWorkspace').mockImplementation(workspaceId => {
      if (workspaceId === 'ws-2') {
        originalPin(null)
        throw new AggregateError([new Error('incoming'), new Error('rollback')], 'nested failure')
      }
      originalPin(workspaceId)
    })

    expect(() => repo.setActiveWorkspaceId('ws-2')).toThrow('nested failure')
    expect(repo.activeWorkspaceId).toBeNull()
    expect(repo.projectors.workspaceId).toBeNull()

    pin.mockRestore()
    expect(() => repo.setActiveWorkspaceId('ws-1')).not.toThrow()
    expect(repo.activeWorkspaceId).toBe('ws-1')
    repo.setActiveWorkspaceId(null)
  })
})

describe('repo.activeLayoutSessionId', () => {
  it('falls back to the per-device base id when unset, and round-trips through the setter', () => {
    expect(env.repo.activeLayoutSessionId).toBe('base-session-id')

    env.repo.setActiveLayoutSessionId('perspective-1')
    expect(env.repo.activeLayoutSessionId).toBe('perspective-1')

    env.repo.setActiveLayoutSessionId('perspective-2')
    expect(env.repo.activeLayoutSessionId).toBe('perspective-2')

    // null restores the base-id fallback.
    env.repo.setActiveLayoutSessionId(null)
    expect(env.repo.activeLayoutSessionId).toBe('base-session-id')
  })

  it('is independent per Repo instance', async () => {
    const other = await setup()
    try {
      env.repo.setActiveLayoutSessionId('perspective-a')
      other.repo.setActiveLayoutSessionId('perspective-b')
      expect(env.repo.activeLayoutSessionId).toBe('perspective-a')
      expect(other.repo.activeLayoutSessionId).toBe('perspective-b')
    } finally {
      env.repo.setActiveLayoutSessionId(null)
      await other.h.cleanup()
    }
  })
})

describe('repo.client (ClientContext)', () => {
  // `repo.client` is publicly typed as `ClientContextReader` (no set
  // methods — see clientContext.ts) so production code can't bypass Repo's
  // transition. These tests deliberately reach the CONCRETE ClientContext
  // to prove ITS OWN bare-write contract (no Repo side effects; one shared
  // home for the field) — the thing only the concrete class can exercise.
  // Never do this cast outside a test.
  const asConcrete = (client: ClientContextReader): ClientContext => client as ClientContext

  it('exposes the acting user; repo.user delegates to it', () => {
    expect(env.repo.client.user).toEqual({id: 'user-1'})
    expect(env.repo.user).toBe(env.repo.client.user)
  })

  it('is per-Repo-instance (independent acting-as state)', async () => {
    const other = await setup()
    try {
      expect(other.repo.client).not.toBe(env.repo.client)
      asConcrete(env.repo.client).setActiveLayoutSessionId('mine')
      expect(other.repo.client.activeLayoutSessionId).toBe('base-session-id')
    } finally {
      asConcrete(env.repo.client).setActiveLayoutSessionId(null)
      await other.h.cleanup()
    }
  })

  it('layout-session fallback + set round-trip directly via repo.client', () => {
    expect(env.repo.client.activeLayoutSessionId).toBe('base-session-id')
    asConcrete(env.repo.client).setActiveLayoutSessionId('perspective-direct')
    expect(env.repo.client.activeLayoutSessionId).toBe('perspective-direct')
    // The Repo shims read/write the SAME state — one home for the field.
    expect(env.repo.activeLayoutSessionId).toBe('perspective-direct')
    env.repo.setActiveLayoutSessionId(null)
    expect(env.repo.client.activeLayoutSessionId).toBe('base-session-id')
  })

  it('workspace pin state is shared between the Repo shim and client reads', () => {
    expect(env.repo.client.activeWorkspaceId).toBeNull()
    env.repo.setActiveWorkspaceId('ws-client')
    expect(env.repo.client.activeWorkspaceId).toBe('ws-client')
    env.repo.setActiveWorkspaceId(null)
    expect(env.repo.client.activeWorkspaceId).toBeNull()
    // Reverse direction: a bare client write (no Repo side effects — see
    // ClientContext's doc) is visible through the Repo shim, pinning that
    // there is exactly one home for the field.
    asConcrete(env.repo.client).setActiveWorkspaceId('ws-direct')
    expect(env.repo.activeWorkspaceId).toBe('ws-direct')
    asConcrete(env.repo.client).setActiveWorkspaceId(null)
  })
})

describe('repo.instanceId', () => {
  it('is unique per Repo construction (memoize-key contract)', async () => {
    const a = await setup()
    const b = await setup()
    try {
      expect(a.repo.instanceId).not.toBe(b.repo.instanceId)
      expect(a.repo.instanceId).not.toBe(env.repo.instanceId)
      expect(b.repo.instanceId).not.toBe(env.repo.instanceId)
    } finally {
      await a.h.cleanup()
      await b.h.cleanup()
    }
  })

  it('is a number', () => {
    expect(typeof env.repo.instanceId).toBe('number')
  })
})

describe('repo.metrics() / resetMetrics()', () => {
  it('exposes all subsections; all start empty / at zero', () => {
    const m = env.repo.metrics()
    expect(Object.keys(m).sort()).toEqual(['blockCache', 'db', 'handleStore', 'handleStoreInventory', 'queries', 'reprojection', 'slowestTx', 'txLog'])
    expect(Object.isFrozen(m)).toBe(true)
    expect(m.handleStore.invalidations).toBe(0)
    expect(m.handleStoreInventory.handleCount).toBe(0)
    expect(m.handleStoreInventory.topHeavy).toEqual([])
    expect(m.blockCache.setSnapshotCalls).toBe(0)
    // queries: empty map (no query has run yet).
    expect(Object.keys(m.queries)).toEqual([])
    // db: every method bucket is initialised with zero samples.
    expect(m.db.getAll.calls).toBe(0)
    expect(m.db.writeTransaction.calls).toBe(0)
  })

  it('snapshots are independent across reset (prior snapshot keeps its values)', () => {
    env.repo.cache.setSnapshot({
      id: 'block-1', workspaceId: 'ws', parentId: null, orderKey: 'a',
      content: '', properties: {}, references: [],
      createdAt: 0, updatedAt: 0, userUpdatedAt: 0, createdBy: 'u', updatedBy: 'u', deleted: false,
    })
    const before = env.repo.metrics()
    expect(before.blockCache.setSnapshotCalls).toBe(1)

    env.repo.resetMetrics()
    const after = env.repo.metrics()
    expect(after.blockCache.setSnapshotCalls).toBe(0)
    // The earlier snapshot retains its values — frozen and detached.
    expect(before.blockCache.setSnapshotCalls).toBe(1)
  })

  it('reflects HandleStore activity end-to-end', async () => {
    // Drive a real LoaderHandle through the store via repo.query.
    // (We don't need any data; the dispatcher creates the handle and
    // running .load() triggers loaderRuns.)
    const handle = env.repo.query.children({id: 'nonexistent-id'})
    await handle.load() // empty children list — succeeds with []

    const m = env.repo.metrics()
    expect(m.handleStore.loaderRuns).toBe(1)

    // Direct invalidate that matches the parent-edge dep declared by
    // the children loader. Walks 1 handle, matches 1.
    env.repo.handleStore.invalidate({parentIds: ['nonexistent-id']})
    const after = env.repo.metrics()
    expect(after.handleStore.invalidations).toBe(1)
    expect(after.handleStore.handlesWalked).toBe(1)
    expect(after.handleStore.handlesMatched).toBe(1)
  })

  it('records per-query resolve timings keyed by full query name', async () => {
    env.repo.resetMetrics()
    await env.repo.query.children({id: 'x1'}).load()
    await env.repo.query.children({id: 'x2'}).load()
    await env.repo.query.subtree({id: 'x1'}).load()

    const m = env.repo.metrics()
    expect(m.queries['core.children'].calls).toBe(2)
    expect(m.queries['core.subtree'].calls).toBe(1)
    // Each entry is a plain TimingSnapshot with non-negative timings.
    expect(m.queries['core.children'].meanMs).toBeGreaterThanOrEqual(0)
    expect(m.queries['core.children'].sampleCount).toBe(2)
  })

  it('records db method timings end-to-end (read calls + writeTransaction wall + inner SQL)', async () => {
    // Drive a write through repo.tx directly — keeps the test free of
    // mutator-graph preconditions (createChild requires the parent to
    // exist, etc.) while still exercising the wrapped writeTransaction
    // path. The empty-tx case still opens / closes a transaction.
    env.repo.resetMetrics()
    await env.repo.tx(async () => {
      // No-op tx; we just want writeTransaction wall-clock to land
      // somewhere observable.
    }, {scope: ChangeScope.BlockDefault})

    const afterWrite = env.repo.metrics()
    expect(afterWrite.db.writeTransaction.calls).toBeGreaterThanOrEqual(1)
    // Inner execute counts: the tx pipeline writes at least the
    // tx_context row + command_events row, both via execute().
    expect(afterWrite.db.execute.calls).toBeGreaterThanOrEqual(1)

    // A read-only path: repo.load(id) on an unknown id still hits
    // SQL once via getOptional. Confirms reads outside writeTransaction
    // also flow through the timed proxy.
    env.repo.resetMetrics()
    await env.repo.load('definitely-not-a-real-id')
    const afterRead = env.repo.metrics()
    expect(afterRead.db.getAll.calls + afterRead.db.getOptional.calls + afterRead.db.get.calls)
      .toBeGreaterThanOrEqual(1)
    expect(afterRead.db.writeTransaction.calls).toBe(0)
  })

  it('resetMetrics() clears query and db reservoirs too', async () => {
    await env.repo.query.children({id: 'reset-test'}).load()
    expect(env.repo.metrics().queries['core.children'].calls).toBeGreaterThan(0)
    env.repo.resetMetrics()
    const after = env.repo.metrics()
    expect(Object.keys(after.queries)).toEqual([])
    expect(after.db.getAll.calls).toBe(0)
    expect(after.db.writeTransaction.calls).toBe(0)
  })
})

describe('repo.scheduleReconcileRescan — one-time shadow recovery', () => {
  // Let the deferred run() fire (setTimeout(0) under node, no requestIdleCallback)
  // and then await the drainWorkspace it enqueues.
  const settle = async (repo: Repo) => {
    await new Promise(resolve => setTimeout(resolve, 0))
    await repo.awaitReconcileRescans()
  }

  it('re-scans a workspace once, marks it done, and no-ops on the next open', async () => {
    // The rescan re-reads blocks_synced directly via drainSyncWorkspace; the
    // server-monotonic gate heals shadows without a separate mode.
    const spy = vi.spyOn(env.repo, 'drainSyncWorkspace').mockResolvedValue()

    env.repo.scheduleReconcileRescan('ws-1')
    await settle(env.repo)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('ws-1')

    // Marker now present → a later open is a no-op.
    env.repo.scheduleReconcileRescan('ws-1')
    await settle(env.repo)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('re-scans each workspace independently (per-workspace marker)', async () => {
    const spy = vi.spyOn(env.repo, 'drainSyncWorkspace').mockResolvedValue()

    env.repo.scheduleReconcileRescan('ws-1')
    await settle(env.repo)
    env.repo.scheduleReconcileRescan('ws-2')
    await settle(env.repo)

    expect(spy.mock.calls.map(call => call[0])).toEqual(['ws-1', 'ws-2'])
  })

  it('leaves the marker unset on failure so the next open retries', async () => {
    const spy = vi.spyOn(env.repo, 'drainSyncWorkspace')
      .mockRejectedValueOnce(new Error('drain failed'))
      .mockResolvedValue()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    env.repo.scheduleReconcileRescan('ws-1')
    await settle(env.repo)
    expect(spy).toHaveBeenCalledTimes(1) // failed, marker not written

    env.repo.scheduleReconcileRescan('ws-1')
    await settle(env.repo)
    expect(spy).toHaveBeenCalledTimes(2) // retried
  })
})
