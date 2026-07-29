#!/bin/sh
':' //; script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"; repo_dir="$script_dir"; while [ ! -x "$repo_dir/node_modules/.bin/tsx" ] && [ "$repo_dir" != "/" ]; do repo_dir="$(dirname -- "$repo_dir")"; done; if [ ! -x "$repo_dir/node_modules/.bin/tsx" ]; then echo "Pinned tsx runtime not found above $script_dir" >&2; exit 127; fi; exec "$repo_dir/node_modules/.bin/tsx" "$0" "$@"
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FarmingUpdateService } from '../backend/update-service.cjs';

interface UpdateStatus {
  method: string;
  installable: boolean;
  versions: unknown[];
  latest: { blockedReason: string };
}

async function unsupportedStatusFor(platform: string, arch: string): Promise<{ status: UpdateStatus; fetches: number }> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-platform-root.'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-update-platform-config.'));
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '2.2.0' }));
  let fetches = 0;
  const service = new FarmingUpdateService({
    rootDir,
    configDir,
    installMethod: 'app-bundle',
    platform,
    arch,
    fetchJson: async () => {
      fetches += 1;
      throw new Error('non-npm updates must not fetch a release source');
    },
  });
  const status = await service.check({ force: true }) as UpdateStatus;
  return { status, fetches };
}

async function run(): Promise<void> {
  for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64']] as const) {
    const { status, fetches } = await unsupportedStatusFor(platform, arch);
    assert.strictEqual(status.method, 'app-bundle');
    assert.strictEqual(status.installable, false);
    assert.deepStrictEqual(status.versions, []);
    assert.match(status.latest.blockedReason, /reinstalling a release package or switching to npm/i);
    assert.strictEqual(fetches, 0);
  }
  console.log('✓ non-npm update smoke covers macOS and Linux');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
