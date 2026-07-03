/** CodeMirror CompletionSource for the `@` place trigger.
 *
 *  Trigger shape: `@<query>` at start of line or after whitespace, with
 *  no `[` in the query (so we don't fire inside `[[`) and no preceding
 *  word character (so we don't fire mid-email `a@b`). The query may
 *  contain single spaces ("Blue Bottle Coffee") — a double space, other
 *  whitespace, or the length/word caps end it so prose after a bare
 *  `@word` doesn't keep the dropdown alive. The query may be empty —
 *  that's the moment to surface the "Use current location" sentinel
 *  (Phase F).
 *
 *  On select: the caller-supplied `resolvePlace` returns a
 *  `PlaceResolveResult`. Two kinds:
 *    - `{kind: 'insert', name}` → we replace the trigger span with
 *      `[[<name>]]` (the references plugin picks up the wikilink).
 *    - `{kind: 'handled'}` → the resolver dispatched its own change /
 *      opened a follow-up picker; the source stays out of the way.
 *  Returning `null` cancels the insertion (user dismissed a sub-prompt).
 *
 *  Follow-up pickers (Phase F current-location list) re-enter the
 *  source via `consumePendingCandidates`: a one-shot stash of
 *  candidates + span that the caller pushes from a candidate's apply
 *  handler, then triggers `startCompletion(view)` so CM re-opens the
 *  dropdown with the new list — no second UI to maintain.
 *
 *  The source is *pure* w.r.t. data access — it takes already-resolved
 *  candidates and a `resolvePlace` callback. Wiring to the repo, the
 *  Google client, and `createOrFindPlace` happens in the geo plugin's
 *  CodeMirror extension. */

import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { isInsideLiteralMarkdown } from '@/editor/syntaxContext'
import { matchCharTrigger, type TriggerMatch } from '@/editor/triggerMatch'
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'

export type PlaceCandidateSource =
  | 'local'
  | 'google'
  | 'sentinel:current-location'
  | 'drop-pin'
  | 'create-named'

export interface PlaceAutocompleteCandidate {
  /** Stable id used for de-dup across sources and for picking. For local
   *  candidates, the block id; for Google, the placeId; for sentinels, a
   *  fixed string; for picker-stage candidates, includes the coords. */
  id: string
  source: PlaceCandidateSource
  /** Display label for the dropdown row. */
  label: string
  /** Optional secondary text (address, distance, etc.). */
  detail?: string
  /** Final wikilink text to insert. For Google candidates this is set
   *  during pick (after getDetails resolves the canonical name); for
   *  local matches it's the existing block's name. */
  insertText: string
  /** Coords stashed on picker-stage candidates (drop-pin, create-named)
   *  so resolution can create the Place without re-fetching geolocation. */
  coords?: {lat: number, lng: number}
}

export type PlaceResolveResult =
  | {kind: 'insert', name: string}
  /** Resolver handled the change itself (e.g. opened a follow-up
   *  picker). Source skips the default `[[...]]` insertion. */
  | {kind: 'handled'}
  | null

export interface PlaceResolveContext {
  view: EditorView
  /** Trigger span in the doc — same range CM passes to the apply
   *  callback. Resolvers that re-open the dropdown should re-use this
   *  span for the follow-up so the user's `@here` text stays in place. */
  from: number
  to: number
}

export interface PlaceAutocompleteOptions {
  /** Callback to fetch candidates for the current query. Returns a list
   *  in display order. Implementations bundle: local alias scan,
   *  optionally Google autocomplete (gated by query length and API key),
   *  and the current-location sentinel when appropriate. */
  getCandidates: (query: string) => Promise<PlaceAutocompleteCandidate[]>
  /** Called when the user selects a candidate. Returns either an insert
   *  spec, `{kind:'handled'}` if the resolver took ownership of the
   *  change, or `null` to cancel. */
  resolvePlace: (
    candidate: PlaceAutocompleteCandidate,
    ctx: PlaceResolveContext,
  ) => Promise<PlaceResolveResult>
  /** Optional one-shot stash drained at the top of every source call.
   *  Used by follow-up pickers: a candidate's resolver stashes the next
   *  round of candidates (with their target span) and calls
   *  `startCompletion(view)`. The next invocation returns them
   *  verbatim, bypassing `@` trigger detection. */
  consumePendingCandidates?: () => {
    span: {from: number, to: number}
    candidates: PlaceAutocompleteCandidate[]
  } | null
  /** Persistence fallback for the resolved wikilink. `resolvePlace` can
   *  settle long after the pick (details fetch, collision toast) — by
   *  then the interaction may have moved focus out of the editor, and
   *  the per-block CodeMirror view unmounts with it, so dispatching the
   *  insert into the captured view goes nowhere. When the view can no
   *  longer take the change, this is called to apply the same
   *  trigger-text → wikilink replacement to the underlying block. */
  persistInsert?: (args: {triggerText: string; insert: string}) => Promise<void>
}

