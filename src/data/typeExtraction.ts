/** Extract-type-from-prototype primitives.
 *
 *  Three operations user-defined-types Phase 3 composes through:
 *
 *  1. `createTypeBlock(repo, args)` — materialize a fresh
 *     `block-type` block on the workspace's Types page with the
 *     caller's label + property-schema refList, then wait for
 *     `UserTypesService` to publish the contribution into the
 *     `typesFacet` user-data bucket. Returns the new block id, which
 *     IS the type id (the user-defined-types block-id = type-id rule).
 *
 *  2. `retagBlocks(repo, args)` — apply a type to an explicit list of
 *     block ids inside a single tx. Strict per-row existence checks
 *     (skips rows that were deleted or moved between caller's query
 *     and the tx open).
 *
 *  3. `findCandidatesByPropertyShape(repo, args)` — query primitive
 *     for "blocks whose properties bag carries this subset of
 *     property names, optionally constrained to specific values."
 *     Built on top of `repo.queryBlocks` — no new index needed.
 *
 *  The user-facing "Extract type from this block" flow composes these
 *  three: the caller (UI) picks the property subset off the prototype,
 *  calls `createTypeBlock` to materialize a fresh definition, calls
 *  `findCandidatesByPropertyShape` to surface a candidate list, and
 *  finally calls `retagBlocks` with the user-confirmed instance ids.
 *  The orchestration deliberately stays in the UI layer — the
 *  candidate confirmation step is heuristic and the user is the
 *  arbiter, so wrapping the three into a single function would force
 *  every caller through the same confirmation shape. */

import { ChangeScope } from '@/data/api'
import {
  BLOCK_TYPE_TYPE,
  PAGE_TYPE,
  PROPERTY_SCHEMA_TYPE,
} from '@/data/blockTypes'
import {
  blockTypeColorProp,
  blockTypeLabelProp,
  blockTypePropertiesProp,
  hasBlockType,
  propertyNameProp,
} from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createChild } from '@/data/mutators'
import { pickLeastUsedTypeColor } from '@/data/typeColors'
import { typesPageBlockId } from '@/data/typesPage'

// ──── Error classes ─────────────────────────────────────────────────

/** Thrown by `createTypeBlock`'s Phase A→bridge handoff when the
 *  `UserTypesService` subscription doesn't publish the new id into
 *  `typesFacet`'s user-data bucket within `registrationTimeoutMs`.
 *  Realistic cause: `tryBuildType` returned null (the block-type
 *  block failed to parse — e.g. a property-schema ref doesn't
 *  resolve in the live registry). */
export class TypeRegistrationTimeout extends Error {
  constructor(
    public readonly typeBlockId: string,
    public readonly typeLabel: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `createTypeBlock: type-definition block for "${typeLabel}" was committed ` +
      `but did not appear in the runtime registry within ${timeoutMs}ms. ` +
      `Likely cause: UserTypesService.tryBuildType rejected the block ` +
      `(e.g. a referenced property-schema id doesn't resolve in the live ` +
      `registry, or the workspace bucket hasn't reset since the last switch).`,
    )
    this.name = 'TypeRegistrationTimeout'
  }
}

// ──── createTypeBlock ───────────────────────────────────────────────

export interface CreateTypeBlockArgs {
  /** Workspace the new type lives in. Determines parent (the
   *  workspace's Types page) and the registry the new id needs to
   *  appear in before this function resolves. */
  workspaceId: string
  /** Human label stamped onto `block-type:label`. Required non-empty
   *  — `UserTypesService.tryBuildType` silently drops a block with
   *  an empty label, which would surface here as a registration
   *  timeout instead of a clear pre-tx error. */
  label: string
  /** Property-schema block ids the type's panel section surfaces.
   *  Each id must resolve to a live property-schema block in the
   *  same workspace and be published by `UserSchemasService` —
   *  pre-tx validation enforces both invariants, so a stale ref
   *  fails fast instead of producing a half-registered type with
   *  missing slots. */
  propertySchemaIds: readonly string[]
  /** Chip color stamped onto `block-type:color`. Omitted → the
   *  least-used palette entry (`pickLeastUsedTypeColor`), so freshly
   *  created types spread across the color wheel instead of colliding
   *  the way the pure hash fallback does. Pass `''` to create the type
   *  uncolored (it then renders with the hash fallback). */
  color?: string
  /** Caller cancellation signal. Honored before the tx opens, after
   *  pre-tx validation reads, and during the bridge wait. */
  signal?: AbortSignal
  /** Bound on the tx-commit → subscription-publish handoff. Default
   *  10s — long enough to absorb inactive-tab throttling, short
   *  enough that a genuinely rejected block surfaces within an
   *  interactive UI window. */
  registrationTimeoutMs?: number
}

