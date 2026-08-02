import type { SpeechRecognitionLike } from './types'

export interface SpeechRecognitionOwner {
  current: SpeechRecognitionLike | null
  stopping: SpeechRecognitionLike | null
}

export function ownSpeechRecognition(
  owner: SpeechRecognitionOwner,
  recognition: SpeechRecognitionLike,
) {
  owner.current = recognition
  owner.stopping = null
}

export function isCurrentSpeechRecognition(
  owner: SpeechRecognitionOwner,
  recognition: SpeechRecognitionLike,
) {
  return owner.current === recognition
}

export function releaseSpeechRecognition(
  owner: SpeechRecognitionOwner,
  recognition: SpeechRecognitionLike,
) {
  if (!isCurrentSpeechRecognition(owner, recognition)) return false
  owner.current = null
  if (owner.stopping === recognition) owner.stopping = null
  return true
}

export function stopSpeechRecognition(
  owner: SpeechRecognitionOwner,
  releaseBeforeStop: boolean,
) {
  const recognition = owner.current
  if (!recognition) return 'idle' as const
  const alreadyStopping = owner.stopping === recognition
  if (releaseBeforeStop) {
    releaseSpeechRecognition(owner, recognition)
    if (alreadyStopping) return 'stopping' as const
  } else {
    if (alreadyStopping) return 'stopping' as const
    owner.stopping = recognition
  }
  try {
    recognition.stop()
    return 'stopped' as const
  } catch {
    if (owner.stopping === recognition) owner.stopping = null
    releaseSpeechRecognition(owner, recognition)
    return 'failed' as const
  }
}
