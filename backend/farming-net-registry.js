const fs = require('fs');
const path = require('path');

const ENDPOINT_SCOPES = new Set(['this-device', 'intranet', 'remote', 'tunnel']);

function boundedText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeEndpointUrl(value) {
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

function normalizeEndpoint(rawEndpoint) {
  if (!rawEndpoint || typeof rawEndpoint !== 'object' || Array.isArray(rawEndpoint)) return null;
  const url = normalizeEndpointUrl(rawEndpoint.url);
  if (!url) return null;
  const scope = ENDPOINT_SCOPES.has(rawEndpoint.scope) ? rawEndpoint.scope : 'remote';
  return {
    label: boundedText(rawEndpoint.label, 40) || 'Open',
    url,
    scope,
    primary: rawEndpoint.primary === true,
  };
}

function normalizeInstance(rawInstance) {
  if (!rawInstance || typeof rawInstance !== 'object' || Array.isArray(rawInstance)) return null;
  const id = boundedText(rawInstance.id, 64).toLowerCase();
  const name = boundedText(rawInstance.name, 80);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || !name) return null;

  const seenUrls = new Set();
  const endpoints = (Array.isArray(rawInstance.endpoints) ? rawInstance.endpoints : [])
    .map(normalizeEndpoint)
    .filter(Boolean)
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

function normalizeFarmingNetRegistry(rawRegistry) {
  const source = rawRegistry && typeof rawRegistry === 'object' && !Array.isArray(rawRegistry)
    ? rawRegistry
    : {};
  const seenIds = new Set();
  const instances = (Array.isArray(source.instances) ? source.instances : [])
    .map(normalizeInstance)
    .filter(Boolean)
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

function writeFarmingNetRegistry(filePath, registry) {
  const normalized = normalizeFarmingNetRegistry(registry);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

function loadFarmingNetRegistry(filePath) {
  try {
    return normalizeFarmingNetRegistry(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
    return writeFarmingNetRegistry(filePath, { version: 1, title: 'Farming Net', instances: [] });
  }
}

module.exports = {
  ENDPOINT_SCOPES,
  loadFarmingNetRegistry,
  normalizeEndpointUrl,
  normalizeFarmingNetRegistry,
  writeFarmingNetRegistry,
};
