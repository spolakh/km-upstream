import {
  actionsFacet, ActionContextTypes, appEffectsFacet, appMountsFacet,
  blockContentDecoratorsFacet,
  ChangeScope, codecs, defineBlockType, defineProperty, definePropertyEditorOverride,
  getPluginPrefsBlock, pluginBlockId, propertyEditorOverridesFacet, propertySchemasFacet,
  showError, showInfo, showSuccess, showPropertiesProp, typesFacet, useRepo,
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
  type PropertyEditorProps,
} from '@/extensions/api.js'
import { useHandle } from '@/hooks/block.js'
import type { Block } from '@/data/block.js'
import type { BlockRenderer } from '@/types.js'
import { keyAtEnd, keysBetween } from '@/data/orderKey.js'
import { createOrRestoreTargetBlock } from '@/data/targets.js'
import { addBlockTypeToProperties } from '@/data/properties.js'
import { dailyNoteBlockId, getOrCreateDailyNote, todayIso } from '@/plugins/daily-notes/index.js'
import { computePromotedFromChildren } from '@/plugins/roam-import/plan.js'
import { navigate } from '@/utils/navigation.js'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { Label } from '@/components/ui/label.js'
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import * as matrixSdk from 'https://esm.sh/matrix-js-sdk@38.0.0?bundle'

// ---------------------------------------------------------------------------
// constants

const source = 'matrix-chat-client'
const MATRIX_MESSAGE_TYPE = 'matrix-message'
const TAG_BLOCK_CONTENT = '[[matrix-messages]]'
const POLL_ERROR_DELAY_MS = 5_000

// Stable namespace for deterministic block ids. Derived ids (the per-day tag
// block and every node of a message tree) are a uuidv5 of the workspace + a
// plugin-internal key under this namespace, so two devices that independently
// ingest the same matrix event compute the *same* ids and PowerSync merges
// their writes instead of duplicating the message. Picked once; never change.
const MATRIX_NS = '9839e327-a96a-4974-acb1-128fc44878b8'

// secret — lives only in localStorage, never in a synced block or toast output
const TOKEN_KEY = 'knowledge-medium:matrix:token:v1'
// per-client long-poll cursor — device/server specific, must NOT sync, so it
// stays in localStorage. Key + JSON shape are kept byte-identical to the
// pre-refactor `.js` so an upgrading client resumes from its existing /sync
// position with no gap and no migration.
const NEXT_BATCH_PREFIX = 'knowledge-medium:matrix-messages:state:v1'
// one-time migration marker (per workspace) — see migrateEventNamespace.
const MIGRATION_FLAG_PREFIX = 'knowledge-medium:matrix:migrated:event-ns:v1'
// pre-refactor config blob (homeserver/room/autoStart/token in one localStorage
// JSON) + a per-device flag for the one-time carry-over (see migrateLegacyConfig).
const LEGACY_CONFIG_KEY = 'knowledge-medium:matrix-messages:config:v1'
const LEGACY_CONFIG_FLAG = 'knowledge-medium:matrix:legacy-config-migrated:v1'

// Setup-dialog visibility — a typed module store, NOT a window CustomEvent.
// The connect action / header button flip it; the mounted dialog reads it
// with useSyncExternalStore (the mechanism the app's own DialogHost uses).
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

// Genuine broadcast: wakes the running ingest effect to restart (not a
// dialog/toggle), so it stays a window CustomEvent.
const RESTART_EVENT = 'matrix:ingest:restart'

// ---------------------------------------------------------------------------
// properties — config lives on the per-plugin prefs block; the access token
// stays in localStorage. Event metadata on message blocks lives under the
// reserved `matrix-event:*` namespace so it can never collide with `key::value`
// attributes promoted out of message *content* (which keep the `matrix:*`
// namespace — see matrixPromotionOptions below).

const homeserverProp = defineProperty<string>('matrix:homeserver', {
  codec: codecs.string,
  defaultValue: 'https://matrix.org',
  changeScope: ChangeScope.BlockDefault,
})
const roomIdProp = defineProperty<string>('matrix:roomId', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const autoStartProp = defineProperty<boolean>('matrix:autoStart', {
  codec: codecs.boolean,
  defaultValue: true,
  changeScope: ChangeScope.BlockDefault,
})
// UI hints mirrored onto the prefs block so the settings panel can render
// connection/status without subscribing to localStorage or the poll loop.
const connectedHintProp = defineProperty<boolean>('matrix:connected', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.UserPrefs,
})
const statusProp = defineProperty<string | undefined>('matrix:status', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.UserPrefs,
})

