// URL hash format: #<workspaceId>/<column1>/<column2>/...
//
// hash   := '#' ws ('/' column)*           (+ optional '?query' — see
//           splitHashRouteAndParams / preserveHashQueryParams, unchanged)
// ws     := workspaceId (';' entry)*       matrix-style context on the
//           WORKSPACE token (e.g. `#ws;persp=x/a`). Core assigns no
//           semantics to ANY ws key — `persp` (perspective → layout-session
//           mapping) is interpreted extension-side; every well-formed entry
//           is preserved opaquely in `wsContext`, mirroring the slot
//           `rest[]` pattern (REST_ENTRY_RE well-formedness on both sides,
//           first-valid-wins per key, key-sorted at parse). Unlike slot
//           context there are NO reserved keys here: `view`/`active` have
//           no workspace meaning and ride through as opaque entries too.
//           Splitting these off is also what keeps `workspaceId` CLEAN —
//           previously `#ws;persp=x/...` yielded the garbage id
//           `ws;persp=x`, so a persp-only change read as a workspace
//           change (spurious full remount via layoutWorkspaceChanged).
// column := cell (',' cell)*               a multi-cell column is a vertical
//           stack: `#ws/a/b,c/d` puts b above c in the middle column
// cell   := slot | '(' layout ')'          a parenthesized cell is a nested
//           sub-layout; not implemented yet in the panel rows — parsed and
//           round-tripped so deeper layouts become a data-model change
//           later (inbound URLs degrade them to stacks meanwhile)
// layout := column ('/' column)*           the grammar inside a paren cell
// slot   := blockId (';' entry)*           matrix-style per-slot context:
//           `;view=<value>` (percent-encoded viewMode), `;active` /
//           `;active=true` / `;active=false`, any other well-formed `key`/`key=value`
//           preserved verbatim as an opaque context entry (see REST_ENTRY_RE)
//
// Malformed input follows two rules: OUTSIDE parens, salvage what you can
// (invalid cells/columns are dropped individually, the rest of the layout
// survives); a PAREN GROUP is atomic — any invalid content inside it drops
// the whole group.
//
// Ids are UUIDs (text). An empty hash means "use the user's last-active
// workspace from localStorage, falling back to the first synced workspace".
// A hash with only a workspace id (no `/`) means "restore or create the
// workspace's layout-session panel layout".
//
// Phase 2 dropped support for legacy hashes (`#<blockId>` without a
// workspace id). This rewrite retires the old `(s:a,b)` stack prefix in
// favor of the plain comma grammar above — `(s:` tokens are deliberately
// NOT recognized any more (their inner content fails the blockId charset,
// so a whole `(s:…)` group parses out cleanly).

export interface AppRoute {
  workspaceId?: string
  blockId?: string
}

export interface AppLayoutRoute {
  workspaceId?: string
  /** Opaque matrix entries carried on the WORKSPACE token (`#ws;persp=x/…`),
   *  raw `key[=value]` strings, key-sorted. Present only when non-empty —
   *  like a leaf's `rest`. Core never interprets these; it only guarantees
   *  they parse off cleanly (so `workspaceId` never contains them) and
   *  round-trip through `buildLayoutFromSlots`'s `wsContext` argument. */
  wsContext?: string[]
  slots: LayoutSlot[]
  blockIds: string[]
}

export type LayoutSlot =
  | {kind: 'leaf'; blockId: string; viewMode?: string; active?: boolean; rest?: string[]}
  | {kind: 'stack'; children: LayoutSlot[]}
  // Each sublayout column is represented exactly like a top-level column:
  // a leaf, or a stack when the column has multiple cells.
  | {kind: 'sublayout'; columns: LayoutSlot[]}

type LeafLayoutSlot = Extract<LayoutSlot, {kind: 'leaf'}>

/** All leaf slots in pre-order (stacks and sublayouts flattened). */
export const collectLeafSlots = (slots: readonly LayoutSlot[]): LeafLayoutSlot[] =>
  slots.flatMap(slot => slot.kind === 'leaf'
    ? [slot]
    : collectLeafSlots(slot.kind === 'stack' ? slot.children : slot.columns))

export const flattenSlots = (slots: readonly LayoutSlot[]): string[] =>
  collectLeafSlots(slots).map(leaf => leaf.blockId)

