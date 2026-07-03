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
    // 'panel-stack' FNV-hashes to bucket 0 — chosen so the assertion
    // discriminates: if uncolored types were NOT counted, every bucket
    // would sit at zero and the pick would be palette[0], not [1]. (An
    // id hashing elsewhere makes both behaviors return palette[0] and
    // the test proves nothing.)
    const type = defineBlockType({id: 'panel-stack', label: 'X'})
    expect(defaultTypeColor('panel-stack')).toBe(DEFAULT_TYPE_COLORS[0])
    expect(pickLeastUsedTypeColor([type])).toBe(DEFAULT_TYPE_COLORS[1])
  })

  it('off-palette custom colors, chip-hidden, and plumbing types do not occupy buckets', () => {
    const types = [
      defineBlockType({id: 'a', label: 'A', color: 'tomato'}),
      defineBlockType({id: 'b', label: 'B', color: DEFAULT_TYPE_COLORS[0], hideFromBlockDisplay: true}),
      // Completion-hidden plumbing (panel, prefs containers): chip-
      // visible but too rare on screen to reserve a bucket.
      defineBlockType({id: 'c', label: 'C', color: DEFAULT_TYPE_COLORS[0], hideFromCompletion: true}),
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
