export type AuthoringCatalogSource =
  | 'generated-api'
  | 'generated-module-glob'
  | 'html-importmap'
  | 'html-preload'
  | 'html-entry'

export interface AuthoringModuleSummary {
  importPath: string
  category: string
  description: string
  exports?: string[]
  source: AuthoringCatalogSource
  safeForExtensions?: boolean
}

export interface AuthoringComponentSummary {
  name: string
  importPath: string
  category: string
  description: string
  exports: string[]
  source: AuthoringCatalogSource
}

export interface AuthoringExample {
  label: string
  code: string
}

export interface AuthoringStoragePattern {
  id: string
  when: string
  use: string
  modules: string[]
  example?: AuthoringExample
}

export interface AuthoringStorageGuide {
  principles: string[]
  patterns: AuthoringStoragePattern[]
  credentials: {
    rule: string
    currentAffordance: string
    example?: AuthoringExample
  }
}

export interface AuthoringGuide {
  id: string
  title: string
  when: string[]
  principles: string[]
  steps: string[]
  preferredModules: string[]
  relatedFacets: string[]
  commands: string[]
  /** Worked code snippets that demonstrate the canonical pattern.
   *  Read these before falling back to copying from another extension —
   *  they are kept in sync with the public API surface. */
  examples?: AuthoringExample[]
  /** Notes the agent should act on *after* `install-extension`
   *  returns. Currently used to call out the disabled-by-default
   *  behaviour for user-installed extensions. */
  afterInstall?: string[]
}

export interface AuthoringCatalog {
  guides: AuthoringGuide[]
  storage: AuthoringStorageGuide
  modules: AuthoringModuleSummary[]
  components: AuthoringComponentSummary[]
}

export interface AuthoringCatalogFilters {
  guides?: string[]
  modules?: string[]
  components?: string[]
  /** When true, omit modules and components entirely. The
   *  guide-only / `--brief` path uses this to keep the response
   *  small — module/component glob dumps are 150KB of paths the
   *  agent doesn't need while reading a guide. */
  omitDiscoverableModules?: boolean
}

interface ApiSurfaceLike {
  module: string
  exports: string[]
}

type RuntimeModule = Record<string, unknown>

const internalModuleIndex = import.meta.glob([
  '/src/components/**/*.{ts,tsx}',
  '/src/data/**/*.{ts,tsx}',
  '/src/extensions/**/*.{ts,tsx}',
  '/src/hooks/**/*.{ts,tsx}',
  '/src/markdown/**/*.{ts,tsx}',
  '/src/plugins/**/*.{ts,tsx}',
  '/src/shortcuts/**/*.{ts,tsx}',
  '/src/utils/**/*.{ts,tsx}',
  '!/src/**/*.test.{ts,tsx}',
  '!/src/**/test/**/*.{ts,tsx}',
])

const eagerUiModules = import.meta.glob('/src/components/ui/*.{ts,tsx}', {
  eager: true,
}) as Record<string, RuntimeModule>

