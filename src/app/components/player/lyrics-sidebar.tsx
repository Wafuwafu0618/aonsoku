import clsx from 'clsx'
import { XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LyricsTab } from '@/app/components/fullscreen/lyrics'
import { Button } from '@/app/components/ui/button'
import {
  useLyricsSidebarState,
  usePlayerMediaType,
  usePlayerSonglist,
} from '@/store/player.store'

export function PlayerLyricsSidebar() {
  const { t } = useTranslation()
  const { lyricsSidebarState, toggleLyricsSidebarAction } =
    useLyricsSidebarState()
  const { isSong } = usePlayerMediaType()
  const { currentList, currentSongIndex } = usePlayerSonglist()
  const currentSong = currentList[currentSongIndex]
  const isVisible = lyricsSidebarState && isSong && Boolean(currentSong)

  return (
    <aside
      className={clsx(
        'fixed top-header bottom-player right-0 z-30 hidden md:flex md:w-[28rem]',
        'border-l border-border bg-background transition-transform duration-300',
        isVisible ? 'translate-x-0' : 'translate-x-full pointer-events-none',
      )}
      data-testid="player-lyrics-sidebar"
      aria-hidden={!isVisible}
    >
      <div className="flex h-full w-full flex-col">
        <div className="flex h-12 min-h-12 items-center justify-between border-b border-border bg-background px-3">
          <p className="text-sm font-semibold">{t('fullscreen.lyrics')}</p>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full"
            onClick={toggleLyricsSidebarAction}
            aria-label="Close lyrics sidebar"
          >
            <XIcon className="h-4 w-4" />
          </Button>
        </div>
        <div className="h-[calc(100%-3rem)] bg-background p-3">
          <LyricsTab />
        </div>
      </div>
    </aside>
  )
}
