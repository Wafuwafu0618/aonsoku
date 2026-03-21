import clsx from 'clsx'
import { ListMusic } from 'lucide-react'
import { memo } from 'react'
import { Link } from 'react-router-dom'
import { PlaylistOptions } from '@/app/components/playlist/options'
import { ContextMenuProvider } from '@/app/components/table/context-menu'
import {
  MainSidebarMenuButton,
  MainSidebarMenuItem,
} from '@/app/components/ui/main-sidebar'
import { useRouteIsActive } from '@/app/hooks/use-route-is-active'
import { ROUTES } from '@/routes/routesList'
import { Playlist } from '@/types/responses/playlist'

const MemoContextMenuProvider = memo(ContextMenuProvider)
const MemoPlaylistOptions = memo(PlaylistOptions)

export function SidebarPlaylistItem({ playlist }: { playlist: Playlist }) {
  const { isOnPlaylist } = useRouteIsActive()
  const active = isOnPlaylist(playlist.id)

  return (
    <MainSidebarMenuItem>
      <MemoContextMenuProvider
        options={
          <MemoPlaylistOptions
            variant="context"
            playlist={playlist}
            showPlay={true}
          />
        }
      >
        <MainSidebarMenuButton
          asChild
          isActive={active}
          className={clsx(active && 'cursor-default')}
        >
          <Link
            to={ROUTES.PLAYLIST.PAGE(playlist.id)}
            onClick={(e) => {
              if (active) {
                e.preventDefault()
              }
            }}
          >
            <ListMusic />
            <span className="truncate">{playlist.name}</span>
          </Link>
        </MainSidebarMenuButton>
      </MemoContextMenuProvider>
    </MainSidebarMenuItem>
  )
}
