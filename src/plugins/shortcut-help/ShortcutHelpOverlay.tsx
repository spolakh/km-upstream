import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, Pencil, RotateCcw, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button.js'
import { Kbd } from '@/components/ui/kbd'
import { useEditModeYieldKeepalive } from '@/components/useEditModeYieldKeepalive.js'
import { useRepo } from '@/context/repo.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts.js'
import {
  getActionsBeforeKeybindingOverrides,
  getEffectiveActions,
} from '@/shortcuts/effectiveActions.js'
import type { KeybindingConflict } from '@/shortcuts/keybindingConflicts.js'
import {
  KEYBINDING_OVERRIDE_USER_SOURCE,
  keybindingOverridesFacet,
} from '@/shortcuts/keybindingOverrides.js'
import { contextConfigsByTypeFrom, runActionById } from '@/shortcuts/runAction.js'
import type { ActionConfig, ActionContextType } from '@/shortcuts/types.js'
import { openKeybindingsSettingsAction } from '@/plugins/keybindings-settings/actions.ts'
import { overrideEntryKey, type StoredKeybindingOverride } from '@/plugins/keybindings-settings/config.ts'
import { formatChord, normalizeChord } from '@/plugins/keybindings-settings/keyCapture.ts'
import {
  previewOverrideConflicts,
  readStoredOverrides,
  removeKeybindingOverride,
  setKeybindingOverride,
} from '@/plugins/keybindings-settings/overrideStore.ts'
import {
  actionSourcesFromRuntime,
  buildShortcutHelpModel,
  describeHandler,
  type HelpBinding,
  type HelpContextGroup,
} from './model.ts'
import { shortcutHelpToggle } from './toggleStore.ts'
import { type CaptureMode, useKeyInspector } from './useKeyInspector.ts'

const PHASE_LABELS = {keyup: 'on release', hold: 'hold'} as const

// Stable empty list so the inspector's listener effect doesn't re-run on
// every closed-state render.
const NO_BINDINGS: readonly HelpBinding[] = []
const NO_OVERRIDES: ReadonlySet<string> = new Set()

/** The action a "Rebind…" capture is targeting. */
interface RebindTarget {
  readonly actionId: string
  readonly context: ActionContextType
  readonly description: string
}

/** Post-write confirmation. Lives in overlay state (not the inspector) so
 *  it survives the model rebuild the write triggers, which resets the
 *  inspector and drops the match panel. */
type Notice =
  | {
      readonly kind: 'bound'
      readonly actionId: string
      readonly context: ActionContextType
      readonly description: string
      readonly chord: string
      readonly conflicts: readonly KeybindingConflict[]
    }
  | {readonly kind: 'reset' | 'unbound' | 'error'; readonly description: string}

/** Override mutations, addressing an action by (id, context, description)
 *  rather than the object so the notice banner can still act after the
 *  binding objects have been rebuilt out from under it. */
interface OverrideActions {
  readonly onRebind: (actionId: string, context: ActionContextType, description: string) => void
  readonly onReset: (actionId: string, context: ActionContextType, description: string) => void
  readonly onUnbind: (actionId: string, context: ActionContextType, description: string) => void
}

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
 *  candidates for the same chord, with the handler's source on demand and
 *  rebind / reset / unbind affordances that write the user's overrides. */