export const splitHashRouteAndParams = (hash: string | undefined | null) => {
  const raw = hash ?? ''
  const trimmed = raw.startsWith('#') ? raw.slice(1) : raw
  const queryIndex = trimmed.indexOf('?')
  return {
    route: queryIndex >= 0 ? trimmed.slice(0, queryIndex) : trimmed,
    params: new URLSearchParams(queryIndex >= 0 ? trimmed.slice(queryIndex + 1) : ''),
  }
}

const buildHashWithParams = (route: string, params: URLSearchParams): string => {
  const query = params.toString()
  if (!route && !query) return ''
  return `#${route}${query ? `?${query}` : ''}`
}

export const preserveHashQueryParams = (
  nextHash: string,
  currentHash: string | undefined | null,
): string => {
  const next = splitHashRouteAndParams(nextHash)
  const current = splitHashRouteAndParams(currentHash)
  const merged = new URLSearchParams(next.params)
  const nextKeys = new Set(merged.keys())

  current.params.forEach((value, key) => {
    if (!nextKeys.has(key)) merged.append(key, value)
  })

  return buildHashWithParams(next.route, merged)
}

const splitTopLevel = (input: string, separator: string): string[] => {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (char === '(') depth++
    if (char === ')') depth = Math.max(0, depth - 1)
    if (char === separator && depth === 0) {
      out.push(input.slice(start, index))
      start = index + 1
    }
  }
  out.push(input.slice(start))
  return out
}

// True only when `token` starts with '(' and that SAME paren's matching ')'
// is the very last character — i.e. the whole token is one balanced group,
// not (e.g.) "(a)/(b)" sitting next to something else.
const isFullyParenWrapped = (token: string): boolean => {
  if (token.length < 2 || token[0] !== '(' || token[token.length - 1] !== ')') return false
  let depth = 0
  for (let index = 0; index < token.length; index++) {
    if (token[index] === '(') depth++
    else if (token[index] === ')') {
      depth--
      if (depth === 0) return index === token.length - 1
    }
  }
  return false
}

const BLOCK_ID_RE = /^[A-Za-z0-9._-]+$/
const CONTEXT_ENTRY_RE = /^([a-z][a-z0-9-]*)(=(.*))?$/

// An unknown (rest) entry must be a well-formed percent-encoded segment on
// BOTH sides: parse only keeps entries matching this, and build re-checks
// programmatically constructed slots — keeping parse and build symmetric so
// no entry can survive a parse only to vanish on the next normalization.
const REST_ENTRY_RE = /^[a-z][a-z0-9-]*(=[A-Za-z0-9%._~-]*)?$/

const byEntryKey = (a: {key: string}, b: {key: string}): number =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0

// Shared rest-entry collection: validate REST_ENTRY_RE, first-VALID-wins
// dedup by key (a Set, so a later malformed entry never evicts an earlier
// valid one and vice versa), key-sort. Used by both parseContextEntries'
// unknown-key handling (below, with 'view'/'active' excluded via `isReserved`
// since those two keys take their own single-value branches) and
// canonicalWsContextEntries (no reserved keys at all — every ws-token entry
// is opaque). Splitting this out of a single per-key branch into an
// independent pass over `segments` is behavior-preserving: 'view'/'active'
// and rest keys are mutually exclusive by construction (a given key string
// is always classified the same way), so the two passes' dedup sets never
// need to interact.
const collectRestEntries = (
  segments: readonly string[],
  isReserved: (key: string) => boolean = () => false,
): string[] => {
  const seen = new Set<string>()
  const entries: {key: string; raw: string}[] = []
  for (const raw of segments) {
    // Malformed entry (extra '=', unsafe value chars): drop without
    // consuming the dedup slot, so a later valid entry for the same key
    // still wins.
    if (!REST_ENTRY_RE.test(raw)) continue
    const key = CONTEXT_ENTRY_RE.exec(raw)![1] // REST_ENTRY_RE-validated, key group always matches
    if (isReserved(key) || seen.has(key)) continue
    seen.add(key)
    entries.push({key, raw})
  }
  // Canonicalize at PARSE time (sorted by key) so parse(x) is already a
  // fixed point of parse∘build∘parse regardless of the URL's entry order.
  entries.sort(byEntryKey)
  return entries.map(entry => entry.raw)
}