/** `@` trigger detection — the shared matcher (see
 *  `src/editor/triggerMatch.ts` for the query/guard semantics: single
 *  spaces allowed for multi-word place names, email guard, wikilink
 *  ownership, length/word caps). Exported for direct testing. */
export const matchAtTrigger = (text: string, pos: number): TriggerMatch | null =>
  matchCharTrigger(text, pos, '@')

/** Where to apply the trigger-text → wikilink replacement once the
 *  resolution settles. Prefers the recorded span if the text is still
 *  there; re-locates by content when the doc drifted around it (other
 *  edits landed while the resolution was pending); `null` when the
 *  trigger text is gone — the user deleted it, nothing to replace.
 *  Exported for direct testing. */
export const planResolvedInsert = (
  doc: string,
  span: {from: number; to: number},
  triggerText: string,
): {from: number; to: number} | null => {
  if (triggerText.length === 0) return null
  if (doc.slice(span.from, span.to) === triggerText) return span
  const idx = doc.indexOf(triggerText)
  if (idx === -1) return null
  return {from: idx, to: idx + triggerText.length}
}

/** Try to deliver the insert through the editor view. False when the
 *  view is unmounted/destroyed or the trigger text is no longer in its
 *  doc — the caller falls back to `persistInsert`. */
const applyInsertToView = (
  view: EditorView,
  span: {from: number; to: number},
  triggerText: string,
  insert: string,
): boolean => {
  // `EditorView.destroyed` is private API; a detached root is the
  // observable signature of an unmounted per-block editor.
  if (!view.dom.isConnected) return false
  const plan = planResolvedInsert(view.state.doc.toString(), span, triggerText)
  if (plan === null) return false
  try {
    view.dispatch({
      changes: {from: plan.from, to: plan.to, insert},
      selection: EditorSelection.cursor(plan.from + insert.length),
    })
    return true
  } catch {
    return false
  }
}

const candidateToOption = (
  candidate: PlaceAutocompleteCandidate,
  options: PlaceAutocompleteOptions,
): Completion => ({
  label: candidate.label,
  detail: candidate.detail,
  type: candidate.source === 'sentinel:current-location' ? 'keyword' : 'class',
  apply: (view, _completion, applyFrom, applyTo) => {
    // Snapshot the trigger text now — by the time the resolution
    // settles the doc (or the view itself) may be gone.
    const triggerText = view.state.doc.sliceString(applyFrom, applyTo)
    // Fire-and-forget — the dropdown closes immediately. Errors
    // surface via the resolvePlace impl (toast, console).
    void (async () => {
      const resolved = await options.resolvePlace(candidate, {view, from: applyFrom, to: applyTo})
      if (!resolved) return
      if (resolved.kind === 'handled') return
      const insert = `[[${resolved.name}]]`
      const delivered = applyInsertToView(
        view, {from: applyFrom, to: applyTo}, triggerText, insert,
      )
      if (!delivered) await options.persistInsert?.({triggerText, insert})
    })()
  },
})

export const placeCompletionSource = (
  options: PlaceAutocompleteOptions,
): CompletionSource => {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const pending = options.consumePendingCandidates?.()
    if (pending) {
      return {
        from: pending.span.from,
        to: pending.span.to,
        filter: false,
        options: pending.candidates.map(c => candidateToOption(c, options)),
      }
    }

    const {state, pos, explicit} = context
    const line = state.doc.lineAt(pos)
    const lineText = line.text
    const inLinePos = pos - line.from

    const match = matchAtTrigger(lineText, inLinePos)
    if (!match) return null
    // Don't open on every keystroke until the user has typed `@` — the
    // matcher already enforces that. We do show on an empty query
    // (matched immediately after `@`) so the sentinel surfaces.

    // `@word` is also what literal spans look like (`@decorator` /
    // `@media` in code, `user@host` in a URL) — and with the dropdown
    // open, Enter accepts a place candidate and replaces that text.
    // The pending-candidates path above stays ungated: it re-opens a
    // dropdown the pick flow itself stashed.
    if (isInsideLiteralMarkdown(state, pos)) return null

    const candidates = await options.getCandidates(match.query)
    if (candidates.length === 0 && !explicit) return null

    const from = line.from + match.from
    return {
      from,
      to: pos,
      // Source-side filtering: getCandidates already filtered (local
      // alias LIKE + Google text rank). CodeMirror's default fuzzy
      // filter would hide e.g. a "Use current location" sentinel whose
      // label doesn't contain the typed text.
      filter: false,
      options: candidates.map(c => candidateToOption(c, options)),
    }
  }
}
