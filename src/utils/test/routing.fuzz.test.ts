// @vitest-environment node
/**
 * Fuzz suite for the panel-layout hash-route grammar in `src/utils/routing.ts`
 * (grammar comment: routing.ts:1-31). See `src/test/fuzz.ts` for smoke/deep
 * tier mechanics and `docs/fuzzing.md` for conventions. Existing example
 * tests (`routing.test.ts:145-176,292-300`) pin hand-picked cases for the
 * same laws generalized here; this suite doesn't duplicate those, it fuzzes
 * around them.
 *
 * ──── Properties ────
 *
 * 1. Totality (routing.ts:237-251, 294-301): `parseLayout`/`parseAppHash`
 *    never throw on arbitrary strings over the grammar alphabet
 *    (`/ , ( ) ; = %`) plus random unicode/control chars, and the result is
 *    internally consistent (`blockIds === flattenSlots(slots)`,
 *    routing.ts:59-60/249).
 *
 * 2. Fixed point (routing.ts:184-185: "Canonicalize at PARSE time (sorted by
 *    key) so parse(x) is already a fixed point of parse∘build∘parse
 *    regardless of the URL's entry order"): `parse(build(parse(x)))` deep-
 *    equals `parse(x)` for arbitrary hashes, and — the specific law the
 *    comment names — for a fixed set of rest entries in two independently
 *    shuffled URL orders, both parse to the identical (key-sorted) result.
 *
 * 3. Structural round-trip (build routing.ts:279-286, parse routing.ts:
 *    201-251): for a randomly generated bounded-depth (<=3) `LayoutSlot[]`
 *    AST built from the valid `BLOCK_ID_RE` charset (routing.ts:127) and
 *    valid `REST_ENTRY_RE` context entries (routing.ts:134),
 *    `parseLayout(buildLayoutFromSlots(ws, slots)).slots` deep-equals the
 *    AST canonicalized the same way `buildContextSuffix`/
 *    `parseContextEntries` do (falsy `active`/empty `rest`/empty `viewMode`
 *    dropped, `rest` sorted by key).
 *
 * 4. Paren atomicity (routing.ts:19-20 header rule, enforced by
 *    `strict: true` at routing.ts:198-199/206/219-221): a paren group
 *    containing one invalid segment drops the WHOLE group, while sibling
 *    top-level columns survive untouched.
 *
 * 5. `splitTopLevel(s, sep).join(sep) === s` (routing.ts:94-109). This
 *    helper is module-private with exactly four call sites — routing.ts:203
 *    (','), 218 ('/' inside a paren group), 232 (';'), 242 ('/' top level) —
 *    and no exported binding, so there's nothing to import directly and
 *    reimplementing it would just test a copy, not the real code. Instead,
 *    each call site is driven through its real public-API caller with
 *    inputs constructed so the parsed AST names the split pieces 1:1 (no
 *    loss/reorder/dedup) — recovering the *real* function's split decisions
 *    from its actual output, then checking the join law against the exact
 *    string that was fed in.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import {
  parseLayout,
  parseAppHash,
  buildLayoutFromSlots,
  flattenSlots,
  type LayoutSlot,
} from '../routing'

// ──── Shared charset generators ────

// BLOCK_ID_RE = /^[A-Za-z0-9._-]+$/ (routing.ts:127).
const BLOCK_ID_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-'.split('')
const blockIdArb: fc.Arbitrary<string> =
  fc.string({unit: fc.constantFrom(...BLOCK_ID_CHARS), minLength: 1, maxLength: 8})

// Guaranteed to fail BLOCK_ID_RE: '%' is outside the charset, and the regex
// is anchored to the start, so no suffix can rescue it.
const invalidBlockIdArb: fc.Arbitrary<string> =
  fc.string({unit: fc.constantFrom(...BLOCK_ID_CHARS), maxLength: 4}).map(s => `%${s}`)

// CONTEXT_ENTRY_RE key group = /^[a-z][a-z0-9-]*/ (routing.ts:128); 'view'
// and 'active' are reserved (routing.ts:160,168) so excluded from "rest".
const REST_KEY_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')
const restKeyArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.string({unit: fc.constantFrom(...REST_KEY_CHARS), maxLength: 5}),
  )
  .map(([first, rest]) => first + rest)
  .filter(key => key !== 'view' && key !== 'active')

