/** User-defined `'block-type'` blocks → the `typesFacet` `'user-data'`
 *  runtime-contribution bucket (user-defined-types Phase 1).
 *
 *  The reactive lifecycle (subscribe / pin / publish / reset+clear on
 *  dispose) lives in the shared `ProjectorRuntime` core, configured by
 *  `userTypesProjector` below. This file keeps only the type-side
 *  specifics: the builder (`tryBuildType`, which resolves
 *  `block-type:properties` refs through the schema projector's handle),
 *  the `contributionsEqual` dedup that breaks the feedback loop with the
 *  propertySchemas rebuild step, and the `getTypeBlockId` lookup.
 *
 *  Deliberately narrow: NO synchronous-append / withProvisional path.
 *  See user-defined-types/design.html §Lessons from PR #50 — callers
 *  that need an in-tx dependent on a freshly-registered type use a
 *  two-tx flow (commit the type-definition block; wait for the
 *  subscription rebuild via `repo.onTypesChange`; then open the
 *  dependent tx). */

import {
  type AnyPropertySchema,
  type PropertySchema,
  type TypeContribution,
} from '@/data/api'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type {
  DefinitionBlockProjector,
  ProjectorHandle,
} from '@/data/projectorRuntime'
import {
  blockTypeColorProp,
  blockTypeDescriptionProp,
  blockTypeHideTagProp,
  blockTypeLabelProp,
  blockTypePropertiesProp,
} from '@/data/properties'
import { BLOCK_TYPE_TYPE } from '@/data/blockTypes'
import { typesFacet } from '@/data/facets'
import { USER_SCHEMAS_PROJECTOR_ID } from '@/data/userSchemasService'

/** Projector id for the user-defined block-type bridge. */
export const USER_TYPES_PROJECTOR_ID = 'user-types'

const USER_DATA_SOURCE_ID = 'user-data'

const safeDisplayProp = <T,>(block: Block, prop: PropertySchema<T>, fallback: T): T => {
  try {
    return block.peekProperty(prop) ?? fallback
  } catch (err) {
    console.warn(`[UserTypesService] block ${block.id}: malformed ${prop.name}; using default`, err)
    return fallback
  }
}

/** Build a TypeContribution from a user-authored block-type block.
 *  Returns null with a logged diagnostic when the label is empty;
 *  silently drops refList entries that don't resolve through the schema
 *  projector's `contributionForBlockId` (those fill in on the next
 *  `onPropertySchemasChange` tick when the missing schema publishes). */
const tryBuildType = (
  block: Block,
  schemas: ProjectorHandle<AnyPropertySchema> | undefined,
): TypeContribution | null => {
  const label = block.peekProperty(blockTypeLabelProp) ?? ''
  if (!label) {
    console.warn(`[UserTypesService] block ${block.id} has empty label; skipping`)
    return null
  }
  const description = block.peekProperty(blockTypeDescriptionProp) ?? ''
  // Display-only props must not gate registration: a malformed value
  // (a raw bridge/import write of e.g. "true" into the boolean) decodes
  // with a CodecError, and letting that skip the row would drop the
  // type from every picker and re-offer "Create type" duplicates.
  // Degrade to the default instead.
  const hideTag = safeDisplayProp(block, blockTypeHideTagProp, false)
  const color = safeDisplayProp(block, blockTypeColorProp, '').trim()
  const refIds = block.peekProperty(blockTypePropertiesProp) ?? []
  const properties: AnyPropertySchema[] = []
  for (const refId of refIds) {
    const schema = schemas?.contributionForBlockId(refId)
    if (schema) properties.push(schema)
  }
  return {
    id: block.id,
    label,
    ...(description ? {description} : {}),
    ...(hideTag ? {hideTag} : {}),
    ...(color ? {color} : {}),
    properties,
  }
}

/** Field-wise equality on the contribution list. Element identity isn't
 *  useful because `tryBuildType` creates fresh objects per rebuild;
 *  compare the load-bearing fields and check the properties array
 *  element-wise (schemas come from the schema projector and ARE reused
 *  across rebuilds, so reference identity is the right check there). */
const contributionsEqual = (
  a: readonly TypeContribution[],
  b: readonly TypeContribution[],
): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ac = a[i]
    const bc = b[i]
    if (ac.id !== bc.id || ac.label !== bc.label || ac.description !== bc.description) return false
    if (ac.hideTag !== bc.hideTag || ac.color !== bc.color) return false
    const ap = ac.properties ?? []
    const bp = bc.properties ?? []
    if (ap.length !== bp.length) return false
    for (let j = 0; j < ap.length; j++) {
      if (ap[j] !== bp[j]) return false
    }
  }
  return true
}

/** Descriptor wiring the type bridge into the shared projector
 *  lifecycle. Hydrates raw rows into `Block` facades so the builder can
 *  decode through `peekProperty`; depends on the schema projector
 *  (started first) to resolve property refs; re-resolves on
 *  `onPropertySchemasChange` when a newly-arriving schema makes a
 *  previously-dropped ref resolvable. `dedup` short-circuits the
 *  feedback loop: the propertySchemas rebuild step fires BOTH
 *  propertySchemas AND types listeners, so an unconditional republish
 *  from our `onPropertySchemasChange` listener would re-trigger it. */
export const userTypesProjector: DefinitionBlockProjector<Block, TypeContribution> = {
  id: USER_TYPES_PROJECTOR_ID,
  metaType: BLOCK_TYPE_TYPE,
  targetFacet: typesFacet,
  sourceId: USER_DATA_SOURCE_ID,
  dependsOn: [USER_SCHEMAS_PROJECTOR_ID],
  keyOf: type => type.id,
  hydrate: (rows, ctx) => rows.map(row => ctx.repo.block(row.id)),
  project: (block, ctx) =>
    tryBuildType(block, ctx.handle(USER_SCHEMAS_PROJECTOR_ID) as ProjectorHandle<AnyPropertySchema> | undefined),
  dedup: contributionsEqual,
  secondarySignal: (repo, rebuild) => repo.onPropertySchemasChange(rebuild),
}

/** Thin facade over the `'user-types'` projector. Holds no state of its
 *  own — the lifecycle + contribution list live in the projector's
 *  `ProjectorHandle`, reached through `repo.projectors`. */
export class UserTypesService {
  constructor(private readonly repo: Repo) {}

  /** Start the type projector for the active workspace. Returns a
   *  disposer; throws on double-start / no active workspace. */
  start(): () => void {
    return this.repo.projectors.startById(USER_TYPES_PROJECTOR_ID)
  }

  dispose(): void {
    this.repo.projectors.disposeProjector(USER_TYPES_PROJECTOR_ID)
  }

  /** Look up the source block id for a published type id. Returns
   *  undefined for kernel/plugin types (no backing block) or ids that
   *  aren't user-data registered. */
  getTypeBlockId(typeId: string): string | undefined {
    return this.repo.projectors.handle<TypeContribution>(USER_TYPES_PROJECTOR_ID)?.blockIdForKey(typeId)
  }
}
