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
import { useProperty } from '@/hooks/block.js'
import { useTypes } from '@/hooks/typeRegistry.js'
import {
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { visibleTagTypeIds } from './typeAutocomplete'

/** Contribution-declared chip color, validated so an unparseable value
 *  degrades to default styling instead of a half-styled chip. (Inline
 *  styles assign via CSSOM, so invalid values can't inject — this is
 *  purely a rendering-quality guard.) */
const chipColor = (type: TypeContribution | undefined): string | undefined => {
  const color = type?.color?.trim()
  if (!color) return undefined
  if (typeof CSS !== 'undefined' && CSS.supports && !CSS.supports('color', color)) return undefined
  return color
}

const TypeChips = ({block, typeIds, registry}: {
  block: Block
  typeIds: readonly string[]
  registry: ReadonlyMap<string, TypeContribution>
}) => {
  const readOnly = block.repo.isReadOnly
  return (
    <span className="flex shrink-0 flex-wrap items-center gap-1" aria-label="Block types">
      {typeIds.map(typeId => {
        const type = registry.get(typeId)
        // Unknown id (type not registered — other device's type not yet
        // synced, plugin disabled, or a deleted definition block): keep
        // the chip visible per the never-silently-disappear policy, but
        // don't print a full uuid — shorten it and say what it is.
        const label = type?.label ?? (typeId.length > 8 ? `${typeId.slice(0, 8)}…` : typeId)
        const color = chipColor(type)
        return (
          <span
            key={typeId}
            className={cn(
              'inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-xs',
              color ? '' : 'bg-muted text-muted-foreground',
            )}
            style={color ? {
              color,
              backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
            } : undefined}
            title={type ? type.description ?? typeId : `Unknown type ${typeId} (not registered)`}
          >
            <span className="truncate">#{label}</span>
            {!readOnly && (
              <button
                type="button"
                className={cn(
                  // Padding + negative margin: a finger-sized hit area
                  // without growing the chip visually. A missed tap
                  // would otherwise land on the content surface and
                  // flip the block into edit mode.
                  'rounded-sm p-1.5 -m-1.5 hover:bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  color ? 'text-inherit opacity-70 hover:opacity-100' : 'text-muted-foreground hover:text-foreground',
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

const TypeChipsDecorator = ({block, Inner}: TypeChipsDecoratorProps) => {
  const [types] = useProperty(block, typesProp)
  const registry = useTypes()
  const visible = visibleTagTypeIds(types, registry)
  return (
    <div className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <div className="min-w-0 max-w-full flex-1 basis-48">
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
