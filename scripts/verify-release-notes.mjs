import fs from 'node:fs';
import path from 'node:path';

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CODENAME_PATTERN = /^[A-Z0-9]+(?:[ _-][A-Z0-9]+)*$/;

function requireLine(lines, index, expected, file) {
  if (lines[index] !== expected) {
    throw new Error(`${file}:${index + 1} must be exactly ${JSON.stringify(expected)}`);
  }
}

function readNote(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing release notes: ${file}`);
  }
  return fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
}

function parseCodename(line, prefix, file) {
  const match = line.match(new RegExp(`^${prefix}\\*\\*([^*]+)\\*\\*$`));
  const codename = match?.[1] ?? '';
  if (!CODENAME_PATTERN.test(codename)) {
    throw new Error(`${file}:5 must declare an uppercase milestone codename`);
  }
  return codename;
}

function verifyReleaseNotes(version, notesDir) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Expected an exact semantic version without a v prefix: ${version}`);
  }

  const englishFile = path.join(notesDir, `v${version}.md`);
  const chineseFile = path.join(notesDir, `v${version}.zh_cn.md`);
  const english = readNote(englishFile);
  const chinese = readNote(chineseFile);
  const englishLines = english.split('\n');
  const chineseLines = chinese.split('\n');

  requireLine(englishLines, 0, `# Farming v${version}`, englishFile);
  requireLine(englishLines, 1, '', englishFile);
  requireLine(englishLines, 2, `[简体中文](./v${version}.zh_cn.md)`, englishFile);
  requireLine(englishLines, 3, '', englishFile);
  requireLine(chineseLines, 0, `# Farming v${version}`, chineseFile);
  requireLine(chineseLines, 1, '', chineseFile);
  requireLine(chineseLines, 2, `[English](./v${version}.md)`, chineseFile);
  requireLine(chineseLines, 3, '', chineseFile);

  const englishCodename = parseCodename(
    englishLines[4] ?? '',
    'Milestone codename: ',
    englishFile,
  );
  const chineseCodename = parseCodename(
    chineseLines[4] ?? '',
    '里程碑代号：',
    chineseFile,
  );
  if (englishCodename !== chineseCodename) {
    throw new Error(
      `Release note codenames must match: English=${englishCodename}, Chinese=${chineseCodename}`,
    );
  }

  const upgradeTarget = `farming-code@${version}`;
  if (!english.includes(upgradeTarget) || !chinese.includes(upgradeTarget)) {
    throw new Error(`Both release notes must contain the exact upgrade target ${upgradeTarget}`);
  }

  return { codename: englishCodename };
}

function parseArguments(argv) {
  const version = argv[0] ?? '';
  let notesDir = 'release-notes';
  let codenameOnly = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--notes-dir') {
      notesDir = argv[index + 1] ?? '';
      index += 1;
    } else if (argument === '--codename') {
      codenameOnly = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!notesDir) throw new Error('--notes-dir requires a path');
  return { version, notesDir, codenameOnly };
}

try {
  const { version, notesDir, codenameOnly } = parseArguments(process.argv.slice(2));
  const result = verifyReleaseNotes(version, notesDir);
  process.stdout.write(codenameOnly
    ? `${result.codename}\n`
    : `Release notes valid: v${version} · ${result.codename}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
