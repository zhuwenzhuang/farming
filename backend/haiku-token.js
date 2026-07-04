const crypto = require('crypto');

const SEASON_SKY = '春夏秋冬晨暮晓夜晴雨风雪霜露云月星灯山水江海林泉松竹花草沙石岸潮';
const LANDSCAPE = '山水云月风雨松竹星河花影霜露灯舟林泉溪石烟岚海潮雪径沙岸窗桥池峰';
const ACTIONS = '照入落过映起眠归拂绕穿渡藏向逐随问泊生满摇醒看寻开合沉浮来去停舒敛转隐澄';
const SOFT_ACTIONS = '听照入落过映起眠归拂绕穿渡藏向逐随问泊生满摇醒看寻开合沉浮来去停舒敛转隐澄';
const TONE = '清远深微静白青暖淡幽冷空新旧晚早轻薄浅柔寂玄澈寒明素野疏斜澄净碧苍遥阔圆润';
const IMAGE = '月星灯山水江海林泉松竹花草沙石岸潮桥窗池峰烟岚霜露苔钟云雪溪舟梦声影色';
const MID_SCENE = '雨雪风月云星花灯泉溪松竹海潮霜露烟岚舟影梦声叶沙石苔钟云雪溪桥窗池峰';
const PLACE_ENDING = '里外间边下上前后中尽处畔岸头底旁内侧口门桥窗径湾洲渚浦角';
const MOOD = '孤小轻白青远寒短晚旧新野闲静微暗明半一素淡幽冷薄浅深早暮低高柔寂疏斜澄净';
const CLOSE_LEFT = '松竹星月云雨风雪花溪海灯舟山水江林泉沙石岸潮桥窗池峰烟岚霜露苔钟梦声影色';
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
    { kind: 'pair', left: SEASON_SKY, right: LANDSCAPE },
    { kind: 'char', chars: ACTIONS },
    { kind: 'pair', left: TONE, right: IMAGE },
  ],
  [
    { kind: 'pair', left: SEASON_SKY, right: MID_SCENE },
    { kind: 'char', chars: SOFT_ACTIONS },
    { kind: 'pair', left: LANDSCAPE, right: PLACE_ENDING },
    { kind: 'pair', left: TONE, right: IMAGE },
  ],
  [
    { kind: 'pair', left: MOOD, right: IMAGE },
    { kind: 'char', chars: ACTIONS },
    { kind: 'pair', left: CLOSE_LEFT, right: LANDSCAPE },
  ],
];
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

function uniqueLength(chars) {
  return new Set(Array.from(chars)).size;
}

function chooseChar(chars) {
  const values = Array.from(new Set(Array.from(chars)));
  return values[crypto.randomInt(values.length)];
}

function chooseWord(words) {
  const values = Array.from(new Set(words));
  return values[crypto.randomInt(values.length)];
}

function renderSlot(slot) {
  if (slot.kind === 'pair') {
    return `${chooseChar(slot.left)}${chooseChar(slot.right)}`;
  }
  return chooseChar(slot.chars);
}

function generateChineseHaikuToken() {
  return TOKEN_TEMPLATE
    .map(line => line.map(renderSlot).join(''))
    .join('-');
}

function generateJapaneseHaikuToken() {
  return [5, 7, 5]
    .map(length => Array.from({ length }, () => chooseChar(JAPANESE_KANA)).join(''))
    .join('-');
}

function generateEnglishPassphraseToken() {
  return Array.from({ length: ENGLISH_TOKEN_WORD_COUNT }, () => chooseWord(ENGLISH_WORDS)).join('-');
}

function getChineseHaikuTokenEntropyBits() {
  const bits = TOKEN_TEMPLATE.flat().reduce((total, slot) => {
    if (slot.kind === 'pair') {
      return total + Math.log2(uniqueLength(slot.left)) + Math.log2(uniqueLength(slot.right));
    }
    return total + Math.log2(uniqueLength(slot.chars));
  }, 0);
  return Math.floor(bits);
}

