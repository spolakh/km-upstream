/**
 * Startup-metrics persistence: assemble the cold-start timeline into a durable
 * record and store it as a block-per-session under a hidden per-user ui-state
 * subtree. Block-per-session (a fresh block id each boot) keeps the log
 * conflict-free across devices — two devices booting never touch the same row,
 * unlike a shared JSON-array property which would LWW-clobber. Each record
 * carries the device + version so a fleet-wide history is groupable.
 *
 * Why a record exists at all: see `src/utils/startupTimeline.ts`. This is the
 * "store it so we can see TTI trend, not just feel it" half.
 */

import { ChangeScope, codecs, defineBlockType, defineProperty } from '@/data/api'
import type { Repo } from '@/data/repo'
import type { AppEffect } from '@/extensions/core.js'
import { onFirstSync, type SyncStatusDb } from '@/data/internals/firstSync.js'
import { getPluginUIStateBlock, getPluginUIStateChild } from '@/data/stateBlocks.js'
import { keyAtStart } from '@/data/orderKey.js'
import { appVersion } from '@/appVersion.js'
import { getClientId } from '@/utils/clientId.js'
import { isInstalledAppDisplayMode } from '@/utils/layoutSessionId.js'
import { scheduleIdle } from '@/utils/scheduleIdle.js'
import {
  getLastLongTaskEndMs,
  getStartupTimeline,
  hasStartupMark,
  longTasksSupported,
  markStartup,
  markStartupAt,
  onLongTask,
  type StartupTimeline,
} from '@/utils/startupTimeline.js'
import { v4 as uuidv4 } from 'uuid'

/** One persisted cold-start sample. All `*Ms` fields are ms-since-boot
 *  (`performance.timeOrigin`); a field is absent if its phase wasn't reached
 *  this session (e.g. `settled` on a session the user closed mid-sync). */
export interface StartupRecordData {
  /** Wall-clock epoch ms at which the record was written. */
  recordedAt: number
  /** Build id (`appVersion.display`) + short sha, so a regression can be tied
   *  to a deploy. */
  appVersion: string
  appSha: string
  /** Stable per-installation client id (see `@/utils/clientId`). Records are
   *  grouped under one block per client so a single browser/device's history is
   *  legible; the id rides the record too so it's self-describing. */
  clientId: string
  /** Coarse device/surface label for grouping ("installed:MacIntel"). */
  deviceLabel: string
  /** Boot start as epoch ms (`performance.timeOrigin`). */
  timeOriginMs: number
  repoReadyMs?: number
  workspaceResolvedMs?: number
  bootstrapDoneMs?: number
  /** First paint of the actual workspace layout — pixels appeared. NOT the
   *  same as interactive: the thread can be hammered right after paint. */
  firstContentPaintMs?: number
  syncedMs?: number
  drainedMs?: number
  /** Time to interactivity — boot contention stopped and the UI became usable
   *  (end of the last long task after first paint). The headline metric. */
  interactiveMs?: number
}

/** The whole record rides one identity-codec property (an engine-controlled
 *  blob), so the shape can evolve without per-field schema churn. A future
 *  trend view reads the child blocks and parses these — fine at this volume. */
export const startupRecordProp = defineProperty<StartupRecordData | undefined>('startupRecord', {
  codec: codecs.optionalIdentity<StartupRecordData>('object'),
  defaultValue: undefined,
  // Automation scope (not UiState) so the record is VISIBLE in the property
  // panel — it renders raw (no editor for an object blob), so the metrics are
  // inspectable.
  changeScope: ChangeScope.Automation,
})

/** Parent ui-state container; each boot adds one child under it. */
export const startupMetricsUIStateType = defineBlockType({
  id: 'startup-metrics',
  label: 'Startup metrics',
  // Plumbing for the # dropdown, but the chip is informative on the
  // record block itself.
  hideFromCompletion: true,
  properties: [],
})

const startupDeviceLabel = (): string => {
  const surface = isInstalledAppDisplayMode() ? 'installed' : 'browser'
  if (typeof navigator === 'undefined') return `${surface}:unknown`
  const platform = navigator.platform || navigator.userAgent.slice(0, 40)
  return `${surface}:${platform}`
}

/** Pure: fold the timeline + metadata into a storable record. */
export const buildStartupRecord = (
  timeline: StartupTimeline,
  meta: { recordedAt: number; appVersion: string; appSha: string; clientId: string; deviceLabel: string },
): StartupRecordData => {
  const { marks } = timeline
  return {
    recordedAt: meta.recordedAt,
    appVersion: meta.appVersion,
    appSha: meta.appSha,
    clientId: meta.clientId,
    deviceLabel: meta.deviceLabel,
    timeOriginMs: timeline.timeOriginMs,
    repoReadyMs: marks.repoReady,
    workspaceResolvedMs: marks.workspaceResolved,
    bootstrapDoneMs: marks.bootstrapDone,
    firstContentPaintMs: marks.firstContentPaint,
    syncedMs: marks.synced,
    drainedMs: marks.drained,
    interactiveMs: marks.interactive,
  }
}

/** Append one startup record as a fresh child block under this client's group
 *  block (one per browser/device installation) inside the per-user
 *  startup-metrics ui-state subtree. Returns the new block id. */
