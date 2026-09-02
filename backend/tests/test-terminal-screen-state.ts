const assert = require('assert');
const { Terminal } = require('@xterm/headless');
const { TerminalScreenState } = require('../terminal-screen-state.cjs');

function mouseEncoding(terminal) {
  return terminal._core?.coreMouseService?.activeEncoding || '';
}

async function run() {
  const screen = new TerminalScreenState({ cols: 12, rows: 4 });

  try {
    await screen.write('\x1b]0;Claude Code\x07');
    await screen.write('\x1b[1;31mA\x1b[0m \x1b[3;4;38;2;1;2;3;48;5;25mB\x1b[0m');

    const styledState = screen.getState({ includeRenderOutput: false });
    assert.strictEqual(styledState.previewSnapshot.cursorVisible, true);
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

    const hiddenCursorScreen = new TerminalScreenState({ cols: 12, rows: 4 });
    try {
      await hiddenCursorScreen.write('painted cursor\x1b[?25l');
      const hiddenState = hiddenCursorScreen.getState();
      assert.strictEqual(hiddenState.previewSnapshot.cursorVisible, false);
      assert.ok(hiddenState.renderOutput.endsWith('\x1b[?25l'));

      await hiddenCursorScreen.write('\x1b[?25h');
      const visibleState = hiddenCursorScreen.getState();
      assert.strictEqual(visibleState.previewSnapshot.cursorVisible, true);
      assert.ok(visibleState.renderOutput.endsWith('\x1b[?25h'));
    } finally {
      hiddenCursorScreen.dispose();
    }

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

    const defaultScrollbackScreen = new TerminalScreenState({ cols: 40, rows: 4 });
    try {
      const lines = Array.from(
        { length: 5200 },
        (_unused, index) => `recovery-line-${String(index).padStart(4, '0')}`,
      );
      await defaultScrollbackScreen.write(lines.join('\r\n'));
      const shallowScrollbackState = defaultScrollbackScreen.getState({ scrollback: 200 });
      assert.ok(!shallowScrollbackState.renderOutput.includes('recovery-line-4995'));
      assert.ok(shallowScrollbackState.renderOutput.includes('recovery-line-4996'));
      assert.strictEqual(shallowScrollbackState.renderedScrollback, 200);
      assert.strictEqual(shallowScrollbackState.scrollbackAvailable, 5000);
      const defaultScrollbackState = defaultScrollbackScreen.getState();
      assert.ok(!defaultScrollbackState.renderOutput.includes('recovery-line-0195'));
      assert.ok(defaultScrollbackState.renderOutput.includes('recovery-line-0196'));
      assert.ok(defaultScrollbackState.renderOutput.includes('recovery-line-5199'));
    } finally {
      defaultScrollbackScreen.dispose();
    }

    const mouseScreen = new TerminalScreenState({ cols: 40, rows: 8 });
    try {
      await mouseScreen.write('\x1b[?1049h\x1b[?1002h\x1b[?1006hQwen Code');
      const mouseState = mouseScreen.getState();
      assert.ok(mouseState.renderOutput.includes('\x1b[?1002h'));
      assert.ok(mouseState.renderOutput.includes('\x1b[?1006h'));

      const restored = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
      try {
        await new Promise((resolve) => restored.write(mouseState.renderOutput, resolve));
        assert.strictEqual(restored.modes.mouseTrackingMode, 'drag');
        assert.strictEqual(mouseEncoding(restored), 'SGR');
      } finally {
        restored.dispose();
      }

      await mouseScreen.write('\x1b[?1006l');
      const defaultMouseState = mouseScreen.getState();
      assert.ok(!defaultMouseState.renderOutput.includes('\x1b[?1006h'));
    } finally {
      mouseScreen.dispose();
    }

    console.log('✓ Terminal screen state captures title, viewport preview, styled snapshot, render output, and mouse encoding');
  } finally {
    screen.dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
