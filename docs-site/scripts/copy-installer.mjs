import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const output = new URL('../public/install.sh', import.meta.url);
mkdirSync(fileURLToPath(new URL('../public/', import.meta.url)), { recursive: true });
copyFileSync(new URL('../../bin/install.sh', import.meta.url), output);
