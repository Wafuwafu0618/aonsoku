import { memo } from 'react'
import { ImageLoader } from '@/app/components/image-loader'
import { PreviewCard } from '@/app/components/preview-card/card'
import { getAlbumById } from '@/queries/albums'
import { ROUTES } from '@/routes/routesList'
import { usePlayerActions } from '@/store/player.store'
import { Albums } from '@/types/responses/album'

type AlbumCardProps = {
  album: Albums
}

const APPLE_MUSIC_ALBUM_ID_PREFIX = 'apple-music:'

function AlbumCard({ album }: AlbumCardProps) {
  const { setSongList } = usePlayerActions()
  const isAppleMusicAlbum = album.id.startsWith(APPLE_MUSIC_ALBUM_ID_PREFIX)
  const resolvedAlbumId = isAppleMusicAlbum
    ? album.id.slice(APPLE_MUSIC_ALBUM_ID_PREFIX.length)
    : album.id
  const albumLink = isAppleMusicAlbum
    ? ROUTES.APPLE_MUSIC_ALBUM.PAGE(resolvedAlbumId)
    : ROUTES.ALBUM.PAGE(resolvedAlbumId)

  async function handlePlayAlbum() {
    if (isAppleMusicAlbum) return

    const response = await getAlbumById(resolvedAlbumId)

    if (response) {
      setSongList(response.song, 0)
    }
  }

  return (
    <PreviewCard.Root>
      <PreviewCard.ImageWrapper link={albumLink}>
        <ImageLoader id={album.coverArt} type="album" size={300}>
          {(src) => <PreviewCard.Image src={src} alt={album.name} />}
        </ImageLoader>
        {!isAppleMusicAlbum && (
          <PreviewCard.PlayButton onClick={handlePlayAlbum} />
        )}
      </PreviewCard.ImageWrapper>
      <PreviewCard.InfoWrapper>
        <PreviewCard.Title link={albumLink}>
          {album.name}
        </PreviewCard.Title>
        <PreviewCard.Subtitle
          enableLink={album.artistId !== undefined}
          link={ROUTES.ARTIST.PAGE(album.artistId ?? '')}
        >
          {album.artist}
        </PreviewCard.Subtitle>
      </PreviewCard.InfoWrapper>
    </PreviewCard.Root>
  )
}

export const AlbumGridCard = memo(AlbumCard)
