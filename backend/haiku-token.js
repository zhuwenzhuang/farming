const crypto = require('crypto');

const CHINESE_POETIC_CATEGORIES = {
  verb: '照入落过映起眠归拂绕穿渡藏向逐随问泊生满摇醒看寻开合沉浮来去停舒敛转隐澄',
  softVerb: '听照入落过映起眠归拂绕穿渡藏向逐随问泊生满摇醒看寻开合沉浮来去停舒敛转隐澄',
};
const CHINESE_POETIC_WORDS_DATA = require('./data/chinese-poetic-words.json');
const CHINESE_POETIC_WORDS = CHINESE_POETIC_WORDS_DATA.words;
const POETIC_SOURCE_WORDLISTS = {
  china: require('./data/poetic-word-sources/china.json'),
  japan: require('./data/poetic-word-sources/japan.json'),
  india: require('./data/poetic-word-sources/india.json'),
};
const POETIC_SOURCE_TIER_WEIGHTS = {
  common: 48,
  varied: 47,
  rare: 5,
};
const CHINESE_POETIC_WORD_TIERS = [
  { name: 'common', weight: 76, words: CHINESE_POETIC_WORDS.slice(0, 2048) },
  { name: 'varied', weight: 20, words: CHINESE_POETIC_WORDS.slice(2048, 6144) },
  { name: 'rare', weight: 4, words: CHINESE_POETIC_WORDS.slice(6144) },
];
const CHINESE_POETIC_ACTIVE_WORDS = CHINESE_POETIC_WORD_TIERS.flatMap(tier => tier.words);
const ENGLISH_WORDS = [
  'amber', 'anchor', 'autumn', 'azure', 'bamboo', 'beacon', 'birch', 'blossom',
  'breeze', 'bridge', 'brook', 'canyon', 'cedar', 'circle', 'cloud', 'coast',
  'comet', 'copper', 'crystal', 'dawn', 'delta', 'desert', 'drift', 'dune',
  'dusk', 'ember', 'field', 'flame', 'fjord', 'forest', 'frost', 'garden',
  'glade', 'harbor', 'haze', 'hill', 'island', 'jade', 'lantern', 'leaf',
  'linen', 'meadow', 'mirror', 'mist', 'moon', 'morning', 'moss', 'mountain',
  'night', 'ocean', 'orchard', 'pebble', 'pine', 'plain', 'pond', 'prism',
  'rain', 'reed', 'ridge', 'river', 'rock', 'shadow', 'shore', 'signal',
  'silver', 'sky', 'snow', 'spark', 'spring', 'stone', 'summit', 'sun',
  'tide', 'tower', 'trail', 'valley', 'violet', 'water', 'willow', 'wind',
  'winter', 'wood', 'zephyr', 'quiet', 'bright', 'gentle', 'clear', 'hidden',
  'hollow', 'calm', 'small', 'wide', 'deep', 'fresh', 'soft', 'warm',
  'cool', 'northern', 'eastern', 'western', 'southern', 'open', 'still', 'steady',
  'swift', 'slow', 'early', 'late', 'golden', 'green', 'blue', 'white',
  'black', 'red', 'pale', 'bold', 'brave', 'lucid', 'simple', 'silvered',
  'level', 'round', 'remote', 'near', 'rising', 'falling', 'woven', 'polished',
];
const ENGLISH_TOKEN_WORD_COUNT = 13;
const CHINESE_TOKEN_LOCALE = 'zh';
const JAPANESE_TOKEN_LOCALE = 'ja';
const INDIAN_TOKEN_LOCALE = 'in';
const ENGLISH_TOKEN_LOCALE = 'en';
const AUTO_TOKEN_LOCALE = 'auto';
const CHINESE_TIME_ZONES = new Set([
  'Asia/Shanghai',
  'Asia/Chongqing',
  'Asia/Chungking',
  'Asia/Harbin',
  'Asia/Urumqi',
  'Asia/Hong_Kong',
  'Asia/Macau',
  'Asia/Taipei',
]);
const JAPANESE_TIME_ZONES = new Set([
  'Asia/Tokyo',
  'Japan',
]);

