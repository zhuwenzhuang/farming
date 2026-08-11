#!/usr/bin/env -S node --import tsx
import fs from 'node:fs';
import path from 'node:path';

interface PlaywrightEvidence {
  file: string;
  title: string;
}

interface BehaviorContract {
  id: string;
  surface: 'runtime' | 'ui';
  promise: string;
  owner: string;
  evidence: {
    node?: string[];
    playwright?: PlaywrightEvidence[];
  };
}

interface BehaviorManifest {
  version: number;
  contracts: BehaviorContract[];
}

const projectRoot = path.join(__dirname, '..');
const manifestPath = path.join(projectRoot, 'tests', 'behavior-contracts.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BehaviorManifest;
const packageScripts = (JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
) as { scripts?: Record<string, string> }).scripts || {};
const failures: string[] = [];
const contractIds = new Set<string>();
const registeredTags = new Set<string>();

function fail(message: string): void {
  failures.push(message);
}

function readProjectFile(relativePath: string, description: string): string | null {
  const absolutePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`${description} does not exist: ${relativePath}`);
    return null;
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function testBlock(source: string, title: string): string | null {
  const titleOffset = source.indexOf(`test('${title}'`);
  if (titleOffset < 0) return null;
  const nextTestOffset = source.indexOf('\ntest(', titleOffset + title.length);
  return source.slice(titleOffset, nextTestOffset < 0 ? source.length : nextTestOffset);
}

if (manifest.version !== 1) fail(`unsupported behavior contract manifest version: ${manifest.version}`);
if (!Array.isArray(manifest.contracts) || manifest.contracts.length === 0) {
  fail('behavior contract manifest must declare at least one contract');
}

const browserCommand = packageScripts['test:behavior:e2e'] || '';
for (const requiredSetting of [
  'FARMING_E2E_REAL_CODEX=0',
  'FARMING_E2E_FAKE_EXECUTABLES=1',
  'FARMING_E2E_FAKE_ACP_AGENT=1',
]) {
  if (!browserCommand.includes(requiredSetting)) {
    fail(`test:behavior:e2e must remain provider-independent with ${requiredSetting}`);
  }
}

for (const contract of manifest.contracts) {
  if (!/^[A-Z][A-Z0-9-]+$/.test(contract.id)) fail(`invalid behavior contract id: ${contract.id}`);
  if (contractIds.has(contract.id)) fail(`duplicate behavior contract id: ${contract.id}`);
  contractIds.add(contract.id);
  if (!contract.promise?.trim()) fail(`${contract.id} must state an observable promise`);
  readProjectFile(contract.owner, `${contract.id} owner document`);

  const nodeEvidence = contract.evidence?.node || [];
  const playwrightEvidence = contract.evidence?.playwright || [];
  if (nodeEvidence.length + playwrightEvidence.length === 0) {
    fail(`${contract.id} must have executable evidence`);
  }
  if (contract.surface === 'ui' && playwrightEvidence.length === 0) {
    fail(`${contract.id} is a UI contract and requires Playwright evidence`);
  }

  for (const relativePath of nodeEvidence) {
    readProjectFile(relativePath, `${contract.id} Node evidence`);
  }

  const behaviorTag = `@behavior-${contract.id}`;
  registeredTags.add(behaviorTag);
  for (const evidence of playwrightEvidence) {
    const source = readProjectFile(evidence.file, `${contract.id} Playwright evidence`);
    if (source === null) continue;
    const block = testBlock(source, evidence.title);
    if (block === null) {
      fail(`${contract.id} cannot find Playwright test "${evidence.title}" in ${evidence.file}`);
      continue;
    }
    if (!block.includes('@critical-behavior') || !block.includes(behaviorTag)) {
      fail(`${contract.id} Playwright test must carry @critical-behavior and ${behaviorTag}`);
    }
    if (/(?:readFileSync|readFile)\s*\([^)]*['"`](?:\.\.\/)*(?:src|backend|frontend|desktop|extensions|shared|scripts)\//s.test(block)) {
      fail(`${contract.id} Playwright evidence reads production source; assert observable behavior instead`);
    }
  }
}

const e2eRoot = path.join(projectRoot, 'tests', 'e2e');
for (const entry of fs.readdirSync(e2eRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.spec.ts')) continue;
  const relativePath = path.join('tests', 'e2e', entry.name);
  const source = fs.readFileSync(path.join(e2eRoot, entry.name), 'utf8');
  if (!source.includes('@critical-behavior')) continue;
  const tags = source.match(/@behavior-[A-Z0-9-]+/g) || [];
  if (tags.length === 0) fail(`${relativePath} has @critical-behavior without a stable @behavior-* contract tag`);
  for (const tag of tags) {
    if (!registeredTags.has(tag)) fail(`${relativePath} uses unregistered behavior tag ${tag}`);
  }
}

if (failures.length > 0) {
  console.error('Behavior contract validation failed:');
  failures.forEach(message => console.error(`- ${message}`));
  process.exit(1);
}

console.log(`Behavior contracts valid: ${manifest.contracts.length} contracts`);
