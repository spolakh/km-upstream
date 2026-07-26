import { describe, it, expect } from 'vitest'
import {
  buildAppHash,
  buildLayout,
  buildLayoutFromSlots,
  layoutWorkspaceChanged,
  parseAppHash,
  parseLayout,
  preserveHashQueryParams,
} from '@/utils/routing'

describe('parseLayout', () => {
  it('returns an empty block list when hash is empty/undefined/null', () => {
    expect(parseLayout('')).toEqual({slots: [], blockIds: []})
    expect(parseLayout('#')).toEqual({slots: [], blockIds: []})
    expect(parseLayout(undefined)).toEqual({slots: [], blockIds: []})
    expect(parseLayout(null)).toEqual({slots: [], blockIds: []})
  })

  it('parses a workspace with no blocks', () => {
    expect(parseLayout('#ws-1')).toEqual({
      workspaceId: 'ws-1',
      slots: [],
      blockIds: [],
    })
  })

  it('parses a workspace with one block', () => {
    expect(parseLayout('#ws-1/block-1')).toEqual({
      workspaceId: 'ws-1',
      slots: [{kind: 'leaf', blockId: 'block-1'}],
      blockIds: ['block-1'],
    })
  })

  it('parses a workspace with multiple ordered blocks', () => {
    expect(parseLayout('#ws-1/block-1/block-2/block-3')).toEqual({
      workspaceId: 'ws-1',
      slots: [
        {kind: 'leaf', blockId: 'block-1'},
        {kind: 'leaf', blockId: 'block-2'},
        {kind: 'leaf', blockId: 'block-3'},
      ],
      blockIds: ['block-1', 'block-2', 'block-3'],
    })
  })

  it('ignores hash query parameters used for local bridge pairing', () => {
    expect(parseLayout('#ws-1/block-1/block-2?agent-runtime-secret=secret')).toEqual({
      workspaceId: 'ws-1',
      slots: [
        {kind: 'leaf', blockId: 'block-1'},
        {kind: 'leaf', blockId: 'block-2'},
      ],
      blockIds: ['block-1', 'block-2'],
    })
    expect(parseLayout('#?agent-runtime-secret=secret')).toEqual({slots: [], blockIds: []})
  })
})

describe('buildLayout', () => {
  it('renders workspace-only for an empty block list', () => {
    expect(buildLayout('ws-1', [])).toBe('#ws-1')
  })

  it('renders a single block', () => {
    expect(buildLayout('ws-1', ['block-1'])).toBe('#ws-1/block-1')
  })

  it('renders multiple blocks in order', () => {
    expect(buildLayout('ws-1', ['block-1', 'block-2', 'block-3'])).toBe('#ws-1/block-1/block-2/block-3')
  })

})

describe('comma stack grammar', () => {
  it('round-trips a leaf-with-context column, a stack column, and a plain column', () => {
    const hash = '#ws/a;view=video-notes/b,c/d'
    const route = parseLayout(hash)
    expect(route).toEqual({
      workspaceId: 'ws',
      slots: [
        {kind: 'leaf', blockId: 'a', viewMode: 'video-notes'},
        {
          kind: 'stack',
          children: [
            {kind: 'leaf', blockId: 'b'},
            {kind: 'leaf', blockId: 'c'},
          ],
        },
        {kind: 'leaf', blockId: 'd'},
      ],
      blockIds: ['a', 'b', 'c', 'd'],
    })
    expect(buildLayoutFromSlots(route.workspaceId!, route.slots)).toBe(hash)
  })

  it('round-trips a stack column formed from a plain cell and a context-bearing cell', () => {
    const hash = '#ws/a/b;view=x,c'
    const route = parseLayout(hash)
    expect(route.slots).toEqual([
      {kind: 'leaf', blockId: 'a'},
      {
        kind: 'stack',
        children: [
          {kind: 'leaf', blockId: 'b', viewMode: 'x'},
          {kind: 'leaf', blockId: 'c'},
        ],
      },
    ])
    expect(buildLayoutFromSlots(route.workspaceId!, route.slots)).toBe(hash)
  })
})

