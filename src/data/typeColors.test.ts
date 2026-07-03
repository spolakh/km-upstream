/** The type color palette's two pure entry points: the hash fallback
 *  and the creation-time least-used pick. */
import { describe, expect, it } from 'vitest'
import { defineBlockType } from '@/data/api'
import {
  DEFAULT_TYPE_COLORS,
  defaultTypeColor,
  pickLeastUsedTypeColor,
} from '@/data/typeColors'

describe('defaultTypeColor', () => {
  it('is a stable palette entry per id, and distinct ids can land on distinct entries', () => {
    expect(DEFAULT_TYPE_COLORS).toContain(defaultTypeColor('x1'))
    expect(defaultTypeColor('x1')).toBe(defaultTypeColor('x1'))
    // Pin two known-distinct inputs so a degenerate hash (constant
    // output) can't pass.
    expect(defaultTypeColor('x1')).not.toBe(defaultTypeColor('a-completely-different-id'))
  })
})

describe('pickLeastUsedTypeColor', () => {
  it('empty registry → first palette entry (deterministic tie-break in palette order)', () => {
    expect(pickLeastUsedTypeColor([])).toBe(DEFAULT_TYPE_COLORS[0])
  })

  it('skips occupied buckets: N types configured with the first N palette entries → entry N+1', () => {
    const types = DEFAULT_TYPE_COLORS.slice(0, 3).map((color, i) =>
      defineBlockType({id: `t${i}`, label: `T${i}`, color}))
    expect(pickLeastUsedTypeColor(types)).toBe(DEFAULT_TYPE_COLORS[3])
  })

  it('uncolored types occupy their hash-fallback bucket', () => {
    const type = defineBlockType({id: 'x1', label: 'X'})
    const pick = pickLeastUsedTypeColor([type])
    expect(pick).not.toBe(defaultTypeColor('x1'))
    expect(DEFAULT_TYPE_COLORS).toContain(pick)
  })

  it('off-palette custom colors and chip-hidden types do not occupy buckets', () => {
    const types = [
      defineBlockType({id: 'a', label: 'A', color: 'tomato'}),
      defineBlockType({id: 'b', label: 'B', color: DEFAULT_TYPE_COLORS[0], hideFromBlockDisplay: true}),
    ]
    expect(pickLeastUsedTypeColor(types)).toBe(DEFAULT_TYPE_COLORS[0])
  })

  it('a full wheel wraps to the least-used bucket, not off the palette', () => {
    const once = DEFAULT_TYPE_COLORS.map((color, i) =>
      defineBlockType({id: `a${i}`, label: `A${i}`, color}))
    const skewed = [...once, defineBlockType({id: 'extra', label: 'E', color: DEFAULT_TYPE_COLORS[0]})]
    expect(pickLeastUsedTypeColor(once)).toBe(DEFAULT_TYPE_COLORS[0])
    expect(pickLeastUsedTypeColor(skewed)).toBe(DEFAULT_TYPE_COLORS[1])
  })
})
