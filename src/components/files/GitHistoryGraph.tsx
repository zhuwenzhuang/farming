/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * React host for the VS Code SCM graph renderer, adapted from commit
 * 0217c2f1a0defc7fdbfb4feba74e71e366de6822.
 */

import { memo, useLayoutEffect, useRef } from 'react'
import {
  GIT_HISTORY_HEAD_COLOR,
  GIT_HISTORY_SWIMLANE_HEIGHT,
  GIT_HISTORY_SWIMLANE_WIDTH,
  type GitHistoryGraphNode,
  type GitHistoryItemViewModel,
} from '@/lib/git-history-graph'

const SWIMLANE_CURVE_RADIUS = 5
const CIRCLE_RADIUS = 4
const CIRCLE_STROKE_WIDTH = 2
const SVG_NS = 'http://www.w3.org/2000/svg'

function createPath(color: string, strokeWidth = 1) {
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', color)
  path.setAttribute('stroke-width', String(strokeWidth))
  path.setAttribute('stroke-linecap', 'round')
  return path
}

function drawCircle(index: number, radius: number, strokeWidth: number, color: string, filled = false) {
  const circle = document.createElementNS(SVG_NS, 'circle')
  circle.setAttribute('cx', String(GIT_HISTORY_SWIMLANE_WIDTH * (index + 1)))
  circle.setAttribute('cy', String(GIT_HISTORY_SWIMLANE_WIDTH))
  circle.setAttribute('r', String(radius))
  circle.setAttribute('stroke', color)
  circle.setAttribute('stroke-width', String(strokeWidth))
  circle.setAttribute('fill', filled ? color : 'var(--code-git-history-node-bg, #f6f7f3)')
  return circle
}

function drawVerticalLine(x: number, y1: number, y2: number, color: string, strokeWidth = 1) {
  const path = createPath(color, strokeWidth)
  path.setAttribute('d', `M ${x} ${y1} V ${y2}`)
  return path
}

function findLastIndex(nodes: GitHistoryGraphNode[], id: string) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (nodes[index]!.id === id) return index
  }
  return -1
}

