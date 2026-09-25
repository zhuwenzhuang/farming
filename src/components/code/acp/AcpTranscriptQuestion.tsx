import { createContext, useContext } from 'react'
import type { AcpPendingElicitation } from '@/types/agent'
import { QuestionGlyph } from '@/components/IconGlyphs'
import type { CodeCopy } from '../copy'
import type { AgentTranscriptProcessItem } from './acp-entry-projection'
import { AcpElicitationPanel } from './AcpElicitationPanel'
import { respondToAcpElicitation } from './acp-composer-behavior'

export const AcpQuestionContext = createContext<{ agentId: string; requests: AcpPendingElicitation[] }>({ agentId: '', requests: [] })

export function AcpTranscriptQuestion({ question, copy }: { question: NonNullable<AgentTranscriptProcessItem['question']>; copy: CodeCopy }) {
  const { agentId, requests } = useContext(AcpQuestionContext)
  const pending = requests.some(request => request.requestId === question.requestId)
  return <div className="code-acp-question-history" data-testid="code-acp-question-history" data-request-id={question.requestId}>
    {pending ? <AcpElicitationPanel agentId={agentId} requests={requests} requestId={question.requestId} running={false}
      onRespond={(id, action, content) => respondToAcpElicitation(agentId, id, action, content)} copy={copy} /> : <div className="code-acp-question-result">
      <div><QuestionGlyph /><span>{question.message}</span><small>{question.status === 'answered' ? copy.questionAnswered : question.status === 'skipped' ? copy.questionSkipped : question.status === 'pending' ? copy.questionUnavailable : copy.questionClosed}</small></div>
      {question.answer ? <pre>{question.answer}</pre> : null}
    </div>}
  </div>
}
