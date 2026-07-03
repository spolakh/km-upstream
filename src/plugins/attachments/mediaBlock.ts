/**
 * The `media` block type + its property schemas (design §3 / §11).
 *
 * An attachment IS a block (§3): a `media`-typed block holds the metadata for one
 * content-addressed object, and is embedded everywhere via `!((id))`. The bytes
 * live out-of-band in Storage (§10) + the local OPFS byte store (§8); this block
 * carries only the small metadata the resolver (§7.3) and renderer (§11) need.
 *
 * `media:hash` is THE load-bearing field — it is the `sha256:<hex>` content hash
 * (§5.1) the resolver verifies fetched bytes against and derives the object path
 * from (§10). `mime` drives the renderer's branch; `size`/`filename` are
 * cosmetic. (Capture — Phase 5 — populates them; this phase only defines + renders.)
 */

import { ChangeScope, codecs, defineBlockType, defineProperty } from '@/data/api'
import type { PropertySchema, TypeContribution } from '@/data/api'

export const MEDIA_TYPE = 'media'

/** The `sha256:<hex>` content hash (§5.1). The resolver verifies fetched bytes
 *  against it and derives the §10 object path from it — render-critical, never
 *  cosmetic. Empty default = "no hash yet" → the renderer fails closed. */
export const mediaHashProp = defineProperty<string>('media:hash', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** The object's MIME type — drives the renderer branch (image / file). Defaults
 *  to the bytes' on-the-wire type; the real value is set at capture (§11). */
export const mediaMimeProp = defineProperty<string>('media:mime', {
  codec: codecs.string,
  defaultValue: 'application/octet-stream',
  changeScope: ChangeScope.BlockDefault,
})

/** Plaintext byte length (cosmetic — for the file chip / pending UI). */
export const mediaSizeProp = defineProperty<number>('media:size', {
  codec: codecs.number,
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

/** Original filename, when captured from a file (cosmetic; cross-device LWW). */
export const mediaFilenameProp = defineProperty<string | undefined>('media:filename', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const MEDIA_PROPERTY_SCHEMAS: ReadonlyArray<PropertySchema<unknown>> = [
  mediaHashProp,
  mediaMimeProp,
  mediaSizeProp,
  mediaFilenameProp,
]

export const MEDIA_TYPE_CONTRIBUTION: TypeContribution = defineBlockType({
  id: MEDIA_TYPE,
  label: 'Media',
  description: 'An image or file attachment, stored content-addressed and embedded via !((id)).',
  // Lift the media:* fields so addType('media') materialises their defaults and
  // the property panel surfaces them.
  properties: [...MEDIA_PROPERTY_SCHEMAS],
})

/** Does a MIME type render as an inline image (§11 image branch)? Case-insensitive
 *  — MIME types are case-insensitive (RFC 2045) even though `File.type` is lowercase. */
export const isImageMime = (mime: string | undefined): boolean =>
  typeof mime === 'string' && mime.toLowerCase().startsWith('image/')

/** Does a MIME type render through the inline `<audio>` player (§11 audio branch)?
 *  Case-insensitive, like {@link isImageMime}. */
export const isAudioMime = (mime: string | undefined): boolean =>
  typeof mime === 'string' && mime.toLowerCase().startsWith('audio/')

/** The fallback MIME for a file with no declared type. */
export const GENERIC_MIME = 'application/octet-stream'

/** Sniff a common raster image MIME from the leading magic bytes. Returns `null`
 *  for anything unrecognized (incl. a too-short buffer). */
export const sniffImageMime = (b: Uint8Array): string | null => {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // "WEBP"
  ) return 'image/webp'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp' // "BM"
  return null
}

/** The MIME to STORE for a captured file. `File.type` is unreliable — a pasted or
 *  dropped image often arrives with an empty, generic (`octet-stream`), or even wrong
 *  type, and because captures are content-addressed + DEDUP'd, the FIRST capture's
 *  MIME sticks for every later embed of the same bytes. So the BYTES are authoritative:
 *  if they're a recognizable image, store that (the stored MIME is then a function of
 *  the bytes, like the content key — a typeless/mislabeled image still renders inline,
 *  and no re-paste can disagree with the dedup'd row). Otherwise trust a specific
 *  declared type, else fall back to generic. A false-positive sniff is harmless — the
 *  renderer's hash-verified `<img>` falls to the placeholder on a decode failure. */
export const resolveCaptureMime = (declared: string | undefined, bytes: Uint8Array): string => {
  const sniffed = sniffImageMime(bytes)
  if (sniffed) return sniffed
  const d = declared?.trim()
  return d && d.toLowerCase() !== GENERIC_MIME ? d : GENERIC_MIME
}

// ──── The workspace-level ASSETS container (§11) ────
//
// Captured media blocks are dedup'd by content (one block per content-key), so an
// asset is SHARED across every note that embeds it. Parenting it under the pasting
// note would let that note's subtree soft-delete cascade-tombstone the shared
// asset and break other embeds (§11). Instead every asset block is anchored under
// one flat per-workspace ASSETS container (a kernel page), and notes carry only
// the `!((id))` embed. The container is a normal navigable page tagged `assets`,
// so an asset browser can list it via `subscribeBlocks({ types: [ASSETS_TYPE] })`.

export const ASSETS_TYPE = 'assets'
/** uuid-v5 namespace for the per-workspace assets container; its id is
 *  `uuidv5(workspaceId, ASSETS_NS)` (see {@link kernelPageBlockId}). */
export const ASSETS_NS = 'b6e4d9a1-2f47-4c3e-9a0d-7c1e8f5b2a36'
export const ASSETS_ALIAS = 'Assets'

export const ASSETS_TYPE_CONTRIBUTION: TypeContribution = defineBlockType({
  id: ASSETS_TYPE,
  label: 'Assets',
  description: 'The workspace-level container that holds content-addressed media attachment blocks.',
})
