/** The chip color ladder: configured color > hashed default >
 *  (unregistered) none. Pure — the component test can't cover this
 *  because jsdom's CSS parser drops `color-mix` inline styles. */
import { describe, expect, it } from 'vitest'
import { defineBlockType } from '@/data/api'
import { defaultTypeColor } from '@/data/typeColors'
import { chipStyle } from '../chipStyle'

describe('chipStyle', () => {
  it('unregistered type (no contribution) gets NO color — gray is the "not registered" signal', () => {
    expect(chipStyle(undefined, 'ghost-type')).toBeUndefined()
  })

  it('a registered type without a configured color gets the hashed default, mixed toward the theme foreground', () => {
    const style = chipStyle(defineBlockType({id: 'task', label: 'Task'}), 'task')
    expect(style?.color).toBe(
      `color-mix(in oklch, ${defaultTypeColor('task')} 72%, hsl(var(--foreground)))`,
    )
    expect(style?.backgroundColor).toContain('transparent')
  })

  it('a configured color is used verbatim and wins over the default', () => {
    const style = chipStyle(
      defineBlockType({id: 'task', label: 'Task', color: ' tomato '}),
      'task',
    )
    expect(style?.color).toBe('tomato')
    expect(style?.backgroundColor).toBe('color-mix(in srgb, tomato 14%, transparent)')
  })

  it('the default base is a function of the ID, not the label — stable across renames and devices', () => {
    const a = chipStyle(defineBlockType({id: 'x1', label: 'Recipe'}), 'x1')
    const b = chipStyle(defineBlockType({id: 'x1', label: 'Renamed'}), 'x1')
    expect(a).toEqual(b)
  })
})
