/** Shared trigger-char detection for editor autocompletes (`@` places,
 *  `#` type tags). One implementation of the backward walk + guards so
 *  the fiddly parts — especially the wikilink-ownership parsing — can
 *  only be fixed in one place.
 *
 *  Trigger shape: `<trigger><query>` with no word character before the
 *  trigger (so emails / URL anchors like `a@b`, `page#section` don't
 *  fire) and no `[`/`]` in the query (the wikilink autocomplete owns
 *  `[[…`). The query may contain single spaces ("Blue Bottle Coffee",
 *  "Meeting Note") — a double space, other whitespace, or the
 *  length/word caps end it so prose after a bare `@word`/`#word`
 *  doesn't keep the dropdown alive. A query that starts with a space
 *  never matches (`see you @ 5pm`, and `# Title` markdown headings).
 *  Ownership rules: the trigger nearest the cursor wins over a viable
 *  sibling trigger, and spans owned by other autocompletes — unclosed
 *  `[[` wikilinks and `((` blockrefs — never fire a char trigger. */

export interface TriggerMatch {
  /** Position in the text where the trigger char itself sits. The
   *  inserted/deleted span starts here (so the trigger is consumed). */
  from: number
  /** The text typed after the trigger, possibly empty. */
  query: string
}

export interface CharTriggerOptions {
  /** Reject when the char immediately before the trigger is the
   *  trigger itself — `##foo` is markdown-heading territory, not a
   *  half-typed `#` tag. (The `@` place trigger doesn't set this:
   *  `@@name` has no competing syntax.) */
  rejectDoubledTrigger?: boolean
}

/** All registered trigger chars. The walk breaks on a SIBLING trigger
 *  so the nearest trigger owns the input: in `meet @cafe #todo|` the
 *  `#` source matches `todo` while the `@` walk hits the `#` and
 *  yields — otherwise both sources fire into one dropdown, the place
 *  query swallows ` #todo` (a remote Places request per keystroke),
 *  and the type query swallows ` @home`. */
const TRIGGER_CHARS: ReadonlySet<string> = new Set(['@', '#'])

/** Queries routinely span words, so the caps below decide when a
 *  trigger earlier in the line stops owning what the user types: a
 *  double space or any non-space whitespace ends the query
 *  immediately, and a query longer than this many chars/words is
 *  prose, not a name. Without the caps, every sentence containing a
 *  bare `@word` would re-open the dropdown on each keystroke until end
 *  of line. */
const MAX_QUERY_LEN = 50
const MAX_QUERY_WORDS = 6

/** True when `beforePos` sits after an unclosed `[[` — wikilink spans
 *  belong to the wikilink autocomplete, so char triggers inside them
 *  must not fire. */
const isInsideUnclosedWikilink = (text: string, beforePos: number): boolean => {
  let opens = 0
  let closes = 0
  for (let i = 0; i < beforePos - 1; i++) {
    if (text[i] === '[' && text[i + 1] === '[') {
      opens += 1
      i += 1
    } else if (text[i] === ']' && text[i + 1] === ']') {
      closes += 1
      i += 1
    }
  }
  return opens > closes
}

/** Pure trigger-detection helper. Callers export thin per-char
 *  wrappers (`matchAtTrigger`, `matchHashTrigger`) for their
 *  CompletionSources and tests. */
export const matchCharTrigger = (
  text: string,
  pos: number,
  trigger: string,
  opts: CharTriggerOptions = {},
): TriggerMatch | null => {
  // Checked invariant, not just documentation: a new trigger char that
  // isn't in TRIGGER_CHARS would get silently ASYMMETRIC ownership
  // (its walk yields to the others, theirs plow through it). Fail loud
  // on the new wrapper's first test instead.
  if (!TRIGGER_CHARS.has(trigger)) {
    throw new Error(`matchCharTrigger: trigger '${trigger}' is not registered in TRIGGER_CHARS`)
  }
  // Walk backward from the cursor to find the most recent trigger
  // char. Single spaces are part of the query; wikilink brackets,
  // non-space whitespace, a double space, or an over-long scan
  // interrupt the trigger sequence.
  let i = pos
  while (i > 0) {
    const c = text[i - 1]
    if (c === trigger) break
    // A sibling trigger closer to the cursor owns this input — but
    // only a VIABLE one. A sibling disqualified by its own word-char
    // guard (`C#`, `user@`) can't fire, so yielding to it would leave
    // a dead zone where NO source opens; treat it as query text.
    if (TRIGGER_CHARS.has(c) && !(i >= 2 && /\w/.test(text[i - 2]))) return null
    if (c === ' ') {
      if (i >= 2 && text[i - 2] === ' ') return null
    } else if (/\s/.test(c)) {
      return null
    }
    if (c === '[' || c === ']') return null
    if (pos - i >= MAX_QUERY_LEN) return null
    i -= 1
  }
  if (i === 0 || text[i - 1] !== trigger) return null

  const query = text.slice(i, pos)
  // `@ 5pm` / `# Title` is prose (or a heading), not a half-typed query.
  if (query.startsWith(' ')) return null
  if (query.split(' ').filter(w => w.length > 0).length > MAX_QUERY_WORDS) return null

  const triggerPos = i - 1
  // Word char immediately before the trigger → email-like / URL
  // anchor (`a@b`, `page#section`); skip.
  if (triggerPos > 0 && /\w/.test(text[triggerPos - 1])) return null
  if (opts.rejectDoubledTrigger && triggerPos > 0 && text[triggerPos - 1] === trigger) return null
  // Trigger directly preceded by `[` → inside a half-typed `[[@foo`; skip.
  if (triggerPos > 0 && text[triggerPos - 1] === '[') return null
  // Trigger lives inside an unclosed `[[...` earlier on the line →
  // the wikilink autocomplete owns the input.
  if (isInsideUnclosedWikilink(text, triggerPos)) return null
  // Blockref ownership mirrors blockrefAutocomplete's own matcher
  // exactly (`/\(\(([^)]*?)$/`): a `((` span ends at the first single
  // `)`. Pair-counting `((`/`))` here would poison the rest of the
  // line after prose like `f((x)` and miss a genuine `((` preceded by
  // a stray `))`.
  if (/\(\([^)]*$/.test(text.slice(0, triggerPos))) return null

  return {from: triggerPos, query}
}
