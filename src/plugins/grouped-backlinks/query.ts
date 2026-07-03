import { z } from 'zod'
import { backlinksFilterSchema, defineQuery, type QueryCtx, type Schema } from '@/data/api'
import {
  buildQualifiedBlockColumnsSql,
  type BlockRow,
} from '@/data/blockSchema'
import { labelForBlockData } from '@/utils/linkTargetAutocomplete.js'
import {
  hasBacklinksFilter,
  normalizeBacklinksFilter,
  type BacklinksFilter,
} from '@/plugins/backlinks/query.js'
import {
  TYPED_BLOCKS_LABEL_CHANNEL,
  TYPED_BLOCKS_PROPERTY_CHANNEL,
  TYPED_BLOCKS_REFS_OF_CHANNEL,
  TYPED_BLOCKS_STRUCTURE_CHANNEL,
  typedBlocksLabelKey,
  typedBlocksPropertyKey,
  typedBlocksRefsOfKey,
  typedBlocksStructureKey,
} from '@/data/invalidation'
import { typesProp } from '@/data/properties.js'
import { typesFacet } from '@/data/facets.js'
import {
  buildGroupedBacklinks,
  type GroupedBacklinkCandidate,
  type GroupedBacklinkGroup,
} from './grouping.ts'
import {
  EMPTY_GROUPED_BACKLINKS_CONFIG,
  GROUP_WITH_PROP_NAME,
  normalizeGroupedBacklinksConfig,
  type GroupedBacklinksConfig,
} from './config.ts'

export const GROUPED_BACKLINKS_FOR_BLOCK_QUERY = 'groupedBacklinks.forBlock'

export interface GroupedBacklinkSourceParents {
  sourceId: string
  parentIds: string[]
}

export interface GroupedBacklinksResult {
  groups: GroupedBacklinkGroup[]
  total: number
  unfilteredSourceIds: string[]
  sourceParents: GroupedBacklinkSourceParents[]
}

type CandidateRow = BlockRow & {
  source_id: string
  context_kind: 'ref' | 'root'
}

interface FieldCandidateRow {
  source_id: string
  source_field: string
}

type AttributeCandidateRow = BlockRow & {
  context_id: string
}

interface TypeCandidateRow {
  context_id: string
  type_name: string
}

const groupedBacklinksSchema: Schema<GroupedBacklinksResult> = {
  parse: (input) => input as GroupedBacklinksResult,
}

const groupedBacklinksConfigSchema = z.object({
  highPriorityTags: z.array(z.string()).optional(),
  lowPriorityTags: z.array(z.string()).optional(),
  excludedTags: z.array(z.string()).optional(),
  excludedPatterns: z.array(z.string()).optional(),
}).optional()

const asBlockRows = (rows: ReadonlyArray<BlockRow>): ReadonlyArray<Record<string, unknown>> =>
  rows as unknown as ReadonlyArray<Record<string, unknown>>

const dependOnSourceContextNode = (
  ctx: QueryCtx,
  workspaceId: string,
  id: string,
): void => {
  ctx.depend({
    kind: 'plugin',
    channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
    key: typedBlocksStructureKey(workspaceId, id),
  })
  ctx.depend({
    kind: 'plugin',
    channel: TYPED_BLOCKS_REFS_OF_CHANNEL,
    key: typedBlocksRefsOfKey(workspaceId, id),
  })
}

const dependOnGroupLabel = (
  ctx: QueryCtx,
  workspaceId: string,
  id: string,
): void => {
  ctx.depend({
    kind: 'plugin',
    channel: TYPED_BLOCKS_LABEL_CHANNEL,
    key: typedBlocksLabelKey(workspaceId, id),
  })
}

const resolveBacklinkSourceIds = async (
  ctx: QueryCtx,
  workspaceId: string,
  id: string,
  filter?: Required<BacklinksFilter>,
): Promise<string[]> =>
  (await ctx.run('core.typedBlockIds', {
    workspaceId,
    referencedBy: {id},
    match: filter?.include,
    exclude: filter?.exclude,
    order: 'created-desc',
  })).filter(sourceId => sourceId !== id)

