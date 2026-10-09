import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeAccountQuota, readCodexAccountQuota } from '../backend/codex-account-quota.cjs'

test('only the authoritative codex bucket supplies quota; null is not zero usage', () => {
  const limit = (usedPercent: unknown) => ({ limitId: 'codex', primary: { usedPercent, windowDurationMins: 10080, resetsAt: 2000000000 } })
  assert.equal(normalizeAccountQuota({ rateLimits: limit(92), rateLimitsByLimitId: { codex: limit(49) } }, 1).primary?.usedPercent, 49)
  for (const value of [null, undefined, '', false, -1, 101, NaN]) assert.equal(normalizeAccountQuota({ rateLimits: limit(value) }, 1).available, false)
  assert.equal(normalizeAccountQuota({ rateLimits: limit(0) }, 1).primary?.usedPercent, 0)
  assert.equal(normalizeAccountQuota({ rateLimits: limit(92), rateLimitsByLimitId: { other: limit(9) } }, 1).available, false)
})

test('account reads use exact Home, issue no turns, and clean processes on success/failure/deadline', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'farming-account-quota-'))
  const executable = path.join(dir, 'fake-codex')
  const log = path.join(dir, 'requests.jsonl')
  try {
    await writeFile(executable, `#!/usr/bin/env node
const fs=require('fs');const readline=require('readline');
fs.writeFileSync(process.env.TEST_QUOTA_PID,String(process.pid));
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['--no-daemon','app-server']))process.exit(2);
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);fs.appendFileSync(process.env.TEST_QUOTA_LOG,JSON.stringify({method:request.method,home:process.env.CODEX_HOME})+'\\n');
 if(!request.id || process.env.TEST_QUOTA_MODE==='hang')return;
 if(process.env.TEST_QUOTA_MODE==='oversize'){process.stdout.write('x'.repeat(2*1024*1024));return;}
 let result={};
 if(request.method==='account/read')result={account:null,requiresOpenaiAuth:false};
 if(request.method==='account/rateLimits/read' && process.env.TEST_QUOTA_MODE==='api'){process.stdout.write(JSON.stringify({id:request.id,error:{code:-32600,message:'ChatGPT authentication required'}})+'\\n');return;}
 if(request.method==='account/rateLimits/read')result={rateLimits:{primary:{usedPercent:49,windowDurationMins:10080}}};
 process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});
`, { mode: 0o755 })
    for (const mode of ['success', 'api', 'hang', 'oversize']) {
      const pidFile = path.join(dir, `${mode}.pid`)
      const result = await readCodexAccountQuota(path.join(dir, 'selected-home'), { executable, timeoutMs: mode === 'hang' ? 250 : 3000,
        env: { TEST_QUOTA_LOG: log, TEST_QUOTA_PID: pidFile, TEST_QUOTA_MODE: mode } })
      assert.equal(result.available, mode === 'success')
      if (mode === 'api') assert.equal(result.reasonCode, 'authentication')
      if (mode === 'hang') assert.equal(result.reasonCode, 'timeout')
      if (mode === 'oversize') assert.equal(result.reasonCode, 'invalid-response')
      if (mode === 'success') assert.equal(result.primary?.usedPercent, 49)
      const pid = Number(await readFile(pidFile, 'utf8'))
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    }
    const requests = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; home: string })
    assert.ok(requests.every(row => row.home === path.join(dir, 'selected-home')))
    assert.ok(requests.every(row => ['initialize', 'initialized', 'account/rateLimits/read'].includes(row.method)))
    assert.equal((await readCodexAccountQuota(dir, { executable: path.join(dir, 'missing'), timeoutMs: 100 })).available, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
