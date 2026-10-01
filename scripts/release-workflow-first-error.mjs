#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function firstWorkflowError(log) {
  let echoedGroup = false;
  const candidates = [];
  for (const [index, raw] of log.split(/\r?\n/).entries()) {
    // GitHub renders shell source in cyan; its wording is not runtime evidence.
    const echoedSource = /\u001b\[(?:[\d;]*;)?36(?:;[\d;]*)?m/.test(raw);
    const line = raw.replace(/\u001b\[[\d;]*m/g, '');
    if (/##\[group\]Run\s/.test(line)) { echoedGroup = true; continue; }
    if (echoedGroup && /##\[endgroup\]/.test(line)) { echoedGroup = false; continue; }
    if (echoedSource || echoedGroup) continue;
    if (/##\[error\]Process completed with exit code/i.test(line)) candidates.push({ priority: 2, index, line });
    else if (/##\[error\]|::error(?:\s|::)/i.test(line)) candidates.push({ priority: 0, index, line });
    else if (/npm\s+error|\sError:|Timeout reached|Reconciliation deadline reached|outcome remains uncertain|deployment_queued|\sfailed(?:\s|:|$)|\sfailure(?:\s|:|$)/i.test(line)) {
      candidates.push({ priority: 1, index, line });
    }
  }
  candidates.sort((left, right) => left.priority - right.priority || left.index - right.index);
  const first = candidates[0];
  return first ? `${first.index + 1}:${first.line}` : '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Expected a retained workflow log path.');
  console.log(firstWorkflowError(fs.readFileSync(process.argv[2], 'utf8')));
}
