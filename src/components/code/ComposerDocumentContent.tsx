import { Fragment, type ReactNode } from 'react'
import type { ComposerDocument, ComposerDocumentNode } from '../../../shared/composer-document.js'

export function ComposerDocumentContent({ document }: { document: ComposerDocument }) {
  function render(node: ComposerDocumentNode, key: number): ReactNode {
    let children: ReactNode = node.text ?? node.content?.map(render)
    for (const [index, mark] of (node.marks || []).entries()) {
      if (mark.type === 'bold') children = <strong key={index}>{children}</strong>
      else if (mark.type === 'italic') children = <em key={index}>{children}</em>
      else if (mark.type === 'strike') children = <s key={index}>{children}</s>
      else if (mark.type === 'underline') children = <u key={index}>{children}</u>
      else if (mark.type === 'code') children = <code key={index}>{children}</code>
      else if (mark.type === 'link') children = <a key={index} href={String(mark.attrs?.href)} target="_blank" rel="noopener noreferrer nofollow">{children}</a>
    }
    switch (node.type) {
      case 'text': return <Fragment key={key}>{children}</Fragment>
      case 'hardBreak': return <br key={key} />
      case 'paragraph': return <p key={key}>{children || <br />}</p>
      case 'heading': { const Tag = `h${node.attrs?.level || 1}` as 'h1'; return <Tag key={key}>{children}</Tag> }
      case 'codeBlock': return <pre key={key}><code className={node.attrs?.language ? `language-${node.attrs.language}` : undefined}>{children}</code></pre>
      case 'bulletList': return <ul key={key}>{children}</ul>
      case 'orderedList': return <ol key={key} start={Number(node.attrs?.start || 1)}>{children}</ol>
      case 'listItem': return <li key={key}>{children}</li>
      case 'blockquote': return <blockquote key={key}>{children}</blockquote>
      case 'horizontalRule': return <hr key={key} />
      default: return <Fragment key={key}>{children}</Fragment>
    }
  }
  return <div className="code-composer-document" data-testid="code-user-document">{document.doc.content?.map(render)}</div>
}
