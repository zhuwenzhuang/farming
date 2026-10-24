/** Text-selection contract shared by native Terminal and structured Chat inputs. */
export interface StructuredComposerElement extends HTMLDivElement {
  value: string
  readonly selectionStart: number
  readonly selectionEnd: number
  readonly selectionDirection: 'forward' | 'backward' | 'none'
  readonly disabled: boolean
  setSelectionRange(start: number, end: number, direction?: 'forward' | 'backward' | 'none'): void
  setRangeText(text: string, start?: number, end?: number, selectionMode?: string): void
  select(): void
}
export type ComposerInputElement = HTMLTextAreaElement | StructuredComposerElement
export function isComposerInputElement(element: unknown): element is ComposerInputElement {
  return element instanceof HTMLTextAreaElement || (element instanceof HTMLDivElement && element.dataset.composerRichInput === 'true')
}
