import fs from 'node:fs/promises';
import path from 'node:path';

export const FRONTEND_ASSET_RETENTION_MS = 24 * 60 * 60 * 1000;

// Source servers can outlive several Vite builds. Keep the previous immutable
// chunks outside dist before Vite empties it, without shipping them in releases.
export async function preserveFrontendAssets(projectRoot: string, now = Date.now()): Promise<void> {
  const source = path.join(projectRoot, 'dist', 'assets');
  const retained = path.join(projectRoot, '.tmp', 'frontend-assets');
  const readEntries = async (directory: string) => fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const sourceEntries = await readEntries(source);
  if (sourceEntries.length) await fs.mkdir(retained, { recursive: true });
  for (const entry of sourceEntries) {
    if (!entry.isFile()) throw new Error(`Unexpected frontend asset entry: ${entry.name}`);
    const destination = path.join(retained, entry.name);
    try {
      await fs.copyFile(path.join(source, entry.name), destination, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await fs.lstat(destination)).isFile()) throw new Error(`Invalid retained frontend asset: ${entry.name}`, { cause: error });
    }
    await fs.utimes(destination, now / 1000, now / 1000);
  }
  for (const entry of await readEntries(retained)) {
    if (!entry.isFile()) throw new Error(`Unexpected retained frontend asset entry: ${entry.name}`);
    const filename = path.join(retained, entry.name);
    if (now - (await fs.stat(filename)).mtimeMs > FRONTEND_ASSET_RETENTION_MS) await fs.unlink(filename);
  }
}
