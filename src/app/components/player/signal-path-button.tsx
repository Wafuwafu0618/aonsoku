import clsx from 'clsx'
import { Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/app/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/app/components/ui/popover'
import { SimpleTooltip } from '@/app/components/ui/simple-tooltip'
import { cn } from '@/lib/utils'
import { useOversamplingState, usePlaybackQueueState } from '@/store/player.store'
import { buildSignalPath, SignalPathQuality } from './signal-path'

interface PlayerSignalPathButtonProps {
  disabled: boolean
}

const qualityClassNames: Record<SignalPathQuality, string> = {
  lossless: 'text-emerald-500',
  enhanced: 'text-indigo-500',
  lossy: 'text-amber-500',
  warning: 'text-red-500',
}

function hasNativeAudioApi(): boolean {
  if (typeof window === 'undefined') return false

  const api = (
    window as Window & { api?: { nativeAudioInitialize?: unknown } }
  ).api
  return typeof api?.nativeAudioInitialize === 'function'
}

export function PlayerSignalPathButton({
  disabled,
}: PlayerSignalPathButtonProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const { currentQueueItem } = usePlaybackQueueState()
  const oversamplingState = useOversamplingState()
  const signalPath = useMemo(
    () =>
      buildSignalPath({
        currentQueueItem,
        oversampling: oversamplingState,
        nativeAudioApiAvailable: hasNativeAudioApi(),
      }),
    [currentQueueItem, oversamplingState],
  )
  const qualityLabel = t(`player.signalPath.quality.${signalPath.quality}`)

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <div>
          <SimpleTooltip text={t('player.tooltips.signalPath')}>
            <Button
              variant="ghost"
              className={clsx(
                'rounded-full size-10 p-0 text-secondary-foreground relative',
                isOpen && 'player-button-active',
              )}
              disabled={disabled}
              data-testid="player-button-signal-path"
            >
              <Sparkles className={clsx('size-4', isOpen && 'text-primary')} />
            </Button>
          </SimpleTooltip>
        </div>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="center"
        className={cn('w-[min(92vw,380px)] p-4 !pointer-events-auto')}
        data-testid="player-signal-path-popover"
      >
        <div className="flex flex-col gap-1">
          <h3
            className={clsx(
              'font-semibold text-base',
              qualityClassNames[signalPath.quality],
            )}
            data-testid="player-signal-path-quality"
          >
            {t('player.signalPath.title', { quality: qualityLabel })}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t('player.signalPath.subtitle')}
          </p>
        </div>

        <ol className="mt-4 space-y-2">
          {signalPath.stages.map((stage, index) => (
            <li
              key={stage.id}
              className="grid grid-cols-[16px_1fr] gap-3"
              data-testid={`player-signal-stage-${stage.id}`}
            >
              <div className="flex flex-col items-center">
                <span className="size-2 rounded-full bg-primary mt-1 shadow-[0_0_0_3px_rgba(99,102,241,0.15)]" />
                {index < signalPath.stages.length - 1 && (
                  <span className="mt-1 w-px flex-1 min-h-6 bg-border" />
                )}
              </div>
              <div className="pb-2">
                <p className="text-sm font-medium leading-snug">
                  {t(stage.titleKey)}
                </p>
                <p className="text-sm text-primary leading-snug">
                  <span data-testid={`player-signal-stage-${stage.id}-value`}>
                    {stage.description}
                  </span>
                </p>
              </div>
            </li>
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  )
}
