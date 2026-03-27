import { useQueryClient } from '@tanstack/react-query'
import { Database, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-toastify'
import {
  clearLyricsCache,
  getAllTracks,
  getLyricsCacheStats,
  type LyricsCacheStats,
} from '@/local-library'
import {
  enqueueLyricsPrefetchBatch,
  resetLyricsPrefetchQueue,
} from '@/service/lyrics-prefetch'
import {
  Content,
  ContentItem,
  ContentItemForm,
  ContentItemTitle,
  ContentSeparator,
  Header,
  HeaderDescription,
  HeaderTitle,
  Root,
} from '@/app/components/settings/section'
import { Button } from '@/app/components/ui/button'
import { Switch } from '@/app/components/ui/switch'
import { useLyricsSettings } from '@/store/player.store'

const initialStats: LyricsCacheStats = {
  total: 0,
  found: 0,
  notFound: 0,
  error: 0,
}

export function LyricsSettings() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { preferSyncedLyrics, setPreferSyncedLyrics } = useLyricsSettings()
  const [stats, setStats] = useState<LyricsCacheStats>(initialStats)
  const [isRefreshingStats, setIsRefreshingStats] = useState(false)
  const [isClearingCache, setIsClearingCache] = useState(false)
  const [isQueueingPrefetch, setIsQueueingPrefetch] = useState(false)

  const refreshStats = useCallback(async () => {
    setIsRefreshingStats(true)
    try {
      const nextStats = await getLyricsCacheStats()
      setStats(nextStats)
    } finally {
      setIsRefreshingStats(false)
    }
  }, [])

  useEffect(() => {
    void refreshStats()
  }, [refreshStats])

  async function handleClearCache() {
    setIsClearingCache(true)

    try {
      await clearLyricsCache()
      resetLyricsPrefetchQueue()
      await queryClient.invalidateQueries({
        queryKey: ['get-lyrics'],
      })
      await refreshStats()
      toast.success(t('settings.audio.lyrics.cache.cleared'))
    } catch (error) {
      toast.error(
        t('settings.audio.lyrics.cache.clearError', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      )
    } finally {
      setIsClearingCache(false)
    }
  }

  async function handlePrefetchLocalLibrary() {
    setIsQueueingPrefetch(true)

    try {
      const tracks = await getAllTracks()
      if (tracks.length === 0) {
        toast.warn(t('settings.audio.lyrics.cache.emptyLibrary'))
        return
      }

      enqueueLyricsPrefetchBatch(
        tracks.map((track) => ({
          id: track.id,
          artist: track.artist,
          title: track.title,
          album: track.album,
          duration: track.duration,
        })),
      )
      toast.success(
        t('settings.audio.lyrics.cache.prefetchQueued', {
          count: tracks.length,
        }),
      )
    } catch (error) {
      toast.error(
        t('settings.audio.lyrics.cache.prefetchError', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      )
    } finally {
      setIsQueueingPrefetch(false)
    }
  }

  return (
    <Root>
      <Header>
        <HeaderTitle>{t('settings.audio.lyrics.group')}</HeaderTitle>
        <HeaderDescription>
          {t('settings.audio.lyrics.description')}
        </HeaderDescription>
      </Header>
      <Content>
        <ContentItem>
          <ContentItemTitle info={t('settings.audio.lyrics.preferSynced.info')}>
            {t('settings.audio.lyrics.preferSynced.label')}
          </ContentItemTitle>
          <ContentItemForm>
            <Switch
              checked={preferSyncedLyrics}
              onCheckedChange={setPreferSyncedLyrics}
            />
          </ContentItemForm>
        </ContentItem>

        <ContentItem>
          <ContentItemTitle>
            {t('settings.audio.lyrics.cache.group')}
          </ContentItemTitle>
          <ContentItemForm>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void refreshStats()}
              disabled={isRefreshingStats || isClearingCache}
            >
              <RefreshCw
                className={`w-4 h-4 mr-2 ${isRefreshingStats ? 'animate-spin' : ''}`}
              />
              {t('settings.audio.lyrics.cache.refresh')}
            </Button>
          </ContentItemForm>
        </ContentItem>

        <div className="space-y-2 rounded-md border p-3">
          <div className="text-sm text-muted-foreground">
            {t('settings.audio.lyrics.cache.summary', {
              total: stats.total,
              found: stats.found,
              notFound: stats.notFound,
              error: stats.error,
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handlePrefetchLocalLibrary}
              disabled={isQueueingPrefetch || isClearingCache}
            >
              <Database className="w-4 h-4 mr-2" />
              {isQueueingPrefetch
                ? t('settings.audio.lyrics.cache.prefetching')
                : t('settings.audio.lyrics.cache.prefetch')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={handleClearCache}
              disabled={isClearingCache}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {t('settings.audio.lyrics.cache.clear')}
            </Button>
          </div>
        </div>
      </Content>
      <ContentSeparator />
    </Root>
  )
}