describe('slot context parsing', () => {
  it.each([
    {suffix: ';view=foo;view=bar', expected: {viewMode: 'foo'}, why: 'duplicate view: first wins'},
    {suffix: ';active;active=false', expected: {active: true}, why: 'duplicate active: first wins'},
    {suffix: ';active=true', expected: {active: true}, why: 'active=true means active'},
    {suffix: ';active=false', expected: {}, why: 'active=false means absent'},
    {suffix: ';;', expected: {}, why: 'empty segments dropped, bare leaf remains'},
    {suffix: ';VIEW=x', expected: {}, why: 'uppercase key fails the key charset'},
    {suffix: ';view=', expected: {}, why: 'empty view value dropped'},
    {suffix: ';view=%zz', expected: {}, why: 'malformed percent-escape dropped'},
    {suffix: ';view=%zz;view=ok', expected: {viewMode: 'ok'}, why: 'first-VALID-wins: malformed view does not pin the dedup slot'},
    {suffix: ';view;view=x', expected: {viewMode: 'x'}, why: 'first-VALID-wins: bare view does not pin the dedup slot'},
    {suffix: ';active=maybe;active', expected: {active: true}, why: 'bad active value dropped without consuming dedup'},
    {suffix: ';max', expected: {rest: ['max']}, why: 'unknown bare key preserved verbatim in rest'},
    {suffix: ';comments=open', expected: {rest: ['comments=open']}, why: 'unknown key=value preserved verbatim in rest'},
    {suffix: ';max;max', expected: {rest: ['max']}, why: 'repeated unknown key deduped to one rest entry'},
    {suffix: ';k=a=b', expected: {}, why: 'unknown value with a second = is malformed'},
    {suffix: ';k=a+b', expected: {}, why: 'unknown value outside the safe charset is malformed'},
    {suffix: ';k=a%3Db', expected: {rest: ['k=a%3Db']}, why: 'percent-encoded unknown value kept verbatim'},
    {suffix: ';k=a=b;k=ok', expected: {rest: ['k=ok']}, why: 'malformed unknown entry does not pin the dedup slot'},
  ])('b$suffix — $why', ({suffix, expected}) => {
    expect(parseLayout(`#ws/b${suffix}`).slots[0]).toEqual({kind: 'leaf', blockId: 'b', ...expected})
  })

  it('re-emits unknown rest entries verbatim on build', () => {
    for (const hash of ['#ws/b;max', '#ws/b;k=a%3Db']) {
      expect(buildLayoutFromSlots('ws', parseLayout(hash).slots)).toBe(hash)
    }
  })

  it('is a parse∘build∘parse fixed point for malformed and encoded unknown entries', () => {
    for (const hash of ['#ws/b;k=a=b', '#ws/b;k=a+b', '#ws/b;k=a%3Db']) {
      const first = parseLayout(hash)
      expect(parseLayout(buildLayoutFromSlots('ws', first.slots))).toEqual(first)
    }
  })
})

describe('slot context value encoding', () => {
  it('encodes to the safe charset and round-trips the exact original value', () => {
    const raw = 'a b(c),d;e/f%'
    const built = buildLayoutFromSlots('ws', [{kind: 'leaf', blockId: 'b', viewMode: raw}])
    const [, encoded] = built.split(';view=')
    expect(encoded).toMatch(/^[A-Za-z0-9%._~-]+$/) // no structural chars survive unescaped
    expect(parseLayout(built).slots[0]).toEqual({kind: 'leaf', blockId: 'b', viewMode: raw})
  })
})

describe('slot context rest canonicalization (parse-time)', () => {
  it('sorts rest entries by key at parse time', () => {
    expect(parseLayout('#ws/b;zzz=1;aaa=2').slots[0]).toEqual({
      kind: 'leaf',
      blockId: 'b',
      rest: ['aaa=2', 'zzz=1'],
    })
  })

  it('is AST-idempotent with multiple rest keys: parse(build(parse(x))) deep-equals parse(x)', () => {
    const first = parseLayout('#ws/b;zzz=1;aaa=2')
    const rebuilt = buildLayoutFromSlots('ws', first.slots)
    expect(parseLayout(rebuilt)).toEqual(first)
  })
})

describe('build-time context guards', () => {
  it('treats an empty viewMode as absent', () => {
    expect(buildLayoutFromSlots('ws', [{kind: 'leaf', blockId: 'b', viewMode: ''}])).toBe('#ws/b')
  })

  it('silently drops rest entries that do not conform to the entry grammar', () => {
    expect(buildLayoutFromSlots('ws', [
      {kind: 'leaf', blockId: 'b', rest: ['ok=1', 'Bad=2', 'sp ace', 'key=val;ue', 'k=(paren)']},
    ])).toBe('#ws/b;ok=1')
  })

  it('excludes reserved keys from rest at build (no duplicate view/active)', () => {
    expect(buildLayoutFromSlots('ws', [
      {kind: 'leaf', blockId: 'b', viewMode: 'real', rest: ['view=evil', 'active', 'ok=1']},
    ])).toBe('#ws/b;ok=1;view=real')
  })
})

