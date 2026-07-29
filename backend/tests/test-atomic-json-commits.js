const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { atomicWriteJson } = require('../atomic-json-store.cjs');
const ConfigManager = require('../config-manager');
const { ReviewSessionStore } = require('../review-session-store.cjs');
const { ReviewStateStore } = require('../review-state-store.cjs');
const { RunHistoryStore } = require('../run-history-store.cjs');

function failingFileSystem(method) {
  return new Proxy(fs, {
    get(target, property) {
      if (property === method) {
        return () => {
          throw new Error(`simulated ${method} failure`);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function temporaryFiles(directory, baseName) {
  return fs.readdirSync(directory).filter(name => name.startsWith(`${baseName}.`) && name.endsWith('.tmp'));
}

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-atomic-json-'));
  try {
    const target = path.join(root, 'state.json');
    atomicWriteJson(target, { value: 'before' }, { mode: 0o600 });
    const originalBytes = fs.readFileSync(target, 'utf8');
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);

    for (const method of ['writeFileSync', 'fdatasyncSync', 'renameSync']) {
      assert.throws(
        () => atomicWriteJson(target, { value: 'after' }, { fileSystem: failingFileSystem(method), mode: 0o600 }),
        new RegExp(`simulated ${method} failure`),
      );
      assert.strictEqual(fs.readFileSync(target, 'utf8'), originalBytes, `${method} failure must preserve the committed file`);
      assert.deepStrictEqual(temporaryFiles(root, 'state.json'), [], `${method} failure must clean its temporary file`);
    }

    let failWrites = false;
    const writeJson = (file, value) => {
      if (failWrites) throw new Error('simulated snapshot commit failure');
      atomicWriteJson(file, value);
    };

    const historyDir = path.join(root, 'history-store');
    const historyStore = new RunHistoryStore(historyDir, { writeJson });
    historyStore.init();
    historyStore.appendEntry({ id: 'committed' });
    const historyFile = path.join(historyDir, 'history', 'runs.json');
    const historyBytes = fs.readFileSync(historyFile, 'utf8');
    failWrites = true;
    assert.throws(() => historyStore.appendEntry({ id: 'uncommitted' }), /snapshot commit failure/);
    assert.deepStrictEqual(historyStore.getEntries(), [{ id: 'committed' }]);
    assert.strictEqual(fs.readFileSync(historyFile, 'utf8'), historyBytes);

    failWrites = false;
    const reviewDir = path.join(root, 'review-store');
    const reviewId = 'review-11111111111111111111111111111111';
    const firstTree = 'a'.repeat(40);
    const secondTree = 'b'.repeat(40);
    const reviewStore = new ReviewSessionStore(reviewDir, { writeJson });
    reviewStore.create({
      base: 'c'.repeat(40),
      createdAt: '2026-07-26T00:00:00.000Z',
      id: reviewId,
      root,
      tree: firstTree,
    });
    const reviewFile = path.join(reviewDir, 'history', 'review-sessions.json');
    const reviewBytes = fs.readFileSync(reviewFile, 'utf8');
    failWrites = true;
    assert.throws(
      () => reviewStore.appendRevision(reviewId, secondTree, '2026-07-26T00:01:00.000Z'),
      /snapshot commit failure/,
    );
    assert.strictEqual(reviewStore.get(reviewId).revisions.length, 1);
    assert.strictEqual(fs.readFileSync(reviewFile, 'utf8'), reviewBytes);

    failWrites = false;
    const reviewStateDir = path.join(root, 'review-state-store');
    const reviewStateStore = new ReviewStateStore(reviewStateDir, { writeJson });
    reviewStateStore.setFileReviewedGerrit({
      patchset: 'revision-1',
      path: 'src/committed.ts',
      reviewId: 'review-state',
      reviewed: true,
    });
    const reviewStateFile = path.join(reviewStateDir, 'history', 'review-state.json');
    const reviewStateBytes = fs.readFileSync(reviewStateFile, 'utf8');
    failWrites = true;
    assert.throws(() => reviewStateStore.setFileReviewedGerrit({
      patchset: 'revision-1',
      path: 'src/uncommitted.ts',
      reviewId: 'review-state',
      reviewed: true,
    }), /snapshot commit failure/);
    assert.deepStrictEqual(
      reviewStateStore.getPatchsetState('review-state', 'revision-1').reviewedPaths,
      ['src/committed.ts'],
    );
    assert.strictEqual(fs.readFileSync(reviewStateFile, 'utf8'), reviewStateBytes);

    failWrites = false;
    const configDir = path.join(root, 'config-manager');
    const configManager = new ConfigManager({ configDir, writeJson });
    configManager.init();
    configManager.updateSettings({ appearance: 'dark' });
    const settingsFile = path.join(configDir, 'settings.json');
    const settingsBytes = fs.readFileSync(settingsFile, 'utf8');
    const settingsBeforeFailure = configManager.getSettings();
    failWrites = true;
    assert.throws(() => configManager.updateSettings({ appearance: 'light' }), /snapshot commit failure/);
    assert.deepStrictEqual(configManager.getSettings(), settingsBeforeFailure);
    assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), settingsBytes);
    assert.throws(() => configManager.setProjectName(root, 'Uncommitted name'), /snapshot commit failure/);
    assert.deepStrictEqual(configManager.getSettings(), settingsBeforeFailure);
    assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), settingsBytes);

    console.log('test-atomic-json-commits passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run();
