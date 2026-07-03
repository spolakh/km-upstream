/**
 * Production bootstrap for the new data layer (replaces
 * `src/data/repoInstance.ts`).
 *
 * Per-user PowerSync database — the database itself is the user
 * isolation boundary (no shared CRUD queue, no shared cache, no risk
 * of one session's pending uploads being retried under another user's
 * JWT). Sign-out clears the Supabase session but leaves the local DB
 * intact; sign-in as the same user reopens the same DB and unsynced
 * edits resume uploading. Sign-in as a different user opens a fresh
 * DB.
 *
 * What this DOES:
 *   - Open a `PowerSyncDatabase` keyed by user id
 *   - Run PowerSync's `init()` (sets up powersync_crud + ps_oplog)
 *   - Run the new client-side DDL: `blocks` + core indexes,
 *     workspaces + workspace_members tables/indexes,
 *     `CLIENT_SCHEMA_STATEMENTS` (tx_context, row_events,
 *     command_events, core side indexes, and triggers), then static
 *     data-plugin local schema contributions
 *   - Connect to the PowerSync server when `hasRemoteSyncConfig`
 *
 * What this does NOT do (vs. legacy):
 *   - No `block_event_context` / `block_events` tables (replaced by
 *     `tx_context` + `row_events` from clientSchema.ts)
 *   - No legacy CRUD-routing triggers (replaced by the 5 audit/upload
 *     triggers in clientSchema.ts that key on `tx_context.source`)
 *   - No `UndoRedoManager` (undo lands in a future stage; engine
 *     doesn't depend on it)
 */

