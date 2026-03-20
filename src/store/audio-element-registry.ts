let currentAudioElement: HTMLAudioElement | null = null

export function setCurrentAudioElement(audio: HTMLAudioElement | null): void {
  currentAudioElement = audio
}

export function getCurrentAudioElement(): HTMLAudioElement | null {
  return currentAudioElement
}
