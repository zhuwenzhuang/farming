#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const referenceRoot = process.env.POEM_REFERENCE_DIR
  || path.join(projectRoot, 'reference', 'poem');
const outputDir = process.env.POEM_WORDLIST_OUT_DIR
  || path.join(projectRoot, 'backend', 'data', 'poetic-word-sources');

const CHINESE_POETRY_ROOT = process.env.CHINESE_POETRY_CORPUS_DIR
  || path.join(referenceRoot, 'chinese-poetry');
const JAPAN_TEXT = process.env.JAPAN_POEM_TEXT
  || path.join(referenceRoot, 'text', 'japanese-short-poems.txt');
const INDIA_TEXT = process.env.INDIA_POEM_TEXT
  || path.join(referenceRoot, 'text', 'tagore-collection.txt');

const SOURCE_TARGETS = {
  china: Number(process.env.POEM_WORDLIST_CHINA_COUNT || 8192),
  japan: Number(process.env.POEM_WORDLIST_JAPAN_COUNT || 2048),
  india: Number(process.env.POEM_WORDLIST_INDIA_COUNT || 2048),
};

const CHINA_INCLUDED_DIRS = [
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
const SKIP_JSON_FILE_RE = /authors|表面结构|README|package|index|loader/i;
const NOISE_LINE_RE = /版权|目录|出版|责任编辑|ISBN|CIP|作者|译者|策划|监制|字数|印刷|版权所有|返回总目录|北京|出版社|图书在版|世界名著|总序|第\d+版|www\.|http|^\[?\]?$|^-{3,}$/i;

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
  '入庭', '山微', '人香', '歌金', '午年', '衣更', '席人', '箫人',
  '作人', '作者', '译者', '目录', '版权', '出版', '责任编辑',
  '年月', '月日', '年春', '明白', '年轻', '短歌', '歌人', '门人',
  '静地', '心地', '旦心', '波浦', '地鼓', '电灯', '洲时', '春天',
  '秋天', '冬日',
  '草风', '空海', '人秋', '日明', '茶浪', '年冬', '年秋', '年夏',
  '桃青', '月雨', '月银', '云空', '云世', '钟人', '舟年', '舟日',
  '珠沙', '时红', '地绿', '地低', '地生', '远地', '断地', '轻地',
  '天衣', '古马', '云鼓', '长马', '珠人', '红节',
  '地歌', '地叶', '灯古', '灯生', '灯心', '低岸', '低雨', '断新',
  '断长', '风席', '峰日', '峰生', '高河', '歌鸟', '根花',
  '生辰', '李白', '木鸡', '门书', '深爱', '年日', '冬时', '时心',
  '笑时', '时生', '日天', '人时', '日人', '天人', '人院',
]);

const IMAGE_CHARS = new Set(Array.from([
  '天地日月星辰云霞烟雾风雨雪霜露虹霁霭',
  '山水江河湖海溪泉潭涧潮浪波浦洲渚岸沙石岩峰岭谷崖壑',
  '林森树木松柏竹梅兰菊荷莲柳枫桂桃李杏花草苔萝藤芦叶枝根蕊',
  '鸟莺燕雁鸥鹭鹤鸿鸳鸯鱼龙马鹿猿蝉蝶蜂萤',
  '城郭楼台亭阁门窗帘院园庭阶桥寺庙宫阙舟船帆',
  '笛箫琴弦钟鼓灯烛镜剑书画诗酒茶棋枕席衣裳袖',
  '尘香玉金银锦绣珠帘光影歌心爱笑旅客',
  '春夏秋冬晨朝晓旦午暮夕晚夜更年岁时节',
  '寒暑冷暖晴阴清明幽微闲静孤寂空远遥深浅轻薄淡浓',
  '翠碧青苍绿红白黄紫玄素暗新旧古圆斜疏密残断',
].join('')));

