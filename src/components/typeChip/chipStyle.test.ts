/** The chip color ladder: configured color > hashed default >
 *  (unregistered) none. Pure — the component test can't cover this
 *  because jsdom's CSS parser drops `color-mix` inline styles. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineBlockType } from '@/data/api'
import { defaultTypeColor } from '@/data/typeColors'
import { chipStyle } from './chipStyle'

afterEach(() => vi.unstubAllGlobals())

describe('chipStyle', () => {
  it('unregistered type (no contribution) gets NO color — gray is the "not registered" signal', () => {
    expect(chipStyle(undefined)).toBeUndefined()
  })

  it('a registered type without a configured color gets the hashed default, mixed toward the theme foreground', () => {
    // Pin the ladder (hash-of-id base, mixed toward the theme
    // foreground), not the exact mix percentages — those are tuning.
    const style = chipStyle(defineBlockType({id: 'task', label: 'Task'}))
    expect(style?.color).toContain(defaultTypeColor('task'))
    expect(style?.color).toContain('--foreground')
    expect(style?.backgroundColor).toContain('transparent')
  })

  it('a configured color is used verbatim and wins over the default', () => {
    const style = chipStyle(defineBlockType({id: 'task', label: 'Task', color: ' tomato '}))
    expect(style?.color).toBe('tomato')
    expect(style?.backgroundColor).toContain('tomato')
    expect(style?.backgroundColor).toContain('transparent')
  })

  // Node (this test env) has no CSS global, so the guard normally
  // short-circuits to "accept" — stub it to cover both branches.
  it('an unparseable configured color is rejected by the CSS.supports guard → hash-default styling', () => {
    vi.stubGlobal('CSS', {supports: () => false})
    const style = chipStyle(defineBlockType({id: 'task', label: 'Task', color: 'not a color'}))
    expect(style?.color).toContain(defaultTypeColor('task'))
  })

  it('the guard validates the RAW color value, not the color-mix expression around it', () => {
    const supports = vi.fn(() => true)
    vi.stubGlobal('CSS', {supports})
    const style = chipStyle(defineBlockType({id: 'task', label: 'Task', color: ' tomato '}))
    expect(supports).toHaveBeenCalledTimes(1)
    expect(supports).toHaveBeenCalledWith('color', 'tomato')
    expect(style?.color).toBe('tomato')
  })

  it('the default base is a function of the ID, not the label — stable across renames and devices', () => {
    const a = chipStyle(defineBlockType({id: 'x1', label: 'Recipe'}))
    const b = chipStyle(defineBlockType({id: 'x1', label: 'Renamed'}))
    expect(a).toEqual(b)
  })
})
