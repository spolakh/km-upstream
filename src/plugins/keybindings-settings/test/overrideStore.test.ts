import { describe, expect, it } from 'vitest'
import { KEYBINDING_OVERRIDE_USER_SOURCE } from '@/shortcuts/keybindingOverrides.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextType,
} from '@/shortcuts/types.js'
import type { StoredKeybindingOverride, StoredKeybindingOverrides } from '../config.ts'
import {
  previewOverrideConflicts,
  toFacetOverride,
  withRemovedOverride,
  withReplacedOverride,
} from '../overrideStore.ts'

const GLOBAL = ActionContextTypes.GLOBAL as ActionContextType

const stored = (
  actionId: string,
  keys: string,
  context: ActionContextType = GLOBAL,
): StoredKeybindingOverride => ({actionId, context, binding: {keys}})

const action = (id: string, keys: string): ActionConfig => ({
  id,
  description: `run ${id}`,
  context: GLOBAL,
  handler: () => undefined,
  defaultBinding: {keys},
})

describe('withReplacedOverride', () => {
  it('appends a new entry keyed by (context, actionId)', () => {
    const next = withReplacedOverride([], stored('a', '$mod+k'))
    expect(next).toEqual([stored('a', '$mod+k')])
  })

  it('replaces the entry for the same (context, actionId), keeping others', () => {
    const start: StoredKeybindingOverrides = [stored('a', '$mod+k'), stored('b', 'g')]
    const next = withReplacedOverride(start, stored('a', '$mod+j'))
    expect(next).toEqual([stored('b', 'g'), stored('a', '$mod+j')])
  })

  it('treats the same action id in a different context as a distinct row', () => {
    const start: StoredKeybindingOverrides = [stored('a', '$mod+k', GLOBAL)]
    const other = stored('a', '$mod+j', 'normal-mode' as ActionContextType)
    expect(withReplacedOverride(start, other)).toEqual([...start, other])
  })
})

describe('withRemovedOverride', () => {
  it('drops the entry for one (context, actionId)', () => {
    const start: StoredKeybindingOverrides = [stored('a', '$mod+k'), stored('b', 'g')]
    expect(withRemovedOverride(start, 'a', GLOBAL)).toEqual([stored('b', 'g')])
  })
})

describe('toFacetOverride', () => {
  it('stamps the user-prefs source onto the facet contribution', () => {
    expect(toFacetOverride(stored('a', '$mod+k'))).toEqual({
      actionId: 'a',
      context: GLOBAL,
      binding: {keys: '$mod+k'},
      source: KEYBINDING_OVERRIDE_USER_SOURCE,
    })
  })
})

describe('previewOverrideConflicts', () => {
  it('reports no conflict when the new chord only collides with a DEFAULT (which loses)', () => {
    // A's default is $mod+k; rebinding B to $mod+k strips A's default in
    // the overlapping global context, so only B claims it — no conflict.
    const base = [action('a', '$mod+k'), action('b', 'g')]
    const conflicts = previewOverrideConflicts(base, [], stored('b', '$mod+k'))
    expect(conflicts).toEqual([])
  })

  it('reports a conflict when the new chord collides with another USER override', () => {
    // A already has a user override on $mod+k; a direct override wins over
    // the strip pass, so binding B to $mod+k leaves both claiming it.
    const base = [action('a', 'x'), action('b', 'g')]
    const conflicts = previewOverrideConflicts(base, [stored('a', '$mod+k')], stored('b', '$mod+k'))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.actions.map(a => a.actionId).sort()).toEqual(['a', 'b'])
  })

  it('only returns conflicts the proposed action participates in', () => {
    // C and D collide with each other but not with the proposed B, so
    // they're filtered out of B's preview.
    const base = [action('b', 'g')]
    const existing: StoredKeybindingOverrides = [stored('c', '$mod+p'), stored('d', '$mod+p')]
    const conflicts = previewOverrideConflicts(base, existing, stored('b', 'g g'))
    expect(conflicts).toEqual([])
  })
})
