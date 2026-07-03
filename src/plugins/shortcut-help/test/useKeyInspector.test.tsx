// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ActiveContextsMap } from '@/shortcuts/ActiveContexts.js'
import { registerArmedHold } from '@/shortcuts/holdRegistry.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextConfig,
  type ActionContextType,
  type BaseShortcutDependencies,
} from '@/shortcuts/types.js'
import { buildShortcutHelpModel } from '../model.ts'
import { useKeyInspector } from '../useKeyInspector.ts'

const globalConfig: ActionContextConfig = {
  type: ActionContextTypes.GLOBAL,
  displayName: 'Global',
  validateDependencies: (deps: unknown): deps is BaseShortcutDependencies => deps !== undefined,
}

const action = (id: string, keys: string | string[]): ActionConfig => ({
  id,
  description: `run ${id}`,
  context: ActionContextTypes.GLOBAL as ActionContextType,
  handler: () => undefined,
  defaultBinding: {keys},
})

const active: ActiveContextsMap = new Map([
  [ActionContextTypes.GLOBAL, {uiStateBlock: {} as never}],
])

const model = buildShortcutHelpModel(
  [action('palette', '$mod+k'), action('top', 'g g')],
  {active, contextConfigsByType: new Map([[globalConfig.type, globalConfig]])},
)

const press = (init: KeyboardEventInit): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init})
  window.dispatchEvent(event)
  return event
}

const release = (init: KeyboardEventInit): KeyboardEvent => {
  const event = new KeyboardEvent('keyup', {bubbles: true, cancelable: true, ...init})
  window.dispatchEvent(event)
  return event
}

const pressedDisplays = (state: {pressed: readonly {display: string}[]}) =>
  state.pressed.map(p => p.display)

