/** Pure color ladder for type-tag chips: configured color > hashed
 *  default > (unregistered) none. Kept out of the component so the
 *  ladder is testable without a DOM — jsdom's CSS parser rejects
 *  `color-mix`, so asserting on rendered inline styles can't cover it.
 *  The palette itself lives in `@/data/typeColors` (shared with the
 *  creation-time least-used stamp in `createTypeBlock`). */

import type { TypeContribution } from '@/data/api'
import { defaultTypeColor } from '@/data/typeColors'

/** Contribution-declared chip color, validated so an unparseable value
 *  degrades to default styling instead of a half-styled chip. (Inline
 *  styles assign via CSSOM, so invalid values can't inject — this is
 *  purely a rendering-quality guard.) */
const configuredChipColor = (type: TypeContribution): string | undefined => {
  const color = type.color?.trim()
  if (!color) return undefined
  if (typeof CSS !== 'undefined' && CSS.supports && !CSS.supports('color', color)) return undefined
  return color
}

interface ChipStyle {
  color: string
  backgroundColor: string
}

/** Every REGISTERED type gets a color: the configured one verbatim, or
 *  the hash-fallback palette entry. The default's text mixes the base
 *  toward the theme foreground, so one formula yields a dark readable
 *  tone on light themes and a light one on dark themes — no
 *  dark-variant branch. Unregistered ids return undefined and keep the
 *  muted-gray fallback: the missing color is a SIGNAL (definition not
 *  synced / plugin disabled), not a styling gap. */
export const chipStyle = (
  type: TypeContribution | undefined,
): ChipStyle | undefined => {
  if (!type) return undefined
  const configured = configuredChipColor(type)
  if (configured) {
    return {
      color: configured,
      backgroundColor: `color-mix(in srgb, ${configured} 14%, transparent)`,
    }
  }
  const base = defaultTypeColor(type.id)
  return {
    color: `color-mix(in oklch, ${base} 72%, hsl(var(--foreground)))`,
    backgroundColor: `color-mix(in srgb, ${base} 14%, transparent)`,
  }
}