// REST_ENTRY_RE value group = /[A-Za-z0-9%._~-]*/ (routing.ts:134).
const REST_VALUE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789%._~-'.split('')
const restValueArb: fc.Arbitrary<string> =
  fc.string({unit: fc.constantFrom(...REST_VALUE_CHARS), maxLength: 5})

const restEntryArb: fc.Arbitrary<string> = fc
  .tuple(restKeyArb, fc.option(restValueArb, {nil: undefined}))
  .map(([key, value]) => (value === undefined ? key : `${key}=${value}`))

const entryKey = (entry: string): string => entry.split('=')[0]
const sortByKey = (entries: readonly string[]): string[] =>
  [...entries].sort((a, b) => (entryKey(a) < entryKey(b) ? -1 : entryKey(a) > entryKey(b) ? 1 : 0))

// Unique by key: parseContextEntries dedups on first-valid-wins per key
// (routing.ts:147/156/180), so a generator with colliding keys wouldn't
// exercise these properties any differently — dedup keeps the AST/build
// side aligned with what a parse would actually produce.
const uniqueRestEntriesArb: fc.Arbitrary<string[]> =
  fc.uniqueArray(restEntryArb, {selector: entryKey, minLength: 0, maxLength: 4})

// ──── Property 1: totality ────

const soupFragmentArb = fc.oneof(
  fc.constantFrom('#', '/', ',', '(', ')', ';', '=', '%', '?', '&'),
  fc.constantFrom(...BLOCK_ID_CHARS),
  fc.integer({min: 0, max: 0x1f}).map(n => String.fromCharCode(n)), // control chars
  fc.string({unit: 'binary', maxLength: 4}), // arbitrary UTF-16 incl. unpaired surrogates
)
const soupArb: fc.Arbitrary<string> = fc
  .array(soupFragmentArb, {maxLength: 20})
  .map(frags => `#${frags.join('')}`)

describe('totality: parseLayout / parseAppHash never throw on grammar-alphabet + adversarial soup', () => {
  it('parseLayout never throws and blockIds is always flattenSlots(slots)', () => {
    fc.assert(
      fc.property(soupArb, raw => {
        let result: ReturnType<typeof parseLayout> | undefined
        expect(() => {
          result = parseLayout(raw)
        }).not.toThrow()
        expect(Array.isArray(result!.slots)).toBe(true)
        expect(Array.isArray(result!.blockIds)).toBe(true)
        // routing.ts:249: `blockIds: flattenSlots(slots)` — the two must
        // always agree, since the real code derives one from the other.
        expect(result!.blockIds).toEqual(flattenSlots(result!.slots))
      }),
      fuzzParams(200),
    )
  })

  it('parseAppHash never throws', () => {
    fc.assert(
      fc.property(soupArb, raw => {
        expect(() => parseAppHash(raw)).not.toThrow()
      }),
      fuzzParams(200),
    )
  })
})

// ──── Property 2: fixed point ────

describe('fixed point: parse∘build∘parse (routing.ts:184-185)', () => {
  it('holds for arbitrary hash strings', () => {
    fc.assert(
      fc.property(soupArb, raw => {
        const first = parseLayout(raw)
        // wsContext is threaded through like the slots: parse canonicalizes
        // the ws-token entries, build re-emits them, so the composition is a
        // fixed point over the WHOLE route — id, ws-context, and slots.
        const rebuilt = buildLayoutFromSlots(first.workspaceId ?? '', first.slots, first.wsContext)
        const second = parseLayout(rebuilt)
        expect(second).toEqual(first)
      }),
      fuzzParams(200),
    )
  })

  it('rest-entry URL order does not affect the parsed result (routing.ts:184-186 sorts at parse time)', () => {
    const orderedPairArb = uniqueRestEntriesArb.chain(entries =>
      fc.tuple(
        fc.constant(entries),
        fc.shuffledSubarray(entries, {minLength: entries.length, maxLength: entries.length}),
        fc.shuffledSubarray(entries, {minLength: entries.length, maxLength: entries.length}),
      ),
    )

    fc.assert(
      fc.property(blockIdArb, orderedPairArb, (blockId, [, orderA, orderB]) => {
        const hashA = `#ws/${[blockId, ...orderA].join(';')}`
        const hashB = `#ws/${[blockId, ...orderB].join(';')}`
        const parsedA = parseLayout(hashA)
        const parsedB = parseLayout(hashB)

        // Same entries, different URL order -> identical parsed result.
        expect(parsedA).toEqual(parsedB)

        const leaf = parsedA.slots[0]
        if (leaf.kind === 'leaf' && leaf.rest) expect(leaf.rest).toEqual(sortByKey(leaf.rest))

        // And it's a fixed point under build/reparse too.
        const rebuilt = buildLayoutFromSlots('ws', parsedA.slots)
        expect(parseLayout(rebuilt)).toEqual(parsedA)
      }),
      fuzzParams(150),
    )
  })
})

