/** Char-generic matcher cases, exercised through `@` (no options) —
 *  both production wrappers (`matchAtTrigger`, `matchHashTrigger`) are
 *  thin parameterizations of this one implementation; their suites
 *  keep only wrapper-specific guards (stacked `##`, etc.). */
import { describe, expect, it } from 'vitest'
import { matchCharTrigger } from '../triggerMatch'

const at = (text: string, pos: number) => matchCharTrigger(text, pos, '@')

describe('matchCharTrigger', () => {
  it('matches at start of line', () => {
    expect(at('@dandelion', 10)).toEqual({from: 0, query: 'dandelion'})
  })

  it('matches after whitespace and after non-word punctuation', () => {
    expect(at('met at @blue', 12)).toEqual({from: 7, query: 'blue'})
    expect(at('(@blue', 6)).toEqual({from: 1, query: 'blue'})
  })

  it('matches with an empty query (right after the trigger)', () => {
    expect(at('met at @', 8)).toEqual({from: 7, query: ''})
  })

  it('matches multi-word queries across single spaces, up to a mid-word cursor', () => {
    expect(at('lunch @blue bottle', 11)).toEqual({from: 6, query: 'blue'})
    expect(at('lunch @blue bottle', 18)).toEqual({from: 6, query: 'blue bottle'})
    expect(at('@blue ', 6)).toEqual({from: 0, query: 'blue '})
  })

  it('does NOT match with a word char before the trigger (emails, URL anchors)', () => {
    expect(at('a@b', 3)).toBeNull()
    expect(at('user@example', 12)).toBeNull()
  })

  it('does NOT match inside [[wikilink]] brackets', () => {
    expect(at('[[@foo', 6)).toBeNull()
    expect(at('[[foo @bar', 10)).toBeNull()
  })

  it('does NOT match when there is no trigger in the current token', () => {
    expect(at('dandelion', 9)).toBeNull()
  })

  it('does NOT match when the query starts with a space', () => {
    expect(at('see you @ 5pm', 13)).toBeNull()
  })

  it('does NOT match across a double space or tabs', () => {
    expect(at('@home  later that day', 21)).toBeNull()
    expect(at('@foo\tbar', 8)).toBeNull()
  })

  it('does NOT match once the query exceeds the word cap', () => {
    expect(at('@one two three four five six', 28))
      .toEqual({from: 0, query: 'one two three four five six'})
    expect(at('@one two three four five six seven', 34)).toBeNull()
  })

  it('does NOT match once the query exceeds the length cap', () => {
    const long = `@${'a'.repeat(60)}`
    expect(at(long, long.length)).toBeNull()
  })

  it('rejectDoubledTrigger rejects a doubled trigger char; off by default', () => {
    expect(matchCharTrigger('##task', 6, '#', {rejectDoubledTrigger: true})).toBeNull()
    expect(matchCharTrigger('@@name', 6, '@')).toEqual({from: 1, query: 'name'})
  })

  it('the nearest trigger owns the input — a viable sibling trigger breaks the walk', () => {
    // `#` matches its own query; the earlier `@` yields instead of
    // swallowing ` #todo` into a place query (which would fire a
    // remote Places request per tag keystroke).
    expect(matchCharTrigger('meet @cafe #todo', 16, '#')).toEqual({from: 11, query: 'todo'})
    expect(at('meet @cafe #todo', 16)).toBeNull()
    expect(at('meet #proj @home', 16)).toEqual({from: 11, query: 'home'})
    expect(matchCharTrigger('meet #proj @home', 16, '#')).toBeNull()
  })

  it('a NON-viable sibling (word char before it) is query text, not a dead zone', () => {
    // `C#` can never fire the # trigger — if the @ walk yielded to it,
    // NO source would open. Same for `@` inside an email-like token.
    expect(at('@C# dev', 7)).toEqual({from: 0, query: 'C# dev'})
    expect(matchCharTrigger('#email@work', 11, '#')).toEqual({from: 0, query: 'email@work'})
  })

  it('does NOT match inside an unclosed ((blockref span — ownership ends at the first single paren', () => {
    expect(matchCharTrigger('((see #to', 9, '#')).toBeNull()
    expect(at('((see @home', 11)).toBeNull()
    // A single paren is prose, not a blockref.
    expect(matchCharTrigger('(#task', 6, '#')).toEqual({from: 1, query: 'task'})
    // `f((x)` is CLOSED for the blockref matcher (first `)` ends it) —
    // a later trigger on the line must still fire…
    expect(matchCharTrigger('f((x) so #ta', 12, '#')).toEqual({from: 9, query: 'ta'})
    // …and a stray `))` earlier must not cancel a genuine `((`.
    expect(matchCharTrigger('x)) ((y #t', 10, '#')).toBeNull()
  })

  it('throws on a trigger char missing from TRIGGER_CHARS (checked invariant)', () => {
    expect(() => matchCharTrigger('!foo', 4, '!')).toThrow(/TRIGGER_CHARS/)
  })
})