// Per-message event metadata. Reserved `matrix-event:*` namespace.
const eventIdProp = defineProperty<string>('matrix-event:id', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const eventRoomProp = defineProperty<string>('matrix-event:room', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const eventUrlProp = defineProperty<string | undefined>('matrix-event:url', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const eventAuthorProp = defineProperty<string | undefined>('matrix-event:author', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
const eventTimestampProp = defineProperty<number | undefined>('matrix-event:timestamp', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

const matrixChatPrefsType = defineBlockType({
  id: 'matrix-chat-prefs',
  label: 'Matrix',
  // Prefs container is plumbing for the # dropdown (typing #Matrix
  // must offer creating the user's own type, not tag with this);
  // the chip stays informative on the container block itself.
  hideFromCompletion: true,
  properties: [homeserverProp, roomIdProp, autoStartProp, connectedHintProp, statusProp],
})
const matrixMessageType = defineBlockType({
  id: MATRIX_MESSAGE_TYPE,
  label: 'Matrix message',
  description: 'A message ingested from a Matrix room.',
  properties: [eventIdProp, eventRoomProp, eventUrlProp, eventAuthorProp, eventTimestampProp],
})

// Mapping for the one-time rename of the legacy `matrix:*` event-metadata
// keys onto the reserved `matrix-event:*` namespace.
const EVENT_KEY_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ['matrix:eventId', eventIdProp.name],
  ['matrix:roomId', eventRoomProp.name],
  ['matrix:url', eventUrlProp.name],
  ['matrix:author', eventAuthorProp.name],
  ['matrix:timestamp', eventTimestampProp.name],
]

// ---------------------------------------------------------------------------
// config / secret storage

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, '')

const loadToken = (): string | null => window.localStorage.getItem(TOKEN_KEY)
const saveToken = (t: string) => window.localStorage.setItem(TOKEN_KEY, t)
const clearToken = () => window.localStorage.removeItem(TOKEN_KEY)

interface MatrixConfig {
  baseUrl: string
  roomId: string
  accessToken: string
  autoStart: boolean
}

const prefsBlock = (repo: any) => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return null
  return getPluginPrefsBlock(repo, workspaceId, repo.user, matrixChatPrefsType)
}

const loadConfig = async (repo: any): Promise<MatrixConfig | null> => {
  const prefs = await prefsBlock(repo)
  if (!prefs) return null
  const baseUrl = normalizeBaseUrl(prefs.get(homeserverProp))
  const roomId = prefs.get(roomIdProp)
  const accessToken = loadToken()
  if (!baseUrl || !roomId || !accessToken) return null
  return {baseUrl, roomId, accessToken, autoStart: prefs.get(autoStartProp)}
}

const setStatus = async (repo: any, status: string): Promise<void> => {
  try {
    const prefs = await prefsBlock(repo)
    if (prefs && prefs.peekProperty(statusProp) !== status) await prefs.set(statusProp, status)
  } catch {
    // status is a best-effort UI hint — never let it break the poll loop
  }
}

// ---------------------------------------------------------------------------
// long-poll cursor (localStorage)

const nextBatchKey = (config: Pick<MatrixConfig, 'baseUrl' | 'roomId'>): string =>
  `${NEXT_BATCH_PREFIX}:${normalizeBaseUrl(config.baseUrl)}:${config.roomId}`

// `{nextBatch, savedAt}` JSON, matching the pre-refactor `.js` byte-for-byte so
// an upgrading client's existing cursor is read transparently.
const loadNextBatch = (config: MatrixConfig): string | null => {
  const raw = window.localStorage.getItem(nextBatchKey(config))
  if (!raw) return null
  try {
    const state = JSON.parse(raw)
    return typeof state?.nextBatch === 'string' ? state.nextBatch : null
  } catch {
    return null
  }
}

const saveNextBatch = (config: MatrixConfig, nextBatch: string) =>
  window.localStorage.setItem(nextBatchKey(config), JSON.stringify({nextBatch, savedAt: Date.now()}))

const clearNextBatch = (config: Pick<MatrixConfig, 'baseUrl' | 'roomId'>) =>
  window.localStorage.removeItem(nextBatchKey(config))

// ---------------------------------------------------------------------------
// matrix sync

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timeout = window.setTimeout(resolve, ms)
  signal.addEventListener('abort', () => {
    window.clearTimeout(timeout)
    reject(new DOMException('Aborted', 'AbortError'))
  }, {once: true})
})

const syncFilter = (config: MatrixConfig) => ({
  room: {
    rooms: [config.roomId],
    timeline: {types: ['m.room.message'], limit: 30},
    state: {types: []},
    ephemeral: {types: []},
    account_data: {types: []},
  },
  presence: {types: []},
  account_data: {types: []},
})

const buildSyncQueryParams = (config: MatrixConfig, since: string | null) => {
  const queryParams: Record<string, string> = {
    timeout: since ? '30000' : '0',
    filter: JSON.stringify(syncFilter(config)),
  }
  if (since) queryParams.since = since
  return queryParams
}

const createMatrixClient = (config: MatrixConfig) =>
  matrixSdk.createClient({
    baseUrl: normalizeBaseUrl(config.baseUrl),
    accessToken: config.accessToken,
  })

const fetchMatrixSync = (config: MatrixConfig, since: string | null, signal: AbortSignal, matrixClient: any) =>
  matrixClient.http.authedRequest(
    'GET',
    '/sync',
    buildSyncQueryParams(config, since),
    undefined,
    {abortSignal: signal},
  )

const roomEventsFromSync = (syncBody: any, roomId: string): any[] => {
  const events = syncBody?.rooms?.join?.[roomId]?.timeline?.events
  return Array.isArray(events) ? events : []
}

const eventTimestamp = (event: any): number => {
  const ts = event?.origin_server_ts
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now()
}

// ---------------------------------------------------------------------------
// message text → markdown

