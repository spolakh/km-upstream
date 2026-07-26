/**
 * New `Repo` class for the data-layer redesign (spec §3, §8).
 *
 * Stage 1.4 scope: holds `db` + `cache` + `user` + the mutator registry
 * (kernel mutators registered at construction time). Exposes:
 *   - `repo.tx(fn, opts)` — primitive transactional session
 *   - `repo.mutate.X(args)` — typed-dispatch sugar (1-mutator tx wrapping)
 *   - `repo.run(name, args)` — runtime-validated dispatch (dynamic plugins)
 *   - `repo.setFacetRuntime(runtime)` — refresh mutator registry from a
 *     FacetRuntime. Minimal impl reads `mutatorsFacet` contributions.
 *
 * Stage 2 of Phase 1 (post-1.6) adds:
 *   - HandleStore + `repo.block(id)` / `repo.children(id)` / etc.
 *   - Layout B sync observer for sync-applied invalidation (design doc §9.2)
 */

import { v4 as uuidv4 } from 'uuid'
import type { FacetRuntime, Facet, WorkspaceRuntimeContributionOptions } from '@/facets/facet'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import type {
  AnyMutator,
  AnyPostCommitProcessor,
  AnySameTxProcessor,
  AnyPropertyEditorOverride,
  AnyPropertySchema,
  AnyQuery,
  AnyValuePresetCore,
  BlockData,
  Mutator,
  MutatorRegistry,
  Query,
  QueryCtx,
  QueryRegistry,
  ResolvedTypedBlockQuery,
  RepoTxOptions,
  TypedBlockQuery,
  TypeContribution,
  TypeRegistrySnapshot,
  Tx,
  Unsubscribe,
  User,
} from '@/data/api'
import {
  ChangeScope,
  MutatorNotRegisteredError,
  ParentDeletedError,
  ProcessorRejection,
  QueryNotRegisteredError,
  derivedRefKey,
  reconcileDerived,
} from '@/data/api'
import {
  latestRefProjectionSchema,
  projectedRefsForField,
  refCodecKind,
  refTypedSchemaNames,
} from './internals/refProjection'
import { runTx, type PowerSyncDb } from './internals/commitPipeline'
import { devAssertionsEnabled } from './internals/devAssertions'
import type { BlockCache } from '@/data/blockCache'
import {
  BLOCKS_TABLE_COLUMN_NAMES,
  buildQualifiedBlockColumnsSql,
  parseBlockRow,
  type BlockRow,
} from '@/data/blockSchema'
import { kernelDataExtension } from './kernelDataExtension'
import {
  systemPagesFacet,
  type WorkspaceBackfill,
  type WorkspaceBackfillContext,
} from './facets'
import { ProcessorRunner } from './internals/processorRunner'
import { Block } from './block'
import {
  HandleStore,
  LoaderHandle,
  handleKey,
  snapshotsToChangeNotification,
  type ResolveContext,
} from './internals/handleStore'
import { jsonPathForProperty, normalizeTypedBlockQuery } from './internals/typedBlockQuery'
import {
  DbMetrics,
  QueryMetrics,
  wrapDbWithMetrics,
} from './internals/timingMetrics'
import {
  startBlocksSyncedObserver,
  type BlocksSyncedObserver,
  type BlocksSyncedObserverArgs,
} from '@/data/internals/syncObserver/observer'
import type { MaterializeDeps } from '@/data/internals/syncObserver/materialize'
import type { Materializability } from '@/sync/transform'
import {
  CLEAR_REPROJECT_REF_MARKER_SQL,
  RECORD_REPROJECT_REF_MARKER_SQL,
  REPROJECT_REF_MARKER_PREFIX,
  SELECT_REPROJECT_REF_MARKERS_SQL,
  RECORD_WORKSPACE_BACKFILL_MARKER_SQL,
  WORKSPACE_BACKFILL_MARKER_PREFIX,
  SELECT_WORKSPACE_BACKFILL_MARKERS_SQL,
  RECONCILE_RESCAN_MARKER_PREFIX,
  SELECT_RECONCILE_RESCAN_MARKER_SQL,
  RECORD_RECONCILE_RESCAN_MARKER_SQL,
} from './internals/clientSchema'
import {
  deriveReferenceColumns,
  type ReferenceTargetLookups,
} from './internals/referenceTargetProcessor'
import { parseExactReferenceBlockContent } from './referenceBlock'
import type {
  PropertyDefinitionChange,
  PropertyDefinitionMigrationPlan,
} from './internals/propertyDefinitionMigrations'
import {
  encodedPropertyValueToChildContent,
  isFieldValueChild,
  isPropertyFieldInstance,
  propertyChildContentToEncodedValue,
  rekeyParentPropertyCell,
  type IsPropertyFieldDefinition,
} from './propertyChildren'
import {
  reprojectOwnersForRowStates,
  type ProjectableRow,
  type ProjectionLookups,
} from './internals/propertyChildrenProcessor'
import { readIsChildBackedWorkspace } from '@/data/workspaceSchema'
import { PendingIdleJobs, MarkerStore } from './internals/idleMarkerJobs'
import {
  parseAliasCollisionError,
  parseParentDeletedError,
  type ParsedAliasCollision,
} from './internals/raiseProtocol'
import { UndoManager, type UndoEntry } from './internals/undoManager'
import { replayApplicationOrder } from './internals/txSnapshots'
import { CallbackSet } from '@/utils/callbackSet'
import { scheduleDeepIdle, CATCHUP_DEEP_IDLE } from '@/utils/scheduleIdle'
import { ClientContext, type ClientContextReader } from './clientContext'
import type { TxImpl } from './internals/txEngine'
import { ANCESTORS_SQL, CHILDREN_SQL, SUBTREE_SQL } from './internals/treeQueries'
import {
  SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL,
  SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL,
  SELECT_BLOCK_BY_ID_SQL,
} from './internals/kernelQueries'
import type { InvalidationRule } from './invalidation'
import { KERNEL_PROPERTY_SEEDS } from './properties'
import { KERNEL_TYPE_CONTRIBUTIONS } from './blockTypes'
import { propertiesPageBlockId } from './propertiesPage'
import { typesPageBlockId } from './typesPage'
import { ProjectorRuntime } from './projectorRuntime'
import {USER_SCHEMAS_PROJECTOR_ID, UserSchemasService} from './userSchemasService'
import { UserTypesService } from './userTypesService'
import { TypeTagger } from './typeTagger'
import { FacetBridge } from './facetBridge'
import type {PropertyDefinitionRegistrySnapshot} from './propertyDefinitionRegistry'
import type {TypeDefinitionRegistrySnapshot} from './typeDefinitionRegistry'
import {buildUnboundTypes, materializingTypeSeeds} from './typeDefinitionRegistry'
import {
  materializePropertySeeds,
  materializeTypeSeeds,
  awaitPropertySeedMaterializationAccess,
} from './definitionSeeds'
import {
  propertySchemaResolverForWorkspace,
  type PropertySchemaResolver,
} from './internals/propertySchemaResolution'
import { runFreshInitialLoad } from './internals/freshInitialLoad'

/** Convert a `Mutator<Args, Result>` into the `repo.mutate` dispatcher
 *  signature `(args: Args) => Promise<Result>`. Used to project
 *  augmented `MutatorRegistry` entries into precise per-key types on
 *  the proxy field. */
type DispatchFor<M> = M extends Mutator<infer A, infer R>
  ? (args: A) => Promise<R>
  : never

/** Per-key dispatcher types for every mutator known at compile time —
 *  every `MutatorRegistry` member, plus the bare `core.<name>`-stripped
 *  shortcut. Plugins extend this surface by augmenting the
 *  `MutatorRegistry` interface from `@/data/api`; kernel mutators are
 *  augmented in `kernelMutators.ts`. */
type KnownMutateDispatch = {
  [K in keyof MutatorRegistry]: DispatchFor<MutatorRegistry[K]>
} & {
  [K in keyof MutatorRegistry as K extends `core.${infer Bare}`
    ? Bare
    : never]: DispatchFor<MutatorRegistry[K]>
}

/** Proxy contract surface. Known keys (above) get precise typing;
 *  unknown keys fall through the `any` index signature so dynamically
 *  loaded plugins that haven't augmented `MutatorRegistry` are still
 *  callable via `repo.mutate['plugin:foo'](args)`. The runtime
 *  argsSchema validation in `dispatchMutator` stays the source of truth
 *  for safety on those paths. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MutateProxy = KnownMutateDispatch & { [name: string]: (args: any) => Promise<any> }

/** Convert a `Query<Args, Result>` into the `repo.query` dispatcher
 *  signature `(args: Args) => LoaderHandle<Result>`. Mirrors
 *  `DispatchFor` for mutators. Returning the concrete `LoaderHandle<R>`
 *  (not just `Handle<R>`) keeps consistency with the existing
 *  `repo.subtree(id)` / `repo.children(id)` factories. */
type DispatchQueryFor<Q> = Q extends Query<infer A, infer R>
  ? (args: A) => LoaderHandle<R>
  : never

type KnownQueryDispatch = {
  [K in keyof QueryRegistry]: DispatchQueryFor<QueryRegistry[K]>
} & {
  [K in keyof QueryRegistry as K extends `core.${infer Bare}`
    ? Bare
    : never]: DispatchQueryFor<QueryRegistry[K]>
}

/** Proxy contract surface for `repo.query`. Mirrors `MutateProxy`:
 *  known keys (kernel + augmented plugins per `QueryRegistry`) get
 *  precise typing; unknown string keys fall through the `any` index
 *  so dynamically-loaded plugins are still callable via
 *  `repo.query['plugin:foo'](args)`. The argsSchema validation in
 *  `dispatchQuery` is the runtime safety boundary for those paths. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryProxy = KnownQueryDispatch & { [name: string]: (args: any) => LoaderHandle<any> }

// Stage-0 `_types` fallback before any runtime installs (overwritten synchronously
// by the constructor's kernel-runtime install). Built via `buildUnboundTypes` — the
// same synthesis the facet rebuild uses — so its entries are provenance-stripped
// (no `seedKey`/`revision`), byte-consistent with the post-install map rather than
// the raw `TypeSeedDeclaration`s `KERNEL_TYPE_CONTRIBUTIONS` now holds.
const KERNEL_TYPES = buildUnboundTypes(KERNEL_TYPE_CONTRIBUTIONS)
const KERNEL_PROPERTY_SEED_MAP = new Map(KERNEL_PROPERTY_SEEDS.map(seed => [seed.name, seed]))

/** The `repo.mutate` / `repo.query` proxy shape: string property access
 *  returns `dispatch(name)` (a fresh dispatcher closure per access —
 *  fine, the underlying registry lookup is a single Map.get); symbol
 *  access resolves to undefined. One implementation shared by the
 *  constructor's two proxies and the undoGroup facade's grouped
 *  `mutate`, so the shape can't drift between them. */
const nameDispatchProxy = <T,>(dispatch: (name: string) => unknown): T =>
  new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => (typeof prop === 'string' ? dispatch(prop) : undefined),
  }) as T

/** Bounded ring of recent tx entries surfaced via `repo.metrics().txLog`.
 *  Sized to comfortably cover a cold-start window (a few dozen txs) so
 *  diagnostic dumps right after page load don't lose entries. */
const TX_LOG_CAPACITY = 64

/** Registry key for the per-workspace undo manager when no workspace is
 *  active (issue #186). Workspace ids are UUIDs, so this sentinel can
 *  never collide with a real one. The manager under this key stays empty
 *  in practice — `repo.tx` only records under a pinned (non-null)
 *  workspace and `undo()`/`redo()` no-op when there's no active workspace. */
const NO_ACTIVE_WORKSPACE = '__no_active_workspace__'

/** Max `ctx.run` composition depth before we assume a cycle (a query
 *  composing itself, directly or transitively). Composition chains are
 *  shallow in practice; this just turns a stack overflow into a clear
 *  diagnostic. */
const MAX_QUERY_COMPOSITION_DEPTH = 32

/** Suffix (the part after the `reproject_ref:` prefix) of a per-workspace
 *  reprojection marker. Reprojection is workspace-scoped, so each workspace
 *  records its own "already backfilled name X" marker. Workspace ids are UUIDs
 *  (no colons), so this stays unambiguous even though property names can carry
 *  colons (e.g. `roam:isa`). */
const reprojectionMarkerKey = (workspaceId: string, name: string): string =>
  `${workspaceId}:${name}`

/** Suffix (after the `workspace_backfill:` prefix) of a per-workspace
 *  workspace-backfill completion marker — `<workspaceId>:<backfillId>`. Same
 *  shape/rationale as `reprojectionMarkerKey`. */
const workspaceBackfillMarkerKey = (workspaceId: string, id: string): string =>
  `${workspaceId}:${id}`

/** Equal iff `a` and `b` have the same key set AND `eq` holds for every shared
 *  key's values. An absent map is the empty map; the default `eq` compares keys
 *  only. `b.has(key)` gates the `b.get(key)!`, so a legitimately-undefined value
 *  isn't mistaken for a missing key. */
const sameKeyedMap = <T>(
  a: ReadonlyMap<string, T> | undefined,
  b: ReadonlyMap<string, T> | undefined,
  eq: (av: T, bv: T) => boolean = () => true,
): boolean => {
  const sizeA = a?.size ?? 0
  const sizeB = b?.size ?? 0
  if (sizeA !== sizeB) return false
  if (!a || !b) return true
  for (const [key, value] of a) {
    if (!b.has(key) || !eq(value, b.get(key)!)) return false
  }
  return true
}

/** True when two registry snapshots carry the same SET of seed keys (ignoring
 *  order, revisions, and everything else). Used to fire seed materialization
 *  only when the active workspace's declared seeds actually change — a new
 *  seed appearing (or one dropping) is the sole trigger the create/restore pass
 *  cares about; revisions are the operator step's concern (§4.3/§6.1). Treats
 *  an absent map as the empty set. */
const sameSeedKeySet = (
  a: ReadonlyMap<string, unknown> | undefined,
  b: ReadonlyMap<string, unknown> | undefined,
): boolean => sameKeyedMap(a, b)

/** Like {@link sameSeedKeySet}, but also compares each type seed's membership
 *  `id`. `materializeTypeSeeds` winner-resolves a duplicate-`id` group to its
 *  lowest-seed-key seed (`winnerTypeSeeds`), so an `id` change with no key added or
 *  removed can still change which seed materializes for that id (a de-collision, or a
 *  new lower-key claimant taking over), and the reschedule trigger must see it.
 *  Property seeds carry no such id-collision resolution, so their key-set diff alone
 *  suffices. */
const sameTypeSeedIdentities = (
  a: ReadonlyMap<string, {id: string}> | undefined,
  b: ReadonlyMap<string, {id: string}> | undefined,
): boolean => sameKeyedMap(a, b, (x, y) => x.id === y.id)

/** Equal iff two string sets carry the same members. Absent set = empty. Used to
 *  reschedule type-seed materialization when the CONTESTED seed-key set changes:
 *  `workspaceSeeds` withholds contested keys (`contestedSeedKeys`), and the
 *  keep-first winner they leave in `seedsByKey` may be byte-identical across a
 *  de-collision, so `sameTypeSeedIdentities` alone wouldn't see that a withheld
 *  key became materializable. */
const sameStringSet = (
  a: ReadonlySet<string> | undefined,
  b: ReadonlySet<string> | undefined,
): boolean => {
  const sizeA = a?.size ?? 0
  const sizeB = b?.size ?? 0
  if (sizeA !== sizeB) return false
  if (!a || !b) return true
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}

/** The one-deep "active-or-retained-previous" retain rule, expressed once.
 *  Serve `workspaceId` from the active snapshot, or the immediately-previous one
 *  still retained across a switch; any other (genuinely foreign) workspace
 *  resolves null (fail closed). Used both live and over a tx's frozen capture. */
const registryForWorkspace = (
  active: PropertyDefinitionRegistrySnapshot | null,
  previous: PropertyDefinitionRegistrySnapshot | null,
  workspaceId: string,
): PropertyDefinitionRegistrySnapshot | null =>
  active?.workspaceId === workspaceId
    ? active
    : previous?.workspaceId === workspaceId
      ? previous
      : null

export interface RepoOptions {
  db: PowerSyncDb
  cache: BlockCache
  user: User
  /** Read-only mode rejects `BlockDefault` / `References` writes
   *  (`ReadOnlyError`). `UiState` and `UserPrefs` writes still proceed
   *  and upload like any other write — any server-side RLS / FK
   *  rejection lands in the upload-rejection quarantine. Default false. */
  isReadOnly?: boolean
  /** Now provider — default `Date.now`. Injected for test determinism. */
  now?: () => number
  /** UUID provider — default `crypto.randomUUID`. Injected for tests
   *  that want deterministic ids. */
  newId?: () => string
  /** Monotonic INTEGER tx-grouping key provider, written into
   *  `tx_context.tx_seq` and copied to `ps_crud.tx_id` by the upload
   *  triggers. Default: a counter seeded from `Date.now()` so values
   *  never collide with anything from a prior run. Tests can inject a
   *  deterministic counter. */
  newTxSeq?: () => number
  /** When false, skip the construction-time kernel-runtime install so
   *  the Repo starts with empty registries. Default true: the
   *  constructor installs a kernel-only `FacetRuntime`
   *  (`kernelDataExtension`) so `repo.mutate.<kernel>` /
   *  `repo.query.<kernel>` work immediately through the same facet path
   *  a later `setFacetRuntime` uses — no separate per-facet registration
   *  flags. Callers that want to control the registry explicitly either
   *  pass `false` and call `setFacetRuntime` themselves, or just call
   *  `setFacetRuntime` (it REPLACES the kernel install). */
  installKernelRuntime?: boolean
  /** When true (default), the Layout B sync observer is started at
   *  construction time so sync-applied writes — staged into `blocks_synced`
   *  — materialize into the app-visible `blocks` table and invalidate
   *  handles (design doc §9.2). Set false in unit tests that want explicit
   *  control over drain timing — they call `repo.startSyncObserver()`
   *  themselves and `flushSyncObserver()` to settle deterministically. */
  startSyncObserver?: boolean
  /** Options forwarded to the sync observer when started. */
  syncObserverOptions?: SyncObserverOptions
  /** Layout B materialization POLICY — the §6 mode/key resolver (getCek +
   *  getMaterializability). Production (initRepo) passes the real resolver so
   *  e2ee rows decrypt, plaintext copies through, and locked/unpinned
   *  workspaces defer. Omitted in tests, which fall back to the plaintext
   *  copy-through stub below (no key). */
  syncObserverDeps?: MaterializeDeps
}

/** Repo-level knobs for the Layout B sync observer. `db` / `cache` /
 *  `handleStore` / `getInvalidationRules` / `deps` are supplied by the Repo
 *  itself; only these pass through from a caller. */
export type SyncObserverOptions = Pick<
  BlocksSyncedObserverArgs,
  'onCycleDetected' | 'throttleMs' | 'onError'
>

/** One CAS-guarded local-columns write for `stampReferenceTargets` —
 *  `reference_target_id` plus the `is_field_form` bit (§7 grammar box), both
 *  from the same derive. Strictly ADDITIVE: callers pass only rows the scan
 *  saw at a NULL target column,
 *  and the CAS re-checks (NULL column, unchanged content) inside the write tx
 *  — so a concurrent local edit or sync arrival that already owns the columns
 *  since the scan is never clobbered. Re-pointing an already-stamped row is
 *  deliberately out of scope (see `drainNameRederives`). `targetId` may be
 *  null for a marked row whose span doesn't resolve — the bit still stamps
 *  (pure syntax; only the target late-binds). */
interface ReferenceTargetStamp {
  id: string
  scannedContent: string
  targetId: string | null
  isFieldForm: boolean
}

/** What a stamping pass needs to also re-project the owners of rows it turns
 *  into field rows. `resolver` is CAPTURED at the pass's registry gate and
 *  threaded through — never re-read at write time. Both passes are deferred
 *  idle jobs that can span workspace switches, and
 *  `propertySchemaResolverFor` serves only the active or immediately-previous
 *  workspace: a run-time re-resolve after two switches fails closed, every
 *  fieldId stops resolving, and the repair silently becomes a no-op that no
 *  later scan can find again (the rows are no longer NULL-targeted). Same
 *  hazard, same fix, as `runPropertyDefinitionMigrationBatch`. */
interface ReferenceTargetStampContext {
  readonly workspaceId: string
  readonly resolver: PropertySchemaResolver
}

export class Repo {
  readonly db: PowerSyncDb
  readonly cache: BlockCache
  /** The client's indexical "acting-as" state (user, active workspace
   *  pin, active layout session) — one per client, 1:1 with this Repo.
   *  Semantics live in `clientContext.ts`; Repo keeps thin delegation
   *  shims (`user`, `activeWorkspaceId` + setter, `activeLayoutSessionId`
   *  + setter) so the public API is unchanged.
   *
   *  Held privately as the CONCRETE class — the public `client` getter
   *  below narrows to {@link ClientContextReader} so a caller reaching
   *  `repo.client.setActiveWorkspaceId(...)` directly (bypassing this
   *  Repo's transition) is a compile error, not just a documented
   *  convention. Repo's own delegating setters use this private field. */
  private readonly _client: ClientContext
  /** Read-only mode disables `BlockDefault` / `References` writes;
   *  UI-state and UserPrefs writes still pass through and queue to
   *  ps_crud — server-side rejection (RLS) lands in the rejection
   *  quarantine. Mutate via `repo.setReadOnly(value)` rather than
   *  direct field assignment so callers from inside React hooks don't
   *  trip `react-hooks/immutability` lint (the mutation should travel
   *  through a method, not a property write). */
  isReadOnly: boolean

