/**
 * Date scrub gestures:
 *   - mobile: two-finger horizontal drag
 *   - desktop: hold `s` in NORMAL_MODE to enter scrub mode;
 *     arrows / h-j-k-l scrub by day or week; the wheel also feeds the
 *     same running scrub while armed; release `s` commits; Escape
 *     cancels. Routed through the action system as `DATE_SCRUB_CONTEXT`
 *     — see `dateScrubActions.ts`. Both keyboard and wheel scrub commit
 *     via the context's `s`-keyup action.
 *
 * Long-press is intentionally NOT used: that gesture belongs to
 * selection / bullet drag (Workflowy convention). The two-finger mobile
 * drag is rare enough to be intentional and avoid single-finger tap /
 * swipe / scroll conflicts.
 *
 * Coordination contract:
 *   - The React overlay (`DateScrubOverlay`) registers itself as the
 *     `ScrubHandler` on mount and unregisters on unmount. The overlay
 *     owns the runtime + adapter resolution + tooltip rendering.
 *   - This module owns the SHARED scrub core: the touch-scrub wrappers
 *     the gesture actions call, the module-level keyboard/wheel scrub
 *     state machine, thresholds, and the px→day mapping.
 *   - The TOUCH path rides the action system: `dateScrubRecognizer`
 *     classifies the two-finger drag, pre-checks date-shiftability, and
 *     emits `date-scrub` (progress) / `date-scrub-commit` (commit);
 *     `dateScrubGestureActions` bind those and drive the overlay via the
 *     wrappers below — symmetric with the keyboard/wheel path's
 *     `DATE_SCRUB_CONTEXT` actions. Arbitration with the swipe is the
 *     recognizer loop's (last-active-wins), not a manual swipe-candidate
 *     cancel.
 */
import type { Block } from '@/data/block'
import type { BlockDateAdapter } from './blockDateAdapter.ts'
import { activeLayoutSessionElement } from '@/utils/layoutSessionDom'

/** Pixels of scrub motion per ISO day. Picked so that ±2 weeks fits
 *  inside half a thumb-arc on a phone (~200px = 14 days). */
const PIXELS_PER_DAY = 14
const WHEEL_LINE_PX = 16
/** Caps so a wild horizontal swing across the screen doesn't put the
 *  date a year out by accident. The user can still tap the calendar
 *  chips in the swipe-menu Reschedule sheet for big jumps. */
const MAX_OFFSET_DAYS = 90
const MIN_OFFSET_DAYS = -90

export interface ScrubStartArgs {
  block: Block
  blockId: string
  /** Optional adapter override for input surfaces with fresher state
   *  than `block.peek()` (notably a live CodeMirror editor). */
  adapter?: BlockDateAdapter
  /** Midpoint between the two locked fingers at activation time.
   *  The overlay anchors its pill near this point. */
  startX: number
  startY: number
}

export interface DateScrubDraftPreview {
  label: string
  value: string
  detail?: string
}

export interface DateScrubDraft<Payload = unknown> {
  id: string
  currentIso: string
  preview: DateScrubDraftPreview
  payload?: Payload
  shiftDate: (deltaDays: number) => DateScrubDraft<Payload>
  commit: () => void | Promise<void>
}

export interface ScrubHandler {
  /** Returns true if the overlay accepted the scrub (block is
   *  date-shiftable). Returning false makes the gesture revert as if
   *  no activation happened. */
  start: (args: ScrubStartArgs) => boolean
  update: (deltaDays: number, intentCancel: boolean) => void
  stage?: (blockId: string, draft: DateScrubDraft) => boolean
  getDraft?: (blockId: string) => DateScrubDraft | null
  end: (commit: boolean) => void
}

let activeHandler: ScrubHandler | null = null

export const registerScrubHandler = (handler: ScrubHandler): (() => void) => {
  activeHandler = handler
  return () => {
    if (activeHandler === handler) activeHandler = null
  }
}

export interface KeyboardScrubTarget {
  block: Block
  adapter?: BlockDateAdapter
}

interface KeyboardScrub {
  blockId: string
  keyDeltaDays: number
  wheelPx: number
}

let keyboardScrub: KeyboardScrub | null = null

export const computeDeltaDays = (offsetPx: number): number => {
  const raw = Math.round(offsetPx / PIXELS_PER_DAY)
  if (raw > MAX_OFFSET_DAYS) return MAX_OFFSET_DAYS
  if (raw < MIN_OFFSET_DAYS) return MIN_OFFSET_DAYS
  return raw
}

