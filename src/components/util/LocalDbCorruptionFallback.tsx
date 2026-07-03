import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useIsLocalOnly, useSignOut } from '@/components/Login.js'
import { downloadLocalDbBackup, resetLocalDatabase } from '@/utils/localDbRecovery.js'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const formatMiB = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`

/**
 * Bootstrap fallback shown when the local SQLite database is corrupt and can't
 * be opened (see [[ipad-opfs-sqlite-corruption]]). Recovery is MANUAL: the user
 * downloads a backup of the (corrupt) DB and then resets — we never wipe
 * automatically. Reset deletes only the local SQLite files (keeps e2ee keys,
 * auth, media) and reloads.
 *
 * Local-only vs synced matters here: a synced workspace re-downloads from the
 * server after reset, but a LOCAL-ONLY workspace has no server copy — reset is
 * irreversible data loss. We branch the warnings on `useIsLocalOnly()` and gate
 * the destructive button behind a backup attempt so the "always offer the old
 * `.db`" promise is enforced, not merely suggested.
 *
 * Self-contained (no `openDialog`/Dialog portal): the app shell isn't mounted in
 * this state, so the confirm step is inline.
 */
export function LocalDbCorruptionFallback({
  userId,
  detail,
}: {
  userId: string
  detail: string
}) {
  const signOut = useSignOut()
  const localOnly = useIsLocalOnly()
  const [confirming, setConfirming] = useState(false)
  const [downloadStarted, setDownloadStarted] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [backupFailed, setBackupFailed] = useState(false)
  const [busy, setBusy] = useState<null | 'export' | 'reset'>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Reset is gated until the user has CONFIRMED they have a backup OR an export
  // attempt genuinely failed (the corrupt file may be unreadable — don't trap
  // them). `downloaded` means "user confirmed the file saved", NOT merely
  // "download fired": an <a download> click has no completion/cancel signal, so
  // we can't treat a started download as a saved backup. This enforces "always
  // give them the old db file when they choose to reset".
  const resetUnlocked = downloaded || backupFailed

  const handleExport = async () => {
    setBusy('export')
    setActionError(null)
    setBackupFailed(false)
    setStatus('Preparing download…')
    try {
      const { filename, size } = await downloadLocalDbBackup(userId)
      setDownloadStarted(true)
      setStatus(
        `Download started for ${filename} (${formatMiB(size)}). ` +
        `Check it saved to your device, then confirm you have it below.`,
      )
    } catch (err) {
      setStatus(null)
      setBackupFailed(true)
      setActionError(`Couldn't export the database: ${messageOf(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const confirmBackupSaved = () => {
    setDownloaded(true)
    setActionError(null)
    setStatus('Backup confirmed — you can reset now.')
  }

  const handleReset = async () => {
    setBusy('reset')
    setActionError(null)
    setStatus('Resetting local database…')
    try {
      await resetLocalDatabase(userId)
      // A fresh PowerSync init on reload opens an empty DB and re-syncs.
      window.location.reload()
    } catch (err) {
      setStatus(null)
      setActionError(`Reset failed: ${messageOf(err)}`)
      setBusy(null)
    }
  }

  const handleSignOut = async () => {
    try {
      await signOut()
    } catch (err) {
      console.error('Sign-out failed', err)
      window.location.reload()
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Local database problem</h1>
          {localOnly ? (
            <p className="text-sm text-muted-foreground">
              This device&apos;s local database is corrupted and can&apos;t be opened. This
              workspace is <strong>local-only</strong> — it does not sync to a server, so this
              device holds your <strong>only</strong> copy. Download a backup before anything
              else; resetting permanently deletes it.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              This device&apos;s local copy of your workspace is corrupted and can&apos;t be
              opened. Your data on the server is unaffected — once you reset, it
              re-downloads here. First, download a backup so nothing is lost.
            </p>
          )}
        </div>

        <pre className="max-h-24 overflow-auto rounded bg-muted p-2 text-xs text-muted-foreground">
          {detail}
        </pre>

        {status && <p className="text-sm text-muted-foreground">{status}</p>}
        {actionError && <p className="text-sm text-destructive">{actionError}</p>}

        {!confirming ? (
          <>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                onClick={() => void handleExport()}
                disabled={busy !== null}
                className="flex-1 min-w-0"
              >
                {busy === 'export' ? 'Downloading…' : 'Download backup (.db)'}
              </Button>
              <Button
                variant="destructive"
                onClick={() => setConfirming(true)}
                disabled={busy !== null}
                className="flex-1 min-w-0"
              >
                {localOnly ? 'Reset (delete local data)…' : 'Reset & re-sync…'}
              </Button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                onClick={() => window.location.reload()}
                disabled={busy !== null}
                className="flex-1 min-w-0"
              >
                Reload
              </Button>
              <Button
                variant="outline"
                onClick={() => void handleSignOut()}
                disabled={busy !== null}
                className="flex-1 min-w-0"
              >
                Sign out
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-3 rounded border border-destructive/40 bg-destructive/5 p-3">
            {localOnly ? (
              <p className="text-sm text-destructive">
                This permanently deletes this workspace on this device. It is
                <strong> local-only</strong>, so there is <strong>no server copy</strong> to
                restore from — anything not exported is lost for good. Your encryption keys
                and sign-in stay on this device.
              </p>
            ) : (
              <p className="text-sm text-destructive">
                This deletes the local database on this device and re-downloads
                everything from the server. Changes not yet synced — and local
                history — will be permanently lost. Your encryption keys and sign-in
                stay on this device.
              </p>
            )}
            {!downloadStarted && !backupFailed && (
              <p className="text-sm text-muted-foreground">
                Download a backup first — the delete button stays disabled until you confirm
                you have it.
              </p>
            )}
            {downloadStarted && !downloaded && (
              <p className="text-sm text-muted-foreground">
                A download was started, but the browser can&apos;t tell us if it actually
                saved. Make sure the file is on your device, then confirm — only then does
                reset unlock.
              </p>
            )}
            {backupFailed && !downloaded && (
              <p className="text-sm text-destructive">
                The backup couldn&apos;t be saved (see above). You can still reset, but
                anything only on this device will be lost.
              </p>
            )}
            {downloadStarted && !downloaded && (
              <Button
                onClick={confirmBackupSaved}
                disabled={busy !== null}
                className="w-full"
              >
                I&apos;ve saved the backup file
              </Button>
            )}
            {/* Download is the precondition step — full width on its own line so
                the two long labels below don't overflow the card (the destructive
                + Cancel pair share a row). */}
            {!downloaded && (
              <Button
                variant="outline"
                onClick={() => void handleExport()}
                disabled={busy !== null}
                className="w-full"
              >
                {busy === 'export'
                  ? 'Downloading…'
                  : backupFailed
                    ? 'Try backup again'
                    : downloadStarted
                      ? 'Download again'
                      : 'Download backup first'}
              </Button>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="destructive"
                onClick={() => void handleReset()}
                disabled={busy !== null || !resetUnlocked}
                className="flex-1 min-w-0"
              >
                {busy === 'reset' ? 'Resetting…' : 'Delete local data & reload'}
              </Button>
              <Button
                variant="outline"
                onClick={() => setConfirming(false)}
                disabled={busy !== null}
                className="flex-1 min-w-0"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
