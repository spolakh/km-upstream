/**
 * Subscribes to the keybindings prefs block and mirrors its
 * contents into the `keybindingOverridesFacet` via
 * `runtime.setRuntimeContributions`. No localStorage cache, no
 * `refreshAppRuntime` dispatch — the facet's per-facet change
 * listener (subscribed in `HotkeyReconciler`) is what triggers the
 * downstream recompute. First paint shows defaults until the prefs
 * block hydrates and this effect runs; that's intentional (keeps the
 * code small and avoids a second source of truth).
 *
 * Codec failures decode to `[]` here so a malformed snapshot falls
 * back to "no overrides" rather than locking the user out of
 * editing.
 */
import type {AppEffect} from '@/extensions/core.js'
import {getPluginPrefsBlock} from '@/data/stateBlocks.js'
import type {FacetRuntime} from '@/facets/facet.js'
import type {PropertySchema} from '@/data/api'
import {
  KEYBINDING_OVERRIDE_USER_SOURCE,
  keybindingOverridesFacet,
} from '@/shortcuts/keybindingOverrides.js'
import {
  keybindingOverridesProp,
  keybindingsPrefsType,
  type StoredKeybindingOverrides,
} from './config.ts'
import {toFacetOverride} from './overrideStore.ts'

interface OverridesReadable {
  peekProperty<T>(schema: PropertySchema<T>): T | undefined
}

export const readOverridesFromBlock = (block: OverridesReadable): StoredKeybindingOverrides => {
  try {
    return block.peekProperty(keybindingOverridesProp) ?? []
  } catch (error) {
    console.error(
      'Keybindings: overrides property is malformed; ' +
      'falling back to "no overrides". Repair via settings or manually edit ' +
      'the Keyboard shortcuts block.',
      error,
    )
    return []
  }
}

/** Push the stored overrides into the facet's runtime bucket. The
 *  facet runtime invalidates its cache and fires per-facet listeners,
 *  which `HotkeyReconciler` listens to and uses to re-run
 *  `getEffectiveActions`. */
export const pushOverridesToRuntime = (
  runtime: FacetRuntime,
  stored: StoredKeybindingOverrides,
): void => {
  runtime.setRuntimeContributions(
    keybindingOverridesFacet,
    KEYBINDING_OVERRIDE_USER_SOURCE,
    stored.map(toFacetOverride),
  )
}

export const keybindingsSyncEffect: AppEffect = {
  id: 'keybindings.sync-runtime',
  start: ({repo, runtime, workspaceId}) => {
    let disposed = false
    let unsubscribe: (() => void) | undefined

    void (async () => {
      const block = await getPluginPrefsBlock(
        repo,
        workspaceId,
        repo.user,
        keybindingsPrefsType,
      )
      if (disposed) return

      const push = () => pushOverridesToRuntime(runtime, readOverridesFromBlock(block))
      push()
      unsubscribe = block.subscribe(push)
    })().catch(error => {
      console.error(
        'Keybindings: failed to resolve prefs block; ' +
        'overrides will not sync until next session.',
        error,
      )
    })

    return () => {
      disposed = true
      unsubscribe?.()
      // Drop our runtime bucket on shutdown so the next effect-start
      // doesn't see a stale snapshot. setRuntimeContributions with []
      // removes the source bucket entirely.
      runtime.setRuntimeContributions(
        keybindingOverridesFacet,
        KEYBINDING_OVERRIDE_USER_SOURCE,
        [],
      )
    }
  },
}