export function renderGitHistoryItemGraph(historyItemViewModel: GitHistoryItemViewModel) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.classList.add('code-git-history-graph-svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')

  const { historyItem, inputSwimlanes, outputSwimlanes } = historyItemViewModel
  const inputIndex = inputSwimlanes.findIndex(node => node.id === historyItem.id)
  const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length
  const circleColor = circleIndex < outputSwimlanes.length
    ? outputSwimlanes[circleIndex]!.color
    : circleIndex < inputSwimlanes.length
      ? inputSwimlanes[circleIndex]!.color
      : GIT_HISTORY_HEAD_COLOR

  let outputSwimlaneIndex = 0
  for (let index = 0; index < inputSwimlanes.length; index += 1) {
    const inputNode = inputSwimlanes[index]!
    const color = inputNode.color

    if (inputNode.id === historyItem.id) {
      if (index !== circleIndex) {
        const path = createPath(color)
        path.setAttribute('d', [
          `M ${GIT_HISTORY_SWIMLANE_WIDTH * (index + 1)} 0`,
          `A ${GIT_HISTORY_SWIMLANE_WIDTH} ${GIT_HISTORY_SWIMLANE_WIDTH} 0 0 1 ${GIT_HISTORY_SWIMLANE_WIDTH * index} ${GIT_HISTORY_SWIMLANE_WIDTH}`,
          `H ${GIT_HISTORY_SWIMLANE_WIDTH * (circleIndex + 1)}`,
        ].join(' '))
        svg.append(path)
      } else {
        outputSwimlaneIndex += 1
      }
      continue
    }

    if (
      outputSwimlaneIndex < outputSwimlanes.length
      && inputNode.id === outputSwimlanes[outputSwimlaneIndex]!.id
    ) {
      if (index === outputSwimlaneIndex) {
        svg.append(drawVerticalLine(
          GIT_HISTORY_SWIMLANE_WIDTH * (index + 1),
          0,
          GIT_HISTORY_SWIMLANE_HEIGHT,
          color,
        ))
      } else {
        const path = createPath(color)
        path.setAttribute('d', [
          `M ${GIT_HISTORY_SWIMLANE_WIDTH * (index + 1)} 0`,
          'V 6',
          `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 1 ${(GIT_HISTORY_SWIMLANE_WIDTH * (index + 1)) - SWIMLANE_CURVE_RADIUS} ${GIT_HISTORY_SWIMLANE_HEIGHT / 2}`,
          `H ${(GIT_HISTORY_SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)) + SWIMLANE_CURVE_RADIUS}`,
          `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 0 ${GIT_HISTORY_SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)} ${(GIT_HISTORY_SWIMLANE_HEIGHT / 2) + SWIMLANE_CURVE_RADIUS}`,
          `V ${GIT_HISTORY_SWIMLANE_HEIGHT}`,
        ].join(' '))
        svg.append(path)
      }
      outputSwimlaneIndex += 1
    }
  }

  for (let parentIndex = 1; parentIndex < historyItem.parentIds.length; parentIndex += 1) {
    const parentOutputIndex = findLastIndex(outputSwimlanes, historyItem.parentIds[parentIndex]!)
    if (parentOutputIndex === -1) continue
    const path = createPath(outputSwimlanes[parentOutputIndex]!.color)
    path.setAttribute('d', [
      `M ${GIT_HISTORY_SWIMLANE_WIDTH * parentOutputIndex} ${GIT_HISTORY_SWIMLANE_HEIGHT / 2}`,
      `A ${GIT_HISTORY_SWIMLANE_WIDTH} ${GIT_HISTORY_SWIMLANE_WIDTH} 0 0 1 ${GIT_HISTORY_SWIMLANE_WIDTH * (parentOutputIndex + 1)} ${GIT_HISTORY_SWIMLANE_HEIGHT}`,
      `M ${GIT_HISTORY_SWIMLANE_WIDTH * parentOutputIndex} ${GIT_HISTORY_SWIMLANE_HEIGHT / 2}`,
      `H ${GIT_HISTORY_SWIMLANE_WIDTH * (circleIndex + 1)}`,
    ].join(' '))
    svg.append(path)
  }

  if (inputIndex !== -1) {
    svg.append(drawVerticalLine(
      GIT_HISTORY_SWIMLANE_WIDTH * (circleIndex + 1),
      0,
      GIT_HISTORY_SWIMLANE_HEIGHT / 2,
      inputSwimlanes[inputIndex]!.color,
    ))
  }
  if (historyItem.parentIds.length > 0) {
    svg.append(drawVerticalLine(
      GIT_HISTORY_SWIMLANE_WIDTH * (circleIndex + 1),
      GIT_HISTORY_SWIMLANE_HEIGHT / 2,
      GIT_HISTORY_SWIMLANE_HEIGHT,
      circleColor,
    ))
  }

  if (historyItemViewModel.kind === 'HEAD') {
    svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 3, CIRCLE_STROKE_WIDTH, circleColor))
    svg.append(drawCircle(circleIndex, CIRCLE_STROKE_WIDTH, 1, circleColor, true))
  } else if (historyItem.parentIds.length > 1) {
    svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 2, CIRCLE_STROKE_WIDTH, circleColor))
    svg.append(drawCircle(circleIndex, CIRCLE_RADIUS - 1, CIRCLE_STROKE_WIDTH, circleColor))
  } else {
    svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 1, CIRCLE_STROKE_WIDTH, circleColor))
  }

  const width = GIT_HISTORY_SWIMLANE_WIDTH * (Math.max(inputSwimlanes.length, outputSwimlanes.length, 1) + 1)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(GIT_HISTORY_SWIMLANE_HEIGHT))
  svg.setAttribute('viewBox', `0 0 ${width} ${GIT_HISTORY_SWIMLANE_HEIGHT}`)
  return svg
}

/**
 * Keeps graph lanes visible through expanded change rows. This follows VS Code's
 * renderSCMHistoryGraphPlaceholder helper; Farming only lets the placeholder
 * grow to the measured height of its inline commit details.
 */
export function renderGitHistoryGraphPlaceholder(columns: GitHistoryGraphNode[], height = GIT_HISTORY_SWIMLANE_HEIGHT) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.classList.add('code-git-history-graph-placeholder-svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')

  for (let index = 0; index < columns.length; index += 1) {
    svg.append(drawVerticalLine(
      GIT_HISTORY_SWIMLANE_WIDTH * (index + 1),
      0,
      height,
      columns[index]!.color,
    ))
  }

  const width = GIT_HISTORY_SWIMLANE_WIDTH * (Math.max(columns.length, 1) + 1)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  return svg
}

export const GitHistoryGraph = memo(function GitHistoryGraph({ viewModel }: { viewModel: GitHistoryItemViewModel }) {
  const hostRef = useRef<HTMLSpanElement | null>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.replaceChildren(renderGitHistoryItemGraph(viewModel))
  }, [viewModel])

  return <span ref={hostRef} className="code-git-history-graph" aria-hidden="true" />
})

export const GitHistoryGraphPlaceholder = memo(function GitHistoryGraphPlaceholder({ columns }: { columns: GitHistoryGraphNode[] }) {
  const hostRef = useRef<HTMLSpanElement | null>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    const render = () => {
      const height = Math.max(GIT_HISTORY_SWIMLANE_HEIGHT, Math.round(host.getBoundingClientRect().height))
      host.replaceChildren(renderGitHistoryGraphPlaceholder(columns, height))
    }
    render()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(render)
    observer.observe(host)
    return () => observer.disconnect()
  }, [columns])

  return <span ref={hostRef} className="code-git-history-graph-placeholder" aria-hidden="true" />
})
