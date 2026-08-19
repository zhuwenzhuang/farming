const assert = require('assert');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const AUTHORITATIVE_NODE_MAJOR = '22';
const NODE_22_FLOOR = '^22.13.0';
const NODE_24_COMPATIBILITY_FLOOR = '>=24.0.0';

interface WorkflowStep {
  env?: Record<string, unknown>;
  name?: string;
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

  assert(fs.existsSync(path.join(root, 'scripts', 'run-playwright-balanced-shard.mjs')));
  assert(fs.existsSync(path.join(root, 'scripts', 'release-snapshot.sh')));
  assert(fs.existsSync(path.join(root, 'scripts', 'watch-run.sh')));
  assert(fs.existsSync(path.join(root, 'scripts', 'watch-candidate-workflows.sh')));
  const candidateWorkflowWatchSource = fs.readFileSync(
    path.join(root, 'scripts', 'watch-candidate-workflows.sh'),
    'utf8',
  );
  assert(
    candidateWorkflowWatchSource.includes('--commit "${CANDIDATE_SHA}"')
      && candidateWorkflowWatchSource.includes('--event push')
      && candidateWorkflowWatchSource.includes('--log-failed')
      && candidateWorkflowWatchSource.includes('SEEN_RUN_COUNT')
      && candidateWorkflowWatchSource.includes('"${SEEN_RUN_COUNT}" -eq 0')
      && candidateWorkflowWatchSource.includes('MODE="${4:-wait}"')
      && candidateWorkflowWatchSource.includes('"${MODE}" == "once"')
      && candidateWorkflowWatchSource.includes('Candidate push workflows are not complete'),
    'release monitoring must discover and retain failures from every candidate push workflow',
  );
  const browserShardSource = fs.readFileSync(
    path.join(root, 'scripts', 'run-playwright-balanced-shard.mjs'),
    'utf8',
  );
  assert(
    browserShardSource.includes('DEFAULT_TEST_WEIGHT_MS')
      && browserShardSource.includes('estimatedDurationMs')
      && browserShardSource.includes('locationWeightMs'),
    'Chromium shard assignment must use measured duration weights instead of test counts alone',
  );

  assert.strictEqual(workflow.env.FARMING_SKIP_INSTALL_RUNTIME_PREPARE, '1');
  assert.strictEqual(workflow.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, '1');
  assert.strictEqual(workflow.env.PUPPETEER_SKIP_DOWNLOAD, '1');
  assert.strictEqual(workflow.jobs.browser.strategy.matrix.shard.length, 9);
  const browserRunStep = workflow.jobs.browser.steps.find(
    step => step.name === 'Run Chromium browser checks',
  );
  assert(
    browserRunStep?.run?.includes('scripts/run-playwright-balanced-shard.mjs')
      && browserRunStep?.run?.includes('--shard ${{ matrix.shard }}/9'),
    'Chromium must use nine duration-balanced single-worker shards',
  );
  assert(
    workflow.jobs.browser.steps.some(step => step.uses === 'actions/upload-artifact@v4'),
    'Chromium failures must retain Playwright evidence',
  );

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
      && !authoritativeScripts.includes('npm run build'),
    `Node ${AUTHORITATIVE_NODE_MAJOR} must stay authoritative for lint and the dependency audit without blocking browser startup on the frontend build`,
  );
  const frontendScripts = runScriptsOf(workflow.jobs.frontend);
  assert.deepStrictEqual(nodeMajorsOf(workflow.jobs.frontend), [AUTHORITATIVE_NODE_MAJOR]);
  assert(
    frontendScripts.includes('npm ci')
      && frontendScripts.includes('FARMING_BASE_PATH=/farming npm run build')
      && !frontendScripts.includes('npm run check'),
    'the frontend artifact job must build once without duplicating the repository check',
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

  const documentationWorkflow = YAML.parse(
    fs.readFileSync(path.join(root, '.github/workflows/docs.yml'), 'utf8'),
  );
  const pagesDeployStep = documentationWorkflow.jobs.deploy.steps.find(
    step => step.name === 'Deploy to GitHub Pages',
  );
  assert.strictEqual(pagesDeployStep.uses, 'actions/deploy-pages@v5');
  assert.strictEqual(
    pagesDeployStep.with.timeout,
    180000,
    'Pages queue incidents must become visible within the three-minute diagnosis budget',
  );

  console.log(
    `✓ CI keeps Node ${AUTHORITATIVE_NODE_MAJOR} authoritative with one bounded Node 24 compatibility gate`,
  );
}

run();
