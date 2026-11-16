import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { TerminalCwdHistory, terminalCwdSequence } from '../shared/terminal-cwd'

const write = (terminal: Terminal, text: string) => new Promise<void>(resolve => terminal.write(text, resolve))
test('cwd follows each output range across trim, reflow and checkpoints', async t => {
  const terminal = new Terminal({ allowProposedApi: true, cols: 20, rows: 4, scrollback: 6 })
  const history = new TerminalCwdHistory(terminal)
  const addon = new SerializeAddon()
  terminal.loadAddon(addon)
  t.after(() => { history.dispose(); terminal.dispose() })
  assert.equal(history.atLine(0), undefined)
  await write(terminal, terminalCwdSequence('/project/one') + 'first.txt\r\n')
  await write(terminal, terminalCwdSequence('/project/two') + 'second.txt\r\n')
  assert.equal(history.atLine(0), '/project/one')
  assert.equal(history.atLine(1), '/project/two')
  terminal.resize(10, 4)
  assert.equal(history.atLine(0), '/project/one')
  assert.equal(history.atLine(1), '/project/two')
  const restored = new Terminal({ allowProposedApi: true, cols: 10, rows: 4, scrollback: 6 })
  const restoredHistory = new TerminalCwdHistory(restored)
  t.after(() => { restoredHistory.dispose(); restored.dispose() })
  await write(restored, addon.serialize({ scrollback: 6 }) + history.serialize(6))
  assert.equal(restoredHistory.atLine(0), '/project/one')
  assert.equal(restoredHistory.atLine(1), '/project/two')
  await write(terminal, '\r\n'.repeat(12))
  assert.equal(history.atLine(0), '/project/two', 'trim retains the cwd covering the surviving lines')
  history.clear()
  assert.equal(history.atLine(0), undefined)
})

test('dropping bounded cwd history never assigns a newer directory to old output', async t => {
  const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 4, scrollback: 300 })
  const history = new TerminalCwdHistory(terminal)
  t.after(() => { history.dispose(); terminal.dispose() })
  for (let index = 0; index < 140; index++) await write(terminal, terminalCwdSequence(`/dir/${index}`) + 'file.txt\r\n')
  assert.equal(history.atLine(0), undefined)
  assert.equal(history.atLine(139), '/dir/139')
})

test('checkpoint inside an alternate-screen application restores normal-buffer cwd history', async t => {
  const source = new Terminal({ allowProposedApi: true, cols: 30, rows: 4 })
  const restored = new Terminal({ allowProposedApi: true, cols: 30, rows: 4 })
  const history = new TerminalCwdHistory(source)
  const restoredHistory = new TerminalCwdHistory(restored)
  const addon = new SerializeAddon()
  source.loadAddon(addon)
  t.after(() => { history.dispose(); restoredHistory.dispose(); source.dispose(); restored.dispose() })
  await write(source, terminalCwdSequence('/first') + 'old.md\r\n' + terminalCwdSequence('/second') + '\x1b[?1049hTUI')
  await write(restored, history.checkpoint(addon.serialize(), 100))
  assert.equal(restoredHistory.atLine(0), undefined)
  await write(restored, '\x1b[?1049l')
  assert.equal(restoredHistory.atLine(0), '/first')
  assert.equal(restoredHistory.atLine(1), '/second')
})
