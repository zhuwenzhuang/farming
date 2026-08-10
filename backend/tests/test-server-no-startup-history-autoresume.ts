const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.cts'), 'utf8');

assert(
  !serverSource.includes('void autoResumeMainPageAgentSessions();'),
  'Server readiness must not automatically start every persisted main-page history Session',
);

console.log('Server startup leaves persisted history Runtime recovery on demand');