/** Create a fresh `block-type` block on the workspace's Types page.
 *  Returns the new block id (== type id once registered). The
 *  returned id is in the live `repo.types` registry by the time the
 *  promise resolves. */
export async function createTypeBlock(
  repo: Repo,
  args: CreateTypeBlockArgs,
): Promise<string> {
  args.signal?.throwIfAborted()

  const trimmedLabel = args.label.trim()
  if (trimmedLabel === '') {
    throw new Error(
      `createTypeBlock: label must be a non-empty string (got ${JSON.stringify(args.label)}). ` +
      `UserTypesService.tryBuildType silently drops a block-type block with an empty label.`,
    )
  }

  // The Types page must exist in `args.workspaceId` before we can
  // parent the new type block under it. We resolve the id from
  // `args.workspaceId` directly — `repo.typesPageId` is derived from
  // `repo.activeWorkspaceId`, which can differ when callers operate
  // on a workspace other than the user's current one (e.g. an import
  // run, a background task). Mismatched parenting would land the new
  // block under the wrong workspace's Types page and either register
  // in the wrong workspace or leave a partial block after the
  // registration timeout.
  const typesPageId = typesPageBlockId(args.workspaceId)
  const typesPage = await repo.load(typesPageId)
  if (!typesPage || typesPage.workspaceId !== args.workspaceId) {
    throw new Error(
      `createTypeBlock: no Types page for workspace ${args.workspaceId}. ` +
      `Call getOrCreateTypesPage during workspace bootstrap.`,
    )
  }

  // Pre-tx validation: each property-schema ref must survive every
  // invariant tryBuildType applies. Validating upfront surfaces the
  // failure pre-commit instead of as a registration timeout 10s
  // after the partial type is already persisted.
  for (const schemaId of args.propertySchemaIds) {
    const schemaBlock = await repo.load(schemaId)
    if (!schemaBlock) {
      throw new Error(
        `createTypeBlock: property-schema ref ${schemaId} doesn't resolve ` +
        `to a live block. Drop it before retrying.`,
      )
    }
    if (schemaBlock.workspaceId !== args.workspaceId) {
      throw new Error(
        `createTypeBlock: property-schema ref ${schemaId} is in workspace ` +
        `${schemaBlock.workspaceId} but the new type is in ` +
        `${args.workspaceId}. Cross-workspace property-schema refs aren't ` +
        `supported.`,
      )
    }
    if (!hasBlockType(schemaBlock, PROPERTY_SCHEMA_TYPE)) {
      throw new Error(
        `createTypeBlock: ref ${schemaId} is not a property-schema block ` +
        `(missing the ${PROPERTY_SCHEMA_TYPE} type tag).`,
      )
    }
    const rawName = schemaBlock.properties[propertyNameProp.name]
    const name = typeof rawName === 'string' ? rawName : ''
    if (name.trim() === '') {
      throw new Error(
        `createTypeBlock: property-schema block ${schemaId} has empty ` +
        `${propertyNameProp.name}; tryBuildType would silently drop it.`,
      )
    }
    const resolved = repo.userSchemas.getSchemaForBlockId(schemaId)
    if (!resolved) {
      throw new Error(
        `createTypeBlock: property-schema block ${schemaId} ("${name}") ` +
        `isn't published by UserSchemasService — e.g. its preset isn't ` +
        `loaded, its config didn't validate, or the block hasn't synced ` +
        `yet. Fix the schema block before retrying.`,
      )
    }
  }

  args.signal?.throwIfAborted()

  // Materialize the block-type block in a single tx: create the row,
  // add BLOCK_TYPE_TYPE + PAGE_TYPE, stamp label + properties refList
  // + color. The least-used pick reads the LIVE registry (pre-tx), so
  // two devices creating concurrently can still collide — acceptable:
  // the color is persisted data, editable on the definition block.
  const color = args.color ?? pickLeastUsedTypeColor(repo.types.values())
  const typeSnapshot = repo.snapshotTypeRegistries()
  let newId = ''
  await repo.tx(async tx => {
    // In-tx re-check of every schema ref — closes the gap between
    // pre-tx reads and tx-open (a sync-applied delete could land in
    // that window).
    for (const schemaId of args.propertySchemaIds) {
      const row = await tx.get(schemaId)
      if (!row || row.deleted) {
        throw new Error(`createTypeBlock: schema block ${schemaId} no longer exists`)
      }
      if (row.workspaceId !== args.workspaceId) {
        throw new Error(`createTypeBlock: schema block ${schemaId} moved to a different workspace`)
      }
      if (!hasBlockType(row, PROPERTY_SCHEMA_TYPE)) {
        throw new Error(`createTypeBlock: schema block ${schemaId} no longer carries ${PROPERTY_SCHEMA_TYPE}`)
      }
    }

    newId = await tx.run(createChild, {
      parentId: typesPageId,
      content: trimmedLabel,
    })
    await repo.addTypeInTx(tx, newId, BLOCK_TYPE_TYPE, {}, typeSnapshot)
    // PAGE_TYPE so the new type block stays navigable as a page —
    // matches the "type flow" pattern (properties page / readwise root).
    await repo.addTypeInTx(tx, newId, PAGE_TYPE, {}, typeSnapshot)
    await tx.setProperty(newId, blockTypeLabelProp, trimmedLabel)
    await tx.setProperty(newId, blockTypePropertiesProp, args.propertySchemaIds)
    if (color) await tx.setProperty(newId, blockTypeColorProp, color)
  }, {scope: ChangeScope.BlockDefault, description: `createTypeBlock ${trimmedLabel}`})

  await waitForTypeRegistrationBounded(
    repo,
    newId,
    trimmedLabel,
    args.signal,
    args.registrationTimeoutMs ?? 10_000,
  )

  return newId
}

