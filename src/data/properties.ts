/**
 * Kernel + UI-state property descriptors. Each export is a
 * `PropertySchema<T>` (data-layer definition with codec + default +
 * change scope). Per-name editor overrides for the rare property that
 * needs one live separately under `propertyEditorOverridesFacet`
 * (Phase 3). See spec §4.1.1 / §5.6 / §6.
 *
 * Migration note (1.6): legacy creator helpers (`stringProperty`,
 * `boolProp`, `objectProperty`, etc.) returned a record-shape
 * `{name, type, value}` that doubled as schema AND value. The new
 * shape is flat — `block.set(schema, value)` / `block.get(schema)`
 * encode/decode through the codec; storage holds the encoded value
 * directly. Helpers like `aliasProp(['x','y'])` (which embedded a
 * default value into the descriptor) are gone — the schema's
 * `defaultValue` is the single source of truth, callers pass values
 * via `block.set(schema, value)`.
 */
import type { Block } from './block'
import type { BlockData, ChangedRow } from '@/data/api'
import {
  ChangeScope,
  codecs,
  defineProperty,
  type PropertySchema,
} from '@/data/api'
import { outlineRenderScopeId } from '@/utils/renderScope'

// ──── UI-state schemas (changeScope: UiState) ────

export const showPropertiesProp = defineProperty<boolean>('system:showProperties', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.UiState,
})

export const isEditingProp = defineProperty<boolean>('isEditing', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.UiState,
})

export const topLevelBlockIdProp = defineProperty<string | undefined>('topLevelBlockId', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
})

export interface FocusedBlockLocation {
  blockId: string
  renderScopeId: string
}

// Focus is persisted as a rendered location. Retired legacy `focusedBlockId`
// keys are ignored so stale state cannot compete with this scoped value.
export const focusedBlockLocationProp = defineProperty<FocusedBlockLocation | undefined>('focusedBlockLocation', {
  codec: codecs.optionalIdentity<FocusedBlockLocation>(),
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
})

export const activePanelIdProp = defineProperty<string | undefined>('activePanelId', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
})

export const scrollTopProp = defineProperty<number | undefined>('scrollTop', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
})

/** Editor-selection state for the active block. Object-typed; the
 *  `unsafeIdentity` codec is appropriate because the shape is engine-
 *  controlled and not exposed for plugin extension. The optional
 *  `line` / `x` / `y` fields are placement hints used by CodeMirror's
 *  cursor-restoration helpers — start/end are the linear offsets,
 *  x/y are pixel coordinates for visual restoration after a wrap. */
export interface EditorSelectionState {
  blockId: string
  start?: number
  end?: number
  line?: 'first' | 'last'
  x?: number
  y?: number
}

export const editorSelection = defineProperty<EditorSelectionState | undefined>('editorSelection', {
  codec: codecs.optionalIdentity<EditorSelectionState>(),
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
})

export const editorFocusRequestProp = defineProperty<number>('editorFocusRequest', {
  codec: codecs.number,
  defaultValue: 0,
  changeScope: ChangeScope.UiState,
})

export interface BlockSelectionState {
  selectedBlockIds: string[]
  anchorBlockId: string | null
}

export const selectionStateProp = defineProperty<BlockSelectionState>('blockSelectionState', {
  codec: codecs.unsafeIdentity<BlockSelectionState>(),
  defaultValue: {selectedBlockIds: [], anchorBlockId: null},
  changeScope: ChangeScope.UiState,
})

// ──── Block-content schemas (changeScope: BlockDefault) ────

