export const PLAYBACK_BACKEND_IDS = [
  'internal',
  'native',
  'spotify-connect',
  'hqplayer',
  'exclusive',
  'apple-music',
] as const

export type PlaybackBackendId = (typeof PLAYBACK_BACKEND_IDS)[number]

export function isPlaybackBackendId(
  value: string,
): value is PlaybackBackendId {
  return PLAYBACK_BACKEND_IDS.includes(value as PlaybackBackendId)
}
