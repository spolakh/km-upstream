// Curated public surface for extension blocks. An extension can do
//
//   import * as km from '@/extensions/api.js'
//
// to discover everything it needs in one shot, or pull individual
// symbols by name. The blob-URL extension modules resolve `@/...`
// through the page-global importmap, so what they import is the same
// module instance the running app uses.
//
// Authors are not constrained to this surface — direct imports from
// any `@/...` path work too. This module is the convention, not a
// fence; it exists to make discovery cheap (`Object.keys(km)`) and to
// give the agent bridge an answer to "what's in the box?".

// --- Facet primitives ---
export {
  defineFacet,
  isFunction,
  combineLastContributionResult,
  resolveLastContributionResult,
  type AppExtension,
  type Facet,
  type FacetContribution,
  type FacetContributionOptions,
  type FacetResolveContext,
  type FacetRuntime,
  type OptionalContributionResult,
} from '@/facets/facet.js'

// --- Runtime toggle types (full surface lives in @/facets/togglable.ts) ---
export type { Togglable } from '@/facets/togglable.js'
export {
  defineVariantFacet,
  defineVariant,
  type Variant,
  type VariantContribution,
  type VariantResolver,
  type VariantSelection,
} from '@/facets/variantFacet.js'

// --- Verb facet helper (observe / wrap / replace a single typed verb) ---
export {
  defineVerbFacet,
  type VerbFacet,
  type VerbImpl,
  type VerbDecorator,
  type VerbBefore,
  type VerbAfter,
  type VerbOutcome,
} from '@/facets/verbFacet.js'

// --- Blessed core facets ---
export {
  actionTransformsFacet,
  actionsFacet,
  actionContextsFacet,
  appEffectsFacet,
  appMountsFacet,
  blockRenderersFacet,
  createRendererRegistry,
  headerItemsFacet,
  panelMountsFacet,
  type AppEffect,
  type AppEffectCleanup,
  type AppEffectContext,
  type AppMountContribution,
  type HeaderItemContribution,
  type HeaderItemRegion,
  type PanelMountContribution,
  type RendererContribution,
} from '@/extensions/core.js'

// DefaultBlockRenderer (the default block chrome — bullet, children,
// properties, edit affordances) is intentionally NOT re-exported here:
// it pulls in radix-ui's Dialog/ContextMenu, which transitively
// imports react-dom. Extension blocks resolve react-dom through the
// page-global importmap, but importing this API surface in vitest
// should not force that heavier renderer tree to load.
//
// Extension authors should import it directly:
//   import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'

// --- Block-interaction facets (click handlers, content renderers, content-surface props, shortcut activations) ---
export {
  blockChildrenFooterFacet,
  blockClickHandlersFacet,
  blockContentDecoratorsFacet,
  blockContentRendererFacet,
  blockContentSurfacePropsFacet,
  blockHeaderFacet,
  blockLayoutFacet,
  shortcutSurfaceActivationsFacet,
  enterBlockEditMode,
  getBlockContentRendererSlot,
  isSelectionClick,
  type BlockChildrenFooterContribution,
  type BlockClickContribution,
  type BlockHeaderContribution,
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
  type BlockContentRendererContribution,
  type BlockContentRendererSlot,
  type BlockContentSurfaceContribution,
  type BlockContentSurfaceProps,
  type BlockInteractionContext,
  type BlockResolveContext,
  type BlockLayout,
  type BlockLayoutContribution,
  type BlockLayoutSlots,
  type BlockShellProps,
  type ShortcutActivationContribution,
  type ShortcutSurfaceContext,
} from '@/extensions/blockInteraction.js'

// --- Markdown rendering pipeline ---
export { markdownExtensionsFacet } from '@/markdown/extensions.js'

// --- Paste decision seam (override how clipboard content lands: split into
// an outline vs drop as a single block, optionally rewriting the text) ---
export {
  pasteDecisionVerb,
  defaultPasteDecision,
  type PasteDecision,
  type PasteRequest,
  type PasteSurface,
} from '@/paste/decision.js'

// --- Navigation seams, two layers ---
// Intent policy (`navigationIntentVerb`): remap the gesture→target mapping —
// the modifier matrix, the follow-link/navigator role, or where global commands
// land (active vs main). Execution (`navigationVerb`): observe / rewrite (by
// target / origin / block) / veto / replace the act of going to a block —
// analytics, confirm-before-leave, retarget by block type.
export {
  navigationVerb,
  navigationIntentVerb,
  defaultNavigationIntent,
  // Build/transform an intent policy's `NavigationDecision`.
  goTo,
  PASSTHROUGH,
  SUPPRESS,
  mapNavigate,
  navigate,
  useNavigate,
  navigateFromGesture,
  navigateFromGlobalCommand,
  useNavigateFromGlobalCommand,
  // The standard way to wire a clickable surface that opens a block (links,
  // buttons, map pins, list rows) — modifier-aware, routed through the policy.
  useOpenBlock,
  useBlockOpener,
  // Route a resolved decision onto a click (gate `preventDefault`) — for custom
  // surfaces that resolve the gesture themselves.
  applyNavigationDecision,
  type NavigateInput,
  type NavigationDecision,
  type ResolvedNavigateInput,
  type GlobalCommandNavigateInput,
  type NavigationRequest,
  type NavigationResult,
  type NavigationGesture,
  type NavigationRole,
  type NavigationViewport,
  type BlockOpenerPlainClick,
  type BlockOpenerOptions,
  type OpenBlockContext,
} from '@/utils/navigation.js'

