import { describe, expect, it } from 'vitest'
import {
  GENERIC_MIME,
  MEDIA_TYPE,
  MEDIA_TYPE_CONTRIBUTION,
  isAudioMime,
  isImageMime,
  mediaHashProp,
  resolveCaptureMime,
  sniffImageMime,
} from './mediaBlock.js'

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])

describe('isImageMime', () => {
  it('is true only for image/* MIME types', () => {
    expect(isImageMime('image/png')).toBe(true)
    expect(isImageMime('image/jpeg')).toBe(true)
    expect(isImageMime('image/svg+xml')).toBe(true)
  })

  it('is false for non-image and malformed/absent types', () => {
    expect(isImageMime('application/pdf')).toBe(false)
    expect(isImageMime('text/plain')).toBe(false)
    expect(isImageMime('image')).toBe(false) // no slash — not a real image type
    expect(isImageMime('')).toBe(false)
    expect(isImageMime(undefined)).toBe(false)
  })

  it('is case-insensitive (MIME types are, even if File.type is lowercased)', () => {
    expect(isImageMime('IMAGE/PNG')).toBe(true)
    expect(isImageMime('Image/Gif')).toBe(true)
  })
})

describe('isAudioMime', () => {
  it('is true only for audio/* MIME types', () => {
    expect(isAudioMime('audio/mpeg')).toBe(true)
    expect(isAudioMime('audio/ogg')).toBe(true)
    expect(isAudioMime('audio/wav')).toBe(true)
  })

  it('is false for non-audio and malformed/absent types', () => {
    expect(isAudioMime('image/png')).toBe(false)
    expect(isAudioMime('video/mp4')).toBe(false) // sibling family, not audio
    expect(isAudioMime('audio')).toBe(false) // no slash — not a real audio type
    expect(isAudioMime('')).toBe(false)
    expect(isAudioMime(undefined)).toBe(false)
  })

  it('is case-insensitive (MIME types are, even if File.type is lowercased)', () => {
    expect(isAudioMime('AUDIO/MPEG')).toBe(true)
    expect(isAudioMime('Audio/Ogg')).toBe(true)
  })
})

describe('sniffImageMime', () => {
  it('recognizes common raster image magic, null otherwise', () => {
    expect(sniffImageMime(png())).toBe('image/png')
    expect(sniffImageMime(jpeg())).toBe('image/jpeg')
    expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
    expect(sniffImageMime(new Uint8Array([0x42, 0x4d, 0, 0]))).toBe('image/bmp')
    expect(sniffImageMime(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull() // %PDF
    expect(sniffImageMime(new Uint8Array([0x89]))).toBeNull() // too short
  })
})

describe('resolveCaptureMime', () => {
  it('derives image MIME from bytes when File.type is missing or generic (the dedup fix)', () => {
    // The core Codex P2 case: a typeless/octet-stream image must still store image/* so
    // it renders inline AND every dedup'd embed of the same bytes agrees.
    expect(resolveCaptureMime(undefined, png())).toBe('image/png')
    expect(resolveCaptureMime('', png())).toBe('image/png')
    expect(resolveCaptureMime(GENERIC_MIME, png())).toBe('image/png')
  })

  it('the bytes WIN over a mislabeled declared type for a recognizable image', () => {
    expect(resolveCaptureMime('application/pdf', jpeg())).toBe('image/jpeg')
  })

  it('trusts a specific declared type when the bytes are not a recognizable image', () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    expect(resolveCaptureMime('application/pdf', pdf)).toBe('application/pdf')
    expect(resolveCaptureMime(undefined, pdf)).toBe(GENERIC_MIME)
  })
})

describe('media type contribution', () => {
  it('lifts the render-critical hash field onto the media type (so addType materialises it)', () => {
    // The resolver can't address bytes without media:hash, so it must be a
    // property of the type — not merely set ad-hoc by capture.
    expect(MEDIA_TYPE_CONTRIBUTION.id).toBe(MEDIA_TYPE)
    expect(MEDIA_TYPE_CONTRIBUTION.properties).toContain(mediaHashProp)
  })
})