export const writeStartupRecord = async (repo: Repo, workspaceId: string): Promise<string> => {
  const root = await getPluginUIStateBlock(repo, workspaceId, repo.user, startupMetricsUIStateType)
  const clientId = getClientId()
  const deviceLabel = startupDeviceLabel()
  // Group records by client: a per-installation block keyed by the opaque
  // clientId (so every device converges on its own group, distinct from peers
  // even after sync) but titled with the device label + a short id suffix so two
  // browsers sharing a platform string stay distinguishable in the tree.
  const group = await getPluginUIStateChild(root, clientId, `${deviceLabel} · ${clientId.slice(0, 8)}`)
  const data = buildStartupRecord(getStartupTimeline(), {
    recordedAt: Date.now(),
    appVersion: appVersion.display,
    appSha: appVersion.sha,
    clientId,
    deviceLabel,
  })
  const id = uuidv4()
  // Newest-first: read the current first sibling's order key and prepend before
  // it, so the log reads reverse-chronologically within this client's group.
  const first = await repo.db.getOptional<{ order_key: string }>(
    'SELECT order_key FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key LIMIT 1',
    [group.id],
  )
  await repo.tx(async tx => {
    await tx.create(
      {
        id,
        workspaceId,
        parentId: group.id,
        orderKey: keyAtStart(first?.order_key ?? null),
        // Content is just the ISO timestamp so the entry is legible in the tree.
        // FTS indexes it, so a timestamp can surface in (( block-ref autocomplete
        // (not [[-link, which isn't FTS-backed) — acceptable.
        content: new Date(data.recordedAt).toISOString(),
        properties: {},
      },
      { systemMint: true },
    )
    await tx.setProperty(id, startupRecordProp, data)
  }, { scope: ChangeScope.Automation, description: 'startup metrics record' })
  return id
}

// ──── collection effect ────

/** A main thread quiet for this long (no long task) after first paint is treated
 *  as "boot contention stopped" — the `interactive` mark lands at the end of the
 *  last long task before this window. */
const INTERACTIVE_QUIET_MS = 2_000

/** If `interactive` is never reached (sync never completes, thread never quiets),
 *  still persist what we have so the earlier marks aren't lost. */
const SETTLE_FALLBACK_MS = 60_000

// Once per page session: boot happens once, and the marks are boot-relative, so
// a later workspace switch must not record a second "startup".
let recorded = false

/** Test helper — re-arm the once-per-session guard. */
export const resetStartupMetricsRecorded = (): void => { recorded = false }

/**
 * On first workspace open, detect time-to-interactivity and persist one record.
 *
 * The headline `interactive` mark is the end of the last long task after first
 * paint — i.e. when boot contention stopped and the UI became usable — found by
 * waiting for a sustained quiet window in the Long Tasks stream. (Without the
 * Long Tasks API we fall back to a single post-paint idle frame, a coarser
 * proxy.) `synced`/`drained` are captured alongside as warm-vs-cold diagnostics
 * (both ~immediate on a warm start; on a cold start the materialization long
 * tasks push `interactive` out on their own). The write itself is deferred to
 * idle so the bookkeeping never re-adds boot contention.
 */
export const collectStartupMetricsEffect: AppEffect = {
  id: 'startup-metrics.collect',
  start: ({ repo, workspaceId }) => {
    if (!workspaceId || recorded) return
    let done = false
    const cleanups: Array<() => void> = []
    const runCleanups = () => { for (const c of cleanups.splice(0)) c() }

    const record = () => {
      if (done) return
      done = true
      runCleanups()
      recorded = true
      scheduleIdle(() => {
        void writeStartupRecord(repo, workspaceId).catch(err =>
          console.warn('[startup-metrics] failed to write record', err),
        )
      })
    }

    const fallback = setTimeout(record, SETTLE_FALLBACK_MS)
    cleanups.push(() => clearTimeout(fallback))

    // Diagnostics — sync complete + materialization caught up. Don't gate the
    // record: warm starts hit both ~instantly; cold starts surface their cost
    // through `interactive` (materialization long tasks) regardless.
    cleanups.push(onFirstSync(repo.db as unknown as SyncStatusDb, () => {
      if (done) return
      markStartup('synced')
      void repo.flushSyncObserver().then(() => { if (!done) markStartup('drained') })
    }))

    // Headline TTI — the boot contention stopping: a sustained quiet window (no
    // long task for INTERACTIVE_QUIET_MS) after first paint. The window is
    // DEBOUNCED off the long-task stream (reset on each task via onLongTask),
    // not polled — so the quiet timer always resets from the same event that
    // advances the last-long-task time, with no poll-vs-observer stale read.
    let paintTimer: ReturnType<typeof setTimeout> | undefined
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    cleanups.push(() => {
      if (paintTimer) clearTimeout(paintTimer)
      if (quietTimer) clearTimeout(quietTimer)
    })

    const acceptInteractive = () => {
      if (done) return
      const fcp = getStartupTimeline().marks.firstContentPaint ?? 0
      // The instant it became usable (end of the last long task), not "now".
      markStartupAt('interactive', Math.max(getLastLongTaskEndMs() ?? 0, fcp))
      record()
    }
    const armQuietTimer = () => {
      if (done) return
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(acceptInteractive, INTERACTIVE_QUIET_MS)
    }
    const waitForPaint = () => {
      paintTimer = undefined
      if (done) return
      if (!hasStartupMark('firstContentPaint')) {
        paintTimer = setTimeout(waitForPaint, 250) // not painted yet — re-poll
        return
      }
      if (!longTasksSupported()) {
        // No Long Tasks API (Safari/test): coarse proxy — one idle frame after
        // paint, via the shared scheduleIdle. The `done` guard makes a disposer
        // unnecessary (a post-teardown callback no-ops).
        scheduleIdle(() => {
          if (done) return
          markStartup('interactive')
          record()
        })
        return
      }
      cleanups.push(onLongTask(armQuietTimer))
      armQuietTimer()
    }
    waitForPaint()

    return () => { done = true; runCleanups() }
  },
}
