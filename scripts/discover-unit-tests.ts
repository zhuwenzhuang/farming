import fs from 'node:fs';
import path from 'node:path';

/** Recursively discovers `*.test.ts` unit tests; Playwright `*.spec.ts` files never match. */
export function discoverUnitTestFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry): string[] => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return discoverUnitTestFiles(entryPath);
      return entry.isFile() && entry.name.endsWith('.test.ts') ? [entryPath] : [];
    })
    .sort();
}