describe('top-level salvage (pins)', () => {
  it.each([
    {hash: '#ws/%bad,b/c', ids: ['b', 'c'], why: 'invalid cell in a comma list drops alone'},
    {hash: '#ws//a', ids: ['a'], why: 'empty column dropped'},
    {hash: '#ws/a/', ids: ['a'], why: 'trailing slash is no column'},
    {hash: '#ws/(a,,b)/c', ids: ['c'], why: 'blank cell inside parens drops the whole group, siblings survive'},
  ])('$hash → $ids ($why)', ({hash, ids}) => {
    expect(parseLayout(hash).blockIds).toEqual(ids)
  })
})

describe('context entry robustness (review gaps)', () => {
  it('degrades degenerate paren tokens without throwing', () => {
    expect(parseLayout('#ws/()/c').slots).toEqual([{kind: 'leaf', blockId: 'c'}])
    expect(parseLayout('#ws/(a').slots).toEqual([])
    expect(parseLayout('#ws/a(b)/c').slots).toEqual([{kind: 'leaf', blockId: 'c'}])
    expect(parseLayout('#ws/(a))/c').slots).toEqual([{kind: 'leaf', blockId: 'c'}])
  })

  it('sorts multiple rest entries canonically within rest on build', () => {
    expect(buildLayoutFromSlots('ws', [
      {kind: 'leaf', blockId: 'b', rest: ['zz=1', 'aa=2']},
    ])).toBe('#ws/b;aa=2;zz=1')
  })
})

describe('slot context canonical order', () => {
  it('builds active, then rest (sorted), then view', () => {
    expect(buildLayoutFromSlots('ws', [
      {kind: 'leaf', blockId: 'blockId', viewMode: 'x', active: true, rest: ['max']},
    ])).toBe('#ws/blockId;active;max;view=x')
  })

  it('re-canonicalizes an out-of-order parse on build', () => {
    const route = parseLayout('#ws/b;view=x;active;max')
    expect(buildLayoutFromSlots('ws', route.slots)).toBe('#ws/b;active;max;view=x')
  })
})

describe('sublayout grammar', () => {
  it('parses a sublayout stacked above a plain cell and round-trips verbatim', () => {
    const hash = '#ws/a/(x/y),b/c'
    const route = parseLayout(hash)
    expect(route.slots).toEqual([
      {kind: 'leaf', blockId: 'a'},
      {
        kind: 'stack',
        children: [
          {kind: 'sublayout', columns: [{kind: 'leaf', blockId: 'x'}, {kind: 'leaf', blockId: 'y'}]},
          {kind: 'leaf', blockId: 'b'},
        ],
      },
      {kind: 'leaf', blockId: 'c'},
    ])
    expect(route.blockIds).toEqual(['a', 'x', 'y', 'b', 'c'])
    expect(buildLayoutFromSlots(route.workspaceId!, route.slots)).toBe(hash)
  })

  it('parses a whole-column sublayout and round-trips verbatim', () => {
    const hash = '#ws/(a,b/c)/d'
    const route = parseLayout(hash)
    expect(route.slots).toEqual([
      {
        kind: 'sublayout',
        columns: [
          {kind: 'stack', children: [{kind: 'leaf', blockId: 'a'}, {kind: 'leaf', blockId: 'b'}]},
          {kind: 'leaf', blockId: 'c'},
        ],
      },
      {kind: 'leaf', blockId: 'd'},
    ])
    expect(buildLayoutFromSlots(route.workspaceId!, route.slots)).toBe(hash)
  })

  it('round-trips a sublayout nested inside a sublayout', () => {
    const hash = '#ws/((a/b),c)/d'
    const route = parseLayout(hash)
    expect(route.slots).toEqual([
      {
        kind: 'sublayout',
        columns: [
          {
            kind: 'stack',
            children: [
              {kind: 'sublayout', columns: [{kind: 'leaf', blockId: 'a'}, {kind: 'leaf', blockId: 'b'}]},
              {kind: 'leaf', blockId: 'c'},
            ],
          },
        ],
      },
      {kind: 'leaf', blockId: 'd'},
    ])
    expect(buildLayoutFromSlots(route.workspaceId!, route.slots)).toBe(hash)
  })

  it('a paren group is atomic: any invalid content drops the WHOLE group', () => {
    // %bad fails the blockId charset; outside parens only that cell would
    // drop, but inside parens the entire group goes.
    expect(parseLayout('#ws/(a/%bad,b/c)/d')).toEqual({
      workspaceId: 'ws',
      slots: [{kind: 'leaf', blockId: 'd'}],
      blockIds: ['d'],
    })
  })
})

