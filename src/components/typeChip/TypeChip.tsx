/** The one visual for a type tag chip — the supertags block chip row
 *  and the property panel's selected-types chips render this same
 *  component, so colors, truncation, and the remove affordance can't
 *  drift apart. POLICY stays with the caller: which chips get a
 *  remove ✕ (the block row withholds it from plumbing types), which
 *  labels link to a definition block, and whether the label carries
 *  the `#` sigil. */

import { X } from 'lucide-react'
import type { MouseEvent } from 'react'
import { cn } from '@/lib/utils'
import type { TypeContribution } from '@/data/api'
import { chipStyle } from './chipStyle'

export interface TypeChipProps {
  typeId: string
  /** Registry contribution; undefined renders the muted-gray
   *  "not registered" look (chipStyle's signal, never a styling gap). */
  type: TypeContribution | undefined
  /** Render the label as a real link (block chips → the type's
   *  definition block; a real href keeps cmd/middle-click native). */
  link?: {
    href: string
    onClick: (event: MouseEvent<HTMLAnchorElement>) => void
  }
  /** Presence renders the remove ✕ — removability policy is the
   *  caller's, not the chip's. */
  onRemove?: () => void
  /** Prefix the label with the `#` sigil (the block chip row does;
   *  the property panel shows bare labels). */
  withHash?: boolean
}

/** Unknown id (type not registered — other device's type not yet
 *  synced, plugin disabled, or a deleted definition block): show a
 *  shortened id, never a full uuid. */
const displayLabel = (type: TypeContribution | undefined, typeId: string): string =>
  type?.label ?? (typeId.length > 8 ? `${typeId.slice(0, 8)}…` : typeId)

export const TypeChip = ({typeId, type, link, onRemove, withHash}: TypeChipProps) => {
  const label = displayLabel(type, typeId)
  const style = chipStyle(type)
  const labelText = withHash ? `#${label}` : label
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-xs',
        style ? '' : 'bg-muted text-muted-foreground',
      )}
      style={style}
      title={type ? type.description ?? typeId : `Unknown type ${typeId} (not registered)`}
    >
      {link ? (
        <a
          href={link.href}
          className="truncate text-inherit no-underline hover:underline"
          // An <a> is draggable by default; a press-drag on the chip
          // should read as a missed click, not start a native link
          // drag.
          draggable={false}
          onClick={link.onClick}
        >
          {labelText}
        </a>
      ) : (
        <span className="truncate">{labelText}</span>
      )}
      {onRemove && (
        <button
          type="button"
          className={cn(
            // Padding + negative margin: a larger hit area with the
            // chip's visual footprint unchanged. Capped at p-1 so the
            // reach doesn't cross the 4px gap into the label's
            // trailing characters — a missed tap must fall through to
            // the surface underneath, not remove the type.
            'rounded-sm p-1 -m-1 hover:bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            style ? 'text-inherit opacity-70 hover:opacity-100' : 'text-muted-foreground hover:text-foreground',
          )}
          aria-label={`Remove ${label} type`}
          onMouseDown={event => event.preventDefault()}
          onClick={event => {
            // Must not double as a click on the surface underneath.
            // In the block row, `button` in interactiveContentSelector
            // is the primary click-to-edit guard; stopPropagation is
            // defense-in-depth for any other bubbled-click listener.
            event.stopPropagation()
            onRemove()
          }}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}
