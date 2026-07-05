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
  indianSamples.forEach((token) => {
    assert.match(token, /^[\u4e00-\u9fa5-]+$/);
    assert.deepStrictEqual(lineLengths(token), [5, 7, 5]);
  });
  assert(getIndianHaikuTokenEntropyBits() >= 85, 'Indian 5-7-5 token should keep at least 85 bits');

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