describe('useKeyInspector', () => {
  it('swallows captured keydowns before window bubble listeners (the coordinator path)', () => {
    const bubbleListener = vi.fn()
    window.addEventListener('keydown', bubbleListener)
    const {unmount} = renderHook(() => useKeyInspector(true, model.bindings, vi.fn()))

    let event!: KeyboardEvent
    act(() => {
      event = press({key: 'k', ctrlKey: true})
    })
    expect(bubbleListener).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)

    unmount()
    act(() => {
      press({key: 'k', ctrlKey: true})
    })
    expect(bubbleListener).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', bubbleListener)
  })

  it('swallows keyups only for keys pressed while open', () => {
    const bubbleKeyup = vi.fn()
    window.addEventListener('keyup', bubbleKeyup)
    renderHook(() => useKeyInspector(true, model.bindings, vi.fn()))

    // A release of a key held from BEFORE opening (no keydown seen while
    // open — only OS repeats, which don't count) must propagate, so
    // keyup-phase commits / hold cancels still terminate.
    act(() => {
      press({key: 's', code: 'KeyS', repeat: true})
      release({key: 's', code: 'KeyS'})
    })
    expect(bubbleKeyup).toHaveBeenCalledTimes(1)

    // A key pressed while open has its release swallowed — keyup-phase
    // bindings must not fire off inspected presses.
    act(() => {
      press({key: 'g', code: 'KeyG'})
      release({key: 'g', code: 'KeyG'})
    })
    expect(bubbleKeyup).toHaveBeenCalledTimes(1)
    window.removeEventListener('keyup', bubbleKeyup)
  })

  it('cancels armed hold timers when opening', () => {
    const cancel = vi.fn()
    const unregister = registerArmedHold(cancel)
    renderHook(() => useKeyInspector(true, model.bindings, vi.fn()))
    expect(cancel).toHaveBeenCalledTimes(1)
    unregister()
  })

  it('resolves an exact chord to its matches', () => {
    const {result} = renderHook(() => useKeyInspector(true, model.bindings, vi.fn()))
    act(() => {
      // jsdom's platform has no Mac marker, so Ctrl is the $mod primary here.
      press({key: 'k', ctrlKey: true})
    })
    expect(result.current.state.matches?.map(b => b.action.id)).toEqual(['palette'])
    expect(result.current.state.pendingMatches).toBeNull()
    expect(result.current.state.pressed).toEqual([])
  })

  it('keeps a sequence prefix pending, then completes it', () => {
    const {result} = renderHook(() => useKeyInspector(true, model.bindings, vi.fn()))
    act(() => {
      press({key: 'g'})
    })
    expect(pressedDisplays(result.current.state)).toEqual(['g'])
    expect(result.current.state.pendingMatches?.map(b => b.action.id)).toEqual(['top'])
    expect(result.current.state.matches).toBeNull()

    act(() => {
      press({key: 'g'})
    })
    expect(result.current.state.matches?.map(b => b.action.id)).toEqual(['top'])
    expect(result.current.state.pressed).toEqual([])
    expect(result.current.state.pendingMatches).toBeNull()
  })

  it('retries the newest press alone when it breaks a pending sequence', () => {
    // The dispatcher keeps per-binding matcher state: `g` then Ctrl+K fires
    // the palette binding even though it breaks the `g g` sequence. The
    // inspector's shared buffer must fall back the same way instead of
    // flashing "nothing bound".
    const {result} = renderHook(() => useKeyInspector(true, model.bindings, vi.fn()))
    act(() => {
      press({key: 'g'})
    })
    expect(result.current.state.pendingMatches?.map(b => b.action.id)).toEqual(['top'])

    act(() => {
      press({key: 'k', ctrlKey: true})
    })
    expect(result.current.state.matches?.map(b => b.action.id)).toEqual(['palette'])
    expect(result.current.state.unmatched).toBeNull()
    expect(result.current.state.pressed).toEqual([])
  })

  it('flags an unbound chord and clears the buffer', () => {
    const {result} = renderHook(() => useKeyInspector(true, model.bindings, vi.fn()))
    act(() => {
      press({key: 'q'})
    })
    expect(result.current.state.unmatched).toEqual(['q'])
    expect(result.current.state.pressed).toEqual([])
  })

  it('resets inspector state when the binding set is rebuilt', () => {
    const {result, rerender} = renderHook(
      ({bindings}) => useKeyInspector(true, bindings, vi.fn()),
      {initialProps: {bindings: model.bindings}},
    )
    act(() => {
      press({key: 'g'})
    })
    expect(result.current.state.pendingMatches).not.toBeNull()

    // A rebuilt model hands over NEW binding objects; stale pending matches
    // would filter the new groups to nothing, so the state must reset.
    const rebuilt = buildShortcutHelpModel(
      [action('palette', '$mod+k'), action('top', 'g g')],
      {active, contextConfigsByType: new Map([[globalConfig.type, globalConfig]])},
    )
    rerender({bindings: rebuilt.bindings})
    expect(result.current.state.pressed).toEqual([])
    expect(result.current.state.pendingMatches).toBeNull()
  })

  it('Escape clears inspector state first, then closes', () => {
    const onClose = vi.fn()
    const {result} = renderHook(() => useKeyInspector(true, model.bindings, onClose))
    act(() => {
      press({key: 'g'})
    })
    expect(pressedDisplays(result.current.state)).toEqual(['g'])

    act(() => {
      press({key: 'Escape'})
    })
    expect(result.current.state.pressed).toEqual([])
    expect(onClose).not.toHaveBeenCalled()

    act(() => {
      press({key: 'Escape'})
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not listen while closed', () => {
    const {result} = renderHook(() => useKeyInspector(false, model.bindings, vi.fn()))
    let event!: KeyboardEvent
    act(() => {
      event = press({key: 'g'})
    })
    expect(result.current.state.pressed).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  describe('capture mode', () => {
    it('resolves the next chord to onChord instead of inspecting it', () => {
      const onChord = vi.fn()
      const onCancel = vi.fn()
      const {result} = renderHook(() =>
        useKeyInspector(true, model.bindings, vi.fn(), {onChord, onCancel}),
      )

      let event!: KeyboardEvent
      act(() => {
        // jsdom has no Mac marker, so Ctrl is the $mod primary.
        event = press({key: 'k', ctrlKey: true})
      })
      expect(onChord).toHaveBeenCalledWith('$mod+k')
      // The chord is captured, not inspected — and swallowed so it can't
      // fire the action it's about to be bound to.
      expect(result.current.state.matches).toBeNull()
      expect(event.defaultPrevented).toBe(true)
    })

    it('previews modifier-only holds without resolving a chord', () => {
      const onChord = vi.fn()
      const {result} = renderHook(() =>
        useKeyInspector(true, model.bindings, vi.fn(), {onChord, onCancel: vi.fn()}),
      )
      act(() => {
        press({key: 'Control', ctrlKey: true})
      })
      expect(onChord).not.toHaveBeenCalled()
      expect(result.current.state.partial).not.toBeNull()
    })

    it('Escape cancels the capture instead of closing the overlay', () => {
      const onCancel = vi.fn()
      const onClose = vi.fn()
      renderHook(() =>
        useKeyInspector(true, model.bindings, onClose, {onChord: vi.fn(), onCancel}),
      )
      act(() => {
        press({key: 'Escape'})
      })
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(onClose).not.toHaveBeenCalled()
    })
  })
})
