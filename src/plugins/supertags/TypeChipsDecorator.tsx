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
 *  chip visibility driven by the registry (`hideTag` edits, late type
 *  publication) re-renders in place instead of re-resolving decorator
 *  gates, and if the renderer's slot identity is ever stabilized the
 *  no-remount invariant holds here without changes. The WeakMap cache
 *  keeps identity stable across parent re-renders (same invariant as
 *  CharacterCountDecorator). */

import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TypeContribution } from '@/data/api'
import type { Block } from '@/data/block.js'
import { typesProp } from '@/data/properties'
import { useProperty, useWorkspaceId } from '@/hooks/block.js'
import { useTypes } from '@/hooks/typeRegistry.js'
import { useBlockOpener } from '@/utils/navigation'
import { buildAppHash } from '@/utils/routing'
import {
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { chipStyle } from './chipStyle'
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
    <span className="flex min-w-0 flex-wrap items-center gap-1" aria-label="Block types">
      {typeIds.map(typeId => {
        const type = registry.get(typeId)
        // Unknown id (type not registered — other device's type not yet
        // synced, plugin disabled, or a deleted definition block): keep
        // the chip visible per the never-silently-disappear policy, but
        // don't print a full uuid — shorten it and say what it is.
        const label = type?.label ?? (typeId.length > 8 ? `${typeId.slice(0, 8)}…` : typeId)
        const style = chipStyle(type, typeId)
        // A user-defined type's definition block IS its id's source —
        // link the chip there. Kernel/plugin types have no backing
        // block (their config lives in code), so their chips stay
        // plain text.
        const definitionId = repo.userTypes.getTypeBlockId(typeId)
        const labelText = `#${label}`
        return (
          <span
            key={typeId}
            className={cn(
              'inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-xs',
              style ? '' : 'bg-muted text-muted-foreground',
            )}
            style={style}
            title={type ? type.description ?? typeId : `Unknown type ${typeId} (not registered)`}
          >
            {definitionId ? (
              <a
                href={buildAppHash(workspaceId, definitionId)}
                className="truncate text-inherit no-underline hover:underline"
                // An <a> is draggable by default; a press-drag on the
                // chip should read as a missed click, not start a
                // native link drag.
                draggable={false}
                onClick={event => openBlock(event, {blockId: definitionId, workspaceId})}
              >
                {labelText}
              </a>
            ) : (
              <span className="truncate">{labelText}</span>
            )}
            {!readOnly && (
              <button
                type="button"
                className={cn(
                  // Padding + negative margin: a larger hit area with
                  // the chip's visual footprint unchanged. Capped at
                  // p-1 so the reach doesn't cross the 4px gap into
                  // the label's trailing characters — a missed tap
                  // must fall through as edit intent, not remove the
                  // type.
                  'rounded-sm p-1 -m-1 hover:bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  style ? 'text-inherit opacity-70 hover:opacity-100' : 'text-muted-foreground hover:text-foreground',
                )}
                aria-label={`Remove ${label} type`}
                onMouseDown={event => event.preventDefault()}
                onClick={event => {
                  // Removing a tag must not double as "activate the
                  // block's editor" — the content surface underneath
                  // treats bubbled clicks as edit intents.
                  event.stopPropagation()
                  void block.removeType(typeId)
                }}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
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
          of the text, with a 2rem floor as the caret's landing strip. */}
      <div className={visible.length > 0 ? 'min-w-8 max-w-full' : 'w-full'}>
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