const decodeContextValue = (raw: string): string | null => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

type SlotContext = {viewMode?: string; active?: boolean; rest?: string[]}

const isReservedSlotContextKey = (key: string): boolean => key === 'view' || key === 'active'

const parseContextEntries = (segments: readonly string[]): SlotContext => {
  const seen = new Set<string>()
  let viewMode: string | undefined
  let active = false

  for (const raw of segments) {
    const match = CONTEXT_ENTRY_RE.exec(raw)
    if (!match) continue
    const key = match[1]
    if (!isReservedSlotContextKey(key)) continue
    if (seen.has(key)) continue
    const hasValue = match[2] !== undefined
    const value = match[3] ?? ''

    if (key === 'view') {
      if (!hasValue) continue
      const decoded = decodeContextValue(value)
      // local '' ≡ absent fold — see normalizeViewMode (properties.ts);
      // routing stays import-free of the data layer.
      if (!decoded) continue
      viewMode = decoded
      seen.add(key)
    } else {
      if (!hasValue || value === 'true') {
        active = true
        seen.add(key)
      } else if (value === 'false') {
        seen.add(key)
      } // else malformed value: drop, and don't consume the dedup slot
    }
  }

  const rest = collectRestEntries(segments, isReservedSlotContextKey)

  return {
    ...(viewMode !== undefined ? {viewMode} : {}),
    ...(active ? {active: true} : {}),
    ...(rest.length > 0 ? {rest} : {}),
  }
}

// Column parsing carries the header's two malformed-input rules: with
// `strict: false` (outside parens) invalid cells are dropped individually
// and the survivors keep the column alive; with `strict: true` (inside a
// paren group) ANY invalid cell voids the column, and parseSublayout
// propagates that to drop the whole group atomically.
// 0 cells -> no column; 1 -> that slot directly; >=2 -> a stack.
const parseColumn = (text: string, strict: boolean): LayoutSlot | null => {
  const cells: LayoutSlot[] = []
  for (const raw of splitTopLevel(text, ',')) {
    const slot = parseSlotCell(raw)
    if (!slot) {
      if (strict) return null
      continue
    }
    cells.push(slot)
  }
  if (cells.length === 0) return null
  if (cells.length === 1) return cells[0]
  return {kind: 'stack', children: cells}
}

const parseSublayout = (inner: string): LayoutSlot | null => {
  const columns: LayoutSlot[] = []
  for (const text of splitTopLevel(inner, '/')) {
    const column = parseColumn(text, true)
    if (!column) return null
    columns.push(column)
  }
  return {kind: 'sublayout', columns}
}

// Ws-token context entries (see the `ws` grammar rule in the header):
// every key is opaque, so this is collectRestEntries with no reserved keys.
// Shared between parse and build — build re-checks programmatically
// constructed entries against the same rules so parse(x) stays a fixed
// point of parse∘build∘parse for the ws segment too.
const canonicalWsContextEntries = (
  segments: readonly string[],
): string[] | undefined => {
  const entries = collectRestEntries(segments)
  return entries.length > 0 ? entries : undefined
}

const parseSlotCell = (raw: string): LayoutSlot | null => {
  const token = raw.trim()
  if (!token) return null

  if (isFullyParenWrapped(token)) return parseSublayout(token.slice(1, -1))

  const [blockId, ...contextSegments] = splitTopLevel(token, ';')
  if (!blockId || !BLOCK_ID_RE.test(blockId)) return null
  return {kind: 'leaf', blockId, ...parseContextEntries(contextSegments)}
}

export const parseLayout = (hash: string | undefined | null): AppLayoutRoute => {
  if (!hash) return {slots: [], blockIds: []}
  const trimmed = splitHashRouteAndParams(hash).route
  if (!trimmed) return {slots: [], blockIds: []}

  const [workspaceToken, ...columnTokens] = splitTopLevel(trimmed, '/')
  const [workspaceId, ...wsContextSegments] = splitTopLevel(workspaceToken, ';')
  const wsContext = canonicalWsContextEntries(wsContextSegments)
  const slots = columnTokens
    .map(token => parseColumn(token, false))
    .filter((slot): slot is LayoutSlot => Boolean(slot))
  return {
    workspaceId: workspaceId || undefined,
    ...(wsContext !== undefined ? {wsContext} : {}),
    slots,
    blockIds: flattenSlots(slots),
  }
}

