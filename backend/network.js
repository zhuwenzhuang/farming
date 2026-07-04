const os = require('os');

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];

  for (const [, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      if (addr.family !== 'IPv4') continue;
      ips.push(addr.address);
    }
  }

  return ips;
}

module.exports = { getLocalIPs };