const resolveSourceParents = async (
  ctx: QueryCtx,
  workspaceId: string,
  sourceIds: readonly string[],
): Promise<GroupedBacklinkSourceParents[]> => {
  if (sourceIds.length === 0) return []

  // core.manyAncestors returns one entry per input id (input order), each
  // with the leaf-to-root chain (depth-asc, excluding self) as hydrated
  // BlockData — the same ordering manyAncestorsSql produced. deps:'none'
  // because the context-node deps are declared explicitly below.
  const entries = await ctx.run('core.manyAncestors', {ids: sourceIds}, {deps: 'none'})
  for (const sourceId of sourceIds) dependOnSourceContextNode(ctx, workspaceId, sourceId)
  for (const entry of entries) {
    for (const ancestor of entry.ancestors) {
      dependOnSourceContextNode(ctx, ancestor.workspaceId, ancestor.id)
    }
  }

  return entries.map(entry => ({
    sourceId: entry.startId,
    parentIds: entry.ancestors.map(ancestor => ancestor.id).reverse(),
  }))
}

/** Source ids ride in a single JSON-array bind parameter and unpack
 *  via `json_each`. One bind regardless of source count — avoids
 *  the SQLite parameter ceiling that would have been hit by a
 *  per-id `VALUES (?)` list on heavily-linked targets. */
const SOURCE_IDS_CTE = `source_ids(id) AS (SELECT value FROM json_each(?))`

/** Hydrate the member (source/backlink) rows by id. Grouping consumes the
 *  members' *references* (via `block_references`) and their parent edges, but
 *  never the members' own rows — `resolveBacklinkSourceIds` returns ids only.
 *  Group-header actions (e.g. daily-notes "spread") gate visibility on each
 *  member's content through the action's `isVisible` (`block.peek()`), so this
 *  primes those rows into the cache. One JSON-array bind (same trick as
 *  `SOURCE_IDS_CTE`) avoids the SQLite parameter ceiling on heavily-linked
 *  targets. */
export const SELECT_GROUPED_BACKLINK_MEMBER_ROWS_SQL = `
  WITH ${SOURCE_IDS_CTE}
  SELECT ${buildQualifiedBlockColumnsSql('b')}
  FROM source_ids s
  JOIN blocks b ON b.id = s.id
  WHERE b.deleted = 0
`

/** Group context = (refs from source + each ancestor) UNION (root
 *  ancestor's own id). Roam-style: "what context is each backlink
 *  in?" — the page it lives on plus any tags/refs anywhere up the
 *  chain. Source ids come pre-filtered from the backlinks wrapper
 *  (which delegates to typed-blocks predicates), so this SQL is now
 *  filter-free and just walks ancestors for the given source set. */
export const SELECT_GROUPED_BACKLINK_CANDIDATES_SQL = `
  WITH RECURSIVE
    ${SOURCE_IDS_CTE},
    ancestor_chain(source_id, anc_id, anc_parent_id, depth, path) AS (
      SELECT s.id, b.id, b.parent_id, 0, '!' || hex(b.id) || '/'
      FROM source_ids s
      JOIN blocks b ON b.id = s.id
      WHERE b.deleted = 0
      UNION ALL
      SELECT
        ancestor_chain.source_id,
        parent.id,
        parent.parent_id,
        ancestor_chain.depth + 1,
        ancestor_chain.path || '!' || hex(parent.id) || '/'
      FROM ancestor_chain
      JOIN blocks parent ON parent.id = ancestor_chain.anc_parent_id
      WHERE parent.deleted = 0
        AND ancestor_chain.depth < 100
        AND INSTR(ancestor_chain.path, '!' || hex(parent.id) || '/') = 0
    ),
    group_context_refs AS (
      SELECT DISTINCT
        ancestor_chain.source_id,
        refs.target_id AS context_id,
        'ref' AS context_kind
      FROM ancestor_chain
      JOIN block_references refs ON refs.source_id = ancestor_chain.anc_id
      WHERE refs.workspace_id = ?
        AND (refs.source_field = '' OR refs.target_id != ?)
      UNION
      SELECT
        ancestor_chain.source_id,
        ancestor_chain.anc_id AS context_id,
        'root' AS context_kind
      FROM ancestor_chain
      WHERE ancestor_chain.anc_parent_id IS NULL
    )
  SELECT DISTINCT
    cr.source_id AS source_id,
    cr.context_kind AS context_kind,
    ${buildQualifiedBlockColumnsSql('group_block')}
  FROM group_context_refs cr
  JOIN blocks group_block ON group_block.id = cr.context_id
  WHERE group_block.deleted = 0
  ORDER BY cr.source_id, coalesce(group_block.user_updated_at, group_block.updated_at) DESC, group_block.id
`

