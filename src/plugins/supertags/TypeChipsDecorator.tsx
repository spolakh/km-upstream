/** Block content decorator that renders a block's types as trailing
 *  `#label` chips (Tana-style supertags), each with a remove button.
 *
 *  Unlike the character-counter/geo decorators, the contribution does
 *  NOT gate on `ctx.types` — the wrap applies to every block and the
 *  component decides whether to render chips. NOTE the honest scope of
 *  this: a types change still remounts the content subtree regardless,
 *  because `types` participates in `DefaultBlockRenderer`'s
 *  resolve-context and slot identity (the `#` pick flow stays correct
 *  across that remount because its tag write is cache-coherent — see
 *  codeMirrorExtensions.ts). What the unconditional wrap DOES buy:
 *  chip visibility driven by the registry (`hideFromBlockDisplay`
 *  edits, late type
 *  publication) re-renders in place instead of re-resolving decorator
 *  gates, and if the renderer's slot identity is ever stabilized the
 *  no-remount invariant holds here without changes. The WeakMap cache
 *  keeps identity stable across parent re-renders (same invariant as
 *  CharacterCountDecorator). */

import type { TypeContribution } from '@/data/api'
import type { Block } from '@/data/block.js'
import { typesProp } from '@/data/properties'
import { useProperty, useWorkspaceId } from '@/hooks/block.js'
import { useTypes } from '@/hooks/typeRegistry.js'
import { useBlockOpener } from '@/utils/navigation'
import { buildAppHash } from '@/utils/routing'
import { TypeChip } from '@/components/typeChip/TypeChip'
import {
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { visibleTagTypeIds } from './typeAutocomplete'

const TypeChips = ({block, typeIds, registry}: {
  block: Block
  typeIds: readonly string[]
  registry: ReadonlyMap<string, TypeContribution>
}) => {
  const repo = block.repo
  const readOnly = repo.isReadOnly
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')
  // One opener for the whole chip row (chips render in a loop). Default
  // 'follow-link' role: a chip is an inline link, so plain click swaps
  // this panel; shift / alt / cmd follow the canonical modifier matrix.
  const openBlock = useBlockOpener()
  return (
    // role="group": aria-label is ignored on a generic span, and the
    // row needs an accessible name to announce as one unit.
    <span role="group" className="flex min-w-0 flex-wrap items-center gap-1" aria-label="Block types">
      {typeIds.map(typeId => {
        const type = registry.get(typeId)
        // Plumbing chips (panel, user, prefs containers — anything the
        // `#` dropdown refuses to offer) are informative but LOAD-
        // BEARING: one click on the X would strip e.g. `panel-stack`
        // from a layout row or orphan a plugin's prefs container, and
        // the dropdown can't re-add what it never offers. Keep those
        // chips read-only here; the property panel (which lists every
        // type) stays the deliberate-removal surface. Unregistered ids
        // keep their X — removing a junk tag is the point of the chip.
        const removable = !readOnly && type?.hideFromCompletion !== true
        // A user-defined type's definition block IS its id's source —
        // link the chip there. Kernel/plugin types have no backing
        // block (their config lives in code), so their chips stay
        // plain text.
        const definitionId = repo.userTypes.getTypeBlockId(typeId)
        return (
          <TypeChip
            key={typeId}
            typeId={typeId}
            type={type}
            withHash
            link={definitionId ? {
              href: buildAppHash(workspaceId, definitionId),
              onClick: event => openBlock(event, {blockId: definitionId, workspaceId}),
            } : undefined}
            onRemove={removable ? () => { void block.removeType(typeId) } : undefined}
          />
        )
      })}
    </span>
  )
}

interface TypeChipsDecoratorProps {
  block: Block
  Inner: BlockRenderer
}

/** Layout: chips hug the end of the content instead of claiming a
 *  column. In a flex-WRAP container, line-breaking is decided on the
 *  items' base sizes before any shrinking, so the chip row can never
 *  squeeze the content narrower: short single-line content gets the
 *  chips right after the text (Tana-ish); content long enough to wrap
 *  puts them on their own row below. True Tana inline-in-the-last-line
 *  isn't reachable while the content is a block-level editor — it
 *  would need a CodeMirror end-of-doc widget. */
const TypeChipsDecorator = ({block, Inner}: TypeChipsDecoratorProps) => {
  const [types] = useProperty(block, typesProp)
  const registry = useTypes()
  const visible = visibleTagTypeIds(types, registry)
  return (
    <div className="flex w-full flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      {/* No chips → full row, exactly the undecorated layout (a fit-
          content editor on an EMPTY block collapses to ~0px and hides
          the caret). With chips → intrinsic width so they hug the end
          of the text, with a 2rem floor as the caret's landing strip.
          Embed CONTENT renderers (video player etc.) sit inside this
          wrapper even though the decorator is innermost — a 100%-width
          iframe/video/audio has no useful intrinsic width (react-player
          renders an audio element for audio-file URLs), so fit-content
          would collapse it; give those the full row and let the chips
          wrap below. */}
      <div className={visible.length > 0
        ? 'min-w-8 max-w-full has-[iframe]:w-full has-[video]:w-full has-[audio]:w-full'
        : 'w-full'}>
        <Inner block={block}/>
      </div>
      {visible.length > 0 && <TypeChips block={block} typeIds={visible} registry={registry}/>}
    </div>
  )
}

const cache = new WeakMap<BlockRenderer, BlockRenderer>()

const decorate: BlockContentDecorator = inner => {
  const existing = cache.get(inner)
  if (existing) return existing
  const Decorated: BlockRenderer = ({block}) => (
    <TypeChipsDecorator block={block} Inner={inner}/>
  )
  Decorated.displayName = 'WithTypeChips'
  cache.set(inner, Decorated)
  return Decorated
}

export const typeChipsDecoratorContribution: BlockContentDecoratorContribution = () => decorate
