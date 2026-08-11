const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { importTsModule } = require('./helpers/import-ts-module');

const {
  DEFAULT_PROVIDER_HOME_ID,
  canonicalProviderSessionKey,
  canonicalResumedProviderSessionSource,
  decodeProviderSessionKey,
  decodeResumedProviderSessionSource,
  encodeProviderSessionKey,
  encodeResumedProviderSessionSource,
  legacyProviderSessionKeyAlias,
  providerSessionIdentityTupleKey,
} = require('../../shared/provider-session-identity.js');
const {
  findActiveAgentClaimingSession,
  mainPageAgentSessionFromKey,
  mainPageAgentSessionKey,
  mainPageAgentSessionsToAutoResume,
  resumedAgentSource,
} = require('../main-page-session.cjs');
const { FarmingSessionStore } = require('../farming-session-store.cjs');
const {
  buildCrtHistoryItems,
  buildCrtSearchResults,
  crtAgentSessionKey,
  crtCanonicalAgentSessionKey,
  crtClaimedSessionFromSource,
  crtHistoryItemResumeSession,
  crtResumedSessionFromSource,
} = require('../../frontend/skins/crt/app.js');

const COLLIDING_DEFAULT_SESSION_ID = 'home:work:x';
const HOME_SCOPED_HOME_ID = 'work';
const HOME_SCOPED_SESSION_ID = 'x';

function tempRoot(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `farming-${name}-`));
}

function normalizeMainPageSessionKeys(keys: unknown): string[] {
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [];
}

