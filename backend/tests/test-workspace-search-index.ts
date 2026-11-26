import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceFileService } from '../workspace-file-service.cjs';

async function run(): Promise<void> {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'farming-search-index-')));
  const service = new WorkspaceFileService();
  try {
    // Build a realistic project tree with deep paths, snake_case, CamelCase, and ties.
    fs.mkdirSync(path.join(tmpRoot, 'task', 'sql_task', 'execution_engine', 'streamline'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'docs', 'empty-topic'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'noise', 'n-e-w-f-i-l-e'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpRoot, 'task', 'sql_task', 'execution_engine', 'streamline', 'slx_columnar_serialize_buffer.h'),
      '// header\n',
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'task', 'sql_task', 'execution_engine', 'streamline', 'slx_columnar_serialize_buffer.cpp'),
      '// impl\n',
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'task', 'sql_task', 'execution_engine', 'streamline', 'pipeline_buffer_writer.cpp'),
      '// writer\n',
    );
    fs.writeFileSync(path.join(tmpRoot, 'src', 'components', 'AppState.tsx'), 'export const AppState = 1;\n');
    fs.writeFileSync(path.join(tmpRoot, 'src', 'components', 'appstate_legacy.tsx'), 'export const legacy = 1;\n');
    fs.writeFileSync(path.join(tmpRoot, 'src', 'components', 'alpha_tie.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(tmpRoot, 'src', 'components', 'beta_tie.ts'), 'export const b = 2;\n');
    fs.writeFileSync(path.join(tmpRoot, 'noise', 'n-e-w-f-i-l-e', 'dummy.ts'), 'export {};\n');

    // 1. Cold build populates the in-memory index; second search hits cache in RAM.
    const cold = await service.searchIndex.search(tmpRoot, 'slx_columnar_serialize_buffer', {
      limit: 10,
      timeoutMs: 3000,
    });
    assert.strictEqual(cold.cacheHit, false);
    assert.strictEqual(cold.matches.length, 2);
    assert(cold.matches[0].path.endsWith('slx_columnar_serialize_buffer.h')
      || cold.matches[0].path.endsWith('slx_columnar_serialize_buffer.cpp'));
    assert(cold.matches[0].ranges.length > 0, 'path matches must include exact highlight ranges');

    const stats = service.searchIndex.getStats(tmpRoot);
    assert.strictEqual(stats.ready, true);
    assert(stats.fileCount >= 7);
    assert(stats.directoryCount >= 6);

    const warm = await service.searchIndex.search(tmpRoot, 'slx_columnar_serialize_buffer', {
      limit: 10,
      timeoutMs: 3000,
    });
    assert.strictEqual(warm.cacheHit, true);
    assert.deepStrictEqual(
      warm.matches.map(m => m.path),
      cold.matches.map(m => m.path),
    );

    // 2. Arbitrary-length (>6 chars) fuzzy subsequence matching returns exact character ranges.
    const longFuzzy = await service.search(tmpRoot, 'slxcolserbuf', { scope: 'entries', limit: 10 });
    assert(longFuzzy.matches.length >= 2, '12-char fuzzy query should match slx_columnar_serialize_buffer files');
    const firstLong = longFuzzy.matches[0] as { path: string; ranges: Array<{ start: number; end: number }> };
    assert(firstLong.path.includes('slx_columnar_serialize_buffer'));
    const highlighted = firstLong.ranges.map(r => firstLong.path.slice(r.start, r.end)).join('');
    assert.strictEqual(highlighted.toLowerCase(), 'slxcolserbuf');

    // 3. Multi-token space-separated queries match across directory + basename with exact ranges.
    const multiToken = await service.search(tmpRoot, 'streamline buf', { scope: 'entries', limit: 10 });
    assert(multiToken.matches.length >= 3);
    assert(
      multiToken.matches.every((m: { path: string }) => m.path.includes('streamline') && m.path.includes('buf')),
      'multi-token query should require every token to match',
    );
    const multiFirst = multiToken.matches[0] as { path: string; ranges: Array<{ start: number; end: number }> };
    const multiHighlights = multiFirst.ranges.map(r => multiFirst.path.slice(r.start, r.end).toLowerCase());
    assert(multiHighlights.includes('streamline'), 'multi-token highlight must cover directory token');
    assert(multiHighlights.includes('buf'), 'multi-token highlight must cover filename token');

    // 4. Smart Case soft tie-breaker prefers matching uppercase letters.
    const smartCase = await service.search(tmpRoot, 'AppState', { scope: 'entries', limit: 10 });
    const smartFiles = (smartCase.matches as Array<{ entryType: string; path: string }>)
      .filter(m => m.entryType === 'file');
    assert.strictEqual(smartFiles[0].path, 'src/components/AppState.tsx');

    // 5. MRU frecency boost breaks ties in favor of recently read file.
    await service.readFile(tmpRoot, 'src/components/beta_tie.ts');
    const tieSearch = await service.search(tmpRoot, 'tie', { scope: 'entries', limit: 10 });
    const tieFiles = (tieSearch.matches as Array<{ entryType: string; path: string }>)
      .filter(m => m.entryType === 'file');
    assert.strictEqual(tieFiles[0].path, 'src/components/beta_tie.ts');

    // 6. Empty directories are indexed and searchable in memory.
    const emptyDirSearch = await service.search(tmpRoot, 'empty-topic', { scope: 'entries', limit: 10 });
    assert(emptyDirSearch.matches.some((m: { entryType: string; path: string }) => (
      m.entryType === 'directory' && m.path === 'docs/empty-topic'
    )));

    // 7. External filesystem writes invalidate the snapshot immediately via quick fingerprint.
    fs.writeFileSync(path.join(tmpRoot, 'src', 'components', 'fresh_external_file.ts'), 'export const fresh = 1;\n');
    const afterExternalWrite = await service.search(tmpRoot, 'fresh_external_file', { scope: 'entries', limit: 10 });
    assert(afterExternalWrite.matches.some((m: { path: string }) => m.path === 'src/components/fresh_external_file.ts'));

    // 8. WorkspaceFileService mutations invalidate the index cleanly.
    await service.createEntry(tmpRoot, 'src/components', 'created_via_service.ts', 'file', 'export {};\n');
    const afterCreate = await service.search(tmpRoot, 'created_via_service', { scope: 'entries', limit: 10 });
    assert(afterCreate.matches.some((m: { path: string }) => m.path === 'src/components/created_via_service.ts'));

    await service.deleteEntry(tmpRoot, 'src/components/created_via_service.ts');
    const afterDelete = await service.search(tmpRoot, 'created_via_service', { scope: 'entries', limit: 10 });
    assert(!afterDelete.matches.some((m: { path: string }) => m.path === 'src/components/created_via_service.ts'));

    // 9. Subdirectory scoping restricts matches strictly to the requested subtree.
    const scoped = await service.search(tmpRoot, 'AppState', { path: 'task', scope: 'entries', limit: 10 });
    assert.deepStrictEqual(scoped.matches, []);

    console.log('✓ WorkspaceSearchIndex in-memory caching, multi-token, long fuzzy, Smart Case, MRU, and invalidation passed');
  } finally {
    await service.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
