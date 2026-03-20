let currentSongSeekHandler: ((positionSeconds: number) => void) | null = null

export function setCurrentSongSeekHandler(
  handler: ((positionSeconds: number) => void) | null,
): void {
  currentSongSeekHandler = handler
}

export function getCurrentSongSeekHandler():
  | ((positionSeconds: number) => void)
  | null {
  return currentSongSeekHandler
}