const storageGuide: AuthoringStorageGuide = {
  principles: [
    'Store plugin configuration and sync state in system blocks whenever possible.',
    'Use typed properties with ChangeScope.UserPrefs for per-user preferences and ChangeScope.BlockDefault for workspace/content data.',
    'Use `pluginBlockId(workspaceId, NAMESPACE, key)` for plugin-owned singleton blocks so upserts are idempotent across reinstalls.',
    'Use deterministic external-id properties on imported records so sync plugins can upsert instead of duplicating data.',
    'Keep credentials in `window.localStorage`, scoped under a `knowledge-medium:<plugin>:...` key. Never echo token values through bridge output.',
  ],
  patterns: [
    {
      id: 'user-prefs-config',
      when: 'Per-user plugin settings, defaults, and lightweight sync checkpoints.',
      use: 'Define a TypeContribution for the plugin via `defineBlockType({id, label, properties})` and register it through `typesFacet`. Then read/write the per-plugin sub-block via `getPluginPrefsBlock(repo, workspaceId, user, type)`. Each plugin gets its own row under user-prefs, so unrelated plugins\' settings can\'t clobber each other.',
      modules: ['@/extensions/api.js'],
      example: {
        label: 'Define a prefs type and read/write a setting',
        code: [
          "import {",
          "  ChangeScope, codecs, defineBlockType, defineProperty,",
          "  getPluginPrefsBlock, typesFacet, propertySchemasFacet,",
          "} from '@/extensions/api.js'",
          "",
          "const lastSyncProp = defineProperty('readwise:lastSyncedAt', {",
          "  codec: codecs.optionalString,",
          "  defaultValue: null,",
          "  changeScope: ChangeScope.UserPrefs,",
          "})",
          "",
          "const readwisePrefsType = defineBlockType({",
          "  id: 'readwise-prefs',",
          "  label: 'Readwise',",
          "  // Prefs containers are plumbing for the # dropdown, but their",
          "  // chip is informative when the container block itself is on",
          "  // screen — hide completion only (matches the in-repo",
          "  // pluginPrefsExtension stamp).",
          "  hideFromCompletion: true,",
          "  properties: [lastSyncProp],",
          "})",
          "",
          "// In an action handler:",
          "const prefs = await getPluginPrefsBlock(repo, repo.activeWorkspaceId, repo.user, readwisePrefsType)",
          "const last = prefs.peekProperty(lastSyncProp)",
          "await prefs.set(lastSyncProp, new Date().toISOString())",
          "",
          "// Top-level facet contributions:",
          "export default [",
          "  typesFacet.of(readwisePrefsType, {source: 'readwise'}),",
          "  propertySchemasFacet.of(lastSyncProp, {source: 'readwise'}),",
          "  // ... actions, mounts, etc.",
          "]",
        ].join('\n'),
      },
    },
    {
      id: 'plugin-root-singleton',
      when: 'The plugin needs a stable workspace-scoped root block — e.g. a "Readwise Library" page that all imported books/highlights live under.',
      use: 'Hardcode a UUID v4 once as your plugin\'s namespace constant, then derive every plugin-owned id with `pluginBlockId(workspaceId, NAMESPACE, key)`. Same inputs always produce the same id, so re-running the install (or running on a fresh device) lands on the same block and your upserts stay idempotent. Use the same helper for per-record ids by passing a key like `book:${externalId}`.',
      modules: ['@/extensions/api.js'],
      example: {
        label: 'Deterministic id for a plugin root block',
        code: [
          "import { ChangeScope, pluginBlockId } from '@/extensions/api.js'",
          "",
          "// Generate ONE namespace UUID for your plugin and never change it.",
          "// (Run `crypto.randomUUID()` in any browser console.)",
          "const READWISE_NS = '0d4f1c2e-7e9a-4f4d-a4f1-2c0a3a6e7f01'",
          "",
          "// In a sync handler:",
          "const rootId = pluginBlockId(repo.activeWorkspaceId, READWISE_NS, 'library-root')",
          "const existing = await repo.load(rootId)",
          "if (!existing) {",
          "  await repo.tx(async tx => {",
          "    await tx.create({",
          "      id: rootId,                              // pin the id",
          "      workspaceId: repo.activeWorkspaceId,",
          "      parentId: null,",
          "      content: 'Readwise Library',",
          "      properties: { alias: ['Readwise Library'], types: ['page'] },",
          "    })",
          "  }, { scope: ChangeScope.BlockDefault, description: 'create readwise root' })",
          "}",
          "",
          "// Per-record ids — same helper, different key:",
          "const bookId = pluginBlockId(repo.activeWorkspaceId, READWISE_NS, `book:${userBookId}`)",
        ].join('\n'),
      },
    },
    {
      id: 'workspace-config-block',
      when: 'Workspace-visible plugin configuration or shared sync state.',
      use: 'Use a deterministic id (see `plugin-root-singleton`) for a config block, then store config as properties and child blocks. Prefer this over user-prefs when the config should sync across all of the user\'s devices and be visible to other workspace members.',
      modules: ['@/extensions/api.js'],
    },
    {
      id: 'settings-via-property-editor-override',
      when: 'Settings / configuration UI for a plugin — what a user sees when they want to change how the plugin behaves. Preferred over a modal dialog: configuration belongs *with* the block whose properties it edits, syncs naturally, and is browsable / scriptable like any other block.',
      use: 'Define a custom property editor with `definePropertyEditorOverride({name, label, Editor})` and register it via `propertyEditorOverridesFacet`. The Editor receives `PropertyEditorProps<T>` (`value`, `set`, `block`, etc.). To "open settings" from the command palette or a header item, navigate to the prefs block with `navigate(repo, {target: \'new-panel\', blockId: prefsBlock.id, workspaceId})` — the property panel renders your custom Editor inline. Reserve modal dialogs — `openDialog(Component)`, or `appMountsFacet` + a `useSyncExternalStore` visibility store — for *interactive* flows (search, picker), not for configuration.',
      modules: ['@/extensions/api.js', '@/utils/navigation.js'],
      example: {
        label: 'Custom settings UI as a property-editor override on the prefs block',
        code: [
          "import {",
          "  actionsFacet, ActionContextTypes, ChangeScope, codecs,",
          "  defineBlockType, defineProperty, definePropertyEditorOverride,",
          "  getPluginPrefsBlock, propertyEditorOverridesFacet,",
          "  propertySchemasFacet, showPropertiesProp, typesFacet,",
          "  type PropertyEditorProps,",
          "} from '@/extensions/api.js'",
          "import { navigate } from '@/utils/navigation.js'",
          "",
          "// 1. Each setting is its own typed property of the prefs block.",
          "//    ChangeScope.UserPrefs keeps them per-user (sync across the",
          "//    user's devices, not shared with other workspace members).",
          "const autoSyncProp = defineProperty<boolean>('readwise:autoSync', {",
          "  codec: codecs.boolean,",
          "  defaultValue: false,",
          "  changeScope: ChangeScope.UserPrefs,",
          "})",
          "const intervalMinutesProp = defineProperty<number>('readwise:intervalMinutes', {",
          "  codec: codecs.number,",
          "  defaultValue: 60,",
          "  changeScope: ChangeScope.UserPrefs,",
          "})",
          "",
          "const readwisePrefsType = defineBlockType({",
          "  id: 'readwise-prefs',",
          "  label: 'Readwise',",
          "  hideFromCompletion: true, // dropdown plumbing; chip stays informative",
          "  properties: [autoSyncProp, intervalMinutesProp],",
          "})",
          "",
          "// 2. Property-editor overrides — register one per property, each",
          "//    rendered inline in the property panel when the user opens",
          "//    the prefs block. For multi-field settings, you can either",
          "//    register multiple small editors (one per property) or have",
          "//    one editor read `block.peekProperty(other)` to span fields.",
          "const AutoSyncEditor = ({value, set}: PropertyEditorProps<boolean>) => (",
          "  <label>",
          "    <input",
          "      type='checkbox'",
          "      checked={value}",
          "      onChange={event => void set(event.target.checked)}",
          "    />",
          "    Auto-sync",
          "  </label>",
          ")",
          "",
          "const autoSyncUi = definePropertyEditorOverride<boolean>({",
          "  name: autoSyncProp.name,",
          "  label: 'Auto-sync',",
          "  Editor: AutoSyncEditor,",
          "})",
          "",
          "// 3. The 'open settings' action navigates to the prefs block;",
          "//    the property panel renders the Editor inline. No modal.",
          "const openSettings = {",
          "  id: 'readwise.configure',",
          "  description: 'Configure Readwise sync',",
          "  context: ActionContextTypes.GLOBAL,",
          "  handler: async ({uiStateBlock}) => {",
          "    const repo = uiStateBlock.repo",
          "    const workspaceId = repo.activeWorkspaceId",
          "    if (!workspaceId) return",
          "    const prefsBlock = await getPluginPrefsBlock(",
          "      repo, workspaceId, repo.user, readwisePrefsType,",
          "    )",
          "    // Force the property panel visible on arrival — the block's",
          "    // own content is usually empty (everything is in properties).",
          "    await prefsBlock.set(showPropertiesProp, true)",
          "    navigate(repo, {target: 'new-panel', blockId: prefsBlock.id, workspaceId})",
          "  },",
          "}",
          "",
          "// 4. Wire the contributions.",
          "export default [",
          "  typesFacet.of(readwisePrefsType, {source: 'readwise'}),",
          "  propertySchemasFacet.of(autoSyncProp, {source: 'readwise'}),",
          "  propertySchemasFacet.of(intervalMinutesProp, {source: 'readwise'}),",
          "  propertyEditorOverridesFacet.of(autoSyncUi, {source: 'readwise'}),",
          "  actionsFacet.of(openSettings, {source: 'readwise'}),",
          "]",
        ].join('\n'),
      },
    },
    {
      id: 'imported-record-blocks',
      when: 'External records such as Readwise books/highlights that should be queryable and editable as blocks.',
      use: 'Define source-id properties (`readwise:user_book_id`, `readwise:highlight_id`, …) and either upsert by id-lookup or derive the block id from the external id with `pluginBlockId(workspaceId, NAMESPACE, `book:${id}`)`. Either way, the second sync of the same record must update the existing block, not create a duplicate.',
      modules: ['@/extensions/api.js'],
      example: {
        label: 'Tx mutation primitives — create/read/update inside a transaction',
        code: [
          "import {",
          "  ChangeScope, keyAtEnd, keysBetween, pluginBlockId,",
          "} from '@/extensions/api.js'",
          "",
          "// Inside `await repo.tx(async tx => { ... }, {scope, description})`:",
          "//",
          "//   tx.get(id)                       → Promise<BlockData | null>",
          "//   tx.peek(id)                      → BlockData | null (sync, snapshot read)",
          "//   tx.create({...})                 → Promise<string> (new id, or pin via {id})",
          "//   tx.update(id, patch)             → patch is {content?, properties?, references?}",
          "//   tx.delete(id) / tx.restore(id)   → soft delete + recover",
          "//   tx.move(id, {parentId, orderKey})",
          "//   tx.childrenOf(parentId, wsId?)   → Promise<BlockData[]> (order_key ascending)",
          "//   tx.parentOf(childId)             → Promise<BlockData | null>",
          "",
          "// Idempotent upsert by deterministic id:",
          "const READWISE_NS = '0d4f1c2e-7e9a-4f4d-a4f1-2c0a3a6e7f01'",
          "",
          "await repo.tx(async tx => {",
          "  const rootId = pluginBlockId(repo.activeWorkspaceId, READWISE_NS, 'library-root')",
          "  const existingRoot = await tx.get(rootId)",
          "  if (!existingRoot) {",
          "    await tx.create({",
          "      id: rootId,                                  // pin",
          "      workspaceId: repo.activeWorkspaceId,",
          "      parentId: null,",
          "      content: 'Readwise Library',",
          "      properties: { alias: ['Readwise Library'], types: ['page'] },",
          "    })",
          "  }",
          "",
          "  // Insert N highlights as children, using order keys that sort",
          "  // between the existing last child and the end-of-list.",
          "  const children = await tx.childrenOf(rootId)",
          "  const lastKey = children.at(-1)?.orderKey ?? null",
          "  const newKeys = keysBetween(lastKey, null, highlights.length)",
          "  for (const [i, hl] of highlights.entries()) {",
          "    await tx.create({",
          "      id: pluginBlockId(repo.activeWorkspaceId, READWISE_NS, `hl:${hl.id}`),",
          "      workspaceId: repo.activeWorkspaceId,",
          "      parentId: rootId,",
          "      orderKey: newKeys[i],",
          "      content: hl.text,",
          "      properties: { 'readwise:highlight_id': String(hl.id) },",
          "    })",
          "  }",
          "}, { scope: ChangeScope.BlockDefault, description: 'readwise sync' })",
        ].join('\n'),
      },
    },
  ],
  credentials: {
    rule: 'Store credentials in `window.localStorage` under a `knowledge-medium:<plugin>:token:v1`-style key. Block-backed storage isn\'t appropriate for secrets because PowerSync ships block content to the server.',
    currentAffordance: 'Render a setup Dialog that links to the provider\'s token page, validate the token against the provider\'s auth endpoint before saving, then write it to localStorage. Never include token values in action return payloads or bridge eval output.',
    example: {
      label: 'localStorage credential read/write',
      code: [
        "const TOKEN_KEY = 'knowledge-medium:readwise:token:v1'",
        "",
        "const loadToken = () => window.localStorage.getItem(TOKEN_KEY) || null",
        "const saveToken = (t) => window.localStorage.setItem(TOKEN_KEY, t)",
        "const clearToken = () => window.localStorage.removeItem(TOKEN_KEY)",
        "",
        "// Validate before saving so a typo doesn't get silently stored:",
        "const ok = await fetch('https://readwise.io/api/v2/auth/', {",
        "  headers: { Authorization: `Token ${candidate}` },",
        "}).then(r => r.status === 204)",
        "if (ok) saveToken(candidate)",
      ].join('\n'),
    },
  },
}

