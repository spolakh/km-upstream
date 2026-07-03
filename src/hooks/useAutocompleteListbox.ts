import { useCallback, useState, type KeyboardEvent, type MouseEvent } from 'react'

export interface AutocompleteListboxOptions {
  /** Number of options currently in the listbox. */
  itemCount: number
  /** Commit the option at `index`. Return `true` if a commit happened so
   *  the key is consumed (`preventDefault`); return `false` to let it fall
   *  through — e.g. so Enter submits the surrounding form / inserts the
   *  typed value instead. Called for keyboard Enter/Tab (with the active
   *  index) and for an option click (with that option's index). */
  onCommit: (index: number) => boolean
  /** Reveal the listbox; called when an arrow key starts navigation. */
  setOpen: (open: boolean) => void
  /** Wrap arrow navigation around the ends instead of clamping at them. */
  wrap?: boolean
  /** Commit on Tab as well as Enter — for single-field editors where Tab
   *  means "accept". Leave off for multi-field forms where Tab should move
   *  focus. */
  commitOnTab?: boolean
  /** Base id for option elements + `aria-activedescendant` wiring. */
  listboxId?: string
}

export interface AutocompleteOptionProps {
  role: 'option'
  id: string | undefined
  'aria-selected': boolean
  onMouseEnter: () => void
  onMouseDown: (event: MouseEvent) => void
  onClick: () => void
}

export interface AutocompleteListbox {
  activeIndex: number
  setActiveIndex: (index: number) => void
  /** Value for the input's `aria-activedescendant` (undefined without a
   *  `listboxId`). */
  activeDescendantId: string | undefined
  /** Attach to the input's `onKeyDown`. Handles Arrow Up/Down (move the
   *  active option + open the listbox), Enter, and — when `commitOnTab` —
   *  Tab. Keys that vary per editor (Escape, Backspace, …) are left for
   *  the caller to handle in its own handler before/after delegating. */
  onKeyDown: (event: KeyboardEvent) => void
  /** Spread onto each option element; pair with a stable `key`. */
  getOptionProps: (index: number) => AutocompleteOptionProps
}

/** The shared interaction core of the autocomplete dropdowns (ref/tag/
 *  type/property pickers): the active-option index, arrow-key navigation,
 *  Enter/Tab commit, and the option mouse + a11y wiring. It is
 *  search-agnostic — the caller fetches its own options (debounced or not)
 *  and feeds the current list's length in via `itemCount`. */
export function useAutocompleteListbox({
  itemCount,
  onCommit,
  setOpen,
  wrap = false,
  commitOnTab = false,
  listboxId,
}: AutocompleteListboxOptions): AutocompleteListbox {
  const [activeIndex, setActiveIndex] = useState(0)

  const move = useCallback((delta: 1 | -1) => {
    setActiveIndex(index => {
      if (itemCount <= 0) return index
      if (wrap) return (index + delta + itemCount) % itemCount
      return Math.min(Math.max(index + delta, 0), itemCount - 1)
    })
  }, [itemCount, wrap])

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setOpen(true)
        move(1)
        return
      case 'ArrowUp':
        event.preventDefault()
        setOpen(true)
        move(-1)
        return
      case 'Enter':
        if (onCommit(activeIndex)) event.preventDefault()
        return
      case 'Tab':
        if (commitOnTab && onCommit(activeIndex)) event.preventDefault()
        return
    }
  }, [activeIndex, commitOnTab, move, onCommit, setOpen])

  const getOptionProps = useCallback((index: number): AutocompleteOptionProps => ({
    role: 'option',
    id: listboxId ? `${listboxId}-option-${index}` : undefined,
    'aria-selected': index === activeIndex,
    onMouseEnter: () => setActiveIndex(index),
    onMouseDown: event => event.preventDefault(),
    onClick: () => { onCommit(index) },
  }), [activeIndex, listboxId, onCommit])

  return {
    activeIndex,
    setActiveIndex,
    // Guard against a stale index: `move` clamps, but the option list
    // can shrink underneath the index (a concurrent registry change
    // while hovering) — a dangling IDREF is worse for AT than none.
    activeDescendantId: listboxId && activeIndex < itemCount
      ? `${listboxId}-option-${activeIndex}`
      : undefined,
    onKeyDown,
    getOptionProps,
  }
}
