#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReceipt } from './npm-release-evidence.mjs';
import { observeGitHub } from './observe-release-gh.mjs';

const positiveId = /^[1-9][0-9]*$/;
const commitSha = /^[a-f0-9]{40}$/;
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const artifactName = /^farming-npm-publication-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const requiredSteps = ['Verify exact preparation run', 'Require successful candidate push workflows',
  'Require successful automated and Computer Use acceptance', 'Publish the matching draft release',
  'Verify public tag, assets, and manifest', 'Verify and publish npm package with provenance'];

export function authenticateRun(run, workflow, jobs, repository, id, attempt, mode = 'original') {
  if (!repositoryName.test(repository) || !positiveId.test(String(id)) || !positiveId.test(String(attempt))
    || String(run.id) !== String(id) || String(run.run_attempt) !== String(attempt)
    || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
    || workflow.path !== '.github/workflows/publish-release.yml' || workflow.id !== run.workflow_id
    || run.event !== 'workflow_dispatch' || run.status !== 'completed'
    || !['success', 'failure'].includes(run.conclusion) || !commitSha.test(run.head_sha)) {
    throw new Error('Untrusted publication run identity, repository, workflow, or terminal outcome.');
  }
  const matches = jobs.jobs.filter(job => job.name === 'Publish verified release');
  if (matches.length !== 1 || jobs.total_count !== jobs.jobs.length) throw new Error('Publication jobs are ambiguous or truncated.');
  const steps = matches[0].steps || [];
  const original = requiredSteps.every(name => steps.filter(step => step.name === name && step.conclusion === 'success').length === 1);
  const skippedOnRecovery = ['Require successful candidate push workflows', 'Publish the matching draft release'];
  const recovery = ['trigger', 'uploader'].includes(mode)
    && requiredSteps.every(name => steps.filter(step => step.name === name
      && step.conclusion === (skippedOnRecovery.includes(name) ? 'skipped' : 'success')).length === 1)
    && steps.filter(step => step.name === 'Checkout recovery verifier' && step.conclusion === 'success').length === 1
    && steps.filter(step => step.name === 'Download prior npm publication evidence'
      && ['success', 'skipped'].includes(step.conclusion)).length === 1;
  if (mode === 'candidate') {
    const beforeUpload = requiredSteps.slice(0, 4).every(name => steps.filter(step => step.name === name && step.conclusion === 'success').length === 1)
      && steps.some(step => step.name === 'Verify public tag, assets, and manifest' && step.conclusion === 'failure')
      && steps.some(step => step.name === 'Verify and publish npm package with provenance' && step.conclusion === 'skipped');
    return original || beforeUpload;
  }
  return (original || recovery) && steps.some(step => step.name === 'Wait for npm package to become public'
    && ['success', 'failure'].includes(step.conclusion));
}

export function selectEvidenceArtifact(list, version) {
  if (list.total_count !== list.artifacts.length) throw new Error('Publication artifacts are truncated.');
  const matches = list.artifacts.filter(artifact => artifactName.test(artifact.name)
    && (!version || artifact.name === `farming-npm-publication-${version}`));
  if (!matches.length && !version) return null;
  if (matches.length !== 1 || matches[0].expired || !Number.isSafeInteger(matches[0].id)
    || matches[0].id < 1 || !Number.isSafeInteger(matches[0].size_in_bytes) || matches[0].size_in_bytes < 1
    || matches[0].size_in_bytes > 1_000_000) throw new Error('Publication evidence artifact is absent, ambiguous, expired, or oversized.');
  return matches[0];
}

export function validateOrigin(origin, receipt, repository, version) {
  validateReceipt(receipt, origin.candidateSha);
  if (origin.schemaVersion !== 1 || origin.repository !== repository || origin.version !== version
    || receipt.version !== version || !positiveId.test(String(origin.runId))
    || !positiveId.test(String(origin.runAttempt)) || !positiveId.test(String(origin.preparationRunId))
    || !positiveId.test(String(origin.candidatePublicationRunId)) || !positiveId.test(String(origin.candidatePublicationRunAttempt))) {
    throw new Error('Invalid original-upload identity.');
  }
  return origin;
}

