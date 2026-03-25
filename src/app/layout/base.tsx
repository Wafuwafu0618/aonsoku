import { memo } from 'react'
import { MainDrawerPage } from '@/app/components/drawer/page'
import { FullscreenMode } from '@/app/components/fullscreen/page'
import { Player } from '@/app/components/player/player'
import { CreatePlaylistDialog } from '@/app/components/playlist/form-dialog'
import { RemovePlaylistDialog } from '@/app/components/playlist/remove-dialog'
import { AppSidebar } from '@/app/components/sidebar/app-sidebar'
import { SongInfoDialog } from '@/app/components/song/info-dialog'
import {
  MainSidebarInset,
  MainSidebarProvider,
} from '@/app/components/ui/main-sidebar'
import { useBackgroundImageSource } from '@/app/hooks/use-background-image-source'
import { Header } from '@/app/layout/header'
import { useTheme } from '@/store/theme.store'
import { Theme } from '@/types/themeContext'
import { MainRoutes } from './main'

const MemoHeader = memo(Header)
const MemoPlayer = memo(Player)
const MemoSongInfoDialog = memo(SongInfoDialog)
const MemoRemovePlaylistDialog = memo(RemovePlaylistDialog)
const MemoMainDrawerPage = memo(MainDrawerPage)
const MemoFullscreenMode = memo(FullscreenMode)

export default function BaseLayout() {
  const backgroundImageSource = useBackgroundImageSource()
  const { theme } = useTheme()
  const isMinatoWave = theme === Theme.MinatoWave

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      {backgroundImageSource && (
        <>
          <img
            className="app-window-background"
            src={backgroundImageSource}
            alt=""
          />
          <div className="app-window-background-overlay" />
        </>
      )}

      <div className="relative z-[1] h-full w-full">
        {isMinatoWave && <div className="app-content-glass-layer" />}

        <div className="relative z-[1] h-full w-full">
          <MainSidebarProvider>
            <MemoHeader />
            <AppSidebar />
            <MainSidebarInset>
              <MainRoutes />
            </MainSidebarInset>
            <MemoPlayer />
          </MainSidebarProvider>
          <MemoSongInfoDialog />
          <MemoRemovePlaylistDialog />
          <MemoMainDrawerPage />
          <CreatePlaylistDialog />
          <MemoFullscreenMode />
        </div>
      </div>
    </div>
  )
}