const settingsDialogExample: AuthoringExample = {
  label: 'Setup dialog mounted via appMountsFacet; visibility is a typed module store flipped by an action',
  code: [
    "import {",
    "  actionsFacet, appMountsFacet, ActionContextTypes,",
    "  useRepo, showError, showSuccess,",
    "} from '@/extensions/api.js'",
    "import {",
    "  Dialog, DialogContent, DialogDescription, DialogFooter,",
    "  DialogHeader, DialogTitle,",
    "} from '@/components/ui/dialog.js'",
    "import { Button } from '@/components/ui/button.js'",
    "import { Input } from '@/components/ui/input.js'",
    "import { Label } from '@/components/ui/label.js'",
    "import { useState, useSyncExternalStore } from 'react'",
    "",
    "const TOKEN_KEY = 'knowledge-medium:readwise:token:v1'",
    "",
    "// Visibility is a tiny typed module store — NOT a window CustomEvent.",
    "// The configure action flips it directly; the mounted component reads",
    "// it with useSyncExternalStore, the same mechanism the app's own",
    "// DialogHost uses. (For a one-shot prompt that just returns a value,",
    "// prefer the imperative `openDialog(Component)` shape below instead.)",
    "let settingsOpen = false",
    "const settingsListeners = new Set()",
    "const setSettingsOpen = next => {",
    "  settingsOpen = next",
    "  settingsListeners.forEach(notify => notify())",
    "}",
    "const subscribeSettingsOpen = notify => {",
    "  settingsListeners.add(notify)",
    "  return () => settingsListeners.delete(notify)",
    "}",
    "",
    "const ReadwiseSetupDialog = () => {",
    "  const repo = useRepo()  // access Repo from inside an appMountsFacet component",
    "  const open = useSyncExternalStore(subscribeSettingsOpen, () => settingsOpen)",
    "  const [token, setToken] = useState('')",
    "  const [saving, setSaving] = useState(false)",
    "",
    "  const save = async () => {",
    "    setSaving(true)",
    "    try {",
    "      const ok = await fetch('https://readwise.io/api/v2/auth/', {",
    "        headers: { Authorization: `Token ${token}` },",
    "      }).then(r => r.status === 204).catch(() => false)",
    "      if (!ok) {",
    "        showError('Readwise rejected that token. Check it and try again.')",
    "        return",
    "      }",
    "      window.localStorage.setItem(TOKEN_KEY, token)",
    "      // repo is available here if you need to write workspace state too.",
    "      void repo  // (silence unused — show the access pattern)",
    "      showSuccess('Readwise connected.')",
    "      setSettingsOpen(false)",
    "    } finally {",
    "      setSaving(false)",
    "    }",
    "  }",
    "",
    "  return (",
    "    <Dialog open={open} onOpenChange={setSettingsOpen}>",
    "      <DialogContent>",
    "        <DialogHeader>",
    "          <DialogTitle>Connect Readwise</DialogTitle>",
    "          <DialogDescription>",
    "            Get a token from readwise.io/access_token and paste it here.",
    "          </DialogDescription>",
    "        </DialogHeader>",
    "        <Label htmlFor='rw-token'>Access token</Label>",
    "        <Input",
    "          id='rw-token'",
    "          value={token}",
    "          onChange={e => setToken(e.target.value)}",
    "          disabled={saving}",
    "        />",
    "        <DialogFooter>",
    "          <Button onClick={save} disabled={!token || saving}>",
    "            {saving ? 'Validating…' : 'Save'}",
    "          </Button>",
    "        </DialogFooter>",
    "      </DialogContent>",
    "    </Dialog>",
    "  )",
    "}",
    "",
    "export default [",
    "  appMountsFacet.of(",
    "    { id: 'readwise.setup-dialog', component: ReadwiseSetupDialog },",
    "    { source: 'readwise' },",
    "  ),",
    "  actionsFacet.of({",
    "    id: 'user.readwise.configure',",
    "    description: 'Configure Readwise',",
    "    context: ActionContextTypes.GLOBAL,",
    "    handler: () => setSettingsOpen(true),",
    "  }, { source: 'readwise' }),",
    "]",
  ].join('\n'),
}

