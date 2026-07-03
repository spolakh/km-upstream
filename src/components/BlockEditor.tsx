import CodeMirror, { ReactCodeMirrorRef, ReactCodeMirrorProps } from '@uiw/react-codemirror'
import { Block } from '../data/block'
import {
  editorSelection,
  editorFocusRequestProp,
  exitEditModeForBlock,
  isFocusedBlock,
  type EditorSelectionState,
} from '@/data/properties.js'
import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState, type Ref } from 'react'
import { useInEditMode, useIsEditing, useUIStateBlock } from '@/data/globalState'
import { debounce } from 'lodash-es'
import { clampSelectionToLength, placeCursorAtX, placeCursorAtCoords } from '@/utils/codemirror.js'
import { useContentRevision, usePropertyValue } from '@/hooks/block.js'
import { shouldExitEditModeAfterBlur } from '@/utils/dom.js'
import { EditorView } from '@codemirror/view'
import { EditorSelection, type Extension } from '@codemirror/state'
import { keyboardAwareScroll } from '@/utils/keyboardAwareScroll.js'
import { useShortcutSurfaceActivations } from '@/extensions/useShortcutSurfaceActivations.js'
import { useBlockContext } from '@/context/block.js'
import { resolveEditModeKeepalive } from '@/components/editModeKeepalive.js'

interface BlockEditorProps extends Omit<ReactCodeMirrorProps, 'value' | 'onChange' | 'onUpdate' | 'onBlur' | 'ref'> {
  block: Block
  ref?: Ref<ReactCodeMirrorRef>
}

