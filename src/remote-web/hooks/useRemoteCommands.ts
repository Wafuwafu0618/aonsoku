import { useCallback } from 'react'
import type { RemoteCommand, RemotePlaybackTarget } from '../lib/remoteApi'
import * as remoteApi from '../lib/remoteApi'

export function useRemoteCommands(leaseId: string | undefined) {
  const sendCommand = useCallback(
    async (command: RemoteCommand) => {
      if (!leaseId) {
        throw new Error('セッションが確立されていません')
      }

      await remoteApi.sendCommand(leaseId, command)
    },
    [leaseId],
  )

  const playPause = useCallback(() => {
    return sendCommand({ type: 'playPause' })
  }, [sendCommand])

  const prev = useCallback(() => {
    return sendCommand({ type: 'prev' })
  }, [sendCommand])

  const next = useCallback(() => {
    return sendCommand({ type: 'next' })
  }, [sendCommand])

  const seek = useCallback(
    (positionSeconds: number) => {
      return sendCommand({ type: 'seek', value: positionSeconds })
    },
    [sendCommand],
  )

  const setVolume = useCallback(
    (volume: number) => {
      return sendCommand({ type: 'setVolume', value: volume })
    },
    [sendCommand],
  )

  const playAlbum = useCallback(
    (albumId: string) => {
      return sendCommand({ type: 'playAlbum', albumId })
    },
    [sendCommand],
  )

  const playSong = useCallback(
    (albumId: string, songId: string) => {
      return sendCommand({ type: 'playSong', albumId, songId })
    },
    [sendCommand],
  )

  const setPlaybackTarget = useCallback(
    (target: RemotePlaybackTarget) => {
      return sendCommand({ type: 'setPlaybackTarget', target })
    },
    [sendCommand],
  )

  return {
    sendCommand,
    playPause,
    prev,
    next,
    seek,
    setVolume,
    playAlbum,
    playSong,
    setPlaybackTarget,
  }
}
