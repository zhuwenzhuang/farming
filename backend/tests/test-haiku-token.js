const assert = require('assert');
const {
  createPoeticToken,
  generateEnglishPassphraseToken,
  generateJapaneseHaikuToken,
  TOKEN_TEMPLATE,
  generatePoeticToken,
  getEnglishPassphraseTokenEntropyBits,
  getJapaneseHaikuTokenEntropyBits,
  getPoeticTokenEntropyBits,
  resolvePoeticTokenLocale,
} = require('../haiku-token');

function lineLengths(token) {
  return token.split('-').map(part => Array.from(part).length);
}

function run() {
  assert.strictEqual(TOKEN_TEMPLATE.length, 3);
  assert.strictEqual(getPoeticTokenEntropyBits({ locale: 'zh' }) >= 85, true);

  const samples = Array.from({ length: 64 }, () => generatePoeticToken({ locale: 'zh' }));
  samples.forEach((token) => {
    assert.match(token, /^[\u4e00-\u9fa5-]+$/);
    assert.deepStrictEqual(lineLengths(token), [5, 7, 5]);
    assert(token.length < 64);
  });

  assert(new Set(samples).size > 60, 'haiku token generator should produce varied tokens');

  const japaneseSamples = Array.from({ length: 16 }, () => generateJapaneseHaikuToken());
  japaneseSamples.forEach((token) => {
    assert.match(token, /^[\u3040-\u309f-]+$/);
    assert.deepStrictEqual(lineLengths(token), [5, 7, 5]);
  });
  assert(getJapaneseHaikuTokenEntropyBits() >= 85, 'Japanese 5-7-5 token should keep at least 85 bits');

  const englishToken = generateEnglishPassphraseToken();
  assert.match(englishToken, /^[a-z-]+$/);
  assert.strictEqual(englishToken.split('-').length, 13);
  assert(getEnglishPassphraseTokenEntropyBits() >= 85, 'English passphrase token should keep at least 85 bits');

  assert.deepStrictEqual(
    resolvePoeticTokenLocale({ locale: 'auto', timeZone: 'Asia/Shanghai', env: {} }),
    { locale: 'zh', style: 'zh-haiku', source: 'timeZone=Asia/Shanghai' }
  );
  assert.deepStrictEqual(
    resolvePoeticTokenLocale({ locale: 'auto', timeZone: 'Asia/Tokyo', env: {} }),
    { locale: 'ja', style: 'ja-haiku', source: 'timeZone=Asia/Tokyo' }
  );
  assert.deepStrictEqual(
    resolvePoeticTokenLocale({ locale: 'auto', timeZone: 'UTC', env: { LANG: 'C.UTF-8' } }),
    { locale: 'en', style: 'en-passphrase', source: 'timeZone=UTC' }
  );
  assert.deepStrictEqual(
    resolvePoeticTokenLocale({ locale: 'ja', timeZone: 'Asia/Shanghai', env: {} }),
    { locale: 'ja', style: 'ja-haiku', source: 'FARMING_TOKEN_LOCALE=ja' }
  );
  assert.match(createPoeticToken({ locale: 'auto', timeZone: 'Asia/Tokyo', env: {} }).token, /^[\u3040-\u309f-]+$/);

  console.log('test-haiku-token passed');
}

run();
