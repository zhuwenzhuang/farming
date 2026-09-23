import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const visited = new Set();
const notices = new Map();

function packageRoot(name, from) {
  let current = from;
  while (current.startsWith(root)) {
    const candidate = path.join(current, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    current = path.dirname(current);
  }
  return null;
}

function visit(directory) {
  if (visited.has(directory)) return;
  visited.add(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const identity = `${manifest.name}@${manifest.version}`;
  const files = fs.readdirSync(directory).filter(name => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name)
    && fs.statSync(path.join(directory, name)).isFile()).sort();
  notices.set(identity, [`${identity} (${manifest.license || 'see package notices'})`,
    ...files.map(name => `${name}\n${fs.readFileSync(path.join(directory, name), 'utf8')}`)].join('\n\n'));
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
    const dependency = packageRoot(name, directory);
    if (dependency) visit(dependency);
    else if (manifest.dependencies?.[name] && !manifest.optionalDependencies?.[name]) {
      throw new Error(`Missing frontend license dependency: ${identity} -> ${name}`);
    }
  }
}

for (const name of ['@visactor/vtable', 'mermaid', 'monaco-editor']) {
  const directory = packageRoot(name, root);
  if (!directory) throw new Error(`Missing frontend build dependency: ${name}`);
  visit(directory);
}
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/frontend-licenses.txt'),
  [...notices].sort(([a], [b]) => a.localeCompare(b)).map(([, notice]) => notice).join('\n\n----------------------------------------\n\n') + '\n');
console.log(`Preserved ${notices.size} frontend dependency notices.`);
