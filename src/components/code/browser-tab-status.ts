type UnreadRow = { unread?: boolean; archived?: boolean; isMain?: boolean }
type UnreadProject = {
  agents: readonly UnreadRow[]
  agentSessions: readonly UnreadRow[]
  agentSummary?: { unreadCount: number } | null
}

// Membership has already been deduplicated by the main-page inventory owner.
// Consume it before search, collapsed groups and session pagination.
export function browserTabUnreadCount(projects: readonly UnreadProject[], inventoryComplete: boolean): number {
  const unread = (row: UnreadRow) => row.unread === true && row.archived !== true && row.isMain !== true
  return projects.reduce((total, project) => total
    + (!inventoryComplete && project.agentSummary
      ? project.agentSummary.unreadCount
      : project.agents.filter(unread).length)
    + project.agentSessions.filter(unread).length, 0)
}

export function browserTabTitle(instanceName: string, unreadCount: number): string {
  return `${unreadCount > 0 ? `(${unreadCount}) ` : ''}${instanceName} · Farming Code`
}
