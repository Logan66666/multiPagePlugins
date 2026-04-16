const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clearTmailorDomainStats,
  DEFAULT_TMAILOR_DOMAIN_STATE,
  DEFAULT_TMAILOR_WHITELIST,
  DEFAULT_TMAILOR_DOMAIN_MODE,
  extractEmailDomain,
  isAllowedTmailorDomain,
  isBlacklistedTmailorDomain,
  isWhitelistedTmailorDomain,
  mergeTmailorDomainStates,
  moveTmailorDomainToBlacklist,
  normalizeTmailorDomainState,
  recordTmailorDomainFailure,
  recordTmailorDomainSuccess,
  shouldBlacklistTmailorDomainForError,
  validateTmailorEmail,
} = require('../shared/tmailor-domains.js');

test('normalizeTmailorDomainState keeps the built-in whitelist and normalizes user entries', () => {
  const state = normalizeTmailorDomainState({
    mode: 'whitelist_only',
    whitelist: ['@Alpha.com', 'mikfarm.com', ''],
    blacklist: ['Bad.com', 'MIKFARM.com'],
    stats: {
      'Alpha.com': { successCount: '2', failureCount: '1' },
      'bad.com': { successCount: 0, failureCount: 3 },
    },
  });

  assert.equal(state.whitelist.includes('mikfarm.com'), false);
  assert.equal(state.whitelist.includes('alpha.com'), true);
  assert.equal(state.blacklist.includes('bad.com'), true);
  assert.equal(state.blacklist.includes('mikfarm.com'), true);
  assert.equal(state.mode, 'whitelist_only');
  assert.deepEqual(state.stats['alpha.com'], { successCount: 2, failureCount: 1 });
});

test('normalizeTmailorDomainState lets an explicit blacklist override built-in whitelist entries', () => {
  const state = normalizeTmailorDomainState({
    blacklist: ['mikfarm.com'],
  });

  assert.equal(state.whitelist.includes('mikfarm.com'), false);
  assert.equal(state.blacklist.includes('mikfarm.com'), true);
});

test('isAllowedTmailorDomain accepts whitelisted domains and non-blacklisted .com domains', () => {
  const state = normalizeTmailorDomainState({
    mode: 'com_only',
    blacklist: ['blocked.com'],
  });

  assert.equal(isAllowedTmailorDomain(state, 'mikfarm.com'), true);
  assert.equal(isAllowedTmailorDomain(state, 'fresh-domain.com'), true);
  assert.equal(isAllowedTmailorDomain(state, 'blocked.com'), false);
  assert.equal(isAllowedTmailorDomain(state, 'random.net'), false);
});

test('isAllowedTmailorDomain whitelist_only mode only accepts whitelisted domains', () => {
  const state = normalizeTmailorDomainState({
    mode: 'whitelist_only',
    blacklist: ['blocked.com'],
  });

  assert.equal(isAllowedTmailorDomain(state, 'mikfarm.com'), true);
  assert.equal(isAllowedTmailorDomain(state, 'fresh-domain.com'), false);
  assert.equal(isAllowedTmailorDomain(state, 'blocked.com'), false);
});

test('recordTmailorDomainSuccess increments stats and auto-whitelists successful .com domains', () => {
  const nextState = recordTmailorDomainSuccess(DEFAULT_TMAILOR_DOMAIN_STATE, 'newgood.com');

  assert.equal(isWhitelistedTmailorDomain(nextState, 'newgood.com'), true);
  assert.equal(isBlacklistedTmailorDomain(nextState, 'newgood.com'), false);
  assert.deepEqual(nextState.stats['newgood.com'], { successCount: 1, failureCount: 0 });
});

test('recordTmailorDomainSuccess promotes a successful com_only domain into the whitelist', () => {
  const nextState = recordTmailorDomainSuccess(
    normalizeTmailorDomainState({
      mode: 'com_only',
      whitelist: [],
      blacklist: [],
    }),
    'fresh-win.com'
  );

  assert.equal(isWhitelistedTmailorDomain(nextState, 'fresh-win.com'), true);
  assert.equal(isBlacklistedTmailorDomain(nextState, 'fresh-win.com'), false);
  assert.deepEqual(nextState.stats['fresh-win.com'], { successCount: 1, failureCount: 0 });
});

test('recordTmailorDomainFailure increments stats and can blacklist non-whitelisted domains', () => {
  const nextState = recordTmailorDomainFailure(DEFAULT_TMAILOR_DOMAIN_STATE, 'badfresh.com', {
    blacklist: true,
  });

  assert.equal(isBlacklistedTmailorDomain(nextState, 'badfresh.com'), true);
  assert.deepEqual(nextState.stats['badfresh.com'], { successCount: 0, failureCount: 1 });
});

