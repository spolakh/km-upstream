import {
  actionTransformsFacet, actionsFacet, ActionContextTypes, appEffectsFacet, appMountsFacet,
  blockContentDecoratorsFacet, ChangeScope, codecs, defineBlockType, defineProperty,
  definePropertyEditorOverride, getPluginPrefsBlock,
  keyBetween, keysBetween, pluginBlockId,
  propertyEditorOverridesFacet, propertySchemasFacet,
  showError, showInfo, showProgress, showPropertiesProp,
  showSuccess, typesFacet, useRepo,
  type ActionConfig,
  type ActionContextType,
  type ActionTransform,
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
  type PropertyEditorProps,
  type PropertySchema,
} from '@/extensions/api.js'
import type { Block } from '@/data/block.js'
import { BLOCK_TYPE_TYPE, PAGE_TYPE } from '@/data/blockTypes.js'
import { aliasesProp, getBlockTypes } from '@/data/properties.js'
import { createOrRestoreTargetBlock, ensureAliasTarget } from '@/data/targets.js'
import { addDaysIso, getOrCreateDailyNote, todayIso } from '@/plugins/daily-notes/dailyNotes.js'
import { DAILY_NOTE_TYPE } from '@/plugins/daily-notes/schema.js'
import { SWIPE_RIGHT_BLOCK_ACTION_ID } from '@/plugins/swipe-quick-actions/actions.js'
import {
  EDIT_MODE_TODO_CYCLE_ACTION_ID,
  TODO_CYCLE_ACTION_ID,
} from '@/plugins/todo/actions.js'
import type { BlockShortcutDependencies } from '@/shortcuts/types.js'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { Label } from '@/components/ui/label.js'
import { Textarea } from '@/components/ui/textarea.js'
import { navigate, useOpenBlock } from '@/utils/navigation.js'
import { buildAppHash } from '@/utils/routing.js'
import { useHandle } from '@/hooks/block.js'
import type { BlockData, BlockRenderer, BlockRendererProps } from '@/types.js'
import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'

// ---------------------------------------------------------------------------
// constants

const READWISE_NS = '45fb169f-ffac-458b-b2a7-6cec87d2d7ee'
const TOKEN_KEY = 'knowledge-medium:readwise:token:v1'

// Setup-dialog visibility — a typed module store, NOT a window CustomEvent.
// The connect action / header button / "Connect" toast flip it directly;
// the mounted dialog reads it with useSyncExternalStore (the same mechanism
// the app's own DialogHost uses).
let setupOpen = false
const setupListeners = new Set<() => void>()
const setSetupOpen = (next: boolean) => {
  setupOpen = next
  setupListeners.forEach((notify) => notify())
}
const subscribeSetupOpen = (notify: () => void) => {
  setupListeners.add(notify)
  return () => setupListeners.delete(notify)
}
const READWISE_API = 'https://readwise.io/api/v2'
const READWISE_LIBRARY_TYPE = 'readwise-library'
const READWISE_DOCUMENT_TYPE = 'readwise-document'
const READWISE_HIGHLIGHT_TYPE = 'readwise-highlight'
const READWISE_NOTE_TYPE = 'readwise-note'
const HIGHLIGHTS_SECTION_CONTENT = 'Highlights'
const REVIEW_ROLLOVER_BUFFER_MINUTES = 120

const DEFAULT_PAGE_TITLE_TEMPLATE = '{title}'
const DEFAULT_BOOK_TEMPLATE = ''
const DEFAULT_HIGHLIGHT_TEMPLATE = '{text}'

// ---------------------------------------------------------------------------
// token helpers — never echo the value back through bridge / toast output

const loadToken = (): string | null => window.localStorage.getItem(TOKEN_KEY)
const saveToken = (t: string) => window.localStorage.setItem(TOKEN_KEY, t)
const clearToken = () => window.localStorage.removeItem(TOKEN_KEY)

