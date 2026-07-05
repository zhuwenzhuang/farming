#!/usr/bin/env node

const {
  generateChineseHaikuToken,
  generateIndianHaikuToken,
  generateJapaneseHaikuToken,
  getPoeticTokenEntropyBits,
} = require('../backend/haiku-token');

const SOURCES = [
  { key: 'china', locale: 'zh', label: 'China', generate: generateChineseHaikuToken },
  { key: 'japan', locale: 'ja', label: 'Japan', generate: generateJapaneseHaikuToken },
  { key: 'india', locale: 'india', label: 'India', generate: generateIndianHaikuToken },
];

const EXPECTED_LINE_LENGTHS = [5, 7, 5];
const STRONG_IMAGE_CHARS = new Set(Array.from('云月星霞烟雨雪霜露风山水江河海溪泉林松竹梅兰菊荷莲柳桃花草叶枝鸟雁鸥岸沙石岩峰谷灯钟琴笛诗酒茶'));
const INDIA_MARKER_RE = /^(天空|诗人|清晨|微笑|森林|诗歌|夜晚|花园|河水|河岸|光明|深夜|青春|寺院|阴影|遥远|寂静|时光|月光|旅人|芦笛|莲花|尘世|孤寂|海岸|新生|心花|爱人|霞光|星光|晨光|灯光|暮歌|晨歌|心弦|河心|祝福|自由|灵魂|梦乡)/;
const JAPAN_MARKER_RE = /梅|露|秋|暮|夕|菊|旅|红叶|谷鸟|黄莺|清水|时雨|苔|蝉|蛙|芦|雁|孤寂|草木|寒夜|春雨|春风|春日|春夜|春山|夏日|夏夜|冬夜|雪/;
const NON_NATIVE_MARKER_RE = /^(微笑|青春|花园|诗歌|心花|心弦|爱人|自由|灵魂|梦乡)/;
const NON_NATIVE_IMAGE_RE = /微笑|青春|花园|诗歌|心花|心弦|爱人|自由|灵魂|梦乡|时光/;

function parseArgs(argv) {
  const options = { count: 1000, samples: 10, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      options.check = true;
    } else if (arg === '--count') {
      options.count = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--samples') {
      options.samples = Number(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.count) || options.count <= 0) throw new Error('--count must be a positive integer');
  if (!Number.isInteger(options.samples) || options.samples < 0) throw new Error('--samples must be a non-negative integer');
  return options;
}

function lineLengths(token) {
  return token.split('-').map(part => Array.from(part).length);
}

function countRepeatedStrongImageChars(token) {
  const counts = new Map();
  for (const char of Array.from(token.replace(/-/g, ''))) {
    if (!STRONG_IMAGE_CHARS.has(char)) continue;
    counts.set(char, (counts.get(char) || 0) + 1);
  }
  return Array.from(counts.values()).filter(count => count > 1).length;
}

function markerMatched(sourceKey, token) {
  const firstLine = token.split('-')[0] || '';
  if (sourceKey === 'india') return INDIA_MARKER_RE.test(firstLine);
  if (sourceKey === 'japan') return JAPAN_MARKER_RE.test(Array.from(firstLine).slice(0, 2).join(''));
  return true;
}

function markerContaminated(sourceKey, token) {
  if (sourceKey === 'india') return false;
  const firstLine = token.split('-')[0] || '';
  return NON_NATIVE_MARKER_RE.test(firstLine);
}

function imageContaminated(sourceKey, token) {
  if (sourceKey === 'india') return false;
  return NON_NATIVE_IMAGE_RE.test(token);
}

function scoreSource(source, options) {
  const tokens = [];
  const invalidTokens = [];
  const badLineLengths = [];
  let repeatedStrongImageTokenCount = 0;
  let repeatedStrongImageTotal = 0;
  let markerMissCount = 0;
  let markerContaminationCount = 0;
  let imageContaminationCount = 0;

  for (let index = 0; index < options.count; index += 1) {
    const token = source.generate();
    tokens.push(token);

    if (!/^[\u4e00-\u9fa5-]+$/.test(token)) invalidTokens.push(token);
    if (JSON.stringify(lineLengths(token)) !== JSON.stringify(EXPECTED_LINE_LENGTHS)) badLineLengths.push(token);

    const repeatedStrongImageChars = countRepeatedStrongImageChars(token);
    if (repeatedStrongImageChars > 0) repeatedStrongImageTokenCount += 1;
    repeatedStrongImageTotal += repeatedStrongImageChars;
    if (!markerMatched(source.key, token)) markerMissCount += 1;
    if (markerContaminated(source.key, token)) markerContaminationCount += 1;
    if (imageContaminated(source.key, token)) imageContaminationCount += 1;
  }

  const uniqueCount = new Set(tokens).size;
  return {
    source: source.key,
    entropyBits: getPoeticTokenEntropyBits({ locale: source.locale }),
    count: options.count,
    uniqueCount,
    uniqueRatio: uniqueCount / options.count,
    invalidCount: invalidTokens.length,
    badLineLengthCount: badLineLengths.length,
    repeatedStrongImageTokenRatio: repeatedStrongImageTokenCount / options.count,
    repeatedStrongImageAverage: repeatedStrongImageTotal / options.count,
    markerCoverage: 1 - (markerMissCount / options.count),
    markerContaminationCount,
    imageContaminationCount,
    samples: tokens.slice(0, options.samples),
  };
}

function printReport(report) {
  console.log(`\n${report.source}`);
  console.log(`  entropy: ${report.entropyBits} bits`);
  console.log(`  unique: ${report.uniqueCount}/${report.count} (${(report.uniqueRatio * 100).toFixed(1)}%)`);
  console.log(`  invalid format: ${report.invalidCount}`);
  console.log(`  bad line length: ${report.badLineLengthCount}`);
  console.log(`  marker coverage: ${(report.markerCoverage * 100).toFixed(1)}%`);
  console.log(`  non-native marker contamination: ${report.markerContaminationCount}`);
  console.log(`  non-native image contamination: ${report.imageContaminationCount}`);
  console.log(`  repeated strong image tokens: ${(report.repeatedStrongImageTokenRatio * 100).toFixed(1)}%`);
  console.log(`  repeated strong image average: ${report.repeatedStrongImageAverage.toFixed(2)}`);
  report.samples.forEach(token => console.log(`  ${token}`));
}

function assertReport(report) {
  const errors = [];
  if (report.entropyBits < 85) errors.push(`${report.source}: entropy below 85 bits`);
  if (report.invalidCount > 0) errors.push(`${report.source}: invalid token format`);
  if (report.badLineLengthCount > 0) errors.push(`${report.source}: wrong 5-7-5 lengths`);
  if (report.uniqueRatio < 0.98) errors.push(`${report.source}: unique ratio below 98%`);
  if (report.source === 'india' && report.markerCoverage < 1) errors.push('india: marker coverage below 100%');
  if (report.markerContaminationCount > 0) errors.push(`${report.source}: non-native marker contamination`);
  if (report.imageContaminationCount > 0) errors.push(`${report.source}: non-native image contamination`);
  return errors;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const reports = SOURCES.map(source => scoreSource(source, options));
  reports.forEach(printReport);

  if (options.check) {
    const errors = reports.flatMap(assertReport);
    if (errors.length > 0) {
      console.error(`\nPoetic token evaluation failed:\n${errors.map(error => `- ${error}`).join('\n')}`);
      process.exit(1);
    }
  }
}

main();
