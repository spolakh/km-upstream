// @vitest-environment jsdom
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import type { TypeContribution } from '@/data/api'
import { PAGE_TYPE } from '@/data/blockTypes'
import {
  buildTypeTagCandidates,
  findCompletableTypeByName,
  matchHashTrigger,
  planTriggerRestore,
  planTriggerStrip,
  restoreTriggerToView,
  typeTagCompletionSource,
  visibleTagTypeIds,
  type TypeTagCandidate,
} from '../typeAutocomplete'

describe('matchHashTrigger', () => {
  // Char-generic behavior (whitespace/word-cap/wikilink/… guards) is
  // covered in src/editor/test/triggerMatch.test.ts against the shared
  // matcher; this suite pins only the #-specific wiring.
  it('matches a basic tag query', () => {
    expect(matchHashTrigger('call mom #todo', 14)).toEqual({from: 9, query: 'todo'})
  })

  it('does NOT match a markdown heading (query starts with a space)', () => {
    expect(matchHashTrigger('# Title', 7)).toBeNull()
  })

  it('does NOT match stacked hashes (## heading territory)', () => {
    expect(matchHashTrigger('##task', 6)).toBeNull()
  })

  it('does NOT match with a word char before the # (URL anchors)', () => {
    expect(matchHashTrigger('example.com/page#section', 24)).toBeNull()
  })
})

const registryOf = (...types: TypeContribution[]): ReadonlyMap<string, TypeContribution> =>
  new Map(types.map(t => [t.id, t]))

const existingIds = (out: readonly TypeTagCandidate[]): string[] =>
  out.flatMap(c => c.kind === 'existing' ? [c.id] : [])

const TASK: TypeContribution = {id: 'uuid-task', label: 'Task'}
const TRIP: TypeContribution = {id: 'uuid-trip', label: 'Trip', description: 'A journey'}
const TODO: TypeContribution = {id: 'todo', label: 'Todo'}
const PAGE: TypeContribution = {id: PAGE_TYPE, label: 'Page', hideFromCompletion: true, hideFromBlockDisplay: true}
const PREFS: TypeContribution = {id: 'quick-find-ui-state', label: 'Quick find', hideFromCompletion: true, hideFromBlockDisplay: true}

describe('buildTypeTagCandidates', () => {
  it('lists all visible types for an empty query, without a create sentinel', () => {
    const out = buildTypeTagCandidates({
      registry: registryOf(TASK, TRIP, PAGE),
      currentTypeIds: [],
      query: '',
    })
    expect(existingIds(out)).toEqual(['uuid-task', 'uuid-trip'])
    expect(out.every(c => c.kind === 'existing')).toBe(true)
  })

  it('filters by label and id, case-insensitively', () => {
    const byLabel = buildTypeTagCandidates({
      registry: registryOf(TASK, TRIP),
      currentTypeIds: [],
      query: 'tA',
    })
    expect(existingIds(byLabel)).toEqual(['uuid-task'])

    const byId = buildTypeTagCandidates({
      registry: registryOf(TODO, TRIP),
      currentTypeIds: [],
      query: 'todo',
    })
    expect(byId[0]).toMatchObject({kind: 'existing', id: 'todo'})
  })

  it('excludes types already on the block', () => {
    const out = buildTypeTagCandidates({
      registry: registryOf(TASK, TRIP),
      currentTypeIds: ['uuid-task'],
      query: '',
    })
    expect(existingIds(out)).toEqual(['uuid-trip'])
  })

  it('excludes hideFromCompletion contributions — kernel structure and plugin plumbing alike', () => {
    const out = buildTypeTagCandidates({
      registry: registryOf(PAGE, PREFS, TASK),
      currentTypeIds: [],
      query: '',
    })
    expect(existingIds(out)).toEqual(['uuid-task'])
  })

  it('ranks prefix matches above contains matches', () => {
    const stash: TypeContribution = {id: 'uuid-stash', label: 'Stash'}
    const shopping: TypeContribution = {id: 'uuid-shop', label: 'Shopping'}
    const out = buildTypeTagCandidates({
      registry: registryOf(stash, shopping),
      currentTypeIds: [],
      query: 'sh',
    })
    expect(out.filter(c => c.kind === 'existing').map(c => c.label))
      .toEqual(['Shopping', 'Stash'])
  })

  it('appends a create sentinel for a non-matching query, trimmed', () => {
    const out = buildTypeTagCandidates({
      registry: registryOf(TASK),
      currentTypeIds: [],
      query: 'Recipe ',
    })
    expect(out[out.length - 1]).toMatchObject({kind: 'create', label: 'Recipe'})
  })

  it('offers no create sentinel when the query exactly matches a taggable label — even an already-applied one', () => {
    const applied = buildTypeTagCandidates({
      registry: registryOf(TASK),
      currentTypeIds: ['uuid-task'],
      query: 'task',
    })
    expect(applied).toEqual([])
  })

  it('an exact match on a STRUCTURAL label is not a dead end — create is offered', () => {
    // Without this, `#page` / `#user` would silently show nothing:
    // the hidden-from-completion type never appears as a candidate, and its label
    // suppressing the sentinel would leave zero options.
    const out = buildTypeTagCandidates({
      registry: registryOf(PAGE),
      currentTypeIds: [],
      query: 'page',
    })
    expect(out).toEqual([{kind: 'create', label: 'page', detail: 'Create new type'}])
  })

  it('carries the type description as detail', () => {
    const out = buildTypeTagCandidates({
      registry: registryOf(TRIP),
      currentTypeIds: [],
      query: 'trip',
    })
    expect(out[0].detail).toBe('A journey')
  })
})

