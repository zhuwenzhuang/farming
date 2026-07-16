/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Adapted from VS Code's SCM history graph at commit
 * 0217c2f1a0defc7fdbfb4feba74e71e366de6822:
 * src/vs/workbench/contrib/scm/browser/scmHistory.ts
 *
 * Farming keeps the proven swimlane transform independent from its React UI and Git provider.
 */

import type { WorkspaceGitHistoryItem } from './workspace-files'

export const GIT_HISTORY_SWIMLANE_HEIGHT = 22
export const GIT_HISTORY_SWIMLANE_WIDTH = 11
export const GIT_HISTORY_GRAPH_COLORS = ['#ffb000', '#dc267f', '#994f00', '#40b0a6', '#b66dff'] as const
export const GIT_HISTORY_HEAD_COLOR = '#2188ff'

export interface GitHistoryGraphNode {
  id: string
  color: string
}

export interface GitHistoryItemViewModel {
  historyItem: WorkspaceGitHistoryItem
  inputSwimlanes: GitHistoryGraphNode[]
  outputSwimlanes: GitHistoryGraphNode[]
  kind: 'HEAD' | 'node'
}

function cloneGraphNode(node: GitHistoryGraphNode): GitHistoryGraphNode {
  return { ...node }
}

function getReferenceColor(historyItem: WorkspaceGitHistoryItem, colorMap: ReadonlyMap<string, string | undefined>) {
  for (const reference of historyItem.references ?? []) {
    const color = colorMap.get(reference.id)
    if (color !== undefined) return color
  }
  return undefined
}

/**
 * Converts date/topology ordered commits into per-row input and output swimlanes.
 * The transform intentionally follows VS Code's implementation so page-boundary
 * lanes and multi-parent merges keep the same behavior as the built-in SCM Graph.
 */
export function toGitHistoryItemViewModelArray(
  historyItems: WorkspaceGitHistoryItem[],
  currentHeadId?: string,
  colorMap: ReadonlyMap<string, string | undefined> = new Map(),
): GitHistoryItemViewModel[] {
  let colorIndex = -1
  const viewModels: GitHistoryItemViewModel[] = []

  for (const historyItem of historyItems) {
    const kind = historyItem.id === currentHeadId ? 'HEAD' : 'node'
    const outputSwimlanesFromPreviousItem = viewModels[viewModels.length - 1]?.outputSwimlanes ?? []
    const inputSwimlanes = outputSwimlanesFromPreviousItem.map(cloneGraphNode)
    const outputSwimlanes: GitHistoryGraphNode[] = []

    let firstParentAdded = false

    if (historyItem.parentIds.length > 0) {
      for (const node of inputSwimlanes) {
        if (node.id === historyItem.id) {
          if (!firstParentAdded) {
            outputSwimlanes.push({
              id: historyItem.parentIds[0]!,
              color: getReferenceColor(historyItem, colorMap) ?? node.color,
            })
            firstParentAdded = true
          }
          continue
        }

        outputSwimlanes.push(cloneGraphNode(node))
      }
    }

    for (let parentIndex = firstParentAdded ? 1 : 0; parentIndex < historyItem.parentIds.length; parentIndex += 1) {
      let color: string | undefined

      if (parentIndex === 0) {
        color = getReferenceColor(historyItem, colorMap)
      } else {
        const historyItemParent = historyItems.find(candidate => candidate.id === historyItem.parentIds[parentIndex])
        color = historyItemParent ? getReferenceColor(historyItemParent, colorMap) : undefined
      }

      if (!color) {
        colorIndex = (colorIndex + 1) % GIT_HISTORY_GRAPH_COLORS.length
        color = GIT_HISTORY_GRAPH_COLORS[colorIndex]!
      }

      outputSwimlanes.push({ id: historyItem.parentIds[parentIndex]!, color })
    }

    viewModels.push({ historyItem, kind, inputSwimlanes, outputSwimlanes })
  }

  return viewModels
}

export function gitHistoryItemLaneIndex(historyItemViewModel: GitHistoryItemViewModel) {
  const inputIndex = historyItemViewModel.inputSwimlanes
    .findIndex(node => node.id === historyItemViewModel.historyItem.id)
  return inputIndex !== -1 ? inputIndex : historyItemViewModel.inputSwimlanes.length
}
