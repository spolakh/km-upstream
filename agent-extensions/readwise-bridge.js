// Extensions can import any kernel module via `@/...` — both the
// `@/extensions/api.js` barrel and deep paths (`@/context/repo.js`,
// `@/utils/toast.js`, …) produce the same module identity as the
// host app, because the kernel now imports modules with the same `.js`
// suffix extensions use. The mix below is deliberate: bulk-imported
// primitives go through the barrel for readability, and `useRepo` uses
// a deep import as a regression test that deep imports still resolve
// to the same `RepoContext` the kernel's `<RepoProvider>` wrote to.
import {
  ActionContextTypes,
  ChangeScope,
  actionsFacet,
  appEffectsFacet,
  appMountsFacet,
  headerItemsFacet,
  propertySchemasFacet,
  typesFacet,
  defineProperty,
  codecs,
  keyAtEnd,
  keysBetween,
  showSuccess,
  showError,
  showInfo,
  showProgress,
  dismissToast,
} from '@/extensions/api.js'
import {useRepo} from '@/context/repo.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.js'
import {Button} from '@/components/ui/button.js'
import {Input} from '@/components/ui/input.js'
import {Label} from '@/components/ui/label.js'
import {Textarea} from '@/components/ui/textarea.js'
import {Checkbox} from '@/components/ui/checkbox.js'
import {createElement as h, useCallback, useEffect, useState, useSyncExternalStore} from 'react'

// ============================================================================
// Constants
// ============================================================================

const VERSION = 1
const SOURCE = 'readwise-sync'
const GLOBAL_KEY = '__knowledgeMediumReadwiseSync'

const TOKEN_KEY = 'readwise:token'
const CONFIG_KEY = 'readwise:config:v1'
const STATE_KEY = 'readwise:state:v1'

const DEFAULT_CONFIG = {
  syncIntervalMinutes: 60,
  autoSync: true,
  rootContent: '[[Readwise]]',
  bookTemplate: '[[{{title}}]] by {{author}}',
  highlightTemplate: '{{text}}',
  noteTemplate: 'Note: {{note}}',
  initialSyncAfter: '',
}

