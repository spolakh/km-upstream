/**
 * The media up-lane HEALTH surface (design §9/§11).
 *
 * A background drain can leave a record `failed` (a permanent reject, retries/age
 * exhausted, or a poisoned path). That happens OFF the paste hot-path, so — unlike a
 * capture failure, which `reportCaptureFailures` toasts at paste time — it otherwise
 * has no user feedback. This publishes the active user's FAILED-record count into the
 * shared diagnostics seam, so a stuck upload surfaces in the status indicator.
 *
 * Severity is `warning`, not `error`: the bytes still render from the local OPFS
 * replica, so nothing is broken on THIS device — but they aren't backed up to Storage,
 * so they may be unavailable on other devices (and are at risk if OPFS is evicted).
 *
 * A live store + a {@link DiagnosticSourceContribution}: the drain (and the boot
 * reconciler) call {@link refreshUploadLaneStatus} after each pass; the source feeds
 * the status chip via `useSyncExternalStore`. The warning also carries an
 * {@link RETRY_UPLOADS_ACTION_ID} action so the chip renders a "Retry" button — the §9
 * recovery trigger (the only one), which probes + re-drives the failed records.
 */
import type { DiagnosticSnapshot, DiagnosticSourceContribution } from '@/plugins/diagnostics/facet.js'
import { CallbackSet } from '@/utils/callbackSet.js'
import type { ByteUploadStore } from './uploadStore.js'

/** Global action id the failed-uploads warning points its "Retry" button at. Defined
 *  here (the surface that references it) so {@link import('./retryUploadsAction.js')} can
 *  import it without this module depending on the action wiring — no import cycle. */
export const RETRY_UPLOADS_ACTION_ID = 'attachments.retry-failed-uploads'

let failedCount = 0
const listeners = new CallbackSet('upload-lane-status')

/** Re-read the FAILED-record count for `userId` and publish if it changed. Called by
 *  the drain after each pass and by the boot reconciler. A null user (signed out)
 *  clears the count. */
export const refreshUploadLaneStatus = async (
  store: ByteUploadStore,
  userId: string | null,
): Promise<void> => {
  const next = userId ? await store.countByStatus(userId, 'failed') : 0
  if (next === failedCount) return
  failedCount = next
  listeners.notify()
}

// Ref-stable snapshot cache (feeds useSyncExternalStore): rebuilt ONLY when the count
// actually changes, so getSnapshot returns the same reference while unchanged.
let cachedCount = -1
let cachedSnapshot: DiagnosticSnapshot | null = null

export const uploadLaneDiagnosticSource: DiagnosticSourceContribution = {
  id: 'attachments.uploads',
  label: 'Media uploads',
  subscribe: (listener) => listeners.add(listener),
  getSnapshot: () => {
    if (failedCount !== cachedCount) {
      cachedCount = failedCount
      cachedSnapshot =
        failedCount > 0
          ? {
              severity: 'warning',
              summary: `${failedCount} media upload${failedCount === 1 ? '' : 's'} failed`,
              detail:
                'Captured locally but not backed up to storage — they may be unavailable on other devices.',
              // The §9 recovery trigger: probe + re-drive the failed records (the only
              // recovery trigger — transient failures are auto-retried by the drain).
              actionId: RETRY_UPLOADS_ACTION_ID,
              actionLabel: 'Retry',
              nudge: true,
            }
          : null
    }
    return cachedSnapshot
  },
}
