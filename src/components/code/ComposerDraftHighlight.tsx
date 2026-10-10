import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { highlightComposerMarkdown } from './composer-markdown'

/** An inert paint layer; selection, undo, IME and accessibility stay native. */
export function ComposerDraftHighlight({ draft, textareaRef }: { draft: string; textareaRef: RefObject<HTMLTextAreaElement | null> }) {
  const html = useMemo(() => highlightComposerMarkdown(draft), [draft])
  const mirrorRef = useRef<HTMLPreElement>(null)
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    const mirror = mirrorRef.current
    if (!textarea || !mirror || html === null) return
    textarea.classList.add('code-composer-highlighted')
    const sync = () => {
      const style = getComputedStyle(textarea)
      Object.assign(mirror.style, {
        top: `${textarea.offsetTop}px`, left: `${textarea.offsetLeft}px`,
        width: `${textarea.clientWidth}px`, height: `${textarea.clientHeight}px`,
        font: style.font, letterSpacing: style.letterSpacing, padding: style.padding,
        tabSize: style.tabSize, textIndent: style.textIndent,
      })
      mirror.scrollTop = textarea.scrollTop
      mirror.scrollLeft = textarea.scrollLeft
    }
    sync()
    const resize = new ResizeObserver(sync)
    resize.observe(textarea)
    if (textarea.parentElement) resize.observe(textarea.parentElement)
    const appearance = new MutationObserver(sync)
    appearance.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-appearance'] })
    textarea.addEventListener('scroll', sync, { passive: true })
    return () => {
      textarea.classList.remove('code-composer-highlighted')
      resize.disconnect(); appearance.disconnect()
      textarea.removeEventListener('scroll', sync)
    }
  }, [html, textareaRef])
  // highlight.js escapes input. Source clipboard HTML is never inserted here.
  return html === null ? null : <pre ref={mirrorRef} className="code-composer-draft-highlight" aria-hidden="true" data-testid="code-composer-draft-highlight" dangerouslySetInnerHTML={{ __html: html + '\n' }} />
}
