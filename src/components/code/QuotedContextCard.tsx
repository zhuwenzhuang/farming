import type { ReactNode } from 'react'

/** One disclosure recipe for captured context before and after submission. */
export function QuotedContextCard({ label, children, actions, detail, testId = 'code-composer-quote' }: {
  label: string; children: ReactNode; actions?: ReactNode; detail?: ReactNode; testId?: string
}) {
  return <div className="code-composer-quote" data-testid={testId}>
    <details>
      <summary>{label}</summary>
      <pre>{children}</pre>
      {detail}
    </details>
    <div className="code-composer-quote-excerpt">{children}</div>
    {actions}
  </div>
}
