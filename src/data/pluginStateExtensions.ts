/** Bundling helpers for plugin-owned prefs / ui-state sub-blocks.
 *
 *  Each plugin that owns a per-user pref sub-block or a per-device
 *  ui-state sub-block declares it as a `TypeContribution` and registers
 *  via one of the helpers below. The helpers pair the `typesFacet`
 *  registration with an idle-time eager-bootstrap `AppEffect` so the
 *  sub-block exists before the user navigates to the Preferences /
 *  ui-state tree — without this, plugin sub-blocks would only appear
 *  after their hooks run for the first time, making configurable
 *  options non-discoverable.
 */

import { INFRASTRUCTURE_TYPE_DISPLAY, type TypeContribution } from '@/data/api'
import { typesFacet } from '@/data/facets.js'
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { getPluginPrefsBlock, getPluginUIStateBlock } from '@/data/stateBlocks.js'
import { scheduleDeepIdle, LAZY_DEEP_IDLE } from '@/utils/scheduleIdle.js'

// These sub-blocks only need to exist before the user navigates to Preferences /
// the ui-state tree (and a hook lazily creates them on first use anyway), so the
// eager bootstrap is pure convenience — defer it to genuine idle, never near boot.
const pluginPrefsBootstrapEffect = (type: TypeContribution): AppEffect => ({
  id: `plugin-prefs.${type.id}.bootstrap`,
  start: ({repo, workspaceId}) => {
    scheduleDeepIdle(() => {
      void getPluginPrefsBlock(repo, workspaceId, repo.user, type)
    }, LAZY_DEEP_IDLE)
  },
})

const pluginUIStateBootstrapEffect = (type: TypeContribution): AppEffect => ({
  id: `plugin-ui-state.${type.id}.bootstrap`,
  start: ({repo, workspaceId}) => {
    scheduleDeepIdle(() => {
      void getPluginUIStateBlock(repo, workspaceId, repo.user, type)
    }, LAZY_DEEP_IDLE)
  },
})

/** Bundle a plugin-prefs `TypeContribution` registration with an
 *  idle-time eager-bootstrap effect. Spread the returned array into the
 *  plugin's `AppExtension`:
 *
 *      export const myPlugin: AppExtension = [
 *        ...pluginPrefsExtension(myPrefsType, 'my-plugin'),
 *        // …other facet contributions…
 *      ]
 */
export const pluginPrefsExtension = (
  type: TypeContribution,
  source: string,
): readonly AppExtension[] => [
  // Prefs containers are plumbing, not tags — stamp the infrastructure
  // display flags so the tagging UX (# autocomplete, tag chips) never
  // surfaces them.
  typesFacet.of({...type, ...INFRASTRUCTURE_TYPE_DISPLAY}, {source}),
  appEffectsFacet.of(pluginPrefsBootstrapEffect(type), {source}),
]

/** Same as `pluginPrefsExtension`, for sub-blocks under the root
 *  ui-state subtree (scoped via ChangeScope.UiState — non-undoable but
 *  still synced). */
export const pluginUIStateExtension = (
  type: TypeContribution,
  source: string,
): readonly AppExtension[] => [
  // UI-state containers are plumbing, not tags — see pluginPrefsExtension.
  typesFacet.of({...type, ...INFRASTRUCTURE_TYPE_DISPLAY}, {source}),
  appEffectsFacet.of(pluginUIStateBootstrapEffect(type), {source}),
]