/**
 * Touch-scrub entry points used by the date-scrub RECOGNIZER
 * (`dateScrubRecognizer.ts`). The continuous-gesture loop drives the touch path
 * now (replacing the bespoke content surface), but it still talks to the same
 * registered `ScrubHandler` (the overlay) the keyboard/wheel path does — these
 * thin wrappers keep `activeHandler` encapsulated. `start` returns whether the
 * overlay accepted (block is date-shiftable). */
export const startTouchScrub = (args: ScrubStartArgs): boolean =>
  activeHandler?.start(args) ?? false
export const updateTouchScrub = (deltaDays: number, intentCancel: boolean): void => {
  activeHandler?.update(deltaDays, intentCancel)
}
export const endTouchScrub = (commit: boolean): void => {
  activeHandler?.end(commit)
}

/** Named gestures the date-scrub recognizer (`dateScrubRecognizer.ts`) emits for
 *  actions (`dateScrubGestureActions.ts`) to bind: `date-scrub` carries the live
 *  PROGRESS preview, `date-scrub-commit` the COMMIT on a committing release.
 *  `DATE_SCRUB_GESTURE` doubles as the recognizer's arbitration id. */
export const DATE_SCRUB_GESTURE = 'date-scrub'
export const DATE_SCRUB_COMMIT_GESTURE = 'date-scrub-commit'

/**
 * The payload a date-scrub PROGRESS tick carries to the bound `date-scrub`
 * action. `deltaDays` / `cancelIntent` drive the overlay's `update`; the
 * activation (first) tick also carries `begin` — the locked two-finger midpoint
 * — so the action opens the overlay there before the first update. Opaque to the
 * dispatch layer, agreed between the recognizer and the action (as the swipe
 * tick carries its `dx`).
 */
export interface DateScrubProgressDetail {
  readonly deltaDays: number
  readonly cancelIntent: boolean
  readonly begin?: { readonly startX: number; readonly startY: number }
}

/** Event type the recognizer streams on each progress tick. The terminal settle
 *  arrives as the dispatcher's `GESTURE_PROGRESS_CANCEL_EVENT` instead. */
export const DATE_SCRUB_PROGRESS_TICK_EVENT = 'date-scrub-progress-tick'

export const dateScrubProgressTickEvent = (
  detail: DateScrubProgressDetail,
): CustomEvent<DateScrubProgressDetail> =>
  new CustomEvent(DATE_SCRUB_PROGRESS_TICK_EVENT, {detail})

const finishKeyboardScrub = (commit: boolean): void => {
  const current = keyboardScrub
  if (!current) return
  keyboardScrub = null
  activeHandler?.end(commit)
}

/** Exposed to the `DATE_SCRUB_CONTEXT` commit/cancel actions. Idempotent
 *  — calling when no scrub is active is a no-op. */
export const endKeyboardScrub = finishKeyboardScrub

const normalizeWheelDelta = (
  event: Pick<globalThis.WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'>,
): {dx: number; dy: number} => {
  const multiplier = event.deltaMode === 1
    ? WHEEL_LINE_PX
    : event.deltaMode === 2
      ? (typeof window === 'undefined' ? 800 : window.innerWidth)
      : 1
  return {
    dx: event.deltaX * multiplier,
    dy: event.deltaY * multiplier,
  }
}

const scrubPixelsForWheelDelta = (
  event: Pick<globalThis.WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'>,
): number => {
  const {dx, dy} = normalizeWheelDelta(event)
  // Browsers commonly remap Shift+wheel vertical motion into deltaX.
  const axisPx = dy !== 0 ? dy : dx
  return -axisPx
}

const escapeCssIdent = (value: string): string => {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

const keyboardScrubAnchorPoint = (blockId: string): {x: number; y: number} => {
  const fallback = {
    x: typeof window === 'undefined' ? 0 : window.innerWidth / 2,
    y: typeof window === 'undefined' ? 0 : window.innerHeight / 2,
  }
  if (typeof document === 'undefined') return fallback

  const selector = `[data-block-id="${escapeCssIdent(blockId)}"]`
  const activeElement = document.activeElement
  const activeBlock = activeElement instanceof Element
    ? activeElement.closest<HTMLElement>(selector)
    : null
  // First-match fallback (no focused ancestor to anchor from): scope to the
  // ACTIVE layout session so a warm hidden session's DOM (also matching
  // data-block-id) can't win the query — see layoutSessionDom.ts. Degrades
  // to a document-wide query when the host isn't mounted (single session).
  const blockElement = activeBlock
    ?? (activeLayoutSessionElement() ?? document).querySelector<HTMLElement>(selector)
  const anchor = blockElement?.querySelector<HTMLElement>('.block-content') ?? blockElement
  if (!anchor) return fallback

  const rect = anchor.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return fallback
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  }
}

