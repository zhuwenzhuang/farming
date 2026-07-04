const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const source = fs.readFileSync(path.join(__dirname, '../..', 'vite.config.ts'), 'utf8');

  assert(
    source.includes('process.env.FARMING_BASE_PATH') &&
      source.includes('env.FARMING_BASE_PATH') &&
      source.indexOf('process.env.FARMING_BASE_PATH') < source.indexOf('env.FARMING_BASE_PATH'),
    'Vite base path must honor shell FARMING_BASE_PATH before env files so npm start works under /farming'
  );

  console.log('✓ Vite base path honors shell FARMING_BASE_PATH');
}

run();