export const buildLayout = (workspaceId: string, blockIds: readonly string[] = []): string =>
  blockIds.length > 0 ? `#${workspaceId}/${blockIds.join('/')}` : `#${workspaceId}`

const UNSAFE_ENCODE_RE = /[!'()*]/g
const encodeContextValue = (value: string): string =>
  encodeURIComponent(value).replace(UNSAFE_ENCODE_RE, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

const buildContextSuffix = (slot: SlotContext): string => {
  const entries: {key: string; text: string}[] = []
  if (slot.active) entries.push({key: 'active', text: 'active'})
  // local '' ≡ absent fold — see normalizeViewMode (properties.ts).
  if (slot.viewMode) entries.push({key: 'view', text: `view=${encodeContextValue(slot.viewMode)}`})
  for (const raw of slot.rest ?? []) {
    // Guard programmatically constructed slots: drop malformed entries
    // (REST_ENTRY_RE, same rule as parse) and entries squatting on the
    // reserved keys — viewMode/active own those; a rest duplicate would
    // emit the key twice.
    if (!REST_ENTRY_RE.test(raw)) continue
    const key = CONTEXT_ENTRY_RE.exec(raw)![1]  // REST_ENTRY_RE-validated above, so the key group always matches
    if (key === 'view' || key === 'active') continue
    entries.push({key, text: raw})
  }
  entries.sort(byEntryKey)
  return entries.map(entry => `;${entry.text}`).join('')
}

const buildLayoutSlot = (slot: LayoutSlot): string => {
  if (slot.kind === 'leaf') return `${slot.blockId}${buildContextSuffix(slot)}`
  if (slot.kind === 'stack') return slot.children.map(buildLayoutSlot).join(',')
  return `(${slot.columns.map(buildLayoutSlot).join('/')})`
}

export const buildLayoutFromSlots = (
  workspaceId: string,
  slots: readonly LayoutSlot[] = [],
  /** Opaque ws-token entries to re-emit after the workspace id (see
   *  `AppLayoutRoute.wsContext`). Malformed/duplicate entries are dropped
   *  and the rest key-sorted — the same canonicalization parse applies. */
  wsContext?: readonly string[],
): string => {
  const wsSuffix = (canonicalWsContextEntries(wsContext ?? []) ?? [])
    .map(entry => `;${entry}`)
    .join('')
  const ws = `${workspaceId}${wsSuffix}`
  return slots.length > 0 ? `#${ws}/${slots.map(buildLayoutSlot).join('/')}` : `#${ws}`
}

export const layoutWorkspaceChanged = (
  previousHash: string | undefined | null,
  nextHash: string | undefined | null,
): boolean =>
  parseLayout(previousHash).workspaceId !== parseLayout(nextHash).workspaceId

export const parseAppHash = (hash: string | undefined | null): AppRoute => {
  const {workspaceId, blockIds} = parseLayout(hash)
  if (!workspaceId) return {}
  return {
    workspaceId,
    blockId: blockIds[0],
  }
}

export const buildAppHash = (workspaceId: string, blockId?: string): string =>
  buildLayout(workspaceId, blockId ? [blockId] : [])

/**
 * Promote an app hash (from `buildAppHash` / `buildLayout` /
 * `buildLayoutFromSlots`) to an absolute, shareable URL:
 * `<origin><pathname><hash>`.
 *
 * In-app `<a href>` links can use the bare hash directly — the browser
 * resolves it against the current document. A URL meant to leave the app
 * (copied to the clipboard, shared) has to be absolute, which is what this
 * adds.
 *
 * Uses origin+pathname only, deliberately dropping the current query
 * string and existing hash. The live hash can carry the agent-runtime
 * pairing secret (`#…?agent-runtime-secret=…`, consumed by the agent
 * bridge); replacing the whole hash guarantees it never rides along in a
 * link the user shares. In a non-browser context (SSR/tests) there is no
 * location to resolve against, so the bare hash is returned unchanged.
 */
export const absoluteAppUrl = (hash: string): string =>
  typeof window === 'undefined'
    ? hash
    : `${window.location.origin}${window.location.pathname}${hash}`
