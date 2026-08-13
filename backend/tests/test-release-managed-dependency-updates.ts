const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

async function run() {
  const checker = await import(pathToFileURL(
    path.join(process.cwd(), 'scripts/check-release-managed-dependency-updates.mjs'),
  ).href);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-release-dependencies-'));
  try {
    fs.mkdirSync(path.join(temporaryRoot, 'backend/data'), { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, 'package.json'), JSON.stringify({
      dependencies: { '@agentclientprotocol/sdk': '1.2.1' },
      devDependencies: {
        '@agentclientprotocol/codex-acp': '1.1.4',
        '@agentclientprotocol/claude-agent-acp': '0.59.0',
        'agent-browser': '0.32.3',
        'pi-acp': '0.0.33',
      },
      overrides: { '@openai/codex': '0.146.0' },
    }));
    fs.writeFileSync(path.join(temporaryRoot, 'package-lock.json'), JSON.stringify({
      packages: {
        'node_modules/@agentclientprotocol/claude-agent-acp': {
          dependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.207' },
        },
      },
    }));
    fs.writeFileSync(
      path.join(temporaryRoot, 'backend/data/runtime-dependency-manifest.json'),
      JSON.stringify({
        dependencies: {
          codex: { version: '0.146.0' },
          claude: { version: '0.3.207' },
          agentBrowser: { version: '0.32.3' },
        },
      }),
    );

    const dependencies = checker.readManagedReleaseDependencies(temporaryRoot);
    assert.deepStrictEqual(
      dependencies.map(dependency => dependency.name),
      [
        '@agentclientprotocol/codex-acp',
        '@agentclientprotocol/claude-agent-acp',
        'pi-acp',
        '@agentclientprotocol/sdk',
        '@openai/codex',
        '@anthropic-ai/claude-agent-sdk',
      ],
    );

    const currentVersions = new Map(dependencies.map(dependency => [dependency.name, dependency.current]));
    const registryFetch = async url => {
      const packageName = decodeURIComponent(new URL(url).pathname.split('/')[1]);
      return new Response(JSON.stringify({ version: currentVersions.get(packageName) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const current = await checker.inspectManagedReleaseDependencies(dependencies, {
      fetchImpl: registryFetch,
      registry: 'https://registry.test/',
    });
    assert.strictEqual(current.mismatches.length, 0);
    assert.strictEqual(current.reviews.length, 0);

    currentVersions.set('@agentclientprotocol/codex-acp', '1.1.14');
    currentVersions.set('pi-acp', '0.0.34');
    currentVersions.set('@anthropic-ai/claude-agent-sdk', '0.3.226');
    const outdated = await checker.inspectManagedReleaseDependencies(dependencies, {
      fetchImpl: registryFetch,
      registry: 'https://registry.test/',
    });
    assert.deepStrictEqual(
      outdated.mismatches.map(dependency => dependency.name),
      ['@agentclientprotocol/codex-acp', 'pi-acp'],
    );
    assert.deepStrictEqual(
      outdated.reviews.map(dependency => dependency.name),
      ['@anthropic-ai/claude-agent-sdk'],
    );

    await assert.rejects(
      checker.inspectManagedReleaseDependencies(dependencies, {
        fetchImpl: async () => new Response('', { status: 503 }),
        registry: 'https://registry.test/',
      }),
      /registry returned HTTP 503/,
    );

    const packageJson = JSON.parse(fs.readFileSync(path.join(temporaryRoot, 'package.json'), 'utf8'));
    packageJson.overrides['@openai/codex'] = '0.145.0';
    fs.writeFileSync(path.join(temporaryRoot, 'package.json'), JSON.stringify(packageJson));
    assert.throws(
      () => checker.readManagedReleaseDependencies(temporaryRoot),
      /Codex override must match/,
    );

    packageJson.overrides['@openai/codex'] = '0.146.0';
    fs.writeFileSync(path.join(temporaryRoot, 'package.json'), JSON.stringify(packageJson));
    const runtimeManifestPath = path.join(temporaryRoot, 'backend/data/runtime-dependency-manifest.json');
    const runtimeManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, 'utf8'));
    runtimeManifest.dependencies.claude.version = '0.3.206';
    fs.writeFileSync(runtimeManifestPath, JSON.stringify(runtimeManifest));
    assert.throws(
      () => checker.readManagedReleaseDependencies(temporaryRoot),
      /must match the exact Claude ACP adapter dependency/,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  console.log('✓ Release dependency preflight detects current, outdated, unavailable, and inconsistent pins');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
