const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_AUTO_RUN_COUNT,
  DEFAULT_AUTO_RUN_INFINITE,
  PERSISTED_TOP_SETTING_KEYS,
  normalizePersistentSettings,
  sanitizeAutoRunCount,
  sanitizeInfiniteAutoRun,
} = require('../shared/sidepanel-settings.js');

test('sanitizeAutoRunCount keeps positive integers', () => {
  assert.equal(sanitizeAutoRunCount('5'), 5);
  assert.equal(sanitizeAutoRunCount(3), 3);
});

test('sanitizeAutoRunCount falls back to default for invalid values', () => {
  assert.equal(sanitizeAutoRunCount(''), DEFAULT_AUTO_RUN_COUNT);
  assert.equal(sanitizeAutoRunCount('0'), DEFAULT_AUTO_RUN_COUNT);
  assert.equal(sanitizeAutoRunCount('-1'), DEFAULT_AUTO_RUN_COUNT);
  assert.equal(sanitizeAutoRunCount('abc'), DEFAULT_AUTO_RUN_COUNT);
});

test('sanitizeInfiniteAutoRun coerces values to booleans', () => {
  assert.equal(sanitizeInfiniteAutoRun(true), true);
  assert.equal(sanitizeInfiniteAutoRun(false), false);
  assert.equal(sanitizeInfiniteAutoRun('true'), true);
  assert.equal(sanitizeInfiniteAutoRun('false'), false);
  assert.equal(sanitizeInfiniteAutoRun(undefined), false);
});

test('normalizePersistentSettings returns only persisted top-bar settings', () => {
  assert.deepEqual(
    normalizePersistentSettings({
      vpsUrl: 'http://127.0.0.1:3000',
      mailProvider: 'inbucket',
      inbucketHost: 'mail.test',
      inbucketMailbox: 'box-1',
      autoRunCount: '8',
      autoRunInfinite: 'true',
      customPassword: 'should-not-be-here',
    }),
    {
      vpsUrl: 'http://127.0.0.1:3000',
      mailProvider: 'inbucket',
      inbucketHost: 'mail.test',
      inbucketMailbox: 'box-1',
      autoRunCount: 8,
      autoRunInfinite: true,
    }
  );

  assert.deepEqual(
    normalizePersistentSettings({}),
    {
      vpsUrl: '',
      mailProvider: '163',
      inbucketHost: '',
      inbucketMailbox: '',
      autoRunCount: DEFAULT_AUTO_RUN_COUNT,
      autoRunInfinite: DEFAULT_AUTO_RUN_INFINITE,
    }
  );

  assert.deepEqual(
    PERSISTED_TOP_SETTING_KEYS,
    ['vpsUrl', 'mailProvider', 'inbucketHost', 'inbucketMailbox', 'autoRunCount', 'autoRunInfinite']
  );
});
