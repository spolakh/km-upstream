export type SyncIndicatorState =
  | 'error'
  | 'local'
  | 'uploading'
  | 'downloading'
  | 'materializing'
  | 'pending'
  | 'connecting'
  | 'offline'
  | 'synced'
  | 'starting'

export type SyncIndicatorTone = 'error' | 'local' | 'active' | 'warning' | 'success' | 'neutral'

export type SyncIndicatorIcon = 'alert' | 'hard-drive' | 'upload' | 'sync' | 'offline' | 'check'

export interface SyncIndicatorInput {
  localOnly: boolean
  connected: boolean
  connecting: boolean
  hasSynced?: boolean
  uploading: boolean
  downloading: boolean
  pendingChanges: number
  pendingChangesApproximate?: boolean
  /** Count of rows in `ps_crud_rejected` — writes the server permanently
   *  refused (FK, RLS, 4xx). Sync may still be working for new writes;
   *  these are unfinished business that needs manual retry or dismissal.
   *  Defaults to 0 so callers that don't pipe it in stay backwards-
   *  compatible. */
  rejectedChanges?: number
  /** Rows synced into the `blocks_synced` staging table but not yet applied to
   *  the app-visible `blocks` table — the Layout B observer's
   *  `blocks_synced_changes` backlog. Non-zero means downloaded data hasn't
   *  fully surfaced in the UI yet (e.g. a large initial sync still draining).
   *  Defaults to 0 so callers that don't pipe it in stay unaffected. */
  materializingChanges?: number
  materializingChangesApproximate?: boolean
  downloadFraction?: number | null
  errorMessage?: string | null
  lastSyncedAt?: Date
  /** Worst diagnostic the chip should escalate on (from the diagnostics seam):
   *  an error-severity health signal (e.g. a consistency-audit anomaly). Present
   *  escalates the chip to an error in settled states (the data is structurally
   *  inconsistent even when sync is fine). Null/omitted when nothing is wrong. */
  diagnosticAlert?: DiagnosticAlert | null
}

/** A single error-severity diagnostic worth escalating onto the chip. Generic
 *  (contributed via the diagnostics seam) — the chip doesn't know which plugin
 *  it came from, only the label + one-line summary to show. */
export interface DiagnosticAlert {
  label: string
  summary: string
}

export interface SyncIndicatorView {
  state: SyncIndicatorState
  tone: SyncIndicatorTone
  icon: SyncIndicatorIcon
  label: string
  title: string
  pendingLabel: string | null
  progressPercent: number | null
  spinning: boolean
}

const formatPendingLabel = (count: number, approximate = false): string | null => {
  if (count <= 0) return null
  if (approximate) return `${count}+`
  if (count > 999) return '999+'
  return String(count)
}

// `pendingChanges` counts distinct blocks with queued edits (see
// queueCounts.ts), so the human-readable form is phrased in blocks.
const formatChangeCount = (count: number, approximate = false): string => {
  const countLabel = approximate ? `${count}+` : String(count)
  const noun = count === 1 && !approximate ? 'block' : 'blocks'
  return `${countLabel} ${noun}`
}

const clampProgressPercent = (fraction: number | null | undefined): number | null => {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return null
  return Math.round(Math.max(0, Math.min(1, fraction)) * 100)
}

const formatLastSyncedAt = (date: Date | undefined): string | null => {
  if (!date) return null
  return `Last synced ${date.toLocaleString()}.`
}

const appendPendingTitle = (
  title: string,
  pendingChanges: number,
  localOnly = false,
  approximate = false,
): string => {
  if (pendingChanges <= 0) return title
  const suffix = localOnly
    ? `${formatChangeCount(pendingChanges, approximate)} changed, stored locally.`
    : `${formatChangeCount(pendingChanges, approximate)} changed, queued for upload.`
  return `${title} ${suffix}`
}

const formatRejectedCount = (count: number): string => {
  if (count === 1) return "1 change couldn't sync — review."
  return `${count} changes couldn't sync — review.`
}

const appendRejectedTitle = (title: string, rejectedChanges: number): string => {
  if (rejectedChanges <= 0) return title
  return `${title} ${formatRejectedCount(rejectedChanges)}`
}

