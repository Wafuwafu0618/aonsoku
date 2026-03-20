import { ImagesContent } from './images'
import { LocalLibraryContent } from './local-library'
import { PodcastContent } from './podcast'
import { SidebarContent } from './sidebar'

export function Content() {
  return (
    <div className="space-y-4">
      <SidebarContent />
      <LocalLibraryContent />
      <PodcastContent />
      <ImagesContent />
    </div>
  )
}
