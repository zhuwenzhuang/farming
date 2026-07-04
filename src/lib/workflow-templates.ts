export interface WorkflowTemplateOption {
  id: string
  label: string
  /** Prepended when merging with optional user task body */
  prefix: string
}

export const WORKFLOW_TEMPLATE_OPTIONS: WorkflowTemplateOption[] = [
  { id: '', label: '(none)', prefix: '' },
  { id: 'ralph', label: 'Ralph loop', prefix: '[Workflow: ralph loop]\n' },
  { id: 'developer', label: 'Developer loop', prefix: '[Workflow: developer loop]\n' },
  { id: 'reviewer', label: 'Reviewer loop', prefix: '[Workflow: reviewer loop]\n' },
]

export function mergeTaskWithWorkflow(
  userTask: string,
  workflowId: string
): { task: string; workflowTemplate: string } {
  const opt = WORKFLOW_TEMPLATE_OPTIONS.find(o => o.id === workflowId)
  const prefix = opt?.prefix ?? ''
  const trimmed = userTask.trim()
  const task = prefix ? (trimmed ? `${prefix}${trimmed}` : prefix.trimEnd()) : trimmed
  return { task, workflowTemplate: workflowId || '' }
}
