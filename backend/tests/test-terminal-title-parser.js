const assert = require('assert');
const { extractLatestTerminalTitle } = require('../local-session-engine');

(() => {
  assert.strictEqual(extractLatestTerminalTitle('plain output'), null);
  assert.strictEqual(
    extractLatestTerminalTitle('\x1b]0;Claude Code\x07'),
    'Claude Code'
  );
  assert.strictEqual(
    extractLatestTerminalTitle('\x1b]2;Fix lint errors\x07'),
    'Fix lint errors'
  );
  assert.strictEqual(
    extractLatestTerminalTitle('\x1b]2;Old\x07...\x1b]0;New title\x07'),
    'New title'
  );

  console.log('✓ terminal title parser extracts the latest OSC title');
})();
