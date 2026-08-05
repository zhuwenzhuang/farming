import type { AgentTranscriptProcessItem } from './acp/acp-entry-projection'
import { ChevronRightGlyph } from '../IconGlyphs'
import { planDetailItems } from './agent-plan'

export function AgentPlanActivityPreview({
  plan,
  expanded,
  onToggle,
}: {
  plan: AgentTranscriptProcessItem
  expanded: boolean
  onToggle: () => void
}) {
  const items = planDetailItems(String(plan.detail || ''))
  const progress = plan.totalSteps
    ? `${plan.completedSteps || 0}/${plan.totalSteps}`
    : ''
  const currentStep = String(
    plan.currentStep
      || items?.find(item => item.status === 'running')?.text
      || '',
  ).trim()

  return (
    <aside
      className={`code-agent-transcript-plan-driver ${expanded ? 'expanded' : ''}`}
      data-testid="code-agent-transcript-plan-driver"
      aria-label="Current plan"
    >
      <button
        type="button"
        className="code-agent-transcript-plan-driver-summary"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span>Plan</span>
        {progress ? <small>{progress}</small> : null}
        {currentStep ? <em title={currentStep}>{currentStep}</em> : null}
        <ChevronRightGlyph className="code-agent-transcript-plan-driver-chevron" />
      </button>
      {expanded ? (
        items ? (
          <ol className="code-agent-transcript-plan-list">
            {items.map((item, index) => (
              <li
                key={`${index}:${item.text}`}
                className={item.status}
                aria-current={item.status === 'running' ? 'step' : undefined}
              >
                <span>{item.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="code-agent-transcript-plan-driver-detail">{plan.detail}</div>
        )
      ) : null}
    </aside>
  )
}
