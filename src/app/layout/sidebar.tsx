import {
  Clock3Icon,
  CompassIcon,
  HomeIcon,
  LibraryIcon,
  Mic2Icon,
  Music2Icon,
  RadioIcon,
  SearchIcon,
} from 'lucide-react'
import { ElementType, memo } from 'react'
import { ROUTES } from '@/routes/routesList'

const Clock3 = memo(Clock3Icon)
const Compass = memo(CompassIcon)
const Mic2 = memo(Mic2Icon)
const Music2 = memo(Music2Icon)
const Radio = memo(RadioIcon)
const Search = memo(SearchIcon)
const Home = memo(HomeIcon)
const Library = memo(LibraryIcon)

export interface ISidebarItem {
  id: string
  title: string
  route: string
  icon: ElementType
}

export enum SidebarItems {
  Search = 'search',
  Home = 'home',
  Library = 'library',
  RecentlyAdded = 'recently-added',
  Recommended = 'recommended',
  Artists = 'artists',
  Songs = 'songs',
  Albums = 'albums',
  Favorites = 'favorites',
  Playlists = 'playlists',
  AppleMusic = 'apple-music',
  Podcasts = 'podcasts',
  Radios = 'radios',
  PodcastAll = 'podcast-all',
  PodcastLatest = 'podcast-latest',
  Browse = 'browse',
}

export const mainNavItems = [
  {
    id: SidebarItems.Search,
    title: 'sidebar.miniSearch',
    route: `${ROUTES.LIBRARY.SONGS}?filter=search`,
    icon: Search,
  },
  {
    id: SidebarItems.Home,
    title: 'sidebar.home',
    route: ROUTES.LIBRARY.HOME,
    icon: Home,
  },
  {
    id: SidebarItems.Radios,
    title: 'sidebar.radios',
    route: ROUTES.LIBRARY.RADIOS,
    icon: Radio,
  },
  {
    id: SidebarItems.Library,
    title: 'sidebar.library',
    route: ROUTES.LIBRARY.FAVORITES,
    icon: Library,
  },
]

export const appleMusicMainNavItems = [
  {
    id: SidebarItems.Search,
    title: 'sidebar.miniSearch',
    route: `${ROUTES.LIBRARY.SONGS}?filter=search`,
    icon: Search,
  },
  {
    id: SidebarItems.Home,
    title: 'sidebar.home',
    route: ROUTES.LIBRARY.HOME,
    icon: Home,
  },
  {
    id: SidebarItems.Radios,
    title: 'sidebar.radios',
    route: ROUTES.LIBRARY.RADIOS,
    icon: Radio,
  },
  {
    id: SidebarItems.Browse,
    title: 'sidebar.browse',
    route: ROUTES.LIBRARY.APPLE_MUSIC,
    icon: Compass,
  },
  {
    id: SidebarItems.Library,
    title: 'sidebar.library',
    route: ROUTES.LIBRARY.FAVORITES,
    icon: Library,
  },
]

export const libraryItems = [
  {
    id: SidebarItems.RecentlyAdded,
    title: 'home.recentlyAdded',
    route: `${ROUTES.ALBUMS.RECENTLY_ADDED}&scope=favorites`,
    icon: Clock3,
  },
  {
    id: SidebarItems.Artists,
    title: 'sidebar.artists',
    route: `${ROUTES.LIBRARY.ARTISTS}?scope=favorites`,
    icon: Mic2,
  },
  {
    id: SidebarItems.Songs,
    title: 'sidebar.songs',
    route: `${ROUTES.LIBRARY.SONGS}?scope=favorites`,
    icon: Music2,
  },
  {
    id: SidebarItems.Albums,
    title: 'sidebar.albums',
    route: `${ROUTES.ALBUMS.GENERIC('alphabeticalByName')}&scope=favorites`,
    icon: Library,
  },
  {
    id: SidebarItems.Recommended,
    title: 'home.explore',
    route: `${ROUTES.ALBUMS.RANDOM}&scope=favorites`,
    icon: Compass,
  },
]

export const appleMusicLibraryItems = [
  {
    id: SidebarItems.RecentlyAdded,
    title: 'home.recentlyAdded',
    route: `${ROUTES.ALBUMS.RECENTLY_ADDED}&scope=favorites`,
    icon: Clock3,
  },
  {
    id: SidebarItems.Artists,
    title: 'sidebar.artists',
    route: `${ROUTES.LIBRARY.ARTISTS}?scope=favorites`,
    icon: Mic2,
  },
  {
    id: SidebarItems.Songs,
    title: 'sidebar.songs',
    route: `${ROUTES.LIBRARY.SONGS}?scope=favorites`,
    icon: Music2,
  },
  {
    id: SidebarItems.Albums,
    title: 'sidebar.albums',
    route: `${ROUTES.ALBUMS.GENERIC('alphabeticalByName')}&scope=favorites`,
    icon: Library,
  },
  {
    id: SidebarItems.Playlists,
    title: 'sidebar.playlists',
    route: ROUTES.LIBRARY.PLAYLISTS,
    icon: Compass,
  },
]

export const podcastItems = [
  {
    id: SidebarItems.PodcastAll,
    title: 'podcasts.form.all',
    route: ROUTES.LIBRARY.PODCASTS,
    icon: () => null,
  },
  {
    id: SidebarItems.PodcastLatest,
    title: 'podcasts.form.latestEpisodes',
    route: ROUTES.EPISODES.LATEST,
    icon: () => null,
  },
]