export function validateEvidence(trigger, canonical, originalRun, repository, version, candidateRun = originalRun) {
  const origin = validateOrigin(canonical.origin, canonical.receipt, repository, version);
  validateOrigin(trigger.origin, trigger.receipt, repository, version);
  if (String(originalRun.id) !== String(origin.runId)
    || String(originalRun.run_attempt) !== String(origin.runAttempt)) throw new Error('Original upload does not identify the exact candidate SHA.');
  if (candidateRun.head_sha !== origin.candidateSha || String(candidateRun.id) !== String(origin.candidatePublicationRunId)
    || String(candidateRun.run_attempt) !== String(origin.candidatePublicationRunAttempt)) {
    throw new Error('Candidate publication does not identify the exact candidate SHA.');
  }
  for (const [key, expected] of Object.entries(origin)) {
    if (trigger.origin[key] !== expected) throw new Error('Triggering recovery replaced the original-upload identity.');
  }
  for (const [key, expected] of Object.entries(canonical.receipt)) {
    if (trigger.receipt[key] !== expected) throw new Error('Triggering recovery receipt differs from the authenticated original smoke receipt.');
  }
  for (const evidence of [trigger, canonical]) {
    const upload = evidence.upload;
    if (upload.uploadExitCode !== 0 || !Number.isFinite(Date.parse(upload.observedAt))
      || upload.packageName !== evidence.receipt.packageName || upload.version !== version
      || upload.gitHead !== origin.candidateSha) throw new Error('Original upload acceptance is not proven for this receipt.');
  }
  if (trigger.upload.observedAt !== canonical.upload.observedAt) throw new Error('Recovery changed the original upload timestamp.');
  if (trigger.state.status !== 'awaiting-public' || trigger.state.uploadStatus !== 'accepted'
    || trigger.state.packageName !== trigger.receipt.packageName || trigger.state.version !== version
    || trigger.state.gitHead !== origin.candidateSha) throw new Error('Publication is not an accepted upload awaiting public verification.');
  return origin;
}

