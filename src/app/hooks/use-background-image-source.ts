import { useEffect, useState } from 'react'
import { readLocalLibraryFile } from '@/platform'
import { isDesktop } from '@/platform/capabilities'
import { useAppBackgroundImage } from '@/store/app.store'

function getMimeTypeFromPath(path: string): string | undefined {
  const ext = path.toLowerCase().split('.').pop()
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    case 'avif':
      return 'image/avif'
    default:
      return undefined
  }
}

function toFilePath(value: string): string {
  if (!value.startsWith('file://')) return value

  try {
    const parsed = new URL(value)
    let pathname = decodeURIComponent(parsed.pathname)

    if (/^\/[a-zA-Z]:/.test(pathname)) {
      pathname = pathname.slice(1)
    }

    return pathname
  } catch {
    return value
  }
}

function isDirectlyRenderableUrl(value: string): boolean {
  return (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('blob:') ||
    value.startsWith('data:')
  )
}

export function useBackgroundImageSource() {
  const { backgroundImageUrl } = useAppBackgroundImage()
  const [resolvedSource, setResolvedSource] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let objectUrl: string | null = null

    async function resolve() {
      if (!backgroundImageUrl) {
        setResolvedSource(null)
        return
      }

      if (isDirectlyRenderableUrl(backgroundImageUrl)) {
        setResolvedSource(backgroundImageUrl)
        return
      }

      const sourcePath = toFilePath(backgroundImageUrl)

      if (!isDesktop()) {
        setResolvedSource(backgroundImageUrl)
        return
      }

      try {
        const file = await readLocalLibraryFile(sourcePath)
        if (disposed) return

        const mimeType = getMimeTypeFromPath(sourcePath)
        const blob = mimeType
          ? new Blob([file.data], { type: mimeType })
          : new Blob([file.data])

        objectUrl = URL.createObjectURL(blob)
        setResolvedSource(objectUrl)
      } catch {
        if (!disposed) {
          setResolvedSource(null)
        }
      }
    }

    void resolve()

    return () => {
      disposed = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [backgroundImageUrl])

  return resolvedSource
}
