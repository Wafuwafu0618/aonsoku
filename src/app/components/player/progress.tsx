import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ProgressSlider } from '@/app/components/ui/slider'
import { podcasts } from '@/service/podcasts'
import {
  usePlayerActions,
  usePlayerDuration,
  usePlayerMediaType,
  usePlayerProgress,
  usePlayerSonglist,
} from '@/store/player.store'
import { convertSecondsToTime } from '@/utils/convertSecondsToTime'
import { logger } from '@/utils/logger'

let isSeeking = false

export function PlayerProgress() {
  const progress = usePlayerProgress()
  const [localProgress, setLocalProgress] = useState(progress)
  const currentDuration = usePlayerDuration()
  const { currentList, podcastList, currentSongIndex } = usePlayerSonglist()
  const { isSong, isPodcast } = usePlayerMediaType()
  const { seekTo, setUpdatePodcastProgress, getCurrentPodcastProgress } =
    usePlayerActions()

  const isEmpty = isSong && currentList.length === 0

  const handleSeeking = useCallback((amount: number) => {
    isSeeking = true
    setLocalProgress(amount)
  }, [])

  const handleSeeked = useCallback(
    (amount: number) => {
      isSeeking = false
      seekTo(amount)
      setLocalProgress(amount)
    },
    [seekTo],
  )

  const handleSeekedFallback = useCallback(() => {
    if (localProgress !== progress) {
      isSeeking = false
      seekTo(localProgress)
    }
  }, [localProgress, progress, seekTo])

  const songDuration = useMemo(
    () => convertSecondsToTime(currentDuration ?? 0),
    [currentDuration],
  )

  // Used to save listening progress to backend every 30 seconds
  useEffect(() => {
    if (!isPodcast || !podcastList) return
    if (progress === 0) return

    const send = (progress / 30) % 1 === 0
    if (!send) return

    const podcast = podcastList[currentSongIndex] ?? null
    if (!podcast) return

    const podcastProgress = getCurrentPodcastProgress()
    if (progress === podcastProgress) return

    setUpdatePodcastProgress(progress)

    podcasts
      .saveEpisodeProgress(podcast.id, progress)
      .then(() => {
        logger.info('Progress sent:', progress)
      })
      .catch((error) => {
        logger.error('Error sending progress', error)
      })
  }, [
    currentSongIndex,
    getCurrentPodcastProgress,
    isPodcast,
    podcastList,
    progress,
    setUpdatePodcastProgress,
  ])

  const currentTime = convertSecondsToTime(isSeeking ? localProgress : progress)

  const isProgressLarge = useMemo(() => {
    return localProgress >= 3600 || progress >= 3600
  }, [localProgress, progress])

  const isDurationLarge = useMemo(() => {
    return currentDuration >= 3600
  }, [currentDuration])

  return (
    <div
      className={clsx(
        'flex w-full justify-center items-center gap-2',
        isEmpty && 'opacity-50',
      )}
    >
      <small
        className={clsx(
          'text-xs text-muted-foreground text-right',
          isProgressLarge ? 'min-w-14' : 'min-w-10',
        )}
        data-testid="player-current-time"
      >
        {currentTime}
      </small>
      {!isEmpty || isPodcast ? (
        <ProgressSlider
          defaultValue={[0]}
          value={isSeeking ? [localProgress] : [progress]}
          tooltipTransformer={convertSecondsToTime}
          max={currentDuration}
          step={1}
          className="cursor-pointer w-[32rem]"
          onValueChange={([value]) => handleSeeking(value)}
          onValueCommit={([value]) => handleSeeked(value)}
          // Sometimes onValueCommit doesn't work properly
          // so we also have to set the value on pointer/mouse up events
          // see https://github.com/radix-ui/primitives/issues/1760
          onPointerUp={handleSeekedFallback}
          onMouseUp={handleSeekedFallback}
          data-testid="player-progress-slider"
        />
      ) : (
        <ProgressSlider
          defaultValue={[0]}
          max={100}
          step={1}
          disabled={true}
          className="cursor-pointer w-[32rem] pointer-events-none"
        />
      )}
      <small
        className={clsx(
          'text-xs text-muted-foreground text-left',
          isDurationLarge ? 'min-w-14' : 'min-w-10',
        )}
        data-testid="player-duration-time"
      >
        {songDuration}
      </small>
    </div>
  )
}