const escapeRegex = (value: unknown) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const unwrapLinks = (value: unknown): string => {
  let text = String(value ?? '')
  text = text.replace(
    /\[(.*?)]\(https:\/\/roamresearch\.com\/#\/app\/[^/]+\/page\/[a-zA-Z-_0-9]+?\)/g,
    '$1',
  )

  const origin = window.location?.origin
  if (origin) {
    text = text.replace(new RegExp(`\\[(.*?)]\\(${escapeRegex(origin)}\\/[^)]*\\)`, 'g'), '$1')
  }

  return text
}

const mxcToHttpUrl = (mxcUrl: unknown, matrixClient: any): string => {
  if (typeof mxcUrl !== 'string' || !mxcUrl.startsWith('mxc://')) return (mxcUrl as string) || ''

  return matrixClient.mxcUrlToHttp(
    mxcUrl,
    undefined,
    undefined,
    undefined,
    false,
    true,
    false,
  ) || ''
}

const getMediaLabel = (content: any, fallback: string): string =>
  String(content.body || content.filename || fallback).trim() || fallback

const getMessageText = (event: any, matrixClient: any): string => {
  const content = event.content && typeof event.content === 'object' ? event.content : {}
  const msgtype = typeof content.msgtype === 'string' ? content.msgtype : 'm.room.message'

  if (msgtype === 'm.audio') {
    return `{{[[audio]]: ${mxcToHttpUrl(content.url, matrixClient)} }}`
  }

  if (msgtype === 'm.image') {
    return `![${getMediaLabel(content, 'image')}](${mxcToHttpUrl(content.url, matrixClient)})`
  }

  if (msgtype === 'm.file' || msgtype === 'm.video') {
    return `[${getMediaLabel(content, msgtype)}](${mxcToHttpUrl(content.url, matrixClient)})`
  }

  if (msgtype === 'm.emote') return `* ${unwrapLinks(content.body)}`
  return unwrapLinks(content.body || content.url || msgtype)
}

interface BlockDef {
  content: string
  children?: BlockDef[]
  properties?: Record<string, unknown>
}

const isListItem = (line: string) => /^(\s*)-\s+/.test(line)

const parseListItem = (line: string) => {
  const listItemMatch = line.match(/^(\s*)-\s+(.*)/)
  if (!listItemMatch) throw new Error('Invalid list item format')
  return {leadingSpaces: listItemMatch[1].length, content: listItemMatch[2]}
}

const isValidIndentation = (spaces: number) => spaces % 2 === 0

const appendContinuationLine = (block: BlockDef, line: string) => {
  block.content += `\n${line.trim()}`
}

const parseLines = (lines: string[], level = 0): BlockDef[] | null => {
  const blocks: BlockDef[] = []

  while (lines.length > 0) {
    const line = lines[0]

    if (isListItem(line)) {
      const {leadingSpaces, content} = parseListItem(line)
      if (!isValidIndentation(leadingSpaces)) return null

      const indentationLevel = leadingSpaces / 2
      if (indentationLevel < level) break

      if (indentationLevel > level) {
        if (!blocks.length) return null
        const nestedBlocks = parseLines(lines, indentationLevel)
        if (!nestedBlocks) return null
        const parent = blocks[blocks.length - 1]
        parent.children = [...(parent.children ?? []), ...nestedBlocks]
        continue
      }

      lines.shift()
      blocks.push({content})
      continue
    }

    if (!blocks.length) return null
    appendContinuationLine(blocks[blocks.length - 1], line)
    lines.shift()
  }

  return blocks
}

const parseMarkdownToBlockDefinitions = (markdownText: string): BlockDef[] => {
  const source = String(markdownText ?? '')
  const lines = source.split(/\r?\n/).filter(line => line.trim() !== '')
  const blocks = parseLines([...lines])
  return blocks && blocks.length ? blocks : [{content: source.trim() || '(empty message)'}]
}

// ---------------------------------------------------------------------------
// attribute promotion — `key::value` children of message *content* are hoisted
// onto their parent under the `matrix:*` namespace. This is deliberately
// distinct from the reserved `matrix-event:*` keys the ingest sets, so a chat
// message that happens to contain `timestamp::…` can never overwrite the
// event's own timestamp.

const matrixEventUrl = (roomId: string, eventId: string) => `https://matrix.to/#/${roomId}/${eventId}`
const matrixPromotionOptions = {
  namespacePrefix: 'matrix',
  transformKey: (key: string) => key.toLowerCase(),
}

const propertyValues = (value: unknown): unknown[] => Array.isArray(value) ? value : [value]

const samePropertyValue = (left: unknown, right: unknown) => Object.is(left, right)

const mergePropertyValue = (current: unknown, incoming: unknown): unknown => {
  if (current === undefined) return incoming

  const values: unknown[] = []
  for (const value of [...propertyValues(current), ...propertyValues(incoming)]) {
    if (!values.some(existing => samePropertyValue(existing, value))) {
      values.push(value)
    }
  }
  return values.length === 1 ? values[0] : values
}

const mergeProperties = (...propertyBags: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined => {
  const merged: Record<string, unknown> = {}
  for (const bag of propertyBags) {
    if (!bag || typeof bag !== 'object') continue
    for (const [key, value] of Object.entries(bag)) {
      merged[key] = mergePropertyValue(merged[key], value)
    }
  }
  return Object.keys(merged).length ? merged : undefined
}

const blockPathUid = (path: number[]) => `matrix-message:${path.join('.')}`

const toRoamBlock = (block: BlockDef, path: number[]): any => ({
  uid: blockPathUid(path),
  string: block.content,
  children: (block.children ?? []).map((child, index) => toRoamBlock(child, [...path, index])),
})

const withPromotedMatrixProperties = (blocks: BlockDef[], bubbled = new Set<string>(), path: number[] = []): BlockDef[] =>
  blocks.flatMap((block, index) => {
    const blockPath = [...path, index]
    const children = Array.isArray(block.children) ? block.children : []
    const promotion = computePromotedFromChildren(
      children.map((child, childIndex) => toRoamBlock(child, [...blockPath, childIndex])),
      bubbled,
      matrixPromotionOptions,
    )

    for (const uid of promotion.bubbled) bubbled.add(uid)

    const promotedChildren = withPromotedMatrixProperties(children, bubbled, blockPath)
    const next: BlockDef = {
      ...block,
      properties: mergeProperties(block.properties, promotion.promoted),
      children: promotedChildren.length ? promotedChildren : undefined,
    }

    // Subtractive promotion: drop a node whose own `key::value` was hoisted into
    // its parent's props AND whose whole subtree was consumed — the value lives
    // on as the derived prop. The anchor (root) is never bubbled, so it always
    // survives; a consumed attr that still has non-attr children is kept so they
    // aren't orphaned. (Diverges from the Roam importer, which preserves attr
    // blocks for fidelity; chat ingest wants the literal bullet gone.)
    if (bubbled.has(blockPathUid(blockPath)) && !next.children) return []
    return [next]
  })

const nestTopLevelBlocksUnderFirst = (blocks: BlockDef[]): BlockDef[] => {
  if (blocks.length <= 1) return blocks
  const [first, ...rest] = blocks
  return [{
    ...first,
    children: [...(first.children ?? []), ...rest],
  }]
}

const createBlocksFromEvent = (event: any, matrixClient: any): BlockDef[] => {
  const text = getMessageText(event, matrixClient)
  return withPromotedMatrixProperties(
    nestTopLevelBlocksUnderFirst(parseMarkdownToBlockDefinitions(text)),
  )
}

// ---------------------------------------------------------------------------
// write the message into today's daily note

// Deterministic id for a node of a message tree, keyed by the matrix event id
// and the node's index path within that message. `[0]` is the message root
// (the single elected-first block under the day's tag block); `[0, 1]` is its
// second child, and so on. Same event + same path → same id on every device.
const messageNodeId = (workspaceId: string, eventId: string, path: number[]): string =>
  pluginBlockId(workspaceId, MATRIX_NS, `event:${eventId}:${path.join('.')}`)

const createBlockTree = async (
  tx: any,
  workspaceId: string,
  parentId: string,
  blockDefinitions: BlockDef[],
  eventId: string,
  rootProperties?: Record<string, unknown>,
  path: number[] = [],
): Promise<void> => {
  if (!blockDefinitions.length) return

  const existingChildren = await tx.childrenOf(parentId, workspaceId)
  const orderKeys = keysBetween(
    existingChildren.at(-1)?.orderKey ?? null,
    null,
    blockDefinitions.length,
  )

  for (const [index, block] of blockDefinitions.entries()) {
    const nodePath = [...path, index]
    const isMessageRoot = path.length === 0 && index === 0
    const merged = mergeProperties(isMessageRoot ? rootProperties : undefined, block.properties)
    // The message root is marked as a `matrix-message` block so its event
    // metadata renders under that type in the property panel. addBlockType…
    // re-encodes `types` through the list codec — going through our own
    // mergeProperties would collapse a single-element list back to a scalar.
    const properties = isMessageRoot
      ? addBlockTypeToProperties(merged ?? {}, MATRIX_MESSAGE_TYPE)
      : merged

    const id = await tx.create({
      id: messageNodeId(workspaceId, eventId, nodePath),
      workspaceId,
      parentId,
      orderKey: orderKeys[index],
      content: block.content,
      properties,
    })

    if (Array.isArray(block.children) && block.children.length) {
      await createBlockTree(tx, workspaceId, id, block.children, eventId, undefined, nodePath)
    }
  }
}

// Find this day's `[[matrix-messages]]` container, or create it. The id is
// deterministic per (workspace, date) so two devices ingesting on the same day
// converge on one container instead of creating two. We still prefer an
// existing block found by content scan — that reuses a container made by an
// older (random-id) build, or one already synced in from another device,
// rather than orphaning its messages under a fresh deterministic id.
const ensureMatrixTagBlock = async (
  tx: any,
  workspaceId: string,
  dailyId: string,
  iso: string,
): Promise<string> => {
  const dailyChildren = await tx.childrenOf(dailyId, workspaceId)
  const existing = dailyChildren.find((child: any) => child.content.trim() === TAG_BLOCK_CONTENT)
  if (existing) return existing.id

  const {id} = await createOrRestoreTargetBlock(tx, {
    id: pluginBlockId(workspaceId, MATRIX_NS, `tag:${iso}`),
    workspaceId,
    parentId: dailyId,
    orderKey: keyAtEnd(dailyChildren.at(-1)?.orderKey ?? null),
    freshContent: TAG_BLOCK_CONTENT,
  })
  return id
}

const appendMatrixMessage = async (repo: any, config: MatrixConfig, event: any, matrixClient: any): Promise<void> => {
  const eventId = typeof event.event_id === 'string' ? event.event_id : null
  if (!eventId) return

  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) throw new Error('Matrix message ingest requires an active workspace')

  const iso = todayIso(new Date(eventTimestamp(event)))
  await getOrCreateDailyNote(repo, workspaceId, iso)
  const dailyId = dailyNoteBlockId(workspaceId, iso)

  await repo.tx(async (tx: any) => {
    const tagBlockId = await ensureMatrixTagBlock(tx, workspaceId, dailyId, iso)

    // Idempotency + cross-device de-duplication. The message root carries a
    // deterministic id derived from the (workspace, matrix event id). A row
    // already at that id — live OR tombstoned — means this event was already
    // ingested (here or, post-sync, on another device) or deliberately
    // deleted, so leave it be. Creation is atomic, so a present root implies
    // the whole tree is present; absence implies none of its nodes exist.
    const rootId = messageNodeId(workspaceId, eventId, [0])
    if (await tx.get(rootId)) return

    // Legacy guard: messages ingested before deterministic ids carry random
    // ids but the same `matrix-event:id` property. This event would have
    // landed under the same day's tag block, so a match there means skip.
    const messageChildren = await tx.childrenOf(tagBlockId, workspaceId)
    if (messageChildren.some((child: any) => child.properties?.[eventIdProp.name] === eventId)) return

    await createBlockTree(
      tx,
      workspaceId,
      tagBlockId,
      createBlocksFromEvent(event, matrixClient),
      eventId,
      {
        [eventIdProp.name]: eventId,
        [eventRoomProp.name]: config.roomId,
        [eventUrlProp.name]: matrixEventUrl(config.roomId, eventId),
        [eventAuthorProp.name]: typeof event.sender === 'string' ? event.sender : '',
        [eventTimestampProp.name]: eventTimestamp(event),
      },
    )
  }, {scope: ChangeScope.BlockDefault, description: 'matrix message ingest'})
}

// ---------------------------------------------------------------------------
// one-time migration: rename legacy `matrix:*` event metadata onto the
// reserved `matrix-event:*` namespace. Runs once per workspace, scoped to the
// active workspace, idempotent (per-row recheck + localStorage marker). The
// discriminator is the camelCased `matrix:eventId`, which only the ingest sets
// — content promotion lowercases keys, so it can never produce it.

const migrationFlagKey = (workspaceId: string) => `${MIGRATION_FLAG_PREFIX}:${workspaceId}`

const migrateEventNamespace = async (repo: any): Promise<void> => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId || repo.isReadOnly) return
  if (window.localStorage.getItem(migrationFlagKey(workspaceId))) return

  // Candidate roots: carry the legacy key but not the new one yet. The JSON
  // paths are fixed literals (no user input), so inlining them is safe.
  const candidates = await repo.db.getAll(
    `SELECT id FROM blocks
       WHERE workspace_id = ?
         AND deleted = 0
         AND json_extract(properties_json, '$."matrix:eventId"') IS NOT NULL
         AND json_extract(properties_json, '$."matrix-event:id"') IS NULL`,
    [workspaceId],
  ) as Array<{id: string}>

  const BATCH = 200
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH)
    await repo.tx(async (tx: any) => {
      for (const {id} of batch) {
        const block = await tx.get(id)
        if (!block || block.deleted) continue
        // Re-check inside the tx — a concurrent ingest may have raced us.
        if (block.properties['matrix:eventId'] === undefined) continue
        if (block.properties[eventIdProp.name] !== undefined) continue

        const next: Record<string, unknown> = {...block.properties}
        for (const [oldKey, newKey] of EVENT_KEY_RENAMES) {
          if (!(oldKey in next)) continue
          if (!(newKey in next)) next[newKey] = next[oldKey]
          delete next[oldKey]
        }
        await tx.update(id, {properties: addBlockTypeToProperties(next, MATRIX_MESSAGE_TYPE)})
      }
    }, {scope: ChangeScope.BlockDefault, description: 'matrix: migrate event metadata namespace'})
  }

  window.localStorage.setItem(migrationFlagKey(workspaceId), new Date().toISOString())
  if (candidates.length > 0) {
    showInfo(`Matrix: migrated ${candidates.length} message(s) to the matrix-event namespace.`)
  }
}

