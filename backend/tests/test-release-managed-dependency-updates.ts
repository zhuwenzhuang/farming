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
    const missingVersions = new Set();
    const registryFetch = async url => {
      const pathParts = new URL(url).pathname.split('/');
      const packageName = decodeURIComponent(pathParts[1]);
      const requestedVersion = pathParts[2] ? decodeURIComponent(pathParts[2]) : '';
      if (requestedVersion !== 'latest') {
        return new Response('', {
          status: missingVersions.has(`${packageName}@${requestedVersion}`) ? 404 : 200,
        });
      }
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
    assert.strictEqual(current.deferred.length, 0);

    currentVersions.set('@agentclientprotocol/claude-agent-acp', '0.60.0');
    const deferredClaude = await checker.inspectManagedReleaseDependencies(dependencies, {
      fetchImpl: registryFetch,
      registry: 'https://registry.test/',
    });
    assert.strictEqual(deferredClaude.mismatches.length, 0);
    assert.deepStrictEqual(
      deferredClaude.deferred.map(dependency => dependency.name),
      ['@agentclientprotocol/claude-agent-acp'],
    );

    currentVersions.set('@openai/codex', '0.147.0');
    const codexRuntimeUpdate = await checker.inspectManagedReleaseDependencies(dependencies, {
      fetchImpl: registryFetch,
      registry: 'https://registry.test/',
    });
    assert.deepStrictEqual(
      codexRuntimeUpdate.mismatches.map(dependency => dependency.name),
      ['@agentclientprotocol/claude-agent-acp', '@openai/codex'],
    );

    missingVersions.add('@openai/codex@0.147.0-darwin-x64');
    const incompleteCodexRuntimeUpdate = await checker.inspectManagedReleaseDependencies(
      dependencies,
      {
        fetchImpl: registryFetch,
        registry: 'https://registry.test/',
      },
    );
    assert.deepStrictEqual(incompleteCodexRuntimeUpdate.mismatches, []);
    assert.deepStrictEqual(
      incompleteCodexRuntimeUpdate.deferred.map(dependency => dependency.name),
      ['@agentclientprotocol/claude-agent-acp', '@openai/codex'],
    );
    assert.deepStrictEqual(
      incompleteCodexRuntimeUpdate.incomplete.map(dependency => ({
        name: dependency.name,
        missingPlatforms: dependency.missingPlatforms,
      })),
      [{ name: '@openai/codex', missingPlatforms: ['darwin-x64'] }],
    );
    missingVersions.clear();

    for (const status of [204, 206, 503]) {
      await assert.rejects(
        checker.inspectManagedReleaseDependencies(dependencies, {
          fetchImpl: async url => {
            if (String(url).endsWith('/0.147.0-darwin-arm64')) {
              return new Response(status === 204 ? null : '', { status });
            }
            return registryFetch(url);
          },
          registry: 'https://registry.test/',
        }),
        new RegExp(`registry returned HTTP ${status}`),
      );
    }
    currentVersions.set('@openai/codex', '0.146.0');

    currentVersions.set('@agentclientprotocol/codex-acp', '1.1.14');
    currentVersions.set('pi-acp', '0.0.34');
    currentVersions.set('@anthropic-ai/claude-agent-sdk', '0.3.226');
    const outdated = await checker.inspectManagedReleaseDependencies(dependencies, {
      fetchImpl: registryFetch,
      registry: 'https://registry.test/',
    });
    assert.deepStrictEqual(
      outdated.mismatches.map(dependency => dependency.name),
      [
        '@agentclientprotocol/codex-acp',
        '@agentclientprotocol/claude-agent-acp',
        'pi-acp',
      ],
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

    for (const status of [201, 206]) {
      await assert.rejects(
        checker.inspectManagedReleaseDependencies(dependencies, {
          fetchImpl: async url => (
            String(url).endsWith('/latest')
              ? new Response(JSON.stringify({ version: '9.9.9' }), { status })
              : registryFetch(url)
          ),
          registry: 'https://registry.test/',
        }),
        new RegExp(`registry returned HTTP ${status}`),
      );
    }

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

  console.log(
    '✓ Release dependency preflight detects current, outdated, incomplete, unavailable, and inconsistent pins',
  );
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
