/** The default color palette for types (rendered by the supertags
 *  chip row, stamped onto new type-definition blocks by
 *  `createTypeBlock`). Data-layer because both the block-creation path
 *  and display plugins need it, and cross-plugin imports are worse
 *  than a shared kernel module.
 *
 *  A curated wheel, NOT a raw hash-to-hue: oklch hue degrees are far
 *  from perceptually even (the pink–violet stretch alone spans ~90°),
 *  so uniformly-random hues routinely land two types in colors a
 *  reader can't tell apart. Hand-spaced hues with alternating
 *  chroma/lightness keep even wheel-adjacent entries distinguishable
 *  at chip size. */

import type { TypeContribution } from '@/data/api'

export const DEFAULT_TYPE_COLORS: readonly string[] = [
  'oklch(0.62 0.21 25)',   // red
  'oklch(0.70 0.17 55)',   // orange
  'oklch(0.76 0.15 90)',   // amber
  'oklch(0.72 0.19 130)',  // lime
  'oklch(0.60 0.15 155)',  // green
  'oklch(0.72 0.13 185)',  // teal
  'oklch(0.64 0.14 220)',  // sky
  'oklch(0.58 0.20 262)',  // blue
  'oklch(0.66 0.20 292)',  // violet
  'oklch(0.58 0.22 315)',  // purple
  'oklch(0.68 0.24 340)',  // magenta
  'oklch(0.62 0.20 5)',    // pink-red
]

/** Deterministic palette entry for a type with NO persisted color —
 *  FNV-1a of the id. Hashing the ID (not the label) keeps the color
 *  stable across renames and identical across devices (ids sync; a
 *  fresh random draw per device/session would flicker and diverge).
 *  Pure functions of the id collide (birthday problem), which is why
 *  type CREATION persists a least-used pick instead — this is the
 *  fallback for code-contributed and imported types. */
export const defaultTypeColor = (typeId: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < typeId.length; i++) {
    hash ^= typeId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return DEFAULT_TYPE_COLORS[(hash >>> 0) % DEFAULT_TYPE_COLORS.length]
}

/** The palette entry currently carried by the fewest visible types —
 *  what `createTypeBlock` stamps onto a new type so fresh types spread
 *  across the wheel instead of colliding like a pure hash would.
 *  Counts each chip-visible type's EFFECTIVE color: its configured
 *  color when that is a palette entry, its hash fallback otherwise
 *  (off-palette custom colors don't occupy a bucket; chip-hidden types
 *  never show a color at all). Deterministic: ties break in palette
 *  order. */
export const pickLeastUsedTypeColor = (
  types: Iterable<TypeContribution>,
): string => {
  const counts = new Map<string, number>(DEFAULT_TYPE_COLORS.map(color => [color, 0]))
  for (const type of types) {
    if (type.hideFromBlockDisplay === true) continue
    const effective = type.color?.trim() || defaultTypeColor(type.id)
    const count = counts.get(effective)
    if (count !== undefined) counts.set(effective, count + 1)
  }
  let best = DEFAULT_TYPE_COLORS[0]
  let bestCount = Infinity
  for (const color of DEFAULT_TYPE_COLORS) {
    const count = counts.get(color)!
    if (count < bestCount) {
      best = color
      bestCount = count
    }
  }
  return best
}
