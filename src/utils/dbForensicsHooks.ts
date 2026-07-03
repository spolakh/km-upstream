/**
 * Wiring between the app boot/lifecycle and the out-of-band {@link dbForensics}
 * recorder. Kept separate from `dbForensics` (pure store) and from
 * `repoProvider` (which just calls these) so the glue — the per-user watcher,
 * the lifecycle listeners, the retrieval hook — lives in one place.
 */

import { dbForensics, type DbForensics } from '@/utils/dbForensics.js'
import { isLocalDbCorruptionError, isRuntimeDbCorruptionError } from '@/utils/localDbCorruption.js'
import { reportRuntimeLocalDbCorruption } from '@/data/localDbCorruptionSignal.js'

// Structural PowerSync status surface (avoids importing PowerSync types; see
// firstSync.ts for the same approach). `downloadError` lives under
// `dataFlowStatus` in current PowerSync, but check both shapes defensively.
interface DownloadErrorStatus {
  dataFlowStatus?: { downloadError?: unknown }
  downloadError?: unknown
}
interface CorruptionWatchDb {
  currentStatus?: DownloadErrorStatus
  registerListener?: (l: { statusChanged?: (s: DownloadErrorStatus) => void }) => () => void
}

const downloadErrorOf = (s: DownloadErrorStatus | undefined): unknown =>
  s?.dataFlowStatus?.downloadError ?? s?.downloadError

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

let sessionRecorded = false
let lifecycleInstalled = false
// The runtime watcher is bound to a specific user's connection. An in-page
// account switch (onAuthStateChange → new user.id, no reload) re-runs
// `ensurePowerSyncReady` for the new user, so we must tear down the previous
// user's listener and re-arm — else the new user goes unwatched AND the stale
// listener could report the OLD user's corruption into the new session (routing
// a reset at the wrong user's `.db`).
let watchedUserId: string | null = null
let disposeWatch: (() => void) | null = null
let runtimeCorruptionCaptured = false

/**
 * Record a new forensic session (unclean-shutdown detection). Once per page
 * load — the session is the page-load lifetime, so later `ensurePowerSyncReady`
 * calls (re-render / in-page account switch) are no-ops. Best-effort; never throws.
 */
export const recordForensicSessionStart = (
  userId: string,
  dbFilename: string,
  forensics: DbForensics = dbForensics,
): void => {
  if (sessionRecorded) return
  sessionRecorded = true
  void forensics.recordSessionStart({ userId, dbFilename })
}

/** Capture a forensic snapshot on a DB-OPEN corruption, before recovery. */
export const captureDbOpenCorruption = (
  userId: string,
  dbFilename: string,
  error: unknown,
  forensics: DbForensics = dbForensics,
): void => {
  if (!isLocalDbCorruptionError(error)) return
  void forensics.captureCorruptionSnapshot({
    userId,
    dbFilename,
    reason: 'db-open-corrupt',
    sql: { message: messageOf(error) },
  })
}

/**
 * Watch the PowerSync connection for a RUNTIME sync-apply corruption
 * (`downloadError`) — the class the DB-open detector never sees (connect isn't
 * awaited). On the first corruption it captures a forensic snapshot AND routes
 * to the recovery UI via `reportRuntimeLocalDbCorruption` → the sentinel → the
 * bootstrap ErrorBoundary. Both gate on the strict, reset-gating matcher so a
 * benign sync failure neither consumes the one-shot capture nor shows the UI.
 *
 * Re-arms per user: on an in-page account switch it disposes the previous
 * listener and rebinds to the new user's db.
 */
export const watchForRuntimeCorruption = (
  db: CorruptionWatchDb,
  userId: string,
  dbFilename: string,
  forensics: DbForensics = dbForensics,
): void => {
  if (watchedUserId === userId) return
  disposeWatch?.()
  disposeWatch = null
  watchedUserId = userId
  runtimeCorruptionCaptured = false // re-arm the one-shot capture for the new user

  const check = (status: DownloadErrorStatus | undefined): void => {
    const err = downloadErrorOf(status)
    // Tight matcher: `downloadError` also carries benign HTTP/network failures
    // whose server body could echo a broad corruption phrase — those must NOT
    // route to the destructive recovery UI.
    if (err === undefined || err === null || !isRuntimeDbCorruptionError(err)) return
    if (!runtimeCorruptionCaptured) {
      runtimeCorruptionCaptured = true
      void forensics.captureCorruptionSnapshot({
        userId,
        dbFilename,
        reason: 'runtime-sync-corrupt',
        sql: { downloadError: messageOf(err) },
      })
    }
    // Route to the recovery UI (latched in the signal, so repeated sync-loop
    // failures don't re-fire).
    reportRuntimeLocalDbCorruption(userId, err)
  }

  check(db.currentStatus)
  disposeWatch = typeof db.registerListener === 'function'
    ? db.registerListener({ statusChanged: check })
    : null
}

/** Test-only: reset the once-per-process guards + per-user watcher state. */
export const __resetDbForensicsHooksForTest = (): void => {
  sessionRecorded = false
  lifecycleInstalled = false
  disposeWatch?.()
  disposeWatch = null
  watchedUserId = null
  runtimeCorruptionCaptured = false
}

/**
 * Register global lifecycle listeners that feed the current session's breadcrumb
 * log + clean-shutdown flag, and expose a retrieval hook on
 * `window.__omniliner.forensics` (`dump()` / `download()`) so the recorded
 * breadcrumbs + corruption snapshots can be pulled over the remote inspector or
 * downloaded next incident. `pagehide` marks a clean exit; `pageshow`/`resume`
 * un-mark it (the session is live again — avoids a bfcache false-negative).
 * Idempotent; call once at app startup.
 */
export const installDbForensicsLifecycle = (forensics: DbForensics = dbForensics): void => {
  if (lifecycleInstalled || typeof window === 'undefined') return
  lifecycleInstalled = true
  document.addEventListener('visibilitychange', () => {
    void forensics.recordLifecycleEvent(`visibility:${document.visibilityState}`)
  })
  window.addEventListener('freeze', () => void forensics.recordLifecycleEvent('freeze'))
  window.addEventListener('pagehide', () => void forensics.markCleanShutdown())
  // pageshow/resume: the session is live again, so un-mark clean. This can also
  // fire after a clean nav-away+freeze without a bfcache restore, logging a
  // benign `unclean` — but only ever while hidden, so it lands in the benign
  // `unclean+hidden` bucket, not the suspicious `unclean+visible` one we watch.
  window.addEventListener('pageshow', () => void forensics.clearCleanShutdown())
  window.addEventListener('resume', () => void forensics.clearCleanShutdown())

  // Retrieval hook, shared with the `__omniliner` namespace (see
  // metricsConsoleHook). Available even in the bootstrap error fallback (no
  // Repo), so a corrupt-DB session can still hand over its forensics.
  const ns = (window.__omniliner ?? {}) as Record<string, unknown> & {
    forensics?: OmnilinerForensicsApi
  }
  ns.forensics = {
    dump: () => forensics.exportAll(),
    download: async () => downloadJson('db-forensics.json', await forensics.exportAll()),
  }
  window.__omniliner = ns as Window['__omniliner']
}

interface OmnilinerForensicsApi {
  /** Every forensic record (sessions, unclean archives, snapshots). */
  dump: () => Promise<Record<string, unknown>>
  /** Download the dump as `db-forensics.json`. */
  download: () => Promise<void>
}

const downloadJson = (filename: string, data: unknown): void => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