// Accepts 'YYYY-MM-DD' or any string the Date constructor parses. Returns an
// ISO 8601 string (Readwise's updatedAfter format), or null if unusable.
const normalizeInitialSyncAfter = value => {
  const text = String(value ?? '').trim()
  if (!text) return null
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const READWISE_BASE = 'https://readwise.io/api/v2'
const DIALOG_MOUNT_ID = 'readwise.settings-dialog'

// ============================================================================
// Token / config / state storage (localStorage, since secrets shouldn't be in
// blocks and the matrix-chat-client extension establishes the same precedent
// for non-block-backed sync state).
// ============================================================================

const readJson = key => {
  const raw = window.localStorage.getItem(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const writeJson = (key, value) => {
  window.localStorage.setItem(key, JSON.stringify(value))
}

const loadToken = () => window.localStorage.getItem(TOKEN_KEY) || ''
const saveToken = token => {
  if (token) window.localStorage.setItem(TOKEN_KEY, token)
  else window.localStorage.removeItem(TOKEN_KEY)
}

const loadConfig = () => {
  const stored = readJson(CONFIG_KEY)
  return {...DEFAULT_CONFIG, ...(stored && typeof stored === 'object' ? stored : {})}
}

const saveConfig = config => {
  writeJson(CONFIG_KEY, {
    syncIntervalMinutes: Number(config.syncIntervalMinutes) || DEFAULT_CONFIG.syncIntervalMinutes,
    autoSync: Boolean(config.autoSync),
    rootContent: String(config.rootContent || DEFAULT_CONFIG.rootContent),
    bookTemplate: String(config.bookTemplate || DEFAULT_CONFIG.bookTemplate),
    highlightTemplate: String(config.highlightTemplate || DEFAULT_CONFIG.highlightTemplate),
    noteTemplate: String(config.noteTemplate || DEFAULT_CONFIG.noteTemplate),
    initialSyncAfter: String(config.initialSyncAfter ?? ''),
  })
}

const loadState = () => readJson(STATE_KEY) || {}
const saveState = next => writeJson(STATE_KEY, {...loadState(), ...next})
const clearCursor = () => {
  const s = loadState()
  delete s.updatedAfter
  delete s.rootBlockId
  writeJson(STATE_KEY, s)
}

// ============================================================================
// Template rendering — simple `{{var}}` substitution
// ============================================================================

const renderTemplate = (template, vars) =>
  String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = vars?.[key]
    if (value == null) return ''
    return Array.isArray(value) ? value.join(', ') : String(value)
  })

// ============================================================================
// Readwise API client
// ============================================================================

const readwiseFetch = async (path, token, params = {}) => {
  const url = new URL(`${READWISE_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.toString(), {
    headers: {Authorization: `Token ${token}`, 'Content-Type': 'application/json'},
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Readwise ${path} → ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

const validateToken = async token => {
  const res = await fetch(`${READWISE_BASE}/auth/`, {
    headers: {Authorization: `Token ${token}`},
  })
  return res.status === 204
}

const fetchExport = async (token, updatedAfter) => {
  const all = []
  let pageCursor = null
  for (let i = 0; i < 200; i++) {
    const page = await readwiseFetch('/export/', token, {
      ...(updatedAfter ? {updatedAfter} : {}),
      ...(pageCursor ? {pageCursor} : {}),
    })
    if (Array.isArray(page.results)) all.push(...page.results)
    pageCursor = page.nextPageCursor || null
    if (!pageCursor) break
  }
  return all
}

// ============================================================================
// Block helpers
// ============================================================================

const findChildByProperty = (children, propertyKey, value) =>
  children.find(child => {
    const propValue = child.properties?.[propertyKey]
    if (Array.isArray(propValue)) return propValue.some(v => Object.is(v, value))
    return Object.is(propValue, value)
  })

const findChildByContent = (children, content) =>
  children.find(child => (child.content ?? '').trim() === content.trim())

const ensureRootBlock = async (tx, workspaceId, config) => {
  const state = loadState()
  if (state.rootBlockId) {
    try {
      const existing = await tx.get(state.rootBlockId)
      if (existing && !existing.deleted) return existing.id
    } catch {
      // fall through and recreate
    }
  }

  // Scan top-level blocks for one matching rootContent
  const topLevel = await tx.childrenOf(null, workspaceId)
  let root = findChildByContent(topLevel, config.rootContent)
  let rootId = root?.id
  if (!rootId) {
    rootId = await tx.create({
      workspaceId,
      parentId: null,
      orderKey: keyAtEnd(topLevel.at(-1)?.orderKey ?? null),
      content: config.rootContent,
      properties: {
        types: ['readwise-root', 'page'],
        alias: [config.rootContent.replace(/^\[\[|\]\]$/g, '')],
      },
    })
  }
  saveState({rootBlockId: rootId})
  return rootId
}

const renderHighlightProps = highlight => ({
  'readwise:highlightId': highlight.id,
  'readwise:location': highlight.location ?? null,
  'readwise:locationType': highlight.location_type ?? null,
  'readwise:highlightedAt': highlight.highlighted_at ?? null,
  'readwise:url': highlight.url ?? null,
  'readwise:color': highlight.color ?? null,
  'readwise:tags': (highlight.tags ?? []).map(t => t?.name).filter(Boolean),
})

const renderBookProps = book => ({
  types: ['readwise-book'],
  'readwise:bookId': book.user_book_id,
  'readwise:title': book.title ?? null,
  'readwise:author': book.author ?? null,
  'readwise:category': book.category ?? null,
  'readwise:source': book.source ?? null,
  'readwise:sourceUrl': book.source_url ?? null,
  'readwise:coverImageUrl': book.cover_image_url ?? null,
  'readwise:asin': book.asin ?? null,
  'readwise:readwiseUrl': book.readwise_url ?? null,
})

const upsertHighlight = async (tx, workspaceId, bookBlockId, highlight, config) => {
  const children = await tx.childrenOf(bookBlockId, workspaceId)
  const existing = findChildByProperty(children, 'readwise:highlightId', highlight.id)

  const content = renderTemplate(config.highlightTemplate, {
    text: highlight.text,
    note: highlight.note,
    location: highlight.location,
    highlightedAt: highlight.highlighted_at,
    color: highlight.color,
    tags: (highlight.tags ?? []).map(t => t?.name).filter(Boolean),
  }) || '(empty highlight)'

  const props = {
    types: ['readwise-highlight'],
    ...renderHighlightProps(highlight),
  }

  let highlightId
  if (existing) {
    await tx.update(existing.id, {content, properties: props})
    highlightId = existing.id
  } else {
    highlightId = await tx.create({
      workspaceId,
      parentId: bookBlockId,
      orderKey: keyAtEnd(children.at(-1)?.orderKey ?? null),
      content,
      properties: props,
    })
  }

  // Manage child Note block
  const highlightChildren = await tx.childrenOf(highlightId, workspaceId)
  const existingNote = highlightChildren.find(
    c => c.properties?.['readwise:noteFor'] === highlight.id,
  )
  if (highlight.note) {
    const noteContent = renderTemplate(config.noteTemplate, {note: highlight.note}) || ''
    if (existingNote) {
      if ((existingNote.content ?? '') !== noteContent) {
        await tx.update(existingNote.id, {content: noteContent})
      }
    } else {
      await tx.create({
        workspaceId,
        parentId: highlightId,
        orderKey: keyAtEnd(highlightChildren.at(-1)?.orderKey ?? null),
        content: noteContent,
        properties: {'readwise:noteFor': highlight.id},
      })
    }
  } else if (existingNote) {
    await tx.delete(existingNote.id)
  }
}

const upsertBook = async (tx, workspaceId, rootId, book, config) => {
  const children = await tx.childrenOf(rootId, workspaceId)
  const existing = findChildByProperty(children, 'readwise:bookId', book.user_book_id)

  const content = renderTemplate(config.bookTemplate, {
    title: book.title,
    author: book.author,
    category: book.category,
    source: book.source,
    url: book.source_url,
    coverUrl: book.cover_image_url,
  }) || `(book #${book.user_book_id})`

  const props = renderBookProps(book)

  let bookId
  if (existing) {
    await tx.update(existing.id, {content, properties: {...existing.properties, ...props}})
    bookId = existing.id
  } else {
    bookId = await tx.create({
      workspaceId,
      parentId: rootId,
      orderKey: keyAtEnd(children.at(-1)?.orderKey ?? null),
      content,
      properties: props,
    })
  }

  for (const highlight of book.highlights ?? []) {
    await upsertHighlight(tx, workspaceId, bookId, highlight, config)
  }

  return bookId
}

// ============================================================================
// Sync driver
// ============================================================================

const runSync = async (repo, {force = false} = {}) => {
  const token = loadToken()
  if (!token) throw new Error('No Readwise token configured. Open settings to add one.')

  const config = loadConfig()
  const state = loadState()
  const initialFloor = normalizeInitialSyncAfter(config.initialSyncAfter)
  const updatedAfter = force
    ? initialFloor
    : state.updatedAfter || initialFloor

  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) throw new Error('No active workspace')

  const startedAt = new Date().toISOString()
  const books = await fetchExport(token, updatedAfter)

  let touchedBooks = 0
  let touchedHighlights = 0

  if (books.length > 0) {
    await repo.tx(
      async tx => {
        const rootId = await ensureRootBlock(tx, workspaceId, config)
        for (const book of books) {
          await upsertBook(tx, workspaceId, rootId, book, config)
          touchedBooks += 1
          touchedHighlights += (book.highlights ?? []).length
        }
      },
      {scope: ChangeScope.BlockDefault, description: 'readwise sync'},
    )
  }

  saveState({
    updatedAfter: startedAt,
    lastSyncAt: startedAt,
    lastSyncStatus: 'ok',
    lastSyncCounts: {books: touchedBooks, highlights: touchedHighlights},
  })
  return {books: touchedBooks, highlights: touchedHighlights, startedAt}
}

// ============================================================================
// Background scheduler — runtime manager kept on window so reloads stop the
// old loop before starting a new one (matches the matrix-chat-client idiom).
// ============================================================================

const createManager = () => ({
  version: VERSION,
  timer: null,
  running: false,
  repo: null,
  status: 'idle',
  lastError: null,

  scheduleNext(delayMs) {
    if (this.timer) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => this.tick(), delayMs)
  },

  async tick() {
    if (!this.repo) return
    if (this.running) {
      this.scheduleNext(60_000)
      return
    }
    const config = loadConfig()
    const token = loadToken()
    if (!token || !config.autoSync) {
      this.status = 'paused'
      this.scheduleNext(Math.max(60_000, (config.syncIntervalMinutes || 60) * 60_000))
      return
    }
    this.running = true
    try {
      this.status = 'syncing'
      const result = await runSync(this.repo)
      this.status = 'ok'
      this.lastError = null
      if (result.books > 0) {
        showInfo(`Readwise: ${result.books} book(s), ${result.highlights} highlight(s) synced`)
      }
    } catch (err) {
      this.status = 'error'
      this.lastError = err instanceof Error ? err.message : String(err)
      console.error('[readwise-sync]', err)
    } finally {
      this.running = false
      const config = loadConfig()
      this.scheduleNext(Math.max(60_000, (config.syncIntervalMinutes || 60) * 60_000))
    }
  },

  start(repo) {
    this.stop()
    this.repo = repo
    const config = loadConfig()
    // First tick: small initial delay so app finishes booting
    this.scheduleNext(10_000)
    return true
  },

  stop() {
    if (this.timer) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
    this.repo = null
    if (this.status !== 'paused') this.status = 'idle'
  },

  async runOnce({force = false} = {}) {
    if (!this.repo) throw new Error('Sync manager not started')
    if (this.running) throw new Error('Sync already in progress')
    this.running = true
    try {
      this.status = 'syncing'
      const result = await runSync(this.repo, {force})
      this.status = 'ok'
      this.lastError = null
      return result
    } catch (err) {
      this.status = 'error'
      this.lastError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      this.running = false
    }
  },
})

const manager = () => {
  const existing = window[GLOBAL_KEY]
  if (existing?.version === VERSION) return existing
  existing?.stop?.()
  const next = createManager()
  window[GLOBAL_KEY] = next
  return next
}

// ============================================================================
// Settings dialog
// ============================================================================

const dialogStore = {
  open: false,
  listeners: new Set(),
  setOpen(open) {
    this.open = open
    for (const l of this.listeners) l()
  },
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  },
  getSnapshot() {
    return this.open
  },
}