// ──── Property 3: structural round-trip on a bounded-depth AST ────

type Leaf = Extract<LayoutSlot, {kind: 'leaf'}>

const leafArb: fc.Arbitrary<Leaf> = fc.record({
  kind: fc.constant('leaf' as const),
  blockId: blockIdArb,
  viewMode: fc.option(fc.string({minLength: 1, maxLength: 10}), {nil: undefined}),
  active: fc.boolean(),
  rest: uniqueRestEntriesArb,
})

const MAX_DEPTH = 3

// `depth` = remaining allowed paren-nesting levels from this point; a
// sublayout consumes exactly one level for its own columns. Stack cells
// (kind: 'leaf' | 'sublayout' only — routing.ts:47-49/209-213) and columns
// mirror the actual grammar shapes parseColumn/parseSublayout produce.
function genCell(depth: number): fc.Arbitrary<LayoutSlot> {
  return depth > 0
    ? fc.oneof({weight: 2, arbitrary: leafArb}, {weight: 1, arbitrary: genSublayout(depth)})
    : leafArb
}

function genStack(depth: number): fc.Arbitrary<LayoutSlot> {
  return fc
    .array(genCell(depth), {minLength: 2, maxLength: 3})
    .map((children): LayoutSlot => ({kind: 'stack', children}))
}

function genSublayout(depth: number): fc.Arbitrary<LayoutSlot> {
  return fc
    .array(genColumn(depth - 1), {minLength: 1, maxLength: 3})
    .map((columns): LayoutSlot => ({kind: 'sublayout', columns}))
}

function genColumn(depth: number): fc.Arbitrary<LayoutSlot> {
  return depth > 0
    ? fc.oneof(
      {weight: 3, arbitrary: leafArb},
      {weight: 1, arbitrary: genStack(depth)},
      {weight: 1, arbitrary: genSublayout(depth)},
    )
    : leafArb
}

const slotsArb: fc.Arbitrary<LayoutSlot[]> =
  fc.array(genColumn(MAX_DEPTH), {minLength: 0, maxLength: 4})

/** Mirrors buildContextSuffix (routing.ts:260-277) / parseContextEntries
 *  (routing.ts:146-193)'s canonicalization: falsy `active`, empty `rest`,
 *  and empty/absent `viewMode` are all dropped; `rest` is sorted by key. */
const canonicalizeSlot = (slot: LayoutSlot): LayoutSlot => {
  if (slot.kind === 'leaf') {
    const rest = sortByKey(slot.rest ?? [])
    return {
      kind: 'leaf',
      blockId: slot.blockId,
      ...(slot.viewMode ? {viewMode: slot.viewMode} : {}),
      ...(slot.active ? {active: true} : {}),
      ...(rest.length > 0 ? {rest} : {}),
    }
  }
  if (slot.kind === 'stack') return {kind: 'stack', children: slot.children.map(canonicalizeSlot)}
  return {kind: 'sublayout', columns: slot.columns.map(canonicalizeSlot)}
}

describe('structural round-trip: bounded-depth LayoutSlot AST (build routing.ts:279-286, parse routing.ts:201-251)', () => {
  it('buildLayoutFromSlots -> parseLayout recovers the canonicalized input AST', () => {
    fc.assert(
      fc.property(blockIdArb, slotsArb, (ws, slots) => {
        const hash = buildLayoutFromSlots(ws, slots)
        const parsed = parseLayout(hash)
        expect(parsed.workspaceId).toBe(ws)
        expect(parsed.slots).toEqual(slots.map(canonicalizeSlot))
      }),
      fuzzParams(150),
    )
  })
})

// ──── Property 4: paren atomicity ────