const SEASON_CHARS = new Set(Array.from('春夏秋冬晨朝晓旦午暮夕晚夜更年岁时节寒暑霜雪露雨'));
const NATURE_CHARS = new Set(Array.from([
  '天地日月星辰云霞烟雾风雨雪霜露虹霁霭',
  '山水江河湖海溪泉潭涧潮浪波浦洲渚岸沙石岩峰岭谷崖壑',
  '林森树木松柏竹梅兰菊荷莲柳枫桂桃李杏花草苔萝藤芦叶枝根蕊',
  '鸟莺燕雁鸥鹭鹤鸿鸳鸯鱼龙鹿猿蝉蝶蜂萤',
].join('')));
const PLACE_CHARS = new Set(Array.from('城郭楼台亭阁门窗帘院园庭阶桥寺庙宫阙舟船帆岸浦洲渚'));
const LIGHT_CHARS = new Set(Array.from('日月星辰云霞烟雾虹光影灯烛明暗晴阴青苍绿红白黄紫翠碧金银素玄'));
const OBJECT_CHARS = new Set(Array.from('笛箫琴弦钟鼓灯烛镜剑书画诗酒茶棋枕席衣裳袖珠玉金银锦绣帘'));
const FEELING_CHARS = new Set(Array.from('心爱笑梦清幽微闲静孤寂空远遥深淡浓冷暖轻薄'));
const CONTEXT_EDGE_CHARS = new Set(Array.from('人地马生世时年日门衣书客'));
const SOFT_BAD_WORD_RE = /[电犬鸡]/;
const GOOD_WORDS = new Set([
  '春风', '明月', '白云', '梅花', '秋风', '青山', '清风', '日月',
  '江湖', '江山', '风月', '草木', '桃李', '月明', '桃花', '山水',
  '山林', '青云', '烟霞', '日暮', '夜深', '烟雨', '春光', '秋水',
  '夜雨', '夜月', '风露', '翠微', '松风', '春草', '秋月', '云深',
  '春水', '花枝', '莲花', '荷花', '孤舟', '古寺', '玉楼', '青灯',
  '露珠', '春雨', '秋暮', '清水', '岁时', '月光', '红叶', '时雨',
  '秋夜', '夕暮', '白露', '孤寂', '谷鸟', '黄莺', '夏日', '银河',
  '白菊', '春夜', '梅香', '山鸟', '松风', '庭园', '茶花', '菊花',
  '木叶', '岩石', '朝雾', '春山', '海浪', '红梅', '花影', '黄叶',
  '天空', '清晨', '微笑', '森林', '诗歌', '夜晚', '花园', '河水',
  '河岸', '光明', '深夜', '节日', '青春', '寺院', '阴影', '遥远',
  '寂静', '时光', '白天', '日夜', '风雨', '树林', '星辰', '树枝',
  '莲花', '晨光', '青草', '海岸', '芦笛', '霞光', '星光', '灯光',
  '暮歌', '晨歌', '心弦', '心花',
]);

function hasAnyChar(word, chars) {
  return Array.from(word).some(char => chars.has(char));
}

function hasAllCharClasses(word, leftClass, rightClass) {
  const chars = Array.from(word);
  return leftClass.has(chars[0]) && rightClass.has(chars[1]);
}