test('clearTmailorDomainStats clears only the requested metric for the provided domains', () => {
  const nextState = clearTmailorDomainStats(
    normalizeTmailorDomainState({
      whitelist: ['alpha.com'],
      blacklist: ['beta.com'],
      stats: {
        'alpha.com': { successCount: 5, failureCount: 2 },
        'beta.com': { successCount: 4, failureCount: 7 },
        'gamma.com': { successCount: 3, failureCount: 6 },
      },
    }),
    ['alpha.com', 'beta.com'],
    'success'
  );

  assert.deepEqual(nextState.stats['alpha.com'], { successCount: 0, failureCount: 2 });
  assert.deepEqual(nextState.stats['beta.com'], { successCount: 0, failureCount: 7 });
  assert.deepEqual(nextState.stats['gamma.com'], { successCount: 3, failureCount: 6 });
});

test('clearTmailorDomainStats clears only failure counts for matching domains and ignores invalid keys', () => {
  const original = normalizeTmailorDomainState({
    whitelist: ['alpha.com'],
    stats: {
      'alpha.com': { successCount: 5, failureCount: 2 },
      'beta.com': { successCount: 4, failureCount: 7 },
    },
  });

  const nextState = clearTmailorDomainStats(original, ['alpha.com'], 'failure');
  const unchanged = clearTmailorDomainStats(original, ['alpha.com'], 'other');

  assert.deepEqual(nextState.stats['alpha.com'], { successCount: 5, failureCount: 0 });
  assert.deepEqual(nextState.stats['beta.com'], { successCount: 4, failureCount: 7 });
  assert.deepEqual(unchanged, original);
});

test('moveTmailorDomainToBlacklist moves a domain from whitelist to blacklist and preserves stats', () => {
  const nextState = moveTmailorDomainToBlacklist(
    normalizeTmailorDomainState({
      whitelist: ['alpha.com'],
      stats: {
        'alpha.com': { successCount: 5, failureCount: 2 },
      },
    }),
    'alpha.com'
  );

  assert.equal(nextState.whitelist.includes('alpha.com'), false);
  assert.equal(nextState.blacklist.includes('alpha.com'), true);
  assert.deepEqual(nextState.stats['alpha.com'], { successCount: 5, failureCount: 2 });
});

test('moveTmailorDomainToBlacklist can manually blacklist a built-in whitelist domain', () => {
  const nextState = moveTmailorDomainToBlacklist(DEFAULT_TMAILOR_DOMAIN_STATE, 'mikfarm.com');

  assert.equal(nextState.whitelist.includes('mikfarm.com'), false);
  assert.equal(nextState.blacklist.includes('mikfarm.com'), true);
});

test('shouldBlacklistTmailorDomainForError blacklists non-whitelisted .com domains for auth-blocking failures', () => {
  const state = normalizeTmailorDomainState();

  assert.equal(
    shouldBlacklistTmailorDomainForError(state, 'unknown-good.com', 'Step 4 blocked: email domain is unsupported on the auth page.'),
    true
  );
  assert.equal(
    shouldBlacklistTmailorDomainForError(state, 'unknown-good.com', 'Step 4 failed: 验证过程中出错 (unsupported_email)。请重试。'),
    true
  );
  assert.equal(
    shouldBlacklistTmailorDomainForError(state, 'unknown-good.com', 'Step 8 blocked: auth page still requires phone verification.'),
    true
  );
  assert.equal(
    shouldBlacklistTmailorDomainForError(state, 'unknown-good.com', 'Step 7 blocked: phone number is required on the auth page. Please change node and retry.'),
    true
  );
  assert.equal(
    shouldBlacklistTmailorDomainForError(state, 'unknown-good.com', 'Step 7 failed: Verification form stayed visible after submit attempts. URL: https://auth.openai.com/add-phone'),
    true
  );
  assert.equal(
    shouldBlacklistTmailorDomainForError(state, 'unknown-good.com', 'Step 5 failed: Auth fatal error page detected after profile submit.'),
    true
  );
  assert.equal(
    shouldBlacklistTmailorDomainForError(state, 'unknown-good.com', 'Step 5 failed: Could not find name input. URL: https://auth.openai.com/u/signup/continue'),
    true
  );
  assert.equal(
    shouldBlacklistTmailorDomainForError(state, 'mikfarm.com', 'Step 8 blocked: auth page still requires phone verification.'),
    false
  );
  assert.equal(
    shouldBlacklistTmailorDomainForError(state, 'unknown-good.net', 'Step 4 blocked: email domain is unsupported on the auth page.'),
    false
  );
});