  private readonly now: () => number
  private readonly newId: () => string
  private readonly newTxSeq: () => number
  private mutators: Map<string, AnyMutator> = new Map()
  private processors: Map<string, AnyPostCommitProcessor> = new Map()
  /** Same-tx processor registry — runs inside the user's
   *  writeTransaction in `runTx`. Kept separate from
   *  `this.processors` (post-commit) because the two have different
   *  ctx shapes and run at different pipeline stages; see
   *  `sameTxProcessorsFacet` doc in `facets.ts`. */
  private sameTxProcessors: Map<string, AnySameTxProcessor> = new Map()
  private queries: Map<string, AnyQuery> = new Map()
  private _types: ReadonlyMap<string, TypeContribution> = KERNEL_TYPES
  /** Active-workspace type-definition registry — the id-keyed, declaration-
   * authoritative snapshot behind `getTypeBlockId` (block-backed types resolve
   * to their durable block id) and the seed-provenance read-only gates. Null at
   * stage 0 before a workspace pin; `_types` still holds the code contributions.
   * Rebuilt by `applyTypesAndSchemas` from `projectedTypeDefinitionsFacet` +
   * `typeSeedsFacet`. */
  private _typeDefinitionRegistry: TypeDefinitionRegistrySnapshot | null = null
  private _propertySchemas: ReadonlyMap<string, AnyPropertySchema> = KERNEL_PROPERTY_SEED_MAP
  /** Atomic active-workspace definition snapshot. Null at stage 0 before a
   * workspace pin; identity resolution is unavailable in that state. */
  private _propertyDefinitionRegistry: PropertyDefinitionRegistrySnapshot | null = null
  /** The immediately-previous active workspace's snapshot, retained across one
   * switch so an in-flight read/tx that began for that workspace still resolves
   * against its REAL definitions (faithful shadow/winner info) instead of a
   * partial rebuild. Bounded to one workspace: anything older is genuinely
   * foreign and fails closed. Rotated by `applyTypesAndSchemas` on a pin to a
   * different workspace. */
  private _previousPropertyDefinitionRegistry: PropertyDefinitionRegistrySnapshot | null = null
  /** Original declaration-name multiplicity retained so both stage-0 and
   * snapshot-bound plain-schema fallbacks reject seed-owned names. */
  private _propertySeedNameCounts: ReadonlyMap<string, number> = new Map()
  private _propertyEditorOverrides: ReadonlyMap<string, AnyPropertyEditorOverride> = new Map()
  private _valuePresetCores: ReadonlyMap<string, AnyValuePresetCore> = new Map()
  private invalidationRules: readonly InvalidationRule[] = []
  /** Facet→registry bridge (audit D1(c)) — owns the installed
   *  FacetRuntime, the rebuild steps, the per-facet change subscriptions,
   *  and the React-facing schema/type/override/preset change channels.
   *  Constructed in the constructor (the rebuild steps write back into
   *  this Repo's registries through a callback target). */
  private readonly facetBridge: FacetBridge
  /** Listeners for user-surfaceable errors thrown from inside a
   *  `repo.tx` — currently `ProcessorRejection` from same-tx
   *  processors. Subscribers are responsible for the UI side
   *  (toast routing); the data layer stays UI-agnostic. */
  private readonly userErrorListeners = new CallbackSet<[ProcessorRejection]>('Repo.userErrors')
  /** Global query-registry epoch. Bumped by `swapQueries` (via
   *  `setFacetRuntime` / `__setQueriesForTesting`) when an existing query is
   *  REPLACED or REMOVED — NOT for a purely-additive swap (see
   *  `swapQueries`). The epoch is folded into EVERY query handle-store key,
   *  so a bump re-keys all queries at once:
   *
   *   - A handle, once obtained, is immutable: it stays at its epoch's key,
   *     keeps its captured registry snapshot, and keeps serving that
   *     version (a data-driven re-resolve re-runs against the SAME snapshot
   *     — see `dispatchQuery` / `runSubquery`, which pin the outer resolver
   *     and every `ctx.run` helper to the registry captured at creation).
   *   - Re-obtaining a handle (the next `repo.query` lookup, e.g. a remount
   *     or re-render) computes the new-epoch key → a fresh handle over the
   *     current registry → the new version.
   *
   *  Why one epoch instead of a per-name / composition-graph scheme on a
   *  replace/remove: a composed query's set of helpers is only known by
   *  RUNNING it, so any surgical "re-key just the affected queries" approach
   *  silently misses unobserved compositions — idle handles, first-load
   *  races, and data-conditional branches — and hands a fresh lookup
   *  pre-swap code. Re-keying everything is correct by construction.
   *
   *  Cost: a swap never re-resolves a LIVE handle in place; the cost of a
   *  bump is that the next render re-looks-up → fresh handle + cold resolve
   *  for every query, even unaffected ones. To keep that off the hot path we
   *  do NOT bump on additive swaps — and for an all-plugins-enabled user the
   *  cold-start `base→next` swap IS additive (adds dynamic-plugin queries
   *  while kernel/static instances stay identical), so the visible tree's
   *  already-loaded kernel queries (subtree/children/...) keep their handles.
   *  The over-resolve happens on a genuine replace/remove (plugin
   *  reload/disable) — rare and defensible — AND, today, once at cold start
   *  for users who've DISABLED a data-extension plugin (the bootstrap→base
   *  REMOVE; see the init-layer limitation note on `swapQueries`). */
  private queryEpoch = 0
  private readonly processorRunner: ProcessorRunner
  /** Type-tagging engine (audit D1(b)) — backs the `addType` /
   *  `removeType` / `toggleType` / `setBlockTypes` delegating methods. */
  private readonly typeTagger: TypeTagger
  /** Per-WORKSPACE undo / redo state (spec §10 step 7, §17 line 2228;
   *  issue #186). Each workspace gets its own `UndoManager` (independent
   *  per-scope stacks), so cmd-Z only ever acts on the workspace the user
   *  is looking at and a switch can never revert an edit in a workspace
   *  they've left — while switching back restores that workspace's
   *  history. The public `undoManager` getter resolves to the active
   *  workspace's manager; `repo.tx` records into the tx's pinned
   *  workspace; `repo.undo` / `repo.redo` pop + replay via
   *  `TxImpl.applyRaw`. */
  private readonly undoManagers = new Map<string, UndoManager>()
  /** Identity-stable Block facades, keyed by id. Block satisfies
   *  Handle<BlockData|null> structurally (spec §5.1, §5.2) — its
   *  row-grain reactivity goes through BlockCache.subscribe directly,
   *  so it doesn't need a HandleStore entry; this map IS its identity
   *  table. */
  private readonly blockFacades = new Map<string, Block>()
  /** Handle registry for query-backed collection factories: `children`,
   *  `subtree`, `ancestors`, plugin queries, etc. Identity rule:
   *  same key → same LoaderHandle instance. GC after `gcTimeMs` of
   *  zero subscribers + zero in-flight loads. The store also walks
   *  invalidation: TxEngine fast path + the Layout B sync observer
   *  call `handleStore.invalidate({…})` to fan out to dep-matching
   *  handles. */
  readonly handleStore: HandleStore = new HandleStore()
  /** Per-PowerSyncDb-call timings (getAll / getOptional / get /
   *  execute / writeTransaction). Populated by the metrics-wrapping
   *  proxy installed around `this.db` at construction. */
  readonly dbMetrics = new DbMetrics()
  /** Per-query-name resolve timings. The dispatcher records each
   *  `loader(ctx)` invocation here keyed by the query's full name. */
  readonly queryMetrics = new QueryMetrics()
  /** Counters for `reprojectRefTypedProperties`. Each call to the
   *  reprojection path increments these — useful when investigating
   *  bootstrap-time write-tx amplification triggered by user/plugin
   *  schema changes. Surfaced through `repo.metrics().reprojection`. */
  private readonly reprojectionMetrics = {
    calls: 0,
    schemasReprojected: 0,
    rowsScanned: 0,
    blocksUpdated: 0,
    msTotal: 0,
    skippedByMarker: 0,
    skippedByAbsence: 0,
  }
  /** Lazy in-memory mirror of the per-name reprojection markers in
   *  `client_schema_state` (rows keyed `reproject_ref:<workspaceId>:<name>`).
   *  Loaded on first reprojection call via a single
   *  `SELECT key … LIKE 'reproject_ref:%'` round-trip; afterwards
   *  `reprojectRefTypedProperties` skips ref-typed names already marked
   *  without further SQL. Constructed in the constructor (needs `this.db`).
   *  Tests / migrations that wipe the table call
   *  `__resetReprojectionMarkerCache` to force a reload. */
  private readonly reprojectionMarkers: MarkerStore
  /** In-flight reprojection runs whose deferral timer has already fired.
   *  `scheduleReprojection` is fire-and-forget (the cold-start path must
   *  not block on it); `awaitReprojections()` drains this for
   *  deterministic test quiescence and to keep a stray reprojection from
   *  writing into the next test on a shared DB.
   *
   *  These three maintenance passes are one-time-per-workspace data-completeness
   *  catch-ups (derived backlinks, daily-note:date etc., shadow-bug recovery),
   *  so they run on deep idle off the cold-start window — but WITH a fallback so
   *  a never-idle session still completes them this session (CATCHUP_DEEP_IDLE),
   *  unlike the lazy data-integrity audit which may skip a session. */
  private readonly reprojectionJobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, CATCHUP_DEEP_IDLE))
  /** Registered workspace backfills (`workspaceBackfillsFacet` snapshot,
   *  refreshed by the `workspaceBackfills` rebuild step). Run once per
   *  workspace by `scheduleWorkspaceBackfills`. */
  private _workspaceBackfills: readonly WorkspaceBackfill[] = []
  /** Lazy in-memory mirror of the workspace-backfill completion markers in
   *  `client_schema_state` (rows keyed `workspace_backfill:<ws>:<id>`), same
   *  pattern as `reprojectionMarkers`. Constructed in the constructor. */
  private readonly workspaceBackfillMarkers: MarkerStore
  /** In-flight workspace-backfill runs whose deferral timer has fired —
   *  drained by `awaitWorkspaceBackfills()` for deterministic test quiescence,
   *  mirroring `reprojectionJobs`. */
  private readonly workspaceBackfillJobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, CATCHUP_DEEP_IDLE))
  /** In-flight one-time reconcile-rescan runs — drained by
   *  `awaitReconcileRescans()`, same pattern. */
  private readonly reconcileRescanJobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, CATCHUP_DEEP_IDLE))
  /** Workspaces whose reference-target catch-up sweep ran THIS SESSION
   *  (adversarial-review round 2: a durable once-ever marker permanently
   *  missed definitions/aliases that arrived while the app was closed or
   *  the workspace inactive). Cost honesty: the CANDIDATE SET shrinks after
   *  the first run, but the LIKE prefilter itself is an O(table) scan on
   *  every open (~50ms native / a few hundred ms in-browser at 350k rows) —
   *  deep idle, once per workspace open; a partial expression index on the
   *  content-shape predicate is the escape hatch if it ever matters. */
  private readonly referenceTargetSweepDone = new Set<string>()
  /** Accumulated `[[name]]`/alias re-derive requests per workspace, drained
   *  in ONE batched scan per drain (never one scan per name). Names only
   *  accumulate after the workspace's sweep ran (pre-sweep, the sweep
   *  covers them); a drain that finds the registry pointed elsewhere leaves
   *  the set intact and re-arms when that workspace's registry primes. */
  private readonly pendingNameRederives = new Map<string, Set<string>>()
  private readonly nameRederiveDrainScheduled = new Set<string>()
  /** In-flight reference-target derive passes — drained by
   *  `awaitReferenceTargetDerive()`, same pattern. */
  private readonly referenceTargetDeriveJobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, CATCHUP_DEEP_IDLE))
  /** In-flight rename-reproject / codec re-encode migration passes
   *  (PR #288 §7/§9, slice B2) — drained by
   *  `awaitPropertyDefinitionMigrations()`, same pattern. */
  private readonly propertyDefinitionMigrationJobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, CATCHUP_DEEP_IDLE))
  /** In-flight property-seed materialization passes (§4.3 of the schema-
   *  unification design) — drained by `awaitSeedMaterialization()`. Unlike its
   *  siblings the pass is create/restore-only + idempotent rather than
   *  marker-gated once-per-workspace, so it can re-run on every seed-set change
   *  (a probe SELECT that short-circuits in steady state). */
  private readonly seedMaterializationJobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, CATCHUP_DEEP_IDLE))
  /** The "trigger generation" the seed-materialization access gate references.
   *  A deferred pass parks on the membership row before writing; the App defaults
   *  a not-yet-synced role to writable, so on a workspace whose membership never
   *  syncs that wait never resolves. Without an abort, every subsequent seed-set
   *  change would park another job (and its members subscription), unbounded.
   *  Aborted + renewed whenever the active workspace changes, so parked waits for
   *  a workspace we've left terminate promptly. */
  private seedMaterializationGeneration = new AbortController()
  /** Workspaces with a seed-materialization pass already queued or parked.
   *  Repeated seed-set changes within one workspace (e.g. toggling several
   *  dynamic extensions) coalesce onto the one pending pass instead of stacking
   *  a job + a `workspace_members` subscription each; the pending pass reads the
   *  LATEST seed set when it runs, so nothing is missed. Cleared when it settles. */
  private readonly pendingSeedMaterializationWorkspaces = new Set<string>()
  /** Workspaces whose seed set changed while a pass was already in flight AND had
   *  already snapshotted its seeds (or was aborted mid-flight). Coalescing onto the
   *  running pass would drop that change — the pass materializes only its old
   *  snapshot. Instead we mark the workspace dirty and re-schedule ONE more pass
   *  once the running one settles, so a newly-enabled extension's definitions land
   *  without waiting for the next unrelated seed change or a workspace reopen. */
  private readonly dirtySeedMaterializationWorkspaces = new Set<string>()
  /** Slowest writeTransaction observed since the last reset, by
   *  description (`opts.description` passed to `repo.tx`). Updated only
   *  when a tx exceeds the previous high-water mark, so the field is
   *  cheap to maintain in the hot path. Surfaces through
   *  `repo.metrics().db.slowestTx`. */
  private slowestTx: {description: string | null; ms: number} = {description: null, ms: 0}
  /** Bounded log of recent tx (description, ms) — used to attribute
   *  cold-start `writeTransaction` totals to specific call sites. The
   *  most recent `TX_LOG_CAPACITY` entries are retained; older drops
   *  are silent. Surfaces through `repo.metrics().txLog`. */
  private readonly txLog: Array<{description: string | null; ms: number}> = []
  /** Active Layout B sync observer (design doc §9.2): drains the
   *  `blocks_synced` staging table into the app-visible `blocks` table and
   *  invalidates cache + handles. Replaces the row_events tail. Lazy:
   *  created on first start, replaced on subsequent starts. Tests can
   *  `dispose()` and re-`start` for deterministic flushing. */
  private syncObserver: BlocksSyncedObserver | null = null
  /** §6 mode/key resolver for the observer (undefined ⇒ plaintext stub). Public
   *  so the data-integrity plugin's audit runner can reuse the same resolver for
   *  the divergence decrypt-compare (undefined in tests ⇒ cleartext-only). */
  readonly syncObserverDeps?: MaterializeDeps
  /** Instance discriminator for memoization keys that need to vary
   *  across Repo instances (e.g. lodash.memoize calls in the panel /
   *  user-page bootstrap). Auto-incremented per construction. */
  private static nextInstanceId = 1
  readonly instanceId: number = Repo.nextInstanceId++

  /** Hydrate a list of `BlockRow`s into the cache + return parsed
   *  BlockData[]. Internal helper for kernel queries. Callers choose
   *  whether returned rows are part of the query result (`row` deps) or
   *  only cache priming (`no row` deps). Accepts readonly so it pairs
   *  cleanly with the QueryCtx plumbing in `dispatchQuery`. */
  private hydrateRows(
    rows: ReadonlyArray<BlockRow>,
    opts: {ctx?: ResolveContext; declareRowDeps?: boolean} = {},
  ): BlockData[] {
    const {ctx, declareRowDeps = Boolean(ctx)} = opts
    const out: BlockData[] = []
    for (const r of rows) {
      const data = parseBlockRow(r)
      this.cache.applyIfNewer(data, 'hydrate')
      if (ctx && declareRowDeps) ctx.depend({kind: 'row', id: data.id})
      out.push(data)
    }
    return out
  }

  get types(): ReadonlyMap<string, TypeContribution> {
    return this._types
  }

  get propertySchemas(): ReadonlyMap<string, AnyPropertySchema> {
    return this._propertySchemas
  }

  get propertyDefinitions(): PropertyDefinitionRegistrySnapshot | null {
    return this._propertyDefinitionRegistry
  }

  /** Active-workspace type-definition registry snapshot (kernel/plugin code
   *  types are NOT in it — those live only in `types`; this is the block-built +
   *  seed side that `getTypeBlockId` and the seed read-only gates read). Null
   *  before a workspace pin. */
  get typeDefinitions(): TypeDefinitionRegistrySnapshot | null {
    return this._typeDefinitionRegistry
  }

  /** Internal identity boundary factory. The caller supplies the target row's
   * workspace (the transaction layer owns that fact); resolve() itself accepts
   * only a handle/name and is therefore immune to ambient workspace switches. */
  propertySchemaResolverFor(workspaceId: string): PropertySchemaResolver {
    // Serve the active workspace, or the immediately-previous one still retained
    // across a switch, from its faithful snapshot. Any other (genuinely foreign)
    // workspace fails closed — we never synthesise a partial seeds-only snapshot
    // for a workspace whose definitions aren't loaded (which could resolve a
    // shadowed seed as a winner). The stage-0/active boot window (null snapshot +
    // allow-plain) still uses the transitional resolver.
    const snapshot = registryForWorkspace(
      this._propertyDefinitionRegistry,
      this._previousPropertyDefinitionRegistry,
      workspaceId,
    )
    return propertySchemaResolverForWorkspace(
      snapshot,
      workspaceId,
      this._propertySeedNameCounts,
      this.client.activeWorkspaceId === null || workspaceId === this.client.activeWorkspaceId,
    )
  }

  get propertyEditorOverrides(): ReadonlyMap<string, AnyPropertyEditorOverride> {
    return this._propertyEditorOverrides
  }

  get valuePresetCores(): ReadonlyMap<string, AnyValuePresetCore> {
    return this._valuePresetCores
  }

  /** Deterministic id of the workspace's Properties page (parent of
   *  all `'property-schema'` blocks). Created lazily by
   *  `getOrCreatePropertiesPage` during workspace bootstrap. */
  get propertiesPageId(): string | null {
    if (!this.client.activeWorkspaceId) return null
    return propertiesPageBlockId(this.client.activeWorkspaceId)
  }

  /** Registry + driver for definition-block projectors (the
   *  data-defined "watch a meta-type → mirror into a facet bucket"
   *  pattern, issue #90). The synchronous Repo workspace pin owns the
   *  lifecycle for every projector in `definitionBlockProjectorFacet`.
   *  Each incoming generation exposes an awaitable first-tick prime. The
   *  `userSchemas` / `userTypes` facades read their state through it. */
  readonly projectors: ProjectorRuntime = new ProjectorRuntime(this)

  /** Thin facade over the Repo-owned `'user-schemas'` projector. The
   *  projector runtime owns its lifecycle, contribution state, and indexes;
   *  the Repo pin starts its workspace generation before callers can perform
   *  workspace work. */
  readonly userSchemas: UserSchemasService = new UserSchemasService(this)

  /** Thin facade over the Repo-owned `'user-types'` projector. The projector
   *  runtime owns its lifecycle, contribution state, and indexes. It depends on
   *  `'user-schemas'` (started first) to resolve block-type:properties
   *  refList entries to live property schemas. */
  readonly userTypes: UserTypesService = new UserTypesService(this)

  /** Deterministic id of the workspace's Types page (parent of every
   *  `'block-type'` block in the workspace). Created lazily by
   *  `getOrCreateTypesPage` during workspace bootstrap. */
  get typesPageId(): string | null {
    if (!this.client.activeWorkspaceId) return null
    return typesPageBlockId(this.client.activeWorkspaceId)
  }

  /** Run `CHILDREN_SQL` for `parentId` and hydrate every row into the
   *  per-row cache. Shared by the `repo.load(id, {children: true})`
   *  opts path, `repo.children(id)` handle, and the hydrating variant
   *  of `repo.childIds(id)`. Collection-level reactivity is owned by
   *  the `LoaderHandle` returned from `repo.children` / `repo.childIds`
   *  — `BlockCache` doesn't track per-parent "loaded" state. */
  private async hydrateChildren(parentId: string, ctx?: ResolveContext): Promise<BlockData[]> {
    const rows = await this.db.getAll<BlockRow>(CHILDREN_SQL, [parentId])
    return this.hydrateRows(rows, {ctx})
  }

  /** Typed-dispatch sugar. `repo.mutate.indent({id})` opens a 1-mutator
   *  tx with the mutator's scope and runs it. Lookup tries the literal
   *  key first (`'tasks:setDueDate'` for plugin mutators), then
   *  `'core.${name}'` (so the bare `repo.mutate.indent` resolves to
   *  `'core.indent'`).
   *
   *  Typing surface (Phase 3 — chunk C): keys present in
   *  `MutatorRegistry` (kernel + augmented plugins, see §12.1) get
   *  precise `(args: Args) => Promise<Result>` types; the
   *  `core.<name>`-stripped form is also typed. Unknown keys
   *  (dynamically-loaded plugins that haven't augmented the registry)
   *  fall back to a permissive `(args: any) => Promise<any>` index
   *  signature so string-key access stays callable. */
  readonly mutate: MutateProxy

  /** Typed query dispatch. `repo.query.subtree({id})` returns an
   *  identity-stable `LoaderHandle<R>` (the same instance for the same
   *  args, GC'd via HandleStore). Lookup tries the literal `name` first
   *  (`'core.subtree'` or `'plugin:foo'`), then `'core.${name}'` so the
   *  bare `repo.query.subtree` resolves to `'core.subtree'`. Args are
   *  validated against `Query.argsSchema` on every call.
   *
   *  Typing surface mirrors `repo.mutate`: keys present in
   *  `QueryRegistry` (kernel + augmented plugins) get precise
   *  `(args: Args) => LoaderHandle<Result>` types; the
   *  `core.<name>`-stripped form is also typed. Unknown keys
   *  (dynamically-loaded plugins that haven't augmented the registry)
   *  fall back to a permissive `(args: any) => LoaderHandle<any>` index
   *  signature so string-key access stays callable. The runtime
   *  `argsSchema` validation in `dispatchQuery` is the safety boundary
   *  for those paths. */
  readonly query: QueryProxy

  constructor(opts: RepoOptions) {
    // Wrap the raw PowerSyncDb so every read/write call goes through
    // the timing proxy. Internal Repo code, processors, runTx, and the
    // sync observer all consume `this.db` — they all get the wrapped
    // surface for free. External callers that hold the original
    // `opts.db` reference are NOT instrumented; pass `repo.db` if you
    // want timings (or use `repo.runQuery` / `repo.tx` which already
    // route through it). The wrapper has the same shape, so existing
    // type contracts hold.
    this.db = wrapDbWithMetrics(opts.db, this.dbMetrics) as PowerSyncDb
    // Marker stores need the wrapped `this.db`, so they're built here
    // rather than as field initializers (which run before the body).
    this.reprojectionMarkers = new MarkerStore(
      this.db,
      REPROJECT_REF_MARKER_PREFIX,
      SELECT_REPROJECT_REF_MARKERS_SQL,
      RECORD_REPROJECT_REF_MARKER_SQL,
      CLEAR_REPROJECT_REF_MARKER_SQL,
    )
    this.workspaceBackfillMarkers = new MarkerStore(
      this.db,
      WORKSPACE_BACKFILL_MARKER_PREFIX,
      SELECT_WORKSPACE_BACKFILL_MARKERS_SQL,
      RECORD_WORKSPACE_BACKFILL_MARKER_SQL,
    )
    this.syncObserverDeps = opts.syncObserverDeps
    this.cache = opts.cache
    this._client = new ClientContext({user: opts.user})
    this.isReadOnly = opts.isReadOnly ?? false
    this.now = opts.now ?? Date.now
    this.newId = opts.newId ?? uuidv4
    // Default tx-seq provider: monotonic counter seeded above any
    // value a prior Repo instance could have written. Date.now() in
    // milliseconds is plenty of headroom (Number.MAX_SAFE_INTEGER /
    // ms-per-day ~= a few hundred thousand years).
    if (opts.newTxSeq) {
      this.newTxSeq = opts.newTxSeq
    } else {
      let seq = Date.now()
      this.newTxSeq = () => ++seq
    }
    // Kernel contributions are installed via the facet runtime at the
    // end of this constructor (see `installKernelRuntime` below) — one
    // registration path shared with `setFacetRuntime`, no per-facet
    // flags and no dual kernel registration (audit B1(1)).
    // Initialize the processor runner. The runner needs a Repo
    // reference for opening processor txs; passing `this` is safe
    // because runner methods only use it post-construction (during
    // dispatch). The runner reads its registry per-tx from the snapshot
    // baked into TxResult — we don't sync a registry into the runner
    // here.
    this.processorRunner = new ProcessorRunner(this, this.db)
    // Type-tagging engine (audit D1(b)). Repo keeps spec-pinned
    // delegating methods over this single instance.
    this.typeTagger = new TypeTagger(this)
    // Facet→registry bridge (audit D1(c)). The rebuild steps write their
    // results back into this Repo's registries through these closures;
    // the bridge owns the runtime, the steps, the per-facet change
    // subscriptions, and the React change channels.
    this.facetBridge = new FacetBridge({
      getPropertySchemas: () => this._propertySchemas,
      getPropertyDefinitionProjector: () => this.propertyDefinitionProjector(),
      applyMutators: (mutators) => { this.mutators = mutators },
      applyProcessors: (processors) => { this.processors = processors },
      applySameTxProcessors: (processors) => { this.sameTxProcessors = processors },
      applyInvalidationRules: (rules) => { this.invalidationRules = rules },
      applyWorkspaceBackfills: (backfills) => { this._workspaceBackfills = backfills },
      applyTypesAndSchemas: (
        types,
        propertySchemas,
        propertyDefinitions,
        propertySeedNameCounts,
        typeDefinitions,
      ) => {
        this._types = types
        this._propertySchemas = propertySchemas
        // Retain the outgoing workspace's faithful snapshot when pinning a
        // DIFFERENT workspace, so an in-flight read/tx that began for it still
        // resolves against real definitions. A same-workspace rebuild (contribution
        // change) or a re-prime doesn't rotate the slot.
        //
        // Derive the incoming workspace from EITHER registry: `typeDefinitions` is
        // built without the property registry's priming gate (facetBridge), so a
        // type-only seed change can land while `propertyDefinitions` is still null.
        // Falling back to the type registry's workspace keeps both the retention
        // check and the reschedule guard below from mistaking that window for "no
        // workspace" and skipping a type-seed materialization pass.
        const incomingWorkspaceId =
          propertyDefinitions?.workspaceId ?? typeDefinitions?.workspaceId ?? null
        const currentWorkspaceId = this._propertyDefinitionRegistry?.workspaceId ?? null
        if (this._propertyDefinitionRegistry && incomingWorkspaceId !== currentWorkspaceId) {
          this._previousPropertyDefinitionRegistry = this._propertyDefinitionRegistry
        }
        // Seed materialization (§4.3): plugin/dynamic seeds first appear when the
        // toggle-aware app runtime installs in a post-paint effect, long after
        // bootstrap ran — so re-run the create/restore pass whenever this active
        // workspace's materializable seed set changes (not on every type/preset
        // rebuild). Diff BOTH registries against their PRIOR value (so assign them
        // AFTER): a type seed (a `seedType` contribution) can appear post-bootstrap
        // on its own, with no property-seed change to piggyback the reschedule on.
        // The type diff is id-aware (`sameTypeSeedIdentities`): materializability
        // there also depends on membership-id collisions, so an id that de-collides
        // without a key change must still reschedule. It is also contested-key-aware
        // (`sameStringSet` over `contestedSeedKeys`): a withheld duplicate-key seed
        // leaves a byte-identical keep-first winner in `seedsByKey`, so a de-collision
        // that makes it materializable again must reschedule even though the id diff
        // sees no change.
        const seedsChanged =
          !sameSeedKeySet(this._propertyDefinitionRegistry?.seedsByKey, propertyDefinitions?.seedsByKey) ||
          !sameTypeSeedIdentities(this._typeDefinitionRegistry?.seedsByKey, typeDefinitions?.seedsByKey) ||
          !sameStringSet(this._typeDefinitionRegistry?.contestedSeedKeys, typeDefinitions?.contestedSeedKeys)
        this._propertyDefinitionRegistry = propertyDefinitions
        this._typeDefinitionRegistry = typeDefinitions
        this._propertySeedNameCounts = propertySeedNameCounts
        if (seedsChanged && incomingWorkspaceId !== null && incomingWorkspaceId === this.client.activeWorkspaceId) {
          this.scheduleWorkspaceSeedMaterialization(incomingWorkspaceId, false)
        }
        // Re-arm name-rederive drains parked while this workspace's registry
        // wasn't primed (drainNameRederives leaves the pending set intact in
        // that case).
        if (
          incomingWorkspaceId !== null
          && (this.pendingNameRederives.get(incomingWorkspaceId)?.size ?? 0) > 0
          && !this.nameRederiveDrainScheduled.has(incomingWorkspaceId)
        ) {
          this.nameRederiveDrainScheduled.add(incomingWorkspaceId)
          this.referenceTargetDeriveJobs.schedule(() => this.drainNameRederives(incomingWorkspaceId))
        }
      },
      applyPropertyEditorOverrides: (overrides) => { this._propertyEditorOverrides = overrides },
      applyValuePresetCores: (presets) => { this._valuePresetCores = presets },
      applyQueries: (queries) => { this.swapQueries(queries) },
      scheduleReprojection: (names, schemas) => { this.scheduleReprojection(names, schemas) },
      getPropertyDefinitions: () => this._propertyDefinitionRegistry,
      schedulePropertyDefinitionMigrations: (workspaceId, changes) => {
        this.schedulePropertyDefinitionMigrations(workspaceId, changes)
      },
    })
    this.mutate = nameDispatchProxy<MutateProxy>(name => this.dispatchMutator(name))
    // Identity stability for query handles is provided by the
    // handle-store key inside `dispatchQuery`, not by memoizing the
    // dispatcher itself.
    this.query = nameDispatchProxy<QueryProxy>(name => this.dispatchQuery(name))
    // Install the kernel-only FacetRuntime so the kernel mutators,
    // queries, same-tx processors, invalidation rule, property schemas,
    // and type contributions are live before any `setFacetRuntime` swap
    // (audit B1(1)). This is the SAME path a later swap takes — it
    // REPLACES this install with the merged kernel + plugin registry —
    // so there is exactly one kernel registration path. Reprojection
    // scheduling is gated on an active workspace (none yet at
    // construction), so this does no DB work. Tests/tooling that need
    // empty registries pass `installKernelRuntime: false`.
    if (opts.installKernelRuntime ?? true) {
      this.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
    }
    // Start the Layout B sync observer by default (design doc §9.2).
    // Tests that want deterministic timing pass startSyncObserver: false
    // and call repo.startSyncObserver() + flushSyncObserver() themselves
    // before issuing sync-style writes into `blocks_synced`.
    if (opts.startSyncObserver ?? true) {
      this.startSyncObserver(opts.syncObserverOptions)
    }
  }

  /** Start the Layout B sync observer (design doc §9.2). Idempotent in
   *  spirit: if one is already running, it's disposed first so the new
   *  options take effect. Returns the observer for inspection / manual
   *  flushing. */
  startSyncObserver(options?: SyncObserverOptions): BlocksSyncedObserver {
    if (this.syncObserver) this.syncObserver.dispose()
    // Production passes the §6 mode/key resolver (initRepo). Tests omit it
    // and fall back to plaintext copy-through with no key — the historical
    // behavior, so non-e2ee tests are unaffected.
    const policyDeps = this.syncObserverDeps
      ?? { getMaterializability: (): Materializability => 'copy', getCek: async () => null }
    this.syncObserver = startBlocksSyncedObserver({
      db: this.db,
      cache: this.cache,
      handleStore: this.handleStore,
      deps: {
        ...policyDeps,
        // Derive-at-arrival seam (PR #288 slice A): always attached — the
        // LOCAL `reference_target_id` column must track content for
        // sync-applied rows on every device, e2ee included (derivation runs
        // over decrypted content). Resolution mirrors
        // `core.deriveReferenceTarget`: schema-name winner map first, then
        // the `block_aliases` index read on the open write tx (so
        // same-window alias/definition arrivals resolve).
        referenceTargetLookups: policyDeps.referenceTargetLookups
          ?? (tx => this.referenceTargetLookupsVia(tx)),
        onAliasTargetsAdded: policyDeps.onAliasTargetsAdded
          ?? ((workspaceId, aliases) =>
            this.scheduleReferenceTargetNameRederive(workspaceId, aliases)),
      },
      getInvalidationRules: () => this.invalidationRules,
      onCycleDetected: options?.onCycleDetected,
      throttleMs: options?.throttleMs,
      onError: options?.onError,
    })
    return this.syncObserver
  }

  /** Dispose the active sync observer (no-op if none). Tests use this to
   *  detach the subscription before tearing down the test DB. */
  stopSyncObserver(): void {
    if (this.syncObserver) {
      this.syncObserver.dispose()
      this.syncObserver = null
    }
  }

  /** Manually flush the sync observer — drains any pending `blocks_synced`
   *  changes into `blocks` and walks `handleStore.invalidate(...)`. Tests
   *  use this instead of waiting on the throttle window; it's a real settle
   *  barrier (awaits every drain enqueued before it). */
  async flushSyncObserver(): Promise<void> {
    if (this.syncObserver) await this.syncObserver.flush()
  }

  /** Re-materialize a workspace's staged `blocks_synced` rows after it becomes
   *  materializable (WK pasted / plaintext confirmed via the §8.2 gate). No-op
   *  if the observer isn't running. */
  async drainSyncWorkspace(workspaceId: string): Promise<void> {
    if (this.syncObserver) await this.syncObserver.drainWorkspace(workspaceId)
  }

  /** Frozen snapshot of internal data-layer counters + timings
   *  (perf-baseline follow-up #4). Returns four subsections:
   *
   *    - `handleStore` — invalidate fan-out (`invalidations`,
   *      `handlesWalked`, `handlesMatched`) and per-LoaderHandle
   *      lifecycle (`loaderInvalidations`, `loaderRuns`,
   *      `midLoadInvalidations`, `reloadsAfterSettle`,
   *      `notifiesFired`, `notifiesSkippedByDiff`).
   *    - `blockCache` — write/notify activity
   *      (`setSnapshotCalls`, `setSnapshotDedupHits/Misses`,
   *      `applyIfNewerSyncCalls`/`Rejected` for row_events-tail
   *      arrivals, `applyIfNewerHydrateCalls`/`Rejected` for
   *      kernel-query `hydrateRows` + `repo.load` re-reads,
   *      `notifies`).
   *    - `queries` — per-query-name resolve timings keyed by full
   *      name (e.g. `core.subtree`, `plugin:tasks/dueSoon`). Each
   *      entry is a `TimingSnapshot` with `calls`, mean, p50/p95/p99,
   *      min/max, and totalMs. Empty until a query runs.
   *    - `db` — aggregate PowerSyncDb call timings split by method
   *      (`getAll`, `getOptional`, `get`, `execute`, `writeTransaction`).
   *      `writeTransaction` records full wall-clock for the tx; the
   *      tx-internal SQL calls also count against their respective
   *      buckets — so a single `mutate.X` typically registers one
   *      `writeTransaction` sample plus several inner-SQL samples.
   *
   *  Plain counters are monotonic from the last `resetMetrics()` (or
   *  Repo construction). Timing reservoirs hold the last 256 samples
   *  for percentile estimation; their `calls` field is unbounded.
   *
   *  Each call returns a fresh frozen object so callers can keep two
   *  snapshots and diff them.
   *
   *  Useful as:
   *    - regression detection in production (`handlesWalked /
   *      invalidations` should drop once the inverted-index lands;
   *      `queries['backlinks.forBlock'].p95Ms` should drop once the
   *      backlinks index lands),
   *    - cold-start investigation (open a page, `repo.metrics()`,
   *      see which queries dominated and how many SQL roundtrips
   *      they incurred),
   *    - in-app debug panels that surface latency distributions
   *      without needing a Playwright + profiler harness. */
  metrics(): Readonly<{
    handleStore: Readonly<Record<string, number>>
    /** Live-state aggregates over the registered handle set: handle
     *  count, dep-count percentiles, and the top-3 keys by dep count.
     *  Pairs with `handleStore` counters — counters describe events
     *  since the last reset, this describes the store right now. Use
     *  the top-heavy list to spot resolvers that are over-registering
     *  deps. */
    handleStoreInventory: ReturnType<HandleStore['snapshotInventory']>
    blockCache: Readonly<Record<string, number>>
    queries: Readonly<Record<string, ReturnType<QueryMetrics['snapshot']>[string]>>
    db: ReturnType<DbMetrics['snapshot']>
    /** High-water mark across all `repo.tx` calls since the last reset.
     *  Pairs with `db.writeTransaction.maxMs` to attribute outliers to a
     *  concrete description (e.g. 'reproject ref-typed properties after
     *  schema swap'). `description: null` means the slowest tx so far
     *  was opened without a description. */
    slowestTx: Readonly<{description: string | null; ms: number}>
    /** Bounded list of recent (description, ms) entries — the most
     *  recent `TX_LOG_CAPACITY` writeTransactions across the Repo's
     *  lifetime since the last reset. Lets a cold-start metrics dump
     *  attribute every observed writeTransaction sample to a concrete
     *  call site. Order is oldest-to-newest. */
    txLog: ReadonlyArray<Readonly<{description: string | null; ms: number}>>
    reprojection: Readonly<{
      calls: number
      schemasReprojected: number
      rowsScanned: number
      blocksUpdated: number
      msTotal: number
      skippedByMarker: number
      skippedByAbsence: number
    }>
  }> {
    return Object.freeze({
      handleStore: this.handleStore.metrics.snapshot(),
      handleStoreInventory: this.handleStore.snapshotInventory(),
      blockCache: this.cache.metrics.snapshot(),
      queries: this.queryMetrics.snapshot(),
      db: this.dbMetrics.snapshot(),
      slowestTx: Object.freeze({...this.slowestTx}),
      txLog: Object.freeze(this.txLog.map(entry => Object.freeze({...entry}))),
      reprojection: Object.freeze({...this.reprojectionMetrics}),
    })
  }

  /** Zero every counter and reservoir in `repo.metrics()`. Use to
   *  mark a baseline before measuring a discrete operation (e.g. a
   *  benchmark iteration, a UI interaction in a soak test, or a
   *  cold-start "open page → metrics" investigation). */
  resetMetrics(): void {
    this.handleStore.metrics.reset()
    this.cache.metrics.reset()
    this.queryMetrics.reset()
    this.dbMetrics.reset()
    this.reprojectionMetrics.calls = 0
    this.reprojectionMetrics.schemasReprojected = 0
    this.reprojectionMetrics.rowsScanned = 0
    this.reprojectionMetrics.blocksUpdated = 0
    this.reprojectionMetrics.msTotal = 0
    this.reprojectionMetrics.skippedByMarker = 0
    this.reprojectionMetrics.skippedByAbsence = 0
    this.slowestTx = {description: null, ms: 0}
    this.txLog.length = 0
  }

  /** Get a `Block` facade for `id`. Sync — does NOT load. Read access
   *  on the returned facade (`block.data`, `block.peek()`, etc.) is gated
   *  by what's in cache; call `block.load()` or `repo.load(id)` first
   *  for guaranteed availability. The same `Block` instance is returned
   *  on repeat calls so identity-based React keys / memo work. */
  block(id: string): Block {
    let cached = this.blockFacades.get(id)
    if (!cached) {
      cached = new Block(this, id)
      this.blockFacades.set(id, cached)
    }
    return cached
  }

  /** Load a row + (optionally) a neighborhood into the cache. Spec §5.2.
   *
   *    repo.load(id)                          → just the row
   *    repo.load(id, {children: true})        → row + immediate children
   *    repo.load(id, {ancestors: true})       → row + full parent chain
   *    repo.load(id, {descendants: N})        → row + subtree clipped at
   *                                              depth N (or whole tree
   *                                              if N is omitted/falsy
   *                                              for descendants:true)
   *
   *  Hydrates rows into the cache so subsequent `block.peek()` /
   *  `block.data` calls succeed. Collection reactivity (children /
   *  subtree handles) is owned by the HandleStore, not this loader —
   *  use `repo.query.children({id}).load()` if you want a
   *  handle-cached child-rows list with structural invalidation.
   *
   *  Concurrency note: this method does NOT dedup concurrent loads. An
   *  id-only in-flight cache would silently merge a plain `repo.load(id)`
   *  with a concurrent `repo.load(id, {children: true})` — the second
   *  caller would see the plain promise resolve and miss the children.
   *  Load-dedup that matters for Suspense lives one layer up, at the
   *  `Block` facade (`block.load()`, keyed by Block identity). Inlining
   *  here costs at most one extra row read per concurrent caller; the
   *  cache's `setSnapshot` is fingerprint-deduplicated so listeners
   *  don't fire twice. */
  async load(
    id: string,
    opts?: { children?: boolean; ancestors?: boolean; descendants?: boolean | number },
  ): Promise<BlockData | null> {
    const row = await this.db.getOptional<BlockRow>(
      'SELECT * FROM blocks WHERE id = ? AND deleted = 0', [id],
    )
    if (row === null) {
      this.cache.markMissing(id)
      return null
    }
    const data = parseBlockRow(row)
    this.cache.applyIfNewer(data, 'hydrate')

    if (opts?.children) await this.hydrateChildren(id)

    if (opts?.ancestors) {
      // Pass id twice — ANCESTORS_SQL uses it as both start and skip.
      const ancestorRows = await this.db.getAll<BlockRow>(ANCESTORS_SQL, [id, id])
      for (const r of ancestorRows) this.cache.applyIfNewer(parseBlockRow(r), 'hydrate')
    }

    if (opts?.descendants) {
      const subtreeRows = await this.db.getAll<BlockRow & {depth: number}>(SUBTREE_SQL, [id])
      const maxDepth = typeof opts.descendants === 'number' ? opts.descendants : Infinity
      for (const r of subtreeRows) {
        if (r.depth > maxDepth) continue
        this.cache.applyIfNewer(parseBlockRow(r), 'hydrate')
      }
    }

    return data
  }

  /** Async existence check — cache-first, falls back to a single SQL
   *  hit. Soft-deleted rows count as MISSING here so create/restore
   *  flows on the caller side get the consistent "not found" signal.
   *  The cache holds tombstone snapshots after `tx.delete` (so peek
   *  can show `deleted: true`); `hasSnapshot` alone would falsely
   *  report a tombstoned row as existing, hence the `deleted` gate. */
  async exists(id: string): Promise<boolean> {
    const cached = this.cache.getSnapshot(id)
    if (cached !== undefined) return !cached.deleted
    const row = await this.db.getOptional<{id: string}>(SELECT_BLOCK_BY_ID_SQL, [id])
    return row !== null
  }

  // ──── Acting-as delegation shims (state lives on `this._client`) ────

  /** The `ClientContextReader` view of `this._client` — reads + the
   *  {@link ClientContext.onActingAsChange} subscribe method, but NOT the
   *  set methods. See {@link ClientContextReader} for why: mutating
   *  through it would bypass this Repo's transitions. Mutate ONLY via
   *  `repo.setActiveWorkspaceId` / `repo.setActiveLayoutSessionId`. */
  get client(): ClientContextReader {
    return this._client
  }

  /** The authenticated user this client acts as — see
   *  {@link ClientContext.user} (`repo.client`). A getter (not a field)
   *  so the state has exactly one home; the read API is unchanged. */
  get user(): User {
    return this._client.user
  }

  // ──── Active-workspace getter/setter (UI bookkeeping) ────

  /** The active workspace pin. State + semantics live on
   *  {@link ClientContext.activeWorkspaceId} (`repo.client`); this shim
   *  keeps the existing read API. */
  get activeWorkspaceId(): string | null {
    return this._client.activeWorkspaceId
  }

  /** Pin the active workspace. The STATE lives on `this._client`; the
   *  side effects of a switch — facet-bridge notification, projector
   *  pin/rollback, seed-materialization generation turnover — stay
   *  here, so callers keep going through this method (never
   *  `client.setActiveWorkspaceId` directly — and, since `repo.client` is
   *  typed as {@link ClientContextReader}, no longer even compiles).
   *  Note: `this._client.setActiveWorkspaceId` below fires
   *  `onActingAsChange` on an effective change BEFORE the facet-bridge /
   *  projector side effects below run — a subscriber reacting
   *  synchronously observes the new pin while those are still
   *  mid-transition (see the doc on {@link ClientContext.setActiveWorkspaceId}). */
  setActiveWorkspaceId(workspaceId: string | null): void {
    if (
      workspaceId === this._client.activeWorkspaceId &&
      (!this.facetRuntime || workspaceId === this.projectors.workspaceId)
    ) return
    const previousWorkspaceId = this._client.activeWorkspaceId
    this._client.setActiveWorkspaceId(workspaceId)
    if (workspaceId !== previousWorkspaceId) {
      // Cancel any parked seed-materialization access waits bound to the
      // workspace we just left, then open a fresh generation for the incoming
      // one (a same-workspace projector re-pin keeps the current generation).
      this.seedMaterializationGeneration.abort()
      this.seedMaterializationGeneration = new AbortController()
    }
    this.facetBridge.setActiveWorkspaceId(workspaceId)
    try {
      if (this.facetRuntime) {
        this.projectors.pinWorkspace(workspaceId)
      }
    } catch (error) {
      // ProjectorRuntime attempts to restore its outgoing generation. If that
      // nested rollback also failed, its honest state is null; mirror that
      // rather than claiming the old workspace and suppressing a retry.
      const restoredWorkspaceId = this.projectors.workspaceId
      this._client.setActiveWorkspaceId(restoredWorkspaceId)
      this.facetBridge.setActiveWorkspaceId(restoredWorkspaceId)
      // The failed switch already aborted the outgoing seed-materialization
      // generation. Open a fresh one and re-arm the restored workspace so its
      // aborted parked pass isn't stranded until the next seed change (a no-op
      // if the pinned registry isn't the restored workspace's).
      this.seedMaterializationGeneration = new AbortController()
      if (restoredWorkspaceId) this.scheduleWorkspaceSeedMaterialization(restoredWorkspaceId, false)
      throw error
    }
  }

  // ──── Active-layout-session getter/setter (UI bookkeeping) ────

  /** The active layout-session id, with its base-seed fallback. State +
   *  semantics live on {@link ClientContext.activeLayoutSessionId}
   *  (`repo.client`); this shim keeps the existing read API. */
  get activeLayoutSessionId(): string {
    return this._client.activeLayoutSessionId
  }

  /** Override the active layout-session id (`null` restores the base
   *  id). Pure delegation — see
   *  {@link ClientContext.setActiveLayoutSessionId} for semantics
   *  (including the effective-change notification consumed by
   *  `useActiveLayoutSessionId` / `LayoutSessionHost`). */
  setActiveLayoutSessionId(id: string | null): void {
    this._client.setActiveLayoutSessionId(id)
  }

  /** Wait until persisted property definitions have produced their first
   * complete workspace snapshot. Bootstrap calls this before typed writes so
   * declaration synthesis cannot temporarily outrank a stored rename/shadow. */
  async whenPropertyDefinitionsReady(workspaceId: string): Promise<void> {
    const handle = this.propertyDefinitionProjector()
    if (!handle) return
    await handle.whenPrimed(workspaceId)
  }

  private propertyDefinitionProjector() {
    if (!this.facetRuntime) return undefined
    return this.projectors.handle(USER_SCHEMAS_PROJECTOR_ID)
  }

  /** The active workspace's undo / redo manager — what cmd-Z and the
   *  Undo UI act on (issue #186). Because each workspace has its own
   *  manager, callers can use the plain `peekUndo` / `popUndo` API and it
   *  is implicitly scoped to the active workspace; switching workspace
   *  swaps which manager this returns without disturbing the others.
   *  When no workspace is active, returns a stable throwaway manager
   *  (keyed by `NO_ACTIVE_WORKSPACE`) so callers don't have to null-check
   *  — `undo()` / `redo()` still guard on `activeWorkspaceId`. */
  get undoManager(): UndoManager {
    return this.undoManagerFor(this.client.activeWorkspaceId ?? NO_ACTIVE_WORKSPACE)
  }

  /** Undo manager for a specific workspace, lazily created. `repo.tx`
   *  records into the tx's pinned workspace's manager so history follows
   *  the workspace, not the (possibly since-changed) active pin. Public
   *  for the rare caller that must address a *known* workspace regardless
   *  of which is currently active — e.g. the SRS reschedule toast, which
   *  captures the rescheduled block's workspace so a workspace switch
   *  during the reschedule's await can't rebind the toast to the wrong
   *  stack. Most callers want `undoManager` (the active one). */
  undoManagerFor(workspaceId: string): UndoManager {
    let manager = this.undoManagers.get(workspaceId)
    if (!manager) {
      manager = new UndoManager()
      this.undoManagers.set(workspaceId, manager)
    }
    return manager
  }

  /** Toggle read-only mode. Wrapping the field write in a method
   *  keeps call sites that come from inside React hooks lint-clean
   *  (`react-hooks/immutability` flags direct property writes on
   *  hook outputs). UI-state and UserPrefs writes still pass through
   *  and upload regardless of this flag; only `BlockDefault` /
   *  `References` writes are rejected. */
  setReadOnly(value: boolean): void {
    this.isReadOnly = value
  }

  /** Run a transactional session. Spec §3, §10. */
  async tx<R>(
    fn: (tx: Tx) => Promise<R>,
    opts: RepoTxOptions,
  ): Promise<R> {
    // Translation + listener notification happen inside `_runAndDispatch`
    // so all entry points (`tx`, `undo`, `redo`) get uniform error
    // shaping — `repo.tx` just re-throws here.
    const result: Awaited<ReturnType<typeof this._runAndDispatch<R>>> =
      await this._runAndDispatch(fn, opts)
    // Step 7 of the §10 pipeline — record undo entry into the tx's pinned
    // workspace's manager, so a later cmd-Z only ever acts on entries from
    // the workspace the user is looking at (issue #186). Non-undoable
    // scopes are filtered inside `record`; zero-write txs have no pinned
    // workspace (null) and nothing to undo, so skip them here. Replays go
    // through `_replay`, not here, so they don't add new history.
    if (result.workspaceId !== null) {
      this.undoManagerFor(result.workspaceId).record({
        scope: opts.scope,
        txId: result.txId,
        snapshots: result.snapshots,
        description: opts.description,
        // Group token (issue #306): entries sharing it merge at record
        // time while the previous one is still top-of-stack, so a
        // multi-tx composite reverts with one cmd-Z.
        groupId: opts.groupId,
      })
    }
    return result.value
  }

  /** Undo the most recent committed `repo.tx` for `scope` *in the active
   *  workspace*. Default scope is `BlockDefault` (the cmd-Z target).
   *  Resolves to true if an entry was popped + replayed, false if there
   *  is no active workspace or its manager has no entry for `scope`.
   *
   *  Undo is per-workspace (issue #186): each workspace has its own
   *  `UndoManager`, and we operate on the active one — so a workspace
   *  switch (in-place, no reload) can never revert (or re-upload) an edit
   *  in a workspace the user has left, and switching back restores that
   *  workspace's history. The active manager is captured up front so a
   *  switch mid-replay can't redirect the redo push to a different
   *  workspace's manager.
   *
   *  Replay opens its own `repo.tx` with `source = 'user'` so the
   *  inverse syncs upstream just like the original write did (per the
   *  spec's §7.3 + the follow-ups doc's "undo of a content edit
   *  should sync the un-edit"). The replayed entry belongs to the active
   *  workspace, so the active workspace's read-only flag
   *  (`this.isReadOnly`) is the entry's own workspace read-only —
   *  viewing a read-only workspace B can never block undo of an editable
   *  workspace A's edit, because cmd-Z in B operates on B's (empty)
   *  manager, not A's (issue #186 A5b). Throws `ReadOnlyError` when the
   *  active workspace is read-only for scopes that cannot write locally.
   *  (Known pre-existing limitation: `isReadOnly` is updated by an async
   *  App effect, so it can briefly lag a just-switched-to workspace; a
   *  cmd-Z in that window may transiently `ReadOnlyError`, but the entry
   *  is pushed back so a retry once the flag settles succeeds — see
   *  issue #226.) */
  async undo(scope: ChangeScope = ChangeScope.BlockDefault): Promise<boolean> {
    if (this.client.activeWorkspaceId === null) return false
    const manager = this.undoManager
    const entry = manager.popUndo(scope)
    if (entry === null) return false
    try {
      await this._replay(entry, 'before')
      manager.pushRedo(scope, entry)
      return true
    } catch (err) {
      // Replay failed — push the entry back so the user can retry
      // (e.g. after toggling read-only off, fixing a missing parent).
      // Known narrow hazard (pre-existing, issue #226 window): if a new
      // tx recorded during the failed replay's await, this pushback
      // lands the entry ABOVE it — chronologically inverted. With
      // grouping the inversion additionally makes a same-group tx merge
      // into the pushed-back entry rather than the newer one. We keep
      // the groupId on pushback anyway: stripping it would break the
      // legitimate retry path (RescheduleToast re-matches the restored
      // entry by groupId once read-only clears), which is a far more
      // common sequence than a mid-replay same-group commit.
      manager.pushUndo(scope, entry)
      throw err
    }
  }

  /** Redo the most recently undone tx for `scope` in the active
   *  workspace. Same defaults + same per-workspace + read-only
   *  semantics as `undo`, mirrored. */
  async redo(scope: ChangeScope = ChangeScope.BlockDefault): Promise<boolean> {
    if (this.client.activeWorkspaceId === null) return false
    const manager = this.undoManager
    const entry = manager.popRedo(scope)
    if (entry === null) return false
    try {
      await this._replay(entry, 'after')
      manager.pushUndo(scope, entry)
      return true
    } catch (err) {
      manager.pushRedo(scope, entry)
      throw err
    }
  }

  /** Run `fn` against a `Repo`-shaped facade whose every tx carries one
   *  freshly-minted undo-group token (issue #306, docs/undo-grouping.md).
   *  Consecutive txs opened through the facade — directly via
   *  `grouped.tx`, or indirectly via `grouped.mutate.X` / `grouped.run`
   *  — MERGE into a single undo entry at record time, so the whole
   *  composite reverts with one cmd-Z. Helpers that take a `Repo`
   *  parameter join the group simply by being handed the facade.
   *
   *  Wrap-site convention: name the callback parameter `repo`,
   *  shadowing the raw repo — that way an out-of-habit `repo.tx(...)`
   *  inside the group cannot silently open a foreign tx and split it.
   *
   *  Semantics to be aware of:
   *   - Merging is top-of-stack only: a foreign tx (one opened on the
   *     plain repo, e.g. a background write) landing mid-group SPLITS
   *     the group into two entries rather than folding across it.
   *   - No atomicity: each tx still commits independently. If a later
   *     tx throws, the committed prefix stays applied and remains
   *     covered by the (single) group entry; the error propagates.
   *   - Nested `undoGroup` on the facade joins the OUTER group — one
   *     user-perceived action, one entry.
   *   - The facade must not escape the callback: its token never
   *     expires, so a leaked reference would stamp far-future txs into
   *     a long-dead group (see the `block` override below for the one
   *     leak path that existed).
   *   - Grouping covers `tx` / `mutate` / `run` and the TypeTagger
   *     convenience writes. Two write styles deliberately do NOT join:
   *     Block-facade sugar (`grouped.block(id).setContent(...)` routes
   *     through `block.repo` = the real repo — a group-bound Block
   *     would be exactly the leak the `block` override closes) and
   *     stateful service writes (`userSchemas` / `userTypes` /
   *     `projectors` — constructed against the real repo; a
   *     facade-hosted twin would clobber their shared contribution
   *     buckets). Both land as foreign txs and split the group; use
   *     `grouped.tx` / `grouped.mutate` inside a group instead.
   *   - Everything not overridden delegates to the real repo via the
   *     prototype chain and therefore runs with the facade as `this` —
   *     safe for reads and shared-object mutation, NOT safe for three
   *     hazard classes (shared-state minting, instance-field
   *     assignment, construction-captured collaborators), which the
   *     overrides in {@link groupedFacade} cover — each carries its
   *     rationale at the override. The classification rubric and the
   *     structural enforcement live in `repoFacadeGate.test.ts`, which
   *     fails on any Repo member that is neither overridden nor
   *     consciously allowlisted. */
  async undoGroup<R>(fn: (grouped: Repo) => Promise<R>): Promise<R> {
    return fn(this.groupedFacade(this.newId()))
  }

  /** Build the group-injecting facade for {@link undoGroup}. */
  private groupedFacade(groupId: string): Repo {
    const facade = Object.create(this) as Repo
    const tx = <R,>(fn: (tx: Tx) => Promise<R>, opts: RepoTxOptions): Promise<R> =>
      this.tx(fn, {...opts, groupId})
    const run = ((name: string, args: unknown) =>
      this.dispatchMutator(name, groupId)(args)) as Repo['run']
    const mutate = nameDispatchProxy<MutateProxy>(name => this.dispatchMutator(name, groupId))
    // Async so a synchronously-throwing callback rejects like the outer
    // `undoGroup` does instead of throwing through the caller.
    const undoGroup = async <R,>(inner: (grouped: Repo) => Promise<R>): Promise<R> =>
      inner(facade)
    // `block()` on a cache miss mints `new Block(this, id)` into the
    // repo-wide `blockFacades` identity map. With the facade as `this`
    // that would cache a facade-bound Block FOREVER — every later
    // ordinary edit through it (`setContent`, `set`, `delete` route
    // through `block.repo`) would carry this group's token and merge
    // into the long-dead group's entry (one cmd-Z would then revert an
    // unrelated edit plus the whole composite). Mint through the real
    // repo so shared state only ever holds real-repo Blocks.
    const block = (id: string): Block => this.block(id)
    // The TypeTagger convenience writes (`addType` & co.) open their own
    // txs through the tagger's construction-captured host — the REAL
    // repo — so on the facade they would silently escape the group and
    // split it. A facade-hosted tagger (TypeTagger is a stateless
    // wrapper; the facade satisfies TypeTaggerHost structurally, with
    // grouped `tx`) keeps the documented "helpers join by being handed
    // the facade" contract true for them. The `*InTx` variants write
    // into a caller-provided tx and need no override.
    const groupedTagger = new TypeTagger(facade)
    const addType: Repo['addType'] = (blockId, typeId, initialValues = {}) =>
      groupedTagger.addType(blockId, typeId, initialValues)
    const removeType: Repo['removeType'] = (blockId, typeId) =>
      groupedTagger.removeType(blockId, typeId)
    const toggleType: Repo['toggleType'] = (blockId, typeId) =>
      groupedTagger.toggleType(blockId, typeId)
    const setBlockTypes: Repo['setBlockTypes'] = (blockId, typeIds) =>
      groupedTagger.setBlockTypes(blockId, typeIds)
    // Shared-state minting, part 2: `runQuery` (the dynamic dispatch
    // entry point — exactly helper-shaped) would store a LoaderHandle
    // whose loader and QueryCtx capture the facade into the SHARED
    // handle store, where every future invalidation-driven re-resolve
    // would see `ctx.repo` = the long-dead facade. Query resolution is
    // never group-bound; delegate.
    const runQuery: Repo['runQuery'] = (name, args) => this.runQuery(name, args)
    // Deferred-job scheduling captures `this` into shared job queues
    // that fire long after the group's lifetime — a facade-bound job
    // would open GROUPED txs minutes later and merge system writes into
    // the dead entry. Never group-bound; delegate.
    const scheduleWorkspaceBackfills: Repo['scheduleWorkspaceBackfills'] = (ws) =>
      this.scheduleWorkspaceBackfills(ws)
    const scheduleWorkspaceRefBackfill: Repo['scheduleWorkspaceRefBackfill'] = (ws) =>
      this.scheduleWorkspaceRefBackfill(ws)
    const scheduleWorkspaceSeedMaterialization: Repo['scheduleWorkspaceSeedMaterialization'] =
      (ws, freshlyCreated) => this.scheduleWorkspaceSeedMaterialization(ws, freshlyCreated)
    const scheduleReconcileRescan: Repo['scheduleReconcileRescan'] = (ws) =>
      this.scheduleReconcileRescan(ws)
    const scheduleReferenceTargetDerivePass: Repo['scheduleReferenceTargetDerivePass'] = (ws) =>
      this.scheduleReferenceTargetDerivePass(ws)
    // Field-assigning members: run with the facade as `this`, the
    // assignment would create a shadow property on the facade and the
    // real repo would never see it (silent state divergence). Delegate
    // explicitly. `undo`/`redo` belong here because `_runAndDispatch`
    // assigns `slowestTx` mid-flight; the sync-observer pair assigns
    // `syncObserver` (a shadowed stop would strand the real repo with a
    // disposed observer it believes is live). `setActiveWorkspaceId`
    // still reassigns `seedMaterializationGeneration` on a switch.
    // `setActiveLayoutSessionId`'s state moved onto the shared
    // ClientContext (interior mutation — safe through the chain), but it
    // stays delegated so the acting-as setter pair keeps one facade shape.
    const setActiveWorkspaceId: Repo['setActiveWorkspaceId'] = (id) =>
      this.setActiveWorkspaceId(id)
    const setActiveLayoutSessionId: Repo['setActiveLayoutSessionId'] = (id) =>
      this.setActiveLayoutSessionId(id)
    const setReadOnly: Repo['setReadOnly'] = (value) => this.setReadOnly(value)
    const undo: Repo['undo'] = (scope) => this.undo(scope)
    const redo: Repo['redo'] = (scope) => this.redo(scope)
    const startSyncObserver: Repo['startSyncObserver'] = (options) =>
      this.startSyncObserver(options)
    const stopSyncObserver: Repo['stopSyncObserver'] = () => this.stopSyncObserver()
    const resetMetrics: Repo['resetMetrics'] = () => this.resetMetrics()
    return Object.assign(facade, {
      tx, run, mutate, undoGroup, block, runQuery,
      addType, removeType, toggleType, setBlockTypes,
      scheduleWorkspaceBackfills, scheduleWorkspaceRefBackfill,
      scheduleWorkspaceSeedMaterialization, scheduleReconcileRescan,
      scheduleReferenceTargetDerivePass,
      setActiveWorkspaceId, setActiveLayoutSessionId, setReadOnly, undo, redo,
      startSyncObserver, stopSyncObserver, resetMetrics,
    })
  }

  /** Shared `runTx` + processor-dispatch path. Used by both `tx`
   *  (records on undo stack) and `_replay` (does not).
   *
   *  Storage-layer integrity errors are translated to user-domain
   *  exceptions here so every caller — `repo.tx`, `repo.undo`,
   *  `repo.redo` — surfaces the same shape. Currently:
   *    - `alias_collision` RAISE → `ProcessorRejection('alias.collision',
   *      …)` via the trigger on `block_aliases`.
   *    - `parent_deleted` RAISE → `ParentDeletedError(parentId)` via the
   *      trigger on `blocks` — kept as a typed error rather than a
   *      ProcessorRejection because no toast surface is wired for it and
   *      existing callers `instanceof`-check the class.
   *  Listeners (`onUserError`) fire on translated ProcessorRejections
   *  here so the toast layer sees collisions from undo/redo replay,
   *  not just from `repo.tx` directly. */
  private async _runAndDispatch<R>(
    fn: (tx: Tx) => Promise<R>,
    opts: RepoTxOptions,
    isReplay = false,
  ) {
    const txT0 = performance.now()
    let result
    // A workspace pin starts the definition projector asynchronously. Delay
    // active-workspace transactions at the one shared boundary so callers
    // cannot capture declaration-only seed winners during that short window.
    // The wait is generation-bound: a workspace switch rejects it instead of
    // letting the queued transaction drift into a different workspace.
    const readinessWorkspaceId = this.client.activeWorkspaceId
    const readinessGenerationToken = this.projectors.generationToken
    if (readinessWorkspaceId) {
      await this.whenPropertyDefinitionsReady(readinessWorkspaceId)
      if (
        this.client.activeWorkspaceId !== readinessWorkspaceId
        || this.projectors.generationToken !== readinessGenerationToken
      ) {
        throw new Error(
          `[Repo.tx] active workspace generation changed while waiting for ${readinessWorkspaceId}`,
        )
      }
    }
    const capturedActivePropertyDefinitions = this._propertyDefinitionRegistry
    const capturedPreviousPropertyDefinitions = this._previousPropertyDefinitionRegistry
    try {
      result = await runTx({
        db: this.db,
        cache: this.cache,
        fn,
        opts,
        user: this.user,
        isReadOnly: this.isReadOnly,
        newTxId: this.newId,
        newTxSeq: this.newTxSeq,
        newId: this.newId,
        now: this.now,
        mutators: this.mutators,
        processors: this.processors,
        sameTxProcessors: this.sameTxProcessors,
        propertySchemas: this._propertySchemas,
        // Serve the tx's active-at-start workspace, or the retained previous one,
        // from their frozen snapshots; any other workspace resolves null (fail
        // closed). Frozen at tx-start so a mid-tx workspace switch can't re-scope
        // resolution for the workspace the tx is operating on.
        propertyDefinitionRegistryForWorkspace:
          workspaceId => registryForWorkspace(
            capturedActivePropertyDefinitions,
            capturedPreviousPropertyDefinitions,
            workspaceId,
          ),
        propertySchemaWorkspaceId: this.client.activeWorkspaceId,
        propertySeedNameCounts: this._propertySeedNameCounts,
        // Undo/redo replays skip the same-tx processor pass so a
        // value-deriving processor can't override `applyRaw`'s exact
        // restore (#187). Post-commit processors still dispatch below.
        isReplay,
      })
    } catch (err) {
      const collision = parseAliasCollisionError(err)
      if (collision !== null) {
        const rejection = await this.buildAliasCollisionRejection(collision)
        this.userErrorListeners.notify(rejection)
        throw rejection
      }
      const parentDeleted = parseParentDeletedError(err)
      if (parentDeleted !== null) {
        throw new ParentDeletedError(parentDeleted.parentId)
      }
      if (err instanceof ProcessorRejection) this.userErrorListeners.notify(err)
      throw err
    }
    // Track the slowest tx by description so cold-start metrics can
    // attribute writeTransaction outliers to a concrete site (e.g.
    // 'reproject ref-typed properties after schema swap', mutator names).
    // Cheaper than recording every tx; only the high-water mark wins.
    const txMs = performance.now() - txT0
    const description = opts.description ?? null
    if (txMs > this.slowestTx.ms) {
      this.slowestTx = {description, ms: txMs}
    }
    // Bounded log of recent tx (description, ms). Drops the oldest
    // entry once `TX_LOG_CAPACITY` is reached. Lets a cold-start
    // metrics dump attribute every writeTransaction sample to a
    // call site, not just the slowest one.
    this.txLog.push({description, ms: txMs})
    if (this.txLog.length > TX_LOG_CAPACITY) this.txLog.shift()
    // TxEngine fast path (spec §9.3 path 1): post-commit, fan-out the
    // tx's snapshots diff to dep-matching collection handles. The
    // commit pipeline already updated the BlockCache (which fires
    // Block.subscribe row-grain listeners) — this layer is just for
    // children/subtree/ancestors/backlinks handles. Synchronous walk;
    // each handle's runLoader is async, but `invalidate` only sets
    // pendingReinvalidate / kicks off a microtask, so the caller's tx
    // resolve isn't blocked on handle re-resolution.
    if (result.snapshots.size > 0) {
      this.handleStore.invalidate(
        snapshotsToChangeNotification(result.snapshots, this.invalidationRules),
      )
    }
    // Step 9 of the §10 pipeline — start field-watch + explicit
    // post-commit processors. Failures are caught + logged inside the
    // runner so a buggy processor can't poison the caller's resolve.
    // Dispatch is intentionally fire-and-forget; callers that need
    // deterministic processor completion can await `awaitProcessors()`.
    void this.processorRunner.dispatch({
      txId: result.txId,
      user: result.user,
      workspaceId: result.workspaceId,
      snapshots: result.snapshots,
      afterCommitJobs: result.afterCommitJobs,
      processors: result.processors,
      propertySchemas: result.propertySchemas,
    })
    return result
  }

  /** Replay an undo / redo entry. Opens a tx in the entry's scope and
   *  raw-applies each (id → snap.before) (undo) or (id → snap.after)
   *  (redo) via the engine-internal `applyRaw` primitive. Replays do
   *  NOT push themselves onto the undo stack — the caller manages
   *  stack motion (manager.pushRedo / manager.pushUndo) so the same
   *  entry shuttles symmetrically between stacks. */
  private async _replay(
    entry: UndoEntry,
    direction: 'before' | 'after',
  ): Promise<void> {
    const action = direction === 'before' ? 'undo' : 'redo'
    const description = entry.description
      ? `${action}: ${entry.description}`
      : action
    await this._runAndDispatch(async (tx) => {
      const txImpl = tx as TxImpl
      // Start from replayApplicationOrder's topological order (see its
      // docblock in txSnapshots.ts for the parent-before-child
      // rationale), then worklist-retry rows a row-level trigger
      // rejects — the topo sort can't express RESOURCE constraints
      // between equal-depth rows. Undoing a merge of two
      // alias-carrying blocks must revert the target (releasing the
      // merged alias) before restoring the source (re-claiming it). A
      // statement-level RAISE(ABORT) only rolls back that statement, so
      // deferring the aborted row and applying the rest is safe; the
      // replay's end state is a previously-observed valid state, so
      // every constraint-blocked row eventually unblocks — a full pass
      // with zero progress means the entry itself is inconsistent, and
      // we rethrow.
      let pending = replayApplicationOrder(entry.snapshots, direction)
      while (pending.length > 0) {
        const deferred: typeof pending = []
        let lastError: unknown = null
        for (const [id, target] of pending) {
          try {
            await txImpl.applyRaw(id, target)
          } catch (err) {
            if (parseAliasCollisionError(err) !== null || parseParentDeletedError(err) !== null) {
              deferred.push([id, target])
              lastError = err
            } else {
              throw err
            }
          }
        }
        if (deferred.length === pending.length) throw lastError
        pending = deferred
      }
    }, {scope: entry.scope, description}, true)
  }

  /** Dynamic dispatch — used by runtime-loaded plugins where the
   *  TypeScript identity isn't available. `name` is the full mutator
   *  name (e.g. `'tasks:setDueDate'` or `'core.indent'`). Args are
   *  validated at the boundary via the mutator's argsSchema. */
  async run<R = unknown>(name: string, args: unknown): Promise<R> {
    return this.dispatchMutator(name)(args) as Promise<R>
  }

  /** Dynamic query dispatch — `repo.query[name]` for runtime-loaded
   *  plugins. Resolves the query, runs `.load()`, and returns the
   *  result. The same `core.${name}` shortcut as the proxy applies. */
  async runQuery<R = unknown>(name: string, args: unknown): Promise<R> {
    return this.dispatchQuery(name)(args).load() as Promise<R>
  }

  private resolveTypedBlockQuery(query: TypedBlockQuery): ResolvedTypedBlockQuery {
    return normalizeTypedBlockQuery({
      workspaceId: query.workspaceId,
      types: query.types,
      where: query.where,
      referencedBy: query.referencedBy,
      match: query.match,
      exclude: query.exclude,
      order: query.order,
    })
  }

  /** Run a typed block query once. `workspaceId` is required: callers
   *  that want the user's currently-active workspace use
   *  `queryActiveWorkspace` instead — making the workspace explicit at
   *  the call site prevents background flows / import runs from silently
   *  mis-scoping on a workspace switch (PR #47 review). */
  async queryBlocks(query: TypedBlockQuery): Promise<BlockData[]> {
    return this.query.typedBlocks(this.resolveTypedBlockQuery(query)).load()
  }

  /** Subscribe to a typed block query. `workspaceId` is required: callers
   *  that want the user's currently-active workspace use
   *  `subscribeActiveWorkspace` instead. */
  subscribeBlocks(
    query: TypedBlockQuery,
    listener: (rows: BlockData[]) => void,
    options?: {
      /** Projector-only mode: suppress cached delivery and emit exactly one
       * fresh initial snapshot before forwarding later live changes. */
      freshInitial?: boolean
      onInitialError?: (error: unknown) => void
    },
  ): Unsubscribe {
    const handle = this.query.typedBlocks(this.resolveTypedBlockQuery(query))
    if (options?.freshInitial) {
      let initialPending = true
      const unsubscribe = handle.subscribe(rows => {
        if (!initialPending) listener(rows)
      })
      // Bounded retry: a transient initial-load fault must not settle projector
      // readiness as failed for the whole generation (which would wedge every
      // active-workspace transaction until the next re-pin). Only a persistent
      // failure reaches onInitialError.
      const cancelLoad = runFreshInitialLoad(
        () => handle.loadFresh(),
        rows => {
          initialPending = false
          try {
            listener(rows)
          } catch (error) {
            options.onInitialError?.(error)
          }
        },
        error => {
          initialPending = false
          options.onInitialError?.(error)
        },
      )
      return () => {
        cancelLoad()
        unsubscribe()
      }
    }
    const current = handle.peek()
    if (current !== undefined) queueMicrotask(() => listener(current))
    return handle.subscribe(listener)
  }

  /** Active-workspace shorthand for `queryBlocks`. Resolves
   *  `activeWorkspaceId` at call time; if no workspace is active,
   *  returns an empty list (mirrors the historical fallback behaviour
   *  for the rare callers that legitimately want "whatever the user is
   *  looking at right now"). Most non-UI code should NOT use this —
   *  prefer the bare `queryBlocks` with an explicit workspaceId. */
  async queryActiveWorkspace(
    query: Omit<TypedBlockQuery, 'workspaceId'>,
  ): Promise<BlockData[]> {
    const workspaceId = this.activeWorkspaceId
    if (!workspaceId) return []
    return this.queryBlocks({...query, workspaceId})
  }

  /** Active-workspace shorthand for `subscribeBlocks`. Same caveat as
   *  `queryActiveWorkspace`: the workspace is captured at subscription
   *  time and does NOT re-resolve on later workspace switches. UI
   *  surfaces that need switch-following behaviour should resubscribe
   *  themselves when `activeWorkspaceId` changes (e.g. via
   *  `useActiveWorkspaceId`). */
  subscribeActiveWorkspace(
    query: Omit<TypedBlockQuery, 'workspaceId'>,
    listener: (rows: BlockData[]) => void,
  ): Unsubscribe {
    const workspaceId = this.activeWorkspaceId
    if (!workspaceId) {
      queueMicrotask(() => listener([]))
      return () => {}
    }
    return this.subscribeBlocks({...query, workspaceId}, listener)
  }

  /** Count non-deleted blocks in `workspaceId` whose `properties` map
   *  has a value at `name`. Used by the property-schema editor to warn
   *  the user before deleting a schema definition that's still in use.
   *  Workspace defaults to the active one; missing workspace returns 0. */
  async countBlocksUsingProperty(
    name: string,
    workspaceId?: string,
  ): Promise<number> {
    const wsId = workspaceId ?? this.activeWorkspaceId
    if (!wsId) return 0
    const row = await this.db.getOptional<{count: number}>(
      `
        SELECT COUNT(*) AS count
        FROM blocks b
        WHERE b.workspace_id = ?
          AND b.deleted = 0
          AND json_extract(b.properties_json, ?) IS NOT NULL
      `,
      [wsId, jsonPathForProperty(name)],
    )
    return row?.count ?? 0
  }

  /** Read-only handle on the currently-installed FacetRuntime. Used by
   *  non-React callers that need to consult facets at action-handler
   *  time (e.g. `pickBlockDateAdapter` from a multi-select handler
   *  where `useAppRuntime()` isn't available). Returns null before the
   *  first `setFacetRuntime` call. Delegates to `FacetBridge` (D1(c)).
   *
   *  NOTE: this also serves as the carrier of *app-layer* facets for
   *  callers outside React — `AppRuntimeProvider` installs the merged
   *  app runtime here (so plugin mutators/processors reach the data
   *  registries), and e.g. `surfaceProcessorRejection` reads app-only
   *  facets (`rejectionToastFacet`) off it at error-fan-out time. That
   *  contract holds under the current replace-the-world model; a runtime
   *  refactor that stops installing the full app runtime here must keep
   *  "repo.facetRuntime carries app facets" or relocate those reads —
   *  otherwise they go silently empty. */
  get facetRuntime(): FacetRuntime | null {
    return this.facetBridge.facetRuntime
  }

  /** Update the data-layer registries from a FacetRuntime (spec §8) via
   *  the facet bridge. The bridge decomposes the swap into named rebuild
   *  steps that write back into this Repo's registries, preserving the
   *  replay → rebuild → listeners ordering. Kernel mutators must be
   *  present in the runtime if the caller wants them — pass them in via
   *  the static-facet bundle the kernel ships. */
  setFacetRuntime(runtime: FacetRuntime): void {
    this.facetBridge.setFacetRuntime(runtime)
    if (this.client.activeWorkspaceId) {
      try {
        this.projectors.pinWorkspace(this.client.activeWorkspaceId)
      } catch (error) {
        // A changed descriptor set can fail both its incoming start and the
        // attempted restoration under this same replacement runtime. Keep the
        // Repo/filter pin honest with the projector runtime so an explicit
        // workspace retry is not suppressed.
        const restoredWorkspaceId = this.projectors.workspaceId
        this._client.setActiveWorkspaceId(restoredWorkspaceId)
        this.facetBridge.setActiveWorkspaceId(restoredWorkspaceId)
        throw error
      }
    }
  }

  /** Replace the runtime contribution bucket for `facet` keyed by
   *  `sourceId`. Triggers a re-run of every rebuild step whose declared
   *  inputs include this facet, plus per-facet listener fan-out for React
   *  subscribers (e.g. usePropertySchemas). Throws if no FacetRuntime has
   *  been installed yet — callers must setFacetRuntime first.
   *
   *  OWNERSHIP CONTRACT: the bucket is DURABLE — it survives `setFacetRuntime`
   *  swaps via `FacetRuntime.adoptDurableContributionsFrom`, and the Repo is a
   *  per-user singleton reused across workspace switches. Workspace-scoped
   *  buckets are filtered synchronously by the Repo pin, so they cannot bleed
   *  into another workspace. Their owner still clears the captured workspace's
   *  bucket on teardown to bound retained/adopted state and ensure a later
   *  restart rebuilds from the current rows. */
  setRuntimeContributions<Input>(
    facet: Facet<Input, unknown>,
    sourceId: string,
    contributions: readonly Input[],
    options?: WorkspaceRuntimeContributionOptions,
  ): void {
    this.facetBridge.setRuntimeContributions(facet, sourceId, contributions, options)
  }

  /** Subscribe to changes on `_propertySchemas`. Fires when
   *  `setFacetRuntime` rebuilds the schema map AND when a projected
   *  definition (user-schema) contribution updates the user-data bucket.
   *  Used by `usePropertySchemas` so React rerenders on user-schema
   *  add/edit/remove without a runtime swap. */
  onPropertySchemasChange(listener: () => void): () => void {
    return this.facetBridge.onPropertySchemasChange(listener)
  }

  /** Subscribe to changes on `_types`. Fires whenever the rebuild step
   *  that owns `_types` re-runs — i.e. after `setFacetRuntime` AND
   *  after `setRuntimeContributions(typeSeedsFacet | projectedTypeDefinitionsFacet, ...)`
   *  publishes into the user-data bucket. Symmetric to `onPropertySchemasChange`.
   *  Consumers (e.g. `createTypeBlock` waiting for `UserTypesService`
   *  to publish a freshly-committed type-definition block) recheck
   *  `repo.types` inside the listener; spurious firings are tolerated. */
  onTypesChange(listener: () => void): () => void {
    return this.facetBridge.onTypesChange(listener)
  }

  /** Subscribe to changes on the merged `propertyEditorOverrides` map
   *  (currently driven exclusively by `propertyEditorOverridesFacet`,
   *  but exposed as a Repo-level event so future runtime-contribution
   *  paths layer on without changing the consumer surface). */
  onPropertyEditorOverridesChange(listener: () => void): () => void {
    return this.facetBridge.onPropertyEditorOverridesChange(listener)
  }

  /** Subscribe to changes on the value-preset map. */
  onValuePresetsChange(listener: () => void): () => void {
    return this.facetBridge.onValuePresetsChange(listener)
  }

  /** Subscribe to user-surfaceable errors thrown from `repo.tx`
   *  (currently `ProcessorRejection` from same-tx processors). The
   *  data layer fires; the UI layer (e.g. toast) listens. Returns an
   *  unsubscribe fn. Listener exception isolation is handled by
   *  `CallbackSet.notify` — one bad listener can't poison the others
   *  or break the underlying `repo.tx` error propagation. */
  onUserError(listener: (error: ProcessorRejection) => void): () => void {
    return this.userErrorListeners.add(listener)
  }

  /** Translate a parsed alias-collision RAISE into a fully-populated
   *  `ProcessorRejection`. Runs after the user tx has already rolled
   *  back, so `block_aliases` is back to the pre-tx state — the
   *  conflicting claimant is still indexed and one PK lookup away. */
  private async buildAliasCollisionRejection(
    collision: ParsedAliasCollision,
  ): Promise<ProcessorRejection> {
    const claimantRow = await this.db.getOptional<BlockRow>(
      SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL,
      [collision.workspaceId, collision.alias, collision.attemptedBlockId],
    )
    // The claimant should always be present (the trigger only fired
    // because one existed at INSERT time, and the user tx rolled back
    // without touching it). Defensive fallback uses the bare info
    // from the RAISE message if the lookup somehow misses.
    const claimant = claimantRow === null ? null : parseBlockRow(claimantRow)
    // If the attempting block was CREATED in the rejected tx, the
    // rollback erased it — there is no row at all (a tombstone would
    // still be a row). Mark these `collisionOrigin: 'create'` so the
    // toast doesn't offer a "Merge into …" whose source no longer
    // exists.
    const attemptedRow = await this.db.getOptional<{id: string}>(
      'SELECT id FROM blocks WHERE id = ?', [collision.attemptedBlockId],
    )
    return new ProcessorRejection(
      `Alias "${collision.alias}" is already used by another block`,
      'alias.collision',
      {
        alias: collision.alias,
        conflictingBlockId: claimant?.id ?? null,
        // 80-char truncation matches the prior in-processor format —
        // toast UI doesn't render long strings well.
        conflictingBlockTitle: claimant?.content.slice(0, 80) ?? '',
        workspaceId: collision.workspaceId,
        attemptedOn: collision.attemptedBlockId,
        ...(attemptedRow === null ? {collisionOrigin: 'create'} : {}),
      },
    )
  }

  snapshotTypeRegistries(): TypeRegistrySnapshot {
    return {types: this._types, propertySchemas: this._propertySchemas}
  }

  private async reprojectRefTypedProperties(
    propertyNames: readonly string[],
    propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
    /** Workspace to scan + mark. Reprojection is scoped to a single
     *  workspace: `propertySchemas` only reflects the *active* workspace's
     *  user-data schemas, so evaluating ref-ness against another workspace's
     *  blocks is meaningless and would rewrite (or strip) refs in workspaces
     *  the user hasn't even opened. Markers are likewise per-workspace, so each
     *  workspace gets its own one-time backfill when first opened. */
    workspaceId: string,
  ): Promise<void> {
    if (this.isReadOnly || propertyNames.length === 0 || !workspaceId) return
    // Workspace-isolation gate: only backfill the ACTIVE workspace's refs. This
    // scan is deferred (deep-idle, up to ~30 s), so by the time it fires the user
    // may have switched away — reprojecting a workspace they've left would write
    // derived `references` into a non-open workspace's blocks. Skip it (leaving
    // its marker unset) so it re-runs when that workspace is next opened
    // (`scheduleWorkspaceRefBackfill` on bootstrap). This mirrors the
    // seed-materialization access gate. A switch DURING the scan is still handled
    // by the per-block frozen-snapshot fallback below and by `repo.tx`'s readiness
    // gate, which cancels a tx parked across an active-workspace flip.
    if (this.client.activeWorkspaceId !== workspaceId) return
    const t0 = performance.now()
    let blocksUpdated = 0
    let scanScheduled = false
    try {
      // Live registry *as of the gate decision* — workspace-correct (the live
      // map only while still on this scan's workspace, else the scheduled
      // snapshot, so a cross-workspace switch can't decide ref-ness for the
      // captured workspace's blocks). Used only to tell "absent everywhere"
      // from a present redefine in the gate below. The per-block projection
      // later takes a *fresh* `liveSchemas` snapshot (after the SELECT), so it
      // still reconciles against a redefine that lands while the scan is in
      // flight (see the `does not let an older … reprojection re-add` test).
      const liveSchemasAtGate = this.client.activeWorkspaceId === workspaceId
        ? this._propertySchemas
        : propertySchemas

      // Decide, per name, whether to scan it:
      //  - still ref-typed AND already backfilled here ⇒ SKIP. The references
      //    processor has maintained `references_json` incrementally since the
      //    marker landed, so a re-scan is pure overhead.
      //  - absent from BOTH the scheduled snapshot and the live registry ⇒ SKIP
      //    and RETAIN its existing refs. Absence is "not loaded / toggled off",
      //    NOT "deleted": it occurs when async user/import schemas
      //    (UserSchemasService) republish their bucket as rows materialize,
      //    when a non-essential plugin is toggled off, and when ?safeMode forces
      //    every non-essential off at once. Stripping on absence is what
      //    silently deleted ~10k `next-review-date` backlinks fleet-wide when
      //    SRS was toggled off. (bd7c363a re-enabled that strip believing that,
      //    after workspace-scoping, absence ⟺ a genuine redefine/delete — but it
      //    reasoned only about grow-only cold-start materialization and
      //    cross-workspace switches, never the toggle/safeMode re-resolve that
      //    removes a plugin's schema without deleting anything.)
      //  - PRESENT but non-ref ⇒ scanned, but reprojection is ADD-ONLY (see the
      //    per-block loop), so this is a no-op: there is nothing new to project.
      //    A real ref→non-ref redefine's now-stale derived refs are swept lazily
      //    by the references processor on each block's next write, not here.
      // Reprojection therefore never strips derived refs. Removal is always
      // value-driven (the per-block processor recomputes a field when its value
      // changes) or an explicit delete — never a side-effect of a schema going
      // absent or non-ref. Far cheaper than the mass silent delete that an
      // eager strip risked.
      const markers = await this.reprojectionMarkers.load()
      const namesToScan: string[] = []
      let skippedByMarker = 0
      let skippedByAbsence = 0
      for (const name of propertyNames) {
        const kind = refCodecKind(propertySchemas.get(name))
        if (kind !== undefined && markers.has(reprojectionMarkerKey(workspaceId, name))) {
          skippedByMarker += 1
          continue
        }
        if (!propertySchemas.has(name) && !liveSchemasAtGate.has(name)) {
          skippedByAbsence += 1
          continue
        }
        namesToScan.push(name)
      }
      this.reprojectionMetrics.skippedByMarker += skippedByMarker
      this.reprojectionMetrics.skippedByAbsence += skippedByAbsence
      if (namesToScan.length === 0) return
      scanScheduled = true
      this.reprojectionMetrics.calls += 1
      this.reprojectionMetrics.schemasReprojected += namesToScan.length

      const placeholders = namesToScan.map(() => '?').join(', ')
      const rows = await this.db.getAll<BlockRow>(
        `
          SELECT DISTINCT ${buildQualifiedBlockColumnsSql('b')}
          FROM blocks b, json_each(b.properties_json) prop
          WHERE b.deleted = 0
            AND b.workspace_id = ?
            AND prop.key IN (${placeholders})
        `,
        [workspaceId, ...namesToScan],
      )
      this.reprojectionMetrics.rowsScanned += rows.length
      // Note: we do NOT bail when `this._propertySchemas !== propertySchemas`.
      // On cold start `AppRuntimeProvider` calls `setFacetRuntime` twice
      // (kernel+static, then async with dynamic extensions); a same-context
      // reload calls it once (only the async swap — the sync base commit is
      // gated to cold starts). On cold start that follow-up setFacetRuntime
      // lands while reprojection-1 is mid-SELECT, so bailing here meant
      // reprojection-1 never wrote markers and the same 1.4 s scan repeated
      // on every reload; on a single-swap reload there's no racing follow-up
      // to bail against anyway. Dynamic extensions are additive
      // (no codec redefinitions), so reprojection-1's snapshot is still
      // correct against the current state; per-block tx.get reads live
      // references and the JSON.stringify diff skips writes when nothing
      // changed. If a real codec redefinition ever races a reprojection,
      // the rebuild step's follow-up reprojection corrects it.
      // Even when `rows.length === 0` we still want to record the
      // markers below so the next cold start short-circuits — for many
      // plugin-contributed ref schemas there's simply no legacy data,
      // and we should stamp them as "caught up" the first time.

      // Fresh live snapshot for the per-block projection — re-read here (after
      // the SELECT) rather than reusing `liveSchemasAtGate`, so a redefine that
      // landed while the scan was in flight is reconciled. Project against the
      // live registry only while still on the scan's workspace; after a
      // workspace switch fall back to the scheduled snapshot so the other
      // workspace's schema set can't decide ref-ness for the captured
      // workspace's blocks.
      const liveSchemas = this.client.activeWorkspaceId === workspaceId
        ? this._propertySchemas
        : propertySchemas

      const blocksByWorkspace = new Map<string, BlockData[]>()
      for (const row of rows) {
        const block = parseBlockRow(row)
        const blocks = blocksByWorkspace.get(block.workspaceId) ?? []
        blocks.push(block)
        blocksByWorkspace.set(block.workspaceId, blocks)
      }

      for (const blocks of blocksByWorkspace.values()) {
        await this.tx(async tx => {
          for (const block of blocks) {
            const liveBlock = await tx.get(block.id)
            if (liveBlock === null || liveBlock.deleted) continue
            // Add-only / retain-on-source contract
            // (docs/contracts/derived-data-add-only.md): reprojection NEVER
            // strips. It fires on a schema change while block *values* are
            // static, so recompute can only ADD — a still-ref field projects
            // exactly its existing refs (no-op), a newly-ref field gains refs,
            // and a now-non-ref / absent field keeps its existing refs
            // (projection adds nothing). `reconcileDerived`'s default retain-all
            // enforces that: all removal is lazy and value-driven — the
            // per-block references processor recomputes a field on the next
            // write to its value — never a side effect of a schema going absent
            // (plugin toggled off, ?safeMode) or non-ref here.
            const projected = namesToScan.flatMap(name =>
              projectedRefsForField(
                liveBlock,
                latestRefProjectionSchema(propertySchemas, liveSchemas, name),
                name,
              )
            )
            const reconciled = reconcileDerived({
              prior: liveBlock.references,
              recomputed: projected,
              keyOf: derivedRefKey,
            })
            if (devAssertionsEnabled()) {
              // L2 dev/test-only assertion (off in prod): reprojection
              // must be ADD-ONLY — prior ⊆ reconciled. A dropped ref here is the
              // mass-strip regression 21494fdb fixed; fail it in CI, never on a
              // user's write. (The length-equality skip below also assumes this
              // superset, so this guards that optimization too.)
              const nextKeys = new Set(reconciled.map(derivedRefKey))
              for (const ref of liveBlock.references) {
                if (!nextKeys.has(derivedRefKey(ref))) {
                  throw new Error(
                    `[reprojection] add-only violated: block ${liveBlock.id} dropped ref ${ref.sourceField ?? ''}/${ref.id}`,
                  )
                }
              }
            }
            // Retain-all add-only ⇒ reconciled ⊇ prior, so an equal length means
            // nothing new was projected. Skip the no-op write (avoids re-firing
            // the field-watcher / write amplification).
            if (reconciled.length === liveBlock.references.length) continue
            await tx.update(liveBlock.id, {references: reconciled}, {skipMetadata: true})
            blocksUpdated += 1
          }
        }, {
          scope: ChangeScope.References,
          description: 'reproject ref-typed properties after schema swap',
        })
      }

      // Record markers for names that are now ref-typed; clear markers
      // for names that have transitioned to non-ref (cleanup case) so a
      // future re-add as ref triggers a fresh scan. Doing this after
      // the per-workspace tx loop means a partial failure leaves some
      // names un-marked → next start retries them, which is the
      // conservative behavior we want.
      for (const name of namesToScan) {
        const schema = latestRefProjectionSchema(propertySchemas, liveSchemas, name)
        const kind = refCodecKind(schema)
        if (kind === undefined) {
          await this.reprojectionMarkers.clear(reprojectionMarkerKey(workspaceId, name))
        } else {
          await this.reprojectionMarkers.set(reprojectionMarkerKey(workspaceId, name))
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[setFacetRuntime] ref-typed property reprojection failed: ${reason}`)
    } finally {
      this.reprojectionMetrics.blocksUpdated += blocksUpdated
      if (scanScheduled) this.reprojectionMetrics.msTotal += performance.now() - t0
    }
  }

  /** Defer reprojection off the cold-start critical path. The first
   *  cold start on a fresh device (or one whose `client_schema_state`
   *  was wiped) has no markers in place yet, so reprojection scans
   *  every block whose properties_json mentions any ref-typed name —
   *  ~1.4 s on a real graph, holding the SQLite connection and
   *  blocking every read issued during page render. The references
   *  processor handles every write that lands during the deferral
   *  window, so projection correctness is preserved.
   *
   *  Deferred via `scheduleDeepIdle(fn, CATCHUP_DEEP_IDLE)` (see
   *  `reprojectionJobs`): off the cold-start window (10 s floor) but
   *  force-run by a 30 s fallback so a never-idle session still gets its
   *  catch-up scan. Test / Node path is `setTimeout(0)` so vitest fake
   *  timers can advance the call deterministically. */
  private scheduleReprojection(
    names: readonly string[],
    schemas: ReadonlyMap<string, AnyPropertySchema>,
  ): void {
    // Capture the active workspace now, not inside the deferred callback: a
    // workspace switch during the idle-callback window must not re-scope a scan
    // scheduled for the workspace whose schemas actually changed. No active
    // workspace (bootstrap, before any workspace opens) ⇒ nothing to scope, so
    // there's nothing to backfill yet — skip.
    const workspaceId = this.client.activeWorkspaceId
    if (!workspaceId) return
    this.reprojectionJobs.schedule(() =>
      this.reprojectRefTypedProperties(names, schemas, workspaceId),
    )
  }

  /** Schedule a marker-gated reprojection over every ref-typed schema in the
   *  active workspace. Called once per workspace open from `bootstrapWorkspace`
   *  (the sibling of `scheduleWorkspaceBackfills`): a freshly-opened workspace
   *  backfills its existing rows' derived references even when a ref-typed name
   *  is unchanged from a previously-active workspace — which the facet bridge's
   *  `changedRefSchemaNames` diff can't see. The reprojection markers are
   *  `(workspaceId, name)`-keyed, so subsequent opens are a no-op. Scheduling on
   *  workspace OPEN (not on every raw pin) keeps deferred scans off unrelated
   *  in-session workspace flips. */
  scheduleWorkspaceRefBackfill(workspaceId: string): void {
    if (this.isReadOnly || !workspaceId || workspaceId !== this.client.activeWorkspaceId) return
    const refNames = refTypedSchemaNames(this._propertySchemas)
    if (refNames.length > 0) this.scheduleReprojection(refNames, this._propertySchemas)
  }

  /** Test escape hatch — drop the in-memory marker mirror so the next
   *  reprojection re-reads from `client_schema_state`. Used by tests
   *  that mutate the table out-of-band to simulate cross-session state. */
  __resetReprojectionMarkerCache(): void {
    this.reprojectionMarkers.reset()
  }

  /**
   * Ensure every registered system page (`systemPagesFacet`) exists for
   * `workspaceId`. Called at workspace bootstrap BEFORE the landing resolver
   * seeds, so a `[[reserved alias]]` wiki-link (Journal/Properties/Types/
   * Locations) resolves to the canonical page instead of auto-creating a rival
   * that trips `alias.collision`. Each `ensure` get-or-creates at a
   * deterministic id (idempotent), so repeated bootstraps and offline-
   * converging clients all land on the same rows.
   *
   * Reads off this Repo's own `facetRuntime` — which carries the data-layer
   * contributions installed at construction (`staticDataExtensions`) — so no
   * separate runtime resolution is needed. Awaited (not deferred): the pages
   * must exist before the seed's references parse.
   */
  async ensureSystemPages(workspaceId: string): Promise<void> {
    if (!workspaceId) return
    const pages = this.facetRuntime?.read(systemPagesFacet) ?? []
    await Promise.all(pages.map(page => page.ensure(this, workspaceId)))
  }

  /**
   * Run the registered workspace backfills (`workspaceBackfillsFacet`) for
   * `workspaceId`. These are the synced-table counterpart to LocalSchema
   * backfills: they write through `repo.tx`, so their rows carry
   * source='user' and actually upload — unlike a raw `db.execute`, which would
   * leave the rows local-only (the daily-note:date sync gap). Deferred off the
   * workspace-open critical path (`scheduleDeepIdle` / `CATCHUP_DEEP_IDLE` —
   * same scheme as `scheduleReprojection`) and gated so each
   * backfill runs at most once per workspace.
   *
   * Call AFTER the access gate confirms the workspace is materializable: a
   * read-only / locked / unverified workspace must not be written (the same
   * reason App.tsx defers bootstrap writes past the gate). Fire-and-forget —
   * returns immediately; tests drain via `awaitWorkspaceBackfills()`.
   */
  scheduleWorkspaceBackfills(workspaceId: string): void {
    if (this.isReadOnly || !workspaceId || this._workspaceBackfills.length === 0) return
    const backfills = this._workspaceBackfills
    this.workspaceBackfillJobs.schedule(() =>
      this.runWorkspaceBackfills(workspaceId, backfills),
    )
  }

  /**
   * Materialize the code-declared property seeds visible to the installed
   * runtime into real `property-schema` blocks under the workspace's Properties
   * page (§4.3 of the schema-unification design). This is what makes seeded
   * definitions visible/editable in the UI and available to clients that don't
   * have the contributing plugin loaded; the in-memory registry itself works
   * with zero rows, so this pass never blocks correctness.
   *
   * Organic + deferred: scheduled off the critical path (`scheduleDeepIdle` /
   * `CATCHUP_DEEP_IDLE`, same scheme as `scheduleWorkspaceBackfills`) and re-run
   * on every seed-set change — create/restore-only + idempotent, so steady state
   * is a single probe SELECT that short-circuits on `seed:revision`. Passes
   * COALESCE per workspace (one pending pass at a time); the pass reads the
   * workspace's current seed set at run time, and only if that workspace is still
   * the active/projected one, so a coalesced set-grow is picked up and a
   * switched-away workspace is skipped.
   *
   * The deferred job awaits `awaitPropertySeedMaterializationAccess`, which
   * (for a non-freshly-created workspace) waits for the membership row before
   * writing — a fresh device defaults a not-yet-synced role to writable, so a
   * bare `isReadOnly` check would let a viewer enqueue ~100 RLS-rejected creates.
   * The early `isReadOnly` guard is a cheap short-circuit for a genuinely
   * read-only session; the gate is the authoritative check.
   */
  /** The current property + type seed declarations for `workspaceId`, or empty
   *  arrays when a registry is absent or pinned to a different workspace. Read
   *  live (not snapshotted) so a coalesced pass materializes the latest set. */
  private workspaceSeeds(workspaceId: string) {
    const propertyRegistry = this._propertyDefinitionRegistry
    const typeRegistry = this._typeDefinitionRegistry
    return {
      propertySeeds: propertyRegistry?.workspaceId === workspaceId
        ? [...propertyRegistry.seedsByKey.values()]
        : [],
      // Materialize exactly the registry's winners: one backing block per membership
      // id (the lowest-seed-key winner from `seedKeyById`), and never a contested-KEY
      // seed (its keep-first winner is contribution-order-dependent, so the
      // create/restore-only pass would strand a stale mirror on a later reorder). A
      // membership-id collision is winner-resolved rather than withheld — the id's one
      // stable winner materializes, its losers don't. `materializingTypeSeeds` is the
      // shared derivation, so this agrees with the block-id binding and the scheduled
      // recheck.
      typeSeeds: typeRegistry?.workspaceId === workspaceId
        ? materializingTypeSeeds(typeRegistry)
        : [],
    }
  }

  scheduleWorkspaceSeedMaterialization(workspaceId: string, freshlyCreated: boolean): void {
    if (this.isReadOnly || !workspaceId) return
    // Gate on EITHER registry: a type-seed-only change must still schedule a pass.
    const {propertySeeds, typeSeeds} = this.workspaceSeeds(workspaceId)
    if (propertySeeds.length === 0 && typeSeeds.length === 0) return
    // Coalesce: one pending pass per workspace. Repeated seed-set changes while a
    // pass is parked on the membership wait would otherwise stack a job + a
    // `workspace_members` subscription each; the pending pass reads the latest
    // seed set at run time, so a coalesced change is still materialized — UNLESS
    // the change lands after the pass snapshotted its seeds (or under an aborted
    // signal), which the running pass can't pick up. Mark dirty so the running
    // job re-runs once more rather than silently dropping it.
    if (this.pendingSeedMaterializationWorkspaces.has(workspaceId)) {
      this.dirtySeedMaterializationWorkspaces.add(workspaceId)
      return
    }
    this.pendingSeedMaterializationWorkspaces.add(workspaceId)
    this.seedMaterializationJobs.schedule(async () => {
      try {
        // Re-run while dirty: a seed-set change that coalesced onto this pass
        // after it snapshotted its seeds — or a switch-away that aborted it — sets
        // the dirty bit; loop so the change materializes without waiting for the
        // next unrelated change or a workspace reopen. The bit is cleared BEFORE
        // each run so a change landing during the run re-arms it. Re-fetch the
        // live generation each iteration: a switch-away aborts the prior one, so a
        // re-run for a (now re-active) workspace must use the current signal, not
        // the stale aborted one. `runWorkspaceSeedMaterialization` re-checks the
        // active/projected workspace and reads the latest seeds, so a run whose
        // workspace has gone away is a cheap no-op rather than a wrong write.
        // Kept inside ONE scheduled job (not a re-schedule) so the drain barrier's
        // single pending promise still covers the whole cascade.
        do {
          this.dirtySeedMaterializationWorkspaces.delete(workspaceId)
          await this.runWorkspaceSeedMaterialization(
            workspaceId, freshlyCreated, this.seedMaterializationGeneration.signal,
          )
        } while (this.dirtySeedMaterializationWorkspaces.has(workspaceId))
      } finally {
        this.pendingSeedMaterializationWorkspaces.delete(workspaceId)
        this.dirtySeedMaterializationWorkspaces.delete(workspaceId)
      }
    })
  }

  private async runWorkspaceSeedMaterialization(
    workspaceId: string,
    freshlyCreated: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const access = await awaitPropertySeedMaterializationAccess(this, workspaceId, {freshlyCreated, signal})
      if (!access.allowed) return
    } catch (err) {
      // A superseded generation (the user switched workspaces) aborts the parked
      // access wait — expected, not a failure to log or retry. Gate on OUR signal
      // so an unrelated AbortError-named failure still surfaces.
      if (signal.aborted && err instanceof Error && err.name === 'AbortError') return
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[seedMaterialization] workspace ${workspaceId} access wait failed: ${reason}`)
      return
    }
    // Property and type seeds back INDEPENDENT pages (Properties / Types), so run
    // each kind as its own isolated pass: a failure materializing one (e.g. a
    // deterministic id occupied by a foreign row) must NOT suppress the other, and
    // each rechecks the abort signal first so a switch-away landing between the two
    // can't create backing blocks in the workspace the user just left.
    await this.materializeSeedKind(workspaceId, signal, 'property')
    await this.materializeSeedKind(workspaceId, signal, 'type')
  }

  private async materializeSeedKind(
    workspaceId: string,
    signal: AbortSignal,
    kind: 'property' | 'type',
  ): Promise<void> {
    if (signal.aborted) return
    try {
      // `workspaceSeeds` reads live (see its doc); one extra consequence here is
      // that a registry rotated by a switch-away yields an empty set for the
      // departed workspace, making this a cheap no-op.
      const {propertySeeds, typeSeeds} = this.workspaceSeeds(workspaceId)
      // Pass `revalidateAgainstRegistry: true`: this snapshot can go stale during the
      // materializer's awaits (probe / ensure / tx setup), so the write path rechecks
      // each seed against the live registry before committing (§4.3 phantom guard).
      if (kind === 'property') {
        if (propertySeeds.length > 0) await materializePropertySeeds(this, workspaceId, propertySeeds, signal, true)
      } else if (typeSeeds.length > 0) {
        await materializeTypeSeeds(this, workspaceId, typeSeeds, signal, true)
      }
    } catch (err) {
      if (signal.aborted && err instanceof Error && err.name === 'AbortError') return
      const reason = err instanceof Error ? err.message : String(err)
      console.error(
        `[seedMaterialization] workspace ${workspaceId} ${kind} seeds failed (will retry next open/seed change): ${reason}`,
      )
    }
  }

  /** Test helper — drains seed-materialization passes whose deferral timer has
   *  fired. Mirror of `awaitWorkspaceBackfills`. */
  async awaitSeedMaterialization(): Promise<void> {
    await this.seedMaterializationJobs.drain()
  }

  private async runWorkspaceBackfills(
    workspaceId: string,
    backfills: readonly WorkspaceBackfill[],
  ): Promise<void> {
    const markers = await this.workspaceBackfillMarkers.load()
    for (const backfill of backfills) {
      // A role flip to read-only during the deferral window must stop further
      // writes — re-check per backfill (the loop can span several txs).
      if (this.isReadOnly) return
      if (markers.has(workspaceBackfillMarkerKey(workspaceId, backfill.id))) continue
      const ctx: WorkspaceBackfillContext = {
        workspaceId,
        getAll: <T>(sql: string, params?: readonly unknown[]) =>
          this.db.getAll<T>(sql, params as unknown[] | undefined),
        tx: <R>(fn: (tx: Tx) => Promise<R>, opts: {scope: ChangeScope; description?: string}) =>
          this.tx(fn, opts),
      }
      try {
        await backfill.run(ctx)
        // Record the marker only after a clean run — a thrown backfill leaves
        // it unset so the next open retries (backfills are written idempotent
        // via a per-row recheck, so a retry is cheap).
        await this.workspaceBackfillMarkers.set(workspaceBackfillMarkerKey(workspaceId, backfill.id))
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        console.error(
          `[workspaceBackfills] "${backfill.id}" failed for workspace ${workspaceId}: ${reason}`,
        )
      }
    }
  }

  /**
   * One-time-per-workspace catch-up derive of the LOCAL `reference_target_id`
   * column (PR #288 slice A). The column is derived per device and never
   * synced, so rows that predate it — an upgrading device's whole DB, or a
   * fresh device's rows synced before the schema registry primed — sit at
   * NULL until this pass sweeps them; from then on the same-tx processor
   * (local writes) and the materializer's derive-at-arrival (sync writes)
   * maintain it incrementally.
   *
   * Deferred off the workspace-open critical path (`scheduleDeepIdle`, same
   * scheme as its sibling passes) and marker-gated once per workspace. Derives
   * textually (`((id))`) or through the alias index (`[[alias]]`) — no schema
   * registry needed for resolution — but still scheduled after
   * `whenPropertyDefinitionsReady` so the sweep runs against the pinned active
   * workspace (its once-per-session gate below). NOT gated on writability: the
   * writes are local bookkeeping (source-NULL raw UPDATEs of a never-uploaded
   * column), safe in a read-only workspace.
   */
  scheduleReferenceTargetDerivePass(workspaceId: string): void {
    if (!workspaceId) return
    this.referenceTargetDeriveJobs.schedule(() =>
      // Swallow + log a transient sweep failure rather than leak an unhandled
      // rejection (the idle-job runner only does `.finally`, like the sibling
      // `drainNameRederives` guards its own body). The sweep marker is left
      // UNSET on throw, so the next workspace open retries — the pass is
      // strictly additive (`reference_target_id IS NULL`), never a re-stamp,
      // so a partial run can't double-stamp or clobber.
      this.runReferenceTargetDerivePass(workspaceId).catch((err) => {
        const reason = err instanceof Error ? err.message : String(err)
        console.error(`[referenceTargetDerive] workspace ${workspaceId} sweep failed: ${reason}`)
      }),
    )
  }

  /** Test helper — drains derive passes whose deferral timer has fired.
   *  Mirror of `awaitWorkspaceBackfills`. */
  async awaitReferenceTargetDerive(): Promise<void> {
    await this.referenceTargetDeriveJobs.drain()
  }

  private async runReferenceTargetDerivePass(workspaceId: string): Promise<void> {
    if (this.referenceTargetSweepDone.has(workspaceId)) return
    // Run only while this workspace is the pinned/active one — if the user
    // switched away before the deferred job fired, skip WITHOUT the marker so
    // the next open retries. (Resolution itself no longer needs the registry:
    // `((id))` derives textually and `[[alias]]` through the alias index.)
    const registry = this._propertyDefinitionRegistry
    if (!registry || registry.workspaceId !== workspaceId) return
    // Captured HERE, at the gate that just proved this workspace's registry
    // is live — not at write time, which is many awaits and possibly two
    // workspace switches later (see ReferenceTargetStampContext).
    const stampContext: ReferenceTargetStampContext = {
      workspaceId, resolver: this.propertySchemaResolverFor(workspaceId),
    }

    // Candidate prefilter in SQL (cheap LIKEs over one workspace, one-time);
    // the real grammar check is `parseExactReferenceBlockContent` inside
    // `deriveReferenceTargetId`. Deleted rows are included deliberately: a
    // tombstone restored later arrives content-unchanged, so nothing would
    // re-derive it. `reference_target_id IS NULL` keeps the pass strictly
    // additive — it never second-guesses a processor- or arrival-derived
    // value. Lean scan (id + content): the write phase re-reads fresh rows
    // in-tx, so full rows here would only feed stale snapshots.
    // The `'::%'` probe is the marked-form twin (§7 grammar box): every
    // content-shape prefilter carries it, or a pasted `::[[future-field]]`
    // (bit-worthy, target unresolvable) would never be revisited by repair.
    const candidates = await this.db.getAll<{id: string; content: string}>(
      `SELECT id, content FROM blocks
        WHERE workspace_id = ?
          AND reference_target_id IS NULL
          AND (
            (TRIM(content) LIKE '((%' AND TRIM(content) LIKE '%))')
            OR (TRIM(content) LIKE '[[%' AND TRIM(content) LIKE '%]]')
            OR TRIM(content) LIKE '[%](((%)))'
            OR TRIM(content) LIKE '::%'
          )`,
      [workspaceId],
    )

    const lookups = this.referenceTargetLookupsVia()

    const updates: ReferenceTargetStamp[] = []
    for (const row of candidates) {
      const derived = await deriveReferenceColumns(row.content, workspaceId, lookups)
      // Target column is already NULL, so unresolved (`undefined`) and
      // non-reference (`null`) alike mean "no target to write" — but a
      // marked row stamps its bit regardless (pure syntax; §9 condition 1).
      if (typeof derived.targetId === 'string' || derived.isFieldForm) {
        updates.push({
          id: row.id,
          scannedContent: row.content,
          targetId: derived.targetId ?? null,
          isFieldForm: derived.isFieldForm,
        })
      }
    }

    await this.stampReferenceTargets(updates, stampContext)

    this.referenceTargetSweepDone.add(workspaceId)
    // Defense only — pre-sweep scheduling never accumulates. Note the
    // narrow accepted window: an alias/definition arriving between this
    // sweep's candidate SELECT and this line is dropped for the session
    // and healed by the NEXT open's sweep.
    this.pendingNameRederives.delete(workspaceId)
  }

  /** The one construction site for reference-target resolution outside a
   *  repo.tx (PR #288 slice A): the `block_aliases` index read on `reader` —
   *  the open sync-arrival write tx, or the auto-commit connection for the
   *  idle passes. Mirrors `core.deriveReferenceTarget` (a `((id))` block-ref
   *  resolves textually, `[[alias]]` through this lookup); the two must
   *  resolve identically or the column diverges across write paths. */
  private referenceTargetLookupsVia(
    reader: {getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>} = this.db,
  ): ReferenceTargetLookups {
    return {
      aliasTargetId: async (alias, workspaceId) => {
        if (alias === '' || workspaceId === '') return null
        const row = await reader.getOptional<{id: string}>(
          SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL,
          [workspaceId, alias],
        )
        return row?.id ?? null
      },
    }
  }

  /** Chunked raw column stamps, materializer-style: source-NULL (upload
   *  triggers skip; row_events tags 'sync'), no repo.tx — a tx would advance
   *  `updated_at` (the LWW row-version) for a purely local derivation.
   *
   *  Compare-and-set per row (adversarial-review fix): callers scan/derive
   *  outside the write lock, so a concurrent local edit or sync arrival can
   *  change content (the processor/arrival owns the column from then on). A
   *  bare UPDATE would stamp a stale target that nothing ever repairs — the
   *  row would misclassify as a field row post-flip. Only rows still at
   *  (scanned content, NULL column) are written, and snapshots come from the
   *  in-tx fresh rows, never scan-time state. */
  private async stampReferenceTargets(
    updates: readonly ReferenceTargetStamp[],
    context: ReferenceTargetStampContext,
  ): Promise<void> {
    const CHUNK = 200
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK)
      // BOTH gates are re-read per chunk, and the symmetry is the point.
      // `properties_migration` is server-driven (a synced `workspaces` row,
      // no local writer) and `isReadOnly` is mutable and resolved
      // asynchronously, so either can land mid-pass. Hoisting is stale in
      // the UNSAFE direction for both: the rows still get stamped, and both
      // repair scans require `reference_target_id IS NULL`, so once stamped
      // nothing — not the next open's sweep, not the drain — ever re-finds
      // them. A dormant workspace collects nothing, so the cost of asking
      // again is one indexed row read per 200 stamps.
      const reproject = !this.isReadOnly
        && await readIsChildBackedWorkspace(this.db, context.workspaceId)
      // Rows THIS chunk turned into recognized field rows. Per chunk, not
      // per pass: the re-projection then follows its own stamps immediately,
      // so a crash or a closed tab loses at most one chunk of repair instead
      // of all of it — and the rows are no longer NULL-targeted, so no later
      // scan would ever find them again.
      const newlyRecognized: ProjectableRow[] = []
      const snapshots = new Map<string, {before: BlockData; after: BlockData}>()
      await this.db.writeTransaction(async tx => {
        await tx.execute('UPDATE tx_context SET source = NULL WHERE id = 1')
        for (const {id, scannedContent, targetId, isFieldForm} of chunk) {
          const freshRow = await tx.getOptional<BlockRow>(
            `SELECT ${BLOCKS_TABLE_COLUMN_NAMES.join(', ')} FROM blocks WHERE id = ?`,
            [id],
          )
          if (
            freshRow === null
            || (freshRow.reference_target_id ?? null) !== null
            || freshRow.content !== scannedContent
            // Bit-only stamps (marked row, unresolvable span) skip when the
            // bit already matches — nothing to write, no snapshot churn.
            || (targetId === null && (freshRow.is_field_form === 1) === isFieldForm)
          ) continue
          await tx.execute(
            'UPDATE blocks SET reference_target_id = ?, is_field_form = ? WHERE id = ?',
            [targetId, isFieldForm ? 1 : null, id],
          )
          const before = parseBlockRow(freshRow)
          const after = {...before, referenceTargetId: targetId, isFieldForm}
          snapshots.set(id, {before, after})
          // Only the "turns on" direction is reachable: the CAS above writes
          // only rows still at a NULL target, and §9 recognition needs a
          // resolved one — so nothing here was a field row beforehand.
          if (reproject && targetId !== null && isFieldForm && after.parentId !== null) {
            newlyRecognized.push({
              id: after.id,
              parentId: after.parentId,
              workspaceId: after.workspaceId,
              referenceTargetId: targetId,
              isFieldForm,
            })
          }
        }
      })
      if (snapshots.size === 0) continue
      // Explicit fan-out (PR #288 §11 implementation note): `updated_at` is
      // deliberately unchanged, so the cache's `applyIfNewer` LWW gate would
      // reject the repair and row-version-driven invalidation sees nothing.
      // Refresh already-cached snapshots directly (never populate cold rows)
      // and notify handles. NEVER regress a newer cached row: in the sync
      // ack-to-echo window the cache can legitimately be AHEAD of disk, and
      // the LWW gate this bypasses exists precisely to protect that — only
      // replace a snapshot the stamped disk row is at least as new as.
      for (const {after} of snapshots.values()) {
        const cached = this.cache.getSnapshot(after.id)
        if (cached !== undefined && cached.updatedAt <= after.updatedAt) {
          this.cache.setSnapshot(after)
        }
      }
      this.handleStore.invalidate(
        snapshotsToChangeNotification(snapshots, this.invalidationRules),
      )
      if (newlyRecognized.length === 0) continue
      try {
        await this.reprojectOwnersOfStampedFieldRows(newlyRecognized, context)
      } catch (err) {
        // The stamps are the primary job and they committed; a projection
        // failure must not abort the pass (the sweep would never set its
        // marker, disabling late-binding for the whole session). The repair
        // is additive and idempotent, so any later edit to the subtree
        // re-projects it through the ordinary processor.
        const reason = err instanceof Error ? err.message : String(err)
        console.error(
          `[referenceTargetStamp] owner re-projection failed for workspace `
          + `${context.workspaceId}: ${reason}`,
        )
      }
    }
  }

  /** Owner-cell re-projection for rows a raw stamp just turned into
   *  recognized field rows (PR #288 §9 / issue #402's derivation-liveness
   *  group). The stamp itself deliberately bypasses `repo.tx` to preserve
   *  `updated_at`, so no processor sees it — but resolving a `::[[Foo]]`
   *  row's target IS the transition that makes it a field row, and the
   *  owner's cell must gain the key at that moment rather than waiting for
   *  an unrelated edit to the subtree.
   *
   *  Reachable post-flip only (the caller owns that gate): a hand-typed or
   *  imported `::[[status]]` written before anything claimed "status"
   *  derives to a NULL target, and the alias-claim drain (or the next open's
   *  sweep) resolves it later. Unlike the stamp, this write goes through
   *  `repo.tx` — it's a cell write on the PARENT, ordinary derived state,
   *  and the projection's `skipMetadata` keeps it off "last edited".
   *
   *  ADDITIVE, and that is load-bearing (adversarial review). Running
   *  outside the PROJECT processor means the cell write is not settled, so
   *  `core.materializePropertyChildren` reads it as a key change. A `full`
   *  projection here would therefore be destructive in the ordinary case,
   *  not an exotic one: between a workspace flipping and its backfill
   *  landing every owner holds cell keys with NO field rows, so the first
   *  sweep would project "nothing parses" into an unset, and materialize
   *  would read that unset as a user deleting the key and tombstone the
   *  very rows the stamp just recognized — uploading the tombstones. The
   *  overwrite direction is barred for the same reason: reconciling a
   *  populated cell against children is the backfill's job.
   *
   *  `References`, not `BlockDefault` (the same call the deferred definition
   *  migration batch makes, for the same reason): a `BlockDefault` tx lands
   *  on the user's cmd-Z stack, so a background repair would become the
   *  thing their next undo reverts. */
  private async reprojectOwnersOfStampedFieldRows(
    rows: readonly ProjectableRow[],
    context: ReferenceTargetStampContext,
  ): Promise<void> {
    if (rows.length === 0) return
    const lookups: ProjectionLookups = {
      resolveFieldSchema: (fieldId) => {
        const resolution = context.resolver.resolveField(fieldId)
        return resolution.status === 'resolved' ? resolution.schema : undefined
      },
    }
    await this.tx(
      tx => reprojectOwnersForRowStates(tx, rows, lookups, 'additive'),
      {
        scope: ChangeScope.References,
        description: 'reproject property cells after reference-target stamp',
      },
    )
  }

  /** Targeted re-derive for NEWLY-ADDED property definitions (PR #288 §9's
   *  arrival-order repair, adversarial-review fix): `[[name]]` rows written
   *  or synced BEFORE their definition existed derived to NULL, and nothing
   *  content-driven ever revisits them — the definition's later
   *  arrival/creation must enqueue this pass. Scheduled by the facet bridge
   *  when a registry rebuild shows a fieldId with no previous entry (the
   *  boot-time first snapshot diffs against null and is deliberately
   *  skipped — the once-per-workspace catch-up pass covers it, running
   *  after registry readiness). Not flip-gated: the column is slice-A
   *  machinery, maintained everywhere. */
  scheduleReferenceTargetNameRederive(
    workspaceId: string,
    names: readonly string[],
  ): void {
    if (!workspaceId || names.length === 0) return
    // Pre-sweep, the per-open sweep covers every name — don't accumulate
    // (on a fresh device EVERY page arrival gains aliases; queuing them all
    // would just re-run the sweep's own scan).
    if (!this.referenceTargetSweepDone.has(workspaceId)) return
    const pending = this.pendingNameRederives.get(workspaceId) ?? new Set<string>()
    for (const name of names) if (name !== '') pending.add(name)
    this.pendingNameRederives.set(workspaceId, pending)
    if (this.nameRederiveDrainScheduled.has(workspaceId)) return
    this.nameRederiveDrainScheduled.add(workspaceId)
    this.referenceTargetDeriveJobs.schedule(() => this.drainNameRederives(workspaceId))
  }

  /** ONE batched candidate scan per drain (the LIKE prefilter the sweep
   *  uses, workspace-scoped, NULL-column only), matched in JS against the
   *  pending name set via the real grammar (which tolerates inner padding a
   *  SQL equality can't). A drain whose workspace registry isn't primed
   *  leaves the set intact — `applyTypesAndSchemas` re-arms it when that
   *  workspace's registry lands. */
  private async drainNameRederives(workspaceId: string): Promise<void> {
    this.nameRederiveDrainScheduled.delete(workspaceId)
    const pending = this.pendingNameRederives.get(workspaceId)
    if (!pending || pending.size === 0) return
    const registry = this._propertyDefinitionRegistry
    if (!registry || registry.workspaceId !== workspaceId) return
    // Captured at the gate, not at write time (see ReferenceTargetStampContext).
    const stampContext: ReferenceTargetStampContext = {
      workspaceId, resolver: this.propertySchemaResolverFor(workspaceId),
    }
    this.pendingNameRederives.delete(workspaceId)
    try {
      // Strictly additive (`reference_target_id IS NULL`, like the sweep):
      // late-bind rows that derived to NULL because their target didn't exist
      // yet — a generic alias minted mid-session (referencesProcessor enqueues
      // the name when it creates the seat) repairs `[[Foo]]` rows written
      // before page Foo existed. Re-pointing an ALREADY-stamped row is
      // deliberately NOT done: `reference_target_id`'s only consumers are
      // property field-row recognition (is-target-a-definition), and
      // definitions aren't name-resolvable yet, so a non-NULL re-point would
      // change nothing any reader observes. That reclaim (with the cell
      // reprojection a raw stamp currently skips) belongs to the auto-claim
      // work that makes definitions name-resolvable.
      // `'::[[%'` twin: marked alias rows late-bind exactly like unmarked
      // ones (§7 — the bit is already stamped by derive; this repairs the
      // target), and a prefilter without the twin would leave a pasted
      // `::[[future-field]]` bit=1/target-NULL forever once its name mints.
      // Alias forms ONLY, unlike the sweep's all-forms prefilter: this drain
      // discards anything that isn't `kind === 'alias'` two lines below, and
      // an id form can't be one. Fetching `((%…%))` rows here would scan a
      // whole workspace's exact refs to throw every one of them away.
      const candidates = await this.db.getAll<{id: string; content: string}>(
        `SELECT id, content FROM blocks
          WHERE workspace_id = ?
            AND reference_target_id IS NULL
            AND TRIM(content) LIKE '%]]'
            AND (TRIM(content) LIKE '[[%' OR TRIM(content) LIKE '::[[%')`,
        [workspaceId],
      )
      const lookups = this.referenceTargetLookupsVia()
      const updates: ReferenceTargetStamp[] = []
      for (const row of candidates) {
        const exact = parseExactReferenceBlockContent(row.content)
        if (exact?.kind !== 'alias' || !pending.has(exact.alias)) continue
        const derived = await deriveReferenceColumns(row.content, workspaceId, lookups)
        if (typeof derived.targetId === 'string') {
          updates.push({
            id: row.id,
            scannedContent: row.content,
            targetId: derived.targetId,
            isFieldForm: derived.isFieldForm,
          })
        }
      }
      await this.stampReferenceTargets(updates, stampContext)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[referenceTargetRederive] workspace ${workspaceId} failed: ${reason}`)
      // Re-queue AND re-arm so the repair isn't consumed by a transient
      // failure (without the re-arm the names would sit until the next
      // alias event / registry rebuild / app open).
      const requeued = this.pendingNameRederives.get(workspaceId) ?? new Set<string>()
      for (const name of pending) requeued.add(name)
      this.pendingNameRederives.set(workspaceId, requeued)
      if (!this.nameRederiveDrainScheduled.has(workspaceId)) {
        this.nameRederiveDrainScheduled.add(workspaceId)
        this.referenceTargetDeriveJobs.schedule(() => this.drainNameRederives(workspaceId))
      }
    }
  }

  /**
   * Rename-reproject + codec re-encode migration pass (PR #288 §7/§9, slice
   * B2). Scheduled by the facet bridge when a registry rebuild shows a
   * definition's NAME or codec TYPE changed under its durable fieldId —
   * renames break silently without it: children survive untouched (the
   * column, not the label, is authoritative) but the cell stays keyed by the
   * dead name and every schema-aware reader falls back to `defaultValue`.
   *
   * Per change, one child-indexed sweep (the `reference_target_id` partial
   * index): retitle stale field-row content (`[[old]]` → `[[new]]` — markdown
   * export and cross-workspace re-derive-by-content bind the name), re-encode
   * value children to the new codec's canonical content where they convert,
   * and re-key each consuming parent's cell (drop the old key; project the
   * new one from the first parseable value). Writes ride ordinary repo.tx —
   * field-row content and cells are synced state, and the flip-gated
   * processors' idempotence makes the overlap free.
   *
   * Values that can't convert under a codec change are REPORTED (§9: "N
   * values can't convert" must be user-visible, not a silent unset) via the
   * user-error toast channel; the rows stay visible/fixable in the tree.
   *
   * Flip-gated: an un-flipped workspace has no recognized field rows and its
   * renames keep today's semantics; skipped entirely (no marker — this pass
   * is change-driven, not once-per-workspace).
   */
  schedulePropertyDefinitionMigrations(
    workspaceId: string,
    changes: readonly PropertyDefinitionChange[],
  ): void {
    if (this.isReadOnly || !workspaceId || changes.length === 0) return
    // Resolve NOW, not when the deferred job runs. `changes` comes from this
    // workspace's OWN registry rebuild (the facet bridge calls
    // `applyTypesAndSchemas` then this method synchronously, in the same
    // tick), so `propertySchemaResolverFor(workspaceId)` is guaranteed to
    // serve it faithfully here. The batch itself is deferred to a deep-idle
    // job, and `propertySchemaResolverFor` only retains the active workspace
    // or the immediately-previous one (one-deep) — by the time the job runs
    // the user may have switched workspaces twice more, which would evict
    // `workspaceId` from both slots and make a run-time re-resolve fail
    // closed (empty plans, migration silently dropped with no retry, #386
    // review). Capturing the resolved plan here instead means it describes
    // THIS change and can never go stale from a LATER, unrelated workspace
    // switch. A fieldId that doesn't resolve (shadowed / unavailable, §6) is
    // dropped from the plan — the same skip the run-time check used to do,
    // just performed here instead.
    const resolver = this.propertySchemaResolverFor(workspaceId)
    const plans: PropertyDefinitionMigrationPlan[] = changes.flatMap(change => {
      const resolution = resolver.resolveField(change.fieldId)
      return resolution.status === 'resolved' ? [{change, schema: resolution.schema}] : []
    })
    if (plans.length === 0) return
    this.propertyDefinitionMigrationJobs.schedule(() =>
      this.runPropertyDefinitionMigrations(workspaceId, plans, resolver),
    )
  }

  /** Test helper — drains migration passes whose deferral timer has fired. */
  async awaitPropertyDefinitionMigrations(): Promise<void> {
    await this.propertyDefinitionMigrationJobs.drain()
  }

  private async runPropertyDefinitionMigrations(
    workspaceId: string,
    plans: readonly PropertyDefinitionMigrationPlan[],
    resolver: PropertySchemaResolver,
  ): Promise<void> {
    if (!(await readIsChildBackedWorkspace(this.db, workspaceId))) return
    try {
      await this.runPropertyDefinitionMigrationBatch(workspaceId, plans, resolver)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const names = plans.map(({change}) => `"${change.newName}" (${change.fieldId})`).join(', ')
      console.error(`[propertyDefinitionMigrations] ${names} failed: ${reason}`)
    }
  }

  /** Re-key + re-encode every parent touched by THIS rebuild's definition
   *  changes, applying each parent's whole change set in ONE cell write.
   *
   *  Per-change passes are unsafe when two definitions SWAP names (`a→b` and
   *  `b→a` in one rebuild). Migrating `a→b` first writes the intermediate cell
   *  `{b: <a's value>}`, which (1) clobbers b's value outright and (2) removes
   *  key `a` — and because `a` now resolves through the FINAL name map to the
   *  OTHER definition, the same-tx materializer (which watches `properties`)
   *  reads that removal as a user delete and tombstones that definition's field
   *  row before its own pass runs. No ordering avoids it: a swap is a cycle.
   *
   *  Applying a parent's whole set at once has no intermediate state: every
   *  old name is dropped BEFORE any new name is assigned, so a swap lands as
   *  `{a: <b's value>, b: <a's value>}` in a single write and the materializer
   *  never sees a key go missing. */
  private async runPropertyDefinitionMigrationBatch(
    workspaceId: string,
    plans: readonly PropertyDefinitionMigrationPlan[],
    resolver: PropertySchemaResolver,
  ): Promise<void> {
    // `plans` arrives pre-resolved (schedule-time capture, see
    // `schedulePropertyDefinitionMigrations`) and `resolver` is the SAME
    // instance that resolved it — both frozen against the registry snapshot
    // as of that moment, immune to any workspace switch that happens while
    // this deferred batch sits queued or runs. Shadowed/unavailable
    // definitions were already excluded from `plans` there (§6) — nothing to
    // re-key for them.

    // `parent_id IS NOT NULL`: §9 root half — a stamped workspace-root row
    // is user content (never a field row); retitling it would rewrite the
    // user's text.
    // Chunked like the parent pass below: one bound variable per changed field
    // would otherwise blow SQLITE_MAX_VARIABLE_NUMBER on a big registry rebuild
    // (a large sync or scripted schema change), and the caller only LOGS the
    // throw — so every affected cell would silently stay unmigrated.
    // The Set is load-bearing, not tidiness: `SELECT DISTINCT` only dedupes
    // WITHIN one statement, so a parent holding field rows for two changed
    // definitions that land in different chunks would otherwise be migrated
    // twice.
    const fieldIds = plans.map(plan => plan.change.fieldId)
    const FIELD_PROBE_CHUNK = 500
    const parentIdSet = new Set<string>()
    for (let i = 0; i < fieldIds.length; i += FIELD_PROBE_CHUNK) {
      const fieldChunk = fieldIds.slice(i, i + FIELD_PROBE_CHUNK)
      const candidates = await this.db.getAll<{parent_id: string | null}>(
        `SELECT DISTINCT parent_id FROM blocks
          WHERE workspace_id = ? AND reference_target_id IN (${fieldChunk.map(() => '?').join(', ')})
            AND is_field_form = 1
            AND deleted = 0 AND parent_id IS NOT NULL`,
        [workspaceId, ...fieldChunk],
      )
      for (const row of candidates) {
        if (row.parent_id !== null) parentIdSet.add(row.parent_id)
      }
    }
    const parentIds = [...parentIdSet]
    if (parentIds.length === 0) return

    // Per changed definition, for the user-facing unparseable-values report.
    const unconvertibleByField = new Map<string, number>()
    const CHUNK = 100
    for (let i = 0; i < parentIds.length; i += CHUNK) {
      const chunk = parentIds.slice(i, i + CHUNK)
      await this.tx(async tx => {
        // Flat §9 recognition: field-row selection below keys on the BIT +
        // fieldId (the bit is what keeps a ref-typed value pointing at this
        // very definition from being misread as a field row — no ancestry
        // walk exists anymore, and every owner re-keys uniformly at any
        // depth).
        //
        // `isFieldDefinition` closes over the batch's captured `resolver`
        // (schedule-time snapshot, captured in
        // `schedulePropertyDefinitionMigrations` and threaded through as a
        // parameter — NOT re-derived here). It used to call
        // `this.propertySchemaResolverFor(workspaceId)` fresh per
        // chunk, but that has the exact same one-deep active/previous fail-
        // closed behavior as the outer resolve this method used to do: once
        // the deferred batch's own workspace fell out of retention (further
        // switches while THIS batch's chunks are still running), every
        // fieldId — including the ones `plans` already proved resolvable —
        // would stop resolving, `isPropertyFieldInstance` below would reject
        // every sibling, and the batch would silently re-key nothing despite
        // having non-empty plans. Reusing the captured `resolver` fixes that:
        // it's bound to a real snapshot for the life of the batch, not to
        // whatever workspace happens to be live when a chunk executes. This
        // also covers ancestor fieldIds unrelated to `plans` (arbitrary other
        // definitions encountered walking up from `parentId`), which a
        // plans-only lookup can't answer — the resolver is what actually knows
        // "is this fieldId some (possibly shadowed) definition in this
        // workspace's registry", not just "is it one of the migrating ones".
        //
        // Trade-off: this is a fixed snapshot for the whole batch, so a
        // genuinely concurrent definition change landing between chunks (or
        // between schedule time and the batch running) isn't picked up
        // here — but that's an independent, separately-diffed registry
        // rebuild, so it schedules its OWN follow-up migration; it doesn't
        // need this pass to also notice it. For the `plans` fieldIds
        // specifically, `isFieldDefinition(change.fieldId)` is now
        // provably always true (same resolver instance that already proved
        // `change.fieldId` resolves when `plans` was built) — the guard below
        // stays for the root-half/shared-recognizer symmetry with the
        // ancestor walk, not as a live re-check.
        const isFieldDefinition: IsPropertyFieldDefinition = (fieldId) => {
          const rowResolution = resolver.resolveField(fieldId)
          return rowResolution.status === 'resolved'
            || (rowResolution.status === 'identity-unavailable' && rowResolution.reason === 'shadowed')
        }

        for (const parentId of chunk) {
          // Shared swap-safe re-key: the helper owns the parent guard and
          // the drop-all-then-set-all apply (symmetric with the same-tx
          // rename processor). This computePlan is the codec half — it
          // re-encodes value children under the (possibly new) codec and
          // reports unconvertibles.
          await rekeyParentPropertyCell(
            tx, parentId,
            async (siblings) => {
              const oldNames: string[] = []
              const assignments: Array<{name: string; value: unknown; unset: boolean}> = []
              for (const {change, schema} of plans) {
                let projected: unknown
                let hasProjection = false
                let parentUnconvertible = 0
                let sawFieldRow = false
                // Field-row content is `::((fieldId))` — id-addressed and
                // rename-stable (§7), nothing to retitle. The fieldId
                // equality picks THIS definition's field rows; the shared §9
                // recognizer supplies the bit + root + resolvability
                // conditions (`isFieldDefinition(change.fieldId)` is always
                // true here — kept as the one composed predicate rather than
                // a hand-rolled restatement).
                for (const sibling of siblings) {
                  if (
                    (sibling.referenceTargetId ?? null) !== change.fieldId
                    || !isPropertyFieldInstance(sibling, isFieldDefinition)
                  ) continue
                  sawFieldRow = true
                  // §9 value set: bit-filtered — nested marked rows are
                  // machinery, never value candidates.
                  const values = (await tx.childrenOf(sibling.id, undefined))
                    .filter(isFieldValueChild)
                  for (const value of values) {
                    try {
                      const encoded = propertyChildContentToEncodedValue(
                        schema, value.content, value.referenceTargetId ?? null,
                      )
                      if (!hasProjection) {
                        projected = encoded
                        hasProjection = true
                      }
                      // Canonicalize the child content under the (possibly new)
                      // codec so the stored text matches what setProperty would
                      // write.
                      const canonical = encodedPropertyValueToChildContent(schema, encoded)
                      if (value.content !== canonical) {
                        await tx.update(value.id, {content: canonical}, {skipMetadata: true})
                      }
                    } catch {
                      parentUnconvertible += 1
                    }
                  }
                }
                // This parent carries no field row for this definition — its
                // cell keys for it are none of this change's business.
                if (!sawFieldRow) continue
                if (parentUnconvertible > 0) {
                  unconvertibleByField.set(
                    change.fieldId,
                    (unconvertibleByField.get(change.fieldId) ?? 0) + parentUnconvertible,
                  )
                }

                if (change.oldName !== schema.name) oldNames.push(change.oldName)
                if (hasProjection) {
                  assignments.push({name: schema.name, value: projected, unset: false})
                } else if (parentUnconvertible === 0) {
                  assignments.push({name: schema.name, value: undefined, unset: true})
                }
                // else (all-unconvertible): leave the new key unset — no
                // assignment.
                //   - rename: the old key is dropped and the new key stays
                //     absent → the cell shows unset for the unparseable values,
                //     §9's contract. Re-keying the stale value under the new name
                //     would violate §9 (cell derives from children).
                //   - no rename: the existing key rides untouched (no old name to
                //     drop, no assignment) so a stale-but-fixable value stays
                //     visible; the next valid edit reprojects and heals it
                //     (§5 pending-reprojection).
                // This pass NEVER deletes value rows, so they stay live
                // unconditionally and the unconvertible COUNT is surfaced below.
              }
              return {oldNames, assignments}
            },
          )
        }
      }, {
        // References, not BlockDefault (adversarial-review blocker): a
        // BlockDefault tx lands on the user's cmd-Z stack — a rename backing
        // thousands of field rows would flood/evict their history, clear
        // redo, and a stray undo would revert a migration chunk with no
        // re-run path (the pass is change-driven, no marker). References is
        // the maintenance bucket the ref-reprojection pass already uses:
        // uploads normally, never exposed to cmd-Z. Writes are
        // skipMetadata — machinery, not "last edited".
        scope: ChangeScope.References,
        // This pass now handles codec-TYPE changes (renames are same-tx, see
        // core.migratePropertyRename), so a single plan is usually a re-encode
        // (oldName === newName) — only a COMBINED rename+codec edit still shows
        // an arrow. Word it to match rather than print "Foo -> Foo".
        description: plans.length === 1
          ? (plans[0].change.oldName === plans[0].schema.name
            ? `re-encode property definition ${plans[0].schema.name}`
            : `migrate property definition ${plans[0].change.oldName} -> ${plans[0].schema.name}`)
          : `migrate ${plans.length} property definitions`,
      })
    }

    // §9: a codec change that strands values must be user-visible, never a
    // silent unset. The rows stay in the tree, fixable by hand. Reported per
    // definition — one rebuild can change several.
    for (const {change, schema} of plans) {
      const unconvertible = unconvertibleByField.get(change.fieldId) ?? 0
      if (unconvertible === 0) continue
      // Claim only what's true: this pass never deletes a value row, so the
      // text is preserved verbatim. It does NOT promise a surface — value
      // children sit under a field row, and the visible view prunes field
      // rows (§9), so post-flip they are reachable through the property
      // rows, not by scrolling the outline. Naming the outline here would
      // send the user somewhere the values demonstrably aren't (#386 review).
      const message =
        `${unconvertible} value${unconvertible === 1 ? '' : 's'} for property `
        + `"${schema.name}" could not convert to the new type; their original `
        + `text is preserved unchanged`
      console.warn(`[propertyDefinitionMigrations] ${message}`)
      this.userErrorListeners.notify(new ProcessorRejection(
        message, 'property.codec-change.unconvertible',
        {fieldId: change.fieldId, name: schema.name, count: unconvertible},
      ))
    }
  }

  /**
   * One-time post-upgrade recovery for the deterministic-id shadow bug. A client
   * that skip-staled the server's authoritative row under an *old* reconcile
   * gate consumed its `blocks_synced_changes` entry, so a normal queue-driven
   * drain never re-evaluates it — the shadow persists across reloads. This
   * re-runs the materialization for the workspace via `drainSyncWorkspace`,
   * which re-reads `blocks_synced` DIRECTLY (bypassing the consumed queue) and
   * re-applies the gate, un-shadowing the server's value on disk.
   *
   * No special mode is needed anymore: with server-enforced `updated_at`
   * monotonicity, the sole gate already lets the server win on any
   * non-equal-non-pending row, and a 0-stamped pristine shadow yields via the
   * stamp-0 exemption. (This replaced the old `healing`-mode rescan, which
   * existed because the legacy strict gate would PROTECT a real-user-stamped
   * shadow as if it were an edit.) The pending + equal-nonzero-stamp guards
   * still hold, so an unsent edit is never lost.
   *
   * Marker-gated to run at most once per (workspace, client); deferred off the
   * open path; windowed + resumable and idempotent (a settled workspace
   * re-scans to no-ops). A 0-stamped pristine shadow heals in the live cache
   * too (the LWW accept, since the server row out-stamps 0); a legacy nonzero
   * shadow heals on disk now and in the cache on the next reload.
   *
   * Call after the access gate (a locked/unverified workspace must not be
   * re-materialized here — its own gate-resolution path runs drainWorkspace).
   */
  scheduleReconcileRescan(workspaceId: string): void {
    if (!workspaceId) return
    this.reconcileRescanJobs.schedule(() => this.runReconcileRescan(workspaceId))
  }

  private async runReconcileRescan(workspaceId: string): Promise<void> {
    const key = `${RECONCILE_RESCAN_MARKER_PREFIX}${workspaceId}`
    const done = await this.db.getOptional<{key: string}>(SELECT_RECONCILE_RESCAN_MARKER_SQL, [key])
    if (done) return
    try {
      await this.drainSyncWorkspace(workspaceId)
      // Marker only after a clean pass — a thrown/interrupted re-scan leaves it
      // unset so the next open retries (drainSyncWorkspace is resumable + idempotent).
      await this.db.execute(RECORD_RECONCILE_RESCAN_MARKER_SQL, [key])
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[reconcileRescan] workspace ${workspaceId} failed (will retry next open): ${reason}`)
    }
  }

  /** Test helper — drains reconcile-rescans whose deferral timer has fired.
   *  Mirror of `awaitWorkspaceBackfills`. */
  async awaitReconcileRescans(): Promise<void> {
    await this.reconcileRescanJobs.drain()
  }

  /** Strict: throws `BlockNotFoundForTypeError` if `blockId` is missing
   *  or tombstoned at write time. Use when the caller's correctness
   *  depends on the tag actually landing (orchestration / fan-out
   *  paths). For the lenient variant that silently no-ops on a missing
   *  block, see `addTypeInTxLenient` and (in-tx) the dedicated lenient
   *  entry points. Delegates to `TypeTagger` (audit D1(b)). */
  async addType(
    blockId: string,
    typeId: string,
    initialValues: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.typeTagger.addType(blockId, typeId, initialValues)
  }

  /** Strict in-tx variant. Throws `BlockNotFoundForTypeError` if the
   *  target block is missing or tombstoned. The default for orchestration
   *  code; pair with the lenient variant only when racing a concurrent
   *  delete is legitimate (sync-apply / processor paths). */
  async addTypeInTx(
    tx: Tx,
    blockId: string,
    typeId: string,
    initialValues: Readonly<Record<string, unknown>> = {},
    snapshot?: TypeRegistrySnapshot,
  ): Promise<void> {
    await this.typeTagger.addTypeInTx(tx, blockId, typeId, initialValues, snapshot)
  }

  /** Lenient in-tx variant — silently no-ops if the target block is
   *  missing or tombstoned. Reserved for sync-apply / processor paths
   *  that may legitimately observe a concurrent delete between
   *  pre-tx state and tx-start. New orchestration code should prefer
   *  `addTypeInTx` (strict) so a footgun like the Roam-isa adoption
   *  bug (PR #47) can't be expressed. */
  async addTypeInTxLenient(
    tx: Tx,
    blockId: string,
    typeId: string,
    initialValues: Readonly<Record<string, unknown>> = {},
    snapshot?: TypeRegistrySnapshot,
  ): Promise<void> {
    await this.typeTagger.addTypeInTxLenient(tx, blockId, typeId, initialValues, snapshot)
  }

  async removeType(blockId: string, typeId: string): Promise<void> {
    await this.typeTagger.removeType(blockId, typeId)
  }

  async removeTypeInTx(tx: Tx, blockId: string, typeId: string): Promise<void> {
    await this.typeTagger.removeTypeInTx(tx, blockId, typeId)
  }

  async toggleType(blockId: string, typeId: string): Promise<void> {
    await this.typeTagger.toggleType(blockId, typeId)
  }

  async setBlockTypes(blockId: string, typeIds: readonly string[]): Promise<void> {
    await this.typeTagger.setBlockTypes(blockId, typeIds)
  }

  /** Replace the query registry and bump the global `queryEpoch` only when
   *  an existing query was REPLACED or REMOVED — never for a purely
   *  additive swap (new names only). A bump re-keys every query, so the
   *  next lookup of any query gets a fresh handle over the new registry;
   *  existing handles stay at the old epoch and keep serving their captured
   *  snapshot (see `queryEpoch`).
   *
   *  Why additive swaps don't bump: a new query name cannot invalidate any
   *  EXISTING handle's snapshot — every query a live handle captured is
   *  still present and identical, so its result can't have changed and a
   *  fresh lookup of an existing query is safe to reuse the cached handle.
   *  This is the common reload shape (`AppRuntimeProvider`'s base→next swap
   *  adds dynamic-plugin queries while kernel/static instances stay the
   *  same), so it keeps cold start from needlessly re-resolving the visible
   *  tree's unchanged kernel queries.
   *
   *  A replace/remove CAN change a composed result, and we can't tell which
   *  callers compose the changed query (composition is only known by
   *  running a resolver — a per-name scheme misses unobserved compositions
   *  and serves pre-swap code), so we re-key everything via the epoch.
   *
   *  Shadowing add: an added bare name `X` whose `core.X` already exists is
   *  NOT additive-safe — it flips what an existing bare `ctx.run('X')`
   *  resolves to (fallback `core.X` → exact `X`; see `runSubquery` /
   *  `dispatchQuery`). The "captured queries are identical" argument is
   *  about object identity, not name→query RESOLUTION, so we count it as
   *  mutating. (Nothing composes bare names today — all `ctx.run` callers
   *  use fully-qualified names — but the guard keeps the invariant sound.)
   *
   *  Corner: a pre-existing query that conditionally composes a NEWLY-ADDED
   *  (non-shadowing) name won't see it on a fresh lookup until a later
   *  replace/remove bump. That's a stable→dynamic dependency (an
   *  anti-pattern) and it fails loud (`QueryNotRegisteredError` against the
   *  captured registry), never silently stale.
   *
   *  Known limitation (separate, init-layer): cold start is only storm-free
   *  when all data-extension plugins are enabled. The bootstrap swap
   *  (`initRepo`, toggle-BLIND) registers every plugin's data queries; the
   *  base swap (`AppRuntimeProvider`, toggle-AWARE) prunes disabled ones —
   *  a REMOVE → bump → the visible tree re-resolves once. Fixing that needs
   *  bootstrap to know the workspace overrides, which it can't yet. */
  private swapQueries(newQueries: Map<string, AnyQuery>): void {
    let mutated = false
    for (const [name, newQ] of newQueries) {
      const old = this.queries.get(name)
      if (old !== undefined) {
        if (old !== newQ) { mutated = true; break } // REPLACE
      } else if (!name.startsWith('core.') && newQueries.has(`core.${name}`)) {
        mutated = true; break // shadowing ADD (see doc above)
      }
      // plain ADD (no shadow) is additive-safe → no bump.
    }
    // A REMOVED name (present before, gone now).
    if (!mutated) {
      for (const oldName of this.queries.keys()) {
        if (!newQueries.has(oldName)) { mutated = true; break }
      }
    }
    this.queries = newQueries
    if (mutated) this.queryEpoch++
  }

  /** Wait until the post-commit processor framework has nothing
   *  pending — useful in tests + scripted scenarios that need
   *  deterministic ordering after a `repo.tx` resolves. Does NOT
   *  advance timers; jobs scheduled with `delayMs` only enter the
   *  pending set when the timer fires. */
  async awaitProcessors(): Promise<void> {
    await this.processorRunner.awaitIdle()
  }

  /** Wait until every reprojection whose deferral timer has already
   *  fired has finished writing. Like `awaitProcessors()`, this does
   *  NOT advance timers — a reprojection only enters the pending set
   *  once its `setTimeout`/`requestIdleCallback` callback runs, so
   *  callers using fake timers must advance the clock first. Loops so
   *  that a reprojection settling while we await an earlier one is
   *  still drained. Reprojection runs never schedule further
   *  reprojections, so this terminates. */
  async awaitReprojections(): Promise<void> {
    await this.reprojectionJobs.drain()
  }

  /** Wait until every workspace backfill whose deferral timer has already
   *  fired has finished. Mirror of `awaitReprojections` — does NOT advance
   *  timers; fake-timer callers must advance the clock first. */
  async awaitWorkspaceBackfills(): Promise<void> {
    await this.workspaceBackfillJobs.drain()
  }

  /** Test-only escape hatch retained for stage-level tests that wire
   *  specific processor sets without a FacetRuntime. */
  __setProcessorsForTesting(processors: ReadonlyArray<AnyPostCommitProcessor>): void {
    this.processors = new Map(processors.map(p => [p.name, p]))
  }

  /** Test-only mirror of `__setProcessorsForTesting` for same-tx
   *  processors. Used by stage-level tests that need to exercise
   *  the in-tx runner without going through the facet runtime. */
  __setSameTxProcessorsForTesting(processors: ReadonlyArray<AnySameTxProcessor>): void {
    this.sameTxProcessors = new Map(processors.map(p => [p.name, p]))
  }

  /** Build the dispatcher closure for a mutator name. Resolution order:
   *    1. literal `name` (kernel full-name like `'core.indent'`,
   *       plugin full-name like `'tasks:setDueDate'`)
   *    2. `'core.${name}'` (so `repo.mutate.indent` resolves to
   *       `'core.indent'` even though the registry key is full-prefixed)
   *  Throws `MutatorNotRegisteredError` if neither matches.
   *  `groupId` (from an `undoGroup` facade) stamps the dispatched tx so
   *  it merges into the group's undo entry. */
  private dispatchMutator(name: string, groupId?: string): (args: unknown) => Promise<unknown> {
    return async (args: unknown) => {
      const m = this.mutators.get(name) ?? this.mutators.get(`core.${name}`)
      if (!m) throw new MutatorNotRegisteredError(name)
      const validated = m.argsSchema.parse(args) as never
      const scope = typeof m.scope === 'function' ? m.scope(validated) : m.scope
      return this.tx(tx => tx.run(m, validated) as Promise<unknown>, {
        scope,
        description: m.describe?.(validated),
        groupId,
      })
    }
  }

  /** Test-only escape hatch retained for stage 1.3 carryover tests
   *  that wired specific mutator sets without a FacetRuntime. New
   *  tests should prefer `setFacetRuntime` (or `installKernelRuntime:
   *  false` plus `setFacetRuntime`). */
  __setMutatorsForTesting(mutators: ReadonlyArray<AnyMutator>): void {
    this.mutators = new Map(mutators.map(m => [m.name, m]))
  }

  /** Build the `QueryCtx` handed to a query's `resolve`.
   *
   *  - `dataSink` takes `depend` + the row deps `hydrateBlocks` declares
   *    (both route through it, so a no-op `dataSink` is how `deps:'none'`
   *    suppresses *data* deps in one move).
   *  - `registry` is the query-registry snapshot this resolve is pinned to.
   *    `ctx.run` resolves composed queries from it — NOT `this.queries` —
   *    so an outer query and every query it composes always come from one
   *    consistent version, and a data-driven re-resolve of an existing
   *    handle re-runs against the SAME version even after a later swap
   *    replaced `this.queries`.
   *
   *  For a top-level query `dataSink` is the handle's `ResolveContext` and
   *  `registry` is the snapshot captured at lookup. */
  private makeQueryCtx(
    dataSink: ResolveContext,
    registry: ReadonlyMap<string, AnyQuery>,
    depth: number,
  ): QueryCtx {
    return {
      db: this.db,
      repo: this,
      hydrateBlocks: (rows, opts) => this.hydrateRows(
        rows as unknown as ReadonlyArray<BlockRow>,
        {ctx: dataSink, declareRowDeps: opts?.declareRowDeps ?? true},
      ),
      depend: (dep) => dataSink.depend(dep),
      run: ((name: string, args: unknown, opts?: {deps?: 'inherit' | 'none'}) =>
        this.runSubquery(
          name, args, dataSink, registry, opts?.deps ?? 'inherit', depth,
        )) as QueryCtx['run'],
    }
  }

  /** Inline resolution for `QueryCtx.run`. Resolves the query by name
   *  (literal, then `core.${name}`) FROM THE PINNED `registry` SNAPSHOT —
   *  not `this.queries` — so an outer query and everything it composes
   *  resolve at one consistent version even if `this.queries` is later
   *  swapped. Validates args, then runs the resolver with a `QueryCtx`
   *  whose *data* deps route to `parentDataSink` (`inherit`) or a no-op
   *  sink (`none`). No handle is created — the sub-query is a reusable
   *  resolver, not its own cache/invalidation unit. Result is parsed
   *  through the callee `resultSchema` so a composed query honors the same
   *  `Query<Args, Result>` contract as a direct dispatch. */
  private async runSubquery(
    name: string,
    args: unknown,
    parentDataSink: ResolveContext,
    registry: ReadonlyMap<string, AnyQuery>,
    deps: 'inherit' | 'none',
    parentDepth: number,
  ): Promise<unknown> {
    const depth = parentDepth + 1
    if (depth > MAX_QUERY_COMPOSITION_DEPTH) {
      throw new Error(
        `QueryCtx.run: composition depth exceeded ${MAX_QUERY_COMPOSITION_DEPTH} ` +
        `resolving '${name}' (likely a query composition cycle)`,
      )
    }
    const q = registry.get(name) ?? registry.get(`core.${name}`)
    if (!q) throw new QueryNotRegisteredError(name)
    const childDataSink: ResolveContext = deps === 'none' ? {depend: () => {}} : parentDataSink
    const validated = q.argsSchema.parse(args) as never
    const raw = await q.resolve(
      validated, this.makeQueryCtx(childDataSink, registry, depth),
    )
    return q.resultSchema.parse(raw)
  }

  /** Build the dispatcher closure for a query name. Same resolution
   *  order as `dispatchMutator`: literal name first, then
   *  `'core.${name}'`. The returned closure validates args via the
   *  query's `argsSchema`, then `getOrCreate`s an identity-stable
   *  `LoaderHandle` keyed by `(queryName, args)`. The loader wraps the
   *  query's `resolve` with a `QueryCtx` that forwards `depend` to the
   *  handle's `ResolveContext` and exposes `db` / `repo` /
   *  `hydrateBlocks`. */
  private dispatchQuery(name: string): (args: unknown) => LoaderHandle<unknown> {
    return (args: unknown) => {
      // Capture the registry snapshot for this handle. The loader (and
      // every `ctx.run` beneath it) resolves against THIS map, so the
      // handle stays pinned to a consistent query-version snapshot even
      // after a later swap replaces `this.queries`. getOrCreate only runs
      // the factory on first create, so an existing handle keeps the
      // registry captured at ITS creation — re-keying via the bumped epoch
      // is what binds the next lookup to a new snapshot.
      const registry = this.queries
      const q = registry.get(name) ?? registry.get(`core.${name}`)
      if (!q) throw new QueryNotRegisteredError(name)
      const validated = q.argsSchema.parse(args) as never
      // Use the registry-stored full name in the key so the bare-name
      // shortcut (`repo.query.subtree`) and the literal full-name access
      // (`repo.query['core.subtree']`) hit the same handle slot.
      const fullName = q.name
      // Folding the global epoch into the key means any registry swap
      // produces a distinct handle slot for the NEXT lookup of every
      // query — old handles keep serving their captured snapshot and GC
      // once subscribers detach; fresh lookups bind to the new registry.
      const key = handleKey(`query:${fullName}@${this.queryEpoch}`, validated)
      return this.handleStore.getOrCreate(key, () => new LoaderHandle({
        store: this.handleStore,
        key,
        loader: async (ctx) => {
          // Time the resolve for `repo.metrics().queries[fullName]`.
          // Counts cold loads + every re-resolve from invalidate; that
          // matches "ms to settle" — the unit a debug panel cares
          // about. argsSchema.parse and resultSchema.parse run inside
          // the timed window because they're part of the dispatch
          // path's wall-clock cost.
          const t0 = performance.now()
          try {
            const raw = await q.resolve(validated, this.makeQueryCtx(ctx, registry, 0))
            // Result-schema parse at the boundary — symmetry with argsSchema
            // and the documented contract (Query.resultSchema is required).
            // For loose kernel schemas (`z.array(z.unknown())`) this is a
            // pass-through; for strict plugin schemas it's the safety net
            // that prevents a malformed resolver from publishing to the
            // handle's subscribers + Suspense throwers.
            return q.resultSchema.parse(raw)
          } finally {
            this.queryMetrics.record(fullName, performance.now() - t0)
          }
        },
      }))
    }
  }

  /** Test-only escape hatch parallel to `__setMutatorsForTesting`.
   *  Bypasses the FacetRuntime so unit tests can register a single
   *  query without standing up a full kernel runtime. Routes through
   *  `swapQueries` so generation bookkeeping stays consistent with
   *  the production `setFacetRuntime` path. */
  __setQueriesForTesting(queries: ReadonlyArray<AnyQuery>): void {
    this.swapQueries(new Map(queries.map(q => [q.name, q])))
  }
}

// Re-import ChangeScope so the file's TypeScript module structure
// includes a use of it (used inside dispatchMutator's scope-resolve
// path indirectly through Mutator.scope; explicit import keeps the
// dependency visible to readers).
void ChangeScope
