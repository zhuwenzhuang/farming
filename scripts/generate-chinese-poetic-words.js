#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const corpusRoot = process.env.CHINESE_POETRY_CORPUS_DIR
  || path.join(projectRoot, 'reference', 'poem', 'chinese-poetry');
const poemTextRoot = process.env.CHINESE_POEM_TEXT_DIR
  || path.join(projectRoot, 'reference', 'poem', 'text');
const outputFile = process.env.CHINESE_POETIC_WORDS_OUT
  || path.join(projectRoot, 'backend', 'data', 'chinese-poetic-words.json');
const targetWordCount = Number(process.env.CHINESE_POETIC_WORD_COUNT || 8192);

const INCLUDED_DIRS = [
  '全唐诗',
  '宋词',
  '诗经',
  '楚辞',
  '纳兰性德',
  '水墨唐诗',
  '曹操诗集',
  '元曲',
  '五代诗词',
];
const SKIP_FILE_RE = /authors|表面结构|README|package|index|loader/i;

const TRADITIONAL_TO_SIMPLIFIED = Object.fromEntries([
  ['風', '风'], ['雲', '云'], ['煙', '烟'], ['霧', '雾'],
  ['門', '门'], ['橋', '桥'], ['葉', '叶'], ['聲', '声'],
  ['夢', '梦'], ['飛', '飞'], ['鳥', '鸟'], ['舊', '旧'],
  ['靜', '静'], ['曉', '晓'], ['濤', '涛'], ['塵', '尘'],
  ['遙', '遥'], ['遠', '远'], ['灣', '湾'], ['嶺', '岭'],
  ['萬', '万'], ['蘆', '芦'], ['鶴', '鹤'], ['鳳', '凤'],
  ['龍', '龙'], ['黃', '黄'], ['綠', '绿'], ['紅', '红'],
  ['鐘', '钟'], ['燈', '灯'], ['蘭', '兰'], ['臺', '台'],
  ['樓', '楼'], ['淺', '浅'], ['閒', '闲'], ['淚', '泪'],
  ['巖', '岩'], ['巔', '巅'], ['澗', '涧'], ['淨', '净'],
  ['雙', '双'], ['園', '园'], ['圓', '圆'], ['關', '关'],
  ['宮', '宫'], ['闕', '阙'], ['靈', '灵'], ['歸', '归'],
  ['來', '来'], ['盡', '尽'], ['邊', '边'], ['時', '时'],
  ['處', '处'], ['裏', '里'], ['裡', '里'], ['陰', '阴'],
  ['陽', '阳'], ['臨', '临'], ['聽', '听'], ['觀', '观'],
  ['廣', '广'], ['滄', '沧'], ['瀟', '潇'], ['灑', '洒'],
  ['滿', '满'], ['漢', '汉'], ['臥', '卧'], ['錦', '锦'],
  ['繡', '绣'], ['鏡', '镜'], ['銅', '铜'], ['銀', '银'],
  ['鐵', '铁'], ['寶', '宝'], ['劍', '剑'], ['絃', '弦'],
  ['絕', '绝'], ['絲', '丝'], ['畫', '画'], ['書', '书'],
  ['詩', '诗'], ['齋', '斋'], ['齊', '齐'], ['嚴', '严'],
  ['歡', '欢'], ['憶', '忆'], ['懷', '怀'], ['憐', '怜'],
  ['憂', '忧'], ['驚', '惊'], ['斷', '断'], ['殘', '残'],
  ['艷', '艳'], ['蕭', '萧'], ['蓮', '莲'], ['廬', '庐'],
  ['廟', '庙'], ['階', '阶'], ['隱', '隐'], ['隨', '随'],
  ['雜', '杂'], ['離', '离'], ['難', '难'], ['霽', '霁'],
  ['靄', '霭'], ['韻', '韵'], ['顏', '颜'], ['飄', '飘'],
  ['騎', '骑'], ['馬', '马'], ['魚', '鱼'], ['鷗', '鸥'],
  ['鴈', '雁'], ['鴻', '鸿'], ['鵑', '鹃'], ['鶯', '莺'],
  ['鵲', '鹊'], ['鵬', '鹏'], ['鷺', '鹭'], ['鴛', '鸳'],
  ['鴦', '鸯'], ['龜', '龟'],
]);

const ALLOWED_CHARS = new Set(Array.from([
  '天地日月星辰云霞烟雾风雨雪霜露雷电虹霁霭',
  '山水江河湖海溪泉潭涧潮浪波浦洲渚岸沙石岩峰岭谷崖壑',
  '林森树木松柏竹梅兰菊荷莲柳枫桂桃李杏花草苔萝藤芦叶枝根蕊',
  '鸟莺燕雁鸥鹭鹤鸿鸳鸯鱼龙马鹿猿蝉蝶蜂萤鸦犬鸡',
  '城郭楼台亭阁门窗帘院园庭阶桥寺庙宫阙舟船帆',
  '笛箫琴弦钟鼓灯烛镜剑书画诗酒茶棋枕席衣裳袖',
  '尘香玉金银锦绣珠帘光影歌心爱笑旅客人世界生命',
  '春夏秋冬晨朝晓旦午暮夕晚夜更年岁时节',
  '寒暑冷暖晴阴清明幽微闲静孤寂空远遥深浅轻薄淡浓',
  '翠碧青苍绿红白黄紫玄素暗新旧古高低长短圆斜疏密残断',
].join('')));

