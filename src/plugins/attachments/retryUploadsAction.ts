/**
 * The §9 failed-upload retry surface: a global action the failed-uploads diagnostics
 * warning ({@link import('./uploadLaneStatus.js')}) points its "Retry" button at, and
 * that the command palette lists. It runs the recovery actor
 * ({@link import('./uploadRecovery.js')}) over the active user's `failed` records — a cheap
 * content-path probe → 3-way (re-drive a freed path / clear an already-uploaded one / keep
 * a poisoned one), then a drain. This is the ONLY recovery trigger (a deliberate §9
 * simplification: transient failures are auto-retried by the drain as `pending`; only the
 * quarantined `failed` set is user-driven), so the user is the rate limiter — no automatic
 * re-drive bound.
 *
 * A single in-flight guard debounces the button: without it, N rapid clicks queue N full
 * passes, each re-PUTting a freed-then-still-failing body's sealed bytes. One retry runs at
 * a time; clicks while it's in flight are ignored until it settles.
 *
 * Lives here (not core) so it only exists when the attachments plugin does, like the
 * image-insert actions.
 */
import { RefreshCw } from 'lucide-react'
import { getActiveUserId } from '@/data/repoProvider.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { runUploadRecovery } from './assetUpload.js'
import { RETRY_UPLOADS_ACTION_ID } from './uploadLaneStatus.js'

let retryInFlight: Promise<void> | null = null

export const retryFailedUploadsAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: RETRY_UPLOADS_ACTION_ID,
  description: 'Retry failed media uploads',
  context: ActionContextTypes.GLOBAL,
  icon: RefreshCw,
  handler: () => {
    const userId = getActiveUserId()
    if (!userId || retryInFlight) return // one retry at a time — swallow double-clicks
    retryInFlight = runUploadRecovery(userId)
    void retryInFlight.finally(() => {
      retryInFlight = null
    })
  },
}
