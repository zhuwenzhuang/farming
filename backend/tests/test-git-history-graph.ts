/*
 * Topology cases adapted from VS Code's MIT-licensed SCM history tests at
 * 0217c2f1a0defc7fdbfb4feba74e71e366de6822.
 */

const assert = require('assert');
const {
  GIT_HISTORY_GRAPH_COLORS,
  toGitHistoryItemViewModelArray,
} = require('../../src/lib/git-history-graph.ts');

function item(id, parentIds, references = []) {
  return {
    id,
    displayId: id,
    parentIds,
    subject: '',
    author: '',
    authorEmail: '',
    references,
  };
}

function graphShape(items) {
  return toGitHistoryItemViewModelArray(items).map(viewModel => ({
    input: viewModel.inputSwimlanes.map(node => node.id),
    output: viewModel.outputSwimlanes.map(node => node.id),
    colors: viewModel.outputSwimlanes.map(node => node.color),
  }));
}

function run() {
  assert.deepStrictEqual(toGitHistoryItemViewModelArray([]), []);
  assert.deepStrictEqual(graphShape([item('a', [])]), [{ input: [], output: [], colors: [] }]);

  assert.deepStrictEqual(graphShape([
    item('a', ['b']),
    item('b', ['c']),
    item('c', ['d']),
    item('d', ['e']),
    item('e', []),
  ]), [
    { input: [], output: ['b'], colors: [GIT_HISTORY_GRAPH_COLORS[0]] },
    { input: ['b'], output: ['c'], colors: [GIT_HISTORY_GRAPH_COLORS[0]] },
    { input: ['c'], output: ['d'], colors: [GIT_HISTORY_GRAPH_COLORS[0]] },
    { input: ['d'], output: ['e'], colors: [GIT_HISTORY_GRAPH_COLORS[0]] },
    { input: ['e'], output: [], colors: [] },
  ]);

  assert.deepStrictEqual(graphShape([
    item('a', ['b']),
    item('b', ['c', 'd']),
    item('d', ['c']),
    item('c', ['e']),
    item('e', ['f']),
  ]), [
    { input: [], output: ['b'], colors: [GIT_HISTORY_GRAPH_COLORS[0]] },
    { input: ['b'], output: ['c', 'd'], colors: [GIT_HISTORY_GRAPH_COLORS[0], GIT_HISTORY_GRAPH_COLORS[1]] },
    { input: ['c', 'd'], output: ['c', 'c'], colors: [GIT_HISTORY_GRAPH_COLORS[0], GIT_HISTORY_GRAPH_COLORS[1]] },
    { input: ['c', 'c'], output: ['e'], colors: [GIT_HISTORY_GRAPH_COLORS[0]] },
    { input: ['e'], output: ['f'], colors: [GIT_HISTORY_GRAPH_COLORS[0]] },
  ]);

  assert.deepStrictEqual(graphShape([
    item('a', ['b', 'c']),
    item('c', ['d']),
    item('b', ['e']),
    item('e', ['f']),
    item('f', ['d']),
    item('d', ['g']),
  ]), [
    { input: [], output: ['b', 'c'], colors: [GIT_HISTORY_GRAPH_COLORS[0], GIT_HISTORY_GRAPH_COLORS[1]] },
    { input: ['b', 'c'], output: ['b', 'd'], colors: [GIT_HISTORY_GRAPH_COLORS[0], GIT_HISTORY_GRAPH_COLORS[1]] },
    { input: ['b', 'd'], output: ['e', 'd'], colors: [GIT_HISTORY_GRAPH_COLORS[0], GIT_HISTORY_GRAPH_COLORS[1]] },
    { input: ['e', 'd'], output: ['f', 'd'], colors: [GIT_HISTORY_GRAPH_COLORS[0], GIT_HISTORY_GRAPH_COLORS[1]] },
    { input: ['f', 'd'], output: ['d', 'd'], colors: [GIT_HISTORY_GRAPH_COLORS[0], GIT_HISTORY_GRAPH_COLORS[1]] },
    { input: ['d', 'd'], output: ['g'], colors: [GIT_HISTORY_GRAPH_COLORS[0]] },
  ]);

  assert.deepStrictEqual(graphShape([
    item('a', ['b', 'c']),
    item('c', ['b']),
    item('b', ['d', 'e']),
    item('e', ['f']),
    item('f', ['g']),
    item('d', ['h']),
  ]), [
    { input: [], output: ['b', 'c'], colors: [GIT_HISTORY_GRAPH_COLORS[0], GIT_HISTORY_GRAPH_COLORS[1]] },
    { input: ['b', 'c'], output: ['b', 'b'], colors: [GIT_HISTORY_GRAPH_COLORS[0], GIT_HISTORY_GRAPH_COLORS[1]] },
    { input: ['b', 'b'], output: ['d', 'e'], colors: [GIT_HISTORY_GRAPH_COLORS[0], GIT_HISTORY_GRAPH_COLORS[2]] },
    { input: ['d', 'e'], output: ['d', 'f'], colors: [GIT_HISTORY_GRAPH_COLORS[0], GIT_HISTORY_GRAPH_COLORS[2]] },
    { input: ['d', 'f'], output: ['d', 'g'], colors: [GIT_HISTORY_GRAPH_COLORS[0], GIT_HISTORY_GRAPH_COLORS[2]] },
    { input: ['d', 'g'], output: ['h', 'g'], colors: [GIT_HISTORY_GRAPH_COLORS[0], GIT_HISTORY_GRAPH_COLORS[2]] },
  ]);

  const pageOne = [item('a', ['b', 'c']), item('c', ['d'])];
  const pageOneViewModels = toGitHistoryItemViewModelArray(pageOne, 'a');
  assert.strictEqual(pageOneViewModels[0].kind, 'HEAD');
  assert.deepStrictEqual(pageOneViewModels[1].outputSwimlanes.map(node => node.id), ['b', 'd']);

  const combined = toGitHistoryItemViewModelArray([
    ...pageOne,
    item('b', ['d']),
    item('d', []),
  ], 'a');
  assert.deepStrictEqual(combined[2].inputSwimlanes.map(node => node.id), ['b', 'd']);
  assert.deepStrictEqual(combined[3].inputSwimlanes.map(node => node.id), ['d', 'd']);
  assert.deepStrictEqual(combined[3].outputSwimlanes, []);

  const colored = toGitHistoryItemViewModelArray([
    item('a', ['b'], [{ id: 'refs/heads/main', name: 'main', category: 'local-branch' }]),
  ], undefined, new Map([['refs/heads/main', '#123456']]));
  assert.strictEqual(colored[0].outputSwimlanes[0].color, '#123456');

  console.log('test-git-history-graph passed');
}

run();
