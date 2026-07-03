import { describe, expect, it } from 'vitest'
import { getSyncIndicatorView } from '../model.ts'

const baseInput = {
  localOnly: false,
  connected: true,
  connecting: false,
  hasSynced: true,
  uploading: false,
  downloading: false,
  pendingChanges: 0,
}

describe('getSyncIndicatorView', () => {
  it('shows the pending upload count from the PowerSync queue', () => {
    const view = getSyncIndicatorView({
      ...baseInput,
      pendingChanges: 3,
    })

    expect(view.state).toBe('pending')
    expect(view.label).toBe('Pending')
    expect(view.pendingLabel).toBe('3')
    expect(view.title).toContain('3 blocks changed, queued for upload')
  })

  it('labels capped pending counts as lower bounds', () => {
    const view = getSyncIndicatorView({
      ...baseInput,
      pendingChanges: 1000,
      pendingChangesApproximate: true,
    })

    expect(view.state).toBe('pending')
    expect(view.pendingLabel).toBe('1000+')
    expect(view.title).toContain('1000+ blocks changed, queued for upload')
  })

  it('shows download progress while preserving the pending count badge', () => {
    const view = getSyncIndicatorView({
      ...baseInput,
      downloading: true,
      pendingChanges: 12,
      downloadFraction: 0.625,
    })

    expect(view.state).toBe('downloading')
    expect(view.label).toBe('Sync 63%')
    expect(view.pendingLabel).toBe('12')
    expect(view.progressPercent).toBe(63)
    expect(view.spinning).toBe(true)
  })

  it('labels local-only sessions without presenting them as sync failures', () => {
    const view = getSyncIndicatorView({
      ...baseInput,
      localOnly: true,
      connected: false,
      pendingChanges: 1,
    })

    expect(view.state).toBe('local')
    expect(view.label).toBe('Local only')
    expect(view.pendingLabel).toBe('1')
    expect(view.title).toContain('1 block changed, stored locally')
  })

  it('surfaces sync errors before passive connection states', () => {
    const view = getSyncIndicatorView({
      ...baseInput,
      connected: false,
      errorMessage: 'JWT expired',
      pendingChanges: 2,
    })

    expect(view.state).toBe('error')
    expect(view.label).toBe('Sync issue')
    expect(view.title).toContain('JWT expired')
    expect(view.pendingLabel).toBe('2')
  })

  describe('materializing backlog (Layout B observer catch-up)', () => {
    // Rows can be downloaded into the `blocks_synced` staging table but not yet
    // applied to the app-visible `blocks` table — a large initial sync drains in
    // bounded windows. While that backlog is non-zero the content isn't on
    // screen yet, so "Synced"/"Offline" would misreport; surface a catch-up.

    it('shows a processing state with the remaining count', () => {
      const view = getSyncIndicatorView({
        ...baseInput,
        materializingChanges: 12_340,
      })

      expect(view.state).toBe('materializing')
      expect(view.label).toBe('Processing')
      expect(view.spinning).toBe(true)
      expect(view.title).toContain('12340 blocks')
    })

    it('outranks the synced chip — downloaded data that is not applied is not "done"', () => {
      const view = getSyncIndicatorView({
        ...baseInput,
        hasSynced: true,
        materializingChanges: 5,
      })

      expect(view.state).toBe('materializing')
    })

    it('surfaces over offline so a disconnected backlog is still visible', () => {
      const view = getSyncIndicatorView({
        ...baseInput,
        connected: false,
        hasSynced: true,
        materializingChanges: 500,
      })

      expect(view.state).toBe('materializing')
    })

    it('yields to an active download (its percentage is the leading progress)', () => {
      const view = getSyncIndicatorView({
        ...baseInput,
        downloading: true,
        downloadFraction: 0.4,
        materializingChanges: 9_000,
      })

      expect(view.state).toBe('downloading')
    })

    it('yields to a hard error', () => {
      const view = getSyncIndicatorView({
        ...baseInput,
        errorMessage: 'JWT expired',
        materializingChanges: 9_000,
      })

      expect(view.state).toBe('error')
    })
  })

  describe('quarantined / rejected changes', () => {
    // When the bucket is otherwise drained, a green "Synced" check
    // misrepresents the state of the data: the server refused some
    // earlier writes and they sit in the rejection quarantine until
    // someone retries or dismisses them. Sync IS working (new writes
    // land), but there's unfinished business — the chip should reflect
    // that without opening the dropdown.

    it('downgrades the synced chip to warning when rejections are present', () => {
      const view = getSyncIndicatorView({
        ...baseInput,
        rejectedChanges: 379,
      })

      expect(view.state).toBe('synced')  // sync IS working
      expect(view.tone).toBe('warning')
      expect(view.icon).toBe('alert')
      expect(view.label).toBe('Synced with issues')
      expect(view.title).toContain('379 changes')
      expect(view.title.toLowerCase()).toMatch(/couldn['']?t sync|need.*attention|review/)
    })

    it("keeps the clean synced view when there are zero rejections", () => {
      const view = getSyncIndicatorView({
        ...baseInput,
        rejectedChanges: 0,
      })

      expect(view.state).toBe('synced')
      expect(view.tone).toBe('success')
      expect(view.icon).toBe('check')
    })

    it("singularizes the rejected count in the title", () => {
      const view = getSyncIndicatorView({
        ...baseInput,
        rejectedChanges: 1,
      })

      expect(view.title).toContain('1 change')
      expect(view.title).not.toContain('1 changes')
    })

    it("mentions rejections in the title for the offline state", () => {
      // Even when offline, the rejection backlog is worth surfacing so
      // the user knows to come back to it when reconnected.
      const view = getSyncIndicatorView({
        ...baseInput,
        connected: false,
        hasSynced: true,
        rejectedChanges: 5,
      })

      expect(view.state).toBe('offline')
      expect(view.title).toContain('5 changes')
    })

    it("doesn't downgrade pending / error / active states (already calling attention)", () => {
      // Pending already uses a warning tone; uploading is active; error
      // is louder than warning. Letting rejections override those would
      // hide the more urgent signal.
      const pending = getSyncIndicatorView({
        ...baseInput,
        pendingChanges: 3,
        rejectedChanges: 5,
      })
      expect(pending.state).toBe('pending')
      expect(pending.icon).toBe('upload')

      const errored = getSyncIndicatorView({
        ...baseInput,
        errorMessage: 'JWT expired',
        rejectedChanges: 5,
      })
      expect(errored.state).toBe('error')
      expect(errored.icon).toBe('alert')
    })
  })

  describe('diagnostic alert (e.g. data-integrity anomaly)', () => {
    const alert = {label: 'Data integrity', summary: '2 issues found'}

    it('escalates a settled state to an error chip with the source label + summary', () => {
      const view = getSyncIndicatorView({...baseInput, diagnosticAlert: alert})
      expect(view.tone).toBe('error')
      expect(view.icon).toBe('alert')
      // The chip names the reporting source generically (not a hardcoded
      // "Integrity issue"), so a non-integrity source would name itself.
      expect(view.label).toBe('Data integrity')
      expect(view.title).toContain('Data integrity: 2 issues found')
    })

    it('yields to a hard sync error (sync broken is more urgent)', () => {
      const view = getSyncIndicatorView({
        ...baseInput,
        errorMessage: 'JWT expired',
        diagnosticAlert: alert,
      })
      expect(view.state).toBe('error')
      expect(view.label).toBe('Sync issue')
    })

    it('does not escalate active/transient states (would clobber progress / fire on a transient)', () => {
      const view = getSyncIndicatorView({
        ...baseInput,
        downloading: true,
        downloadFraction: 0.5,
        diagnosticAlert: alert,
      })
      expect(view.state).toBe('downloading')
      expect(view.spinning).toBe(true)
      expect(view.tone).toBe('active')
    })

    it('leaves a healthy chip untouched when there is no alert', () => {
      const view = getSyncIndicatorView({...baseInput, diagnosticAlert: null})
      expect(view.state).toBe('synced')
      expect(view.tone).toBe('success')
    })
  })
})
