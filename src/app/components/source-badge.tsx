import { MediaSource } from '@/domain/media-source'
import { cn } from '@/lib/utils'
import { getSourceStyle } from '@/store/queue-adapter'

interface SourceBadgeProps {
  source: MediaSource
  className?: string
  showLabel?: boolean
}

/**
 * Sourceバッジコンポーネント
 * 音源のソース（Navidrome/Spotify/Local）を視覚的に表示
 */
export function SourceBadge({
  source,
  className,
  showLabel = true,
}: SourceBadgeProps) {
  const style = getSourceStyle(source)

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium',
        className,
      )}
      style={{
        backgroundColor: style.bgColor,
        color: style.color,
      }}
    >
      <span
        className="w-2 h-2 rounded-full"
        style={{ backgroundColor: style.color }}
      />
      {showLabel && <span>{style.label}</span>}
    </span>
  )
}

/**
 * ミニマル版Sourceバッジ（ドットのみ）
 */
export function SourceBadgeDot({
  source,
  className,
}: Omit<SourceBadgeProps, 'showLabel'>) {
  const style = getSourceStyle(source)

  return (
    <span
      className={cn('inline-block w-2 h-2 rounded-full', className)}
      style={{ backgroundColor: style.color }}
      title={style.label}
    />
  )
}
