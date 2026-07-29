const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const packageJson = require('../../package.json');

assert.strictEqual(packageJson.dependencies.compression, '^1.8.1');
assert(
  serverSource.includes('app.use(compression())'),
  'HTTP compression must run before static assets are served',
);
assert(
  serverSource.includes("routePath(BASE_PATH, '/assets')") &&
    serverSource.includes("maxAge: '1y'") &&
    serverSource.includes('immutable: true'),
  'content-hashed Vite assets must use a long immutable browser cache',
);
assert(
  serverSource.includes("res.setHeader('Cache-Control', 'no-cache')"),
  'the HTML entry must remain revalidated so deployments select the latest hashed assets',
);

console.log('test-static-asset-delivery passed');
