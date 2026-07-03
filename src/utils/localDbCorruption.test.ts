import { describe, expect, it } from 'vitest'
import {
  LocalDatabaseCorruptError,
  corruptErrorUserId,
  isLocalDbCorruptionError,
  isRuntimeDbCorruptionError,
  toLocalDbOpenError,
} from './localDbCorruption'

describe('isLocalDbCorruptionError', () => {
  it('matches the SQLite corruption messages we actually see on open', () => {
    for (const msg of [
      'database disk image is malformed',
      'malformed database schema (blocks_fts_update) - trigger blocks_fts_update already exists',
      'file is not a database',
      'file is encrypted or is not a database',
      'SQLITE_CORRUPT: database disk image is malformed',
      // Runtime sync-apply corruption surfaced by PowerSync's control fn (#284).
      'powersync_control: internal SQLite call returned CORRUPT',
    ]) {
      expect(isLocalDbCorruptionError(new Error(msg)), msg).toBe(true)
    }
  })

  it('does NOT match transient / unrelated open failures', () => {
    for (const msg of [
      'database is locked',
      'SQLITE_BUSY: database is busy',
      'no such table: blocks',
      'This browser is blocking local storage access (OPFS)',
      'NetworkError when attempting to fetch resource',
    ]) {
      expect(isLocalDbCorruptionError(new Error(msg)), msg).toBe(false)
    }
  })

  it('does NOT match a benign "malformed X" that is not SQLite corruption', () => {
    // The substring list must be the specific SQLite phrasings, not a bare
    // `malformed` — otherwise a malformed-URL/JSON/UTF-8 error surfacing during
    // init would route the user to a DESTRUCTIVE reset for a healthy DB.
    for (const msg of [
      'Failed to construct URL: malformed input',
      'SyntaxError: malformed JSON response',
      'malformed UTF-8 data',
    ]) {
      expect(isLocalDbCorruptionError(new Error(msg)), msg).toBe(false)
    }
  })

  it('walks the cause chain so corruption wrapped behind a generic message still matches', () => {
    const wrapped = new Error('Failed to initialize database', {
      cause: new Error('database disk image is malformed'),
    })
    expect(isLocalDbCorruptionError(wrapped)).toBe(true)
    // ...but a generic error with a benign cause still does not match.
    const benign = new Error('boot failed', { cause: new Error('network down') })
    expect(isLocalDbCorruptionError(benign)).toBe(false)
  })

  it('handles non-Error values', () => {
    expect(isLocalDbCorruptionError('database disk image is malformed')).toBe(true)
    expect(isLocalDbCorruptionError(null)).toBe(false)
    expect(isLocalDbCorruptionError(undefined)).toBe(false)
  })

  it('matches a PLAIN-OBJECT error (worker/Comlink-serialized, not an Error instance)', () => {
    // PowerSync's runtime `downloadError` arrives from the wa-sqlite worker as a
    // plain {name, message, stack} object — `error instanceof Error` is false, so
    // the matcher must still read its string `.message` (not String(obj)).
    const serialized = {
      name: 'Error',
      message: 'powersync_control: internal SQLite call returned CORRUPT',
      stack: 'check@https://…/WASQLiteDB.worker.js:617:24',
    }
    expect(isLocalDbCorruptionError(serialized)).toBe(true)
    // corruption on a plain object's `.cause` is matched too
    expect(isLocalDbCorruptionError({ message: 'boot failed', cause: serialized })).toBe(true)
    // a benign plain object does not match
    expect(isLocalDbCorruptionError({ message: 'network request failed' })).toBe(false)
    expect(isLocalDbCorruptionError({ code: 5 })).toBe(false)
  })
})

describe('isRuntimeDbCorruptionError', () => {
  it('matches a genuine runtime SQLite corruption (Error and plain-object shapes)', () => {
    const msg = 'powersync_control: internal SQLite call returned CORRUPT'
    expect(isRuntimeDbCorruptionError(new Error(msg))).toBe(true)
    // The real runtime shape: a worker-serialized plain object, not an Error.
    expect(isRuntimeDbCorruptionError({ name: 'Error', message: msg, stack: 'x' })).toBe(true)
    expect(isRuntimeDbCorruptionError({ message: 'database disk image is malformed' })).toBe(true)
  })

  it('does NOT route a benign HTTP/sync error whose SERVER body echoes a broad corruption phrase', () => {
    // downloadError carries any sync-loop failure, incl. `HTTP <status>: <body>`.
    // The broad open-path matcher WOULD match these (server-controlled text);
    // the runtime matcher must not, so a healthy session isn't yanked to reset.
    for (const message of [
      'HTTP Bad Request: table "users" is not a database table',
      'HTTP 400: malformed database schema in sync rules',
      'HTTP 500: internal database corruption on the server',
      'SQLITE_CORRUPT reported by an upstream service',
    ]) {
      expect(isLocalDbCorruptionError({ message }), `broad: ${message}`).toBe(true)
      expect(isRuntimeDbCorruptionError({ message }), `runtime: ${message}`).toBe(false)
    }
    expect(isRuntimeDbCorruptionError({ message: 'network request failed' })).toBe(false)
  })
})

describe('toLocalDbOpenError', () => {
  it('wraps a corruption error, carrying userId + the original as cause', () => {
    const original = new Error('database disk image is malformed')
    const wrapped = toLocalDbOpenError(original, 'user-123')
    expect(wrapped).toBeInstanceOf(LocalDatabaseCorruptError)
    expect((wrapped as LocalDatabaseCorruptError).userId).toBe('user-123')
    expect((wrapped as LocalDatabaseCorruptError).cause).toBe(original)
  })

  it('passes a non-corruption error through unchanged', () => {
    const original = new Error('database is locked')
    expect(toLocalDbOpenError(original, 'user-123')).toBe(original)
  })

  it('is idempotent on an already-wrapped error (no double-wrap)', () => {
    const wrapped = new LocalDatabaseCorruptError('user-123', { cause: new Error('malformed') })
    expect(toLocalDbOpenError(wrapped, 'user-456')).toBe(wrapped)
  })
})

describe('corruptErrorUserId', () => {
  it('returns the userId for a wrapped error', () => {
    expect(corruptErrorUserId(new LocalDatabaseCorruptError('u1'))).toBe('u1')
  })

  it('recognises a structurally-equal error across instanceof boundaries', () => {
    // Simulates an HMR/bundle boundary where the class identity differs.
    const lookalike = { name: 'LocalDatabaseCorruptError', userId: 'u2', message: 'x' }
    expect(corruptErrorUserId(lookalike)).toBe('u2')
  })

  it('returns null for unrelated errors', () => {
    expect(corruptErrorUserId(new Error('boom'))).toBeNull()
    expect(corruptErrorUserId(null)).toBeNull()
  })

  it('rejects an empty userId (would resolve the wrong OPFS file)', () => {
    expect(corruptErrorUserId(new LocalDatabaseCorruptError(''))).toBeNull()
    expect(
      corruptErrorUserId({ name: 'LocalDatabaseCorruptError', userId: '', message: 'x' }),
    ).toBeNull()
  })
})
