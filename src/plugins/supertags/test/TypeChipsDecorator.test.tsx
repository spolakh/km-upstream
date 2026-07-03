// @vitest-environment jsdom
/** Component contract of the chip row: which chips link to a type
 *  definition (user-defined only — kernel/plugin types have no backing
 *  block), how a chip click routes through the navigation opener, and
 *  that the remove button neither navigates nor needs the anchor. The
 *  modifier→target matrix itself is navigation.ts's contract, covered
 *  by its own tests — here the opener is a recording stub. The color
 *  ladder is pure and covered in chipStyle.test.ts (jsdom's CSS parser
 *  rejects `color-mix`, so inline-style asserts can't see it). */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MouseEvent } from 'react'
import { defineBlockType } from '@/data/api'
import { typesFacet } from '@/data/facets'
import { getBlockTypes, typesProp } from '@/data/properties'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { getOrCreateTypesPage } from '@/data/typesPage'
import { createTypeBlock } from '@/data/typeExtraction'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import type { BlockRendererProps } from '@/types'
import { typeChipsDecoratorContribution } from '../TypeChipsDecorator'

const WS = 'ws-supertags-chips'
const TIMEOUT_MS = 3_000

const repoRef = vi.hoisted(() => ({current: undefined as unknown}))
const openCalls = vi.hoisted(() => ({
  current: [] as Array<{blockId: string; workspaceId?: string; defaultPrevented: boolean}>,
}))

vi.mock('@/context/repo', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

vi.mock('@/utils/navigation', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/navigation')>(),
  useBlockOpener: () => (event: MouseEvent, target: {blockId: string; workspaceId?: string}) => {
    // Record defaultPrevented AT CALL TIME: the chip's own onClick must
    // never preventDefault before delegating — the real opener's
    // cmd/middle-click PASSTHROUGH branch relies on the default staying
    // live so the browser opens the href natively.
    openCalls.current.push({...target, defaultPrevented: event.defaultPrevented})
    // Emulate the applyNavigationDecision 'navigate' branch so jsdom
    // doesn't attempt real anchor navigation.
    event.preventDefault()
    event.stopPropagation()
  },
}))

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

interface Harness {
  repo: Repo
  dispose: () => void
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  openCalls.current = []
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [
      typesFacet.of(defineBlockType({id: 'task', label: 'Task'}), {source: 'test'}),
      typesFacet.of(
        defineBlockType({id: 'plumbing', label: 'Plumbing', hideFromCompletion: true}),
        {source: 'test'},
      ),
    ],
  })
  repo.setActiveWorkspaceId(WS)
  repoRef.current = repo
  await getOrCreatePropertiesPage(repo, WS)
  await getOrCreateTypesPage(repo, WS)
  const disposeSchemas = repo.userSchemas.start()
  const disposeTypes = repo.userTypes.start()
  return {repo, dispose: () => { disposeTypes(); disposeSchemas() }}
}

let env: Harness
afterEach(() => {
  cleanup()
  env.dispose()
  repoRef.current = undefined
})

const Inner = ({block}: BlockRendererProps) => <div data-testid="inner">{block.id}</div>
// The contribution ignores its resolve context and never opts out.
const decorateContent = typeChipsDecoratorContribution(undefined as never)
if (!decorateContent) throw new Error('supertags decorator contribution opted out unexpectedly')
const Decorated = decorateContent(Inner)

/** Raw typesProp write (not repo.addType): strict tagging rejects
 *  unregistered ids, but the chip row must render them (the
 *  never-silently-disappear policy) — so seed the property directly. */
const renderTaggedBlock = async (repo: Repo, typeIds: readonly string[]) => {
  const blockId = await repo.mutate.createChild({parentId: repo.typesPageId!})
  const block = repo.block(blockId)
  await block.load()
  await block.set(typesProp, typeIds)
  render(<Decorated block={block}/>)
  await waitFor(
    () => expect(screen.getByLabelText('Block types')).toBeTruthy(),
    {timeout: TIMEOUT_MS},
  )
  return block
}

describe('TypeChipsDecorator', () => {
  it('links a user-defined type chip to its definition block; code/unknown chips stay plain', async () => {
    env = await setup()
    const definitionId = await createTypeBlock(env.repo, {
      workspaceId: WS, label: 'recipe', propertySchemaIds: [],
    })
    await renderTaggedBlock(env.repo, [definitionId, 'task', 'ghost-type'])

    const recipeLink = await screen.findByText('#recipe')
    expect(recipeLink.tagName).toBe('A')
    expect(recipeLink.getAttribute('href')).toContain(definitionId)

    fireEvent.click(recipeLink)
    // A cmd-click must reach the opener with the default still live —
    // its passthrough branch leaves the native href navigation to the
    // browser, which an eager preventDefault in the chip would kill.
    fireEvent.click(recipeLink, {metaKey: true})
    expect(openCalls.current).toEqual([
      {blockId: definitionId, workspaceId: WS, defaultPrevented: false},
      {blockId: definitionId, workspaceId: WS, defaultPrevented: false},
    ])

    // Code-contributed and unregistered types have no definition block
    // to open — their labels must not be anchors.
    expect(screen.getByText('#Task').tagName).not.toBe('A')
    expect(screen.getByText('#ghost-ty…').tagName).not.toBe('A')
  })

  it('plumbing chips (hideFromCompletion) render without the remove X; normal and unregistered chips keep it', async () => {
    env = await setup()
    await renderTaggedBlock(env.repo, ['task', 'plumbing', 'ghost-type'])

    // Rationale lives at the `removable` gate in TypeChipsDecorator.
    expect(screen.getByText('#Plumbing')).toBeTruthy()
    expect(screen.queryByLabelText('Remove Plumbing type')).toBeNull()
    expect(screen.getByLabelText('Remove Task type')).toBeTruthy()
    expect(screen.getByLabelText('Remove ghost-ty… type')).toBeTruthy()
  })

  it('the remove button removes the type without triggering chip navigation', async () => {
    env = await setup()
    const definitionId = await createTypeBlock(env.repo, {
      workspaceId: WS, label: 'recipe', propertySchemaIds: [],
    })
    const block = await renderTaggedBlock(env.repo, [definitionId])

    fireEvent.click(screen.getByLabelText('Remove recipe type'))
    await waitFor(async () => {
      const data = await env.repo.load(block.id)
      expect(getBlockTypes(data!)).toEqual([])
    }, {timeout: TIMEOUT_MS})
    expect(openCalls.current).toEqual([])
  })
})