const openDialogExample: AuthoringExample = {
  label: 'Simpler alternative: imperative `openDialog` from an action handler',
  code: [
    "// When you just need a one-shot prompt (no persistent mount, no",
    "// reactive subscription), `openDialog(Component, props)` returns",
    "// a promise that resolves with the user's choice. The dialog",
    "// component receives `resolve(value)` and `cancel()` as props.",
    "import {",
    "  actionsFacet, ActionContextTypes, openDialog,",
    "  showError, showSuccess,",
    "} from '@/extensions/api.js'",
    "import {",
    "  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,",
    "} from '@/components/ui/dialog.js'",
    "import { Button } from '@/components/ui/button.js'",
    "import { Input } from '@/components/ui/input.js'",
    "import { useState } from 'react'",
    "",
    "const ReadwiseTokenPrompt = ({ resolve, cancel }) => {",
    "  const [token, setToken] = useState('')",
    "  return (",
    "    <Dialog open={true} onOpenChange={open => { if (!open) cancel() }}>",
    "      <DialogContent>",
    "        <DialogHeader><DialogTitle>Paste your Readwise token</DialogTitle></DialogHeader>",
    "        <Input value={token} onChange={e => setToken(e.target.value)} />",
    "        <DialogFooter>",
    "          <Button onClick={() => resolve(token)} disabled={!token}>Save</Button>",
    "        </DialogFooter>",
    "      </DialogContent>",
    "    </Dialog>",
    "  )",
    "}",
    "",
    "actionsFacet.of({",
    "  id: 'user.readwise.configure',",
    "  description: 'Configure Readwise',",
    "  context: ActionContextTypes.GLOBAL,",
    "  handler: async () => {",
    "    const token = await openDialog(ReadwiseTokenPrompt)",
    "    if (!token) return  // user cancelled",
    "    const ok = await fetch('https://readwise.io/api/v2/auth/', {",
    "      headers: { Authorization: `Token ${token}` },",
    "    }).then(r => r.status === 204).catch(() => false)",
    "    if (!ok) { showError('Readwise rejected that token.'); return }",
    "    window.localStorage.setItem('knowledge-medium:readwise:token:v1', token)",
    "    showSuccess('Readwise connected.')",
    "  },",
    "}, { source: 'readwise' })",
  ].join('\n'),
}