const ReadwiseSettingsDialog = () => {
  const open = useSyncExternalStore(
    cb => dialogStore.subscribe(cb),
    () => dialogStore.getSnapshot(),
  )
  const repo = useRepo()
  const [token, setToken] = useState('')
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)

  useEffect(() => {
    if (open) {
      setToken(loadToken())
      setConfig(loadConfig())
      setStatus(null)
    }
  }, [open])

  const onSave = useCallback(async () => {
    setBusy(true)
    try {
      const trimmed = (token || '').trim()
      if (trimmed && !(await validateToken(trimmed))) {
        showError('Readwise: token rejected by /auth')
        setBusy(false)
        return
      }
      saveToken(trimmed)
      saveConfig(config)
      manager().start(repo)
      showSuccess('Readwise settings saved')
      dialogStore.setOpen(false)
    } catch (err) {
      showError(`Readwise: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }, [token, config, repo])

  const onSyncNow = useCallback(async () => {
    setBusy(true)
    setStatus('syncing…')
    const progressToast = showProgress('Readwise sync in progress…')
    try {
      const result = await manager().runOnce({force: false})
      dismissToast(progressToast)
      showSuccess(
        `Readwise: ${result.books} book(s), ${result.highlights} highlight(s)`,
      )
      setStatus(`Last sync: ${new Date(result.startedAt).toLocaleString()}`)
    } catch (err) {
      dismissToast(progressToast)
      const msg = err instanceof Error ? err.message : String(err)
      showError(`Readwise sync failed: ${msg}`)
      setStatus(`Error: ${msg}`)
    } finally {
      setBusy(false)
    }
  }, [])

  const update = patch => setConfig(prev => ({...prev, ...patch}))

  const lastSyncInfo = (() => {
    const state = loadState()
    if (!state.lastSyncAt) return 'Never synced'
    const counts = state.lastSyncCounts
    const when = new Date(state.lastSyncAt).toLocaleString()
    const c = counts ? ` — ${counts.books} books / ${counts.highlights} highlights` : ''
    return `Last sync: ${when}${c}`
  })()

  return h(
    Dialog,
    {open, onOpenChange: o => dialogStore.setOpen(!!o)},
    h(
      DialogContent,
      {className: 'max-w-2xl'},
      h(
        DialogHeader,
        null,
        h(DialogTitle, null, 'Readwise sync'),
        h(
          DialogDescription,
          null,
          'Paste your Readwise access token (https://readwise.io/access_token) and customize how books and highlights are imported. Templates use {{var}} substitution.',
        ),
      ),
      h(
        'div',
        {className: 'flex flex-col gap-3 py-2'},
        h(
          'div',
          {className: 'flex flex-col gap-1'},
          h(Label, {htmlFor: 'rw-token'}, 'Access token'),
          h(Input, {
            id: 'rw-token',
            type: 'password',
            placeholder: 'Readwise API token',
            value: token,
            onChange: e => setToken(e.target.value),
          }),
        ),
        h(
          'div',
          {className: 'grid grid-cols-2 gap-3'},
          h(
            'div',
            {className: 'flex flex-col gap-1'},
            h(Label, {htmlFor: 'rw-interval'}, 'Sync every (minutes)'),
            h(Input, {
              id: 'rw-interval',
              type: 'number',
              min: 5,
              value: config.syncIntervalMinutes,
              onChange: e => update({syncIntervalMinutes: Number(e.target.value)}),
            }),
          ),
          h(
            'div',
            {className: 'flex items-end gap-2'},
            h(Checkbox, {
              id: 'rw-auto',
              checked: !!config.autoSync,
              onCheckedChange: v => update({autoSync: !!v}),
            }),
            h(Label, {htmlFor: 'rw-auto'}, 'Sync automatically'),
          ),
        ),
        h(
          'div',
          {className: 'flex flex-col gap-1'},
          h(Label, {htmlFor: 'rw-root'}, 'Root page'),
          h(Input, {
            id: 'rw-root',
            value: config.rootContent,
            onChange: e => update({rootContent: e.target.value}),
          }),
          h(
            'p',
            {className: 'text-xs text-muted-foreground'},
            'Top-level page that holds imported books.',
          ),
        ),
        h(
          'div',
          {className: 'flex flex-col gap-1'},
          h(Label, {htmlFor: 'rw-initial'}, 'Initial sync from'),
          h(Input, {
            id: 'rw-initial',
            type: 'date',
            value: config.initialSyncAfter || '',
            onChange: e => update({initialSyncAfter: e.target.value}),
          }),
          h(
            'p',
            {className: 'text-xs text-muted-foreground'},
            'Only import highlights updated after this date on the first sync (or after a full re-sync). Leave blank to import everything.',
          ),
        ),
        h(
          'div',
          {className: 'flex flex-col gap-1'},
          h(Label, {htmlFor: 'rw-book'}, 'Book template'),
          h(Textarea, {
            id: 'rw-book',
            rows: 2,
            value: config.bookTemplate,
            onChange: e => update({bookTemplate: e.target.value}),
          }),
          h(
            'p',
            {className: 'text-xs text-muted-foreground'},
            'Available: {{title}}, {{author}}, {{category}}, {{source}}, {{url}}, {{coverUrl}}',
          ),
        ),
        h(
          'div',
          {className: 'flex flex-col gap-1'},
          h(Label, {htmlFor: 'rw-hl'}, 'Highlight template'),
          h(Textarea, {
            id: 'rw-hl',
            rows: 2,
            value: config.highlightTemplate,
            onChange: e => update({highlightTemplate: e.target.value}),
          }),
          h(
            'p',
            {className: 'text-xs text-muted-foreground'},
            'Available: {{text}}, {{note}}, {{location}}, {{highlightedAt}}, {{color}}, {{tags}}',
          ),
        ),
        h(
          'div',
          {className: 'flex flex-col gap-1'},
          h(Label, {htmlFor: 'rw-note'}, 'Note template (sub-block, only when highlight has a note)'),
          h(Textarea, {
            id: 'rw-note',
            rows: 2,
            value: config.noteTemplate,
            onChange: e => update({noteTemplate: e.target.value}),
          }),
          h(
            'p',
            {className: 'text-xs text-muted-foreground'},
            'Available: {{note}}',
          ),
        ),
        h(
          'p',
          {className: 'text-xs text-muted-foreground'},
          status || lastSyncInfo,
        ),
      ),
      h(
        DialogFooter,
        {className: 'gap-2'},
        h(
          Button,
          {variant: 'outline', disabled: busy, onClick: onSyncNow},
          busy ? 'Working…' : 'Sync now',
        ),
        h(
          Button,
          {variant: 'ghost', disabled: busy, onClick: () => dialogStore.setOpen(false)},
          'Cancel',
        ),
        h(Button, {disabled: busy, onClick: onSave}, 'Save'),
      ),
    ),
  )
}

// ============================================================================
// Header item — a small "RW" badge that opens the dialog
// ============================================================================

const ReadwiseHeaderItem = () => {
  const open = useSyncExternalStore(
    cb => dialogStore.subscribe(cb),
    () => dialogStore.getSnapshot(),
  )
  return h(
    Button,
    {
      variant: 'ghost',
      size: 'sm',
      title: 'Readwise sync',
      onClick: () => dialogStore.setOpen(!open),
    },
    'RW',
  )
}

// ============================================================================
// Facet contributions
// ============================================================================

const readwiseEffect = {
  id: 'user.readwise.poller',
  start: ({repo}) => {
    manager().start(repo)
    return () => manager().stop()
  },
}

export default [
  appEffectsFacet.of(readwiseEffect, {source: SOURCE}),

  appMountsFacet.of(
    {id: DIALOG_MOUNT_ID, component: ReadwiseSettingsDialog},
    {source: SOURCE},
  ),

  headerItemsFacet.of(
    {id: 'readwise.header', region: 'end', component: ReadwiseHeaderItem},
    {source: SOURCE, precedence: 45},
  ),

  // Action: open settings
  actionsFacet.of(
    {
      id: 'readwise.configure',
      description: 'Configure Readwise sync',
      context: ActionContextTypes.GLOBAL,
      handler: async () => dialogStore.setOpen(true),
    },
    {source: SOURCE},
  ),

  // Action: sync now
  actionsFacet.of(
    {
      id: 'readwise.sync-now',
      description: 'Readwise: sync now',
      context: ActionContextTypes.GLOBAL,
      handler: async () => {
        try {
          const result = await manager().runOnce({force: false})
          showSuccess(
            `Readwise: ${result.books} book(s), ${result.highlights} highlight(s)`,
          )
        } catch (err) {
          showError(
            `Readwise sync failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      },
    },
    {source: SOURCE},
  ),

  // Action: force full resync (clears cursor)
  actionsFacet.of(
    {
      id: 'readwise.full-resync',
      description: 'Readwise: full re-sync (clear cursor)',
      context: ActionContextTypes.GLOBAL,
      handler: async () => {
        clearCursor()
        try {
          const result = await manager().runOnce({force: true})
          showSuccess(
            `Readwise full resync: ${result.books} books, ${result.highlights} highlights`,
          )
        } catch (err) {
          showError(
            `Readwise full resync failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      },
    },
    {source: SOURCE},
  ),

  // Action: disconnect (clear token)
  actionsFacet.of(
    {
      id: 'readwise.disconnect',
      description: 'Readwise: disconnect (clear token)',
      context: ActionContextTypes.GLOBAL,
      handler: async () => {
        saveToken('')
        showInfo('Readwise: token cleared')
      },
    },
    {source: SOURCE},
  ),

  // Types for imported records. (`label`, not `name` — TypeContribution
  // has no `name` field, so the old key rendered these types by id.)
  // The root is a singleton container: keep it out of the # dropdown
  // so #Readwise offers creating the user's own type instead.
  typesFacet.of({id: 'readwise-root', label: 'Readwise root', hideFromCompletion: true}, {source: SOURCE}),
  typesFacet.of({id: 'readwise-book', label: 'Readwise book'}, {source: SOURCE}),
  typesFacet.of({id: 'readwise-highlight', label: 'Readwise highlight'}, {source: SOURCE}),

  // Property schemas for imported records (BlockDefault scope — these are
  // workspace-visible data, not per-user settings).
  propertySchemasFacet.of(
    defineProperty('readwise:bookId', {scope: ChangeScope.BlockDefault, codec: codecs.number}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:title', {scope: ChangeScope.BlockDefault, codec: codecs.optionalString}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:author', {scope: ChangeScope.BlockDefault, codec: codecs.optionalString}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:category', {scope: ChangeScope.BlockDefault, codec: codecs.optionalString}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:source', {scope: ChangeScope.BlockDefault, codec: codecs.optionalString}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:sourceUrl', {scope: ChangeScope.BlockDefault, codec: codecs.optionalString}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:coverImageUrl', {scope: ChangeScope.BlockDefault, codec: codecs.optionalString}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:asin', {scope: ChangeScope.BlockDefault, codec: codecs.optionalString}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:readwiseUrl', {scope: ChangeScope.BlockDefault, codec: codecs.optionalString}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:highlightId', {scope: ChangeScope.BlockDefault, codec: codecs.number}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:location', {scope: ChangeScope.BlockDefault, codec: codecs.optionalString}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:locationType', {scope: ChangeScope.BlockDefault, codec: codecs.optionalString}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:highlightedAt', {scope: ChangeScope.BlockDefault, codec: codecs.optionalString}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:url', {scope: ChangeScope.BlockDefault, codec: codecs.optionalString}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:color', {scope: ChangeScope.BlockDefault, codec: codecs.optionalString}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:tags', {scope: ChangeScope.BlockDefault, codec: codecs.list(codecs.string)}),
    {source: SOURCE},
  ),
  propertySchemasFacet.of(
    defineProperty('readwise:noteFor', {scope: ChangeScope.BlockDefault, codec: codecs.number}),
    {source: SOURCE},
  ),
]