describe('old (s:...) grammar is dead', () => {
  it('drops a (s:...) cell containing an invalid inner blockId, keeping the rest of the layout', () => {
    expect(parseLayout('#ws/(s:a,b)/c')).toEqual({
      workspaceId: 'ws',
      slots: [{kind: 'leaf', blockId: 'c'}],
      blockIds: ['c'],
    })
  })

  it('drops a (s:...) cell entirely when it is the only column', () => {
    expect(parseLayout('#ws/(s:a,b)')).toEqual({
      workspaceId: 'ws',
      slots: [],
      blockIds: [],
    })
  })
})

describe('ws-token context (`#ws;persp=x/...`)', () => {
  it('splits matrix entries off the workspace token so workspaceId comes out CLEAN', () => {
    expect(parseLayout('#ws-1;persp=abc/block-1')).toEqual({
      workspaceId: 'ws-1',
      wsContext: ['persp=abc'],
      slots: [{kind: 'leaf', blockId: 'block-1'}],
      blockIds: ['block-1'],
    })
  })

  it('parses a ws-context on a workspace-only hash', () => {
    expect(parseLayout('#ws-1;persp=abc')).toEqual({
      workspaceId: 'ws-1',
      wsContext: ['persp=abc'],
      slots: [],
      blockIds: [],
    })
  })

  it('round-trips through buildLayoutFromSlots with and without slots', () => {
    for (const hash of ['#ws-1;persp=abc', '#ws-1;persp=abc/a/b,c']) {
      const route = parseLayout(hash)
      expect(buildLayoutFromSlots(route.workspaceId!, route.slots, route.wsContext)).toBe(hash)
    }
  })

  it('omits wsContext entirely when the ws token carries no entries', () => {
    expect(parseLayout('#ws-1/a')).not.toHaveProperty('wsContext')
    expect(buildLayoutFromSlots('ws-1', [{kind: 'leaf', blockId: 'a'}])).toBe('#ws-1/a')
    expect(buildLayoutFromSlots('ws-1', [{kind: 'leaf', blockId: 'a'}], [])).toBe('#ws-1/a')
  })

  it('every ws key is opaque — persp, unknown keys, and even view/active pass through verbatim', () => {
    expect(parseLayout('#ws;persp=x;zed;view=m;active').wsContext)
      .toEqual(['active', 'persp=x', 'view=m', 'zed'])
  })

  it('canonicalizes at parse: key-sorted, first-wins dedup, malformed entries dropped', () => {
    expect(parseLayout('#ws;zz=1;aa=2;zz=9;Bad=3;sp ace;k=a=b/a').wsContext)
      .toEqual(['aa=2', 'zz=1'])
    // Empty segments are no entries at all.
    expect(parseLayout('#ws;;/a')).not.toHaveProperty('wsContext')
  })

  it('build re-checks programmatic entries (same guard as slot rest)', () => {
    expect(buildLayoutFromSlots('ws', [], ['zz=1', 'aa=2', 'Bad=3', 'zz=9', 'k=a=b']))
      .toBe('#ws;aa=2;zz=1')
  })

  it('is a parse∘build∘parse fixed point', () => {
    for (const hash of ['#ws;persp=x/a', '#ws;zz=1;aa=2', '#ws;k=a=b/a;view=m']) {
      const first = parseLayout(hash)
      const rebuilt = buildLayoutFromSlots(first.workspaceId ?? '', first.slots, first.wsContext)
      expect(parseLayout(rebuilt)).toEqual(first)
    }
  })

  it('slot-level context still parses independently of the ws-context', () => {
    const route = parseLayout('#ws;persp=x/a;view=m;active/b')
    expect(route.workspaceId).toBe('ws')
    expect(route.wsContext).toEqual(['persp=x'])
    expect(route.slots).toEqual([
      {kind: 'leaf', blockId: 'a', viewMode: 'm', active: true},
      {kind: 'leaf', blockId: 'b'},
    ])
  })

  it('parseAppHash returns the clean workspace id for a persp-bearing hash', () => {
    expect(parseAppHash('#ws-1;persp=abc/block-1')).toEqual({
      workspaceId: 'ws-1',
      blockId: 'block-1',
    })
  })
})