export const SELECT_GROUPED_BACKLINK_FIELD_CANDIDATES_SQL = `
  WITH ${SOURCE_IDS_CTE}
  SELECT DISTINCT
    refs.source_id AS source_id,
    refs.source_field AS source_field
  FROM source_ids s
  JOIN block_references refs ON refs.source_id = s.id
  WHERE refs.workspace_id = ?
    AND refs.target_id = ?
    AND refs.source_field != ''
  ORDER BY refs.source_id, refs.source_field
`

/** Roam-date `addAttributeGroups` equivalent. For each context block C
 *  that the main candidates query surfaced (i.e. a block any backlink
 *  references directly or through an ancestor), pull C's `groupWith`
 *  property values via `block_references.source_field`. The caller
 *  fans these out: every source whose context chain contained C also
 *  gets C's groupWith targets as additional group candidates. The
 *  context block ids ride in via the same JSON-array bind trick as
 *  `SOURCE_IDS_CTE` so we don't hit the SQLite parameter ceiling. */
export const SELECT_GROUPED_BACKLINK_ATTRIBUTE_CANDIDATES_SQL = `
  WITH context_ids(id) AS (SELECT value FROM json_each(?))
  SELECT DISTINCT
    refs.source_id AS context_id,
    ${buildQualifiedBlockColumnsSql('group_block')}
  FROM context_ids c
  JOIN block_references refs ON refs.source_id = c.id
  JOIN blocks group_block ON group_block.id = refs.target_id
  WHERE refs.workspace_id = ?
    AND refs.source_field = ?
    AND refs.target_id != ?
    AND group_block.deleted = 0
  ORDER BY refs.source_id, coalesce(group_block.user_updated_at, group_block.updated_at) DESC, group_block.id
`

/** Type enrichment. For each distinct context block C the main query
 *  surfaced, contribute the type names of (A) C itself and (B) blocks
 *  that C references one hop out. The result is keyed by the original
 *  context_id so the JS side can fan out: every source whose context
 *  chain reached C also picks up the produced type names as group
 *  candidates. UNION dedupes across A and B (e.g. when D is reached
 *  via both paths through different context blocks for the same
 *  source). The context block ids ride in via the same JSON-array
 *  bind trick as `SOURCE_IDS_CTE` so we don't hit the SQLite
 *  parameter ceiling. */
export const SELECT_GROUPED_BACKLINK_TYPE_CANDIDATES_SQL = `
  WITH context_ids(id) AS (SELECT value FROM json_each(?))
  SELECT bt.block_id AS context_id, bt.type AS type_name
    FROM context_ids c
    JOIN block_types bt
      ON bt.block_id = c.id
     AND bt.workspace_id = ?
  UNION
  SELECT refs.source_id AS context_id, bt.type AS type_name
    FROM context_ids c
    JOIN block_references refs
      ON refs.source_id = c.id
     AND refs.workspace_id = ?
    JOIN block_types bt
      ON bt.block_id = refs.target_id
     AND bt.workspace_id = ?
  ORDER BY context_id, type_name
`

export const groupedBacklinksForBlockQuery = defineQuery<
  {
    workspaceId: string
    id: string
    filter?: BacklinksFilter
    groupingConfig?: Partial<GroupedBacklinksConfig>
  },
  GroupedBacklinksResult
