const assert = require('assert');
const { TerminalNotificationParser } = require('../terminal-notification-parser.cjs');

const parser = new TerminalNotificationParser();

assert.deepStrictEqual(parser.push('plain\x07text'), [
  { method: 'bel', title: '', message: '' },
]);
assert.deepStrictEqual(parser.push('\x1b]9;Agent turn complete\x07'), [
  { method: 'osc9', title: '', message: 'Agent turn complete' },
]);
assert.deepStrictEqual(parser.push('\x1b]9;4;1;50\x07'), [], 'OSC 9;4 is terminal progress, not a notification');
assert.deepStrictEqual(parser.push('\x1b]0;title update\x07'), [], 'an OSC terminator BEL is not a standalone bell');
assert.deepStrictEqual(parser.push('\x1b]777;notify;Codex;Ready to review\x1b\\'), [
  { method: 'osc777', title: 'Codex', message: 'Ready to review' },
]);
assert.deepStrictEqual(parser.push(
  '\x1b]99;i=opentui-1:p=title:e=1:d=0;b3BlbmNvZGU=\x1b\\'
  + '\x1b]99;i=opentui-1:p=body:e=1:d=1;U2Vzc2lvbiBjb21wbGV0ZQ==\x1b\\',
), [
  { method: 'osc99', title: 'opencode', message: 'Session complete' },
], 'OpenTUI completion notifications use Kitty OSC 99 title/body payloads');
assert.deepStrictEqual(parser.push(
  '\x1b]99;i=42:d=0:p=title:e=1;UXdlbiBDb2Rl\x1b\\'
  + '\x1b]99;i=42:p=body:e=1;UmVhZHkgdG8gcmV2aWV3\x1b\\'
  + '\x1b]99;i=42:d=1:a=focus;\x1b\\',
), [
  { method: 'osc99', title: 'Qwen Code', message: 'Ready to review' },
], 'Qoder/Qwen completion notifications finish with a separate Kitty OSC 99 activation payload');
assert.deepStrictEqual(parser.push('\x1b]9;split '), []);
assert.deepStrictEqual(parser.push('message\x07'), [
  { method: 'osc9', title: '', message: 'split message' },
]);
assert.deepStrictEqual(parser.push('\x1bPtmux;\x1b\x1b]9;wrapped\x07\x1b\\'), [
  { method: 'osc9', title: '', message: 'wrapped' },
]);

console.log('terminal notification parser tests passed');