export const BlockEditor = ({
  block,
  ref,
  ...codeMirrorProps
}: BlockEditorProps) => {
  const blockEditData = useContentRevision(block)

  const cm = useRef<ReactCodeMirrorRef>(null)
  const [editorView, setEditorView] = useState<EditorView | null>(null)

  const [isEditing] = useIsEditing()
  const inEditMode = useInEditMode(block.id)
  const blockContext = useBlockContext()
  const renderScopeId = typeof blockContext.renderScopeId === 'string'
    ? blockContext.renderScopeId
    : undefined
  const initialContent = useRef(blockEditData?.content ?? '')
  // Last value we handed to `block.setContent` (or adopted from an
  // external change). Decides whether a `blockData` update is (a) our
  // own committed echo / a no-op (live === incoming), (b) an external
  // change we should adopt (live matches lastCommittedContent), or
  // (c) an arrival that would clobber edits the user has typed past
  // their last commit (skip; the next debounced commit reconciles).
  const lastCommittedContent = useRef(blockEditData?.content ?? '')
  // Highest `updatedAt` we've adopted from blockData. Ratchets forward
  // monotonically so a stale snapshot (older or same-ms with different
  // content) can't clobber the editor — the cache layer has its own LWW
  // gate via applyIfNewer, this is defense-in-depth at the React
  // layer for paths that bypass it (e.g. blockData arriving via React
  // batching after a stale-but-published snapshot).
  const lastAdoptedUpdatedAt = useRef(blockEditData?.updatedAt ?? 0)
  const uiStateBlock = useUIStateBlock()
  const [focusRequestId] = usePropertyValue(uiStateBlock, editorFocusRequestProp)

  // useRef-wrapped debounce is the per-component-instance idiom; its
  // body runs on debounce-fire (not during render), so the ref writes
  // inside are safe even though the new react-hooks rule flags the
  // closure-construction itself.
  //
  // Note: `lastCommittedContent` is NOT updated here. Doing so used to
  // open a race — between this synchronous ref write and the tx
  // actually committing, a re-render driven by a PRIOR (still in-flight)
  // commit's late notification would arrive with `incoming` = the prior
  // content but `lastCommittedContent` already optimistically advanced
  // to the value we just queued, so the "user typed past" guard
  // wouldn't trip and the editor would clobber back to the prior value.
  // Instead, the adoption useEffect advances `lastCommittedContent`
  // when it observes `live === incoming` — i.e. when the cache
  // genuinely confirms our write.
  const pushChange = useRef(
    debounce((value: string) => {
      void block.setContent(value)
    }, 300),
  ).current

  const pushSelection = useRef(
    debounce((selection: EditorSelectionState) => {
      // Skip if focus has already moved to another block. Cross-block
      // navigation actions (Up/Down/Backspace-merge) write the target
      // block's `editorSelection` and then change `focusedBlockLocation`; this
      // BlockEditor unmounts and `flushDebouncers` fires a pending
      // pushSelection synchronously. Without this guard that fire would
      // overwrite the navigation's selection with a stale entry pointing
      // back at this (now unfocused) block, so the new editor's focus
      // effect bails on `selection.blockId !== block.id` and the cursor
      // lands at position 0 instead of the column the user came from.
      if (!isFocusedBlock(uiStateBlock, selection.blockId, renderScopeId)) return
      void uiStateBlock.set(editorSelection, selection)
    }, 150),
  ).current

  const flushDebouncers = useCallback(() => {
    pushChange.flush()
    pushSelection.flush()
  }, [pushChange, pushSelection])

  // Layout (not passive) effect: layout cleanups run BEFORE React
  // detaches the host nodes, so by the time anyone observes the editor
  // DOM as disconnected, the pending content/selection writes are
  // already enqueued ahead of them on the FIFO write lock. The
  // supertags failure-restore path relies on exactly this ordering —
  // with a passive cleanup there is a one-frame window where the view
  // is detached but the deletion never persisted, and a
  // restore-vs-flush race can drop the user's text.
  useLayoutEffect(() => flushDebouncers, [flushDebouncers])

  useEffect(() => {
    if (!blockEditData || !editorView) return
    // Ratchet the high-water `updatedAt` on every observation — including
    // our own committed-echoes that fall through to the early return
    // below. This is what makes the staleness check below trustworthy:
    // without it, a stale snapshot whose `updatedAt` is older than our
    // own latest commit (but newer than the previous external adoption)
    // would slip through.
    const incomingUpdatedAt = blockEditData.updatedAt
    const live = editorView.state.doc.toString()
    const incoming = blockEditData.content
    if (live === incoming) {
      // Cache has confirmed the editor's current value — either our own
      // committed write echoing back, or coincidentally identical
      // external state. Advance the "last committed" marker so the
      // user-typed-past guard below can be trusted: it can't trip on a
      // value the cache has already absorbed.
      lastCommittedContent.current = incoming
      if (incomingUpdatedAt > lastAdoptedUpdatedAt.current) {
        lastAdoptedUpdatedAt.current = incomingUpdatedAt
      }
      return
    }
    // Stale snapshot (older or equal-ms with different content). The
    // cache's LWW gate normally catches this, but a same-ms collision
    // window can squeeze a stale snapshot through to React; refuse to
    // roll back.
    if (incomingUpdatedAt <= lastAdoptedUpdatedAt.current) return
    // User has typed past the last commit — adopting `incoming` here
    // would discard those characters. Skip; the user's next debounced
    // commit will catch the editor up.
    if (live !== lastCommittedContent.current) return
    // Clamp the existing selection to the new doc length before dispatch —
    // an external change can shorten the doc below the cursor (see
    // clampSelectionToLength; omitting the selection instead would let
    // default mapping collapse the cursor to 0, since it sits inside the
    // replaced range [0, live.length]).
    editorView.dispatch({
      changes: {from: 0, to: live.length, insert: incoming},
      selection: clampSelectionToLength(editorView.state.selection, incoming.length),
    })
    // Cancel any pushChange pending from the user's pre-adoption typing,
    // and the one that the dispatch above just queued via onChange. The
    // adopted content is, by construction, what the cache already has
    // (`incoming`), so re-committing it would write a no-op tx that
    // still records on the undo stack — clearing the redo branch and
    // breaking redo-after-undo. The "user typed past" guard at line 129
    // ensured `live === lastCommittedContent` before we got here, so
    // there are no unflushed user keystrokes to lose.
    pushChange.cancel()
    lastCommittedContent.current = incoming
    lastAdoptedUpdatedAt.current = incomingUpdatedAt
    // pushChange is the per-component-instance debounce captured from
    // useRef.current; its identity is stable across renders so it
    // doesn't need to be a dep here. Adding it would cause the lint
    // rule to surface the ref-during-render flag on the `useRef(...)
    // .current` capture above (a deliberate idiom called out in the
    // comment block on `pushChange`'s creation), without changing
    // behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockEditData, editorView, block.id])

  useEffect(() => {
    if (!isEditing || !inEditMode || !editorView) return

    let cancelled = false
    const frameId = requestAnimationFrame(() => {
      if (!editorView || cancelled) return

      editorView.focus()

      const selection = uiStateBlock.peekProperty(editorSelection)
      if (!cancelled && selection?.blockId === block.id) {
        if (selection.x !== undefined && selection.y !== undefined) {
          placeCursorAtCoords(editorView, {x: selection.x, y: selection.y})
        } else if (selection.x !== undefined) {
          placeCursorAtX(editorView, selection.x, selection.line === 'last')
        } else if (selection.start !== undefined) {
          // The stored selection is debounce-persisted and can outlive
          // a doc-shrinking dispatch (e.g. the supertags `#`
          // autocomplete deleting its trigger text) — clamp it (see
          // clampSelectionToLength, shared with the adoption path
          // above).
          editorView.dispatch({selection: clampSelectionToLength(
            EditorSelection.single(selection.start, selection.end ?? selection.start),
            editorView.state.doc.length,
          )})
        }
      }

      if (cancelled) return
      // Pull the caret into view on edit-entry. `view.focus()` uses
      // preventScroll (CodeMirror's default), so nothing else scrolls
      // here — and when the on-screen keyboard is already up (tapping a
      // second block while editing) no visualViewport resize fires for
      // keyboardAwareScroll's plugin to catch, making this the only
      // chance to lift the caret above the keyboard. The scrollMargins
      // contributed by keyboardAwareScroll keep that landing keyboard-
      // aware; on desktop the margin is 0 and this is a cheap no-op for
      // an already-visible caret.
      editorView.dispatch({
        effects: EditorView.scrollIntoView(editorView.state.selection.main.head),
      })
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(frameId)
    }
  }, [block.id, editorView, focusRequestId, inEditMode, isEditing, uiStateBlock])

  // Activate the EDIT_MODE_CM shortcut surface so actions bound to that
  // context (Escape, Tab, etc.) fire via hotkeys-js whenever this editor is
  // mounted — for any consumer (markdown editor, extension editor, future).
  const shortcutSurfaceOptions = useMemo(() => ({editorView: editorView ?? undefined}), [editorView])
  useShortcutSurfaceActivations(block, 'codemirror', shortcutSurfaceOptions)

  // Every block editor gets keyboard-aware scrolling so the caret stays
  // above the on-screen keyboard (see keyboardAwareScroll). Prepended so
  // a caller-supplied extension can still override anything if it needs to.
  const {extensions: providedExtensions, ...restCodeMirrorProps} = codeMirrorProps
  const mergedExtensions = useMemo<Extension[]>(
    () => [keyboardAwareScroll(), ...(providedExtensions ?? [])],
    [providedExtensions],
  )

  if (!blockEditData) return null

  const forwardRefValue = (value: ReactCodeMirrorRef | null) => {
    if (!ref) return

    if (typeof ref === 'function') {
      ref(value)
    } else {
      ref.current = value
    }
  }

  return (
    <CodeMirror
      // `theme="none"` opts out of @uiw/react-codemirror's bundled
      // light-mode theme — that theme paints .cm-editor and .cm-content
      // white, which leaks through every block in any palette other
      // than plain white. Our own `createMinimalMarkdownConfig` sets
      // background: transparent so the surrounding block's palette
      // shows through. Callers can still pass `theme` via the spread
      // below to force a specific look.
      theme="none"
      ref={(value) => {
        cm.current = value
        setEditorView(value?.view ?? null)
        forwardRefValue(value)
      }}
      // CodeMirror is uncontrolled here — we feed the *first-render*
      // content via initialContent and apply later updates by dispatching
      // changes (see the useEffect above). Reading the ref during render
      // is the deliberate uncontrolled-init pattern.
      // eslint-disable-next-line react-hooks/refs
      value={initialContent.current}
      onChange={(value) => {
        pushChange(value)
      }}
      onUpdate={(viewUpdate) => {
        if (viewUpdate.selectionSet) {
          const selection = viewUpdate.state.selection.main
          pushSelection({blockId: block.id, start: selection.from, end: selection.to})
        }
      }}
      onBlur={() => {
        flushDebouncers()
        requestAnimationFrame(() => {
          if (!document.hasFocus() || !shouldExitEditModeAfterBlur(document.activeElement)) return
          // A keepalive hold (mobile toolbar around structural actions /
          // the file picker, or the command palette while open) means a
          // surface pulled focus without intending to end editing. Honor
          // it instead of exiting: 'refocus' snaps focus back to the
          // editor (the focus loss was incidental), 'yield' leaves focus
          // alone (a surface owns it and refocuses us on close). See
          // editModeKeepalive.
          const keepalive = resolveEditModeKeepalive()
          if (keepalive === 'refocus') {
            cm.current?.view?.focus()
            return
          }
          if (keepalive === 'yield') return
          // Clear edit mode only if THIS block still owns it. A block→block
          // tap may have already handed edit mode to the tapped block; an
          // unconditional clear would race that handoff and drop it (the
          // "keyboard hides / needs a second tap" bug). See exitEditModeForBlock.
          void exitEditModeForBlock(uiStateBlock, block.id, renderScopeId)
        })
      }}
      extensions={mergedExtensions}
      {...restCodeMirrorProps}
    />
  )
}

BlockEditor.displayName = 'BlockEditor'