// ──── retagBlocks ───────────────────────────────────────────────────

export interface RetagBlocksArgs {
  /** The type to apply. Must already be registered in `repo.types`. */
  typeId: string
  /** Block ids to tag. Each is re-checked inside the tx — rows that
   *  were deleted or moved between caller's discovery and tx open
   *  are silently skipped (no exception). */
  instanceIds: readonly string[]
  signal?: AbortSignal
}

/** Apply `typeId` to every block in `instanceIds` in a single tx.
 *  Idempotent per row: `addTypeInTx` no-ops when the type is already
 *  present. Throws if `typeId` isn't registered. */
export async function retagBlocks(
  repo: Repo,
  args: RetagBlocksArgs,
): Promise<void> {
  args.signal?.throwIfAborted()

  if (!repo.types.has(args.typeId)) {
    throw new Error(
      `retagBlocks: type ${args.typeId} is not registered. ` +
      `Call createTypeBlock first or verify the type-definition block ` +
      `hasn't been deleted.`,
    )
  }

  if (args.instanceIds.length === 0) return

  await repo.tx(async tx => {
    // Capture the registry snapshot INSIDE the tx body so a sync-
    // applied delete of the type-definition block between the
    // pre-tx check and tx-open can't slip in a stale snapshot.
    const snapshotInTx = repo.snapshotTypeRegistries()
    if (!snapshotInTx.types.has(args.typeId)) {
      throw new Error(
        `retagBlocks: type ${args.typeId} was unregistered between caller ` +
        `check and tx open — likely a sync-applied delete of the ` +
        `type-definition block.`,
      )
    }

    // Pin the type's workspace from the live row so we can reject
    // instance ids that don't belong to the same workspace. Stale
    // callers (the candidate list was built before a sync-applied
    // move) could otherwise tag a cross-workspace block.
    const typeRow = await tx.get(args.typeId)
    if (!typeRow || typeRow.deleted) {
      throw new Error(
        `retagBlocks: type-definition block ${args.typeId} doesn't exist ` +
        `or was deleted inside the tx.`,
      )
    }
    const typeWorkspaceId = typeRow.workspaceId

    for (const instanceId of args.instanceIds) {
      const row = await tx.get(instanceId)
      // Silently skip rows that were deleted, missing, or moved to
      // a different workspace. The candidate list is a snapshot from
      // the caller's discovery step; a stale entry shouldn't fail
      // the whole retag — and tagging across workspaces would break
      // the type-stays-in-its-workspace invariant.
      if (!row || row.deleted) continue
      if (row.workspaceId !== typeWorkspaceId) continue
      await repo.addTypeInTx(tx, instanceId, args.typeId, {}, snapshotInTx)
    }
  }, {scope: ChangeScope.BlockDefault, description: `retagBlocks ${args.typeId}`})
}

// ──── findCandidatesByPropertyShape ─────────────────────────────────

export interface PropertyShapeFilter {
  /** Property name that must be set on the candidate. */
  name: string
  /** Scalar equality filter — the candidate's value at `name` must
   *  equal `value` (compared via the schema's where-encoder). Mutually
   *  exclusive with `targetIds`; use for non-ref properties. */
  value?: unknown
  /** Permissive ref / refList match: the candidate's value at `name`
   *  must reference EVERY id in `targetIds` (i.e. block's refList must
   *  be a superset). Compiled into one `match` predicate per id, each
   *  with `referencedBy: {id, sourceField: name}` — multiple ids ANDed.
   *
   *  Empty array is treated as no filter (presence-only), same as
   *  omitting. Mutually exclusive with `value`. */
  targetIds?: readonly string[]
}

