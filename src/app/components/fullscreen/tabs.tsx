import { ComponentPropsWithoutRef, memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CurrentSongInfo } from '@/app/components/queue/current-song-info'
import { QueueSongList } from '@/app/components/queue/song-list'
import { Tabs, TabsList, TabsTrigger } from '@/app/components/ui/tabs'
import { cn } from '@/lib/utils'
import { LyricsTab } from './lyrics'

const MemoCurrentSongInfo = memo(CurrentSongInfo)
const MemoQueueSongList = memo(QueueSongList)
const MemoLyricsTab = memo(LyricsTab)

enum TabsEnum {
  Queue = 'queue',
  Lyrics = 'lyrics',
}

type TabValue = TabsEnum

const triggerStyles =
  'w-full data-[state=active]:bg-foreground data-[state=active]:text-secondary text-foreground drop-shadow-sm'

export function FullscreenTabs() {
  const [tab, setTab] = useState<TabValue>(TabsEnum.Queue)
  const { t } = useTranslation()

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as TabValue)}
      className="w-full h-full min-h-full"
    >
      <div className="flex items-center justify-end mb-4">
        <TabsList className="w-[320px] bg-foreground/20">
          <TabsTrigger value={TabsEnum.Queue} className={triggerStyles}>
            {t('fullscreen.queue')}
          </TabsTrigger>
          <TabsTrigger value={TabsEnum.Lyrics} className={triggerStyles}>
            {t('fullscreen.lyrics')}
          </TabsTrigger>
        </TabsList>
      </div>

      <div className="flex w-full h-[calc(100%-64px)] mt-0 px-[6%] mb-0">
        <MemoCurrentSongInfo />

        <div className="flex flex-1 justify-center relative">
          <ActiveContent active={tab === TabsEnum.Queue}>
            <MemoQueueSongList />
          </ActiveContent>
          <ActiveContent active={tab === TabsEnum.Lyrics}>
            <MemoLyricsTab />
          </ActiveContent>
        </div>
      </div>
    </Tabs>
  )
}

type ActiveContentProps = ComponentPropsWithoutRef<'div'> & {
  active: boolean
}

function ActiveContent({
  active,
  children,
  className,
  ...props
}: ActiveContentProps) {
  return (
    <div
      className={cn(
        'w-full h-full absolute inset-0 opacity-0 pointer-events-none transition-opacity duration-300 bg-black/0',
        active && 'opacity-100 pointer-events-auto',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}
