import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const {
  sanitizeLanguageServerResult,
} = require('../../extensions/language-server/backend/language-server-router.cjs');

function run() {
  const iconGlyphsSource = fs.readFileSync(path.join(__dirname, '../../src/components/IconGlyphs.tsx'), 'utf8');
  const pluginsPanelSource = fs.readFileSync(path.join(__dirname, '../../src/components/code/PluginsPanel.tsx'), 'utf8');
  assert.ok(
    iconGlyphsSource.includes('export function LanguageServerGlyph')
      && iconGlyphsSource.includes('M9.80307 3.0431C10.0554 3.15525')
      && pluginsPanelSource.includes('<LanguageServerGlyph />'),
    'The Language Server plugin card should use its dedicated code glyph',
  );
  assert.ok(
    pluginsPanelSource.includes('languageServerReady')
      && pluginsPanelSource.includes('languageServerHasActiveConnections')
      && pluginsPanelSource.includes('code-plugin-language-server-connections'),
    'The Language Server plugin card should distinguish idle readiness from active project connections',
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-language-server-'));
  try {
    const workspaceInput = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceInput, { recursive: true });
    const workspace = fs.realpathSync(workspaceInput);
    const sourceFile = path.join(workspace, 'src', 'main.ts');
    const outsideFile = path.join(tempDir, 'private.txt');
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, 'export const value = 1;\n');
    fs.writeFileSync(outsideFile, 'private\n');

    assert.deepStrictEqual(sanitizeLanguageServerResult(workspace, {
      selectionRange: null,
      nested: {
        value: null,
        items: [
          null,
          { uri: pathToFileURL(sourceFile).toString(), selectionRange: null },
          { uri: pathToFileURL(outsideFile).toString(), selectionRange: null },
        ],
      },
    }), {
      selectionRange: null,
      nested: {
        value: null,
        items: [
          null,
          { path: 'src/main.ts', selectionRange: null },
        ],
      },
    });

    assert.deepStrictEqual(sanitizeLanguageServerResult(workspace, [{
      item: {
        uri: pathToFileURL(outsideFile).toString(),
        selectionRange: null,
      },
      ranges: [],
    }, {
      item: {
        uri: pathToFileURL(sourceFile).toString(),
        selectionRange: null,
      },
      ranges: [],
    }]), [{
      item: {
        path: 'src/main.ts',
        selectionRange: null,
      },
      ranges: [],
    }]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  assert.strictEqual(fs.existsSync(tempDir), false, 'the test must remove its exact temporary directory');
  console.log('Language Server extension regression test passed.');
}

run();
