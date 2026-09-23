import fs from 'node:fs';

// Keep the current site online until npm can satisfy the new first-use command.
// A successful release workflow triggers Documentation again after publication.
const response = await fetch('https://registry.npmjs.org/farming-code/latest', {
  signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error(`npm installer readiness check failed: HTTP ${response.status}`);
const metadata = await response.json();
const ready = metadata.farmingUserInstall === 1;
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\n`);
console.log(ready
  ? `farming-code@${metadata.version} supports the public installer.`
  : `Keeping the existing documentation deployment: farming-code@${metadata.version} does not yet support the new installer.`);
