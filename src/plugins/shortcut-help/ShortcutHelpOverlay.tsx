import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useEditModeYieldKeepalive } from '@/components/useEditModeYieldKeepalive.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts.js'
import { getEffectiveActions } from '@/shortcuts/effectiveActions.js'
import { keybindingOverridesFacet } from '@/shortcuts/keybindingOverrides.js'
import { contextConfigsByTypeFrom } from '@/shortcuts/runAction.js'
import { formatChord } from '@/plugins/keybindings-settings/keyCapture.ts'
import type { ActionConfig } from '@/shortcuts/types.js'
import {
  actionSourcesFromRuntime,
  buildShortcutHelpModel,
  describeHandler,
  type HelpBinding,
  type HelpContextGroup,
} from './model.ts'
import { shortcutHelpToggle } from './toggleStore.ts'
import { useKeyInspector } from './useKeyInspector.ts'

const PHASE_LABELS = {keyup: 'on release', hold: 'hold'} as const

// Stable empty list so the inspector's listener effect doesn't re-run on
// every closed-state render.
const NO_BINDINGS: readonly HelpBinding[] = []

const PhaseBadge = ({binding}: {binding: HelpBinding}) => {
  if (binding.phase === 'keydown') return null
  const label = binding.phase === 'hold' && binding.holdMs !== undefined
    ? `${PHASE_LABELS.hold} ${binding.holdMs}ms`
    : PHASE_LABELS[binding.phase as keyof typeof PHASE_LABELS]
  return (
    <span className="rounded border px-1 py-0.5 text-[10px] text-muted-foreground">
      {label}
    </span>
  )
}

const BindingChord = ({binding}: {binding: HelpBinding}) => (
  <span className="flex shrink-0 items-center gap-1">
    <PhaseBadge binding={binding}/>
    <Kbd>{formatChord(binding.chord)}</Kbd>
  </span>
)

/** One row per ACTION: all of its chords rendered together (matching the
 *  command palette's presentation), clicking inspects the first one. */
const ActionRow = ({bindings, onSelect}: {
  bindings: readonly HelpBinding[]
  onSelect: (binding: HelpBinding) => void
}) => (
  <button
    type="button"
    onClick={() => onSelect(bindings[0]!)}
    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
  >
    <span className="truncate">{bindings[0]!.action.description}</span>
    <span className="flex shrink-0 items-center gap-1">
      {bindings.map((binding, index) => <BindingChord key={index} binding={binding}/>)}
    </span>
  </button>
)

/** Bucket a group's per-chord bindings back into per-action rows, keeping
 *  the group's order. */
const rowsOf = (group: HelpContextGroup): HelpBinding[][] => {
  const rows = new Map<ActionConfig, HelpBinding[]>()
  for (const binding of group.bindings) {
    const row = rows.get(binding.action) ?? []
    row.push(binding)
    rows.set(binding.action, row)
  }
  return Array.from(rows.values())
}

const ContextGroupSection = ({group, onSelect}: {
  group: HelpContextGroup
  onSelect: (binding: HelpBinding) => void
}) => (
  <section className="mb-3 break-inside-avoid">
    <h3 className="mb-1 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {group.config.displayName}
      {group.shadowed && (
        <span
          className="rounded border px-1 py-0.5 text-[10px] font-normal normal-case"
          title="A modal context holds the keyboard: these chords won't fire until it closes."
        >
          shadowed{group.shadowedBy ? ` by ${group.shadowedBy}` : ''}
        </span>
      )}
    </h3>
    <div className={group.shadowed ? 'opacity-60' : undefined}>
      {rowsOf(group).map(bindings => (
        <ActionRow key={bindings[0]!.action.id} bindings={bindings} onSelect={onSelect}/>
      ))}
    </div>
  </section>
)

/** Detail card for the chord the user just pressed (or the row they
 *  clicked): the winning action plus any lower-precedence/shadowed
 *  candidates for the same chord, with the handler's source on demand. */
