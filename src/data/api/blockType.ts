import type { AnyPropertySchema } from './propertySchema'

export interface TypeContribution {
  /** Stable id; matches the string written into `typesProp`. */
  readonly id: string
  /** Property schemas that apply to blocks of this type. */
  readonly properties?: ReadonlyArray<AnyPropertySchema>
  /** Optional human label for type pickers / property sections. */
  readonly label?: string
  /** Optional longer description for tooltips / section headers. */
  readonly description?: string
  /** Never offer this type in the `#` autocomplete (nor as the target
   *  of its "Create type" dedup / a picker's exact-label commit). For
   *  kernel structure (page, panel, …) and plugin plumbing (prefs /
   *  ui-state containers) that would otherwise pollute the dropdown.
   *  Orthogonal to the chip: some plumbing types keep their chip as an
   *  on-block identity hint (panel, user, prefs containers — the
   *  `pluginPrefsExtension` / `pluginUIStateExtension` stamp sets only
   *  this flag), others hide both (see
   *  `INFRASTRUCTURE_TYPE_DISPLAY`). The type stays fully visible and
   *  removable in the property panel. */
  readonly hideFromCompletion?: boolean
  /** Don't render this type's `#label` chip on blocks. Display-only:
   *  the type stays offered in the `#` autocomplete and manageable in
   *  the property panel (e.g. `todo` — the checkbox already conveys
   *  it). User-defined types set this via
   *  `block-type:hide-from-block-display` on their definition block. */
  readonly hideFromBlockDisplay?: boolean
  /** Optional CSS color for this type's tag chip (any value the
   *  browser's `color` property accepts). User-defined types set this
   *  via `block-type:color` on their definition block. */
  readonly color?: string
}

/** Display spread for types the tagging UX should never surface at
 *  all: hidden from the `#` autocomplete AND from block chip display,
 *  still visible in the property panel. For plumbing whose chip has no
 *  on-block value (page — every block row lives on one; auto-managed
 *  state tags like SRS progress). Plumbing whose chip IS informative
 *  on the block itself (panel, user, prefs containers) sets only
 *  `hideFromCompletion`. Spread it (`...INFRASTRUCTURE_TYPE_DISPLAY`)
 *  rather than spelling the flags so a future display surface's flag
 *  gets picked up in one place. */
export const INFRASTRUCTURE_TYPE_DISPLAY = {
  hideFromCompletion: true,
  hideFromBlockDisplay: true,
} as const satisfies Partial<TypeContribution>

export interface TypeRegistrySnapshot {
  readonly types: ReadonlyMap<string, TypeContribution>
  readonly propertySchemas: ReadonlyMap<string, AnyPropertySchema>
}

/** Identity helper for definition-site inference. Registration still
 *  happens through `typesFacet.of(...)`. */
export const defineBlockType = (def: TypeContribution): TypeContribution => def