describe('visibleTagTypeIds', () => {
  const HIDDEN: TypeContribution = {id: 'uuid-secret', label: 'Secret', hideFromBlockDisplay: true}

  it('drops infrastructure kernel types and hideFromBlockDisplay opt-outs, keeps the rest in order', () => {
    const registry = registryOf(TASK, TRIP, PAGE, HIDDEN)
    expect(visibleTagTypeIds(
      ['uuid-task', PAGE_TYPE, 'uuid-secret', 'uuid-trip'], registry))
      .toEqual(['uuid-task', 'uuid-trip'])
  })

  it('keeps types missing from the registry (label falls back to the id)', () => {
    expect(visibleTagTypeIds(['uuid-unknown'], registryOf())).toEqual(['uuid-unknown'])
  })

  it('hideFromBlockDisplay types stay offerable in the # autocomplete', () => {
    const out = buildTypeTagCandidates({
      registry: registryOf(HIDDEN),
      currentTypeIds: [],
      query: 'sec',
    })
    expect(out[0]).toMatchObject({kind: 'existing', id: 'uuid-secret'})
  })
})

describe('typeTagCompletionSource', () => {
  const contextFor = (doc: string, pos: number, explicit = false): CompletionContext =>
    new CompletionContext(EditorState.create({doc}), pos, explicit)

  const candidate = (): TypeTagCandidate => ({kind: 'existing', id: 'uuid-task', label: 'Task'})

  it('returns null when there is no # trigger at the cursor', async () => {
    const source = typeTagCompletionSource({
      getCandidates: () => [candidate()],
      pickType: async () => {},
    })
    expect(await source(contextFor('plain prose', 11))).toBeNull()
  })

  it('anchors the result at the # and labels the create sentinel', async () => {
    const source = typeTagCompletionSource({
      getCandidates: () => [candidate(), {kind: 'create', label: 'Recipe'}],
      pickType: async () => {},
    })
    const result = await source(contextFor('note #rec', 9))
    expect(result).toMatchObject({from: 5, to: 9, filter: false})
    expect(result!.options.map(o => o.label)).toEqual(['Task', 'Create type "Recipe"'])
  })

  it('returns null for zero candidates unless explicitly invoked', async () => {
    const source = typeTagCompletionSource({
      getCandidates: () => [],
      pickType: async () => {},
    })
    expect(await source(contextFor('#zzz', 4))).toBeNull()
    const explicit = await source(contextFor('#zzz', 4, true))
    expect(explicit).toMatchObject({options: []})
  })

  it('on apply, deletes the trigger text and hands pickType the candidate + doc snapshots', async () => {
    const picked: TypeTagCandidate[] = []
    const contexts: unknown[] = []
    const source = typeTagCompletionSource({
      getCandidates: () => [candidate()],
      pickType: async (c, ctx) => { picked.push(c); contexts.push(ctx) },
    })
    const view = new EditorView({
      state: EditorState.create({doc: 'call mom #ta'}),
      parent: document.body,
    })
    try {
      const result = await source(new CompletionContext(view.state, 12, false))
      const option = result!.options[0]
      const apply = option.apply as (view: EditorView, c: unknown, from: number, to: number) => void
      apply(view, option, result!.from, 12)
      expect(view.state.doc.toString()).toBe('call mom ')
      expect(view.state.selection.main.head).toBe(9)
      expect(picked).toEqual([candidate()])
      // The snapshots are the strip/restore contract — position, not
      // text search (see planTriggerStrip).
      expect(contexts).toEqual([{
        triggerText: '#ta',
        at: 9,
        docBefore: 'call mom #ta',
        docAfter: 'call mom ',
      }])
    } finally {
      view.destroy()
    }
  })

  it('a failed pick restores the deleted trigger text into the view and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const source = typeTagCompletionSource({
        getCandidates: () => [candidate()],
        pickType: async () => { throw new Error('registry says no') },
      })
      const view = new EditorView({
        state: EditorState.create({doc: '#ta'}),
        parent: document.body,
      })
      try {
        const result = await source(new CompletionContext(view.state, 3, false))
        const option = result!.options[0]
        const apply = option.apply as (view: EditorView, c: unknown, from: number, to: number) => void
        apply(view, option, result!.from, 3)
        expect(view.state.doc.toString()).toBe('')
        await vi.waitFor(() => {
          expect(warn).toHaveBeenCalledWith(
            '[supertags] failed to apply type', 'Task', expect.any(Error))
          expect(view.state.doc.toString()).toBe('#ta')
        })
        expect(view.state.selection.main.head).toBe(3)
      } finally {
        view.destroy()
      }
    } finally {
      warn.mockRestore()
    }
  })

  it('falls back to restoreTrigger when the view is unmounted at failure time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const restored: string[] = []
      let failPick: () => void = () => {}
      const source = typeTagCompletionSource({
        getCandidates: () => [candidate()],
        pickType: () => new Promise((_, reject) => {
          failPick = () => reject(new Error('too late'))
        }),
        restoreTrigger: async ({triggerText}) => { restored.push(triggerText) },
      })
      const view = new EditorView({
        state: EditorState.create({doc: '#ta'}),
        parent: document.body,
      })
      const result = await source(new CompletionContext(view.state, 3, false))
      const option = result!.options[0]
      const apply = option.apply as (view: EditorView, c: unknown, from: number, to: number) => void
      apply(view, option, result!.from, 3)
      view.destroy()
      failPick()
      await vi.waitFor(() => {
        expect(restored).toEqual(['#ta'])
      })
    } finally {
      warn.mockRestore()
    }
  })
})

