/**
 * Property editor for `keybindings:overrides`.
 *
 * Lists every action the runtime knows about, grouped by context.
 * Each row shows the action's current effective binding (taking the
 * unsaved `value` into account, not just the runtime-committed state)
 * with edit / reset / disable affordances. A separate section at the
 * bottom collects actions whose effective binding is undefined — the
 * user can assign a chord there to give the action a shortcut.
 *
 * The editor is purely a view over `value` + the action registry: every
 * mutation calls `onChange(nextValue)` which writes the prefs block.
 * The subscription effect then mirrors the new value into the cache
 * and dispatches `refreshAppRuntime`, after which `HotkeyReconciler`
 * picks up the new bindings via the next `getEffectiveActions` pass.
 */
import {useCallback, useMemo, useState} from 'react'
import {Pencil, RotateCcw, X, Plus, AlertTriangle} from 'lucide-react'
import type {PropertyEditorProps} from '@/data/api'
import {Button} from '@/components/ui/button.js'
import {Input} from '@/components/ui/input.js'
import {Kbd} from '@/components/ui/kbd.js'
import {useAppRuntime} from '@/extensions/runtimeContext.js'
import {actionContextsFacet} from '@/extensions/core.js'
import {getActionsBeforeKeybindingOverrides} from '@/shortcuts/effectiveActions.js'
import {applyKeybindingOverrides} from '@/shortcuts/applyKeybindingOverrides.js'
import {findKeybindingConflicts} from '@/shortcuts/keybindingConflicts.js'
import type {
  ActionConfig,
  ActionContextConfig,
  ActionContextType,
} from '@/shortcuts/types.js'
import {KeyCaptureInput} from './KeyCaptureInput.tsx'
import {formatChord, normalizeChord} from './keyCapture.ts'
import {
  overrideEntryKey,
  type StoredKeybindingOverrides,
} from './config.ts'
import {
  toFacetOverrides,
  withRemovedOverride,
  withReplacedOverride,
} from './overrideStore.ts'

const chordOf = (action: ActionConfig): string | null => {
  const binding = action.defaultBinding
  if (!binding) return null
  return Array.isArray(binding.keys) ? binding.keys[0] ?? null : binding.keys
}

const isOverridden = (
  stored: StoredKeybindingOverrides,
  actionId: string,
  context: ActionContextType,
): boolean => {
  const key = overrideEntryKey(context, actionId)
  return stored.some(e => overrideEntryKey(e.context, e.actionId) === key)
}

interface CapturingState {
  actionId: string
  context: ActionContextType
  pending: string | null
}

