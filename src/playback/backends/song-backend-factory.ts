import { PlaybackBackendId } from '@/domain/playback-backend'
import { NativeAudioOutputMode } from '@/platform/contracts/desktop-contract'
import { PlaybackBackend } from '@/playback/backend'
import { AppleMusicPlaybackBackend } from './apple-music-backend'
import { InternalPlaybackBackend } from './internal-backend'
import { NativePlaybackBackend } from './native-backend'
import { SpotifyConnectPlaybackBackend } from './spotify-connect-backend'

export interface SongPlaybackBackendFactoryInput {
  audio: HTMLAudioElement
  backendId: PlaybackBackendId
  outputMode: NativeAudioOutputMode
}

export function createSongPlaybackBackend({
  audio,
  backendId,
  outputMode,
}: SongPlaybackBackendFactoryInput): PlaybackBackend {
  if (backendId === 'apple-music') {
    return new AppleMusicPlaybackBackend({ outputMode })
  }

  if (backendId === 'spotify-connect') {
    return new SpotifyConnectPlaybackBackend()
  }

  if (backendId === 'native') {
    return new NativePlaybackBackend({ outputMode })
  }

  return new InternalPlaybackBackend(audio)
}
