import { MediaSource } from './media-source'

export function createDomainId(source: MediaSource, sourceId: string): string {
  return `${source}:${sourceId}`
}
