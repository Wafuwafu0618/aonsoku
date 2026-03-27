import { clsx } from 'clsx'
import {
  Pause,
  Play,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
} from 'lucide-react'
import { Fragment } from 'react/jsx-runtime'
import RepeatOne from '@/app/components/icons/repeat-one'
import { Button } from '@/app/components/ui/button'
import {
  usePlayerActions,
  usePlayerIsPlaying,
  usePlayerLoop,
  usePlayerPrevAndNext,
  usePlayerShuffle,
} from '@/store/player.store'
import { LoopState } from '@/types/playerContext'

export function FullscreenControls() {
  const isPlaying = usePlayerIsPlaying()
  const isShuffleActive = usePlayerShuffle()
  const loopState = usePlayerLoop()
  const { hasPrev, hasNext } = usePlayerPrevAndNext()
  const {
    isPlayingOneSong,
    toggleShuffle,
    playNextSong,
    playPrevSong,
    togglePlayPause,
    toggleLoop,
  } = usePlayerActions()

  return (
    <Fragment>
      <Button
        size="icon"
        variant="ghost"
        className={clsx(
          buttonsStyle.secondary,
          isShuffleActive && buttonsStyle.activeDot,
        )}
        style={{ ...buttonsStyle.style }}
        onClick={() => toggleShuffle()}
        disabled={isPlayingOneSong() || !hasNext}
      >
        <Shuffle
          className={clsx(
            buttonsStyle.secondaryIcon,
            'text-white',
          )}
        />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className={buttonsStyle.secondary}
        style={{ ...buttonsStyle.style }}
        onClick={() => playPrevSong()}
        disabled={!hasPrev}
      >
        <SkipBack className={buttonsStyle.secondaryIconFilled} />
      </Button>
      <Button
        size="icon"
        variant="default"
        className={buttonsStyle.main}
        style={{ ...buttonsStyle.style }}
        onClick={() => togglePlayPause()}
      >
        {isPlaying ? (
          <Pause className={buttonsStyle.mainIcon} strokeWidth={1} />
        ) : (
          <Play className={buttonsStyle.mainIcon} />
        )}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className={buttonsStyle.secondary}
        style={{ ...buttonsStyle.style }}
        onClick={() => playNextSong()}
        disabled={!hasNext && loopState !== LoopState.All}
      >
        <SkipForward className={buttonsStyle.secondaryIconFilled} />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className={clsx(
          buttonsStyle.secondary,
          loopState !== LoopState.Off && buttonsStyle.activeDot,
        )}
        onClick={() => toggleLoop()}
        style={{ ...buttonsStyle.style }}
      >
        {loopState === LoopState.Off && (
          <Repeat className={clsx(buttonsStyle.secondaryIcon, 'text-white')} />
        )}
        {loopState === LoopState.All && (
          <Repeat className={clsx(buttonsStyle.secondaryIcon, 'text-white')} />
        )}
        {loopState === LoopState.One && (
          <RepeatOne className={clsx(buttonsStyle.secondaryIcon, 'text-white')} />
        )}
      </Button>
    </Fragment>
  )
}

export const buttonsStyle = {
  main:
    'w-14 h-14 rounded-full p-0 hover:scale-105 transition-transform will-change-transform',
  mainIcon: 'w-6 h-6 text-primary-foreground fill-primary-foreground',
  secondary:
    'relative w-12 h-12 rounded-full p-0 text-white hover:text-white hover:scale-105 transition-transform will-change-transform',
  secondaryIcon: 'w-6 h-6 text-white',
  secondaryIconFilled: 'w-6 h-6 text-white fill-white',
  activeDot:
    "after:content-['•'] after:block after:absolute after:-bottom-1 after:text-white",
  style: {
    backfaceVisibility: 'hidden' as const,
  },
}
