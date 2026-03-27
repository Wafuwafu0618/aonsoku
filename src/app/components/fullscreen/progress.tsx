import { useCallback, useState } from 'react'
import { ProgressSlider } from '@/app/components/ui/slider'
import {
  usePlayerActions,
  usePlayerDuration,
  usePlayerProgress,
} from '@/store/player.store'
import { convertSecondsToTime } from '@/utils/convertSecondsToTime'

let isSeeking = false

export function FullscreenProgress() {
  const progress = usePlayerProgress()
  const [localProgress, setLocalProgress] = useState(progress)
  const currentDuration = usePlayerDuration()
  const { seekTo } = usePlayerActions()

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

  const currentTime = convertSecondsToTime(isSeeking ? localProgress : progress)

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-[50px] max-w-[60px] text-right text-xs text-muted-foreground">
        {currentTime}
      </div>

      <ProgressSlider
        variant="default"
        defaultValue={[0]}
        value={isSeeking ? [localProgress] : [progress]}
        tooltipTransformer={convertSecondsToTime}
        max={currentDuration}
        step={1}
        className="w-full h-4"
        onValueChange={([value]) => handleSeeking(value)}
        onValueCommit={([value]) => handleSeeked(value)}
        onPointerUp={handleSeekedFallback}
        onMouseUp={handleSeekedFallback}
      />

      <div className="min-w-[50px] max-w-[60px] text-left text-xs text-muted-foreground">
        {convertSecondsToTime(currentDuration ?? 0)}
      </div>
    </div>
  )
}
