import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  COMPUTER_DRIVER_VERSION,
  COMPUTER_SCHEMA_SHA256,
  COMPUTER_TOOL_COUNT,
} from './computer-constants.cjs';

interface ComputerToolDescriptor extends Record<string, unknown> {
  annotations?: Record<string, unknown>;
  description?: string;
  inputSchema?: Record<string, unknown>;
  name: string;
  upstreamName: string;
}

interface ComputerToolManifest {
  driverVersion: string;
  toolCount: number;
  tools: ComputerToolDescriptor[];
}

function loadComputerToolManifest(): ComputerToolManifest {
  const file = path.join(__dirname, 'cua-tools.json');
  const bytes = fs.readFileSync(file);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== COMPUTER_SCHEMA_SHA256) {
    throw new Error(`Farming Computer tool schema integrity mismatch: ${sha256}`);
  }
  const manifest = JSON.parse(bytes.toString('utf8')) as ComputerToolManifest;
  if (
    manifest.driverVersion !== COMPUTER_DRIVER_VERSION
    || manifest.toolCount !== COMPUTER_TOOL_COUNT
    || manifest.tools.length !== COMPUTER_TOOL_COUNT
  ) {
    throw new Error('Farming Computer tool schema does not match the pinned Cua Driver contract');
  }
  return manifest;
}

export {
  loadComputerToolManifest,
  type ComputerToolDescriptor,
  type ComputerToolManifest,
};