function getEnglishPassphraseTokenEntropyBits() {
  return Math.floor(ENGLISH_TOKEN_WORD_COUNT * Math.log2(new Set(ENGLISH_WORDS).size));
}

function getJapaneseHaikuTokenEntropyBits() {
  return Math.floor(17 * Math.log2(uniqueLength(JAPANESE_KANA)));
}

function normalizeTokenLocale(value) {
  const locale = String(value || '').trim().toLowerCase();
  if (locale === CHINESE_TOKEN_LOCALE || locale === 'zh-cn' || locale === 'zh_cn') return CHINESE_TOKEN_LOCALE;
  if (locale === JAPANESE_TOKEN_LOCALE || locale === 'jp' || locale === 'ja-jp' || locale === 'ja_jp') return JAPANESE_TOKEN_LOCALE;
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
    || requestedLocale === ENGLISH_TOKEN_LOCALE
  ) {
    return {
      locale: requestedLocale,
      style: requestedLocale === CHINESE_TOKEN_LOCALE
        ? 'zh-haiku'
        : requestedLocale === JAPANESE_TOKEN_LOCALE
          ? 'ja-haiku'
          : 'en-passphrase',
      source: `FARMING_TOKEN_LOCALE=${explicitLocale}`,
    };
  }

  const detectedTimeZone = detectTimeZone({ ...options, env });
  if (detectedTimeZone.timeZone && JAPANESE_TIME_ZONES.has(detectedTimeZone.timeZone)) {
    return { locale: JAPANESE_TOKEN_LOCALE, style: 'ja-haiku', source: detectedTimeZone.source };
  }

  if (detectedTimeZone.timeZone && CHINESE_TIME_ZONES.has(detectedTimeZone.timeZone)) {
    return { locale: CHINESE_TOKEN_LOCALE, style: 'zh-haiku', source: detectedTimeZone.source };
  }

  const japaneseLocaleValue = localeEnvironmentValues(env).find(localeLooksJapanese);
  if (japaneseLocaleValue) {
    return { locale: JAPANESE_TOKEN_LOCALE, style: 'ja-haiku', source: `locale=${japaneseLocaleValue}` };
  }

  const localeValue = localeEnvironmentValues(env).find(localeLooksChinese);
  if (localeValue) {
    return { locale: CHINESE_TOKEN_LOCALE, style: 'zh-haiku', source: `locale=${localeValue}` };
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
  return generateEnglishPassphraseToken();
}

function getPoeticTokenEntropyBits(options = {}) {
  const resolved = resolvePoeticTokenLocale(options);
  if (resolved.locale === CHINESE_TOKEN_LOCALE) return getChineseHaikuTokenEntropyBits();
  if (resolved.locale === JAPANESE_TOKEN_LOCALE) return getJapaneseHaikuTokenEntropyBits();
  return getEnglishPassphraseTokenEntropyBits();
}

function createPoeticToken(options = {}) {
  const resolved = resolvePoeticTokenLocale(options);
  const token = resolved.locale === CHINESE_TOKEN_LOCALE
    ? generateChineseHaikuToken()
    : resolved.locale === JAPANESE_TOKEN_LOCALE
      ? generateJapaneseHaikuToken()
      : generateEnglishPassphraseToken();
  const entropyBits = resolved.locale === CHINESE_TOKEN_LOCALE
    ? getChineseHaikuTokenEntropyBits()
    : resolved.locale === JAPANESE_TOKEN_LOCALE
      ? getJapaneseHaikuTokenEntropyBits()
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
  CHINESE_TIME_ZONES,
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
  generateJapaneseHaikuToken,
  generatePoeticToken,
  getChineseHaikuTokenEntropyBits,
  getEnglishPassphraseTokenEntropyBits,
  getJapaneseHaikuTokenEntropyBits,
  getPoeticTokenEntropyBits,
  resolvePoeticTokenLocale,
};
