import { useTranslation } from 'react-i18next'
import { PreviewListFallback } from '@/app/components/fallbacks/home-fallbacks'
import { useGetGenreRecommendations } from '@/app/hooks/use-home'
import { ROUTES } from '@/routes/routesList'
import PreviewList from './preview-list'

export function GenreRecommendations() {
  const { t } = useTranslation()
  const { data, isLoading } = useGetGenreRecommendations()

  if (isLoading) {
    return (
      <>
        <PreviewListFallback />
        <PreviewListFallback />
      </>
    )
  }

  if (!data || data.length === 0) return null

  return (
    <>
      {data.map((section) => (
        <PreviewList
          key={section.genre}
          title={t('album.more.genreTitle', {
            genre: section.genre,
          })}
          moreRoute={ROUTES.ALBUMS.GENRE(section.genre)}
          list={section.albums}
        />
      ))}
    </>
  )
}