// ---------------------------------------------------------------------------
// one-time carry-over from the pre-refactor `.js`, which kept homeserver /
// room / autoStart / token together in a single localStorage JSON blob. The
// token can't move into the now-synced prefs block, so it gets its own
// localStorage key (shape change → migration); the rest seeds the prefs block.
// Per-device (the source is localStorage), idempotent via a flag, and it never
// clobbers a token or config the user has already set on this device/workspace.

const migrateLegacyConfig = async (repo: any): Promise<void> => {
  if (window.localStorage.getItem(LEGACY_CONFIG_FLAG)) return

  const raw = window.localStorage.getItem(LEGACY_CONFIG_KEY)
  if (raw) {
    let legacy: any = null
    try { legacy = JSON.parse(raw) } catch { legacy = null }
    if (legacy && typeof legacy === 'object') {
      if (typeof legacy.accessToken === 'string' && legacy.accessToken && !loadToken()) {
        saveToken(legacy.accessToken)
      }
      // Seed the prefs block only when this workspace was never configured
      // (empty roomId), so a fresh config on this workspace is never stomped.
      const prefs = await prefsBlock(repo)
      if (prefs && !prefs.get(roomIdProp)) {
        if (typeof legacy.baseUrl === 'string' && legacy.baseUrl) {
          await prefs.set(homeserverProp, normalizeBaseUrl(legacy.baseUrl))
        }
        if (typeof legacy.roomId === 'string' && legacy.roomId) {
          await prefs.set(roomIdProp, legacy.roomId)
        }
        if (typeof legacy.autoStart === 'boolean') {
          await prefs.set(autoStartProp, legacy.autoStart)
        }
        if (legacy.roomId && loadToken()) await prefs.set(connectedHintProp, true)
      }
    }
  }

  window.localStorage.setItem(LEGACY_CONFIG_FLAG, new Date().toISOString())
}