function assertExactCollisionIsDistinct(): void {
  // The pre-v2 encoding folded the Agent Home into the session id, so a legal
  // session id of `home:work:x` under the default Home produced exactly the same
  // string as session `x` bound to Agent Home `work`. The Home-scoped tuple owns
  // that spelling, so the colliding default-Home tuple has no pre-v2 alias.
  assert.strictEqual(
    legacyProviderSessionKeyAlias({
      provider: 'codex',
      providerHomeId: HOME_SCOPED_HOME_ID,
      sessionId: HOME_SCOPED_SESSION_ID,
    }),
    'agent-session:codex:home:work:x',
    'the Home-scoped tuple owns the ambiguous pre-v2 spelling',
  );
  assert.strictEqual(
    legacyProviderSessionKeyAlias({
      provider: 'codex',
      providerHomeId: DEFAULT_PROVIDER_HOME_ID,
      sessionId: COLLIDING_DEFAULT_SESSION_ID,
    }),
    '',
    'the colliding default-Home tuple must not claim the ambiguous pre-v2 spelling',
  );

  const defaultKey = mainPageAgentSessionKey('codex', COLLIDING_DEFAULT_SESSION_ID);
  const homeScopedKey = mainPageAgentSessionKey('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID);
  assert.notStrictEqual(defaultKey, homeScopedKey, 'v2 keys must distinguish the colliding tuples');

  const defaultSource = resumedAgentSource('codex', COLLIDING_DEFAULT_SESSION_ID);
  const homeScopedSource = resumedAgentSource('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID);
  assert.notStrictEqual(defaultSource, homeScopedSource, 'v2 sources must distinguish the colliding tuples');

  const defaultHandle = crtAgentSessionKey({ provider: 'codex', id: COLLIDING_DEFAULT_SESSION_ID });
  const homeScopedHandle = crtAgentSessionKey({
    provider: 'codex',
    id: HOME_SCOPED_SESSION_ID,
    providerHomeId: HOME_SCOPED_HOME_ID,
  });
  assert.notStrictEqual(defaultHandle, homeScopedHandle, 'v2 handles must distinguish the colliding tuples');

  assert.deepStrictEqual(mainPageAgentSessionFromKey(defaultKey), {
    provider: 'codex',
    providerHomeId: DEFAULT_PROVIDER_HOME_ID,
    sessionId: COLLIDING_DEFAULT_SESSION_ID,
  });
  assert.deepStrictEqual(mainPageAgentSessionFromKey(homeScopedKey), {
    provider: 'codex',
    providerHomeId: HOME_SCOPED_HOME_ID,
    sessionId: HOME_SCOPED_SESSION_ID,
  });
  assert.deepStrictEqual(decodeResumedProviderSessionSource(defaultSource), {
    provider: 'codex',
    providerHomeId: DEFAULT_PROVIDER_HOME_ID,
    sessionId: COLLIDING_DEFAULT_SESSION_ID,
    forked: false,
  });
  assert.deepStrictEqual(crtResumedSessionFromSource(homeScopedSource), {
    provider: 'codex',
    providerHomeId: HOME_SCOPED_HOME_ID,
    sessionId: HOME_SCOPED_SESSION_ID,
    forked: false,
  });
}

function assertDelimiterSafeRoundTrip(): void {
  const sessionIds = [
    'plain-session',
    'chat:with-colon',
    COLLIDING_DEFAULT_SESSION_ID,
    'home:work:x:y',
    '~2~default~spoofed',
    'percent%25encoded',
    'tilde~and%percent',
    '%',
    '~',
    '%7E',
    '%25',
    'foo%2Fbar',
    '100%~done',
  ];
  const homeIds = [DEFAULT_PROVIDER_HOME_ID, HOME_SCOPED_HOME_ID, 'home.2', 'home_id-3'];
  const keys = new Set<string>();

  for (const sessionId of sessionIds) {
    for (const providerHomeId of homeIds) {
      const key = encodeProviderSessionKey('codex', sessionId, providerHomeId);
      assert.deepStrictEqual(decodeProviderSessionKey(key), {
        provider: 'codex',
        providerHomeId,
        sessionId,
      }, `key round-trip failed for ${providerHomeId}/${sessionId}`);
      assert.strictEqual(canonicalProviderSessionKey(key), key, 'canonicalizing a v2 key must be a no-op');
      assert.ok(!keys.has(key), `v2 keys must be distinct: ${key}`);
      keys.add(key);

      const source = encodeResumedProviderSessionSource('codex', sessionId, providerHomeId);
      assert.deepStrictEqual(decodeResumedProviderSessionSource(source), {
        provider: 'codex',
        providerHomeId,
        sessionId,
        forked: false,
      }, `source round-trip failed for ${providerHomeId}/${sessionId}`);
      assert.strictEqual(
        canonicalResumedProviderSessionSource(source),
        source,
        'canonicalizing a v2 source must be a no-op',
      );
    }
  }
}

function assertNonCanonicalEscapesFailClosed(): void {
  // A v2 writer only ever emits `%25` and `%7E`. Accepting any other `%` sequence
  // would decode it unchanged and then canonicalize it into a different string —
  // `foo%2Fbar` would become `foo%252Fbar` — inventing a tuple nothing wrote.
  const nonCanonicalPayloads = [
    '~2~default~foo%2Fbar',
    '~2~default~foo%bar',
    '~2~default~foo%7ebar',
    '~2~default~foo%25bar%',
    '~2~default~foo%',
    '~2~default~%',
    '~2~default~%2',
    '~2~default~%%25',
    '~2~default~%7e',
    '~2~default~ session-1',
    '~2~de%2Ffault~session-1',
    '~2~default%7e~session-1',
  ];
  for (const payload of nonCanonicalPayloads) {
    const key = `agent-session:codex:${payload}`;
    assert.strictEqual(
      decodeProviderSessionKey(key),
      null,
      `a non-canonical v2 escape must fail closed: ${payload}`,
    );
    assert.strictEqual(
      canonicalProviderSessionKey(key),
      '',
      `a non-canonical v2 escape must not canonicalize: ${payload}`,
    );
    assert.strictEqual(
      mainPageAgentSessionFromKey(key),
      null,
      `a non-canonical v2 escape must not become an auto-resume session: ${payload}`,
    );
    assert.strictEqual(
      decodeResumedProviderSessionSource(`codex-history:${payload}`),
      null,
      `a non-canonical v2 source escape must fail closed: ${payload}`,
    );
    assert.strictEqual(
      crtCanonicalAgentSessionKey(key),
      '',
      `CRT must fail closed on a non-canonical v2 escape: ${payload}`,
    );
    assert.strictEqual(
      crtResumedSessionFromSource(`codex-history:${payload}`),
      null,
      `CRT must fail closed on a non-canonical v2 source escape: ${payload}`,
    );
  }

  // The canonical spelling of the same ids is accepted and re-encodes exactly.
  for (const sessionId of ['foo%2Fbar', 'foo%bar', 'foo%7ebar', '%', '~']) {
    const key = encodeProviderSessionKey('codex', sessionId, DEFAULT_PROVIDER_HOME_ID);
    assert.strictEqual(decodeProviderSessionKey(key)?.sessionId, sessionId);
    assert.strictEqual(canonicalProviderSessionKey(key), key);
    assert.strictEqual(crtCanonicalAgentSessionKey(key), key, 'CRT must accept the canonical spelling');
  }
}

function assertIllegalIdentityFieldsAreRefused(): void {
  // The Agent Home id is validated against the authoritative charset used by the
  // resume boundary, so an illegal Home can never reach a durable key.
  for (const providerHomeId of ['home:nested', 'tilde~home', 'percent%home', 'with space', '']) {
    assert.strictEqual(
      encodeProviderSessionKey('codex', 'session-1', providerHomeId || DEFAULT_PROVIDER_HOME_ID),
      providerHomeId ? '' : mainPageAgentSessionKey('codex', 'session-1'),
      `an illegal Agent Home id must not be encoded: ${providerHomeId}`,
    );
    if (!providerHomeId) continue;
    assert.strictEqual(
      encodeResumedProviderSessionSource('codex', 'session-1', providerHomeId),
      '',
      `an illegal Agent Home id must not be encoded into a source: ${providerHomeId}`,
    );
    assert.strictEqual(
      crtAgentSessionKey({ provider: 'codex', id: 'session-1', providerHomeId }),
      '',
      `CRT must refuse an illegal Agent Home id: ${providerHomeId}`,
    );
    // A hand-edited durable key must not be accepted either.
    assert.strictEqual(
      decodeProviderSessionKey(`agent-session:codex:~2~${providerHomeId}~session-1`),
      null,
      `an illegal Agent Home id must not decode: ${providerHomeId}`,
    );
    assert.strictEqual(
      crtCanonicalAgentSessionKey(`agent-session:codex:~2~${providerHomeId}~session-1`),
      '',
      `CRT must refuse to canonicalize an illegal Agent Home id: ${providerHomeId}`,
    );
  }

  for (const provider of ['1codex', 'co dex', 'codex.1', '']) {
    assert.strictEqual(
      encodeProviderSessionKey(provider, 'session-1'),
      '',
      `an illegal provider must not be encoded: ${provider}`,
    );
    assert.strictEqual(
      crtAgentSessionKey({ provider, id: 'session-1' }),
      '',
      `CRT must refuse an illegal provider: ${provider}`,
    );
  }
  assert.strictEqual(
    decodeProviderSessionKey('agent-session:CODEX:~2~default~session-1')?.provider,
    'codex',
    'a provider is normalized rather than rejected for case',
  );
}

function assertMalformedV2PayloadsFailClosed(): void {
  // `~2~` is unreachable for a pre-v2 writer, so a payload carrying it is a v2
  // payload. A malformed one is corrupt, and reading it as legacy would invent a
  // session id of `~2~...` and bind durable state to it.
  const malformedPayloads = [
    '~2~',
    '~2~default',
    '~2~default~',
    '~2~~session-1',
    '~2~default~session~extra',
  ];
  for (const payload of malformedPayloads) {
    assert.strictEqual(
      decodeProviderSessionKey(`agent-session:codex:${payload}`),
      null,
      `a malformed v2 key must fail closed: ${payload}`,
    );
    assert.strictEqual(
      canonicalProviderSessionKey(`agent-session:codex:${payload}`),
      '',
      `a malformed v2 key must not canonicalize: ${payload}`,
    );
    assert.strictEqual(
      mainPageAgentSessionFromKey(`agent-session:codex:${payload}`),
      null,
      `a malformed v2 key must not become an auto-resume session: ${payload}`,
    );
    assert.strictEqual(
      decodeResumedProviderSessionSource(`codex-history:${payload}`),
      null,
      `a malformed v2 source must fail closed: ${payload}`,
    );
    assert.strictEqual(
      crtCanonicalAgentSessionKey(`agent-session:codex:${payload}`),
      '',
      `CRT must fail closed on a malformed v2 key: ${payload}`,
    );
    assert.strictEqual(
      crtResumedSessionFromSource(`codex-history:${payload}`),
      null,
      `CRT must fail closed on a malformed v2 source: ${payload}`,
    );
  }
}

function assertLegacyShapesKeepHistoricalMeaning(): void {
  // Historical shape 1: no Agent Home segment.
  assert.deepStrictEqual(decodeProviderSessionKey('agent-session:codex:session-1'), {
    provider: 'codex',
    providerHomeId: DEFAULT_PROVIDER_HOME_ID,
    sessionId: 'session-1',
  });
  assert.deepStrictEqual(decodeProviderSessionKey('agent-session:claude:chat:with-colon'), {
    provider: 'claude',
    providerHomeId: DEFAULT_PROVIDER_HOME_ID,
    sessionId: 'chat:with-colon',
  });

  // Historical shape 2: `home:<homeId>:` prefix wins, which is also the only
  // reading available for the ambiguous pair. v2 does not invent a new answer.
  assert.deepStrictEqual(decodeProviderSessionKey('agent-session:codex:home:work:x'), {
    provider: 'codex',
    providerHomeId: HOME_SCOPED_HOME_ID,
    sessionId: HOME_SCOPED_SESSION_ID,
  });
  assert.deepStrictEqual(decodeResumedProviderSessionSource('codex-history:home:work:x'), {
    provider: 'codex',
    providerHomeId: HOME_SCOPED_HOME_ID,
    sessionId: HOME_SCOPED_SESSION_ID,
    forked: false,
  });
  assert.deepStrictEqual(decodeResumedProviderSessionSource('codex-history-fork:session-1'), {
    provider: 'codex',
    providerHomeId: DEFAULT_PROVIDER_HOME_ID,
    sessionId: 'session-1',
    forked: true,
  });

  assert.strictEqual(
    canonicalProviderSessionKey('agent-session:codex:home:work:x'),
    mainPageAgentSessionKey('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID),
  );
  assert.strictEqual(
    crtCanonicalAgentSessionKey('agent-session:codex:home:work:x'),
    mainPageAgentSessionKey('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID),
    'CRT must upgrade a legacy key to the same v2 key the backend writes',
  );
  assert.strictEqual(canonicalProviderSessionKey('not-a-session-key'), '');
}

function assertCrtMirrorsSharedCodec(): void {
  const cases = [
    { sessionId: 'plain-session', providerHomeId: DEFAULT_PROVIDER_HOME_ID },
    { sessionId: COLLIDING_DEFAULT_SESSION_ID, providerHomeId: DEFAULT_PROVIDER_HOME_ID },
    { sessionId: HOME_SCOPED_SESSION_ID, providerHomeId: HOME_SCOPED_HOME_ID },
    { sessionId: 'tilde~and%percent', providerHomeId: 'home.2' },
  ];
  for (const { sessionId, providerHomeId } of cases) {
    assert.strictEqual(
      crtAgentSessionKey({ provider: 'codex', id: sessionId, providerHomeId }),
      encodeProviderSessionKey('codex', sessionId, providerHomeId),
      `CRT key encoding diverged for ${providerHomeId}/${sessionId}`,
    );
    const source = encodeResumedProviderSessionSource('codex', sessionId, providerHomeId);
    assert.deepStrictEqual(
      crtResumedSessionFromSource(source),
      { provider: 'codex', providerHomeId, sessionId, forked: false },
      `CRT source decoding diverged for ${providerHomeId}/${sessionId}`,
    );
    const forkSource = encodeResumedProviderSessionSource('codex', sessionId, providerHomeId, { forked: true });
    assert.deepStrictEqual(
      crtResumedSessionFromSource(forkSource),
      { provider: 'codex', providerHomeId, sessionId, forked: true },
      `CRT fork source decoding diverged for ${providerHomeId}/${sessionId}`,
    );
    assert.strictEqual(
      crtClaimedSessionFromSource(forkSource),
      null,
      `CRT must not claim the origin of a forked resume: ${providerHomeId}/${sessionId}`,
    );
  }
}

function assertFrontendHandleMatchesBackendKey(): void {
  const { agentSessionId } = importTsModule('src/components/code/model.ts') as {
    agentSessionId: (session: { provider: string; id: string; providerHomeId?: string }) => string;
  };
  const sessionDisplay = importTsModule('src/components/code/session-display.ts') as {
    normalizeMainPageSessionKeys: (keys: string[]) => string[];
    resumedAgentSource: (provider: string, sessionId: string, providerHomeId?: string) => string;
    resumedAgentSessionSourceIdentity: (source?: string) => unknown;
  };

  assert.strictEqual(
    agentSessionId({ provider: 'codex', id: COLLIDING_DEFAULT_SESSION_ID }),
    mainPageAgentSessionKey('codex', COLLIDING_DEFAULT_SESSION_ID),
  );
  assert.strictEqual(
    agentSessionId({ provider: 'codex', id: HOME_SCOPED_SESSION_ID, providerHomeId: HOME_SCOPED_HOME_ID }),
    mainPageAgentSessionKey('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID),
  );
  assert.notStrictEqual(
    agentSessionId({ provider: 'codex', id: COLLIDING_DEFAULT_SESSION_ID }),
    agentSessionId({ provider: 'codex', id: HOME_SCOPED_SESSION_ID, providerHomeId: HOME_SCOPED_HOME_ID }),
  );
  assert.strictEqual(
    sessionDisplay.resumedAgentSource('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID),
    resumedAgentSource('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID),
  );
  assert.deepStrictEqual(
    sessionDisplay.resumedAgentSessionSourceIdentity('codex-history:home:work:x'),
    { provider: 'codex', providerHomeId: HOME_SCOPED_HOME_ID, sessionId: HOME_SCOPED_SESSION_ID, forked: false },
  );

  // A legacy alias and its v2 key are one membership entry, not two rows.
  const canonicalKey = mainPageAgentSessionKey('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID);
  assert.deepStrictEqual(
    sessionDisplay.normalizeMainPageSessionKeys([
      'agent-session:codex:home:work:x',
      canonicalKey,
      'agent-session:codex:tmp_uuid_pending',
      'agent-session:codex:-dash-leading',
    ]),
    [canonicalKey],
  );
}

function assertAutoResumeDedupesByTuple(): void {
  const canonicalKey = mainPageAgentSessionKey('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID);
  const sessions = mainPageAgentSessionsToAutoResume({
    mainPageSessionKeys: [
      'agent-session:codex:home:work:x',
      canonicalKey,
      mainPageAgentSessionKey('codex', COLLIDING_DEFAULT_SESSION_ID),
      'agent-session:bash:not-a-resume-provider',
    ],
  });
  assert.deepStrictEqual(sessions, [
    { provider: 'codex', providerHomeId: HOME_SCOPED_HOME_ID, sessionId: HOME_SCOPED_SESSION_ID },
    { provider: 'codex', providerHomeId: DEFAULT_PROVIDER_HOME_ID, sessionId: COLLIDING_DEFAULT_SESSION_ID },
  ]);
  assert.notStrictEqual(
    providerSessionIdentityTupleKey(sessions[0]),
    providerSessionIdentityTupleKey(sessions[1]),
  );
}

function assertClaimIsTupleExact(): void {
  const homeScopedSession = { id: HOME_SCOPED_SESSION_ID, providerHomeId: HOME_SCOPED_HOME_ID };
  const collidingSession = { id: COLLIDING_DEFAULT_SESSION_ID, providerHomeId: DEFAULT_PROVIDER_HOME_ID };

  const legacyKeyAgent = { id: 'agent-legacy-key', status: 'running', providerSessionKey: 'agent-session:codex:home:work:x' };
  assert.strictEqual(
    findActiveAgentClaimingSession([legacyKeyAgent], 'codex', homeScopedSession)?.id,
    'agent-legacy-key',
    'a legacy persisted key must still claim its tuple',
  );
  assert.strictEqual(
    findActiveAgentClaimingSession([legacyKeyAgent], 'codex', collidingSession),
    null,
    'a legacy Agent Home key must not claim the colliding default-home session',
  );

  const legacySourceAgent = { id: 'agent-legacy-source', status: 'running', source: 'codex-history:home:work:x' };
  assert.strictEqual(
    findActiveAgentClaimingSession([legacySourceAgent], 'codex', homeScopedSession)?.id,
    'agent-legacy-source',
    'a legacy resumed source must still claim its tuple',
  );
  assert.strictEqual(
    findActiveAgentClaimingSession([legacySourceAgent], 'codex', collidingSession),
    null,
  );

  const v2Agent = {
    id: 'agent-v2',
    status: 'running',
    providerSessionKey: mainPageAgentSessionKey('codex', COLLIDING_DEFAULT_SESSION_ID),
  };
  assert.strictEqual(
    findActiveAgentClaimingSession([v2Agent], 'codex', collidingSession)?.id,
    'agent-v2',
  );
  assert.strictEqual(findActiveAgentClaimingSession([v2Agent], 'codex', homeScopedSession), null);

  const forkAgent = {
    id: 'agent-fork',
    status: 'running',
    source: encodeResumedProviderSessionSource('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID, { forked: true }),
  };
  assert.strictEqual(
    findActiveAgentClaimingSession([forkAgent], 'codex', homeScopedSession),
    null,
    'a forked resume starts a new provider session and never claims the origin',
  );

  const fieldAgent = {
    id: 'agent-fields',
    status: 'running',
    providerSessionProvider: 'codex',
    providerSessionId: HOME_SCOPED_SESSION_ID,
    providerHomeId: HOME_SCOPED_HOME_ID,
  };
  assert.strictEqual(
    findActiveAgentClaimingSession([fieldAgent], 'codex', homeScopedSession)?.id,
    'agent-fields',
  );
  assert.strictEqual(findActiveAgentClaimingSession([fieldAgent], 'codex', collidingSession), null);
}

function assertStoreMigratesLegacyKeysWithoutDoubleEntries(): void {
  const root = tempRoot('provider-session-identity');
  try {
    const legacyKey = 'agent-session:codex:home:work:x';
    const canonicalKey = mainPageAgentSessionKey('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID);

    const store = new FarmingSessionStore(root, { normalizeMainPageSessionKeys });
    store.init({ legacyMainPageSessionKeys: [legacyKey] });

    assert.deepStrictEqual(
      store.getMainPageSessionKeys(),
      [canonicalKey],
      'startup migration must rewrite a legacy membership entry to v2',
    );

    const record = store.getRecordForProviderSessionKey(legacyKey);
    assert.ok(record, 'a legacy key must resolve the record for its tuple');
    assert.strictEqual(record.providerSessionKey, canonicalKey);
    assert.strictEqual(record.providerHomeId, HOME_SCOPED_HOME_ID);
    assert.strictEqual(record.providerSessionId, HOME_SCOPED_SESSION_ID);
    assert.strictEqual(store.getRecordForProviderSessionKey(canonicalKey)?.id, record.id);
    assert.strictEqual(
      store.getRecordForProviderSessionKey(mainPageAgentSessionKey('codex', COLLIDING_DEFAULT_SESSION_ID)),
      null,
      'the colliding default-home tuple must be a different record',
    );

    // Remembering the legacy alias again must not add a second row.
    assert.deepStrictEqual(store.rememberMainPageSessionKey(legacyKey), [canonicalKey]);
    assert.deepStrictEqual(store.getMainPageSessionKeys(), [canonicalKey]);

    // The colliding tuple is a genuinely separate membership entry.
    const collidingKey = mainPageAgentSessionKey('codex', COLLIDING_DEFAULT_SESSION_ID);
    assert.deepStrictEqual(
      store.rememberMainPageSessionKey(collidingKey),
      [collidingKey, canonicalKey],
    );

    // A caller still holding the legacy alias must remove the same tuple.
    assert.strictEqual(store.removeMainPageSessionKey(legacyKey), true);
    assert.deepStrictEqual(store.getMainPageSessionKeys(), [collidingKey]);
    assert.deepStrictEqual(store.removeMainPageSessionKeys([collidingKey]), [collidingKey]);
    assert.deepStrictEqual(store.getMainPageSessionKeys(), []);

    const restarted = new FarmingSessionStore(root, { normalizeMainPageSessionKeys });
    restarted.init();
    assert.strictEqual(
      restarted.getRecordForProviderSessionKey(legacyKey)?.providerSessionKey,
      canonicalKey,
      'the persisted record must survive the restart under its v2 key',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertStoreKeepsAgentBindingsTupleExact(): void {
  const root = tempRoot('provider-session-identity-agents');
  try {
    const store = new FarmingSessionStore(root, { normalizeMainPageSessionKeys });
    store.init();

    const collidingId = store.rememberAgent({
      id: 'runtime-colliding',
      providerSessionProvider: 'codex',
      providerSessionId: COLLIDING_DEFAULT_SESSION_ID,
      providerHomeId: DEFAULT_PROVIDER_HOME_ID,
    });
    const homeScopedId = store.rememberAgent({
      id: 'runtime-home-scoped',
      providerSessionProvider: 'codex',
      providerSessionId: HOME_SCOPED_SESSION_ID,
      providerHomeId: HOME_SCOPED_HOME_ID,
    });
    assert.notStrictEqual(collidingId, homeScopedId, 'the colliding tuples must bind to separate records');
    assert.deepStrictEqual(store.getMainPageSessionKeys(), [
      mainPageAgentSessionKey('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID),
      mainPageAgentSessionKey('codex', COLLIDING_DEFAULT_SESSION_ID),
    ]);

    assert.strictEqual(
      store.providerSessionKeyForAgent({
        providerSessionKey: 'agent-session:codex:home:work:x',
      }),
      mainPageAgentSessionKey('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID),
    );
    assert.strictEqual(
      store.providerSessionKeyForAgent({
        providerSessionProvider: 'codex',
        providerSessionId: COLLIDING_DEFAULT_SESSION_ID,
      }),
      mainPageAgentSessionKey('codex', COLLIDING_DEFAULT_SESSION_ID),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withSilencedWarnings<T>(body: () => T): T {
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    return body();
  } finally {
    console.warn = originalWarn;
  }
}

function assertMixedIndexSpellingsResolveDeterministically(): void {
  const root = tempRoot('provider-session-identity-index');
  try {
    const store = new FarmingSessionStore(root, { normalizeMainPageSessionKeys });
    const legacyKey = 'agent-session:codex:home:work:x';
    const canonicalKey = mainPageAgentSessionKey('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID);
    const legacyBoundId = 'agent_legacy_binding';
    const v2BoundId = 'agent_v2_binding';

    // A v2 spelling was written by a v2 build, so it outranks the pre-v2 alias
    // for the same tuple no matter which key the persisted object lists first.
    assert.deepStrictEqual(
      store.normalizeProviderSessionRecords({ [legacyKey]: legacyBoundId, [canonicalKey]: v2BoundId }),
      { [canonicalKey]: v2BoundId },
    );
    assert.deepStrictEqual(
      store.normalizeProviderSessionRecords({ [canonicalKey]: v2BoundId, [legacyKey]: legacyBoundId }),
      { [canonicalKey]: v2BoundId },
    );

    // Agreeing spellings collapse into a single binding.
    assert.deepStrictEqual(
      store.normalizeProviderSessionRecords({ [legacyKey]: v2BoundId, [canonicalKey]: v2BoundId }),
      { [canonicalKey]: v2BoundId },
    );

    // Two equally authoritative spellings that disagree are dropped, so the
    // reconcile pass rebuilds the binding from the authoritative records.
    assert.deepStrictEqual(
      withSilencedWarnings(() => store.normalizeProviderSessionRecords({
        [legacyKey]: legacyBoundId,
        'agent-session:CODEX:home:work:x': v2BoundId,
      })),
      {},
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertConflictingRecordSpellingsFailClosed(): void {
  const root = tempRoot('provider-session-identity-conflict');
  try {
    const store = new FarmingSessionStore(root, { normalizeMainPageSessionKeys });
    fs.mkdirSync(store.sessionsDir, { recursive: true });
    const canonicalKey = mainPageAgentSessionKey('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID);
    const records = [
      { id: 'agent_legacy_spelling', providerSessionKey: 'agent-session:codex:home:work:x' },
      { id: 'agent_v2_spelling', providerSessionKey: canonicalKey },
    ];
    for (const record of records) {
      fs.writeFileSync(path.join(store.sessionsDir, `${record.id}.json`), JSON.stringify({
        ...record,
        kind: 'agent',
        provider: 'codex',
        providerHomeId: HOME_SCOPED_HOME_ID,
        providerSessionId: HOME_SCOPED_SESSION_ID,
      }));
    }

    // Two records claiming one tuple is unprovable state, whichever spelling
    // each one was written with.
    assert.throws(() => store.init(), /Conflicting Farming session records/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertPendingForkClaimsNothing(): void {
  // A fork is admitted before its own provider session id exists, so for a window
  // the only identity it carries is the origin it was forked from. Nothing may
  // read that as a claim on the origin session.
  const originKey = mainPageAgentSessionKey('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID);
  const forkSource = encodeResumedProviderSessionSource(
    'codex',
    HOME_SCOPED_SESSION_ID,
    HOME_SCOPED_HOME_ID,
    { forked: true },
  );
  const sessionDisplay = importTsModule('src/components/code/session-display.ts') as {
    claimedAgentSessionHandle: (agent: { providerSessionKey?: string; source?: string }) => string;
  };
  const { claimedAgentSessionKeysForAgents } = importTsModule('src/components/code/agent-list-state.ts') as {
    claimedAgentSessionKeysForAgents: (agents: unknown[], sessions?: unknown[]) => Set<string>;
  };
  const composerState = importTsModule('src/components/code/composer-state.ts') as {
    composerStateKeyForAgent: (agent: unknown) => string;
    composerStateAliasKeysForAgent: (agent: unknown) => string[];
  };
  const pendingForkAgent = {
    id: 'agent-pending-fork',
    command: 'codex',
    cwd: '/repo',
    projectWorkspace: '/repo',
    source: forkSource,
    status: 'running',
    isMain: false,
    archived: false,
    startedAt: 190_000,
  };
  const originSession = {
    provider: 'codex',
    id: HOME_SCOPED_SESSION_ID,
    providerHomeId: HOME_SCOPED_HOME_ID,
    title: 'Origin',
    workspace: '/repo',
    cwd: '/repo',
    updatedAt: new Date(200_000).toISOString(),
  };

  assert.strictEqual(
    sessionDisplay.claimedAgentSessionHandle(pendingForkAgent),
    '',
    'a pending fork resolves no main-page handle, so it cannot pin or remove the origin membership',
  );
  assert.strictEqual(
    sessionDisplay.claimedAgentSessionHandle({ ...pendingForkAgent, providerSessionKey: originKey }),
    originKey,
    'an explicit provider session key still owns the handle',
  );
  assert.deepStrictEqual(
    Array.from(claimedAgentSessionKeysForAgents([pendingForkAgent], [originSession])),
    [],
    'Code must not let a pending fork claim the origin session row',
  );
  assert.strictEqual(
    composerState.composerStateKeyForAgent(pendingForkAgent),
    pendingForkAgent.id,
    'a pending fork keeps its own composer key instead of adopting the origin draft',
  );
  assert.deepStrictEqual(
    composerState.composerStateAliasKeysForAgent(pendingForkAgent),
    [pendingForkAgent.id],
    'a pending fork exposes no composer alias for the origin session, v2 or pre-v2',
  );

  const crtSessions = [{
    provider: 'codex',
    id: HOME_SCOPED_SESSION_ID,
    providerHomeId: HOME_SCOPED_HOME_ID,
    title: 'Origin',
    workspace: '/repo',
    updatedAt: new Date(200_000).toISOString(),
  }];
  assert.deepStrictEqual(
    buildCrtHistoryItems({ agents: [pendingForkAgent], sessions: crtSessions })
      .filter((item: { kind: string }) => item.kind === 'session')
      .map((item: { session: { id: string } }) => item.session.id),
    [HOME_SCOPED_SESSION_ID],
    'CRT History must keep the origin session listed while a fork of it is live',
  );
  assert.deepStrictEqual(
    buildCrtSearchResults({
      query: 'origin',
      agents: [pendingForkAgent],
      sessions: crtSessions,
    }).map((result: { kind: string }) => result.kind),
    ['session'],
    'CRT Search must keep the origin session resumable while a fork of it is live',
  );
}

function assertForkedHistorySourceNeverResumesOrigin(): void {
  // A fork that dies before materializing its own provider session is archived
  // carrying only the origin's fork source. History may show where it came from,
  // but provenance is not a resume target: offering Continue on that row would
  // resume the origin session the user never asked to reopen.
  const originKey = mainPageAgentSessionKey('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID);
  const forkSource = encodeResumedProviderSessionSource(
    'codex',
    HOME_SCOPED_SESSION_ID,
    HOME_SCOPED_HOME_ID,
    { forked: true },
  );
  const resumeSource = encodeResumedProviderSessionSource(
    'codex',
    HOME_SCOPED_SESSION_ID,
    HOME_SCOPED_HOME_ID,
  );
  const historyPanel = importTsModule('src/components/code/HistoryPanel.tsx') as {
    buildHistoryAgentItems: (
      runs: unknown[],
      agents: unknown[],
      sessions: unknown[],
    ) => Array<{ kind: string; historyKey: string }>;
    historyItemSessionKey: (item: unknown) => string;
  };
  const sessionDisplay = importTsModule('src/components/code/session-display.ts') as {
    claimedAgentSessionFromSource: (source?: string) => unknown;
    resumedAgentSessionSourceIdentity: (source?: string) => unknown;
  };

  const archivedRun = (id: string, source: string) => ({
    id,
    agentId: id,
    command: 'codex',
    cwd: '/repo',
    projectWorkspace: '/repo',
    title: 'Fork of origin',
    task: '',
    source,
    reason: 'process-exit',
    status: 'stopped',
    startedAt: 100_000,
    lastActivity: 110_000,
    archivedAt: 110_000,
  });
  const originSession = {
    provider: 'codex',
    providerName: 'Codex',
    id: HOME_SCOPED_SESSION_ID,
    providerHomeId: HOME_SCOPED_HOME_ID,
    title: 'Origin',
    workspace: '/repo',
    cwd: '/repo',
    updatedAt: new Date(200_000).toISOString(),
  };

  const forkedItems = historyPanel.buildHistoryAgentItems(
    [archivedRun('run-failed-fork', forkSource)],
    [],
    [originSession],
  );
  assert.deepStrictEqual(
    forkedItems.map(item => item.historyKey),
    [originKey, 'run:run-failed-fork'],
    'a failed fork is its own History row and must not collapse into the origin session',
  );
  const forkedRunItem = forkedItems.find(item => item.kind === 'run');
  assert.strictEqual(
    historyPanel.historyItemSessionKey(forkedRunItem),
    '',
    'a forked History row resolves no session key, so it offers no session-keyed resume',
  );
  assert.strictEqual(
    historyPanel.historyItemSessionKey(forkedItems.find(item => item.kind === 'session')),
    originKey,
    'the origin session row keeps its own resume target',
  );

  const resumedItems = historyPanel.buildHistoryAgentItems(
    [archivedRun('run-resumed', resumeSource)],
    [],
    [originSession],
  );
  assert.deepStrictEqual(
    resumedItems.map(item => item.historyKey),
    [originKey],
    'an ordinary resumed run still dedupes into the session it resumed',
  );
  assert.strictEqual(
    historyPanel.historyItemSessionKey(resumedItems[0]),
    originKey,
    'ordinary History continue is unchanged',
  );

  assert.strictEqual(
    sessionDisplay.claimedAgentSessionFromSource(forkSource),
    null,
    'the claim helper resolves a fork source to nothing',
  );
  assert.deepStrictEqual(
    sessionDisplay.resumedAgentSessionSourceIdentity(forkSource),
    {
      provider: 'codex',
      providerHomeId: HOME_SCOPED_HOME_ID,
      sessionId: HOME_SCOPED_SESSION_ID,
      forked: true,
    },
    'the display parser still exposes the origin tuple a fork was started from',
  );

  assert.strictEqual(
    crtHistoryItemResumeSession({ kind: 'run', historyKey: 'run:run-failed-fork', entry: archivedRun('run-failed-fork', forkSource) }),
    null,
    'CRT must not resume the origin from a forked History run',
  );
  assert.strictEqual(
    crtHistoryItemResumeSession({
      kind: 'agent',
      historyKey: 'agent:agent-failed-fork',
      agent: { id: 'agent-failed-fork', command: 'codex', source: forkSource },
    }),
    null,
    'CRT must not resume the origin from an archived Agent carrying only a fork source',
  );
  assert.deepStrictEqual(
    crtHistoryItemResumeSession({ kind: 'run', historyKey: 'run:run-resumed', entry: archivedRun('run-resumed', resumeSource) }),
    { provider: 'codex', providerHomeId: HOME_SCOPED_HOME_ID, sessionId: HOME_SCOPED_SESSION_ID },
    'CRT keeps resuming an ordinary History run',
  );
}

function withStubbedDisplayState<T>(state: unknown, body: () => T): T {
  const globals = globalThis as { window?: unknown };
  const previousWindow = globals.window;
  globals.window = {
    localStorage: {
      getItem: (key: string) => (
        key === 'farming.codex.sessionDisplayState.v1' ? JSON.stringify(state) : null
      ),
    },
  };
  try {
    return body();
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
}

function assertBrowserDisplayStateMigrationIsOrderIndependent(): void {
  const { loadSessionDisplayState } = importTsModule('src/components/code/session-display.ts') as {
    loadSessionDisplayState: () => {
      promotedKeys: string[];
      pinnedOverrides: Record<string, boolean>;
      archivedOverrides: Record<string, boolean>;
    };
  };
  const legacyKey = 'agent-session:codex:home:work:x';
  const upperCaseLegacyKey = 'agent-session:CODEX:home:work:x';
  const canonicalKey = mainPageAgentSessionKey('codex', HOME_SCOPED_SESSION_ID, HOME_SCOPED_HOME_ID);

  for (const promotedKeys of [[legacyKey, canonicalKey], [canonicalKey, legacyKey]]) {
    assert.deepStrictEqual(
      withStubbedDisplayState({ promotedKeys }, loadSessionDisplayState).promotedKeys,
      [canonicalKey],
      'a pre-v2 alias and its v2 key are one promoted session, in either persisted order',
    );
  }

  // The v2 spelling is the authoritative one, so it decides the value whichever
  // property the persisted object lists first.
  for (const pinnedOverrides of [
    { [legacyKey]: true, [canonicalKey]: false },
    { [canonicalKey]: false, [legacyKey]: true },
  ]) {
    assert.deepStrictEqual(
      withStubbedDisplayState({ pinnedOverrides }, loadSessionDisplayState).pinnedOverrides,
      { [canonicalKey]: false },
      'the v2 pin override outranks the pre-v2 alias regardless of property order',
    );
  }
  for (const archivedOverrides of [
    { [legacyKey]: false, [canonicalKey]: true },
    { [canonicalKey]: true, [legacyKey]: false },
  ]) {
    assert.deepStrictEqual(
      withStubbedDisplayState({ archivedOverrides }, loadSessionDisplayState).archivedOverrides,
      { [canonicalKey]: true },
      'the v2 archive override outranks the pre-v2 alias regardless of property order',
    );
  }

  // Two equally authoritative spellings that disagree are unprovable state, so the
  // override is dropped and the session keeps its authoritative pin/archive state.
  for (const conflicting of [
    { [legacyKey]: true, [upperCaseLegacyKey]: false },
    { [upperCaseLegacyKey]: false, [legacyKey]: true },
  ]) {
    const loaded = withStubbedDisplayState(
      { pinnedOverrides: conflicting, archivedOverrides: conflicting },
      loadSessionDisplayState,
    );
    assert.deepStrictEqual(loaded.pinnedOverrides, {}, 'a conflicting pin override fails closed');
    assert.deepStrictEqual(loaded.archivedOverrides, {}, 'a conflicting archive override fails closed');
  }

  // A conflict among pre-v2 aliases is still resolved by the v2 spelling.
  for (const pinnedOverrides of [
    { [legacyKey]: true, [upperCaseLegacyKey]: false, [canonicalKey]: true },
    { [canonicalKey]: true, [upperCaseLegacyKey]: false, [legacyKey]: true },
  ]) {
    assert.deepStrictEqual(
      withStubbedDisplayState({ pinnedOverrides }, loadSessionDisplayState).pinnedOverrides,
      { [canonicalKey]: true },
    );
  }

  // A key that is not a provider session handle keeps its own entry.
  assert.deepStrictEqual(
    withStubbedDisplayState(
      { pinnedOverrides: { 'agent-1': true, [legacyKey]: false } },
      loadSessionDisplayState,
    ).pinnedOverrides,
    { 'agent-1': true, [canonicalKey]: false },
  );
}

function run(): void {
  assertExactCollisionIsDistinct();
  assertDelimiterSafeRoundTrip();
  assertNonCanonicalEscapesFailClosed();
  assertIllegalIdentityFieldsAreRefused();
  assertMalformedV2PayloadsFailClosed();
  assertLegacyShapesKeepHistoricalMeaning();
  assertCrtMirrorsSharedCodec();
  assertFrontendHandleMatchesBackendKey();
  assertAutoResumeDedupesByTuple();
  assertClaimIsTupleExact();
  assertPendingForkClaimsNothing();
  assertForkedHistorySourceNeverResumesOrigin();
  assertBrowserDisplayStateMigrationIsOrderIndependent();
  assertStoreMigratesLegacyKeysWithoutDoubleEntries();
  assertStoreKeepsAgentBindingsTupleExact();
  assertMixedIndexSpellingsResolveDeterministically();
  assertConflictingRecordSpellingsFailClosed();
  console.log('Provider session durable identity v2 codec tests passed');
}

run();
