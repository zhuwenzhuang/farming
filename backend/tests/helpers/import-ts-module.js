const Module = require('module');
const path = require('path');
const esbuild = require('esbuild');

const projectRoot = path.resolve(__dirname, '../../..');
const moduleCache = new Map();

function importTsModule(relativePath) {
  const entryPoint = path.resolve(projectRoot, relativePath);
  if (moduleCache.has(entryPoint)) return moduleCache.get(entryPoint);

  const result = esbuild.buildSync({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    write: false,
    absWorkingDir: projectRoot,
    alias: {
      '@': path.join(projectRoot, 'src'),
    },
  });
  const output = result.outputFiles[0]?.text;
  if (!output) throw new Error(`Failed to bundle ${relativePath}`);

  const compiled = new Module(entryPoint, module);
  compiled.filename = entryPoint;
  compiled.paths = Module._nodeModulePaths(path.dirname(entryPoint));
  compiled._compile(output, entryPoint);
  moduleCache.set(entryPoint, compiled.exports);
  return compiled.exports;
}

module.exports = {
  importTsModule,
};
