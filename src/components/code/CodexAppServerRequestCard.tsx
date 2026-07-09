import { useEffect, useMemo, useState } from 'react'
import type { CodexAppServerPendingRequest } from '@/types/agent'
import type { CodeCopy } from './copy'

interface UserInputQuestion {
  id: string
  header: string
  question: string
  isSecret: boolean
  options: Array<{ label: string; description: string }>
}

interface CodexAppServerRequestCardProps {
  request: CodexAppServerPendingRequest | null | undefined
  onRespond: (requestId: string, result: unknown) => void
  onReject: (requestId: string) => void
  copy: CodeCopy
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function userInputQuestions(params: Record<string, unknown>): UserInputQuestion[] {
  const questions = Array.isArray(params.questions) ? params.questions : []
  return questions.map(question => {
    const value = asRecord(question)
    return {
      id: stringValue(value.id),
      header: stringValue(value.header),
      question: stringValue(value.question),
      isSecret: value.isSecret === true,
      options: Array.isArray(value.options)
        ? value.options.map(option => {
          const item = asRecord(option)
          return { label: stringValue(item.label), description: stringValue(item.description) }
        }).filter(option => option.label)
        : [],
    }
  }).filter(question => question.id)
}

function isApprovalRequest(method: string) {
  return method === 'item/commandExecution/requestApproval'
    || method === 'item/fileChange/requestApproval'
    || method === 'item/permissions/requestApproval'
}

function approvalDecision(method: string, decision: 'accept' | 'decline') {
  if (!isApprovalRequest(method)) return null
  return { decision }
}

export function CodexAppServerRequestCard({
  request,
  onRespond,
  onReject,
  copy,
}: CodexAppServerRequestCardProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const questions = useMemo(() => userInputQuestions(request?.params || {}), [request])

  useEffect(() => {
    setAnswers({})
  }, [request?.id])

  if (!request) return null
  const params = asRecord(request.params)
  const command = stringValue(params.command)
  const reason = stringValue(params.reason)
  const approval = isApprovalRequest(request.method)
  const userInput = request.method === 'item/tool/requestUserInput' && questions.length > 0
  const canSubmitAnswers = userInput && questions.every(question => (answers[question.id] || '').trim())

  return (
    <section className="code-app-server-request" data-testid="code-app-server-request">
      <header>
        <strong>{approval ? copy.appServerApprovalRejectedTitle : copy.appServerRequestTitle}</strong>
        <span>{request.method}</span>
      </header>
      {reason && <p>{reason}</p>}
      {approval && <p>{copy.appServerApprovalRejectedDescription}</p>}
      {command && (
        <div className="code-app-server-request-command">
          <small>{copy.appServerRequestCommand}</small>
          <code>{command}</code>
        </div>
      )}
      {userInput && (
        <div className="code-app-server-request-questions">
          {questions.map(question => (
            <label key={question.id}>
              <span>{question.header || copy.appServerRequestQuestion}</span>
              {question.question && <small>{question.question}</small>}
              {question.options.length > 0 && (
                <div className="code-app-server-request-options">
                  {question.options.map(option => (
                    <button
                      type="button"
                      key={option.label}
                      className={answers[question.id] === option.label ? 'active' : ''}
                      onClick={() => setAnswers(current => ({ ...current, [question.id]: option.label }))}
                    >
                      {option.label}
                      {option.description && <small>{option.description}</small>}
                    </button>
                  ))}
                </div>
              )}
              <input
                type="text"
                className={question.isSecret ? 'code-app-server-secret-input' : undefined}
                name={`farming-app-server-answer-${question.id}`}
                inputMode="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="done"
                data-lpignore="true"
                data-1p-ignore="true"
                data-bwignore="true"
                data-form-type="other"
                value={answers[question.id] || ''}
                onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))}
              />
            </label>
          ))}
        </div>
      )}
      {!approval && !userInput && <p>{copy.appServerRequestUnsupported}</p>}
      <div className="code-app-server-request-actions">
        {approval && (
          <button type="button" onClick={() => onRespond(request.id, approvalDecision(request.method, 'decline'))}>
            {copy.appServerRequestDecline}
          </button>
        )}
        {userInput && (
          <button
            type="button"
            className="approve"
            disabled={!canSubmitAnswers}
            onClick={() => onRespond(request.id, {
              answers: Object.fromEntries(questions.map(question => [
                question.id,
                { answers: [String(answers[question.id] ?? '').trim()] },
              ])),
            })}
          >
            {copy.appServerRequestSubmit}
          </button>
        )}
        {!approval && !userInput && (
          <button type="button" onClick={() => onReject(request.id)}>{copy.appServerRequestDecline}</button>
        )}
      </div>
    </section>
  )
}