const keyboardScrubTotalDays = (scrub: KeyboardScrub): number =>
  clampDeltaDays(scrub.keyDeltaDays + computeDeltaDays(scrub.wheelPx))

const clampDeltaDays = (deltaDays: number): number => {
  if (deltaDays > MAX_OFFSET_DAYS) return MAX_OFFSET_DAYS
  if (deltaDays < MIN_OFFSET_DAYS) return MIN_OFFSET_DAYS
  return deltaDays
}

const startKeyboardScrub = (target: KeyboardScrubTarget): KeyboardScrub | null => {
  if (keyboardScrub) return keyboardScrub
  if (!activeHandler) return null

  const point = keyboardScrubAnchorPoint(target.block.id)
  const accepted = activeHandler.start({
    block: target.block,
    blockId: target.block.id,
    adapter: target.adapter,
    startX: point.x,
    startY: point.y,
  })
  if (!accepted) return null

  const next = {
    blockId: target.block.id,
    keyDeltaDays: 0,
    wheelPx: 0,
  }
  keyboardScrub = next
  return next
}

/** Exposed for the `DATE_SCRUB_CONTEXT` enter action: starts a keyboard
 *  scrub on `target` if the overlay accepts (block is date-shiftable).
 *  Returns true on success — the action handler then activates the
 *  modal context. */
export const startKeyboardScrubForTarget = (target: KeyboardScrubTarget): boolean =>
  startKeyboardScrub(target) !== null

/** Exposed for the `DATE_SCRUB_CONTEXT` movement actions: applies a day
 *  delta to the running scrub. No-op if no scrub is active (the modal
 *  context's invariant should prevent this, but the action handlers
 *  can't atomically observe it). */
export const applyKeyboardScrubDelta = (deltaDays: number): void => {
  if (!keyboardScrub) return
  keyboardScrub.keyDeltaDays = clampDeltaDays(keyboardScrub.keyDeltaDays + deltaDays)
  activeHandler?.update(keyboardScrubTotalDays(keyboardScrub), false)
}

export const stageDateScrubDraft = (
  blockId: string,
  draft: DateScrubDraft,
): boolean => activeHandler?.stage?.(blockId, draft) ?? false

export const getDateScrubDraft = (
  blockId: string,
): DateScrubDraft | null => activeHandler?.getDraft?.(blockId) ?? null

const updateKeyboardScrubByWheel = (
  scrub: KeyboardScrub,
  event: globalThis.WheelEvent,
): void => {
  const deltaPx = scrubPixelsForWheelDelta(event)
  if (deltaPx === 0) return
  event.preventDefault()
  event.stopPropagation()
  scrub.wheelPx += deltaPx
  activeHandler?.update(keyboardScrubTotalDays(scrub), false)
}

/** Window listeners the keyboard-scrub state machine needs that don't
 *  fit the action system: wheel events as a feeder while a scrub is
 *  already armed (no wheel-trigger primitive on the action substrate),
 *  and window blur to cancel.
 *
 *  Activation, movement, commit, and cancel are all routed through
 *  `DATE_SCRUB_CONTEXT` actions (see dateScrubActions.ts). The wheel
 *  here is purely a feeder — it never starts a scrub on its own, only
 *  contributes deltas while one is armed via hold-`s`. */
export const installDateScrubAuxListeners = (): (() => void) => {
  if (typeof window === 'undefined') return () => undefined

  const handleBlur = (): void => {
    finishKeyboardScrub(false)
  }

  const handleWheel = (event: globalThis.WheelEvent): void => {
    if (!keyboardScrub) return
    updateKeyboardScrubByWheel(keyboardScrub, event)
  }

  window.addEventListener('blur', handleBlur)
  window.addEventListener('wheel', handleWheel, {capture: true, passive: false})

  return () => {
    window.removeEventListener('blur', handleBlur)
    window.removeEventListener('wheel', handleWheel, true)
    finishKeyboardScrub(false)
  }
}