const guides: AuthoringGuide[] = [
  {
    id: 'external-sync-plugin',
    title: 'External Sync Plugin',
    when: ['imports external API data', 'needs setup/config', 'needs manual sync'],
    principles: [
      'Use block-backed config and sync checkpoints.',
      'Use a Dialog mounted through appMountsFacet for setup — never window.prompt/alert/confirm.',
      'Store credentials in window.localStorage; everything else (settings, checkpoints, imported data) lives in blocks.',
      'Use stable external ids on imported records, or derive their block ids deterministically with uuidv5, so re-syncs upsert instead of duplicating.',
    ],
    steps: [
      'Define typed properties for external ids and source metadata via `defineProperty` + `propertySchemasFacet`. Persist sync checkpoints on a `getPluginPrefsBlock` sub-block, not localStorage.',
      'Render a Dialog component, mount it via `appMountsFacet`, and drive its open/closed state from a small typed module store the component reads with `useSyncExternalStore`. The configure action flips that store directly — never a `window` CustomEvent. Validate credentials against the provider\'s auth endpoint before saving. (For one-shot prompts, `openDialog(Component)` is the simpler imperative alternative — see the settings-dialog guide.)',
      'Add a manual sync action through `actionsFacet`. The handler reads the checkpoint from the prefs block, fetches incremental updates, and runs a single `repo.tx`. Wrap the body in `showProgress(...)` so the user sees per-page / per-book progress and a final summary.',
      'Anchor imported content under a plugin-owned root block whose id is `pluginBlockId(workspaceId, NAMESPACE, "library-root")` — see the `plugin-root-singleton` storage pattern.',
      'Upsert child records the same way: derive the block id from the external id, or look up by an external-id property. Never create a second block for the same external record.',
      'For *background* sync (poll a webhook / poll on an interval) use `appEffectsFacet.of({id, start: ({repo}) => { ... return cleanup })`. Manual sync via an action is enough for most plugins — only reach for an effect when the data source itself pushes. The effect object must be a STABLE reference: define it once at module scope (not inline in a function-valued extension), and export your extension as an array, not a function — a fresh `{id, start}` every resolve reads as "code changed" and silently restarts the effect (dropping its connection / interval) on every unrelated extension toggle.',
    ],
    preferredModules: [
      '@/extensions/api.js',
      '@/components/ui/dialog.js',
      '@/components/ui/input.js',
      '@/components/ui/button.js',
      '@/components/ui/label.js',
    ],
    relatedFacets: ['core.actions', 'core.app-mounts', 'core.app-effects', 'data.propertySchemas', 'data.types'],
    commands: [
      'yarn agent describe-runtime --guide external-sync-plugin --storage',
      'yarn agent describe-runtime --components dialog,input,button,label',
      // Writes compiled declarations for the app's vendored `@/...`
      // modules, so TS-aware editors resolve extension imports with
      // the same signatures the app build checks.
      'yarn agent types agent-extensions/kernel-types',
      'yarn agent types --module "@/extensions/api.js"',
      // Convention: extension source files live under `agent-extensions/`
      // at the repo root. The matrix-chat-client + canvas-layout
      // extensions are there as references.
      'yarn agent install-extension --verify [--description "<text>"] agent-extensions/<plugin>.js <label>',
      'yarn agent enable-extension <label>',
      'yarn agent uninstall-extension <label>',
    ],
    afterInstall: [
      'User-installed extensions are disabled by default (`userExtensionToggle` sets `defaultEnabled: false`). After install, run `yarn agent enable-extension <label>` (or `<id>`) before its actions show up in `yarn agent run-action`.',
      'enable-extension does two things (issue #67): it sets the synced "enabled" intent AND grants THIS device a trust approval pinned to the current source hash. A block runs only with both — so enabling on the bridge runs it on the bridge.',
      'After you EDIT an extension (install-extension onto the same block, or hand-edit the source), re-run `yarn agent enable-extension <label>` to re-pin the new source on this device. Until you do, the device keeps running the PREVIOUSLY approved version and the settings UI shows "Update available" — the live source is never auto-executed.',
      'disable-extension / a source change do NOT stop a running extension by themselves: disable only clears intent (the trust grant persists for a frictionless re-enable), and a drifted source keeps running the pinned version. uninstall-extension deletes the block and revokes the device trust.',
      'Do not retry `install-extension` if the action is "not found" — the install succeeded; the toggle/approval is just off. Run enable-extension.',
      'Pass `--verify` to `install-extension` to see the facets/actions the extension contributed without enabling/approving it (verify compiles the live source in isolation for diagnostics only).',
    ],
    examples: [
      settingsDialogExample,
      openDialogExample,
    ],
  },
  {
    id: 'settings-dialog',
    title: 'Settings Dialog',
    when: ['needs user setup', 'needs explanatory text', 'needs form controls'],
    principles: [
      'For *configuration* UI, prefer the `settings-via-property-editor-override` storage pattern: register a `definePropertyEditorOverride` and navigate to the prefs block. The property panel renders your editor inline — settings live with the block they edit, sync naturally, and are scriptable like any other block. Modal dialogs are right for interactive flows (search, picker, credential setup) — they\'re wrong as the default for "user changes how the plugin behaves".',
      'Two equally-valid dialog shapes: (a) appMountsFacet + a typed module store the component reads via `useSyncExternalStore`, flipped by an action, for a persistent mount that can react to live state; (b) imperative `openDialog(Component, props)` from an action handler when you just need a one-shot prompt that returns a value. Never route dialog open/toggle through a `window` CustomEvent — that bypasses the typed action and dialog channels.',
      'Access the live Repo from inside a Dialog component with `useRepo()`. Action handlers receive it as `uiStateBlock.repo`.',
      'Use system dialog and form components (`Dialog`, `Input`, `Button`, `Label`) — they already match the app theme.',
      'Use `showError` / `showSuccess` / `showProgress` for feedback. Never `window.alert` / `window.confirm` / `window.prompt`.',
      'Validate credentials against the provider\'s auth endpoint before persisting.',
    ],
    steps: [
      'Check first whether this is *configuration*. If so, use the `settings-via-property-editor-override` pattern instead — modal dialog is the wrong shape for configuration.',
      'For a non-configuration flow, pick the shape: (a) appMountsFacet + a typed module store read via `useSyncExternalStore` (flipped by an action) if the dialog will live across the session and react to live state; (b) `openDialog(Component)` from the action handler when "open it, get a value, close it" is all you need.',
      'Build the dialog with `Dialog` + `DialogContent` + form controls. Access repo via `useRepo()` (mount-style) or via the action handler\'s `uiStateBlock.repo` before calling `openDialog`.',
      'Report progress / outcome via `showProgress` / `showSuccess` / `showError`.',
      'Save non-secret values via `getPluginPrefsBlock`; save credentials to `localStorage`.',
    ],
    preferredModules: [
      '@/extensions/api.js',
      '@/components/ui/dialog.js',
      '@/components/ui/input.js',
      '@/components/ui/button.js',
      '@/components/ui/label.js',
    ],
    relatedFacets: ['core.app-mounts', 'core.actions'],
    commands: [
      'yarn agent describe-runtime --components dialog,input,button,label',
      'yarn agent describe-runtime --modules components/ui',
      'yarn agent types agent-extensions/kernel-types',
      'yarn agent types --module "@/components/ui/dialog.js"',
    ],
    examples: [
      settingsDialogExample,
      openDialogExample,
    ],
  },
  {
    id: 'block-backed-config',
    title: 'Block-Backed Config',
    when: ['stores settings', 'stores sync state', 'stores imported metadata'],
    principles: storageGuide.principles,
    steps: [
      'Choose UserPrefs for per-user settings and BlockDefault for shared workspace/content data.',
      'Define properties with explicit codecs.',
      'For per-plugin sub-blocks under user-prefs, define a `TypeContribution` via `defineBlockType` and read/write via `getPluginPrefsBlock(repo, workspaceId, user, type)`.',
      'For plugin-owned singleton blocks (e.g. import roots), derive the id deterministically via `pluginBlockId(workspaceId, NS, key)` so re-installs land on the same block.',
      'Store large or user-visible imported data as child/content blocks.',
    ],
    preferredModules: ['@/extensions/api.js'],
    relatedFacets: ['data.propertySchemas', 'data.types'],
    commands: [
      'yarn agent describe-runtime --storage',
      'yarn agent describe-runtime --facets data.propertySchemas',
      'yarn agent types agent-extensions/kernel-types',
      'yarn agent types --module "@/extensions/api.js"',
    ],
    examples: [
      storageGuide.patterns.find(p => p.id === 'user-prefs-config')!.example!,
      storageGuide.patterns.find(p => p.id === 'plugin-root-singleton')!.example!,
    ],
  },
]

