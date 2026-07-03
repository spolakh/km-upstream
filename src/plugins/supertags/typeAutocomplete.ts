/** CodeMirror CompletionSource for the `#` type-tag trigger (Tana-style
 *  supertags).
 *
 *  Trigger detection is the shared `matchCharTrigger`
 *  (`src/editor/triggerMatch.ts`, also behind the geo `@` trigger)
 *  with the stacked-hash guard on, so markdown headings (`# Title`,
 *  `##foo`) and URL anchors never fire it.
 *
 *  On select the trigger text (`#query`) is deleted from the doc
 *  immediately — the tag lives in the block's `types` property and is
 *  rendered as a trailing chip by `TypeChipsDecorator`, not as text —
 *  and the (async) type write is fired through `pickType`, which also
 *  mirrors the deletion into the block's stored content (same tx as
 *  the tag) so the editor remount that a types change triggers seeds
 *  from a cache row without the trigger text. A failed pick restores
 *  the deleted text (view first, stored content as fallback).
 *
 *  The source is pure w.r.t. data access: it takes already-resolved
 *  candidates and a `pickType` callback. Wiring to the repo (the live
 *  `typesFacet` registry, `addType`, `createTypeBlock`) happens in the
 *  plugin's CodeMirror extension. */

import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import type { TypeContribution } from '@/data/api'
import { isInsideMarkdownCode } from '@/editor/syntaxContext'
import { matchCharTrigger, type TriggerMatch } from '@/editor/triggerMatch'

/** Whether the `#` autocomplete offers this type — everything except
 *  `hideFromCompletion` opt-outs (kernel structure like page/panel,
 *  plugin prefs/ui-state plumbing — see `TypeContribution`). */
const offeredInCompletion = (type: TypeContribution | undefined): boolean =>
  type === undefined || type.hideFromCompletion !== true

/** Which of a block's types display as trailing tag chips: everything
 *  except `hideFromBlockDisplay` opt-outs
 *  (`block-type:hide-from-block-display` on user-defined types). The
 *  two display flags are orthogonal — a chip-hidden type stays offered
 *  in the completion and vice versa; infrastructure types set both.
 *  Unknown ids (type not in the registry, e.g. mid-load) stay visible
 *  so a tag never silently disappears. Dedups: a malformed `types`
 *  array (importer/bridge writes) must not render duplicate React
 *  keys. */
export const visibleTagTypeIds = (
  typeIds: readonly string[],
  registry: ReadonlyMap<string, TypeContribution>,
): readonly string[] => {
  const seen = new Set<string>()
  return typeIds.filter(typeId => {
    if (seen.has(typeId)) return false
    seen.add(typeId)
    return registry.get(typeId)?.hideFromBlockDisplay !== true
  })
}

export type TypeTagCandidate =
  /** A registered type; `id` is what `addType` takes. */
  | {kind: 'existing', id: string, label: string, detail?: string}
  /** The "Create type" sentinel; the real id is the type-definition
   *  block id minted at pick time. `label` is the trimmed query. */
  | {kind: 'create', label: string, detail?: string}

/** Dropdown length cap. Typing narrows the list, so truncation only
 *  ever hides types the query hasn't disambiguated yet. */
const RESULT_CAP = 12

/** `#` trigger detection — the shared matcher with the stacked-hash
 *  guard on (`##foo` is heading territory, not a tag). Exported for
 *  direct testing. */
export const matchHashTrigger = (text: string, pos: number): TriggerMatch | null =>
  matchCharTrigger(text, pos, '#', {rejectDoubledTrigger: true})

const labelOf = (type: TypeContribution): string => type.label ?? type.id

/** Case-insensitive exact label/id lookup among completion-offered
 *  types. Exported for the create flow's just-before-create re-check
 *  (the sentinel can be picked before an earlier create publishes). */
export const findCompletableTypeByName = (
  registry: ReadonlyMap<string, TypeContribution>,
  name: string,
): TypeContribution | undefined => {
  const q = name.trim().toLowerCase()
  if (q === '') return undefined
  for (const type of registry.values()) {
    if (!offeredInCompletion(type)) continue
    if (labelOf(type).toLowerCase() === q || type.id.toLowerCase() === q) return type
  }
  return undefined
}

