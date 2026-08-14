import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const EXTENSION_DIRECTORY_NAME = 'farming-browser-connector';

export function browserExtensionPath(configDir: string): string {
  const resolvedConfigDir = path.resolve(configDir);
  const configName = path.basename(resolvedConfigDir);
  const directoryName = configName === '.farming'
    ? EXTENSION_DIRECTORY_NAME
    : `${EXTENSION_DIRECTORY_NAME}-${configName.replace(/^\.+/u, '') || 'config'}`;
  return path.join(path.dirname(resolvedConfigDir), directoryName);
}

function linkType(): fs.symlink.Type {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

function createExtensionLink(source: string, destination: string): void {
  fs.symlinkSync(path.resolve(source), destination, linkType());
}

export function ensureBrowserExtensionLink(source: string, configDir: string): string {
  if (!fs.existsSync(path.join(source, 'manifest.json'))) {
    throw new Error('Farming Browser Connector is missing from this installation');
  }

  const destination = browserExtensionPath(configDir);
  const expectedTarget = fs.realpathSync(source);
  let current: fs.Stats | null = null;
  try {
    current = fs.lstatSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (!current) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    createExtensionLink(source, destination);
    return destination;
  }
  if (!current.isSymbolicLink()) {
    throw new Error(`${destination} already exists and is not managed by Farming`);
  }
  try {
    if (fs.realpathSync(destination) === expectedTarget) return destination;
  } catch {
    // Broken or outdated Farming links are replaced atomically below.
  }

  const parent = path.dirname(destination);
  const staging = path.join(parent, `.${path.basename(destination)}.linking-${crypto.randomUUID()}`);
  const previous = path.join(parent, `.${path.basename(destination)}.previous-${crypto.randomUUID()}`);
  createExtensionLink(source, staging);
  try {
    fs.renameSync(destination, previous);
    fs.renameSync(staging, destination);
    fs.unlinkSync(previous);
  } catch (error) {
    if (!fs.existsSync(destination) && fs.existsSync(previous)) fs.renameSync(previous, destination);
    fs.rmSync(staging, { force: true });
    throw error;
  }
  return destination;
}