// ---------------------------------------------------------------------------
// poll loop

// Transient failures clear on the next poll, so they should stay out of the
// user's face — log them, reflect them in the (quiet) status hint, but don't
// toast. This covers network blips (fetch rejects with a TypeError; matrix-js-
// sdk may rewrap it as a ConnectionError) and server-side conditions that the
// long-poll naturally rides out (429 rate-limit, 5xx). Actionable errors — a
// bad/expired token, a malformed request — fall through to the loud path.
const RETRYABLE_MESSAGE_RE = /failed to fetch|fetch failed|network ?error|load failed/i

const isRetryableError = (error: unknown): boolean => {
  if (error instanceof TypeError) return true
  const name = (error as {name?: unknown})?.name
  if (name === 'ConnectionError' || name === 'AbortError') return true
  const status = (error as {httpStatus?: unknown})?.httpStatus
  if (typeof status === 'number') return status === 429 || status >= 500
  const message = error instanceof Error ? error.message : String(error)
  return RETRYABLE_MESSAGE_RE.test(message)
}

const pollLoop = async (repo: any, config: MatrixConfig, signal: AbortSignal, matrixClient: any): Promise<void> => {
  let nextBatch = loadNextBatch(config)
  // `toasted` gates the one-per-streak toast (loud, actionable errors only);
  // `degraded` tracks whether the status hint is currently non-running so a
  // recovered poll clears it — regardless of which kind of error set it.
  let toasted = false
  let degraded = false
  await setStatus(repo, 'running')

  while (!signal.aborted) {
    try {
      const syncBody = await fetchMatrixSync(config, nextBatch, signal, matrixClient)
      const events = nextBatch ? roomEventsFromSync(syncBody, config.roomId) : []

      for (const event of events) {
        if (event?.type !== 'm.room.message') continue
        await appendMatrixMessage(repo, config, event, matrixClient)
      }

      const newBatch = syncBody?.next_batch
      if (typeof newBatch === 'string') {
        nextBatch = newBatch
        saveNextBatch(config, newBatch)
      }
      if (degraded) {
        degraded = false
        toasted = false
        await setStatus(repo, 'running')
      }
    } catch (error) {
      if (signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      degraded = true
      if (isRetryableError(error)) {
        console.warn('[matrix-messages] transient poll error (will retry):', message)
        await setStatus(repo, `retrying: ${message}`)
      } else {
        console.error('[matrix-messages]', error)
        await setStatus(repo, `error: ${message}`)
        // One toast per failure streak — a long-poll can fail every few
        // seconds and we don't want to bury the user in toasts.
        if (!toasted) {
          toasted = true
          showError(`Matrix ingest error: ${message}`)
        }
      }
      await sleep(POLL_ERROR_DELAY_MS, signal).catch(() => undefined)
    }
  }
}

// ---------------------------------------------------------------------------
// background effect — owns the poll lifecycle. No window-global singleton:
// the effect runtime calls our cleanup on hot-reload / disable, and we abort
// the in-flight poll there.

const matrixIngestEffect = {
  id: 'matrix-chat-client.ingest',
  start: ({repo}: {repo: any}) => {
    let currentAbort: AbortController | null = null
    let cancelled = false

    const startPoll = async () => {
      currentAbort?.abort()
      currentAbort = null
      if (cancelled) return

      const config = await loadConfig(repo).catch(() => null)
      if (!config) {
        await setStatus(repo, 'unconfigured')
        return
      }
      if (!config.autoStart) {
        await setStatus(repo, 'stopped')
        return
      }

      const abort = new AbortController()
      currentAbort = abort
      const matrixClient = createMatrixClient(config)
      void pollLoop(repo, config, abort.signal, matrixClient).catch(error => {
        if (!abort.signal.aborted) console.error('[matrix-messages]', error)
      })
    }

    const onRestart = () => { void startPoll() }
    window.addEventListener(RESTART_EVENT, onRestart)

    void (async () => {
      try {
        await migrateLegacyConfig(repo)
      } catch (error) {
        console.error('[matrix-messages] legacy-config migration', error)
      }
      try {
        await migrateEventNamespace(repo)
      } catch (error) {
        console.error('[matrix-messages] migration', error)
      }
      await startPoll()
    })()

    return () => {
      cancelled = true
      window.removeEventListener(RESTART_EVENT, onRestart)
      currentAbort?.abort()
      currentAbort = null
    }
  },
}

const requestRestart = () => window.dispatchEvent(new CustomEvent(RESTART_EVENT))

// ---------------------------------------------------------------------------
// setup dialog (homeserver / room / token)

const MatrixSetupDialog = () => {
  const repo = useRepo()
  const open = useSyncExternalStore(subscribeSetupOpen, () => setupOpen)
  const [homeserver, setHomeserver] = useState('https://matrix.org')
  const [roomId, setRoomId] = useState('')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)

  // Load current prefs into the form each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setToken('')
    let cancelled = false
    void (async () => {
      try {
        const prefs = await prefsBlock(repo)
        if (!cancelled && prefs) {
          setHomeserver(prefs.get(homeserverProp) || 'https://matrix.org')
          setRoomId(prefs.get(roomIdProp) || '')
        }
      } catch {
        // fall back to defaults
      }
    })()
    return () => { cancelled = true }
  }, [open, repo])

  const save = async () => {
    setSaving(true)
    try {
      const prefs = await prefsBlock(repo)
      if (!prefs) {
        showError('No active workspace')
        return
      }
      const tokenToUse = token || loadToken()
      if (!tokenToUse) {
        showError('An access token is required.')
        return
      }
      await prefs.set(homeserverProp, normalizeBaseUrl(homeserver))
      await prefs.set(roomIdProp, roomId.trim())
      await prefs.set(autoStartProp, true)
      await prefs.set(connectedHintProp, true)
      if (token) saveToken(token)
      requestRestart()
      showSuccess('Matrix connected.')
      setSetupOpen(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setSetupOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Matrix</DialogTitle>
          <DialogDescription>
            Point at your homeserver and the room to ingest, then paste an access token.
            The token is stored locally and never synced.
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-3'>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='mx-homeserver'>Homeserver URL</Label>
            <Input
              id='mx-homeserver'
              value={homeserver}
              onChange={e => setHomeserver(e.target.value)}
              disabled={saving}
              placeholder='https://matrix.org'
            />
          </div>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='mx-room'>Room ID</Label>
            <Input
              id='mx-room'
              value={roomId}
              onChange={e => setRoomId(e.target.value)}
              disabled={saving}
              placeholder='!roomid:matrix.org'
            />
          </div>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='mx-token'>Access token</Label>
            <Input
              id='mx-token'
              value={token}
              onChange={e => setToken(e.target.value)}
              disabled={saving}
              type='password'
              placeholder={loadToken() ? 'leave blank to keep saved token' : 'paste token'}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant='ghost' onClick={() => setSetupOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={!roomId || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// property editors (rendered on the prefs block's property panel)

const ConnectedEditor = ({value, onChange}: PropertyEditorProps<boolean>) => {
  const repo = useRepo()
  const tokenPresent = loadToken() != null
  const connected = value && tokenPresent
  return (
    <div className='flex items-center gap-2'>
      <span>{connected ? 'Connected ✓' : 'Not connected'}</span>
      {connected
        ? (
          <Button
            variant='outline'
            size='sm'
            onClick={() => {
              clearToken()
              onChange(false)
              requestRestart()
              showInfo('Matrix disconnected.')
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
        onClick={() => { void repo; requestRestart() }}
        disabled={!tokenPresent}
      >Restart ingest</Button>
    </div>
  )
}

const StatusEditor = ({value}: PropertyEditorProps<string | undefined>) => (
  <span style={{color: 'var(--muted-foreground)'}}>{value ?? 'idle'}</span>
)

const connectedEditor = definePropertyEditorOverride<boolean>({
  name: connectedHintProp.name,
  label: 'Matrix',
  Editor: ConnectedEditor,
})
const statusEditor = definePropertyEditorOverride<string | undefined>({
  name: statusProp.name,
  label: 'Status',
  Editor: StatusEditor,
})
const homeserverEditor = definePropertyEditorOverride<string>({
  name: homeserverProp.name,
  label: 'Homeserver URL',
})
const roomIdEditor = definePropertyEditorOverride<string>({
  name: roomIdProp.name,
  label: 'Room ID',
})
const autoStartEditor = definePropertyEditorOverride<boolean>({
  name: autoStartProp.name,
  label: 'Auto-start ingest',
})

// ---------------------------------------------------------------------------
// actions

const openSettingsAction = {
  id: 'matrix.configure',
  description: 'Matrix: open settings',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}: {uiStateBlock: any}) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const prefs = await getPluginPrefsBlock(repo, workspaceId, repo.user, matrixChatPrefsType)
    await prefs.set(showPropertiesProp, true)
    navigate(repo, {target: 'new-panel', blockId: prefs.id, workspaceId})
  },
}

const connectAction = {
  id: 'matrix.connect',
  description: 'Matrix: connect / change token',
  context: ActionContextTypes.GLOBAL,
  handler: () => { setSetupOpen(true) },
}

const startAction = {
  id: 'matrix.start',
  description: 'Matrix: start message ingest',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}: {uiStateBlock: any}) => {
    const prefs = await prefsBlock(uiStateBlock.repo)
    if (prefs) await prefs.set(autoStartProp, true)
    requestRestart()
  },
}

const stopAction = {
  id: 'matrix.stop',
  description: 'Matrix: stop message ingest',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}: {uiStateBlock: any}) => {
    const prefs = await prefsBlock(uiStateBlock.repo)
    if (prefs) await prefs.set(autoStartProp, false)
    requestRestart()
  },
}

const resetPositionAction = {
  id: 'matrix.reset-position',
  description: 'Matrix: reset message ingest position',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}: {uiStateBlock: any}) => {
    const prefs = await prefsBlock(uiStateBlock.repo)
    if (!prefs) return
    clearNextBatch({baseUrl: prefs.get(homeserverProp), roomId: prefs.get(roomIdProp)})
    requestRestart()
  },
}

