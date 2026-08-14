import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';

const {
  extractZipArchive,
  validateZipSymlinkTarget,
} = require('../zip-archive.cjs');

interface ArchiveEntry {
  contents?: Buffer | string;
  mode: number;
  name: string;
}

function makeZip(entries: ArchiveEntry[]): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const contents = Buffer.isBuffer(entry.contents)
      ? entry.contents
      : Buffer.from(entry.contents || '');
    const checksum = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    localRecords.push(local, name, contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralRecords.push(central, name);
    localOffset += local.length + name.length + contents.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

async function run() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-zip-archive-'));
  try {
    const archive = path.join(temporary, 'valid.zip');
    const destination = path.join(temporary, 'valid');
    const validEntries: ArchiveEntry[] = [
      { name: 'runtime/', mode: 0o040755 },
      { name: 'runtime/tools/program', contents: 'executable\n', mode: 0o100755 },
    ];
    if (process.platform !== 'win32') {
      validEntries.push({ name: 'runtime/current', contents: 'tools/program', mode: 0o120777 });
    }
    fs.writeFileSync(archive, makeZip(validEntries));
    await extractZipArchive(archive, { dir: destination });
    assert.strictEqual(fs.readFileSync(path.join(destination, 'runtime', 'tools', 'program'), 'utf8'), 'executable\n');
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(path.join(destination, 'runtime', 'tools', 'program')).mode & 0o111, 0o111);
      assert.strictEqual(fs.readlinkSync(path.join(destination, 'runtime', 'current')), 'tools/program');
    }

    assert.doesNotThrow(() => validateZipSymlinkTarget('runtime/current', 'tools/program'));
    assert.throws(
      () => validateZipSymlinkTarget('runtime/escape', '../../outside'),
      /escapes the archive root/,
    );
    assert.throws(
      () => validateZipSymlinkTarget('runtime/escape', '/outside'),
      /must stay inside the archive/,
    );
    assert.throws(
      () => validateZipSymlinkTarget('runtime/escape', 'C:outside'),
      /must stay inside the archive/,
    );

    const traversalArchive = path.join(temporary, 'traversal.zip');
    fs.writeFileSync(traversalArchive, makeZip([
      { name: '../outside', contents: 'escaped\n', mode: 0o100644 },
    ]));
    await assert.rejects(
      extractZipArchive(traversalArchive, { dir: path.join(temporary, 'traversal') }),
      /invalid relative path|escapes the archive root/i,
    );
    assert.strictEqual(fs.existsSync(path.join(temporary, 'outside')), false);

    const attackArchive = path.join(temporary, 'attack.zip');
    const attackDestination = path.join(temporary, 'attack');
    const outside = path.join(temporary, 'outside');
    fs.writeFileSync(attackArchive, makeZip([
      { name: 'redirect', contents: '../../outside', mode: 0o120777 },
      { name: 'redirect/payload', contents: 'escaped\n', mode: 0o100644 },
    ]));
    await assert.rejects(
      extractZipArchive(attackArchive, { dir: attackDestination }),
      /symbolic link target escapes the archive root/,
    );
    assert.strictEqual(fs.existsSync(outside), false);

    if (process.platform !== 'win32') {
      const existingLinkDestination = path.join(temporary, 'existing-link');
      const existingLinkOutside = path.join(temporary, 'existing-link-outside');
      fs.mkdirSync(existingLinkDestination);
      fs.mkdirSync(existingLinkOutside);
      fs.symlinkSync(existingLinkOutside, path.join(existingLinkDestination, 'redirect'));
      const nestedArchive = path.join(temporary, 'nested.zip');
      fs.writeFileSync(nestedArchive, makeZip([
        { name: 'redirect/payload', contents: 'escaped\n', mode: 0o100644 },
      ]));
      await assert.rejects(
        extractZipArchive(nestedArchive, { dir: existingLinkDestination }),
        /refuses to write through a symbolic link/,
      );
      assert.strictEqual(fs.existsSync(path.join(existingLinkOutside, 'payload')), false);
    }

    console.log('✓ ZIP extraction keeps files and symbolic links inside the destination');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

run();
