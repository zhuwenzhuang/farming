'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalConfigDir, configInstanceFingerprint } from './config-instance.cjs';
import {
  matchingProcessIdentity,
  readServerProcessIdentity,
} from './server-process-identity.cjs';
import type { ServerProcessIdentity } from './server-process-identity.cjs';

const PACKAGE_IMAGE_MARKER_FORMAT = 'farming-package-image-v1';
const PACKAGE_CURRENT_FORMAT = 'farming-package-current-v1';
const PACKAGE_USAGE_FORMAT = 'farming-package-usage-v1';
const PACKAGE_MUTATION_OWNER_FORMAT = 'farming-package-mutation-owner-v1';
const PACKAGE_IMAGE_MARKER_NAME = '.farming-package-image.json';
const PACKAGE_CURRENT_NAME = 'current.json';
const DEFAULT_RETAINED_PACKAGE_IMAGES = 5;

interface UnknownRecord {
  [key: string]: unknown;
}

interface PackageImageMarker extends UnknownRecord {
  format: typeof PACKAGE_IMAGE_MARKER_FORMAT;
  installationId: string;
  installationRoot: string;
  bootstrapPackageRoot: string;
  imageId: string;
  version: string;
  sourceIntegrity: string;
  createdAt: string;
}

interface PackageImageRef {
  imageId: string;
  version: string;
  sourceIntegrity: string;
  packageRoot: string;
  relativePath: string;
}

interface PackageCurrentPointer extends UnknownRecord {
  format: typeof PACKAGE_CURRENT_FORMAT;
  installationId: string;
  imageId: string;
  version: string;
  relativePath: string;
  previousImageId?: string;
  previousRelativePath?: string;
  bootstrapSourceIntegrity?: string;
  activatedAt: string;
}

interface PackageInstallationContext {
  installationId: string;
  installationRoot: string;
  bootstrapPackageRoot: string;
  activePackageRoot: string;
  versionsDir: string;
  stagingDir: string;
  usageDir: string;
  currentFile: string;
  mutationLockDir: string;
}

interface PackageMutationOwner extends UnknownRecord {
  format?: unknown;
  claimId?: unknown;
  installationId?: unknown;
  processIdentity?: ServerProcessIdentity | null;
}

interface PackageUsageRecord extends UnknownRecord {
  format: typeof PACKAGE_USAGE_FORMAT;
  installationId: string;
  configFingerprint: string;
  configDir: string;
  imageId: string;
  version: string;
  packageRoot: string;
  processIdentity: ServerProcessIdentity;
  updatedAt: string;
}

interface ActivatePackageImageResult {
  changed: boolean;
  current: PackageCurrentPointer;
  previous: PackageCurrentPointer | null;
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
}

function readJsonObject(filePath: string): UnknownRecord | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as UnknownRecord
      : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: UnknownRecord): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function canonicalPath(value: string): string {
  return canonicalConfigDir(value);
}

function pathIsInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeImageSegment(value: unknown, fallback: string): string {
  const normalized = String(value || '')
    .trim()
    .replace(/[^0-9A-Za-z._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function packageVersion(packageRoot: string): string {
  return String(readJsonObject(path.join(packageRoot, 'package.json'))?.version || '').trim();
}

function packageImageMarkerFile(packageRoot: string): string {
  return path.join(packageRoot, PACKAGE_IMAGE_MARKER_NAME);
}

function readPackageImageMarker(packageRoot: string): PackageImageMarker | null {
  const value = readJsonObject(packageImageMarkerFile(packageRoot));
  if (
    value?.format !== PACKAGE_IMAGE_MARKER_FORMAT
    || !/^[a-f0-9]{16}$/.test(String(value.installationId || ''))
    || !path.isAbsolute(String(value.installationRoot || ''))
    || !path.isAbsolute(String(value.bootstrapPackageRoot || ''))
    || !/^[a-f0-9]{16}$/.test(String(value.imageId || ''))
    || !String(value.version || '').trim()
    || !String(value.sourceIntegrity || '').trim()
  ) return null;
  return value as PackageImageMarker;
}

function packageInstallationId(bootstrapPackageRoot: string): string {
  return crypto
    .createHash('sha256')
    .update('farming-package-installation-v1\0')
    .update(canonicalPath(bootstrapPackageRoot))
    .digest('hex')
    .slice(0, 16);
}

function defaultPackageInstallationsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.FARMING_PACKAGE_INSTALLATIONS_DIR || '').trim();
  if (explicit) return path.resolve(explicit);
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Farming', 'packages');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Farming', 'packages');
  }
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'farming', 'packages');
}