function qualityScore(word, count) {
  let score = 0;
  if (GOOD_WORDS.has(word)) score += 8;
  if (hasAllCharClasses(word, SEASON_CHARS, NATURE_CHARS)) score += 4;
  if (hasAllCharClasses(word, NATURE_CHARS, NATURE_CHARS)) score += 4;
  if (hasAllCharClasses(word, NATURE_CHARS, PLACE_CHARS)) score += 3;
  if (hasAllCharClasses(word, PLACE_CHARS, NATURE_CHARS)) score += 3;
  if (hasAllCharClasses(word, LIGHT_CHARS, NATURE_CHARS)) score += 3;
  if (hasAllCharClasses(word, NATURE_CHARS, LIGHT_CHARS)) score += 3;
  if (hasAllCharClasses(word, OBJECT_CHARS, NATURE_CHARS)) score += 2;
  if (hasAllCharClasses(word, NATURE_CHARS, OBJECT_CHARS)) score += 2;
  if (hasAllCharClasses(word, FEELING_CHARS, NATURE_CHARS)) score += 2;
  if (hasAllCharClasses(word, NATURE_CHARS, FEELING_CHARS)) score += 2;
  if (hasAnyChar(word, PLACE_CHARS) && hasAnyChar(word, NATURE_CHARS)) score += 1;
  if (hasAnyChar(word, LIGHT_CHARS) && hasAnyChar(word, NATURE_CHARS)) score += 1;
  if (hasAnyChar(word, OBJECT_CHARS) && hasAnyChar(word, NATURE_CHARS)) score += 1;
  if (hasAnyChar(word, CONTEXT_EDGE_CHARS)) score -= 2;
  if (CONTEXT_EDGE_CHARS.has(Array.from(word)[0]) && !GOOD_WORDS.has(word)) score -= 2;
  if (CONTEXT_EDGE_CHARS.has(Array.from(word)[1]) && !GOOD_WORDS.has(word)) score -= 2;
  if (SOFT_BAD_WORD_RE.test(word) && !GOOD_WORDS.has(word)) score -= 4;
  if (count >= 8) score += 1;
  if (count >= 32) score += 1;
  return score;
}

function walkJsonFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonFiles(entryPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.json') && !SKIP_JSON_FILE_RE.test(entry.name)) {
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

function extractJsonTextValues(node) {
  const values = [];
  if (typeof node === 'string') {
    values.push(node);
  } else if (Array.isArray(node)) {
    node.forEach(item => values.push(...extractJsonTextValues(item)));
  } else if (node && typeof node === 'object') {
    ['paragraphs', 'content'].forEach((key) => {
      if (node[key]) values.push(...extractJsonTextValues(node[key]));
    });
  }
  return values;
}

function cleanPlainText(text) {
  return normalizeText(text)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !NOISE_LINE_RE.test(line))
    .join('\n');
}

function isAllowedWord(word) {
  const chars = Array.from(word);
  return chars.length === 2
    && chars[0] !== chars[1]
    && !DENY_WORDS.has(word)
    && chars.every(char => ALLOWED_CHARS.has(char))
    && chars.some(char => IMAGE_CHARS.has(char));
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

function countJsonSource(files) {
  const counts = new Map();
  let textPieceCount = 0;

  files.forEach((file) => {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }

    extractJsonTextValues(data).forEach((text) => {
      textPieceCount += countText(text, counts);
    });
  });

  return { counts, textPieceCount };
}

function countTextSource(file) {
  const counts = new Map();
  const text = cleanPlainText(fs.readFileSync(file, 'utf8'));
  const textPieceCount = countText(text, counts);
  return { counts, textPieceCount };
}