test('extractEmailDomain normalizes email domains safely', () => {
  assert.equal(extractEmailDomain('User@MiKFARM.com '), 'mikfarm.com');
  assert.equal(extractEmailDomain('not-an-email'), '');
});

test('validateTmailorEmail accepts allowed emails and normalizes casing', () => {
  const result = validateTmailorEmail(DEFAULT_TMAILOR_DOMAIN_STATE, ' User@MiKFARM.com ');

  assert.equal(result.ok, true);
  assert.equal(result.email, 'user@mikfarm.com');
  assert.equal(result.domain, 'mikfarm.com');
  assert.equal(result.reason, '');
});

test('validateTmailorEmail rejects malformed or disallowed emails', () => {
  const invalidEmail = validateTmailorEmail(DEFAULT_TMAILOR_DOMAIN_STATE, 'not-an-email');
  const blockedEmail = validateTmailorEmail(
    normalizeTmailorDomainState({ mode: 'whitelist_only' }),
    'user@random.com'
  );

  assert.equal(invalidEmail.ok, false);
  assert.equal(invalidEmail.reason, 'invalid_email');
  assert.equal(blockedEmail.ok, false);
  assert.equal(blockedEmail.reason, 'domain_not_allowed');
  assert.equal(blockedEmail.domain, 'random.com');
});

test('mergeTmailorDomainStates keeps packaged seeds while letting runtime state override mode and stats', () => {
  const merged = mergeTmailorDomainStates(
    {
      mode: 'com_only',
      whitelist: ['seeded.com'],
      blacklist: ['blocked-seed.com'],
      stats: {
        'blocked-seed.com': { successCount: 0, failureCount: 1 },
      },
    },
    {
      mode: 'whitelist_only',
      whitelist: ['runtime-only.com'],
      blacklist: ['runtime-blocked.com'],
      stats: {
        'blocked-seed.com': { successCount: 0, failureCount: 3 },
        'runtime-only.com': { successCount: 2, failureCount: 0 },
      },
    }
  );

  assert.equal(merged.mode, 'whitelist_only');
  assert.equal(merged.whitelist.includes('seeded.com'), true);
  assert.equal(merged.whitelist.includes('runtime-only.com'), true);
  assert.equal(merged.blacklist.includes('blocked-seed.com'), true);
  assert.equal(merged.blacklist.includes('runtime-blocked.com'), true);
  assert.deepEqual(merged.stats['blocked-seed.com'], { successCount: 0, failureCount: 3 });
  assert.deepEqual(merged.stats['runtime-only.com'], { successCount: 2, failureCount: 0 });
});

test('mergeTmailorDomainStates lets the packaged blacklist evict stale persisted whitelist entries', () => {
  const merged = mergeTmailorDomainStates(
    {
      mode: 'com_only',
      whitelist: ['seeded-good.com'],
      blacklist: ['pippoc.com'],
      stats: {
        'pippoc.com': { successCount: 0, failureCount: 1 },
      },
    },
    {
      mode: 'whitelist_only',
      whitelist: ['pippoc.com', 'runtime-only.com'],
      blacklist: [],
      stats: {
        'runtime-only.com': { successCount: 2, failureCount: 0 },
      },
    }
  );

  assert.equal(merged.whitelist.includes('seeded-good.com'), true);
  assert.equal(merged.whitelist.includes('runtime-only.com'), true);
  assert.equal(merged.whitelist.includes('pippoc.com'), false);
  assert.equal(merged.blacklist.includes('pippoc.com'), true);
});

test('default tmailor state exposes the initial whitelist', () => {
  assert.equal(DEFAULT_TMAILOR_WHITELIST.length > 5, true);
  assert.equal(DEFAULT_TMAILOR_DOMAIN_MODE, 'whitelist_only');
  assert.equal(DEFAULT_TMAILOR_DOMAIN_STATE.whitelist.includes('mikfarm.com'), true);
  assert.equal(DEFAULT_TMAILOR_DOMAIN_STATE.whitelist.includes('nickmxh.com'), false);
  assert.equal(DEFAULT_TMAILOR_DOMAIN_STATE.whitelist.includes('hetzez.com'), false);
  assert.equal(DEFAULT_TMAILOR_DOMAIN_STATE.whitelist.includes('pippoc.com'), false);
  assert.equal(DEFAULT_TMAILOR_DOMAIN_STATE.blacklist.includes('nickmxh.com'), true);
  assert.equal(DEFAULT_TMAILOR_DOMAIN_STATE.blacklist.includes('hetzez.com'), true);
  assert.equal(DEFAULT_TMAILOR_DOMAIN_STATE.blacklist.includes('pippoc.com'), true);
  assert.equal(DEFAULT_TMAILOR_DOMAIN_STATE.mode, 'whitelist_only');
});
