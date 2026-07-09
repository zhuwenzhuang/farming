const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  QrShareTicketStore,
  SHARE_TICKET_ALPHABET,
  SHARE_TICKET_TTL_MS,
  createShareTicketCode,
} = require('../qr-share-tickets');

function fixedBytes(value) {
  return (length) => Buffer.alloc(length, value);
}

function run() {
  const code = createShareTicketCode({ length: 10, randomBytes: fixedBytes(0) });
  assert.strictEqual(code, 'AAAAAAAAAA');
  assert.match(code, /^[A-Z2-9]+$/);
  for (const char of code) {
    assert(SHARE_TICKET_ALPHABET.includes(char));
  }
  assert(!/[IO01]/.test(SHARE_TICKET_ALPHABET), 'share codes should avoid ambiguous characters');
  assert.strictEqual(SHARE_TICKET_TTL_MS, 5 * 60 * 1000);

  const store = new QrShareTicketStore({
    ttlMs: SHARE_TICKET_TTL_MS,
    codeLength: 10,
    randomBytes: fixedBytes(1),
  });
  const ticket = store.create('春风-轻落庭前-一枝梅', { now: 1000 });
  assert.strictEqual(ticket.code, 'BBBBBBBBBB');
  assert.strictEqual(ticket.expiresAt, 1000 + SHARE_TICKET_TTL_MS);
  assert.strictEqual(ticket.targetQuery, '');

  const targetedStore = new QrShareTicketStore({
    ttlMs: SHARE_TICKET_TTL_MS,
    codeLength: 10,
    randomBytes: fixedBytes(2),
  });
  const targeted = targetedStore.create('target-token', { now: 1500, targetQuery: 'ftarget=agent&agent=agent-1' });
  assert.strictEqual(targeted.targetQuery, 'ftarget=agent&agent=agent-1');
  assert.strictEqual(targetedStore.consume(targeted.code, { now: 1501 }).targetQuery, 'ftarget=agent&agent=agent-1');

  const consumed = store.consume('bbbbbbbbbb', { now: 1000 + SHARE_TICKET_TTL_MS - 1 });
  assert.strictEqual(consumed.token, '春风-轻落庭前-一枝梅');
  assert.strictEqual(store.consume(ticket.code, { now: 1000 + SHARE_TICKET_TTL_MS - 1 }), null);

  const expired = store.create('expired-token', { now: 2000 });
  assert.strictEqual(store.consume(expired.code, { now: 2000 + SHARE_TICKET_TTL_MS }), null);

  const revoked = store.create('revoked-token', { now: 3000 });
  assert.strictEqual(store.revoke(revoked.code), true);
  assert.strictEqual(store.consume(revoked.code, { now: 3001 }), null);

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert(
    serverSource.indexOf("app.get(routePath(BASE_PATH, '/j/:code')") <
      serverSource.indexOf('app.use(tokenAuth.middleware())'),
    'short share-code redemption should be available before token auth middleware'
  );
  assert(serverSource.includes("app.post(routePath(BASE_PATH, '/api/share/qr-ticket')"));
  assert(serverSource.includes("app.delete(routePath(BASE_PATH, '/api/share/qr-ticket/:code')"));
  assert(serverSource.includes('function shareTargetQueryFromBody'));
  assert(serverSource.includes("params.set('ftarget', kind)"));
  assert(serverSource.includes("target.kind === 'folder'"));
  assert(serverSource.includes("params.set('folder', folderPath)"));
  assert(serverSource.includes("res.redirect(302, entryPathWithQuery(ticket.targetQuery))"));
  assert(serverSource.includes('tokenLabel: authEnabled ? tokenAuth.getToken() :'));
  assert(serverSource.includes('const longPath = entryPathWithToken(ticket.targetQuery)'));
  assert(serverSource.includes('longUrl: absoluteClientUrl(req, longPath)'));
  assert(serverSource.includes('shortUrl: absoluteClientUrl(req, shortPath)'));

  console.log('qr share ticket assertions passed');
}

run();