const MatchPanel = ({matches, capturing, partial, overriddenKeys, actions, onCancelCapture}: {
  matches: readonly HelpBinding[]
  capturing: RebindTarget | null
  partial: string | null
  overriddenKeys: ReadonlySet<string>
  actions: OverrideActions
  onCancelCapture: () => void
}) => {
  const winner = matches.find(binding => !binding.shadowed) ?? matches[0]!
  const others = matches.filter(binding => binding !== winner)
  const handler = describeHandler(winner.action)
  const action = winner.action
  const isCapturing = capturing?.actionId === action.id && capturing.context === action.context
  const overridden = overriddenKeys.has(overrideEntryKey(action.context, action.id))
  return (
    // min-w-0: DialogContent is a grid, and a grid item's default
    // min-width:auto lets the handler-source <pre>'s unbreakable lines
    // widen the track past the dialog — the pre must scroll inside
    // instead.
    <div className="min-w-0 rounded-md border bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{action.description}</span>
        {isCapturing ? (
          <span className="flex shrink-0 items-center gap-2 text-xs">
            {partial
              ? <Kbd>{formatChord(partial)}…</Kbd>
              : <span className="text-muted-foreground">Press a key…</span>}
            <Button type="button" variant="ghost" size="sm" onClick={onCancelCapture}>
              Cancel
            </Button>
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1">
            <BindingChord binding={winner}/>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="Rebind"
              onClick={() => actions.onRebind(action.id, action.context, action.description)}
            >
              <Pencil className="h-3.5 w-3.5"/>
            </Button>
            {overridden && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title="Reset to default"
                onClick={() => actions.onReset(action.id, action.context, action.description)}
              >
                <RotateCcw className="h-3.5 w-3.5"/>
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="Remove shortcut"
              onClick={() => actions.onUnbind(action.id, action.context, action.description)}
            >
              <X className="h-3.5 w-3.5"/>
            </Button>
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {winner.contextConfig.displayName}
        {' · '}action <code>{action.id}</code>
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

/** Names of the OTHER actions a proposed binding would also fire. */
const conflictPeers = (
  conflicts: readonly KeybindingConflict[],
  self: {actionId: string; context: ActionContextType},
): string[] => {
  const names = new Set<string>()
  for (const conflict of conflicts) {
    for (const participant of conflict.actions) {
      if (participant.actionId === self.actionId && participant.context === self.context) continue
      names.add(participant.description)
    }
  }
  return [...names]
}

const NoticeBanner = ({notice, onReset, onOpenSettings, onDismiss}: {
  notice: Notice
  onReset: OverrideActions['onReset']
  onOpenSettings: () => void
  onDismiss: () => void
}) => {
  const peers = notice.kind === 'bound' ? conflictPeers(notice.conflicts, notice) : []
  return (
    <div className="min-w-0 rounded-md border bg-muted/40 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {notice.kind === 'bound' && (
            <span>Bound <Kbd>{formatChord(notice.chord)}</Kbd> to <span className="font-medium">{notice.description}</span>.</span>
          )}
          {notice.kind === 'reset' && (
            <span>Restored the default shortcut for <span className="font-medium">{notice.description}</span>.</span>
          )}
          {notice.kind === 'unbound' && (
            <span>Removed the shortcut for <span className="font-medium">{notice.description}</span>.</span>
          )}
          {notice.kind === 'error' && (
            <span className="text-destructive">Couldn't update <span className="font-medium">{notice.description}</span> — see the console.</span>
          )}
        </div>
        <Button type="button" variant="ghost" size="icon" title="Dismiss" onClick={onDismiss}>
          <X className="h-3.5 w-3.5"/>
        </Button>
      </div>
      {peers.length > 0 && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0"/>
          <span>Also fires {peers.join(', ')} — both handlers run on this chord.</span>
        </div>
      )}
      {notice.kind === 'bound' && (
        <div className="mt-2 flex items-center gap-3 text-xs">
          <button
            type="button"
            className="underline hover:no-underline"
            onClick={() => onReset(notice.actionId, notice.context, notice.description)}
          >
            Reset to default
          </button>
          <button type="button" className="underline hover:no-underline" onClick={onOpenSettings}>
            Open keyboard settings
          </button>
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
  const repo = useRepo()
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

  // Which (context, actionId) rows carry a user override — drives the
  // "Reset to default" affordance. Only user-source overrides count; a
  // plugin-shipped rebind isn't the user's to reset from here.
  const overriddenKeys = useMemo<ReadonlySet<string>>(() => {
    if (!open) return NO_OVERRIDES
    const set = new Set<string>()
    for (const override of runtime.read(keybindingOverridesFacet)) {
      if (override.source !== KEYBINDING_OVERRIDE_USER_SOURCE || !override.context) continue
      set.add(overrideEntryKey(override.context, override.actionId))
    }
    return set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runtime, overridesGeneration])

  const [capturing, setCapturing] = useState<RebindTarget | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  // The keydown-driven `commitRebind` needs the current target
  // synchronously; mirror it into a ref (layout effect, not render) so the
  // callback can stay stable and pure — reading it inside a setState
  // updater would double-fire the write under StrictMode.
  const capturingRef = useRef<RebindTarget | null>(null)
  useLayoutEffect(() => {
    capturingRef.current = capturing
  }, [capturing])

  // A closed overlay carries no capture/notice into its next opening.
  // Reset during render on the open→closed edge (the endorsed
  // "adjust-state-when-a-prop-changes" pattern) rather than in an effect,
  // which react-hooks/set-state-in-effect forbids.
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (!open) {
      setCapturing(null)
      setNotice(null)
    }
  }

  const startRebind = useCallback((actionId: string, context: ActionContextType, description: string) => {
    setNotice(null)
    setCapturing({actionId, context, description})
  }, [])

  const cancelRebind = useCallback(() => setCapturing(null), [])

  // Persist a rebind: preview the conflicts it would create (from the
  // pre-write stored set), then write. The block subscription bumps
  // `overridesGeneration`, which rebuilds the model and resets the
  // inspector — so the confirmation lives in `notice`, not the panel.
  const commitRebind = useCallback((chord: string) => {
    const target = capturingRef.current
    if (!target) return
    setCapturing(null)
    const normalized = normalizeChord(chord)
    const entry: StoredKeybindingOverride = {
      actionId: target.actionId,
      context: target.context,
      binding: {keys: normalized},
    }
    void (async () => {
      try {
        const stored = await readStoredOverrides(repo)
        const conflicts = previewOverrideConflicts(
          getActionsBeforeKeybindingOverrides(runtime),
          stored,
          entry,
        )
        await setKeybindingOverride(repo, entry)
        setNotice({
          kind: 'bound',
          actionId: target.actionId,
          context: target.context,
          description: target.description,
          chord: normalized,
          conflicts,
        })
      } catch (error) {
        console.error('shortcut-help: failed to rebind', error)
        setNotice({kind: 'error', description: target.description})
      }
    })()
  }, [repo, runtime])

  const resetBinding = useCallback((actionId: string, context: ActionContextType, description: string) => {
    void (async () => {
      try {
        await removeKeybindingOverride(repo, actionId, context)
        setNotice({kind: 'reset', description})
      } catch (error) {
        console.error('shortcut-help: failed to reset binding', error)
        setNotice({kind: 'error', description})
      }
    })()
  }, [repo])

  const unbindBinding = useCallback((actionId: string, context: ActionContextType, description: string) => {
    void (async () => {
      try {
        await setKeybindingOverride(repo, {actionId, context, binding: {unbound: true}})
        setNotice({kind: 'unbound', description})
      } catch (error) {
        console.error('shortcut-help: failed to remove binding', error)
        setNotice({kind: 'error', description})
      }
    })()
  }, [repo])

  const overrideActions = useMemo<OverrideActions>(
    () => ({onRebind: startRebind, onReset: resetBinding, onUnbind: unbindBinding}),
    [startRebind, resetBinding, unbindBinding],
  )

  const openSettings = useCallback(() => {
    shortcutHelpToggle.close()
    void runActionById(openKeybindingsSettingsAction.id, new CustomEvent('shortcut-help-settings'))
  }, [])

  const bindings = model?.bindings ?? NO_BINDINGS
  const capture = useMemo<CaptureMode | null>(
    () => (capturing ? {onChord: commitRebind, onCancel: cancelRebind} : null),
    [capturing, commitRebind, cancelRebind],
  )
  const {state, selectBinding} = useKeyInspector(open, bindings, shortcutHelpToggle.close, capture)

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

  const status = capturing ? (
    <span>Recording a shortcut for <span className="font-medium">{capturing.description}</span> — press a combo, Esc to cancel</span>
  ) : state.partial ? (
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
        {state.matches && (
          <MatchPanel
            matches={state.matches}
            capturing={capturing}
            partial={state.partial}
            overriddenKeys={overriddenKeys}
            actions={overrideActions}
            onCancelCapture={cancelRebind}
          />
        )}
        {notice && (
          <NoticeBanner
            notice={notice}
            onReset={resetBinding}
            onOpenSettings={openSettings}
            onDismiss={() => setNotice(null)}
          />
        )}
        <div className="min-w-0 max-h-[60vh] overflow-y-auto sm:columns-2 sm:gap-6">
          {visibleGroups.map(group => (
            <ContextGroupSection key={group.config.type} group={group} onSelect={selectBinding}/>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