// ---------------------------------------------------------------------------
// audio-url content decorator — a message carrying a `matrix:audio-url`
// property (promoted from an `audio-url::` attribute in the message body) gets
// a small audio glyph pinned to its top-right corner that opens the linked
// audio in a new tab. A decorator (not a renderer override) so it composes with
// whatever content renderer the block already uses — same idiom as the geo /
// character-counter / readwise decorators. Gated on the stable `matrix-message`
// type membership (resolver context doesn't track property changes); the icon
// itself is shown/hidden inside the component from a reactive `useHandle` read,
// so it appears the moment the property lands and vanishes if it's cleared.

const AUDIO_URL_KEY = 'matrix:audio-url'

// The property is promoted from message *content* (external, untrusted), so
// only honour http(s) URLs before placing one in an <a href> — never let a
// `javascript:`/`data:` value through. A multi-valued promotion arrives as an
// array; take the first usable entry.
const firstHttpUrl = (value: unknown): string | null => {
  const candidates = Array.isArray(value) ? value : [value]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.trim()
    if (/^https?:\/\//i.test(trimmed)) return trimmed
  }
  return null
}

const matrixAudioStyles = {
  wrapper: {position: 'relative', width: '100%'},
  link: {
    position: 'absolute',
    top: '1px',
    right: '1px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '22px',
    borderRadius: '4px',
    color: 'var(--muted-foreground)',
    background: 'var(--background)',
    cursor: 'pointer',
    textDecoration: 'none',
  },
} satisfies Record<string, CSSProperties>