function sourceCommit(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return '';
  return childProcess.execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function tierForIndex(index, total) {
  if (index < Math.ceil(total * 0.35)) return 'common';
  if (index < Math.ceil(total * 0.85)) return 'varied';
  return 'rare';
}

function buildPayload({
  key,
  country,
  sourceName,
  sourceKind,
  sourcePaths,
  sourceUrl,
  license,
  commit,
  counts,
  textPieceCount,
  targetCount,
}) {
  const ranked = Array.from(counts.entries())
    .map(([word, count]) => ({ word, count, quality: qualityScore(word, count) }))
    .sort((left, right) => (
      right.quality - left.quality
      || right.count - left.count
      || left.word.localeCompare(right.word, 'zh-Hans-CN')
    ));
  const selected = ranked.slice(0, targetCount);
  const tiers = {
    common: selected.filter((_, index) => tierForIndex(index, selected.length) === 'common').length,
    varied: selected.filter((_, index) => tierForIndex(index, selected.length) === 'varied').length,
    rare: selected.filter((_, index) => tierForIndex(index, selected.length) === 'rare').length,
  };

  return {
    version: 1,
    key,
    country,
    locale: 'zh-CN',
    description: 'Two-character Chinese poetic token candidates extracted from one source family.',
    source: {
      name: sourceName,
      kind: sourceKind,
      paths: sourcePaths.map(file => path.relative(projectRoot, file)),
      url: sourceUrl,
      license,
      commit,
    },
    extraction: {
      unit: 'adjacent Chinese bigram',
      normalization: 'limited traditional-to-simplified character mapping',
      filtering: [
        'drop metadata/noise lines for plain text sources',
        'keep only two different Chinese characters',
        'require each character to be in the poetic allowed-character set',
        'drop known awkward, metadata, or unsafe words',
      ],
      allowedCharacters: Array.from(ALLOWED_CHARS).join(''),
    },
    stats: {
      textPieces: textPieceCount,
      candidates: ranked.length,
      selected: selected.length,
      target: targetCount,
      tiers,
      frequencyRange: selected.length
        ? {
            max: Math.max(...selected.map(entry => entry.count)),
            min: Math.min(...selected.map(entry => entry.count)),
          }
        : { max: 0, min: 0 },
      qualityRange: selected.length
        ? {
            max: Math.max(...selected.map(entry => entry.quality)),
            min: Math.min(...selected.map(entry => entry.quality)),
          }
        : { max: 0, min: 0 },
    },
    words: selected.map(({ word, count, quality }, index) => ({
      word,
      count,
      quality,
      tier: tierForIndex(index, selected.length),
    })),
  };
}

function writePayload(payload) {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `${payload.key}.json`);
  fs.writeFileSync(outputFile, `${JSON.stringify(payload, null, 2)}\n`);
  console.error(`Wrote ${payload.words.length} ${payload.key} words to ${outputFile}`);
}

function main() {
  const chinaFiles = CHINA_INCLUDED_DIRS.flatMap((dir) => walkJsonFiles(path.join(CHINESE_POETRY_ROOT, dir)));
  const china = countJsonSource(chinaFiles);
  writePayload(buildPayload({
    key: 'china',
    country: 'China',
    sourceName: 'chinese-poetry selected classic corpora',
    sourceKind: 'json corpus',
    sourcePaths: CHINA_INCLUDED_DIRS.map(dir => path.join(CHINESE_POETRY_ROOT, dir)),
    sourceUrl: 'https://github.com/chinese-poetry/chinese-poetry',
    license: 'MIT',
    commit: sourceCommit(CHINESE_POETRY_ROOT),
    counts: china.counts,
    textPieceCount: china.textPieceCount,
    targetCount: SOURCE_TARGETS.china,
  }));

  const japan = countTextSource(JAPAN_TEXT);
  writePayload(buildPayload({
    key: 'japan',
    country: 'Japan',
    sourceName: 'Japanese short poems Chinese translation collection',
    sourceKind: 'local epub-derived text',
    sourcePaths: [JAPAN_TEXT],
    sourceUrl: '',
    license: 'local reference only',
    commit: '',
    counts: japan.counts,
    textPieceCount: japan.textPieceCount,
    targetCount: SOURCE_TARGETS.japan,
  }));

  const india = countTextSource(INDIA_TEXT);
  writePayload(buildPayload({
    key: 'india',
    country: 'India',
    sourceName: 'Tagore Chinese translation collection',
    sourceKind: 'local epub-derived text',
    sourcePaths: [INDIA_TEXT],
    sourceUrl: '',
    license: 'local reference only',
    commit: '',
    counts: india.counts,
    textPieceCount: india.textPieceCount,
    targetCount: SOURCE_TARGETS.india,
  }));
}

main();
