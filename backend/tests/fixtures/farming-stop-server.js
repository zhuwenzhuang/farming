const http = require('http');

const basePath = String(process.env.FARMING_BASE_PATH || '/farming').replace(/\/$/, '');
const server = http.createServer((req, res) => {
  if (req.url === `${basePath}/api/settings`) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ settings: { workspace: process.env.FARMING_CONFIG_DIR || '' } }));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

process.on('SIGTERM', () => {
  process.send?.({ type: 'stop-requested' });
});

process.on('message', message => {
  if (message?.type !== 'release') return;
  server.close(() => process.exit(0));
});

server.listen(Number(process.env.FARMING_TEST_PORT || 0), '127.0.0.1', () => {
  process.send?.({ type: 'listening', port: server.address().port });
});