const TOKEN_TEMPLATE = [
  [
    { kind: 'word' },
    { kind: 'verb' },
    { kind: 'word' },
  ],
  [
    { kind: 'word' },
    { kind: 'softVerb' },
    { kind: 'word' },
    { kind: 'word' },
  ],
  [
    { kind: 'word' },
    { kind: 'verb' },
    { kind: 'word' },
  ],
];
const CHINESE_POETIC_PATTERNS = [
  TOKEN_TEMPLATE,
  [
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'verb' }, { kind: 'word' }],
  ],
  [
    [{ kind: 'word' }, { kind: 'verb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'verb' }, { kind: 'word' }],
  ],
  [
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'verb' }, { kind: 'word' }],
  ],
  [
    [{ kind: 'word' }, { kind: 'verb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
  ],
  [
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
  ],
  [
    [{ kind: 'word' }, { kind: 'verb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
  ],
  [
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
  ],
];
const SOURCE_MARKER_WORD_COUNT = 128;
const SOURCE_MARKER_PREFERRED_WEIGHT = 70;
const SOURCE_MARKER_FORCE_SOURCE = new Set(['india']);
const SOURCE_MARKER_PATTERNS = {
  china: /春|秋|山|水|月|风|云|梅|花|江|烟|霞|松|竹|桃|柳|楼|台|诗|雪/,
  japan: /梅|露|秋|暮|夕|菊|旅|红叶|谷鸟|黄莺|清水|时雨|苔|蝉|蛙|芦|雁|孤寂|草木|寒夜|春雨|春风|春日|春夜|春山|夏日|夏夜|冬夜|雪/,
  india: /天空|诗人|清晨|微笑|森林|诗歌|夜晚|花园|河水|河岸|光明|深夜|青春|寺院|阴影|遥远|寂静|时光|月光|旅人|芦笛|莲花|尘世|孤寂|海岸|新生|心花|爱人|霞光|星光|晨光|灯光|暮歌|晨歌|心弦|河心|祝福|自由|灵魂|梦乡/,
};
const SOURCE_MARKER_BAD_WORDS = {
  china: new Set(['微笑', '青春', '花园', '诗歌', '心花', '心弦', '爱人', '自由', '灵魂', '梦乡']),
  japan: new Set(['微笑', '青春', '花园', '诗歌', '心花', '心弦', '爱人', '自由', '灵魂', '梦乡']),
};
const SOURCE_IMAGE_BAD_CHARS = /[龙猿鸳蜂根裳渚洲鹤辰鹿金鱼李玄银]/;
const SOURCE_IMAGE_WORD_BAD_CHARS = /[龙猿鸳蜂根裳渚洲鹤辰鹿金鱼李玄银心笑爱客旅命界歌]/;
const SOURCE_IMAGE_BAD_WORDS = new Set(['青春', '花园', '自由', '灵魂', '梦乡', '时光']);
const SOURCE_IMAGE_PREFERRED_MIN_QUALITY = 10;
const SOURCE_IMAGE_PREFERRED_MAX_WEIGHT = 30;
const SOURCE_IMAGE_PREFERRED_MIN_WEIGHT = 15;
const SOURCE_IMAGE_PREFERRED_RATIO_MULTIPLIER = 1.05;
const SOURCE_IMAGE_ENTROPY_MIN_CHOICES = 2048;
const SOURCE_IMAGE_CHAR_ENTROPY_MIN_CHOICES = 40;
const SOURCE_TONE_CHARS = '清远深微静暖淡幽冷空晚轻薄浅寂寒素疏斜澄碧遥';
const SOURCE_IMAGE_CHARS = '云月星霞烟雨雪霜露风山水江河海溪泉林松竹梅兰菊荷莲柳桃花草叶枝鸟雁鸥岸沙石岩峰谷灯钟琴笛诗酒茶';
const SOURCE_POETIC_PATTERNS = [
  [
    [{ kind: 'marker' }, { kind: 'verb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'verb' }, { kind: 'word' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'verb' }, { kind: 'word' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'verb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'verb' }, { kind: 'word' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'verb' }, { kind: 'word' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'verb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'verb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
    [{ kind: 'word' }, { kind: 'softVerb' }, { kind: 'word' }],
  ],
];
const SOURCE_IMAGE_POETIC_PATTERNS = [
  [
    [{ kind: 'marker' }, { kind: 'verb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'softVerb' }, { kind: 'image' }, { kind: 'toneChar' }, { kind: 'imageChar' }],
    [{ kind: 'image' }, { kind: 'verb' }, { kind: 'image' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'softVerb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'imageChar' }, { kind: 'verb' }, { kind: 'image' }, { kind: 'toneChar' }],
    [{ kind: 'image' }, { kind: 'softVerb' }, { kind: 'image' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'verb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'toneChar' }, { kind: 'softVerb' }, { kind: 'image' }, { kind: 'imageChar' }],
    [{ kind: 'image' }, { kind: 'verb' }, { kind: 'image' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'softVerb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'softVerb' }, { kind: 'image' }, { kind: 'imageChar' }, { kind: 'toneChar' }],
    [{ kind: 'image' }, { kind: 'verb' }, { kind: 'image' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'verb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'softVerb' }, { kind: 'image' }, { kind: 'toneChar' }, { kind: 'imageChar' }],
    [{ kind: 'image' }, { kind: 'softVerb' }, { kind: 'image' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'softVerb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'imageChar' }, { kind: 'verb' }, { kind: 'image' }, { kind: 'toneChar' }],
    [{ kind: 'image' }, { kind: 'softVerb' }, { kind: 'image' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'verb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'toneChar' }, { kind: 'softVerb' }, { kind: 'image' }, { kind: 'imageChar' }],
    [{ kind: 'image' }, { kind: 'verb' }, { kind: 'image' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'softVerb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'imageChar' }, { kind: 'softVerb' }, { kind: 'image' }, { kind: 'toneChar' }],
    [{ kind: 'image' }, { kind: 'verb' }, { kind: 'image' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'verb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'toneChar' }, { kind: 'imageChar' }, { kind: 'softVerb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'softVerb' }, { kind: 'image' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'softVerb' }, { kind: 'image' }],
    [{ kind: 'imageChar' }, { kind: 'image' }, { kind: 'verb' }, { kind: 'image' }, { kind: 'toneChar' }],
    [{ kind: 'image' }, { kind: 'verb' }, { kind: 'image' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'verb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'imageChar' }, { kind: 'toneChar' }, { kind: 'softVerb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'verb' }, { kind: 'image' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'softVerb' }, { kind: 'image' }],
    [{ kind: 'toneChar' }, { kind: 'imageChar' }, { kind: 'image' }, { kind: 'verb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'softVerb' }, { kind: 'image' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'verb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'softVerb' }, { kind: 'toneChar' }, { kind: 'imageChar' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'verb' }, { kind: 'image' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'softVerb' }, { kind: 'image' }],
    [{ kind: 'imageChar' }, { kind: 'toneChar' }, { kind: 'image' }, { kind: 'softVerb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'verb' }, { kind: 'image' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'verb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'verb' }, { kind: 'imageChar' }, { kind: 'image' }, { kind: 'toneChar' }],
    [{ kind: 'image' }, { kind: 'softVerb' }, { kind: 'image' }],
  ],
  [
    [{ kind: 'marker' }, { kind: 'softVerb' }, { kind: 'image' }],
    [{ kind: 'toneChar' }, { kind: 'image' }, { kind: 'imageChar' }, { kind: 'verb' }, { kind: 'image' }],
    [{ kind: 'image' }, { kind: 'verb' }, { kind: 'image' }],
  ],
];
const SOURCE_POETIC_VERBS = {
  china: {
    verb: '照入落过映起眠归拂绕穿渡藏向逐随问泊摇醒看寻开沉浮来去停舒敛转隐澄行',
    softVerb: '听照入落过映起眠归拂绕穿渡藏向逐随问泊摇醒看寻开沉浮来去停舒敛转隐澄行',
  },
  japan: {
    verb: '落照听过归入眠映浮渡寻泊醒静藏问开摇穿随起看隐澄拂绕逐向停舒敛转来去行',
    softVerb: '听照落过归入眠映浮渡寻泊醒静藏问开摇穿随起看隐澄拂绕逐向停舒敛转来去行',
  },
  india: {
    verb: '照听唤醒归寻渡映开过入浮问起看穿随藏澄拂绕逐向停舒敛转来去行',
    softVerb: '听照唤醒归寻渡映开过入浮问起看穿随藏澄拂绕逐向停舒敛转来去行',
  },
};
const JAPANESE_PARTICLES = 'のにへをやともはが';
const JAPANESE_KANA = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽぁぃぅぇぉゃゅょっ';
const JAPANESE_SEASON_WORDS = 'はる なつ あき ふゆ あさ よる ゆき つき ほし かぜ あめ くも うみ やま かわ もり まつ はな とり そら みず なみ きり つゆ しも すな いし たき こけ しま さと みね はま おか たに ぬま ふじ うめ もも あし'.split(' ');
const JAPANESE_IMAGE_WORDS = 'つき ほし ゆき はな かぜ あめ くも うみ やま かわ もり まつ とり そら みず なみ きり つゆ しも すな いし たき こけ しま さと みね はま おか たに ぬま ふじ うめ もも あし こえ かげ ゆめ あわ いろ おと ひび つぼ えだ はね つの たね くさ つち かい つる すみ'.split(' ');
const JAPANESE_PLACE_WORDS = 'やま うみ かわ もり はま さと しま たに みね おか ぬま いけ はし まど にわ みち つち そら むら うら いえ たき はら のべ あぜ すみ よこ かど した うえ なか きし おき かべ もと さき ほら ふち すえ より'.split(' ');
const JAPANESE_VERB_WORDS = 'ゆく みる きく まつ ねる さく ふる とぶ なく よむ たつ すむ ふく よる うく もゆ ぬく ひく おる いる くる かう あう おう よぶ なる きる ぬる ふむ つむ かむ のむ'.split(' ');
const JAPANESE_TOKEN_TEMPLATE = [
  [
    { kind: 'word', words: JAPANESE_SEASON_WORDS },
    { kind: 'char', chars: JAPANESE_PARTICLES },
    { kind: 'word', words: JAPANESE_IMAGE_WORDS },
  ],
  [
    { kind: 'word', words: JAPANESE_PLACE_WORDS },
    { kind: 'char', chars: JAPANESE_PARTICLES },
    { kind: 'word', words: JAPANESE_IMAGE_WORDS },
    { kind: 'word', words: JAPANESE_VERB_WORDS },
  ],
  [
    { kind: 'word', words: JAPANESE_IMAGE_WORDS },
    { kind: 'char', chars: JAPANESE_PARTICLES },
    { kind: 'word', words: JAPANESE_IMAGE_WORDS },
  ],
];

function chooseChar(chars) {
  const values = Array.from(new Set(Array.from(chars)));
  return values[crypto.randomInt(values.length)];
}

function chooseWord(words) {
  const values = Array.from(new Set(words));
  return values[crypto.randomInt(values.length)];
}

function uniqueChars(chars) {
  return Array.from(new Set(Array.from(chars)));
}

function sourceWordTiers(sourceKey) {
  const source = POETIC_SOURCE_WORDLISTS[sourceKey];
  if (!source) throw new Error(`Unknown poetic source: ${sourceKey}`);
  return Object.entries(POETIC_SOURCE_TIER_WEIGHTS).map(([name, weight]) => ({
    name,
    weight,
    words: source.words
      .filter(entry => entry.tier === name)
      .map(entry => entry.word),
  })).filter(tier => tier.words.length > 0);
}

function sourceImageEntries(sourceKey) {
  const source = POETIC_SOURCE_WORDLISTS[sourceKey];
  if (!source) return [];
  const entries = source.words.filter(entry => (
    (entry.tier === 'common' || entry.tier === 'varied')
    && (entry.quality ?? 0) >= 5
    && !/[人地马生世]/.test(entry.word)
    && !SOURCE_IMAGE_WORD_BAD_CHARS.test(entry.word)
    && !SOURCE_IMAGE_BAD_WORDS.has(entry.word)
  ));
  if (sourceKey === 'china') return entries;

  const seen = new Set(entries.map(entry => entry.word));
  const classicEntries = POETIC_SOURCE_WORDLISTS.china.words.filter(entry => (
    (entry.tier === 'common' || entry.tier === 'varied')
    && (entry.quality ?? 0) >= 5
    && !/[人地马生世]/.test(entry.word)
    && !SOURCE_IMAGE_WORD_BAD_CHARS.test(entry.word)
    && !SOURCE_IMAGE_BAD_WORDS.has(entry.word)
    && !seen.has(entry.word)
  ));
  return entries.concat(classicEntries);
}

function sourcePreferredImageEntries(sourceKey) {
  const entries = sourceImageEntries(sourceKey);
  return entries.filter(entry => (entry.quality ?? 0) >= SOURCE_IMAGE_PREFERRED_MIN_QUALITY);
}

function sourceImagePreferredWeight(sourceKey) {
  const allCount = sourceImageEntries(sourceKey).length;
  const preferredCount = sourcePreferredImageEntries(sourceKey).length;
  if (allCount === 0 || preferredCount === 0 || preferredCount >= allCount) return 0;
  const proportionalWeight = Math.ceil((preferredCount / allCount) * 100 * SOURCE_IMAGE_PREFERRED_RATIO_MULTIPLIER);
  return Math.min(
    SOURCE_IMAGE_PREFERRED_MAX_WEIGHT,
    Math.max(SOURCE_IMAGE_PREFERRED_MIN_WEIGHT, proportionalWeight)
  );
}

function chooseTieredSourceWord(sourceKey, usedWords) {
  const availableTiers = sourceWordTiers(sourceKey)
    .map(tier => ({ ...tier, candidates: tier.words.filter(word => !usedWords.has(word)) }))
    .filter(tier => tier.candidates.length > 0);
  const tiers = availableTiers.length
    ? availableTiers
    : sourceWordTiers(sourceKey).map(tier => ({ ...tier, candidates: tier.words }));
  const totalWeight = tiers.reduce((total, tier) => total + tier.weight, 0);
  let roll = crypto.randomInt(totalWeight);
  const tier = tiers.find((candidateTier) => {
    roll -= candidateTier.weight;
    return roll < 0;
  }) || tiers[tiers.length - 1];
  const word = tier.candidates[crypto.randomInt(tier.candidates.length)];
  usedWords.add(word);
  return word;
}

function wordOverlapsUsedImageChars(word, usedImageChars) {
  return Array.from(word).some(char => usedImageChars.has(char));
}

function markImageWordUsed(word, usedWords, usedImageChars) {
  usedWords.add(word);
  Array.from(word).forEach(char => usedImageChars.add(char));
}

function chooseSourceImageWord(sourceKey, usedWords, usedImageChars) {
  const preferredWeight = sourceImagePreferredWeight(sourceKey);
  const preferred = sourcePreferredImageEntries(sourceKey).map(entry => entry.word);
  const preferredSet = new Set(preferred);
  const fallback = sourceImageEntries(sourceKey)
    .map(entry => entry.word)
    .filter(word => !preferredSet.has(word));
  const shouldUsePreferred = preferredWeight > 0 && crypto.randomInt(100) < preferredWeight;
  const pool = shouldUsePreferred && preferred.length > 0 ? preferred : fallback;
  const fallbackPool = pool.length > 0 ? pool : preferred;
  const nonOverlapping = fallbackPool.filter(word => !usedWords.has(word) && !wordOverlapsUsedImageChars(word, usedImageChars));
  const unusedPreferred = fallbackPool.filter(word => !usedWords.has(word));
  const words = nonOverlapping.length >= SOURCE_IMAGE_ENTROPY_MIN_CHOICES
    ? nonOverlapping
    : (unusedPreferred.length ? unusedPreferred : fallbackPool);
  if (words.length === 0) return chooseTieredSourceWord(sourceKey, usedWords);
  const word = words[crypto.randomInt(words.length)];
  markImageWordUsed(word, usedWords, usedImageChars);
  return word;
}

function chooseSourceMarkerWord(sourceKey, usedWords, usedImageChars) {
  const source = POETIC_SOURCE_WORDLISTS[sourceKey];
  const badWords = SOURCE_MARKER_BAD_WORDS[sourceKey] || new Set();
  const preferred = source.words.filter(entry => (
    SOURCE_MARKER_PATTERNS[sourceKey]?.test(entry.word)
    && !/[地马生世]/.test(entry.word)
    && !SOURCE_IMAGE_BAD_CHARS.test(entry.word)
    && !badWords.has(entry.word)
  ));
  const fallbackSource = sourceImageEntries(sourceKey).slice(0, SOURCE_MARKER_WORD_COUNT);
  const markerSource = preferred.length >= SOURCE_MARKER_WORD_COUNT
    ? preferred.slice(0, SOURCE_MARKER_WORD_COUNT)
    : (
        SOURCE_MARKER_FORCE_SOURCE.has(sourceKey) && preferred.length > 0
          ? preferred
          : (
        preferred.length > 0 && crypto.randomInt(100) < SOURCE_MARKER_PREFERRED_WEIGHT
          ? preferred
          : fallbackSource
          )
      );
  const markerWords = markerSource.map(entry => entry.word).filter(word => !usedWords.has(word));
  const fallbackWords = markerSource.map(entry => entry.word);
  const words = markerWords.length ? markerWords : fallbackWords;
  const word = words[crypto.randomInt(words.length)];
  markImageWordUsed(word, usedWords, usedImageChars);
  return word;
}

function chooseSourcePoeticVerb(sourceKey, kind) {
  const verbs = SOURCE_POETIC_VERBS[sourceKey] || SOURCE_POETIC_VERBS.china;
  const categoryName = kind === 'softVerb' ? 'softVerb' : 'verb';
  return chooseChar(verbs[categoryName]);
}

function chooseSourcePoeticChar(kind, usedImageChars) {
  if (kind === 'toneChar') return chooseChar(SOURCE_TONE_CHARS);

  const imageChars = uniqueChars(SOURCE_IMAGE_CHARS);
  const freshChars = imageChars.filter(char => !usedImageChars.has(char));
  const chars = freshChars.length >= SOURCE_IMAGE_CHAR_ENTROPY_MIN_CHOICES ? freshChars : imageChars;
  const char = chars[crypto.randomInt(chars.length)];
  usedImageChars.add(char);
  return char;
}

function renderSourcePoeticLine(sourceKey, slots, usedWords, usedImageChars) {
  return slots.map((slot) => {
    if (slot.kind === 'marker') return chooseSourceMarkerWord(sourceKey, usedWords, usedImageChars);
    if (slot.kind === 'image') return chooseSourceImageWord(sourceKey, usedWords, usedImageChars);
    if (slot.kind === 'toneChar' || slot.kind === 'imageChar') return chooseSourcePoeticChar(slot.kind, usedImageChars);
    if (slot.kind === 'word') return chooseTieredSourceWord(sourceKey, usedWords);
    if (slot.kind === 'verb' || slot.kind === 'softVerb') return chooseSourcePoeticVerb(sourceKey, slot.kind);
    throw new Error(`Unknown source poetic token slot: ${slot.kind}`);
  }).join('');
}

function sourcePoeticPatterns(sourceKey) {
  if (POETIC_SOURCE_WORDLISTS[sourceKey]) return SOURCE_IMAGE_POETIC_PATTERNS;
  return SOURCE_POETIC_PATTERNS;
}

function generateSourcePoeticToken(sourceKey) {
  const usedWords = new Set();
  const usedImageChars = new Set();
  return chooseWord(sourcePoeticPatterns(sourceKey))
    .map(line => renderSourcePoeticLine(sourceKey, line, usedWords, usedImageChars))
    .join('-');
}

function generateChineseHaikuToken() {
  return generateSourcePoeticToken('china');
}

function generateJapaneseHaikuToken() {
  return generateSourcePoeticToken('japan');
}

function generateIndianHaikuToken() {
  return generateSourcePoeticToken('india');
}

function generateEnglishPassphraseToken() {
  return Array.from({ length: ENGLISH_TOKEN_WORD_COUNT }, () => chooseWord(ENGLISH_WORDS)).join('-');
}

function getChineseHaikuTokenEntropyBits() {
  return getSourcePoeticTokenEntropyBits('china');
}

function getSourcePoeticTokenEntropyBits(sourceKey) {
  const tiers = sourceWordTiers(sourceKey);
  const tierWeightTotal = tiers.reduce((total, tier) => total + tier.weight, 0);
  const verbCategories = SOURCE_POETIC_VERBS[sourceKey] || SOURCE_POETIC_VERBS.china;
  const patterns = sourcePoeticPatterns(sourceKey);
  const patternBits = Math.log2(patterns.length);
  const patternEntropies = patterns.map((pattern) => {
    let usedWordSlots = 0;
    return pattern.reduce((patternTotal, line) => {
      return patternTotal + line.reduce((lineTotal, slot) => {
        if (slot.kind === 'word') {
          const maxWordProbability = Math.max(...tiers.map((tier) => {
            const choices = Math.max(1, tier.words.length - usedWordSlots);
            return (tier.weight / tierWeightTotal) / choices;
          }));
          usedWordSlots += 1;
          return lineTotal - Math.log2(maxWordProbability);
        }
        if (slot.kind === 'image') {
          const preferredWeight = sourceImagePreferredWeight(sourceKey) / 100;
          const preferredChoices = Math.max(
            1,
            Math.min(SOURCE_IMAGE_ENTROPY_MIN_CHOICES, sourcePreferredImageEntries(sourceKey).length - usedWordSlots)
          );
          const fallbackChoices = Math.max(
            1,
            Math.min(
              SOURCE_IMAGE_ENTROPY_MIN_CHOICES,
              sourceImageEntries(sourceKey).length - sourcePreferredImageEntries(sourceKey).length - usedWordSlots
            )
          );
          const choices = sourceImagePreferredWeight(sourceKey) > 0
            ? 1 / Math.max(preferredWeight / preferredChoices, (1 - preferredWeight) / fallbackChoices)
            : Math.max(
                1,
                Math.min(SOURCE_IMAGE_ENTROPY_MIN_CHOICES, sourceImageEntries(sourceKey).length - usedWordSlots)
              );
          usedWordSlots += 1;
          return lineTotal + Math.log2(choices);
        }
        if (slot.kind === 'toneChar' || slot.kind === 'imageChar') {
          if (slot.kind === 'imageChar') {
            const choices = Math.min(SOURCE_IMAGE_CHAR_ENTROPY_MIN_CHOICES, uniqueChars(SOURCE_IMAGE_CHARS).length);
            return lineTotal + Math.log2(choices);
          }
          return lineTotal + Math.log2(uniqueChars(SOURCE_TONE_CHARS).length);
        }
        if (slot.kind === 'marker') {
          const source = POETIC_SOURCE_WORDLISTS[sourceKey];
          const badWords = SOURCE_MARKER_BAD_WORDS[sourceKey] || new Set();
          const preferred = source.words.filter(entry => (
            SOURCE_MARKER_PATTERNS[sourceKey]?.test(entry.word)
            && !/[地马生世]/.test(entry.word)
            && !SOURCE_IMAGE_BAD_CHARS.test(entry.word)
            && !badWords.has(entry.word)
          ));
          const fallbackChoices = Math.max(1, sourceImageEntries(sourceKey).slice(0, SOURCE_MARKER_WORD_COUNT).length);
          const preferredChoices = Math.max(1, Math.min(SOURCE_MARKER_WORD_COUNT, preferred.length));
          const maxMarkerProbability = preferred.length >= SOURCE_MARKER_WORD_COUNT
            ? 1 / preferredChoices
            : SOURCE_MARKER_FORCE_SOURCE.has(sourceKey) && preferred.length > 0
              ? 1 / preferredChoices
            : Math.max(
                (SOURCE_MARKER_PREFERRED_WEIGHT / 100) / preferredChoices,
                ((100 - SOURCE_MARKER_PREFERRED_WEIGHT) / 100) / fallbackChoices
              );
          usedWordSlots += 1;
          return lineTotal - Math.log2(maxMarkerProbability);
        }
        if (slot.kind === 'verb' || slot.kind === 'softVerb') {
          return lineTotal + Math.log2(uniqueChars(verbCategories[slot.kind]).length);
        }
        return lineTotal;
      }, 0);
    }, 0);
  });
  const bits = patternBits + Math.min(...patternEntropies);
  return Math.floor(bits);
}

function getEnglishPassphraseTokenEntropyBits() {
  return Math.floor(ENGLISH_TOKEN_WORD_COUNT * Math.log2(new Set(ENGLISH_WORDS).size));
}

function getJapaneseHaikuTokenEntropyBits() {
  return getSourcePoeticTokenEntropyBits('japan');
}

function getIndianHaikuTokenEntropyBits() {
  return getSourcePoeticTokenEntropyBits('india');
}

function normalizeTokenLocale(value) {
  const locale = String(value || '').trim().toLowerCase();
  if (locale === CHINESE_TOKEN_LOCALE || locale === 'zh-cn' || locale === 'zh_cn') return CHINESE_TOKEN_LOCALE;
  if (locale === JAPANESE_TOKEN_LOCALE || locale === 'jp' || locale === 'ja-jp' || locale === 'ja_jp') return JAPANESE_TOKEN_LOCALE;
  if (locale === INDIAN_TOKEN_LOCALE || locale === 'india' || locale === 'tagore') return INDIAN_TOKEN_LOCALE;
  if (locale === ENGLISH_TOKEN_LOCALE || locale === 'en-us' || locale === 'en_us') return ENGLISH_TOKEN_LOCALE;
  return AUTO_TOKEN_LOCALE;
}

function detectTimeZone(options = {}) {
  if (typeof options.timeZone === 'string' && options.timeZone.trim()) {
    return { timeZone: options.timeZone.trim(), source: `timeZone=${options.timeZone.trim()}` };
  }

  const env = options.env || process.env;
  if (typeof env.TZ === 'string' && env.TZ.trim()) {
    return { timeZone: env.TZ.trim(), source: `TZ=${env.TZ.trim()}` };
  }

  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timeZone) return { timeZone, source: `Intl timeZone=${timeZone}` };
  } catch {
    // Ignore missing ICU data and fall back to locale below.
  }

  return { timeZone: '', source: '' };
}

function localeEnvironmentValues(env = process.env) {
  return [
    env.LC_ALL,
    env.LC_MESSAGES,
    env.LANGUAGE,
    env.LANG,
  ].filter(Boolean).map(String);
}

function localeLooksChinese(value) {
  return String(value || '').split(':').some(part => /^zh(?:[_.-]|$)/i.test(part));
}

function localeLooksJapanese(value) {
  return String(value || '').split(':').some(part => /^ja(?:[_.-]|$)/i.test(part));
}

function resolvePoeticTokenLocale(options = {}) {
  const env = options.env || process.env;
  const explicitLocale = options.locale || env.FARMING_TOKEN_LOCALE || AUTO_TOKEN_LOCALE;
  const requestedLocale = normalizeTokenLocale(explicitLocale);
  if (
    requestedLocale === CHINESE_TOKEN_LOCALE
    || requestedLocale === JAPANESE_TOKEN_LOCALE
    || requestedLocale === INDIAN_TOKEN_LOCALE
    || requestedLocale === ENGLISH_TOKEN_LOCALE
  ) {
    return {
      locale: requestedLocale,
      style: requestedLocale === CHINESE_TOKEN_LOCALE
        ? 'zh-classic-haiku'
        : requestedLocale === JAPANESE_TOKEN_LOCALE
          ? 'zh-japan-haiku'
          : requestedLocale === INDIAN_TOKEN_LOCALE
            ? 'zh-india-haiku'
            : 'en-passphrase',
      source: `FARMING_TOKEN_LOCALE=${explicitLocale}`,
    };
  }

  const detectedTimeZone = detectTimeZone({ ...options, env });
  if (detectedTimeZone.timeZone && JAPANESE_TIME_ZONES.has(detectedTimeZone.timeZone)) {
    return { locale: JAPANESE_TOKEN_LOCALE, style: 'zh-japan-haiku', source: detectedTimeZone.source };
  }

  if (detectedTimeZone.timeZone && CHINESE_TIME_ZONES.has(detectedTimeZone.timeZone)) {
    return { locale: CHINESE_TOKEN_LOCALE, style: 'zh-classic-haiku', source: detectedTimeZone.source };
  }

  const japaneseLocaleValue = localeEnvironmentValues(env).find(localeLooksJapanese);
  if (japaneseLocaleValue) {
    return { locale: JAPANESE_TOKEN_LOCALE, style: 'zh-japan-haiku', source: `locale=${japaneseLocaleValue}` };
  }

  const localeValue = localeEnvironmentValues(env).find(localeLooksChinese);
  if (localeValue) {
    return { locale: CHINESE_TOKEN_LOCALE, style: 'zh-classic-haiku', source: `locale=${localeValue}` };
  }

  return {
    locale: ENGLISH_TOKEN_LOCALE,
    style: 'en-passphrase',
    source: detectedTimeZone.source || 'default=en',
  };
}

function generatePoeticToken(options = {}) {
  const resolved = resolvePoeticTokenLocale(options);
  if (resolved.locale === CHINESE_TOKEN_LOCALE) return generateChineseHaikuToken();
  if (resolved.locale === JAPANESE_TOKEN_LOCALE) return generateJapaneseHaikuToken();
  if (resolved.locale === INDIAN_TOKEN_LOCALE) return generateIndianHaikuToken();
  return generateEnglishPassphraseToken();
}

function getPoeticTokenEntropyBits(options = {}) {
  const resolved = resolvePoeticTokenLocale(options);
  if (resolved.locale === CHINESE_TOKEN_LOCALE) return getChineseHaikuTokenEntropyBits();
  if (resolved.locale === JAPANESE_TOKEN_LOCALE) return getJapaneseHaikuTokenEntropyBits();
  if (resolved.locale === INDIAN_TOKEN_LOCALE) return getIndianHaikuTokenEntropyBits();
  return getEnglishPassphraseTokenEntropyBits();
}

function createPoeticToken(options = {}) {
  const resolved = resolvePoeticTokenLocale(options);
  const token = resolved.locale === CHINESE_TOKEN_LOCALE
    ? generateChineseHaikuToken()
    : resolved.locale === JAPANESE_TOKEN_LOCALE
      ? generateJapaneseHaikuToken()
      : resolved.locale === INDIAN_TOKEN_LOCALE
        ? generateIndianHaikuToken()
        : generateEnglishPassphraseToken();
  const entropyBits = resolved.locale === CHINESE_TOKEN_LOCALE
    ? getChineseHaikuTokenEntropyBits()
    : resolved.locale === JAPANESE_TOKEN_LOCALE
      ? getJapaneseHaikuTokenEntropyBits()
      : resolved.locale === INDIAN_TOKEN_LOCALE
        ? getIndianHaikuTokenEntropyBits()
        : getEnglishPassphraseTokenEntropyBits();

  return {
    token,
    locale: resolved.locale,
    style: resolved.style,
    source: resolved.source,
    entropyBits,
  };
}

module.exports = {
  AUTO_TOKEN_LOCALE,
  CHINESE_POETIC_ACTIVE_WORDS,
  CHINESE_POETIC_CATEGORIES,
  CHINESE_POETIC_PATTERNS,
  CHINESE_POETIC_WORD_TIERS,
  CHINESE_POETIC_WORDS,
  CHINESE_TIME_ZONES,
  INDIAN_TOKEN_LOCALE,
  JAPANESE_TIME_ZONES,
  ENGLISH_TOKEN_WORD_COUNT,
  ENGLISH_WORDS,
  JAPANESE_KANA,
  JAPANESE_IMAGE_WORDS,
  JAPANESE_PLACE_WORDS,
  JAPANESE_SEASON_WORDS,
  JAPANESE_TOKEN_TEMPLATE,
  JAPANESE_VERB_WORDS,
  TOKEN_TEMPLATE,
  createPoeticToken,
  generateChineseHaikuToken,
  generateEnglishPassphraseToken,
  generateIndianHaikuToken,
  generateJapaneseHaikuToken,
  generatePoeticToken,
  generateSourcePoeticToken,
  getChineseHaikuTokenEntropyBits,
  getEnglishPassphraseTokenEntropyBits,
  getIndianHaikuTokenEntropyBits,
  getJapaneseHaikuTokenEntropyBits,
  getPoeticTokenEntropyBits,
  getSourcePoeticTokenEntropyBits,
  resolvePoeticTokenLocale,
};
