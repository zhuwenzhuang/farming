import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function readCandidate(archive) {
  const metadata = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
  const integrity = `sha512-${createHash('sha512').update(fs.readFileSync(archive)).digest('base64')}`;
  return { archive, metadata, integrity };
}

export function runtimeCandidates(application) {
  if (application.metadata.farmingRuntimePackages !== 1) return [];
  return Object.entries(application.metadata.optionalDependencies)
    .filter(([name]) => name.startsWith('farming-code-runtime-'))
    .map(([name, pin]) => {
      assert(pin.startsWith('npm:farming-code@'), 'Expected exact Farming runtime alias');
      const version = pin.slice('npm:farming-code@'.length);
      assert(/^[\w.-]+$/.test(version), 'Unsafe runtime version');
      const item = readCandidate(path.join(path.dirname(application.archive), `farming-code-${version}.tgz`));
      assert.equal(item.metadata.version, version);
      assert.equal(item.metadata.farmingRuntimePlatform, name.slice('farming-code-runtime-'.length));
      return item;
    });
}
