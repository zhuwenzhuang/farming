'use strict';

import * as os from 'os';

function getLocalIPs(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];

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

function getPrimaryLocalIP(): string {
  return getLocalIPs()[0] || '127.0.0.1';
}

export { getLocalIPs, getPrimaryLocalIP };
