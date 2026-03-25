import { useQuery } from '@tanstack/react-query'
import { appleMusicService } from '@/service/apple-music'
import { queryKeys } from '@/utils/queryKeys'

export const useGetAppleMusicBrowse = (options?: {
  newReleasesLimit?: number
  topChartsLimit?: number
}) => {
  return useQuery({
    queryKey: [queryKeys.appleMusic.browse, options],
    queryFn: () => appleMusicService.getBrowse(options),
    staleTime: 1000 * 60 * 5, // 5分間キャッシュ
  })
}

export const useGetAppleMusicLibraryPage = (options?: {
  limit?: number
  offset?: number
}) => {
  return useQuery({
    queryKey: [queryKeys.appleMusic.library, options],
    queryFn: () => appleMusicService.getLibraryPage(options),
    staleTime: 1000 * 60 * 2, // 2分間キャッシュ
  })
}

export const useSearchAppleMusic = (
  query: string,
  types: string[] = ['songs', 'albums'],
  enabled: boolean = true,
) => {
  return useQuery({
    queryKey: [queryKeys.appleMusic.search, query, types],
    queryFn: () => appleMusicService.search(query, types),
    enabled: enabled && query.length > 0,
    staleTime: 1000 * 60 * 10, // 10分間キャッシュ
  })
}

export const useGetCatalogAlbum = (
  albumId: string,
  enabled: boolean = true,
) => {
  console.log('[useGetCatalogAlbum] albumId:', albumId, 'enabled:', enabled)
  return useQuery({
    queryKey: [queryKeys.appleMusic.album, albumId],
    queryFn: async () => {
      console.log('[useGetCatalogAlbum] Fetching album:', albumId)
      try {
        const result = await appleMusicService.getCatalogAlbum(albumId)
        console.log('[useGetCatalogAlbum] Result:', result)
        return result
      } catch (error) {
        console.error('[useGetCatalogAlbum] Error:', error)
        throw error
      }
    },
    enabled: enabled && albumId.length > 0,
    staleTime: 0,
    refetchOnMount: 'always',
  })
}
