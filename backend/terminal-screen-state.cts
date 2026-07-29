import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

const ATTR_BOLD = 0x01;
const ATTR_ITALIC = 0x02;
const ATTR_UNDERLINE = 0x04;
const ATTR_DIM = 0x08;
const ATTR_INVERSE = 0x10;
const ATTR_INVISIBLE = 0x20;
const ATTR_STRIKETHROUGH = 0x40;

interface TerminalScreenStateOptions {
  cols?: number;
  previewSnapshot?: boolean;
  rows?: number;
  scrollback?: number;
}

interface TerminalScreenReadOptions {
  includeRenderOutput?: boolean;
  refreshPreview?: boolean;
}

interface TerminalSnapshotCell {
  attributes?: number;
  bg?: number;
  char: string;
  fg?: number;
  width: number;
}

interface TerminalViewportSnapshot {
  cells: TerminalSnapshotCell[][];
  cols: number;
  cursorVisible: boolean;
  cursorX: number;
  cursorY: number;
  rows: number;
  viewportY: number;
}

interface TerminalScreenSnapshot {
  cols: number;
  previewSnapshot: TerminalViewportSnapshot | null;
  previewText: string;
  renderOutput: string;
  rows: number;
  title: string;
}

interface TerminalWithPrivateCore extends Terminal {
  _core?: {
    coreService?: {
      isCursorHidden?: boolean;
    };
  };
}

function collectViewportText(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines = [];

  for (let y = buffer.viewportY; y < buffer.viewportY + terminal.rows; y += 1) {
    const line = buffer.getLine(y);
    lines.push(line ? line.translateToString(true) : '');
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}

function collectViewportSnapshot(terminal: Terminal): TerminalViewportSnapshot {
  const buffer = terminal.buffer.active;
  const fallbackCell = buffer.getNullCell();
  const cells = [];

  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    const rowCells: TerminalSnapshotCell[] = [];

    for (let col = 0; col < terminal.cols; col += 1) {
      const cell = line ? line.getCell(col, fallbackCell) : fallbackCell;
      if (!cell) continue;

      const width = cell.getWidth ? cell.getWidth() : 1;
      if (width === 0) continue;

      let attributes = 0;
      if (cell.isBold && cell.isBold()) attributes |= ATTR_BOLD;
      if (cell.isItalic && cell.isItalic()) attributes |= ATTR_ITALIC;
      if (cell.isUnderline && cell.isUnderline()) attributes |= ATTR_UNDERLINE;
      if (cell.isDim && cell.isDim()) attributes |= ATTR_DIM;
      if (cell.isInverse && cell.isInverse()) attributes |= ATTR_INVERSE;
      if (cell.isInvisible && cell.isInvisible()) attributes |= ATTR_INVISIBLE;
      if (cell.isStrikethrough && cell.isStrikethrough()) attributes |= ATTR_STRIKETHROUGH;

      const bufferCell: TerminalSnapshotCell = {
        char: cell.getChars ? (cell.getChars() || ' ') : ' ',
        width,
      };

      const fg = cell.getFgColor ? cell.getFgColor() : -1;
      const bg = cell.getBgColor ? cell.getBgColor() : -1;

      if (Number.isFinite(fg) && fg >= 0) {
        bufferCell.fg = fg;
      }

      if (Number.isFinite(bg) && bg >= 0) {
        bufferCell.bg = bg;
      }

      if (attributes !== 0) {
        bufferCell.attributes = attributes;
      }

      rowCells.push(bufferCell);
    }

    let lastNonBlankCell = rowCells.length - 1;
    while (lastNonBlankCell >= 0) {
      const cell = rowCells[lastNonBlankCell];
      if (
        cell.char !== ' ' ||
        cell.fg !== undefined ||
        cell.bg !== undefined ||
        cell.attributes !== undefined
      ) {
        break;
      }
      lastNonBlankCell -= 1;
    }

    if (lastNonBlankCell < rowCells.length - 1) {
      rowCells.splice(Math.max(1, lastNonBlankCell + 1));
    }

    if (rowCells.length === 0) {
      rowCells.push({ char: ' ', width: 1 });
    }

    cells.push(rowCells);
  }

  return {
    cols: terminal.cols,
    rows: terminal.rows,
    viewportY: buffer.viewportY,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    cursorVisible: getTerminalCursorVisible(terminal),
    cells,
  };
}

function getTerminalCursorVisible(terminal: Terminal): boolean {
  // xterm does not currently expose DECTCEM through its public buffer API.
  // The headless core still tracks it, and replay must preserve it to avoid
  // showing xterm's cursor on top of a TUI-rendered cursor.
  const privateTerminal = terminal as TerminalWithPrivateCore;
  const isCursorHidden = privateTerminal._core?.coreService
    ? privateTerminal._core.coreService.isCursorHidden
    : false;
  return isCursorHidden !== true;
}

