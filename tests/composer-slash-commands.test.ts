import assert from 'node:assert/strict'
import test from 'node:test'
import {
  composerCommandGroup,
  composerCommandTestId,
  findComposerCommandTrigger,
  matchesComposerCommand,
  rankComposerCommand,
} from '../src/components/code/composer-slash-commands'

const goalCommand = { command: '/goal', label: 'Set goal', description: 'Start a goal', source: 'custom' as const }
const planCommand = { command: '/plan', label: 'Plan first', description: 'Make a plan', source: 'custom' as const }
const browserCommand = { command: '$browser', label: 'Browser control', description: 'Use the browser', source: 'skill' as const }

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
  assert.equal(matchesComposerCommand(goalCommand, 'go', '/'), true)
  assert.equal(matchesComposerCommand(planCommand, 'go', '/'), false)
  assert.equal(matchesComposerCommand(browserCommand, 'browser', '$'), true)
  assert.equal(matchesComposerCommand(browserCommand, 'browser', '/'), true)
  assert.equal(matchesComposerCommand(goalCommand, 'goal', '$'), false)
  assert.equal(findComposerCommandTrigger('email@example.com', 17), null)
  assert.equal(findComposerCommandTrigger('echo $HOME', 10), null)
  assert.deepEqual(findComposerCommandTrigger('请用（$翻译', 6), {
    start: 3, end: 6, query: '翻译', trigger: '$',
  })
  assert.equal(composerCommandGroup(browserCommand), 'Skills')
  assert.equal(composerCommandGroup({ ...goalCommand, source: 'farming' }), 'Farming actions')
  assert.equal(rankComposerCommand(goalCommand, 'go'), 0)
  assert.equal(rankComposerCommand(goalCommand, 'set'), 1)
  assert.equal(composerCommandTestId('$browser.control'), 'code-slash-command-browser-control')
})