describe('findCompletableTypeByName', () => {
  it('matches label and id case-insensitively, skipping hideFromCompletion types', () => {
    const registry = registryOf(TASK, PAGE)
    expect(findCompletableTypeByName(registry, 'tAsK')).toBe(TASK)
    expect(findCompletableTypeByName(registry, 'uuid-task')).toBe(TASK)
    expect(findCompletableTypeByName(registry, 'Page')).toBeUndefined()
    expect(findCompletableTypeByName(registry, '')).toBeUndefined()
  })
})

describe('restoreTriggerToView', () => {
  it('re-inserts at the original spot, clamped to the live doc', () => {
    const view = new EditorView({
      state: EditorState.create({doc: 'ab'}),
      parent: document.body,
    })
    try {
      expect(restoreTriggerToView(view, 9, '#ta')).toBe(true)
      expect(view.state.doc.toString()).toBe('ab#ta')
    } finally {
      view.destroy()
    }
  })

  it('returns false for an unmounted view', () => {
    const view = new EditorView({state: EditorState.create({doc: 'ab'})})
    view.destroy()
    expect(restoreTriggerToView(view, 0, '#ta')).toBe(false)
  })
})

describe('planTriggerStrip', () => {
  const ctx = {triggerText: '#re', at: 18, docBefore: 'see #recipe notes #re', docAfter: 'see #recipe notes '}

  it('strips exactly the picked span when the stored content matches the pick-time doc', () => {
    expect(planTriggerStrip('see #recipe notes #re', ctx)).toBe('see #recipe notes ')
  })

  it('never strips by text search — drifted content is left alone', () => {
    // The round-2 corruption case: the debounce already persisted the
    // view deletion; an indexOf-based strip would eat the `#re` inside
    // `#recipe`. Strict snapshot equality must refuse instead.
    expect(planTriggerStrip('see #recipe notes ', ctx)).toBeNull()
    // Unflushed keystrokes elsewhere → refuse too.
    expect(planTriggerStrip('see #recipe notes #re!', ctx)).toBeNull()
  })
})

describe('planTriggerRestore', () => {
  const ctx = {triggerText: '#ta', at: 5, docBefore: 'call #ta mom', docAfter: 'call  mom'}

  it('restores the exact pre-pick doc when content matches the post-deletion snapshot', () => {
    expect(planTriggerRestore('call  mom', ctx)).toBe('call #ta mom')
  })

  it('no-ops when the trigger text is demonstrably back at its spot', () => {
    expect(planTriggerRestore('call #ta mom', ctx)).toBeNull()
  })

  it('falls back to a clamped positional insert on drifted content', () => {
    expect(planTriggerRestore('call', ctx)).toBe('call#ta')
    expect(planTriggerRestore('call  mom and dad', ctx)).toBe('call #ta mom and dad')
  })
})
