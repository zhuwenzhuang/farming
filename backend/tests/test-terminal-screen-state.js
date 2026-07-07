const assert = require('assert');
const TerminalScreenState = require('../terminal-screen-state');

async function run() {
  const screen = new TerminalScreenState({ cols: 12, rows: 4 });

  try {
    await screen.write('\x1b]0;Claude Code\x07');
    await screen.write('\x1b[1;31mA\x1b[0m \x1b[3;4;38;2;1;2;3;48;5;25mB\x1b[0m');

    const styledState = screen.getState({ includeRenderOutput: false });
    assert.strictEqual(styledState.previewSnapshot.cells[0][0].char, 'A');
    assert.strictEqual(styledState.previewSnapshot.cells[0][0].fg, 1);
    assert.strictEqual(styledState.previewSnapshot.cells[0][0].attributes, 0x01);
    assert.strictEqual(styledState.previewSnapshot.cells[0][2].char, 'B');
    assert.strictEqual(styledState.previewSnapshot.cells[0][2].fg, 0x010203);
    assert.strictEqual(styledState.previewSnapshot.cells[0][2].bg, 25);
    assert.strictEqual(styledState.previewSnapshot.cells[0][2].attributes, 0x06);

    await screen.write('\r\n');
    await screen.write('one\r\ntwo\r\nthree\r\nfour\r\nfive');

    const state = screen.getState();
    assert.strictEqual(state.title, 'Claude Code');
    assert.strictEqual(state.previewText, 'two\nthree\nfour\nfive');
    assert.ok(state.renderOutput.includes('five'));
    assert.ok(state.renderOutput.includes('one'), 'render output should use the configured replay scrollback, not just the viewport');
    assert.strictEqual(state.previewSnapshot.cols, 12);
    assert.strictEqual(state.previewSnapshot.rows, 4);
    assert.strictEqual(state.previewSnapshot.cells.length, 4);
    assert.deepStrictEqual(state.previewSnapshot.cells[0].slice(0, 3), [
      { char: 't', width: 1 },
      { char: 'w', width: 1 },
      { char: 'o', width: 1 },
    ]);

    const resized = screen.resize(12, 3);
    assert.strictEqual(resized.previewText, 'three\nfour\nfive');
    assert.strictEqual(resized.previewSnapshot.rows, 3);

    const cleared = await screen.clearBuffer();
    assert.strictEqual(cleared.previewText, '');
    assert.ok(!cleared.renderOutput.includes('five'), 'cleared render output should not replay old scrollback');
    assert.strictEqual(cleared.previewSnapshot.rows, 3);

    const lfScreen = new TerminalScreenState({ cols: 24, rows: 4 });
    try {
      await lfScreen.write('alpha\nbeta\ngamma');
      const lfState = lfScreen.getState({ includeRenderOutput: false });
      assert.strictEqual(
        lfState.previewText,
        'alpha\nbeta\ngamma',
        'bare LF capture text should start each next line at column zero'
      );
    } finally {
      lfScreen.dispose();
    }

    const textOnlyScreen = new TerminalScreenState({ cols: 24, rows: 4, previewSnapshot: false });
    try {
      await textOnlyScreen.write('light preview');
      const textOnlyState = textOnlyScreen.getState({ includeRenderOutput: false });
      assert.strictEqual(textOnlyState.previewText, 'light preview');
      assert.strictEqual(textOnlyState.previewSnapshot, null);
    } finally {
      textOnlyScreen.dispose();
    }

    const replayScrollbackScreen = new TerminalScreenState({ cols: 40, rows: 4, scrollback: 32 });
    try {
      const lines = Array.from({ length: 20 }, (_unused, index) => `replay-line-${String(index).padStart(2, '0')}`);
      await replayScrollbackScreen.write(lines.join('\r\n'));
      const replayState = replayScrollbackScreen.getState();
      assert.strictEqual(replayState.previewText, 'replay-line-16\nreplay-line-17\nreplay-line-18\nreplay-line-19');
      assert.ok(
        replayState.renderOutput.includes('replay-line-00'),
        'serialized replay output should preserve history older than four viewport heights'
      );
      assert.ok(replayState.renderOutput.includes('replay-line-19'));
    } finally {
      replayScrollbackScreen.dispose();
    }

    console.log('✓ Terminal screen state captures title, viewport preview, styled snapshot, and render output');
  } finally {
    screen.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
