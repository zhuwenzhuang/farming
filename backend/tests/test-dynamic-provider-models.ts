import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listClaudeModelOptions, parseClaudeModels } from '../claude-models.cjs';

async function main() {
  assert.deepEqual(parseClaudeModels([{ value: 'future', supportedEffortLevels: ['new-effort'] }])[0].reasoningLevels.map(option => option.value), ['new-effort']);
  assert.deepEqual(parseClaudeModels([{ value: 'plain' }])[0].reasoningLevels, []);
  assert.throws(() => parseClaudeModels([]), /no models/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-dynamic-models-'));
  const executable = path.join(root, 'provider');
  try {
    fs.writeFileSync(executable, `#!${process.execPath}
const args = process.argv.slice(2);
  if (!args.includes('--no-session-persistence') || !args.includes('--verbose')) process.exit(7);
  process.stdin.once('data', line => {
    const request = JSON.parse(line);
    if (request.request.subtype !== 'initialize') process.exit(6);
    if (process.env.CLAUDE_CONFIG_DIR === 'hang') return;
    if (process.env.CLAUDE_CONFIG_DIR === 'unicode') {
      const response = Buffer.from(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models:[{value:'unicode',displayName:'模型',description:'多语言'}]}}})+'\\n');
      const split = response.indexOf(Buffer.from('模')) + 1;
      process.stdout.write(response.subarray(0,split));
      setTimeout(()=>process.stdout.write(response.subarray(split)),30); return;
    }
    const models = process.env.CLAUDE_CONFIG_DIR === 'empty' ? [] : [{value:process.env.CLAUDE_CONFIG_DIR, supportedEffortLevels:['future']}];
    console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models}}}));
  });
`, { mode: 0o755 });
    // Successful discovery includes process startup under parallel test load.
    // Keep the deliberate timeout case short without timing normal startup.
    const readClaude = (home: string, timeoutMs = 5_000) => listClaudeModelOptions({
      executable, env: { ...process.env, CLAUDE_CONFIG_DIR: home }, timeoutMs,
    });
    const discoveries = await Promise.allSettled(['one', 'two'].map(home => readClaude(home)));
    const claude = discoveries.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    assert.equal(claude[0].catalog[0].value, 'one'); assert.equal(claude[1].catalog[0].value, 'two');
    await assert.rejects(readClaude('empty'), /no models/);
    await assert.rejects(readClaude('hang', 500), /timed out/);
    const unicode = await readClaude('unicode');
    assert.equal(unicode.catalog[0].label, '模型', 'UTF-8 model metadata survives chunk boundaries');
    assert.equal(unicode.catalog[0].description, '多语言');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('Dynamic provider model discovery tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