export const isCollapsedProp = defineProperty<boolean>('system:collapsed', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

export const typesProp = defineProperty<readonly string[]>('types', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

export const rendererProp = defineProperty<string | undefined>('renderer', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const rendererNameProp = defineProperty<string | undefined>('rendererName', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const createdAtProp = defineProperty<number | undefined>('createdAt', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const sourceBlockIdProp = defineProperty<string | undefined>('sourceBlockId', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

// ──── extension block fields ────

/** Human-readable extension name. Kept on the block instead of inside
 *  executable extension code so disabled extensions can still be
 *  described in settings without compiling them. */
export const extensionNameProp = defineProperty<string>('extension:name', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** Optional extension description displayed in the settings surface. */
export const extensionDescriptionProp = defineProperty<string>('extension:description', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

// ──── property-schema kernel type fields (user-defined-properties §4) ────

/** User-supplied property name on a `'property-schema'` block. */
export const propertyNameProp = defineProperty<string>('property-schema:name', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** Preset id on a `'property-schema'` block — matches a registered
 *  `ValuePreset.id` (and the codec's `type` for codecs built by that
 *  preset). */
export const presetIdProp = defineProperty<string>('property-schema:preset', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** Preset-specific config JSON. Stored as opaque JSON via the
 *  `unsafeIdentity` codec; validation happens in the preset's
 *  `configCodec.decode` at registration time. */
export const presetConfigProp = defineProperty<Record<string, unknown>>('property-schema:config', {
  codec: codecs.unsafeIdentity<Record<string, unknown>>('object'),
  defaultValue: {},
  changeScope: ChangeScope.BlockDefault,
})

// ──── block-type kernel fields (user-defined-types Phase 1) ────

/** Human-readable label on a `'block-type'` block. Shown in the type
 *  picker and as the section header in the property panel. */
export const blockTypeLabelProp = defineProperty<string>('block-type:label', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** Optional free-form description on a `'block-type'` block. */
export const blockTypeDescriptionProp = defineProperty<string>('block-type:description', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** RefList over `'property-schema'` blocks. UserTypesService resolves
 *  each ref to the merged property-schema map (via
 *  `UserSchemasService.getSchemaForBlockId`) to build the lifted
 *  property list on the resulting TypeContribution. */
export const blockTypePropertiesProp = defineProperty<readonly string[]>('block-type:properties', {
  codec: codecs.refList({targetTypes: ['property-schema']}),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

/** Don't render this type's chip on blocks (the supertags `#type`
 *  row). Display-only — the type stays taggable and visible in
 *  pickers/panel. Lifted onto `TypeContribution.hideFromBlockDisplay`. */
export const blockTypeHideFromBlockDisplayProp = defineProperty<boolean>('block-type:hide-from-block-display', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

/** CSS color for this type's tag chip (any `color`-property value:
 *  `#e11d48`, `tomato`, `hsl(…)`, …). Empty = default chip styling.
 *  Lifted onto `TypeContribution.color`. */
export const blockTypeColorProp = defineProperty<string>('block-type:color', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

// ──── user page kernel fields ────

/** Opaque user id (the value stored in `created_by` / `updated_by`) on a
 *  `'user'` user-page block. Gives the page a structured, queryable link
 *  between the id and the display name (the block's content) alongside
 *  the human-friendly alias — so attribution surfaces can resolve either
 *  direction without parsing aliases. */
export const userIdProp = defineProperty<string>('user:id', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** Alias list stored on alias-target / daily-note blocks (§7). The
 *  encoded shape in `properties_json` is `string[]`; the codec is the
 *  list-of-strings combinator.
 *
 *  This is the schema `parseReferences` writes when a tx inserts a
 *  target block (e.g. `[[Inbox]]` produces a target with
 *  `aliases: ['Inbox']`), and the same schema alias-lookup queries
 *  consult to resolve `[[alias]]` to a target id. */
export const aliasesProp: PropertySchema<string[]> = defineProperty<string[]>('alias', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

// ──── Helpers ────

export const getBlockTypes = (data: Pick<BlockData, 'properties'>): readonly string[] => {
  const raw = data.properties[typesProp.name]
  return raw === undefined ? typesProp.defaultValue : typesProp.codec.decode(raw)
}

export const hasBlockType = (
  data: Pick<BlockData, 'properties'>,
  typeId: string,
): boolean => getBlockTypes(data).includes(typeId)

/** Type-membership delta helpers for same-tx processors that watch the
 *  `properties` field. `row.before` is null on insert; `row.after` is
 *  null on hard-delete — both are null-safe here, returning the
 *  appropriate one-sided diff. Order in the returned array matches
 *  `typesProp.codec.decode` order on whichever side is non-null. */
export const addedTypes = (row: ChangedRow): readonly string[] => {
  const before = row.before ? new Set(getBlockTypes(row.before)) : new Set<string>()
  const after = row.after ? getBlockTypes(row.after) : []
  return after.filter(t => !before.has(t))
}

export const removedTypes = (row: ChangedRow): readonly string[] => {
  const before = row.before ? getBlockTypes(row.before) : []
  const after = row.after ? new Set(getBlockTypes(row.after)) : new Set<string>()
  return before.filter(t => !after.has(t))
}

/** Raw membership writer for BlockData construction paths that do not
 *  have a Repo/Tx available. Does not run setup or materialise
 *  addType initial values. */
export const addBlockTypeToProperties = (
  properties: Record<string, unknown>,
  typeId: string,
): Record<string, unknown> => {
  const current = getBlockTypes({properties})
  if (current.includes(typeId)) return properties
  return {
    ...properties,
    [typesProp.name]: typesProp.codec.encode([...current, typeId]),
  }
}

/** Set the editing flag on the UI-state block. Refuses to enter edit
 *  mode in a read-only repo (workspace viewer) — the wrappers also
 *  short-circuit, but this gate keeps any new caller honest. */
export const setIsEditing = (uiStateBlock: Block, editing: boolean): void => {
  if (editing && uiStateBlock.repo.isReadOnly) return
  void uiStateBlock.set(isEditingProp, editing)
}

const decodeFocusedBlockLocation = (raw: unknown): FocusedBlockLocation | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const maybe = raw as Record<string, unknown>
  return typeof maybe.blockId === 'string' && typeof maybe.renderScopeId === 'string'
    ? {blockId: maybe.blockId, renderScopeId: maybe.renderScopeId}
    : undefined
}

export const focusedBlockLocationFromProperties = (
  properties: Record<string, unknown> | undefined,
): FocusedBlockLocation | undefined => {
  if (!properties) return undefined
  return decodeFocusedBlockLocation(properties[focusedBlockLocationProp.name])
}

export const peekFocusedBlockLocation = (uiStateBlock: Block): FocusedBlockLocation | undefined =>
  focusedBlockLocationFromProperties(uiStateBlock.peek()?.properties)

export const isFocusedBlock = (
  uiStateBlock: Block,
  blockId: string,
  renderScopeId?: string,
): boolean => {
  const location = peekFocusedBlockLocation(uiStateBlock)
  if (!location || location.blockId !== blockId) return false
  return renderScopeId ? location.renderScopeId === renderScopeId : true
}

export const sameFocusedBlockLocation = (
  a: FocusedBlockLocation | undefined,
  b: FocusedBlockLocation | undefined,
): boolean =>
  Boolean(a && b && a.blockId === b.blockId && a.renderScopeId === b.renderScopeId)

const isEditingFromProperties = (
  properties: Record<string, unknown> | undefined,
): boolean => {
  const encoded = properties?.[isEditingProp.name]
  return encoded === undefined
    ? isEditingProp.defaultValue
    : isEditingProp.codec.decode(encoded)
}

/** Atomically move focus to `blockId` and set the edit flag in one tx.
 *
 *  Focus is a rendered location, not just a logical block id: the
 *  same block can appear in the outline, backlinks, and any number of
 *  embeds at once. The render scope disambiguates those copies while
 *  keeping selection state separately keyed by block id.
 *
 *  Returns the tx-commit promise so callers that need to observe
 *  focus-derived state next can `await` instead of racing propagation. */
export const focusBlock = async (
  uiStateBlock: Block,
  blockId: string,
  options: {edit?: boolean; renderScopeId?: string} = {},
): Promise<void> => {
  const {edit = false, renderScopeId} = options
  // Match the legacy `setIsEditing` read-only gate: a viewer can't
  // transition into edit mode, but it can still mark focus (highlight,
  // nav anchor).
  const targetEdit = edit && !uiStateBlock.repo.isReadOnly ? true : false
  const currentLocation = peekFocusedBlockLocation(uiStateBlock)
  const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
  const fallbackRenderScopeId = currentLocation?.blockId === blockId
    ? currentLocation.renderScopeId
    : outlineRenderScopeId(topLevelBlockId ?? blockId)
  const location: FocusedBlockLocation = {
    blockId,
    renderScopeId: renderScopeId ?? fallbackRenderScopeId,
  }
  await uiStateBlock.repo.tx(async tx => {
    const current = targetEdit ? null : await tx.get(uiStateBlock.id)
    const preserveCurrentEditMode = !targetEdit &&
      sameFocusedBlockLocation(focusedBlockLocationFromProperties(current?.properties), location) &&
      isEditingFromProperties(current?.properties)

    await tx.setProperty(uiStateBlock.id, focusedBlockLocationProp, location)
    await tx.setProperty(uiStateBlock.id, isEditingProp, preserveCurrentEditMode || targetEdit)
  }, {scope: ChangeScope.UiState, description: 'focus block'})
}

/** Exit edit mode on behalf of `blockId` — but only if that block still
 *  owns edit mode when the tx commits.
 *
 *  `isEditing` is a single flag shared across the UI-state surface, so an
 *  unconditional clear is identity-less: it can't tell *whose* edit mode it
 *  ends. During a block→block tap the tapped block's `focusBlock(edit:true)`
 *  and the outgoing editor's blur-driven exit race. An anonymous clear that
 *  commits *after* the handoff clobbers the flag the new block just set,
 *  dropping edit mode entirely (on a soft keyboard it hides, needing a
 *  second tap) — and it only misfires under that timing, which is why it
 *  doesn't repro on fast/native paths.
 *
 *  Reading the focused location INSIDE the tx (commit-consistent — the same
 *  `tx.get` pattern `focusBlock` uses to preserve edit mode) makes this a
 *  compare-and-swap: whichever of the two txs commits second sees the
 *  other's effect, so both interleavings settle on the tapped block editing.
 *  Unlike a DOM-focus heuristic it's oblivious to *where* focus physically
 *  sits (the iOS soft-keyboard proxy input, the incoming block's shell, …). */
export const exitEditModeForBlock = async (
  uiStateBlock: Block,
  blockId: string,
  renderScopeId?: string,
): Promise<void> => {
  await uiStateBlock.repo.tx(async tx => {
    const location = focusedBlockLocationFromProperties((await tx.get(uiStateBlock.id))?.properties)
    // Another block owns the focused location now (or a different render-scope
    // copy of this block does) → the handoff already moved on; not ours to clear.
    if (location && location.blockId !== blockId) return
    if (location && renderScopeId !== undefined && location.renderScopeId !== renderScopeId) return
    await tx.setProperty(uiStateBlock.id, isEditingProp, false)
  }, {scope: ChangeScope.UiState, description: 'exit edit mode'})
}

export const requestEditorFocus = (uiStateBlock: Block): void => {
  const current = uiStateBlock.peekProperty(editorFocusRequestProp) ?? 0
  void uiStateBlock.set(editorFocusRequestProp, current + 1)
}

// Re-export PropertySchema for callers who want to type-narrow.
export type { PropertySchema }

// ──── Kernel bundle ────

/** Every kernel-owned `PropertySchema` in one array. Consumed by
 *  `kernelDataExtension` to register them with `propertySchemasFacet`
 *  so non-React surfaces (the property panel's schema lookup, future
 *  CLI / server-side audit, plugin authors inspecting the registry)
 *  see the kernel descriptors uniformly.
 *
 *  Heterogeneous `PropertySchema<T>` shapes flatten through
 *  `PropertySchema<unknown>` for storage in the array — the precise
 *  per-schema types stay at the export sites and reach typed callers
 *  via the schema reference (`block.set(typesProp, ...)` etc.). */
export const KERNEL_PROPERTY_SCHEMAS: ReadonlyArray<PropertySchema<unknown>> = [
  // UI-state schemas
  showPropertiesProp,
  isEditingProp,
  topLevelBlockIdProp,
  focusedBlockLocationProp,
  activePanelIdProp,
  scrollTopProp,
  editorSelection,
  editorFocusRequestProp,
  selectionStateProp,
  // BlockDefault schemas
  isCollapsedProp,
  typesProp,
  rendererProp,
  rendererNameProp,
  createdAtProp,
  sourceBlockIdProp,
  aliasesProp,
  // extension block fields
  extensionNameProp,
  extensionDescriptionProp,
  // property-schema fields
  propertyNameProp,
  presetIdProp,
  presetConfigProp,
  // block-type fields
  blockTypeLabelProp,
  blockTypeDescriptionProp,
  blockTypePropertiesProp,
  blockTypeHideFromBlockDisplayProp,
  blockTypeColorProp,
  // user page fields
  userIdProp,
] as ReadonlyArray<PropertySchema<unknown>>
