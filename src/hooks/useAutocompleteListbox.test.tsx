// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { KeyboardEvent, MouseEvent } from 'react'
import { useAutocompleteListbox, type AutocompleteListboxOptions } from './useAutocompleteListbox.ts'

const key = (k: string) => {
  const event = { key: k, preventDefault: vi.fn() }
  return event as typeof event & KeyboardEvent
}

const setup = (overrides: Partial<AutocompleteListboxOptions> = {}) => {
  const onCommit = overrides.onCommit ?? vi.fn(() => true)
  const setOpen = overrides.setOpen ?? vi.fn()
  const hook = renderHook(
    (props: AutocompleteListboxOptions) => useAutocompleteListbox(props),
    { initialProps: { itemCount: 3, onCommit, setOpen, ...overrides } },
  )
  return { hook, onCommit, setOpen }
}

describe('useAutocompleteListbox', () => {
  it('clamps arrow navigation at the ends by default', () => {
    const { hook, setOpen } = setup({ itemCount: 3 })
    expect(hook.result.current.activeIndex).toBe(0)

    act(() => hook.result.current.onKeyDown(key('ArrowDown')))
    expect(hook.result.current.activeIndex).toBe(1)
    expect(setOpen).toHaveBeenCalledWith(true)

    act(() => hook.result.current.onKeyDown(key('ArrowDown')))
    act(() => hook.result.current.onKeyDown(key('ArrowDown'))) // past the end
    expect(hook.result.current.activeIndex).toBe(2) // clamped, no wrap

    act(() => hook.result.current.onKeyDown(key('ArrowUp')))
    act(() => hook.result.current.onKeyDown(key('ArrowUp')))
    act(() => hook.result.current.onKeyDown(key('ArrowUp'))) // past the start
    expect(hook.result.current.activeIndex).toBe(0) // clamped at 0
  })

  it('wraps arrow navigation around the ends when wrap is set', () => {
    const { hook } = setup({ itemCount: 3, wrap: true })

    act(() => hook.result.current.onKeyDown(key('ArrowUp'))) // wraps to last
    expect(hook.result.current.activeIndex).toBe(2)

    act(() => hook.result.current.onKeyDown(key('ArrowDown'))) // wraps back to first
    expect(hook.result.current.activeIndex).toBe(0)
  })

  it('does not move (or crash) when there are no items', () => {
    const { hook, setOpen } = setup({ itemCount: 0 })
    act(() => hook.result.current.onKeyDown(key('ArrowDown')))
    expect(hook.result.current.activeIndex).toBe(0)
    expect(setOpen).toHaveBeenCalledWith(true) // arrows still reveal the (empty) listbox
  })

  it('commits the active option on Enter and consumes the key only when committed', () => {
    const committed = key('Enter')
    const { hook, onCommit } = setup({ itemCount: 3, onCommit: vi.fn(() => true) })
    act(() => hook.result.current.onKeyDown(key('ArrowDown'))) // active = 1
    act(() => hook.result.current.onKeyDown(committed))
    expect(onCommit).toHaveBeenLastCalledWith(1)
    expect(committed.preventDefault).toHaveBeenCalled()

    const fellThrough = key('Enter')
    const { hook: hook2 } = setup({ itemCount: 3, onCommit: vi.fn(() => false) })
    act(() => hook2.result.current.onKeyDown(fellThrough))
    expect(fellThrough.preventDefault).not.toHaveBeenCalled() // lets the form submit
  })

  it('commits on Tab only when commitOnTab is enabled', () => {
    const noTab = key('Tab')
    const { hook, onCommit } = setup({ itemCount: 3, commitOnTab: false })
    act(() => hook.result.current.onKeyDown(noTab))
    expect(onCommit).not.toHaveBeenCalled()
    expect(noTab.preventDefault).not.toHaveBeenCalled()

    const withTab = key('Tab')
    const onCommit2 = vi.fn(() => true)
    const { hook: hook2 } = setup({ itemCount: 3, commitOnTab: true, onCommit: onCommit2 })
    act(() => hook2.result.current.onKeyDown(withTab))
    expect(onCommit2).toHaveBeenCalledWith(0)
    expect(withTab.preventDefault).toHaveBeenCalled()
  })

  it('wires option props: aria-selected tracks the active index, hover sets it, click commits', () => {
    const onCommit = vi.fn(() => true)
    const { hook } = setup({ itemCount: 3, onCommit, listboxId: 'lb' })

    expect(hook.result.current.getOptionProps(0)['aria-selected']).toBe(true)
    expect(hook.result.current.getOptionProps(1)['aria-selected']).toBe(false)
    expect(hook.result.current.getOptionProps(2).id).toBe('lb-option-2')
    expect(hook.result.current.activeDescendantId).toBe('lb-option-0')

    act(() => hook.result.current.getOptionProps(2).onMouseEnter())
    expect(hook.result.current.activeIndex).toBe(2)
    expect(hook.result.current.activeDescendantId).toBe('lb-option-2')

    const mouseDown = { preventDefault: vi.fn() } as unknown as MouseEvent
    hook.result.current.getOptionProps(1).onMouseDown(mouseDown)
    expect(mouseDown.preventDefault).toHaveBeenCalled() // keeps input focus

    hook.result.current.getOptionProps(1).onClick()
    expect(onCommit).toHaveBeenCalledWith(1)
  })

  it('omits option ids and active-descendant id without a listboxId', () => {
    const { hook } = setup({ itemCount: 2 })
    expect(hook.result.current.getOptionProps(0).id).toBeUndefined()
    expect(hook.result.current.activeDescendantId).toBeUndefined()
  })

  it('drops the active-descendant id when the list shrinks below the active index', () => {
    // `move` clamps, but the list can shrink underneath the index (a
    // concurrent registry change while hovering) — the id must not
    // dangle on a nonexistent option element.
    const onCommit = vi.fn(() => true)
    const setOpen = vi.fn()
    const { hook } = setup({ itemCount: 4, onCommit, setOpen, listboxId: 'lb' })
    act(() => hook.result.current.setActiveIndex(3))
    expect(hook.result.current.activeDescendantId).toBe('lb-option-3')
    hook.rerender({ itemCount: 2, onCommit, setOpen, listboxId: 'lb' })
    expect(hook.result.current.activeDescendantId).toBeUndefined()
  })
})
