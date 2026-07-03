/**
 * Detect an unrecoverable local-database open failure (SQLite corruption) and
 * carry it to the error boundary as a typed, recoverable error.
 *
 * Why a dedicated type: the bootstrap error boundary needs to tell "the local
 * SQLite file is structurally broken" (offer Export + Reset) apart from any
 * other bootstrap failure (offer only Reload / Sign out). It also needs the
 * `userId` to locate the OPFS `.db` file, which isn't on the raw SQLite error.
 *
 * This module is intentionally dependency-free (no repoProvider import) so the
 * DB-open path can import it without a cycle.
 */

// Substrings SQLite/PowerSync surface when the `.db` bytes can't be opened
// because they're structurally invalid — NOT transient (busy/locked) and NOT
// access-denied (private-browsing OPFS block, handled separately). Matched
// case-insensitively. Each entry is the SPECIFIC SQLite phrasing, not a bare
// token: a routing decision here can lead the user to a DESTRUCTIVE reset, so a
// benign "malformed URL" / "malformed JSON" surfacing during init must NOT match
// (the bare token `malformed` would). The two "malformed" entries are the only
// such emits from SQLite (`SQLITE_CORRUPT`). `sqlite call returned corrupt` is
// the RUNTIME shape: PowerSync's `powersync_control` surfacing SQLITE_CORRUPT
// during sync-apply ("powersync_control: internal SQLite call returned CORRUPT")
// — the class that opens fine but corrupts an already-mounted DB (issue #284).
const CORRUPTION_SUBSTRINGS = [
  'disk image is malformed', // "database disk image is malformed"
  'malformed database schema', // "malformed database schema (...)"
  'not a database', // SQLITE_NOTADB: "file is not a database" / "...or is not a database"
  'database corruption',
  'sqlite_corrupt',
  'sqlite_notadb',
  'sqlite call returned corrupt', // powersync_control surfacing SQLITE_CORRUPT at runtime
] as const

// A TIGHTER set for the RUNTIME sync-apply path (`isRuntimeDbCorruptionError`),
// where `error` is PowerSync's `downloadError`. That field holds ANY sync-loop
// exception — including `HTTP <status>: <raw server body>` — and crosses the
// worker as a plain object, so the broad set above would let a benign server
// error body that merely echoes generic English like "…not a database table…"
// or "malformed … schema" (sync-rule validation) route the user into the
// DESTRUCTIVE recovery UI. These two phrasings are what a real SQLite corruption
// emits AND cannot plausibly appear in the sync API's (Postgres-backed) error
// bodies. `disk image is malformed` is SQLite-only; `sqlite call returned
// corrupt` is powersync_control's exact SQLITE_CORRUPT wrapper.
const RUNTIME_CORRUPTION_SUBSTRINGS = [
  'sqlite call returned corrupt',
  'disk image is malformed',
] as const

const messageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message
  // A worker/Comlink-serialized error arrives as a plain object; read its string
  // `.message` so the recovery UI's detail shows the real text, not "[object Object]".
  if (typeof error === 'object' && error !== null) {
    const msg = (error as { message?: unknown }).message
    if (typeof msg === 'string') return msg
  }
  return String(error)
}

// The SQLite corruption text doesn't always reach us on the top-level `.message`
// — PowerSync/app layers can rethrow with a generic outer message and the real
// error on `.cause` (e.g. `new Error('boot failed', { cause: sqliteError })`).
// Concatenate the whole cause chain (bounded) so substring-matching sees it.
//
// A non-Error is handled too: an error that crosses a Web Worker / Comlink
// boundary can arrive as a PLAIN OBJECT `{name, message, stack}` rather than a
// real `Error` instance — PowerSync's runtime `downloadError` (thrown by the
// wa-sqlite worker's `powersync_control`) is exactly this shape. Reading its
// string `.message` (instead of `String(obj)` → "[object Object]") is what lets
// the runtime-corruption routing match at all.
const messageChainOf = (error: unknown, depth = 5): string => {
  if (depth <= 0 || error === null || error === undefined) return ''
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    return cause === undefined
      ? error.message
      : `${error.message}\n${messageChainOf(cause, depth - 1)}`
  }
  if (typeof error === 'object') {
    const obj = error as { message?: unknown; cause?: unknown }
    if (typeof obj.message === 'string') {
      return obj.cause === undefined
        ? obj.message
        : `${obj.message}\n${messageChainOf(obj.cause, depth - 1)}`
    }
  }
  return String(error)
}

const includesAnySubstring = (error: unknown, substrings: readonly string[]): boolean => {
  const msg = messageChainOf(error).toLowerCase()
  return substrings.some(s => msg.includes(s))
}

/** True when `error` reads like an unrecoverable SQLite-corruption open failure.
 *  Use at the DB-OPEN boundary, where `error` is a real in-process Error (no
 *  worker-boundary / server-body contamination). For the runtime `downloadError`
 *  path use {@link isRuntimeDbCorruptionError}, which is narrower. */
export const isLocalDbCorruptionError = (error: unknown): boolean =>
  includesAnySubstring(error, CORRUPTION_SUBSTRINGS)

/** True when a RUNTIME sync-apply `downloadError` is a genuine SQLite corruption
 *  — tighter than {@link isLocalDbCorruptionError} so a server-controlled error
 *  body can't route a healthy session into the destructive recovery UI (see
 *  RUNTIME_CORRUPTION_SUBSTRINGS). */
export const isRuntimeDbCorruptionError = (error: unknown): boolean =>
  includesAnySubstring(error, RUNTIME_CORRUPTION_SUBSTRINGS)

/**
 * Typed local-DB corruption error. Carries the `userId` so the recovery UI can
 * resolve the OPFS `.db` file, and the original error as `cause`.
 */
export class LocalDatabaseCorruptError extends Error {
  readonly userId: string

  constructor(userId: string, options?: { cause?: unknown }) {
    const cause = options?.cause
    super(`Local database is corrupted and could not be opened: ${messageOf(cause)}`)
    this.name = 'LocalDatabaseCorruptError'
    this.userId = userId
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Recognise a `LocalDatabaseCorruptError` even across HMR / bundle boundaries
 * where `instanceof` can fail (the class identity differs). Returns the wrapped
 * userId, or `null` if `error` isn't a wrapped corruption error.
 */
export const corruptErrorUserId = (error: unknown): string | null => {
  // A non-empty userId is required: downstream resolves the OPFS `.db` from it
  // (`dbFilenameForUser('')` → `kmp-v6-.db`), so an empty id would back up /
  // delete the wrong file. Fall through to the generic boundary instead.
  if (error instanceof LocalDatabaseCorruptError) {
    return error.userId.length > 0 ? error.userId : null
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'LocalDatabaseCorruptError' &&
    typeof (error as { userId?: unknown }).userId === 'string' &&
    (error as { userId: string }).userId.length > 0
  ) {
    return (error as { userId: string }).userId
  }
  return null
}

/**
 * Use at the DB-open boundary: returns a typed `LocalDatabaseCorruptError` (to
 * throw) when `error` is a corruption failure, otherwise returns `error`
 * unchanged so the caller can rethrow it as-is. Idempotent on an
 * already-wrapped error.
 */
export const toLocalDbOpenError = (error: unknown, userId: string): unknown => {
  if (corruptErrorUserId(error) !== null) return error
  if (isLocalDbCorruptionError(error)) return new LocalDatabaseCorruptError(userId, { cause: error })
  return error
}