/** Pure candidate builder over a registry snapshot. Exported for
 *  direct testing; the plugin extension feeds it `repo.types` and the
 *  block's current `types` property.
 *
 *  The `create` sentinel appears for any non-empty query with no exact
 *  label/id match among the completion-offered types (already-applied
 *  ones included, so you can't mint a second "Task" from a block that
 *  already carries the first). `hideFromCompletion` types deliberately
 *  don't suppress it: `#page` should offer to create the user's own
 *  "page" type rather than dead-end with an empty dropdown. */
export const buildTypeTagCandidates = (args: {
  registry: ReadonlyMap<string, TypeContribution>
  currentTypeIds: readonly string[]
  query: string
}): TypeTagCandidate[] => {
  const trimmed = args.query.trim()
  const q = trimmed.toLowerCase()
  const current = new Set(args.currentTypeIds)
  const all = Array.from(args.registry.values())

  const matches = all.filter(type =>
    offeredInCompletion(type) &&
    !current.has(type.id) &&
    (q === '' ||
      labelOf(type).toLowerCase().includes(q) ||
      type.id.toLowerCase().includes(q)))

  const rank = (type: TypeContribution): number =>
    labelOf(type).toLowerCase().startsWith(q) ? 0 : 1
  matches.sort((a, b) =>
    rank(a) - rank(b) || labelOf(a).localeCompare(labelOf(b)))

  const existing = matches.slice(0, RESULT_CAP).map((type): TypeTagCandidate => ({
    kind: 'existing',
    id: type.id,
    label: labelOf(type),
    detail: type.description,
  }))

  if (trimmed === '' || findCompletableTypeByName(args.registry, trimmed)) return existing

  return [...existing, {
    kind: 'create',
    label: trimmed,
    detail: 'Create new type',
  }]
}

/** Everything a pick implementation needs to mirror (or undo) the
 *  view-side trigger deletion against the block's STORED content
 *  without ever guessing at positions: full doc snapshots from the
 *  moment of the pick. Deleting by text search (`indexOf`) is not
 *  safe — the trigger text can occur earlier in the block (`#recipe`
 *  contains `#rec`), and matching the wrong occurrence corrupts user
 *  content permanently once the tag-triggered editor remount seeds
 *  from it. */
export interface TypeTagPickContext {
  /** The deleted `#query` span. */
  triggerText: string
  /** Doc offset of the trigger's `#` at pick time. */
  at: number
  /** Full doc content immediately BEFORE the trigger deletion. */
  docBefore: string
  /** Full doc content immediately AFTER the trigger deletion
   *  (`docBefore` minus the trigger span). */
  docAfter: string
}

/** How `pickType` should mirror the view's trigger deletion into the
 *  block's stored content. Strict snapshot equality — anything else
 *  (unflushed keystrokes, concurrent edits) returns null and the
 *  caller skips the content edit: the editor's own debounced
 *  `setContent` carries the deletion in those cases, and a wrong guess
 *  here would destroy user text. Pure; exported for direct testing. */
export const planTriggerStrip = (
  storedContent: string,
  ctx: TypeTagPickContext,
): string | null => {
  if (storedContent === ctx.docBefore) return ctx.docAfter
  return null
}

/** How a FAILED pick's fallback should put the trigger text back into
 *  stored content (the view path is preferred; this runs only when the
 *  view is unmounted). Exact inverse when the stored content matches
 *  the post-deletion snapshot; no-op when the text is demonstrably
 *  already there at its spot; best-effort positional insert otherwise
 *  (drifted content — restoring the user's text imperfectly placed
 *  beats dropping it). Pure; exported for direct testing. */
export const planTriggerRestore = (
  storedContent: string,
  ctx: TypeTagPickContext,
): string | null => {
  if (storedContent === ctx.docAfter) return ctx.docBefore
  if (storedContent.slice(ctx.at, ctx.at + ctx.triggerText.length) === ctx.triggerText) return null
  const pos = Math.min(ctx.at, storedContent.length)
  return storedContent.slice(0, pos) + ctx.triggerText + storedContent.slice(pos)
}

