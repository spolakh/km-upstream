/** The panel type-picker's Enter/Tab commit decision (pure) — the
 *  label-collision preference and the navigated-highlight override.
 *  The surrounding combobox mechanics (filtering, arrow movement) are
 *  plain list state; the commit resolution is the part with policy. */
import { describe, expect, it } from 'vitest'
import { resolveCommitTarget, type TypeOption } from './TypesPropertyEditor'

const USER_DEFINED: TypeOption = {id: 'uuid-1', label: 'User', hideFromCompletion: false}
const KERNEL_USER: TypeOption = {id: 'user', label: 'User', hideFromCompletion: true}
const MEDIA: TypeOption = {id: 'media', label: 'Media', hideFromCompletion: true}
const TASK: TypeOption = {id: 'uuid-2', label: 'Task', hideFromCompletion: false}

const resolve = (overrides: Partial<Parameters<typeof resolveCommitTarget>[0]>) =>
  resolveCommitTarget({
    options: [],
    filtered: [],
    queryText: '',
    navigated: false,
    activeIndex: 0,
    selectedIds: new Set<string>(),
    ...overrides,
  })

describe('resolveCommitTarget', () => {
  it('on a label collision, the completion-offered type beats the infrastructure one', () => {
    expect(resolve({
      options: [KERNEL_USER, USER_DEFINED],
      filtered: [KERNEL_USER, USER_DEFINED],
      queryText: 'user',
    })).toBe(USER_DEFINED)
  })

  it('a sole infrastructure exact match still commits — the panel picker lists everything', () => {
    expect(resolve({
      options: [MEDIA, TASK],
      filtered: [MEDIA],
      queryText: 'media',
    })).toBe(MEDIA)
  })

  it('an explicit highlight (navigated) beats the exact-match shortcut', () => {
    expect(resolve({
      options: [KERNEL_USER, USER_DEFINED, TASK],
      filtered: [USER_DEFINED, TASK],
      queryText: 'user',
      navigated: true,
      activeIndex: 1,
    })).toBe(TASK)
  })

  it('an exact match already on the block falls through to the highlighted row', () => {
    expect(resolve({
      options: [USER_DEFINED, TASK],
      filtered: [TASK],
      queryText: 'user',
      selectedIds: new Set([USER_DEFINED.id]),
    })).toBe(TASK)
  })

  it('matches by id as well as label, case-insensitively', () => {
    expect(resolve({
      options: [TASK],
      filtered: [],
      // queryText arrives pre-lowercased from the component; the id
      // comparison folds the OPTION's side — mixed-case id exercises it.
      queryText: 'uuid-2',
    })).toBe(TASK)
    expect(resolve({
      options: [{...TASK, id: 'UUID-2'}],
      filtered: [],
      queryText: 'uuid-2',
    })).toMatchObject({id: 'UUID-2'})
  })

  it('no exact match and nothing filtered → nothing to commit', () => {
    expect(resolve({
      options: [TASK],
      filtered: [],
      queryText: 'recipe',
    })).toBeUndefined()
  })
})
