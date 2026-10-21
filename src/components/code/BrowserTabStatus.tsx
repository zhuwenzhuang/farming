import { useEffect, useMemo } from 'react'
import { agentWithCurrentLiveState, useDynamicPinProjectionRevision } from '@/lib/agent-live-state'
import { appPath } from '@/lib/base-path'
import type { ProjectGroup } from './types'
import { browserTabTitle, browserTabUnreadCount } from './browser-tab-status'

export function BrowserTabStatus({ projects, inventoryComplete, instanceName }: {
  projects: ProjectGroup[]
  inventoryComplete: boolean
  instanceName: string
}) {
  // This existing bounded attention revision includes unread/read changes even
  // when inventory row objects stay unchanged. Do not subscribe to output text.
  const attentionRevision = useDynamicPinProjectionRevision()
  const unreadCount = useMemo(() => {
    void attentionRevision
    return browserTabUnreadCount(projects.map(project => ({
      ...project,
      agents: project.agents.map(agentWithCurrentLiveState),
    })), inventoryComplete)
  }, [projects, inventoryComplete, attentionRevision])

  useEffect(() => {
    const title = document.title
    const icon = document.querySelector<HTMLLinkElement>('#farming-favicon')
    const href = icon?.getAttribute('href')
    return () => {
      document.title = title
      if (icon && href) icon.setAttribute('href', href)
    }
  }, [])

  useEffect(() => {
    document.title = browserTabTitle(instanceName, unreadCount)
  }, [instanceName, unreadCount])

  const hasUnread = unreadCount > 0
  useEffect(() => {
    document.querySelector<HTMLLinkElement>('#farming-favicon')?.setAttribute(
      'href', appPath(`/farming-2/favicon-v4${hasUnread ? '-unread' : ''}.svg`),
    )
  }, [hasUnread])

  return null
}