const normalizeTerms = (filters: string[] | undefined): string[] =>
  (filters ?? [])
    .flatMap(filter => filter.split(','))
    .map(filter => filter.trim().toLowerCase())
    .filter(Boolean)

const matchesTerms = (
  filters: string[] | undefined,
  ...values: Array<string | string[] | undefined>
): boolean => {
  const terms = normalizeTerms(filters)
  if (terms.length === 0) return true

  const haystack = values
    .flatMap(value => Array.isArray(value) ? value : value ? [value] : [])
    .map(value => value.toLowerCase())

  return terms.some(term =>
    haystack.some(value => value === term || value.includes(term)),
  )
}

const sourcePriority = (source: AuthoringCatalogSource): number => {
  if (source === 'generated-api') return 4
  if (source === 'generated-module-glob') return 3
  if (source === 'html-entry') return 2
  if (source === 'html-preload') return 1
  return 0
}

const stripExtension = (path: string): string =>
  path.replace(/\.(ts|tsx|js|jsx|mjs)$/, '')

const toImportPath = (path: string): string =>
  stripExtension(path)
    .replace(/^\/src\//, '@/')
    .replace(/^src\//, '@/')
    .replace(/$/, '.js')

const basename = (path: string): string =>
  stripExtension(path).split('/').at(-1) ?? path

const categoryForPath = (importPath: string): string => {
  if (importPath === '@/extensions/api.js') return 'public-api'
  if (importPath.includes('/components/ui/')) return 'ui-component'
  if (importPath.includes('/components/')) return 'component'
  if (importPath.includes('/extensions/')) return 'extension-system'
  if (importPath.includes('/plugins/')) return 'plugin'
  if (importPath.includes('/data/')) return 'data'
  if (importPath.startsWith('react') || importPath.includes('/node_modules/')) return 'external'
  return 'module'
}

const generatedDescription = (importPath: string, exports: string[] | undefined): string => {
  if (importPath === '@/extensions/api.js') {
    return 'Generated from the live public extension API barrel.'
  }
  if (exports && exports.length > 0) {
    return `Generated from the module graph; runtime exports: ${exports.slice(0, 8).join(', ')}.`
  }
  return 'Generated from the module graph; export names are not loaded for this module.'
}

const moduleDescriptionForPath = (source: AuthoringCatalogSource): string => {
  if (source === 'html-importmap') return 'Import-map entry visible to dynamic extension modules.'
  if (source === 'html-entry') return 'Module entry script loaded by the current app document.'
  if (source === 'html-preload') return 'Module preload discovered from the current app document.'
  return 'Generated from the module graph.'
}

const exportNames = (module: RuntimeModule | undefined): string[] | undefined => {
  if (!module) return undefined
  return Object.keys(module).sort()
}

const generatedExportMap = (apiSurface: ApiSurfaceLike): Map<string, string[]> => {
  const map = new Map<string, string[]>([
    ['@/extensions/api.js', apiSurface.exports],
  ])

  for (const [path, module] of Object.entries(eagerUiModules)) {
    map.set(toImportPath(path), exportNames(module) ?? [])
  }

  return map
}

const generatedModules = (apiSurface: ApiSurfaceLike): AuthoringModuleSummary[] => {
  const exportsByImportPath = generatedExportMap(apiSurface)
  const modules = Object.keys(internalModuleIndex).map(path => {
    const importPath = toImportPath(path)
    const exports = exportsByImportPath.get(importPath)
    return {
      importPath,
      category: categoryForPath(importPath),
      description: generatedDescription(importPath, exports),
      ...(exports ? {exports} : {}),
      source: importPath === '@/extensions/api.js' ? 'generated-api' : 'generated-module-glob',
      safeForExtensions: true,
    } satisfies AuthoringModuleSummary
  })

  if (!modules.some(module => module.importPath === '@/extensions/api.js')) {
    modules.push({
      importPath: '@/extensions/api.js',
      category: 'public-api',
      description: generatedDescription('@/extensions/api.js', apiSurface.exports),
      exports: apiSurface.exports,
      source: 'generated-api',
      safeForExtensions: true,
    })
  }

  return modules
}

const isComponentExport = (name: string): boolean =>
  /^[A-Z]/.test(name)

const generatedComponents = (): AuthoringComponentSummary[] => {
  const out: AuthoringComponentSummary[] = []
  const seen = new Set<string>()

  const push = (component: AuthoringComponentSummary) => {
    const key = `${component.importPath}:${component.name}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(component)
  }

  for (const [path, module] of Object.entries(eagerUiModules)) {
    const importPath = toImportPath(path)
    for (const name of exportNames(module)?.filter(isComponentExport) ?? []) {
      push({
        name,
        importPath,
        category: categoryForPath(importPath),
        description: `Generated from runtime export ${name}.`,
        exports: [name],
        source: 'generated-module-glob',
      })
    }
  }

  for (const path of Object.keys(internalModuleIndex)) {
    if (!path.endsWith('.tsx')) continue
    const name = basename(path)
    if (!isComponentExport(name)) continue
    const importPath = toImportPath(path)
    push({
      name,
      importPath,
      category: categoryForPath(importPath),
      description: `Inferred from component module ${importPath}.`,
      exports: [name],
      source: 'generated-module-glob',
    })
  }

  return out.sort((a, b) =>
    a.importPath.localeCompare(b.importPath) || a.name.localeCompare(b.name),
  )
}

const normalizeDocumentModulePath = (raw: string, baseURI: string | undefined): string => {
  try {
    const url = new URL(raw, baseURI || 'http://agent-runtime.local/')
    const pathname = url.pathname
    const srcIndex = pathname.indexOf('/src/')
    if (srcIndex >= 0) return `@/${stripExtension(pathname.slice(srcIndex + '/src/'.length))}.js`
    const nodeIndex = pathname.indexOf('/node_modules/')
    if (nodeIndex >= 0) return pathname.slice(nodeIndex + 1)
    return pathname || raw
  } catch {
    return raw
  }
}

const importMapModules = (document: Document): AuthoringModuleSummary[] => {
  const modules: AuthoringModuleSummary[] = []
  const scripts = Array.from(document.querySelectorAll('script[type="importmap"]'))

  for (const script of scripts) {
    const text = script.textContent?.trim()
    if (!text) continue

    try {
      const parsed = JSON.parse(text) as {imports?: Record<string, string>}
      for (const [key, value] of Object.entries(parsed.imports ?? {})) {
        modules.push({
          importPath: key,
          category: key.startsWith('@/') || key === '@/' ? 'extension-import-prefix' : 'external',
          description: `${moduleDescriptionForPath('html-importmap')} Target: ${value}`,
          source: 'html-importmap',
          safeForExtensions: key === '@/' || key.startsWith('react'),
        })
      }
    } catch {
      modules.push({
        importPath: '<invalid importmap>',
        category: 'diagnostic',
        description: 'The current document has an importmap script that could not be parsed as JSON.',
        source: 'html-importmap',
      })
    }
  }

  return modules
}

const linkedModules = (
  document: Document,
  selector: string,
  source: AuthoringCatalogSource,
): AuthoringModuleSummary[] =>
  Array.from(document.querySelectorAll(selector))
    .map(element => element.getAttribute('href') ?? element.getAttribute('src') ?? '')
    .filter(Boolean)
    .map(raw => {
      const importPath = normalizeDocumentModulePath(raw, document.baseURI)
      return {
        importPath,
        category: categoryForPath(importPath),
        description: moduleDescriptionForPath(source),
        source,
        safeForExtensions: importPath.startsWith('@/'),
      }
    })

const documentModules = (document: Document | undefined): AuthoringModuleSummary[] => {
  if (!document) return []
  return [
    ...importMapModules(document),
    ...linkedModules(document, 'link[rel="modulepreload"][href]', 'html-preload'),
    ...linkedModules(document, 'script[type="module"][src]', 'html-entry'),
  ]
}

const mergeModules = (modules: AuthoringModuleSummary[]): AuthoringModuleSummary[] => {
  const seen = new Map<string, AuthoringModuleSummary>()
  for (const module of modules) {
    const existing = seen.get(module.importPath)
    if (!existing || sourcePriority(module.source) > sourcePriority(existing.source)) {
      seen.set(module.importPath, module)
    }
  }
  return [...seen.values()].sort((a, b) => a.importPath.localeCompare(b.importPath))
}

export const describeAuthoringCatalog = (
  apiSurface: ApiSurfaceLike,
  filters: AuthoringCatalogFilters = {},
  document?: Document,
): AuthoringCatalog => {
  const modules = filters.omitDiscoverableModules
    ? []
    : mergeModules([
      ...generatedModules(apiSurface),
      ...documentModules(document),
    ]).filter(module =>
      matchesTerms(filters.modules, module.importPath, module.category, module.description, module.exports),
    )

  const components = filters.omitDiscoverableModules
    ? []
    : generatedComponents().filter(component =>
      matchesTerms(filters.components, component.name, component.importPath, component.category, component.description, component.exports),
    )

  return {
    guides: guides.filter(guide =>
      matchesTerms(filters.guides, guide.id, guide.title, guide.when, guide.relatedFacets),
    ),
    storage: storageGuide,
    modules,
    components,
  }
}