describe('paren atomicity: one invalid segment drops the WHOLE group (routing.ts:19-20, 216-223)', () => {
  it('corrupting one leaf inside a paren group drops the group; sibling top-level columns survive untouched', () => {
    fc.assert(
      fc.property(
        blockIdArb,
        leafArb,
        leafArb,
        fc.array(blockIdArb, {minLength: 1, maxLength: 3}),
        fc.nat(),
        invalidBlockIdArb,
        (ws, siblingA, siblingB, sublayoutBlockIds, rawIndex, badId) => {
          const idx = rawIndex % sublayoutBlockIds.length
          const badColumns: LayoutSlot[] = sublayoutBlockIds.map((blockId, i): LayoutSlot => ({
            kind: 'leaf',
            blockId: i === idx ? badId : blockId,
          }))
          const mutatedSlots: LayoutSlot[] = [siblingA, {kind: 'sublayout', columns: badColumns}, siblingB]
          const mutatedHash = buildLayoutFromSlots(ws, mutatedSlots)

          const parsed = parseLayout(mutatedHash)
          // The whole sublayout column is gone; the two valid siblings
          // survive, canonicalized exactly as property 3 predicts.
          expect(parsed.slots).toEqual([siblingA, siblingB].map(canonicalizeSlot))
        },
      ),
      fuzzParams(100),
    )
  })
})

// ──── Property 5: splitTopLevel(s, sep).join(sep) === s, via real callers ────

describe('splitTopLevel join law, driven through its real callers (routing.ts:94-109)', () => {
  it('comma split: parseColumn recovers cells 1:1 (routing.ts:203)', () => {
    fc.assert(
      fc.property(fc.array(blockIdArb, {minLength: 1, maxLength: 5}), pieces => {
        const text = pieces.join(',')
        const parsed = parseLayout(`#ws/${text}`)
        expect(parsed.slots).toHaveLength(1)
        const slot = parsed.slots[0]
        const recovered = slot.kind === 'leaf'
          ? [slot.blockId]
          : (slot as Extract<LayoutSlot, {kind: 'stack'}>).children
            .map(c => (c as Leaf).blockId)
        expect(recovered).toEqual(pieces)
        expect(recovered.join(',')).toBe(text)
      }),
      fuzzParams(100),
    )
  })

  it('top-level slash split: parseLayout recovers workspaceId + column pieces 1:1 (routing.ts:242)', () => {
    fc.assert(
      fc.property(blockIdArb, fc.array(blockIdArb, {minLength: 0, maxLength: 5}), (ws, pieces) => {
        const text = [ws, ...pieces].join('/')
        const parsed = parseLayout(`#${text}`)
        expect(parsed.workspaceId).toBe(ws)
        const recoveredColumns = parsed.slots.map(s => (s as Leaf).blockId)
        expect(recoveredColumns).toEqual(pieces)
        expect([parsed.workspaceId, ...recoveredColumns].join('/')).toBe(text)
      }),
      fuzzParams(100),
    )
  })

  it('paren-inner slash split: parseSublayout recovers columns 1:1 (routing.ts:218)', () => {
    fc.assert(
      fc.property(fc.array(blockIdArb, {minLength: 1, maxLength: 4}), pieces => {
        const inner = pieces.join('/')
        const parsed = parseLayout(`#ws/(${inner})`)
        expect(parsed.slots).toHaveLength(1)
        const slot = parsed.slots[0]
        expect(slot.kind).toBe('sublayout')
        const columns = (slot as Extract<LayoutSlot, {kind: 'sublayout'}>).columns
        const recovered = columns.map(c => (c as Leaf).blockId)
        expect(recovered).toEqual(pieces)
        expect(recovered.join('/')).toBe(inner)
      }),
      fuzzParams(100),
    )
  })

  it('semicolon split: parseSlotCell recovers [blockId, ...rest] 1:1 when already key-sorted (routing.ts:232)', () => {
    const sortedUniqueRestEntriesArb = uniqueRestEntriesArb.map(sortByKey)
    fc.assert(
      fc.property(blockIdArb, sortedUniqueRestEntriesArb, (blockId, entries) => {
        const text = [blockId, ...entries].join(';')
        const parsed = parseLayout(`#ws/${text}`)
        expect(parsed.slots).toHaveLength(1)
        const leaf = parsed.slots[0] as Leaf
        expect(leaf.kind).toBe('leaf')
        const recovered = [leaf.blockId, ...(leaf.rest ?? [])]
        expect(recovered).toEqual([blockId, ...entries])
        expect(recovered.join(';')).toBe(text)
      }),
      fuzzParams(100),
    )
  })
})