const MatchPanel = ({matches}: {matches: readonly HelpBinding[]}) => {
  const winner = matches.find(binding => !binding.shadowed) ?? matches[0]!
  const others = matches.filter(binding => binding !== winner)
  const handler = describeHandler(winner.action)
  return (
    // min-w-0: DialogContent is a grid, and a grid item's default
    // min-width:auto lets the handler-source <pre>'s unbreakable lines
    // widen the track past the dialog — the pre must scroll inside
    // instead.
    <div className="min-w-0 rounded-md border bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{winner.action.description}</span>
        <BindingChord binding={winner}/>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {winner.contextConfig.displayName}
        {' · '}action <code>{winner.action.id}</code>
        {winner.source && <>{' · '}from <code>{winner.source}</code></>}
        {winner.shadowed && <>{' · '}shadowed — would not fire right now</>}
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Handler source{handler.name ? ` — ${handler.name}()` : ''}
        </summary>
        <pre className="mt-1 max-h-48 max-w-full overflow-auto rounded bg-muted p-2 text-[11px] leading-snug">
          {handler.source}
        </pre>
      </details>
      {others.length > 0 && (
        <div className="mt-2 border-t pt-2 text-xs text-muted-foreground">
          {/* Not "lower precedence": a phase-different twin (hold vs press) is a
              different lifecycle moment, and the dispatcher can also fall through
              to these when the first candidate declines at dispatch time. */}
          <div className="mb-1">Also bound to this chord:</div>
          {others.map((binding, index) => (
            <div key={`${binding.action.id}:${index}`} className="flex items-center justify-between gap-2 py-0.5">
              <span className="truncate">
                {binding.action.description}
                {' · '}{binding.contextConfig.displayName}
                {binding.shadowed ? ' (shadowed)' : ''}
              </span>
              <BindingChord binding={binding}/>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ShortcutHelpOverlay() {
  const open = useSyncExternalStore(
    shortcutHelpToggle.subscribe,
    shortcutHelpToggle.isOpen,
    shortcutHelpToggle.isOpen,
  )
  const runtime = useAppRuntime()
  const active = useActiveContextsState()

  // Same edit-mode keepalive dance as the command palette: without it,
  // opening from edit mode would exit edit mode and deactivate
  // EDIT_MODE_CM — making the overlay list the wrong contexts for "what
  // can I press right now".
  useEditModeYieldKeepalive(open)

  // Keybinding overrides are pushed in place via setRuntimeContributions
  // (no runtime identity change), so subscribe to the facet's change
  // listener — same reason HotkeyReconciler does — or the overlay would
  // keep listing/matching stale chords after a mid-open remap.
  const [overridesGeneration, setOverridesGeneration] = useState(0)
  useEffect(() => {
    return runtime.onFacetChange(keybindingOverridesFacet.id, () => {
      setOverridesGeneration(g => g + 1)
    })
  }, [runtime])

  const model = useMemo(() => {
    if (!open) return null
    return buildShortcutHelpModel(
      getEffectiveActions(runtime),
      {active, contextConfigsByType: contextConfigsByTypeFrom(runtime)},
      actionSourcesFromRuntime(runtime),
    )
    // overridesGeneration re-runs the memo on in-place override updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runtime, active, overridesGeneration])

  const bindings = model?.bindings ?? NO_BINDINGS
  const {state, selectBinding} = useKeyInspector(open, bindings, shortcutHelpToggle.close)

  // Which-key narrowing: while a sequence prefix is pending, the list
  // collapses to its continuations.
  const visibleGroups = useMemo(() => {
    if (!model) return []
    if (!state.pendingMatches) return model.groups.filter(group => group.bindings.length > 0)
    const pendingSet = new Set(state.pendingMatches)
    return model.groups
      .map(group => ({...group, bindings: group.bindings.filter(b => pendingSet.has(b))}))
      .filter(group => group.bindings.length > 0)
  }, [model, state.pendingMatches])

  const status = state.partial ? (
    <span>Holding <Kbd>{formatChord(state.partial)}</Kbd>…</span>
  ) : state.pressed.length > 0 ? (
    <span>
      Pending sequence <Kbd>{state.pressed.map(p => formatChord(p.display)).join(' ')}</Kbd> — showing continuations
    </span>
  ) : state.unmatched ? (
    <span>Nothing bound to <Kbd>{state.unmatched.map(formatChord).join(' ')}</Kbd></span>
  ) : (
    <span>Press any key combo to inspect it. Esc clears, then closes.</span>
  )

  return (
    <Dialog open={open} onOpenChange={shortcutHelpToggle.set}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>{status}</DialogDescription>
        </DialogHeader>
        {state.matches && <MatchPanel matches={state.matches}/>}
        <div className="min-w-0 max-h-[60vh] overflow-y-auto sm:columns-2 sm:gap-6">
          {visibleGroups.map(group => (
            <ContextGroupSection key={group.config.type} group={group} onSelect={selectBinding}/>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
