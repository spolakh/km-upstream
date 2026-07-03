/**
 * Trigger a browser download of an in-memory {@link Blob} via a transient anchor.
 *
 * The anchor is created, clicked, and removed synchronously — it is NEVER left in
 * the DOM — and its object URL is revoked on the next microtask. Two properties
 * matter to callers:
 *   - No navigable `blob:` URL survives in the document, so there's nothing to
 *     middle-click / open-in-new-tab (a persistent `<a href="blob:">` typed with an
 *     active content-type would be a same-origin render/XSS vector).
 *   - `blob:` URLs don't expose download completion, so an optional `cleanup` runs on
 *     a long delay (only needed by callers holding an OPFS temp snapshot alive).
 */
export function downloadBlob(
  blob: Blob,
  filename: string,
  cleanup?: () => void | Promise<void>,
): void {
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // Revoke after the click microtask finishes so the browser has a
    // chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 0)
    if (cleanup) {
      // Blob URLs do not expose download completion. This fallback path is
      // only for browsers without showSaveFilePicker; keep the snapshot
      // around long enough for a large download to start and finish.
      setTimeout(() => {
        void Promise.resolve(cleanup()).catch(error => {
          console.warn('[download-blob] failed to run download cleanup:', error)
        })
      }, 60 * 60 * 1000)
    }
  }
}