const baseSyncIndicatorView = ({
  localOnly,
  connected,
  connecting,
  hasSynced,
  uploading,
  downloading,
  pendingChanges,
  pendingChangesApproximate = false,
  rejectedChanges = 0,
  materializingChanges = 0,
  materializingChangesApproximate = false,
  downloadFraction,
  errorMessage,
  lastSyncedAt,
}: SyncIndicatorInput): SyncIndicatorView => {
  const progressPercent = clampProgressPercent(downloadFraction)
  const pendingLabel = formatPendingLabel(pendingChanges, pendingChangesApproximate)

  if (localOnly) {
    return {
      state: 'local',
      tone: 'local',
      icon: 'hard-drive',
      label: 'Local only',
      title: appendPendingTitle('Remote sync is disabled.', pendingChanges, true, pendingChangesApproximate),
      pendingLabel,
      progressPercent: null,
      spinning: false,
    }
  }

  if (errorMessage) {
    return {
      state: 'error',
      tone: 'error',
      icon: 'alert',
      label: 'Sync issue',
      title: appendPendingTitle(
        `Sync needs attention: ${errorMessage}`,
        pendingChanges,
        false,
        pendingChangesApproximate,
      ),
      pendingLabel,
      progressPercent: null,
      spinning: false,
    }
  }

  if (downloading) {
    return {
      state: 'downloading',
      tone: 'active',
      icon: 'sync',
      label: progressPercent === null ? 'Syncing' : `Sync ${progressPercent}%`,
      title: appendPendingTitle(
        progressPercent === null
          ? 'Downloading remote changes.'
          : `Downloading remote changes: ${progressPercent}%.`,
        pendingChanges,
        false,
        pendingChangesApproximate,
      ),
      pendingLabel,
      progressPercent,
      spinning: true,
    }
  }

  // Downloaded data that hasn't been applied to `blocks` yet is invisible in the
  // UI, so surface the catch-up explicitly — above uploading/pending/offline/
  // synced (all of which would otherwise misreport "done" while content is still
  // missing), but below an active download (its % is the upstream progress) and
  // below a hard error.
  if (materializingChanges > 0) {
    return {
      state: 'materializing',
      tone: 'active',
      icon: 'sync',
      label: 'Processing',
      title: appendPendingTitle(
        `Applying ${formatChangeCount(materializingChanges, materializingChangesApproximate)} of synced data to this device.`,
        pendingChanges,
        false,
        pendingChangesApproximate,
      ),
      pendingLabel,
      progressPercent: null,
      spinning: true,
    }
  }

  if (uploading) {
    return {
      state: 'uploading',
      tone: 'active',
      icon: 'sync',
      label: 'Uploading',
      title: appendPendingTitle('Uploading local changes.', pendingChanges, false, pendingChangesApproximate),
      pendingLabel,
      progressPercent: null,
      spinning: true,
    }
  }

  if (pendingChanges > 0) {
    return {
      state: 'pending',
      tone: connected ? 'warning' : 'neutral',
      icon: 'upload',
      label: 'Pending',
      title: appendPendingTitle(
        connected ? 'Waiting to upload.' : 'Waiting for a sync connection.',
        pendingChanges,
        false,
        pendingChangesApproximate,
      ),
      pendingLabel,
      progressPercent: null,
      spinning: false,
    }
  }

  if (connecting) {
    return {
      state: 'connecting',
      tone: 'active',
      icon: 'sync',
      label: 'Connecting',
      title: 'Connecting to sync.',
      pendingLabel,
      progressPercent: null,
      spinning: true,
    }
  }

  if (!connected) {
    return {
      state: 'offline',
      tone: 'neutral',
      icon: 'offline',
      label: 'Offline',
      title: appendRejectedTitle('Sync is offline.', rejectedChanges),
      pendingLabel,
      progressPercent: null,
      spinning: false,
    }
  }

  if (hasSynced) {
    // The bucket is drained, but if some earlier writes are sitting in
    // the rejection quarantine, sync isn't fully "OK" from the user's
    // perspective. Keep state='synced' (new writes do land) but make
    // the chip visually distinct so it surfaces in passing.
    if (rejectedChanges > 0) {
      return {
        state: 'synced',
        tone: 'warning',
        icon: 'alert',
        label: 'Synced with issues',
        title: appendRejectedTitle(
          formatLastSyncedAt(lastSyncedAt) ?? 'All current changes are synced.',
          rejectedChanges,
        ),
        pendingLabel,
        progressPercent: null,
        spinning: false,
      }
    }
    return {
      state: 'synced',
      tone: 'success',
      icon: 'check',
      label: 'Synced',
      title: formatLastSyncedAt(lastSyncedAt) ?? 'All local changes are synced.',
      pendingLabel,
      progressPercent: null,
      spinning: false,
    }
  }

  return {
    state: 'starting',
    tone: 'active',
    icon: 'sync',
    label: 'Starting',
    title: 'Preparing initial sync.',
    pendingLabel,
    progressPercent: null,
    spinning: true,
  }
}

export const getSyncIndicatorView = (input: SyncIndicatorInput): SyncIndicatorView => {
  const view = baseSyncIndicatorView(input)
  const alert = input.diagnosticAlert
  // A diagnostic alert (e.g. a data-integrity anomaly) is persistent and serious,
  // but unlike a sync error it doesn't block new writes. Surface it on the chip
  // (error tone + alert icon) only in SETTLED states: yield to a hard sync error
  // (already error tone) and to active/transient states (spinning) so it neither
  // clobbers progress nor fires on a mid-sync transient. Details render in the
  // dropdown.
  //
  // The label is the SOURCE'S OWN label (`alert.label`, e.g. "Data integrity"),
  // not a hardcoded string — the alert is generic (any error-severity diagnostic
  // source can raise it), so the chip must name whichever source is reporting.
  if (alert && view.tone !== 'error' && !view.spinning) {
    return {
      ...view,
      tone: 'error',
      icon: 'alert',
      label: alert.label,
      title: `${alert.label}: ${alert.summary} — see details. ${view.title}`,
    }
  }
  return view
}
