import assert from 'node:assert/strict'
import test from 'node:test'
import type { FarmingTerminal } from '../src/lib/terminal-engine'
import { TerminalSelectionController } from '../src/lib/terminal-selection'

function line(text: string, isWrapped = false) {
  return {
    length: text.length,
    isWrapped,
    getCell: (col: number) => ({
      getChars: () => text[col] || '',
      getWidth: () => 1,
    }),
  }
}

function createHarness(lines = [line('$hello world')]) {
  let selection = ''
  let selected: { col: number; row: number; length: number } | null = null
  const terminal = {
    cols: 12,
    rows: 1,
    viewportY: 0,
    buffer: {
      active: {
        length: lines.length,
        getLine: (row: number) => lines[row],
      },
    },
    select(col: number, row: number, length: number) {
      selected = { col, row, length }
      selection = lines[row]
        ? Array.from({ length }, (_, index) => lines[row]?.getCell(col + index).getChars()).join('')
        : ''
    },
    getSelection: () => selection,
  } as unknown as FarmingTerminal
  const hostEl = { contains: () => false } as unknown as HTMLElement
  const controller = new TerminalSelectionController({
    terminal,
    hostEl,
    cellMetrics: () => ({ width: 10, height: 20 }),
    screenRect: () => ({ left: 0, right: 120, top: 0, bottom: 20 }) as DOMRect,
  })
  return {
    controller,
    get selected() { return selected },
  }
}

test('selection owner expands one continuous word without absorbing a prompt marker', () => {
  const harness = createHarness()
  assert.equal(harness.controller.selectContinuousTextAtCell(2, 0), 'hello')
  assert.deepEqual(harness.selected, { col: 1, row: 0, length: 5 })
  assert.equal(harness.controller.cachedSelection, 'hello')
  assert.equal(harness.controller.lastNonEmptySelection, 'hello')
})

test('selection owner fences drag identity and projects wrapped logical lines', () => {
  const harness = createHarness([line('hello '), line('world', true)])
  const down = {
    button: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    clientX: 5,
    clientY: 5,
  } as MouseEvent
  let prevented = 0
  const move = {
    ...down,
    clientX: 25,
    preventDefault: () => { prevented += 1 },
    stopPropagation: () => {},
  } as MouseEvent
  assert.equal(harness.controller.startDrag(down, false), true)
  assert.equal(harness.controller.updateDrag(move), true)
  assert.equal(harness.controller.finishDrag(move), true)
  assert.equal(prevented, 2)
  assert.equal(harness.controller.hasDrag(), false)
  assert.equal(harness.controller.logicalLineAtBufferRow(1)?.text, 'hello world')
})
