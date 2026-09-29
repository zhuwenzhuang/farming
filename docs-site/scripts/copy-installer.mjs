import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

mkdirSync(fileURLToPath(new URL('../public/', import.meta.url)), { recursive: true });
for (const name of ['farming_install.sh', 'install.sh']) {
  copyFileSync(new URL('../../bin/install.sh', import.meta.url), new URL(`../public/${name}`, import.meta.url));
}
