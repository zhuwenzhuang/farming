// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyAcpNativeTerminal = applyAcpNativeTerminal;
exports.acpNativeTerminalText = acpNativeTerminalText;
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const MAX_OUTPUT_CHARS = 1024 * 1024;
/** Display-only native terminals never acquire client-terminal process controls. */
function applyAcpNativeTerminal(previous, metadata, replaceOutput) {
    const meta = record(metadata);
    const info = record(meta.terminal_info);
    const output = record(meta.terminal_output ?? meta.terminal_output_delta);
    const exit = record(meta.terminal_exit);
    const old = record(previous);
    const id = old.id || info.terminal_id || output.terminal_id || exit.terminal_id;
    if (typeof id !== 'string' || !id || id.length > 512)
        return null;
    for (const event of [info, output, exit]) {
        if (event.terminal_id !== undefined && event.terminal_id !== id)
            throw new Error('Native terminal identity changed within a tool call');
    }
    const replaces = replaceOutput && meta.terminal_output !== undefined;
    const before = typeof old.output === 'string' ? old.output : '';
    const text = typeof output.data === 'string' ? (replaces ? output.data : before + output.data) : before;
    return {
        id, output: text.slice(-MAX_OUTPUT_CHARS),
        truncated: (replaces ? false : old.truncated === true) || text.length > MAX_OUTPUT_CHARS,
        ...(Object.prototype.hasOwnProperty.call(old, 'exitCode') ? { exitCode: old.exitCode, signal: old.signal } : {}),
        ...(meta.terminal_exit ? {
            exitCode: Number.isInteger(exit.exit_code) ? Number(exit.exit_code) : null,
            signal: typeof exit.signal === 'string' ? exit.signal : null,
        } : {}),
    };
}
function acpNativeTerminalText(value) {
    const terminal = record(value);
    if (typeof terminal.id !== 'string')
        return '';
    const output = typeof terminal.output === 'string' ? terminal.output.trimEnd() : '';
    const exit = Number.isInteger(terminal.exitCode) ? `Exit code: ${terminal.exitCode}`
        : typeof terminal.signal === 'string' && terminal.signal ? `Signal: ${terminal.signal}` : '';
    return [terminal.truncated === true ? '[Earlier terminal output truncated]' : '', output, exit].filter(Boolean).join('\n');
}
