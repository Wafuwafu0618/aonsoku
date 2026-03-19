import { NativeAudioOutputMode } from '@/platform/contracts/desktop-contract'
import { PlaybackBackend } from '@/playback/backend'
import { InternalPlaybackBackend } from './internal-backend'
import { NativePlaybackBackend } from './native-backend'

export interface SongPlaybackBackendFactoryInput {
  audio: HTMLAudioElement
  useNativeBackend: boolean
  outputMode: NativeAudioOutputMode
}

export function createSongPlaybackBackend({
  audio,
  useNativeBackend,
  outputMode,
}: SongPlaybackBackendFactoryInput): PlaybackBackend {
  if (useNativeBackend) {
    return new NativePlaybackBackend({ outputMode })
  }

  return new InternalPlaybackBackend(audio)
}
