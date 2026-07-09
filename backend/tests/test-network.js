const assert = require('assert');

const { getLocalIPs, getPrimaryLocalIP } = require('../network');

function run() {
  const ips = getLocalIPs();
  assert(Array.isArray(ips));
  assert(ips.every(ip => typeof ip === 'string' && ip.length > 0));
  assert.strictEqual(typeof getPrimaryLocalIP(), 'string');
  assert(getPrimaryLocalIP().length > 0);

  console.log('✓ Network helpers expose a stable primary system IP');
}

run();