async function api(endpoint) {
  const chunks = [];
  const code = await observeGitHub(['api', endpoint], {
    timeoutMs: 20_000, maxOutputBytes: 2_000_000,
    onStdout: chunk => chunks.push(chunk), stderr: () => {},
  });
  if (code !== 0) throw new Error('GitHub metadata read failed, exceeded its output bound, or timed out.');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function readEvidence(directory) {
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  return { origin: read('upload-origin.json'), receipt: read('npm-smoke-receipt.json'),
    upload: read('upload-result.json'), state: read('publication-state.json') };
}
async function runMetadata(repository, id, attempt, mode = 'original') {
  if (!repositoryName.test(repository) || !positiveId.test(String(id)) || !positiveId.test(String(attempt))) {
    throw new Error('Invalid GitHub metadata request identity.');
  }
  const prefix = `repos/${repository}/actions/runs/${id}/attempts/${attempt}`;
  const run = await api(prefix);
  if (!positiveId.test(String(run.workflow_id))) throw new Error('Invalid publication workflow identity.');
  const workflow = await api(`repos/${repository}/actions/workflows/${run.workflow_id}`);
  const jobs = await api(`${prefix}/jobs?per_page=100`);
  const eligible = authenticateRun(run, workflow, jobs, repository, id, attempt, mode);
  const lineage = await api(`repos/${repository}/compare/${run.head_sha}...main`);
  if (!['ahead', 'identical'].includes(lineage.status) || lineage.base_commit?.sha !== run.head_sha) {
    throw new Error('Publication verifier or original candidate is not integrated into main.');
  }
  return { run, workflow, jobs, eligible };
}
export function authenticatePreparation(run, workflow, repository, origin) {
  if (String(run.id) !== String(origin.preparationRunId) || run.repository?.full_name !== repository
    || run.head_repository?.full_name !== repository || run.head_sha !== origin.candidateSha
    || run.event !== 'workflow_dispatch' || run.status !== 'completed' || run.conclusion !== 'success'
    || workflow.id !== run.workflow_id || workflow.path !== '.github/workflows/release.yml') {
    throw new Error('Preparation does not prove the exact candidate source for the original upload.');
  }
}
async function authenticateOrigin(origin, repository) {
  const uploader = await runMetadata(repository, origin.runId, origin.runAttempt, 'uploader');
  const candidate = String(origin.runId) === String(origin.candidatePublicationRunId)
    && String(origin.runAttempt) === String(origin.candidatePublicationRunAttempt)
    ? { ...uploader, eligible: authenticateRun(uploader.run, uploader.workflow, uploader.jobs, repository,
      origin.candidatePublicationRunId, origin.candidatePublicationRunAttempt, 'candidate') }
    : await runMetadata(repository, origin.candidatePublicationRunId, origin.candidatePublicationRunAttempt, 'candidate');
  if (!uploader.eligible || !candidate.eligible || candidate.run.head_sha !== origin.candidateSha) {
    throw new Error('Original uploader or exact candidate publication did not pass its required gates.');
  }
  if (String(uploader.run.id) !== String(candidate.run.id)) {
    const steps = uploader.jobs.jobs[0].steps;
    if (!['Require successful candidate push workflows', 'Publish the matching draft release']
      .every(name => steps.some(step => step.name === name && step.conclusion === 'skipped'))) {
      throw new Error('A separate candidate publication origin requires an authenticated recovery uploader.');
    }
  }
  const preparation = await api(`repos/${repository}/actions/runs/${origin.preparationRunId}`);
  if (!positiveId.test(String(preparation.workflow_id))) throw new Error('Invalid preparation workflow identity.');
  const workflow = await api(`repos/${repository}/actions/workflows/${preparation.workflow_id}`);
  authenticatePreparation(preparation, workflow, repository, origin);
  return { uploader, candidate };
}
function output(values) {
  const text = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, text);
  console.log(text.trim());
}
async function main() {
  const [command, directory, canonicalDirectory] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  if (command === 'locate') {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (event.action !== 'completed' || event.repository?.full_name !== repository
      || event.workflow_run?.repository?.full_name !== repository) throw new Error('Unexpected workflow completion event.');
    const metadata = await runMetadata(repository, event.workflow_run.id, event.workflow_run.run_attempt, 'trigger');
    if (metadata.run.head_sha !== event.workflow_run.head_sha || metadata.run.workflow_id !== event.workflow_run.workflow_id) {
      throw new Error('Workflow event differs from authenticated run metadata.');
    }
    if (!metadata.eligible) return output({ eligible: 'false' });
    const artifact = selectEvidenceArtifact(await api(`repos/${repository}/actions/runs/${metadata.run.id}/artifacts?per_page=100`));
    if (!artifact) return output({ eligible: 'false' });
    const version = artifactName.exec(artifact.name)[1];
    output({ eligible: 'true', version, trigger_run_id: metadata.run.id,
      trigger_run_attempt: metadata.run.run_attempt, trigger_artifact_id: artifact.id });
    return;
  }
  if (command === 'identify') {
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'publication-state.json'), 'utf8'));
    // Historical releases without origin checkpoints remain manually recoverable.
    if (state.status !== 'awaiting-public') return output({ eligible: 'false' });
    if (!fs.existsSync(path.join(directory, 'upload-origin.json'))) {
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        '### npm observation\n\nThe original upload identity checkpoint is unavailable. Publication remains pending; resume the original upload run through read-only recovery.\n');
      return output({ eligible: 'false' });
    }
    const trigger = readEvidence(directory);
    const origin = validateOrigin(trigger.origin, trigger.receipt, repository, process.env.RELEASE_VERSION);
    await authenticateOrigin(origin, repository);
    const artifact = selectEvidenceArtifact(await api(`repos/${repository}/actions/runs/${origin.runId}/artifacts?per_page=100`), origin.version);
    output({ eligible: 'true', candidate_sha: origin.candidateSha, original_run_id: origin.runId,
      original_run_attempt: origin.runAttempt, original_artifact_id: artifact.id });
    return;
  }
  if (command === 'validate') {
    const trigger = readEvidence(directory);
    const canonical = readEvidence(canonicalDirectory);
    validateOrigin(canonical.origin, canonical.receipt, repository, process.env.RELEASE_VERSION);
    const original = await authenticateOrigin(canonical.origin, repository);
    validateEvidence(trigger, canonical, original.uploader.run, repository, process.env.RELEASE_VERSION, original.candidate.run);
    const triggerRun = await runMetadata(repository, process.env.TRIGGER_RUN_ID, process.env.TRIGGER_RUN_ATTEMPT, 'trigger');
    if (!triggerRun.eligible) throw new Error('Triggering publication gates are not successful.');
    fs.mkdirSync('npm-evidence', { recursive: true });
    for (const name of ['upload-origin.json', 'upload-result.json', 'npm-smoke-receipt.json']) {
      fs.copyFileSync(path.join(canonicalDirectory, name), path.join('npm-evidence', name));
    }
    return;
  }
  if (command === 'finish') {
    const stateFile = path.join(directory, 'publication-state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.observationStatus = 'ended';
    state.observationDurationMs = state.elapsedMs;
    state.observationRunId = process.env.GITHUB_RUN_ID;
    state.originalUploadRunId = JSON.parse(fs.readFileSync(path.join(directory, 'upload-origin.json'), 'utf8')).runId;
    const temporary = `${stateFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
      fs.renameSync(temporary, stateFile);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return;
  }
  throw new Error('Usage: continue-npm-publication.mjs <locate|identify|validate|finish> [evidence-directory] [canonical-directory]');
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // gh failures may include signed download URLs; emit no raw transport output.
    console.error(`npm continuation failed: ${error instanceof SyntaxError ? 'Invalid JSON evidence or GitHub metadata.' : error.message}`);
    process.exitCode = 1;
  });
}