const DENY_WORDS = new Set([
  '青楼', '黄泉', '双泪', '泪双', '泪空', '泪泉', '黄门', '荷玄',
  '江小', '白高', '门半', '影半', '舟半', '斜明', '城尘', '低草',
  '低影', '低云', '草梦', '尘白', '花春', '月春', '玄微', '深玄',
  '高低', '高深', '深浅', '色寒', '色花', '色云', '色高', '色深',
  '色霞', '浅色', '浅深', '柔万', '清万', '空万', '山万', '岩万',
  '风万', '河万', '云万', '万秋', '万山', '万叶', '深万', '沙万',
  '门草', '草门', '草暮', '草湖', '草浪', '岸色', '木马', '马高',
  '满高', '时拂', '时断', '起幽', '起微', '去风', '去晚', '日松',
  '入庭', '山微',
]);

function walkJsonFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonFiles(entryPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.json') && !SKIP_FILE_RE.test(entry.name)) {
      out.push(entryPath);
    }
  }
  return out;
}

function walkTextFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTextFiles(entryPath, out);
    } else if (entry.isFile() && /\.(txt|text)$/i.test(entry.name)) {
      out.push(entryPath);
    }
  }
  return out;
}

function normalizeText(value) {
  return Array.from(String(value || ''))
    .map(char => TRADITIONAL_TO_SIMPLIFIED[char] || char)
    .join('');
}

function extractTextValues(node) {
  const values = [];
  if (typeof node === 'string') {
    values.push(node);
  } else if (Array.isArray(node)) {
    node.forEach(item => values.push(...extractTextValues(item)));
  } else if (node && typeof node === 'object') {
    ['paragraphs', 'content'].forEach((key) => {
      if (node[key]) values.push(...extractTextValues(node[key]));
    });
  }
  return values;
}

function isAllowedWord(word) {
  const chars = Array.from(word);
  return chars.length === 2
    && chars[0] !== chars[1]
    && !DENY_WORDS.has(word)
    && chars.every(char => ALLOWED_CHARS.has(char));
}

function countText(text, counts) {
  let textPieceCount = 0;

  normalizeText(text).split(/[，。！？；：、,.!?;:\s]+/).forEach((rawPiece) => {
    const chars = Array.from(rawPiece).filter(char => /[\u4e00-\u9fff]/.test(char));
    if (chars.length < 2 || chars.length > 12) return;
    textPieceCount += 1;

    for (let index = 0; index < chars.length - 1; index += 1) {
      const word = chars[index] + chars[index + 1];
      if (isAllowedWord(word)) {
        counts.set(word, (counts.get(word) || 0) + 1);
      }
    }
  });

  return textPieceCount;
}

function countJsonWords(files) {
  const counts = new Map();
  let textPieceCount = 0;

  files.forEach((file) => {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }

    extractTextValues(data).forEach((text) => {
      textPieceCount += countText(text, counts);
    });
  });

  return { counts, textPieceCount };
}

function countPlainTextWords(files, counts) {
  let textPieceCount = 0;
  files.forEach((file) => {
    try {
      textPieceCount += countText(fs.readFileSync(file, 'utf8'), counts);
    } catch {
      // Keep optional local reference texts best-effort.
    }
  });
  return textPieceCount;
}

function main() {
  if (!fs.existsSync(corpusRoot)) {
    throw new Error(`Missing chinese-poetry corpus at ${corpusRoot}`);
  }
  if (!Number.isInteger(targetWordCount) || targetWordCount < 1) {
    throw new Error(`Invalid CHINESE_POETIC_WORD_COUNT: ${process.env.CHINESE_POETIC_WORD_COUNT}`);
  }

  const jsonFiles = INCLUDED_DIRS.flatMap((dir) => {
    const dirPath = path.join(corpusRoot, dir);
    return fs.existsSync(dirPath) ? walkJsonFiles(dirPath) : [];
  });
  const textFiles = walkTextFiles(poemTextRoot);
  const { counts, textPieceCount: jsonTextPieces } = countJsonWords(jsonFiles);
  const plainTextPieces = countPlainTextWords(textFiles, counts);
  const wordsWithCounts = Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-Hans-CN'));
  const selected = wordsWithCounts.slice(0, targetWordCount);

  if (selected.length < targetWordCount) {
    throw new Error(`Only extracted ${selected.length} words; target is ${targetWordCount}`);
  }

  const sourceCommit = fs.existsSync(path.join(corpusRoot, '.git'))
    ? childProcess.execFileSync('git', ['-C', corpusRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    : '';
  const payload = {
    version: 2,
    locale: 'zh',
    source: {
      name: 'chinese-poetry + local poem text references',
      url: 'https://github.com/chinese-poetry/chinese-poetry',
      license: 'MIT',
      commit: sourceCommit,
      includedDirs: INCLUDED_DIRS,
      textFiles: textFiles.map(file => path.relative(projectRoot, file)),
      textPieces: jsonTextPieces + plainTextPieces,
      jsonTextPieces,
      plainTextPieces,
      candidates: wordsWithCounts.length,
    },
    words: selected.map(([word]) => word),
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(payload, null, 2)}\n`);
  console.error(`Wrote ${selected.length} words to ${outputFile}`);
  console.error(`Candidates: ${wordsWithCounts.length}; text pieces: ${jsonTextPieces + plainTextPieces}; cutoff: ${selected.at(-1).join(':')}`);
}

main();