// --- Action / shortcut helpers ---
export {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextConfig,
  type ActionContextType,
  type Action,
  type ActionTransform,
  type ShortcutBinding,
  type KeyCombination,
} from '@/shortcuts/types.js'
export {
  actionRuntimeKey,
  getActiveActionById,
  getEffectiveActions,
} from '@/shortcuts/effectiveActions.js'
// --- Action-dispatch seam ---
// Middleware around action INVOCATION (observe / guard-veto / wrap / globally
// redirect a command as it runs) — distinct from `actionTransformsFacet`, which
// rewrites action DEFINITIONS at compile time. Built on `defineVerbFacet`'s
// passthrough sync runner. Contribute `actionDispatchWrap({actionId, context?,
// wrap})` for a per-action handler wrap, or `actionDispatchVerb.before/after`
// observers for telemetry. See `docs/action-dispatch-seam.md`.
export {
  actionDispatchVerb,
  actionDispatchWrap,
  invokeAction,
  type ActionInvocation,
  type ActionDispatchDecorator,
  type ActionHandlerWrap,
} from '@/shortcuts/actionDispatch.js'
export {
  bindBlockActionContext,
  createSharedBlockActions,
  extendSelectionDown,
  extendSelectionUp,
} from '@/shortcuts/blockActions.js'

// --- Block / data primitives ---
export { Block } from '../data/block'
export { Repo } from '../data/repo'
export {
  getLayoutSessionBlock,
  getPluginPrefsBlock,
  getPluginUIStateBlock,
  getUserBlock,
  getUserPrefsBlock,
} from '@/data/stateBlocks.js'
// PropertySchema authoring — extensions define their own typed
// properties via `defineProperty` from the data-layer api.
export { defineBlockType, defineProperty, definePropertyEditorOverride, codecs, ChangeScope, INFRASTRUCTURE_TYPE_DISPLAY } from '@/data/api'
export type {
  BlockData,
  Codec,
  PropertyEditorOverride,
  PropertyEditorProps,
  PropertySchema,
  TypeContribution,
} from '@/data/api'
export { propertyEditorOverridesFacet, propertySchemasFacet, typesFacet } from '@/data/facets.js'
export {
  // System UI-state props extensions might want to read/write
  isCollapsedProp,
  showPropertiesProp,
  topLevelBlockIdProp,
  focusedBlockLocationProp,
  // Atomic focus + edit transition (single primitive — `setFocusedBlockId`
  // and `setIsEditing` were removed in favor of this).
  focusBlock,
} from '@/data/properties.js'
export type { FocusedBlockLocation } from '@/data/properties.js'
export type {
  BlockRenderer,
  BlockRendererProps,
  BlockContextType,
} from '@/types.js'

export { pluginBlockId } from '@/extensions/pluginIds.js'

// React hook for accessing the live Repo from inside an
// `appMountsFacet` component. Action handlers receive `repo` through
// `uiStateBlock.repo`; components rendered inside the app tree should
// use this hook instead so they participate in the same Repo
// instance + context the rest of the app uses.
export { useRepo } from '@/context/repo.js'

// Imperative dialog primitive. Renders `Component` and returns a
// promise that resolves with the user's choice (or `null` on
// cancel). The dialog component receives `resolve(value)` /
// `cancel()` as props. Use this from action handlers when an
// `appMountsFacet`-mounted persistent dialog is overkill.
export { openDialog } from '@/utils/dialogs.js'
export type { DialogComponent, DialogContextProps } from '@/utils/dialogs.js'

// User-feedback primitives. Prefer these over `window.alert` /
// `window.confirm` — they match the app's theme, queue cleanly, and
// `showProgress` is genuinely the right shape for long-running syncs
// (returns a `{update, done, fail}` handle for incremental updates +
// terminal resolution).
export {
  showError,
  showInfo,
  showSuccess,
  showProgress,
  showCustom,
  dismissToast,
} from '@/utils/toast.js'
export type { ProgressToast, ToastAction, ToastOptions } from '@/utils/toast.js'

// Fractional-index order keys for inserting blocks at deterministic
// positions among siblings. `keyAtEnd(lastChild.orderKey)` for "append
// to children"; `keysBetween(prev, next, count)` for "insert N items
// between these two existing siblings".
export {
  keyAtEnd,
  keyAtStart,
  keyBetween,
  keysBetween,
} from '@/data/orderKey.js'
