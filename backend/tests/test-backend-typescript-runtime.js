const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backendDir = path.resolve(__dirname, '..');
const packageJson = require('../../package.json');
const modules = fs.readdirSync(backendDir)
  .filter(fileName => fileName.endsWith('.cts'))
  .map(fileName => fileName.slice(0, -'.cts'.length))
  .sort();

for (const moduleName of modules) {
  assert(fs.existsSync(path.join(backendDir, `${moduleName}.cts`)), `${moduleName} TypeScript source is missing`);
  assert(fs.existsSync(path.join(backendDir, `${moduleName}.cjs`)), `${moduleName} compiled runtime is missing`);
  assert(!fs.existsSync(path.join(backendDir, `${moduleName}.js`)), `${moduleName} legacy JavaScript still exists`);
  assert.doesNotThrow(() => require(path.join(backendDir, `${moduleName}.cjs`)));
}

assert(packageJson.files.includes('backend/*.cjs'), 'npm package must include compiled backend TypeScript');
assert(!packageJson.files.includes('backend/*.cts'), 'npm package must not execute or ship backend TypeScript source');
assert(!packageJson.files.includes('backend/*.ts'), 'npm package must not execute or ship backend TypeScript source');

console.log('backend TypeScript runtime boundary assertions passed');
