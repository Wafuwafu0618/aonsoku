import { QueueItem } from '@/domain/entities/queue-item'
import { mapNavidromeSongToQueueItem } from '@/domain/mappers/navidrome'
import { ISong } from '@/types/responses/song'

/**
 * ISong（Navidrome固有型）からQueueItem（ドメイン型）への変換
 * WP5移行期間中の互換性レイヤー
 */
export function convertISongToQueueItem(song: ISong): QueueItem {
  return mapNavidromeSongToQueueItem(song)
}

/**
 * ISong配列からQueueItem配列への変換
 */
export function convertISongsToQueueItems(songs: ISong[]): QueueItem[] {
  return songs.map(convertISongToQueueItem)
}

/**
 * QueueItemから表示用の基本情報を抽出
 * UIコンポーネントで使用
 */
export function getQueueItemDisplayInfo(item: QueueItem) {
  return {
    id: item.id,
    title: item.title,
    artist: item.primaryArtist,
    album: item.albumTitle,
    duration: item.durationSeconds,
    coverArtId: item.coverArtId,
    source: item.source,
    sourceId: item.sourceId,
  }
}

/**
 * ソースに応じたスタイル情報を取得
 */
export function getSourceStyle(source: QueueItem['source']) {
  const styles = {
    navidrome: {
      label: 'Navidrome',
      color: '#4F46E5', // indigo-600
      bgColor: '#EEF2FF', // indigo-50
    },
    spotify: {
      label: 'Spotify',
      color: '#1DB954',
      bgColor: '#D1FAE5',
    },
    local: {
      label: 'Local',
      color: '#7C3AED', // violet-600
      bgColor: '#EDE9FE', // violet-50
    },
  }

  return styles[source] ?? styles.navidrome
}