function isManagedNpmPackageRoot(packageRoot: string): boolean {
  if (fs.existsSync(path.join(packageRoot, '.git'))) return false;
  const release = readJsonObject(path.join(packageRoot, 'RELEASE.json')) || {};
  if (release.updateMethod === 'npm') return true;
  if (release.type && release.type !== 'npm') return false;
  const metadata = readJsonObject(path.join(packageRoot, 'package.json')) || {};
  return metadata.name === 'farming-code';
}

function contextFromValues(
  bootstrapPackageRoot: string,
  activePackageRoot: string,
  installationId: string,
  installationRoot: string,
): PackageInstallationContext {
  const canonicalInstallationRoot = canonicalPath(installationRoot);
  return {
    installationId,
    installationRoot: canonicalInstallationRoot,
    bootstrapPackageRoot: canonicalPath(bootstrapPackageRoot),
    activePackageRoot: canonicalPath(activePackageRoot),
    versionsDir: path.join(canonicalInstallationRoot, 'versions'),
    stagingDir: path.join(canonicalInstallationRoot, 'staging'),
    usageDir: path.join(canonicalInstallationRoot, 'usage'),
    currentFile: path.join(canonicalInstallationRoot, PACKAGE_CURRENT_NAME),
    mutationLockDir: path.join(canonicalInstallationRoot, '.mutation.lock'),
  };
}

function resolvePackageInstallationContext(
  packageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): PackageInstallationContext | null {
  const activePackageRoot = canonicalPath(packageRoot);
  const marker = readPackageImageMarker(activePackageRoot);
  if (marker) {
    return contextFromValues(
      marker.bootstrapPackageRoot,
      activePackageRoot,
      marker.installationId,
      marker.installationRoot,
    );
  }

  const environmentInstallationRoot = String(env.FARMING_PACKAGE_INSTALLATION_ROOT || '').trim();
  const environmentInstallationId = String(env.FARMING_PACKAGE_INSTALLATION_ID || '').trim();
  const environmentBootstrapRoot = String(env.FARMING_BOOTSTRAP_PACKAGE_ROOT || '').trim();
  if (environmentInstallationRoot || environmentInstallationId || environmentBootstrapRoot) {
    if (
      !path.isAbsolute(environmentInstallationRoot)
      || !/^[a-f0-9]{16}$/.test(environmentInstallationId)
      || !path.isAbsolute(environmentBootstrapRoot)
    ) {
      throw new Error('Farming package installation environment is incomplete or invalid');
    }
    return contextFromValues(
      environmentBootstrapRoot,
      activePackageRoot,
      environmentInstallationId,
      environmentInstallationRoot,
    );
  }

  if (!isManagedNpmPackageRoot(activePackageRoot)) return null;
  const installationId = packageInstallationId(activePackageRoot);
  const installationRoot = path.join(defaultPackageInstallationsDir(env), installationId);
  return contextFromValues(activePackageRoot, activePackageRoot, installationId, installationRoot);
}