export const KeybindingsEditor = ({value, onChange}: PropertyEditorProps<StoredKeybindingOverrides>) => {
  const runtime = useAppRuntime()
  const contextConfigs = useMemo(() => runtime.read(actionContextsFacet), [runtime])
  // Contexts dispatched some way other than the keyboard (e.g. block-pointer,
  // fired by pointer gestures) declare keyboardBindable: false. Their actions
  // have no keyboard binding and must never appear in this editor as assignable
  // — an assigned chord would be a dead binding and would pollute conflict
  // detection. Drop them before anything downstream sees them.
  const nonBindableContexts = useMemo(() => {
    const set = new Set<ActionContextType>()
    for (const c of contextConfigs) if (c.keyboardBindable === false) set.add(c.type)
    return set
  }, [contextConfigs])
  const baseActions = useMemo(
    () => getActionsBeforeKeybindingOverrides(runtime).filter(a => !nonBindableContexts.has(a.context)),
    [runtime, nonBindableContexts],
  )
  const contextDisplay = useMemo(() => {
    const map = new Map<ActionContextType, string>()
    for (const c of contextConfigs) map.set(c.type, c.displayName)
    return map
  }, [contextConfigs])

  const facetEntries = useMemo(() => toFacetOverrides(value), [value])
  const previewActions = useMemo(
    () => applyKeybindingOverrides(baseActions, facetEntries),
    [baseActions, facetEntries],
  )
  const conflicts = useMemo(() => findKeybindingConflicts(previewActions), [previewActions])
  const conflictChordsByAction = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const conflict of conflicts) {
      for (const p of conflict.actions) {
        const key = overrideEntryKey(p.context, p.actionId)
        const set = map.get(key) ?? new Set<string>()
        set.add(conflict.chord)
        map.set(key, set)
      }
    }
    return map
  }, [conflicts])

  const [search, setSearch] = useState('')
  const [capturing, setCapturing] = useState<CapturingState | null>(null)

  const matchesSearch = useCallback(
    (action: ActionConfig) => {
      const q = search.trim().toLowerCase()
      if (!q) return true
      return (
        action.id.toLowerCase().includes(q) ||
        action.description.toLowerCase().includes(q)
      )
    },
    [search],
  )

  const sections = useMemo(() => {
    const withBinding: ActionConfig[] = []
    const withoutBinding: ActionConfig[] = []
    for (const action of previewActions) {
      if (!matchesSearch(action)) continue
      if (action.defaultBinding) withBinding.push(action)
      else withoutBinding.push(action)
    }

    const groups = new Map<ActionContextType, ActionConfig[]>()
    for (const action of withBinding) {
      const bucket = groups.get(action.context) ?? []
      bucket.push(action)
      groups.set(action.context, bucket)
    }
    for (const bucket of groups.values()) {
      bucket.sort((a, b) => a.description.localeCompare(b.description))
    }
    withoutBinding.sort((a, b) => a.description.localeCompare(b.description))

    return {groups, withoutBinding}
  }, [previewActions, matchesSearch])

  const handleStartCapture = useCallback((action: ActionConfig) => {
    setCapturing({actionId: action.id, context: action.context, pending: null})
  }, [])

  const handleCancelCapture = useCallback(() => setCapturing(null), [])

  const handleCaptureChord = useCallback(
    (chord: string) => {
      if (!capturing) return
      const normalized = normalizeChord(chord)
      onChange(withReplacedOverride(value, {
        actionId: capturing.actionId,
        context: capturing.context,
        binding: {keys: normalized},
      }))
      setCapturing(null)
    },
    [capturing, onChange, value],
  )

  const handlePartialChord = useCallback((chord: string | null) => {
    setCapturing(prev => (prev ? {...prev, pending: chord} : prev))
  }, [])

  const handleReset = useCallback(
    (actionId: string, context: ActionContextType) => {
      onChange(withRemovedOverride(value, actionId, context))
    },
    [onChange, value],
  )

  const handleDisable = useCallback(
    (actionId: string, context: ActionContextType) => {
      onChange(withReplacedOverride(value, {
        actionId,
        context,
        binding: {unbound: true},
      }))
    },
    [onChange, value],
  )

  return (
    <div className="space-y-4">
      <Input
        value={search}
        onChange={event => setSearch(event.target.value)}
        placeholder="Filter actions…"
      />

      {[...sections.groups.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([context, actions]) => (
          <Section
            key={context}
            title={contextDisplay.get(context) ?? context}
          >
            {actions.map(action => (
              <ActionRow
                key={overrideEntryKey(action.context, action.id)}
                action={action}
                chord={chordOf(action)}
                overridden={isOverridden(value, action.id, action.context)}
                conflictChords={conflictChordsByAction.get(overrideEntryKey(action.context, action.id))}
                capturing={
                  capturing?.actionId === action.id && capturing.context === action.context
                    ? capturing
                    : null
                }
                onStartCapture={() => handleStartCapture(action)}
                onCaptureChord={handleCaptureChord}
                onPartial={handlePartialChord}
                onCancelCapture={handleCancelCapture}
                onReset={() => handleReset(action.id, action.context)}
                onDisable={() => handleDisable(action.id, action.context)}
              />
            ))}
          </Section>
        ))}

      {sections.withoutBinding.length > 0 && (
        <Section title="Without shortcut">
          {sections.withoutBinding.map(action => (
            <ActionRow
              key={overrideEntryKey(action.context, action.id)}
              action={action}
              chord={null}
              overridden={isOverridden(value, action.id, action.context)}
              conflictChords={undefined}
              capturing={
                capturing?.actionId === action.id && capturing.context === action.context
                  ? capturing
                  : null
              }
              onStartCapture={() => handleStartCapture(action)}
              onCaptureChord={handleCaptureChord}
              onPartial={handlePartialChord}
              onCancelCapture={handleCancelCapture}
              onReset={() => handleReset(action.id, action.context)}
              onDisable={() => handleDisable(action.id, action.context)}
              variant="empty"
              contextLabel={contextDisplay.get(action.context) ?? action.context}
            />
          ))}
        </Section>
      )}
    </div>
  )
}

interface SectionProps {
  title: string
  children: React.ReactNode
}

const Section = ({title, children}: SectionProps) => (
  <section className="space-y-1">
    <h3 className="text-xs font-semibold uppercase text-muted-foreground">{title}</h3>
    <div className="divide-y divide-border/40 rounded border border-border/40">
      {children}
    </div>
  </section>
)

interface ActionRowProps {
  action: ActionConfig
  chord: string | null
  overridden: boolean
  conflictChords: ReadonlySet<string> | undefined
  capturing: CapturingState | null
  variant?: 'empty'
  contextLabel?: string
  onStartCapture: () => void
  onCaptureChord: (chord: string) => void
  onPartial: (chord: string | null) => void
  onCancelCapture: () => void
  onReset: () => void
  onDisable: () => void
}

const ActionRow = ({
  action,
  chord,
  overridden,
  conflictChords,
  capturing,
  variant,
  contextLabel,
  onStartCapture,
  onCaptureChord,
  onPartial,
  onCancelCapture,
  onReset,
  onDisable,
}: ActionRowProps) => {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 truncate text-sm">
          <span className="truncate">{action.description}</span>
          {variant === 'empty' && contextLabel && (
            <span className="text-xs text-muted-foreground">· {contextLabel}</span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">{action.id}</div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {capturing ? (
          <KeyCaptureInput
            pending={capturing.pending}
            onCapture={onCaptureChord}
            onPartial={onPartial}
            onCancel={onCancelCapture}
          />
        ) : (
          <>
            {chord ? (
              <Kbd>{formatChord(chord)}</Kbd>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
            {conflictChords && conflictChords.size > 0 && (
              <span
                className="inline-flex items-center text-amber-600"
                title={`Shadows in ${[...conflictChords].map(formatChord).join(', ')} — both will run`}
              >
                <AlertTriangle className="h-3.5 w-3.5"/>
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onStartCapture}
              title={variant === 'empty' ? 'Add binding' : 'Change binding'}
            >
              {variant === 'empty' ? <Plus className="h-3.5 w-3.5"/> : <Pencil className="h-3.5 w-3.5"/>}
            </Button>
            {overridden && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onReset}
                title="Reset to default"
              >
                <RotateCcw className="h-3.5 w-3.5"/>
              </Button>
            )}
            {chord && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onDisable}
                title="Disable shortcut"
              >
                <X className="h-3.5 w-3.5"/>
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// Lint: unused but kept exported in case test harness wants to render
// against the discovered context-config list directly.
export type {ActionContextConfig}
