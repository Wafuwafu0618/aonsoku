export const MEDIA_SOURCES = ['navidrome', 'spotify', 'local'] as const

export type MediaSource = (typeof MEDIA_SOURCES)[number]

export function isMediaSource(value: string): value is MediaSource {
  return MEDIA_SOURCES.includes(value as MediaSource)
}
