const http = require('http');

const basePath = String(process.env.FARMING_BASE_PATH || '/farming').replace(/\/$/, '');
const server = http.createServer((req, res) => {
  if (req.url === `${basePath}/api/settings`) {
    if (process.env.FARMING_TEST_REJECT_COOKIE === '1' && req.headers.cookie) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'No-auth probe must not send a Cookie' }));
      return;
    }
    const expectedToken = process.env.FARMING_TEST_TOKEN || '';
    if (expectedToken && req.headers.cookie !== `farming_token=${encodeURIComponent(expectedToken)}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'Token required' }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ settings: { workspace: process.env.FARMING_TEST_WORKSPACE || '/non-default-workspace' } }));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(Number(process.env.FARMING_TEST_PORT || 0), '127.0.0.1', () => {
  process.send?.({ type: 'listening', port: server.address().port });
});