class TerminalScreenState {
  private readonly includePreviewSnapshot: boolean;
  private readonly scrollback: number;
  private readonly serializeAddon: SerializeAddon;
  private readonly terminal: Terminal;
  private pendingWrite: Promise<TerminalScreenSnapshot>;
  private previewDirty: boolean;
  private previewSnapshot: TerminalViewportSnapshot | null;
  private previewText: string;
  private renderOutput: string;
  private renderOutputDirty: boolean;
  private title: string;

  constructor(options: TerminalScreenStateOptions = {}) {
    const cols = options.cols || 80;
    const rows = options.rows || 30;
    const scrollback = options.scrollback || rows * 8;
    this.scrollback = scrollback;
    this.includePreviewSnapshot = options.previewSnapshot !== false;

    this.terminal = new Terminal({
      cols,
      rows,
      scrollback,
      allowProposedApi: true,
      convertEol: true,
    });
    this.serializeAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeAddon);

    this.title = '';
    this.renderOutput = '';
    this.previewText = '';
    this.previewSnapshot = null;
    this.previewDirty = false;
    this.renderOutputDirty = true;
    this.pendingWrite = Promise.resolve({
      cols,
      rows,
      renderOutput: '',
      previewText: '',
      previewSnapshot: null,
      title: '',
    });

    this.terminal.onTitleChange((title) => {
      this.title = title || '';
    });

    this.refreshPreview();
  }

  private refreshPreview(): void {
    this.previewText = collectViewportText(this.terminal);
    this.previewSnapshot = this.includePreviewSnapshot
      ? collectViewportSnapshot(this.terminal)
      : null;
    this.previewDirty = false;
    this.renderOutputDirty = true;
  }

  private refreshRenderOutput(): void {
    const serialized = this.serializeAddon.serialize({
      scrollback: this.scrollback,
    });
    // SerializeAddon preserves screen contents and most terminal modes, but it
    // omits DECTCEM (CSI ? 25 h/l). Make the cursor state explicit so a fresh
    // browser terminal does not fall back to its visible-cursor default.
    this.renderOutput = `${serialized}\x1b[?25${getTerminalCursorVisible(this.terminal) ? 'h' : 'l'}`;
    this.renderOutputDirty = false;
  }

  refresh(options: TerminalScreenReadOptions = {}): TerminalScreenSnapshot {
    const includeRenderOutput = options.includeRenderOutput !== false;
    this.refreshPreview();
    if (includeRenderOutput) {
      this.refreshRenderOutput();
    }

    return this.getState(options);
  }

  async write(data: string): Promise<TerminalScreenSnapshot> {
    this.pendingWrite = this.pendingWrite.then(
      () =>
        new Promise<TerminalScreenSnapshot>((resolve) => {
          this.terminal.write(data, () => {
            this.previewDirty = true;
            this.renderOutputDirty = true;
            resolve(this.getState({
              includeRenderOutput: false,
              refreshPreview: false,
            }));
          });
        }),
    );

    return this.pendingWrite;
  }

  resize(cols: number, rows: number): TerminalScreenSnapshot {
    this.terminal.resize(cols, rows);
    return this.refresh({ includeRenderOutput: false });
  }

  async clearBuffer(): Promise<TerminalScreenSnapshot> {
    this.pendingWrite = this.pendingWrite.then(
      () =>
        new Promise<TerminalScreenSnapshot>((resolve) => {
          this.terminal.write('\x1b[2J\x1b[3J\x1b[H', () => {
            this.refreshPreview();
            resolve(this.getState({ includeRenderOutput: true }));
          });
        }),
    );

    return this.pendingWrite;
  }

  getState(options: TerminalScreenReadOptions = {}): TerminalScreenSnapshot {
    const includeRenderOutput = options.includeRenderOutput !== false;
    if (options.refreshPreview !== false && this.previewDirty) {
      this.refreshPreview();
    }
    if (includeRenderOutput && this.renderOutputDirty) {
      this.refreshRenderOutput();
    }

    return {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      renderOutput: includeRenderOutput ? this.renderOutput : '',
      previewText: this.previewText,
      previewSnapshot: this.previewSnapshot,
      title: this.title,
    };
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

export {
  TerminalScreenState,
  collectViewportSnapshot,
  collectViewportText,
  getTerminalCursorVisible,
};

export type {
  TerminalScreenSnapshot,
  TerminalViewportSnapshot,
};