export interface FindCandidatesByPropertyShapeArgs {
  workspaceId: string
  /** Property-name set the candidate must carry. ANDed across the
   *  list — every named property must be set on the candidate. An
   *  empty array returns every block in the workspace (caller should
   *  enforce non-empty if that's not desired). */
  shape: readonly PropertyShapeFilter[]
  /** Block ids to exclude from the candidate set. Typical use: the
   *  prototype block the user is extracting FROM (it's already an
   *  instance-of-itself; surfacing it as a retag candidate is just
   *  noise). */
  exclude?: ReadonlyArray<string>
  /** Optional candidate cap (defense against pathological matches
   *  on broad shapes — "every block that has `createdAt` set"
   *  would otherwise return the entire workspace). Default 1000. */
  limit?: number
}

/** Find blocks whose property bag carries every name in `shape`,
 *  optionally constrained by per-property equality / ref-target
 *  filters. Returns block ids (not full `BlockData`) — callers that
 *  need the rows can load them via `repo.load`.
 *
 *  Filter semantics (per `PropertyShapeFilter`):
 *   - `value === undefined && (!targetIds || targetIds.length === 0)`:
 *     presence-only via `where: {[name]: {exists: true}}`.
 *   - `value` set: scalar equality via `where: {[name]: value}`.
 *   - `targetIds` non-empty: permissive ref / refList match — compiles
 *     to one `match` predicate per id with `referencedBy: {id,
 *     sourceField: name}`. ANDing these means the candidate's ref(List)
 *     at `name` must be a superset of `targetIds` (block can have
 *     additional refs). */
export async function findCandidatesByPropertyShape(
  repo: Repo,
  args: FindCandidatesByPropertyShapeArgs,
): Promise<readonly string[]> {
  if (args.shape.length === 0) return []

  const where: Record<string, unknown> = {}
  const match: { referencedBy: { id: string; sourceField: string } }[] = []
  for (const filter of args.shape) {
    const targetIds = filter.targetIds ?? []
    if (targetIds.length > 0) {
      // One `match` entry per target id; ANDed by the query compiler.
      // Each says "candidate sources a reference to <id> via property
      // <name>" — i.e. <name>'s ref(List) value contains <id>.
      for (const id of targetIds) {
        match.push({referencedBy: {id, sourceField: filter.name}})
      }
      continue
    }
    where[filter.name] = filter.value === undefined
      ? {exists: true}
      : filter.value
  }

  const rows = await repo.queryBlocks({
    workspaceId: args.workspaceId,
    where: Object.keys(where).length === 0 ? undefined : where,
    match: match.length === 0 ? undefined : match,
  })
  const excluded = new Set(args.exclude ?? [])
  const limit = args.limit ?? 1000
  const out: string[] = []
  for (const row of rows) {
    if (excluded.has(row.id)) continue
    out.push(row.id)
    if (out.length >= limit) break
  }
  return out
}

// ──── Internal: bridge wait ─────────────────────────────────────────

async function waitForTypeRegistrationBounded(
  repo: Repo,
  typeId: string,
  typeLabel: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  if (repo.types.has(typeId)) return
  if (signal?.aborted) throw signal.reason

  await new Promise<void>((resolve, reject) => {
    let settled = false
    // Mutable holder so eslint's prefer-const stays quiet — timer is
    // set after an early-return check, so an inline init would force
    // the no-op cancel path through a discarded handle.
    const timerRef: {handle: ReturnType<typeof setTimeout> | null} = {handle: null}
    const dispose = repo.onTypesChange(() => {
      if (repo.types.has(typeId)) settle(resolve)
    })
    const onAbort = () => settle(() => reject(signal!.reason))
    const settle = (cb: () => void) => {
      if (settled) return
      settled = true
      if (timerRef.handle !== null) clearTimeout(timerRef.handle)
      dispose()
      signal?.removeEventListener('abort', onAbort)
      cb()
    }
    // Re-check after attaching the listener — the registration may
    // have landed in the gap between the top-of-function check and
    // the dispose-assignment.
    if (repo.types.has(typeId)) {
      settle(resolve)
      return
    }
    timerRef.handle = setTimeout(
      () => settle(() => reject(new TypeRegistrationTimeout(typeId, typeLabel, timeoutMs))),
      timeoutMs,
    )
    signal?.addEventListener('abort', onAbort)
    if (signal?.aborted) settle(() => reject(signal.reason))
  })
}