function ensurePackageInstallationDirectories(context: PackageInstallationContext): void {
  fs.mkdirSync(context.versionsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(context.stagingDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(context.usageDir, { recursive: true, mode: 0o700 });
}

function applyPackageInstallationEnvironment(
  env: NodeJS.ProcessEnv,
  context: PackageInstallationContext,
  activePackageRoot: string,
): NodeJS.ProcessEnv {
  env.FARMING_PACKAGE_INSTALLATION_ID = context.installationId;
  env.FARMING_PACKAGE_INSTALLATION_ROOT = context.installationRoot;
  env.FARMING_BOOTSTRAP_PACKAGE_ROOT = context.bootstrapPackageRoot;
  env.FARMING_ACTIVE_PACKAGE_ROOT = canonicalPath(activePackageRoot);
  env.FARMING_MANAGED_PACKAGE_ROOT = env.FARMING_ACTIVE_PACKAGE_ROOT;
  return env;
}

function imageRefFromMarker(packageRoot: string, marker: PackageImageMarker): PackageImageRef {
  const canonicalRoot = canonicalPath(packageRoot);
  const relativePath = path.relative(canonicalPath(marker.installationRoot), canonicalRoot);
  return {
    imageId: marker.imageId,
    version: marker.version,
    sourceIntegrity: marker.sourceIntegrity,
    packageRoot: canonicalRoot,
    relativePath,
  };
}

function readPackageImageRef(packageRoot: string): PackageImageRef | null {
  const marker = readPackageImageMarker(packageRoot);
  return marker ? imageRefFromMarker(packageRoot, marker) : null;
}

function packageImageId(version: string, sourceIntegrity: string): string {
  return crypto
    .createHash('sha256')
    .update('farming-package-image-v1\0')
    .update(version)
    .update('\0')
    .update(sourceIntegrity)
    .digest('hex')
    .slice(0, 16);
}

function localPackageIntegrity(packageRoot: string): string {
  const digest = crypto.createHash('sha256').update('farming-local-package-v1\0');
  for (const name of ['package.json', 'package-lock.json', 'RELEASE.json']) {
    const filePath = path.join(packageRoot, name);
    digest.update(name).update('\0');
    try {
      digest.update(fs.readFileSync(filePath));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      digest.update('missing');
    }
    digest.update('\0');
  }
  return `local-sha256-${digest.digest('hex')}`;
}

function markerForImage(
  context: PackageInstallationContext,
  version: string,
  sourceIntegrity: string,
): PackageImageMarker {
  return {
    format: PACKAGE_IMAGE_MARKER_FORMAT,
    installationId: context.installationId,
    installationRoot: context.installationRoot,
    bootstrapPackageRoot: context.bootstrapPackageRoot,
    imageId: packageImageId(version, sourceIntegrity),
    version,
    sourceIntegrity,
    createdAt: new Date().toISOString(),
  };
}

function finalImageRoot(context: PackageInstallationContext, marker: PackageImageMarker): string {
  return path.join(
    context.versionsDir,
    `${safeImageSegment(marker.version, 'version')}-${marker.imageId}`,
  );
}

function verifyPublishedImage(
  context: PackageInstallationContext,
  packageRoot: string,
  expected: PackageImageMarker,
): PackageImageRef {
  const marker = readPackageImageMarker(packageRoot);
  if (
    !marker
    || marker.installationId !== context.installationId
    || marker.imageId !== expected.imageId
    || marker.version !== expected.version
    || marker.sourceIntegrity !== expected.sourceIntegrity
    || packageVersion(packageRoot) !== expected.version
  ) {
    throw new Error(`Farming package image ${expected.imageId} is incomplete or does not match its identity`);
  }
  return imageRefFromMarker(packageRoot, marker);
}

function publishPreparedPackageImage(
  context: PackageInstallationContext,
  preparedPackageRoot: string,
  version: string,
  sourceIntegrity: string,
): PackageImageRef {
  ensurePackageInstallationDirectories(context);
  const marker = markerForImage(context, version, sourceIntegrity);
  const targetRoot = finalImageRoot(context, marker);
  if (fs.existsSync(targetRoot)) return verifyPublishedImage(context, targetRoot, marker);
  if (packageVersion(preparedPackageRoot) !== version) {
    throw new Error(`Prepared Farming package version mismatch: expected ${version}`);
  }
  writeJsonAtomic(packageImageMarkerFile(preparedPackageRoot), marker);
  try {
    fs.renameSync(preparedPackageRoot, targetRoot);
  } catch (error) {
    if (!fs.existsSync(targetRoot)) throw error;
  }
  return verifyPublishedImage(context, targetRoot, marker);
}

function publishRunningPackageImage(
  context: PackageInstallationContext,
  runningPackageRoot: string,
): PackageImageRef {
  const existing = readPackageImageRef(runningPackageRoot);
  if (existing) {
    const marker = readPackageImageMarker(runningPackageRoot)!;
    if (marker.installationId !== context.installationId) {
      throw new Error('Running Farming package image belongs to another installation');
    }
    return existing;
  }

  ensurePackageInstallationDirectories(context);
  const version = packageVersion(runningPackageRoot);
  if (!version) throw new Error('Running Farming package has no version metadata');
  const sourceIntegrity = localPackageIntegrity(runningPackageRoot);
  const marker = markerForImage(context, version, sourceIntegrity);
  const targetRoot = finalImageRoot(context, marker);
  if (fs.existsSync(targetRoot)) return verifyPublishedImage(context, targetRoot, marker);

  const temporaryParent = fs.mkdtempSync(path.join(context.versionsDir, '.seed-'));
  const temporaryRoot = path.join(temporaryParent, 'package');
  try {
    fs.cpSync(runningPackageRoot, temporaryRoot, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    writeJsonAtomic(packageImageMarkerFile(temporaryRoot), marker);
    try {
      fs.renameSync(temporaryRoot, targetRoot);
    } catch (error) {
      if (!fs.existsSync(targetRoot)) throw error;
    }
    return verifyPublishedImage(context, targetRoot, marker);
  } finally {
    fs.rmSync(temporaryParent, { recursive: true, force: true });
  }
}

function currentPointerFromValue(
  context: PackageInstallationContext,
  value: UnknownRecord | null,
): PackageCurrentPointer | null {
  if (
    value?.format !== PACKAGE_CURRENT_FORMAT
    || value.installationId !== context.installationId
    || !/^[a-f0-9]{16}$/.test(String(value.imageId || ''))
    || !String(value.version || '').trim()
    || typeof value.relativePath !== 'string'
    || path.isAbsolute(value.relativePath)
    || (value.bootstrapSourceIntegrity !== undefined
      && typeof value.bootstrapSourceIntegrity !== 'string')
  ) return null;
  const packageRoot = path.resolve(context.installationRoot, value.relativePath);
  if (!pathIsInside(context.versionsDir, packageRoot)) return null;
  const image = readPackageImageRef(packageRoot);
  if (!image || image.imageId !== value.imageId || image.version !== value.version) return null;
  return value as PackageCurrentPointer;
}

function readCurrentPackagePointer(context: PackageInstallationContext): PackageCurrentPointer | null {
  return currentPointerFromValue(context, readJsonObject(context.currentFile));
}

function packageImageForPointer(
  context: PackageInstallationContext,
  pointer: PackageCurrentPointer | null,
): PackageImageRef | null {
  if (!pointer) return null;
  const packageRoot = path.resolve(context.installationRoot, pointer.relativePath);
  return readPackageImageRef(packageRoot);
}

function readPackageMutationOwner(context: PackageInstallationContext): PackageMutationOwner {
  return readJsonObject(path.join(context.mutationLockDir, 'owner.json')) as PackageMutationOwner || {};
}

function exactMutationIdentity(owner: PackageMutationOwner): ServerProcessIdentity | null {
  const identity = owner.processIdentity;
  if (
    identity?.format !== 'ps-lstart-c-utc-v1'
    || !Number.isSafeInteger(Number(identity.pid))
    || Number(identity.pid) <= 0
    || !Number.isSafeInteger(Number(identity.processGroupId))
    || Number(identity.processGroupId) <= 0
    || !String(identity.startedAt || '').trim()
  ) return null;
  return identity;
}

function mutationLockExists(context: PackageInstallationContext): boolean {
  try {
    fs.lstatSync(context.mutationLockDir);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function quarantineMutationLock(context: PackageInstallationContext, claimId: string): boolean {
  const destination = `${context.mutationLockDir}.stale-${claimId}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(context.mutationLockDir, destination);
    fs.rmSync(destination, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(errorCode(error))) return false;
    throw error;
  }
}

function acquirePackageMutation(context: PackageInstallationContext): {
  claimId: string;
  processIdentity: ServerProcessIdentity;
} {
  ensurePackageInstallationDirectories(context);
  const processIdentity = readServerProcessIdentity(process.pid);
  if (!processIdentity) throw new Error('Package activation process identity could not be verified');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const claimId = crypto.randomUUID();
    const claimDir = `${context.mutationLockDir}.claim-${claimId}`;
    fs.mkdirSync(claimDir, { mode: 0o700 });
    writeJsonAtomic(path.join(claimDir, 'owner.json'), {
      format: PACKAGE_MUTATION_OWNER_FORMAT,
      claimId,
      installationId: context.installationId,
      processIdentity,
      createdAt: new Date().toISOString(),
    });
    let published = false;
    try {
      if (!mutationLockExists(context)) {
        try {
          fs.renameSync(claimDir, context.mutationLockDir);
          published = true;
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes(errorCode(error))) throw error;
        }
      }
    } finally {
      fs.rmSync(claimDir, { recursive: true, force: true });
    }
    if (published) return { claimId, processIdentity };

    const owner = readPackageMutationOwner(context);
    const ownerIdentity = exactMutationIdentity(owner);
    const ownerClaimId = String(owner.claimId || '');
    if (
      owner.format !== PACKAGE_MUTATION_OWNER_FORMAT
      || owner.installationId !== context.installationId
      || !/^[0-9a-f-]{36}$/i.test(ownerClaimId)
      || !ownerIdentity
    ) {
      throw new Error('Farming package activation owner is incomplete; refusing to replace it');
    }
    const liveIdentity = readServerProcessIdentity(ownerIdentity.pid);
    if (matchingProcessIdentity(ownerIdentity, liveIdentity)) {
      throw new Error(`Another Farming process (${ownerIdentity.pid}) is publishing this installation`);
    }
    if (!quarantineMutationLock(context, ownerClaimId)) continue;
  }
  throw new Error('Farming package activation ownership changed repeatedly');
}

function releasePackageMutation(
  context: PackageInstallationContext,
  claim: { claimId: string; processIdentity: ServerProcessIdentity },
): void {
  const owner = readPackageMutationOwner(context);
  const ownerIdentity = exactMutationIdentity(owner);
  if (
    owner.claimId !== claim.claimId
    || !ownerIdentity
    || !matchingProcessIdentity(claim.processIdentity, ownerIdentity)
  ) return;
  quarantineMutationLock(context, claim.claimId);
}

function writeCurrentPointer(
  context: PackageInstallationContext,
  image: PackageImageRef,
  previous: PackageCurrentPointer | null,
  bootstrapSourceIntegrity = previous?.bootstrapSourceIntegrity || '',
): PackageCurrentPointer {
  const pointer: PackageCurrentPointer = {
    format: PACKAGE_CURRENT_FORMAT,
    installationId: context.installationId,
    imageId: image.imageId,
    version: image.version,
    relativePath: path.relative(context.installationRoot, image.packageRoot),
    ...(previous ? {
      previousImageId: previous.imageId,
      previousRelativePath: previous.relativePath,
    } : {}),
    ...(bootstrapSourceIntegrity ? { bootstrapSourceIntegrity } : {}),
    activatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(context.currentFile, pointer);
  return pointer;
}

function initializeCurrentPackageImage(
  context: PackageInstallationContext,
  image: PackageImageRef,
): PackageCurrentPointer {
  const claim = acquirePackageMutation(context);
  try {
    const current = readCurrentPackagePointer(context);
    return current || writeCurrentPointer(
      context,
      image,
      null,
      localPackageIntegrity(context.bootstrapPackageRoot),
    );
  } finally {
    releasePackageMutation(context, claim);
  }
}

function adoptChangedBootstrapPackage(
  context: PackageInstallationContext,
  bootstrapPackageRoot: string,
  observedCurrent: PackageCurrentPointer,
): PackageImageRef | null {
  const bootstrapSourceIntegrity = localPackageIntegrity(bootstrapPackageRoot);
  if (
    !observedCurrent.bootstrapSourceIntegrity
    || observedCurrent.bootstrapSourceIntegrity === bootstrapSourceIntegrity
  ) return packageImageForPointer(context, observedCurrent);

  const bootstrapImage = publishRunningPackageImage(context, bootstrapPackageRoot);
  const claim = acquirePackageMutation(context);
  try {
    const current = readCurrentPackagePointer(context);
    if (!current) {
      writeCurrentPointer(context, bootstrapImage, null, bootstrapSourceIntegrity);
      return bootstrapImage;
    }
    if (current.bootstrapSourceIntegrity === bootstrapSourceIntegrity) {
      return packageImageForPointer(context, current);
    }
    writeCurrentPointer(context, bootstrapImage, current, bootstrapSourceIntegrity);
    return bootstrapImage;
  } finally {
    releasePackageMutation(context, claim);
  }
}

function activatePackageImage(
  context: PackageInstallationContext,
  image: PackageImageRef,
  expectedCurrentImageId = '',
): ActivatePackageImageResult {
  const marker = readPackageImageMarker(image.packageRoot);
  if (!marker || marker.installationId !== context.installationId || marker.imageId !== image.imageId) {
    throw new Error('Target Farming package image does not belong to this installation');
  }
  const claim = acquirePackageMutation(context);
  try {
    const previous = readCurrentPackagePointer(context);
    if (previous?.imageId === image.imageId) {
      return { changed: false, current: previous, previous };
    }
    if (expectedCurrentImageId && previous?.imageId !== expectedCurrentImageId) {
      throw new Error(
        `Farming package selection changed from ${expectedCurrentImageId} to ${previous?.imageId || 'none'}; refresh and retry`,
      );
    }
    const current = writeCurrentPointer(context, image, previous);
    return { changed: true, current, previous };
  } finally {
    releasePackageMutation(context, claim);
  }
}

function resolvePackageLaunch(
  bootstrapPackageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): { context: PackageInstallationContext | null; packageRoot: string } {
  const ownRoot = canonicalPath(bootstrapPackageRoot);
  const ownMarker = readPackageImageMarker(ownRoot);
  if (ownMarker) {
    const context = resolvePackageInstallationContext(ownRoot, env)!;
    return { context, packageRoot: ownRoot };
  }
  const context = resolvePackageInstallationContext(ownRoot, env);
  if (!context) return { context: null, packageRoot: ownRoot };
  const current = readCurrentPackagePointer(context);
  const selected = current
    ? adoptChangedBootstrapPackage(context, ownRoot, current)
    : null;
  return { context, packageRoot: selected?.packageRoot || ownRoot };
}

function usageFile(context: PackageInstallationContext, configDir: string): string {
  return path.join(context.usageDir, `${configInstanceFingerprint(configDir)}.json`);
}

function registerPackageImageUsage(
  context: PackageInstallationContext,
  configDir: string,
  image: PackageImageRef,
  processIdentity: ServerProcessIdentity,
): void {
  ensurePackageInstallationDirectories(context);
  const record: PackageUsageRecord = {
    format: PACKAGE_USAGE_FORMAT,
    installationId: context.installationId,
    configFingerprint: configInstanceFingerprint(configDir),
    configDir: canonicalPath(configDir),
    imageId: image.imageId,
    version: image.version,
    packageRoot: image.packageRoot,
    processIdentity,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(usageFile(context, configDir), record);
}

function releasePackageImageUsage(
  context: PackageInstallationContext,
  configDir: string,
  expectedIdentity: ServerProcessIdentity | null | undefined,
): void {
  const filePath = usageFile(context, configDir);
  const record = readJsonObject(filePath) as PackageUsageRecord | null;
  if (
    record?.format !== PACKAGE_USAGE_FORMAT
    || record.installationId !== context.installationId
    || !matchingProcessIdentity(expectedIdentity, record.processIdentity)
  ) return;
  fs.rmSync(filePath, { force: true });
}

function protectedPackageImageIds(context: PackageInstallationContext): Set<string> {
  const protectedIds = new Set<string>();
  const current = readCurrentPackagePointer(context);
  if (current?.imageId) protectedIds.add(current.imageId);
  if (current?.previousImageId) protectedIds.add(current.previousImageId);
  let names: string[] = [];
  try {
    names = fs.readdirSync(context.usageDir);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  for (const name of names) {
    if (!/^[a-f0-9]{16}\.json$/.test(name)) continue;
    const filePath = path.join(context.usageDir, name);
    let record: PackageUsageRecord;
    try {
      record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PackageUsageRecord;
    } catch (error) {
      throw new Error(`Farming package usage record ${name} is unreadable; refusing to prune`, {
        cause: error,
      });
    }
    if (
      record?.format !== PACKAGE_USAGE_FORMAT
      || record.installationId !== context.installationId
      || !record.processIdentity
      || !record.imageId
    ) {
      throw new Error(`Farming package usage record ${name} is invalid; refusing to prune`);
    }
    let currentIdentity: ServerProcessIdentity | null;
    try {
      currentIdentity = readServerProcessIdentity(record.processIdentity.pid);
    } catch {
      protectedIds.add(record.imageId);
      continue;
    }
    if (matchingProcessIdentity(record.processIdentity, currentIdentity)) {
      protectedIds.add(record.imageId);
    } else {
      fs.rmSync(filePath, { force: true });
    }
  }
  return protectedIds;
}

function prunePackageImages(
  context: PackageInstallationContext,
  keepCount = DEFAULT_RETAINED_PACKAGE_IMAGES,
): { removed: string[]; retained: string[] } {
  ensurePackageInstallationDirectories(context);
  const protectedIds = protectedPackageImageIds(context);
  const images = fs.readdirSync(context.versionsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => {
      const packageRoot = path.join(context.versionsDir, entry.name);
      const marker = readPackageImageMarker(packageRoot);
      let modifiedAt = 0;
      try {
        modifiedAt = fs.statSync(packageRoot).mtimeMs;
      } catch {
        // The entry disappeared during inspection.
      }
      return { packageRoot, marker, modifiedAt };
    })
    .filter(item => item.marker?.installationId === context.installationId)
    .sort((left, right) => right.modifiedAt - left.modifiedAt);

  const retained = new Set<string>();
  for (const item of images.slice(0, Math.max(0, keepCount))) retained.add(item.marker!.imageId);
  for (const id of protectedIds) retained.add(id);
  const removed: string[] = [];
  for (const item of images) {
    const marker = item.marker!;
    if (retained.has(marker.imageId)) continue;
    fs.rmSync(item.packageRoot, { recursive: true, force: true });
    removed.push(marker.imageId);
  }
  return { removed, retained: [...retained] };
}

export {
  PACKAGE_CURRENT_FORMAT,
  PACKAGE_IMAGE_MARKER_FORMAT,
  PACKAGE_IMAGE_MARKER_NAME,
  activatePackageImage,
  applyPackageInstallationEnvironment,
  defaultPackageInstallationsDir,
  ensurePackageInstallationDirectories,
  initializeCurrentPackageImage,
  isManagedNpmPackageRoot,
  localPackageIntegrity,
  packageImageForPointer,
  packageImageId,
  packageImageMarkerFile,
  packageInstallationId,
  protectedPackageImageIds,
  prunePackageImages,
  publishPreparedPackageImage,
  publishRunningPackageImage,
  readCurrentPackagePointer,
  readPackageImageMarker,
  readPackageImageRef,
  registerPackageImageUsage,
  releasePackageImageUsage,
  resolvePackageInstallationContext,
  resolvePackageLaunch,
};
export type {
  ActivatePackageImageResult,
  PackageCurrentPointer,
  PackageImageMarker,
  PackageImageRef,
  PackageInstallationContext,
};