describe('preserveHashQueryParams', () => {
  it('carries bridge pairing params onto a replacement layout hash', () => {
    expect(
      preserveHashQueryParams(
        '#ws-1/block-1',
        '#?agent-runtime-secret=secret&agent-runtime-open-tokens=1',
      ),
    ).toBe('#ws-1/block-1?agent-runtime-secret=secret&agent-runtime-open-tokens=1')
  })

  it('keeps replacement hash params authoritative when keys overlap', () => {
    expect(
      preserveHashQueryParams(
        '#ws-1/block-1?agent-runtime-secret=next&debug=1',
        '#old?agent-runtime-secret=old&agent-runtime-open-tokens=1',
      ),
    ).toBe('#ws-1/block-1?agent-runtime-secret=next&debug=1&agent-runtime-open-tokens=1')
  })
})

describe('layoutWorkspaceChanged', () => {
  it('ignores same-workspace panel layout changes', () => {
    expect(layoutWorkspaceChanged('#ws-1/a', '#ws-1/b/c')).toBe(false)
    expect(layoutWorkspaceChanged('#ws-1/a', '#ws-1')).toBe(false)
  })

  it('detects workspace/bootstrap hash changes', () => {
    expect(layoutWorkspaceChanged('#ws-1/a', '#ws-2/a')).toBe(true)
    expect(layoutWorkspaceChanged('#ws-1/a', '')).toBe(true)
    expect(layoutWorkspaceChanged('', '#ws-1/a')).toBe(true)
  })

  it('compares CLEAN ids — a persp-only change is NOT a workspace change (no spurious full remount)', () => {
    expect(layoutWorkspaceChanged('#ws-1;persp=a/x', '#ws-1;persp=b/x')).toBe(false)
    expect(layoutWorkspaceChanged('#ws-1/x', '#ws-1;persp=a/x')).toBe(false)
    // A REAL workspace change under identical persp entries still registers.
    expect(layoutWorkspaceChanged('#ws-1;persp=a/x', '#ws-2;persp=a/x')).toBe(true)
  })
})

describe('parseAppHash', () => {
  it('returns empty when hash is empty/undefined/null', () => {
    expect(parseAppHash('')).toEqual({})
    expect(parseAppHash('#')).toEqual({})
    expect(parseAppHash(undefined)).toEqual({})
    expect(parseAppHash(null)).toEqual({})
  })

  it('parses workspace + block from #<wsId>/<blockId>', () => {
    expect(parseAppHash('#ws-1/block-2')).toEqual({
      workspaceId: 'ws-1',
      blockId: 'block-2',
    })
  })

  it('parses workspace-only hash', () => {
    expect(parseAppHash('#ws-1')).toEqual({
      workspaceId: 'ws-1',
      blockId: undefined,
    })
  })

  it('handles a missing leading #', () => {
    expect(parseAppHash('ws-1/block-2')).toEqual({
      workspaceId: 'ws-1',
      blockId: 'block-2',
    })
  })

  it('treats trailing slash as no block id', () => {
    expect(parseAppHash('#ws-1/')).toEqual({
      workspaceId: 'ws-1',
      blockId: undefined,
    })
  })

  it('ignores hash query parameters used for local bridge pairing', () => {
    expect(parseAppHash('#ws-1/block-2?agent-runtime-secret=secret')).toEqual({
      workspaceId: 'ws-1',
      blockId: 'block-2',
    })
    expect(parseAppHash('#?agent-runtime-secret=secret')).toEqual({})
  })

  it('keeps single-block compatibility by returning the first layout block', () => {
    expect(parseAppHash('#ws-1/block-1/block-2')).toEqual({
      workspaceId: 'ws-1',
      blockId: 'block-1',
    })
  })
})

describe('buildAppHash', () => {
  it('renders workspace + block', () => {
    expect(buildAppHash('ws-1', 'block-2')).toBe('#ws-1/block-2')
  })

  it('renders workspace-only when blockId is omitted', () => {
    expect(buildAppHash('ws-1')).toBe('#ws-1')
  })
})