import { PowerSyncDatabase, Schema, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web'
import { createPowerSyncConnector, hasRemoteSyncConfig } from '@/services/powersync.js'
import { createSyncResolver, type SyncResolver } from '@/sync/keys/resolver.js'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore.js'
import type { MaterializeDeps } from '@/data/internals/syncObserver/materialize.js'
import {
  BLOCKS_SYNCED_RAW_TABLE,
  CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
  CREATE_BLOCKS_SYNCED_TABLE_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
} from '@/data/blockSchema'
import {
  CREATE_WORKSPACES_TABLE_SQL,
  CREATE_WORKSPACE_MEMBERS_INDEX_SQL,
  CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
  WORKSPACES_RAW_TABLE,
  WORKSPACE_MEMBERS_RAW_TABLE,
  ensureWorkspaceE2eeColumns,
} from '@/data/workspaceSchema'
import {
  CLIENT_SCHEMA_STATEMENTS,
  backfillBlockAliasesIfEmpty,
  backfillBlocksFtsIfEmpty,
  backfillBlockTypesIfEmpty,
  ensureBlockUserUpdatedAtColumn,
} from '@/data/internals/clientSchema'
import { runAnalyzeIfStale } from '@/data/maintenance'
import { onFirstSync } from '@/data/internals/firstSync.js'
import { scheduleIdle } from '@/utils/scheduleIdle.js'
import { toLocalDbOpenError } from '@/utils/localDbCorruption.js'
import {
  captureDbOpenCorruption,
  recordForensicSessionStart,
  watchForRuntimeCorruption,
} from '@/utils/dbForensicsHooks.js'
import { releasePowerSyncConnection } from '@/data/releasePowerSyncConnection.js'
import {
  applyLocalSchemaContributions,
  resolveLocalSchemaContributions,
} from '@/data/localSchema.js'
import { guardSyncedTableWrites } from '@/data/syncedTableWriteGuard.js'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'

const appSchema = new Schema({})
// Layout B (design doc §9.2): PowerSync writes EVERY downloaded block — the
// `blocks_synced` row_type emitted by the sync rules — into the raw
// `blocks_synced` staging table; the Repo's sync observer then decrypts/copies
// each into the app-visible plaintext `blocks` table. So `blocks` is NOT a raw
// table here — it's a plain local table the observer owns. During the dual-run
// window the sync rules still also emit a plain `blocks` row_type for old
// clients; this client has no raw mapping for it, so PowerSync stashes it in
// `ps_untyped` and ignores it.
appSchema.withRawTables({
  blocks_synced: BLOCKS_SYNCED_RAW_TABLE,
  workspaces: WORKSPACES_RAW_TABLE,
  workspace_members: WORKSPACE_MEMBERS_RAW_TABLE,
})

// wa-sqlite's VFS caps pathnames at 64 chars (mxPathname in
// node_modules/@journeyapps/wa-sqlite/src/VFS.js). SQLite derives
// WAL/journal/shm paths from the dbFilename with suffixes up to ~10
// chars, so the base has to stay well under 64 or sqlite3_open_v2
// fails with "Filename too long" and no useful error. 7 (prefix) +
// 40 (user) + 3 (suffix) = 50 — safe headroom.
const MAX_USER_SEGMENT = 40

// v6 = baseline (OPFSCoopSync + multi-tabs on @powersync/web@1.38.1).
// History: v3 was the original IDB layout; v4 introduced OPFS; v5
// reverted to IDB to test whether the bucket-wipe pattern was
// OPFS-specific (it wasn't — wipes reproduce identically on both, so
// the cause is upstream of storage). v6 returns to the intended
// production setup: OPFSCoopSync for fast sync access handles + multi-
// tabs enabled. Each VFS bump gets a fresh filename so we don't reuse
// storage across backends.
// PR previews are served under /<repo>/pr-preview/pr-<n>/ on the SAME origin as
// production, and OPFS/IndexedDB is per-origin — so without a per-deploy suffix a
// signed-in preview would open production's REAL local DB, and any client schema
// change / migration / PowerSync bump in the PR would mutate it (the app is
// offline-first, so the local store is authoritative). Derive a namespace from
// the deploy path so previews get their own DB. Production (BASE_URL = /<repo>/)
// matches nothing here, so its filename stays byte-for-byte identical and
// existing users keep their data. The `-pr-<n>` suffix is short enough to stay
// under the 64-char wa-sqlite pathname cap (see MAX_USER_SEGMENT).
export const previewDbSuffix = (base: string): string => {
  const match = base.match(/\/pr-preview\/(pr-[^/]+)\//)
  return match ? `-${match[1]}` : ''
}

export const dbFilenameForUser = (
  userId: string,
  base: string = import.meta.env.BASE_URL,
) => {
  const suffix = previewDbSuffix(base)
  // The preview suffix comes OUT of the user budget, so the base name stays
  // within the same envelope as production (`kmp-v6-` + <=MAX_USER_SEGMENT +
  // `.db` = 50) regardless of the suffix — preserving the headroom the 64-char
  // wa-sqlite pathname cap needs for the -journal/-wal/-shm derivatives.
  const sanitized = userId
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, Math.max(0, MAX_USER_SEGMENT - suffix.length))
  return `kmp-v6-${sanitized}${suffix}.db`
}

const dbsByUser = new Map<string, PowerSyncDatabase>()
const initPromises = new Map<string, Promise<void>>()
let activeUserId: string | null = null
// Whether the ACTIVE session connects to remote (vs local-only mode). Set alongside
// activeUserId in ensurePowerSyncReady; read by the attachment up-lane + resolver so a
// local-only session makes NO Supabase Storage request — the same "no remote requests
// in local-only" contract this module already upholds for the PowerSync connect below.
let activeRemoteSync = false
let connectChain: Promise<void> = Promise.resolve()

// One §6 sync resolver per user, shared by both halves of the Layout B
// seam: the upload connector (encrypt-on-upload) and the Repo's download
// observer (materializability + key lookup). Built here so the Repo
// bootstrap (context/repo.tsx) doesn't re-derive a second resolver against
// the same shared key store + mode pins.
const syncResolversByUser = new Map<string, SyncResolver>()
const resolverForUser = (userId: string): SyncResolver => {
  let resolver = syncResolversByUser.get(userId)
  if (!resolver) {
    resolver = createSyncResolver(() => userId, getWorkspaceKeyStore())
    syncResolversByUser.set(userId, resolver)
  }
  return resolver
}

/** The active user id (whose per-user PowerSync DB is mounted), or null when
 *  signed out. The asset byte path (§7.3) scopes its OPFS store + resolver to
 *  this — re-read at call time so an account switch is reflected. */
export const getActiveUserId = (): string | null => activeUserId

/** Whether the active session has remote sync ENABLED (vs local-only). The attachment
 *  up-lane + resolver gate on this so a local-only session uploads/fetches NOTHING
 *  to/from Supabase Storage — `supabase` being non-null only means auth is CONFIGURED,
 *  not that this session opted into remote. */
export const isRemoteSyncActive = (): boolean => activeRemoteSync

/** The active user's §6 sync resolver (materializability / WK / K_id), or null
 *  when signed out. The in-thread asset resolver delegates its decode + content-
 *  key decisions to it, so they share the one §6 policy source. */
export const getActiveSyncResolver = (): SyncResolver | null =>
  activeUserId ? resolverForUser(activeUserId) : null

/** The §6 sync resolver for a SPECIFIC user (materializability / WK / K_id),
 *  regardless of who is active. The byte up-lane binds this at its entry boundary
 *  (capture / drain) so an operation initiated for one user can't read another
 *  user's keys if the active account switches mid-flight. (The read-path asset
 *  resolver legitimately follows the ACTIVE user instead — see assetResolver.ts.) */
export const syncResolverForUser = (userId: string): SyncResolver => resolverForUser(userId)

/** Observer deps for the Repo's `syncObserverDeps` parameter, drawn from
 *  the same per-user resolver the upload connector uses — so download
 *  (decrypt/copy/defer) and upload (encrypt) share one §6 policy source. */
export const syncObserverDepsFor = (
  userId: string,
): MaterializeDeps => {
  const resolver = resolverForUser(userId)
  return {
    getMaterializability: resolver.getMaterializability,
    getCek: resolver.getCek,
  }
}

// Firefox and Safari block OPFS in private browsing — `getDirectory()`
// throws SecurityError. Probe once and surface a useful message before
// PowerSync gets to fail with the opaque internal error.
let opfsProbe: Promise<void> | null = null
const assertOpfsAvailable = (): Promise<void> => {
  if (!opfsProbe) {
    opfsProbe = (async () => {
      try {
        await navigator.storage.getDirectory()
      } catch (err) {
        if (err instanceof DOMException && err.name === 'SecurityError') {
          throw new Error(
            'This browser is blocking local storage access (OPFS), which Knowledge Medium needs to keep your data on this device. ' +
            'This usually means you\'re in private/incognito browsing on Firefox or Safari, where OPFS is disabled. ' +
            'Try a regular (non-private) window, or use Chrome — Chrome incognito allows OPFS.',
            {cause: err},
          )
        }
        throw err
      }
    })()
  }
  return opfsProbe
}

// OPFSCoopSyncVFS gives fast sync access handles (much faster than IDB
// transactions); enableMultiTabs lets the SharedSync worker coordinate
// one sync stream across all open tabs of the same workspace.
const buildPowerSyncDb = (userId: string) => new PowerSyncDatabase({
  schema: appSchema,
  database: new WASQLiteOpenFactory({
    dbFilename: dbFilenameForUser(userId),
    vfs: WASQLiteVFS.OPFSCoopSyncVFS,
  }),
  flags: {
    enableMultiTabs: true,
  },
})

export const getPowerSyncDb = (userId: string): PowerSyncDatabase => {
  const existing = dbsByUser.get(userId)
  if (existing) return existing
  const db = buildPowerSyncDb(userId)
  dbsByUser.set(userId, db)
  return db
}

/**
 * Close the user's PowerSync connection IF one was already constructed (release
 * the OPFS sync access handle) and forget it. Unlike `getPowerSyncDb`, this NEVER
 * constructs a connection — the recovery path is about to delete the `.db`, and
 * opening a fresh connection to it would re-acquire the very handle we need
 * released (and re-fail on the corrupt file). No-op when nothing is open.
 *
 * A failed-init connection (corrupt DB) needs the adapter released directly —
 * its high-level close() re-throws the rejected init before freeing the OPFS
 * handle — so we go through `releasePowerSyncConnection`. We still drop it from
 * the maps so a later reload re-inits cleanly.
 */
export const closePowerSyncDbIfOpen = async (userId: string): Promise<void> => {
  const existing = dbsByUser.get(userId)
  dbsByUser.delete(userId)
  initPromises.delete(userId)
  if (!existing) return
  await releasePowerSyncConnection(existing)
}

// `useRemoteSync` is the runtime gate (defaults to the build-time
// `hasRemoteSyncConfig`). Callers pass `false` when the user opted into
// local-only mode at login — in that case we still init the local DB +
// triggers but skip `db.connect()` so we never make a Supabase auth or
// PowerSync sync request from this session.
export const ensurePowerSyncReady = async (
  userId: string,
  useRemoteSync: boolean = hasRemoteSyncConfig,
) => {
  await assertOpfsAvailable()

  const db = getPowerSyncDb(userId)
  const dbFilename = dbFilenameForUser(userId)

  let initPromise = initPromises.get(userId)
  if (!initPromise) {
    initPromise = initializePowerSyncDb(db)
    initPromises.set(userId, initPromise)
  }
  try {
    await initPromise
  } catch (error) {
    // A corrupt local `.db` surfaces here (e.g. "database disk image is
    // malformed"). Record a forensic snapshot (issue #284) BEFORE anything
    // touches the file, then re-throw as a typed, recoverable error carrying the
    // userId so the bootstrap error boundary can offer Export + Reset. Any other
    // failure passes through unchanged.
    captureDbOpenCorruption(userId, dbFilename, error)
    throw toLocalDbOpenError(error, userId)
  }

  // Out-of-band forensic instrumentation (issue #284): record the session (with
  // unclean-shutdown detection), schedule an idle zero-page scan, and watch for
  // a RUNTIME sync-apply corruption the DB-open detector never sees. All
  // best-effort — guarded to run once per process, never throws into boot.
  recordForensicSessionStart(userId, dbFilename)
  watchForRuntimeCorruption(db, userId, dbFilename)

  // The local DB is now mounted for this user — record it as the active account in
  // BOTH modes. The asset byte path (§7.3) + media capture key off getActiveUserId,
  // so a local-only session must still set it or every image/file paste reaches
  // captureMedia as `no-user` and is silently dropped. Only the REMOTE connect
  // below is gated on useRemoteSync.
  const previousUserId = activeUserId
  const alreadyActive = activeUserId === userId
  activeUserId = userId
  // Record the session's mode for the asset lane (set in BOTH modes, like activeUserId).
  activeRemoteSync = useRemoteSync

  if (!useRemoteSync) {
    return
  }

  if (alreadyActive) {
    return
  }

  // Run disconnect+connect serially so we don't race two connect
  // attempts. Don't await the chain — connect can take a while and
  // we want render to proceed against the local cache.
  connectChain = connectChain
    .then(async () => {
      if (previousUserId && previousUserId !== userId) {
        const previousDb = dbsByUser.get(previousUserId)
        if (previousDb) {
          await previousDb.disconnect()
        }
      }
      // Encrypt-on-upload (§9.2): bind the connector's mode/key lookups to this
      // user's mode pins + shared workspace-key store. Plaintext workspaces
      // resolve mode 'none' (no-op); e2ee workspaces seal content columns. Same
      // per-user resolver the observer deps draw from (`syncObserverDepsFor`).
      const resolver = resolverForUser(userId)
      await db.connect(createPowerSyncConnector({
        getWorkspaceMode: resolver.getMode,
        getCek: resolver.getCek,
      }))
    })
    .catch((error) => {
      console.error(`PowerSync background connect failed for ${userId}:`, error)
    })
}

const initializePowerSyncDb = async (powerSyncDb: PowerSyncDatabase) => {
  await powerSyncDb.init()

  // No `PRAGMA journal_mode=WAL`: none of wa-sqlite's PowerSync-bundled
  // VFSes implement xShmMap (the wal-index shared-memory primitive
  // SQLite needs for native WAL), so SQLite silently keeps rollback
  // journal mode. Re-evaluate if PowerSync ever ships a WAL-capable
  // browser VFS.

  // Cache + temp-store tuning. SQLite's default `cache_size` is 2000
  // pages = ~8 MB — fine for tiny DBs, catastrophic for users with
  // import-heavy workspaces (250k blocks ≈ 700 MB on-disk). Each cold
  // page becomes a synchronous OPFS read on the worker thread, so a
  // page-open's load + ancestors + children + backlinks queries all
  // serialize behind cold-page I/O. Raising the cache to 256 MiB lets
  // the hot index + active-page footprint live in worker RAM, dropping
  // most reads to memory speed after a brief warmup.
  //
  // Negative value = absolute KiB (positive = page count, which depends
  // on page_size). 262144 KiB = 256 MiB.
  //
  // Trade: ~256 MiB resident browser memory while the app is open. On
  // small DBs SQLite only allocates pages it touches, so steady-state
  // memory tracks the actual working set (much less than the cap).
  //
  // `temp_store = MEMORY` keeps temp B-trees (DISTINCT, ORDER BY,
  // recursive CTEs) off OPFS — they're transient and don't need to
  // survive a crash, and the OPFS VFS doesn't perform well as a temp
  // store anyway.
  await powerSyncDb.execute('PRAGMA cache_size = -262144')
  await powerSyncDb.execute('PRAGMA temp_store = MEMORY')

  // ── blocks + its indexes ──
  await powerSyncDb.execute(CREATE_BLOCKS_TABLE_SQL)
  // Layout B staging table (§9.2). The raw-table mapping above tells
  // PowerSync how to write it, but does NOT create the local SQLite table —
  // we run the DDL ourselves, same as `blocks`. This is the live landing zone
  // for the `blocks_synced` sync stream; the Repo's observer materializes it
  // into `blocks`.
  await powerSyncDb.execute(CREATE_BLOCKS_SYNCED_TABLE_SQL)
  await powerSyncDb.execute(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL)
  await powerSyncDb.execute(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)
  // Idempotent local migration: add `user_updated_at` to an existing
  // `blocks` / `blocks_synced` on upgrading devices (CREATE TABLE IF NOT
  // EXISTS above is a no-op when the table already exists) + one-shot
  // backfill. See hydration-staleness-fix-handoff.md step 3.
  await ensureBlockUserUpdatedAtColumn(powerSyncDb)

  // ── workspaces + workspace_members ──
  await powerSyncDb.execute(CREATE_WORKSPACES_TABLE_SQL)
  // Idempotent local migration: add the E2EE columns to an existing
  // `workspaces` table on upgrading devices (CREATE TABLE IF NOT EXISTS
  // above is a no-op when the table already exists). §7 / e2ee-design.
  await ensureWorkspaceE2eeColumns(powerSyncDb)
  await powerSyncDb.execute(CREATE_WORKSPACE_MEMBERS_TABLE_SQL)
  await powerSyncDb.execute(CREATE_WORKSPACE_MEMBERS_INDEX_SQL)

  // ── tx_context, row_events, command_events, block_aliases + core
  // triggers ── (5 audit/upload, 2 workspace-invariant, 3 alias-index.)
  // Statements include
  // CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / CREATE
  // TRIGGER IF NOT EXISTS so re-running is a no-op against an
  // already-bootstrapped dev database.
  for (const stmt of CLIENT_SCHEMA_STATEMENTS) {
    await powerSyncDb.execute(stmt)
  }

  // One-shot side-index backfills for users upgrading from a
  // pre-index schema. Steady-state startups noop on a single LIMIT 1
  // probe of `client_schema_state`.
  const backfillDb = {
    // Guarded: a LocalSchema statement/backfill that raw-writes a synced table
    // (blocks/workspaces/workspace_members) leaves tx_context.source = NULL, so
    // the upload trigger never fires and the write is local-only — it silently
    // never syncs. The guard turns that class into a loud throw. Synced-table
    // backfills must go through repo.tx (workspaceBackfillsFacet).
    execute: guardSyncedTableWrites((sql: string, params?: unknown[]) =>
      powerSyncDb.execute(sql, params as never[] | undefined)),
    getOptional: async <T,>(sql: string) => {
      const row = await powerSyncDb.getOptional<T>(sql)
      return row ?? null
    },
  }
  await backfillBlockAliasesIfEmpty(backfillDb)
  await backfillBlockTypesIfEmpty(backfillDb)
  await backfillBlocksFtsIfEmpty(backfillDb)
  await applyLocalSchemaContributions(
    backfillDb,
    resolveLocalSchemaContributions(staticDataExtensions),
  )

  // ANALYZE off the cold-start path. wa-sqlite never auto-populates
  // `sqlite_stat1`, so the planner makes pessimal join-order choices on
  // `blocks` once a workspace is large (a 4-id `json_each` lookup can
  // degenerate to a 4-second scan of the workspace partial index).
  // `runAnalyzeIfStale` re-runs only when the live `blocks` count has
  // drifted from the count the stats were built on (see clientSchema), so
  // a stable workspace pays nothing and a grown one self-corrects. Both
  // the count probe and ANALYZE run on the single SQLite worker, so every
  // trigger below is idle-deferred — never on the first-paint path.
  //
  // (a) Boot: catches anything that changed since the last session — a
  // prior-session import, organic growth, or the legacy "0 0" stats bug.
  const scheduleAnalyzeCheck = (reason: string) => {
    scheduleIdle(() => {
      void runAnalyzeIfStale(backfillDb).catch(error => {
        console.warn(`[Repo] ANALYZE check failed (${reason}):`, error)
      })
    })
  }
  scheduleAnalyzeCheck('boot')

  // (b) First sync of THIS session: a fresh device boots with an empty
  // `blocks`, so (a) skips. Once PowerSync finishes the initial sync and
  // the observer materializes the rows, the table is large and the boot
  // baseline is stale — re-check then so the user gets good plans the same
  // session instead of after a reload. One-shot; disposes after the first
  // `hasSynced`. If the first sync already completed in a prior session,
  // (a) above already covered it, so don't bother registering.
  if (!powerSyncDb.currentStatus?.hasSynced) {
    onFirstSync(powerSyncDb, () => scheduleAnalyzeCheck('first-sync'))
  }
}
