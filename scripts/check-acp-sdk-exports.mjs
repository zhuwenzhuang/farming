import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export async function checkAcpSdkExports(sdkRoot) {
  const manifestPath = path.join(sdkRoot, 'package.json');
  const sdk = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const require = createRequire(manifestPath);
  const importedExports = [];
  const unavailableOptionalExports = [];
  for (const [name, target] of Object.entries(sdk.exports)) {
    const runtimePath = typeof target === 'object' ? target.import : target;
    assert(fs.statSync(path.join(sdkRoot, runtimePath)).isFile(), `Missing ACP SDK export: ${name}`);
    if (typeof target !== 'object') continue;
    // This upstream integration is not used by Farming. An absent optional
    // peer makes it unavailable, not a broken mandatory runtime dependency.
    // Check the exact declaration before admitting that one exception; never
    // catch errors from imports (including an installed peer's dependencies).
    if (name === './experimental/mcp-server') {
      const peer = '@modelcontextprotocol/server';
      assert(sdk.peerDependencies?.[peer] && sdk.peerDependenciesMeta?.[peer]?.optional === true,
        'ACP MCP server integration must explicitly declare its optional peer');
      const installed = require.resolve.paths(peer).some(directory => {
        try {
          fs.lstatSync(path.join(directory, peer));
          return true;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          return false;
        }
      });
      if (!installed) {
        unavailableOptionalExports.push(name);
        continue;
      }
    }
    await import(pathToFileURL(path.join(sdkRoot, runtimePath)).href);
    importedExports.push(name);
  }
  return { importedExports, unavailableOptionalExports };
}
