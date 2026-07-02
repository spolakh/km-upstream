import { describe, expect, it } from 'vitest'
import { dbFilenameForUser, previewDbSuffix } from '@/data/repoProvider'

// The local SQLite DB is per-origin; PR previews share production's origin. These
// pin the two data-safety invariants of the preview namespacing (repoProvider.ts):
// production's filename must stay byte-for-byte identical (existing users keep
// their data), and a preview must get an isolated filename (a preview's client
// migration can't touch the real local DB).
describe('previewDbSuffix', () => {
  it('is empty for production and root deploys', () => {
    expect(previewDbSuffix('/knowledge-medium/')).toBe('')
    expect(previewDbSuffix('/')).toBe('')
  })

  it('derives -pr-<n> from a preview base path', () => {
    expect(previewDbSuffix('/knowledge-medium/pr-preview/pr-292/')).toBe('-pr-292')
    expect(previewDbSuffix('/knowledge-medium/pr-preview/pr-1/')).toBe('-pr-1')
  })
})

describe('dbFilenameForUser', () => {
  it('leaves the production filename unchanged', () => {
    expect(dbFilenameForUser('user-1', '/knowledge-medium/')).toBe('kmp-v6-user-1.db')
    expect(dbFilenameForUser('user-1', '/')).toBe('kmp-v6-user-1.db')
  })

  it('isolates a preview into its own DB namespace', () => {
    expect(dbFilenameForUser('user-1', '/knowledge-medium/pr-preview/pr-292/')).toBe(
      'kmp-v6-user-1-pr-292.db',
    )
  })

  it('keeps production capped at the full 40-char user segment', () => {
    expect(dbFilenameForUser('a'.repeat(50), '/knowledge-medium/')).toBe(`kmp-v6-${'a'.repeat(40)}.db`)
  })

  it('sanitizes and length-caps the user segment, reserving room for the suffix', () => {
    const long = 'a'.repeat(80)
    // '-pr-292' is 7 chars, taken out of the 40-char user budget → 33 kept.
    const name = dbFilenameForUser(`${long}!!`, '/knowledge-medium/pr-preview/pr-292/')
    expect(name).toBe(`kmp-v6-${'a'.repeat(33)}-pr-292.db`)
  })

  it('stays within the 64-char wa-sqlite pathname cap at worst case', () => {
    // Max user + a wide PR number: the suffix eats into the user budget, so the
    // base stays ~50 chars, leaving headroom for sqlite's -journal/-wal/-shm.
    const name = dbFilenameForUser('a'.repeat(40), '/knowledge-medium/pr-preview/pr-99999999/')
    expect(name.length + '-journal'.length).toBeLessThan(64)
  })
})
