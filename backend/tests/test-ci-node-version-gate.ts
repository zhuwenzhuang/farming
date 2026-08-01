const assert = require('assert');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const AUTHORITATIVE_NODE_MAJOR = '22';
const NODE_22_FLOOR = '^22.13.0';
const NODE_24_COMPATIBILITY_FLOOR = '>=24.0.0';

interface WorkflowStep {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
  strategy?: unknown;
  'continue-on-error'?: unknown;
}

function nodeMajorsOf(job: WorkflowJob): string[] {
  return (job?.steps || [])
    .filter(step => typeof step?.uses === 'string' && step.uses.startsWith('actions/setup-node@'))
    .map(step => String(step?.with?.['node-version'] ?? '').split('.')[0]);
}

function runScriptsOf(job: WorkflowJob): string {
  return (job?.steps || []).map(step => step?.run ?? '').join('\n');
}

function run() {
  const root = path.join(__dirname, '../..');
  const packageJson = require(path.join(root, 'package.json'));
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
  const jobs: [string, WorkflowJob][] = Object.entries(workflow.jobs);

  // `engines` is a range, not an enumeration: `>=24.0.0` also admits Node majors that do not
  // exist yet, so this gate asserts the two declared floors instead of a finite major list.
  const engines = String(packageJson.engines.node);
  assert(
    engines.includes(NODE_22_FLOOR),
    `package.json engines must keep the Node ${AUTHORITATIVE_NODE_MAJOR} floor ${NODE_22_FLOOR}`,
  );
  assert(
    engines.includes(NODE_24_COMPATIBILITY_FLOOR),
    `package.json engines must keep the ${NODE_24_COMPATIBILITY_FLOOR} compatibility floor`,
  );

  const authoritativeScripts = runScriptsOf(workflow.jobs.check);
  assert.deepStrictEqual(nodeMajorsOf(workflow.jobs.check), [AUTHORITATIVE_NODE_MAJOR]);
  assert(
    authoritativeScripts.includes('npm run check')
      && authoritativeScripts.includes('npm audit --omit=dev')
      && authoritativeScripts.includes('npm run build'),
    `Node ${AUTHORITATIVE_NODE_MAJOR} must stay authoritative for lint, the dependency audit, and the frontend build`,
  );
  assert.deepStrictEqual(
    nodeMajorsOf(workflow.jobs.browser),
    [AUTHORITATIVE_NODE_MAJOR],
    `the Chromium shards must stay on Node ${AUTHORITATIVE_NODE_MAJOR} only`,
  );

  const node24Jobs = jobs.filter(([, job]) => nodeMajorsOf(job).includes('24'));
  assert.strictEqual(node24Jobs.length, 1, 'the Node 24 compatibility floor needs exactly one bounded gate');
  const [name, job] = node24Jobs[0];
  const scripts = runScriptsOf(job);

  assert.deepStrictEqual(nodeMajorsOf(job), ['24'], `${name} must pin only Node 24`);
  assert.strictEqual(job.strategy, undefined, `${name} must not fan out into a matrix`);
  assert.strictEqual(
    job['continue-on-error'],
    undefined,
    `${name} must fail the workflow visibly instead of reporting a soft warning`,
  );
  assert(
    scripts.includes('npm ci')
      && scripts.includes('npm run typecheck')
      && scripts.includes('npm test'),
    `${name} must install with npm ci and cover typecheck plus the test suite`,
  );
  assert(
    !scripts.includes('playwright')
      && !scripts.includes('npm audit')
      && !scripts.includes('npm run build')
      && !scripts.includes('npm run lint')
      && !scripts.includes('npm run check'),
    `${name} must stay bounded and must not duplicate Chromium, audit, build, or lint work`,
  );

  assert.deepStrictEqual(workflow.permissions, { contents: 'read' });

  console.log(
    `✓ CI keeps Node ${AUTHORITATIVE_NODE_MAJOR} authoritative with one bounded Node 24 compatibility gate`,
  );
}

run();