export interface TypeTagAutocompleteOptions {
  /** Candidates for the current query, in display order. */
  getCandidates: (query: string) => TypeTagCandidate[] | Promise<TypeTagCandidate[]>
  /** Called when the user picks a candidate, after the `#query`
   *  trigger text has been deleted from the view. Implementations MUST
   *  also remove it from the block's stored content in the SAME tx as
   *  the tag write (via `planTriggerStrip`): adding a type remounts
   *  the per-block editor (types participate in the renderer's slot
   *  identity), and the remounted editor seeds from the cache, so a
   *  cache row that still holds the trigger text resurrects it under
   *  the user's cursor. */
  pickType: (candidate: TypeTagCandidate, ctx: TypeTagPickContext) => Promise<void>
  /** Persistence fallback for a FAILED pick: re-insert the trigger
   *  text into the block's stored content (via `planTriggerRestore`)
   *  when the editor view can no longer take the restore (unmounted /
   *  navigated away). */
  restoreTrigger?: (ctx: TypeTagPickContext) => Promise<void>
}

/** Put a failed pick's trigger text back into the editor at (or as
 *  near as the doc allows) its original spot. False when the view is
 *  unmounted — the caller falls back to `restoreTrigger`. Exported for
 *  direct testing. */
export const restoreTriggerToView = (
  view: EditorView,
  at: number,
  triggerText: string,
): boolean => {
  if (!view.dom.isConnected) return false
  try {
    const pos = Math.min(at, view.state.doc.length)
    view.dispatch({
      changes: {from: pos, insert: triggerText},
      selection: EditorSelection.cursor(pos + triggerText.length),
    })
    return true
  } catch {
    return false
  }
}

const candidateToOption = (
  candidate: TypeTagCandidate,
  options: TypeTagAutocompleteOptions,
): Completion => ({
  label: candidate.kind === 'create' ? `Create type "${candidate.label}"` : candidate.label,
  detail: candidate.detail,
  type: candidate.kind === 'create' ? 'keyword' : 'class',
  apply: (view, _completion, applyFrom, applyTo) => {
    // Snapshot the doc around the deletion while the view is
    // guaranteed alive — pickType mirrors the deletion into the stored
    // content by snapshot equality, never by text search (see
    // TypeTagPickContext).
    const docBefore = view.state.doc.toString()
    const triggerText = view.state.doc.sliceString(applyFrom, applyTo)
    view.dispatch({
      changes: {from: applyFrom, to: applyTo, insert: ''},
      selection: EditorSelection.cursor(applyFrom),
    })
    const ctx: TypeTagPickContext = {
      triggerText,
      at: applyFrom,
      docBefore,
      docAfter: view.state.doc.toString(),
    }
    void (async () => {
      try {
        await options.pickType(candidate, ctx)
      } catch (err) {
        // The user's text was deleted optimistically — a failed pick
        // must give it back, not just log.
        console.warn('[supertags] failed to apply type', candidate.label, err)
        if (!restoreTriggerToView(view, applyFrom, triggerText)) {
          await options.restoreTrigger?.(ctx).catch((restoreErr: unknown) => {
            console.warn('[supertags] failed to restore trigger text', restoreErr)
          })
        }
      }
    })()
  },
})

export const typeTagCompletionSource = (
  options: TypeTagAutocompleteOptions,
): CompletionSource => {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const {state, pos, explicit} = context
    const line = state.doc.lineAt(pos)
    const match = matchHashTrigger(line.text, pos - line.from)
    if (!match) return null
    // `#word` is exactly what code looks like (`#define`, `#include`,
    // a CSS `#id`, `#!/bin/sh`) — and with the dropdown open, Enter
    // accepts the auto-selected "Create type" sentinel: it deletes the
    // code text and mints a junk type. Tags don't exist inside code.
    if (isInsideMarkdownCode(state, pos)) return null

    const candidates = await options.getCandidates(match.query)
    if (candidates.length === 0 && !explicit) return null

    return {
      from: line.from + match.from,
      to: pos,
      // Source-side filtering: buildTypeTagCandidates already matched
      // the query, and CodeMirror's fuzzy filter would drop the
      // `Create type "…"` sentinel whose label doesn't contain the
      // typed text in filterable form.
      filter: false,
      options: candidates.map(c => candidateToOption(c, options)),
    }
  }
}
