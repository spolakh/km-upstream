/**
 * Read/write helpers for the per-user keybinding overrides block.
 *
 * The keybindings-settings plugin owns the storage format
 * (`keybindingOverridesProp` on the per-user prefs sub-block). Anything
 * that wants to remap an action — the settings editor, the shortcut-help
 * overlay's inline "Rebind…" — goes through here rather than reaching
 * for the prefs block and codec directly, so the storage shape and the
 * storage↔facet mapping live in one place.
 *
 * Pure transforms (`withReplacedOverride`, `withRemovedOverride`) compose
 * the next stored array; the async helpers resolve the prefs block and
 * apply the transform inside `block.set`'s updater, which reads the
 * committed value INSIDE the serialized write-tx so two concurrent
 * single-action edits compose instead of clobbering each other.
 */
import type {Repo} from '@/data/repo.js'
import {getPluginPrefsBlock} from '@/data/stateBlocks.js'
import {applyKeybindingOverrides} from '@/shortcuts/applyKeybindingOverrides.js'
import {
  findKeybindingConflicts,
  type KeybindingConflict,
} from '@/shortcuts/keybindingConflicts.js'
import {
  KEYBINDING_OVERRIDE_USER_SOURCE,
  type KeybindingOverride,
} from '@/shortcuts/keybindingOverrides.js'
import type {ActionConfig, ActionContextType} from '@/shortcuts/types.js'
import {
  keybindingOverridesProp,
  keybindingsPrefsType,
  overrideEntryKey,
  type StoredKeybindingOverride,
  type StoredKeybindingOverrides,
} from './config.ts'

// ──── storage ↔ facet mapping ────

/** One stored entry as the facet contribution the apply-overrides pass
 *  consumes. The settings plugin's overrides are always user-source. */
export const toFacetOverride = (entry: StoredKeybindingOverride): KeybindingOverride => ({
  actionId: entry.actionId,
  context: entry.context,
  binding: entry.binding,
  source: KEYBINDING_OVERRIDE_USER_SOURCE,
})

export const toFacetOverrides = (
  stored: StoredKeybindingOverrides,
): readonly KeybindingOverride[] => stored.map(toFacetOverride)

// ──── pure transforms over the stored array ────

/** Replace (or add) the entry for one (context, actionId), keeping the
 *  rest. A row is addressed by the composite key so two contexts can
 *  hold overrides for the same action id. */
export const withReplacedOverride = (
  stored: StoredKeybindingOverrides,
  next: StoredKeybindingOverride,
): StoredKeybindingOverrides => {
  const key = overrideEntryKey(next.context, next.actionId)
  const filtered = stored.filter(e => overrideEntryKey(e.context, e.actionId) !== key)
  return [...filtered, next]
}

/** Drop the entry for one (context, actionId) — reset-to-default. */
export const withRemovedOverride = (
  stored: StoredKeybindingOverrides,
  actionId: string,
  context: ActionContextType,
): StoredKeybindingOverrides => {
  const key = overrideEntryKey(context, actionId)
  return stored.filter(e => overrideEntryKey(e.context, e.actionId) !== key)
}

// ──── conflict preview ────

/** Conflicts the proposed override would introduce, filtered to the ones
 *  the proposed action participates in. `baseActions` are the actions
 *  BEFORE overrides (`getActionsBeforeKeybindingOverrides`); `stored` is
 *  the current user override set. Advisory: plugin-source overrides
 *  aren't modelled here (they're rare), so this reflects user-vs-user and
 *  user-vs-default clashes — the ones a manual rebind actually creates. */
export const previewOverrideConflicts = (
  baseActions: readonly ActionConfig[],
  stored: StoredKeybindingOverrides,
  proposed: StoredKeybindingOverride,
): readonly KeybindingConflict[] => {
  const preview = applyKeybindingOverrides(
    baseActions,
    toFacetOverrides(withReplacedOverride(stored, proposed)),
  )
  return findKeybindingConflicts(preview).filter(conflict =>
    conflict.actions.some(
      a => a.actionId === proposed.actionId && a.context === proposed.context,
    ),
  )
}

// ──── async I/O against the prefs block ────

const resolvePrefsBlock = async (repo: Repo) => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) {
    throw new Error('keybinding overrides require an active workspace')
  }
  return getPluginPrefsBlock(repo, workspaceId, repo.user, keybindingsPrefsType)
}

/** Bind (or rebind) one action, persisting to the user's prefs block. */
export const setKeybindingOverride = async (
  repo: Repo,
  entry: StoredKeybindingOverride,
): Promise<void> => {
  const block = await resolvePrefsBlock(repo)
  await block.set(keybindingOverridesProp, current =>
    withReplacedOverride(current ?? [], entry),
  )
}

/** Clear an action's override, restoring its default binding. */
export const removeKeybindingOverride = async (
  repo: Repo,
  actionId: string,
  context: ActionContextType,
): Promise<void> => {
  const block = await resolvePrefsBlock(repo)
  await block.set(keybindingOverridesProp, current =>
    withRemovedOverride(current ?? [], actionId, context),
  )
}

/** Read the user's currently-stored overrides (defaults to empty; a
 *  malformed snapshot surfaces as a throw the caller can catch). */
export const readStoredOverrides = async (
  repo: Repo,
): Promise<StoredKeybindingOverrides> => {
  const block = await resolvePrefsBlock(repo)
  return block.peekProperty(keybindingOverridesProp) ?? []
}
