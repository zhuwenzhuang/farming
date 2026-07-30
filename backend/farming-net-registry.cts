const fs = require('fs');
const path = require('path');

type EndpointScope = 'this-device' | 'intranet' | 'remote' | 'tunnel';

export interface FarmingNetEndpoint {
  label: string;
  primary: boolean;
  scope: EndpointScope;
  url: string;
}

export interface FarmingNetInstance {
  description: string;
  endpoints: FarmingNetEndpoint[];
  federated: boolean;
  id: string;
  name: string;
  owner: string;
  pinned: boolean;
  platform: string;
}

export interface FarmingNetRegistry {
  instances: FarmingNetInstance[];
  subtitle: string;
  title: string;
  version: 1;
}

const ENDPOINT_SCOPES = new Set<EndpointScope>(['this-device', 'intranet', 'remote', 'tunnel']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): string {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeEndpointUrl(value: unknown): string {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeEndpoint(rawEndpoint: unknown): FarmingNetEndpoint | null {
  if (!isObject(rawEndpoint)) return null;
  const url = normalizeEndpointUrl(rawEndpoint.url);
  if (!url) return null;
  const scope = typeof rawEndpoint.scope === 'string'
    && ENDPOINT_SCOPES.has(rawEndpoint.scope as EndpointScope)
    ? rawEndpoint.scope as EndpointScope
    : 'remote';
  return {
    label: boundedText(rawEndpoint.label, 40) || 'Open',
    url,
    scope,
    primary: rawEndpoint.primary === true,
  };
}

function normalizeInstance(rawInstance: unknown): FarmingNetInstance | null {
  if (!isObject(rawInstance)) return null;
  const id = boundedText(rawInstance.id, 64).toLowerCase();
  const name = boundedText(rawInstance.name, 80);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || !name) return null;

  const seenUrls = new Set<string>();
  const endpoints = (Array.isArray(rawInstance.endpoints) ? rawInstance.endpoints : [])
    .map(normalizeEndpoint)
    .filter((endpoint): endpoint is FarmingNetEndpoint => endpoint !== null)
    .filter(endpoint => {
      if (seenUrls.has(endpoint.url)) return false;
      seenUrls.add(endpoint.url);
      return true;
    })
    .slice(0, 8);
  if (endpoints.length === 0) return null;
  if (!endpoints.some(endpoint => endpoint.primary)) endpoints[0].primary = true;

  return {
    id,
    name,
    owner: boundedText(rawInstance.owner, 80),
    description: boundedText(rawInstance.description, 180),
    federated: rawInstance.federated === true,
    platform: boundedText(rawInstance.platform, 40),
    pinned: rawInstance.pinned === true,
    endpoints,
  };
}

function normalizeFarmingNetRegistry(rawRegistry: unknown): FarmingNetRegistry {
  const source = isObject(rawRegistry)
    ? rawRegistry
    : {};
  const seenIds = new Set<string>();
  const instances = (Array.isArray(source.instances) ? source.instances : [])
    .map(normalizeInstance)
    .filter((instance): instance is FarmingNetInstance => instance !== null)
    .filter(instance => {
      if (seenIds.has(instance.id)) return false;
      seenIds.add(instance.id);
      return true;
    })
    .slice(0, 200);

  return {
    version: 1,
    title: boundedText(source.title, 80) || 'Farming Net',
    subtitle: boundedText(source.subtitle, 160),
    instances,
  };
}

function writeFarmingNetRegistry(filePath: string, registry: unknown): FarmingNetRegistry {
  const normalized = normalizeFarmingNetRegistry(registry);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

function loadFarmingNetRegistry(filePath: string): FarmingNetRegistry {
  try {
    return normalizeFarmingNetRegistry(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return writeFarmingNetRegistry(filePath, { version: 1, title: 'Farming Net', instances: [] });
  }
}

export {
  ENDPOINT_SCOPES,
  loadFarmingNetRegistry,
  normalizeEndpointUrl,
  normalizeFarmingNetRegistry,
  writeFarmingNetRegistry,
};
