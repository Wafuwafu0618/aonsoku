import { useInfiniteQuery } from '@tanstack/react-query'
import debounce from 'lodash/debounce'
import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  albumSearch,
  getAlbumList,
  getArtistDiscography,
} from '@/queries/albums'
import { useMediaLibraryMode } from '@/store/app.store'
import { AlbumListType } from '@/types/responses/album'
import {
  AlbumsFilters,
  AlbumsSearchParams,
  LibraryScopeFilter,
  LibraryScopeFilters,
  SourceFilter,
  SourceFilters,
  YearFilter,
  YearSortOptions,
} from '@/utils/albumsFilter'
import { queryKeys } from '@/utils/queryKeys'
import { getMainScrollElement } from '@/utils/scrollPageToTop'
import { SearchParamsHandler } from '@/utils/searchParamsHandler'

export function useAlbumsListModel() {
  const { mode } = useMediaLibraryMode()
  const [searchParams] = useSearchParams()
  const { getSearchParam } = new SearchParamsHandler(searchParams)
  const defaultOffset = 128
  const oldestYear = '0001'
  const currentYear = new Date().getFullYear().toString()

  const scrollDivRef = useRef<HTMLDivElement | null>(null)

  const currentFilter = getSearchParam<AlbumListType>(
    AlbumsSearchParams.MainFilter,
    AlbumsFilters.RecentlyAdded,
  )
  const yearFilter = getSearchParam<YearFilter>(
    AlbumsSearchParams.YearFilter,
    YearSortOptions.Oldest,
  )
  const genre = getSearchParam<string>(AlbumsSearchParams.Genre, '')
  const artistId = getSearchParam<string>(AlbumsSearchParams.ArtistId, '')
  const query = getSearchParam<string>(AlbumsSearchParams.Query, '')
  const artistName = getSearchParam<string>(AlbumsSearchParams.ArtistName, '')
  const sourceFilter = getSearchParam<SourceFilter>(
    AlbumsSearchParams.Source,
    SourceFilters.All,
  )
  const libraryScope = getSearchParam<LibraryScopeFilter>(
    AlbumsSearchParams.Scope,
    LibraryScopeFilters.All,
  )
  const favoritesOnly = libraryScope === LibraryScopeFilters.Favorites

  useEffect(() => {
    scrollDivRef.current = getMainScrollElement()
  }, [])

  function getYearRange() {
    if (yearFilter === YearSortOptions.Oldest) {
      return [oldestYear, currentYear]
    } else {
      return [currentYear, oldestYear]
    }
  }

  const [fromYear, toYear] = getYearRange()

  const fetchAlbums = async ({ pageParam = 0 }) => {
    if (currentFilter === AlbumsFilters.ByDiscography && artistId !== '') {
      return getArtistDiscography(artistId, {
        source: sourceFilter,
        artistName,
        offset: pageParam,
        count: defaultOffset,
      })
    }

    if (favoritesOnly) {
      return getAlbumList({
        type: currentFilter,
        size: defaultOffset,
        offset: pageParam,
        fromYear,
        toYear,
        genre,
        source: sourceFilter,
        favoritesOnly: true,
        query: currentFilter === AlbumsFilters.Search ? query : '',
      })
    }

    if (currentFilter === AlbumsFilters.Search && query !== '') {
      return albumSearch({
        query,
        count: defaultOffset,
        offset: pageParam,
        source: sourceFilter,
      })
    }

    return getAlbumList({
      type: currentFilter,
      size: defaultOffset,
      offset: pageParam,
      fromYear,
      toYear,
      genre,
      source: sourceFilter,
    })
  }

  function enableMainQuery() {
    if (mode === 'applemusic') return false
    if (currentFilter === AlbumsFilters.ByGenre && genre === '') return false

    return true
  }

  const { data, fetchNextPage, hasNextPage, isLoading } = useInfiniteQuery({
    queryKey: [
      queryKeys.album.all,
      currentFilter,
      yearFilter,
      genre,
      query,
      artistId,
      sourceFilter,
      libraryScope,
    ],
    queryFn: fetchAlbums,
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset,
    enabled: enableMainQuery(),
  })

  useEffect(() => {
    const scrollElement = scrollDivRef.current
    if (!scrollElement) return

    const handleScroll = debounce(() => {
      const { scrollTop, clientHeight, scrollHeight } = scrollElement

      const isNearBottom =
        scrollTop + clientHeight >= scrollHeight - scrollHeight / 4

      if (isNearBottom) {
        if (hasNextPage) fetchNextPage()
      }
    }, 200)

    scrollElement.addEventListener('scroll', handleScroll)
    return () => {
      scrollElement.removeEventListener('scroll', handleScroll)
    }
  }, [fetchNextPage, hasNextPage])

  function getAlbums() {
    if (!data) return { albums: [], albumsCount: 0 }

    const albums = data.pages.flatMap((page) => page.albums)
    const albumsCount = data.pages[data.pages.length - 1].albumsCount

    return {
      albums,
      albumsCount,
    }
  }

  const { albums, albumsCount } = getAlbums()

  const isEmpty = albums.length === 0 || !data

  return {
    isLoading,
    isEmpty,
    albums,
    albumsCount,
  }
}
