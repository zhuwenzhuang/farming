import assert from 'node:assert/strict'
import test from 'node:test'
import {
  composerCommandTestId,
  findComposerCommandTrigger,
  matchesComposerCommand,
  rankComposerCommand,
} from '../src/components/code/composer-slash-commands'

const commands = [
  { command: '/goal', label: 'Set goal', description: 'Start a goal' },
  { command: '/plan', label: 'Plan first', description: 'Make a plan' },
  { command: '$browser', label: 'Browser control', description: 'Use the browser' },
]

test('finds a command trigger only at the active line prefix', () => {
  assert.deepEqual(findComposerCommandTrigger('  /go', 5), {
    start: 2,
    end: 5,
    query: 'go',
    trigger: '/',
  })
  assert.deepEqual(findComposerCommandTrigger('first\n  /pl', 11), {
    start: 8,
    end: 11,
    query: 'pl',
    trigger: '/',
  })
  assert.equal(findComposerCommandTrigger('keep /goal working', 18), null)
})

test('matches, ranks, and identifies slash and skill commands consistently', () => {
  assert.deepEqual(findComposerCommandTrigger('use $bro', 8), {
    start: 4,
    end: 8,
    query: 'bro',
    trigger: '$',
  })
  assert.equal(matchesComposerCommand(commands[0], 'go', '/'), true)
  assert.equal(matchesComposerCommand(commands[1], 'go', '/'), false)
  assert.equal(matchesComposerCommand(commands[2], 'browser', '$'), true)
  assert.equal(rankComposerCommand(commands[0], 'go'), 0)
  assert.equal(rankComposerCommand(commands[0], 'set'), 1)
  assert.equal(composerCommandTestId('$browser.control'), 'code-slash-command-browser-control')
})
