// Native-PTY fixture: raw multiline bursts remain drafts; bracketed paste plus
// Enter admits one prompt and materializes the history needed for runtime switching.
const fs = require('node:fs');
const path = require('node:path');
const { sessionId } = JSON.parse(fs.readFileSync('.farming-handoff-fixture.json', 'utf8'));
const pasteStart = '\x1b[200~';
const pasteEnd = '\x1b[201~';
let input = '';
let draft = '';
let pasted = false;
let insidePaste = false;

function idle() {
  process.stdout.write('\r\n› \r\n\r\ngpt-5.6-terra medium · ~/workspace\r\n');
}

function submit() {
  if (draft === '/status') {
    process.stdout.write(`OpenAI Codex (v0.142.3)\r\n  Model: gpt-5.6-terra (reasoning medium)\r\n  Directory: ~/workspace\r\n  Session: ${sessionId}\r\n`);
  } else if (draft && pasted) {
    // Hold a real provider busy phase until the test observes it through inventory.
    process.stdout.write('\x1b]0;⠙ Reading handoff\x07\r\nWorking · esc to interrupt\r\n');
    const completion = '.farming-handoff-turn-complete';
    const watcher = fs.watch('.', (_event, filename) => {
      if (String(filename) !== completion || !fs.existsSync(completion)) return;
      watcher.close();
      process.stdout.write('\x1b]0;Handoff complete\x07Handoff prompt submitted once. Waiting for instructions.\r\n');
      idle();
    });
    fs.appendFileSync('handoff-prompts.jsonl', JSON.stringify(draft) + '\n');
    const sessions = path.join(process.env.CODEX_HOME, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, `rollout-${sessionId}.jsonl`), JSON.stringify({
      type: 'session_meta', payload: { id: sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() },
    }) + '\n');
    draft = '';
    pasted = false;
    return;
  }
  draft = '';
  pasted = false;
  idle();
}

process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\x1b[?25l\x1b[?25hFake Codex handoff ready\r\n');
idle();
process.stdin.on('data', chunk => {
  // Model a CLI paste-burst guard: Enter in an unframed multiline burst belongs
  // to the draft rather than submitting it. This is the pre-fix failure.
  if (!insidePaste && !input && !chunk.includes(pasteStart) && chunk.includes('\n')) {
    draft += chunk;
    return;
  }
  input += chunk;
  while (input) {
    const marker = insidePaste ? pasteEnd : pasteStart;
    if (marker.startsWith(input) && input.length < marker.length) return;
    if (input.startsWith(marker)) {
      insidePaste = !insidePaste;
      pasted = true;
      input = input.slice(marker.length);
      continue;
    }
    const char = input[0];
    input = input.slice(1);
    if (!insidePaste && char === '\r') submit();
    else draft += char;
  }
});