// lucide `audio-lines` glyph, inlined to avoid a runtime dependency import.
const AudioGlyph = () => (
  <svg
    xmlns='http://www.w3.org/2000/svg'
    width='16'
    height='16'
    viewBox='0 0 24 24'
    fill='none'
    stroke='currentColor'
    strokeWidth='2'
    strokeLinecap='round'
    strokeLinejoin='round'
    aria-hidden='true'
  >
    <path d='M2 10v3'/>
    <path d='M6 6v11'/>
    <path d='M10 3v18'/>
    <path d='M14 8v7'/>
    <path d='M18 5v13'/>
    <path d='M22 10v3'/>
  </svg>
)

const MatrixAudioDecorator = ({block, Inner}: {block: Block; Inner: BlockRenderer}) => {
  const audioUrl = useHandle(block, {
    selector: data => firstHttpUrl(data?.properties?.[AUDIO_URL_KEY]),
  })
  return (
    <div style={matrixAudioStyles.wrapper}>
      <Inner block={block}/>
      {audioUrl && (
        <a
          href={audioUrl}
          target='_blank'
          rel='noreferrer'
          title='Open audio'
          aria-label='Open audio'
          style={matrixAudioStyles.link}
          onClick={event => event.stopPropagation()}
          onMouseDown={event => event.stopPropagation()}
        >
          <AudioGlyph/>
        </a>
      )}
    </div>
  )
}

