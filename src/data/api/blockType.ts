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
   *  ui-state containers) that would otherwise pollute the dropdown —
   *  such types normally set `hideFromBlockDisplay` too (see
   *  `INFRASTRUCTURE_TYPE_DISPLAY`); `pluginPrefsExtension` /
   *  `pluginUIStateExtension` stamp both automatically. The type stays
   *  fully visible and removable in the property panel. */
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

/** Display spread for infrastructure types — kernel structure (page,
 *  panel, …) and plugin plumbing (prefs / ui-state containers,
 *  auto-managed state tags): hidden from the `#` autocomplete AND from
 *  block chip display, still visible in the property panel. Spread it
 *  (`...INFRASTRUCTURE_TYPE_DISPLAY`) rather than spelling the flags so
 *  a future display surface's flag gets picked up in one place. */
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