>({
  name: GROUPED_BACKLINKS_FOR_BLOCK_QUERY,
  argsSchema: z.object({
    workspaceId: z.string(),
    id: z.string(),
    filter: backlinksFilterSchema.optional(),
    groupingConfig: groupedBacklinksConfigSchema,
  }),
  resultSchema: groupedBacklinksSchema,
  resolve: async ({workspaceId, id, filter, groupingConfig}, ctx) => {
    if (!workspaceId || !id) {
      return {groups: [], total: 0, unfilteredSourceIds: [], sourceParents: []}
    }

    const normalizedFilter = normalizeBacklinksFilter(filter)
    const normalizedGroupingConfig = normalizeGroupedBacklinksConfig(
      groupingConfig ?? EMPTY_GROUPED_BACKLINKS_CONFIG,
    )

    // Target structural dep — mirrors the backlinks wrapper. Re-resolve
    // if the target is deleted/restored without making target content
    // part of the collection query contract.
    ctx.depend({
      kind: 'plugin',
      channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
      key: typedBlocksStructureKey(workspaceId, id),
    })

    // Type-enrichment dep. `types` is a plain string-list property, not a
    // refList, so it doesn't project into `block_references` — the
    // refs-of channel on each context block (registered via
    // `dependOnSourceContextNode` during ancestor resolution) won't see
    // type changes. Subscribe at the property channel for the workspace
    // so any `types` write wakes the handle. Coarser than the per-block
    // refs-of channels but it's the granularity the kernel exposes for
    // non-refList property changes.
    ctx.depend({
      kind: 'plugin',
      channel: TYPED_BLOCKS_PROPERTY_CHANNEL,
      key: typedBlocksPropertyKey(workspaceId, typesProp.name),
    })

    // Inline-resolve the typed-block-id calls so their deps (typed-blocks
    // reference/property/type channels, plus structural deps for filters)
    // register against THIS handle, not the sub-query's handle. A
    // `repo.query[BACKLINKS_FOR_BLOCK_QUERY](...).load()` would
    // execute correctly but leave the grouped handle without the
    // invalidation triggers that wake the backlinks handle.
    const unfilteredSourceIds = await resolveBacklinkSourceIds(ctx, workspaceId, id)
    const sourceIds = hasBacklinksFilter(normalizedFilter)
      ? await resolveBacklinkSourceIds(ctx, workspaceId, id, normalizedFilter)
      : unfilteredSourceIds
    if (sourceIds.length === 0) {
      return {groups: [], total: 0, unfilteredSourceIds, sourceParents: []}
    }

    const sourceParents = await resolveSourceParents(ctx, workspaceId, sourceIds)
    // One JSON-array bind for the source-ids CTE (vs one per id).
    // Avoids the SQLite parameter ceiling on heavily-linked targets.
    const sourceIdsJson = JSON.stringify(sourceIds)

    // Prime member rows (see SELECT_GROUPED_BACKLINK_MEMBER_ROWS_SQL).
    // `declareRowDeps: false` keeps the ids-only projection's invalidation
    // shape: a plain content edit to a member won't re-fire this collection
    // handle (a date-ref add/remove still will — the sources already declare
    // refs-of deps via `dependOnSourceContextNode`).
    const memberRows = await ctx.db.getAll<BlockRow>(
      SELECT_GROUPED_BACKLINK_MEMBER_ROWS_SQL,
      [sourceIdsJson],
    )
    ctx.hydrateBlocks(asBlockRows(memberRows), {declareRowDeps: false})

    const candidateRows = await ctx.db.getAll<CandidateRow>(
      SELECT_GROUPED_BACKLINK_CANDIDATES_SQL,
      [sourceIdsJson, workspaceId, id],
    )
    const fieldCandidateRows = await ctx.db.getAll<FieldCandidateRow>(
      SELECT_GROUPED_BACKLINK_FIELD_CANDIDATES_SQL,
      [sourceIdsJson, workspaceId, id],
    )

    // groupWith expansion (roam-date `addAttributeGroups` parallel). The
    // distinct set of context blocks the main query found becomes the
    // input set: for each, look up `block_references` rows with
    // `source_field='groupWith'` and treat the targets as additional
    // group candidates for every source whose context chain reached
    // that context block. Refs invalidation on each context block is
    // already registered below via `dependOnSourceContextNode`, so a
    // groupWith property write re-fires the handle for free.
    const sourcesByContextId = new Map<string, Set<string>>()
    for (const row of candidateRows) {
      let sources = sourcesByContextId.get(row.id)
      if (!sources) {
        sources = new Set()
        sourcesByContextId.set(row.id, sources)
      }
      sources.add(row.source_id)
    }
    const contextIds = Array.from(sourcesByContextId.keys())
    const contextIdsJson = contextIds.length === 0 ? '[]' : JSON.stringify(contextIds)
    const attributeCandidateRows = contextIds.length === 0
      ? []
      : await ctx.db.getAll<AttributeCandidateRow>(
        SELECT_GROUPED_BACKLINK_ATTRIBUTE_CANDIDATES_SQL,
        [contextIdsJson, workspaceId, GROUP_WITH_PROP_NAME, id],
      )

    // Type enrichment runs against the same context_ids set: types of
    // each context block (Path A) UNION types of blocks each context
    // block references one hop out (Path B). Both paths feed 'type'-kind
    // candidates that participate in the normal default-priority pool.
    const typeCandidateRows = contextIds.length === 0
      ? []
      : await ctx.db.getAll<TypeCandidateRow>(
        SELECT_GROUPED_BACKLINK_TYPE_CANDIDATES_SQL,
        [contextIdsJson, workspaceId, workspaceId, workspaceId],
      )

    // User-defined types store the block-type block's id in `types[]`
    // (not its label string), so a raw `type_name` is a UUID we have
    // to dereference for display. Use the in-memory `typesFacet`
    // registry — it carries both kernel-contributed types and
    // user-defined types materialized at runtime by
    // `UserTypesService`. O(1) Map lookup, no DB roundtrip.
    //
    // A SQL-driven label lookup against `blocks` measured 4 seconds
    // for 4 ids in practice on a real-world DB (the planner couldn't
    // keep the join cheap regardless of whether json_each was on the
    // left or the right). The in-memory path sidesteps that entirely.
    //
    // Eventual consistency: renaming a type block republishes the
    // facet contribution but does not invalidate this query handle,
    // so the panel keeps the previous label until any other dep
    // wakes the resolver. Accepted in exchange for the perf win.
    const typesRegistry = ctx.repo.facetRuntime?.read(typesFacet)
    const typeLabelById = new Map<string, string>()
    if (typesRegistry) {
      for (const contribution of typesRegistry.values()) {
        typeLabelById.set(contribution.id, contribution.label ?? contribution.id)
      }
    }

    const groupRowsById = new Map<string, BlockRow>()
    for (const row of candidateRows) {
      groupRowsById.set(row.id, row)
    }
    for (const row of attributeCandidateRows) {
      if (!groupRowsById.has(row.id)) groupRowsById.set(row.id, row)
    }
    const groupData = ctx.hydrateBlocks(asBlockRows(Array.from(groupRowsById.values())), {declareRowDeps: false})
    for (const group of groupData) dependOnGroupLabel(ctx, group.workspaceId, group.id)
    const labelByGroupId = new Map(groupData.map(data => [data.id, labelForBlockData(data, data.id)]))

    const candidates: GroupedBacklinkCandidate[] = candidateRows.map(row => ({
      sourceId: row.source_id,
      groupId: row.id,
      groupLabel: labelByGroupId.get(row.id) ?? (row.content.trim() || row.id),
      kind: row.context_kind === 'root' ? 'root' : 'ref',
    }))
    for (const row of fieldCandidateRows) {
      candidates.push({
        sourceId: row.source_id,
        groupId: `field:${row.source_field}`,
        groupLabel: row.source_field,
        kind: 'field',
      })
    }
    for (const row of attributeCandidateRows) {
      const sources = sourcesByContextId.get(row.context_id)
      if (!sources) continue
      const groupLabel = labelByGroupId.get(row.id) ?? (row.content.trim() || row.id)
      for (const sourceId of sources) {
        candidates.push({
          sourceId,
          groupId: row.id,
          groupLabel,
          kind: 'attribute',
        })
      }
    }

    // Type candidates: groupId namespaces type names (`type:<name>`) so
    // they never collide with block-id-based groups. Same source can be
    // reached via Path A and Path B for the same type name — dedup per
    // (sourceId, typeName) so we don't double-count members and skew
    // pickLargestGroup. groupId equality alone isn't enough because
    // CandidateGroup uses a Set on sourceIds, but a candidate already
    // ingested would still re-trigger label/priority bookkeeping.
    const emittedTypeCandidates = new Set<string>()
    for (const row of typeCandidateRows) {
      const sources = sourcesByContextId.get(row.context_id)
      if (!sources) continue
      const groupId = `type:${row.type_name}`
      const groupLabel = typeLabelById.get(row.type_name) ?? row.type_name
      for (const sourceId of sources) {
        const key = `${sourceId}\x00${groupId}`
        if (emittedTypeCandidates.has(key)) continue
        emittedTypeCandidates.add(key)
        candidates.push({
          sourceId,
          groupId,
          groupLabel,
          kind: 'type',
        })
      }
    }

    return {
      groups: buildGroupedBacklinks({
        targetId: id,
        sourceOrder: sourceIds,
        candidates,
        groupingConfig: normalizedGroupingConfig,
      }),
      total: sourceIds.length,
      unfilteredSourceIds,
      sourceParents,
    }
  },
})

declare module '@/data/api' {
  interface QueryRegistry {
    [GROUPED_BACKLINKS_FOR_BLOCK_QUERY]: typeof groupedBacklinksForBlockQuery
  }
}