// Cached per inner renderer so React keeps a stable component identity and
// never unmounts the inner subtree on a parent re-render (same invariant the
// other decorators rely on).
const matrixAudioDecoratorCache = new WeakMap<BlockRenderer, BlockRenderer>()

const decorateMatrixAudio: BlockContentDecorator = inner => {
  const existing = matrixAudioDecoratorCache.get(inner)
  if (existing) return existing
  const Decorated: BlockRenderer = ({block}) => (
    <MatrixAudioDecorator block={block} Inner={inner}/>
  )
  Decorated.displayName = 'WithMatrixAudio'
  matrixAudioDecoratorCache.set(inner, Decorated)
  return Decorated
}

const matrixAudioContentDecorator: BlockContentDecoratorContribution = ctx => {
  if (!ctx.types.includes(MATRIX_MESSAGE_TYPE)) return null
  if (ctx.blockContext?.isBreadcrumb) return null
  return decorateMatrixAudio
}

// ---------------------------------------------------------------------------
// wiring

export default [
  typesFacet.of(matrixChatPrefsType, {source}),
  typesFacet.of(matrixMessageType, {source}),

  propertySchemasFacet.of(homeserverProp, {source}),
  propertySchemasFacet.of(roomIdProp, {source}),
  propertySchemasFacet.of(autoStartProp, {source}),
  propertySchemasFacet.of(connectedHintProp, {source}),
  propertySchemasFacet.of(statusProp, {source}),
  propertySchemasFacet.of(eventIdProp, {source}),
  propertySchemasFacet.of(eventRoomProp, {source}),
  propertySchemasFacet.of(eventUrlProp, {source}),
  propertySchemasFacet.of(eventAuthorProp, {source}),
  propertySchemasFacet.of(eventTimestampProp, {source}),

  propertyEditorOverridesFacet.of(connectedEditor, {source}),
  propertyEditorOverridesFacet.of(statusEditor, {source}),
  propertyEditorOverridesFacet.of(homeserverEditor, {source}),
  propertyEditorOverridesFacet.of(roomIdEditor, {source}),
  propertyEditorOverridesFacet.of(autoStartEditor, {source}),

  appMountsFacet.of({id: 'matrix.setup-dialog', component: MatrixSetupDialog}, {source}),
  appEffectsFacet.of(matrixIngestEffect, {source}),

  blockContentDecoratorsFacet.of(matrixAudioContentDecorator, {source}),

  actionsFacet.of(openSettingsAction, {source}),
  actionsFacet.of(connectAction, {source}),
  actionsFacet.of(startAction, {source}),
  actionsFacet.of(stopAction, {source}),
  actionsFacet.of(resetPositionAction, {source}),
]