const validateToken = async (candidate: string): Promise<boolean> => {
  try {
    const res = await fetch(`${READWISE_API}/auth/`, {
      headers: { Authorization: `Token ${candidate}` },
    })
    return res.status === 204
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// properties

const lastSyncedAtProp = defineProperty<string | undefined>('readwise:lastSyncedAt', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.UserPrefs,
})
const syncSinceProp = defineProperty<Date | undefined>('readwise:syncSince', {
  codec: codecs.date,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const pageTitleTemplateProp = defineProperty<string>('readwise:pageTitleTemplate', {
  codec: codecs.string,
  defaultValue: DEFAULT_PAGE_TITLE_TEMPLATE,
  changeScope: ChangeScope.BlockDefault,
})
const bookTemplateProp = defineProperty<string>('readwise:bookTemplate', {
  codec: codecs.string,
  defaultValue: DEFAULT_BOOK_TEMPLATE,
  changeScope: ChangeScope.BlockDefault,
})
const highlightTemplateProp = defineProperty<string>('readwise:highlightTemplate', {
  codec: codecs.string,
  defaultValue: DEFAULT_HIGHLIGHT_TEMPLATE,
  changeScope: ChangeScope.BlockDefault,
})
const autoSyncIntervalProp = defineProperty<number>('readwise:autoSyncIntervalMin', {
  codec: codecs.number,
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})
const authorPageTypesProp = defineProperty<readonly string[]>('readwise:authorPageTypes', {
  codec: codecs.refList({ targetTypes: [BLOCK_TYPE_TYPE] }),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})
const documentPageTypesProp = defineProperty<readonly string[]>('readwise:documentPageTypes', {
  codec: codecs.refList({ targetTypes: [BLOCK_TYPE_TYPE] }),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})
const highlightTypesProp = defineProperty<readonly string[]>('readwise:highlightTypes', {
  codec: codecs.refList({ targetTypes: [BLOCK_TYPE_TYPE] }),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})
// purely a UI hint — the source of truth is localStorage. We mirror it so the
// settings page can render a "Connected" pill without subscribing to storage.
const connectedHintProp = defineProperty<boolean>('readwise:connectedHint', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.UserPrefs,
})
// per-block external ids on imported pages / highlights
const userBookIdProp = defineProperty<string | undefined>('readwise:user_book_id', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const highlightIdProp = defineProperty<string | undefined>('readwise:highlight_id', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const titleProp = defineProperty<string | undefined>('readwise:title', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const authorProp = defineProperty<string>('readwise:author', {
  codec: codecs.ref({ targetTypes: [PAGE_TYPE] }),
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const categoryProp = defineProperty<string | undefined>('readwise:category', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const sourceProp = defineProperty<string | undefined>('readwise:source', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const sourceUrlProp = defineProperty<string | undefined>('readwise:source_url', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const readwiseUrlProp = defineProperty<string | undefined>('readwise:readwise_url', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const coverImageUrlProp = defineProperty<string | undefined>('readwise:cover_image_url', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const documentNoteProp = defineProperty<string | undefined>('readwise:document_note', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const numHighlightsProp = defineProperty<number | undefined>('readwise:num_highlights', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const lastHighlightAtProp = defineProperty<string | undefined>('readwise:last_highlight_at', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const asinProp = defineProperty<string | undefined>('readwise:asin', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const tagsProp = defineProperty<string[]>('readwise:tags', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})
const locationProp = defineProperty<string | undefined>('readwise:location', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const locationTypeProp = defineProperty<string | undefined>('readwise:location_type', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const colorProp = defineProperty<string | undefined>('readwise:color', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const highlightedAtProp = defineProperty<string | undefined>('readwise:highlighted_at', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const updatedAtProp = defineProperty<string | undefined>('readwise:updated_at', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const createdAtProp = defineProperty<string | undefined>('readwise:created_at', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const noteForHighlightIdProp = defineProperty<string | undefined>('readwise:note_for_highlight_id', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const reviewDateProp = defineProperty<string>('readwise:review_date', {
  codec: codecs.ref({ targetTypes: [DAILY_NOTE_TYPE] }),
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const reviewedProp = defineProperty<boolean>('readwise:reviewed', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

const readwisePrefsType = defineBlockType({
  id: 'readwise-prefs',
  label: 'Readwise',
  // Prefs container is plumbing for the # dropdown (typing #Readwise
  // must offer creating the user's own type, not tag with this);
  // the chip stays informative on the container block itself.
  hideFromCompletion: true,
  properties: [
    lastSyncedAtProp, syncSinceProp,
    pageTitleTemplateProp, bookTemplateProp, highlightTemplateProp,
    autoSyncIntervalProp, authorPageTypesProp, documentPageTypesProp,
    highlightTypesProp, connectedHintProp,
  ],
})
const readwiseLibraryType = defineBlockType({
  id: READWISE_LIBRARY_TYPE,
  label: 'Readwise library',
  // Singleton root marker, same rationale as the prefs container.
  hideFromCompletion: true,
})
const readwiseDocumentType = defineBlockType({
  id: READWISE_DOCUMENT_TYPE,
  label: 'Readwise document',
  description: 'A document imported from Readwise Reader or the Readwise export API.',
  properties: [
    userBookIdProp, titleProp, authorProp, categoryProp, sourceProp,
    sourceUrlProp, readwiseUrlProp, coverImageUrlProp, documentNoteProp,
    numHighlightsProp, lastHighlightAtProp, asinProp, tagsProp,
  ],
})
const readwiseHighlightType = defineBlockType({
  id: READWISE_HIGHLIGHT_TYPE,
  label: 'Readwise highlight',
  description: 'A highlight imported from Readwise.',
  properties: [
    highlightIdProp, userBookIdProp, readwiseUrlProp, locationProp, locationTypeProp,
    colorProp, highlightedAtProp, updatedAtProp, createdAtProp, tagsProp,
    reviewDateProp, reviewedProp,
  ],
})
const readwiseNoteType = defineBlockType({
  id: READWISE_NOTE_TYPE,
  label: 'Readwise note',
  properties: [noteForHighlightIdProp],
})

const DOCUMENT_PROPERTY_SCHEMAS = [
  userBookIdProp,
  titleProp,
  authorProp,
  categoryProp,
  sourceProp,
  sourceUrlProp,
  readwiseUrlProp,
  coverImageUrlProp,
  documentNoteProp,
  numHighlightsProp,
  lastHighlightAtProp,
  asinProp,
  tagsProp,
]
const HIGHLIGHT_PROPERTY_SCHEMAS = [
  userBookIdProp,
  highlightIdProp,
  readwiseUrlProp,
  tagsProp,
  locationProp,
  locationTypeProp,
  colorProp,
  highlightedAtProp,
  updatedAtProp,
  createdAtProp,
]
const NOTE_PROPERTY_SCHEMAS = [
  noteForHighlightIdProp,
]
const HIGHLIGHT_REVIEW_PROPERTY_SCHEMAS = [
  reviewDateProp,
  reviewedProp,
]
const IMPORTED_PROPERTY_SCHEMAS = [
  ...DOCUMENT_PROPERTY_SCHEMAS,
  ...HIGHLIGHT_PROPERTY_SCHEMAS.filter(schema =>
    !DOCUMENT_PROPERTY_SCHEMAS.some(existing => existing.name === schema.name)),
  ...NOTE_PROPERTY_SCHEMAS,
  ...HIGHLIGHT_REVIEW_PROPERTY_SCHEMAS,
]

// ---------------------------------------------------------------------------
// document decorator

type ReadwiseDocumentMeta = {
  title?: string
  authorId?: string
  category?: string
  source?: string
  sourceUrl?: string
  readwiseUrl?: string
  coverImageUrl?: string
  documentNote?: string
  numHighlights?: number
  lastHighlightAt?: string
  asin?: string
  tags: string[]
}

const readBlockProperty = <T,>(block: Block, schema: PropertySchema<T>): T | undefined => {
  try {
    return block.peekProperty(schema)
  } catch {
    return undefined
  }
}

const readwiseDocumentMeta = (block: Block): ReadwiseDocumentMeta => ({
  title: readBlockProperty(block, titleProp),
  authorId: readBlockProperty(block, authorProp),
  category: readBlockProperty(block, categoryProp),
  source: readBlockProperty(block, sourceProp),
  sourceUrl: readBlockProperty(block, sourceUrlProp),
  readwiseUrl: readBlockProperty(block, readwiseUrlProp),
  coverImageUrl: readBlockProperty(block, coverImageUrlProp),
  documentNote: readBlockProperty(block, documentNoteProp),
  numHighlights: readBlockProperty(block, numHighlightsProp),
  lastHighlightAt: readBlockProperty(block, lastHighlightAtProp),
  asin: readBlockProperty(block, asinProp),
  tags: readBlockProperty(block, tagsProp) ?? [],
})

const cleanText = (value: string | undefined): string | undefined => {
  const text = value?.trim()
  return text ? text : undefined
}

const formatReadwiseDate = (value: string | undefined): string | undefined => {
  const text = cleanText(value)
  if (!text) return undefined
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return text
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

const hostLabel = (value: string | undefined): string | undefined => {
  const text = cleanText(value)
  if (!text) return undefined
  try {
    return new URL(text).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

const highlightCountLabel = (count: number | undefined): string | undefined => {
  if (count === undefined || !Number.isFinite(count)) return undefined
  const unit = count === 1 ? 'highlight' : 'highlights'
  return `${count.toLocaleString()} ${unit}`
}

const titleInitial = (meta: ReadwiseDocumentMeta, fallback: string | undefined): string => {
  const source = cleanText(meta.title) ?? cleanText(fallback) ?? 'R'
  return source.slice(0, 1).toUpperCase()
}

const decodeAliasLabel = (data: BlockData | undefined): string | undefined => {
  if (!data) return undefined
  try {
    const aliases = aliasesProp.codec.decode(data.properties[aliasesProp.name])
    return cleanText(aliases[0]) ?? cleanText(data.content)
  } catch {
    return cleanText(data.content)
  }
}

const readwiseDocumentStyles = {
  card: {
    display: 'flex',
    width: '100%',
    alignItems: 'stretch',
    gap: 16,
    padding: 12,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--card)',
    boxShadow: '0 10px 28px rgba(15, 23, 42, 0.08)',
  },
  coverFrame: {
    flex: '0 0 clamp(72px, 18vw, 112px)',
    alignSelf: 'flex-start',
    maxWidth: 112,
  },
  cover: {
    display: 'block',
    width: '100%',
    aspectRatio: '2 / 3',
    objectFit: 'cover',
    border: '1px solid var(--border)',
    borderRadius: 5,
    background: 'var(--muted)',
    boxShadow: '0 8px 18px rgba(15, 23, 42, 0.16)',
  },
  coverFallback: {
    display: 'grid',
    width: '100%',
    aspectRatio: '2 / 3',
    placeItems: 'center',
    border: '1px solid var(--border)',
    borderRadius: 5,
    background: 'linear-gradient(145deg, var(--muted), var(--background))',
    color: 'var(--muted-foreground)',
    fontSize: 28,
    fontWeight: 650,
    boxShadow: '0 8px 18px rgba(15, 23, 42, 0.14)',
  },
  body: {
    display: 'flex',
    minWidth: 0,
    flex: 1,
    flexDirection: 'column',
    gap: 8,
  },
  kicker: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center',
    color: 'var(--muted-foreground)',
    fontSize: 12,
    lineHeight: 1.35,
  },
  sourceDot: {
    width: 4,
    height: 4,
    borderRadius: 4,
    background: 'var(--border)',
  },
  title: {
    minWidth: 0,
    fontSize: 19,
    fontWeight: 650,
    lineHeight: 1.3,
  },
  author: {
    color: 'var(--muted-foreground)',
    fontSize: 13,
    lineHeight: 1.4,
  },
  detailRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center',
  },
  detail: {
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '2px 6px',
    color: 'var(--muted-foreground)',
    fontSize: 12,
    lineHeight: 1.45,
  },
  note: {
    maxWidth: 680,
    maxHeight: '4.8em',
    overflow: 'hidden',
    color: 'var(--foreground)',
    fontSize: 13,
    lineHeight: 1.6,
  },
  links: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    alignItems: 'center',
    fontSize: 12,
    lineHeight: 1.4,
  },
  link: {
    color: 'var(--primary)',
    textDecoration: 'none',
  },
} satisfies Record<string, CSSProperties>

interface ReadwiseDocumentDecoratorViewProps {
  block: Block
  Inner: BlockRenderer
  innerProps: BlockRendererProps
}

const ReadwiseAuthorLine = ({block, authorId}: {block: Block; authorId: string}) => {
  const authorBlock = useMemo(() => block.repo.block(authorId), [block.repo, authorId])
  const authorData = useHandle(authorBlock, {selector: data => data ?? undefined})
  const label = decodeAliasLabel(authorData)
  const workspaceId = block.peek()?.workspaceId ?? authorData?.workspaceId
  const openAuthor = useOpenBlock({blockId: authorId, workspaceId})

  if (!label) return null

  return (
    <div style={readwiseDocumentStyles.author}>
      by{' '}
      {workspaceId ? (
        <a
          className="wikilink"
          data-alias={label}
          href={buildAppHash(workspaceId, authorId)}
          onClick={openAuthor}
          onMouseDown={event => event.stopPropagation()}
        >
          {label}
        </a>
      ) : label}
    </div>
  )
}

const ReadwiseDocumentDecoratorView = ({
  block,
  Inner,
  innerProps,
}: ReadwiseDocumentDecoratorViewProps) => {
  const meta = readwiseDocumentMeta(block)
  const source = cleanText(meta.source) ?? hostLabel(meta.sourceUrl)
  const category = cleanText(meta.category)
  const authorId = cleanText(meta.authorId)
  const note = cleanText(meta.documentNote)
  const sourceUrl = cleanText(meta.sourceUrl)
  const readwiseUrl = cleanText(meta.readwiseUrl)
  const asin = cleanText(meta.asin)
  const highlightCount = highlightCountLabel(meta.numHighlights)
  const lastHighlight = formatReadwiseDate(meta.lastHighlightAt)
  const cover = cleanText(meta.coverImageUrl)
  const fallbackTitle = block.peek()?.content
  const tags = meta.tags.map(cleanText).filter((tag): tag is string => Boolean(tag))

  return (
    <div style={readwiseDocumentStyles.card}>
      <div style={readwiseDocumentStyles.coverFrame} aria-hidden="true">
        {cover ? (
          <img
            alt=""
            src={cover}
            style={readwiseDocumentStyles.cover}
          />
        ) : (
          <div style={readwiseDocumentStyles.coverFallback}>
            {titleInitial(meta, fallbackTitle)}
          </div>
        )}
      </div>
      <div style={readwiseDocumentStyles.body}>
        {(category || source) && (
          <div style={readwiseDocumentStyles.kicker}>
            {category && <span>{category}</span>}
            {category && source && <span style={readwiseDocumentStyles.sourceDot}/>}
            {source && <span>{source}</span>}
          </div>
        )}
        <div style={readwiseDocumentStyles.title}>
          <Inner {...innerProps}/>
        </div>
        {authorId && <ReadwiseAuthorLine block={block} authorId={authorId}/>}
        {(highlightCount || lastHighlight || asin) && (
          <div style={readwiseDocumentStyles.detailRow}>
            {highlightCount && <span style={readwiseDocumentStyles.detail}>{highlightCount}</span>}
            {lastHighlight && <span style={readwiseDocumentStyles.detail}>Last highlight {lastHighlight}</span>}
            {asin && <span style={readwiseDocumentStyles.detail}>ASIN {asin}</span>}
          </div>
        )}
        {tags.length > 0 && (
          <div style={readwiseDocumentStyles.detailRow}>
            {tags.map(tag => (
              <span key={tag} style={readwiseDocumentStyles.detail}>{tag}</span>
            ))}
          </div>
        )}
        {note && <div style={readwiseDocumentStyles.note}>{note}</div>}
        {(sourceUrl || readwiseUrl) && (
          <div style={readwiseDocumentStyles.links}>
            {sourceUrl && (
              <a
                href={sourceUrl}
                rel="noreferrer"
                target="_blank"
                style={readwiseDocumentStyles.link}
                onClick={event => event.stopPropagation()}
                onMouseDown={event => event.stopPropagation()}
              >
                Source
              </a>
            )}
            {readwiseUrl && (
              <a
                href={readwiseUrl}
                rel="noreferrer"
                target="_blank"
                style={readwiseDocumentStyles.link}
                onClick={event => event.stopPropagation()}
                onMouseDown={event => event.stopPropagation()}
              >
                Readwise
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const readwiseDocumentDecoratorCache = new WeakMap<BlockRenderer, BlockRenderer>()

const decorateReadwiseDocument: BlockContentDecorator = inner => {
  const existing = readwiseDocumentDecoratorCache.get(inner)
  if (existing) return existing

  const Decorated: BlockRenderer = props => (
    <ReadwiseDocumentDecoratorView block={props.block} Inner={inner} innerProps={props}/>
  )
  Decorated.displayName = 'WithReadwiseDocumentDecorator'
  readwiseDocumentDecoratorCache.set(inner, Decorated)
  return Decorated
}

const readwiseDocumentContentDecorator: BlockContentDecoratorContribution = ctx => {
  if (!ctx.types.includes(READWISE_DOCUMENT_TYPE)) return null
  if (ctx.blockContext?.isBreadcrumb) return null
  return decorateReadwiseDocument
}

// ---------------------------------------------------------------------------
// template rendering

type BookRecord = {
  user_book_id: number
  title?: string
  author?: string
  category?: string
  source?: string
  source_url?: string
  readwise_url?: string
  cover_image_url?: string
  asin?: string
  book_tags?: Array<{ name?: string }>
  document_note?: string
  num_highlights?: number
  last_highlight_at?: string
  highlights?: HighlightRecord[]
}

type HighlightRecord = {
  id: number
  text?: string
  note?: string
  location?: number | string
  location_type?: string
  color?: string
  highlighted_at?: string
  updated_at?: string
  created_at?: string
  tags?: Array<{ name?: string }>
  readwise_url?: string
  is_deleted?: boolean
}

const formatTags = (tags: Array<{ name?: string }> | undefined): string => {
  if (!tags || !tags.length) return ''
  return tags.map(t => t.name?.trim()).filter(Boolean).map(n => `#[[${n}]]`).join(' ')
}

const substitute = (template: string, vars: Record<string, string>): string => {
  return template.replace(/\{([a-z_]+)\}/gi, (_, key) => {
    const v = vars[key]
    return v == null ? '' : v
  })
}

const bookVars = (b: BookRecord): Record<string, string> => ({
  title: b.title ?? '',
  author: b.author ?? '',
  category: b.category ?? '',
  source: b.source ?? '',
  source_url: b.source_url ?? '',
  readwise_url: b.readwise_url ?? '',
  cover_image_url: b.cover_image_url ?? '',
  asin: b.asin ?? '',
  document_note: b.document_note ?? '',
  num_highlights: String(b.num_highlights ?? ''),
  last_highlight_at: b.last_highlight_at ?? '',
  tags: formatTags(b.book_tags),
  user_book_id: String(b.user_book_id),
})

const highlightVars = (h: HighlightRecord): Record<string, string> => ({
  text: h.text ?? '',
  note: h.note ?? '',
  location: String(h.location ?? ''),
  location_type: h.location_type ?? '',
  color: h.color ?? '',
  highlighted_at: h.highlighted_at ?? '',
  updated_at: h.updated_at ?? '',
  created_at: h.created_at ?? '',
  readwise_url: h.readwise_url ?? '',
  tags: formatTags(h.tags),
  highlight_id: String(h.id),
})

// Drop trailing-empty lines and lines that collapse to whitespace after
// substitution — most book templates have optional fields like {tags} that
// the user has left blank.
const renderTemplateLines = (template: string, vars: Record<string, string>): string[] => {
  return template
    .split('\n')
    .map(line => substitute(line, vars))
    .filter(line => line.trim().length > 0)
}

const templateKeys = (line: string): string[] =>
  Array.from(line.matchAll(/\{([a-z_]+)\}/gi), match => match[1])

const propertyBackedLine = (line: string, propertyBackedKeys: ReadonlySet<string>): boolean => {
  const keys = templateKeys(line)
  if (keys.length === 0 || !keys.every(key => propertyBackedKeys.has(key))) return false
  // Only treat the line as fully property-backed (and therefore safe to drop,
  // since the managed properties now carry these values) when it is *nothing
  // but* those placeholders plus whitespace. A line like `My note: {note}` or
  // `Review prompt for {title}` carries literal text the properties don't
  // represent, so dropping it would lose the user's custom template output —
  // keep it and render it as a supplemental line instead.
  return line.replace(/\{[a-z_]+\}/gi, '').trim().length === 0
}

const renderSupplementalTemplateLines = (
  template: string,
  vars: Record<string, string>,
  propertyBackedKeys: ReadonlySet<string>,
): string[] => {
  return template
    .split('\n')
    .filter(line => !propertyBackedLine(line, propertyBackedKeys))
    .map(line => substitute(line, vars))
    .filter(line => line.trim().length > 0)
}

const BOOK_PROPERTY_TEMPLATE_KEYS = new Set([
  'author',
  'asin',
  'category',
  'cover_image_url',
  'document_note',
  'last_highlight_at',
  'num_highlights',
  'readwise_url',
  'source',
  'source_url',
  'tags',
  'title',
  'user_book_id',
])

const HIGHLIGHT_PROPERTY_TEMPLATE_KEYS = new Set([
  'color',
  'created_at',
  'highlight_id',
  'highlighted_at',
  'location',
  'location_type',
  'note',
  'readwise_url',
  'tags',
  'text',
  'updated_at',
])

const nonEmptyString = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  return text.length ? text : undefined
}

const tagNames = (tags: Array<{ name?: string }> | undefined): string[] =>
  (tags ?? [])
    .map(tag => tag.name?.trim())
    .filter((name): name is string => Boolean(name))

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

const normalizedConfiguredTypeIds = (typeIds: readonly string[]): string[] =>
  [...new Set(typeIds.map(cleanText).filter((id): id is string => Boolean(id)))]

const addConfiguredTypes = async (
  tx: any,
  repo: any,
  blockId: string,
  typeIds: readonly string[],
  typeSnapshot: any,
) => {
  for (const typeId of normalizedConfiguredTypeIds(typeIds)) {
    if (!typeSnapshot.types.has(typeId)) continue
    await repo.addTypeInTx(tx, blockId, typeId, {}, typeSnapshot)
  }
}

type ManagedPropertyEntry<T = any> = readonly [PropertySchema<T>, T | undefined]

const applyManagedProperties = async (
  tx: any,
  blockId: string,
  schemas: readonly PropertySchema<any>[],
  entries: readonly ManagedPropertyEntry[],
) => {
  const row = await tx.get(blockId)
  if (!row) return

  const next = { ...row.properties }
  let changed = false
  const values = new Map<string, unknown>()
  for (const [schema, value] of entries) {
    if (value !== undefined) values.set(schema.name, schema.codec.encode(value))
  }

  for (const schema of schemas) {
    if (!values.has(schema.name)) {
      if (Object.prototype.hasOwnProperty.call(next, schema.name)) {
        delete next[schema.name]
        changed = true
      }
      continue
    }
    const encoded = values.get(schema.name)
    if (!sameJson(next[schema.name], encoded)) {
      next[schema.name] = encoded
      changed = true
    }
  }

  if (changed) await tx.update(blockId, { properties: next })
}

const mergeSourceOwnedAlias = async (
  tx: any,
  blockId: string,
  previousTitle: string | undefined,
  nextTitle: string,
) => {
  const current = await tx.getProperty(blockId, aliasesProp)
  if (current.length === 0 || (previousTitle !== undefined && current.length === 1 && current[0] === previousTitle)) {
    await tx.setProperty(blockId, aliasesProp, [nextTitle])
  }
}

const lookupOrCreateAuthorPage = async (
  tx: any,
  repo: any,
  workspaceId: string,
  author: string | undefined,
  authorPageTypeIds: readonly string[],
  typeSnapshot: any,
): Promise<string | undefined> => {
  const name = nonEmptyString(author)
  if (!name) return undefined

  const existing = await tx.aliasLookup(name, workspaceId)
  if (existing && !existing.deleted) return existing.id

  const ensured = await ensureAliasTarget(tx, repo, name, workspaceId, typeSnapshot)
  if (ensured.inserted) {
    await addConfiguredTypes(tx, repo, ensured.id, authorPageTypeIds, typeSnapshot)
  }
  return ensured.id
}

const documentPropertyEntries = (
  book: BookRecord,
  authorPageId: string | undefined,
): ManagedPropertyEntry[] => {
  const tags = tagNames(book.book_tags)
  return [
    [userBookIdProp, String(book.user_book_id)],
    [titleProp, nonEmptyString(book.title)],
    [authorProp, authorPageId],
    [categoryProp, nonEmptyString(book.category)],
    [sourceProp, nonEmptyString(book.source)],
    [sourceUrlProp, nonEmptyString(book.source_url)],
    [readwiseUrlProp, nonEmptyString(book.readwise_url)],
    [coverImageUrlProp, nonEmptyString(book.cover_image_url)],
    [documentNoteProp, nonEmptyString(book.document_note)],
    [numHighlightsProp, optionalNumber(book.num_highlights)],
    [lastHighlightAtProp, nonEmptyString(book.last_highlight_at)],
    [asinProp, nonEmptyString(book.asin)],
    [tagsProp, tags.length ? tags : undefined],
  ]
}

const highlightPropertyEntries = (book: BookRecord, highlight: HighlightRecord): ManagedPropertyEntry[] => {
  const tags = tagNames(highlight.tags)
  return [
    [highlightIdProp, String(highlight.id)],
    [userBookIdProp, String(book.user_book_id)],
    [readwiseUrlProp, nonEmptyString(highlight.readwise_url)],
    [locationProp, nonEmptyString(highlight.location)],
    [locationTypeProp, nonEmptyString(highlight.location_type)],
    [colorProp, nonEmptyString(highlight.color)],
    [highlightedAtProp, nonEmptyString(highlight.highlighted_at)],
    [updatedAtProp, nonEmptyString(highlight.updated_at)],
    [createdAtProp, nonEmptyString(highlight.created_at)],
    [tagsProp, tags.length ? tags : undefined],
  ]
}

const notePropertyEntries = (highlight: HighlightRecord): ManagedPropertyEntry[] => [
  [noteForHighlightIdProp, String(highlight.id)],
]

const reviewDateIsoForSync = (now = new Date()): string => {
  const today = todayIso(now)
  const tomorrowStart = new Date(now)
  tomorrowStart.setHours(24, 0, 0, 0)
  const msUntilTomorrow = tomorrowStart.getTime() - now.getTime()
  return msUntilTomorrow <= REVIEW_ROLLOVER_BUFFER_MINUTES * 60_000
    ? addDaysIso(today, 1)
    : today
}

const ensureHighlightReviewState = async (
  tx: any,
  blockId: string,
  reviewDateBlockId: string,
) => {
  const row = await tx.get(blockId)
  if (!row) return

  const next = { ...row.properties }
  let changed = false
  if (!Object.prototype.hasOwnProperty.call(next, reviewDateProp.name)) {
    next[reviewDateProp.name] = reviewDateProp.codec.encode(reviewDateBlockId)
    changed = true
  }
  if (!Object.prototype.hasOwnProperty.call(next, reviewedProp.name)) {
    next[reviewedProp.name] = reviewedProp.codec.encode(false)
    changed = true
  }
  if (changed) await tx.update(blockId, { properties: next })
}

const readReviewed = (properties: Record<string, unknown>): boolean => {
  const stored = properties[reviewedProp.name]
  if (stored === undefined) return reviewedProp.defaultValue
  try {
    return reviewedProp.codec.decode(stored)
  } catch {
    return reviewedProp.defaultValue
  }
}

const toggleHighlightReviewed = async (block: any): Promise<boolean> => {
  const data = block.peek() ?? await block.load()
  if (!data || !getBlockTypes(data).includes(READWISE_HIGHLIGHT_TYPE)) return false

  if (!block.repo.isReadOnly) {
    await block.set(reviewedProp, !readReviewed(data.properties))
  }
  return true
}

const decorateActionToToggleReadwiseReview = (
  actionId: string,
  context?: ActionContextType,
): ActionTransform => ({
  actionId,
  ...(context ? { context } : {}),
  apply: (action: ActionConfig): ActionConfig => ({
    ...action,
    handler: async (deps, trigger, dispatch) => {
      const block = (deps as BlockShortcutDependencies).block
      if (block && (await toggleHighlightReviewed(block))) return
      await action.handler(deps as never, trigger, dispatch)
    },
  }),
})

const readwiseSwipeRightDecorator: ActionTransform =
  decorateActionToToggleReadwiseReview(SWIPE_RIGHT_BLOCK_ACTION_ID)

const readwiseTodoCycleDecorators: readonly ActionTransform[] = [
  decorateActionToToggleReadwiseReview(
    TODO_CYCLE_ACTION_ID,
    ActionContextTypes.NORMAL_MODE,
  ),
  decorateActionToToggleReadwiseReview(
    EDIT_MODE_TODO_CYCLE_ACTION_ID,
    ActionContextTypes.EDIT_MODE_CM,
  ),
]

// ---------------------------------------------------------------------------
// Readwise export pagination

const fetchExportPage = async (
  token: string,
  updatedAfter: string | null,
  pageCursor: string | null,
): Promise<{ results: BookRecord[]; nextPageCursor: string | null }> => {
  const params = new URLSearchParams()
  if (updatedAfter) params.set('updatedAfter', updatedAfter)
  if (pageCursor) params.set('pageCursor', pageCursor)
  const url = `${READWISE_API}/export/${params.toString() ? `?${params}` : ''}`
  const res = await fetch(url, { headers: { Authorization: `Token ${token}` } })
  if (!res.ok) {
    throw new Error(`Readwise /export returned ${res.status}`)
  }
  const data = await res.json()
  return {
    results: Array.isArray(data.results) ? data.results : [],
    nextPageCursor: data.nextPageCursor ?? null,
  }
}

// ---------------------------------------------------------------------------
// sync

type SyncDeps = {
  repo: ReturnType<typeof useRepo> | any
}

const ensureRoot = async (repo: any, workspaceId: string) => {
  const rootId = pluginBlockId(workspaceId, READWISE_NS, 'library-root')
  const typeSnapshot = repo.snapshotTypeRegistries()
  await repo.tx(async (tx: any) => {
    const existing = await tx.get(rootId)
    if (!existing || existing.deleted) {
      const roots = await tx.childrenOf(null, workspaceId)
      const lastKey = roots.length ? roots[roots.length - 1].orderKey : null
      await createOrRestoreTargetBlock(tx, {
        id: rootId,
        workspaceId,
        parentId: null,
        orderKey: keyBetween(lastKey, null),
        freshContent: 'Readwise Library',
      })
    }
    await repo.addTypeInTx(tx, rootId, PAGE_TYPE, { [aliasesProp.name]: ['Readwise Library'] }, typeSnapshot)
    await repo.addTypeInTx(tx, rootId, READWISE_LIBRARY_TYPE, {}, typeSnapshot)
  }, { scope: ChangeScope.BlockDefault, description: 'readwise: create root' })
  return rootId
}

const ensureHighlightsSection = async (
  tx: any,
  workspaceId: string,
  bookId: string,
  sectionId: string,
  metaIds: readonly string[],
): Promise<string> => {
  const children = await tx.childrenOf(bookId)
  const section = await tx.get(sectionId)
  const metaOrderKeys = metaIds
    .map(id => children.find((child: any) => child.id === id)?.orderKey)
    .filter((key): key is string => typeof key === 'string')
  const lower = metaOrderKeys.length ? metaOrderKeys[metaOrderKeys.length - 1] : null
  const upper = children.find((child: any) =>
    child.id !== sectionId &&
    !metaIds.includes(child.id) &&
    (lower === null || child.orderKey > lower))?.orderKey ?? null
  const targetOrderKey = keyBetween(lower, upper)

  if (!section || section.deleted) {
    await createOrRestoreTargetBlock(tx, {
      id: sectionId,
      workspaceId,
      parentId: bookId,
      orderKey: targetOrderKey,
      freshContent: HIGHLIGHTS_SECTION_CONTENT,
    })
    return sectionId
  }

  if (section.content !== HIGHLIGHTS_SECTION_CONTENT) {
    await tx.update(sectionId, { content: HIGHLIGHTS_SECTION_CONTENT })
  }

  const alreadyInPlace = section.parentId === bookId &&
    (lower === null || section.orderKey > lower) &&
    (upper === null || section.orderKey < upper)
  if (!alreadyInPlace) {
    await tx.move(sectionId, { parentId: bookId, orderKey: targetOrderKey })
  }

  return sectionId
}

const syncBookToBlocks = async (
  repo: any,
  workspaceId: string,
  rootId: string,
  book: BookRecord,
  pageTitleTemplate: string,
  bookTemplate: string,
  highlightTemplate: string,
  authorPageTypeIds: readonly string[],
  documentPageTypeIds: readonly string[],
  highlightTypeIds: readonly string[],
  reviewDateIso: string,
) => {
  const bookId = pluginBlockId(workspaceId, READWISE_NS, `book:${book.user_book_id}`)
  const highlightsSectionId = pluginBlockId(workspaceId, READWISE_NS, `book:${book.user_book_id}:highlights`)
  const bVars = bookVars(book)
  const title = substitute(pageTitleTemplate, bVars).trim() || `Readwise: ${book.title ?? book.user_book_id}`
  const supplementalLines = renderSupplementalTemplateLines(bookTemplate, bVars, BOOK_PROPERTY_TEMPLATE_KEYS)
  const typeSnapshot = repo.snapshotTypeRegistries()
  const highlights = (book.highlights ?? [])
    .filter(h => !h.is_deleted && h.text && h.text.trim().length)
  const reviewDateBlock = highlights.length
    ? await getOrCreateDailyNote(repo, workspaceId, reviewDateIso)
    : null

  await repo.tx(async (tx: any) => {
    // 1. document page
    const existing = await tx.get(bookId)
    if (!existing || existing.deleted) {
      const siblings = await tx.childrenOf(rootId)
      const firstKey = siblings.length ? siblings[0].orderKey : null
      await createOrRestoreTargetBlock(tx, {
        id: bookId,
        workspaceId,
        parentId: rootId,
        orderKey: keyBetween(null, firstKey),
        freshContent: title,
      })
    } else if (existing.content !== title) {
      await tx.update(bookId, { content: title })
    }
    await repo.addTypeInTx(tx, bookId, PAGE_TYPE, { [aliasesProp.name]: [title] }, typeSnapshot)
    await repo.addTypeInTx(tx, bookId, READWISE_DOCUMENT_TYPE, {}, typeSnapshot)
    await addConfiguredTypes(tx, repo, bookId, documentPageTypeIds, typeSnapshot)
    await mergeSourceOwnedAlias(tx, bookId, existing?.content, title)
    const authorPageId = await lookupOrCreateAuthorPage(
      tx,
      repo,
      workspaceId,
      book.author,
      authorPageTypeIds,
      typeSnapshot,
    )
    await applyManagedProperties(tx, bookId, DOCUMENT_PROPERTY_SCHEMAS, documentPropertyEntries(book, authorPageId))

    // 2. supplemental template children. Property-backed template lines are
    //    intentionally omitted here because their values live on the
    //    Readwise document type.
    const bookKids = await tx.childrenOf(bookId)
    const metaIds = supplementalLines.map((_, i) =>
      pluginBlockId(workspaceId, READWISE_NS, `book:${book.user_book_id}:meta:${i}`))

    // Template lines sit at the top of the book page, before any other children.
    const firstNonMetaKey = bookKids.find((k: any) => !metaIds.includes(k.id))?.orderKey ?? null
    const metaKeys = keysBetween(null, firstNonMetaKey, supplementalLines.length || 1)

    for (let i = 0; i < supplementalLines.length; i++) {
      const id = metaIds[i]
      const content = supplementalLines[i]
      const orderKey = metaKeys[i]
      const existingMetaBlock = await tx.get(id)
      if (!existingMetaBlock || existingMetaBlock.deleted) {
        await createOrRestoreTargetBlock(tx, {
          id, workspaceId, parentId: bookId, orderKey, freshContent: content,
        })
      } else {
        if (existingMetaBlock.content !== content) {
          await tx.update(id, { content })
        }
      }
    }
    // 3. highlights live under a deterministic sub-bullet on the document
    //    page, with notes still nested under their highlight.
    if (!highlights.length) return

    await ensureHighlightsSection(tx, workspaceId, bookId, highlightsSectionId, metaIds)

    const sectionKids = await tx.childrenOf(highlightsSectionId)
    const lastHighlightKey = sectionKids.length ? sectionKids[sectionKids.length - 1].orderKey : null
    const newHighlightKeys = keysBetween(lastHighlightKey, null, highlights.length || 1)
    let nextNewHighlightKey = 0

    for (let i = 0; i < highlights.length; i++) {
      const h = highlights[i]
      const hId = pluginBlockId(workspaceId, READWISE_NS, `hl:${h.id}`)
      const hVars = highlightVars(h)
      const hLines = renderTemplateLines(highlightTemplate, hVars)
      const hContent = hLines[0] ?? (h.text ?? '')
      const noteLines = renderSupplementalTemplateLines(
        highlightTemplate.split('\n').slice(1).join('\n'),
        hVars,
        HIGHLIGHT_PROPERTY_TEMPLATE_KEYS,
      )
      const noteText = nonEmptyString(h.note)

      const existingH = await tx.get(hId)
      if (!existingH || existingH.deleted) {
        await createOrRestoreTargetBlock(tx, {
          id: hId,
          workspaceId,
          parentId: highlightsSectionId,
          orderKey: newHighlightKeys[nextNewHighlightKey++],
          freshContent: hContent,
        })
      } else {
        if (existingH.content !== hContent) {
          await tx.update(hId, { content: hContent })
        }
      }
      await repo.addTypeInTx(tx, hId, READWISE_HIGHLIGHT_TYPE, {}, typeSnapshot)
      await addConfiguredTypes(tx, repo, hId, highlightTypeIds, typeSnapshot)
      await applyManagedProperties(tx, hId, HIGHLIGHT_PROPERTY_SCHEMAS, highlightPropertyEntries(book, h))
      if (reviewDateBlock) {
        await ensureHighlightReviewState(tx, hId, reviewDateBlock.id)
      }

      // a single deterministic note child
      const noteId = pluginBlockId(workspaceId, READWISE_NS, `hl:${h.id}:note`)
      const extraLines = [noteText, ...noteLines].filter(s => s && s.trim().length)
      const noteBlock = await tx.get(noteId)
      if (extraLines.length === 0) {
        if (noteBlock) await tx.delete(noteId)
      } else {
        const noteContent = extraLines.join('\n')
        if (!noteBlock || noteBlock.deleted) {
          const hKids = await tx.childrenOf(hId)
          const lastHKid = hKids.length ? hKids[hKids.length - 1].orderKey : null
          await createOrRestoreTargetBlock(tx, {
            id: noteId, workspaceId, parentId: hId,
            orderKey: keyBetween(lastHKid, null),
            freshContent: noteContent,
          })
        } else if (noteBlock.content !== noteContent) {
          await tx.update(noteId, { content: noteContent })
        }
        await repo.addTypeInTx(tx, noteId, READWISE_NOTE_TYPE, {}, typeSnapshot)
        await applyManagedProperties(tx, noteId, NOTE_PROPERTY_SCHEMAS, notePropertyEntries(h))
      }
    }
  }, { scope: ChangeScope.BlockDefault, description: `readwise: sync book ${book.user_book_id}` })
}

const runSync = async (repo: any, { silent = false } = {}) => {
  const token = loadToken()
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) {
    if (!silent) showError('No active workspace')
    return
  }
  if (!token) {
    if (!silent) {
      showError('Connect Readwise first', {
        action: { label: 'Connect', onClick: () => setSetupOpen(true) },
      })
    }
    return
  }
  const prefs = await getPluginPrefsBlock(repo, workspaceId, repo.user, readwisePrefsType)
  const lastSynced = prefs.peekProperty(lastSyncedAtProp)
  const syncSince = prefs.peekProperty(syncSinceProp)
  const updatedAfter = lastSynced ?? syncSince?.toISOString() ?? null
  const pageTitleTemplate = prefs.get(pageTitleTemplateProp)
  const bookTemplate = prefs.get(bookTemplateProp)
  const highlightTemplate = prefs.get(highlightTemplateProp)
  const authorPageTypeIds = prefs.get(authorPageTypesProp)
  const documentPageTypeIds = prefs.get(documentPageTypesProp)
  const highlightTypeIds = prefs.get(highlightTypesProp)
  const reviewDateIso = reviewDateIsoForSync(new Date())

  let progress = silent ? null : showProgress('Readwise: fetching…')
  try {
    const rootId = await ensureRoot(repo, workspaceId)
    let pageCursor: string | null = null
    let bookCount = 0
    let highlightCount = 0
    do {
      const { results, nextPageCursor } = await fetchExportPage(token, updatedAfter, pageCursor)
      pageCursor = nextPageCursor
      for (const book of results) {
        bookCount++
        highlightCount += (book.highlights ?? []).length
        if (!progress) progress = showProgress('Readwise: syncing…')
        progress.update(`Readwise: ${bookCount} books, ${highlightCount} highlights…`)
        await syncBookToBlocks(
          repo, workspaceId, rootId, book,
          pageTitleTemplate, bookTemplate, highlightTemplate,
          authorPageTypeIds, documentPageTypeIds, highlightTypeIds, reviewDateIso,
        )
      }
    } while (pageCursor)

    const finishedAt = new Date().toISOString()
    await prefs.set(lastSyncedAtProp, finishedAt)
    progress?.done(bookCount === 0
      ? undefined
      : `Readwise: synced ${bookCount} book(s), ${highlightCount} highlight(s)`)
  } catch (err: any) {
    if (progress) {
      progress.fail(`Readwise sync failed: ${err?.message ?? err}`)
    } else if (!silent) {
      showError(`Readwise sync failed: ${err?.message ?? err}`)
    }
  }
}

// ---------------------------------------------------------------------------
// setup dialog (one-time token entry, plus disconnect)

const ReadwiseSetupDialog = () => {
  const repo = useRepo()
  const open = useSyncExternalStore(subscribeSetupOpen, () => setupOpen)
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)

  // Clear any stale token entry each time the dialog opens.
  useEffect(() => {
    if (open) setToken('')
  }, [open])

  const save = async () => {
    setSaving(true)
    try {
      const ok = await validateToken(token)
      if (!ok) {
        showError('Readwise rejected that token. Check it and try again.')
        return
      }
      saveToken(token)
      // mirror connected state into prefs so the settings panel can read it
      const workspaceId = repo.activeWorkspaceId
      if (workspaceId) {
        const prefs = await getPluginPrefsBlock(repo, workspaceId, repo.user, readwisePrefsType)
        await prefs.set(connectedHintProp, true)
      }
      showSuccess('Readwise connected.')
      setSetupOpen(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setSetupOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Readwise</DialogTitle>
          <DialogDescription>
            Grab an access token from{' '}
            <a href='https://readwise.io/access_token' target='_blank' rel='noreferrer'>
              readwise.io/access_token
            </a>
            {' '}and paste it here.
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-2'>
          <Label htmlFor='rw-token'>Access token</Label>
          <Input
            id='rw-token'
            value={token}
            onChange={e => setToken(e.target.value)}
            disabled={saving}
            autoFocus
            type='password'
            placeholder='paste token'
          />
        </div>
        <DialogFooter>
          <Button variant='ghost' onClick={() => setSetupOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={!token || saving}>
            {saving ? 'Validating…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// property editors (rendered inline in the prefs block's property panel)

const TextareaEditor = ({ value, onChange }: PropertyEditorProps<string>) => (
  <Textarea
    value={value}
    onChange={e => onChange(e.target.value)}
    rows={Math.max(3, value.split('\n').length + 1)}
    spellCheck={false}
    style={{ fontFamily: 'monospace', width: '100%' }}
  />
)

const NumberEditor = ({ value, onChange }: PropertyEditorProps<number>) => (
  <Input
    type='number'
    min={0}
    value={value}
    onChange={e => onChange(Number(e.target.value) || 0)}
    style={{ width: '8rem' }}
  />
)

const ConnectedEditor = ({ value, onChange, block }: PropertyEditorProps<boolean>) => {
  const tokenPresent = loadToken() != null
  const connected = value && tokenPresent
  const repo = useRepo()
  return (
    <div className='flex items-center gap-2'>
      <span>{connected ? 'Connected ✓' : 'Not connected'}</span>
      {connected
        ? (
          <Button
            variant='outline'
            size='sm'
            onClick={async () => {
              clearToken()
              onChange(false)
              // also clear sync checkpoint so a reconnect starts fresh
              void block
              void repo
              showInfo('Readwise disconnected.')
            }}
          >Disconnect</Button>
          )
        : (
          <Button
            size='sm'
            onClick={() => setSetupOpen(true)}
          >Connect…</Button>
          )}
      <Button
        variant='outline'
        size='sm'
        onClick={() => runSync(repo)}
        disabled={!tokenPresent}
      >Sync now</Button>
    </div>
  )
}

const LastSyncedEditor = ({ value }: PropertyEditorProps<string | undefined>) => (
  <span style={{ color: 'var(--muted-foreground)' }}>
    {value ? `last synced ${new Date(value).toLocaleString()}` : 'never synced'}
  </span>
)

// ---------------------------------------------------------------------------
// actions

const openSettingsAction = {
  id: 'readwise.configure',
  description: 'Readwise: open settings',
  context: ActionContextTypes.GLOBAL,
  handler: async ({ uiStateBlock }: { uiStateBlock: any }) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const prefs = await getPluginPrefsBlock(repo, workspaceId, repo.user, readwisePrefsType)
    await prefs.set(showPropertiesProp, true)
    navigate(repo, { target: 'new-panel', blockId: prefs.id, workspaceId })
  },
}

const syncNowAction = {
  id: 'readwise.sync',
  description: 'Readwise: sync now',
  context: ActionContextTypes.GLOBAL,
  handler: async ({ uiStateBlock }: { uiStateBlock: any }) => {
    await runSync(uiStateBlock.repo)
  },
}

const connectAction = {
  id: 'readwise.connect',
  description: 'Readwise: connect / change token',
  context: ActionContextTypes.GLOBAL,
  handler: () => setSetupOpen(true),
}

// ---------------------------------------------------------------------------
// background sync effect — runs while interval > 0 and a token is present

const autoSyncEffect = {
  id: 'readwise.auto-sync',
  start: ({ repo }: { repo: any }) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    const schedule = async () => {
      if (cancelled) return
      const workspaceId = repo.activeWorkspaceId
      if (!workspaceId) {
        timer = setTimeout(schedule, 60_000)
        return
      }
      try {
        const prefs = await getPluginPrefsBlock(repo, workspaceId, repo.user, readwisePrefsType)
        const minutes = prefs.peekProperty(autoSyncIntervalProp) ?? 0
        const token = loadToken()
        if (minutes > 0 && token) {
          await runSync(repo, { silent: true })
        }
        const nextMs = minutes > 0 ? minutes * 60_000 : 5 * 60_000
        timer = setTimeout(schedule, nextMs)
      } catch {
        timer = setTimeout(schedule, 5 * 60_000)
      }
    }

    // first run after a short delay so we don't pile work onto bootstrap
    timer = setTimeout(schedule, 10_000)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  },
}

// ---------------------------------------------------------------------------
// editor overrides

const connectedEditor = definePropertyEditorOverride<boolean>({
  name: connectedHintProp.name,
  label: 'Readwise',
  Editor: ConnectedEditor,
})
const lastSyncedEditor = definePropertyEditorOverride<string | undefined>({
  name: lastSyncedAtProp.name,
  label: 'Last synced',
  Editor: LastSyncedEditor,
})
const syncSinceEditor = definePropertyEditorOverride<Date | undefined>({
  name: syncSinceProp.name,
  label: 'Initial sync start date',
})
const pageTitleEditor = definePropertyEditorOverride<string>({
  name: pageTitleTemplateProp.name,
  label: 'Page title template',
})
const bookTemplateEditor = definePropertyEditorOverride<string>({
  name: bookTemplateProp.name,
  label: 'Document supplemental template',
})
const highlightTemplateEditor = definePropertyEditorOverride<string>({
  name: highlightTemplateProp.name,
  label: 'Highlight template',
  Editor: TextareaEditor,
})
const autoSyncEditor = definePropertyEditorOverride<number>({
  name: autoSyncIntervalProp.name,
  label: 'Auto-sync interval (minutes; 0 = off)',
  Editor: NumberEditor,
})
const authorPageTypesEditor = definePropertyEditorOverride<readonly string[]>({
  name: authorPageTypesProp.name,
  label: 'New author page types',
})
const documentPageTypesEditor = definePropertyEditorOverride<readonly string[]>({
  name: documentPageTypesProp.name,
  label: 'Document page types',
})
const highlightTypesEditor = definePropertyEditorOverride<readonly string[]>({
  name: highlightTypesProp.name,
  label: 'Highlight types',
})

// ---------------------------------------------------------------------------
// wiring

const source = 'readwise'

export default [
  typesFacet.of(readwisePrefsType, { source }),
  typesFacet.of(readwiseLibraryType, { source }),
  typesFacet.of(readwiseDocumentType, { source }),
  typesFacet.of(readwiseHighlightType, { source }),
  typesFacet.of(readwiseNoteType, { source }),

  propertySchemasFacet.of(lastSyncedAtProp, { source }),
  propertySchemasFacet.of(syncSinceProp, { source }),
  propertySchemasFacet.of(pageTitleTemplateProp, { source }),
  propertySchemasFacet.of(bookTemplateProp, { source }),
  propertySchemasFacet.of(highlightTemplateProp, { source }),
  propertySchemasFacet.of(autoSyncIntervalProp, { source }),
  propertySchemasFacet.of(authorPageTypesProp, { source }),
  propertySchemasFacet.of(documentPageTypesProp, { source }),
  propertySchemasFacet.of(highlightTypesProp, { source }),
  propertySchemasFacet.of(connectedHintProp, { source }),
  ...IMPORTED_PROPERTY_SCHEMAS.map(schema => propertySchemasFacet.of(schema, { source })),

  propertyEditorOverridesFacet.of(connectedEditor, { source }),
  propertyEditorOverridesFacet.of(lastSyncedEditor, { source }),
  propertyEditorOverridesFacet.of(syncSinceEditor, { source }),
  propertyEditorOverridesFacet.of(pageTitleEditor, { source }),
  propertyEditorOverridesFacet.of(bookTemplateEditor, { source }),
  propertyEditorOverridesFacet.of(highlightTemplateEditor, { source }),
  propertyEditorOverridesFacet.of(autoSyncEditor, { source }),
  propertyEditorOverridesFacet.of(authorPageTypesEditor, { source }),
  propertyEditorOverridesFacet.of(documentPageTypesEditor, { source }),
  propertyEditorOverridesFacet.of(highlightTypesEditor, { source }),

  appMountsFacet.of({ id: 'readwise.setup-dialog', component: ReadwiseSetupDialog }, { source }),
  appEffectsFacet.of(autoSyncEffect, { source }),
  blockContentDecoratorsFacet.of(readwiseDocumentContentDecorator, { source }),

  actionsFacet.of(openSettingsAction, { source }),
  actionsFacet.of(syncNowAction, { source }),
  actionsFacet.of(connectAction, { source }),
  actionTransformsFacet.of(readwiseSwipeRightDecorator, { source }),
  ...readwiseTodoCycleDecorators.map(decorator =>
    actionTransformsFacet.of(decorator, { source })),
]
