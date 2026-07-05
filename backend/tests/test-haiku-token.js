const assert = require('assert');
const {
  CHINESE_POETIC_ACTIVE_WORDS,
  CHINESE_POETIC_CATEGORIES,
  CHINESE_POETIC_PATTERNS,
  CHINESE_POETIC_WORD_TIERS,
  CHINESE_POETIC_WORDS,
  createPoeticToken,
  generateEnglishPassphraseToken,
  generateIndianHaikuToken,
  generateJapaneseHaikuToken,
  TOKEN_TEMPLATE,
  generatePoeticToken,
  getEnglishPassphraseTokenEntropyBits,
  getIndianHaikuTokenEntropyBits,
  getJapaneseHaikuTokenEntropyBits,
  getPoeticTokenEntropyBits,
  resolvePoeticTokenLocale,
} = require('../haiku-token');
const CHINA_SOURCE_WORDS = require('../data/poetic-word-sources/china.json');
const JAPAN_SOURCE_WORDS = require('../data/poetic-word-sources/japan.json');
const INDIA_SOURCE_WORDS = require('../data/poetic-word-sources/india.json');

function lineLengths(token) {
  return token.split('-').map(part => Array.from(part).length);
}

function slotWidth(slot) {
  if (slot.kind === 'word') return 2;
  if (slot.kind === 'verb' || slot.kind === 'softVerb') return 1;
  return 0;
}

function run() {
  assert.strictEqual(TOKEN_TEMPLATE.length, 3);
  assert(CHINESE_POETIC_WORDS.length >= 4096, 'Chinese token generator should keep a large curated word list');
  assert(CHINESE_POETIC_ACTIVE_WORDS.length >= 4096, 'Chinese token generator should use the full word pool');
  assert.deepStrictEqual(CHINESE_POETIC_WORD_TIERS.map(tier => tier.weight), [76, 20, 4]);
  assert.deepStrictEqual(CHINESE_POETIC_WORD_TIERS.map(tier => tier.words.length), [2048, 4096, 2048]);
  assert.strictEqual(new Set(CHINESE_POETIC_WORDS).size, CHINESE_POETIC_WORDS.length);
  CHINESE_POETIC_WORDS.forEach((word) => {
    assert.match(word, /^[\u4e00-\u9fa5]{2}$/);
    assert.notStrictEqual(word[0], word[1], `Chinese poetic words should avoid repeated characters: ${word}`);
  });
  assert(CHINESE_POETIC_PATTERNS.length >= 8, 'Chinese token generator should use a varied template pool');
  CHINESE_POETIC_PATTERNS.forEach((pattern) => {
    assert.deepStrictEqual(pattern.map(line => line.reduce((total, slot) => total + slotWidth(slot), 0)), [5, 7, 5]);
    pattern.flat().forEach((slot) => {
      if (slot.kind === 'verb' || slot.kind === 'softVerb') {
        assert(
          CHINESE_POETIC_CATEGORIES[slot.kind],
          `Chinese poetic category should exist: ${slot.kind}`
        );
      } else {
        assert.strictEqual(slot.kind, 'word');
      }
    });
  });
  assert.strictEqual(getPoeticTokenEntropyBits({ locale: 'zh' }) >= 90, true);

  const samples = Array.from({ length: 64 }, () => generatePoeticToken({ locale: 'zh' }));
  samples.forEach((token) => {
    assert.match(token, /^[\u4e00-\u9fa5-]+$/);
    assert.deepStrictEqual(lineLengths(token), [5, 7, 5]);
    assert(token.length < 64);
  });

  assert(new Set(samples).size > 60, 'haiku token generator should produce varied tokens');

  const japaneseSamples = Array.from({ length: 16 }, () => generateJapaneseHaikuToken());
  japaneseSamples.forEach((token) => {
    assert.match(token, /^[\u4e00-\u9fa5-]+$/);
    assert.deepStrictEqual(lineLengths(token), [5, 7, 5]);
  });
  assert(getJapaneseHaikuTokenEntropyBits() >= 85, 'Japanese 5-7-5 token should keep at least 85 bits');

  const indianSamples = Array.from({ length: 16 }, () => generateIndianHaikuToken());
  const indianMarkerPattern = /天空|诗人|清晨|微笑|森林|诗歌|夜晚|花园|河水|河岸|光明|深夜|青春|寺院|阴影|遥远|寂静|时光|月光|旅人|芦笛|莲花|尘世|孤寂|海岸|新生|心花|爱人|霞光|星光|晨光|灯光|暮歌|晨歌|心弦|河心|祝福|自由|灵魂|梦乡/;
  indianSamples.forEach((token) => {
    assert.match(token, /^[\u4e00-\u9fa5-]+$/);
    assert.deepStrictEqual(lineLengths(token), [5, 7, 5]);
    assert.match(token.split('-')[0].slice(0, 2), indianMarkerPattern);
  });
  assert(getIndianHaikuTokenEntropyBits() >= 85, 'Indian 5-7-5 token should keep at least 85 bits');

  [CHINA_SOURCE_WORDS, JAPAN_SOURCE_WORDS, INDIA_SOURCE_WORDS].forEach((source) => {
    assert(source.words.length >= 1000, `${source.key} source should keep enough candidates`);
    source.words.forEach((entry) => {
      assert.strictEqual(typeof entry.quality, 'number', `${source.key} source word should include a quality score`);
    });
    assert(source.stats.qualityRange.max >= source.stats.qualityRange.min, `${source.key} source should report quality range`);
  });

  const englishToken = generateEnglishPassphraseToken();
  assert.match(englishToken, /^[a-z-]+$/);
  assert.strictEqual(englishToken.split('-').length, 13);
  assert(getEnglishPassphraseTokenEntropyBits() >= 85, 'English passphrase token should keep at least 85 bits');

  assert.deepStrictEqual(
    resolvePoeticTokenLocale({ locale: 'auto', timeZone: 'Asia/Shanghai', env: {} }),
    { locale: 'zh', style: 'zh-classic-haiku', source: 'timeZone=Asia/Shanghai' }
  );
  assert.deepStrictEqual(
    resolvePoeticTokenLocale({ locale: 'auto', timeZone: 'Asia/Tokyo', env: {} }),
    { locale: 'ja', style: 'zh-japan-haiku', source: 'timeZone=Asia/Tokyo' }
  );
  assert.deepStrictEqual(
    resolvePoeticTokenLocale({ locale: 'auto', timeZone: 'UTC', env: { LANG: 'C.UTF-8' } }),
    { locale: 'en', style: 'en-passphrase', source: 'timeZone=UTC' }
  );
  assert.deepStrictEqual(
    resolvePoeticTokenLocale({ locale: 'ja', timeZone: 'Asia/Shanghai', env: {} }),
    { locale: 'ja', style: 'zh-japan-haiku', source: 'FARMING_TOKEN_LOCALE=ja' }
  );
  assert.deepStrictEqual(
    resolvePoeticTokenLocale({ locale: 'india', timeZone: 'Asia/Shanghai', env: {} }),
    { locale: 'in', style: 'zh-india-haiku', source: 'FARMING_TOKEN_LOCALE=india' }
  );
  assert.match(createPoeticToken({ locale: 'auto', timeZone: 'Asia/Tokyo', env: {} }).token, /^[\u4e00-\u9fa5-]+$/);
  assert.match(createPoeticToken({ locale: 'tagore', timeZone: 'UTC', env: {} }).token, /^[\u4e00-\u9fa5-]+$/);

  console.log('test-haiku-token passed');
}

run();
